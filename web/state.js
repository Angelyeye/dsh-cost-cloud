// ============================================================
// dsh-cost-cloud 看板 —— 状态与工具（无构建、无依赖）
// ============================================================

export const state = {
  view: 'overview',
  range: '7d',
  devices: [],
  sources: [],
  filterDevices: [],
  filterSources: [],
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
}

const listeners = new Set()
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export function setState(patch) {
  Object.assign(state, patch)
  for (const fn of listeners) fn(state)
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
export function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(Number(ms) + 28800000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
}
export function fmtAgo(ms) {
  if (!ms) return '从未'
  const diff = Date.now() - Number(ms)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

export const RANGES = [
  { id: 'today', label: '今天' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: 'month', label: '本月' },
  { id: 'year', label: '本年' },
  { id: 'all', label: '全部' },
]

export const SOURCE_COLORS = ['#4176e6', '#d97706', '#16a34a', '#7c3aed', '#dc2626', '#0891b2', '#c026d3', '#65a30d', '#ea580c', '#0ea5e9']
export function colorForSource(src, list) {
  const i = Math.max(0, (list || []).indexOf(src))
  return SOURCE_COLORS[i % SOURCE_COLORS.length]
}

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

export function qs() {
  const p = new URLSearchParams()
  p.set('range', state.range)
  if (state.filterDevices.length) p.set('devices', state.filterDevices.join(','))
  if (state.filterSources.length) p.set('sources', state.filterSources.join(','))
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
