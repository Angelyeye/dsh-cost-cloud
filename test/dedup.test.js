// ============================================================
// 去重键契约测试（docs/INGEST-API.md §6）
// 这些用例守护对外契约：任何实现都必须产生同样的 dedupKey。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detailCanonical, rollupCanonical, dedupKeyOfDetail, dedupKeyOfRollup,
  cost6, toInt, SEP, CONTRACT_VECTOR, SOURCE_RE,
} from '../src/dedup.js'

test('契约测试向量：canonical 串与文档完全一致', () => {
  const c = detailCanonical(CONTRACT_VECTOR.record, { resetEpoch: CONTRACT_VECTOR.resetEpoch })
  assert.equal(c, CONTRACT_VECTOR.canonical)
})

test('canonical 串对字段书写顺序不敏感', () => {
  const a = detailCanonical({ ts: 1, provider: 'P', model: 'M', tokens: { input: 1, output: 2 }, cost: 0.5 }, {})
  const b = detailCanonical({ cost: 0.5, tokens: { output: 2, input: 1 }, model: 'M', provider: 'P', ts: 1 }, {})
  assert.equal(a, b)
})

test('字符串 trim + provider/model 小写', () => {
  assert.equal(detailCanonical({ ts: 1, provider: '  DeepSeek-Official ', model: ' DeepSeek-V4.1-Flash ', tokens: { input: 0, output: 0 }, cost: 0 }, {}),
    ['detail', 0, 1, 'deepseek-official', 'deepseek-v4.1-flash', '', '', 0, 0, 0, 0, 0, '0'].join(SEP))
})

test('费用取 6 位小数的最短表示（1.5 而非 1.500000）', () => {
  assert.equal(cost6(1.5), '1.5')
  assert.equal(cost6(0.01624808), '0.016248')
  assert.equal(cost6(0), '0')
  assert.equal(cost6(123.456789), '123.456789')
  assert.equal(cost6(-0), '0')
  assert.equal(cost6(NaN), '0')
})

test('token 取整、非有限值按 0', () => {
  assert.equal(toInt(12.9), 12)
  assert.equal(toInt(-3.2), -3)
  assert.equal(toInt(undefined), 0)
  assert.equal(toInt('7'), 7)
  assert.equal(toInt(Infinity), 0)
})

test('resetEpoch 参与计算：重置后重新导入不判为重复', () => {
  const r = CONTRACT_VECTOR.record
  const k0 = dedupKeyOfDetail(r, { resetEpoch: 0 })
  const k1 = dedupKeyOfDetail(r, { resetEpoch: 1 })
  assert.notEqual(k0, k1)
  assert.match(k0, /^[0-9a-f]{64}$/)
})

test('明细内容不同 → 键不同（cost / tokens / session / ts 任一变化）', () => {
  const base = { ts: 100, provider: 'p', model: 'm', sessionId: 's', purpose: '', tokens: { input: 1, output: 1 }, cost: 1 }
  const keys = new Set([
    dedupKeyOfDetail(base, {}),
    dedupKeyOfDetail(Object.assign({}, base, { cost: 1.000001 }), {}),
    dedupKeyOfDetail(Object.assign({}, base, { tokens: { input: 2, output: 1 } }), {}),
    dedupKeyOfDetail(Object.assign({}, base, { sessionId: 's2' }), {}),
    dedupKeyOfDetail(Object.assign({}, base, { ts: 101 }), {}),
  ])
  assert.equal(keys.size, 5)
})

test('rollup canonical：只按 dayKey + provider + model 区分，且不受可变指标影响', () => {
  const s = { dayKey: '2026-03-04', provider: 'P', model: 'M', subscription: false, tokens: { input: 1, output: 2 }, cost: 3 }
  const c = rollupCanonical(s)
  assert.equal(c, ['rollup:2026-03-04', '0', 'p', 'm'].join(SEP))
  assert.match(dedupKeyOfRollup(s), /^[0-9a-f]{64}$/)
  // 同一天继续使用：calls / tokens / cost 增长，身份不变（否则会重复计数）
  assert.equal(rollupCanonical(Object.assign({}, s, { calls: 9, tokens: { input: 99, output: 88 }, cost: 42 })), c)
  // 换天 / 换模型 → 不同身份
  assert.notEqual(rollupCanonical(Object.assign({}, s, { dayKey: '2026-03-05' })), c)
  assert.notEqual(rollupCanonical(Object.assign({}, s, { model: 'M2' })), c)
  // 订阅口径与按量口径分离
  assert.notEqual(rollupCanonical(Object.assign({}, s, { subscription: true })), c)
})

test('source 命名约定正则', () => {
  for (const good of ['dsh', 'zcode', 'codex', 'claude-code', 'a1', 'x'.repeat(32)]) assert.ok(SOURCE_RE.test(good), good)
  for (const bad of ['', 'Dsh', '-dsh', 'd sh', 'x'.repeat(33), 'dsh_1', '中文']) assert.ok(!SOURCE_RE.test(bad), bad)
})
