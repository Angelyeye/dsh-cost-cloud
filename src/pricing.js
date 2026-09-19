// ============================================================
// DSH 花费统计插件 —— 定价与 Token 层（纯逻辑，可独立测试）
//
// ⚠️ 本文件是插件仓库 `dsh-cost-tracker/pricing.js` 的**刻意副本**（v1.9.0 起
// 除本段注释与 PRICING_SOURCE_HASH 常量外逐字节一致，见
// scripts/check-pricing-sync.js 的同源校验）。改动计价逻辑请先改插件仓库，
// 再同步本副本并重算 PRICING_SOURCE_HASH。
//
// 单价来源：DeepSeek 官方定价页
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
//   - 高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00）为表内价格；
//     空闲时段 = 高峰 × 0.5。周末（周六/周日）全天计入空闲时段（该窗口两版价通用）。
//   - **单价随时间调整**：故单价表按生效时刻分版（见 PRICE_ERAS），按记录时间戳选版。
//       · legacy  ：V4-Flash 3.0/9.0/0.10、V4-Pro 9.0/27.0/0.30
//       · v41     ：V4.1 Flash 2.0/8.0/0.04（北京时间 2026-09-10 12:00 起生效）。
//                   官方现役模型名为 `deepseek-flash`；旧名 `deepseek-v4-flash` 与
//                   `deepseek-v4-flash-vision-exp` 已下线但仍可调用，请求由 V4.1 Flash
//                   提供服务并按 Flash 价计费，故一并路由到 `deepseek-flash`。
//       · v41pro  ：同一档单价，**V4-Pro 路由在此才开始**：官方通告为「北京时间 2026-09-14
//                   12:00 之后，deepseek-v4-pro 的请求全部路由到 V4.1 Flash 并按 V4.1 Flash
//                   单价计费」（价格卡脚注 (2) 同口径）。9/10 12:00 ～ 9/14 12:00 之间的
//                   V4-Pro 请求按 V4-Pro 自有牌价 9.0/27.0/0.30 计费，不可提前折算。
//   - deepseek-v4-flash-vision-exp 与 deepseek-v4-flash 在 legacy 时代单价一致。
//   - 模型名归一化后 `deepseek-v4.1-flash` 等同为 `deepseek-flash` 的等价写法，命中同一档。
//
// 视觉模型 Token 规则：
//   https://api-docs.deepseek.com/zh-cn/guides/vision#token-usage
//   图片进入模型前按尺寸自动缩放（<384×384 放大、更大缩小至约 800×800），
//   每张图片换算 token 数存在上限（384 个），与文本 token 一并计费——
//   即包含在接口返回的 prompt_tokens 中，由 DSH 映射为 inputTokens，
//   插件按接口用量记账（接口用量为准，估算可能有误差）。
// ============================================================

/**
 * 计费时代（price era）——DeepSeek 单价是「随时间调整」的，因此单价表按
 * 生效时刻（since，epoch ms）分版。计费与展示一律以「记录自身的时间戳」选版，
 * 历史记录口径不会被新价改写。
 *
 * 字段：input=输入缓存未命中价 / output=输出价 / cacheRead=cacheWrite=缓存命中价
 *      （官方规则：缓存写入(cache write)与缓存命中(cache hit)同价）。
 * 均为「高峰时段」价；空闲时段 = 高峰 × 0.5（两版价格的空闲档都恰好是半价）。
 *
 * routes：某个时代内把指定模型名的请求**改按另一档单价计费**，记录也以被路由
 *         到的**计费模型规范名**（当前为官方现役名 `deepseek-flash`）入账，
 *         便于按模型聚合时看到真实计费口径。
 */

/** V4.1 Flash 价格的生效时刻：北京时间 2026-09-10 12:00（UTC+8）= 2026-09-10T04:00:00Z */
export const V41_EFFECTIVE_AT = Date.UTC(2026, 8, 10, 4, 0, 0)

/** 与插件仓库 pricing.js 的 sha256 同源校验值（scripts/check-pricing-sync.js 比对）。
 *  v1.9.0 同步副本后重算：sha256:d5dd3f0dacb08241 */
export const PRICING_SOURCE_HASH = 'sha256:d5dd3f0dacb08241'

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
      // 高峰价：输入（缓存命中）0.04 / 输入（缓存未命中）2 / 输出 8；空闲减半
      [V41_FLASH_MODEL]: { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 },
      // V4-Pro 尚在「自有牌价」窗口（9-14 12:00 前不路由），故本时代仍需保留其单价，
      // 否则会落入 provider 兜底而被误标记为「估算」。
      'deepseek-v4-pro': { input: 9.0, output: 27.0, cacheRead: 0.30, cacheWrite: 0.30 },
    },
    // 旧 V4-Flash 系（含视觉版）已下线，请求由 V4.1 Flash 提供并按 Flash 价计费。
    // V4-Pro 此时尚未路由（官方路由时刻为 9-14 12:00，见下一个时代）。
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
    // V4.1 Pro 上线前，V4-Pro 的请求全部路由到 V4.1 Flash 并按 V4.1 Flash 单价计费。
    routes: {
      'deepseek-v4-pro': V41_FLASH_MODEL,
      'deepseek-v4-flash': V41_FLASH_MODEL,
      'deepseek-v4-flash-vision-exp': V41_FLASH_MODEL,
    },
  },
]

/** 旧价精确单价表（**仅 legacy 时代**）。保留导出，兼容既有调用与历史口径；
 *  当前时代的精确表请用 `exactModelsAt(ts)`（会随时代切换）。 */
export const EXACT_MODELS = PRICE_ERAS[0].models

/** 归一化模型名：小写并剔除分隔符，使 v4.1 / v4-1 / v41 等写法命中同一档价。 */
export function normalizeModelName(m) {
  return String(m == null ? '' : m).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 规范名别名表（归一化后 → 官方现役规范名）。
 * 官方文档口径：「模型名请使用 `deepseek-flash`」，`deepseek-v4.1-flash` 是同一档价的
 * 等价写法（历史记录与旧文档中出现）。此处**不**把它们加进单价表，以免在单价表展示里
 * 重复列出；只在解析阶段归一到规范名，保证 `estimated=false` 且按模型聚合同一个桶。
 */
export const MODEL_ALIASES = {
  deepseekv41flash: V41_FLASH_MODEL,   // deepseek-v4.1-flash / deepseek-v41-flash / deepseek_v4.1_flash …
  deepseekv41: V41_FLASH_MODEL,        // deepseek-v41
  deepseekflashv41: V41_FLASH_MODEL,   // deepseek-flash-v4.1
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

/**
 * 某模型在指定时代下命中的**计费模型规范名**：先按别名表归一，再查本时代单价表，
 * 最后查路由表（路由目标须在本时代单价表内）；均未命中返回 null。
 */
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

/** 某一时刻生效的价格时代（缺省用当前时间）。
 *  v1.9.0 起：在内置 PRICE_ERAS 之外合并**官方同步时代**（setSyncedEras 注入，
 *  见 price-sync.js）——两侧按 since 取「最近生效者」，同时刻同步时代优先
 *  （同步数据来自官方页面实抓，比内置常量新）。 */
export function eraAt(ts) {
  const t = Number.isFinite(ts) ? ts : Date.now()
  let cur = PRICE_ERAS[0]
  for (const e of PRICE_ERAS) if (t >= e.since) cur = e
  for (const e of SYNCED_ERAS) {
    if (t >= e.since && (cur === PRICE_ERAS[0] || e.since >= cur.since)) cur = e
  }
  return cur
}

// ---------- 官方同步时代（v1.9.0，price-sync.js 注入） ----------
let SYNCED_ERAS = []
/**
 * 注入官方价格同步产生的时代（启动时从 storages/cost-tracker-prices.json 加载）。
 * 时代按 since 升序排序；非法条目（缺 models/since）丢弃，绝不阻断启动。
 * @param {object[]} eras
 */
export function setSyncedEras(eras) {
  SYNCED_ERAS = (Array.isArray(eras) ? eras : [])
    .filter((e) => e && typeof e === 'object' && Number.isFinite(e.since) && e.models && typeof e.models === 'object')
    .sort((a, b) => a.since - b.since)
    .map((e) => Object.assign({ routes: {}, label: '官方同步价', synced: true }, e))
}
/** 当前注入的同步时代（只读副本，供状态回显） */
export function getSyncedEras() { return SYNCED_ERAS.slice() }

// ---------- 手动覆盖价（v1.9.0，插件配置卡维护） ----------
let PRICE_OVERRIDES = new Map()
function overrideKey(np, model) {
  return normalizeModelName(np) + '/' + normalizeModelName(model)
}
/**
 * 注入手动覆盖价：键 'provider/model'（两侧都归一化），值为
 * {input, output, cacheRead, cacheWrite}（CNY / 1M tokens）。
 * 命中优先级最高（高于订阅归类、同步时代与目录）。
 */
export function setPriceOverrides(map) {
  PRICE_OVERRIDES = new Map()
  for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) {
    if (!v || typeof v !== 'object') continue
    const rates = {
      input: Number(v.input), output: Number(v.output),
      cacheRead: Number(v.cacheRead), cacheWrite: Number(v.cacheWrite === undefined ? v.cacheRead : v.cacheWrite),
    }
    if (!rates.input || !Number.isFinite(rates.input) || rates.input < 0) continue
    if (!Number.isFinite(rates.output) || rates.output < 0) continue
    if (!Number.isFinite(rates.cacheRead) || rates.cacheRead < 0) continue
    // 键形如 'provider/model'：先按 '/' 拆开再各自归一化（normalizeModelName 会
    // 剔除一切非字母数字，直接整串归一会把 '/' 吃掉，导致写读两侧对不上）
    const parts = String(k).split('/')
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) continue
    PRICE_OVERRIDES.set(normalizeModelName(parts[0]) + '/' + normalizeModelName(parts[1]), { rates, tiered: false })
  }
}
export function getPriceOverrides() { return PRICE_OVERRIDES }

/** 某一时刻生效的精确单价表（缺省用当前时间）。 */
export function exactModelsAt(ts) { return eraAt(ts).models }

/**
 * 订阅套餐（等效费用估算，仅供参考）。
 * DSH 的 kimi provider 上报名为 'kimi'（模型 kimi-k3 等），
 * 'kimi-coding' 为别名形式（kimi-coding-official 归一化后形如 kimi-coding），
 * 两个键都命中，避免订阅调用被误计为按量估算。
 * 缓存写入按缓存命中价计（与官方规则一致）。
 */
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
 * 值为 null 表示「该 provider 全部模型都属于这个套餐」（Kimi 即如此，
 * 保持 1.8.13 及以前的既有行为逐字节不变）。
 * 值为数组时按**归一化模型名**匹配（见 normalizeModelName），
 * 另可用 `prefixes` 放行整族模型（如方舟自动调度的 ark-code 系）。
 */
export const SUBSCRIPTION_MODELS = {
  'kimi-coding': null,
  kimi: null,
}

/**
 * 火山方舟（Volcengine Ark）Coding Plan 订阅套餐。
 *
 * provider 名由用户在 DSH 里自定，故登记多个常见别名（normProvider 已剥离
 * `-official` 后缀）。用户实测 provider 为 `byteblus-coding-plan-cn`
 * （baseURL 指向 ark.cn-beijing.volces.com/api/coding/v3），一并纳入。
 *
 * 模型白名单：套餐内含多厂商模型。**同名模型在按量侧也存在**
 * （如 doubao-seed-2.0-pro、deepseek-v4-pro），因此判定必须靠
 * 「provider 命中 + 模型在白名单内」双重限定，缺一不可。
 *
 * ⚠️ 单价口径（**估算，非官方账单**）：套餐内的模型各自牌价差异很大
 * （豆包 / GLM / Kimi / DeepSeek / MiniMax 各档不同），而套餐只有一个
 * 固定月费、按窗口百分比计量，**官方没有给出「套餐内某次调用的等效单价」**。
 * 故此处取**单一代表价**，与既有 Kimi 订阅（同样一个价位代表整档套餐）
 * 的口径一致，仅用于横向比较订阅是否划算。
 * 未逐一登记各模型第三方报价：可核实到的多为聚合站的美元估价，
 * 与方舟官方人民币牌价不可直接对照，按本仓库「不编造价格」的约定不收录。
 * 要精确到模型，请以方舟控制台账单为准。
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
 * 与上面的泛 `volcengine` 别名区别对待：这类 provider 本身就是订阅入口，
 * 其可调模型全部来自套餐（调用套餐外模型需另配 `/api/v3` 在线推理 provider，
 * 那属于另一个 provider 名），因此**不再逐模型限定**——这也解决了
 * 「模型 id 带日期后缀、清单永远追不上」的问题。
 *
 * 泛 `volcengine` 走另一个分支：必须靠模型白名单，因为同一个 provider 下
 * 套餐内外的模型混在一起（接入点 id 形如 ep-xxxx 就是按量）。
 */
export const VOLCENGINE_PLAN_DEDICATED_PROVIDERS = [
  'byteblus-coding-plan-cn',
  'byteplus-coding-plan-cn',
  'volcengine-coding',
  'volcengine-plan',
  'volcengine-coding-plan',
]

/**
 * 火山方舟 Coding Plan 覆盖的具体模型（原始名，归一化后匹配）。
 *
 * 带上实测见到的**日期/版本后缀**变体：方舟模型 id 普遍带后缀
 * （用户配置里就有 `glm-5-3-flash-260828`、`deepseek-v4-1-flash-260910`、
 * `doubao-seed-2-1-pro-260915`），漏配的后果是订阅调用被当成未知模型、
 * 标成「按量计费 · 价格为估算」——正是本次要修掉的那类误标。
 */
const VOLCENGINE_PLAN_MODEL_IDS = [
  'ark-code-latest',
  // 豆包
  'doubao-seed-code',
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-lite',
  'doubao-seed-2.1-pro',
  // 智谱（含用户配置里的 5.3 flash 带日期变体）
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
 * **刻意收得很窄**：只放行方舟自动调度名（`ark-code-*`，会滚动升级，
 * 逐一登记必然过期）。其余一律靠上面的显式清单——
 * 前缀放太宽（如按 `deepseek` / `glm` 整族放行）会把该 provider 下
 * 套餐外的按量模型一并算成订阅，金额从「真实花费」里消失，
 * 那正是本门卫要防的方向，宁可漏配（可显式补清单）也不能错配。
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

/** 供测试与展示：归一化模型名 → 套餐单价 */
export function volcenginePlanModels() {
  const idx = volcModelIndex()
  const out = {}
  for (const k of Object.keys(idx)) out[k] = VOLC_PLAN_RATES
  return out
}

/**
 * 解析某次调用是否命中订阅套餐。
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

/** Provider 兜底单价（估算）；缓存写入按缓存命中价计。
 *  deepseek 兜底已同步至 V4.1 Flash 档（2.0/8.0/0.04），未知模型不再按旧价高估。 */
export const PROVIDER_RATES = {
  deepseek: { rates: { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 }, tiered: true },
  openai: { rates: { input: 10.0, output: 30.0, cacheRead: 5.0, cacheWrite: 5.0 }, tiered: false },
  anthropic: { rates: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 1.5 }, tiered: false },
  gemini: { rates: { input: 2.5, output: 10.0, cacheRead: 0.625, cacheWrite: 0.625 }, tiered: false },
  ollama: { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiered: false },
  local: { rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiered: false },
}

/** 未知模型兜底单价（估算）；缓存写入按缓存命中价计。 */
export const GENERIC_RATES = { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 0.5 }

/** 高峰时段（北京时间，仅周一至周五），空闲时段 = 高峰 × 0.5；周末全天空闲 */
export const PEAK_WINDOWS = '周一至周五 9:00-12:00 · 14:00-18:00（周末全天闲时）'

/** 视觉模型名（DeepSeek DeepSeek-V4-Flash-Vision-Exp） */
export const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** 每张图片换算 token 的上限（官方规则） */
export const VISION_IMAGE_MAX_TOKENS = 384

/** 是否高峰时段（北京时间 UTC+8，仅周一至周五；周末全天空闲） */
export function isPeak(ts) {
  const d = new Date(ts + 28800000)
  const day = d.getUTCDay() // 0=周日 … 6=周六
  if (day === 0 || day === 6) return false // 周末不计高峰
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 峰时段窗口（北京时间小时，半开区间 [start, end)）。 */
export const PEAK_HOUR_WINDOWS = [{ start: 9, end: 12 }, { start: 14, end: 18 }]

/**
 * 某一时刻所处的峰谷相位与相邻切换点（供时段条 / 倒计时 / 切换前弹窗）。
 * 与 isPeak 同口径（北京时间 UTC+8），并处理「周末全天谷价」：
 *  - 工作日：按峰窗口判定 inPeak，扫描前后 N 天收集切换点；
 *  - 周末：inPeak=false 且 weekend=true，日内无切换点（价格恒为谷），
 *    下一个价格切换点为下周一 09:00（首个峰窗口起点）。
 * @param {number} ts - epoch ms
 * @param {number} [spanDays=5] - 前后扫描天数（须覆盖最长周末间隔）
 * @returns {{inPeak:boolean, weekend:boolean, prevAtMs:number, nextAtMs:number,
 *            nextIntoPeak:boolean}|null} prevAtMs/nextAtMs 为相邻切换点 epoch ms
 */
export function peakPhaseAt(ts, spanDays) {
  if (!Number.isFinite(ts)) return null
  const SPAN = (Number.isFinite(spanDays) && spanDays >= 1) ? Math.floor(spanDays) : 5
  const DAY_MS = 86400000
  // 北京时间日 index 与星期（0=周日 … 6=周六；1970-01-01 为周四）。
  const D0 = Math.floor((ts + 28800000) / DAY_MS)
  const weekday = (D0 + 4) % 7
  const isWeekendNow = weekday === 6 || weekday === 0
  // 某北京时间日 D 的某时 h 对应的 epoch ms（北京 = UTC+8）。
  const atBeijing = (D, h) => D * DAY_MS - 28800000 + h * 3600000
  // 收集 ±SPAN 天内全部窗口边界切换点，剔除落在周末（无价格变化）的点。
  const points = []
  for (let off = -SPAN; off <= SPAN; off += 1) {
    const D = D0 + off
    const wd = (D + 4) % 7
    if (wd === 6 || wd === 0) continue // 周末日内无切换
    for (const w of PEAK_HOUR_WINDOWS) {
      points.push({ at: atBeijing(D, w.start), intoPeak: true })
      points.push({ at: atBeijing(D, w.end), intoPeak: false })
    }
  }
  let prev = null
  let next = null
  for (const p of points) {
    if (p.at <= ts && (prev === null || p.at > prev.at)) prev = p
    if (p.at > ts && (next === null || p.at < next.at)) next = p
  }
  if (isWeekendNow) {
    // 周末全谷价：当前谷，下一切换 = 下周一首个峰窗口起点；prev = 周六 00:00（北京）。
    if (next === null) return null
    return { inPeak: false, weekend: true, prevAtMs: (D0 - weekday) * DAY_MS - 57600000, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
  }
  if (prev === null || next === null) return null
  return { inPeak: isPeak(ts), weekend: false, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
}

/**
 * 解析一次调用的价格信息。
 * @param {string} np - 归一化后的 provider 名（如 deepseek）
 * @param {string} model - 模型名（如 deepseek-v4-flash-vision-exp）
 * @param {number} [ts] - 调用发生时刻（epoch ms）；决定用哪一版单价表。
 *   缺省用当前时间——注意历史/测试场景应显式传入，否则跨价格时代会错。
 * @param {{catalog?:Function, overrides?:Map, planOverrides?:object}} [opts]
 *   · catalog(np, model) → 目录命中对象 | null（vendor-catalog.catalogEntryFor，
 *     由调用方注入以保持本模块可独立测试）；
 *   · overrides：setPriceOverrides 注入的手动覆盖价（不传则用模块态）；
 *   · planOverrides：订阅归类覆盖 {'provider/model'|'provider/*': 'plan'|'api'}。
 * @returns {{rates:object, tiered:boolean, estimated:boolean, subscription:boolean,
 *            model:string, era:string|null, source:string}}
 *   model 为**计费模型规范名**：命中路由时是被路由到的模型（如 V4-Pro → V4.1 Flash），
 *   记账应以它入账；未命中精确表时为原模型名。
 *   source：override > plan > exact/synced > catalog > provider > generic。
 */
export function priceFor(np, model, ts, opts) {
  const o = opts || {}
  // ---- 0. 订阅归类覆盖（用户在配置卡按 provider 或 provider/model 强制归类）----
  const po = planOverrideFor(np, model, o.planOverrides)
  if (po === 'plan') {
    const sub = subscriptionPlanFor(np, model)
    if (sub) return { rates: sub, tiered: false, estimated: true, subscription: true, model, era: null, source: 'plan' }
    // 无既有套餐可套：按「该渠道走订阅」处理 —— 照常解析单价（目录/时代/兜底），
    // 但标记为订阅等值口径；这正是「套餐覆盖了清单外的模型」的兜法。
    const forced = resolveNonPlanPrice(np, model, ts, o)
    forced.subscription = true
    forced.source = 'plan'
    return forced
  }
  if (po === 'api') {
    const forced = resolveNonPlanPrice(np, model, ts, o)
    forced.subscription = false
    return forced
  }
  // ---- 1. 内置订阅套餐 ----
  const sub = subscriptionPlanFor(np, model)
  if (sub) return { rates: sub, tiered: false, estimated: true, subscription: true, model, era: null, source: 'plan' }
  return resolveNonPlanPrice(np, model, ts, o)
}

/** 订阅归类覆盖查找：先 provider/model 精确，再 provider/* 通配 */
function planOverrideFor(np, model, map) {
  if (!map || typeof map !== 'object') return ''
  const nModel = normalizeModelName(model)
  const nProv = normalizeModelName(np)
  const exact = map[nProv + '/' + nModel]
  if (exact === 'plan' || exact === 'api') return exact
  const wild = map[nProv + '/*']
  if (wild === 'plan' || wild === 'api') return wild
  return ''
}

/** 非订阅路径的价格解析：覆盖价 > 时代精确表（内置+同步） > 目录 > provider 兜底 > 通用兜底 */
function resolveNonPlanPrice(np, model, ts, o) {
  const ov = (o.overrides || PRICE_OVERRIDES)
  const hit = ov.get(overrideKey(np, model))
  if (hit) return { rates: hit.rates, tiered: hit.tiered, estimated: false, subscription: false, model, era: eraAt(ts).id, source: 'override' }
  const era = eraAt(ts)
  const exact = resolveModelInEra(era, model)
  if (exact) return { rates: era.models[exact], tiered: true, estimated: false, subscription: false, model: exact, era: era.id, source: era.synced ? 'synced' : 'exact' }
  if (typeof o.catalog === 'function') {
    try {
      const c = o.catalog(np, model)
      if (c && c.rates) return { rates: c.rates, tiered: false, estimated: false, subscription: false, model, era: era.id, source: 'catalog', catalog: { provider: c.provider, sourceUrl: c.sourceUrl || '', checkedAt: c.checkedAt || '', via: c.via || '' } }
    } catch (e) { /* 目录读取失败不阻断计费，落到 provider 兜底 */ }
  }
  const p = PROVIDER_RATES[np]
  if (p) return { rates: p.rates, tiered: p.tiered, estimated: true, subscription: false, model, era: era.id, source: 'provider' }
  return { rates: GENERIC_RATES, tiered: false, estimated: true, subscription: false, model, era: era.id, source: 'generic' }
}

/**
 * 计算一次调用的费用（CNY）。
 * @param {object} rates - {input, output, cacheRead, cacheWrite, reasoning?}（CNY / 1M tokens）
 *   cacheRead 与 cacheWrite 同价（均为缓存命中价），输入用未命中价，reasoning 缺省 0。
 * @param {boolean} tiered - 是否峰谷计价（false 时按表内价）
 * @param {boolean} peak - 是否高峰时段（tiered 且非高峰时 ×0.5）
 * @param {{input:number, output:number, cacheRead:number, cacheWrite:number, reasoning?:number}} t - token 用量
 */
export function computeCost(rates, tiered, peak, t) {
  const f = tiered && !peak ? 0.5 : 1
  const reasoning = toNum(t.reasoning) * (toNum(rates.reasoning))
  return (t.input * rates.input + t.output * rates.output + (t.cacheRead + t.cacheWrite) * rates.cacheRead + reasoning) * f / 1000000
}

function toNum(x) { const n = Number(x); return isNaN(n) ? 0 : n }

/**
 * 把 DSH usage 事件归一化为插件记账的 token 桶。
 * - inputTokens：缓存未命中的输入（DSH 已从 prompt_tokens 中扣除缓存命中部分）
 * - imageTokens：预留的视觉图片 token 字段（当前 DSH 未提供，图片 token 已在 inputTokens 内）；
 *   若未来出现独立字段则并入输入，避免漏计
 * - reasoningTokens：推理 token（reasoning 模型按单独单价计费；缺省 0）
 * @param {object} usage - DSH llm/stream usage 事件
 */
export function normalizeTokens(usage) {
  return {
    input: toNum(usage.inputTokens) + toNum(usage.imageTokens),
    output: toNum(usage.outputTokens),
    cacheRead: toNum(usage.cacheReadTokens),
    cacheWrite: toNum(usage.cacheWriteTokens),
    reasoning: toNum(usage.reasoningTokens),
  }
}

// ============================================================
// 云端专用追加段（v1.9.0）
//
// 本段以下的代码**只存在于云端副本**：插件仓库的 pricing.js 是纯计价层，
// 云端还需要「权威计费入口」「价格快照」「来源哈希」这些服务端专属能力。
// 同源校验脚本只比对插件侧存在的结构 + PRICING_SOURCE_HASH（= 插件
// pricing.js 的 sha256），因此本段增删不影响同源判定；但改动上面的计价逻辑
// 必须先改插件仓库再同步过来。
// ============================================================

/** 原始来源文件（用于同步校验） */
export const PRICING_SOURCE = 'dsh-cost-tracker/pricing.js'

export function r4(x) { return Math.round(x * 10000) / 10000 }
export function r6(x) { return Math.round(x * 1000000) / 1000000 }

/**
 * 归一化 provider 名（与插件 `index.js` 的 normProvider 同规则）：
 * 小写并剔除 `-official` 等后缀，使 `deepseek-official` 与 `deepseek` 命中同一档兜底价。
 */
export function normalizeProvider(p) {
  return String(p == null ? '' : p).toLowerCase().replace(/-official$/, '')
}

/**
 * 云端权威计费：按记录自身时间戳选价格时代，返回费用与派生口径。
 *
 * v1.9.0：与插件 priceFor 同步支持 opts（目录命中 / 手动覆盖价 / 订阅归类），
 * 云端可按需注入（当前默认不注入，保持「服务端只用同源价格表」的既有口径；
 * 注入后 cost_basis/cost_drift 会照常记录差异，便于审计）。
 *
 * @param {string} provider - 上报的 provider（内部会归一化）
 * @param {string} model - 上报的模型名
 * @param {number} ts - 调用时刻（epoch ms）
 * @param {object} tokens - 已归一化的 token 桶
 * @param {{catalog?:Function, overrides?:Map, planOverrides?:object}} [opts]
 * @returns {{cost:number, model:string, period:string, estimated:boolean, subscription:boolean, era:string|null, source:string}}
 */
export function computeCostAt(provider, model, ts, tokens, opts) {
  const np = normalizeProvider(provider)
  const price = priceFor(np, model, ts, opts)
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
    source: price.source || '',
  }
}

/** 供 /api/v1/protocol 与工具展示的价格表快照 */
export function priceSnapshot(now) {
  const t = Number.isFinite(now) ? now : Date.now()
  const era = eraAt(t)
  const out = {
    unit: 'CNY / 1M tokens',
    peakWindows: PEAK_WINDOWS,
    offPeakFactor: 0.5,
    currentEra: era.id,
    eraLabel: era.label,
    eraSynced: era.synced === true,
    eras: PRICE_ERAS.map((e) => ({ id: e.id, label: e.label, since: e.since, models: e.models, routes: e.routes || {} })),
    subscription: SUBSCRIPTION_RATES,
    providers: PROVIDER_RATES,
    generic: GENERIC_RATES,
    // v1.4.1：订阅制套餐的**等效单价表**（看板「订阅服务」页用它解释等效费用从哪来）。
    // 之前只回显 kimi（SUBSCRIPTION_RATES），火山的等效单价虽在算价里用到却看不到，
    // 于是看板上「有火山订阅记录、却没有火山套餐说明」。
    subscriptionPlans: [
      {
        id: 'kimi-coding',
        label: 'Kimi Coding Plan',
        providers: ['kimi-coding', 'kimi'],
        rates: SUBSCRIPTION_RATES['kimi-coding'] || SUBSCRIPTION_RATES.kimi,
        scope: '整档订阅（provider 命中即计订阅）',
      },
      {
        id: 'volcengine-coding-plan',
        label: '火山方舟 Coding Plan（BytePlus Coding Plan CN）',
        providers: VOLCENGINE_PLAN_PROVIDER_KEYS,
        dedicated: VOLCENGINE_PLAN_DEDICATED_PROVIDERS,
        models: Object.keys(volcenginePlanModels()),
        rates: VOLCENGINE_PLAN_RATES,
        scope: '专属 Coding 端点整档订阅；泛 volcengine 仅白名单模型；接入点 ep-* 按量',
      },
    ],
  }
  // v1.9.0：同步时代（若云端调用过 setSyncedEras 注入）一并回显，
  // 便于 /api/v1/protocol 对照「云端算价用的是哪一版官方价」
  const synced = getSyncedEras()
  if (synced.length) out.syncedEras = synced.map((e) => ({ id: e.id, label: e.label, since: e.since, models: e.models, routes: e.routes || {} }))
  return out
}
