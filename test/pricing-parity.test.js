// ============================================================
// 计费口径测试（云端权威重算）
//
// 目的：把「云端算出的费用」钉死在一个**独立计算的期望值**上。
// 期望值由用例内自算（价格表常量 × token 数 × 闲时系数），不调用被测实现，
// 因此任何回归（单价改错、峰谷判断错、缓存写入口径错）都会被抓到。
// 与插件 dsh-cost-tracker/pricing.js 的同源一致性由 scripts/check-pricing-sync.js
// （跨仓库比对）负责。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeCostAt, isPeak, normalizeProvider, priceFor, eraAt, PRICE_ERAS, PEAK_HOUR_WINDOWS, V41_FLASH_MODEL, V41_PRO_ROUTE_AT } from '../src/pricing.js'
import { dayKey, monthKey, dayStartMs, enumerateDays, resolveRange } from '../src/time.js'

/** 期望值：按高峰价 × 闲时系数独立计算 */
function expectCost(rates, peak, t) {
  const f = peak ? 1 : 0.5
  return (t.input * rates.input + t.output * rates.output + (t.cacheRead + t.cacheWrite) * rates.cacheRead) * f / 1e6
}

const V41 = { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 }
const LEGACY_FLASH = { input: 3.0, output: 9.0, cacheRead: 0.1 }
const PRO = { input: 9.0, output: 27.0, cacheRead: 0.3, cacheWrite: 0.3 }

test('V4.1 Flash 时代：高峰价与闲时半价逐条对得上', () => {
  const tokens = { input: 100000, output: 20000, cacheRead: 500000, cacheWrite: 1000, reasoning: 0 }
  // 北京时间 2026-09-11 周五 10:00（高峰期，V4.1 Flash 价已生效）
  const peakTs = Date.UTC(2026, 8, 11, 2, 0, 0)
  // 北京时间 2026-09-11 周五 13:00（闲时）
  const offTs = Date.UTC(2026, 8, 11, 5, 0, 0)
  assert.equal(eraAt(peakTs).id, 'v41')
  assert.equal(isPeak(peakTs), true)
  assert.equal(isPeak(offTs), false)
  // 官方现役模型名（价格卡脚注 (1)：模型名请使用 deepseek-flash）
  const peak = computeCostAt('deepseek-official', 'deepseek-flash', peakTs, tokens)
  const off = computeCostAt('deepseek-official', 'deepseek-flash', offTs, tokens)
  assert.ok(Math.abs(peak.cost - expectCost(V41, true, tokens)) < 1e-9, 'peak ' + peak.cost)
  assert.ok(Math.abs(off.cost - expectCost(V41, false, tokens)) < 1e-9, 'off ' + off.cost)
  assert.ok(Math.abs(off.cost * 2 - peak.cost) < 1e-9, '闲时恰好半价')
  assert.equal(peak.period, 'peak')
  assert.equal(off.period, 'off-peak')
  assert.equal(peak.model, V41_FLASH_MODEL, '以官方现役名入账')
  assert.equal(peak.estimated, false, '现役名走精确档，不得标记为估算')
  // 等价写法 deepseek-v4.1-flash 归一化后命中同一档
  const alias = computeCostAt('deepseek-official', 'deepseek-v4.1-flash', peakTs, tokens)
  assert.equal(alias.model, V41_FLASH_MODEL, 'deepseek-v4.1-flash 归一到 deepseek-flash')
  assert.equal(alias.estimated, false, '别名同样走精确档')
  assert.equal(alias.cost, peak.cost, '别名与现役名同价')
})

test('周末全天闲时（与插件同口径）', () => {
  // 2026-09-12 是周六；北京时间 10:00 仍为闲时价
  const sat = Date.UTC(2026, 8, 12, 2, 0, 0)
  assert.equal(new Date(sat + 28800000).getUTCDay(), 6, '确认是周六')
  assert.equal(isPeak(sat), false)
  const c = computeCostAt('deepseek-official', 'deepseek-flash', sat, { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  assert.ok(Math.abs(c.cost - 1.0) < 1e-9, '2.0 CNY/1M × 1M × 0.5 = 1.0，实际 ' + c.cost)
})

test('计费时代：同一模型在 v41 生效前后取不同价，且路由到 V4.1 Flash', () => {
  // 生效时刻 = 北京时间 2026-09-10 12:00（UTC 04:00）
  // 之前：北京时间 2026-09-09 22:00（闲时）；之后：北京时间 13:00（同属闲时），只比较时代价差
  const before = Date.UTC(2026, 8, 9, 14, 0, 0)
  const after = Date.UTC(2026, 8, 10, 5, 0, 0)
  assert.equal(isPeak(before), false, '北京时间 22:00 属闲时')
  assert.equal(isPeak(after), false, '北京时间 13:00 属闲时')
  assert.equal(eraAt(before).id, 'legacy')
  assert.equal(eraAt(after).id, 'v41')
  const tokens = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  // 旧 V4-Flash：闲时 3.0 × 0.5 = 1.5；v41 路由到 V4.1 Flash：闲时 2.0 × 0.5 = 1.0
  const a = computeCostAt('deepseek-official', 'deepseek-v4-flash', before, tokens)
  const b = computeCostAt('deepseek-official', 'deepseek-v4-flash', after, tokens)
  assert.ok(Math.abs(a.cost - expectCost(LEGACY_FLASH, false, tokens)) < 1e-9, 'legacy ' + a.cost)
  assert.equal(b.model, V41_FLASH_MODEL, '记录以官方现役计费模型名入账')
  assert.ok(Math.abs(b.cost - expectCost(V41, false, tokens)) < 1e-9, 'v41 ' + b.cost)
})

test('V4-Pro 路由时刻：9-14 12:00 前按自有牌价，之后路由到 V4.1 Flash', () => {
  // 官方通告：北京时间 2026-09-14 12:00 之后 deepseek-v4-pro 才路由到 V4.1 Flash
  assert.equal(V41_PRO_ROUTE_AT, Date.UTC(2026, 8, 14, 4, 0, 0))
  const tokens = { input: 100000, output: 20000, cacheRead: 500000, cacheWrite: 0, reasoning: 0 }
  // 窗口内：北京时间 2026-09-12 周六 10:00（闲时，Flash 已调价但 V4-Pro 仍是自有牌价）
  const midTs = Date.UTC(2026, 8, 12, 2, 0, 0)
  // 路由后：北京时间 2026-09-15 周二 10:00（高峰）
  const postTs = Date.UTC(2026, 8, 15, 2, 0, 0)
  assert.equal(eraAt(midTs).id, 'v41')
  assert.equal(eraAt(postTs).id, 'v41pro')
  const mid = computeCostAt('deepseek-official', 'deepseek-v4-pro', midTs, tokens)
  assert.equal(mid.model, 'deepseek-v4-pro', '路由前保持自有模型名')
  assert.equal(mid.estimated, false, '路由前仍走精确档（不得落入兜底估算）')
  assert.ok(Math.abs(mid.cost - expectCost(PRO, false, tokens)) < 1e-9, '路由前按 V4-Pro 闲时价 ' + mid.cost)
  const post = computeCostAt('deepseek-official', 'deepseek-v4-pro', postTs, tokens)
  assert.equal(post.model, V41_FLASH_MODEL, '路由后改按 V4.1 Flash 入账')
  assert.ok(Math.abs(post.cost - expectCost(V41, true, tokens)) < 1e-9, '路由后按 Flash 高峰价 ' + post.cost)
  // 边界：路由时刻前一毫秒仍未路由
  const edge = computeCostAt('deepseek-official', 'deepseek-v4-pro', V41_PRO_ROUTE_AT - 1, tokens)
  assert.equal(edge.model, 'deepseek-v4-pro', '12:00 前一毫秒仍未路由')
  const edge2 = computeCostAt('deepseek-official', 'deepseek-v4-pro', V41_PRO_ROUTE_AT, tokens)
  assert.equal(edge2.model, V41_FLASH_MODEL, '12:00 整点起路由')
})

test('provider 归一化：-official 后缀不影响兜底价命中', () => {
  assert.equal(normalizeProvider('DeepSeek-Official'), 'deepseek')
  assert.equal(normalizeProvider('deepseek'), 'deepseek')
  const a = computeCostAt('deepseek-official', 'some-unknown-model', Date.UTC(2026, 8, 10, 5, 0), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  const b = computeCostAt('deepseek', 'some-unknown-model', Date.UTC(2026, 8, 10, 5, 0), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  assert.equal(a.cost, b.cost)
  assert.equal(a.estimated, true, '未知模型标记为估算')
})

test('订阅 provider 走等效费用口径', () => {
  const p = priceFor('kimi-coding', 'kimi-coding', Date.now())
  assert.equal(p.subscription, true)
  const c = computeCostAt('moonshot-ai', 'kimi-coding', Date.UTC(2026, 8, 12, 5, 0), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  assert.ok(c.cost > 0)
  assert.equal(c.period, 'flat', '订阅没有峰谷分段')
})

test('价格表结构完整（era / routes / 峰窗口）', () => {
  assert.equal(PRICE_ERAS.length, 3, 'legacy / v41 / v41pro 三个计费时代')
  assert.equal(V41_FLASH_MODEL, 'deepseek-flash', '规范名 = 官方现役模型名')
  assert.equal(PRICE_ERAS[2].routes['deepseek-v4-pro'], V41_FLASH_MODEL)
  assert.equal(PRICE_ERAS[1].routes['deepseek-v4-pro'], undefined, 'v41 时代不含 V4-Pro 路由（9-14 12:00 才生效）')
  assert.equal(PRICE_ERAS[1].routes['deepseek-v4-flash'], V41_FLASH_MODEL)
  assert.equal(PRICE_ERAS[1].models['deepseek-v4-pro'].input, 9.0, '路由前保留 V4-Pro 自有牌价')
  assert.deepEqual(PEAK_HOUR_WINDOWS, [{ start: 9, end: 12 }, { start: 14, end: 18 }])
})

test('北京时间分桶：日/月/区间边界', () => {
  // 北京时间 2026-09-12 00:00 = UTC 2026-09-11 16:00
  const bjMidnight = Date.UTC(2026, 8, 11, 16, 0, 0)
  assert.equal(dayKey(bjMidnight), '2026-09-12')
  assert.equal(dayKey(bjMidnight - 1), '2026-09-11')
  assert.equal(monthKey(bjMidnight), '2026-09')
  assert.equal(dayStartMs(bjMidnight), bjMidnight)
  assert.deepEqual(enumerateDays('2026-09-10', '2026-09-12'), ['2026-09-10', '2026-09-11', '2026-09-12'])
  assert.deepEqual(enumerateDays('2026-09-12', '2026-09-10'), [])
  const r = resolveRange({ range: 'today' }, bjMidnight)
  assert.equal(r.fromMs, bjMidnight)
  const m = resolveRange({ range: 'month' }, bjMidnight)
  assert.equal(m.fromMs, Date.UTC(2026, 7, 31, 16, 0, 0), '本月从北京时间 9/1 00:00 起')
  const y = resolveRange({ range: 'year' }, bjMidnight)
  assert.equal(y.fromMs, Date.UTC(2025, 11, 31, 16, 0, 0))
  const all = resolveRange({ range: 'all' }, bjMidnight)
  assert.equal(all.fromMs, 0)
  // 看板新增的「近 90 天」预设：必须被解析成滚动窗口，而不是落到 default（= 全部）
  const d90 = resolveRange({ range: '90d' }, bjMidnight)
  assert.equal(d90.range, '90d')
  assert.equal(d90.fromMs, bjMidnight - 90 * 86400000)
  assert.equal(d90.toMs, bjMidnight + 1)
  assert.equal(d90.label, '近 90 天')
  // 自定义区间（热力图点格子下钻用）优先级最高
  const custom = resolveRange({ range: '7d', from: String(bjMidnight - 1000), to: String(bjMidnight) }, bjMidnight)
  assert.equal(custom.range, 'custom')
  assert.equal(custom.fromMs, bjMidnight - 1000)
  assert.equal(custom.toMs, bjMidnight)
})

test('时间区间枚举上限（防止超长轴拖垮页面）', () => {
  const days = enumerateDays('1970-01-01', '2026-09-12', 30)
  assert.equal(days.length, 30)
  assert.equal(days[days.length - 1], '2026-09-12')
})
