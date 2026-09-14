// ============================================================
// 上报链路测试：幂等 / 去重 / 快照与墓碑 / 水位 / 校验
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeApp, ingestDirect, rec } from './helpers.js'
import { call } from './http-client.js'
import { dedupKeyOfDetail, dedupKeyOfRollup } from '../src/dedup.js'

test('同批重放（相同 batchUid）直接返回原结果，不重复计数', () => {
  const h = makeApp()
  try {
    const batchUid = 'fixed-batch-1'
    const r1 = ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 1000 }), rec({ ts: 2000 })], extra: { batchUid } })
    assert.equal(r1.accepted, 2)
    assert.equal(r1.duplicates, 0)
    const r2 = ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 1000 }), rec({ ts: 2000 })], extra: { batchUid } })
    assert.equal(r2.replayed, true)
    assert.equal(r2.accepted, 2, '重放返回首次结果')
    const n = h.app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n
    assert.equal(Number(n), 2)
  } finally { h.cleanup() }
})

test('不同 batchUid 但内容相同 → 全部计入 duplicates，行数不变', () => {
  const h = makeApp()
  try {
    const a = ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 1000 })] })
    assert.equal(a.accepted, 1)
    const b = ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 1000 })] })
    assert.equal(b.accepted, 0)
    assert.equal(b.duplicates, 1)
    assert.equal(Number(h.app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n), 1)
  } finally { h.cleanup() }
})

test('相同内容来自不同 source / device / agentInstance → 各自记一条', () => {
  const h = makeApp()
  try {
    const r = rec({ ts: 1000 })
    ingestDirect(h.app, { deviceId: 'dev-a', source: 'dsh', records: [r] })
    ingestDirect(h.app, { deviceId: 'dev-a', source: 'codex', records: [r] })
    ingestDirect(h.app, { deviceId: 'dev-b', source: 'dsh', records: [r] })
    ingestDirect(h.app, { deviceId: 'dev-a', source: 'dsh', records: [r], extra: { agentInstance: 'inst2' } })
    const n = Number(h.app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n)
    assert.equal(n, 4)
    const bySource = h.app.db.prepare('SELECT source, COUNT(*) AS n FROM records GROUP BY source ORDER BY source').all()
      .map((x) => [String(x.source), Number(x.n)])
    assert.deepEqual(bySource, [['codex', 1], ['dsh', 3]], 'dsh 两条（默认实例 + inst2）')
    // 同设备同来源同内容（仅 agentInstance 不同）→ 两条（dev-b 的那条也在 dsh 下）
    const insts = h.app.db.prepare("SELECT agent_instance FROM records WHERE source = 'dsh' ORDER BY agent_instance, device_id").all()
      .map((x) => String(x.agent_instance))
    assert.deepEqual(insts, ['', '', 'inst2'])
  } finally { h.cleanup() }
})

test('非法记录被跳过并计入 invalid / warnings，合法记录仍然入库', () => {
  const h = makeApp()
  try {
    const out = ingestDirect(h.app, {
      deviceId: 'dev-a',
      records: [
        rec({ ts: 1000 }),
        { ts: 'abc', provider: 'p', model: 'm', tokens: { input: 1, output: 1 } },
        { provider: 'p', model: 'm' },
        rec({ ts: 2000, tokens: { input: -1, output: 1 } }),
      ],
    })
    assert.equal(out.accepted, 1)
    assert.equal(out.invalid, 3)
    assert.equal(out.warnings.length, 3)
  } finally { h.cleanup() }
})

test('缺 source → MISSING_SOURCE（HTTP 400）', async () => {
  const h = makeApp()
  try {
    const res = await call(h.app, 'POST', '/api/v1/ingest/records', { syncVer: 1, records: [] }, '')
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'MISSING_SOURCE')
  } finally { h.cleanup() }
})

test('不支持的 syncVer → UNSUPPORTED_SYNC_VER 且带 minSyncVer', async () => {
  const h = makeApp()
  try {
    const res = await call(h.app, 'POST', '/api/v1/ingest/records', { syncVer: 99, source: 'dsh', records: [] }, '')
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'UNSUPPORTED_SYNC_VER')
    assert.equal(res.body.minSyncVer, 1)
  } finally { h.cleanup() }
})

test('无令牌 / 错令牌 → 401 TOKEN_MISSING / TOKEN_INVALID', async () => {
  const h = makeApp()
  try {
    const noAuth = await call(h.app, 'POST', '/api/v1/ingest/heartbeat', { syncVer: 1, source: 'dsh' }, '')
    assert.equal(noAuth.status, 401)
    assert.equal(noAuth.body.code, 'TOKEN_MISSING')
    const bad = await call(h.app, 'POST', '/api/v1/ingest/heartbeat', { syncVer: 1, source: 'dsh' }, 'dshc_bogus')
    assert.equal(bad.status, 401)
    assert.equal(bad.body.code, 'TOKEN_INVALID')
  } finally { h.cleanup() }
})

test('rollup 快照：absorbed 落墓碑，后续重放仍为 duplicates', () => {
  const h = makeApp()
  try {
    const r1 = rec({ ts: 1000 })
    const r2 = rec({ ts: 2000 })
    ingestDirect(h.app, { deviceId: 'dev-a', records: [r1, r2] })
    const k1 = dedupKeyOfDetail(r1, { resetEpoch: 0 })
    const k2 = dedupKeyOfDetail(r2, { resetEpoch: 0 })
    const snap = {
      dayKey: '2026-09-12', provider: 'deepseek-official', model: 'deepseek-v4.1-flash', subscription: false,
      calls: 2, tokens: { input: 2000, output: 1000, cacheRead: 4000 }, cost: 0.02,
      absorbed: [k1, k2, 'f'.repeat(64)],
    }
    const out = ingestDirect(h.app, { deviceId: 'dev-a', records: [], rollups: [snap] })
    assert.equal(out.rollupsUpserted, 1)
    assert.equal(out.tombstoned, 3, '声明吸收的三条 key 全部落墓碑（含尚未出现的那条）')
    const tomb = Number(h.app.db.prepare('SELECT COUNT(*) AS n FROM tombstones').get().n)
    assert.equal(tomb, 3)
    // 重复上报同一条明细仍判 duplicates，且不重复计数
    const again = ingestDirect(h.app, { deviceId: 'dev-a', records: [r1] })
    assert.equal(again.duplicates, 1)
    // 明细行仍在库中（墓碑只做排除），但聚合不再计入
    const agg = h.app.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE kind = 'detail'`).get()
    assert.equal(Number(agg.n), 2)
  } finally { h.cleanup() }
})

test('rollup 快照单调合并：只增不减（max 语义）', () => {
  const h = makeApp()
  try {
    const base = { dayKey: '2026-09-12', provider: 'p', model: 'm', subscription: false, tokens: { input: 10, output: 5 }, cost: 1 }
    ingestDirect(h.app, { deviceId: 'dev-a', rollups: [Object.assign({}, base, { calls: 3 })] })
    ingestDirect(h.app, { deviceId: 'dev-a', rollups: [Object.assign({}, base, { calls: 9, tokens: { input: 90, output: 40 }, cost: 4 })] })
    ingestDirect(h.app, { deviceId: 'dev-a', rollups: [Object.assign({}, base, { calls: 5, tokens: { input: 20, output: 5 }, cost: 2 })] })
    const row = h.app.db.prepare(`SELECT calls, input, output, cost FROM records WHERE kind = 'rollup'`).get()
    assert.equal(Number(row.calls), 9)
    assert.equal(Number(row.input), 90)
    assert.equal(Number(row.cost), 4)
  } finally { h.cleanup() }
})

test('乱序安全：快照先到不会吞掉尚未上报的明细（明细仍入库，但被声明为已计入快照）', () => {
  const h = makeApp()
  try {
    const r = rec({ ts: 1000 })
    const k = dedupKeyOfDetail(r, { resetEpoch: 0 })
    const snap = { dayKey: '2026-09-12', provider: 'p', model: 'm', subscription: false, calls: 1, tokens: { input: 1, output: 1 }, cost: 0.1, absorbed: [k] }
    const first = ingestDirect(h.app, { deviceId: 'dev-a', rollups: [snap] })
    assert.equal(first.tombstoned, 1, '声明即落墓碑（明细可尚未到达）')
    assert.equal(Number(h.app.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind = 'detail'").get().n), 0)
    const later = ingestDirect(h.app, { deviceId: 'dev-a', records: [r] })
    assert.equal(later.accepted, 1, '明细后到仍应入库（保留审计痕迹）')
    assert.equal(later.tombstoned, 1, '插入时即发现已被快照声明，计入被排除数')
    // 聚合口径：不重复计数（快照 0.1 + 明细被排除）
    assert.ok(Math.abs(Number(h.app.db.prepare(`SELECT SUM(cost) AS c FROM records WHERE NOT (kind='detail' AND EXISTS (
      SELECT 1 FROM tombstones t WHERE t.device_id = records.device_id AND t.source = records.source
        AND t.agent_instance = records.agent_instance AND t.dedup_key = records.dedup_key))`).get().c) - 0.1) < 1e-9)
  } finally { h.cleanup() }
})

test('水位：watermarkOf 返回明细最大 seq', () => {
  const h = makeApp()
  try {
    ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 1, seq: 5 }), rec({ ts: 2, seq: 9 })] })
    const out = h.app.ingest.watermarkOf({ deviceId: 'dev-a', source: 'dsh', agentInstance: '' })
    assert.equal(out.maxClientSeq, 9)
    assert.ok(out.lastAcceptedAt > 0)
  } finally { h.cleanup() }
})

test('心跳与设备登记：上报后设备与来源出现在看板维度里', () => {
  const h = makeApp()
  try {
    ingestDirect(h.app, { deviceId: 'dev-a', source: 'codex', records: [rec({ ts: 1000 })], extra: { deviceName: '办公台式机' } })
    const dev = h.app.db.prepare('SELECT id, name FROM devices WHERE id = ?').get('dev-a')
    assert.equal(dev.name, '办公台式机')
    const src = h.app.db.prepare('SELECT source, plugin_version FROM sources WHERE device_id = ?').get('dev-a')
    assert.equal(src.source, 'codex')
  } finally { h.cleanup() }
})

test('设备改名锁定：锁定后 name_locked=1，新上报不覆盖', () => {
  const h = makeApp()
  try {
    ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 1 })], extra: { deviceName: '旧名' } })
    h.app.db.prepare('UPDATE devices SET name = ?, name_locked = 1 WHERE id = ?').run('用户改的名', 'dev-a')
    ingestDirect(h.app, { deviceId: 'dev-a', records: [rec({ ts: 2 })], extra: { deviceName: '适配器建议名' } })
    assert.equal(h.app.db.prepare('SELECT name FROM devices WHERE id = ?').get('dev-a').name, '用户改的名')
  } finally { h.cleanup() }
})

test('tombstone 端点：只标记已存在记录', async () => {
  const h = makeApp()
  try {
    const r = rec({ ts: 1000 })
    ingestDirect(h.app, { deviceId: 'dev-a', records: [r] })
    const k = dedupKeyOfDetail(r, { resetEpoch: 0 })
    const token = h.app.ingest.registerDevice({ deviceId: 'dev-a', deviceName: 'dev-a' }).token
    const res = await call(h.app, 'POST', '/api/v1/ingest/tombstone',
      { syncVer: 1, source: 'dsh', keys: [k, 'a'.repeat(64)] }, token)
    assert.equal(res.status, 200)
    assert.equal(res.body.marked, 1)
  } finally { h.cleanup() }
})

export { dedupKeyOfRollup }
