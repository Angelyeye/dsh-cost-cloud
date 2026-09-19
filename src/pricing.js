// ============================================================
// dsh-cost-cloud —— 定价与 token 口径层
//
// ⚠️ 与插件 `dsh-cost-tracker/pricing.js` **同源**，是刻意的副本：
//   - 插件端的价格表随 DeepSeek 官方调价而更新（按「计费时代」分版）；
//   - 云端必须以**同源规则**按记录自身时间戳重算，否则两边数字对不上。
//   两者一致性由 `test/pricing-parity.test.js` 用固定样本集逐条比对守住。
//   插件更新价格后，请同步本文件的 PRICE_ERAS 并更新 schema_meta.pricing_source_hash。
//   校验方式：`node scripts/check-pricing-sync.js`（逐字段比对关键结构 + 抽样计费，
//   并校验 PRICING_SOURCE_HASH 是否等于插件仓库 pricing.js 的 sha256）。
//
// 云端是定价的**唯一权威**：适配器上报的 `cost` 只作为参考值，用于计算「口径漂移」。
// ============================================================

/** 原始来源文件（用于同步校验） */
export const PRICING_SOURCE = 'dsh-cost-tracker/pricing.js'

/** 来源文件内容哈希（插件仓库 `dsh-cost-tracker/pricing.js` 的 sha256，前 16 位）。
 *  每次同步价格表后必须更新；`scripts/check-pricing-sync.js` 会实测比对，不一致即报错。 */
export const PRICING_SOURCE_HASH = 'sha256:7dd678571cce195f'

/** V4.1 Flash 价格的生效时刻：北京时间 2026-09-10 12:00（UTC+8）= 2026-09-10T04:00:00Z */
export const V41_EFFECTIVE_AT = Date.UTC(2026, 8, 10, 4, 0, 0)

/**
 * V4-Pro 请求被路由到 V4.1 Flash 的生效时刻：北京时间 2026-09-14 12:00。
 * 官方表述：「北京时间 2026 年 9 月 14 日 12:00 之后，至未来 V4.1 Pro 上线之前，
 * 用户访问 deepseek-v4-pro 的请求将全部路由到 V4.1 Flash，并按 V4.1 Flash 单价计费」。
 * 注意它与 V41_EFFECTIVE_AT（9-10 12:00）不是同一时刻，提前折算会低估 V4-Pro 花费。
 */
export const V41_PRO_ROUTE_AT = Date.UTC(2026, 8, 14, 4, 0, 0)

/**
 * V4.1 Flash 档的规范（官方现役）模型名。
 * 官方文档：「模型名请使用 `deepseek-flash`」——被路由的请求一律以此名入账，
 * 使按模型聚合的口径与官方账单一致。`deepseek-v4.1-flash` 归一化后等价命中本档。
 */
export const V41_FLASH_MODEL = 'deepseek-flash'

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
    label: 'V4.1 Flash 价（2026-09-10 12:00 起；V4-Pro 此时仍按自有牌价）',
    since: V41_EFFECTIVE_AT,
    models: {
      [V41_FLASH_MODEL]: { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 },
      // V4-Pro 尚在「自有牌价」窗口（9-14 12:00 前不路由），故本时代仍需保留其单价，
      // 否则会落入 provider 兜底而被误标记为「估算」。
      'deepseek-v4-pro': { input: 9.0, output: 27.0, cacheRead: 0.30, cacheWrite: 0.30 },
    },
    routes: {
      'deepseek-v4-flash': V41_FLASH_MODEL,
      'deepseek-v4-flash-vision-exp': V41_FLASH_MODEL,
    },
    proRouteSince: V41_PRO_ROUTE_AT,
  },
  {
    id: 'v41pro',
    label: 'V4.1 Flash 价 + V4-Pro 路由（2026-09-14 12:00 起）',
    since: V41_PRO_ROUTE_AT,
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

/** 旧价精确单价表（**仅 legacy 时代**） */
export const EXACT_MODELS = PRICE_ERAS[0].models

/** 归一化模型名：小写并剔除分隔符，使 v4.1 / v4-1 / v41 等写法命中同一档价 */
export function normalizeModelName(m) {
  return String(m == null ? '' : m).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 规范名别名表（归一化后 → 官方现役规范名）。
 * 官方口径：「模型名请使用 `deepseek-flash`」，`deepseek-v4.1-flash` 是同一档价的等价写法
 * （历史记录与旧文档中出现）。只在解析阶段归一，避免单价表展示重复列项。
 */
export const MODEL_ALIASES = {
  deepseekv41flash: V41_FLASH_MODEL,   // deepseek-v4.1-flash / deepseek-v41-flash / deepseek_v4.1_flash …
  deepseekv41: V41_FLASH_MODEL,        // deepseek-v41
  deepseekflashv41: V41_FLASH_MODEL,   // deepseek-flash-v4.1
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
  let n = normalizeModelName(model)
  if (!n) return null
  if (MODEL_ALIASES[n]) n = normalizeModelName(MODEL_ALIASES[n])
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

/**
 * 订阅套餐的**模型白名单**：provider 键 → 该套餐覆盖的模型。
 *
 * 为什么必须有这层：订阅制的判定原先只看 provider 名。这对 Kimi 成立
 * （kimi 全部走订阅），但**火山方舟不是**——同一个 provider 下既有
 * Coding Plan 套餐内的模型（订阅，不按量扣费），也有套餐外的模型
 * （按量计费）。只看 provider 会把按量调用错记为订阅，金额从「真实花费」
 * 里凭空消失，且原始记录被标成 subscription 后无法自动回滚。
 *
 * 值为 null 表示「该 provider 全部模型都属于这个套餐」（Kimi 即如此）。
 * 值与插件 `pricing.js` 的同名常量**保持逐字节一致**（见
 * scripts/check-pricing-sync.js：云端价格表是插件的刻意副本）。
 */
export const SUBSCRIPTION_MODELS = {
  'kimi-coding': null,
  kimi: null,
}

/**
 * 火山方舟（Volcengine Ark）Coding Plan 订阅套餐。
 *
 * provider 名由用户在 DSH 里自定，故登记多个常见别名（normalizeProvider 已
 * 剥离 `-official` 后缀）。实测 provider 为 `byteblus-coding-plan-cn`
 * （baseURL 指向 ark.cn-beijing.volces.com/api/coding/v3），一并纳入。
 *
 * 模型白名单：套餐内含多厂商模型。**同名模型在按量侧也存在**
 * （如 doubao-seed-2.0-pro、deepseek-v4-pro），因此判定必须靠
 * 「provider 命中 + 模型在白名单内」双重限定，缺一不可。
 */
const VOLC_PLAN_RATES = { input: 3.0, output: 12.0, cacheRead: 0.6, cacheWrite: 0.6 }

/** 火山方舟 Coding Plan 覆盖的 provider 别名 */
export const VOLCENGINE_PLAN_PROVIDER_KEYS = [
  'volcengine',
  'volcengine-coding',
  'volcengine-plan',
  'volcengine-coding-plan',
  'byteblus-coding-plan-cn',
  'byteplus-coding-plan-cn',
]

/**
 * **专属 Coding Plan 端点**的 provider（baseURL 指向 `.../api/coding/v3`）。
 *
 * 与泛 `volcengine` 别名区别对待：这类 provider 本身就是订阅入口，
 * 其可调模型全部来自套餐（套餐外模型需另配 `/api/v3` 在线推理 provider，
 * 那属于另一个 provider 名），因此**不再逐模型限定**——这也解决了
 * 「模型 id 带日期后缀、清单永远追不上」的问题。
 */
export const VOLCENGINE_PLAN_DEDICATED_PROVIDERS = [
  'byteblus-coding-plan-cn',
  'byteplus-coding-plan-cn',
  'volcengine-coding',
  'volcengine-plan',
  'volcengine-coding-plan',
]

/** 火山方舟 Coding Plan 覆盖的具体模型（原始名，归一化后匹配） */
const VOLCENGINE_PLAN_MODEL_IDS = [
  'ark-code-latest',
  // 豆包
  'doubao-seed-code',
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-lite',
  'doubao-seed-2.1-pro',
  // 智谱
  'glm-4.7',
  'glm-5.1',
  'glm-5.3-flash',
  // Kimi / DeepSeek / MiniMax
  'kimi-k2.5',
  'deepseek-v3.2',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'minimax-m2.5',
]

/**
 * 整族放行的模型前缀（归一化后）。
 *
 * **刻意收得很窄**：只放行方舟自动调度名（`ark-code-*`，会滚动升级）。
 * 前缀放太宽（如按 `deepseek` / `glm` 整族放行）会把该 provider 下
 * 套餐外的按量模型一并算成订阅，金额从「真实花费」里消失——
 * 宁可漏配（可显式补清单）也不能错配。
 */
export const VOLCENGINE_PLAN_MODEL_PREFIXES = ['arkcode']

export const VOLCENGINE_PLAN_RATES = VOLC_PLAN_RATES

/** 归一化模型名索引（惰性构建，与下方 eraIndex 同法，避免依赖声明顺序） */
let VOLC_MODEL_INDEX = null
function volcModelIndex() {
  if (VOLC_MODEL_INDEX === null) {
    VOLC_MODEL_INDEX = {}
    for (const id of VOLCENGINE_PLAN_MODEL_IDS) VOLC_MODEL_INDEX[normalizeModelName(id)] = id
  }
  return VOLC_MODEL_INDEX
}

/** 归一化模型名 → 套餐单价（供展示/测试） */
export function volcenginePlanModels() {
  const idx = volcModelIndex()
  const out = {}
  for (const k of Object.keys(idx)) out[k] = VOLC_PLAN_RATES
  return out
}

/**
 * 解析某次调用是否命中订阅套餐（与插件同名同语义）。
 * @param {string} np - 归一化 provider 名
 * @param {string} model - 模型名
 * @returns {object|null} 命中返回单价表，否则 null
 */
export function subscriptionPlanFor(np, model) {
  const sub = SUBSCRIPTION_RATES[np]
  if (sub) {
    const allow = SUBSCRIPTION_MODELS[np]
    // null = 该 provider 全部模型都属于订阅（Kimi：保持既有行为不变）
    if (allow === null || allow === undefined) return sub
    const n = normalizeModelName(model)
    if (Array.isArray(allow) && allow.indexOf(n) >= 0) return sub
    return null
  }
  // 火山方舟 Coding Plan：先看专属订阅端点的 provider（全部模型均属套餐），
  // 再看泛 volcengine（必须靠模型白名单，因为套餐内外模型混在同一 provider 下）。
  if (VOLCENGINE_PLAN_PROVIDER_KEYS.indexOf(np) < 0) return null
  if (VOLCENGINE_PLAN_DEDICATED_PROVIDERS.indexOf(np) >= 0) return VOLC_PLAN_RATES
  const n = normalizeModelName(model)
  if (volcModelIndex()[n] !== undefined) return VOLC_PLAN_RATES
  for (const p of VOLCENGINE_PLAN_MODEL_PREFIXES) {
    if (n.startsWith(p)) return VOLC_PLAN_RATES
  }
  return null
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
  const sub = subscriptionPlanFor(np, model)
  if (sub) return { rates: sub, tiered: false, estimated: true, subscription: true, model, era: null }
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
