#!/usr/bin/env node
// ============================================================
// 最小可用适配器（约 60 行）
//
// 演示一个 agent 的统计插件需要做的事：
//   1. 读共享设备身份（同一台机器的所有 agent 必须共用 machineId）
//   2. 维护本地 seq 与水位（增量上报）
//   3. 按 docs/INGEST-API.md §6 计算 dedupKey（明细用 dedupKeyOfDetail）
//   4. 失败退避、成功推进水位
//
//   node docs/examples/minimal-adapter.mjs <base-url> <token|bootstrap-token> [source]
// ============================================================
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const TOKEN = process.argv[3] || ''
const SOURCE = process.argv[4] || 'demo'
const DATA_DIR = process.env.DSH_COST_HOME || join(homedir(), '.dsh-cost')
const IDENTITY_FILE = join(DATA_DIR, 'device.json')
const STATE_FILE = join(DATA_DIR, 'adapter-' + SOURCE + '.json')

// ---------- 共享设备身份（跨 agent 复用同一个 machineId） ----------
function loadIdentity() {
  mkdirSync(DATA_DIR, { recursive: true })
  try { return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) } catch (e) { /* 首次运行 */ }
  const id = {
    v: 1,
    machineId: createHash('sha256').update(process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown').digest('hex').slice(0, 16),
    machineName: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
  }
  writeFileSync(IDENTITY_FILE, JSON.stringify(id, null, 2))
  return id
}
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch (e) { return { watermark: 0, seq: 0 } }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

// ---------- 契约 §6：canonical + sha256 ----------
const US = '\u001f'
const s = (v) => (v == null ? '' : String(v).trim())
const i = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
function cost6(v) { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '0' }
function dedupKeyOfDetail(r, resetEpoch = 0) {
  const t = r.tokens || {}
  const canonical = ['detail', i(resetEpoch), i(r.ts), s(r.provider).toLowerCase(), s(r.model).toLowerCase(),
    s(r.sessionId), s(r.purpose), i(t.input), i(t.output), i(t.cacheRead), i(t.cacheWrite), i(t.reasoning), cost6(r.cost)].join(US)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ---------- 上报 ----------
const id = loadIdentity()
const state = loadState()
const batch = [
  { ts: Date.now(), provider: 'deepseek-official', model: 'deepseek-v4.1-flash', sessionId: 'demo-' + randomUUID().slice(0, 8), purpose: 'demo',
    tokens: { input: 1234, output: 567, cacheRead: 8901, cacheWrite: 0, reasoning: 0 }, cost: 0.0102 },
].map((r, idx) => Object.assign({ seq: state.seq + idx + 1, dedupKey: dedupKeyOfDetail(r, 0) }, r))

const res = await fetch(BASE + '/api/v1/ingest/records', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN },
  body: JSON.stringify({
    syncVer: 1, source: SOURCE, deviceId: id.machineId, deviceName: id.machineName,
    agent: { name: 'minimal-adapter', version: '1.0.0', pluginVersion: 'example' },
    resetEpoch: 0, maxClientSeq: batch[batch.length - 1].seq, sentAt: Date.now(),
    batchUid: randomUUID(), records: batch,
  }),
})
const json = await res.json()
console.log('HTTP', res.status, JSON.stringify(json))
if (json && json.ok) {
  state.seq += batch.length
  state.watermark = json.watermark ? json.watermark.maxClientSeq : state.seq
  saveState(state)
  console.log('本地水位推进到 seq=' + state.watermark)
}
