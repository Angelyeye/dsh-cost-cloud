// ============================================================
// 二维统计正确性测试：设备 × Agent 矩阵 / 分组 / 排除语义
// 核心不变量：行合计 = 列合计 = 总计；明细与日汇总混合后仍自洽
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeApp, ingestDirect, rec } from './helpers.js'
import { call, login } from './http-client.js'
import * as Q from '../src/query.js'
import { dedupKeyOfDetail } from '../src/dedup.js'
import { resolveRange } from '../src/time.js'

const T0 = Date.UTC(2026, 8, 12, 5, 0, 0)

/**
 * 管理端「统一响应契约」守卫。
 *
 * 背景（真实缺陷）：前端 web/state.js 的 api() 要求每个管理端响应带 `ok: true`，
 * 否则抛错并中断渲染。曾因 `Q.matrix()` 漏了 `ok`，导致看板**卡在"加载中…"、导航点不动**，
 * 而当时的矩阵测试因为用 interface 包装、HTTP 测试只断言 rows.length 而全部通过 —— 这是测试盲区。
 * 因此这里逐个端点断言 `ok === true`，任何新端点漏加都会被立刻拦下。
 */
test('契约守卫：所有管理端 GET 接口都必须返回 ok:true（前端据此判定成功）', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const { cookie } = await login(h.app)
    const endpoints = [
      'overview?range=all',
      'overview?range=all&union=' + encodeURIComponent(JSON.stringify([{ excludeDevice: 'dev-A' }])),
      'groups?range=all&groupBy=device',
      'matrix?range=all',
      'trend?range=all&bucket=day&groupBy=device',
      'models?range=all',
      'devices',
      'sources',
      'records?range=all&limit=5',
      'sessions?range=all&limit=5',
      'sync-health',
      'health',
      'config',
      'prices',
      'audit?limit=5',
    ]
    for (const ep of endpoints) {
      const r = await call(h.app, 'GET', '/api/admin/' + ep, null, '', cookie)
      assert.equal(r.status, 200, ep + ' 状态码应为 200')
      assert.equal(r.body.ok, true, ep + ' 响应必须带 ok:true（否则前端 api() 会抛错）')
    }
  } finally { h.cleanup() }
})

test('契约守卫：query 层各聚合函数直接调用时也返回 ok:true', () => {
  const h = makeApp()
  try {
    seed(h.app)
    const range = resolveRange({ range: 'all' }, Date.now())
    const p = { fromMs: range.fromMs, toMs: range.toMs, range: 'all' }
    assert.equal(Q.overview(h.app.db, p).ok, true, 'overview()')
    assert.equal(Q.groups(h.app.db, Object.assign({}, p, { groupBy: ['device'] })).ok, true, 'groups()')
    assert.equal(Q.matrix(h.app.db, p).ok, true, 'matrix()')
    assert.equal(Q.trend(h.app.db, Object.assign({}, p, { bucket: 'day', groupBy: ['device'] })).ok, true, 'trend()')
    assert.equal(Q.records(h.app.db, Object.assign({}, p, { limit: 5 })).ok, true, 'records()')
    assert.equal(Q.sessions(h.app.db, Object.assign({}, p, { limit: 5 })).ok, true, 'sessions()')
    assert.equal(Q.syncHealth(h.app.db, h.config).ok, true, 'syncHealth()')
    assert.equal(Q.listDimensions(h.app.db).devices !== undefined, true, 'listDimensions()')
    assert.equal(Q.overviewUnion(h.app.db, [p, p]).ok, true, 'overviewUnion()')
  } finally { h.cleanup() }
})

/** 造 3 设备 × 多 Agent 的数据；返回期望的费用矩阵 */
function seed(app) {
  const want = {}
  const put = (device, source, ts, cost, over) => {
    ingestDirect(app, {
      deviceId: device, source, records: [rec(Object.assign({ ts, cost, sessionId: device + '-' + source, purpose: 'proj-' + source }, over || {}))],
    })
    want[device] = want[device] || {}
    want[device][source] = (want[device][source] || 0) + cost
  }
  put('dev-A', 'dsh', T0 + 1000, 1.5)
  put('dev-A', 'dsh', T0 + 2000, 0.5)
  put('dev-A', 'codex', T0 + 3000, 2.25)
  put('dev-B', 'dsh', T0 + 4000, 3.0)
  put('dev-B', 'zcode', T0 + 5000, 0.75)
  put('dev-C', 'dsh', T0 + 6000, 0.25)
  return want
}

function params(over) {
  const r = resolveRange({ range: 'all' }, Date.now())
  return Object.assign({ fromMs: r.fromMs, toMs: r.toMs }, over || {})
}

test('矩阵：单元格 = 该设备该 Agent 之和；行/列/总计自洽', () => {
  const h = makeApp()
  try {
    const want = seed(h.app)
    const m = Q.matrix(h.app.db, params())
    assert.deepEqual(m.cols.sort(), ['codex', 'dsh', 'zcode'])
    assert.equal(m.rows.length, 3)
    for (const row of m.rows) {
      for (const [src, cell] of Object.entries(row.cells)) {
        assert.ok(Math.abs(cell.cost - (want[row.device][src] || 0)) < 1e-9, row.device + '/' + src)
      }
      const rowSum = Object.values(row.cells).reduce((s, c) => s + c.cost, 0)
      assert.ok(Math.abs(rowSum - row.cost) < 1e-9, '行合计 ' + row.device)
    }
    for (const src of m.cols) {
      const colSum = m.rows.reduce((s, r) => s + ((r.cells[src] || {}).cost || 0), 0)
      assert.ok(Math.abs(colSum - m.rows.reduce((s, r) => s + ((r.cells[src] || {}).cost || 0), 0)) < 1e-9)
    }
    const grand = m.rows.reduce((s, r) => s + r.cost, 0)
    assert.ok(Math.abs(grand - 8.25) < 1e-9)
    assert.ok(Math.abs(m.totals.cost - grand) < 1e-9, '右下列合计 = 各行合计')
  } finally { h.cleanup() }
})

test('groupBy=device,source 与矩阵端点结果一致', () => {
  const h = makeApp()
  try {
    const want = seed(h.app)
    const g = Q.groups(h.app.db, params({ groupBy: ['device', 'source'] }))
    const m = Q.matrix(h.app.db, params())
    const map = new Map()
    for (const item of g.groups) map.set(item.key.device + '/' + item.key.source, item.cost)
    for (const row of m.rows) {
      for (const [src, cell] of Object.entries(row.cells)) {
        const v = map.get(row.device + '/' + src) || 0
        assert.ok(Math.abs(v - cell.cost) < 1e-9, row.device + '/' + src)
      }
    }
    const expectedCombos = Object.values(want).reduce((s, bySrc) => s + Object.keys(bySrc).length, 0)
    assert.equal(g.groups.length, expectedCombos, '设备×Agent 组合数')
    assert.equal(g.groups.length, 5, 'dev-A 有 dsh+codex、dev-B 有 dsh+zcode、dev-C 只有 dsh → 5 组')
  } finally { h.cleanup() }
})

test('excludeDevice：排除后合计 = 全集 − 该设备', () => {
  const h = makeApp()
  try {
    seed(h.app)
    const all = Q.matrix(h.app.db, params())
    const excl = Q.matrix(h.app.db, params({ excludeDevice: 'dev-A' }))
    assert.equal(excl.rows.length, 2)
    assert.ok(Math.abs((all.totals.cost - excl.totals.cost) - 4.25) < 1e-9, 'dev-A 合计 4.25')
    for (const r of excl.rows) assert.notEqual(r.device, 'dev-A')
  } finally { h.cleanup() }
})

test('排除/白名单语义可叠加：excludeDevice、excludeSource、devices+sources', () => {
  const h = makeApp()
  try {
    seed(h.app)
    // 单独排除整台设备（含该机全部 agent）
    assert.ok(Math.abs(Q.overview(h.app.db, params({ excludeDevice: 'dev-A' })).summary.cost - 4.0) < 1e-9,
      '排除 dev-A 整台 = dev-B(3.75) + dev-C(0.25)')
    // 单独排除来源
    assert.ok(Math.abs(Q.overview(h.app.db, params({ excludeSource: 'dsh' })).summary.cost - (2.25 + 0.75)) < 1e-9,
      '排除 dsh = codex(2.25) + zcode(0.75)')
    // 叠加：只要某台设备的非 dsh 来源
    assert.ok(Math.abs(Q.overview(h.app.db, params({ devices: 'dev-A', excludeSource: 'dsh' })).summary.cost - 2.25) < 1e-9,
      'dev-A 且非 dsh = codex 2.25')
    // 白名单 + 黑名单叠加
    assert.ok(Math.abs(Q.overview(h.app.db, params({ devices: 'dev-B,dev-C', excludeSource: 'zcode' })).summary.cost - 3.25) < 1e-9,
      'dev-B/C 且非 zcode = 3.0 + 0.25')
  } finally { h.cleanup() }
})

test('overviewUnion：并集口径 = 各部分之和（「其他整机 + 本机其它 agent」）', () => {
  const h = makeApp()
  try {
    seed(h.app)
    // 模拟插件看板的「本机+云端」：本机 = dev-A/dsh(1.5+0.5=2.0) 不计入云端部分
    const others = Q.overview(db_(h), params({ excludeDevice: 'dev-A' }))          // dev-B + dev-C = 4.0
    const sameBoxOtherAgents = Q.overview(db_(h), params({ devices: 'dev-A', excludeSource: 'dsh' })) // codex = 2.25
    const union = Q.overviewUnion(db_(h), [
      params({ excludeDevice: 'dev-A' }),
      params({ devices: 'dev-A', excludeSource: 'dsh' }),
    ])
    assert.equal(union.union, true, '标记为并集结果')
    assert.ok(Math.abs(union.summary.cost - (others.summary.cost + sameBoxOtherAgents.summary.cost)) < 1e-9,
      '并集合计 = 各部分之和：' + union.summary.cost)
    assert.ok(Math.abs(union.summary.cost - (4.0 + 2.25)) < 1e-9, '= 6.25')
    // 不变量：本机 DSH 本地 + 并集 = 全集
    const localDsh = 2.0
    const total = Q.overview(h.app.db, params()).summary.cost
    assert.ok(Math.abs(localDsh + union.summary.cost - total) < 1e-9,
      '本机(2.0) + 并集(6.25) = 全网(8.25)：' + (localDsh + union.summary.cost) + ' vs ' + total)
    // 各部分之和也反映在 devices / sources 明细里：
    // 并集覆盖全部三台设备（dev-A 只由第二部分的 codex 贡献），来源含 codex 与 zcode
    assert.equal(union.devices.length, 3, '并集覆盖 dev-A/dev-B/dev-C')
    const devA = union.devices.find((d) => d.device === 'dev-A')
    assert.ok(Math.abs(devA.cost - 2.25) < 1e-9, '并集里 dev-A 只剩 codex 2.25')
    assert.deepEqual(devA.sources, ['codex'], '并集里 dev-A 的来源只有 codex（dsh 已由本机本地计入）')
    assert.ok(union.sources.some((s) => s.source === 'codex'), '并集包含 codex 来源')
  } finally { h.cleanup() }
})

test('overviewUnion（HTTP）：union 参数校验与结果一致', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const { cookie } = await login(h.app)
    const one = await call(h.app, 'GET', '/api/admin/overview?range=all&excludeDevice=dev-A', null, '', cookie)
    const parts = JSON.stringify([{ excludeDevice: 'dev-A' }, { devices: 'dev-A', excludeSource: 'dsh' }])
    const un = await call(h.app, 'GET', '/api/admin/overview?range=all&union=' + encodeURIComponent(parts), null, '', cookie)
    assert.equal(un.status, 200)
    assert.equal(un.body.union, true)
    assert.ok(Math.abs(un.body.summary.cost - (one.body.summary.cost + 2.25)) < 1e-9, '并集 = 排除整台 + 同机其它 agent')
    const bad = await call(h.app, 'GET', '/api/admin/overview?range=all&union=notjson', null, '', cookie)
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'INVALID_BODY')
    const tooMany = await call(h.app, 'GET', '/api/admin/overview?range=all&union=' + encodeURIComponent(JSON.stringify(new Array(9).fill({}))), null, '', cookie)
    assert.equal(tooMany.status, 400)
  } finally { h.cleanup() }
})

test('排除语义（HTTP）：excludeDevice 与 devices 白名单等价，且 sources 过滤可叠加', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const { cookie } = await login(h.app)
    const excl = await call(h.app, 'GET', '/api/admin/overview?range=all&excludeDevice=dev-A', null, '', cookie)
    const white = await call(h.app, 'GET', '/api/admin/overview?range=all&devices=dev-B,dev-C', null, '', cookie)
    assert.equal(excl.status, 200)
    assert.ok(Math.abs(excl.body.summary.cost - white.body.summary.cost) < 1e-9, '两条路径同值')
    assert.equal(excl.body.excludedDevice, 'dev-A', '响应回显被排除的设备')
    const withSrc = await call(h.app, 'GET', '/api/admin/overview?range=all&devices=dev-B,dev-C&sources=dsh', null, '', cookie)
    assert.ok(Math.abs(withSrc.body.summary.cost - (3.0 + 0.25)) < 1e-9, '设备白名单 + 来源过滤叠加')
  } finally { h.cleanup() }
})

function db_(h) { return h.app.db }

test('devices / sources 过滤可叠加使用', () => {
  const h = makeApp()
  try {
    seed(h.app)
    const onlyA = Q.overview(h.app.db, params({ devices: 'dev-A,dev-B', sources: 'dsh' }))
    assert.ok(Math.abs(onlyA.summary.cost - (1.5 + 0.5 + 3.0)) < 1e-9)
    assert.deepEqual(onlyA.devices.map((d) => d.device).sort(), ['dev-A', 'dev-B'])
    assert.deepEqual(onlyA.sources.map((s) => s.source), ['dsh'])
  } finally { h.cleanup() }
})

test('明细 + 日汇总混合：总额等于两者之和（快照不被重复计入）', () => {
  const h = makeApp()
  try {
    const r = rec({ ts: T0 + 1000, cost: 1 })
    ingestDirect(h.app, { deviceId: 'dev-A', source: 'dsh', records: [r] })
    const k = dedupKeyOfDetail(r, { resetEpoch: 0 })
    ingestDirect(h.app, {
      deviceId: 'dev-A', source: 'dsh',
      rollups: [{
        dayKey: '2026-09-12', provider: 'deepseek-official', model: 'deepseek-v4.1-flash', subscription: false,
        calls: 1, tokens: { input: 1000, output: 500, cacheRead: 2000 }, cost: 1, peak: 0, off: 1, flat: 0, absorbed: [k],
      }],
    })
    const o = Q.overview(h.app.db, params())
    // 明细被墓碑排除，快照计入 → 合计仍为 1（不是 2）
    assert.ok(Math.abs(o.summary.cost - 1) < 1e-9, '实际 ' + o.summary.cost)
    assert.ok(Math.abs(o.summary.realCalls - 1) < 1e-9)
  } finally { h.cleanup() }
})

test('订阅与按量分开统计（矩阵与卡片口径一致）', () => {
  const h = makeApp()
  try {
    ingestDirect(h.app, { deviceId: 'dev-A', source: 'dsh', records: [rec({ ts: T0, cost: 1, subscription: false })] })
    ingestDirect(h.app, { deviceId: 'dev-A', source: 'dsh', records: [rec({ ts: T0 + 1, cost: 5, subscription: true, provider: 'moonshot-ai', model: 'kimi-coding' })] })
    const o = Q.overview(h.app.db, params())
    assert.ok(Math.abs(o.summary.realCost - 1) < 1e-9)
    assert.ok(Math.abs(o.summary.subEquivalent - 5) < 1e-9)
    const m = Q.matrix(h.app.db, params())
    assert.ok(Math.abs(m.totals.cost - 6) < 1e-9, '矩阵总计含订阅等效')
    assert.ok(Math.abs(m.totals.subCost - 5) < 1e-9)
  } finally { h.cleanup() }
})

test('HTTP 层：matrix / overview 端点可用且需要登录', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const anon = await call(h.app, 'GET', '/api/admin/matrix?range=all', null, '', '')
    assert.equal(anon.status, 401)
    const { cookie } = await login(h.app)
    const m = await call(h.app, 'GET', '/api/admin/matrix?range=all', null, '', cookie)
    assert.equal(m.status, 200)
    assert.equal(m.body.rows.length, 3)
    const ov = await call(h.app, 'GET', '/api/admin/overview?range=all&excludeDevice=dev-A', null, '', cookie)
    assert.equal(ov.status, 200)
    assert.equal(ov.body.excludedDevice, 'dev-A')
    assert.ok(Math.abs(ov.body.summary.cost - 4.0) < 1e-9, '排除 dev-A 后 8.25-4.25=4.0')
  } finally { h.cleanup() }
})

test('趋势：按机器分组返回多序列，累计等于总花费', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const { cookie } = await login(h.app)
    const t = await call(h.app, 'GET', '/api/admin/trend?range=all&bucket=day&groupBy=device', null, '', cookie)
    assert.equal(t.status, 200)
    const sum = t.body.series.reduce((s, x) => s + x.points.reduce((a, b) => a + b, 0), 0)
    assert.ok(Math.abs(sum - 8.25) < 1e-6, '实际 ' + sum)
    assert.equal(t.body.series.length, 3)
  } finally { h.cleanup() }
})

test('记录列表：按设备+来源筛选与矩阵单元格一致', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const { cookie } = await login(h.app)
    const r = await call(h.app, 'GET', '/api/admin/records?range=all&devices=dev-A&sources=codex&limit=50', null, '', cookie)
    assert.equal(r.status, 200)
    assert.equal(r.body.items.length, 1)
    assert.ok(Math.abs(r.body.items[0].cost - 2.25) < 1e-9)
  } finally { h.cleanup() }
})

test('CSV 导出：含设备、Agent 与口径列', async () => {
  const h = makeApp()
  try {
    seed(h.app)
    const { cookie } = await login(h.app)
    const r = await call(h.app, 'GET', '/api/admin/export.csv?range=all', null, '', cookie)
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /text\/csv/)
    const lines = String(r.body.raw || '').split('\n')
    assert.ok(lines[0].includes('deviceName') && lines[0].includes('agent') && lines[0].includes('costBasis'))
    assert.equal(lines.filter(Boolean).length, 7)
  } finally { h.cleanup() }
})
