// ============================================================
// DSH 花费统计插件 —— 定价与 Token 层（纯逻辑，可独立测试）
//
// ⚠️ 本文件是插件仓库 `dsh-cost-tracker/pricing.js` 的**刻意副本**（v1.9.0 起
// 除本段注释与 PRICING_SOURCE_HASH 常量外逐字节一致，见
// scripts/check-pricing-sync.js 的同源校验）。改动计价逻辑请先改插件仓库，
// 再跑 `node scripts/sync-pricing-copy.js` 刷新本副本与 PRICING_SOURCE_HASH。
//
// 单价来源：DeepSeek 官方定价页
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
//   - 高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00，**不含中国法定节假日**）
//     为表内价格；其余时段（含周末与法定节假日全天）= 高峰 × 0.5。
//   - **单价随时间调整**：故单价表按生效时刻分版（见 PRICE_ERAS），按记录时间戳选版。
//       · legacy  ：V4-Flash 3.0/9.0/0.10、V4-Pro 9.0/27.0/0.30
//       · v41     ：V4.1 Flash 2.0/8.0/0.04（北京时间 2026-09-10 12:00 起生效）。
//                   官方现役模型名为 `deepseek-flash`；旧名 `deepseek-v4-flash` 与
//                   `deepseek-v4-flash-vision-exp` 已下线但仍可调用，请求由 V4.1 Flash
//                   提供服务并按 Flash 价计费，故一并路由到 `deepseek-flash`。
//                   **V4-Pro 维持自有牌价（9.0/27.0/0.30），不做任何路由**：
//                   09-10 新闻稿确实预告过「9-14 12:00 之后 pro 请求全部路由到 V4.1 Flash
//                   并按 Flash 单价计费」，v1.9.0/1.9.1 据此实现了 v41pro 时代；但官方
//                   **更新日志随后改为**「为响应广大用户的需求，我们决定在 2026 年 9 月 14 日
//                   之后继续提供 DeepSeek V4 Pro 的 API 调用服务，计费方式保持不变」，
//                   且现行价目页仍为 pro **单列价格**（9.0/27.0/0.30）与**独立并发 500**
//                   （flash 为 2500），脚注只把旧 flash 名与 `deepseek-v4.1-flash` 路由到
//                   flash。故 v1.9.2 起**取消 pro 的反向路由**：否则会按 Flash 价计 pro 调用
//                   （输入 2 vs 9、输出 8 vs 27），显著低估。
//   - 法定节假日（isPeak / peakPhaseAt 的 offAllDay）：官方口径把节假日全天计入空闲时段，
//     数据来自国务院办公厅节假日安排通知（见 CN_HOLIDAYS）。调休补班的周六/周日**不**计高峰
//     —— 定价规则只看「周一至周五」，调休不改变这一点。
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
 *  由 scripts/sync-pricing-copy.js 自动重算；请勿手改。 */
export const PRICING_SOURCE_HASH = 'sha256:4420f2df88d783f5'

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
    label: 'V4.1 Flash 价（2026-09-10 12:00 起；V4-Pro 维持自有牌价）',
    since: V41_EFFECTIVE_AT,
    models: {
      // 高峰价：输入（缓存命中）0.04 / 输入（缓存未命中）2 / 输出 8；空闲减半
      [V41_FLASH_MODEL]: { input: 2.0, output: 8.0, cacheRead: 0.04, cacheWrite: 0.04 },
      // V4-Pro 维持自有牌价：官方 9-14 撤销了下线计划（「继续提供服务，计费方式保持不变」），
      // 现行价目页仍为其单列 9.0/27.0/0.30 与独立并发 500 —— 因此**不做路由**。
      'deepseek-v4-pro': { input: 9.0, output: 27.0, cacheRead: 0.30, cacheWrite: 0.30 },
    },
    // 旧 V4-Flash 系（含视觉版）已下线，请求由 V4.1 Flash 提供并按 Flash 价计费。
    routes: {
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

/** 高峰时段（北京时间，仅周一至周五且非法定节假日），空闲时段 = 高峰 × 0.5 */
export const PEAK_WINDOWS = '周一至周五 9:00-12:00 · 14:00-18:00（周末与法定节假日全天闲时）'

/** 视觉模型名（DeepSeek DeepSeek-V4-Flash-Vision-Exp） */
export const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** 每张图片换算 token 的上限（官方规则） */
export const VISION_IMAGE_MAX_TOKENS = 384

// ------------------------------------------------------------
// 中国法定节假日（官方峰谷口径：节假日全天计入空闲时段）
//
// 官方价目页脚注：「北京时间周一至周五（**不含中国法定节假日**）9:00-12:00、
// 14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
// 因此仅排除周末是不够的：节假日落在一周内时，峰段也必须按闲时计（否则会多计 1 倍）。
//
// 数据来源：国务院办公厅关于节假日安排的通知。
//   · 2026 年：国办发明电〔2025〕7 号（2025-11-04 发布）
//     https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
// 调休补班的周六/周日**不计高峰**：定价规则只看「周一至周五」，调休不改变这一点。
// 新一年度的安排通常在上一年 11 月公布，届时更新本表并随版本发布；也可在插件配置卡
// 用 `peakHolidays` 覆盖（见 setPeakHolidays）。
// ------------------------------------------------------------
export const CN_HOLIDAYS = [
  // 2026 · 元旦 1/1-1/3
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 2026 · 春节 2/15-2/23
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 2026 · 清明 4/4-4/6
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 2026 · 劳动节 5/1-5/5
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 2026 · 端午 6/19-6/21
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 2026 · 中秋 9/25-9/27
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 2026 · 国庆 10/1-10/7
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 把 'YYYY-MM-DD' / 'YYYY/M/D' 归一为 'YYYY-MM-DD'；非法返回 '' */
function normHolidayKey(s) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(String(s == null ? '' : s).trim())
  if (!m) return ''
  const mm = Number(m[2])
  const dd = Number(m[3])
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return ''
  return m[1] + '-' + (mm < 10 ? '0' + mm : String(mm)) + '-' + (dd < 10 ? '0' + dd : String(dd))
}

/** 归一化节假日列表：接受数组或「逗号/分号/空白分隔」的整串，去重并升序 */
export function normalizeHolidayList(input) {
  const out = []
  if (Array.isArray(input)) {
    for (const s of input) { const k = normHolidayKey(s); if (k) out.push(k) }
  } else if (typeof input === 'string') {
    for (const s of input.split(/[\s,，;；]+/)) { const k = normHolidayKey(s); if (k) out.push(k) }
  }
  return Array.from(new Set(out)).sort()
}

// null = 使用内置表 CN_HOLIDAYS；[] = 显式停用（不排除任何节假日）；否则为用户覆盖列表
let PEAK_HOLIDAY_LIST = null
let PEAK_HOLIDAY_SET = null // Set<string>（null 时按需从 CN_HOLIDAYS 构建）

/**
 * 覆盖法定节假日列表（插件配置卡的「峰谷计价与提示」）。语义防呆：
 *   · 传 null / undefined / ''  → 恢复内置表（默认）；config 里存空串即走这条；
 *   · 传 'none' / 'off' / '0'   → 显式停用（不排除任何节假日，等价于按「仅周末」计）；
 *   · 传数组或分隔字符串        → 用该列表**整体替换**内置表（不追加）；
 *   · 传了内容但一条都解析不出  → 视为停用并记入 invalid，如实回显，
 *                                避免「以为关掉了节假日，其实还在用内置表」。
 * @returns {{dates:string[], mode:'builtin'|'custom'|'disabled', builtin:boolean, disabled:boolean, count:number, invalid:string[]}}
 */
export function setPeakHolidays(input) {
  if (Array.isArray(input)) {
    PEAK_HOLIDAY_LIST = normalizeHolidayList(input)
  } else if (input === null || input === undefined) {
    PEAK_HOLIDAY_LIST = null
  } else {
    const raw = String(input).trim()
    if (raw === '') PEAK_HOLIDAY_LIST = null
    else if (/^(none|off|0|无|关|关闭)$/i.test(raw)) PEAK_HOLIDAY_LIST = []
    else PEAK_HOLIDAY_LIST = normalizeHolidayList(raw)
  }
  PEAK_HOLIDAY_SET = null
  return getPeakHolidays(typeof input === 'string' ? input : undefined)
}

/**
 * 当前生效的节假日列表（含来源标记，便于配置卡回显与双端比对）。
 * @param {string} [rawInput] - 可选：原始配置字符串（用于统计被忽略的非法条目）
 */
export function getPeakHolidays(rawInput) {
  const list = PEAK_HOLIDAY_LIST === null ? CN_HOLIDAYS : PEAK_HOLIDAY_LIST
  const invalid = []
  if (typeof rawInput === 'string' && rawInput.trim() !== '' && !/^(none|off|0|无|关|关闭)$/i.test(rawInput.trim())) {
    for (const tok of rawInput.split(/[\s,，;；]+/)) {
      if (tok && !normHolidayKey(tok)) invalid.push(tok)
    }
  }
  const mode = PEAK_HOLIDAY_LIST === null ? 'builtin' : (PEAK_HOLIDAY_LIST.length === 0 ? 'disabled' : 'custom')
  return { dates: list.slice(), mode, builtin: mode === 'builtin', disabled: mode === 'disabled', count: list.length, invalid }
}

/** 某时刻所属的北京日历日（'YYYY-MM-DD'） */
export function holidayKeyAt(ts) {
  const t = Number(ts)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + 28800000)
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

/** 北京日 index（D0，北京午夜为界）→ 'YYYY-MM-DD' */
function holidayKeyOfDayIndex(D) {
  return holidayKeyAt(D * 86400000 - 28800000 + 43200000) // 该北京日正午，避免边界歧义
}

/** 某时刻是否落在（配置生效的）中国法定节假日 */
export function isCnHoliday(ts) {
  const key = holidayKeyAt(ts)
  if (!key) return false
  const set = PEAK_HOLIDAY_SET || (PEAK_HOLIDAY_SET = new Set(PEAK_HOLIDAY_LIST === null ? CN_HOLIDAYS : PEAK_HOLIDAY_LIST))
  return set.has(key)
}

/** 是否高峰时段（北京时间 UTC+8：周一至周五、非节假日、落在峰窗口内） */
export function isPeak(ts) {
  const t = Number(ts)
  const d = new Date(t + 28800000)
  const day = d.getUTCDay() // 0=周日 … 6=周六
  if (day === 0 || day === 6) return false // 周末不计高峰
  if (isCnHoliday(t)) return false // 法定节假日全天闲时
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 峰时段窗口（北京时间小时，半开区间 [start, end)）。 */
export const PEAK_HOUR_WINDOWS = [{ start: 9, end: 12 }, { start: 14, end: 18 }]

/**
 * 某一时刻所处的峰谷相位与相邻切换点（供时段条 / 倒计时 / 切换前弹窗）。
 * 与 isPeak 同口径（北京时间 UTC+8），并处理「全天谷价日」：
 *  - 普通工作日：按峰窗口判定 inPeak，扫描前后 N 天收集切换点；
 *  - 周末 / 法定节假日：inPeak=false、allDayOff=true，日内无切换点（价格恒为谷），
 *    下一个价格切换点为下一个「工作日且非节假日」的首个峰窗口起点；
 *    weekend / holiday 分别标记具体原因（节假日落在周末时 weekend 优先）。
 * @param {number} ts - epoch ms
 * @param {number} [spanDays=5] - 前后扫描天数（须覆盖最长连休：春节 9 天，故内部下限取 12）
 * @returns {{inPeak:boolean, weekend:boolean, holiday:boolean, allDayOff:boolean,
 *            prevAtMs:number, nextAtMs:number, nextIntoPeak:boolean}|null}
 *          prevAtMs/nextAtMs 为相邻切换点 epoch ms（全天谷价日的 prevAtMs = 本段连休起点）
 */
export function peakPhaseAt(ts, spanDays) {
  if (!Number.isFinite(ts)) return null
  // 连休最长可达 9 天（春节），默认扫描窗口必须比它大，否则会找不到下一切换点。
  const SPAN = Math.max(12, (Number.isFinite(spanDays) && spanDays >= 1) ? Math.floor(spanDays) : 5)
  const DAY_MS = 86400000
  // 北京时间日 index 与星期（0=周日 … 6=周六；1970-01-01 为周四）。
  const D0 = Math.floor((ts + 28800000) / DAY_MS)
  const weekday = (D0 + 4) % 7
  const isWeekendNow = weekday === 6 || weekday === 0
  const isHolidayNow = isCnHoliday(ts)
  const allDayOffNow = isWeekendNow || isHolidayNow
  // 某北京时间日 D 的某时 h 对应的 epoch ms（北京 = UTC+8）。
  const atBeijing = (D, h) => D * DAY_MS - 28800000 + h * 3600000
  // 某北京时间日 D 是否为「全天谷价日」：周末或法定节假日。
  const dayOff = (D) => {
    const wd = (D + 4) % 7
    if (wd === 6 || wd === 0) return true
    const set = PEAK_HOLIDAY_SET || (PEAK_HOLIDAY_SET = new Set(PEAK_HOLIDAY_LIST === null ? CN_HOLIDAYS : PEAK_HOLIDAY_LIST))
    return set.has(holidayKeyOfDayIndex(D))
  }
  // 收集 ±SPAN 天内全部窗口边界切换点，剔除落在全天谷价日（无价格变化）的点。
  const points = []
  for (let off = -SPAN; off <= SPAN; off += 1) {
    const D = D0 + off
    if (dayOff(D)) continue // 周末 / 节假日日内无切换
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
  if (allDayOffNow) {
    // 全天谷价：当前谷，下一切换 = 下一个非谷价日的首个峰窗口起点；
    // prev = 本段连休起点（北京时间 00:00），便于「本段已持续多久」类展示。
    if (next === null) return null
    let start = D0
    for (let i = 0; i < SPAN && dayOff(start - 1); i += 1) start -= 1
    return {
      inPeak: false,
      weekend: isWeekendNow,
      holiday: isHolidayNow && !isWeekendNow,
      allDayOff: true,
      prevAtMs: start * DAY_MS - 28800000,
      nextAtMs: next.at,
      nextIntoPeak: next.intoPeak,
    }
  }
  if (prev === null || next === null) return null
  return { inPeak: isPeak(ts), weekend: false, holiday: false, allDayOff: false, prevAtMs: prev.at, nextAtMs: next.at, nextIntoPeak: next.intoPeak }
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
