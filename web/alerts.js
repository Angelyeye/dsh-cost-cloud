// ============================================================
// dsh-cost-cloud 看板 —— 监控告警规则（纯函数，可在 node 里单测）
//
// 输入是各接口的原始响应（可能缺项，规则必须容忍 undefined），
// 输出是统一形状的告警数组：
//   { level: 'error' | 'warn' | 'info', code, title, detail, hint }
//
// 设计取向：**只报可行动的结论**。每条告警都要能回答「我该做什么」，
// 说不清的就不报（否则监控页会退化成噪音墙）。
// ============================================================
import { fmtMoney, fmtInt, fmtPct, fmtAgo, fmtDur, DEFAULT_PREFS, sliceReal } from './state.js'

const HOUR = 3600000

function pct(x, digits) { return fmtPct(x, digits === undefined ? 1 : digits) }

/**
 * @param {object} ctx
 * @param {object} ctx.prefs        阈值（见 state.js DEFAULT_PREFS）
 * @param {object} [ctx.health]     /api/admin/health
 * @param {object} [ctx.config]     /api/admin/config
 * @param {object} [ctx.overview]   /api/admin/overview
 * @param {object} [ctx.syncHealth] /api/admin/sync-health
 * @param {object} [ctx.subscriptions] /api/admin/subscriptions
 * @param {object} [ctx.heatmap]    /api/admin/heatmap（近 30 天）
 * @param {number} [ctx.now]
 */
export function computeAlerts(ctx) {
  const c = ctx || {}
  const prefs = Object.assign({}, DEFAULT_PREFS, c.prefs || {})
  const now = Number(c.now) || Date.now()
  const out = []
  const add = (level, code, title, detail, hint) => out.push({ level, code, title, detail, hint: hint || '' })

  // ---------- 1. 云端静默（整体新鲜度） ----------
  if (c.health) {
    const last = Number(c.health.lastIngestAt) || 0
    const silenceMs = Math.max(1, Number(prefs.silenceHours) || 6) * HOUR
    if (!last) {
      add('warn', 'cloud-never-ingest', '云端从未收到上报', '数据库里还没有任何入库批次。', '在插件端配置云端地址与设备令牌后点击「立即同步」。')
    } else if (now - last > silenceMs) {
      add('warn', 'cloud-silent', '云端已 ' + fmtDur(now - last) + ' 没有收到上报',
        '最近一次入库：' + fmtAgo(last) + '（阈值 ' + prefs.silenceHours + ' 小时）。',
        '检查设备是否关机、插件是否仍在运行；长期不用的设备可在「设备」页禁用以免干扰告警。')
    }
  }

  // ---------- 2. 设备同步停滞 / 时钟偏差 / 非法记录 ----------
  const items = (c.syncHealth && Array.isArray(c.syncHealth.items)) ? c.syncHealth.items : []
  const staleMs = Math.max(1, Number(prefs.staleHours) || 24) * HOUR
  for (const it of items) {
    if (it.disabled) continue
    const who = (it.deviceName || it.deviceId || '未知设备') + ' · ' + (it.source || 'agent')
    const lag = it.lagMs === null || it.lagMs === undefined ? (it.lastIngestAt ? now - Number(it.lastIngestAt) : null) : Number(it.lagMs)
    if (lag !== null && lag > staleMs) {
      const level = lag > staleMs * 3 ? 'error' : 'warn'
      add(level, 'sync-stale', who + ' 已 ' + fmtDur(lag) + ' 未上报',
        '最后上报 ' + fmtAgo(it.lastIngestAt) + '（阈值 ' + prefs.staleHours + ' 小时）。',
        '确认该 agent 是否仍在使用；若已停用，可在「设备」页禁用该设备。')
    }
    const skew = Number(it.clockSkewMs) || 0
    if (Math.abs(skew) > Math.max(1, Number(prefs.skewSec) || 300) * 1000) {
      add('warn', 'clock-skew', who + ' 时钟偏差 ' + (skew / 1000).toFixed(0) + ' 秒',
        '设备时间与服务器相差 ' + Math.abs(skew / 1000).toFixed(0) + ' 秒，会影响「今天」与峰谷时段归属。',
        '在该设备上校准系统时间（NTP），然后重新同步。')
    }
    if (Number(it.invalid) > 0) {
      add('warn', 'ingest-invalid', who + ' 有 ' + fmtInt(it.invalid) + ' 条记录被拒',
        '云端校验未通过（缺字段 / 类型不符 / 超长）。',
        '查看该 agent 的上报日志与 docs/INGEST-API.zh.md 的必填字段表。')
    }
    if (Number(it.duplicates) > 0 && Number(it.accepted) + Number(it.duplicates) > 0) {
      const rate = Number(it.duplicates) / (Number(it.accepted) + Number(it.duplicates))
      if (rate > 0.9 && Number(it.duplicates) > 50) {
        add('info', 'ingest-dedup', who + ' 去重命中率 ' + pct(rate),
          '重复上报被去重（幂等生效），不重复计数。',
          '若持续接近 100%，说明该 agent 每次都全量重传，可调大本地同步间隔以减少请求。')
      }
    }
  }

  // ---------- 3. 口径漂移 / 估算占比 / 缓存命中 ----------
  const s = (c.overview && c.overview.summary) || null
  if (s) {
    const drift = Number(s.driftAbs) || 0
    const driftLimit = Math.max(Number(prefs.driftYuan) || 0, 0)
    if (drift > driftLimit && driftLimit > 0) {
      add('warn', 'cost-drift', '口径漂移 ¥' + fmtMoney(drift),
        '设备上报值与云端重算值累计相差 ¥' + fmtMoney(drift) + '（阈值 ¥' + fmtMoney(driftLimit) + '）。',
        '常见原因是插件版本较旧或价格表已更新：升级插件后在设备上执行 cost_recompute 补账。')
    }
    const rows = Number(s.rows) || 0
    const est = Number(s.estimatedRows) || 0
    if (rows > 0) {
      const share = est / rows
      if (share > (Number(prefs.estShare) || 0.2)) {
        add('warn', 'cost-estimated', '估算记录占比 ' + pct(share) + '（' + fmtInt(est) + '/' + fmtInt(rows) + ' 行）',
          '这些记录未命中精确单价表，用的是兜底价，金额仅供参考。',
          '核对「模型」页里的 provider/model 写法，或在服务端补齐单价表。')
      }
    }
    const hitBase = (Number(s.input) || 0) + (Number(s.cacheRead) || 0)
    if (hitBase > 100000) {
      const hit = (Number(s.cacheRead) || 0) / hitBase
      if (hit < (Number(prefs.hitRateMin) || 0.5)) {
        add('info', 'cache-hit-low', '缓存命中率 ' + pct(hit),
          '命中 ' + fmtInt(s.cacheRead) + ' / 未命中 ' + fmtInt(s.input) + '（阈值 ' + pct(prefs.hitRateMin, 0) + '）。',
          '长会话里复用上下文、避免频繁改动系统提示词可以提升命中率（命中价仅为输入价的 1/50）。')
      }
    }
  }

  // ---------- 4. 花费速率异常（今日 vs 近 7 日均值） ----------
  const hm = c.heatmap && c.heatmap.summary
  const today = c.overview && c.overview.today
  if (hm && today && Number(hm.last7 && hm.last7.days) >= 4) {
    const avg = Number((hm.last7 || {}).avgCost) || 0
    const cur = sliceReal(today)
    const ratio = Number(prefs.spikeRatio) || 3
    if (avg > 0.1 && cur > avg * ratio) {
      add('warn', 'cost-spike', '今日花费 ¥' + fmtMoney(cur) + '，是近 7 日均值的 ' + (cur / avg).toFixed(1) + ' 倍',
        '近 7 日均值 ¥' + fmtMoney(avg) + ' / 天（阈值 ' + ratio + ' 倍）。',
        '在「记录」页按今天筛选，确认是否有异常批量调用；必要时在「模型」页核对单价命中。')
    }
  }

  // ---------- 5. 月度预算 ----------
  const budget = Number(prefs.budgetMonth) || 0
  if (budget > 0 && c.overview && c.overview.month) {
    const used = sliceReal(c.overview.month)
    const ratio = used / budget
    if (ratio >= 1) {
      add('error', 'budget-exceeded', '本月按量花费 ¥' + fmtMoney(used) + ' 已超出预算 ¥' + fmtMoney(budget),
        '已用 ' + pct(ratio, 0) + '（月初至今）。', '在「记录」页定位主要消耗来源，或调高预算阈值。')
    } else if (ratio >= 0.8) {
      add('warn', 'budget-near', '本月按量花费已达预算 ' + pct(ratio, 0),
        '¥' + fmtMoney(used) + ' / ¥' + fmtMoney(budget) + '。', '留意剩余天数的消耗速度。')
    }
  }

  // ---------- 6. 订阅套餐闲置 ----------
  if (c.subscriptions && Array.isArray(c.subscriptions.items)) {
    const idle = Math.max(1, Number(prefs.subIdleDays) || 14)
    for (const it of c.subscriptions.items) {
      if (it.idleDays !== null && it.idleDays !== undefined && Number(it.idleDays) > idle) {
        add('info', 'sub-idle', '订阅套餐 ' + it.key + ' 已 ' + it.idleDays + ' 天未使用',
          '等效费用 ¥' + fmtMoney(it.cost) + ' / ' + fmtInt(it.calls) + ' 次调用。',
          '若已改用其它模型，可忽略；订阅制套餐闲置不产生额外费用，但会持续占用套餐额度。')
      }
    }
  }

  // ---------- 7. 插件版本不一致 ----------
  const versions = new Set(items.filter((x) => x.pluginVersion).map((x) => String(x.pluginVersion)))
  if (versions.size > 1) {
    add('info', 'plugin-version-drift', '插件版本不一致：' + Array.from(versions).sort().join(' / '),
      '不同设备的插件版本不同，个别机器可能缺少补账与口径修复。',
      '把各机升级到同一版本，然后在新版设备上执行 cost_recompute 补账。')
  }

  // ---------- 8. 区间无数据 ----------
  if (s && Number(s.calls) === 0 && Number(s.rows) === 0 && (c.overview.range !== 'all')) {
    add('info', 'range-empty', '当前区间没有任何记录',
      '换个时间范围或清空筛选试试。', '也可能是该区间的数据还没同步上来。')
  }

  const rank = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => (rank[a.level] - rank[b.level]) || a.code.localeCompare(b.code))
}

/** 计数摘要：{ error, warn, info, total, level } */
export function summarizeAlerts(items) {
  const list = Array.isArray(items) ? items : []
  const error = list.filter((x) => x.level === 'error').length
  const warn = list.filter((x) => x.level === 'warn').length
  const info = list.filter((x) => x.level === 'info').length
  return { error, warn, info, total: list.length, level: error ? 'error' : warn ? 'warn' : info ? 'info' : 'ok' }
}
