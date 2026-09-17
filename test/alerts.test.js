// ============================================================
// 监控告警规则（web/alerts.js）—— 纯函数单测
//
// 告警是「监控」页的核心产出：报错了会误导，漏报了等于没有监控。
// 这里逐条规则给正例 + 反例，并守护两件容易写错的事：
//   · 阈值来自 prefs（用户可调），改动必须真的改变结论
//   · 概览切片用的是 {real} 字段（不是 realCost），预算/尖峰规则不能因此失灵
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom } from './dom-shim.mjs'

installDom() // alerts.js → state.js 会读 localStorage，先装上桩

const { computeAlerts, summarizeAlerts } = await import('../web/alerts.js')

const HOUR = 3600000
const DAY = 86400000
const NOW = Date.UTC(2026, 8, 17, 4, 0, 0) // 北京 12:00

/** 概览切片用真实形状 {real, calls, tokens, sub, ...} */
const slice = (real, calls, tokens, sub) => ({ real, calls, tokens, sub: sub || 0, subCalls: 0, subTokens: 0 })
const base = () => ({
  now: NOW,
  prefs: {},
  health: { lastIngestAt: NOW - 60000, serviceVersion: '1.3.0' },
  config: { timezone: 'Asia/Shanghai' },
  overview: {
    range: '7d',
    summary: {
      realCost: 10, realCalls: 100, realTokens: 1000, subEquivalent: 0, subCalls: 0, subTokens: 0,
      cost: 10, calls: 100, tokens: 1000, rows: 100, estimatedRows: 0, driftAbs: 0,
      peakCost: 1, offCost: 2, flatCost: 0, input: 1000, cacheRead: 4000,
    },
    today: slice(1.0, 10, 100),
    month: slice(10, 100, 1000),
    all: slice(10, 100, 1000),
  },
  syncHealth: { items: [{ deviceName: '台式机', source: 'dsh', pluginVersion: '1.8.8', lastIngestAt: NOW - 60000, lagMs: 60000, clockSkewMs: 0, accepted: 10, duplicates: 0, invalid: 0, disabled: false }] },
  subscriptions: { items: [] },
  heatmap: { summary: { last7: { days: 7, cost: 7, avgCost: 1, calls: 70 } } },
})

const codes = (alerts) => alerts.map((a) => a.code)
const find = (alerts, code) => alerts.find((a) => a.code === code)

test('alerts: 一切正常时没有任何告警', () => {
  const alerts = computeAlerts(base())
  assert.deepEqual(alerts, [], '干净数据不应产生告警')
  assert.deepEqual(summarizeAlerts(alerts), { error: 0, warn: 0, info: 0, total: 0, level: 'ok' })
})

test('alerts: 云端静默（含从未上报）', () => {
  const never = computeAlerts(Object.assign(base(), { health: { lastIngestAt: 0 } }))
  assert.ok(codes(never).includes('cloud-never-ingest'))

  const late = base()
  late.health = { lastIngestAt: NOW - 30 * HOUR }
  assert.ok(codes(computeAlerts(late)).includes('cloud-silent'), '超过 6 小时（默认阈值）应告警')

  const justNow = base()
  justNow.health = { lastIngestAt: NOW - 3 * HOUR }
  assert.deepEqual(codes(computeAlerts(justNow)), [], '3 小时以内不算静默')
})

test('alerts: 同步停滞按 3 倍阈值升级为严重，且跳过已禁用设备', () => {
  const it = (over) => Object.assign({
    deviceName: '笔记本', source: 'dsh', pluginVersion: '1.8.8', lastIngestAt: NOW - 30 * HOUR,
    lagMs: 30 * HOUR, clockSkewMs: 0, accepted: 1, duplicates: 0, invalid: 0, disabled: false,
  }, over || {})

  const warn = computeAlerts(Object.assign(base(), { syncHealth: { items: [it()] } }))
  assert.equal(find(warn, 'sync-stale').level, 'warn', '超过 24 小时 → 警告')

  const err = computeAlerts(Object.assign(base(), { syncHealth: { items: [it({ lagMs: 100 * HOUR, lastIngestAt: NOW - 100 * HOUR })] } }))
  assert.equal(find(err, 'sync-stale').level, 'error', '超过 72 小时 → 严重')

  const skipped = computeAlerts(Object.assign(base(), { syncHealth: { items: [it({ disabled: true })] } }))
  assert.deepEqual(codes(skipped), [], '已禁用的设备不再告警')

  // 阈值可调：把停滞阈值调到 7 天，30 小时就不再是问题
  const relaxed = computeAlerts(Object.assign(base(), { syncHealth: { items: [it()] }, prefs: { staleHours: 168 } }))
  assert.deepEqual(codes(relaxed), [], '阈值放宽后不应再报同一件事')
})

test('alerts: 时钟偏差 / 非法记录 / 全量重传', () => {
  const mk = (over) => Object.assign(base(), {
    syncHealth: {
      items: [Object.assign({
        deviceName: '台式机', source: 'dsh', pluginVersion: '1.8.8', lastIngestAt: NOW - 60000,
        lagMs: 60000, clockSkewMs: 0, accepted: 10, duplicates: 0, invalid: 0, disabled: false,
      }, over)],
    },
  })
  assert.ok(codes(computeAlerts(mk({ clockSkewMs: 20 * 60000 }))).includes('clock-skew'), '20 分钟偏差 → 告警')
  assert.ok(!codes(computeAlerts(mk({ clockSkewMs: 60 * 1000 }))).includes('clock-skew'), '1 分钟偏差 → 不告警')
  assert.ok(codes(computeAlerts(mk({ invalid: 3 }))).includes('ingest-invalid'))
  assert.ok(codes(computeAlerts(mk({ duplicates: 900, accepted: 5 }))).includes('ingest-dedup'), '去重率 >90% 且量足够大 → 提示')
  assert.ok(!codes(computeAlerts(mk({ duplicates: 3, accepted: 5 }))).includes('ingest-dedup'), '少量去重是幂等生效，不该报警')
})

test('alerts: 口径漂移 / 估算占比 / 缓存命中率', () => {
  const withSummary = (over) => {
    const c = base()
    c.overview = Object.assign({}, c.overview, { summary: Object.assign({}, c.overview.summary, over) })
    return c
  }
  assert.ok(codes(computeAlerts(withSummary({ driftAbs: 3.2 }))).includes('cost-drift'))
  assert.ok(!codes(computeAlerts(withSummary({ driftAbs: 0.3 }))).includes('cost-drift'), '低于阈值不报')
  assert.ok(codes(computeAlerts(withSummary({ estimatedRows: 60, rows: 100 }))).includes('cost-estimated'))
  assert.ok(!codes(computeAlerts(withSummary({ estimatedRows: 5, rows: 100 }))).includes('cost-estimated'))
  // 命中率 200000/(50000+200000) = 80% → 正常；调高下限到 90% 后必须报出来
  const big = { input: 50000, cacheRead: 200000 }
  assert.ok(!codes(computeAlerts(withSummary(big))).includes('cache-hit-low'), '80% 命中率高于默认下限 50%')
  const strict = withSummary(big)
  strict.prefs = { hitRateMin: 0.9 }
  assert.ok(codes(computeAlerts(strict)).includes('cache-hit-low'), '阈值提高后 80% 命中应触发提示')
  // 样本太小时不评判命中率（几百 token 的命中率没有统计意义）
  assert.ok(!codes(computeAlerts(withSummary({ input: 10, cacheRead: 10 }))).includes('cache-hit-low'))
})

test('alerts: 花费尖峰（今日 vs 近 7 日均值）', () => {
  const spike = base()
  spike.overview.today = slice(9.0, 90, 900)
  assert.ok(codes(computeAlerts(spike)).includes('cost-spike'), '今日是均值 9 倍 → 告警')

  const mild = base()
  mild.overview.today = slice(2.0, 20, 200)
  assert.ok(!codes(computeAlerts(mild)).includes('cost-spike'), '2 倍不算尖峰')

  const noHistory = base()
  noHistory.heatmap = { summary: { last7: { days: 2, avgCost: 1, cost: 2, calls: 2 } } }
  noHistory.overview.today = slice(9.0, 90, 900)
  assert.ok(!codes(computeAlerts(noHistory)).includes('cost-spike'), '样本不足 4 天不做趋势判断')
})

test('alerts: 月度预算（切片用 {real} 字段，不能因字段名读错而失灵）', () => {
  const c = base()
  c.prefs = { budgetMonth: 8 }
  c.overview.month = slice(10, 100, 1000) // 已超预算
  assert.equal(find(computeAlerts(c), 'budget-exceeded').level, 'error')

  const near = base()
  near.prefs = { budgetMonth: 12 }
  near.overview.month = slice(10, 100, 1000) // 83%
  assert.equal(find(computeAlerts(near), 'budget-near').level, 'warn')

  const off = base()
  off.prefs = { budgetMonth: 0 }
  off.overview.month = slice(1000, 1, 1)
  assert.ok(!codes(computeAlerts(off)).includes('budget-exceeded'), '预算 0 = 关闭该规则')

  // 若读成 month.realCost（undefined）→ 会静默变成 0，规则永不触发：这里守住真实形状
  const legacy = base()
  legacy.prefs = { budgetMonth: 8 }
  legacy.overview.month = { realCost: 10, calls: 100, tokens: 1000 }
  assert.ok(codes(computeAlerts(legacy)).includes('budget-exceeded'), '同时兼容 realCost 形状')
})

test('alerts: 订阅闲置 / 插件版本不一致 / 区间空数据', () => {
  const c = base()
  c.subscriptions = { items: [{ key: 'kimi-coding/k3', cost: 1.5, calls: 8, idleDays: 30 }, { key: 'kimi-coding/k3-256k', cost: 20, calls: 300, idleDays: 0 }] }
  const sub = find(computeAlerts(c), 'sub-idle')
  assert.ok(sub, '闲置 30 天（阈值 14）应提示')
  assert.match(sub.title, /kimi-coding\/k3 已 30 天未使用/)

  const vc = base()
  vc.syncHealth.items.push({ deviceName: '笔记本', source: 'dsh', pluginVersion: '1.7.1', lastIngestAt: NOW - 60000, lagMs: 60000, clockSkewMs: 0, accepted: 1, duplicates: 0, invalid: 0 })
  assert.ok(codes(computeAlerts(vc)).includes('plugin-version-drift'))

  const empty = base()
  empty.overview.summary = Object.assign({}, empty.overview.summary, { calls: 0, rows: 0 })
  assert.ok(codes(computeAlerts(empty)).includes('range-empty'))
})

test('alerts: 缺数据的上下文不炸，也不误报', () => {
  assert.deepEqual(computeAlerts({}), [], '空上下文应返回空数组')
  const half = computeAlerts({
    health: { lastIngestAt: NOW - 1000 },
    syncHealth: { items: [] },
    overview: { range: '7d', summary: {} },
  })
  assert.deepEqual(half, [], '半截数据不应产生告警（缺哪块就少算哪几条规则）')
  // lastIngestAt = 0 是**真实信息**（库里确实没有入库批次），不是「数据缺失」→ 必须报
  assert.ok(codes(computeAlerts({ health: { lastIngestAt: 0 } })).includes('cloud-never-ingest'))
  const partial = computeAlerts({ overview: { range: '7d', summary: { calls: 0, rows: 0 } } })
  assert.ok(codes(partial).includes('range-empty'), '唯一可判定的规则仍然生效')
})

test('alerts: 输出有稳定顺序（严重 → 警告 → 提示）与计数摘要', () => {
  const c = base()
  c.health = { lastIngestAt: 0 }                      // warn
  c.overview.summary = Object.assign({}, c.overview.summary, { driftAbs: 5 }) // warn
  c.subscriptions = { items: [{ key: 'kimi-coding/k3', cost: 1, calls: 1, idleDays: 99 }] } // info
  const alerts = computeAlerts(c)
  const rank = { error: 0, warn: 1, info: 2 }
  for (let i = 1; i < alerts.length; i += 1) {
    assert.ok(rank[alerts[i - 1].level] <= rank[alerts[i].level], '必须先严重后提示')
  }
  const s = summarizeAlerts(alerts)
  assert.equal(s.total, alerts.length)
  assert.equal(s.level, 'warn')
  assert.equal(s.warn, 2)
  assert.equal(s.info, 1)
  // 每条告警都要能回答「我该做什么」
  for (const a of alerts) {
    assert.ok(a.title && a.title.length > 4, '告警必须有标题：' + a.code)
    assert.ok(a.hint && a.hint.length > 4, '告警必须给出下一步动作：' + a.code)
  }
  assert.equal(summarizeAlerts([{ level: 'error' }]).level, 'error')
  assert.equal(summarizeAlerts([]).level, 'ok')
})
