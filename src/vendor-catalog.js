// ============================================================
// DSH 花费统计插件 —— 多厂商模型价格目录（纯逻辑，可独立测试）
//
// 数据来源：docs/provider-pricing.json —— 改编自 dsh-cost-meter（MIT License）
// 的「已核对官方价格目录」（generatedAt 2026-08-18），保留每个条目的
// sourceUrl / checkedAt 以便溯源；条目单价为 **USD / 1M tokens**。
//
// 本插件账本恒以人民币（CNY）入账，因此目录价在计费时按 `catalogFxRate`
// （默认 7.2，可在插件配置卡修改）折算为 CNY。缓存写入价沿用目录约定：
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
  generatedAt: '2026-08-18',
  note: 'USD per 1M tokens; unpriced entries have no verified official price.',
  origin: 'adapted from dsh-cost-meter docs/provider-pricing.json (MIT)',
}

/** 目录价 USD→CNY 默认汇率（可在配置中覆盖） */
export const CATALOG_FX_DEFAULT = 7.2

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

/** 惰性索引：目录键 → Map(归一化模型名 → 条目) */
let INDEX = null
function catalogIndex() {
  if (INDEX) return INDEX
  INDEX = new Map()
  const ps = rawProviders()
  for (const pid of Object.keys(ps)) {
    const models = (ps[pid] && ps[pid].models) || {}
    const m = new Map()
    for (const key of Object.keys(models)) m.set(normalizeModelName(key), models[key])
    INDEX.set(pid, m)
  }
  return INDEX
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
  return {
    input: num(entry.input) * fx,
    output: num(entry.output) * fx,
    cacheRead: cache * fx,
    cacheWrite: cache * fx,
  }
}

/**
 * 在目录中查找某次调用的价格。
 * @param {string} np - 归一化 provider 名
 * @param {string} model - 模型名
 * @param {{mode?:'exact'|'fuzzy', fx?:number}} [opts]
 * @returns {object|null} { provider, catalogModel, rates(CNY), sourceUrl, checkedAt, fx, via }
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
  return {
    provider: pid,
    catalogModel: hit.__key || undefined,
    rates: toRates(hit, fx),
    sourceUrl: String(hit.sourceUrl || ''),
    checkedAt: String(hit.checkedAt || ''),
    notes: String(hit.notes || ''),
    fx,
    via,
    priceHint: { input: num(hit.input), output: num(hit.output), cachedInput: num(hit.cachedInput), currency: 'USD' },
  }
}

/** 调试/展示：某 provider 在目录中的全部模型键 */
export function catalogModelsFor(np) {
  const pid = catalogProviderKey(np)
  if (!pid) return []
  return [...catalogIndex().get(pid).keys()]
}
