// ============================================================
// 看板监控新增接口：/api/admin/heatmap 与 /api/admin/subscriptions
//
// 这两块是「热力图 + 订阅服务」看板的数据源，口径要求：
//   ① 日历格必须**铺满**窗口（缺口补零）—— 否则热力图会缺格子、把没记录的日子挤掉
//   ② 时段格只取明细（ts > 0）：日汇总快照的 ts 可能为 0，落进正午会造出假高峰
//   ③ 订阅与按量分开统计，且 totals.cost = realCost + subCost 恒等
//   ④ 过滤条件（devices / sources / range / days）必须与 overview 口径一致
//   ⑤ 管理端专属：设备令牌访问 /api/admin/* 一律 401
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { listen } from '../src/server.js'
import { testConfig, tmpDir, addDevice, rec, ingestDirect } from './helpers.js'

const BJ = 28800000
const DAY = 86400000
const SHARED = 'shared-bootstrap-token-0123456789'

function bjMidnight(ts) { return Math.floor((ts + BJ) / DAY) * DAY - BJ }
/** 北京时间的「N 天前的 hh:mm」 */
function atBj(daysAgo, hour, min) {
  return bjMidnight(Date.now()) - daysAgo * DAY + hour * 3600000 + (min || 0) * 60000
}
function bjParts(ts) {
  const d = new Date(ts + BJ)
  return { dow: d.getUTCDay(), hour: d.getUTCHours(), day: d.toISOString().slice(0, 10) }
}

async function boot(over) {
  const dir = tmpDir()
  const config = testConfig(dir, Object.assign({
    DSH_SYNC_TOKEN: SHARED, ALLOW_DEVICE_SELF_REGISTER: '1', HOST: '127.0.0.1', PORT: '0',
  }, over || {}))
  const { server, app, url } = await listen(config, { log: () => {} })
  return {
    app, url, config,
    async close() {
      await new Promise((r) => server.close(r))
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch (e) {}
    },
  }
}

async function fetchRetry(url, init) {
  try {
    return await fetch(url, init)
  } catch (e) {
    const code = String((e && e.cause && e.cause.code) || e)
    if (!code.includes('ECONNRESET') && !code.includes('ECONNREFUSED')) throw e
    return await fetch(url, init)
  }
}
async function adminCookie(url) {
  const login = await fetchRetry(url + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  })
  return (login.headers.getSetCookie()[0] || '').split(';')[0]
}
const adminGet = async (url, cookie, path) => {
  const r = await fetchRetry(url + '/api/admin/' + path, { headers: cookie ? { cookie } : {} })
  return { status: r.status, body: await r.json() }
}

/**
 * 造数据：两台设备、三条明细（其中一条订阅）、一条日汇总快照。
 * 明细时间刻意落在两个不同日期的不同时段，便于断言分桶。
 */
function seed(app) {
  addDevice(app, 'machine-A', '办公台式机')
  addDevice(app, 'machine-B', '笔记本')
  const T1 = atBj(1, 10, 30)   // 昨天 10:30（工作日则为高峰时段）
  const T2 = atBj(3, 15, 0)    // 3 天前 15:00
  const T3 = atBj(3, 15, 30)   // 3 天前 15:30（与 T2 同格）
  ingestDirect(app, {
    deviceId: 'machine-A', source: 'dsh', extra: { deviceName: '办公台式机' },
    records: [
      rec({ ts: T1, cost: 0.6, sessionId: 'a1' }),
      rec({ ts: T2, provider: 'kimi-coding', model: 'k3-256k', subscription: true, cost: 1.5, sessionId: 'k1' }),
    ],
  })
  ingestDirect(app, {
    deviceId: 'machine-B', source: 'zcode', extra: { deviceName: '笔记本' },
    records: [rec({ ts: T3, cost: 0.25, sessionId: 'b1' })],
  })
  // 日汇总快照：ts = 0（这正是「时段格必须排除快照」的原因）
  const dayKey = bjParts(T2).day
  ingestDirect(app, {
    deviceId: 'machine-A', source: 'dsh', extra: { deviceName: '办公台式机' },
    rollups: [{
      dayKey, provider: 'deepseek', model: 'deepseek-flash', subscription: false,
      calls: 7, tokens: { input: 1000, output: 500, cacheRead: 0 }, cost: 3.0,
    }],
  })
  return { T1, T2, T3, dayKey, total: 0.6 + 1.5 + 0.25 + 3.0 }
}

// ============================================================
// 1. 热力图：日历格铺满 + 与 overview 口径一致
// ============================================================
test('heatmap: 日历格铺满窗口，缺口补零且与 overview 总额自洽', async () => {
  const h = await boot()
  try {
    const seedInfo = seed(h.app)
    const cookie = await adminCookie(h.url)

    const hm = (await adminGet(h.url, cookie, 'heatmap?range=30d')).body
    assert.equal(hm.ok, true)
    // range=30d 是滚动 30×24h 窗口，按日边界扩展后 = 31 个**完整**日历天
    // （首日不足 24 小时也算一格，保证格子里真的是「一整天」；看板自身走 days=NN）
    assert.equal(hm.daily.length, 31, '滚动窗口按日边界扩展后应铺满 31 格')
    assert.equal(hm.summary.windowDays, hm.daily.length)
    assert.equal(hm.toKey, bjParts(Date.now()).day, '末日必须是今天（北京）')
    assert.equal(hm.byHour.length, 24)
    assert.equal(hm.byWeekday.length, 7)
    assert.equal(hm.hourly.length, 168, '星期×小时必须恒为 7×24')

    // 有记录的日子在轴上，且金额对得上
    const d1 = hm.daily.find((d) => d.date === bjParts(seedInfo.T1).day)
    const d3 = hm.daily.find((d) => d.date === bjParts(seedInfo.T2).day)
    assert.equal(d1.cost, 0.6, '第 1 天的花费')
    assert.equal(d3.cost, 4.75, '第 3 天 = 明细 0.25 + 订阅 1.5 + 快照 3.0')
    assert.equal(d3.subCost, 1.5, '订阅单独成列')
    assert.equal(d3.realCost, 3.25, '按量 = 明细 0.25 + 快照 3.0')

    // 空格必须存在（这段区间里只有 2 天有数据）
    assert.ok(hm.daily.filter((d) => d.calls === 0 && d.cost === 0).length >= 25, '缺口要被补成空格')

    // 与 overview 同口径：窗口总额一致
    const ov = (await adminGet(h.url, cookie, 'overview?range=30d')).body
    assert.equal(hm.summary.cost, ov.summary.cost, '热力图窗口合计必须等于 overview 的 cost')
    assert.equal(hm.summary.realCost, ov.summary.realCost)
    assert.equal(hm.summary.subCost, ov.summary.subEquivalent)
    assert.equal(hm.summary.calls, ov.summary.calls)

    assert.equal(hm.summary.maxDay.cost, 4.75)
    assert.equal(hm.summary.activeDays, 2)
    assert.equal(hm.summary.last7.days, 7)
  } finally { await h.close() }
})

test('heatmap: 时段格只收明细（ts>0），日汇总快照不得落进正午造出假高峰', async () => {
  const h = await boot()
  try {
    const seedInfo = seed(h.app)
    const cookie = await adminCookie(h.url)
    const hm = (await adminGet(h.url, cookie, 'heatmap?range=30d')).body

    const p1 = bjParts(seedInfo.T1)
    const cell1 = hm.hourly.find((c) => c.dow === p1.dow && c.hour === 10)
    assert.ok(cell1, '必须存在该星期×小时格')
    assert.equal(cell1.cost, 0.6, '昨天 10:30 的明细应落在 10 点格')
    assert.equal(cell1.calls, 1)

    const p2 = bjParts(seedInfo.T2)
    const cell2 = hm.hourly.find((c) => c.dow === p2.dow && c.hour === 15)
    assert.equal(cell2.cost, 1.75, '同格的两条明细（1.5 + 0.25）应合并')

    const detailTotal = 0.6 + 1.5 + 0.25
    const gridTotal = Math.round(hm.hourly.reduce((s, c) => s + c.cost, 0) * 10000) / 10000
    assert.equal(gridTotal, detailTotal, '时段格合计 = 明细合计（快照 3.0 被排除）')
    assert.equal(hm.summary.cost, detailTotal + 3.0, '但日历格仍包含快照')

    // 高峰时段：工作日 09-12 / 14-18 共 5×7 = 35 格
    assert.equal(hm.hourly.filter((c) => c.peakSlot).length, 35, '高峰格数应为 5 天 × 7 小时')
    assert.equal(cell1.peakSlot, p1.dow >= 1 && p1.dow <= 5, '10 点在工作日算高峰、周末不算')
    assert.equal(hm.hourly.find((c) => c.dow === 0 && c.hour === 10).peakSlot, false, '周日全天空闲')
    assert.equal(hm.hourly.find((c) => c.dow === 1 && c.hour === 12).peakSlot, false, '12 点不算高峰')
  } finally { await h.close() }
})

test('heatmap: days=90 / range=all 的窗口语义', async () => {
  const h = await boot()
  try {
    seed(h.app)
    const cookie = await adminCookie(h.url)

    const d90 = (await adminGet(h.url, cookie, 'heatmap?days=90')).body
    assert.equal(d90.daily.length, 90, 'days=90 必须铺满 90 格')
    assert.equal(d90.stepDays, 90)
    assert.equal(d90.daily[d90.daily.length - 1].date, bjParts(Date.now()).day, '末日必须是今天（北京）')

    const all = (await adminGet(h.url, cookie, 'heatmap?range=all')).body
    assert.equal(all.fromKey, bjParts(atBj(3, 15, 0)).day, 'range=all 的起点 = 数据最早一天')
    assert.ok(all.daily.length >= 4 && all.daily.length <= 5)

    // 过滤条件同样生效
    const onlyA = (await adminGet(h.url, cookie, 'heatmap?range=30d&devices=machine-A')).body
    assert.equal(onlyA.summary.cost, 0.6 + 1.5 + 3.0, 'devices 过滤必须落到热力图')
    const onlySub = (await adminGet(h.url, cookie, 'heatmap?range=30d&sources=zcode')).body
    assert.equal(onlySub.summary.cost, 0.25)
  } finally { await h.close() }
})

// ============================================================
// 2. 订阅服务看板
// ============================================================
test('subscriptions: 订阅与按量分开统计，恒等式与占比自洽', async () => {
  const h = await boot()
  try {
    const seedInfo = seed(h.app)
    const cookie = await adminCookie(h.url)
    const s = (await adminGet(h.url, cookie, 'subscriptions?range=30d')).body

    assert.equal(s.ok, true)
    assert.equal(s.totals.realCost, 0.6 + 0.25 + 3.0)
    assert.equal(s.totals.subCost, 1.5, '订阅等效费用')
    assert.equal(s.totals.cost, seedInfo.total, 'totals.cost = realCost + subCost')
    assert.equal(Math.round(s.totals.subShare * 1000) / 1000, Math.round(1.5 / seedInfo.total * 1000) / 1000)
    assert.equal(s.totals.planCount, 1)

    assert.equal(s.items.length, 1)
    const it = s.items[0]
    assert.equal(it.key, 'kimi-coding/k3-256k')
    assert.equal(it.cost, 1.5)
    assert.equal(it.share, 1, '唯一套餐的占比为 1')
    assert.equal(it.devices, 1)
    assert.equal(it.activeDays, 1)
    assert.equal(it.idleDays, 3, '3 天前用过 → 闲置 3 天')
    assert.equal(it.firstDay, bjParts(seedInfo.T2).day)
    assert.equal(it.lastDay, bjParts(seedInfo.T2).day)

    // 按设备 / 按月 / 最近记录
    assert.equal(s.byDevice.length, 1)
    assert.equal(s.byDevice[0].source, 'dsh')
    assert.equal(s.byDevice[0].deviceName, '办公台式机', '设备名要来自 devices 表而不是裸 ID')
    const sep = bjParts(seedInfo.T2).day.slice(0, 7)
    const month = s.byMonth.find((m) => m.month === sep)
    assert.ok(month, '按月轴里应有本月')
    assert.equal(month.subCost, 1.5)
    assert.equal(month.realCost, 3.85)
    assert.equal(s.recent.length, 1)
    assert.equal(s.recent[0].model, 'k3-256k')

    // 等效费用的折算依据（套餐单价表）必须一并下发
    assert.ok(s.plans['kimi-coding'], '订阅单价表应包含 kimi-coding')
    assert.equal(s.plans['kimi-coding'].input, 6.5)
    // 按天轴：订阅与按量两条序列都对得上
    const day3 = s.byDay.find((d) => d.date === bjParts(seedInfo.T2).day)
    assert.equal(day3.subCost, 1.5)
    assert.equal(day3.realCost, 3.25, '按量 = 明细 0.25 + 快照 3.0')
    assert.equal(day3.cost, 4.75)
  } finally { await h.close() }
})

test('subscriptions: 过滤条件与 overview 同口径（设备 / 来源 / 区间）', async () => {
  const h = await boot()
  try {
    seed(h.app)
    const cookie = await adminCookie(h.url)

    const onlyB = (await adminGet(h.url, cookie, 'subscriptions?range=30d&devices=machine-B')).body
    assert.equal(onlyB.totals.subCost, 0, 'B 机没有订阅记录')
    assert.equal(onlyB.totals.realCost, 0.25)
    assert.equal(onlyB.items.length, 0)

    const onlySub = (await adminGet(h.url, cookie, 'subscriptions?range=30d&sources=dsh')).body
    assert.equal(onlySub.totals.subCost, 1.5)
    assert.equal(onlySub.totals.realCost, 3.6)

    // 区间收窄到「今天」时，几天前的数据必须落空
    const today = (await adminGet(h.url, cookie, 'subscriptions?range=today')).body
    assert.equal(today.totals.cost, 0)
    assert.equal(today.byDay.length, 1, '今天的日轴只有 1 格')

    // 与 overview 的三切片口径对齐
    const ov = (await adminGet(h.url, cookie, 'overview?range=30d&sources=dsh')).body
    assert.equal(onlySub.totals.realCost, ov.summary.realCost)
    assert.equal(onlySub.totals.subCost, ov.summary.subEquivalent)
  } finally { await h.close() }
})

// ============================================================
// 3. overview 的上期（环比）切片
// ============================================================
test('overview: 上期（环比）切片取等长紧邻窗口', async () => {
  const h = await boot()
  try {
    addDevice(h.app, 'machine-A', '办公台式机')
    ingestDirect(h.app, { deviceId: 'machine-A', source: 'dsh', records: [rec({ ts: Date.now() - 3600000, cost: 1.0, sessionId: 'cur' })] })
    ingestDirect(h.app, { deviceId: 'machine-A', source: 'dsh', records: [rec({ ts: Date.now() - 8 * DAY, cost: 2.0, sessionId: 'prev' })] })
    ingestDirect(h.app, { deviceId: 'machine-A', source: 'dsh', records: [rec({ ts: Date.now() - 20 * DAY, cost: 9.0, sessionId: 'old' })] })
    const cookie = await adminCookie(h.url)

    const ov = (await adminGet(h.url, cookie, 'overview?range=7d')).body
    assert.equal(ov.summary.realCost, 1.0, '当前 7 天窗口')
    assert.equal(ov.summary.prevHas, 1)
    assert.equal(ov.summary.prevRealCost, 2.0, '上期 = 再往前 7 天（8 天前那条）')
    assert.equal(ov.summary.prevRealCalls, 1)

    // range=all 没有上期
    const all = (await adminGet(h.url, cookie, 'overview?range=all')).body
    assert.equal(all.summary.prevHas, 0)
    assert.equal(all.summary.prevRealCost, 0)
  } finally { await h.close() }
})

// ============================================================
// 5. 火山方舟 Coding Plan 在看板上的可见性（v1.4.1 回归）
// ============================================================
// 真实现场：用户本地 provider 名是自定的 `byteblus-coding-plan-cn`，云端**确实收到了**
// 183 条订阅记录，但看板「订阅服务」页的套餐单价表只列了 kimi —— 既看不到火山套餐的
// 等效单价说明，provider 又只显示原始字符串，于是用户以为「云端没有火山订阅的上报」。
// 这组断言守住三件事：① 订阅 payload 带完整套餐说明；② 火山记录带人话标签；
// ③ priceSnapshot 暴露火山的等效单价表。
test('subscriptions: 火山方舟 Coding Plan 必须可见（套餐说明 + provider 别名 + 单价表）', async () => {
  const h = await boot()
  try {
    const token = addDevice(h.app, 'machine-volc', '火山测试机')
    const bytedance = h.app.ingest.registerDevice({ deviceId: 'machine-volc', deviceName: '火山测试机', source: 'dsh' }).token
    const T = atBj(1, 14, 0)
    // 专属 Coding 端点（整档订阅）: provider 由用户自定，云端不得靠名字猜，只能靠上报的 subscription 标记
    ingestDirect(h.app, {
      token: bytedance, deviceId: 'machine-volc', source: 'dsh',
      records: [
        rec({ ts: T, provider: 'byteblus-coding-plan-cn', model: 'glm-5-3-flash-260828', subscription: true, cost: 0.5, tokens: { input: 100000, output: 5000, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }),
        rec({ ts: T + 60000, provider: 'byteblus-coding-plan-cn', model: 'deepseek-v4-1-flash-260910', subscription: true, cost: 0.25, tokens: { input: 50000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }),
      ],
    })
    void token
    const cookie = await adminCookie(h.url)
    const s = (await adminGet(h.url, cookie, 'subscriptions?range=30d')).body

    // ① 订阅记录确实进来了，并且与按量分开
    assert.equal(s.totals.subCalls, 2, '两条火山订阅记录应计入订阅调用')
    assert.equal(s.totals.subCost, 0.75)
    assert.equal(s.totals.realCalls, 0)
    const volc = s.items.filter((x) => x.provider === 'byteblus-coding-plan-cn')
    assert.equal(volc.length, 2, '两个火山模型都应在订阅明细里')
    // ② provider 别名 → 人话（用户认得出这是火山方舟）
    assert.match(String(volc[0].providerLabel), /火山方舟/, '订阅明细要带人话套餐名：' + JSON.stringify(volc[0].providerLabel))
    assert.ok(s.byDevice.every((x) => /火山方舟/.test(String(x.providerLabel))), '按设备维度同样要带标签')
    assert.ok(s.recent.every((x) => /火山方舟/.test(String(x.providerLabel))), '最近订阅记录同样要带标签')

    // ③ 套餐单价表：kimi 与火山都在，火山带 provider 别名与白名单模型数
    assert.ok(Array.isArray(s.subscriptionPlans) && s.subscriptionPlans.length >= 2, '应下发完整套餐说明')
    const kimiPlan = s.subscriptionPlans.find((p) => p.id === 'kimi-coding')
    const volcPlan = s.subscriptionPlans.find((p) => p.id === 'volcengine-coding-plan')
    assert.ok(kimiPlan && volcPlan, 'kimi 与火山套餐都要在：' + JSON.stringify(s.subscriptionPlans.map((p) => p.id)))
    assert.equal(volcPlan.rates.input, 3.0, '火山等效单价来自 pricing.js 的 VOLCENGINE_PLAN_RATES')
    assert.ok(volcPlan.providers.includes('byteblus-coding-plan-cn'), '火山套餐要列出专属端点的 provider 别名')
    assert.ok(volcPlan.models.length > 0, '火山套餐要给出白名单模型数')

    // priceSnapshot 本身（管理端 /prices 与 /api/v1/protocol 都读它）也要暴露
    const prices = (await adminGet(h.url, cookie, 'prices')).body.prices
    assert.ok(Array.isArray(prices.subscriptionPlans) && prices.subscriptionPlans.length >= 2, 'priceSnapshot 应含 subscriptionPlans')
    // protocol（无需鉴权）同样能看到 —— 采集端据此自查口径
    const proto = await fetchRetry(h.url + '/api/v1/protocol')
    const pb = await proto.json()
    assert.ok(Array.isArray(pb.pricing && pb.pricing.subscriptionPlans), '/api/v1/protocol 应回显套餐说明')
  } finally { await h.close() }
})

// ============================================================
// 6. 管理端专属：设备令牌不得读新接口
// ============================================================
test('heatmap/subscriptions: 仅供管理端（设备令牌 401，未登录 401）', async () => {  const h = await boot()
  try {
    seed(h.app)
    for (const path of ['heatmap?range=30d', 'subscriptions?range=30d']) {
      const anon = await adminGet(h.url, '', path)
      assert.equal(anon.status, 401, path + ' 未登录必须 401')

      const dev = await fetchRetry(h.url + '/api/admin/' + path, { headers: { authorization: 'Bearer ' + SHARED } })
      assert.equal(dev.status, 401, path + ' 设备令牌必须 401（管理端专属）')
    }
    // 对照：设备令牌可以读插件形状的只读聚合
    const ok = await fetchRetry(h.url + '/api/v1/plugin-view?range=7d', { headers: { authorization: 'Bearer ' + SHARED } })
    assert.equal(ok.status, 200)
  } finally { await h.close() }
})
