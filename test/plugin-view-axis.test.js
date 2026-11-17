// ============================================================
// plugin-view 日期轴必须跟随「实际过滤区间」回归测试
//   node --test test/plugin-view-axis.test.js
//
// 拦的缺陷（2026-11-17 修复）：
//   pluginView() 铺日期轴时只看 params.days，而插件走 from/to 自定义区间
//   （「今天 / 近 14 天 / 近 30 天」都这么传）时 params.days 为空，于是:
//
//     const days = ... : 7          // 默认 7 天
//     const cutoff = now - 7 * DAY  // 与传入的 from/to 无关
//     dates = [cutoff ... now]      // 日期轴只有 7 天
//
//   而总额走的是 buildWhere(params)（含正确 from/to）→ **金额对、按天错**。
//   实测现象：本机设备总额 ¥1174，byDay 却只有 6 天、最早 11/10。
// ============================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { listen } from '../src/server.js'
import { testConfig, tmpDir, addDevice, rec, ingestDirect } from './helpers.js'

const DAY = 86400000
// 三条记录分散在 40 天区间内
const D_OLD = Date.now() - 35 * DAY
const D_MID = Date.now() - 20 * DAY
const D_NEW = Date.now() - 2 * DAY

async function boot() {
  const dir = tmpDir()
  const config = testConfig(dir, {
    DSH_SYNC_TOKEN: 'shared-bootstrap-token-0123456789',
    ALLOW_DEVICE_SELF_REGISTER: '1',
    HOST: '127.0.0.1',
    PORT: '0',
  })
  const { server, app, url } = await listen(config, { log: () => {} })
  const token = addDevice(app, 'machine-A', '测试机')
  ingestDirect(app, {
    token, deviceId: 'machine-A', source: 'dsh',
    records: [
      rec({ ts: D_OLD, cost: 10, sessionId: 'o' }),
      rec({ ts: D_MID, cost: 20, sessionId: 'm' }),
      rec({ ts: D_NEW, cost: 30, sessionId: 'n' }),
    ],
  })
  return {
    url, token,
    close: async () => {
      if (server) server.close()
      try { rmSync(dir, { recursive: true, force: true }) } catch (e) {}
    },
  }
}

async function getJson(url, token, q) {
  const res = await fetch(url + q, { headers: { authorization: 'Bearer ' + token } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** 从 plugin-view 的 byDay 里取非零天数与总花费 */
function summarize(body) {
  const days = (body.byDay || []).filter((d) => (d.peak || 0) + (d.off || 0) + (d.flat || 0) > 0)
  const cost = days.reduce((s, d) => s + (d.peak || 0) + (d.off || 0) + (d.flat || 0), 0)
  return { n: days.length, cost, first: days.length ? days[0].date : '' }
}

test('from/to 自定义区间：byDay 必须覆盖整个区间（不能只铺默认 7 天）', async () => {
  const h = await boot()
  try {
    const now = Date.now()
    const from = now - 40 * DAY
    const r = await getJson(h.url, h.token, '/api/v1/plugin-view?from=' + from + '&to=' + now)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const s = summarize(r.body)

    // 三条记录跨 35 天，都必须出现在 byDay 里
    assert.equal(s.n, 3, 'byDay 应含 3 天非零数据，实际 ' + s.n + '（若为 1 说明日期轴只铺了 7 天）')
    assert.ok(Math.abs(s.cost - 60) < 1e-9, '按天合计应为 60，实际 ' + s.cost)
    // 总额与按天合计必须一致（这正是修复前的矛盾点）
    const totalReal = Number(r.body.realCost || 0) + Number(r.body.subEquivalent || 0)
    assert.ok(Math.abs(totalReal - 60) < 1e-6,
      '总额 ' + totalReal + ' 与按天合计 ' + s.cost + ' 必须一致')
  } finally { await h.close() }
})

test('range=all：byDay 从数据实际起点铺起', async () => {
  const h = await boot()
  try {
    const r = await getJson(h.url, h.token, '/api/v1/plugin-view?range=all')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const s = summarize(r.body)
    assert.equal(s.n, 3, 'range=all 应含 3 天，实际 ' + s.n)
    assert.ok(Math.abs(s.cost - 60) < 1e-9, 'range=all 合计应为 60，实际 ' + s.cost)
  } finally { await h.close() }
})

test('days 参数仍按滚动窗口工作（不因修复而回归）', async () => {
  const h = await boot()
  try {
    // 近 5 天：只有 D_NEW（2 天前）在内
    const r = await getJson(h.url, h.token, '/api/v1/plugin-view?days=5')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const s = summarize(r.body)
    assert.equal(s.n, 1, '近 5 天应只有 1 天数据，实际 ' + s.n)
    assert.ok(Math.abs(s.cost - 30) < 1e-9, '近 5 天合计应为 30，实际 ' + s.cost)
  } finally { await h.close() }
})
