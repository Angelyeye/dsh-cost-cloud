// ============================================================
// dsh-cost-cloud —— 多厂商价格目录（云端侧封套）
//
// 与插件侧共用 src/vendor-catalog.js（**逐字节副本**）+ src/docs/provider-pricing.json。
// 目录数据为 USD / 1M tokens，云端算价（computeCostAt）需要人民币口径，
// 因此这里按 meta 里配置的汇率（catalog_fx_rate，默认跟随 vendor-catalog 的
// CATALOG_FX_DEFAULT；v1.11.0 起为 6.67）折算。
//
// 用途：**与插件侧口径一致** —— 内置价格表（DeepSeek 官方价）之外的模型
// （OpenAI / Anthropic / Gemini / Qwen 等）在插件侧按目录价计费且标为「精确」，
// 云端若只看兜底价就会把它们全部算成「估算」，两边 cost_drift 会长期虚高。
//
// 开关：meta `catalog_enabled`（默认 '1' 开启）。关掉后云端退回纯内置表口径。
// ============================================================
import { getMeta, setMeta } from './db.js'
import { catalogEntryFor, catalogFingerprint, catalogProviders, CATALOG_META, CATALOG_FX_DEFAULT, CATALOG_FX_LEGACY_DEFAULT, catalogFastTiers } from './vendor-catalog.js'

export const CATALOG_ENABLED_META = 'catalog_enabled'
export const CATALOG_FX_META = 'catalog_fx_rate'
export const CATALOG_MATCH_META = 'catalog_match'

/**
 * 目录计价配置（默认开启、汇率跟随 CATALOG_FX_DEFAULT、宽松匹配——与插件默认一致）。
 *
 * v1.11.0 迁移：库里若仍存着历史默认 7.2（早期版本写入），说明管理员从未改过，
 * 升级后跟随新默认 6.67；管理员显式设置的其他值原样保留。
 */
export function catalogConfig(db) {
  const enabled = getMeta(db, CATALOG_ENABLED_META, '1') !== '0'
  const storedRaw = getMeta(db, CATALOG_FX_META, '')
  const stored = Number(storedRaw)
  let fx = Number.isFinite(stored) && stored >= 0.1 && stored <= 100 ? stored : CATALOG_FX_DEFAULT
  if (Number.isFinite(stored) && Math.abs(stored - CATALOG_FX_LEGACY_DEFAULT) < 1e-9
    && Math.abs(CATALOG_FX_DEFAULT - CATALOG_FX_LEGACY_DEFAULT) > 1e-9) {
    fx = CATALOG_FX_DEFAULT
    try { setMeta(db, CATALOG_FX_META, String(CATALOG_FX_DEFAULT)) } catch { /* 只读库不阻断 */ }
  }
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
    // v1.11.0：透传档位与用量，云端重算才能与插件侧的 Fast 价 / 长上下文分档一致
    catalog: (np, model, extra) => catalogEntryFor(np, model, {
      mode: cfg.match,
      fx: cfg.fx,
      serviceTier: extra && extra.serviceTier,
      tokens: extra && extra.tokens,
    }),
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
    // v1.11.0：登记了 Fast 档价的模型数（与插件侧同源数据算出，便于核对）
    fastTierModelCount: catalogFastTiers(cfg.fx).models.length,
  }
}
