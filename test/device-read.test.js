// ============================================================
// 采集端只读查询：/api/v1/overview | matrix | devices（设备令牌鉴权）
//
// 背景：插件（@angelyeye/dsh-cost-tracker）手里只有设备令牌 / 共享引导令牌，
// 而 /api/admin/* 只认管理员会话 cookie —— 所以「仅云端 / 本机+云端」拿不到数据。
// 这里新增一组**只读**接口给采集端读聚合，管理面（写、配置、令牌、审计）不放开。
//
// 断言：
//   ① 设备令牌可读 overview / matrix / devices，且与管理员会话口径**逐项一致**
//   ② excludeDevice / union 语义在设备令牌这条路上同样生效（插件「本机+云端」依赖它）
//   ③ 缺令牌 / 错令牌 → 401；管理员接口仍拒绝设备令牌
//   ④ ALLOW_DEVICE_READ=0 时返回 403，而管理员会话不受影响
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { listen } from '../src/server.js'
import { testConfig, tmpDir, addDevice, rec, ingestDirect } from './helpers.js'

const T0 = Date.UTC(2026, 8, 12, 5, 0, 0)
const SHARED = 'shared-bootstrap-token-0123456789'

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
      // Windows 上 node:sqlite 的文件句柄在 close() 后短暂残留，立即 rmSync 会 EPERM。
      // 用 Node 自带的重试退避兜住，且**清理失败不得让用例判红**（它是拆除动作，
      // 与被测行为无关；临时目录由系统回收）。
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch (e) {}
    },
  }
}

const devGet = async (url, token, path) => {
  const r = await fetchRetry(url + '/api/v1/' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} })
  return { status: r.status, body: await r.json() }
}
const adminGet = async (url, cookie, path) => {
  const r = await fetchRetry(url + '/api/admin/' + path, { headers: cookie ? { cookie } : {} })
  return { status: r.status, body: await r.json() }
}

/**
 * 连接层重试一次。
 * 同文件里先后启动/关闭多个服务实例时，undici 的 keep-alive 池可能复用上一个**已关闭**
 * 服务的 socket，表现为 ECONNRESET —— 与服务端逻辑无关（同一请求单独跑返回 200，已用探针确认）。
 * 只对连接层错误重试，HTTP 状态码一律按原样断言，不会掩盖业务问题。
 */
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

/** 两台设备各上报一条：A=1.5、B=0.5，合计 2.0 */
function seed(app) {
  const tokenA = addDevice(app, 'machine-A', '办公台式机')
  const tokenB = addDevice(app, 'machine-B', '笔记本')
  ingestDirect(app, { token: tokenA, deviceId: 'machine-A', source: 'dsh', records: [rec({ ts: T0, cost: 1.5 })] })
  ingestDirect(app, { token: tokenB, deviceId: 'machine-B', source: 'dsh', records: [rec({ ts: T0 + 1000, cost: 0.5, sessionId: 's2' })] })
  return { tokenA, tokenB }
}

test('设备令牌可读只读聚合，且与管理员会话口径逐项一致', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)
    const cookie = await adminCookie(s.url)

    const admin = await adminGet(s.url, cookie, 'overview?range=all')
    const dev = await devGet(s.url, tokenA, 'overview?range=all')
    assert.equal(dev.status, 200)
    assert.equal(dev.body.ok, true)
    assert.equal(dev.body.summary.cost, admin.body.summary.cost, '总花费口径一致')
    assert.equal(dev.body.summary.calls, admin.body.summary.calls, '调用次数口径一致')
    assert.equal(dev.body.devices.length, admin.body.devices.length, '设备维度一致')
    assert.equal(dev.body.sources.length, admin.body.sources.length, '来源维度一致')

    const devMx = await devGet(s.url, tokenA, 'matrix?range=all')
    const adminMx = await adminGet(s.url, cookie, 'matrix?range=all')
    assert.equal(devMx.status, 200)
    assert.deepEqual(devMx.body.cols, adminMx.body.cols)
    assert.deepEqual(devMx.body.rows, adminMx.body.rows)

    const devDims = await devGet(s.url, tokenA, 'devices')
    assert.equal(devDims.status, 200)
    assert.equal(devDims.body.ok, true)
    assert.equal(devDims.body.devices.length, 2)

    // 共享引导令牌同样可读（采集端首次接入时用的就是它）
    const boot = await devGet(s.url, SHARED, 'overview?range=all')
    assert.equal(boot.status, 200)
    assert.equal(boot.body.summary.cost, admin.body.summary.cost)
  } finally { await s.close() }
})

test('excludeDevice 与 union 在设备令牌路径上同样生效（插件「本机+云端」依赖）', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)

    const excl = await devGet(s.url, tokenA, 'overview?range=all&excludeDevice=machine-A')
    assert.equal(excl.status, 200)
    assert.ok(Math.abs(excl.body.summary.cost - 0.5) < 1e-9, '排除 A 后只剩 B=0.5')

    // 本机(1.5) + 排除本机(0.5) = 全网 2.0
    const union = [{ excludeDevice: 'machine-A' }]
    const merged = await devGet(s.url, tokenA, 'overview?range=all&union=' + encodeURIComponent(JSON.stringify(union)))
    assert.equal(merged.status, 200)
    assert.ok(Math.abs(merged.body.summary.cost + 1.5 - 2.0) < 1e-9, '并集口径相加等于全网')
  } finally { await s.close() }
})

test('鉴权：缺令牌/错令牌 401，管理员面仍不认设备令牌', async () => {
  const s = await boot()
  try {
    const { tokenA } = seed(s.app)

    const none = await devGet(s.url, '', 'overview')
    assert.equal(none.status, 401)
    assert.equal(none.body.code, 'TOKEN_MISSING')

    const bad = await devGet(s.url, 'not-a-real-token-0123456789', 'overview')
    assert.equal(bad.status, 401)
    assert.equal(bad.body.code, 'TOKEN_INVALID')

    // 设备令牌不得越权到管理面（读配置里含共享令牌明文，必须挡住）
    const cfg = await fetchRetry(s.url + '/api/admin/config', { headers: { authorization: 'Bearer ' + tokenA } })
    assert.equal(cfg.status, 401, '管理接口不接受设备令牌')
    const dev = await fetchRetry(s.url + '/api/admin/devices', { headers: { authorization: 'Bearer ' + tokenA } })
    assert.equal(dev.status, 401)
  } finally { await s.close() }
})

test('ALLOW_DEVICE_READ=0：设备只读接口 403，管理员会话不受影响', async () => {
  const s = await boot({ ALLOW_DEVICE_READ: '0' })
  try {
    const { tokenA } = seed(s.app)
    const off = await devGet(s.url, tokenA, 'overview')
    assert.equal(off.status, 403)
    assert.equal(off.body.code, 'DEVICE_READ_DISABLED')

    const cookie = await adminCookie(s.url)
    const admin = await adminGet(s.url, cookie, 'overview?range=all')
    assert.equal(admin.status, 200)
    assert.equal(admin.body.ok, true)
  } finally { await s.close() }
})
