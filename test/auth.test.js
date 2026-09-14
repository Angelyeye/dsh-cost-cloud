// ============================================================
// 鉴权测试：管理员会话 / 设备令牌轮换 / 登录限流
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeApp } from './helpers.js'
import { call, cookieOf } from './http-client.js'
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken, createLoginLimiter, createRateLimiter } from '../src/auth.js'

test('scrypt 口令哈希可验证且拒绝错误口令', () => {
  const h = hashPassword('correct horse battery staple')
  assert.match(h, /^scrypt\$16384\$8\$1\$/)
  assert.ok(verifyPassword('correct horse battery staple', h))
  assert.ok(!verifyPassword('wrong', h))
  assert.ok(!verifyPassword('correct horse battery staple', 'garbage'))
  assert.ok(!verifyPassword('x', ''))
})

test('会话令牌：签名校验、过期失效、篡改失效', () => {
  const secret = 's'.repeat(48)
  const t = createSessionToken(secret, 1000)
  assert.ok(verifySessionToken(secret, t))
  assert.ok(!verifySessionToken('other-secret-other-secret-other-secret', t))
  assert.ok(!verifySessionToken(secret, t + 'x'))
  const payload = t.split('.')[0]
  assert.ok(!verifySessionToken(secret, payload + '.deadbeef'))
  const expired = createSessionToken(secret, -1000)
  assert.equal(verifySessionToken(secret, expired), null)
})

test('登录：错误口令 401；正确口令下发 HttpOnly Cookie 会话', async () => {
  const h = makeApp()
  try {
    const bad = await call(h.app, 'POST', '/api/admin/login', { password: 'nope' })
    assert.equal(bad.status, 401)
    assert.equal(bad.body.code, 'BAD_CREDENTIALS')
    const good = await call(h.app, 'POST', '/api/admin/login', { password: 'test-password' })
    assert.equal(good.status, 200)
    const sc = (good.setCookie || []).join(';')
    assert.match(sc, /dshc_admin=/)
    assert.match(sc, /HttpOnly/)
    assert.match(sc, /SameSite=Strict/)
    const cookie = cookieOf(good)
    const ov = await call(h.app, 'GET', '/api/admin/overview', null, '', cookie)
    assert.equal(ov.status, 200)
    const out = await call(h.app, 'POST', '/api/admin/logout', {}, '', cookie)
    assert.equal(out.status, 200)
    assert.match((out.setCookie || []).join(';'), /Max-Age=0/)
  } finally { h.cleanup() }
})

test('未登录访问管理接口一律 401', async () => {
  const h = makeApp()
  try {
    for (const p of ['overview', 'matrix', 'devices', 'records', 'sync-health', 'config', 'export.csv']) {
      const r = await call(h.app, 'GET', '/api/admin/' + p)
      assert.equal(r.status, 401, p)
      assert.equal(r.body.code, 'UNAUTHORIZED')
    }
  } finally { h.cleanup() }
})

test('登录限流：同 IP 连续失败后触发 429', async () => {
  const h = makeApp()
  try {
    let last = null
    for (let i = 0; i < 8; i += 1) last = await call(h.app, 'POST', '/api/admin/login', { password: 'bad-' + i })
    assert.equal(last.status, 429)
    assert.equal(last.body.code, 'RATE_LIMITED')
    assert.ok(last.body.retryAfterMs > 0)
  } finally { h.cleanup() }
})

test('限流器与登录限流器单元语义', () => {
  const lim = createLoginLimiter({ maxFails: 3, windowMs: 60000 })
  const ip = '1.2.3.4'
  assert.equal(lim.check(ip, 1000).blocked, false)
  lim.fail(ip, 1000); lim.fail(ip, 1001); lim.fail(ip, 1002)
  assert.equal(lim.check(ip, 1003).blocked, true, '达到阈值后立即退避')
  assert.ok(lim.check(ip, 1003).retryAfterMs > 0)
  assert.equal(lim.check(ip, 1000 + 60001).blocked, false, '窗口过后恢复')
  lim.ok(ip)
  assert.equal(lim.check(ip, 1000 + 60002).blocked, false)

  const rl = createRateLimiter(3)
  assert.equal(rl.check('k', 0).allowed, true)
  assert.equal(rl.check('k', 1).allowed, true)
  assert.equal(rl.check('k', 2).allowed, true)
  const over = rl.check('k', 3)
  assert.equal(over.allowed, false)
  assert.ok(over.retryAfterMs > 0)
  assert.equal(rl.check('k', 60001).allowed, true, '一分钟窗口滚动')
})

test('令牌轮换：新令牌可用，被撤销的旧令牌失效', async () => {
  const h = makeApp()
  try {
    const old = h.app.ingest.registerDevice({ deviceId: 'dev-a', deviceName: 'dev-a' }).token
    const { cookie } = await loginRaw(h)
    const rot = await call(h.app, 'POST', '/api/admin/devices/dev-a/rotate-token', {}, '', cookie)
    assert.equal(rot.status, 200)
    const fresh = rot.body.token
    assert.notEqual(fresh, old)
    const useNew = await call(h.app, 'POST', '/api/v1/ingest/heartbeat', { syncVer: 1, source: 'dsh', deviceId: 'dev-a' }, fresh)
    assert.equal(useNew.status, 200)
    const useOld = await call(h.app, 'POST', '/api/v1/ingest/heartbeat', { syncVer: 1, source: 'dsh', deviceId: 'dev-a' }, old)
    assert.equal(useOld.status, 200, '轮换不自动撤销旧令牌（文档承诺）')
    // 手动撤销旧令牌（后台能力）后立刻失效
    const { hashToken } = await import('../src/auth.js')
    h.app.db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?').run(hashToken(old))
    const revoked = await call(h.app, 'POST', '/api/v1/ingest/heartbeat', { syncVer: 1, source: 'dsh', deviceId: 'dev-a' }, old)
    assert.equal(revoked.status, 401)
    assert.equal(revoked.body.code, 'TOKEN_INVALID')
  } finally { h.cleanup() }
})

test('设备改名 / 禁用 / 清空数据的后台操作', async () => {
  const h = makeApp()
  try {
    h.app.ingest.registerDevice({ deviceId: 'dev-a', deviceName: 'old-name' })
    const { cookie } = await loginRaw(h)
    const ren = await call(h.app, 'PATCH', '/api/admin/devices/dev-a', { name: '新名字', nameLocked: true }, '', cookie)
    assert.equal(ren.status, 200)
    assert.equal(ren.body.device.name, '新名字')
    assert.equal(ren.body.device.nameLocked, true)
    const dis = await call(h.app, 'PATCH', '/api/admin/devices/dev-a', { disabled: true }, '', cookie)
    assert.equal(dis.body.device.disabled, true)
    const wipe = await call(h.app, 'POST', '/api/admin/devices/dev-a/delete-data', {}, '', cookie)
    assert.equal(wipe.status, 200)
    const gone = await call(h.app, 'DELETE', '/api/admin/devices/dev-a', null, '', cookie)
    assert.equal(gone.status, 200)
    assert.equal(h.app.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0)
  } finally { h.cleanup() }
})

test('口令修改接口返回可写入 .env 的哈希', async () => {
  const h = makeApp()
  try {
    const { cookie } = await loginRaw(h)
    const bad = await call(h.app, 'POST', '/api/admin/password', { currentPassword: 'wrong', newPassword: 'newpassword1' }, '', cookie)
    assert.equal(bad.status, 401)
    const weak = await call(h.app, 'POST', '/api/admin/password', { currentPassword: 'test-password', newPassword: 'short' }, '', cookie)
    assert.equal(weak.status, 400)
    assert.equal(weak.body.code, 'WEAK_PASSWORD')
    const ok = await call(h.app, 'POST', '/api/admin/password', { currentPassword: 'test-password', newPassword: 'newpassword1' }, '', cookie)
    assert.equal(ok.status, 200)
    assert.ok(verifyPassword('newpassword1', ok.body.hash))
  } finally { h.cleanup() }
})

async function loginRaw(h) {
  const r = await call(h.app, 'POST', '/api/admin/login', { password: 'test-password' })
  return { res: r, cookie: cookieOf(r) }
}
