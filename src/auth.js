// ============================================================
// dsh-cost-cloud —— 鉴权
//   管理员：scrypt 口令哈希 + HMAC 签名会话 Cookie（HttpOnly/SameSite=Strict）
//   设备  ：每枚令牌只存 sha256，比较用 timingSafeEqual，轮换即失效
// ============================================================
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 32

/** 生成 `scrypt$N$r$p$saltB64$hashB64` 形式的口令哈希 */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const dk = scryptSync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), dk.toString('base64')].join('$')
}

/** 校验口令；格式不合法返回 false（fail-closed） */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3])
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
    const salt = Buffer.from(parts[4], 'base64')
    const expect = Buffer.from(parts[5], 'base64')
    const dk = scryptSync(String(password), salt, expect.length, { N, r, p })
    return dk.length === expect.length && timingSafeEqual(dk, expect)
  } catch (e) {
    return false
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 会话令牌：payload.hmac，payload = base64url(JSON) */
export function createSessionToken(secret, ttlMs, extra) {
  const payload = Object.assign({ sub: 'admin', iat: Date.now(), exp: Date.now() + ttlMs, n: b64url(randomBytes(8)) }, extra || {})
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  return body + '.' + sig
}

export function verifySessionToken(secret, token) {
  try {
    const s = String(token || '')
    const i = s.lastIndexOf('.')
    if (i <= 0) return null
    const body = s.slice(0, i)
    const sig = s.slice(i + 1)
    const expect = b64url(createHmac('sha256', secret).update(body).digest())
    if (sig.length !== expect.length) return null
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch (e) {
    return null
  }
}

/** 设备令牌：明文只返回一次，库里只存哈希 */
export function createDeviceToken() {
  return 'dshc_' + b64url(randomBytes(32))
}

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

export function timingSafeEqStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 从 Authorization 头取 Bearer 令牌 */
export function bearerOf(req) {
  const h = req.headers.authorization || req.headers.Authorization
  if (!h) return ''
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
  return m ? m[1].trim() : ''
}

/** 登录失败限流：同 IP 15 分钟 5 次后指数退避 */
export function createLoginLimiter(opts) {
  const windowMs = (opts && opts.windowMs) || 15 * 60 * 1000
  const maxFails = (opts && opts.maxFails) || 5
  const hits = new Map()
  function prune(now) {
    for (const [k, v] of hits) if (now - v.firstAt > windowMs) hits.delete(k)
  }
  return {
    check(ip, now) {
      const t = Number.isFinite(now) ? now : Date.now()
      prune(t)
      const h = hits.get(ip)
      if (!h) return { blocked: false, retryAfterMs: 0 }
      if (t - h.firstAt > windowMs) { hits.delete(ip); return { blocked: false, retryAfterMs: 0 } }
      if (h.count < maxFails) return { blocked: false, retryAfterMs: 0 }
      const backoff = Math.min(300000, 5000 * Math.pow(2, h.count - maxFails))
      const sinceLast = t - h.lastAt
      if (sinceLast >= backoff) return { blocked: false, retryAfterMs: 0 }
      return { blocked: true, retryAfterMs: backoff - sinceLast }
    },
    fail(ip, now) {
      const t = Number.isFinite(now) ? now : Date.now()
      const h = hits.get(ip) || { count: 0, firstAt: t, lastAt: t }
      h.count += 1
      h.lastAt = t
      hits.set(ip, h)
      return h.count
    },
    ok(ip) { hits.delete(ip) },
    size() { return hits.size },
  }
}

/** 上报令牌桶限流（按设备/IP，滑动一分钟） */
export function createRateLimiter(perMin) {
  const limit = Math.max(1, Number(perMin) || 120)
  const buckets = new Map()
  return {
    check(key, now) {
      const t = Number.isFinite(now) ? now : Date.now()
      const b = buckets.get(key)
      if (!b || t - b.start >= 60000) {
        buckets.set(key, { start: t, count: 1 })
        return { allowed: true, retryAfterMs: 0, remaining: limit - 1 }
      }
      b.count += 1
      if (b.count > limit) {
        const retryAfterMs = Math.max(0, 60000 - (t - b.start))
        return { allowed: false, retryAfterMs, remaining: 0 }
      }
      return { allowed: true, retryAfterMs: 0, remaining: limit - b.count }
    },
    size() { return buckets.size },
  }
}
