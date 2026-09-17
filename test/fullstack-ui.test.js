// ============================================================
// 全栈联调：真实服务端（真实入库 / 真实 SQL 聚合）+ 真实前端渲染
//
// 与 web-app.test.js 的区别：那里用的是手写的接口样本，可能和 query.js
// 实际返回的形状不一致；这里的数据全部来自真实 ingest + 真实查询，
// 前端拿到的就是线上会拿到的那一份 JSON。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { installDom, byClass, waitFor } from './dom-shim.mjs'
import { makeApp, addDevice, ingestDirect, rec } from './helpers.js'

test('全栈：真实数据下 10 个视图全部渲染成功', async () => {
  const { app, cleanup } = makeApp({ ALLOW_DEVICE_SELF_REGISTER: '1' })
  const server = createServer((req, res) => app.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port
  const realFetch = globalThis.fetch.bind(globalThis)

  try {
    // ---------- 造真实数据：两台机器、三个 agent ----------
    addDevice(app, 'machine-A', '办公台式机')
    addDevice(app, 'machine-B', '笔记本')
    const T0 = Date.now() - 3600000 // 保证落在默认 7d 区间内
    ingestDirect(app, {
      deviceId: 'machine-A', source: 'dsh', extra: { agentInstance: 'main', deviceName: '办公台式机' },
      records: [rec({ ts: T0 + 1000, sessionId: 's1', cost: 0.6 }), rec({ ts: T0 + 2000, sessionId: 's2', cost: 0.4 })],
    })
    ingestDirect(app, {
      deviceId: 'machine-A', source: 'codex', extra: { deviceName: '办公台式机' },
      records: [rec({ ts: T0 + 3000, provider: 'openai', model: 'gpt-5-codex', sessionId: 'c1', cost: 2.5 })],
    })
    ingestDirect(app, {
      deviceId: 'machine-B', source: 'dsh', extra: { deviceName: '笔记本' },
      records: [rec({ ts: T0 + 4000, sessionId: 'b1', cost: 0.75 })],
    })

    // ---------- 登录拿会话 Cookie ----------
    const login = await realFetch(url + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    })
    assert.equal(login.status, 200, '登录应成功')
    const cookie = (login.headers.getSetCookie()[0] || '').split(';')[0]

    // ---------- 真实前端指向真实服务 ----------
    const { root } = installDom()
    const log = []
    globalThis.fetch = async (u, opts) => {
      const target = String(u).startsWith('http') ? String(u) : url + String(u)
      const o = Object.assign({}, opts || {})
      o.headers = Object.assign({}, o.headers || {}, cookie ? { cookie } : {})
      log.push(String(u))
      return realFetch(target, o)
    }

    await import(new URL('../web/app.js', import.meta.url).href + '?fullstack=1')
    assert.ok(await waitFor(() => /区间按量花费/.test(root.textContent)), '数据应加载并渲染出概览')

    // ---------- 概览：真实设备与 Agent 都要出现 ----------
    const overview = root.textContent
    assert.match(overview, /¥/, '概览应显示金额')
    // 切片字段名（real / sub）读错时，这三张卡会全部显示 ¥0.0000：全时段与时间无关，必须非零
    assert.match(overview, /全部累计¥4\.25/, '全部累计切片必须读到真实金额')
    assert.doesNotMatch(overview, /全部累计¥0\.0000/, '切片不得退化成 0.0000')
    byClass(root, 'nav-item')[5].click() // 设备
    assert.ok(await waitFor(() => /设备清单（2）/.test(root.textContent)), '设备页应列出 2 台设备')
    assert.match(root.textContent, /办公台式机/)
    assert.match(root.textContent, /笔记本/)

    // ---------- 记录：两个 Agent 的明细都要在 ----------
    byClass(root, 'nav-item')[7].click()
    assert.ok(await waitFor(() => /记录明细/.test(root.textContent)), '记录页应渲染')
    assert.match(root.textContent, /dsh/)
    assert.match(root.textContent, /codex/)

    // ---------- 模型：真实 provider/model 落表 ----------
    byClass(root, 'nav-item')[6].click()
    assert.ok(await waitFor(() => /deepseek-v4\.1-flash/.test(root.textContent)), '模型页应出现真实模型名')
    assert.match(root.textContent, /gpt-5-codex/)

    // ---------- 热力图：真实数据必须铺满日历格（含没有记录的空格） ----------
    byClass(root, 'nav-item')[1].click()
    assert.ok(await waitFor(() => /日历热力图/.test(root.textContent)), '热力图应渲染')
    {
      const cells = byClass(root, 'heat-cell').filter((n) => n.dataset && n.dataset.date)
      assert.ok(cells.length >= 90, '近 90 天窗口应铺满 ≥90 个日历格，实际 ' + cells.length)
      assert.ok(cells.some((c) => /(^|\s)l[1-4](\s|$)/.test(c.className)), '有花费的日子必须着色')
      assert.equal(byClass(root, 'hg-cell').length, 168, '星期×小时必须恒为 168 格')
      // 真实明细的 ts 落在 1 小时前 → 时段格必须有非零值（证明 ts 分桶真的生效）
      assert.ok(byClass(root, 'hg-cell').some((c) => /(^|\s)l[1-4](\s|$)/.test(c.className)), '时段格应命中真实明细的时间戳')
    }

    // ---------- 订阅页：没有订阅数据时必须给出可行动提示，而不是空白 ----------
    byClass(root, 'nav-item')[3].click()
    assert.ok(await waitFor(() => /订阅等效费用/.test(root.textContent)), '订阅页应渲染')
    assert.match(root.textContent, /没有订阅记录|订阅套餐明细/)

    // ---------- 逐个走完 10 个视图：不允许任何渲染异常或卡加载 ----------
    for (let i = 0; i < 10; i += 1) {
      const before = log.length
      byClass(root, 'nav-item')[i].click()
      await waitFor(() => log.length > before)
      await waitFor(() => !/加载中/.test(root.textContent) || /渲染异常/.test(root.textContent))
      const text = root.textContent
      assert.doesNotMatch(text, /渲染异常/, '第 ' + (i + 1) + ' 个视图渲染异常：' + text.slice(0, 200))
      assert.doesNotMatch(text, /加载中/, '第 ' + (i + 1) + ' 个视图卡在加载中')
      // 接口形状漂移的通用探针：字段缺失/类型不符时页面会渲染出这些字样
      assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/, '第 ' + (i + 1) + ' 个视图出现未定义字段：' + text.slice(0, 200))
    }

    // ---------- 口径漂移提示应出现（上报成本 4.25 vs 云端按 token 重算） ----------
    byClass(root, 'nav-item')[0].click()
    await waitFor(() => /区间按量花费/.test(root.textContent))
    assert.match(root.textContent, /口径漂移提示/, '应显示漂移横幅')
  } finally {
    await new Promise((r) => server.close(r))
    cleanup()
  }
})
