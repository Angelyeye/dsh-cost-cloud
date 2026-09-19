// ============================================================
// dsh-cost-cloud —— 官方价格同步（云端侧封套）
//
// 与插件侧共用 src/price-sync.js（**逐字节副本**，见 scripts/check-pricing-sync.js）：
// 抓取官方定价页 → 解析出各模型峰价 → 构建新的「计费时代」→ 注入 pricing.js。
//
// 云端自己的职责：
//   · 时代清单持久化在 DB meta（pricing_eras），重启后自动重新注入；
//   · 核对结果（pricing_last_check）与定价页地址（pricing_sync_url）也存 meta；
//   · 应用新价只影响**之后**入库/重算的记录（era.since = 应用时刻），历史口径不回改。
//
// 云端是定价的权威方：这里改的是「官方牌价表」，与适配器上报的 cost 无关；
// 上报 cost 仍然只用于计算口径漂移（cost_drift）。
// ============================================================
import { getMeta, setMeta } from './db.js'
import { setSyncedEras, getSyncedEras, eraAt } from './pricing.js'
import { fetchOfficialPrices, buildSyncedEra, diffAgainstEra } from './price-sync.js'

export const PRICING_ERAS_META = 'pricing_eras'
export const PRICING_LAST_CHECK_META = 'pricing_last_check'
export const PRICING_SYNC_URL_META = 'pricing_sync_url'

export const DEFAULT_PRICING_SYNC_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** 读取 meta 里的同步时代（坏 JSON/非数组一律当空，不阻断启动） */
export function loadPricingEras(db) {
  const raw = getMeta(db, PRICING_ERAS_META, '')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

/** 启动时把同步时代注入 pricing.js（进程内生效，供算价/快照使用） */
export function applyPricingEras(db) {
  const eras = loadPricingEras(db)
  setSyncedEras(eras)
  return eras
}

export function pricingSyncUrl(db) {
  return getMeta(db, PRICING_SYNC_URL_META, DEFAULT_PRICING_SYNC_URL)
}

export function setPricingSyncUrl(db, url) {
  const u = String(url || '').trim()
  if (!/^https:\/\/\S+$/i.test(u)) return { ok: false, error: '定价页地址必须是 https 链接' }
  setMeta(db, PRICING_SYNC_URL_META, u)
  return { ok: true, url: u }
}

export function lastPricingCheck(db) {
  const raw = getMeta(db, PRICING_LAST_CHECK_META, '')
  if (!raw) return null
  try { return JSON.parse(raw) } catch (e) { return null }
}

/** 价格/目录状态（管理端与 /api/v1/protocol 回显用） */
export function pricingStatus(db) {
  const cur = eraAt(Date.now())
  return {
    source: 'src/pricing.js + src/price-sync.js（与插件同源）',
    url: pricingSyncUrl(db),
    currentEra: cur.id,
    eraLabel: cur.label,
    eraSynced: cur.synced === true,
    lastCheck: lastPricingCheck(db),
    syncedEras: getSyncedEras().map((e) => ({ id: e.id, label: e.label, since: e.since, models: e.models, routes: e.routes || {} })),
  }
}

/**
 * 抓取并核对官方价（管理端触发）。
 * @param {object} db
 * @param {{apply?:boolean, url?:string, fetchFn?:typeof fetch, now?:number}} [opts]
 * @returns {Promise<object>} 摘要（ok/diff/applied/models/error），绝不抛错
 */
export async function runPricingSync(db, opts) {
  const o = opts || {}
  const url = String(o.url || pricingSyncUrl(db))
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const out = { ok: false, applied: false, url, checkedAt: now, diff: '', era: '', models: [], error: '', currentEra: '' }
  try {
    const fetched = await fetchOfficialPrices(url, o.fetchFn)
    out.models = fetched.parsed.order.map((name) => {
      const m = fetched.parsed.models[name]
      return { model: name, input: m.peak.input, output: m.peak.output, cacheRead: m.peak.cacheRead, offpeakInput: m.offpeak.input, offpeakOutput: m.offpeak.output }
    })
    const cur = eraAt(now)
    out.currentEra = cur.id
    const diff = diffAgainstEra(fetched.parsed, cur)
    out.diff = diff || ''
    out.ok = true
    if (o.apply === true) {
      if (!diff) {
        out.note = '官方价与当前生效价一致，无需更新'
      } else {
        const era = buildSyncedEra(fetched.parsed, now)
        const eras = loadPricingEras(db).filter((e) => e && e.id !== era.id).concat([era])
        setMeta(db, PRICING_ERAS_META, JSON.stringify(eras))
        setSyncedEras(eras)
        out.applied = true
        out.era = era.id
      }
    } else if (o.apply !== true) {
      out.note = '仅核对，未应用（传 apply: true 才生效）'
    }
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  // 核对结果无论如何都记一笔：面板要能看到「上次核对什么时候、成没成」
  try {
    setMeta(db, PRICING_LAST_CHECK_META, JSON.stringify({
      at: out.checkedAt, ok: out.ok === true, diff: out.diff, applied: out.applied, url, error: out.error.slice(0, 300),
    }))
  } catch (e) { /* meta 写失败不影响本次结果返回 */ }
  return out
}

/** 手工清空同步时代（回退到内置价格表） */
export function clearPricingEras(db) {
  setMeta(db, PRICING_ERAS_META, '[]')
  setSyncedEras([])
  return { ok: true, syncedEras: 0 }
}
