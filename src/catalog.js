// ============================================================
// dsh-cost-cloud —— 多厂商价格目录（云端侧封套）
//
// 与插件侧共用 src/vendor-catalog.js（**逐字节副本**）+ src/docs/provider-pricing.json。
// 目录数据为 USD / 1M tokens，云端算价（computeCostAt）需要人民币口径，
// 因此这里按 meta 里配置的汇率（catalog_fx_rate，默认 7.2）折算。
//
// 用途：**与插件侧口径一致** —— 内置价格表（DeepSeek 官方价）之外的模型
// （OpenAI / Anthropic / Gemini / Qwen 等）在插件侧按目录价计费且标为「精确」，
// 云端若只看兜底价就会把它们全部算成「估算」，两边 cost_drift 会长期虚高。
//
// 开关：meta `catalog_enabled`（默认 '1' 开启）。关掉后云端退回纯内置表口径。
// ============================================================
import { getMeta, setMeta } from './db.js'
import { catalogEntryFor, catalogFingerprint, catalogProviders, CATALOG_META, CATALOG_FX_DEFAULT } from './vendor-catalog.js'

export const CATALOG_ENABLED_META = 'catalog_enabled'
export const CATALOG_FX_META = 'catalog_fx_rate'
export const CATALOG_MATCH_META = 'catalog_match'

/** 目录计价配置（默认开启、汇率 7.2、宽松匹配——与插件默认一致） */
export function catalogConfig(db) {
  const enabled = getMeta(db, CATALOG_ENABLED_META, '1') !== '0'
  const fxRaw = Number(getMeta(db, CATALOG_FX_META, String(CATALOG_FX_DEFAULT)))
  const fx = Number.isFinite(fxRaw) && fxRaw >= 0.1 && fxRaw <= 100 ? fxRaw : CATALOG_FX_DEFAULT
  const match = getMeta(db, CATALOG_MATCH_META, 'fuzzy') === 'exact' ? 'exact' : 'fuzzy'
  return { enabled, fx, match }
}

export function setCatalogConfig(db, patch) {
  const p = patch || {}
  if (typeof p.enabled === 'boolean') setMeta(db, CATALOG_ENABLED_META, p.enabled ? '1' : '0')
  if (Number.isFinite(Number(p.catalogFxRate)) && Number(p.catalogFxRate) >= 0.1 && Number(p.catalogFxRate) <= 100) {
    setMeta(db, CATALOG_FX_META, String(Number(p.catalogFxRate)))
  }
  if (p.priceMatch === 'exact' || p.priceMatch === 'fuzzy') setMeta(db, CATALOG_MATCH_META, p.priceMatch)
  return Object.assign({ ok: true }, catalogConfig(db))
}

/**
 * 算价附加参数（直接透传给 pricing.computeCostAt 的 opts）。
 * 关闭目录时返回 undefined —— 让 computeCostAt 走原来的内置表路径，行为零变化。
 */
export function catalogOpts(db) {
  const cfg = catalogConfig(db)
  if (!cfg.enabled) return undefined
  return {
    catalog: (np, model) => catalogEntryFor(np, model, { mode: cfg.match, fx: cfg.fx }),
  }
}

/** 目录状态（管理端 / protocol 回显用） */
export function catalogInfo(db) {
  const cfg = catalogConfig(db)
  const providers = catalogProviders()
  return {
    enabled: cfg.enabled,
    fxRate: cfg.fx,
    match: cfg.match,
    meta: CATALOG_META,
    fingerprint: catalogFingerprint(),
    providerCount: providers.length,
    modelCount: providers.reduce((a, p) => a + p.count, 0),
    providers,
  }
}
