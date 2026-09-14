// ============================================================
// dsh-cost-cloud —— 数据库层（node:sqlite）
//
// 迁移由 PRAGMA user_version 驱动：启动时按顺序执行 src/schema/*.sql，
// 每个文件执行成功后把 user_version 推到该文件的序号。
// 迁移前自动备份（若库已存在），避免升级把数据改坏后无法回退。
// ============================================================
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCHEMA_DIR = join(HERE, 'schema')

/** 列出迁移文件（按文件名序号排序） */
export function listMigrations(dir) {
  const d = dir || SCHEMA_DIR
  return readdirSync(d)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ file: f, version: Number(f.slice(0, f.indexOf('_'))), path: join(d, f) }))
}

/**
 * 打开数据库并把 schema 迁移到最新。
 * @param {string} file - sqlite 文件路径
 * @param {{backupDir?:string, onLog?:(msg:string)=>void}} [opts]
 */
export function openDatabase(file, opts) {
  const log = (opts && opts.onLog) || (() => {})
  const existed = existsSync(file)
  mkdirSync(dirname(file), { recursive: true })
  if (existed && opts && opts.backupDir) backupBeforeMigration(file, opts.backupDir, log)

  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')

  const before = Number(db.prepare('PRAGMA user_version').get().user_version || 0)
  const applied = []
  for (const m of listMigrations()) {
    if (m.version <= before) continue
    const sql = readFileSync(m.path, 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.exec('PRAGMA user_version = ' + m.version)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch (e2) {}
      throw new Error('migration failed: ' + m.file + ' · ' + (e && e.message ? e.message : e))
    }
    applied.push(m.file)
    log('migration applied: ' + m.file)
  }
  if (!applied.length && existed) log('schema up to date (user_version=' + before + ')')

  return {
    db,
    applied,
    userVersion: Number(db.prepare('PRAGMA user_version').get().user_version || 0),
    close() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch (e) {}
      try { db.close() } catch (e) {}
    },
  }
}

/** 迁移前备份（保留最近 7 份） */
export function backupBeforeMigration(file, backupDir, log) {
  try {
    if (!existsSync(file)) return
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(backupDir, 'pre-migration-' + stamp + '.sqlite')
    copyFileSync(file, dest)
    if (log) log('backup: ' + dest)
    const all = readdirSync(backupDir)
      .filter((f) => f.startsWith('pre-migration-'))
      .sort()
    for (const old of all.slice(0, Math.max(0, all.length - 7))) {
      try { unlinkSync(join(backupDir, old)) } catch (e) {}
    }
  } catch (e) {
    if (log) log('backup skipped: ' + (e && e.message ? e.message : e))
  }
}

/** 事务包装：抛错自动回滚 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try { db.exec('ROLLBACK') } catch (e2) {}
    throw e
  }
}

/** 读取 schema_meta 单键 */
export function getMeta(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key)
    return row ? String(row.value) : (fallback === undefined ? null : fallback)
  } catch (e) { return fallback === undefined ? null : fallback }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value))
}
