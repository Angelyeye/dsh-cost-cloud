// ============================================================
// dsh-cost-cloud 看板 —— 状态与工具（无构建、无依赖）
//
// 约定：
//   · 所有视图共享 state；render() 全量重建 DOM（数据量小，简单可靠）
//   · 偏好（阈值 / 预算 / 自动刷新 / 热力图指标）存 localStorage，键 dshc.prefs
//   · 视图可深链：#/heatmap 之类，刷新后停在原页面
// ============================================================

const PREF_KEY = 'dshc.prefs'

export const DEFAULT_PREFS = {
  budgetMonth: 0,      // 月度预算（CNY，0 = 不告警）
  staleHours: 24,      // 超过 N 小时没有上报 → 告警
  skewSec: 300,        // 设备时钟偏差阈值（秒）
  driftYuan: 0.5,      // 口径漂移阈值（CNY）
  estShare: 0.2,       // 估算记录占比阈值
  hitRateMin: 0.5,     // 缓存命中率下限
  subIdleDays: 14,     // 订阅套餐闲置天数
  silenceHours: 6,     // 云端整体静默阈值（小时）
  spikeRatio: 3,       // 单日花费 / 近 7 日均值 的倍数阈值
  autoRefresh: 0,      // 自动刷新秒数（0 = 关闭）
  heatMetric: 'cost',  // 热力图指标
  heatWindow: '90d',   // 热力图窗口
}

function readPrefs() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(PREF_KEY)
    if (!raw) return Object.assign({}, DEFAULT_PREFS)
    const p = JSON.parse(raw)
    return Object.assign({}, DEFAULT_PREFS, p && typeof p === 'object' ? p : {})
  } catch (e) {
    return Object.assign({}, DEFAULT_PREFS)
  }
}

export const state = {
  view: 'overview',
  range: '7d',
  customFrom: 0,
  customTo: 0,
  devices: [],
  sources: [],
  filterDevices: [],
  filterSources: [],
  showFilters: false,
  bucket: 'day',
  trendGroup: 'device',
  matrixMetric: 'cost',
  drill: null,          // { device, source } 矩阵下钻
  records: null,
  recordsCursor: 0,
  config: null,
  details: null,
  error: '',
  loading: false,
  authed: false,
  autoRefresh: DEFAULT_PREFS.autoRefresh,
  lastLoadedAt: 0,
  alerts: [],
  prefs: typeof globalThis !== 'undefined' && globalThis.localStorage ? readPrefs() : Object.assign({}, DEFAULT_PREFS),
  heatMetric: 'cost',
  heatWindow: '90d',
  subMetric: 'cost',
  subWindow: 'all',
  showFilters: false,
  sessionExpiresAt: 0,
}

// 偏好 → 运行时状态（自动刷新 / 热力图选项跟随上次选择）
state.autoRefresh = Number(state.prefs.autoRefresh) || 0
state.heatMetric = state.prefs.heatMetric || 'cost'
state.heatWindow = state.prefs.heatWindow || '90d'

const listeners = new Set()
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export function setState(patch) {
  Object.assign(state, patch)
  for (const fn of listeners) fn(state)
}

/** 更新偏好并落盘（localStorage 不可用时静默降级） */
export function setPrefs(patch) {
  state.prefs = Object.assign({}, state.prefs, patch || {})
  const p = state.prefs
  state.autoRefresh = Number(p.autoRefresh) || 0
  state.heatMetric = p.heatMetric || state.heatMetric
  state.heatWindow = p.heatWindow || state.heatWindow
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs))
  } catch (e) { /* 忽略：无痕模式等 */ }
  return state.prefs
}

export async function api(path) {
  const r = await fetch('/api/admin/' + path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (r.status === 401) { const e = new Error('UNAUTHORIZED'); e.code = 'UNAUTHORIZED'; throw e }
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }))
  if (!j.ok) { const e = new Error(j.error || j.code || '请求失败'); e.code = j.code; throw e }
  return j
}

export async function post(path, body) {
  const r = await fetch('/api/admin/' + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }))
  if (!j.ok) { const e = new Error(j.error || j.code || '请求失败'); e.code = j.code; throw e }
  return j
}

export async function patch(path, body) {
  const r = await fetch('/api/admin/' + path, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }))
  if (!j.ok) { const e = new Error(j.error || j.code || '请求失败'); e.code = j.code; throw e }
  return j
}

// ---------- 格式化 ----------
export function fmtMoney(x, digits) {
  const n = Number(x) || 0
  const d = digits === undefined ? (Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 1 ? 2 : 4) : digits
  return n.toFixed(d)
}
export function fmtInt(x) {
  const n = Math.round(Number(x) || 0)
  return n.toLocaleString('zh-CN')
}
export function fmtTokens(x) {
  const n = Number(x) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}
/** 0.1234 → "12.3%" */
export function fmtPct(x, digits) {
  const n = Number(x) || 0
  return (n * 100).toFixed(digits === undefined ? 1 : digits) + '%'
}
/** 环比：0.25 → "+25.0%"、-0.1 → "-10.0%" */
export function fmtDelta(x, digits) {
  const n = Number(x) || 0
  return (n > 0 ? '+' : '') + (n * 100).toFixed(digits === undefined ? 1 : digits) + '%'
}
export function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(Number(ms) + 28800000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
}
export function fmtClock(ms) {
  if (!ms) return '—'
  const d = new Date(Number(ms) + 28800000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
}
export function fmtAgo(ms) {
  if (!ms) return '从未'
  const diff = Date.now() - Number(ms)
  if (diff < 0) return '刚刚'
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分'
  return Math.floor(s / 86400) + ' 天 ' + Math.floor((s % 86400) / 3600) + ' 时'
}

export const RANGES = [
  { id: 'today', label: '今天' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: '90d', label: '近 90 天' },
  { id: 'month', label: '本月' },
  { id: 'year', label: '本年' },
  { id: 'all', label: '全部' },
]

/** 热力图窗口（不跟全局区间走：一年热力图和「今天」卡片的窗口本来就不同） */
export const HEAT_WINDOWS = [
  { id: '30d', label: '近 30 天', days: 30 },
  { id: '90d', label: '近 90 天', days: 90 },
  { id: '180d', label: '近 180 天', days: 180 },
  { id: '365d', label: '近一年', days: 365 },
  { id: 'year', label: '本年' },
  { id: 'all', label: '全部' },
]

export const HEAT_METRICS = [
  { id: 'cost', label: '花费', kind: 'money' },
  { id: 'realCost', label: '按量', kind: 'money' },
  { id: 'subCost', label: '订阅', kind: 'money' },
  { id: 'calls', label: '调用', kind: 'int' },
  { id: 'tokens', label: 'Tokens', kind: 'tokens' },
]

/**
 * 订阅看板的窗口。默认**全部**：订阅是按月/按套餐生效的长周期账，
 * 用默认的「近 7 天」会看到一片 ¥0.0000（套餐可能上月才用过），
 * 既看不出占比也看不出闲置 —— 而「闲置」本身就是订阅监控最该回答的问题。
 */
export const SUB_WINDOWS = [
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: '90d', label: '近 90 天' },
  { id: 'month', label: '本月' },
  { id: 'all', label: '全部' },
]

export const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六']
export const DOW_LONG = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 周一为第一行（中文习惯）→ 索引 0..6 对应 dow 1,2,3,4,5,6,0 */
export const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** 指标格式化器 */
export function fmtMetric(v, kind) {
  if (kind === 'int') return fmtInt(v)
  if (kind === 'tokens') return fmtTokens(v)
  return '¥' + fmtMoney(v, 2)
}

/**
 * 分位数色阶断点：花费分布极度长尾（个别高峰日能到均值的几十倍），
 * 用等分色阶会让绝大多数格子落进最浅一档 —— 因此按非零值分位数取断点。
 */
export function heatBreaks(values, levels) {
  const n = levels || 4
  const nz = values.map((v) => Number(v) || 0).filter((v) => v > 0).sort((a, b) => a - b)
  if (!nz.length) return []
  const out = []
  for (let i = 1; i <= n; i += 1) {
    const idx = Math.min(nz.length - 1, Math.max(0, Math.ceil((i / n) * nz.length) - 1))
    out.push(nz[idx])
  }
  return out
}
export function heatLevel(v, breaks) {
  const x = Number(v) || 0
  if (!(x > 0)) return 0
  for (let i = 0; i < breaks.length; i += 1) if (x <= breaks[i]) return i + 1
  return breaks.length
}

export const SOURCE_COLORS = ['#4176e6', '#d97706', '#16a34a', '#7c3aed', '#dc2626', '#0891b2', '#c026d3', '#65a30d', '#ea580c', '#0ea5e9']
export function colorForSource(src, list) {
  const i = Math.max(0, (list || []).indexOf(src))
  return SOURCE_COLORS[i % SOURCE_COLORS.length]
}

// ---------- 概览切片取值 ----------
// 注意字段名有两套，历史上混用过，这里是唯一的归一化入口：
//   · /overview 的 summary            → realCost / subEquivalent / realCalls
//   · /overview 的 today|month|all    → real / sub（与插件本地 buildDashboard 同形）
//   · /plugin-view 的 today|month|all → 同上
// 直接读 x.realCost 会得到 undefined → 页面显示 ¥0.0000（曾因此让「今日 / 本月 / 全部累计」
// 三张卡片长期显示 0.0000，而汇总卡片却是对的）。
export function sliceReal(x) {
  const v = x && (x.realCost !== undefined ? x.realCost : x.real)
  return Number(v) || 0
}
export function sliceSub(x) {
  const v = x && (x.subEquivalent !== undefined ? x.subEquivalent : x.sub)
  return Number(v) || 0
}
export function sliceCalls(x) { return Number(x && x.calls) || 0 }
export function sliceTokens(x) { return Number(x && x.tokens) || 0 }

export function el(tag, attrs, children) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') node.className = v
      else if (k === 'html') node.innerHTML = v
      else if (k === 'text') node.textContent = v
      // 注意：DOM 事件名大小写敏感。onClick → 'click'，必须 toLowerCase，
      // 否则 addEventListener('Click') 会静默注册失败（不报错、不触发）。
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v)
      else node.setAttribute(k, String(v))
    }
  }
  const kids = Array.isArray(children) ? children : (children === undefined || children === null ? [] : [children])
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
  return node
}

const svgNS = 'http://www.w3.org/2000/svg'
export function svgEl(tag, attrs, children) {
  const node = document.createElementNS(svgNS, tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v))
  const kids = Array.isArray(children) ? children : (children === undefined || children === null ? [] : [children])
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
  return node
}

/**
 * 查询串。自定义区间（热力图点格子下钻、记录页手选日期）用 from/to；
 * `extra` 用于给个别接口追加参数（如 days）。
 */
export function qs(extra) {
  const p = new URLSearchParams()
  if (state.range === 'custom' && Number(state.customFrom) > 0) {
    p.set('from', String(Number(state.customFrom)))
    if (Number(state.customTo) > 0) p.set('to', String(Number(state.customTo)))
  } else {
    p.set('range', state.range)
  }
  if (state.filterDevices.length) p.set('devices', state.filterDevices.join(','))
  if (state.filterSources.length) p.set('sources', state.filterSources.join(','))
  for (const [k, v] of Object.entries(extra || {})) if (v !== null && v !== undefined && v !== '') p.set(k, String(v))
  return p
}

export function download(path) {
  const a = document.createElement('a')
  a.href = '/api/admin/' + path
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** 主题色板（趋势 / 矩阵 / 订阅对比共用） */
export const COLOR_LIST = SOURCE_COLORS
