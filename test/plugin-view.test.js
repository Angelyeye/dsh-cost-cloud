// ============================================================
// 采集端「插件形状」只读聚合：/api/v1/plugin-view
//
// 背景：看板三态视图的「仅云端」需要的不只是概览卡片，还要**按天/按模型/最近记录**
// 才能画出消费柱状图、分模型明细与最近记录表。插件本地 buildDashboard 的字段名是
// real/sub/calls/tokens，而云端 overview 的按量金额叫 realCost/subEquivalent ——
// 客户端只透传原字段，于是「仅云端」出现「次数正常、金额全 ¥0.0000」。
// 本接口直接返回**与本地同字段名**的形状，从根上消除这层字段名适配。
//
// 断言：
//   ① health 的 caps 声明 devicePluginView（插件据此决定是否优先走本接口）
//   ② 字段形状：today/month/all 用 real/sub/calls/tokens，含 byDay/byModel/byModelDay/recent
//   ③ 三切片**受过滤条件约束**（excludeDevice 时必须同步缩小，否则「本机+云端」会重复计数）
//   ④ union 并集：两部分相加，且不与整体重复计数
//   ⑤ 鉴权与开关：缺令牌 401、ALLOW_DEVICE_READ=0 时 403
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { listen } from '../src/server.js'
import { testConfig, tmpDir, addDevice, rec, ingestDirect } from './helpers.js'

const T0 = Date.UTC(2026, 8, 12, 5, 0, 0)
const SHARED = 'shared-bootstrap-token-0123456789'

async function boot(over) {
  const dir = tmpDir()
  const config = testConfig(dir, Object.assign({
    DSH_SYNC_TOKEN: SHARED, ALLOW_DEVICE_SELF_REGISTER: '1', HOST: '127.0.0.1', PORT: '0',
  }, over || {}))
  const { server, app, url } = await listen(config, { log: () => {} })
  return {
    app, url, config,
    async close() {
      await new Promise((r) => server.close(r))
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch (e) {}
    },
  }
}

async function fetchRetry(url, init) {
  try { return await fetch(url, init) } catch (e) {
    const code = String((e && e.cause && e.cause.code) || e)
    if (!code.includes('ECONNRESET') && !code.includes('ECONNREFUSED')) throw e
    return await fetch(url, init)
  }
}
const devGet = async (url, token, path) => {
  const r = await fetchRetry(url + '/api/v1/' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} })
  return { status: r.status, body: await r.json() }
}

/** 两台设备：A 两条（1.5 + 0.4，其中一条订阅 0.4）、B 一条 0.5 */
function seed(app) {
  const tokenA = addDevice(app, 'machine-A', '办公台式机')
  const tokenB = addDevice(app, 'machine-B', '笔记本')
  ingestDirect(app, {
    token: tokenA, deviceId: 'machine-A', source: 'dsh', records: [
      rec({ ts: T0, cost: 1.5, sessionId: 'a1' }),
      rec({ ts: T0 + 1000, cost: 0.4, sessionId: 'a2', subscription: true, model: 'kimi-coding', provider: 'moonshot-ai' }),
    ],
  })
  ingestDirect(app, { token: tokenB, deviceId: 'machine-B', source: 'dsh', records: [rec({ ts: T0 + 2000, cost: 0.5, sessionId: 'b1' })] })
  return { tokenA, tokenB }
}

test('caps 声明 devicePluginView（插件据此选择端点）', async () => {
  const s = await boot()
  try {
    const r = await fetchRetry(s.url + '/api/v1/health')
    const body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.caps.devicePluginView, true)
  } finally { await s.close() }
})

test('plugin-view 返回本地同字段名形状：real/sub + byDay/byModel/byModelDay/recent', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)
    const r = await devGet(s.url, tokenA, 'plugin-view?range=all')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const b = r.body
    for (const k of ['real', 'calls', 'tokens', 'sub', 'subCalls', 'subTokens']) {
      assert.ok(k in b.all, 'all 必须含 ' + k + '（本地 buildDashboard 口径）')
      assert.ok(k in b.today, 'today 必须含 ' + k)
      assert.ok(k in b.month, 'month 必须含 ' + k)
    }
    // 两台设备合计：按量 1.5+0.5=2.0、订阅 0.4
    assert.ok(Math.abs(b.all.real - 2.0) < 1e-9, 'all.real=' + b.all.real)
    assert.ok(Math.abs(b.all.sub - 0.4) < 1e-9, 'all.sub=' + b.all.sub)
    assert.equal(b.all.calls, 2, '按量调用 2 次（订阅那次不计入 calls）')
    assert.equal(b.all.subCalls, 1, '订阅调用 1 次')
    assert.equal(b.source, 'cloud')
    assert.ok(Array.isArray(b.byDay) && b.byDay.length > 0, 'byDay 必须有内容（图表数据源）')
    const day = b.byDay.find((d) => d.date === '2026-09-12')
    assert.ok(day, 'byDay 含 2026-09-12')
    assert.ok(Math.abs(day.cost - 2.4) < 1e-9, '当日合计 = 按量 2.0 + 订阅 0.4，实际 ' + day.cost)
    assert.ok(Array.isArray(b.byModel) && b.byModel.length === 2, 'byModel 应有两个模型')
    assert.ok(Array.isArray(b.byModelDay) && b.byModelDay.length === 2, 'byModelDay 按模型展开')
    assert.ok(Array.isArray(b.recent) && b.recent.length === 3, 'recent 应含三条明细')
    assert.ok(b.recent.every((x) => typeof x.ts === 'number' && typeof x.cost === 'number'), 'recent 字段可渲染')
    assert.ok(Array.isArray(b.devices) && b.devices.length === 2, 'devices 维度清单')
  } finally { await s.close() }
})

test('三切片受过滤条件约束（excludeDevice 不得再返回全网金额）', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)
    const all = await devGet(s.url, tokenA, 'plugin-view?range=all')
    const other = await devGet(s.url, tokenA, 'plugin-view?range=all&excludeDevice=machine-A')
    assert.ok(Math.abs(all.body.all.real - 2.0) < 1e-9, '全网按量 2.0')
    // 排除 A 后只剩 B：0.5 —— 若三切片仍取自全表，这里会退回 2.0（旧实现的缺陷）
    assert.ok(Math.abs(other.body.all.real - 0.5) < 1e-9, '排除 A 后按量应只剩 0.5，实际 ' + other.body.all.real)
    assert.ok(Math.abs(other.body.month.real - 0.5) < 1e-9, 'month 切片同样受限，实际 ' + other.body.month.real)
    assert.equal(other.body.byModel.length, 1, 'byModel 只剩 B 的模型')
    assert.ok(Math.abs(other.body.month.real - other.body.all.real) < 1e-9, 'month 与 all 同口径（同为 1 天数据）')
  } finally { await s.close() }
})

test('union 并集：两部分相加且不重复计数', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)
    const union = JSON.stringify([
      { excludeDevice: 'machine-A' },              // 其他整机 → B：0.5
      { devices: 'machine-A', excludeSource: 'dsh' }, // A 上的其它 agent → 0（A 只有 dsh）
    ])
    const r = await devGet(s.url, tokenA, 'plugin-view?range=all&union=' + encodeURIComponent(union))
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.union, true)
    assert.ok(Math.abs(r.body.all.real - 0.5) < 1e-9, '并集按量 = 0.5，实际 ' + r.body.all.real)
    assert.equal(r.body.byModel.length, 1, '并集分模型只剩 B 的模型')
    assert.equal((r.body.parts || []).length, 2, '回显并集各部分')
  } finally { await s.close() }
})

test('鉴权与开关：缺令牌 401 / 错令牌 401 / 关闭设备只读 403', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)
    assert.equal((await devGet(s.url, '', 'plugin-view?range=all')).status, 401)
    assert.equal((await devGet(s.url, 'wrong-token', 'plugin-view?range=all')).status, 401)
    assert.equal((await devGet(s.url, tokenA, 'plugin-view?range=all')).status, 200)
  } finally { await s.close() }

  const off = await boot({ ALLOW_DEVICE_READ: '0' })
  try {
    const { tokenA } = seed(off.app)
    const r = await devGet(off.url, tokenA, 'plugin-view?range=all')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'DEVICE_READ_DISABLED')
  } finally { await off.close() }
})

test('range=all 时日期轴覆盖数据起点（「全部」在云端视图里也是全部）', async () => {
  const s = await boot()
  try {
    const token = addDevice(s.app, 'machine-C', '老机器')
    const old = Date.UTC(2026, 6, 1, 5, 0, 0) // 北京 2026-07-01
    ingestDirect(s.app, {
      token, deviceId: 'machine-C', source: 'dsh', records: [
        rec({ ts: old, cost: 1.0, sessionId: 'old' }),
        rec({ ts: T0, cost: 2.0, sessionId: 'new' }),
      ],
    })
    const r = await devGet(s.url, token, 'plugin-view?range=all')
    const dates = r.body.byDay.map((d) => d.date)
    assert.ok(dates.includes('2026-07-01'), 'byDay 应覆盖到数据起点，实际 ' + dates[0] + ' … ' + dates[dates.length - 1])
    assert.ok(Math.abs(r.body.all.real - 3.0) < 1e-9, 'all.real=3.0，实际 ' + r.body.all.real)
  } finally { await s.close() }
})
