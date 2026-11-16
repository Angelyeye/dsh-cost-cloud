// ============================================================
// dsh-cost-cloud union 分支区间透传回归测试
//   node --test test/union-range.test.js
//
// 拦的缺陷（2026-11-16 修复）：
//   readOverview / readPluginView 的 union 分支此前只把 range / days 透传给
//   每个 part 的 adminParams()，漏掉了 from / to：
//
//     adminParams(Object.assign({ range: query.range, days: query.days }, p || {}))
//
//   而 adminParams() 内部靠 resolveRange(query) 解析区间，resolveRange 只有在
//   拿到 q.from 时才返回自定义区间。于是 union 分支永远只能按 range 枚举算：
//   插件侧传 from/to 精确区间时，「本机 + 云端」视图的云端部分完全不跟随筛选，
//   而「仅云端」（非 union 路径）却正常 —— 这种「一半对一半错」最难察觉。
// ============================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { listen } from '../src/server.js'
import { testConfig, tmpDir, addDevice, rec, ingestDirect } from './helpers.js'

const DAY = 86400000
// 三条记录落在三个不同日子，用来区分区间是否真的生效
const D_OLD = Date.UTC(2026, 8, 1, 4, 0, 0)   // 9/1
const D_MID = Date.UTC(2026, 8, 10, 4, 0, 0)  // 9/10
const D_NEW = Date.UTC(2026, 8, 20, 4, 0, 0)  // 9/20

async function boot() {
  const dir = tmpDir()
  const config = testConfig(dir, {
    DSH_SYNC_TOKEN: 'shared-bootstrap-token-0123456789',
    ALLOW_DEVICE_SELF_REGISTER: '1',
    HOST: '127.0.0.1',
    PORT: '0',
  })
  const { server, app, url } = await listen(config, { log: () => {} })
  const tokenA = addDevice(app, 'machine-A', '办公台式机')
  ingestDirect(app, {
    token: tokenA, deviceId: 'machine-A', source: 'dsh',
    records: [
      rec({ ts: D_OLD, cost: 1.0, sessionId: 'o1' }),
      rec({ ts: D_MID, cost: 2.0, sessionId: 'm1' }),
      rec({ ts: D_NEW, cost: 4.0, sessionId: 'n1' }),
    ],
  })
  return {
    url,
    tokenA,
    close: async () => {
      if (server) server.close()
      try { rmSync(dir, { recursive: true, force: true }) } catch (e) {}
    },
  }
}

async function getJson(url, token, pathAndQuery) {
  const res = await fetch(url + pathAndQuery, { headers: { authorization: 'Bearer ' + token } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

test('union 分支：from/to 必须透传（区间收窄真的生效，不再固定按 range 枚举）', async () => {
  const h = await boot()
  try {
    const union = [{ excludeDevice: 'machine-NOBODY' }] // 空排除：结果≈全量
    const uq = '&union=' + encodeURIComponent(JSON.stringify(union))

    // 全时段：三天全算 → 1+2+4 = 7.0
    const all = await getJson(h.url, h.tokenA, '/api/v1/overview?range=all' + uq)
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.ok(Math.abs(all.body.summary.cost - 7.0) < 1e-9, 'all 应为 7.0，实得 ' + all.body.summary.cost)

    // 只包 9/10 当天：应只剩 2.0
    const midFrom = D_MID
    const midTo = D_MID + DAY
    const mid = await getJson(h.url, h.tokenA,
      '/api/v1/overview?range=7d&from=' + midFrom + '&to=' + midTo + uq)
    assert.equal(mid.status, 200, JSON.stringify(mid.body))
    assert.ok(Math.abs(mid.body.summary.cost - 2.0) < 1e-9,
      'union + from/to 应收窄到 9/10 的 2.0，实得 ' + mid.body.summary.cost
      + '（若为 7.0 说明 from/to 被 union 分支丢弃）')

    // 9/10 及以后：2.0 + 4.0 = 6.0
    const tail = await getJson(h.url, h.tokenA,
      '/api/v1/overview?range=7d&from=' + midFrom + '&to=' + (D_NEW + DAY) + uq)
    assert.equal(tail.status, 200, JSON.stringify(tail.body))
    assert.ok(Math.abs(tail.body.summary.cost - 6.0) < 1e-9,
      'union + from/to 应为 6.0，实得 ' + tail.body.summary.cost)
  } finally { await h.close() }
})

test('非 union 与 union 两条路必须口径一致（不得漂移）', async () => {
  const h = await boot()
  try {
    const midFrom = D_MID
    const midTo = D_MID + DAY
    const plain = await getJson(h.url, h.tokenA,
      '/api/v1/overview?range=7d&from=' + midFrom + '&to=' + midTo)
    assert.equal(plain.status, 200, JSON.stringify(plain.body))

    const union = [{ excludeDevice: 'machine-NOBODY' }]
    const withUnion = await getJson(h.url, h.tokenA,
      '/api/v1/overview?range=7d&from=' + midFrom + '&to=' + midTo
      + '&union=' + encodeURIComponent(JSON.stringify(union)))
    assert.equal(withUnion.status, 200, JSON.stringify(withUnion.body))

    assert.ok(Math.abs(plain.body.summary.cost - withUnion.body.summary.cost) < 1e-9,
      '非 union=' + plain.body.summary.cost + ' 与 union=' + withUnion.body.summary.cost + ' 必须相等')
  } finally { await h.close() }
})

test('plugin-view union 分支：from/to 同样透传', async () => {
  const h = await boot()
  try {
    const union = [{ excludeDevice: 'machine-NOBODY' }]
    const uq = '&union=' + encodeURIComponent(JSON.stringify(union))

    const all = await getJson(h.url, h.tokenA, '/api/v1/plugin-view?range=all' + uq)
    assert.equal(all.status, 200, JSON.stringify(all.body))
    const allReal = Number(all.body.realCost != null ? all.body.realCost : (all.body.all && all.body.all.real) || 0)
    assert.ok(Math.abs(allReal - 7.0) < 1e-9, 'plugin-view all 应为 7.0，实得 ' + allReal)

    const midFrom = D_MID
    const midTo = D_MID + DAY
    const mid = await getJson(h.url, h.tokenA,
      '/api/v1/plugin-view?range=7d&from=' + midFrom + '&to=' + midTo + uq)
    assert.equal(mid.status, 200, JSON.stringify(mid.body))
    const midReal = Number(mid.body.realCost != null ? mid.body.realCost : (mid.body.all && mid.body.all.real) || 0)
    assert.ok(Math.abs(midReal - 2.0) < 1e-9,
      'plugin-view union + from/to 应为 2.0，实得 ' + midReal + '（若为 7.0 说明 from/to 被丢弃）')
  } finally { await h.close() }
})
