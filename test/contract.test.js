// ============================================================
// 契约测试（docs/INGEST-API.md）
//
// 这些用例**只按文档描述构造请求**，不引用服务端内部实现细节：
// 目的是一旦实现偏离文档（错误码、字段容忍、幂等、能力协商），测试立即失败，
// 从而保护第三方适配器作者依赖的那份承诺。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeApp } from './helpers.js'
import { call } from './http-client.js'

function payload(over) {
  return Object.assign({
    syncVer: 1,
    source: 'demo',
    agent: { name: 'Demo Agent', version: '1.0.0', pluginVersion: '0.1.0' },
    deviceId: 'demo-machine-1',
    deviceName: '演示机器',
    resetEpoch: 0,
    maxClientSeq: 2,
    sentAt: Date.now(),
    clock: { tzOffset: -480 },
    batchUid: 'demo-batch-1',
    records: [
      { seq: 1, ts: 1789392645019, provider: 'deepseek-official', model: 'deepseek-v4.1-flash', sessionId: 's-1', purpose: '', tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0, reasoning: 0 }, cost: 0.001, meta: { workspace: 'a' } },
      { seq: 2, ts: 1789392645020, provider: 'deepseek-official', model: 'deepseek-v4.1-flash', sessionId: 's-1', purpose: '', tokens: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0.002 },
    ],
  }, over || {})
}

async function mk() {
  const h = makeApp({ ALLOW_DEVICE_SELF_REGISTER: '1', DSH_SYNC_TOKEN: 'bootstrap-token-for-tests' })
  const reg = await call(h.app, 'POST', '/api/v1/devices/register', { deviceId: 'demo-machine-1', deviceName: '演示机器', source: 'demo' })
  return { h, token: reg.body.token, reg }
}

test('文档 §3.1：/api/v1/health 无需鉴权且公布能力', async () => {
  const h = makeApp()
  try {
    const r = await call(h.app, 'GET', '/api/v1/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.syncVer, 1)
    assert.equal(r.body.minSyncVer, 1)
    assert.ok(Array.isArray(r.body.caps.groupBy))
    assert.ok(r.body.caps.groupBy.includes('source'))
    assert.equal(typeof r.body.caps.maxBatchRecords, 'number')
    assert.equal(typeof r.body.caps.selfRegister, 'boolean')
  } finally { h.cleanup() }
})

test('文档 §3.3：完整载荷上报成功并返回 accepted / watermark / cost', async () => {
  const { h, token } = await mk()
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/records', payload(), token)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.accepted, 2)
    assert.equal(r.body.watermark.maxClientSeq, 2, '水位取最大 seq')
    assert.ok(r.body.cost && typeof r.body.cost.computed === 'number')
    assert.equal(r.body.invalid, 0)
  } finally { h.cleanup() }
})

test('文档 §3.3：相同 batchUid 重放幂等', async () => {
  const { h, token } = await mk()
  try {
    const a = await call(h.app, 'POST', '/api/v1/ingest/records', payload(), token)
    const b = await call(h.app, 'POST', '/api/v1/ingest/records', payload(), token)
    assert.equal(b.status, 200)
    assert.equal(b.body.replayed, true)
    assert.equal(b.body.accepted, a.body.accepted)
    assert.equal(Number(h.app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n), 2)
  } finally { h.cleanup() }
})

test('文档 §3.3：换 batchUid 但同内容 → duplicates，行数不变', async () => {
  const { h, token } = await mk()
  try {
    await call(h.app, 'POST', '/api/v1/ingest/records', payload(), token)
    const b = await call(h.app, 'POST', '/api/v1/ingest/records', payload({ batchUid: 'demo-batch-2' }), token)
    assert.equal(b.body.accepted, 0)
    assert.equal(b.body.duplicates, 2)
    assert.equal(Number(h.app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n), 2)
  } finally { h.cleanup() }
})

test('文档 §4.1/§5：缺 source → 400 MISSING_SOURCE（鉴权之前）', async () => {
  const { h, token } = await mk()
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/records', payload({ source: undefined }), token)
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'MISSING_SOURCE')
  } finally { h.cleanup() }
})

test('文档 §5：非法 source 形态同样被拒', async () => {
  const { h, token } = await mk()
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/records', payload({ source: 'Demo_Agent' }), token)
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'MISSING_SOURCE')
  } finally { h.cleanup() }
})

test('文档 §5：syncVer 不支持 → 400 UNSUPPORTED_SYNC_VER 且带 minSyncVer', async () => {
  const { h, token } = await mk()
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/records', payload({ syncVer: 2 }), token)
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'UNSUPPORTED_SYNC_VER')
    assert.equal(r.body.minSyncVer, 1)
    assert.equal(r.body.syncVer, 1)
  } finally { h.cleanup() }
})

test('文档 §5：令牌无效 → 401 TOKEN_INVALID；设备禁用 → 403 DEVICE_DISABLED', async () => {
  const { h, token } = await mk()
  try {
    const bad = await call(h.app, 'POST', '/api/v1/ingest/records', payload(), 'dshc_wrong_token_value_here')
    assert.equal(bad.status, 401)
    assert.equal(bad.body.code, 'TOKEN_INVALID')
    h.app.db.prepare('UPDATE devices SET disabled = 1 WHERE id = ?').run('demo-machine-1')
    const dis = await call(h.app, 'POST', '/api/v1/ingest/records', payload(), token)
    assert.equal(dis.status, 403)
    assert.equal(dis.body.code, 'DEVICE_DISABLED')
  } finally { h.cleanup() }
})

test('文档 §3.5：tombstone 端点排除记录后的聚合不再计入', async () => {
  const { h, token } = await mk()
  try {
    const upd = await call(h.app, 'POST', '/api/v1/ingest/records', payload({ records: payload().records.slice(0, 1), batchUid: 'one' }), token)
    assert.equal(upd.body.accepted, 1)
    const key = h.app.db.prepare('SELECT dedup_key FROM records').get().dedup_key
    const r = await call(h.app, 'POST', '/api/v1/ingest/tombstone', { syncVer: 1, source: 'demo', keys: [key], reason: 'adapter-reset' }, token)
    assert.equal(r.status, 200)
    assert.equal(r.body.marked, 1)
    const sum = Number(h.app.db.prepare(`SELECT COALESCE(SUM(cost),0) AS c FROM records WHERE NOT (kind='detail' AND EXISTS (
      SELECT 1 FROM tombstones t WHERE t.device_id = records.device_id AND t.source = records.source
        AND t.agent_instance = records.agent_instance AND t.dedup_key = records.dedup_key))`).get().c)
    assert.equal(sum, 0)
  } finally { h.cleanup() }
})

test('文档 §3.6：watermark 查询', async () => {
  const { h, token } = await mk()
  try {
    await call(h.app, 'POST', '/api/v1/ingest/records', payload(), token)
    const r = await call(h.app, 'GET', '/api/v1/ingest/watermark?source=demo', null, token)
    assert.equal(r.status, 200)
    assert.equal(r.body.maxClientSeq, 2)
    const miss = await call(h.app, 'GET', '/api/v1/ingest/watermark', null, token)
    assert.equal(miss.status, 400)
    assert.equal(miss.body.code, 'MISSING_SOURCE')
  } finally { h.cleanup() }
})

test('文档 §3.3：未知字段与 meta 被容忍并保留', async () => {
  const { h, token } = await mk()
  try {
    const p = payload({ batchUid: 'meta-1', futureField: { x: 1 }, records: [Object.assign(payload().records[0], { meta: { workspace: 'proj-x', extra: [1, 2, 3] } })] })
    const r = await call(h.app, 'POST', '/api/v1/ingest/records', p, token)
    assert.equal(r.status, 200)
    assert.equal(r.body.accepted, 1)
    const row = h.app.db.prepare('SELECT meta FROM records').get()
    const meta = JSON.parse(String(row.meta))
    assert.deepEqual(meta, { workspace: 'proj-x', extra: [1, 2, 3] })
  } finally { h.cleanup() }
})

test('文档 §3.2：自注册关闭时返回 403 SELF_REGISTER_DISABLED', async () => {
  const h = makeApp({ ALLOW_DEVICE_SELF_REGISTER: '0' })
  try {
    const r = await call(h.app, 'POST', '/api/v1/devices/register', { deviceId: 'x', source: 'demo' })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'SELF_REGISTER_DISABLED')
  } finally { h.cleanup() }
})

test('文档 §3.2：共享引导令牌可自注册并落地设备', async () => {
  const h = makeApp({ ALLOW_DEVICE_SELF_REGISTER: '1', DSH_SYNC_TOKEN: 'bootstrap-token-for-tests' })
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/records', payload(), 'bootstrap-token-for-tests')
    assert.equal(r.status, 200)
    assert.equal(r.body.accepted, 2)
    const dev = h.app.db.prepare('SELECT name FROM devices WHERE id = ?').get('demo-machine-1')
    assert.equal(dev.name, '演示机器')
  } finally { h.cleanup() }
})

test('文档 §5：超大批次 → 413 BATCH_TOO_LARGE', async () => {
  const app = makeApp({ MAX_BATCH_RECORDS: '10' })
  try {
    const reg = await call(app.app, 'POST', '/api/v1/devices/register', { deviceId: 'big', source: 'demo' })
    assert.equal(reg.status, 403, '自注册默认关闭')
    const token = app.app.ingest.registerDevice({ deviceId: 'big', deviceName: 'big' }).token
    const records = Array.from({ length: 11 }, (_, i) => Object.assign(payload().records[0], { ts: 1789392645019 + i, seq: i + 1 }))
    const r = await call(app.app, 'POST', '/api/v1/ingest/records', payload({ deviceId: 'big', records }), token)
    assert.equal(r.status, 413)
    assert.equal(r.body.code, 'BATCH_TOO_LARGE')
  } finally { app.cleanup() }
})

test('文档 §3.3：rollup 快照端点（snapshots 字段）', async () => {
  const { h, token } = await mk()
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/rollups', {
      syncVer: 1, source: 'demo', deviceId: 'demo-machine-1', batchUid: 'snap-1', sentAt: Date.now(),
      snapshots: [{ dayKey: '2026-03-04', provider: 'deepseek-official', model: 'deepseek-v4.1-flash', subscription: false, calls: 12, tokens: { input: 12000, output: 8000, cacheRead: 40000 }, cost: 1.23, peak: 0.4, off: 0.8, flat: 0.03 }],
    }, token)
    assert.equal(r.status, 200)
    assert.equal(r.body.rollupsUpserted, 1)
  } finally { h.cleanup() }
})

test('文档 §3.4：心跳验证令牌', async () => {
  const { h, token } = await mk()
  try {
    const r = await call(h.app, 'POST', '/api/v1/ingest/heartbeat', { syncVer: 1, source: 'demo', deviceId: 'demo-machine-1', sentAt: Date.now() }, token)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.ok(r.body.serverTime > 0)
  } finally { h.cleanup() }
})

test('文档 §3.1：/api/v1/protocol 暴露去重规则与错误码表', async () => {
  const h = makeApp()
  try {
    const r = await call(h.app, 'GET', '/api/v1/protocol')
    assert.equal(r.status, 200)
    assert.equal(r.body.dedup.algorithm, 'sha256(canonical)')
    assert.equal(r.body.dedup.costRounding, 6)
    assert.ok(r.body.dedup.detailFields.includes('resetEpoch'))
    assert.ok(r.body.dedup.rollupFields.includes('provider'))
    assert.ok(r.body.errors['400'].includes('MISSING_SOURCE'))
    assert.ok(String(r.body.contract).includes('INGEST-API'))
  } finally { h.cleanup() }
})
