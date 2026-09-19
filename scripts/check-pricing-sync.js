// ============================================================
// 同步检查：云端 pricing.js 是否与插件仓库的 pricing.js 一致
//
//   node scripts/check-pricing-sync.js [--plugin <dsh-cost-tracker 目录>]
//
// 背景：云端价格表是插件 pricing.js 的**刻意副本**（云端按记录时间戳重算需要
// 同源规则）。插件调价后若忘记同步，云端「口径漂移」会持续报警。
// 本脚本比对三个关键结构（PRICE_ERAS / SUBSCRIPTION_RATES / PROVIDER_RATES），
// 逐字段比较，任一处不同即退出码 1 并打印差异。
// ============================================================
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as cloud from '../src/pricing.js'

const args = process.argv.slice(2)
const idx = args.indexOf('--plugin')
const pluginDir = idx >= 0 ? args[idx + 1] : join(process.cwd(), '..', 'dsh-cost-tracker')

if (!existsSync(join(pluginDir, 'pricing.js'))) {
  console.error('找不到插件 pricing.js：' + join(pluginDir, 'pricing.js'))
  console.error('用法：node scripts/check-pricing-sync.js --plugin <dsh-cost-tracker 目录>')
  process.exit(2)
}

const plugin = await import(pathToFileURL(join(pluginDir, 'pricing.js')).href)

const checks = []
function cmp(name, a, b) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  checks.push({ name, ok: sa === sb, cloud: sa, plugin: sb })
}

cmp('PRICE_ERAS', cloud.PRICE_ERAS, plugin.PRICE_ERAS)
cmp('SUBSCRIPTION_RATES', cloud.SUBSCRIPTION_RATES, plugin.SUBSCRIPTION_RATES)
cmp('PROVIDER_RATES', cloud.PROVIDER_RATES, plugin.PROVIDER_RATES)
cmp('GENERIC_RATES', cloud.GENERIC_RATES, plugin.GENERIC_RATES)
cmp('PEAK_HOUR_WINDOWS', cloud.PEAK_HOUR_WINDOWS, plugin.PEAK_HOUR_WINDOWS)
cmp('V41_EFFECTIVE_AT', cloud.V41_EFFECTIVE_AT, plugin.V41_EFFECTIVE_AT)
cmp('V41_PRO_ROUTE_AT', cloud.V41_PRO_ROUTE_AT, plugin.V41_PRO_ROUTE_AT)
cmp('V41_FLASH_MODEL', cloud.V41_FLASH_MODEL, plugin.V41_FLASH_MODEL)
cmp('MODEL_ALIASES', cloud.MODEL_ALIASES, plugin.MODEL_ALIASES)

// 来源内容哈希：云端常量须等于插件仓库 pricing.js 的实测 sha256（前 16 位）
{
  const actual = 'sha256:' + createHash('sha256').update(readFileSync(join(pluginDir, 'pricing.js'))).digest('hex').slice(0, 16)
  checks.push({
    name: 'PRICING_SOURCE_HASH',
    ok: cloud.PRICING_SOURCE_HASH === actual,
    cloud: cloud.PRICING_SOURCE_HASH,
    plugin: actual,
  })
}

// v1.9.0：vendor-catalog.js（多厂商价格目录）同样要求逐字节一致（含目录数据
// docs/provider-pricing.json），云端目录指纹才能与插件侧对得上。
{
  const catOk = (rel) => existsSync(join(pluginDir, rel))
  if (!catOk('vendor-catalog.js')) {
    checks.push({ name: 'vendor-catalog.js', ok: false, cloud: '存在', plugin: '缺失（插件仓库需 ≥1.9.0）' })
  } else {
    const h = (p, rel) => createHash('sha256').update(readFileSync(join(p, rel))).digest('hex')
    checks.push({ name: 'vendor-catalog.js 逐字节一致', ok: h(process.cwd(), 'src/vendor-catalog.js') === h(pluginDir, 'vendor-catalog.js'), cloud: 'src/vendor-catalog.js', plugin: 'vendor-catalog.js' })
    checks.push({ name: 'provider-pricing.json 逐字节一致', ok: h(process.cwd(), 'src/docs/provider-pricing.json') === h(pluginDir, 'docs/provider-pricing.json'), cloud: 'src/docs/provider-pricing.json', plugin: 'docs/provider-pricing.json' })
    const { catalogFingerprint: cloudFp } = await import(pathToFileURL(join(process.cwd(), 'src', 'vendor-catalog.js')).href)
    checks.push({ name: '目录指纹可解析', ok: /^sha256:[0-9a-f]{16}$/.test(cloudFp()), cloud: cloudFp(), plugin: '' })
  }
  // v1.9.0：price-sync.js（官方定价页解析器）两边共用同一份实现 ——
  // 解析逻辑一旦分叉，插件与云端会从同一个页面读出不同的价。
  if (!catOk('price-sync.js')) {
    checks.push({ name: 'price-sync.js', ok: false, cloud: '存在', plugin: '缺失（插件仓库需 ≥1.9.0）' })
  } else {
    const h = (p, rel) => createHash('sha256').update(readFileSync(join(p, rel))).digest('hex')
    checks.push({ name: 'price-sync.js 逐字节一致', ok: h(process.cwd(), 'src/price-sync.js') === h(pluginDir, 'price-sync.js'), cloud: 'src/price-sync.js', plugin: 'price-sync.js' })
  }
}

let bad = 0
for (const c of checks) {
  if (c.ok) console.log('✓ ' + c.name + ' 一致')
  else {
    bad += 1
    console.error('✗ ' + c.name + ' 不一致')
    console.error('    云端: ' + c.cloud.slice(0, 400))
    console.error('    插件: ' + c.plugin.slice(0, 400))
  }
}

// 逐条计费一致性抽样：同一批记录在两边算出的费用必须相同
// 覆盖：V4.1 Flash 调价时刻前后、V4-Pro 路由窗口内（9-14 12:00 前，仍按自有牌价）、
//       路由之后、官方现役名与等价写法、订阅 provider、
//       以及**火山方舟 Coding Plan**（专属订阅端点 / 泛 volcengine 白名单 / 接入点按量）。
const samples = [
  { p: 'deepseek-official', m: 'deepseek-flash', ts: Date.UTC(2026, 8, 10, 5, 0), t: { input: 3850, output: 2880, cacheRead: 43904, cacheWrite: 0, reasoning: 0 } },
  { p: 'deepseek-official', m: 'deepseek-v4.1-flash', ts: Date.UTC(2026, 8, 12, 5, 0), t: { input: 24180, output: 477, cacheRead: 1920, cacheWrite: 0, reasoning: 0 } },
  { p: 'deepseek-official', m: 'deepseek-v4-pro', ts: Date.UTC(2026, 8, 12, 5, 0), t: { input: 24180, output: 477, cacheRead: 1920, cacheWrite: 0, reasoning: 0 } },
  { p: 'deepseek-official', m: 'deepseek-v4-pro', ts: Date.UTC(2026, 8, 15, 5, 0), t: { input: 3850, output: 2880, cacheRead: 43904, cacheWrite: 0, reasoning: 0 } },
  { p: 'deepseek-official', m: 'deepseek-v4-pro', ts: Date.UTC(2026, 7, 20, 5, 0), t: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 100, reasoning: 0 } },
  { p: 'moonshot-ai', m: 'kimi-coding', ts: Date.UTC(2026, 8, 12, 5, 0), t: { input: 10000, output: 5000, cacheRead: 1000, cacheWrite: 0, reasoning: 0 } },
  // 火山方舟：专属订阅端点（整档计订阅，含带日期后缀的模型 id）
  { p: 'byteblus-coding-plan-cn', m: 'glm-5-3-flash-260828', ts: Date.UTC(2026, 8, 20, 5, 0), t: { input: 20000, output: 3000, cacheRead: 8000, cacheWrite: 0, reasoning: 0 } },
  { p: 'byteblus-coding-plan-cn', m: 'doubao-seed-2-1-pro-260915', ts: Date.UTC(2026, 8, 20, 5, 0), t: { input: 20000, output: 3000, cacheRead: 8000, cacheWrite: 0, reasoning: 0 } },
  // 泛 volcengine：白名单内 → 订阅；白名单外 / 接入点 id → 按量估算
  { p: 'volcengine', m: 'ark-code-latest', ts: Date.UTC(2026, 8, 20, 5, 0), t: { input: 12000, output: 1500, cacheRead: 4000, cacheWrite: 0, reasoning: 0 } },
  { p: 'volcengine', m: 'ep-20260413045435-2shmq', ts: Date.UTC(2026, 8, 20, 5, 0), t: { input: 12000, output: 1500, cacheRead: 4000, cacheWrite: 0, reasoning: 0 } },
  // Kimi 回归：确认「整档订阅」语义未被模型白名单改造破坏
  { p: 'kimi', m: 'kimi-k2.5', ts: Date.UTC(2026, 8, 20, 5, 0), t: { input: 12000, output: 1500, cacheRead: 4000, cacheWrite: 0, reasoning: 0 } },
]
const nrm = (p) => String(p).toLowerCase().replace(/-official$/, '')
let sampleBad = 0
for (const s of samples) {
  const pc = plugin.priceFor(nrm(s.p), s.m, s.ts)
  const cc = cloud.priceFor(cloud.normalizeProvider(s.p), s.m, s.ts)
  if (pc.model !== cc.model || pc.tiered !== cc.tiered || pc.subscription !== cc.subscription || pc.estimated !== cc.estimated) {
    bad += 1
    sampleBad += 1
    console.error('✗ 解析不一致: ' + s.m + ' 插件=' + JSON.stringify({ m: pc.model, t: pc.tiered, est: pc.estimated }) + ' 云端=' + JSON.stringify({ m: cc.model, t: cc.tiered, est: cc.estimated }))
    continue
  }
  const c1 = plugin.computeCost(pc.rates, pc.tiered, plugin.isPeak(s.ts), s.t)
  const c2 = cloud.computeCost(cc.rates, cc.tiered, cloud.isPeak(s.ts), s.t)
  if (Math.abs(c1 - c2) > 1e-12) {
    bad += 1
    sampleBad += 1
    console.error('✗ 计费不一致: ' + s.m + ' 插=' + c1 + ' 云=' + c2)
  }
}
if (!sampleBad) {
  console.log('✓ 计费抽样 ' + samples.length + ' 条全部一致')
  console.log('')
  console.log('pricing.js 与插件同源：' + pluginDir)
}
process.exit(bad ? 1 : 0)
