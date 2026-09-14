#!/usr/bin/env node
// ============================================================
// dsh-cost-cloud —— 命令行入口
//
//   node src/main.js                 # 启动服务（默认）
//   node src/main.js start           # 同上
//   node src/main.js register --name "办公台式机" --source dsh
//                                    # 在本地库中登记一台设备并打印令牌
//   node src/main.js hash-password "口令"   # 生成 ADMIN_PASSWORD_HASH
//   node src/main.js check           # 自检配置与数据库
// ============================================================
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDotEnv, resolveConfig, formatConfigProblems } from './config.js'
import { listen } from './server.js'
import { openDatabase } from './db.js'
import { registerDevice } from './ingest.js'
import { hashPassword } from './auth.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
      else {
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i += 1 } else out[a.slice(2)] = true
      }
    } else out._.push(a)
  }
  return out
}

function loadConfigOrExit() {
  loadDotEnv(ROOT)
  loadDotEnv(process.cwd())
  const res = resolveConfig(process.env, { cwd: ROOT })
  if (!res.ok) {
    console.error(formatConfigProblems(res))
    process.exit(2)
  }
  for (const h of res.hints || []) console.warn('[dsh-cost-cloud] 提示：' + h)
  return res.config
}

async function cmdStart() {
  const config = loadConfigOrExit()
  mkdirSync(config.dataDir, { recursive: true })
  const log = (m) => console.log('[dsh-cost-cloud] ' + m)
  const { url, app, server } = await listen(config, { log })
  log('listening on ' + config.host + ':' + config.port + ' → ' + url)
  log('dashboard: ' + url + '/ · health: ' + url + '/healthz · ingest: ' + url + '/api/v1/health')
  if (config.insecureDev) log('⚠ 以 ALLOW_INSECURE_DEV=1 运行：仅可用于本地试跑')

  let closing = false
  const shutdown = (sig) => {
    if (closing) return
    closing = true
    log('收到 ' + sig + '，正在保存并退出…')
    server.close(() => {
      try { app.close() } catch (e) {}
      process.exit(0)
    })
    setTimeout(() => { try { app.close() } catch (e) {} process.exit(0) }, 3000)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

function cmdRegister(args) {
  const config = loadConfigOrExit()
  const opened = openDatabase(config.dbFile, { backupDir: config.backupDir })
  try {
    const name = typeof args.name === 'string' ? args.name : ''
    const source = typeof args.source === 'string' ? args.source : ''
    const deviceId = typeof args.id === 'string' ? args.id : ''
    const out = registerDevice(opened.db, { deviceId, deviceName: name, source, label: 'cli' })
    console.log('设备已登记')
    console.log('  deviceId : ' + out.deviceId)
    console.log('  deviceName: ' + out.deviceName)
    console.log('  令牌      : ' + out.token)
    console.log('')
    console.log('把服务地址与令牌填入 DSH 插件的「云端同步」配置卡即可（令牌只显示这一次）。')
  } finally {
    opened.close()
  }
}

function cmdCheck() {
  const config = loadConfigOrExit()
  const opened = openDatabase(config.dbFile, { backupDir: config.backupDir, onLog: (m) => console.log('  ' + m) })
  const counts = {
    devices: Number(opened.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n),
    sources: Number(opened.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n),
    records: Number(opened.db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
    tombstones: Number(opened.db.prepare('SELECT COUNT(*) AS n FROM tombstones').get().n),
  }
  console.log('配置自检通过')
  console.log('  数据目录  : ' + config.dataDir)
  console.log('  数据库    : ' + config.dbFile + ' (user_version=' + opened.userVersion + ')')
  console.log('  监听      : ' + config.host + ':' + config.port)
  console.log('  自注册    : ' + (config.allowSelfRegister ? '开启' : '关闭'))
  console.log('  记录      : ' + JSON.stringify(counts))
  opened.close()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'start'
  switch (cmd) {
    case 'start': case 'serve': await cmdStart(); break
    case 'register': cmdRegister(args); break
    case 'check': cmdCheck(); break
    case 'hash-password': {
      const pw = args._[1] || args.password
      if (!pw) { console.error('用法：node src/main.js hash-password "你的口令"'); process.exit(2) }
      console.log(hashPassword(String(pw)))
      break
    }
    case 'help': case '--help': case '-h':
      console.log('用法：node src/main.js [start|register|check|hash-password] [--name 名称] [--source dsh]')
      break
    default:
      console.error('未知命令：' + cmd)
      process.exit(2)
  }
}

main().catch((e) => {
  console.error('[dsh-cost-cloud] 启动失败：' + (e && e.message ? e.message : e))
  process.exit(1)
})
