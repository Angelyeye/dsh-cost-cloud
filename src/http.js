// ============================================================
// dsh-cost-cloud —— 极简 HTTP 框架（零依赖）
//   路由：method + 路径模板（:param）
//   body：JSON，带体积上限
//   响应：JSON，统一错误形状 { ok:false, code, error, retryAfterMs }
// ============================================================

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code)
    this.status = status
    this.code = code
    this.extra = extra || null
  }
}

export function badRequest(code, message) { return new HttpError(400, code, message) }
export function unauthorized(code, message) { return new HttpError(401, code || 'TOKEN_INVALID', message) }
export function forbidden(code, message) { return new HttpError(403, code, message) }
export function notFound(code, message) { return new HttpError(404, code || 'UNKNOWN_ROUTE', message) }

/** 路径模板 → 正则 + 参数名 */
function compile(pattern) {
  const names = []
  const rx = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => { names.push(n); return '([^/]+)' })
  return { rx: new RegExp('^' + rx + '/?$'), names }
}

export function createRouter() {
  const routes = []
  const router = {
    add(method, pattern, handler) {
      const { rx, names } = compile(pattern)
      routes.push({ method: method.toUpperCase(), rx, names, handler, pattern })
      return router
    },
    get(p, h) { return router.add('GET', p, h) },
    post(p, h) { return router.add('POST', p, h) },
    patch(p, h) { return router.add('PATCH', p, h) },
    delete(p, h) { return router.add('DELETE', p, h) },
    /** 前缀挂载（用于静态资源 /api 兜底） */
    mount(prefix, handler) {
      routes.push({ method: 'ANY', mountPrefix: prefix, handler })
      return router
    },
    match(method, pathname) {
      let pathMatched = false
      for (const r of routes) {
        if (r.mountPrefix) {
          if (pathname === r.mountPrefix || pathname.startsWith(r.mountPrefix + '/')) {
            return { handler: r.handler, params: { rest: pathname.slice(r.mountPrefix.length) } }
          }
          continue
        }
        const m = r.rx.exec(pathname)
        if (!m) continue
        pathMatched = true
        if (r.method !== method.toUpperCase()) continue
        const params = {}
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]) })
        return { handler: r.handler, params }
      }
      return pathMatched ? { methodNotAllowed: true } : null
    },
    routes,
  }
  return router
}

/** 读取请求体（带体积上限），返回字符串 */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过上限 ' + maxBytes + ' 字节'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (e) => reject(e))
  })
}

export async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'INVALID_BODY', 'JSON 解析失败')
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj === undefined ? {} : obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendError(res, status, code, message, extra) {
  const out = Object.assign({ ok: false, code, error: String(message || code) }, extra || {})
  sendJson(res, status, out)
}

/** 客户端 IP（仅在 TRUST_PROXY 时采信 X-Forwarded-For） */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for']
    if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim()
  }
  return (req.socket && req.socket.remoteAddress) || ''
}

export function parseCookies(req) {
  const out = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function setCookie(res, name, value, opts) {
  const o = opts || {}
  const bits = [name + '=' + encodeURIComponent(value)]
  bits.push('Path=' + (o.path || '/'))
  if (o.maxAgeMs) bits.push('Max-Age=' + Math.floor(o.maxAgeMs / 1000))
  if (o.httpOnly !== false) bits.push('HttpOnly')
  bits.push('SameSite=' + (o.sameSite || 'Strict'))
  if (o.secure) bits.push('Secure')
  const prev = res.getHeader('set-cookie')
  const list = prev ? (Array.isArray(prev) ? prev.concat(bits.join('; ')) : [prev, bits.join('; ')]) : [bits.join('; ')]
  res.setHeader('set-cookie', list)
}
