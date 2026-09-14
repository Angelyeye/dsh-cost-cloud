// ============================================================
// 前端渲染离线复现：在本机 Node 里跑 web/ 模块，输入用服务器真实 API 响应
// 目的：把"页面卡在加载中"的渲染异常直接复现出来（不需要浏览器控制台）
//
//   node scripts/repro-render.mjs <cloudDir> [baseUrl] [password]
// ============================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cloudDir = process.argv[2] || join(process.cwd())
const baseUrl = process.argv[3] || 'http://127.0.0.1:8787'
const password = process.argv[4] || ''

// ---------- 最小 DOM 桩 ----------
function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    _listeners: {},
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    setAttribute(k, v) { if (v === undefined || v === null || v === false) return; this.attributes[k] = String(v) },
    getAttribute(k) { return this.attributes[k] },
    removeAttribute(k) { delete this.attributes[k] },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) },
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    click() { for (const fn of (this._listeners.click || [])) fn({ preventDefault() {} }) },
    focus() {},
    remove() {},
    toLocaleString() { return this.textContent },
  }
  return node
}
const appRoot = makeNode('div')
appRoot.className = 'app-loading'
globalThis.document = {
  createElement: (t) => makeNode(t),
  createElementNS: (_ns, t) => makeNode(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById: (id) => (id === 'app' ? appRoot : null),
  body: makeNode('body'),
  addEventListener() {},
}
globalThis.window = { localStorage: { getItem: () => null, setItem() {} }, confirm: () => true, prompt: () => null }
globalThis.localStorage = globalThis.window.localStorage
globalThis.alert = () => {}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---------- 用真实服务端响应作为 api() 的数据源 ----------
const realFetch = globalThis.fetch.bind(globalThis)
let cookie = ''
async function login() {
  const r = await realFetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  if (setCookie.length) cookie = setCookie[0].split(';')[0]
  const j = await r.json()
  console.log('[login]', r.status, JSON.stringify(j).slice(0, 80))
  return j
}

globalThis.fetch = async (url, opts) => {
  const u = String(url).startsWith('http') ? String(url) : baseUrl + String(url)
  const o = Object.assign({}, opts || {})
  o.headers = Object.assign({}, o.headers || {}, cookie ? { cookie } : {})
  return realFetch(u, o)
}

// ---------- 载入前端模块并跑一遍渲染 ----------
await login()
const state = await import(pathToFileURL(join(cloudDir, 'web', 'state.js')).href)
const views = await import(pathToFileURL(join(cloudDir, 'web', 'views.js')).href)
console.log('[modules] state/views 载入成功')

// app.js 是浏览器入口（会自执行 boot()），这里改为逐段复现 Dashboard 的数据流
const api = state.api
const calls = ['health', 'config', 'devices', 'overview?range=7d', 'matrix?range=7d', 'sync-health', 'trend?range=7d&bucket=day&groupBy=device', 'models?range=7d', 'records?range=7d&limit=50', 'prices']
const data = {}
for (const c of calls) {
  // 先看原始响应，避免 api() 把细节吞掉
  try {
    const raw = await globalThis.fetch(baseUrl + '/api/admin/' + c, { headers: { accept: 'application/json' } })
    const text = await raw.text()
    if (raw.status !== 200 || !/"ok"\s*:\s*true/.test(text)) {
      console.log('[api-raw] ' + c.padEnd(42) + ' HTTP ' + raw.status + ' body=' + text.slice(0, 300))
    }
  } catch (e) {
    console.log('[api-raw] ' + c.padEnd(42) + ' fetch 失败: ' + (e && e.message))
  }
  try {
    data[c] = await api(c)
    const n = JSON.stringify(data[c] || {}).length
    console.log('[api] ' + c.padEnd(42) + ' ok  ' + n + 'B')
  } catch (e) {
    console.log('[api] ' + c.padEnd(42) + ' FAIL: ' + (e && e.message) + ' code=' + (e && e.code))
  }
}

// 逐个渲染函数试跑，定位抛错点
const probes = [
  ['cards', () => views.cards([{ title: 't', value: '1' }])],
  ['table', () => views.table([{ key: 'a', label: 'A' }], [])],
  ['barList', () => views.barList([{ label: 'x', value: 1 }])],
  ['sourceDot', () => views.sourceDot('dsh', ['dsh'])],
  ['matrixTable', () => views.matrixTable(data['matrix?range=7d'], (data['matrix?range=7d'].cols || []), 'cost', () => {})],
  ['stackedBars', () => views.stackedBars({ buckets: data['trend?range=7d&bucket=day&groupBy=device'].buckets, series: [] })],
]
for (const [name, fn] of probes) {
  try { fn(); console.log('[render] ' + name.padEnd(14) + ' ok') } catch (e) { console.log('[render] ' + name.padEnd(14) + ' THROW: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)) }
}

// 真正跑一遍 app.js 的 boot（它会自己 fetch 并渲染）
console.log('--- 载入 web/app.js（浏览器入口，自执行 boot） ---')
globalThis.addEventListener = () => {}
try {
  await import(pathToFileURL(join(cloudDir, 'web', 'app.js')).href)
  await new Promise((r) => setTimeout(r, 1500))
  console.log('[app.js] 载入完成，未抛异常')
  console.log('[app.js] #app 子节点数 =', appRoot.children.length, '| className =', JSON.stringify(appRoot.className))
} catch (e) {
  console.log('[app.js] 抛异常：')
  console.log(String(e && e.stack ? e.stack : e).split('\n').slice(0, 8).join('\n'))
}
