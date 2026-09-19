// ============================================================
// DSH 花费统计插件 —— 官方价格同步（纯逻辑 + 可注入 fetch，可独立测试）
//
// 数据源：DeepSeek 官方定价页（中文页直接给出人民币价，与账本币种一致）
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
//
// 页面是 Docusaurus 预渲染 HTML，价格表是**转置布局**：
//   · 「模型细节」表首行列出模型名（列顺序即价格列顺序，名称可能带 (1) 脚注）；
//   · 价格块按行分组：百万tokens输入（缓存命中 / 缓存未命中）、百万tokens输出，
//     每组先「空闲时段」再「高峰时段」，每行 N 个值对应 N 个模型列。
//
// 解析失败（页面改版 / 数字缺失 / 空闲≠高峰一半超出容差）一律抛错并保留
// 原价格 —— 同步只在新数据通过全部校验时才生效。
//
// 产出一个新的「计费时代」（era，见 pricing.js PRICE_ERAS）：since = 同步时刻，
// 历史记录按其自身时间戳仍归旧时代，口径不回改。
// ============================================================

/** HTML → 文本行（去 script/style、标签转换行、实体还原、空白折叠） */
export function stripHtmlLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const MODEL_NAME_RE = /^(deepseek)(-[a-z0-9.]+)+$/i
const PRICE_RE = /^(\d+(?:\.\d+)?)元$/
const FOOTNOTE_RE = /^\((\d)\)$/

/** 定价页能否按本解析器理解（中文页特征） */
function isChinesePage(lines) {
  return lines.some((l) => l.indexOf('百万tokens') >= 0) && lines.some((l) => l === '模型' || l.indexOf('BASE URL') === 0)
}

/**
 * 从文本行序列解析价格。
 * @param {string[]} lines - stripHtmlLines 的输出
 * @returns {{models:object, order:string[], routes:object, peakWindowsLabel:string, currency:'CNY'}}
 *   models: { [name]: { offpeak:{input,output,cacheRead}, peak:{input,output,cacheRead} } }
 *   （input=缓存未命中，cacheRead=缓存命中；cacheWrite 与 cacheRead 同价，由 era 构建补齐）
 */
export function parsePricingLines(lines) {
  if (!isChinesePage(lines)) throw new Error('页面不是可识别的中文定价页（未找到「百万tokens」价格表）')
  // ---- 1. 模型列顺序：「模型」行之后、首个 BASE URL 之前的 deepseek-* 名称 ----
  const mi = lines.indexOf('模型')
  if (mi < 0) throw new Error('未找到「模型」表头（页面结构变化？）')
  const order = []
  for (let k = mi + 1; k < lines.length; k += 1) {
    const l = lines[k]
    if (l.indexOf('BASE URL') === 0) break
    if (FOOTNOTE_RE.test(l)) continue
    if (MODEL_NAME_RE.test(l) && order.indexOf(l) < 0) order.push(l)
  }
  if (!order.length) throw new Error('未在「模型」表头下找到任何模型名（页面结构变化？）')
  // ---- 2. 价格块：状态机走「百万tokens* / 空闲时段 / 高峰时段 / N元」序列 ----
  const start = lines.findIndex((l) => l.indexOf('百万tokens') >= 0)
  if (start < 0) throw new Error('未找到价格块（页面结构变化？）')
  const collected = { cacheRead: { offpeak: [], peak: [] }, input: { offpeak: [], peak: [] }, output: { offpeak: [], peak: [] } }
  let metric = ''
  let tier = ''
  let end = lines.length
  for (let k = start; k < lines.length; k += 1) {
    const l = lines[k]
    if (l.indexOf('并发限制') === 0) { end = k; break }
    if (l.indexOf('百万tokens输入') >= 0) {
      // 两种排版：同行连写「百万tokens输入（缓存命中）」；或标签与括号注释分两行
      if (l.indexOf('缓存命中') >= 0) { metric = 'cacheRead'; tier = '' }
      else if (l.indexOf('缓存未命中') >= 0) { metric = 'input'; tier = '' }
      else { metric = 'pending-input'; tier = '' } // 等下一行「（缓存命中）/（缓存未命中）」
      continue
    }
    if (metric === 'pending-input' && l.indexOf('（缓存命中）') === 0) { metric = 'cacheRead'; continue }
    if (metric === 'pending-input' && l.indexOf('（缓存未命中）') === 0) { metric = 'input'; continue }
    if (l.indexOf('百万tokens输出') >= 0) { metric = 'output'; tier = ''; continue }
    if (l === '空闲时段') { tier = 'offpeak'; continue }
    if (l === '高峰时段') { tier = 'peak'; continue }
    const pm = PRICE_RE.exec(l)
    if (pm && metric && tier) {
      collected[metric][tier].push(Number(pm[1]))
    }
  }
  // ---- 3. 校验：六组取齐、个数一致、数值合理、空闲≈高峰一半 ----
  const n = order.length
  for (const metricName of ['cacheRead', 'input', 'output']) {
    for (const tierName of ['offpeak', 'peak']) {
      const arr = collected[metricName][tierName]
      if (arr.length !== n) {
        throw new Error('价格块解析不完整：' + metricName + '/' + tierName + ' 期望 ' + n + ' 个值，实得 ' + arr.length + '（页面结构变化？）')
      }
      for (const v of arr) {
        if (!(v > 0 && v < 100000)) throw new Error('解析出异常单价 ' + v + '（页面结构变化？）')
      }
    }
    for (let k = 0; k < n; k += 1) {
      const off = collected[metricName].offpeak[k]
      const peak = collected[metricName].peak[k]
      const ratio = off / peak
      if (!(ratio > 0.35 && ratio < 0.65)) {
        throw new Error('「空闲时段价格为高峰的一半」校验失败：' + order[k] + ' ' + metricName + ' 空闲 ' + off + ' / 高峰 ' + peak)
      }
    }
  }
  const models = {}
  for (let k = 0; k < n; k += 1) {
    const name = order[k]
    models[name] = {
      offpeak: { input: collected.input.offpeak[k], output: collected.output.offpeak[k], cacheRead: collected.cacheRead.offpeak[k] },
      peak: { input: collected.input.peak[k], output: collected.output.peak[k], cacheRead: collected.cacheRead.peak[k] },
    }
  }
  // ---- 4. 旧模型名路由：脚注 (1)「旧模型名 … 仍可调用 … 按 Flash 价格计费」 ----
  // 真实页面里名子与说明分行（`旧模型名` / `deepseek-v4-flash` / `、` / `…` /
  // `仍可调用，由 deepseek-flash 提供服务…`），但也可能整条脚注挤在一行，
  // 故起始行本身也要扫名字；收集以「仍可调用 / 计费」为终止词，并设 8 行上限
  // 兜底（脚注里后续若出现别的模型名，不会被误当旧名）。
  const routes = {}
  const flashModel = order[0]
  let collectingOld = false
  let collectedLines = 0
  for (const l of lines) {
    const isStart = l.indexOf('旧模型名') >= 0
    if (isStart) { collectingOld = true; collectedLines = 0 }
    if (!collectingOld) continue
    collectedLines += 1
    if (collectedLines > 8) { collectingOld = false; continue }
    const names = l.match(/deepseek(-[a-z0-9.]+)+/gi) || []
    for (const nm of names) {
      const key = nm.toLowerCase()
      if (MODEL_NAME_RE.test(key) && order.indexOf(key) < 0) routes[key] = flashModel
    }
    if (!isStart && (l.indexOf('仍可调用') >= 0 || l.indexOf('计费') >= 0)) collectingOld = false
  }
  // ---- 5. 峰时段文案（用于与内置窗口对照告警） ----
  let peakWindowsLabel = ''
  for (const l of lines) {
    if (l.indexOf('高峰时段；') >= 0 || (l.indexOf('9:00') >= 0 && l.indexOf('高峰时段') >= 0)) { peakWindowsLabel = l; break }
  }
  return { models, order, routes, peakWindowsLabel, currency: 'CNY' }
}

/** 从 HTML 全文解析（strip + parse 的组合便捷入口） */
export function parsePricingHtml(html) {
  return parsePricingLines(stripHtmlLines(html))
}

/**
 * 把解析结果构建成一个新的计费时代（era）。
 * @param {object} parsed - parsePricingLines 的输出
 * @param {number} since - 生效时刻（epoch ms，惯例取同步时刻；历史不回改）
 * @param {string} [id] - 时代 id（缺省按时间生成）
 */
export function buildSyncedEra(parsed, since, id) {
  const models = {}
  for (const name of Object.keys(parsed.models)) {
    const p = parsed.models[name].peak
    models[name] = { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheRead }
  }
  return {
    id: id || ('sync-' + new Date(since).toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)),
    label: '官方同步价（' + new Date(since).toISOString().replace('T', ' ').slice(0, 16) + ' UTC 抓取）',
    since,
    models,
    routes: Object.assign({}, parsed.routes),
    synced: true,
  }
}

/**
 * 对比解析结果与现有时代：全部同名模型单价一致（且无新增模型）时返回 null，
 * 否则返回差异摘要（用于「无需更新」判定与 UI 提示）。
 */
export function diffAgainstEra(parsed, era) {
  if (!era) return '当前无生效时代'
  const diffs = []
  const names = new Set(Object.keys(parsed.models).concat(Object.keys(era.models || {})))
  for (const name of names) {
    const a = parsed.models[name]
    const b = (era.models || {})[name]
    if (!a || !b) { diffs.push(name + (a ? '（新）' : '（已下线）')); continue }
    for (const k of ['input', 'output', 'cacheRead']) {
      if (Math.abs(a.peak[k] - b[k]) > 1e-9) { diffs.push(name + '.' + k + ': ' + b[k] + ' → ' + a.peak[k]) }
    }
  }
  return diffs.length ? diffs.join(' · ') : null
}

/**
 * 抓取并解析官方定价页。
 * @param {string} url - 定价页地址
 * @param {typeof fetch} fetchFn - 由调用方注入（宿主侧传 hardened fetch）
 * @returns {Promise<{parsed:object, html:string, fetchedAt:number, url:string}>}
 */
export async function fetchOfficialPrices(url, fetchFn) {
  const f = fetchFn || globalThis.fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20000)
  let html = ''
  try {
    const res = await f(url, { headers: { 'user-agent': 'dsh-cost-tracker-pricing-sync' }, signal: ac.signal, redirect: 'manual' })
    if (res.status !== 200) throw new Error('HTTP ' + res.status)
    html = await res.text()
  } finally {
    clearTimeout(timer)
  }
  const parsed = parsePricingHtml(html)
  return { parsed, html, fetchedAt: Date.now(), url }
}
