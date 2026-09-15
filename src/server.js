// ============================================================
// dsh-cost-cloud —— HTTP 服务装配
//   设备侧：/api/v1/**（Bearer 设备令牌）
//   管理侧：/api/admin/**（Cookie 会话 + 管理员口令）
//   看板  ：静态资源
// 零运行时依赖：node:http + node:sqlite + node:crypto
// ============================================================
import { createServer as createHttpServer } from 'node:http'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'

import { openDatabase, getMeta, setMeta } from './db.js'
import { createIngest, authenticate, parseEnvelope, validateEnvelopeShape, registerDevice, mintToken } from './ingest.js'
import * as Q from './query.js'
import { priceSnapshot, PRICING_SOURCE, PRICING_SOURCE_HASH } from './pricing.js'
import { resolveRange, dayKey } from './time.js'
import { createRouter, readJson, sendJson, sendError, HttpError, clientIp, parseCookies } from './http.js'
import {
  verifyPassword, createSessionToken, verifySessionToken, hashPassword,
  createLoginLimiter, createRateLimiter,
} from './auth.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(HERE, '..')
const WEB_DIR = join(ROOT_DIR, 'web')
const SESSION_COOKIE = 'dshc_admin'
const START_AT = Date.now()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * 装配服务（不监听端口，便于测试注入）。
 * @param {object} config - resolveConfig().config
 * @param {{log?:(m:string)=>void, webDir?:string}} [opts]
 */
export function createServer(config, opts) {
  const log = (opts && opts.log) || ((m) => console.log('[dsh-cost-cloud] ' + m))
  const webDir = (opts && opts.webDir) || WEB_DIR
  const opened = openDatabase(config.dbFile, { backupDir: config.backupDir, onLog: log })
  const db = opened.db
  const ingest = createIngest({ db, config, log })
  const loginLimiter = createLoginLimiter({})
  const rateLimiter = createRateLimiter(config.rateLimitPerMin)

  // 库内保存的运行时开关优先于环境变量（可在看板里直接改，无需重启）
  if (getMeta(db, 'allow_self_register') === '1') config.allowSelfRegister = true
  if (!config.syncToken) {
    const stored = getMeta(db, 'device_token', '')
    if (stored) config.syncToken = stored
  }

  setMeta(db, 'service_version', config.serviceVersion)
  setMeta(db, 'supported_sync_ver', String(config.syncVer))
  setMeta(db, 'pricing_source', PRICING_SOURCE)
  if (!getMeta(db, 'pricing_source_hash')) setMeta(db, 'pricing_source_hash', PRICING_SOURCE_HASH)

  const router = createRouter()

  /** 写入 .env（保留注释与其他键）；只读文件系统时由调用方兜底 */
  const setEnvKey = (key, value) => {
    const file = process.env.DSH_COST_ENV_FILE || join(ROOT_DIR, '.env')
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
    let found = false
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i])
      if (m && m[1] === key) { lines[i] = key + '=' + value; found = true; break }
    }
    if (!found) lines.push(key + '=' + value)
    writeFileSync(file, lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8')
    process.env[key] = value
    return file
  }

  const audit = (actor, action, detail) => {
    try {
      db.prepare('INSERT INTO audit_log(at, actor, action, detail) VALUES(?,?,?,?)')
        .run(Date.now(), String(actor), String(action), typeof detail === 'string' ? detail : JSON.stringify(detail || {}))
    } catch (e) { /* 审计失败不影响主流程 */ }
  }

  // ---------------- 设备侧 ----------------
  router.get('/healthz', () => ({ ok: true, time: Date.now() }))

  router.get('/api/v1/health', () => ({
    ok: true,
    serviceVersion: config.serviceVersion,
    syncVer: config.syncVer,
    minSyncVer: config.minSyncVer,
    time: Date.now(),
    caps: caps(config),
  }))

  router.get('/api/v1/protocol', () => protocolDoc(config))

  router.post('/api/v1/devices/register', ({ body }) => {
    if (!config.allowSelfRegister) {
      throw new HttpError(403, 'SELF_REGISTER_DISABLED', '服务端未开启设备自注册，请到管理后台生成共享引导令牌')
    }
    const out = registerDevice(db, {
      deviceId: body.deviceId, deviceName: body.deviceName, source: body.source, label: body.label,
    })
    log('device registered: ' + out.deviceId)
    return out
  })

  const ingestHandler = (fn) => ({ req, body }) => {
    // 形态与版本校验在鉴权之前：缺 source / 版本不支持属于客户端实现问题，
    // 必须给出文档承诺的 400（而不是让适配器作者去查令牌）
    validateEnvelopeShape(body, req.headers, config)
    const auth = authenticate(req, db, config)
    const env = parseEnvelope(body, auth.kind === 'device' ? auth.deviceId : '', req.headers)
    const ip = clientIp(req, config.trustProxy)
    const rl = rateLimiter.check((auth.deviceId || 'bootstrap') + '|' + ip)
    if (!rl.allowed) throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁', { retryAfterMs: rl.retryAfterMs })
    return fn(auth, env, body, { ip })
  }

  router.post('/api/v1/ingest/records', ingestHandler((auth, env, body, meta) => ingest.ingestRecords(auth, env, body, meta)))
  router.post('/api/v1/ingest/rollups', ingestHandler((auth, env, body, meta) => ingest.ingestRollups(auth, env, body, meta)))
  router.post('/api/v1/ingest/tombstone', ingestHandler((auth, env, body) => ingest.ingestTombstone(auth, env, body)))

  router.get('/api/v1/ingest/watermark', ({ req, query }) => {
    const auth = authenticate(req, db, config)
    const source = String(query.source || '').trim()
    if (!source) throw new HttpError(400, 'MISSING_SOURCE', '缺少 source 参数')
    const deviceId = String(query.deviceId || (auth.kind === 'device' ? auth.deviceId : ''))
    if (!deviceId) throw new HttpError(400, 'INVALID_BODY', '无法确定设备标识')
    return Object.assign({ ok: true }, ingest.watermarkOf({ deviceId, source, agentInstance: String(query.agentInstance || '') }))
  })

  router.post('/api/v1/ingest/heartbeat', ({ req, body }) => {
    validateEnvelopeShape(body, req.headers, config)
    const auth = authenticate(req, db, config)
    const env = parseEnvelope(body, auth.kind === 'device' ? auth.deviceId : '', req.headers)
    const now = Date.now()
    try {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, env.deviceId)
      db.prepare('UPDATE sources SET last_seen_at = ?, clock_skew_ms = ? WHERE device_id = ? AND source = ? AND agent_instance = ?')
        .run(now, env.sentAt ? Math.trunc(now - env.sentAt) : 0, env.deviceId, env.source, env.agentInstance)
    } catch (e) { /* 心跳失败不影响上报 */ }
    return { ok: true, serverTime: now, deviceId: env.deviceId }
  })

  // ---------------- 管理侧 ----------------
  const requireAdmin = (req) => {
    const payload = verifySessionToken(config.sessionSecret, parseCookies(req)[SESSION_COOKIE])
    if (!payload) throw new HttpError(401, 'UNAUTHORIZED', '未登录或会话已过期')
    return payload
  }

  router.post('/api/admin/login', ({ req, body }) => {
    const ip = clientIp(req, config.trustProxy)
    const gate = loginLimiter.check(ip)
    if (gate.blocked) throw new HttpError(429, 'RATE_LIMITED', '登录尝试过于频繁', { retryAfterMs: gate.retryAfterMs })
    const password = String(body.password || '')
    const ok = config.adminPasswordHash
      ? verifyPassword(password, config.adminPasswordHash)
      : (config.adminPassword ? password === config.adminPassword : false)
    if (!ok) {
      loginLimiter.fail(ip)
      audit(ip, 'login-failed', '')
      throw new HttpError(401, 'BAD_CREDENTIALS', '口令不正确')
    }
    loginLimiter.ok(ip)
    const token = createSessionToken(config.sessionSecret, config.adminSessionTtlMs)
    audit('admin', 'login', { ip })
    return {
      status: 200,
      body: { ok: true, expiresAt: Date.now() + config.adminSessionTtlMs },
      headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, token, config, config.adminSessionTtlMs) },
    }
  })

  router.post('/api/admin/logout', ({ req }) => {
    requireAdmin(req)
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': cookieHeader(SESSION_COOKIE, '', config, 0) } }
  })

  router.get('/api/admin/session', ({ req }) => {
    const payload = requireAdmin(req)
    return { ok: true, user: 'admin', expiresAt: payload.exp, insecureDev: config.insecureDev === true }
  })

  router.post('/api/admin/password', ({ req, body }) => {
    requireAdmin(req)
    const next = String(body.newPassword || '')
    if (next.length < 8) throw new HttpError(400, 'WEAK_PASSWORD', '新口令至少 8 位')
    const cur = String(body.currentPassword || '')
    const okCur = config.adminPasswordHash ? verifyPassword(cur, config.adminPasswordHash) : cur === config.adminPassword
    if (!okCur) throw new HttpError(401, 'BAD_CREDENTIALS', '当前口令不正确')
    audit('admin', 'password-hash-generated', '')
    return { ok: true, hash: hashPassword(next), note: '把该哈希写入 .env 的 ADMIN_PASSWORD_HASH 并重启服务后生效' }
  })

  const adminParams = (query) => {
    const range = resolveRange(query, Date.now())
    return {
      fromMs: range.fromMs, toMs: range.toMs,
      devices: query.devices, sources: query.sources, agentInstance: query.agentInstance,
      excludeDevice: query.excludeDevice || '', excludeSource: query.excludeSource || '',
      range: range.range, days: query.days,
    }
  }

  /** 只读聚合：概览（支持 union=<JSON 数组>，把多组过滤条件的概览相加——「本机+云端」这类并集口径）。
   *  管理员会话与设备令牌两条路共用同一实现，避免两份口径漂移。 */
  const readOverview = (query) => {
    if (query.union) {
      let parts = null
      try { parts = JSON.parse(query.union) } catch (e) { throw new HttpError(400, 'INVALID_BODY', 'union 必须是 JSON 数组') }
      if (!Array.isArray(parts) || !parts.length || parts.length > 8) {
        throw new HttpError(400, 'INVALID_BODY', 'union 需为 1..8 项的数组')
      }
      return Q.overviewUnion(db, parts.map((p) => adminParams(Object.assign({ range: query.range, days: query.days }, p || {}))))
    }
    return Q.overview(db, adminParams(query))
  }
  const readMatrix = (query) => Q.matrix(db, adminParams(query))
  const readDevices = () => Object.assign({ ok: true }, Q.listDimensions(db))

  router.get('/api/admin/overview', ({ req, query }) => { requireAdmin(req); return readOverview(query) })
  router.get('/api/admin/groups', ({ req, query }) => {
    requireAdmin(req)
    return Q.groups(db, Object.assign(adminParams(query), { groupBy: query.groupBy || 'source' }))
  })
  router.get('/api/admin/matrix', ({ req, query }) => { requireAdmin(req); return readMatrix(query) })
  router.get('/api/admin/trend', ({ req, query }) => {
    requireAdmin(req)
    return Q.trend(db, Object.assign(adminParams(query), { bucket: query.bucket || 'day', groupBy: query.groupBy || 'source' }))
  })
  router.get('/api/admin/models', ({ req, query }) => {
    requireAdmin(req)
    const g = Q.groups(db, Object.assign(adminParams(query), { groupBy: ['model', 'provider', 'kind'] }))
    return {
      ok: true,
      items: g.groups.map((x) => ({
        model: x.key.model, provider: x.key.provider, kind: x.key.kind,
        calls: x.calls, tokens: x.tokens, cost: Q.r4(x.cost), subCost: Q.r4(x.subCost),
        input: x.input, output: x.output, cacheRead: x.cacheRead, cacheWrite: x.cacheWrite, reasoning: x.reasoning,
        estimatedRows: x.estimatedRows, driftAbs: Q.r4(x.driftAbs),
      })),
    }
  })
  router.get('/api/admin/devices', ({ req }) => { requireAdmin(req); return readDevices() })

  // ---------------- 采集端只读查询（设备令牌） ----------------
  // 采集端插件手里只有设备令牌 / 共享引导令牌，拿不到管理员会话；这里给它一组**只读**聚合接口，
  // 供「仅云端 / 本机+云端」视图读取。写入、配置、令牌管理、审计等管理接口仍只认管理员会话。
  // 可用 ALLOW_DEVICE_READ=0 关闭（默认开启）。
  const requireDeviceRead = (req) => {
    if (config.allowDeviceRead !== true) {
      throw new HttpError(403, 'DEVICE_READ_DISABLED', '服务端未开启设备只读查询（设置 ALLOW_DEVICE_READ=1）')
    }
    return authenticate(req, db, config)
  }
  router.get('/api/v1/overview', ({ req, query }) => { requireDeviceRead(req); return readOverview(query) })
  router.get('/api/v1/matrix', ({ req, query }) => { requireDeviceRead(req); return readMatrix(query) })
  router.get('/api/v1/devices', ({ req }) => { requireDeviceRead(req); return readDevices() })

  router.get('/api/admin/devices/:id', ({ req, params }) => {
    requireAdmin(req)
    const dims = Q.listDimensions(db)
    const device = dims.devices.find((d) => d.id === params.id)
    if (!device) throw new HttpError(404, 'NOT_FOUND', '设备不存在')
    const sources = dims.sources.filter((s) => s.deviceId === params.id)
    const byModel = Q.groups(db, { devices: params.id, groupBy: ['model', 'source'] })
    return { ok: true, device, sources, byModel: byModel.groups }
  })
  router.patch('/api/admin/devices/:id', ({ req, params, body }) => {
    requireAdmin(req)
    const row = db.prepare('SELECT id FROM devices WHERE id = ?').get(params.id)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '设备不存在')
    if (typeof body.name === 'string') {
      const name = body.name.trim().slice(0, 64)
      if (!name) throw new HttpError(400, 'INVALID_BODY', '设备名不能为空')
      db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, params.id)
      audit('admin', 'rename-device', { id: params.id, name })
    }
    if (typeof body.nameLocked === 'boolean') db.prepare('UPDATE devices SET name_locked = ? WHERE id = ?').run(body.nameLocked ? 1 : 0, params.id)
    if (typeof body.disabled === 'boolean') db.prepare('UPDATE devices SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, params.id)
    if (typeof body.notes === 'string') db.prepare('UPDATE devices SET notes = ? WHERE id = ?').run(body.notes.slice(0, 500), params.id)
    const u = db.prepare('SELECT * FROM devices WHERE id = ?').get(params.id)
    return {
      ok: true,
      device: {
        id: u.id, name: u.name, nameLocked: Number(u.name_locked) === 1,
        disabled: Number(u.disabled) === 1, notes: u.notes,
      },
    }
  })
  router.post('/api/admin/devices/:id/rotate-token', ({ req, params }) => {
    requireAdmin(req)
    if (!db.prepare('SELECT id FROM devices WHERE id = ?').get(params.id)) throw new HttpError(404, 'NOT_FOUND', '设备不存在')
    const { token, tokenHash } = mintToken()
    db.prepare('INSERT INTO tokens(token_hash, device_id, label, created_at) VALUES(?,?,?,?)').run(tokenHash, params.id, 'rotated', Date.now())
    audit('admin', 'rotate-token', params.id)
    return { ok: true, deviceId: params.id, token, note: '旧令牌仍然有效；如需立刻失效，请撤销旧令牌。' }
  })
  router.post('/api/admin/devices/:id/delete-data', ({ req, params }) => {
    requireAdmin(req)
    const del = db.prepare('DELETE FROM records WHERE device_id = ?').run(params.id)
    db.prepare('DELETE FROM tombstones WHERE device_id = ?').run(params.id)
    db.prepare('DELETE FROM ingest_batches WHERE device_id = ?').run(params.id)
    db.prepare('UPDATE sources SET max_client_seq = 0 WHERE device_id = ?').run(params.id)
    audit('admin', 'delete-device-data', params.id)
    return { ok: true, deleted: Number(del.changes) || 0 }
  })
  router.delete('/api/admin/devices/:id', ({ req, params }) => {
    requireAdmin(req)
    for (const t of ['records', 'tombstones', 'ingest_batches', 'sources', 'tokens']) {
      db.prepare('DELETE FROM ' + t + ' WHERE device_id = ?').run(params.id)
    }
    db.prepare('DELETE FROM devices WHERE id = ?').run(params.id)
    audit('admin', 'delete-device', params.id)
    return { ok: true }
  })
  router.get('/api/admin/sources', ({ req }) => { requireAdmin(req); return Object.assign({ ok: true }, Q.listDimensions(db)) })
  router.get('/api/admin/records', ({ req, query }) => { requireAdmin(req); return Q.records(db, Object.assign(adminParams(query), query)) })
  router.get('/api/admin/sessions', ({ req, query }) => { requireAdmin(req); return Q.sessions(db, Object.assign(adminParams(query), query)) })
  router.get('/api/admin/sync-health', ({ req }) => { requireAdmin(req); return Q.syncHealth(db, config) })
  router.get('/api/admin/health', ({ req }) => {
    requireAdmin(req)
    return {
      ok: true,
      serviceVersion: config.serviceVersion,
      syncVer: config.syncVer,
      startedAt: START_AT,
      uptimeMs: Date.now() - START_AT,
      db: { file: config.dbFile, userVersion: opened.userVersion, migrationsApplied: opened.applied },
      pricing: { source: PRICING_SOURCE, sourceHash: PRICING_SOURCE_HASH },
      lastIngestAt: Number(getMeta(db, 'last_ingest_at', '0')) || 0,
      insecureDev: config.insecureDev === true,
    }
  })
  router.get('/api/admin/config', ({ req }) => {
    requireAdmin(req)
    return {
      ok: true,
      allowSelfRegister: config.allowSelfRegister === true,
      deviceTokenSet: Boolean(config.syncToken || getMeta(db, 'device_token', '')),
      deviceToken: getMeta(db, 'device_token', ''),
      sessionTtlMs: config.adminSessionTtlMs,
      maxBatchRecords: config.maxBatchRecords,
      maxBodyBytes: config.maxBodyBytes,
      rateLimitPerMin: config.rateLimitPerMin,
      trustProxy: config.trustProxy === true,
      timezone: 'Asia/Shanghai (UTC+8)',
      todayKey: dayKey(Date.now()),
      syncVer: config.syncVer,
      pricing: { source: PRICING_SOURCE, sourceHash: PRICING_SOURCE_HASH },
      insecureDev: config.insecureDev === true,
    }
  })
  router.get('/api/admin/prices', ({ req }) => { requireAdmin(req); return { ok: true, prices: priceSnapshot(Date.now()) } })
  router.get('/api/admin/audit', ({ req, query }) => {
    requireAdmin(req)
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 100))
    return { ok: true, items: db.prepare('SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) }
  })

  router.post('/api/admin/device-token', ({ req, body }) => {
    requireAdmin(req)
    const provided = typeof body.token === 'string' ? body.token.trim() : ''
    const token = provided.length >= 16
      ? provided
      : ('dshc_' + randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    setMeta(db, 'device_token', token)
    config.syncToken = token
    let file = ''
    try {
      file = setEnvKey('DSH_SYNC_TOKEN', token)
      if (body.enableSelfRegister !== false) setEnvKey('ALLOW_DEVICE_SELF_REGISTER', '1')
    } catch (e) { file = '(未能写入 .env，仅存于数据库)' }
    if (body.enableSelfRegister !== false) {
      config.allowSelfRegister = true
      setMeta(db, 'allow_self_register', '1')
    }
    audit('admin', 'device-token', { file, selfRegister: config.allowSelfRegister === true })
    return {
      ok: true, deviceToken: token, file,
      selfRegister: config.allowSelfRegister === true,
      note: '把该令牌填入 DSH 插件的「共享引导令牌」，即可让任意 agent 自注册接入。',
    }
  })

  router.post('/api/admin/config', ({ req, body }) => {
    requireAdmin(req)
    const changed = []
    if (typeof body.allowSelfRegister === 'boolean') {
      config.allowSelfRegister = body.allowSelfRegister
      setMeta(db, 'allow_self_register', body.allowSelfRegister ? '1' : '0')
      try { setEnvKey('ALLOW_DEVICE_SELF_REGISTER', body.allowSelfRegister ? '1' : '0') } catch (e) {}
      changed.push('allowSelfRegister=' + body.allowSelfRegister)
    }
    if (typeof body.trustProxy === 'boolean') {
      config.trustProxy = body.trustProxy
      try { setEnvKey('TRUST_PROXY', body.trustProxy ? '1' : '0') } catch (e) {}
      changed.push('trustProxy=' + body.trustProxy)
    }
    audit('admin', 'config-update', changed)
    return { ok: true, changed, allowSelfRegister: config.allowSelfRegister === true, trustProxy: config.trustProxy === true }
  })

  // 导出（CSV）
  router.get('/api/admin/export.csv', ({ req, query, res }) => {
    requireAdmin(req)
    const csv = Q.exportCsv(db, Object.assign(adminParams(query), query))
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="dsh-cost-cloud-' + dayKey(Date.now()) + '.csv"',
    })
    res.end(csv)
    return undefined
  })

  // ---------------- 静态资源 ----------------
  router.mount('/assets', ({ req, res, params }) => serveStatic(req, res, webDir, params.rest))
  router.get('/', ({ req, res }) => serveStatic(req, res, webDir, '/index.html'))

  return {
    db, router, config, opened, ingest,
    /** 供测试直接调用（不经 HTTP） */
    handle(req, res) { return dispatch(router, req, res, config, log) },
    close() { try { opened.close() } catch (e) {} },
  }
}

function cookieHeader(name, value, config, maxAgeMs) {
  const bits = [name + '=' + encodeURIComponent(value), 'Path=/', 'SameSite=Strict', 'HttpOnly']
  bits.push('Max-Age=' + Math.max(0, Math.floor((maxAgeMs || 0) / 1000)))
  if (config.trustProxy) bits.push('Secure')
  return bits.join('; ')
}

function caps(config) {
  return {
    rollups: true,
    tombstones: true,
    meta: true,
    heartbeat: true,
    selfRegister: config.allowSelfRegister === true,
    maxBatchRecords: config.maxBatchRecords,
    maxBodyBytes: config.maxBodyBytes,
    rateLimitPerMin: config.rateLimitPerMin,
    groupBy: ['device', 'source', 'agentInstance', 'model', 'provider', 'project', 'day', 'month', 'kind'],
  }
}

/** 机器可读契约（与 docs/INGEST-API.md 一致） */
function protocolDoc(config) {
  return {
    ok: true,
    contract: 'docs/INGEST-API.md',
    syncVer: config.syncVer,
    minSyncVer: config.minSyncVer,
    capabilities: caps(config),
    envelope: {
      required: ['source'],
      optional: ['syncVer', 'agentInstance', 'agent', 'deviceId', 'deviceName', 'resetEpoch', 'maxClientSeq', 'sentAt', 'clock', 'batchUid', 'records', 'rollups'],
    },
    record: {
      required: ['ts', 'provider', 'model', 'tokens.input', 'tokens.output'],
      optional: ['seq', 'sessionId', 'purpose', 'tokens.cacheRead', 'tokens.cacheWrite', 'tokens.reasoning', 'cost', 'costBasis', 'estimated', 'subscription', 'period', 'meta'],
    },
    rollup: {
      required: ['dayKey', 'provider', 'model', 'subscription', 'calls', 'tokens', 'cost'],
      optional: ['peak', 'off', 'flat', 'absorbed'],
    },
    dedup: {
      algorithm: 'sha256(canonical)',
      separator: '\\u001f',
      detailFields: ['mode', 'resetEpoch', 'ts', 'provider', 'model', 'sessionId', 'purpose', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cost6'],
      rollupFields: ['mode', 'subscription', 'provider', 'model'],
      costRounding: 6,
      note: 'provider/model 小写；字符串 trim；整数截断；cost 取最短十进制表示；mode = detail | rollup:<dayKey>；rollup 身份不含可变指标',
    },
    errors: {
      400: ['MISSING_SOURCE', 'UNSUPPORTED_SYNC_VER', 'INVALID_BODY', 'INVALID_RECORD'],
      401: ['TOKEN_MISSING', 'TOKEN_INVALID'],
      403: ['DEVICE_DISABLED', 'SELF_REGISTER_DISABLED'],
      404: ['UNKNOWN_ROUTE', 'NOT_FOUND'],
      413: ['PAYLOAD_TOO_LARGE', 'BATCH_TOO_LARGE'],
      429: ['RATE_LIMITED'],
      500: ['INTERNAL'],
    },
    timezone: 'Asia/Shanghai (UTC+8)',
  }
}

function serveStatic(req, res, webDir, relPath) {
  const rel = String(relPath || '/index.html').split('?')[0]
  const safe = normalize(rel).replace(/^([/\\.]+)/, '')
  const file = join(webDir, safe || 'index.html')
  if (!file.startsWith(normalize(webDir))) { sendError(res, 404, 'UNKNOWN_ROUTE', 'not found'); return }
  if (!existsSync(file) || !statSync(file).isFile()) {
    const fallback = join(webDir, 'index.html')
    if (existsSync(fallback) && !extname(safe)) { sendFile(req, res, fallback); return }
    sendError(res, 404, 'UNKNOWN_ROUTE', 'not found')
    return
  }
  sendFile(req, res, file)
}

/**
 * 静态文件响应：内容哈希作 ETag + no-cache（每次都协商，变了立刻生效）。
 * 之所以强制协商：看板曾因浏览器沿用旧的 app.js 而「修复不生效」，
 * 这类问题排查成本极高，宁可每次多一个 304。
 */
function sendFile(req, res, file) {
  const buf = readFileSync(file)
  const etag = '"' + createHash('sha256').update(buf).digest('hex').slice(0, 16) + '"'
  const headers = {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    etag,
    'cache-control': 'no-cache',
  }
  if (String(req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['content-length'] = buf.length
  res.writeHead(200, headers)
  res.end(buf)
}

/** 统一分发：路由 → 调用 → 序列化 */
export async function dispatch(router, req, res, config, log) {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)
  const query = Object.fromEntries(url.searchParams.entries())
  const hit = router.match(req.method, pathname)
  if (!hit) { sendError(res, 404, 'UNKNOWN_ROUTE', '未知路径 ' + pathname); return }
  if (hit.methodNotAllowed) { sendError(res, 405, 'METHOD_NOT_ALLOWED', '方法不允许'); return }
  try {
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
    const body = isWrite ? await readJson(req, config.maxBodyBytes) : {}
    const out = await hit.handler({ req, res, query, params: hit.params || {}, body, config })
    if (out === undefined || res.writableEnded) return
    if (out && typeof out === 'object' && (out.status || out.body || out.headers)) {
      for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v)
      sendJson(res, out.status || 200, out.body === undefined ? { ok: true } : out.body)
      return
    }
    sendJson(res, 200, out)
  } catch (e) {
    if (e instanceof HttpError) { sendError(res, e.status, e.code, e.message, e.extra); return }
    const msg = e && e.message ? e.message : String(e)
    if (log) log('ERROR ' + req.method + ' ' + pathname + ' · ' + msg)
    if (log && e && e.stack) log(String(e.stack).split('\n').slice(0, 6).join('\n'))
    sendError(res, 500, 'INTERNAL', msg)
  }
}

/** 创建并监听（生产入口） */
export function listen(config, opts) {
  const app = createServer(config, opts)
  const log = (opts && opts.log) || ((m) => console.log('[dsh-cost-cloud] ' + m))
  const server = createHttpServer((req, res) => { dispatch(app.router, req, res, config, log) })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(config.port, config.host, () => {
      const addr = server.address()
      const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
      resolve({ server, app, url: 'http://' + host + ':' + addr.port, port: addr.port })
    })
  })
}
