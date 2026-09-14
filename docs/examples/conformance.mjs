#!/usr/bin/env node
// ============================================================
// 适配器一致性自验（conformance）
//
// 离线（默认）：校验你的 dedupKey 实现是否与契约 §6 一致 —— 用文档中的测试向量
//               与一组边界用例，不需要服务端。
// 在线（给 --base 与 --token）：额外验证幂等重放、错误码、水位推进、二维归属。
//
// 用法：
//   node docs/examples/conformance.mjs                       # 仅离线向量
//   node docs/examples/conformance.mjs --base http://127.0.0.1:8787 --token dshc_xxx
// ============================================================
import { createHash } from 'node:crypto'

const US = '\u001f'
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const BASE = arg('--base', '')
const TOKEN = arg('--token', '')

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) } else { fail += 1; console.error('  ✗ ' + msg) }
}

// ---------- 契约参考实现（复制自 docs/INGEST-API.md §6.2） ----------
const s = (v) => (v == null ? '' : String(v).trim())
const i = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
function cost6(v) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '0' }
function detailCanonical(r, resetEpoch = 0) {
  const t = r.tokens || {}
  return ['detail', i(resetEpoch), i(r.ts), s(r.provider).toLowerCase(), s(r.model).toLowerCase(),
    s(r.sessionId), s(r.purpose), i(t.input), i(t.output), i(t.cacheRead), i(t.cacheWrite), i(t.reasoning), cost6(r.cost)].join(US)
}
const sha256 = (str) => createHash('sha256').update(str, 'utf8').digest('hex')

console.log('== 离线：契约向量 ==')
const vector = {
  ts: 1789392645019, provider: 'DeepSeek-Official', model: 'DeepSeek-V4.1-Flash',
  sessionId: ' s1 ', purpose: null, tokens: { input: 3850, output: 2880, cacheRead: 43904 }, cost: 0.01624808,
}
const expected = 'detail\u001f0\u001f1789392645019\u001fdeepseek-official\u001fdeepseek-v4.1-flash\u001fs1\u001f\u001f3850\u001f2880\u001f43904\u001f0\u001f0\u001f0.016248'
ok(detailCanonical(vector) === expected, 'canonical 串与文档一致')
ok(sha256(detailCanonical(vector)).length === 64, 'dedupKey 为 64 位小写十六进制')
ok(/^[0-9a-f]{64}$/.test(sha256(detailCanonical(vector))), 'dedupKey 字符集正确')

console.log('== 离线：边界用例 ==')
ok(cost6(1.5) === '1.5', 'cost 取最短十进制（1.5 而非 1.500000）')
ok(cost6(0) === '0' && cost6(NaN) === '0', 'cost 缺失/非法按 0')
ok(i(12.9) === 12 && i(-3.2) === -3, 'token 截断取整')
ok(detailCanonical({ ts: 1, provider: 'P', model: 'M', tokens: { input: 1, output: 2 }, cost: 0.5 })
  === detailCanonical({ cost: 0.5, tokens: { output: 2, input: 1 }, model: 'M', provider: 'P', ts: 1 }),
  '字段书写顺序不影响结果（不要用 JSON.stringify）')
const k0 = sha256(detailCanonical(vector, 0))
const k1 = sha256(detailCanonical(vector, 1))
ok(k0 !== k1, 'resetEpoch 参与身份（清空数据后重导不判重）')

if (!BASE || !TOKEN) {
  console.log('')
  console.log('（未提供 --base/--token，跳过在线校验。离线结果：' + pass + ' 通过 / ' + fail + ' 失败）')
  process.exit(fail ? 1 : 0)
}

// ---------- 在线校验 ----------
console.log('== 在线：能力协商 ==')
const health = await (await fetch(BASE + '/api/v1/health')).json()
ok(health.ok === true, 'health.ok')
ok(health.syncVer === 1, 'syncVer = 1')
const caps = health.caps || {}
ok(Array.isArray(caps.groupBy) && caps.groupBy.includes('source'), 'caps.groupBy 含 source')

const H = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }
const deviceId = 'conformance-' + sha256(String(Date.now())).slice(0, 8)
const source = 'conformance'
const now = Date.now()
const mb = (n) => n * 1000

console.log('== 在线：错误码 ==')
const noSource = await (await fetch(BASE + '/api/v1/ingest/records', { method: 'POST', headers: H, body: JSON.stringify({ syncVer: 1, records: [] }) })).json()
ok(noSource.code === 'MISSING_SOURCE', '缺 source → MISSING_SOURCE')
const badVer = await (await fetch(BASE + '/api/v1/ingest/records', { method: 'POST', headers: H, body: JSON.stringify({ syncVer: 999, source, records: [] }) })).json()
ok(badVer.code === 'UNSUPPORTED_SYNC_VER', '版本不支持 → UNSUPPORTED_SYNC_VER')

const batchUid = 'conf-' + now
const payload = (extra) => Object.assign({
  syncVer: 1, source, deviceId, deviceName: '一致性检查机', resetEpoch: 0,
  maxClientSeq: 1, sentAt: Date.now(), batchUid,
  records: [{
    seq: 1, ts: now, provider: 'deepseek-official', model: 'deepseek-v4.1-flash',
    sessionId: 'conf-s1', purpose: 'conformance',
    tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, reasoning: 0 }, cost: 0.0012,
  }],
}, extra || {})

console.log('== 在线：幂等与水位 ==')
const first = await (await fetch(BASE + '/api/v1/ingest/records', { method: 'POST', headers: H, body: JSON.stringify(payload()) })).json()
ok(first.ok === true, '上报成功')
ok(first.accepted === 1, 'accepted = 1')
const replay = await (await fetch(BASE + '/api/v1/ingest/records', { method: 'POST', headers: H, body: JSON.stringify(payload()) })).json()
ok(replay.replayed === true, '同 batchUid 重放 → replayed')
const dupe = await (await fetch(BASE + '/api/v1/ingest/records', { method: 'POST', headers: H, body: JSON.stringify(payload({ batchUid: batchUid + '-2' })) })).json()
ok(dupe.duplicates === 1, '换 batchUid 同内容 → duplicates')
const wm = await (await fetch(BASE + '/api/v1/ingest/watermark?source=' + source + '&deviceId=' + deviceId, { headers: H })).json()
ok(wm.maxClientSeq >= 1, '水位已推进（maxClientSeq=' + wm.maxClientSeq + '）')

console.log('== 在线：rollup 快照与墓碑 ==')
const key = sha256(detailCanonical({ ts: now, provider: 'deepseek-official', model: 'deepseek-v4.1-flash', sessionId: 'conf-s1', purpose: 'conformance', tokens: { input: 1000, output: 200, cacheRead: 500 }, cost: 0.0012 }, 0))
const snap = await (await fetch(BASE + '/api/v1/ingest/rollups', {
  method: 'POST', headers: H,
  body: JSON.stringify({
    syncVer: 1, source, deviceId, sentAt: Date.now(), batchUid: batchUid + '-snap',
    snapshots: [{
      dayKey: '2026-01-01', provider: 'deepseek-official', model: 'deepseek-v4.1-flash', subscription: false,
      calls: 1, tokens: { input: 1000, output: 200, cacheRead: 500 }, cost: 0.0012, peak: 0, off: 0.0012, flat: 0, absorbed: [key],
    }],
  }),
})).json()
ok(snap.ok === true && snap.rollupsUpserted === 1, '快照入库')
ok(snap.tombstoned >= 1, '声明吸收的明细已落墓碑（tombstoned=' + snap.tombstoned + '）')
// 快照可重复上报（幂等 upsert）
const snap2 = await (await fetch(BASE + '/api/v1/ingest/rollups', {
  method: 'POST', headers: H,
  body: JSON.stringify({
    syncVer: 1, source, deviceId, sentAt: Date.now(), batchUid: batchUid + '-snap2',
    snapshots: [{
      dayKey: '2026-01-01', provider: 'deepseek-official', model: 'deepseek-v4.1-flash', subscription: false,
      calls: 2, tokens: { input: 2000, output: 400, cacheRead: 1000 }, cost: 0.0024, peak: 0, off: 0.0024, flat: 0, absorbed: [key],
    }],
  }),
})).json()
ok(snap2.ok === true, '快照可重复上报（单调合并）')

console.log('')
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
