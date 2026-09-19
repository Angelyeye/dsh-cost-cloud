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

// ---------- 真实接口响应样本（形状与 src/query.js 输出一致，且刻意非空：
//            空数组几乎不触发任何渲染分支，正是当初漏掉 bug 的原因） ----------
const NOW = Date.now()
// 注意：概览三切片的**真实**形状是 {real, sub, calls, tokens, subCalls, subTokens}
// （与插件本地 buildDashboard 同形），**不是** realCost/subEquivalent ——
// 早期样本写成 realCost，掩盖了「今日 / 本月 / 全部累计」长期显示 ¥0.0000 的缺陷。
const money = (cost, calls, tokens) => ({ real: cost, sub: 0, calls, tokens, subCalls: 0, subTokens: 0 })
const FIXTURES = {
  session: { ok: true, expiresAt: NOW + 3600000 },
  health: { ok: true, serviceVersion: '1.0.0', syncVer: 1, uptimeMs: 1234567, lastIngestAt: NOW - 60000, db: { file: '/data/cost.db', userVersion: 1 } },
  config: {
    ok: true, timezone: 'Asia/Shanghai', todayKey: '2026-09-15', allowSelfRegister: true, deviceTokenSet: true,
    deviceToken: 'dshc_fixture_shared_bootstrap_token_01',
    rateLimitPerMin: 120, maxBatchRecords: 2000, trustProxy: true, syncVer: 1, pricing: { source: 'builtin' },
  },
  prices: {
    ok: true,
    prices: {
      currentEra: 'v41', eraLabel: 'V4.1', peakWindows: '09:00-12:00, 14:00-18:00', offPeakFactor: 0.5,
      eras: [{ id: 'v41', label: 'V4.1', models: { 'deepseek-v4.1-flash': { input: 1, cacheRead: 0.1, output: 2 } } }],
    },
  },
  devices: {
    ok: true,
    devices: [
      { id: 'dev-1', name: '台式机', disabled: false, nameLocked: false, sourceCount: 2, recordCount: 3, cost: 1.23, lastIngestAt: NOW - 60000 },
      { id: 'dev-2', name: '笔记本', disabled: true, nameLocked: true, sourceCount: 1, recordCount: 1, cost: 0.5, lastIngestAt: 0 },
    ],
    sources: [
      { deviceId: 'dev-1', source: 'dsh', agentInstance: 'main', agentVersion: '1.0', pluginVersion: '1.8.0', recordCount: 2, cost: 1.0, maxClientSeq: 10, lastIngestAt: NOW - 60000 },
      { deviceId: 'dev-1', source: 'zcode', agentInstance: null, agentVersion: null, pluginVersion: '1.8.0', recordCount: 1, cost: 0.23, maxClientSeq: 4, lastIngestAt: NOW - 120000 },
      { deviceId: 'dev-2', source: 'dsh', agentInstance: null, agentVersion: null, pluginVersion: '1.7.1', recordCount: 1, cost: 0.5, maxClientSeq: 2, lastIngestAt: 0 },
    ],
  },
  overview: {
    ok: true, excludedDevice: false, firstTs: NOW - 86400000,
    summary: { realCost: 1.73, realCalls: 7, realTokens: 12345, subEquivalent: 0.2, subCalls: 1, subTokens: 999, cacheRead: 5000, input: 6000, output: 1345, driftAbs: 0.05 },
    today: money(0.33, 2, 3000), month: money(1.73, 7, 12345), all: money(1.73, 7, 12345),
    sources: [
      { source: 'dsh', cost: 1.5, calls: 5, tokens: 10000, devices: ['dev-1', 'dev-2'] },
      { source: 'zcode', cost: 0.23, calls: 2, tokens: 2345, devices: ['dev-1'] },
    ],
    devices: [
      { device: 'dev-1', name: '台式机', cost: 1.23, calls: 5, tokens: 9000, sources: ['dsh', 'zcode'] },
      { device: 'dev-2', name: '笔记本', cost: 0.5, calls: 2, tokens: 3345, sources: ['dsh'] },
    ],
  },
  'sync-health': {
    ok: true,
    items: [
      { deviceName: '台式机', source: 'dsh', pluginVersion: '1.8.0', lastIngestAt: NOW - 60000, clockSkewMs: 1200000, accepted: 10, duplicates: 2, invalid: 1 },
      { deviceName: '笔记本', source: 'dsh', pluginVersion: '1.7.1', lastIngestAt: 0, clockSkewMs: 1500, accepted: 3, duplicates: 0, invalid: 0 },
    ],
  },
  matrix: {
    ok: true,
    cols: ['dsh', 'zcode'],
    rows: [
      { device: 'dev-1', name: '台式机', cost: 1.23, tokens: 9000, calls: 5, cells: { dsh: { cost: 1.0, tokens: 7000, calls: 4 }, zcode: { cost: 0.23, tokens: 2000, calls: 1 } } },
      { device: 'dev-2', name: '笔记本', cost: 0.5, tokens: 3345, calls: 2, cells: { dsh: { cost: 0.5, tokens: 3345, calls: 2 } } },
    ],
    totals: { cost: 1.73, tokens: 12345, calls: 7 },
  },
  trend: {
    ok: true,
    buckets: ['2026-09-13', '2026-09-14', '2026-09-15'],
    series: [{ id: 'dev-1', points: [0.4, 0.5, 0.33] }, { id: 'dev-2', points: [0.2, 0.3, 0] }],
  },
  models: {
    ok: true,
    items: [
      { kind: 'detail', model: 'deepseek-v4.1-flash', provider: 'deepseek-official', calls: 5, input: 6000, cacheRead: 5000, output: 1345, tokens: 12345, cost: 1.5, driftAbs: 0.02 },
      { kind: 'rollup', model: 'deepseek-v4.1-flash', calls: 2, tokens: 2000, cost: 0.23 },
    ],
  },
  records: {
    ok: true, hasMore: true, nextCursor: 123,
    items: [{
      ts: NOW - 3600000, deviceName: '台式机', source: 'dsh', agentInstance: 'main', kind: 'detail',
      model: 'deepseek-v4.1-flash', sessionId: 'ses_abcdefghijklmnop', input: 1000, cacheRead: 2000,
      output: 300, calls: 1, cost: 0.05, costBasis: 'reported', subscription: false, estimated: false,
    }],
  },
  // 热力图：形状与 src/query.js 的 heatmap() 输出一致（daily 补零铺满、hourly 恒为 7×24）
  heatmap: heatFixture(),
  subscriptions: subFixture(),
}

function heatFixture() {
  const daily = []
  for (let i = 29; i >= 0; i -= 1) {
    const key = new Date(NOW - i * 86400000 + 28800000).toISOString().slice(0, 10)
    const cost = i % 6 === 0 ? 0 : Math.round((1 + (i % 5)) * 37) / 100
    daily.push({
      date: key, label: key.slice(5).replace('-', '/'), dow: new Date(key + 'T00:00:00Z').getUTCDay(),
      cost, realCost: cost, subCost: 0, calls: cost > 0 ? 4 : 0, tokens: 1200, input: 800, output: 400,
      cacheRead: 2000, peak: cost * 0.4, off: cost * 0.6,
    })
  }
  const hourly = []
  for (let dow = 0; dow < 7; dow += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const peakSlot = dow >= 1 && dow <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
      const cost = hour >= 9 && hour <= 20 ? Math.round((hour - 8) * 11) / 100 : 0
      hourly.push({ dow, hour, peakSlot, cost, realCost: cost, subCost: 0, calls: cost > 0 ? 2 : 0, tokens: 300 })
    }
  }
  return {
    ok: true, fromKey: daily[0].date, toKey: daily[daily.length - 1].date, days: daily.length,
    range: '30d', stepDays: 30, daily, hourly,
    byHour: Array.from({ length: 24 }, (_, hour) => ({
      hour, peakHour: (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18),
      cost: hourly.filter((c) => c.hour === hour).reduce((s, c) => s + c.cost, 0),
      realCost: 0, subCost: 0, calls: hour, tokens: 100,
    })),
    byWeekday: Array.from({ length: 7 }, (_, dow) => ({ dow, cost: 1 + dow, calls: 10, tokens: 1000 })),
    summary: {
      cost: 12.34, realCost: 12.34, subCost: 0, calls: 120, tokens: 36000, cacheRead: 60000, input: 24000,
      cacheHitRate: 0.7143, peakCost: 4.94, offCost: 7.4, windowDays: 30, activeDays: 25, streak: 3,
      avgActiveCost: 0.4936, avgDayCost: 0.4113,
      maxDay: { date: daily[10].date, label: daily[10].label, cost: 2.22, calls: 9 },
      maxCell: { dow: 4, hour: 15, cost: 0.77, calls: 5 },
      last7: { days: 7, cost: 3.1, avgCost: 0.4429, calls: 28 },
    },
    asOf: NOW,
  }
}

function subFixture() {
  const byDay = []
  for (let i = 6; i >= 0; i -= 1) {
    const key = new Date(NOW - i * 86400000 + 28800000).toISOString().slice(0, 10)
    byDay.push({
      date: key, label: key.slice(5).replace('-', '/'),
      realCost: 0.2, subCost: 0.35, realCalls: 2, subCalls: 1, realTokens: 900, subTokens: 400, cost: 0.55,
    })
  }
  const items = [
    {
      provider: 'kimi-coding', model: 'k3-256k', key: 'kimi-coding/k3-256k', calls: 8, tokens: 12000,
      input: 4000, output: 2000, cacheRead: 6000, cacheWrite: 0, reasoning: 0, cost: 2.0, share: 0.8,
      estimated: true, firstDay: '2026-08-18', lastDay: byDay[6].date, activeDays: 4, devices: 2, sources: 2,
      lastTs: NOW - 3600000, idleDays: 0, avgPerActiveDay: 0.5,
    },
    {
      provider: 'kimi-coding', model: 'k3', key: 'kimi-coding/k3', calls: 2, tokens: 1000,
      input: 400, output: 200, cacheRead: 400, cacheWrite: 0, reasoning: 0, cost: 0.5, share: 0.2,
      estimated: true, firstDay: '2026-07-01', lastDay: '2026-08-24', activeDays: 1, devices: 1, sources: 1,
      lastTs: NOW - 20 * 86400000, idleDays: 20, avgPerActiveDay: 0.5,
    },
  ]
  return {
    ok: true, source: 'cloud', fromKey: byDay[0].date, toKey: byDay[6].date, range: '7d',
    totals: {
      realCost: 1.4, subCost: 2.5, cost: 3.9, realCalls: 14, subCalls: 7, calls: 21,
      realTokens: 6300, subTokens: 2800, tokens: 9100, subShare: 0.641, planCount: 2,
    },
    items,
    byDevice: [
      { deviceId: 'dev-1', deviceName: '台式机', source: 'dsh', provider: 'kimi-coding', model: 'k3-256k', key: 'kimi-coding/k3-256k', calls: 6, tokens: 9000, cost: 1.5, lastDay: byDay[6].date },
      { deviceId: 'dev-2', deviceName: '笔记本', source: 'zcode', provider: 'kimi-coding', model: 'k3', key: 'kimi-coding/k3', calls: 2, tokens: 1000, cost: 0.5, lastDay: '2026-08-24' },
    ],
    byDay,
    byMonth: [{ month: byDay[0].date.slice(0, 7), label: '26-09', realCost: 1.4, subCost: 2.5, realCalls: 14, subCalls: 7, subTokens: 2800, cost: 3.9 }],
    recent: [{
      ts: NOW - 3600000, date: byDay[6].date, device: 'dev-1', deviceName: '台式机', source: 'dsh',
      provider: 'kimi-coding', model: 'k3-256k', sessionId: 'kimi-session-1', calls: 1, cost: 0.4, estimated: true, tokens: 3000,
    }],
    plans: { 'kimi-coding': { input: 6.5, output: 27, cacheRead: 1.1, cacheWrite: 1.1 } },
    peakWindows: '周一至周五 9:00-12:00 · 14:00-18:00',
    asOf: NOW,
  }
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
test('app.js: 逐个点击 10 个导航项，每个视图都要发请求且渲染出内容', async () => {
  const { root } = dom
  const labels = byClass(root, 'nav-item').map((n) => n.textContent)
  assert.equal(labels.length, 10, '应有 10 个导航项，实际：' + JSON.stringify(labels))

  const { state } = await import(STATE_URL)
  const problems = []
  for (let i = 0; i < labels.length; i += 1) {
    const before = log.length
    byClass(root, 'nav-item')[i].click() // 每次都重新取节点：render() 会重建整棵树
    const fired = await waitFor(() => log.length > before)
    await waitFor(() => !/加载中/.test(root.textContent) || /渲染异常/.test(root.textContent))

    const text = root.textContent
    if (!fired) problems.push(labels[i] + '：点击后没有发出任何请求')
    if (/渲染异常/.test(text)) problems.push(labels[i] + '：' + (text.match(/界面渲染异常：[^\n]{0,80}/) || [''])[0])
    if (/加载中/.test(text)) problems.push(labels[i] + '：仍停在「加载中…」')
    if (text.length < 100) problems.push(labels[i] + '：渲染内容过少 ' + JSON.stringify(text))
    // 接口形状漂移探针：字段缺失/类型不符时页面会渲染出这些字样
    if (/undefined|NaN|\[object Object\]/.test(text)) problems.push(labels[i] + '：出现未定义字段 ' + (text.match(/.{0,30}(undefined|NaN|\[object Object\]).{0,30}/) || [''])[0])
  }
  assert.deepEqual(problems, [], '视图问题：\n' + problems.join('\n'))
  assert.equal(state.view, 'settings', '循环结束后应停在最后一个视图')

  // 视图高亮跟随
  assert.match(byClass(root, 'nav-item')[9].className, /(^|\s)on(\s|$)/)
})

test('app.js: 各视图都渲染出真实数据（不是空壳）', async () => {
  const { root } = dom
  // 顺序与 VIEWS 一致：概览 / 热力图 / 趋势 / 订阅服务 / 设备×Agent / 设备 / 模型 / 记录 / 监控 / 设置
  const EXPECT = [
    [/区间按量花费/, /¥1\.73/],
    [/日历热力图 · 花费/, /近 30 天/],
    [/花费趋势/, /09-1[3-5]/],   // 按天粒度只显示 MM-DD（labelSlice=5）
    [/订阅套餐明细/, /kimi-coding\/k3-256k/],
    [/设备 × Agent 矩阵/, /台式机/],
    [/设备清单（2）/, /zcode/],
    [/模型用量与花费/, /deepseek-v4\.1-flash/],
    [/记录明细/, /ses_abcdefghij/],
    [/设备 × Agent 同步新鲜度/, /时钟偏差|新鲜度/],
    [/服务信息/, /scrypt|单价表来源|共享引导令牌/],
  ]
  for (let i = 0; i < EXPECT.length; i += 1) {
    byClass(root, 'nav-item')[i].click()
    const [title, value] = EXPECT[i]
    const ok = await waitFor(() => title.test(root.textContent) && value.test(root.textContent))
    assert.ok(ok, '第 ' + (i + 1) + ' 个视图未渲染出预期内容：' + root.textContent.slice(0, 200))
  }
})

test('app.js: 设置页明文回显共享引导令牌（不再只说「已设置」）', async () => {
  const { root } = dom
  byClass(root, 'nav-item')[9].click() // 设置
  assert.ok(await waitFor(() => /服务信息/.test(root.textContent)), '设置页应渲染')
  const text = root.textContent
  assert.match(text, /共享引导令牌dshc_fixture_shared_bootstrap_token_01/,
    '设置页必须明文显示共享引导令牌；实际：' + (text.match(/共享引导令牌.{0,40}/) || [''])[0])
  assert.doesNotMatch(text, /共享引导令牌未设置/, '已配置令牌时不得再显示「未设置」')
})

test('app.js: 概览的今日 / 本月 / 全部累计卡片读到切片金额（real 字段，不是 ¥0.0000）', async () => {
  const { root } = dom
  byClass(root, 'nav-item')[0].click() // 概览
  assert.ok(await waitFor(() => /全部累计/.test(root.textContent)), '概览应渲染')
  const text = root.textContent
  assert.match(text, /今日（北京）¥0\.3300/, '今日切片应显示 0.33；实际：' + (text.match(/今日（北京）[^本]{0,20}/) || [''])[0])
  assert.match(text, /本月（北京）¥1\.73/, '本月切片应显示 1.73')
  assert.match(text, /全部累计¥1\.73/, '全部切片应显示 1.73')
  assert.doesNotMatch(text, /(今日（北京）|本月（北京）|全部累计)¥0\.0000/, '切片不得退化成 0.0000（字段名读错时会这样）')
})

test('app.js: 热力图渲染出日历格与 7×24 时段格，点格子能下钻到当天记录', async () => {
  const { root } = dom
  byClass(root, 'nav-item')[1].click() // 热力图
  assert.ok(await waitFor(() => /日历热力图/.test(root.textContent)), '热力图应渲染')

  const cells = byClass(root, 'heat-cell').filter((n) => n.dataset && n.dataset.date)
  assert.ok(cells.length >= 30, '日历热力图应有 ≥30 个可点击格子，实际 ' + cells.length)
  const hg = byClass(root, 'hg-cell')
  assert.equal(hg.length, 168, '星期×小时应有 168 格，实际 ' + hg.length)
  assert.ok(hg.some((c) => /(^|\s)pk(\s|$)/.test(c.className)), '高峰计价时段应有 pk 标记')

  // 点一个格子 → 自定义区间（from/to）→ 记录页
  const before = log.length
  const grid = byClass(root, 'heat-grid')[0]
  grid.dispatch('click', { target: cells[5] })
  const hit = await waitFor(() => log.slice(before).some((u) => /records\?.*from=/.test(u)))
  assert.ok(hit, '点格子后应带 from/to 拉记录；新增请求：' + JSON.stringify(log.slice(before)))

  const { state } = await import(STATE_URL)
  assert.equal(state.view, 'records')
  assert.equal(state.range, 'custom')
})

test('app.js: 订阅页把订阅与按量分开呈现', async () => {
  const { root } = dom
  byClass(root, 'nav-item')[3].click() // 订阅服务
  assert.ok(await waitFor(() => /订阅等效费用/.test(root.textContent)), '订阅页应渲染')
  const text = root.textContent
  assert.match(text, /订阅等效费用/)
  assert.match(text, /¥2\.50/, '订阅等效金额')
  assert.match(text, /¥1\.40/, '按量金额')
  assert.match(text, /64\.1%/, '订阅占比（subShare）')
  assert.match(text, /套餐单价表/, '应展示等效费用的折算依据')
  assert.match(text, /闲置/, '应有订阅闲置监控')
})

test('app.js: 监控页给出告警与阈值设置，并带出真实告警内容', async () => {
  const { root } = dom
  byClass(root, 'nav-item')[8].click() // 监控
  assert.ok(await waitFor(() => /阈值与预算/.test(root.textContent)), '监控页应渲染')
  const text = root.textContent
  assert.match(text, /同步新鲜度/)
  assert.match(text, /时钟偏差/)
  // 样本里 kimi-coding/k3 已闲置 20 天（阈值 14）→ 必须报出来
  assert.match(text, /订阅套餐 kimi-coding\/k3 已 20 天未使用/)
  // 样本里台式机时钟偏差 20 分钟（阈值 300 秒）→ 必须报出来
  assert.match(text, /时钟偏差 1200 秒/)
  const prefs = byClass(root, 'pref')
  assert.ok(prefs.length >= 8, '应渲染阈值输入项，实际 ' + prefs.length)
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
