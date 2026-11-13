// ============================================================
// DSH 花费统计插件 —— 多厂商模型价格目录（纯逻辑，可独立测试）
//
// 数据来源：docs/provider-pricing.json —— 初版改编自 dsh-cost-meter（MIT License）
// 的「已核对官方价格目录」，2026-10-25 起按各厂商官方定价页逐条复核刷新
// （官方页不可达时才用网关价并标注），保留每个条目的 sourceUrl / checkedAt
// 以便溯源；条目单价为 **USD / 1M tokens**。
//
// 本插件账本恒以人民币（CNY）入账，因此目录价在计费时按 `catalogFxRate`
// （默认 7.2，可在配置面板修改）折算为 CNY。缓存写入价沿用目录约定：
// 与缓存命中价（cachedInput）同价。
//
// 匹配规则（catalogEntryFor）：
//   1. provider 别名归一（openai/gpt、anthropic/claude、google/gemini、
//      moonshot/kimi、z-ai/zhipu/glm、alibaba/qwen…）；
//   2. mode='exact'：仅当归一化模型名与目录键完全相等；
//      mode='fuzzy'（默认）：相等优先，其次「请求名包含表内名 / 表内名包含
//      请求名」（双方归一化后长度 ≥4 才参与包含匹配，避免误伤）；
//   3. 同 provider 未命中时，若**恰好只有一个**厂商拥有同名模型，则跨厂商命中
//      （例如 provider 名千奇百怪但模型就叫 glm-5-flash）。
//
// 目录命中 = 精确价（estimated=false，来源标注 catalog）；未命中继续走
// pricing.js 的 provider 兜底 / 通用兜底（estimated=true）。
// ============================================================
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const CATALOG_META = {
  generatedAt: '2026-11-13',
  note: 'USD per 1M tokens; unpriced entries have no verified official price. fast-tier prices live under serviceTiers.fast.',
  origin: 'adapted from dsh-cost-meter docs/provider-pricing.json (MIT); refreshed from vendor pricing pages 2026-11-13',
}

/** 目录价 USD→CNY 默认汇率（可在配置中覆盖）。v1.11.0 起由 7.2 调整为 6.67。 */
export const CATALOG_FX_DEFAULT = 6.67

/**
 * 历史默认汇率：v1.10.x 及更早版本的默认值。
 * 老配置文件里如果存着这个值，说明用户**从未改过**（只是被默认值写了进去），
 * 升级后应跟随新默认 6.67；用户显式改成别的数字（如 6.9）则保留。
 */
export const CATALOG_FX_LEGACY_DEFAULT = 7.2

/** 与 pricing.js 的 normalizeModelName 同一实现（避免相互 import 成环） */
export function normalizeModelName(m) {
  return String(m == null ? '' : m).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** DSH 侧 provider 名（归一化后）→ 目录键 */
export const PROVIDER_ALIASES = {
  openai: 'openai', gpt: 'openai', chatgpt: 'openai',
  anthropic: 'anthropic', claude: 'anthropic',
  google: 'google', gemini: 'google', deepmind: 'google',
  moonshot: 'moonshot', 'moonshot-ai': 'moonshot', 'moonshotai': 'moonshot', kimi: 'moonshot',
  'z-ai': 'z-ai', zai: 'z-ai', zhipu: 'z-ai', bigmodel: 'z-ai', glm: 'z-ai',
  xai: 'xai', grok: 'xai',
  alibaba: 'alibaba', qwen: 'alibaba', dashscope: 'alibaba', ali: 'alibaba',
  minimax: 'minimax',
  tencent: 'tencent', hunyuan: 'tencent',
  xiaomi: 'xiaomi', mimo: 'xiaomi',
  upstage: 'upstage', solar: 'upstage',
  nvidia: 'nvidia', 'nvidia-nim': 'nvidia',
  mistral: 'mistral', mistralai: 'mistral',
  meta: 'meta', 'meta-ai': 'meta', muse: 'meta',
  opencode: 'opencode-go', 'opencode-go': 'opencode-go', opencodego: 'opencode-go',
}

let RAW = null
let RAW_TEXT = ''
function rawProviders() {
  if (RAW !== null) return RAW
  try {
    RAW_TEXT = readFileSync(new URL('./docs/provider-pricing.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(RAW_TEXT)
    RAW = parsed && typeof parsed === 'object' && parsed.providers ? parsed.providers : {}
  } catch (e) {
    RAW = {}
  }
  return RAW
}

/** 目录指纹（数据文件原文的 sha256 前 16 位），供云端同源校验与设置页展示 */
export function catalogFingerprint() {
  rawProviders()
  if (!RAW_TEXT) return ''
  return 'sha256:' + createHash('sha256').update(RAW_TEXT).digest('hex').slice(0, 16)
}

/** 每个厂商的条目数（设置页展示用） */
export function catalogProviders() {
  const ps = rawProviders()
  return Object.keys(ps).map((id) => ({ id, count: Object.keys((ps[id] && ps[id].models) || {}).length }))
}

/** 惰性索引：目录键 → Map(归一化模型名 → 条目)；条目不改写，原名另存于 KEY_ORIGINAL */
let INDEX = null
/** 归一化模型名 → 目录里的原始写法（展示用，避免出现 gpt61sol 这种名字） */
let KEY_ORIGINAL = null
function catalogIndex() {
  if (INDEX) return INDEX
  INDEX = new Map()
  KEY_ORIGINAL = new Map()
  const ps = rawProviders()
  for (const pid of Object.keys(ps)) {
    const models = (ps[pid] && ps[pid].models) || {}
    const m = new Map()
    for (const key of Object.keys(models)) {
      const norm = normalizeModelName(key)
      m.set(norm, models[key])
      if (!KEY_ORIGINAL.has(norm)) KEY_ORIGINAL.set(norm, key)
    }
    INDEX.set(pid, m)
  }
  return INDEX
}

/** 归一化模型名 → 目录原始写法（无记录时回退为归一化名） */
export function catalogOriginalName(normalized) {
  catalogIndex()
  const n = String(normalized == null ? '' : normalized)
  return (KEY_ORIGINAL && KEY_ORIGINAL.get(n)) || n
}

/** 反向索引：归一化模型名 → 拥有它的目录键列表（跨厂商同名匹配用，惰性） */
let REVERSE = null
function reverseIndex() {
  if (REVERSE) return REVERSE
  REVERSE = new Map()
  for (const [pid, models] of catalogIndex()) {
    for (const n of models.keys()) {
      let list = REVERSE.get(n)
      if (!list) { list = []; REVERSE.set(n, list) }
      list.push(pid)
    }
  }
  return REVERSE
}

/** provider 名 → 目录键（未登记返回 ''） */
export function catalogProviderKey(np) {
  const n = String(np == null ? '' : np).toLowerCase().replace(/-official$/, '').replace(/[^a-z0-9-]/g, '')
  if (PROVIDER_ALIASES[n]) return PROVIDER_ALIASES[n]
  // 目录键本身也可直接作为 provider 名（如自建 provider 就叫 openai）
  const ps = rawProviders()
  if (ps[n]) return n
  return ''
}

function toRates(entry, fx) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0 }
  const cache = num(entry.cachedInput)
  // v1.11.0：缓存写价优先用条目自带的 cacheWriteInput（OpenAI / Anthropic 与缓存读不同价），
  // 没有该字段时沿用旧约定（写价 = 缓存命中价），保证历史条目行为不变。
  const cacheWrite = entry.cacheWriteInput === undefined ? cache : num(entry.cacheWriteInput)
  return {
    input: num(entry.input) * fx,
    output: num(entry.output) * fx,
    cacheRead: cache * fx,
    cacheWrite: cacheWrite * fx,
  }
}

/**
 * 取条目某个档位（fast / standard）的价格块，若请求输入量超过长上下文阈值则改用 longContext。
 * @param {object} entry - 目录条目
 * @param {{input?:number, cacheRead?:number, cacheWrite?:number}} [tokens] - 本次用量
 * @returns {{ block: object, contextTier: 'short'|'long' }}
 */
function pickBlock(entry, tokens) {
  const long = entry && entry.longContext
  if (!long) return { block: entry || {}, contextTier: 'short' }
  const t = tokens || {}
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0 }
  // 阈值只按**输入侧**判定（官方口径：prompt > 272K），输出 token 不计入，
  // 否则「长输入短输出」的请求会被误判成长档。
  const promptTokens = num(t.input) + num(t.cacheRead) + num(t.cacheWrite)
  const threshold = num(long.inputTokensAbove)
  if (threshold > 0 && promptTokens > threshold) {
    // 只覆盖价格字段，**不能**把 longContext / serviceTiers 带进来：
    // 否则标准档会误用 Fast 价（曾实测：standard 请求被算成 $4 而不是 $2）。
    return {
      block: {
        input: long.input, cachedInput: long.cachedInput, output: long.output,
        ...(long.cacheWriteInput === undefined ? {} : { cacheWriteInput: long.cacheWriteInput }),
      },
      contextTier: 'long',
    }
  }
  return { block: entry, contextTier: 'short' }
}

/**
 * 在目录中查找某次调用的价格。
 * @param {string} np - 归一化 provider 名
 * @param {string} model - 模型名
 * @param {{mode?:'exact'|'fuzzy', fx?:number, serviceTier?:'standard'|'fast',
 *          tokens?:{input?:number, cacheRead?:number, cacheWrite?:number}}} [opts]
 *   serviceTier='fast' 时优先用条目的 serviceTiers.fast（无该块则回落标准价并标 standard-only）；
 *   tokens 用于长上下文分档（超过 longContext.inputTokensAbove 时按整请求长档价）。
 * @returns {object|null} { provider, catalogModel, rates(CNY), sourceUrl, checkedAt, fx, via,
 *   serviceTier, tierPriceSource, contextTier, tierNote? }
 *   via: 'exact' | 'fuzzy' | 'cross-provider'
 */
export function catalogEntryFor(np, model, opts) {
  const o = opts || {}
  const mode = o.mode === 'exact' ? 'exact' : 'fuzzy'
  const fx = Number.isFinite(Number(o.fx)) && Number(o.fx) > 0 ? Number(o.fx) : CATALOG_FX_DEFAULT
  let pid = catalogProviderKey(np)
  if (!pid) return null
  const models = catalogIndex().get(pid)
  if (!models || models.size === 0) return null
  const n = normalizeModelName(model)
  if (!n) return null
  let hit = null
  let via = ''
  if (models.has(n)) {
    hit = models.get(n); via = 'exact'
  } else if (mode === 'fuzzy') {
    // 包含匹配：双方归一化后长度 ≥4 才参与，取**最长**的表内名（更具体）
    let best = ''
    for (const key of models.keys()) {
      if (key.length < 4) continue
      if ((n.indexOf(key) >= 0 || key.indexOf(n) >= 0) && n.length >= 4 && key.length > best.length) {
        best = key
      }
    }
    if (best) { hit = models.get(best); via = 'fuzzy' }
  }
  if (!hit && mode === 'fuzzy') {
    // 跨厂商同名：恰好只有一个厂商拥有该模型名才命中，避免跨厂商错配
    const owners = reverseIndex().get(n)
    if (owners && owners.length === 1) {
      const e = catalogIndex().get(owners[0]).get(n)
      if (e) { hit = e; pid = owners[0]; via = 'cross-provider' }
    }
  }
  if (!hit) return null
  const num = (v) => { const c = Number(v); return Number.isFinite(c) ? c : 0 }
  // ---- v1.11.0：服务档位（GPT Fast / priority）----
  // 只有条目显式登记 serviceTiers.fast 才按 Fast 计；没登记的模型一律按标准价，
  // 绝不按「×2」推算 —— 价格必须来自官方或可核对的来源。
  const wantFast = String(o.serviceTier || '').toLowerCase() === 'fast'
  const fastEntry = wantFast && hit.serviceTiers && hit.serviceTiers.fast ? hit.serviceTiers.fast : null
  const priced = fastEntry || hit
  const { block, contextTier } = pickBlock(priced, o.tokens)
  const serviceTier = fastEntry ? 'fast' : 'standard'
  let tierNote = ''
  if (wantFast && !fastEntry) {
    tierNote = '该模型无 Fast 档价，按标准价计'
  } else if (wantFast && fastEntry && block === priced && priced.longContext) {
    tierNote = ''
  }
  return {
    provider: pid,
    catalogModel: hit.__key || undefined,
    rates: toRates(block, fx),
    sourceUrl: String((fastEntry && hit.sourceUrlFast) || hit.sourceUrl || ''),
    checkedAt: String((fastEntry && hit.checkedAtFast) || hit.checkedAt || ''),
    notes: String(hit.notes || ''),
    fx,
    via,
    serviceTier,
    tierPriceSource: fastEntry ? 'catalog-fast' : (wantFast ? 'standard-only' : 'standard'),
    ...(tierNote ? { tierNote } : {}),
    contextTier,
    longContextThreshold: block && block.inputTokensAbove !== undefined ? num(block.inputTokensAbove) : undefined,
    priceHint: { input: num(block.input), output: num(block.output), cachedInput: num(block.cachedInput), currency: 'USD', serviceTier },
  }
}

/** 调试/展示：某 provider 在目录中的全部模型键 */
export function catalogModelsFor(np) {
  const pid = catalogProviderKey(np)
  if (!pid) return []
  return [...catalogIndex().get(pid).keys()]
}

/**
 * v1.11.0：列出目录中**登记了 Fast 档价**的模型，并给出标准价 / Fast 价对照。
 * 展示层（设置页、cost_prices 工具）据此说明哪些模型走 Fast 会加价，以及具体数额。
 *
 * @param {number} [fx] - USD→CNY 汇率（缺省用 CATALOG_FX_DEFAULT）
 * @returns {{ fx:number, checkedAt:string, models:Array<object> }}
 *   每项：{ provider, model, standard:{input,cachedInput,output}, fast:{...},
 *          standardCny, fastCny, longContext?, sourceUrl, checkedAt, confidence }
 */
export function catalogFastTiers(fx) {
  const rate = Number.isFinite(Number(fx)) && Number(fx) > 0 ? Number(fx) : CATALOG_FX_DEFAULT
  const out = []
  let checkedAt = ''
  const yen = (v) => Math.round(Number(v) * rate * 10000) / 10000
  for (const [pid, models] of catalogIndex()) {
    for (const [normName, entry] of models) {
      const fast = entry && entry.serviceTiers && entry.serviceTiers.fast
      if (!fast) continue
      const std = { input: Number(entry.input) || 0, cachedInput: Number(entry.cachedInput) || 0, output: Number(entry.output) || 0 }
      const fst = { input: Number(fast.input) || 0, cachedInput: Number(fast.cachedInput) || 0, output: Number(fast.output) || 0 }
      const check = String(entry.checkedAtFast || '')
      if (check && check > checkedAt) checkedAt = check
      out.push({
        provider: pid,
        model: catalogOriginalName(normName),
        standard: std,
        fast: fst,
        standardCny: { input: yen(std.input), cachedInput: yen(std.cachedInput), output: yen(std.output) },
        fastCny: { input: yen(fst.input), cachedInput: yen(fst.cachedInput), output: yen(fst.output) },
        ...(entry.longContext ? { longContext: entry.longContext } : {}),
        ...(fast.longContext ? { fastLongContext: fast.longContext } : {}),
        sourceUrl: String(entry.sourceUrlFast || ''),
        checkedAt: check,
        confidence: String(fast.confidence || ''),
      })
    }
  }
  out.sort((a, b) => (a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider)))
  return { fx: rate, checkedAt, models: out }
}

/** v1.11.0：目录中**没有** Fast 档价的模型清单（展示层据此说明「该模型不区分 Fast」） */
export function catalogModelsWithoutFastTier(np) {
  const pid = catalogProviderKey(np)
  if (!pid) return []
  const models = catalogIndex().get(pid)
  if (!models) return []
  return [...models.entries()].filter(([, e]) => !(e && e.serviceTiers && e.serviceTiers.fast)).map(([k]) => k)
}
