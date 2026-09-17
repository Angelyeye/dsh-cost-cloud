// ============================================================
// 静态资源契约：ETag 协商 + 服务的就是磁盘上的那一份
//
// 背景：看板曾经出现「服务端已修复、浏览器仍跑旧 app.js」的排查黑洞。
// 这里锁死两件事：
//   1. /assets/* 必须带 ETag 且 Cache-Control: no-cache（每次协商）
//   2. 服务出去的字节必须等于仓库 web/ 里的当前文件（防止镜像残留旧包）
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { createServer as createApp, dispatch } from '../src/server.js'
import { testConfig, tmpDir } from './helpers.js'

const REAL_WEB = fileURLToPath(new URL('../web', import.meta.url))

function appWith(webDir) {
  const dir = tmpDir()
  const config = testConfig(dir)
  const app = createApp(config, { log: () => {}, webDir })
  return {
    app,
    cleanup() { try { app.close() } catch (e) {}; try { rmSync(dir, { recursive: true, force: true }) } catch (e) {} },
  }
}

async function req(app, path, headers) {
  const server = createServer((rq, rs) => dispatch(app.router, rq, rs, app.config, () => {}))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const r = await fetch('http://127.0.0.1:' + server.address().port + path, { headers: headers || {} })
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: Buffer.from(await r.arrayBuffer()) }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

function fixtureWeb() {
  // 注意：/assets 是 router.mount 的前缀，rest 会 slice 掉它，
  // 所以 /assets/app.js 实际读的是 <webDir>/app.js（web/ 目录本身就是资源根）。
  const web = tmpDir()
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><body><div id="app">加载中…</div><script type="module" src="/assets/app.js"></script></body></html>')
  writeFileSync(join(web, 'app.js'), 'export const v = 1\n')
  return web
}

test('静态资源：ETag 协商命中 304，未命中 200', async () => {
  const web = fixtureWeb()
  const { app, cleanup } = appWith(web)
  try {
    const first = await req(app, '/assets/app.js')
    assert.equal(first.status, 200)
    assert.equal(first.body.toString(), 'export const v = 1\n')
    assert.ok(first.headers.etag, '必须带 ETag')
    assert.match(first.headers['cache-control'] || '', /no-cache/, '必须 no-cache，避免沿用旧包')

    const second = await req(app, '/assets/app.js', { 'if-none-match': first.headers.etag })
    assert.equal(second.status, 304, '内容未变应返回 304')
    assert.equal(second.body.length, 0)

    // 内容变化 → ETag 变化且返回新内容（不是 304）
    writeFileSync(join(web, 'app.js'), 'export const v = 2\n')
    const stale = await req(app, '/assets/app.js', { 'if-none-match': first.headers.etag })
    assert.equal(stale.status, 200, '内容已变必须重新下发，不能误判 304')
    assert.equal(stale.body.toString(), 'export const v = 2\n')
    assert.notEqual(stale.headers.etag, first.headers.etag)
  } finally { cleanup(); rmSync(web, { recursive: true, force: true }) }
})

test('静态资源：/ 返回看板外壳且同样是 no-cache', async () => {
  const web = fixtureWeb()
  const { app, cleanup } = appWith(web)
  try {
    const r = await req(app, '/')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'] || '', /text\/html/)
    assert.match(r.headers['cache-control'] || '', /no-cache/)
    assert.match(r.body.toString(), /id="app"/)
  } finally { cleanup(); rmSync(web, { recursive: true, force: true }) }
})

test('静态资源：路径穿越被拒绝', async () => {
  const web = fixtureWeb()
  const { app, cleanup } = appWith(web)
  try {
    const r = await req(app, '/assets/..%2f..%2fpackage.json')
    assert.ok(r.status === 404 || r.status === 400, '不应读到 web/ 之外的文件，实际 ' + r.status)
  } finally { cleanup(); rmSync(web, { recursive: true, force: true }) }
})

test('部署一致性：/assets/* 服务出去的字节 == 仓库 web/ 里的当前文件', async () => {
  const { app, cleanup } = appWith(REAL_WEB)
  try {
    for (const name of ['app.js', 'state.js', 'views.js', 'alerts.js', 'style.css']) {
      const disk = readFileSync(join(REAL_WEB, name))
      const r = await req(app, '/assets/' + name)
      assert.equal(r.status, 200, name + ' 应可访问')
      assert.ok(r.body.equals(disk), name + ' 服务内容与仓库文件不一致（镜像里有旧包）')
    }
    // 前端入口必须是当前这一份（含本轮修复）
    const appJs = (await req(app, '/assets/app.js')).body.toString()
    const stateJs = (await req(app, '/assets/state.js')).body.toString()
    assert.match(stateJs, /k\.slice\(2\)\.toLowerCase\(\)/, 'el() 必须把 onClick 归一化为小写事件名')
    assert.match(appJs, /if \(authed\) await loadAll\(\)/, 'boot() 必须在带会话加载时拉数据')
    assert.doesNotMatch(appJs, /\(data\.devices \|\| \[\]\)\.map/, 'header() 不能把响应对象当数组遍历')
  } finally { cleanup() }
})
