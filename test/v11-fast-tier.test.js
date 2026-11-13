// ============================================================
// dsh-cost-cloud —— v1.11.0 专项：目录汇率迁移 + Fast 档入库 + 中文单位
//   node --test test/v11-fast-tier.test.js
//
// 拦的是「云端与插件口径漂移」这类问题：
//   ① 库里残留旧默认 7.2 时必须迁到 6.67，管理员自定义值不得被动；
//   ② meta.serviceTier='fast' 的记录必须按 Fast 价重算（与插件入账一致）；
//   ③ 旧客户端（无 meta）必须仍是 standard，金额与 1.10.x 一致；
//   ④ 看板 token 格式化必须是中文单位且与插件同规则。
// ============================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setMeta, getMeta } from '../src/db.js'
import { catalogConfig, CATALOG_FX_META, catalogInfo } from '../src/catalog.js'
import { tierOfMeta } from '../src/ingest.js'
import { computeCostAt } from '../src/pricing.js'
import { catalogEntryFor, CATALOG_FX_DEFAULT } from '../src/vendor-catalog.js'
import { fmtTokens } from '../web/state.js'
import { makeApp } from './helpers.js'

/** 复用服务端的临时实例（自建库 + 迁移），用完清理 */
function makeDb() {
  const { app, cleanup } = makeApp()
  return { db: app.db, cleanup }
}

test('汇率迁移：残留旧默认 7.2 迁到 6.67，自定义值保留', () => {
  const { db, cleanup } = makeDb()
  try {
    // 旧版本写入的默认值
    setMeta(db, CATALOG_FX_META, '7.2')
    const cfg = catalogConfig(db)
    assert.equal(cfg.fx, CATALOG_FX_DEFAULT, '旧默认应迁移到新默认')
    assert.equal(getMeta(db, CATALOG_FX_META, ''), String(CATALOG_FX_DEFAULT), '迁移应写回库')

    // 管理员显式设置的自定义值不动
    setMeta(db, CATALOG_FX_META, '6.9')
    assert.equal(catalogConfig(db).fx, 6.9, '自定义汇率不得被覆盖')

    // 非法值回退默认
    setMeta(db, CATALOG_FX_META, 'abc')
    assert.equal(catalogConfig(db).fx, CATALOG_FX_DEFAULT, '非法值回退默认')
  } finally {
    cleanup()
  }
})

test('tierOfMeta：只认 fast，其它一律 standard', () => {
  assert.equal(tierOfMeta(JSON.stringify({ serviceTier: 'fast' })), 'fast')
  assert.equal(tierOfMeta({ serviceTier: 'FAST' }), 'fast')
  assert.equal(tierOfMeta(JSON.stringify({ serviceTier: 'standard' })), 'standard')
  assert.equal(tierOfMeta(''), 'standard')
  assert.equal(tierOfMeta(null), 'standard')
  assert.equal(tierOfMeta('not json'), 'standard')
  assert.equal(tierOfMeta(JSON.stringify({ other: 1 })), 'standard')
})

test('Fast 档：按目录 fast 价计费，约为标准档 2 倍', () => {
  const { db, cleanup } = makeDb()
  try {
    const fx = catalogConfig(db).fx
    const tokens = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
    const cat = (np, m, extra) => catalogEntryFor(np, m, { mode: 'fuzzy', fx, serviceTier: extra && extra.serviceTier, tokens: extra && extra.tokens })
    const ts = Date.UTC(2026, 10, 13, 5)

    const std = computeCostAt('openai', 'gpt-6.1-sol', ts, tokens, { catalog: cat })
    const fast = computeCostAt('openai', 'gpt-6.1-sol', ts, tokens, { catalog: cat, serviceTier: 'fast' })
    assert.equal(std.serviceTier, 'standard')
    assert.equal(fast.serviceTier, 'fast')
    assert.ok(Math.abs(fast.cost / std.cost - 2) < 1e-9, `${fast.cost} vs ${std.cost}`)

    // 具体数额：$2/$10 → $4/$20，×6.67
    const expectFast = (1000 / 1e6 * 4 + 500 / 1e6 * 20) * fx
    assert.ok(Math.abs(fast.cost - expectFast) < 1e-6, `${fast.cost} vs ${expectFast}`)
  } finally {
    cleanup()
  }
})

test('无 Fast 档价的模型：即使传 fast 也按标准价（不凭空加价）', () => {
  const { db, cleanup } = makeDb()
  try {
    const fx = catalogConfig(db).fx
    const tokens = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
    const cat = (np, m, extra) => catalogEntryFor(np, m, { mode: 'fuzzy', fx, serviceTier: extra && extra.serviceTier, tokens: extra && extra.tokens })
    const ts = Date.UTC(2026, 10, 13, 5)
    const std = computeCostAt('openai', 'gpt-5.4', ts, tokens, { catalog: cat })
    const fast = computeCostAt('openai', 'gpt-5.4', ts, tokens, { catalog: cat, serviceTier: 'fast' })
    assert.ok(Math.abs(fast.cost - std.cost) < 1e-12, '无 Fast 报价时金额必须相同')
  } finally {
    cleanup()
  }
})

test('目录状态回显：包含 fastTierModelCount 与刷新日期', () => {
  const { db, cleanup } = makeDb()
  try {
    const info = catalogInfo(db)
    assert.ok(info.fastTierModelCount >= 6, String(info.fastTierModelCount))
    assert.equal(info.meta.generatedAt, '2026-11-13')
    assert.equal(info.fxRate, 6.67)
  } finally {
    cleanup()
  }
})

test('看板 token 格式化：中文单位，与插件同规则', () => {
  const cases = [
    [0, '0'], [999, '999'], [9999, '9,999'],
    [10000, '1万'], [314200, '31.4万'], [1500000, '150万'], [31382777, '3138万'],
    [100000000, '1亿'], [150000000, '1.5亿'], [32768000000, '327.7亿'],
  ]
  for (const [input, want] of cases) {
    assert.equal(fmtTokens(input), want, `${input} should be ${want}`)
  }
  // 不得出现英文单位
  for (const [input] of cases) {
    assert.ok(!/[KMB]$/.test(fmtTokens(input)), `${input} 不得以英文单位结尾`)
  }
})
