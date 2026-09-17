// ============================================================
// dsh-cost-cloud —— 时间口径（北京时间 UTC+8）
//
// 与插件 store.js / index.js 的 dayKey() 完全一致：全链路固定北京时间分桶，
// 不随服务器宿主时区或客户端时区变化，保证多机数字可加。
// ============================================================

const DAY_MS = 86400000
export const BJ_OFFSET_MS = 28800000 // UTC+8

function pad2(n) { return n < 10 ? '0' + n : '' + n }

/** 北京时间日期键 YYYY-MM-DD */
export function dayKey(ts) {
  const d = new Date(Number(ts) + BJ_OFFSET_MS)
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

/** 北京时间月份键 YYYY-MM */
export function monthKey(ts) {
  return dayKey(ts).slice(0, 7)
}

/** 北京时间当日 00:00 对应的 epoch ms */
export function dayStartMs(ts) {
  return Math.floor((Number(ts) + BJ_OFFSET_MS) / DAY_MS) * DAY_MS - BJ_OFFSET_MS
}

export function isValidDayKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z'))
}

export function dayKeyToMs(dayKeyStr) {
  const y = Number(dayKeyStr.slice(0, 4))
  const m = Number(dayKeyStr.slice(5, 7))
  const d = Number(dayKeyStr.slice(8, 10))
  return Date.UTC(y, m - 1, d) - BJ_OFFSET_MS
}

/** 两个 dayKey 之间（含端点）的日期序列 */
export function enumerateDays(startKey, endKey, maxDays = 730) {
  const out = []
  let t = dayKeyToMs(startKey)
  const end = dayKeyToMs(endKey)
  if (!Number.isFinite(t) || !Number.isFinite(end) || end < t) return out
  if ((end - t) / DAY_MS > maxDays - 1) t = end - (maxDays - 1) * DAY_MS
  while (t <= end && out.length < maxDays) {
    out.push(dayKey(t))
    t += DAY_MS
  }
  return out
}

/**
 * 把 `range` 解析为 [fromMs, toMs) 与用于展示的标签。
 * 支持的 range：today / 7d / 30d / month（本月）/ year（本年）/ all / 自定义 from&to
 * @param {object} q - 查询参数（range/from/to）
 * @param {number} now - 当前时刻
 */
export function resolveRange(q, now) {
  const t = Number.isFinite(now) ? now : Date.now()
  const range = String((q && q.range) || '7d')
  if (q && q.from) {
    const from = Number(q.from)
    const to = q.to ? Number(q.to) : t
    if (Number.isFinite(from)) return { range: 'custom', fromMs: from, toMs: to, label: '自定义区间' }
  }
  switch (range) {
    case 'today': return { range, fromMs: dayStartMs(t), toMs: t + 1, label: '今天' }
    case '7d': return { range, fromMs: t - 7 * DAY_MS, toMs: t + 1, label: '近 7 天' }
    case '30d': return { range, fromMs: t - 30 * DAY_MS, toMs: t + 1, label: '近 30 天' }
    case '90d': return { range, fromMs: t - 90 * DAY_MS, toMs: t + 1, label: '近 90 天' }
    case 'month': {
      const mk = monthKey(t)
      return { range, fromMs: dayKeyToMs(mk + '-01'), toMs: t + 1, label: '本月' }
    }
    case 'year': {
      const y = dayKey(t).slice(0, 4)
      return { range, fromMs: dayKeyToMs(y + '-01-01'), toMs: t + 1, label: '本年' }
    }
    case 'all':
    default:
      return { range: 'all', fromMs: 0, toMs: t + 1, label: '全部' }
  }
}
