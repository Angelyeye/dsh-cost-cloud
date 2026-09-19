// ============================================================
// dsh-cost-cloud/scripts/sync-pricing-copy.js
//
// 把插件仓库的 `dsh-cost-tracker/pricing.js` 同步成云端的刻意副本
// `dsh-cost-cloud/src/pricing.js`，并重算 PRICING_SOURCE_HASH。
//
// 背景：云端要与插件**逐字节同源**地计价（同一个模型、同一版单价表），否则
// 「本地算 X、云端算 Y」会长期漂移。此前这步靠手工拷贝 + 手改哈希，多次漏改。
// 本脚本把差异限定在两处可复现的注入：
//   ① 云端专属头注释（说明这是副本 + 如何同步）；
//   ② 紧随 V41_EFFECTIVE_AT 之后的 `PRICING_SOURCE_HASH` 常量；
//   ③ 文件尾部的「云端专用追加段」（权威计费入口 / 价格快照）原样保留。
//
// 用法：
//   node scripts/sync-pricing-copy.js [--check] [插件仓库路径]
//     --check  只校验是否已同源（CI 用），不写文件
//   默认插件仓库路径：../dsh-cost-tracker（与本仓库同级）
// ============================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cloudRoot = resolve(join(here, '..'))
const CLOUD_COPY = join(cloudRoot, 'src', 'pricing.js')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const repoArg = args.filter((a) => !a.startsWith('--'))[0]
const pluginRepo = resolve(repoArg || join(cloudRoot, '..', 'dsh-cost-tracker'))
const pluginFile = join(pluginRepo, 'pricing.js')

if (!existsSync(pluginFile)) {
  console.error('[sync-pricing-copy] 找不到插件侧 pricing.js：' + pluginFile)
  console.error('  用法：node scripts/sync-pricing-copy.js [--check] [插件仓库路径]')
  process.exit(2)
}

const HEADER_END_RE = /计费时代（price era）/
const CLOUD_TAIL_RE = /云端专用追加段/
const HASH_LINE_RE = /^export const PRICING_SOURCE_HASH = /

const pluginText = readFileSync(pluginFile, 'utf8')
const pluginLines = pluginText.split('\n')
// 插件侧正文起点：`/** 计费时代 … */` 那段文档注释（其前是插件自己的文件头）
let pluginBodyStart = pluginLines.findIndex((l, i) => HEADER_END_RE.test(l) && /^\s*\*/.test(l)) - 1
if (pluginBodyStart < 1 || pluginLines[pluginBodyStart].trim() !== '/**') {
  console.error('[sync-pricing-copy] 插件侧找不到「计费时代」文档注释起点，格式可能已变')
  process.exit(2)
}
// 插件正文里的同源锚点：V41_EFFECTIVE_AT（哈希常量紧跟其后）
const anchor = pluginLines.findIndex((l) => /^export const V41_EFFECTIVE_AT =/.test(l))
if (anchor < 0) {
  console.error('[sync-pricing-copy] 插件侧找不到 V41_EFFECTIVE_AT 锚点')
  process.exit(2)
}

// 插件头（第 1 行到正文起点前）里的「单价来源…视觉模型」说明段整体搬进云端头
const pluginHeader = pluginLines.slice(0, pluginBodyStart)
const descStart = pluginHeader.findIndex((l) => l.startsWith('// 单价来源'))
if (descStart < 0) {
  console.error('[sync-pricing-copy] 插件头缺少「单价来源」说明段')
  process.exit(2)
}
// 说明段末尾 = 插件头最后一行（插件头的收尾分隔线）
const descEnd = pluginHeader.length
const desc = pluginHeader.slice(descStart, descEnd)

const hash = 'sha256:' + createHash('sha256').update(readFileSync(pluginFile)).digest('hex').slice(0, 16)

const cloudHeader = [
  '// ============================================================',
  '// DSH 花费统计插件 —— 定价与 Token 层（纯逻辑，可独立测试）',
  '//',
  '// ⚠️ 本文件是插件仓库 `dsh-cost-tracker/pricing.js` 的**刻意副本**（v1.9.0 起',
  '// 除本段注释与 PRICING_SOURCE_HASH 常量外逐字节一致，见',
  '// scripts/check-pricing-sync.js 的同源校验）。改动计价逻辑请先改插件仓库，',
  '// 再跑 `node scripts/sync-pricing-copy.js` 刷新本副本与 PRICING_SOURCE_HASH。',
  '//',
  ...desc,
]

const body = pluginLines.slice(pluginBodyStart)
const anchorInBody = anchor - pluginBodyStart
const hashBlock = [
  '',
  '/** 与插件仓库 pricing.js 的 sha256 同源校验值（scripts/check-pricing-sync.js 比对）。',
  ' *  由 scripts/sync-pricing-copy.js 自动重算；请勿手改。 */',
  'export const PRICING_SOURCE_HASH = \'' + hash + '\'',
]
body.splice(anchorInBody + 1, 0, ...hashBlock)

// 云端专用追加段（若已有副本则原样保留）
let cloudTail = []
if (existsSync(CLOUD_COPY)) {
  const old = readFileSync(CLOUD_COPY, 'utf8').split('\n')
  const tailIdx = old.findIndex((l) => CLOUD_TAIL_RE.test(l))
  if (tailIdx > 0) cloudTail = old.slice(tailIdx - 1)
}

const out = cloudHeader.concat(body, cloudTail).join('\n')

if (checkOnly) {
  const cur = existsSync(CLOUD_COPY) ? readFileSync(CLOUD_COPY, 'utf8') : ''
  if (cur === out) {
    console.log('[sync-pricing-copy] 已同源：' + hash)
    process.exit(0)
  }
  console.error('[sync-pricing-copy] 副本与插件侧不一致（跑不带 --check 的命令刷新）')
  process.exit(1)
}

writeFileSync(CLOUD_COPY, out, 'utf8')
console.log('[sync-pricing-copy] 已同步 ' + pluginFile + ' → ' + CLOUD_COPY)
console.log('  PRICING_SOURCE_HASH = ' + hash)
console.log('  行数：插件 ' + pluginLines.length + ' · 云端 ' + out.split('\n').length + '（含云端追加段 ' + cloudTail.length + ' 行）')
