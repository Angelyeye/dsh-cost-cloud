// ============================================================
// 线上前端真实回归：用同一套 DOM 桩在本机跑 web/ 里未经改写的浏览器代码，
// 数据来自真实服务器（含登录 Cookie），并且真的"点击"每个导航项。
//
//   node scripts/repro-render.mjs <cloudDir> <baseUrl> <password>
//
// 退出码 0 = 全部通过；非 0 = 有视图没渲染出来 / 点击没触发请求。
// ============================================================
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installDom, byClass, findAll, waitFor } from '../test/dom-shim.mjs'

const cloudDir = process.argv[2] || process.cwd()
const baseUrl = process.argv[3] || 'http://127.0.0.1:8787'
const password = process.argv[4] || ''

const realFetch = globalThis.fetch.bind(globalThis)
let cookie = ''

async function login() {
  const r = await realFetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  if (sc.length) cookie = sc[0].split(';')[0]
  console.log('[login] HTTP ' + r.status + ' cookie=' + (cookie ? '有' : '无'))
  if (r.status !== 200) { console.log('[login] 失败，后续检查无意义'); process.exit(2) }
}

// ---------- 1. 原始接口（不经 api()，避免细节被吞） ----------
const PATHS = ['health', 'config', 'devices', 'prices', 'overview?range=7d', 'matrix?range=7d', 'sync-health',
  'trend?range=7d&bucket=day&groupBy=device', 'models?range=7d', 'records?range=7d&limit=50']
let bad = 0
await login()
for (const p of PATHS) {
  try {
    const r = await realFetch(baseUrl + '/api/admin/' + p, { headers: { cookie, accept: 'application/json' } })
    const text = await r.text()
    const ok = r.status === 200 && /"ok"\s*:\s*true/.test(text)
    if (!ok) bad += 1
    console.log('[api] ' + (ok ? 'OK  ' : 'BAD ') + p.padEnd(44) + 'HTTP ' + r.status + ' ' + text.length + 'B')
  } catch (e) {
    bad += 1
    console.log('[api] FAIL ' + p.padEnd(44) + (e && e.message))
  }
}

// ---------- 2. 真跑浏览器入口 ----------
const log = []
globalThis.fetch = async (url, opts) => {
  const u = String(url).startsWith('http') ? String(url) : baseUrl + String(url)
  const o = Object.assign({}, opts || {})
  o.headers = Object.assign({}, o.headers || {}, cookie ? { cookie } : {})
  log.push(String(url))
  return realFetch(u, o)
}

const { root } = installDom()
console.log('--- 载入 web/app.js（浏览器真实入口，自执行 boot） ---')
await import(pathToFileURL(join(cloudDir, 'web', 'app.js')).href)

const booted = await waitFor(() => log.some((u) => u.includes('/devices')) && log.some((u) => u.includes('/overview')), 5000)
console.log('[boot] 数据请求 ' + (booted ? 'OK' : '缺失') + '：' + JSON.stringify(log))
if (!booted) { console.log('[boot] boot() 没有拉数据 → 页面必然停在「加载中…」'); process.exit(1) }

if (!/区间按量花费/.test(root.textContent)) { console.log('[boot] 概览未渲染：' + root.textContent.slice(0, 200)); process.exit(1) }
console.log('[boot] 概览已渲染 ✓')

// ---------- 3. 逐个点击导航 ----------
const labels = byClass(root, 'nav-item').map((n) => n.textContent)
console.log('[nav] 共 ' + labels.length + ' 项：' + labels.join(' / '))
if (labels.length !== 7) { console.log('[nav] 导航项数量异常'); process.exit(1) }

let fails = 0
for (let i = 0; i < labels.length; i += 1) {
  const before = log.length
  byClass(root, 'nav-item')[i].click()
  const fired = await waitFor(() => log.length > before, 5000)
  const rendered = await waitFor(() => !/加载中/.test(root.textContent) || /渲染异常/.test(root.textContent), 5000)
  const text = root.textContent
  const broken = /渲染异常/.test(text)
  const stuck = /加载中/.test(text)
  const ok = fired && rendered && !broken && !stuck
  if (!ok) fails += 1
  console.log('[nav] ' + (ok ? 'OK  ' : 'FAIL') + ' ' + labels[i].padEnd(14) +
    ' 请求+' + (log.length - before) + '  文本=' + JSON.stringify(text.slice(0, 60)))
  if (broken) console.log('        ↑ ' + (text.match(/界面渲染异常：[^。]*/) || [''])[0])
}

console.log('---')
console.log(bad === 0 && fails === 0 ? '全部通过 ✓' : ('失败：接口 ' + bad + ' 个，视图 ' + fails + ' 个'))
process.exit(bad === 0 && fails === 0 ? 0 : 1)
