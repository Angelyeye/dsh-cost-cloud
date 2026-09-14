// ============================================================
// dsh-cost-cloud —— 去重键（与 docs/INGEST-API.md §6 一一对应）
//
// 同一个逻辑记录无论上报多少次，都必须得到完全相同的 dedupKey，
// 服务端据此幂等。canonical 串刻意不用 JSON：不同语言对空格、浮点、
// Unicode 转义的处理不一致，会让同一记录算出不同哈希。
//
// 变更本文件即变更对外契约 —— 必须同时更新文档、示例与契约测试。
// ============================================================
import { createHash } from 'node:crypto'

/** 字段分隔符（Unit Separator）；选择它是因为正常文本里绝不会出现 */
export const SEP = '\u001f'

/** 允许的 source 形态（契约 §1） */
export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 每条明细 `meta` 的体积上限（字节，序列化后） */
export const META_MAX_BYTES = 1024

export function toStr(v) {
  return v === undefined || v === null ? '' : String(v).trim()
}

export function toInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/**
 * 费用的规范十进制形式：四舍五入到 6 位小数后取「最短往返」表示。
 * 0 / 0.016248 / 1.5 / 123.456789 —— 与 Java Double.toString、
 * Go strconv.FormatFloat(v,'f',-1,64)、Rust f64 Display 形态一致。
 */
export function cost6(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  if (n === 0) return '0'
  const r = Math.round(n * 1e6) / 1e6
  return String(r)
}

/** 归一化 token 桶：整数、非有限值按 0 */
export function normTokens(t) {
  const o = t && typeof t === 'object' ? t : {}
  return {
    input: toInt(o.input),
    output: toInt(o.output),
    cacheRead: toInt(o.cacheRead),
    cacheWrite: toInt(o.cacheWrite),
    reasoning: toInt(o.reasoning),
  }
}

/** 兼容两种入参：上报原始记录用 `cost`，服务端规范化记录用 `deviceCost`
 *  （null 与缺失一律按 0，保证两侧算出同一个键） */
function costOf(r) {
  if (r && r.cost !== undefined && r.cost !== null) return r.cost
  if (r && r.deviceCost !== undefined && r.deviceCost !== null) return r.deviceCost
  return 0
}

/**
 * 明细记录的 canonical 串（契约 §6.1）。
 * @param {object} r - 明细记录（原始上报对象或服务端规范化对象均可）
 * @param {{resetEpoch?:number}} [opts]
 */
export function detailCanonical(r, opts) {
  const t = normTokens(r && r.tokens)
  const resetEpoch = toInt(opts && opts.resetEpoch)
  return [
    'detail',
    toInt(resetEpoch),
    toInt(r && r.ts),
    toStr(r && r.provider).toLowerCase(),
    toStr(r && r.model).toLowerCase(),
    toStr(r && r.sessionId),
    toStr(r && r.purpose),
    t.input, t.output, t.cacheRead, t.cacheWrite, t.reasoning,
    cost6(costOf(r)),
  ].join(SEP)
}

/**
 * rollup 快照的 canonical 串（契约 §6.1）：只按 dayKey + provider + model 区分。
 *
 * ⚠️ 与明细不同，快照的**可变指标**（calls / tokens / cost）不参与身份：
 * 快照会随着同一天继续使用而增长，若把 metrics 计入键，每次增长都会插入新行，
 * 造成重复计数。服务端对同一 key 的行做 max() 单调合并。
 * @param {object} s - 快照
 */
export function rollupCanonical(s) {
  const day = toStr(s && s.dayKey)
  const sub = (s && (s.subscription === true || s.subscription === 1)) ? '1' : '0'
  return ['rollup:' + day, sub, toStr(s && s.provider).toLowerCase(), toStr(s && s.model).toLowerCase()].join(SEP)
}

export function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex')
}

export function dedupKeyOfDetail(r, opts) {
  return sha256hex(detailCanonical(r, opts))
}

export function dedupKeyOfRollup(s) {
  return sha256hex(rollupCanonical(s))
}

/** 契约测试向量（文档 §6.2 表格里的那一行） */
export const CONTRACT_VECTOR = {
  record: {
    ts: 1789392645019,
    provider: 'DeepSeek-Official',
    model: 'DeepSeek-V4.1-Flash',
    sessionId: ' s1 ',
    purpose: null,
    tokens: { input: 3850, output: 2880, cacheRead: 43904 },
    cost: 0.01624808,
  },
  resetEpoch: 0,
  canonical: 'detail\u001f0\u001f1789392645019\u001fdeepseek-official\u001fdeepseek-v4.1-flash\u001fs1\u001f\u001f3850\u001f2880\u001f43904\u001f0\u001f0\u001f0.016248',
}
