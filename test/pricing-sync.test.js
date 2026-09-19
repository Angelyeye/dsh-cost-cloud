// ============================================================
// dsh-cost-cloud 官方价格同步 + 多厂商目录 测试
//   node --test test/pricing-sync.test.js（由 npm test 统一跑）
//
// 覆盖 v1.4.0 的云端定价能力：
//   ① 解析器与插件同源（同一份 price-sync.js 读出同一批价）；
//   ② 核对（dry-run）不落库；应用（apply）把新计费时代写进 meta 并注入 pricing；
//   ③ 重启（重新 createServer）后同步时代自动恢复 —— 不需要重新抓页面；
//   ④ 新价只影响生效时刻之后的算价，历史时间戳仍走内置价（口径不回改）；
//   ⑤ 坏页面/网络失败 → 不改动既有时代，只记 lastCheck 失败原因；
//   ⑥ 目录价参与云端算价（与插件侧一致），关闭目录后回落内置表口径；
//   ⑦ 管理端鉴权：未登录不得读写定价与目录配置。
// 全程离线：抓取用注入的桩 fetch（不打真实网络）。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { makeApp, testConfig, rec } from './helpers.js'
import { call, login } from './http-client.js'
import { resolveConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { getMeta, setMeta } from '../src/db.js'
import { loadPricingEras, runPricingSync, pricingStatus, PRICING_ERAS_META, DEFAULT_PRICING_SYNC_URL } from '../src/pricing-eras.js'
import { catalogInfo, catalogOpts, setCatalogConfig } from '../src/catalog.js'
import { catalogEntryFor } from '../src/vendor-catalog.js'
import { priceFor, computeCost, computeCostAt, setSyncedEras, setPriceOverrides } from '../src/pricing.js'

/** 合成一份与官方页同结构的定价 HTML（列=模型，行=指标×时段） */
function page(models, oldNames) {
  const half = (v) => String(v / 2)
  const names = models.map((m) => '<td>' + m.name + '</td>').join('')
  const metric = (label, second, key) =>
    `<tr><td>${label}</td><td>${second}</td></tr>` +
    `<tr><td>空闲时段</td>${models.map((m) => '<td>' + half(m[key]) + '元</td>').join('')}</tr>` +
    `<tr><td>高峰时段</td>${models.map((m) => '<td>' + m[key] + '元</td>').join('')}</tr>`
  const note = oldNames && oldNames.length
    ? `<p>(1) 旧模型名 ${oldNames.join('、')} 仍可调用，由 ${models[0].name} 提供服务并按 Flash 价格计费。</p>`
    : ''
  return `<!doctype html><html><body>
<h1>模型 &amp; 价格 | DeepSeek API Docs</h1>
<h2>模型细节</h2>
<table><tr><td>模型</td>${names}</tr><tr><td>BASE URL (OpenAI 格式)</td>${models.map(() => '<td>x</td>').join('')}</tr></table>
<h2>价格</h2>(2)
<table>
${metric('百万tokens输入', '（缓存命中）', 'cacheHit')}
${metric('百万tokens输入', '（缓存未命中）', 'input')}
<tr><td>百万tokens输出</td></tr>
<tr><td>空闲时段</td>${models.map((m) => '<td>' + half(m.output) + '元</td>').join('')}</tr>
<tr><td>高峰时段</td>${models.map((m) => '<td>' + m.output + '元</td>').join('')}</tr>
</table>
<h2>并发限制</h2>(3)
<table><tr>${models.map(() => '<td>2500</td>').join('')}</tr></table>
<p>(2) 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包含周末，为优惠时段。</p>
${note}
</body></html>`
}
const NEW_PAGE = page([
  { name: 'deepseek-flash', input: 1.5, output: 6, cacheHit: 0.03 },
  { name: 'deepseek-v4-pro', input: 7, output: 21, cacheHit: 0.2 },
], ['deepseek-v4-flash'])
const stubFetch = (html, status) => async () => ({
  status: status === undefined ? 200 : status,
  headers: { get: () => null },
  text: async () => html,
})

test('价格同步：核对 → 应用 → 重启恢复 → 历史口径不回改', async () => {
  setSyncedEras([])
  setPriceOverrides({})
  const { dir, config, app, cleanup } = makeApp()
  try {
    // 冷启动：没有同步时代，走内置价
    assert.equal(loadPricingEras(app.db).length, 0)
    const before = computeCostAt('deepseek-official', 'deepseek-flash', Date.UTC(2026, 8, 21, 2), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(before.cost, 2) // 内置 v41pro：高峰 2 元/1M 输入

    // ① 核对（dry-run）：不改动任何状态，但记 lastCheck
    const dry = await runPricingSync(app.db, { apply: false, fetchFn: stubFetch(NEW_PAGE), now: Date.UTC(2026, 8, 19, 4) })
    assert.equal(dry.ok, true)
    assert.equal(dry.applied, false)
    assert.match(dry.diff, /deepseek-flash\.input: 2 → 1\.5/)
    assert.equal(loadPricingEras(app.db).length, 0, 'dry-run 不得写库')
    assert.equal(pricingStatus(app.db).lastCheck.ok, true)
    const still = computeCostAt('deepseek-official', 'deepseek-flash', Date.UTC(2026, 8, 21, 2), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(still.cost, 2, 'dry-run 后算价不变')

    // ② 应用：写 meta + 立即生效
    const applied = await runPricingSync(app.db, { apply: true, fetchFn: stubFetch(NEW_PAGE), now: Date.UTC(2026, 8, 19, 4) })
    assert.equal(applied.ok, true)
    assert.equal(applied.applied, true)
    assert.ok(applied.era, '应给出时代 id')
    assert.equal(loadPricingEras(app.db).length, 1)
    const json = JSON.parse(getMeta(app.db, PRICING_ERAS_META, '[]'))
    assert.equal(json[0].models['deepseek-flash'].input, 1.5)
    assert.equal(json[0].routes['deepseek-v4-flash'], 'deepseek-flash')

    // 生效后：新价
    const after = computeCostAt('deepseek-official', 'deepseek-flash', Date.UTC(2026, 8, 21, 2), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(after.cost, 1.5)
    assert.equal(after.source, 'synced')
    // 历史时间戳（生效之前，周五高峰时段）仍走内置价：口径不回改
    const old = computeCostAt('deepseek-official', 'deepseek-flash', Date.UTC(2026, 8, 18, 2), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(old.cost, 2)
    // v4-pro 在同步时代里恢复为自有牌价（此前被内置时代路由到 flash）
    const pro = computeCostAt('deepseek-official', 'deepseek-v4-pro', Date.UTC(2026, 8, 21, 2), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(pro.cost, 7)

    // 重复应用同一份页面：不重复堆叠时代
    await runPricingSync(app.db, { apply: true, fetchFn: stubFetch(NEW_PAGE), now: Date.UTC(2026, 8, 19, 5) })
    assert.equal(loadPricingEras(app.db).length, 1, '同数据重复应用不应新增时代')
  } finally {
    cleanup()
  }

  // ③ 重启恢复：同一个数据目录重建服务，无需重新抓页面
  const dir2 = mkdtempSync(join(tmpdir(), 'dshc-psy-'))
  try {
    const cfg = testConfig(dir2)
    const app1 = createServer(cfg, { log: () => {}, webDir: join(process.cwd(), 'web') })
    await runPricingSync(app1.db, { apply: true, fetchFn: stubFetch(NEW_PAGE), now: Date.UTC(2026, 8, 19, 4) })
    app1.close()

    setSyncedEras([]) // 模拟进程重启后的空白状态
    const app2 = createServer(cfg, { log: () => {}, webDir: join(process.cwd(), 'web') })
    try {
      assert.equal(loadPricingEras(app2.db).length, 1)
      const restored = computeCostAt('deepseek-official', 'deepseek-flash', Date.UTC(2026, 8, 21, 2), { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 })
      assert.equal(restored.cost, 1.5, '重启后应按库里的同步时代算价')
    } finally {
      app2.close()
    }
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

test('价格同步：坏页面/网络失败不得破坏既有时代', async () => {
  setSyncedEras([])
  const { app, cleanup } = makeApp()
  try {
    await runPricingSync(app.db, { apply: true, fetchFn: stubFetch(NEW_PAGE), now: Date.UTC(2026, 8, 19, 4) })
    const good = loadPricingEras(app.db)
    assert.equal(good.length, 1)

    // 页面改版：解析必须抛错（绝不写错价）
    const broken = await runPricingSync(app.db, { apply: true, fetchFn: stubFetch('<html><body>totally different page</body></html>'), now: Date.UTC(2026, 8, 21, 4) })
    assert.equal(broken.ok, false)
    assert.equal(broken.applied, false)
    assert.match(broken.error, /中文定价页/)
    assert.deepEqual(loadPricingEras(app.db), good, '解析失败不得改动时代')
    assert.equal(pricingStatus(app.db).lastCheck.ok, false)

    // 网络异常
    const netErr = await runPricingSync(app.db, { apply: true, fetchFn: async () => { throw new Error('ECONNRESET') }, now: Date.UTC(2026, 8, 22, 4) })
    assert.equal(netErr.ok, false)
    assert.match(netErr.error, /ECONNRESET/)
    assert.deepEqual(loadPricingEras(app.db), good)

    // 非 200
    const http500 = await runPricingSync(app.db, { apply: true, fetchFn: stubFetch('', 500), now: Date.UTC(2026, 8, 23, 4) })
    assert.equal(http500.ok, false)
    assert.match(http500.error, /HTTP 500/)
    assert.deepEqual(loadPricingEras(app.db), good)
  } finally {
    cleanup()
  }
})

test('多厂商目录：参与云端算价，且与插件侧同源', async () => {
  setSyncedEras([])
  setPriceOverrides({})
  const { app, cleanup } = makeApp()
  try {
    const info = catalogInfo(app.db)
    assert.equal(info.enabled, true, '默认开启目录')
    assert.ok(info.providerCount >= 10, JSON.stringify(info.providerCount))
    assert.match(info.fingerprint, /^sha256:[0-9a-f]{16}$/)

    // openai 的目录价（非内置表模型）：开启目录后应命中目录价而非兜底估值
    const model = 'gpt-5.6-sol'
    const entry = catalogEntryFor('openai', model, { mode: 'fuzzy', fx: info.fxRate })
    assert.ok(entry, '目录里应有该模型')
    const tokens = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }
    const withCat = computeCostAt('openai', model, Date.UTC(2026, 8, 20), tokens, catalogOpts(app.db))
    assert.equal(withCat.estimated, false, '目录命中应为精确价')
    assert.equal(withCat.source, 'catalog')
    assert.ok(Math.abs(withCat.cost - entry.rates.input) < 1e-9, `${withCat.cost} vs ${entry.rates.input}`)

    // 关掉目录：回落兜底价（estimated=true），金额与精确价不同
    setCatalogConfig(app.db, { enabled: false })
    assert.equal(catalogOpts(app.db), undefined)
    const without = computeCostAt('openai', model, Date.UTC(2026, 8, 20), tokens)
    assert.equal(without.estimated, true)
    assert.notEqual(without.cost, withCat.cost)

    // 打开并改汇率：金额按比例变化（setCatalogConfig 回显 {enabled, fx, match}）
    const on = setCatalogConfig(app.db, { enabled: true, catalogFxRate: 5 })
    assert.equal(on.fx, 5)
    const fx5 = computeCostAt('openai', model, Date.UTC(2026, 8, 21, 2), tokens, catalogOpts(app.db))
    const fx72 = catalogEntryFor('openai', model, { mode: 'fuzzy', fx: 7.2 })
    assert.ok(Math.abs(fx5.cost - fx72.rates.input * (5 / 7.2)) < 1e-6, `${fx5.cost}`)

    // 非法汇率被拒（保持上一次合法值）
    const bad = setCatalogConfig(app.db, { catalogFxRate: -1 })
    assert.equal(bad.fx, 5)

    // 内置时代价优先于目录（DeepSeek 官方价不被目录顶掉）
    const ds = computeCostAt('deepseek-official', 'deepseek-flash', Date.UTC(2026, 8, 20), tokens, catalogOpts(app.db))
    assert.equal(ds.source, 'exact')
  } finally {
    cleanup()
  }
})

test('管理端端点：定价同步与目录配置需管理员会话', async () => {
  const { app, cleanup } = makeApp()
  try {
    // 未登录：读也不给
    const anon = await call(app, 'GET', '/api/admin/pricing-sync')
    assert.ok(anon.status === 401 || anon.status === 403, String(anon.status))
    // 登录后可用
    const { cookie } = await login(app)
    const got = await call(app, 'GET', '/api/admin/pricing-sync', null, null, cookie)
    assert.equal(got.body.ok, true)
    assert.ok(got.body.pricing && got.body.catalog)
    assert.equal(got.body.defaultUrl, DEFAULT_PRICING_SYNC_URL)
    const cfgOut = await call(app, 'POST', '/api/admin/catalog', { catalogFxRate: 6.9, priceMatch: 'exact' }, null, cookie)
    assert.equal(cfgOut.body.ok, true)
    assert.equal(cfgOut.body.catalog.fxRate, 6.9)
    assert.equal(cfgOut.body.catalog.match, 'exact')
    // protocol 也回显口径（采集端可自查两边是否同源）
    const proto = await call(app, 'GET', '/api/v1/protocol')
    assert.equal(proto.body.ok, true)
    assert.ok(proto.body.pricing && proto.body.catalog)
    assert.equal(proto.body.catalog.fxRate, 6.9)
  } finally {
    cleanup()
  }
})

test('目录命中记录入库：cost_basis 与插件侧一致（非估算）', async () => {
  const { app, cleanup } = makeApp()
  try {
    const token = app.ingest.registerDevice({ deviceId: 'dev-cat', deviceName: 'dev-cat', source: 'test' }).token
    const auth = { kind: 'device', tokenHash: '', deviceId: 'dev-cat' }
    const env = {
      source: 'dsh', agentInstance: '', deviceId: 'dev-cat', deviceName: 'dev-cat', resetEpoch: 0,
      batchUid: 'b1', maxClientSeqHint: 1, syncVer: 1, sentAt: Date.now(), agent: { name: 'test', version: '1', pluginVersion: '1.9.0' },
    }
    const body = { syncVer: 1, source: 'dsh', deviceId: 'dev-cat', resetEpoch: 0, batchUid: 'b1', records: [rec({ provider: 'openai', model: 'gpt-5.6-sol', cost: 0.01 })] }
    const out = app.ingest.ingestRecords(auth, env, body, { ip: '127.0.0.1' })
    assert.equal(out.ok, true)
    const row = app.db.prepare('SELECT cost, cost_basis, cost_recomputed, cost_drift, estimated FROM records WHERE device_id = ?').get('dev-cat')
    assert.ok(row, '记录应已入库')
    // 云端权威价来自目录（精确）而不是兜底估值：estimated=0，且重算价 = 按目录单价算出的费用
    assert.equal(Number(row.estimated), 0)
    const entry = catalogEntryFor('openai', 'gpt-5.6-sol', { mode: 'fuzzy', fx: catalogInfo(app.db).fxRate })
    assert.ok(entry, '目录里应有该模型')
    const expectCost = computeCost(entry.rates, false, false, { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, reasoning: 0 })
    assert.ok(Math.abs(Number(row.cost_recomputed) - expectCost) < 1e-6, `${row.cost_recomputed} vs ${expectCost}`)
    // 设备上报值仍被信任入账（basis=reported）。注意 cost_drift 的口径是
    // 「上报值 - 本次入账值」，入账用的就是上报值 → 漂移为 0；云端权威价另存
    // 在 cost_recomputed 列（审计/对账用），这正是「上报优先、重算留痕」的设计。
    assert.equal(String(row.cost_basis), 'reported')
    assert.equal(Number(row.cost_drift), 0)
    void token
  } finally {
    cleanup()
  }
})

