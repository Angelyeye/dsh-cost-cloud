// ============================================================
// dsh-cost-cloud —— 上报处理
//
// 契约实现（docs/INGEST-API.md）：
//   1. 鉴权（设备令牌 / 自注册引导令牌）
//   2. 逐条校验 → 内容哈希幂等（INSERT OR IGNORE）
//   3. 先明细后快照；快照的 absorbed 只对**已存在**的明细写墓碑
//   4. 设备 / 来源登记与水位推进
//
// 计费口径：以**上报值**为准（云端可重算时写入 cost_recomputed 供漂移对比），
// 这样云端合计与设备本地合计逐分一致；「口径漂移」由 recomputed − reported 暴露。
// ============================================================
import { dayKey, monthKey } from './time.js'
import { computeCostAt, normalizeProvider } from './pricing.js'
import { catalogOpts } from './catalog.js'
import { SOURCE_RE, META_MAX_BYTES, toInt, toStr, normTokens, dedupKeyOfDetail, dedupKeyOfRollup } from './dedup.js'
import { HttpError } from './http.js'
import { bearerOf, createDeviceToken, hashToken, timingSafeEqStr } from './auth.js'
import { tx, setMeta } from './db.js'

export const COST_BASES = ['reported', 'estimated', 'subscription', 'unknown']
const STR_MAX = 256

function truncate(v, n) {
  const s = toStr(v)
  return s.length > n ? s.slice(0, n) : s
}
function r6(x) { return Math.round(Number(x) * 1e6) / 1e6 }

/** 规范化并校验一条明细；非法时抛出带 code 的错误 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'INVALID_RECORD', '记录必须是对象')
  const ts = Number(raw.ts)
  if (!Number.isFinite(ts) || ts <= 0) throw new HttpError(400, 'INVALID_RECORD', 'ts 必须是正数 epoch ms')
  const provider = truncate(raw.provider, STR_MAX)
  const model = truncate(raw.model, STR_MAX)
  if (!provider || !model) throw new HttpError(400, 'INVALID_RECORD', 'provider 与 model 必填')
  if (!raw.tokens || typeof raw.tokens !== 'object') throw new HttpError(400, 'INVALID_RECORD', 'tokens 必填')
  const tokens = normTokens(raw.tokens)
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    if (tokens[k] < 0) throw new HttpError(400, 'INVALID_RECORD', 'tokens.' + k + ' 不能为负')
  }
  let meta = ''
  if (raw.meta && typeof raw.meta === 'object') {
    try {
      const m = JSON.stringify(raw.meta)
      if (Buffer.byteLength(m, 'utf8') <= META_MAX_BYTES) meta = m
    } catch (e) { meta = '' }
  }
  const costRaw = Number(raw.cost)
  return {
    seq: Number.isFinite(Number(raw.seq)) ? toInt(raw.seq) : null,
    ts: Math.trunc(ts),
    provider,
    model,
    sessionId: truncate(raw.sessionId, STR_MAX),
    purpose: truncate(raw.purpose, STR_MAX),
    tokens,
    deviceCost: Number.isFinite(costRaw) ? Math.round(costRaw * 1e6) / 1e6 : null,
    estimated: raw.estimated === true,
    subscription: raw.subscription === true,
    meta,
  }
}

/** 规范化并校验一条 rollup 快照 */
export function normalizeRollup(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'INVALID_RECORD', '快照必须是对象')
  const dk = toStr(raw.dayKey)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) throw new HttpError(400, 'INVALID_RECORD', 'dayKey 必须是 YYYY-MM-DD')
  const provider = truncate(raw.provider, STR_MAX)
  const model = truncate(raw.model, STR_MAX)
  if (!provider || !model) throw new HttpError(400, 'INVALID_RECORD', '快照的 provider 与 model 必填')
  const tokens = normTokens(raw.tokens)
  const calls = Math.max(0, toInt(raw.calls))
  const cost = Number(raw.cost)
  const peak = Number(raw.peak)
  const off = Number(raw.off)
  const flat = Number(raw.flat)
  const absorbed = Array.isArray(raw.absorbed)
    ? raw.absorbed.map((k) => toStr(k)).filter((k) => /^[0-9a-f]{64}$/.test(k)).slice(0, 5000)
    : []
  return {
    dayKey: dk,
    provider,
    model,
    subscription: raw.subscription === true,
    calls,
    tokens,
    cost: Number.isFinite(cost) ? cost : 0,
    peak: Number.isFinite(peak) ? peak : 0,
    off: Number.isFinite(off) ? off : 0,
    flat: Number.isFinite(flat) ? flat : (Number.isFinite(cost) ? cost : 0),
    absorbed,
  }
}

/**
 * 单条记录的入账费用与口径：设备上报值优先（云端无法核对历史时代价），
 * 无上报值时用云端重算兜底，订阅类按等效费用记账。
 */
export function resolveCost(kind, deviceCost, recomputed, subscription, estimated) {
  if (subscription) return { cost: deviceCost === null ? 0 : deviceCost, basis: deviceCost === null ? 'subscription' : 'reported' }
  if (kind === 'rollup') return { cost: deviceCost === null ? recomputed : deviceCost, basis: deviceCost === null ? 'estimated' : 'reported' }
  if (deviceCost !== null) return { cost: deviceCost, basis: 'reported' }
  return { cost: recomputed, basis: estimated ? 'estimated' : 'reported' }
}

/**
 * 信封形态校验（**在鉴权之前**执行）：缺 source / 版本不受支持属于"客户端实现问题"，
 * 必须在 401 之前给出文档承诺的 400 错误码，否则适配器作者会被误导去查令牌。
 */
export function validateEnvelopeShape(body, headers, config) {
  const h = headers || {}
  const source = toStr(body && (body.source || h['x-source']))
  if (!source) throw new HttpError(400, 'MISSING_SOURCE', '缺少 source（agent 标识）')
  if (!SOURCE_RE.test(source)) {
    throw new HttpError(400, 'MISSING_SOURCE', 'source 不符合命名约定 ^[a-z0-9][a-z0-9-]{0,31}$：' + source)
  }
  const v = toInt(body && body.syncVer)
  if (v && (v < config.minSyncVer || v > config.syncVer)) {
    throw new HttpError(400, 'UNSUPPORTED_SYNC_VER', '不支持的 syncVer=' + v, { syncVer: config.syncVer, minSyncVer: config.minSyncVer })
  }
  return v || config.syncVer
}

/** 解析上报信封 */
export function parseEnvelope(body, authDevice, headers) {
  const h = headers || {}
  const source = toStr(body.source || h['x-source'])
  if (!source) throw new HttpError(400, 'MISSING_SOURCE', '缺少 source（agent 标识）')
  if (!SOURCE_RE.test(source)) {
    throw new HttpError(400, 'MISSING_SOURCE', 'source 不符合命名约定 ^[a-z0-9][a-z0-9-]{0,31}$：' + source)
  }
  const agent = body.agent && typeof body.agent === 'object' ? body.agent : {}
  const deviceId = truncate(body.deviceId || h['x-device-id'] || authDevice, 128)
  if (!deviceId) throw new HttpError(400, 'INVALID_BODY', '无法确定设备标识（deviceId）')
  return {
    source,
    agentInstance: truncate(body.agentInstance, 64),
    deviceId,
    deviceName: truncate(body.deviceName, 64),
    resetEpoch: Math.max(0, toInt(body.resetEpoch)),
    batchUid: truncate(body.batchUid, 128),
    maxClientSeqHint: Math.max(0, toInt(body.maxClientSeq)),
    syncVer: toInt(body.syncVer) || 0,
    sentAt: Number.isFinite(Number(body.sentAt)) ? Math.trunc(Number(body.sentAt)) : 0,
    agent: {
      name: truncate(agent.name, 64),
      version: truncate(agent.version, 64),
      pluginVersion: truncate(agent.pluginVersion, 64),
    },
  }
}

/** 校验 syncVer（缺失按当前版本处理，保持对早期实现的宽容） */
export function checkSyncVer(body, config) {
  const v = toInt(body.syncVer)
  if (!v) return config.syncVer
  if (v < config.minSyncVer || v > config.syncVer) {
    throw new HttpError(400, 'UNSUPPORTED_SYNC_VER', '不支持的 syncVer=' + v, { syncVer: config.syncVer, minSyncVer: config.minSyncVer })
  }
  return v
}

export function mintToken() {
  const token = createDeviceToken()
  return { token, tokenHash: hashToken(token) }
}

/** 登记设备并发放令牌 */
export function registerDevice(db, opts) {
  const now = Date.now()
  const deviceId = toStr(opts.deviceId) || ('dev-' + hashToken(String(now) + ':' + Math.random()).slice(0, 20))
  const name = truncate(opts.deviceName, 64) || deviceId.slice(0, 12)
  const { token, tokenHash } = mintToken()
  tx(db, () => {
    db.prepare(`INSERT INTO devices(id, name, name_locked, created_at, last_seen_at) VALUES(?,?,0,?,?)
                ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
      .run(deviceId, name, now, now)
    db.prepare('INSERT INTO tokens(token_hash, device_id, label, created_at) VALUES(?,?,?,?)')
      .run(tokenHash, deviceId, toStr(opts.label) || (opts.source ? 'auto:' + opts.source : 'auto'), now)
    db.prepare('INSERT INTO audit_log(at, actor, action, detail) VALUES(?,?,?,?)')
      .run(now, 'device:' + deviceId, 'register', JSON.stringify({ source: toStr(opts.source), name }))
  })
  return { ok: true, deviceId, token, deviceName: name }
}

/** 鉴权：设备令牌；自注册开启时也接受共享引导令牌 */
export function authenticate(req, db, config) {
  const token = bearerOf(req)
  if (!token) throw new HttpError(401, 'TOKEN_MISSING', '缺少 Authorization: Bearer <token>')
  const th = hashToken(token)
  const row = db.prepare(`SELECT t.token_hash, t.device_id, t.revoked, d.name, d.disabled, d.id
                          FROM tokens t LEFT JOIN devices d ON d.id = t.device_id WHERE t.token_hash = ?`).get(th)
  if (row) {
    if (Number(row.disabled) === 1) throw new HttpError(403, 'DEVICE_DISABLED', '设备已被禁用')
    if (Number(row.revoked) === 1) throw new HttpError(401, 'TOKEN_INVALID', '令牌已失效')
    db.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), th)
    return { kind: 'device', tokenHash: th, deviceId: String(row.device_id || row.id || ''), deviceName: toStr(row.name) }
  }
  if (config.syncToken && timingSafeEqStr(token, config.syncToken)) {
    if (!config.allowSelfRegister) throw new HttpError(403, 'SELF_REGISTER_DISABLED', '服务端未开启设备自注册')
    return { kind: 'bootstrap', tokenHash: th }
  }
  throw new HttpError(401, 'TOKEN_INVALID', '令牌无效')
}

const INSERT_RECORD_SQL = `INSERT OR IGNORE INTO records
  (device_id, source, agent_instance, dedup_key, kind, ts, day_key, month_key, provider, model,
   session_id, purpose, calls, input, output, cache_read, cache_write, reasoning,
   cost, cost_basis, cost_recomputed, device_cost, cost_drift, peak, off, flat,
   subscription, estimated, period, client_seq, sync_ver, batch_uid, received_at, updated_at, meta)
  VALUES (${new Array(35).fill('?').join(',')})`

export function createIngest({ db, config, log }) {
  const logger = log || (() => {})

  /** 确保设备与来源行存在（新来源自动登记，看板立即可见） */
  function ensureDeviceSource(env, auth, now) {
    const existing = db.prepare('SELECT id, name, name_locked FROM devices WHERE id = ?').get(env.deviceId)
    if (!existing) {
      db.prepare('INSERT INTO devices(id, name, name_locked, created_at, last_seen_at, last_ingest_at) VALUES(?,?,0,?,?,?)')
        .run(env.deviceId, env.deviceName || env.deviceId.slice(0, 12), now, now, now)
    } else if (env.deviceName && Number(existing.name_locked) !== 1 && String(existing.name) !== env.deviceName) {
      db.prepare('UPDATE devices SET name = ?, last_seen_at = ?, last_ingest_at = ? WHERE id = ?')
        .run(env.deviceName, now, now, env.deviceId)
    } else {
      db.prepare('UPDATE devices SET last_seen_at = ?, last_ingest_at = ? WHERE id = ?').run(now, now, env.deviceId)
    }
    if (auth && auth.kind === 'bootstrap' && auth.tokenHash) {
      db.prepare('INSERT OR IGNORE INTO tokens(token_hash, device_id, label, created_at) VALUES(?,?,?,?)')
        .run(auth.tokenHash, env.deviceId, 'bootstrap:' + env.source, now)
    }
    db.prepare(`INSERT INTO sources(device_id, source, agent_instance, display_name, agent_version, plugin_version,
                 sync_ver, first_seen_at, last_seen_at, last_ingest_at, max_client_seq)
                 VALUES(?,?,?,?,?,?,?,?,?,?,0)
                 ON CONFLICT(device_id, source, agent_instance) DO UPDATE SET
                   display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE sources.display_name END,
                   agent_version = CASE WHEN excluded.agent_version <> '' THEN excluded.agent_version ELSE sources.agent_version END,
                   plugin_version = CASE WHEN excluded.plugin_version <> '' THEN excluded.plugin_version ELSE sources.plugin_version END,
                   sync_ver = excluded.sync_ver,
                   last_seen_at = excluded.last_seen_at,
                   last_ingest_at = excluded.last_ingest_at`)
      .run(env.deviceId, env.source, env.agentInstance, env.agent.name, env.agent.version, env.agent.pluginVersion,
        env.syncVer || config.syncVer, now, now, now)
  }

  function skewOf(body, now) {
    const sentAt = Number(body && body.sentAt)
    if (!Number.isFinite(sentAt) || sentAt <= 0) return 0
    return Math.trunc(now - sentAt)
  }

  function watermarkOf(env) {
    const row = db.prepare(`SELECT MAX(client_seq) AS m, MAX(received_at) AS t FROM records
                            WHERE device_id = ? AND source = ? AND agent_instance = ? AND client_seq IS NOT NULL AND kind = 'detail'`)
      .get(env.deviceId, env.source, env.agentInstance)
    return { maxClientSeq: Number(row && row.m) || 0, lastAcceptedAt: Number(row && row.t) || 0 }
  }

  /** 处理一批明细（+可选快照） */
  function ingestRecords(auth, env, body, meta) {
    const now = Date.now()
    const ip = (meta && meta.ip) || ''
    const recordsRaw = Array.isArray(body.records) ? body.records : []
    const rollupsRaw = Array.isArray(body.rollups) ? body.rollups : []
    if (!recordsRaw.length && !rollupsRaw.length) throw new HttpError(400, 'INVALID_BODY', 'records 或 rollups 至少提供一个')
    if (recordsRaw.length > config.maxBatchRecords) {
      throw new HttpError(413, 'BATCH_TOO_LARGE', '单批明细超过上限 ' + config.maxBatchRecords + ' 条，请分包后重试')
    }

    const warnings = []
    const details = []
    recordsRaw.forEach((r, i) => {
      try { details.push(normalizeRecord(r)) } catch (e) { warnings.push('records[' + i + ']: ' + (e.message || 'INVALID_RECORD')) }
    })
    const snapshots = []
    rollupsRaw.forEach((r, i) => {
      try { snapshots.push(normalizeRollup(r)) } catch (e) { warnings.push('rollups[' + i + ']: ' + (e.message || 'INVALID_RECORD')) }
    })
    if (!details.length && !snapshots.length) {
      throw new HttpError(400, 'INVALID_RECORD', '本批没有合法记录', { warnings: warnings.slice(0, 20) })
    }

    // ---- 幂等：同 batch_uid 直接返回首次结果 ----
    if (env.batchUid) {
      const prev = db.prepare(`SELECT accepted, updated, duplicates, invalid, tombstoned
                               FROM ingest_batches WHERE device_id = ? AND source = ? AND agent_instance = ? AND batch_uid = ?`)
        .get(env.deviceId, env.source, env.agentInstance, env.batchUid)
      if (prev) {
        return {
          ok: true, replayed: true,
          accepted: Number(prev.accepted), updated: Number(prev.updated), duplicates: Number(prev.duplicates),
          invalid: Number(prev.invalid), tombstoned: Number(prev.tombstoned), rollupsUpserted: 0,
          cost: { computed: 0, deviceReported: 0, drift: 0, basis: 'replayed', rows: 0 },
          watermark: watermarkOf(env), warnings: [],
        }
      }
    }

    let accepted = 0, updated = 0, duplicated = 0, tombstoned = 0, upserted = 0
    let maxSeq = env.maxClientSeqHint || 0
    let batchCost = 0, batchReported = 0, reportedRows = 0

    // v1.4.0：目录计价参数整批算一次（默认开启；关掉时为 undefined，
    // computeCostAt 走原内置表路径，行为与旧版逐字一致）
    const catOpts = catalogOpts(db)

    tx(db, () => {
      env.deviceId = ensureDeviceSource(env, auth, now) ? env.deviceId : env.deviceId

      const insRec = db.prepare(INSERT_RECORD_SQL)
      // 先到的快照可能已经声明吸收了尚未上报的明细：插入时立即计入墓碑
      const priorTomb = db.prepare(`SELECT 1 AS x FROM tombstones WHERE device_id = ? AND source = ? AND agent_instance = ? AND dedup_key = ?`)
      for (const d of details) {
        const dk = dedupKeyOfDetail(d, { resetEpoch: env.resetEpoch })
        const calc = computeCostAt(d.provider, d.model, d.ts, d.tokens, catOpts)
        const picked = resolveCost('detail', d.deviceCost, calc.cost, d.subscription || calc.subscription, d.estimated || calc.estimated)
        const seg = calc.period === 'peak' ? 'peak' : calc.period === 'off-peak' ? 'off' : 'flat'
        const res = insRec.run(
          env.deviceId, env.source, env.agentInstance, dk, 'detail', d.ts, dayKey(d.ts), monthKey(d.ts),
          normalizeProvider(d.provider), d.model.toLowerCase(), d.sessionId, d.purpose, 1,
          d.tokens.input, d.tokens.output, d.tokens.cacheRead, d.tokens.cacheWrite, d.tokens.reasoning,
          picked.cost, picked.basis, calc.cost, d.deviceCost,
          d.deviceCost === null ? 0 : r6(d.deviceCost - picked.cost),
          seg === 'peak' ? picked.cost : 0, seg === 'off' ? picked.cost : 0, seg === 'flat' ? picked.cost : 0,
          d.subscription || calc.subscription ? 1 : 0, d.estimated || calc.estimated ? 1 : 0, calc.period,
          d.seq, env.syncVer || config.syncVer, env.batchUid, now, now, d.meta,
        )
        batchCost += picked.cost
        if (d.deviceCost !== null) { batchReported += d.deviceCost; reportedRows += 1 }
        if (Number(res.changes) > 0) {
          accepted += 1
          // 先到的快照可能已声明吸收该明细 → 立即计入墓碑（不会被统计）
          if (priorTomb.get(env.deviceId, env.source, env.agentInstance, dk)) tombstoned += 1
        } else {
          const cur = db.prepare(`SELECT id, device_cost, meta, cost_recomputed FROM records
                                  WHERE device_id = ? AND source = ? AND agent_instance = ? AND dedup_key = ?`)
            .get(env.deviceId, env.source, env.agentInstance, dk)
          if (cur) {
            const changed = Number(cur.device_cost === null ? -1 : cur.device_cost) !== Number(d.deviceCost === null ? -1 : d.deviceCost)
              || String(cur.meta || '') !== d.meta
              || Number(cur.cost_recomputed) !== Number(calc.cost)
            if (changed) {
              db.prepare(`UPDATE records SET device_cost = ?, cost_recomputed = ?, cost_drift = ?, meta = ?, updated_at = ?
                          WHERE id = ?`)
                .run(d.deviceCost, calc.cost, d.deviceCost === null ? 0 : r6(d.deviceCost - picked.cost), d.meta, now, cur.id)
              updated += 1
            } else duplicated += 1
          } else duplicated += 1
        }
        if (d.seq !== null && d.seq > maxSeq) maxSeq = d.seq
      }

      // ---- 快照：先明细后快照；absorbed 只墓碑已存在的明细 ----
      const insSnap = db.prepare(INSERT_RECORD_SQL)
      const insTomb = db.prepare(`INSERT OR IGNORE INTO tombstones(device_id, source, agent_instance, dedup_key, reason, created_at)
                                  VALUES(?,?,?,?,?,?)`)
      for (const s of snapshots) {
        const dk = dedupKeyOfRollup(s)
        const ts = Date.parse(s.dayKey + 'T12:00:00Z')
        const res = insSnap.run(
          env.deviceId, env.source, env.agentInstance, dk, 'rollup', ts, s.dayKey, s.dayKey.slice(0, 7),
          normalizeProvider(s.provider), s.model.toLowerCase(), '', '', s.calls,
          s.tokens.input, s.tokens.output, s.tokens.cacheRead, s.tokens.cacheWrite, s.tokens.reasoning,
          s.cost, s.subscription ? 'subscription' : 'reported', 0, null, 0,
          s.peak, s.off, s.flat, s.subscription ? 1 : 0, 0, 'flat',
          null, env.syncVer || config.syncVer, env.batchUid, now, now, '',
        )
        batchCost += s.cost
        if (Number(res.changes) > 0) upserted += 1
        else {
          const cur = db.prepare(`SELECT id, calls, input, output, cache_read, cache_write, reasoning, cost, peak, off, flat
                                  FROM records WHERE device_id = ? AND source = ? AND agent_instance = ? AND dedup_key = ?`)
            .get(env.deviceId, env.source, env.agentInstance, dk)
          if (cur && (Number(cur.calls) !== s.calls || Number(cur.cost) !== s.cost
            || Number(cur.input) !== s.tokens.input || Number(cur.output) !== s.tokens.output
            || Number(cur.cache_read) !== s.tokens.cacheRead || Number(cur.cache_write) !== s.tokens.cacheWrite
            || Number(cur.reasoning) !== s.tokens.reasoning)) {
            db.prepare(`UPDATE records SET calls = MAX(calls, ?), input = MAX(input, ?), output = MAX(output, ?),
                        cache_read = MAX(cache_read, ?), cache_write = MAX(cache_write, ?), reasoning = MAX(reasoning, ?),
                        cost = MAX(cost, ?), peak = MAX(peak, ?), off = MAX(off, ?), flat = MAX(flat, ?), updated_at = ?
                        WHERE id = ?`)
              .run(s.calls, s.tokens.input, s.tokens.output, s.tokens.cacheRead, s.tokens.cacheWrite, s.tokens.reasoning,
                s.cost, s.peak, s.off, s.flat, now, cur.id)
            upserted += 1
          }
        }
        // 快照声明"这些明细已计入本快照"：无论明细当前是否已到，一律落墓碑。
        // 后到的明细插入后即被排除，从而既幂等又不重复计数。
        for (const key of s.absorbed) {
          const r2 = insTomb.run(env.deviceId, env.source, env.agentInstance, key, 'rollup-fold', now)
          if (Number(r2.changes) > 0) tombstoned += 1
        }
      }

      if (env.batchUid) {
        db.prepare(`INSERT OR IGNORE INTO ingest_batches(device_id, source, agent_instance, batch_uid, received_at, count,
                    accepted, updated, duplicates, invalid, tombstoned, ip) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(env.deviceId, env.source, env.agentInstance, env.batchUid, now,
            details.length + snapshots.length, accepted, updated, duplicated, warnings.length, tombstoned, ip)
      }

      db.prepare(`UPDATE sources SET max_client_seq = MAX(max_client_seq, ?), reset_epoch = MAX(reset_epoch, ?),
                  clock_skew_ms = ?, last_ingest_at = ?, last_seen_at = ?
                  WHERE device_id = ? AND source = ? AND agent_instance = ?`)
        .run(maxSeq, env.resetEpoch, skewOf(body, now), now, now, env.deviceId, env.source, env.agentInstance)

      db.prepare('INSERT INTO audit_log(at, actor, action, detail) VALUES(?,?,?,?)')
        .run(now, 'device:' + env.deviceId, 'ingest', JSON.stringify({
          source: env.source, accepted, updated, duplicated, invalid: warnings.length, tombstoned, snapshots: upserted,
        }))
    })

    logger('[ingest] device=' + env.deviceId + ' source=' + env.source + ' accepted=' + accepted
      + ' dup=' + duplicated + ' updated=' + updated + ' snapshots=' + upserted + ' tomb=' + tombstoned
      + ' invalid=' + warnings.length)

    setMeta(db, 'last_ingest_at', String(now))

    return {
      ok: true,
      accepted, updated, duplicates: duplicated, invalid: warnings.length, tombstoned,
      rollupsUpserted: upserted,
      cost: {
        computed: r6(batchCost),
        deviceReported: r6(batchReported),
        drift: r6(batchReported - batchCost),
        basis: reportedRows === 0 ? 'computed-only' : (reportedRows === details.length ? 'reported' : 'mixed'),
        rows: details.length + snapshots.length,
      },
      watermark: watermarkOf(env),
      warnings: warnings.slice(0, 50),
    }
  }

  /** 仅快照端点 */
  function ingestRollups(auth, env, body, meta) {
    const b = Object.assign({}, body, {
      records: [],
      rollups: Array.isArray(body.snapshots) ? body.snapshots : (body.rollups || []),
    })
    return ingestRecords(auth, env, b, meta)
  }

  /** 记录删除声明 */
  function ingestTombstone(auth, env, body) {
    const now = Date.now()
    const keys = (Array.isArray(body.keys) ? body.keys : []).map((k) => toStr(k)).filter((k) => /^[0-9a-f]{64}$/.test(k))
    if (!keys.length) throw new HttpError(400, 'INVALID_BODY', 'keys 必须是非空 dedupKey 数组')
    let marked = 0
    tx(db, () => {
      ensureDeviceSource(env, auth, now)
      const ins = db.prepare(`INSERT OR IGNORE INTO tombstones(device_id, source, agent_instance, dedup_key, reason, created_at)
                              VALUES(?,?,?,?,?,?)`)
      const has = db.prepare(`SELECT 1 AS x FROM records WHERE device_id = ? AND source = ? AND agent_instance = ? AND dedup_key = ?`)
      for (const k of keys) {
        if (!has.get(env.deviceId, env.source, env.agentInstance, k)) continue
        const r = ins.run(env.deviceId, env.source, env.agentInstance, k, toStr(body.reason) || 'adapter', now)
        if (Number(r.changes) > 0) marked += 1
      }
    })
    return { ok: true, marked }
  }

  return { ingestRecords, ingestRollups, ingestTombstone, watermarkOf, ensureDeviceSource, registerDevice: (o) => registerDevice(db, o) }
}
