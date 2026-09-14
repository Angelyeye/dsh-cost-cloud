// ============================================================
// 测试辅助：一次性 HTTP 调用（真实 socket，覆盖鉴权与路由层）
// ============================================================
import { createServer } from 'node:http'
import { dispatch } from '../src/server.js'

async function listenOnce(app) {
  const server = createServer((req, res) => dispatch(app.router, req, res, app.config, () => {}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)) }
}

export async function call(app, method, path, body, token, cookie) {
  const server = await listenOnce(app)
  try {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = 'Bearer ' + token
    if (cookie) headers.cookie = cookie
    const r = await fetch(server.url + path, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch (e) { json = { raw: text } }
    const setCookie = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
    return { status: r.status, body: json, headers: Object.fromEntries(r.headers.entries()), setCookie }
  } finally {
    await server.close()
  }
}

/** 取会话 Cookie 的 name=value 片段 */
export function cookieOf(res) {
  const raw = (res.setCookie && res.setCookie[0]) || res.headers['set-cookie'] || ''
  return String(raw).split(';')[0]
}

/** 登录取会话 Cookie */
export async function login(app, password) {
  const r = await call(app, 'POST', '/api/admin/login', { password: password || 'test-password' })
  return { res: r, cookie: cookieOf(r) }
}
