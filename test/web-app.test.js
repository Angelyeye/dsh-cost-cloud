// ============================================================
// 前端回归测试 —— 在 Node 里真跑一遍浏览器入口 web/app.js
//
// 覆盖两类曾经把整个看板打死的缺陷（都是静默失败，控制台无报错）：
//   1. el() 把 onClick 注册成 'Click'（DOM 事件名大小写敏感）→ 全站按钮失效
//   2. boot() 渲染完外壳却不拉数据 → 带会话刷新页面永远停在「加载中…」
//
// 注意：这里载入的是 web/ 下真实的、未经任何改写的浏览器代码。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, byClass, findAll, waitFor } from './dom-shim.mjs'

const dom = installDom()
const STATE_URL = new URL('../web/state.js', import.meta.url).href

// ---------- 真实接口响应样本（形状与 src/query.js 输出一致） ----------
const money = (cost, calls, tokens) => ({ realCost: cost, calls, tokens, realCalls: calls, realTokens: tokens, subEquivalent: 0, subCalls: 0, subTokens: 0 })
const FIXTURES = {
  session: { ok: true, expiresAt: Date.now() + 3600000 },
  health: { ok: true, serviceVersion: '1.0.0', syncVer: 1, uptimeMs: 1234, lastIngestAt: 0, db: { file: '/data/cost.db', userVersion: 1 } },
  config: {
    ok: true, timezone: 'Asia/Shanghai', todayKey: '2026-09-15', allowSelfRegister: true, deviceTokenSet: true,
    rateLimitPerMin: 120, maxBatchRecords: 500, trustProxy: true, syncVer: 1, pricing: { source: 'builtin' },
  },
  prices: { ok: true, prices: null },
  devices: {
    ok: true,
    devices: [{ id: 'dev-1', name: '台式机', disabled: false, nameLocked: false, sourceCount: 1, recordCount: 3, cost: 1.23, lastIngestAt: 0 }],
    sources: [{ deviceId: 'dev-1', source: 'dsh', agentInstance: null, agentVersion: null, pluginVersion: '1.8.0', recordCount: 3, cost: 1.23, maxClientSeq: 3, lastIngestAt: 0 }],
  },
  overview: {
    ok: true, excludedDevice: false, firstTs: 0,
    summary: { realCost: 1.23, realCalls: 3, realTokens: 3000, subEquivalent: 0, subCalls: 0, subTokens: 0, cacheRead: 100, input: 200, output: 50, driftAbs: 0 },
    today: money(1.23, 3, 3000), month: money(1.23, 3, 3000), all: money(1.23, 3, 3000),
    sources: [], devices: [],
  },
  'sync-health': { ok: true, items: [] },
  matrix: { ok: true, rows: [], cols: [], totals: { cost: 0, tokens: 0, calls: 0 } },
  trend: { ok: true, buckets: [], series: [] },
  models: { ok: true, items: [] },
  records: { ok: true, items: [], hasMore: false, nextCursor: 0 },
}

const log = []
globalThis.fetch = async (url) => {
  const u = String(url)
  log.push(u)
  const path = u.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/admin\//, '').split('?')[0]
  const body = FIXTURES[path]
  const status = body ? 200 : 404
  return new Response(JSON.stringify(body || { ok: false, error: 'NOT_FOUND' }), {
    status, headers: { 'content-type': 'application/json' },
  })
}

// ============================================================
// 1. el() 事件名契约
// ============================================================
test('el(): onClick/onChange 注册为小写事件名，点击真的会触发', async () => {
  const { el } = await import(STATE_URL)
  let clicks = 0
  let changes = 0
  const btn = el('button', { onClick: () => { clicks += 1 } })
  const sel = el('select', { onChange: () => { changes += 1 } })

  assert.deepEqual(btn.listenerTypes(), ['click'], 'onClick 必须注册到 "click"（大小写敏感）')
  assert.deepEqual(sel.listenerTypes(), ['change'], 'onChange 必须注册到 "change"')

  btn.click()
  sel.dispatch('change')
  assert.equal(clicks, 1, '点击回调必须被触发')
  assert.equal(changes, 1, 'change 回调必须被触发')

  // 非函数值不应炸，也不应注册监听器
  const plain = el('div', { onClick: undefined, onChange: null })
  assert.deepEqual(plain.listenerTypes(), [])
})

test('el(): 其余属性/子节点仍然正常', async () => {
  const { el } = await import(STATE_URL)
  const n = el('div', { class: 'a b', style: { width: '10px' }, dataset: { k: 'v' } }, [
    '文本', el('span', {}, '子'), null, false, 0,
  ])
  assert.equal(n.className, 'a b')
  assert.equal(n.style.width, '10px')
  assert.equal(n.dataset.k, 'v')
  assert.equal(n.textContent, '文本子0')
})

// ============================================================
// 2. 浏览器入口冒烟：boot() 必须真的把数据拉回来
// ============================================================
test('app.js: 带会话加载时 boot() 会请求 devices/overview 并渲染出概览', async () => {
  log.length = 0
  const { root } = dom
  await import(new URL('../web/app.js', import.meta.url).href + '?smoke=1')

  const got = await waitFor(() => log.some((u) => u.includes('/devices')) && log.some((u) => u.includes('/overview')))
  assert.ok(got, 'boot() 必须发起 devices + overview 请求；实际请求：' + JSON.stringify(log))

  const { state } = await import(STATE_URL)
  assert.equal(state.authed, true)
  assert.equal(state.loading, false)

  assert.ok(!/加载中/.test(root.textContent), '不应停留在「加载中…」；实际：' + root.textContent.slice(0, 120))
  assert.match(root.textContent, /区间按量花费/, '概览卡片应已渲染')
  assert.doesNotMatch(root.className, /app-loading/)
})

// ============================================================
// 3. 导航按钮真的能点
// ============================================================
test('app.js: 点击左侧导航会切视图并重新取数', async () => {
  const { root } = dom
  const navs = byClass(root, 'nav-item')
  assert.equal(navs.length, 7, '应有 7 个导航项')

  const before = log.length
  navs[2].click() // 设备
  const hit = await waitFor(() => log.slice(before).some((u) => u.includes('/devices')))
  assert.ok(hit, '点击「设备」后必须发起 /devices 请求；新增请求：' + JSON.stringify(log.slice(before)))

  const { state } = await import(STATE_URL)
  assert.equal(state.view, 'devices')
  assert.match(root.textContent, /设备清单/, '设备视图应已渲染')
  assert.match(byClass(root, 'nav-item')[2].className, /(^|\s)on(\s|$)/, '被选中的导航项应高亮')
})

test('app.js: 顶部「刷新」按钮会重新取数', async () => {
  const { root } = dom
  const btn = findAll(root, (n) => n.tagName === 'BUTTON' && n.textContent === '刷新')[0]
  assert.ok(btn, '应存在「刷新」按钮')
  const before = log.length
  btn.click()
  const hit = await waitFor(() => log.length > before)
  assert.ok(hit, '点击刷新后必须发起请求')
})

test('app.js: 时间范围按钮会重新取数', async () => {
  const { root } = dom
  byClass(root, 'nav-item')[0].click() // 回到「概览」（只有带 range 的视图才吃这个参数）
  assert.ok(await waitFor(() => /区间按量花费/.test(root.textContent)), '应先回到概览视图')

  const btn = findAll(root, (n) => n.tagName === 'BUTTON' && n.textContent === '近 30 天')[0]
  assert.ok(btn, '应存在「近 30 天」按钮')
  const before = log.length
  btn.click()
  const hit = await waitFor(() => log.slice(before).some((u) => u.includes('range=30d')))
  assert.ok(hit, '切换范围后请求应带 range=30d；新增请求：' + JSON.stringify(log.slice(before)))
})

// ============================================================
// 4. 未登录时必须渲染登录页（会话 401）
// ============================================================
test('app.js: 会话失效时渲染登录页而不是空白外壳', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = async (url) => {
    log.push(String(url))
    return new Response(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }), { status: 401, headers: { 'content-type': 'application/json' } })
  }
  try {
    const root2 = installDom().root
    await import(new URL('../web/app.js', import.meta.url).href + '?anon=1')
    await waitFor(() => /登录/.test(root2.textContent))
    assert.match(root2.textContent, /多机 · 多 Agent 用量与花费汇总看板/, '应渲染登录视图')
    assert.equal(findAll(root2, (n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'password').length, 1, '应有口令输入框')
    const { state } = await import(STATE_URL)
    assert.equal(state.authed, false)
  } finally {
    globalThis.fetch = saved
  }
})
