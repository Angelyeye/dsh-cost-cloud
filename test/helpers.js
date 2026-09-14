// ============================================================
// 测试辅助：临时数据目录 + 内存化服务实例
// ============================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dshc-test-'))
}

/** 构造测试用配置（默认关闭自注册、固定口令哈希） */
export function testConfig(dir, over) {
  const res = resolveConfig(Object.assign({
    DATA_DIR: dir,
    SESSION_SECRET: 'x'.repeat(48),
    ADMIN_PASSWORD: 'test-password',
    ALLOW_DEVICE_SELF_REGISTER: '0',
    HOST: '127.0.0.1',
    PORT: '0',
  }, over || {}), { cwd: dir })
  if (!res.ok) throw new Error('config: ' + res.problems.join(','))
  return res.config
}

/** 创建一个独立服务实例（不监听端口） */
export function makeApp(over) {
  const dir = tmpDir()
  const config = testConfig(dir, over)
  const app = createServer(config, { log: () => {}, webDir: join(process.cwd(), 'web') })
  return { dir, config, app, cleanup: () => { try { app.close() } catch (e) {}; try { rmSync(dir, { recursive: true, force: true }) } catch (e) {} } }
}

/** 给设备发一个令牌（走内部登记逻辑，避免依赖自注册开关） */
export function addDevice(app, deviceId, name) {
  const { token } = app.ingest.registerDevice({ deviceId, deviceName: name || deviceId, source: 'test' })
  return token
}

/** 构造一条明细记录 */
export function rec(over) {
  return Object.assign({
    ts: Date.UTC(2026, 8, 12, 5, 0, 0),
    provider: 'deepseek-official',
    model: 'deepseek-v4.1-flash',
    sessionId: 's1',
    purpose: 'proj-a',
    tokens: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, reasoning: 0 },
    cost: 0.01,
  }, over || {})
}

/** 直接调用上报（绕过 HTTP，但复用同一套鉴权与处理逻辑） */
export function ingestDirect(app, { token, deviceId, source, records, rollups, extra }) {
  const body = Object.assign({
    syncVer: 1,
    source: source || 'dsh',
    deviceId,
    resetEpoch: 0,
    batchUid: 'batch-' + Math.random().toString(36).slice(2),
    records: records || [],
  }, extra || {})
  if (rollups) body.rollups = rollups
  const auth = { kind: 'device', tokenHash: '', deviceId }
  const env = {
    source: body.source,
    agentInstance: body.agentInstance || '',
    deviceId,
    deviceName: body.deviceName || deviceId,
    resetEpoch: body.resetEpoch || 0,
    batchUid: body.batchUid,
    maxClientSeqHint: body.maxClientSeq || 0,
    syncVer: 1,
    sentAt: Date.now(),
    agent: { name: 'test', version: '1', pluginVersion: '1.8.0' },
  }
  return app.ingest.ingestRecords(auth, env, body, { ip: '127.0.0.1' })
}

export { rec as makeRecord }
export const token = { value: null }
