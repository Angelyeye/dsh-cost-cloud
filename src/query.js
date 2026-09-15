// ============================================================
// dsh-cost-cloud —— 聚合查询（单一口径）
//
// 所有读接口共用这里的 SQL 构造，保证「概览 / 趋势 / 模型 / 设备 / 矩阵 / 记录」
// 六处数字彼此自洽（行合计 = 列合计 = 总合计）。
//
// 口径要点：
//   · 明细与 rollup 快照同表共存（kind 区分），聚合一条 SQL 完成
//   · 墓碑（tombstones）中的明细在所有聚合里被排除
//   · 时间归属：优先用明细 ts；快照的 ts 可能为 0，则回退到 day_key（北京正午）
//   · 按量（totalCost/tokens/calls）与订阅（sub*）分开统计
// ============================================================
import { dayKey, monthKey, dayKeyToMs, enumerateDays, resolveRange } from './time.js'

const DAY_MS = 86400000

export function r4(x) { return Math.round(Number(x) * 10000) / 10000 }
export function r6(x) { return Math.round(Number(x) * 1000000) / 1000000 }

function toStr(v) { return v === undefined || v === null ? '' : String(v).trim() }
function csvList(v) {
  if (Array.isArray(v)) return v.map((x) => toStr(x)).filter(Boolean)
  const s = toStr(v)
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []
}

/** 行的时间归属表达式：明细用 ts，快照回退到 day_key */
export const TS_EXPR = "CASE WHEN ts > 0 THEN ts ELSE (CAST(strftime('%s', day_key) AS INTEGER) * 1000 - 28800000 + 43200000) END"

/** 时间桶表达式 */
export function bucketExpr(bucket) {
  if (bucket === 'month') return "substr(day_key, 1, 7)"
  if (bucket === 'week') {
    return "(substr(day_key,1,4) || '-W' || substr('0' || ((CAST(strftime('%j', day_key) AS INTEGER) + 6) / 7), -2))"
  }
  return 'day_key'
}

/**
 * 构造 WHERE 子句与参数。
 * @param {object} p - { fromMs, toMs, devices, sources, excludeDevice, excludeSource, agentInstance }
 *
 * 过滤语义（互不干扰，可叠加）：
 *   · `devices` / `sources`        —— 白名单（IN）
 *   · `excludeDevice` / `excludeSource` —— 黑名单（<>）
 * 因此「排除本机设备」与「排除某来源」可以同时表达；
 * 需要**并集**（如「其他整机 + 本机上的其它 agent」）时用 overviewUnion。
 */
export function buildWhere(p) {
  const where = ['1=1']
  const params = []
  if (Number.isFinite(p.fromMs)) { where.push(TS_EXPR + ' >= ?'); params.push(p.fromMs) }
  if (Number.isFinite(p.toMs)) { where.push(TS_EXPR + ' < ?'); params.push(p.toMs) }
  const devices = csvList(p.devices)
  if (devices.length) { where.push('device_id IN (' + devices.map(() => '?').join(',') + ')'); params.push(...devices) }
  const sources = csvList(p.sources)
  if (sources.length) { where.push('source IN (' + sources.map(() => '?').join(',') + ')'); params.push(...sources) }
  const instances = csvList(p.agentInstance)
  if (instances.length) { where.push('agent_instance IN (' + instances.map(() => '?').join(',') + ')'); params.push(...instances) }
  if (p.excludeDevice) { where.push('device_id <> ?'); params.push(toStr(p.excludeDevice)) }
  if (p.excludeSource) { where.push('source <> ?'); params.push(toStr(p.excludeSource)) }
  // 只统计「未删除」的记录：明细被墓碑排除；快照不受墓碑影响（快照取代了被折叠的明细）
  where.push("NOT (kind = 'detail' AND EXISTS (SELECT 1 FROM tombstones t WHERE t.device_id = records.device_id AND t.source = records.source AND t.agent_instance = records.agent_instance AND t.dedup_key = records.dedup_key))")
  return { sql: where.join(' AND '), params }
}

const SELECT_METRICS = `
  COUNT(*) AS rows,
  SUM(calls) AS calls,
  SUM(CASE WHEN subscription = 0 THEN calls ELSE 0 END) AS real_calls,
  SUM(CASE WHEN subscription = 1 THEN calls ELSE 0 END) AS sub_calls,
  SUM(input + output + cache_read + cache_write + reasoning) AS tokens,
  SUM(CASE WHEN subscription = 0 THEN input + output + cache_read + cache_write + reasoning ELSE 0 END) AS real_tokens,
  SUM(CASE WHEN subscription = 1 THEN input + output + cache_read + cache_write + reasoning ELSE 0 END) AS sub_tokens,
  SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(reasoning) AS reasoning,
  SUM(cost) AS cost,
  SUM(CASE WHEN subscription = 0 THEN cost ELSE 0 END) AS real_cost,
  SUM(CASE WHEN subscription = 1 THEN cost ELSE 0 END) AS sub_cost,
  SUM(peak) AS peak, SUM(off) AS off, SUM(flat) AS flat,
  SUM(CASE WHEN cost_basis = 'estimated' THEN 1 ELSE 0 END) AS est_rows,
  SUM(CASE WHEN cost_recomputed > 0 THEN ABS(cost - cost_recomputed) ELSE 0 END) AS drift_abs`

function mapRow(r) {
  const o = r || {}
  const n = (k) => Number(o[k]) || 0
  return {
    rows: n('rows'),
    calls: n('calls'),
    realCalls: n('real_calls'),
    subCalls: n('sub_calls'),
    tokens: n('tokens'),
    realTokens: n('real_tokens'),
    subTokens: n('sub_tokens'),
    input: n('input'),
    output: n('output'),
    cacheRead: n('cache_read'),
    cacheWrite: n('cache_write'),
    reasoning: n('reasoning'),
    cost: n('cost'),
    realCost: n('real_cost'),
    subCost: n('sub_cost'),
    peak: n('peak'),
    off: n('off'),
    flat: n('flat'),
    estimatedRows: n('est_rows'),
    driftAbs: n('drift_abs'),
  }
}

/** 汇总卡片：今日 / 本月 / 全部（全部不受区间过滤，单列表） */
export function totalsUnfiltered(db) {
  const row = db.prepare('SELECT ' + SELECT_METRICS + ` FROM records WHERE NOT (kind = 'detail' AND EXISTS (
      SELECT 1 FROM tombstones t WHERE t.device_id = records.device_id AND t.source = records.source
        AND t.agent_instance = records.agent_instance AND t.dedup_key = records.dedup_key))`).get()
  const all = mapRow(row)
  const now = Date.now()
  const today = mapRow(db.prepare('SELECT ' + SELECT_METRICS + ' FROM records WHERE day_key = ? AND ' + aliveClause()).get(dayKey(now)))
  const month = mapRow(db.prepare('SELECT ' + SELECT_METRICS + ' FROM records WHERE month_key = ? AND ' + aliveClause()).get(monthKey(now)))
  const first = db.prepare('SELECT MIN(' + TS_EXPR + ') AS t FROM records').get()
  return {
    today: { realCost: r4(today.realCost), cost: r4(today.cost), calls: today.calls, tokens: today.tokens, subCost: r4(today.subCost) },
    month: { realCost: r4(month.realCost), cost: r4(month.cost), calls: month.calls, tokens: month.tokens, subCost: r4(month.subCost) },
    all: {
      realCost: r4(all.realCost), cost: r4(all.cost), calls: all.calls, tokens: all.tokens,
      subCost: r4(all.subCost), subCalls: all.subCalls, subTokens: all.subTokens,
      peak: r4(all.peak), off: r4(all.off), flat: r4(all.flat), driftAbs: r4(all.driftAbs),
    },
    firstTs: Number(first && first.t) || 0,
  }
}

/**
 * 概览三切片（今日 / 本月 / 全时段）——**带过滤条件**，插件形状聚合专用。
 *
 * 与 totalsUnfiltered 的区别：那张表在「仅云端」用在**全网**口径的概览上（今日/本月/
 * 总花费要跨设备可比），而插件形状聚合可能是「排除本机」或「并集」的一段，
 * 三切片必须落在同一过滤条件下，否则「仅云端 / 本机+云端」的金额卡会凭空变大。
 */
function totalsFiltered(db, params) {
  const w = buildWhere(params)
  // 日/月切片不带时间边界：注意必须传 null 而不是 0 —— buildWhere 用 Number.isFinite 判断，
  // 传 0 会生成 `ts < 0`（恒假），切片永远为空。
  const dayWhere = buildWhere(Object.assign({}, params, { fromMs: null, toMs: null }))
  const all = mapRow(db.prepare(`SELECT ${SELECT_METRICS} FROM records WHERE ${w.sql}`).get(...w.params))
  const now = Date.now()
  const today = mapRow(db.prepare(`SELECT ${SELECT_METRICS} FROM records WHERE ${dayWhere.sql} AND day_key = ?`).get(...dayWhere.params, dayKey(now)))
  const month = mapRow(db.prepare(`SELECT ${SELECT_METRICS} FROM records WHERE ${dayWhere.sql} AND month_key = ?`).get(...dayWhere.params, monthKey(now)))
  const slice = (x) => ({
    // real/sub 必须**互斥**（本地 buildDashboard 口径）：calls/tokens 只含按量，
    // 订阅另计 subCalls/subTokens —— 看板「API 请求次数」主值就是 calls + subCalls。
    real: r4(n0(x.realCost)), calls: n0(x.realCalls), tokens: n0(x.realTokens),
    sub: r4(n0(x.subCost)), subCalls: n0(x.subCalls), subTokens: n0(x.subTokens),
  })
  return { today: slice(today), month: slice(month), all: slice(all) }
}

function aliveClause(alias) {
  const a = alias ? alias + '.' : 'records.'
  return `NOT (kind = 'detail' AND EXISTS (SELECT 1 FROM tombstones t WHERE t.device_id = ${a}device_id AND t.source = ${a}source
          AND t.agent_instance = ${a}agent_instance AND t.dedup_key = ${a}dedup_key))`
}

/** 设备与来源清单（供筛选器与矩阵） */
export function listDimensions(db) {
  const devices = db.prepare(`SELECT d.id, d.name, d.name_locked, d.disabled, d.created_at, d.last_seen_at, d.last_ingest_at,
        (SELECT COUNT(*) FROM records r WHERE r.device_id = d.id) AS record_count,
        (SELECT SUM(r.cost) FROM records r WHERE r.device_id = d.id AND r.subscription = 0) AS cost,
        (SELECT COUNT(*) FROM sources s WHERE s.device_id = d.id) AS source_count
      FROM devices d ORDER BY cost DESC, d.name`).all().map((r) => ({
    id: String(r.id), name: String(r.name || r.id), nameLocked: Number(r.name_locked) === 1,
    disabled: Number(r.disabled) === 1, createdAt: Number(r.created_at) || 0,
    lastSeenAt: Number(r.last_seen_at) || 0, lastIngestAt: Number(r.last_ingest_at) || 0,
    recordCount: Number(r.record_count) || 0, cost: r4(Number(r.cost) || 0), sourceCount: Number(r.source_count) || 0,
  }))
  const sources = db.prepare(`SELECT s.device_id, s.source, s.agent_instance, s.display_name, s.agent_version, s.plugin_version,
        s.first_seen_at, s.last_ingest_at, s.clock_skew_ms, s.max_client_seq,
        (SELECT COUNT(*) FROM records r WHERE r.device_id = s.device_id AND r.source = s.source AND r.agent_instance = s.agent_instance) AS record_count,
        (SELECT SUM(r.cost) FROM records r WHERE r.device_id = s.device_id AND r.source = s.source AND r.agent_instance = s.agent_instance AND r.subscription = 0) AS cost
      FROM sources s ORDER BY cost DESC`).all().map((r) => ({
    deviceId: String(r.device_id), source: String(r.source), agentInstance: String(r.agent_instance || ''),
    displayName: String(r.display_name || r.source), agentVersion: String(r.agent_version || ''),
    pluginVersion: String(r.plugin_version || ''), firstSeenAt: Number(r.first_seen_at) || 0,
    lastIngestAt: Number(r.last_ingest_at) || 0, clockSkewMs: Number(r.clock_skew_ms) || 0,
    maxClientSeq: Number(r.max_client_seq) || 0, recordCount: Number(r.record_count) || 0,
    cost: r4(Number(r.cost) || 0),
  }))
  return { devices, sources }
}

/** 通用分组聚合 */
export function groups(db, params) {
  const keys = csvList(params.groupBy).length ? csvList(params.groupBy) : ['source']
  const allowed = {
    device: 'device_id',
    source: 'source',
    agentInstance: 'agent_instance',
    model: 'model',
    provider: 'provider',
    project: "CASE WHEN purpose = '' THEN '(未标注)' ELSE purpose END",
    day: 'day_key',
    month: "substr(day_key, 1, 7)",
    kind: 'kind',
  }
  const exprs = []
  const selects = []
  for (const k of keys) {
    const c = allowed[k]
    if (!c) throw new Error('unsupported groupBy key: ' + k)
    selects.push(c + ' AS g' + exprs.length)
    exprs.push(c)
  }
  const w = buildWhere(params)
  const sql = `SELECT ${selects.join(', ')}, ${SELECT_METRICS} FROM records WHERE ${w.sql} GROUP BY ${exprs.join(', ')} ORDER BY cost DESC`
  const rows = db.prepare(sql).all(...w.params)
  const out = rows.map((r) => {
    const key = {}
    for (let k = 0; k < exprs.length; k += 1) key[keys[k]] = String(r['g' + k] === null ? '' : r['g' + k])
    return Object.assign({ key }, mapRow(r))
  })
  return { ok: true, groupBy: keys, groups: out }
}

/**
 * 设备 × Agent 矩阵（行=设备，列=source，多实例合并为列内合计）
 * @returns {{rows, cols, totals, cells:object}}
 */
export function matrix(db, params) {
  const rowBy = params.row || 'device'
  const colBy = params.col || 'source'
  if (rowBy !== 'device' || (colBy !== 'source' && colBy !== 'model')) {
    throw new Error('matrix 仅支持 row=device,col=source|model')
  }
  const g = groups(db, Object.assign({}, params, { groupBy: ['device', 'source'] }))
  const dims = listDimensions(db)
  const nameOf = new Map(dims.devices.map((d) => [d.id, d.name]))
  const rowMap = new Map()
  const colSet = new Set()
  const cellMap = new Map()
  let total = 0
  const t = { calls: 0, tokens: 0, cost: 0, subCost: 0 }
  for (const item of g.groups) {
    const dev = item.key.device || '(未知设备)'
    const src = item.key.source || '(未知来源)'
    colSet.add(src)
    let row = rowMap.get(dev)
    if (!row) {
      row = { device: dev, name: nameOf.get(dev) || dev, calls: 0, tokens: 0, cost: 0, subCost: 0, cells: {} }
      rowMap.set(dev, row)
    }
    const add = (o) => { o.calls += item.calls; o.tokens += item.tokens; o.cost += item.cost; o.subCost += item.subCost }
    add(row)
    add(t)
    const cellKey = dev + '\u0000' + src
    const cell = cellMap.get(cellKey) || { device: dev, source: src, calls: 0, tokens: 0, cost: 0, subCost: 0 }
    add(cell)
    cellMap.set(cellKey, cell)
    total += item.cost
  }
  const rows = Array.from(rowMap.values()).map((r) => ({
    device: r.device, name: r.name,
    calls: r.calls, tokens: r.tokens, cost: r4(r.cost), subCost: r4(r.subCost),
    cells: colSet.has('__none__') ? {} : Object.fromEntries(Array.from(colSet).map((s) => {
      const c = cellMap.get(r.device + '\u0000' + s)
      return [s, c ? { calls: c.calls, tokens: c.tokens, cost: r4(c.cost), subCost: r4(c.subCost) } : { calls: 0, tokens: 0, cost: 0, subCost: 0 }]
    })),
  })).sort((a, b) => b.cost - a.cost)
  return {
    ok: true,
    row: rowBy, col: colBy, cols: Array.from(colSet).sort(),
    rows,
    totals: { calls: t.calls, tokens: t.tokens, cost: r4(t.cost), subCost: r4(t.subCost) },
    grandTotal: r4(total),
    deviceNames: Object.fromEntries(dims.devices.map((d) => [d.id, d.name])),
  }
}

/**
 * 合并多份 overview 结果（用于「本机+云端」这类**并集**口径）。
 *
 * 场景：插件要把「其他整机」与「本机上的其它 agent」并起来，
 * 而这两块的过滤条件互斥（一个要排除本机设备、另一个要只要本机设备的非 dsh 来源），
 * 单次查询无法表达。服务端在这里把各部分相加，返回一份口径一致的合并结果。
 * @param {Array} parts - 每项的 params（与 overview 同形）
 */
export function overviewUnion(db, parts) {
  const list = (parts || []).filter(Boolean)
  if (list.length === 1) return overview(db, list[0])
  const outs = list.map((p) => overview(db, p))
  const base = outs[0]
  const acc = {
    ok: true,
    range: base.range,
    fromMs: base.fromMs,
    toMs: base.toMs,
    union: true,
    parts: list.map((p) => ({
      devices: csvList(p.devices), sources: csvList(p.sources),
      excludeDevice: toStr(p.excludeDevice), excludeSource: toStr(p.excludeSource),
    })),
    devices: [],
    sources: [],
    all: null,
    today: null,
    month: null,
    firstTs: 0,
    summary: {},
  }
  const devMap = new Map()
  const srcMap = new Map()
  for (const o of outs) {
    for (const d of o.devices) {
      const cur = devMap.get(d.device) || { device: d.device, name: d.name, cost: 0, calls: 0, tokens: 0, sources: new Set() }
      cur.cost += d.cost; cur.calls += d.calls; cur.tokens += d.tokens
      for (const s of d.sources) cur.sources.add(s)
      devMap.set(d.device, cur)
    }
    for (const s of o.sources) {
      const cur = srcMap.get(s.source) || { source: s.source, cost: 0, calls: 0, tokens: 0, devices: new Set() }
      cur.cost += s.cost; cur.calls += s.calls; cur.tokens += s.tokens
      for (const d of s.devices) cur.devices.add(d)
      srcMap.set(s.source, cur)
    }
    acc.all = addSliceLocal(acc.all, o.all)
    acc.today = addSliceLocal(acc.today, o.today)
    acc.month = addSliceLocal(acc.month, o.month)
    if (o.firstTs && (!acc.firstTs || o.firstTs < acc.firstTs)) acc.firstTs = o.firstTs
    for (const k of Object.keys(o.summary || {})) {
      acc.summary[k] = (acc.summary[k] || 0) + (Number(o.summary[k]) || 0)
    }
  }
  acc.summary.realCost = r4(acc.summary.realCost)
  acc.summary.subEquivalent = r4(acc.summary.subEquivalent)
  acc.summary.cost = r4(acc.summary.cost)
  acc.summary.peakCost = r4(acc.summary.peakCost)
  acc.summary.offCost = r4(acc.summary.offCost)
  acc.summary.flatCost = r4(acc.summary.flatCost)
  acc.summary.driftAbs = r4(acc.summary.driftAbs)
  acc.devices = Array.from(devMap.values()).map((d) => ({
    device: d.device, name: d.name, cost: r4(d.cost), calls: d.calls, tokens: d.tokens,
    sources: Array.from(d.sources).sort(),
  })).sort((a, b) => b.cost - a.cost)
  acc.sources = Array.from(srcMap.values()).map((s) => ({
    source: s.source, cost: r4(s.cost), calls: s.calls, tokens: s.tokens, devices: Array.from(s.devices).sort(),
  })).sort((a, b) => b.cost - a.cost)
  return acc
}

function addSliceLocal(a, b) {
  const x = a || { real: 0, calls: 0, tokens: 0, sub: 0, subCalls: 0, subTokens: 0 }
  const y = b || {}
  return {
    real: r4((x.real || 0) + (y.real || 0)),
    calls: (x.calls || 0) + (y.calls || 0),
    tokens: (x.tokens || 0) + (y.tokens || 0),
    sub: r4((x.sub || 0) + (y.sub || 0)),
    subCalls: (x.subCalls || 0) + (y.subCalls || 0),
    subTokens: (x.subTokens || 0) + (y.subTokens || 0),
  }
}

/**
 * 插件形状聚合的**并集**（「本机+云端」= ① 其他整机 ② 本机上的其它 agent）：
 * 逐部分算 pluginView 后相加，口径与 overviewUnion 一致。
 * 白天/分模型序列按日期与模型键合并，最近记录按时间倒序拼接去重（保留 20 条）。
 */
export function pluginViewUnion(db, parts) {
  const list = (parts || []).filter(Boolean)
  if (list.length === 1) return pluginView(db, list[0])
  const outs = list.map((p) => pluginView(db, p))
  const base = outs[0]
  const acc = {
    ok: true, source: 'cloud', union: true, days: base.days,
    parts: list.map((p) => ({
      devices: csvList(p.devices), sources: csvList(p.sources),
      excludeDevice: toStr(p.excludeDevice), excludeSource: toStr(p.excludeSource),
    })),
    today: null, month: null, all: null,
    byDay: [], byModel: [], byModelDay: [], recent: [],
    devices: [], sources: [], asOf: Date.now(),
    range: base.range,
  }
  const dayMap = new Map()
  const modelMap = new Map()
  const modelDayMap = new Map()
  const recentSeen = new Set()
  const devMap = new Map()
  const srcMap = new Map()
  for (const o of outs) {
    acc.today = addSliceLocal(acc.today, o.today)
    acc.month = addSliceLocal(acc.month, o.month)
    acc.all = addSliceLocal(acc.all, o.all)
    for (const d of o.byDay || []) {
      const cur = dayMap.get(d.date) || { date: d.date, label: d.label, peak: 0, off: 0, flat: 0, calls: 0, tokens: 0, cost: 0 }
      cur.peak += d.peak || 0; cur.off += d.off || 0; cur.flat += d.flat || 0
      cur.calls += d.calls || 0; cur.tokens += d.tokens || 0; cur.cost += d.cost || 0
      dayMap.set(d.date, cur)
    }
    for (const m of o.byModel || []) {
      const cur = modelMap.get(m.model) || { model: m.model, subscription: !!m.subscription, estimated: !!m.estimated, calls: 0, tokens: 0, cost: 0 }
      cur.calls += m.calls || 0; cur.tokens += m.tokens || 0; cur.cost += m.cost || 0
      cur.subscription = cur.subscription && !!m.subscription
      cur.estimated = cur.estimated || !!m.estimated
      modelMap.set(m.model, cur)
    }
    for (const m of o.byModelDay || []) {
      const cur = modelDayMap.get(m.model) || { model: m.model, subscription: !!m.subscription, estimated: !!m.estimated, days: new Map() }
      for (const d of m.days || []) {
        const cell = cur.days.get(d.date) || { date: d.date, label: d.label, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
        cell.calls += d.calls || 0; cell.tokens += d.tokens || 0; cell.input += d.input || 0; cell.output += d.output || 0
        cell.cacheRead += d.cacheRead || 0; cell.cacheWrite += d.cacheWrite || 0; cell.cost += d.cost || 0
        cur.days.set(d.date, cell)
      }
      modelDayMap.set(m.model, cur)
    }
    for (const r of o.recent || []) {
      const key = [r.ts, r.device, r.sessionId, r.model, r.calls, r.cost].join('|')
      if (recentSeen.has(key)) continue
      recentSeen.add(key)
      acc.recent.push(r)
    }
    for (const d of o.devices || []) {
      const cur = devMap.get(d.device) || { device: d.device, name: d.name, cost: 0, calls: 0, tokens: 0, sources: new Set() }
      cur.cost += d.cost || 0; cur.calls += d.calls || 0; cur.tokens += d.tokens || 0
      for (const s of d.sources || []) cur.sources.add(s)
      devMap.set(d.device, cur)
    }
    for (const s of o.sources || []) {
      const cur = srcMap.get(s.source) || { source: s.source, cost: 0, calls: 0, tokens: 0, devices: new Set() }
      cur.cost += s.cost || 0; cur.calls += s.calls || 0; cur.tokens += s.tokens || 0
      for (const d of s.devices || []) cur.devices.add(d)
      srcMap.set(s.source, cur)
    }
  }
  const dates = Array.from(dayMap.keys()).sort()
  acc.byDay = dates.map((d) => {
    const x = dayMap.get(d)
    return { date: d, label: x.label, peak: r4(x.peak), off: r4(x.off), flat: r4(x.flat), calls: x.calls, tokens: x.tokens, cost: r4(x.cost) }
  })
  acc.byModel = Array.from(modelMap.values())
    .map((m) => ({ model: m.model, subscription: m.subscription, estimated: m.estimated, calls: m.calls, tokens: m.tokens, cost: r4(m.cost) }))
    .sort((a, b) => b.cost - a.cost)
  acc.byModelDay = Array.from(modelDayMap.values()).map((m) => ({
    model: m.model, subscription: m.subscription, estimated: m.estimated,
    days: dates.map((d) => {
      const c = m.days.get(d)
      if (!c) return { date: d, label: (dayMap.get(d) || {}).label || d, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      return Object.assign({}, c, { cost: r4(c.cost) })
    }),
  }))
  acc.recent = acc.recent.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20)
  acc.devices = Array.from(devMap.values()).map((d) => ({
    device: d.device, name: d.name, cost: r4(d.cost), calls: d.calls, tokens: d.tokens, sources: Array.from(d.sources).sort(),
  })).sort((a, b) => b.cost - a.cost)
  acc.sources = Array.from(srcMap.values()).map((s) => ({
    source: s.source, cost: r4(s.cost), calls: s.calls, tokens: s.tokens, devices: Array.from(s.devices).sort(),
  })).sort((a, b) => b.cost - a.cost)
  return acc
}

/** 概览（与插件 buildDashboard 字段对齐，便于插件三态视图直接消费） */
export function overview(db, params) {
  const w = buildWhere(params)
  const row = mapRow(db.prepare(`SELECT ${SELECT_METRICS} FROM records WHERE ${w.sql}`).get(...w.params))
  const now = Date.now()
  const totals = totalsUnfiltered(db)
  const g = groups(db, Object.assign({}, params, { groupBy: ['device', 'source'] }))
  const dims = listDimensions(db)
  const nameOf = new Map(dims.devices.map((d) => [d.id, d.name]))
  const devMap = new Map()
  const srcMap = new Map()
  for (const item of g.groups) {
    const dev = item.key.device || ''
    const src = item.key.source || ''
    let dv = devMap.get(dev)
    if (!dv) { dv = { device: dev, name: nameOf.get(dev) || dev, cost: 0, calls: 0, tokens: 0, sources: new Set() }; devMap.set(dev, dv) }
    dv.cost += item.cost; dv.calls += item.calls; dv.tokens += item.tokens; dv.sources.add(src)
    let sv = srcMap.get(src)
    if (!sv) { sv = { source: src, cost: 0, calls: 0, tokens: 0, devices: new Set() }; srcMap.set(src, sv) }
    sv.cost += item.cost; sv.calls += item.calls; sv.tokens += item.tokens; sv.devices.add(dev)
  }
  return {
    ok: true,
    range: params.range || '7d',
    fromMs: params.fromMs, toMs: params.toMs,
    excludedDevice: params.excludeDevice || '',
    devices: Array.from(devMap.values()).map((d) => ({
      device: d.device, name: d.name, cost: r4(d.cost), calls: d.calls, tokens: d.tokens,
      sources: Array.from(d.sources).sort(),
    })).sort((a, b) => b.cost - a.cost),
    sources: Array.from(srcMap.values()).map((s) => ({
      source: s.source, cost: r4(s.cost), calls: s.calls, tokens: s.tokens, devices: Array.from(s.devices).sort(),
    })).sort((a, b) => b.cost - a.cost),
    all: totals.all,
    today: totals.today,
    month: totals.month,
    firstTs: totals.firstTs,
    summary: {
      realCost: r4(n0(row.realCost)), realCalls: row.realCalls, realTokens: row.realTokens,
      subEquivalent: r4(n0(row.subCost)), subCalls: row.subCalls, subTokens: row.subTokens,
      cost: r4(n0(row.cost)), calls: row.calls, tokens: row.tokens,
      peakCost: r4(n0(row.peak)), offCost: r4(n0(row.off)), flatCost: r4(n0(row.flat)),
      driftAbs: r4(n0(row.driftAbs)), estimatedRows: row.estimatedRows,
      input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, reasoning: row.reasoning,
    },
  }
}
function n0(x) { return Number(x) || 0 }

/** 插件侧云端口径（字段名与本地 buildDashboard 完全一致，便于相加） */
export function pluginView(db, params) {
  const w = buildWhere(params)
  const days = Number.isFinite(Number(params.days)) && Number(params.days) > 0 ? Math.floor(Number(params.days)) : 7
  const now = Date.now()
  const cutoff = days > 0 ? now - days * DAY_MS : 0
  // range=all（或 days<=0）时按**数据实际起点**铺日期轴，让「全部」在云端视图里也是全部
  const allTime = days <= 0 || params.range === 'all'
  const firstRow = db.prepare(`SELECT MIN(${TS_EXPR}) AS t FROM records WHERE ${w.sql}`).get(...w.params)
  const firstTs = Number(firstRow && firstRow.t) || 0
  const startKey = dayKey(allTime && firstTs ? firstTs : cutoff)
  const endKey = dayKey(now)
  const dates = enumerateDays(startKey, endKey)

  const tot = mapRow(db.prepare(`SELECT ${SELECT_METRICS} FROM records WHERE ${w.sql}`).get(...w.params))
  const dayRows = db.prepare(`SELECT day_key, SUM(CASE WHEN subscription = 0 THEN cost ELSE 0 END) AS real_cost,
      SUM(peak) AS peak, SUM(off) AS off, SUM(flat) AS flat, SUM(calls) AS calls,
      SUM(input+output+cache_read+cache_write+reasoning) AS tokens
      FROM records WHERE ${w.sql} GROUP BY day_key`).all(...w.params)
  const dayMap = new Map(dayRows.map((r) => [String(r.day_key), r]))
  const modelRows = db.prepare(`SELECT provider, model, subscription, SUM(calls) AS calls,
      SUM(input+output+cache_read+cache_write+reasoning) AS tokens, SUM(cost) AS cost,
      SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
      SUM(reasoning) AS reasoning, SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS est_rows
      FROM records WHERE ${w.sql} GROUP BY provider, model, subscription ORDER BY cost DESC`).all(...w.params)
  const modelDayRows = db.prepare(`SELECT provider, model, day_key, SUM(calls) AS calls,
      SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
      SUM(reasoning) AS reasoning, SUM(cost) AS cost
      FROM records WHERE ${w.sql} GROUP BY provider, model, day_key`).all(...w.params)
  const modelDayMap = new Map(modelDayRows.map((r) => [String(r.provider) + '/' + String(r.model) + '/' + String(r.day_key), r]))
  const recentRows = db.prepare(`SELECT device_id, source, agent_instance, kind, ts, day_key, provider, model, session_id, purpose,
      input, output, cache_read, cache_write, reasoning, calls, cost, cost_basis, subscription, estimated, period
      FROM records WHERE ${w.sql} ORDER BY ts DESC, id DESC LIMIT 20`).all(...w.params)
  const dims = listDimensions(db)
  const nameOf = new Map(dims.devices.map((d) => [d.id, d.name]))

  const byModel = modelRows.map((r) => ({
    model: String(r.provider) + '/' + String(r.model),
    subscription: Number(r.subscription) === 1,
    estimated: Number(r.est_rows) > 0,
    calls: Number(r.calls) || 0,
    tokens: Number(r.tokens) || 0,
    cost: r4(Number(r.cost) || 0),
  }))
  const byModelDay = modelRows.map((r) => {
    const key = String(r.provider) + '/' + String(r.model)
    return {
      model: key, subscription: Number(r.subscription) === 1, estimated: Number(r.est_rows) > 0,
      days: dates.map((d) => {
        const m = modelDayMap.get(String(r.provider) + '/' + String(r.model) + '/' + d)
        return {
          date: d, label: d.slice(5).replace('-', '/'),
          calls: m ? Number(m.calls) || 0 : 0,
          tokens: m ? (Number(m.input) + Number(m.output) + Number(m.cache_read) + Number(m.cache_write) + Number(m.reasoning)) : 0,
          input: m ? Number(m.input) || 0 : 0, output: m ? Number(m.output) || 0 : 0,
          cacheRead: m ? Number(m.cache_read) || 0 : 0, cacheWrite: m ? Number(m.cache_write) || 0 : 0,
          cost: m ? r4(Number(m.cost) || 0) : 0,
        }
      }),
    }
  })
  const real = { cost: 0, calls: 0, tokens: 0 }
  const sub = { cost: 0, calls: 0, tokens: 0 }
  for (const m of byModel) {
    if (m.subscription) { sub.cost += m.cost; sub.calls += m.calls; sub.tokens += m.tokens }
    else { real.cost += m.cost; real.calls += m.calls; real.tokens += m.tokens }
  }
  // 今日 / 本月 / 全时段（北京日历）：与本地 buildDashboard 同口径、**同过滤条件**，
  // 便于三态视图直接相加（此前用 totalsUnfiltered 会绕过 excludeDevice 导致相加偏大）
  const totals = totalsFiltered(db, params)
  const scopeTot = mapRow(db.prepare(`SELECT ${SELECT_METRICS} FROM records WHERE ${w.sql}`).get(...w.params))
  return {
    ok: true,
    days: days,
    source: 'cloud',
    realCost: totals.all.real, realCalls: totals.all.calls, realTokens: totals.all.tokens,
    subEquivalent: totals.all.sub, subCalls: totals.all.subCalls, subTokens: totals.all.subTokens,
    peakCost: r4(n0(scopeTot.peak)), offCost: r4(n0(scopeTot.off)), flatCost: r4(n0(scopeTot.flat)),
    today: totals.today,
    month: totals.month,
    all: totals.all,
    byDay: dates.map((d) => {
      const r = dayMap.get(d)
      return {
        date: d, label: d.slice(5).replace('-', '/'),
        peak: r ? r4(Number(r.peak) || 0) : 0,
        off: r ? r4(Number(r.off) || 0) : 0,
        flat: r ? r4(Number(r.flat) || 0) : 0,
        calls: r ? Number(r.calls) || 0 : 0,
        tokens: r ? Number(r.tokens) || 0 : 0,
        cost: r ? r4(Number(r.peak) + Number(r.off) + Number(r.flat)) : 0,
      }
    }),
    byModel, byModelDay,
    recent: recentRows.map((r) => ({
      ts: Number(r.ts) || 0, date: String(r.day_key), device: String(r.device_id),
      deviceName: nameOf.get(String(r.device_id)) || String(r.device_id),
      source: String(r.source), agentInstance: String(r.agent_instance || ''),
      kind: String(r.kind), provider: String(r.provider), model: String(r.model),
      sessionId: String(r.session_id || ''), purpose: String(r.purpose || ''),
      input: Number(r.input) || 0, output: Number(r.output) || 0,
      cacheRead: Number(r.cache_read) || 0, cacheWrite: Number(r.cache_write) || 0,
      tokens: (Number(r.input) || 0) + (Number(r.output) || 0) + (Number(r.cache_read) || 0) + (Number(r.cache_write) || 0) + (Number(r.reasoning) || 0),
      calls: Number(r.calls) || 0, cost: r4(Number(r.cost) || 0),
      costBasis: String(r.cost_basis || ''), subscription: Number(r.subscription) === 1,
      estimated: Number(r.estimated) === 1, period: String(r.period || ''),
    })),
    devices: overview(db, params).devices,
    sources: overview(db, params).sources,
    asOf: Date.now(),
    range: { fromMs: params.fromMs, toMs: params.toMs },
  }
}

/** 趋势（按时间桶 × 分组键） */
export function trend(db, params) {
  const bucket = params.bucket === 'month' ? 'month' : params.bucket === 'week' ? 'week' : 'day'
  const groupKeys = csvList(params.groupBy).length ? csvList(params.groupBy) : ['source']
  const g = groups(db, Object.assign({}, params, { groupBy: groupKeys.concat([bucket === 'day' ? 'day' : bucket === 'month' ? 'month' : 'day']) }))
  // 以 (bucket, key) 二维重建
  const series = new Map()
  const buckets = new Set()
  for (const item of g.groups) {
    const b = item.key[bucket] || ''
    buckets.add(b)
    const id = groupKeys.map((k) => item.key[k]).join(' · ') || '全部'
    let s = series.get(id)
    if (!s) { s = { id, points: {} }; series.set(id, s) }
    s.points[b] = (s.points[b] || 0) + item.cost
  }
  const ordered = Array.from(buckets).sort()
  return {
    ok: true, bucket,
    buckets: ordered,
    series: Array.from(series.values()).map((s) => ({
      id: s.id, points: ordered.map((b) => r4(s.points[b] || 0)),
    })).sort((a, b) => b.points.reduce((x, y) => x + y, 0) - a.points.reduce((x, y) => x + y, 0)),
  }
}

/** 记录列表（游标分页） */
export function records(db, params) {
  const where = [buildWhere(params).sql]
  const args = buildWhere(params).params
  const limit = Math.min(500, Math.max(1, Number(params.limit) || 50))
  if (params.model) { where.push('model = ?'); args.push(toStr(params.model)) }
  if (params.provider) { where.push('provider = ?'); args.push(toStr(params.provider)) }
  if (params.session) { where.push('session_id = ?'); args.push(toStr(params.session)) }
  if (params.purpose) { where.push('purpose = ?'); args.push(toStr(params.purpose)) }
  if (Number.isFinite(Number(params.minCost))) { where.push('cost >= ?'); args.push(Number(params.minCost)) }
  if (params.kind) { where.push('kind = ?'); args.push(toStr(params.kind)) }
  const cursor = Number(params.cursor) || 0
  if (cursor > 0) { where.push('id < ?'); args.push(cursor) }
  const sql = `SELECT id, device_id, source, agent_instance, kind, ts, day_key, provider, model, session_id, purpose,
      input, output, cache_read, cache_write, reasoning, calls, cost, cost_recomputed, device_cost, cost_drift,
      cost_basis, subscription, estimated, period, received_at, client_seq
    FROM records WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`
  const rows = db.prepare(sql).all(...args, limit + 1)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const dims = listDimensions(db)
  const nameOf = new Map(dims.devices.map((d) => [d.id, d.name]))
  return {
    ok: true,
    items: page.map((r) => ({
      id: Number(r.id), device: String(r.device_id), deviceName: nameOf.get(String(r.device_id)) || String(r.device_id),
      source: String(r.source), agentInstance: String(r.agent_instance || ''), kind: String(r.kind),
      ts: Number(r.ts) || 0, date: String(r.day_key), provider: String(r.provider), model: String(r.model),
      sessionId: String(r.session_id || ''), purpose: String(r.purpose || ''),
      input: Number(r.input) || 0, output: Number(r.output) || 0, cacheRead: Number(r.cache_read) || 0,
      cacheWrite: Number(r.cache_write) || 0, reasoning: Number(r.reasoning) || 0,
      tokens: (Number(r.input) || 0) + (Number(r.output) || 0) + (Number(r.cache_read) || 0) + (Number(r.cache_write) || 0) + (Number(r.reasoning) || 0),
      calls: Number(r.calls) || 0, cost: r6(Number(r.cost) || 0), costRecomputed: r6(Number(r.cost_recomputed) || 0),
      deviceCost: r.device_cost === null ? null : r6(Number(r.device_cost) || 0),
      drift: r6(Number(r.cost_drift) || 0), costBasis: String(r.cost_basis || ''),
      subscription: Number(r.subscription) === 1, estimated: Number(r.estimated) === 1, period: String(r.period || ''),
      receivedAt: Number(r.received_at) || 0, clientSeq: r.client_seq === null ? null : Number(r.client_seq),
    })),
    hasMore,
    nextCursor: hasMore && page.length ? page[page.length - 1].id : 0,
  }
}

/** 会话聚合 */
export function sessions(db, params) {
  const w = buildWhere(params)
  const q = toStr(params.q)
  const args = w.params.slice()
  let extra = ''
  if (q) { extra = ' AND (session_id LIKE ? OR purpose LIKE ? OR model LIKE ?)'; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%') }
  const rows = db.prepare(`SELECT session_id, purpose, device_id, source, MIN(day_key) AS first_day, MAX(day_key) AS last_day,
      COUNT(*) AS rows, SUM(calls) AS calls, SUM(input+output+cache_read+cache_write+reasoning) AS tokens, SUM(cost) AS cost,
      COUNT(DISTINCT model) AS models
    FROM records WHERE ${w.sql} AND session_id <> ''${extra}
    GROUP BY session_id ORDER BY cost DESC LIMIT ?`).all(...args, Math.min(500, Math.max(1, Number(params.limit) || 100)))
  const dims = listDimensions(db)
  const nameOf = new Map(dims.devices.map((d) => [d.id, d.name]))
  return {
    ok: true,
    items: rows.map((r) => ({
      sessionId: String(r.session_id), purpose: String(r.purpose || ''), device: String(r.device_id),
      deviceName: nameOf.get(String(r.device_id)) || String(r.device_id), source: String(r.source),
      firstDay: String(r.first_day), lastDay: String(r.last_day), rows: Number(r.rows) || 0,
      calls: Number(r.calls) || 0, tokens: Number(r.tokens) || 0, cost: r4(Number(r.cost) || 0),
      models: Number(r.models) || 0,
    })),
  }
}

/** 同步健康度：每设备 × 每来源 */
export function syncHealth(db, config) {
  const dims = listDimensions(db)
  const now = Date.now()
  const items = []
  for (const s of dims.sources) {
    const dev = dims.devices.find((d) => d.id === s.deviceId) || { name: s.deviceId }
    const batches = db.prepare(`SELECT COUNT(*) AS n, SUM(accepted) AS accepted, SUM(duplicates) AS dup, SUM(invalid) AS invalid,
        MAX(received_at) AS last FROM ingest_batches WHERE device_id = ? AND source = ? AND agent_instance = ?`)
      .get(s.deviceId, s.source, s.agentInstance)
    items.push({
      deviceId: s.deviceId, deviceName: dev.name, source: s.source, agentInstance: s.agentInstance,
      agentVersion: s.agentVersion, pluginVersion: s.pluginVersion,
      lastIngestAt: s.lastIngestAt,
      lagMs: s.lastIngestAt ? now - s.lastIngestAt : null,
      clockSkewMs: s.clockSkewMs, maxClientSeq: s.maxClientSeq, recordCount: s.recordCount, cost: s.cost,
      batches: Number(batches && batches.n) || 0,
      accepted: Number(batches && batches.accepted) || 0,
      duplicates: Number(batches && batches.dup) || 0,
      invalid: Number(batches && batches.invalid) || 0,
      dedupRate: (Number(batches && batches.accepted) || 0) + (Number(batches && batches.dup) || 0) > 0
        ? r4((Number(batches && batches.dup) || 0) / ((Number(batches && batches.accepted) || 0) + (Number(batches && batches.dup) || 0)))
        : 0,
      disabled: dev.disabled === true,
    })
  }
  return { ok: true, now, items, serviceVersion: config.serviceVersion, syncVer: config.syncVer }
}

/** CSV 导出 */
export function exportCsv(db, params) {
  const where = [buildWhere(params).sql]
  const args = buildWhere(params).params
  if (params.model) { where.push('model = ?'); args.push(toStr(params.model)) }
  if (params.provider) { where.push('provider = ?'); args.push(toStr(params.provider)) }
  const rows = db.prepare(`SELECT kind, ts, day_key, device_id, source, agent_instance, provider, model, session_id, purpose,
      calls, input, output, cache_read, cache_write, reasoning, cost, cost_recomputed, device_cost, cost_basis,
      subscription, estimated, period
    FROM records WHERE ${where.join(' AND ')} ORDER BY ts ASC, id ASC LIMIT 200000`).all(...args)
  const dims = listDimensions(db)
  const nameOf = new Map(dims.devices.map((d) => [d.id, d.name]))
  const head = ['time', 'date', 'deviceId', 'deviceName', 'agent', 'agentInstance', 'kind', 'provider', 'model',
    'sessionId', 'purpose', 'calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
    'costCNY', 'cloudRecomputedCNY', 'deviceReportedCNY', 'costBasis', 'subscription', 'estimated', 'period']
  const lines = [head.join(',')]
  for (const r of rows) {
    const ts = Number(r.ts) || dayKeyToMs(String(r.day_key)) + 43200000
    const d = new Date(ts + 28800000)
    const p2 = (n) => (n < 10 ? '0' + n : '' + n)
    const time = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds())
    lines.push([
      time, r.day_key, r.device_id, nameOf.get(String(r.device_id)) || r.device_id, r.source, r.agent_instance || '', r.kind,
      r.provider, r.model, r.session_id, r.purpose, r.calls, r.input, r.output, r.cache_read, r.cache_write, r.reasoning,
      r6(Number(r.cost) || 0), r6(Number(r.cost_recomputed) || 0), r.device_cost === null ? '' : r6(Number(r.device_cost) || 0),
      r.cost_basis, Number(r.subscription) === 1 ? 1 : 0, Number(r.estimated) === 1 ? 1 : 0, r.period,
    ].map(csvCell).join(','))
  }
  return '\uFEFF' + lines.join('\n') + '\n'
}

function csvCell(s) {
  const v = s === null || s === undefined ? '' : String(s)
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

export { resolveRange }
