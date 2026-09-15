// ============================================================
// dsh-cost-cloud —— 运行配置（fail-closed）
//
// 缺少 SESSION_SECRET 或管理员口令哈希时**拒绝启动**，避免出现
// "以为有鉴权、其实人人可读"的自建服务经典事故。
// 仅显式设置 ALLOW_INSECURE_DEV=1 时放行 dev 默认值。
// ============================================================
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const SERVICE_VERSION = '1.1.1'
const SYNC_VER = 1

function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(v))
}

function intIn(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  return i >= lo && i <= hi ? i : fallback
}

/** 载入 .env（若存在）；不覆盖已设置的环境变量 */
export function loadDotEnv(dir) {
  const p = join(dir || process.cwd(), '.env')
  if (!existsSync(p)) return
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch (e) { return }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    if (process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

/**
 * 解析环境变量为运行配置。
 * @param {object} env - process.env
 * @param {{cwd?:string}} [opts]
 * @returns {{ok:true, config:object} | {ok:false, problems:string[], hints:string[]}}
 */
export function resolveConfig(env, opts) {
  const e = env || {}
  const cwd = (opts && opts.cwd) || process.cwd()
  const allowInsecure = bool(e.ALLOW_INSECURE_DEV, false)
  const problems = []
  const hints = []

  const dataDir = resolve(e.DATA_DIR && String(e.DATA_DIR).trim() ? String(e.DATA_DIR).trim() : join(cwd, 'data'))

  let sessionSecret = String(e.SESSION_SECRET || '').trim()
  let adminPasswordHash = String(e.ADMIN_PASSWORD_HASH || '').trim()
  let adminPassword = String(e.ADMIN_PASSWORD || '').trim()

  if (!sessionSecret) {
    if (allowInsecure) {
      sessionSecret = randomBytes(32).toString('hex')
      hints.push('ALLOW_INSECURE_DEV=1：已生成临时 SESSION_SECRET（重启后所有登录失效）')
    } else {
      problems.push('缺少 SESSION_SECRET')
      hints.push('生成：node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"')
    }
  } else if (sessionSecret.length < 32) {
    problems.push('SESSION_SECRET 太短（至少 32 个字符）')
  }

  if (!adminPasswordHash && !adminPassword) {
    if (allowInsecure) {
      adminPassword = 'admin'
      hints.push('ALLOW_INSECURE_DEV=1：管理员口令回退为 "admin"（切勿在生产使用）')
    } else {
      problems.push('缺少 ADMIN_PASSWORD_HASH（或 ADMIN_PASSWORD）')
      hints.push('生成：node scripts/hash-password.js "你的口令"')
    }
  }

  if (problems.length && !allowInsecure) return { ok: false, problems, hints }

  const syncToken = String(e.DSH_SYNC_TOKEN || '').trim()
  if (!syncToken && bool(e.ALLOW_DEVICE_SELF_REGISTER, false)) {
    hints.push('已开启设备自注册但未设置 DSH_SYNC_TOKEN：任何能访问服务的人都可注册设备')
  }

  const config = {
    serviceVersion: SERVICE_VERSION,
    syncVer: SYNC_VER,
    minSyncVer: intIn(e.MIN_SYNC_VER, 1, 99, 1),
    host: String(e.HOST || '127.0.0.1').trim(),
    port: intIn(e.PORT, 1, 65535, 8787),
    dataDir,
    dbFile: join(dataDir, 'dsh-cost-cloud.sqlite'),
    backupDir: join(dataDir, 'backups'),
    sessionSecret,
    adminPasswordHash,
    adminPassword,
    adminSessionTtlMs: intIn(e.ADMIN_SESSION_TTL_HOURS, 1, 24 * 30, 24 * 30) * 3600000,
    allowSelfRegister: bool(e.ALLOW_DEVICE_SELF_REGISTER, false),
    // 设备令牌（含共享引导令牌）是否可读只读聚合接口 /api/v1/overview|matrix|devices。
    // 采集端插件要用它读云端看板数据，默认开启；设为 0 可关闭，管理接口不受影响。
    allowDeviceRead: bool(e.ALLOW_DEVICE_READ, true),
    syncToken,
    trustProxy: bool(e.TRUST_PROXY, false),
    insecureDev: allowInsecure,
    maxBatchRecords: intIn(e.MAX_BATCH_RECORDS, 1, 20000, 2000),
    maxBodyBytes: intIn(e.MAX_BODY_BYTES, 65536, 64 * 1024 * 1024, 4 * 1024 * 1024),
    rateLimitPerMin: intIn(e.RATE_LIMIT_PER_MIN, 10, 100000, 120),
    batchIdempotencyHours: intIn(e.BATCH_IDEMPOTENCY_HOURS, 1, 24 * 365, 168),
    timezoneLabel: 'Asia/Shanghai (UTC+8)',
    pricingSource: 'dsh-cost-tracker/pricing.js',
  }
  return { ok: true, config, hints }
}

/** 启动失败时打印可执行的修复指引 */
export function formatConfigProblems(result) {
  const lines = ['[dsh-cost-cloud] 启动被拒绝，配置不完整：']
  for (const p of result.problems || []) lines.push('  ✗ ' + p)
  if (result.hints && result.hints.length) {
    lines.push('  修复建议：')
    for (const h of result.hints) lines.push('    · ' + h)
  }
  lines.push('  如仅用于本地试跑，可设置 ALLOW_INSECURE_DEV=1（切勿在生产环境使用）。')
  return lines.join('\n')
}
