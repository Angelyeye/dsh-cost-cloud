// ============================================================
// 共享引导令牌「明文可见」契约
//
// 背景：令牌明文只存在服务器 .env 与 SQLite，此前设置页只回显「已设置 / 未设置」，
// 忘记令牌时只能登服务器翻文件，或重新生成（会作废所有机器上正在用的旧令牌）。
// 现在 GET /api/admin/config 明文回显 deviceToken，设置页据此展示。
//
// 这套用例守护三件事：
//   1. 生成令牌后，管理端 config 能直接读到明文
//   2. 令牌只写在 .env（库里没有）时，同样能读到明文（回退到 config.syncToken）
//   3. 明文仅对管理员会话可见：设备令牌访问 /api/admin/config 永远 401
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { makeApp, addDevice } from './helpers.js'
import { call, login } from './http-client.js'

test('token: 生成后管理端 config 明文回显共享引导令牌', async () => {
  const h = makeApp()
  const prevEnvFile = process.env.DSH_COST_ENV_FILE
  process.env.DSH_COST_ENV_FILE = join(h.dir, '.env') // 别把测试令牌写进仓库根的 .env
  try {
    const { cookie } = await login(h.app, 'test-password')

    const before = await call(h.app, 'GET', '/api/admin/config', null, '', cookie)
    assert.equal(before.status, 200)
    assert.equal(before.body.deviceTokenSet, false)
    assert.equal(before.body.deviceToken, '', '还没生成令牌时明文应为空字符串')

    const gen = await call(h.app, 'POST', '/api/admin/device-token',
      { token: 'dshc_shared_bootstrap_token_0001' }, '', cookie)
    assert.equal(gen.status, 200)

    const after = await call(h.app, 'GET', '/api/admin/config', null, '', cookie)
    assert.equal(after.body.deviceTokenSet, true)
    assert.equal(after.body.deviceToken, 'dshc_shared_bootstrap_token_0001',
      '设置页要显示的就是这段明文')
  } finally {
    if (prevEnvFile === undefined) delete process.env.DSH_COST_ENV_FILE
    else process.env.DSH_COST_ENV_FILE = prevEnvFile
    h.cleanup()
  }
})

test('token: 只写在 .env（库里没有）时 config 仍回显明文', async () => {
  const h = makeApp()
  try {
    h.config.syncToken = 'dshc_env_only_token_0002' // 模拟手工写 DSH_SYNC_TOKEN、没走生成接口
    const { cookie } = await login(h.app, 'test-password')
    const r = await call(h.app, 'GET', '/api/admin/config', null, '', cookie)
    assert.equal(r.body.deviceTokenSet, true)
    assert.equal(r.body.deviceToken, 'dshc_env_only_token_0002')
  } finally { h.cleanup() }
})

test('token: 设备令牌（非管理员会话）读不到明文', async () => {
  const h = makeApp()
  try {
    const token = addDevice(h.app, 'dev-token-visibility', '可见性测试机')
    const r = await call(h.app, 'GET', '/api/admin/config', null, token)
    assert.equal(r.status, 401, '管理端接口不认设备令牌')
    assert.equal(r.body.deviceToken, undefined, '401 响应体里不得带出任何令牌')
  } finally { h.cleanup() }
})
