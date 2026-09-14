// ============================================================
// dsh-cost-cloud —— 定价与 token 口径层
//
// ⚠️ 与插件 `dsh-cost-tracker/pricing.js` **同源**，是刻意的副本：
//   - 插件端的价格表随 DeepSeek 官方调价而更新（按「计费时代」分版）；
//   - 云端必须以**同源规则**按记录自身时间戳重算，否则两边数字对不上。
//   两者一致性由 `test/pricing-parity.test.js` 用固定样本集逐条比对守住。
//   插件更新价格后，请同步本文件的 PRICE_ERAS 并更新 schema_meta.pricing_source_hash。
//   校验方式：`node scripts/sync-pricing.js --check`（比对插件仓库中的 pricing.js 内容哈希）。
//
// 云端是定价的**唯一权威**：适配器上报的 `cost` 只作为参考值，用于计算「口径漂移」。
// ============================================================

/** 原始来源文件（用于同步校验） */
export const PRICING_SOURCE = 'dsh-cost-tracker/pricing.js'

/** 来源文件内容哈希（同步脚本写入；不一致时运维可见） */
export const PRICING_SOURCE_HASH = 'mirror-of-dsh-cost-tracker@pricing.js'

/** V4.1 Flash 价格的生效时刻：北京时间 2026-09-10 12:00（UTC+8）= 2026-09-10T04:00:00Z */
export const V41_EFFECTIVE_AT = Date.UTC(2026, 8, 10, 4, 0, 0)

/** V4.1 Flash 的规范模型名（被路由的请求一律以此名入账） */
export const V41_FLASH_MODEL = 'deepseek-v4.1-flash'

export const PRICE_ERAS = [
  {
    id: 'legacy',
    label: '2026-08 价（V4-Flash / V4-Pro 各自独立计价）',
    since: 0,
    models: {
      'deepseek-v4-flash': { input: 3.0, output: 9.0, cacheRead: 0.10, cacheWrite: 0.10 },
      'deepseek-v4-pro': { input: 9.0, output: 27.0, cacheRead: 0.30, cacheWrite: 0.30 },
      'deepseek-v4-flash-vision-exp': { input: 3.0, output: 9.0, cacheRead: 0.10, cacheWrite: 0.10 },
    },
    routes: {},
  },
  {
    id: 'v41',
    label: 'V4.1 Flash 价（V4-Pro 与旧 V4-Flash 系均路由至此）',
    since: V41_EFFECTIVE_AT,
    models: {
      [V41_FLASH_MODEL]: { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 },
    },
    routes: {
      'deepseek-v4-pro': V41_FLASH_MODEL,
      'deepseek-v4-flash': V41_FLASH_MODEL,
      'deepseek-v4-flash-vision-exp': V41_FLASH_MODEL,
    },
  },
]

/** 旧价精确单价表（legacy 时代） */
export const EXACT_MODELS = PRICE_ERAS[0].models

/** 归一化模型名：小写并剔除分隔符，使 v4.1 / v4-1 / v41 等写法命中同一档价 */
export function normalizeModelName(m) {
  return String(m == null ? '' : m).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 归一化 provider 名（与插件 `index.js` 的 normProvider 同规则）：
 * 小写并剔除 `-official` 等后缀，使 `deepseek-official` 与 `deepseek` 命中同一档兜底价。
 */
export function normalizeProvider(p) {
  return String(p == null ? '' : p).toLowerCase().replace(/-official$/, '')
}

const ERA_INDEX = new Map()
function eraIndex(era) {
  let idx = ERA_INDEX.get(era)
  if (!idx) {
    idx = { models: new Map(), routes: new Map() }
    for (const k of Object.keys(era.models)) idx.models.set(normalizeModelName(k), k)
    for (const k of Object.keys(era.routes || {})) idx.routes.set(normalizeModelName(k), era.routes[k])
    ERA_INDEX.set(era, idx)
  }
  return idx
}

/** 某模型在指定时代下命中的计费模型规范名；未命中返回 null */
export function resolveModelInEra(era, model) {
  if (!era) return null
  const n = normalizeModelName(model)
  if (!n) return null
  const idx = eraIndex(era)
  if (idx.models.has(n)) return idx.models.get(n)
  const target = idx.routes.get(n)
  if (target) {
    const hit = idx.models.get(normalizeModelName(target))
    if (hit) return hit
  }
  return null
}

/** 某一时刻生效的价格时代 */
export function eraAt(ts) {
  const t = Number.isFinite(ts) ? ts : Date.now()
  let cur = PRICE_ERAS[0]
  for (const e of PRICE_ERAS) if (t >= e.since) cur = e
  return cur
}

/** 某一时刻生效的精确单价表 */
export function exactModelsAt(ts) { return eraAt(ts).models }

/** 订阅套餐（等效费用估算，仅供参考） */
export const SUBSCRIPTION_RATES = {
  'kimi-coding': { input: 6.5, output: 27.0, cacheRead: 1.1, cacheWrite: 1.1 },
  kimi: { input: 6.5, output: 27.0, cacheRead: 1.1, cacheWrite: 1.1 },
}

/** Provider 兜底单价（估算）；缓存写入按缓存命中价计 */
export const PROVIDER_RATES = {
  deepseek: { rates: { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 }, tiered: true },
  openai: { rates: { input: 10.0, output: 30.0, cacheRead: 5.0, cacheWrite: 5.0 }, tiered: false },
  anthropic: { rates: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 1.5 }, tiered: false },
  gemini: { rates: { input: 2.5, output: 10.0, cacheRead: 0.625, cacheWrite: 0.625 }, tiered: false },
  ollama: { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiered: false },
  local: { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiered: false },
}

/** 未知模型兜底单价（估算） */
export const GENERIC_RATES = { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 0.5 }

/** 高峰时段（北京时间，仅周一至周五），空闲时段 = 高峰 × 0.5；周末全天空闲 */
export const PEAK_WINDOWS = '周一至周五 9:00-12:00 · 14:00-18:00（周末全天闲时）'

/** 峰时段窗口（北京时间小时，半开区间 [start, end)） */
export const PEAK_HOUR_WINDOWS = [{ start: 9, end: 12 }, { start: 14, end: 18 }]

/** 是否高峰时段（北京时间 UTC+8，仅周一至周五；周末全天空闲） */
export function isPeak(ts) {
  const d = new Date(ts + 28800000)
  const day = d.getUTCDay() // 0=周日 … 6=周六
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 解析一次调用的价格信息（与插件同签名） */
export function priceFor(np, model, ts) {
  if (SUBSCRIPTION_RATES[np]) return { rates: SUBSCRIPTION_RATES[np], tiered: false, estimated: true, subscription: true, model, era: null }
  const era = eraAt(ts)
  const hit = resolveModelInEra(era, model)
  if (hit) return { rates: era.models[hit], tiered: true, estimated: false, subscription: false, model: hit, era: era.id }
  const p = PROVIDER_RATES[np]
  if (p) return { rates: p.rates, tiered: p.tiered, estimated: true, subscription: false, model, era: era.id }
  return { rates: GENERIC_RATES, tiered: false, estimated: true, subscription: false, model, era: era.id }
}

/**
 * 计算一次调用的费用（CNY）。
 * @param {object} rates - CNY / 1M tokens
 * @param {boolean} tiered - 是否峰谷计价（false 时按表内价）
 * @param {boolean} peak - 是否高峰时段（tiered 且非高峰时 ×0.5）
 * @param {{input,output,cacheRead,cacheWrite,reasoning}} t
 */
export function computeCost(rates, tiered, peak, t) {
  const f = tiered && !peak ? 0.5 : 1
  const reasoning = Number(t.reasoning || 0) * (Number(rates.reasoning) || 0)
  return (t.input * rates.input + t.output * rates.output + (t.cacheRead + t.cacheWrite) * rates.cacheRead + reasoning) * f / 1000000
}

export function r4(x) { return Math.round(x * 10000) / 10000 }
export function r6(x) { return Math.round(x * 1000000) / 1000000 }

/**
 * 云端权威计费：按记录自身时间戳选价格时代，返回费用与派生口径。
 * @param {string} provider - 上报的 provider（内部会归一化）
 * @param {string} model - 上报的模型名
 * @param {number} ts - 调用时刻（epoch ms）
 * @param {object} tokens - 已归一化的 token 桶
 * @returns {{cost:number, model:string, period:string, estimated:boolean, subscription:boolean, era:string|null}}
 */
export function computeCostAt(provider, model, ts, tokens) {
  const np = normalizeProvider(provider)
  const price = priceFor(np, model, ts)
  const peak = isPeak(ts)
  const tiered = price.tiered === true
  const cost = computeCost(price.rates, tiered, peak, tokens)
  return {
    cost: r6(cost),
    model: price.model || model,
    period: tiered ? (peak ? 'peak' : 'off-peak') : 'flat',
    estimated: price.estimated === true,
    subscription: price.subscription === true,
    era: price.era === null ? null : price.era,
  }
}

/** 供 /api/v1/protocol 与工具展示的价格表快照 */
export function priceSnapshot(now) {
  const t = Number.isFinite(now) ? now : Date.now()
  const era = eraAt(t)
  return {
    unit: 'CNY / 1M tokens',
    peakWindows: PEAK_WINDOWS,
    offPeakFactor: 0.5,
    currentEra: era.id,
    eraLabel: era.label,
    eras: PRICE_ERAS.map((e) => ({ id: e.id, label: e.label, since: e.since, models: e.models, routes: e.routes || {} })),
    subscription: SUBSCRIPTION_RATES,
    providers: PROVIDER_RATES,
    generic: GENERIC_RATES,
    source: PRICING_SOURCE,
    sourceHash: PRICING_SOURCE_HASH,
  }
}
