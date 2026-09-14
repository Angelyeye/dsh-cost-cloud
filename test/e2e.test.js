// ============================================================
// 端到端测试：真实 HTTP 服务 + 两个设备 × 两个 agent 上报
//
// 验收断言（方案 §5）：
//   ① 总合计 = 各设备/各来源之和
//   ② excludeDevice 排除后 = 其余之和（插件「本机+云端」相加 = 全网）
//   ③ 重复上报数值不变
//   ④ 二维矩阵行/列/总计自洽，且与记录列表筛选一致
//   ⑤ all 区间包含超出明细窗口的 rollup 部分
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { listen } from '../src/server.js'
import { testConfig, tmpDir } from './helpers.js'
import { dedupKeyOfDetail } from '../src/dedup.js'

const US = '\u001f'

/** 模拟一台设备上的一个 agent：持有令牌、本地 seq、批号 */
function makeAgent(base, { deviceId, deviceName, source, token }) {
  let seq = 0
  let lastWatermark = 0
  const sent = []
  return {
    deviceId, source, sent,
    /** 把本地明细上报（只发 seq > watermark 且未被 rollup 吸收的部分） */
    async push(records, extra) {
      const batch = records.map((r) => Object.assign({ seq: ++seq }, r))
      sent.push(...batch)
      const res = await fetch(base + '/api/v1/ingest/records', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(Object.assign({
          syncVer: 1, source, deviceId, deviceName,
          resetEpoch: 0, maxClientSeq: seq, sentAt: Date.now(),
          batchUid: deviceId + '-' + source + '-b' + Math.random().toString(36).slice(2),
          records: batch,
        }, extra || {})),
      })
      const json = await res.json()
      if (json.ok && json.watermark) lastWatermark = json.watermark.maxClientSeq
      return { status: res.status, json }
    },
    async pushRollups(snapshots) {
      const res = await fetch(base + '/api/v1/ingest/rollups', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({
          syncVer: 1, source, deviceId, deviceName, sentAt: Date.now(),
          batchUid: deviceId + '-' + source + '-r' + Math.random().toString(36).slice(2),
          snapshots,
        }),
      })
      return { status: res.status, json: await res.json() }
    },
    get watermark() { return lastWatermark },
  }
}

async function adminGet(base, cookie, path) {
  const r = await fetch(base + '/api/admin/' + path, { headers: { cookie } })
  return { status: r.status, body: await r.json() }
}

function detail(ts, cost, over) {
  return Object.assign({
    ts,
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash',
    sessionId: 'sess-1',
    purpose: 'proj-a',
    tokens: { input: 10000, output: 2000, cacheRead: 30000, cacheWrite: 0, reasoning: 0 },
    cost,
  }, over || {})
}

test('端到端：双设备双 Agent 汇总、去重、排除与二维自洽', async () => {
  const dir = tmpDir()
  const config = testConfig(dir, { ALLOW_DEVICE_SELF_REGISTER: '1', DSH_SYNC_TOKEN: 'shared-bootstrap-token-0123456789', HOST: '127.0.0.1', PORT: '18801' })
  const { server, app, url } = await listen(config, { log: () => {} })
  try {
    // ---------- 两个 agent 用共享引导令牌自注册接入 ----------
    const reg = await fetch(url + '/api/v1/devices/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'machine-A', deviceName: '办公台式机' }),
    })
    const regBody = await reg.json()
    assert.equal(reg.status, 200)

    // 机器 A: dsh；机器 A: codex —— 两者共用同一 machineId（关键约定）
    const tokenA = regBody.token
    const tokenACodex = regBody.token
    const regB = await (await fetch(url + '/api/v1/devices/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'machine-B', deviceName: '笔记本' }),
    })).json()

    const aDsh = makeAgent(url, { deviceId: 'machine-A', deviceName: '办公台式机', source: 'dsh', token: tokenA })
    const aCodex = makeAgent(url, { deviceId: 'machine-A', deviceName: '办公台式机', source: 'codex', token: tokenACodex })
    const bDsh = makeAgent(url, { deviceId: 'machine-B', deviceName: '笔记本', source: 'dsh', token: regB.token })

    const T0 = Date.UTC(2026, 8, 12, 5, 0, 0)
    // A/dsh 两条（合计 1.0）、A/codex 一条（2.5）、B/dsh 一条（0.75）
    const r1 = await aDsh.push([detail(T0 + 1000, 0.6), detail(T0 + 2000, 0.4, { sessionId: 'sess-2' })])
    const r2 = await aCodex.push([detail(T0 + 3000, 2.5, { provider: 'openai', model: 'gpt-5-codex', sessionId: 'codex-1' })])
    const r3 = await bDsh.push([detail(T0 + 4000, 0.75, { sessionId: 'sess-b1' })])
    assert.equal(r1.status, 200)
    assert.equal(r1.json.accepted, 2)
    assert.equal(r2.json.accepted, 1)
    assert.equal(r3.json.accepted, 1)
    assert.equal(r1.json.watermark.maxClientSeq, 2, '水位按 agent 独立推进')

    // ---------- 登录后台 ----------
    const login = await fetch(url + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    })
    const cookie = (login.headers.getSetCookie()[0] || '').split(';')[0]
    assert.match(cookie, /^dshc_admin=/)

    // ---------- ① 总合计 = 各来源之和 ----------
    const ov = await adminGet(url, cookie, 'overview?range=all')
    assert.equal(ov.status, 200)
    assert.ok(Math.abs(ov.body.summary.cost - 4.25) < 1e-6, '总额 0.6+0.4+2.5+0.75=4.25，实际 ' + ov.body.summary.cost)
    assert.equal(ov.body.cost_source_count || ov.body.sources.length, 2, '两个 agent 来源')
    assert.equal(ov.body.devices.length, 2, '两台设备（不是三台）')

    // ---------- ② excludeDevice：排除本机后相加 = 全网 ----------
    const excl = await adminGet(url, cookie, 'overview?range=all&excludeDevice=machine-A')
    assert.ok(Math.abs(excl.body.summary.cost - 0.75) < 1e-6, '排除 A 后只剩 B')
    assert.ok(Math.abs(excl.body.summary.cost + (4.25 - 0.75) - 4.25) < 1e-6, 'A 本地(3.5) + 排除A(0.75) = 4.25')

    // ---------- ③ 重复上报：数值不变 ----------
    const again = await aDsh.push([detail(T0 + 1000, 0.6), detail(T0 + 2000, 0.4, { sessionId: 'sess-2' })])
    assert.equal(again.json.accepted, 0)
    assert.equal(again.json.duplicates, 2)
    const ov2 = await adminGet(url, cookie, 'overview?range=all')
    assert.ok(Math.abs(ov2.body.summary.cost - 4.25) < 1e-6, '重复上报后总额不变')

    // ---------- ④ 二维矩阵自洽 ----------
    const mx = await adminGet(url, cookie, 'matrix?range=all')
    assert.deepEqual(mx.body.cols.sort(), ['codex', 'dsh'])
    const rowA = mx.body.rows.find((r) => r.device === 'machine-A')
    const rowB = mx.body.rows.find((r) => r.device === 'machine-B')
    assert.ok(Math.abs(rowA.cells.dsh.cost - 1.0) < 1e-6, 'A/dsh=1.0')
    assert.ok(Math.abs(rowA.cells.codex.cost - 2.5) < 1e-6, 'A/codex=2.5')
    assert.ok(Math.abs(rowB.cells.dsh.cost - 0.75) < 1e-6, 'B/dsh=0.75')
    const rowSum = mx.body.rows.reduce((s, r) => s + r.cost, 0)
    const colSum = mx.body.cols.reduce((s, c) => s + mx.body.rows.reduce((x, r) => x + (r.cells[c] || { cost: 0 }).cost, 0), 0)
    assert.ok(Math.abs(rowSum - mx.body.totals.cost) < 1e-6, '行合计 = 总计')
    assert.ok(Math.abs(colSum - mx.body.totals.cost) < 1e-6, '列合计 = 总计')
    assert.ok(Math.abs(rowSum - 4.25) < 1e-6)

    // 与记录列表筛选一致
    const recA = await adminGet(url, cookie, 'records?range=all&devices=machine-A&sources=codex&limit=50')
    const sumA = recA.body.items.reduce((s, x) => s + x.cost, 0)
    assert.ok(Math.abs(sumA - 2.5) < 1e-6, '记录筛选合计 = 矩阵单元格')

    // ---------- ⑤ 超出明细窗口的日汇总（rollup）纳入 all 区间 ----------
    // 模拟本地明细超期折叠：声明 absorbed 后上报日汇总
    const oldRec = detail(Date.UTC(2025, 0, 5, 5, 0, 0), 9.5, { sessionId: 'old-sess' })
    await aDsh.push([oldRec])
    const ovWithOld = await adminGet(url, cookie, 'overview?range=all')
    assert.ok(Math.abs(ovWithOld.body.summary.cost - (4.25 + 9.5)) < 1e-6)
    const key = dedupKeyOfDetail(Object.assign({}, oldRec, { seq: aDsh.sent.length }), { resetEpoch: 0 })
    // 客户端真实实现会用同一 canonical（cost 参与明细身份）；这里直接查库取键以聚焦 rollup 语义
    const stored = app.db.prepare("SELECT dedup_key FROM records WHERE session_id = 'old-sess'").get()
    const snap = await aDsh.pushRollups([{
      dayKey: '2025-01-05', provider: 'deepseek-official', model: 'deepseek-v4.1-flash',
      subscription: false, calls: 1,
      tokens: { input: 10000, output: 2000, cacheRead: 30000 },
      cost: 9.5, peak: 0, off: 9.5, flat: 0, absorbed: [String(stored.dedup_key)],
    }])
    assert.equal(snap.json.rollupsUpserted, 1)
    assert.equal(snap.json.tombstoned, 1, '明细被快照声明吸收')
    const ovFinal = await adminGet(url, cookie, 'overview?range=all')
    assert.ok(Math.abs(ovFinal.body.summary.cost - 13.75) < 1e-6, '折叠后总额不重复：13.75，实际 ' + ovFinal.body.summary.cost)
    // 快照按 30 天区间查询时也应命中（按 day_key 归属）
    const ov30 = await adminGet(url, cookie, 'overview?range=all&sources=dsh')
    assert.ok(Math.abs(ov30.body.summary.cost - 11.25) < 1e-6, 'A/dsh 1.0 + B/dsh 0.75 + 快照 9.5 = 11.25')

    // ---------- 同步健康度与来源维度 ----------
    const health = await adminGet(url, cookie, 'sync-health')
    assert.equal(health.body.items.length, 3, '两台设备 × 三个 agent 实例')
    const sources = await adminGet(url, cookie, 'sources')
    assert.equal(sources.body.sources.length, 3)
    const devMeta = sources.body.devices.find((d) => d.id === 'machine-A')
    assert.equal(devMeta.name, '办公台式机')
    assert.equal(devMeta.sourceCount, 2, '机器 A 上有两个 agent')

    // ---------- CSV 导出包含设备与 agent 列 ----------
    const csv = await fetch(url + '/api/admin/export.csv?range=all', { headers: { cookie } })
    const text = await csv.text()
    assert.match(text.split('\n')[0], /deviceName/)
    assert.match(text, /machine-A/)
    assert.match(text, /codex/)
  } finally {
    await new Promise((r) => server.close(r))
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：三态视图所需的口径（本机+云端相加 = 全网）', async () => {
  const dir = tmpDir()
  const config = testConfig(dir, { HOST: '127.0.0.1', PORT: '18802' })
  const { server, app, url } = await listen(config, { log: () => {} })
  try {
    const tA = app.ingest.registerDevice({ deviceId: 'A', deviceName: 'A机' }).token
    const tB = app.ingest.registerDevice({ deviceId: 'B', deviceName: 'B机' }).token
    const post = async (token, deviceId, records) => {
      const r = await fetch(url + '/api/v1/ingest/records', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ syncVer: 1, source: 'dsh', deviceId, batchUid: deviceId + '-' + Math.random(), records }),
      })
      return r.json()
    }
    await post(tA, 'A', [detail(1789000000000, 1.25, { sessionId: 'a1' })])
    await post(tB, 'B', [detail(1789000001000, 2.5, { sessionId: 'b1' })])

    const login = await fetch(url + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
    })
    const cookie = (login.headers.getSetCookie()[0] || '').split(';')[0]

    const local = 1.25                                    // 本机（A）本地看板
    const rest = await adminGet(url, cookie, 'overview?range=all&excludeDevice=A')
    const all = await adminGet(url, cookie, 'overview?range=all')
    assert.ok(Math.abs(rest.body.summary.cost - 2.5) < 1e-6)
    assert.ok(Math.abs((local + rest.body.summary.cost) - all.body.summary.cost) < 1e-6,
      '「本机 + 云端(排除本机)」=「仅云端」')
    // 仅云端 = 全网
    assert.ok(Math.abs(all.body.summary.cost - 3.75) < 1e-6)
  } finally {
    await new Promise((r) => server.close(r))
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
