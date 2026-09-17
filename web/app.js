// ============================================================
// dsh-cost-cloud 看板 —— 应用装配
//   · 登录门（Cookie 会话）
//   · 导航分组：纵览（概览 / 热力图 / 趋势）· 用量（订阅 / 矩阵 / 设备 / 模型 / 记录）· 运维（监控 / 设置）
//   · 吸顶工具栏：区间、筛选、自动刷新、深链（#/view）
// 无构建、无依赖：原生 ES 模块
// ============================================================
import {
  state, setState, setPrefs, api, post, patch, el, qs, download,
  RANGES, HEAT_WINDOWS, HEAT_METRICS, SUB_WINDOWS, COLOR_LIST,
  fmtMoney, fmtInt, fmtTokens, fmtTime, fmtAgo, fmtPct, fmtDelta, fmtClock, fmtDur, fmtMetric,
  colorForSource, DOW_LONG, DOW_ORDER, sliceReal, sliceSub, sliceCalls, sliceTokens,
} from './state.js'
import {
  cards, table, stackedBars, legend, matrixTable, sourceDot, barList, deviceTag,
  heatCalendar, heatGrid, alertList, sparkline, freshnessBar, deltaBadge, heatLegend,
} from './views.js'
import { computeAlerts, summarizeAlerts } from './alerts.js'

const VIEWS = [
  { id: 'overview', label: '概览', icon: '▤', group: '纵览', desc: '区间 KPI、Agent / 设备分布与口径漂移' },
  { id: 'heatmap', label: '热力图', icon: '▩', group: '纵览', desc: '日历格子看每天，星期×小时看时段（高峰半价一眼可见）' },
  { id: 'trend', label: '趋势', icon: '◱', group: '纵览', desc: '按天 / 周 / 月 × 设备 / Agent / 模型 / 项目' },
  { id: 'subscriptions', label: '订阅服务', icon: '◆', group: '用量', desc: '订阅与按量分开口径、套餐明细与闲置监控' },
  { id: 'matrix', label: '设备 × Agent', icon: '▦', group: '用量', desc: '行=设备、列=Agent，行列合计与总计恒等' },
  { id: 'devices', label: '设备', icon: '🖥', group: '用量', desc: '改名 / 禁用 / 轮换令牌 / 清空某机数据' },
  { id: 'models', label: '模型', icon: '◎', group: '用量', desc: '各模型的用量与花费，含超期折叠的历史日汇总' },
  { id: 'records', label: '记录', icon: '☰', group: '用量', desc: '逐条明细：设备 × Agent × 模型 × 会话 × tokens × 费用' },
  { id: 'monitor', label: '监控', icon: '◈', group: '运维', desc: '告警规则、上报新鲜度、成本速率与阈值设置' },
  { id: 'settings', label: '设置', icon: '⚙', group: '运维', desc: '版本 / 数据库 / 接入契约 / 管理员口令 / 单价表' },
]
const GROUPS = ['纵览', '用量', '运维']

const data = {
  overview: null, heatmap: null, miniHeat: null, subscriptions: null, matrix: null, devices: null, trend: null,
  models: null, records: null, health: null, config: null, syncHealth: null, prices: null,
}

let autoTimer = null
let autoRemain = 0
let autoLabel = null

// ---------- 启动 ----------
async function boot() {
  setState({ view: viewFromHash() || state.view })
  let authed = false
  try {
    const s = await api('session')
    setState({ authed: true, sessionExpiresAt: s.expiresAt })
    authed = true
  } catch (e) {
    setState({ authed: false, error: '' })
  }
  render()
  // 关键：带会话刷新页面时也必须拉数据（此前只有登录成功路径会调用 loadAll，
  // 导致刷新后永远停在「加载中…」且没有任何数据请求）。
  if (authed) await loadAll()
}

function viewFromHash() {
  const m = /^#\/?([a-z-]+)/i.exec(String((globalThis.location && globalThis.location.hash) || ''))
  if (!m) return ''
  const id = m[1].toLowerCase()
  return VIEWS.some((v) => v.id === id) ? id : ''
}

function render() {
  const root = document.getElementById('app')
  try {
    root.innerHTML = ''
    root.className = ''
    if (!state.authed) { root.appendChild(loginView()); return }
    root.appendChild(layout())
    armAutoRefresh()
  } catch (e) {
    // 绝不允许因为渲染异常而留下空白页：把真实错误显示出来
    root.className = ''
    root.appendChild(el('div', { class: 'banner err', style: { margin: '24px' } },
      ['界面渲染异常：' + (e && e.message ? e.message : String(e))]))
  }
}

function loginView() {
  const input = el('input', { class: 'input', type: 'password', placeholder: '管理员口令', autofocus: 'true' })
  const err = el('div', { class: 'err' })
  const btn = el('button', { class: 'btn primary' }, '登录')
  async function submit() {
    err.textContent = ''
    btn.disabled = true
    try {
      await post('login', { password: input.value })
      setState({ authed: true })
      render()
      loadAll()
    } catch (e) {
      err.textContent = e.message === 'BAD_CREDENTIALS' ? '口令不正确' : ('登录失败：' + e.message)
      btn.disabled = false
    }
  }
  btn.addEventListener('click', submit)
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit() })
  return el('div', { class: 'login-wrap' }, el('div', { class: 'login' }, [
    el('h1', {}, 'DSH 花费云端'),
    el('div', { class: 'hint' }, '多机 · 多 Agent 用量与花费汇总看板'),
    input, btn, err,
  ]))
}

// ---------- 外壳 ----------
function layout() {
  const summary = summarizeAlerts(state.alerts)
  const rail = el('div', { class: 'rail' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'dot' }),
      el('span', {}, ['DSH 花费云端', el('span', { class: 'brand-sub' }, '多机 · 多 Agent')]),
    ]),
    ...GROUPS.map((g) => el('div', { class: 'nav-group' }, [
      el('div', { class: 'nav-sec' }, g),
      ...VIEWS.filter((v) => v.group === g).map((v) => el('button', {
        class: 'nav-item ' + (state.view === v.id ? 'on' : ''),
        title: v.desc,
        onClick: () => go(v.id),
      }, [el('span', { class: 'ic' }, v.icon), el('span', { class: 'lbl' }, v.label), navBadge(v.id, summary)])),
    ])),
    el('div', { class: 'rail-foot' }, [
      el('div', { class: 'row', style: { gap: '6px' } }, [
        el('span', { class: 'chip' }, '服务 v' + (data.health ? data.health.serviceVersion : '—')),
        el('span', { class: 'chip' }, 'syncVer ' + (data.config ? data.config.syncVer : '—')),
      ]),
      el('div', { class: 'hint', style: { marginTop: '6px' } }, '全部时间口径：北京时间（UTC+8）'),
      summary.total
        ? el('div', { style: { marginTop: '6px' } }, el('button', { class: 'btn', onClick: () => go('monitor') },
          summarizeText(summary)))
        : null,
      el('div', { style: { marginTop: '8px' } }, el('button', { class: 'btn', onClick: logout }, '退出登录')),
    ]),
  ])
  const main = el('div', { class: 'main' }, [topbar(), body()])
  return el('div', { class: 'layout' }, [rail, main])
}

function summarizeText(s) {
  const bits = []
  if (s.error) bits.push(s.error + ' 严重')
  if (s.warn) bits.push(s.warn + ' 警告')
  if (s.info) bits.push(s.info + ' 提示')
  return '监控：' + (bits.join(' · ') || '正常')
}

function navBadge(id, summary) {
  if (id === 'monitor' && summary.total) {
    return el('span', { class: 'nav-badge ' + summary.level }, summary.error || summary.warn || summary.info)
  }
  if (id === 'subscriptions' && data.subscriptions) {
    const share = Number(data.subscriptions.totals.subShare) || 0
    if (share > 0) return el('span', { class: 'nav-badge sub' }, fmtPct(share, 0))
  }
  return null
}

function go(id) {
  setState({ view: id, error: '', drill: null })
  try { if (globalThis.location) globalThis.location.hash = '#/' + id } catch (e) { /* 忽略 */ }
  render()
  loadView(id)
}

// ---------- 工具栏 ----------
function topbar() {
  const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0]
  const summary = summarizeAlerts(state.alerts)
  const rangeGroup = el('div', { class: 'btn-group' }, RANGES.map((r) => el('button', {
    class: state.range === r.id ? 'on' : '',
    onClick: () => { setState({ range: r.id, customFrom: 0, customTo: 0, recordsCursor: 0 }); render(); loadView(state.view) },
  }, r.label)))
  const autoGroup = el('div', { class: 'btn-group' }, [
    { s: 0, label: '自动刷新关' }, { s: 30, label: '30s' }, { s: 60, label: '60s' }, { s: 300, label: '5m' },
  ].map((o) => el('button', {
    class: Number(state.autoRefresh) === o.s ? 'on' : '',
    onClick: () => { setPrefs({ autoRefresh: o.s }); setState({ autoRefresh: o.s }); render() },
  }, o.label)))
  autoLabel = el('span', { class: 'chip' }, autoText())
  const filterCount = state.filterDevices.length + state.filterSources.length

  const row1 = el('div', { class: 'tb-row' }, [
    el('h1', { class: 'h1' }, view.label),
    el('span', { class: 'h1-sub hint' }, view.desc),
    el('span', { class: 'spacer' }),
    summary.total ? el('span', {
      class: 'chip ' + summary.level, title: '点击进入监控页', onClick: () => go('monitor'),
    }, summarizeText(summary)) : el('span', { class: 'chip ok' }, '监控正常'),
    autoLabel,
    autoGroup,
    el('button', { class: 'btn', onClick: () => loadView(state.view) }, '刷新'),
    state.view === 'records' || state.view === 'matrix'
      ? el('button', { class: 'btn', onClick: () => download('export.csv?' + qs().toString()) }, '导出 CSV')
      : null,
  ])
  const row2 = el('div', { class: 'tb-row' }, [
    el('span', { class: 'hint' }, '区间'), rangeGroup,
    viewControl(),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn' + (filterCount ? ' active' : ''),
      onClick: () => { setState({ showFilters: !state.showFilters }); render() },
    }, '筛选' + (filterCount ? '（' + filterCount + '）' : '')),
    state.range === 'custom'
      ? el('button', { class: 'btn', onClick: () => { setState({ range: '7d', customFrom: 0, customTo: 0 }); render(); loadView(state.view) } }, '退出自定义区间')
      : null,
  ])
  return el('div', { class: 'topbar' }, [row1, row2, state.showFilters ? filterPanel() : null])
}

function autoText() {
  if (!Number(state.autoRefresh)) return '自动刷新 关'
  return '自动刷新 ' + (autoRemain > 0 ? autoRemain + 's' : state.autoRefresh + 's')
}

/** 视图专属控件（粒度 / 分组 / 指标 / 热力图窗口） */
function viewControl() {
  if (state.view === 'trend') {
    return el('span', { class: 'row', style: { gap: '6px' } }, [
      el('div', { class: 'btn-group' }, ['day', 'week', 'month'].map((b) => el('button', {
        class: state.bucket === b ? 'on' : '',
        onClick: () => { setState({ bucket: b }); render(); loadView('trend') },
      }, b === 'day' ? '按天' : b === 'week' ? '按周' : '按月'))),
      el('div', { class: 'btn-group' }, [['device', '设备'], ['source', 'Agent'], ['model', '模型'], ['project', '项目']].map(([k, label]) => el('button', {
        class: state.trendGroup === k ? 'on' : '',
        onClick: () => { setState({ trendGroup: k }); render(); loadView('trend') },
      }, label))),
    ])
  }
  if (state.view === 'matrix') {
    return el('div', { class: 'btn-group' }, ['cost', 'tokens', 'calls'].map((k) => el('button', {
      class: state.matrixMetric === k ? 'on' : '',
      onClick: () => { setState({ matrixMetric: k }); render() },
    }, k === 'cost' ? '花费' : k === 'tokens' ? 'Tokens' : '调用')))
  }
  if (state.view === 'heatmap') {
    return el('span', { class: 'row', style: { gap: '6px' } }, [
      el('div', { class: 'btn-group' }, HEAT_METRICS.map((m) => el('button', {
        class: state.heatMetric === m.id ? 'on' : '',
        onClick: () => { setPrefs({ heatMetric: m.id }); setState({ heatMetric: m.id }); render() },
      }, m.label))),
      el('div', { class: 'btn-group' }, HEAT_WINDOWS.map((w) => el('button', {
        class: state.heatWindow === w.id ? 'on' : '',
        onClick: () => { setPrefs({ heatWindow: w.id }); setState({ heatWindow: w.id }); render(); loadView('heatmap') },
      }, w.label))),
    ])
  }
  if (state.view === 'subscriptions') {
    const win = SUB_WINDOWS.find((x) => x.id === (state.subWindow || 'all')) || SUB_WINDOWS[SUB_WINDOWS.length - 1]
    return el('span', { class: 'row', style: { gap: '6px' } }, [
      el('span', { class: 'hint' }, '窗口：' + win.label),
      el('div', { class: 'btn-group' }, SUB_WINDOWS.map((w) => el('button', {
        class: (state.subWindow || 'all') === w.id ? 'on' : '',
        onClick: () => { setState({ subWindow: w.id }); render(); loadView('subscriptions') },
      }, w.label))),
      el('div', { class: 'btn-group' }, [
        { id: 'cost', label: '总额' }, { id: 'subCost', label: '订阅' }, { id: 'realCost', label: '按量' },
      ].map((m) => el('button', {
        class: (state.subMetric || 'cost') === m.id ? 'on' : '',
        onClick: () => { setState({ subMetric: m.id }); render() },
      }, m.label))),
    ])
  }
  return null
}

function filterPanel() {
  const devSel = el('select', {
    class: 'select', multiple: 'true', size: '5',
    onChange: (e) => { setState({ filterDevices: Array.from(e.target.selectedOptions).map((o) => o.value) }); loadView(state.view) },
  }, deviceList().map((d) => el('option', { value: d.id, selected: state.filterDevices.includes(d.id) }, d.name)))
  const srcSel = el('select', {
    class: 'select', multiple: 'true', size: '5',
    onChange: (e) => { setState({ filterSources: Array.from(e.target.selectedOptions).map((o) => o.value) }); loadView(state.view) },
  }, (data.sourcesAll || []).map((s) => el('option', { value: s.source, selected: state.filterSources.includes(s.source) }, s.source)))
  return el('div', { class: 'filter-panel' }, [
    el('div', { class: 'fp-col' }, [el('div', { class: 'hint' }, '设备（可多选，按住 Ctrl / ⌘）'), devSel]),
    el('div', { class: 'fp-col' }, [el('div', { class: 'hint' }, 'Agent（可多选）'), srcSel]),
    el('div', { class: 'fp-col fp-actions' }, [
      el('div', { class: 'hint' }, '筛选会作用于本页所有数字（含图表与导出）。'),
      el('button', {
        class: 'btn', onClick: () => { setState({ filterDevices: [], filterSources: [], recordsCursor: 0 }); render(); loadView(state.view) },
      }, '清除筛选'),
    ]),
  ])
}

// data.devices 保存的是 /devices 的整个响应对象 {ok, devices, sources}，
// 不是数组 —— 这里统一取数组，避免把对象当数组遍历。
function deviceList() {
  return data.devices && Array.isArray(data.devices.devices) ? data.devices.devices : []
}

function body() {
  const wrap = el('div', {})
  if (state.error) wrap.appendChild(el('div', { class: 'banner err' }, ['加载失败：' + state.error]))
  if (state.loading && !data[state.view]) wrap.appendChild(el('div', { class: 'hint' }, '加载中…'))
  switch (state.view) {
    case 'overview': wrap.appendChild(viewOverview()); break
    case 'heatmap': wrap.appendChild(viewHeatmap()); break
    case 'subscriptions': wrap.appendChild(viewSubscriptions()); break
    case 'monitor': wrap.appendChild(viewMonitor()); break
    case 'matrix': wrap.appendChild(viewMatrix()); break
    case 'devices': wrap.appendChild(viewDevices()); break
    case 'trend': wrap.appendChild(viewTrend()); break
    case 'models': wrap.appendChild(viewModels()); break
    case 'records': wrap.appendChild(viewRecords()); break
    case 'settings': wrap.appendChild(viewSettings()); break
    default: break
  }
  return wrap
}

function panel(title, right, children, cls) {
  return el('div', { class: 'panel ' + (cls || '') }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, title),
      el('span', { class: 'spacer' }),
      right || null,
    ]),
    ...(Array.isArray(children) ? children : [children]),
  ])
}

// ---------- 概览 ----------
function viewOverview() {
  const o = data.overview
  if (!o) return el('div', { class: 'hint' }, '加载中…')
  const s = o.summary
  const hitRate = (s.input + s.cacheRead) > 0 ? (s.cacheRead / (s.input + s.cacheRead) * 100) : 0
  const mini = data.miniHeat
  const spark = mini ? mini.daily.map((d) => d.realCost) : []
  const prevDelta = (cur, prev) => (Number(s.prevHas) && Number(prev) > 0 ? (Number(cur) - Number(prev)) / Number(prev) : null)
  const wrap = el('div', {})
  const summary = summarizeAlerts(state.alerts)

  if (summary.error || summary.warn) {
    wrap.appendChild(el('div', { class: 'banner row', style: { gap: '10px' } }, [
      el('span', { class: 'tag ' + (summary.error ? 'red' : 'amber') }, summary.error ? '严重' : '警告'),
      el('span', {}, (state.alerts.find((a) => a.level === (summary.error ? 'error' : 'warn')) || {}).title || ''),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', onClick: () => go('monitor') }, '查看监控 →'),
    ]))
  }

  wrap.appendChild(cards([
    {
      title: '区间按量花费', value: '¥' + fmtMoney(s.realCost),
      sub: '区间 ' + (state.range === 'custom' ? '自定义' : (RANGES.find((r) => r.id === state.range) || {}).label) + ' · ' + fmtInt(s.realCalls) + ' 次',
      tag: o.excludedDevice ? '已排除本机' : null, tagKind: 'amber',
      delta: prevDelta(s.realCost, s.prevRealCost), spark, sparkColor: 'var(--blue)',
    },
    {
      title: '订阅等效（参考）', value: '¥' + fmtMoney(s.subEquivalent),
      sub: fmtInt(s.subCalls) + ' 次 · ' + fmtTokens(s.subTokens) + ' tokens',
      tag: '订阅', tagKind: 'green',
      delta: prevDelta(s.subEquivalent, s.prevSubCost),
    },
    {
      title: '区间调用 / Tokens', value: fmtInt(s.realCalls),
      sub: fmtTokens(s.realTokens) + ' tokens',
      delta: prevDelta(s.realCalls, s.prevRealCalls), invert: false,
    },
    { title: '缓存命中率', value: hitRate.toFixed(1) + '%', sub: '命中 ' + fmtTokens(s.cacheRead) + ' / 未命中 ' + fmtTokens(s.input) },
    { title: '今日（北京）', value: '¥' + fmtMoney(sliceReal(o.today)), sub: fmtInt(sliceCalls(o.today)) + ' 次 · ' + fmtTokens(sliceTokens(o.today)) },
    { title: '本月（北京）', value: '¥' + fmtMoney(sliceReal(o.month)), sub: fmtInt(sliceCalls(o.month)) + ' 次 · ' + fmtTokens(sliceTokens(o.month)) },
    { title: '全部累计', value: '¥' + fmtMoney(sliceReal(o.all)), sub: '自 ' + (o.firstTs ? fmtTime(o.firstTs) : '—') + ' 起' },
    {
      title: '峰 / 闲时段花费', value: '¥' + fmtMoney(s.peakCost) + ' / ¥' + fmtMoney(s.offCost),
      sub: '高峰 09-12 · 14-18（工作日），闲时半价',
    },
  ]))

  if (mini) {
    wrap.appendChild(panel('近 30 天花费热力（点击格子下钻到当天记录）',
      el('button', { class: 'btn', onClick: () => go('heatmap') }, '打开热力图 →'),
      heatCalendar(mini.daily, {
        metric: 'cost', kind: 'money', note: '窗口：近 30 天（北京日历）',
        onPick: (date, from, to) => {
          setState({ view: 'records', range: 'custom', customFrom: from, customTo: to, recordsCursor: 0 })
          go('records')
        },
      })))
  }

  wrap.appendChild(panel('按 Agent（source）', el('span', { class: 'hint' }, '点击行可下钻到该 Agent 记录'),
    o.sources.length
      ? table([
        { key: 'source', label: 'Agent', render: (r) => sourceDot(r.source, o.sources.map((x) => x.source)) },
        { key: 'cost', label: '花费 (CNY)', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'devices', label: '来自设备', render: (r) => r.devices.length + ' 台' },
        { key: 'share', label: '占比', num: true, render: (r) => fmtPct(s.cost > 0 ? r.cost / s.cost : 0) },
      ], o.sources.map((r) => Object.assign({}, r, { __click: () => { setState({ view: 'records', filterSources: [r.source], recordsCursor: 0 }); go('records') } })))
      : el('div', { class: 'hint' }, '暂无数据 —— 在插件里配置云端地址与令牌后点击「立即同步」。')))

  wrap.appendChild(panel('按设备', el('span', { class: 'hint' }, '点击行下钻到该机趋势'),
    deviceTable(o.devices, state.view)))

  if (s.driftAbs > 0.01) {
    wrap.appendChild(el('div', { class: 'banner' }, [
      el('b', {}, '口径漂移提示：'),
      '本次区间内设备上报值与云端重算值累计相差 ¥' + fmtMoney(s.driftAbs) + '（绝对值）。',
      '常见原因是某台设备的插件版本较旧或价格表已更新 —— 可在「设备」页查看各机的插件版本，必要时在该机执行 cost_recompute 补账。',
    ]))
  }
  return wrap
}

function deviceTable(list, viewId) {
  if (!list || !list.length) return el('div', { class: 'hint' }, '暂无设备')
  return table([
    { key: 'name', label: '设备', render: (r) => el('div', {}, [el('div', {}, r.name), el('div', { class: 'dim mono', style: { fontSize: '11px' } }, r.device)]) },
    { key: 'sources', label: 'Agent', render: (r) => el('div', { class: 'row', style: { gap: '4px' } }, (r.sources || []).map((x) => el('span', { class: 'tag' }, x))) },
    { key: 'cost', label: '花费 (CNY)', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
    { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
    { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
  ], list.map((r) => Object.assign({}, r, {
    __click: () => { setState({ filterDevices: [r.device], view: 'trend' }); go('trend') },
  })))
}

// ---------- 热力图 ----------
function viewHeatmap() {
  const h = data.heatmap
  if (!h) return el('div', { class: 'hint' }, '加载中…')
  const metricDef = HEAT_METRICS.find((m) => m.id === state.heatMetric) || HEAT_METRICS[0]
  const s = h.summary
  const wrap = el('div', {})
  const peakShare = (s.peakCost + s.offCost) > 0 ? s.peakCost / (s.peakCost + s.offCost) : 0

  wrap.appendChild(cards([
    { title: '窗口花费', value: '¥' + fmtMoney(s.cost), sub: h.fromKey + ' → ' + h.toKey + '（' + s.windowDays + ' 天）' },
    { title: '活跃天数', value: s.activeDays + ' / ' + s.windowDays, sub: '有记录的日历天（连续 ' + s.streak + ' 天）' },
    { title: '单日最高', value: '¥' + fmtMoney(s.maxDay.cost), sub: (s.maxDay.date || '—') + ' · ' + fmtInt(s.maxDay.calls) + ' 次' },
    { title: '日均（活跃日）', value: '¥' + fmtMoney(s.avgActiveCost), sub: '按窗口日均 ¥' + fmtMoney(s.avgDayCost) },
    { title: '高峰时段花费占比', value: fmtPct(peakShare), sub: '¥' + fmtMoney(s.peakCost) + ' 高峰 / ¥' + fmtMoney(s.offCost) + ' 闲时' },
    { title: '缓存命中率', value: fmtPct(s.cacheHitRate), sub: '命中 ' + fmtTokens(s.cacheRead) + ' / 未命中 ' + fmtTokens(s.input) },
    { title: '最忙时段', value: DOW_LONG[s.maxCell.dow] + ' ' + String(s.maxCell.hour).padStart(2, '0') + ':00', sub: '¥' + fmtMoney(s.maxCell.cost) + ' · ' + fmtInt(s.maxCell.calls) + ' 次' },
  ]))

  wrap.appendChild(panel('日历热力图 · ' + metricDef.label, el('span', { class: 'hint' }, '窗口 ' + h.fromKey + ' → ' + h.toKey),
    heatCalendar(h.daily, {
      metric: metricDef.id, kind: metricDef.kind,
      note: '点击格子 = 下钻到当天记录',
      onPick: (date, from, to) => {
        setState({ range: 'custom', customFrom: from, customTo: to, recordsCursor: 0 })
        go('records')
      },
    })))

  wrap.appendChild(panel('星期 × 小时分布 · ' + metricDef.label,
    el('span', { class: 'hint' }, '仅统计明细（ts > 0），日汇总快照不计入时段'),
    heatGrid(h.hourly, { metric: metricDef.id, kind: metricDef.kind })))

  wrap.appendChild(el('div', { class: 'grid-2' }, [
    panel('按星期', el('span', { class: 'hint' }, '汇总窗口内每天 0-24 时'),
      barList(DOW_ORDER.map((dow) => ({
        label: DOW_LONG[dow],
        value: (h.byWeekday.find((x) => x.dow === dow) || {})[metricDef.id === 'tokens' || metricDef.id === 'calls' ? 'calls' : 'cost'] || 0,
      })), { format: (v) => fmtMoney(v, 2) })),
    panel('按小时', el('span', { class: 'hint' }, '高峰小时用琥珀色标注'),
      barList(h.byHour.map((x) => ({
        label: String(x.hour).padStart(2, '0') + ':00',
        value: metricDef.id === 'tokens' || metricDef.id === 'calls' ? x.calls : x.cost,
        color: x.peakHour ? 'var(--amber)' : 'var(--blue)',
      })), { format: (v) => fmtMoney(v, 2) })),
  ]))

  wrap.appendChild(el('div', { class: 'banner' }, [
    el('b', {}, '口径说明：'),
    '日历格按北京日历天补零铺满（没有记录的日子也在图上，用空格表示）；时段格只取明细记录 —— ',
    '历史日汇总（rollup）的时间戳可能为 0，聚合时会被回退到当日正午，若一并计入会凭空造出一个 12 点的假高峰。',
  ]))
  return wrap
}

// ---------- 订阅服务 ----------
function viewSubscriptions() {
  const sub = data.subscriptions
  if (!sub) return el('div', { class: 'hint' }, '加载中…')
  const t = sub.totals
  const metric = state.subMetric || 'cost'
  const wrap = el('div', {})
  const items = sub.items || []
  const idle = items.filter((x) => x.idleDays !== null && Number(x.idleDays) > Number(state.prefs.subIdleDays || 14))
  const plans = Object.keys(sub.plans || {})

  wrap.appendChild(cards([
    {
      title: '订阅等效费用', value: '¥' + fmtMoney(t.subCost),
      sub: '窗口 ' + sub.fromKey + ' → ' + sub.toKey + ' · 占总花费 ' + fmtPct(t.subShare) + '（按套餐单价折算，不是实际扣费）',
      tag: t.planCount + ' 个套餐', tagKind: 'green',
    },
    { title: '订阅调用', value: fmtInt(t.subCalls), sub: fmtTokens(t.subTokens) + ' tokens' },
    { title: '按量花费', value: '¥' + fmtMoney(t.realCost), sub: fmtInt(t.realCalls) + ' 次 · ' + fmtTokens(t.realTokens) + ' tokens' },
    {
      title: '窗口总花费', value: '¥' + fmtMoney(t.cost),
      sub: '按量 + 订阅等效；两者口径互不混入',
    },
    {
      title: '闲置套餐', value: String(idle.length),
      sub: idle.length
        ? idle.map((x) => x.key + '（' + x.idleDays + ' 天）').join('、')
        : '全部套餐在阈值（' + state.prefs.subIdleDays + ' 天）内有使用',
      tag: idle.length ? '留意' : '正常', tagKind: idle.length ? 'amber' : 'green',
    },
  ]))

  // 订阅 vs 按量：按天堆叠
  const buckets = sub.byDay.map((d) => d.date)
  wrap.appendChild(panel('订阅 vs 按量（按天）',
    el('span', { class: 'hint' }, '订阅为等效费用；按量即实际计费'),
    [
      stackedBars({
        buckets,
        series: [
          { id: '按量计费', points: sub.byDay.map((d) => d.realCost), color: '#4176e6' },
          { id: '订阅等效', points: sub.byDay.map((d) => d.subCost), color: '#16a34a' },
        ],
      }, { labelSlice: 5 }),
      legend([{ label: '按量计费', color: '#4176e6' }, { label: '订阅等效', color: '#16a34a' }]),
    ]))

  wrap.appendChild(panel('订阅套餐明细', el('span', { class: 'hint' }, '等效费用 = tokens × 套餐单价；仅供横向比较'),
    items.length ? table([
      { key: 'key', label: '套餐 / 模型', render: (r) => el('div', {}, [
        el('div', { class: 'mono' }, r.key),
        el('div', { class: 'dim', style: { fontSize: '11px' } }, r.provider + ' · ' + (r.estimated ? '等效单价（估算）' : '精确单价')),
      ]) },
      { key: 'cost', label: '等效费用', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
      { key: 'share', label: '订阅占比', num: true, render: (r) => fmtPct(r.share) },
      { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
      { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
      { key: 'avgPerActiveDay', label: '活跃日均', num: true, render: (r) => '¥' + fmtMoney(r.avgPerActiveDay) },
      { key: 'activeDays', label: '使用天数', num: true, render: (r) => fmtInt(r.activeDays) },
      { key: 'firstDay', label: '首次', render: (r) => r.firstDay || '—' },
      { key: 'lastDay', label: '最近', render: (r) => r.lastDay || '—' },
      {
        key: 'idleDays', label: '闲置', num: true,
        render: (r) => (r.idleDays === null ? '—' : (Number(r.idleDays) > Number(state.prefs.subIdleDays || 14)
          ? el('span', { class: 'tag amber' }, r.idleDays + ' 天')
          : r.idleDays + ' 天')),
      },
      { key: 'devices', label: '设备数', num: true, render: (r) => fmtInt(r.devices) },
    ], items) : el('div', { class: 'hint' }, '区间内没有订阅记录（订阅记录由插件在 subscription=true 时上报）。')))

  wrap.appendChild(el('div', { class: 'grid-2' }, [
    panel('按设备 / Agent', el('span', { class: 'hint' }, '谁在用订阅套餐'),
      sub.byDevice.length ? table([
        { key: 'deviceName', label: '设备' },
        { key: 'source', label: 'Agent', render: (r) => el('span', { class: 'tag blue' }, r.source) },
        { key: 'key', label: '套餐', render: (r) => el('span', { class: 'mono' }, r.key) },
        { key: 'cost', label: '等效费用', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'lastDay', label: '最近', render: (r) => r.lastDay || '—' },
      ], sub.byDevice) : el('div', { class: 'hint' }, '暂无订阅记录')),
    panel('按月', el('span', { class: 'hint' }, '订阅额的月度堆积'),
      sub.byMonth.length ? table([
        { key: 'month', label: '月份' },
        { key: 'subCost', label: '订阅等效', num: true, render: (r) => '¥' + fmtMoney(r.subCost) },
        { key: 'realCost', label: '按量', num: true, render: (r) => '¥' + fmtMoney(r.realCost) },
        { key: 'cost', label: '合计', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        { key: 'subCalls', label: '订阅调用', num: true, render: (r) => fmtInt(r.subCalls) },
        { key: 'subTokens', label: '订阅 Tokens', num: true, render: (r) => fmtTokens(r.subTokens) },
      ], sub.byMonth) : el('div', { class: 'hint' }, '暂无数据')),
  ]))

  wrap.appendChild(el('div', { class: 'grid-2' }, [
    panel('套餐单价表（等效费用口径）', el('span', { class: 'hint' }, 'CNY / 1M tokens'),
      plans.length ? table([
        { key: 'plan', label: '套餐' },
        { key: 'input', label: '输入（未命中）', num: true },
        { key: 'cacheRead', label: '缓存命中', num: true },
        { key: 'output', label: '输出', num: true },
      ], plans.map((k) => Object.assign({ plan: k }, sub.plans[k]))) : el('div', { class: 'hint' }, '服务端未配置订阅单价')),
    panel('最近订阅记录', el('span', { class: 'hint' }, '按时间倒序，最多 20 条'),
      sub.recent.length ? table([
        { key: 'ts', label: '时间（北京）', render: (r) => fmtTime(r.ts || Date.parse(r.date + 'T12:00:00+08:00')) },
        { key: 'deviceName', label: '设备' },
        { key: 'source', label: 'Agent', render: (r) => el('span', { class: 'tag blue' }, r.source) },
        { key: 'model', label: '模型', render: (r) => el('span', { class: 'mono' }, r.provider + '/' + r.model) },
        { key: 'calls', label: '次数', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'cost', label: '等效', num: true, render: (r) => '¥' + fmtMoney(r.cost, 4) },
      ], sub.recent) : el('div', { class: 'hint' }, '暂无订阅记录')),
  ]))

  wrap.appendChild(el('div', { class: 'banner' }, [
    el('b', {}, '订阅口径：'),
    '订阅制（包月 / 编码套餐）没有按 token 的真实账单，插件会用套餐单价折算一份「等效费用」并标记 subscription=true；',
    '云端把它与按量计费分开统计，任何「总花费」卡片都不会把两者混在一起 —— 需要合并看时用本页的「区间总花费」。',
  ]))
  return wrap
}

// ---------- 监控 ----------
function viewMonitor() {
  const wrap = el('div', {})
  const summary = summarizeAlerts(state.alerts)
  const hm = data.miniHeat
  const o = data.overview
  const h = data.health

  wrap.appendChild(cards([
    { title: '严重', value: String(summary.error), sub: '需要立刻处理', kind: summary.error ? 'bad' : '' },
    { title: '警告', value: String(summary.warn), sub: '需要关注', kind: summary.warn ? 'warn' : '' },
    { title: '提示', value: String(summary.info), sub: '可择机优化', kind: '' },
    { title: '服务版本', value: h ? 'v' + h.serviceVersion : '—', sub: h ? '运行 ' + fmtDur(h.uptimeMs) : '—' },
    { title: '最近上报', value: h && h.lastIngestAt ? fmtAgo(h.lastIngestAt) : '—', sub: h && h.lastIngestAt ? fmtTime(h.lastIngestAt) : '尚无入库' },
    { title: '今日按量', value: o ? '¥' + fmtMoney(sliceReal(o.today)) : '—', sub: o ? fmtInt(sliceCalls(o.today)) + ' 次' : '' },
    {
      title: '近 7 日均值', value: hm ? '¥' + fmtMoney(hm.summary.last7.avgCost) : '—',
      sub: hm && o ? '今日 / 均值 = ' + (hm.summary.last7.avgCost > 0 ? (sliceReal(o.today) / hm.summary.last7.avgCost).toFixed(2) : '—') + '×' : '',
      spark: hm ? hm.daily.slice(-14).map((d) => d.cost) : null, sparkColor: 'var(--violet)',
    },
    {
      title: '本月按量', value: o ? '¥' + fmtMoney(sliceReal(o.month)) : '—',
      sub: Number(state.prefs.budgetMonth) > 0 && o
        ? '预算 ¥' + fmtMoney(state.prefs.budgetMonth) + ' · 已用 ' + fmtPct(sliceReal(o.month) / state.prefs.budgetMonth, 0)
        : '未设置预算',
    },
  ]))

  wrap.appendChild(panel('告警',
    el('span', { class: 'hint' }, '规则见下方阈值设置；每条都给出下一步动作'),
    alertList(state.alerts)))

  const items = (data.syncHealth && data.syncHealth.items) || []
  const staleMs = Math.max(1, Number(state.prefs.staleHours) || 24) * 3600000
  wrap.appendChild(panel('设备 × Agent 同步新鲜度',
    el('span', { class: 'hint' }, '进度条 = 距上次上报时长 / 阈值（' + state.prefs.staleHours + ' 小时）'),
    items.length ? table([
      { key: 'deviceName', label: '设备' },
      { key: 'source', label: 'Agent', render: (r) => el('span', { class: 'tag blue' }, r.source) },
      {
        key: 'lagMs', label: '新鲜度',
        render: (r) => el('div', { class: 'row', style: { gap: '8px' } }, [
          freshnessBar(r.lagMs === null || r.lagMs === undefined ? staleMs : r.lagMs, staleMs,
            (r.lagMs === null || r.lagMs === undefined) ? 'warn' : (r.lagMs > staleMs * 3 ? 'bad' : r.lagMs > staleMs ? 'warn' : 'ok')),
          el('span', { class: 'dim', style: { fontSize: '11.5px' } }, r.lastIngestAt ? fmtAgo(r.lastIngestAt) : '从未'),
        ]),
      },
      { key: 'pluginVersion', label: '插件版本', render: (r) => r.pluginVersion || '—' },
      {
        key: 'clockSkewMs', label: '时钟偏差', num: true,
        render: (r) => (Math.abs(r.clockSkewMs) > Math.max(1, Number(state.prefs.skewSec) || 300) * 1000
          ? el('span', { class: 'tag amber' }, (r.clockSkewMs / 1000).toFixed(0) + 's')
          : (r.clockSkewMs / 1000).toFixed(1) + 's'),
      },
      { key: 'accepted', label: '已接收', num: true, render: (r) => fmtInt(r.accepted) },
      { key: 'duplicates', label: '去重命中', num: true, render: (r) => fmtInt(r.duplicates) },
      { key: 'invalid', label: '非法', num: true, render: (r) => (r.invalid ? el('span', { class: 'tag amber' }, String(r.invalid)) : '0') },
      { key: 'dedupRate', label: '去重率', num: true, render: (r) => fmtPct(r.dedupRate) },
    ], items) : el('div', { class: 'hint' }, '暂无上报记录')))

  wrap.appendChild(panel('成本速率（近 30 天）',
    el('span', { class: 'hint' }, '柱子 = 每天（含订阅），折线 = 近 7 日均值'),
    hm ? [
      sparkline(hm.daily.map((d) => d.cost), { width: 900, height: 90, color: 'var(--violet)' }),
      el('div', { class: 'legend' }, [
        el('span', {}, '窗口合计 ¥' + fmtMoney(hm.summary.cost)),
        el('span', {}, '活跃 ' + hm.summary.activeDays + ' 天'),
        el('span', {}, '日均 ¥' + fmtMoney(hm.summary.avgDayCost)),
        el('span', {}, '单日最高 ¥' + fmtMoney(hm.summary.maxDay.cost) + '（' + (hm.summary.maxDay.date || '—') + '）'),
      ]),
    ] : el('div', { class: 'hint' }, '加载中…')))

  wrap.appendChild(panel('阈值与预算', el('span', { class: 'hint' }, '保存在浏览器本地（localStorage），只影响本页告警'),
    el('div', { class: 'prefs' }, [
      numField('月度按量预算（CNY）', 'budgetMonth', 0, '0 = 不告警'),
      numField('同步停滞阈值（小时）', 'staleHours', 1, '超过即告警'),
      numField('时钟偏差阈值（秒）', 'skewSec', 30, '设备时间校准'),
      numField('口径漂移阈值（CNY）', 'driftYuan', 0.5, '上报值 vs 云端重算'),
      numField('估算记录占比阈值', 'estShare', 0.05, '0~1，超过即告警'),
      numField('缓存命中率下限', 'hitRateMin', 0.05, '0~1，低于即提示'),
      numField('订阅闲置天数', 'subIdleDays', 1, '超过即提示'),
      numField('云端静默阈值（小时）', 'silenceHours', 1, '整体无上报'),
      numField('花费尖峰倍数', 'spikeRatio', 0.5, '今日 / 近 7 日均值'),
    ])))

  if (h) {
    wrap.appendChild(panel('服务信息', el('span', { class: 'hint' }, '与「设置」页同源'),
      el('div', { class: 'kv' }, [
        el('span', { class: 'k' }, '服务版本'), el('span', { class: 'mono' }, h.serviceVersion + ' · syncVer ' + h.syncVer),
        el('span', { class: 'k' }, '运行时长'), el('span', {}, fmtDur(h.uptimeMs)),
        el('span', { class: 'k' }, '数据库'), el('span', { class: 'mono', style: { wordBreak: 'break-all' } }, h.db.file + '（user_version=' + h.db.userVersion + '）'),
        el('span', { class: 'k' }, '时区口径'), el('span', {}, (data.config ? data.config.timezone : '—') + '（今日 = ' + (data.config ? data.config.todayKey : '—') + '）'),
        el('span', { class: 'k' }, '设备数 / Agent 数'), el('span', {}, deviceList().length + ' 台 / ' + ((data.devices && data.devices.sources) || []).length + ' 个'),
      ])))
  }
  return wrap
}

function numField(label, key, step, hint) {
  const input = el('input', {
    class: 'input', type: 'number', step: String(step || 1), value: String(state.prefs[key]),
    onChange: (e) => {
      const v = Number(e.target.value)
      setPrefs({ [key]: Number.isFinite(v) ? v : state.prefs[key] })
      recomputeAlerts()
      render()
    },
  })
  return el('div', { class: 'pref' }, [
    el('div', { class: 'hint' }, label),
    input,
    el('div', { class: 'dim', style: { fontSize: '11px' } }, hint || ''),
  ])
}

// ---------- 设备 × Agent 矩阵 ----------
function viewMatrix() {
  const m = data.matrix
  if (!m) return el('div', { class: 'hint' }, '加载中…')
  const wrap = el('div', {})
  const srcs = m.cols
  wrap.appendChild(panel('设备 × Agent 矩阵', el('span', { class: 'hint' }, '单元格口径见右上角；点击可下钻'),
    [
      srcs.length
        ? matrixTable(m, srcs, state.matrixMetric, (device, source) => {
          setState({ view: 'records', filterDevices: [device], filterSources: [source], recordsCursor: 0 })
          go('records')
        })
        : el('div', { class: 'hint' }, '暂无数据'),
      el('div', { class: 'hint', style: { marginTop: '8px' } },
        '行合计 = 该设备所有 Agent 之和，列合计 = 该 Agent 在所有设备之和，右下角 = 区间总计；三者恒等（含明细与历史日汇总）。'),
    ]))

  wrap.appendChild(el('div', { class: 'grid-2' }, [
    panel('各 Agent 占比', null,
      barList((data.overview ? data.overview.sources : []).map((s) => ({
        label: s.source, value: s.cost, color: colorForSource(s.source, srcs),
      })), { format: (v) => '¥' + fmtMoney(v) })),
    panel('同步健康度', el('span', { class: 'hint' }, '详细告警见「监控」页'),
      (data.syncHealth && data.syncHealth.items.length)
        ? table([
          { key: 'deviceName', label: '设备' },
          { key: 'source', label: 'Agent', render: (r) => sourceDot(r.source, srcs) },
          { key: 'pluginVersion', label: '插件版本', render: (r) => r.pluginVersion || '—' },
          { key: 'lastIngestAt', label: '最后上报', render: (r) => fmtAgo(r.lastIngestAt) },
          { key: 'clockSkewMs', label: '时钟偏差', num: true, render: (r) => (Math.abs(r.clockSkewMs) > 300000 ? el('span', { class: 'tag red' }, (r.clockSkewMs / 1000).toFixed(0) + 's') : (r.clockSkewMs / 1000).toFixed(1) + 's') },
          { key: 'accepted', label: '已接收', num: true, render: (r) => fmtInt(r.accepted) },
          { key: 'duplicates', label: '去重命中', num: true, render: (r) => fmtInt(r.duplicates) },
          { key: 'invalid', label: '非法', num: true, render: (r) => (r.invalid ? el('span', { class: 'tag amber' }, String(r.invalid)) : '0') },
        ], data.syncHealth.items)
        : el('div', { class: 'hint' }, '暂无上报记录')),
  ]))
  return wrap
}

// ---------- 设备 ----------
function viewDevices() {
  const d = data.devices
  if (!d) return el('div', { class: 'hint' }, '加载中…')
  const wrap = el('div', {})
  wrap.appendChild(panel('设备清单（' + d.devices.length + '）',
    el('span', { class: 'hint' }, '改名后可在插件端继续上报，名称不会被覆盖（名称锁定）'),
    d.devices.length ? table([
      { key: 'name', label: '设备', render: (r) => editableName(r) },
      { key: 'id', label: 'Device ID', render: (r) => el('span', { class: 'mono dim' }, r.id) },
      { key: 'sourceCount', label: 'Agent 数', num: true },
      { key: 'recordCount', label: '记录数', num: true, render: (r) => fmtInt(r.recordCount) },
      { key: 'cost', label: '累计花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
      { key: 'lastIngestAt', label: '最后上报', render: (r) => fmtAgo(r.lastIngestAt) },
      { key: 'ops', label: '操作', render: (r) => el('div', { class: 'row', style: { gap: '6px' } }, [
        el('button', { class: 'btn', onClick: () => toggleLock(r) }, r.nameLocked ? '解锁名称' : '锁定名称'),
        el('button', { class: 'btn', onClick: () => toggleDisabled(r) }, r.disabled ? '启用' : '禁用'),
        el('button', { class: 'btn', onClick: () => rotate(r) }, '轮换令牌'),
        el('button', { class: 'btn danger', onClick: () => wipe(r) }, '清空数据'),
      ]) },
    ], d.devices) : el('div', { class: 'hint' }, '还没有设备上报')))

  wrap.appendChild(panel('设备 × Agent 明细', null,
    d.sources.length ? table([
      { key: 'deviceId', label: '设备', render: (r) => (d.devices.find((x) => x.id === r.deviceId) || {}).name || r.deviceId },
      { key: 'source', label: 'Agent', render: (r) => sourceDot(r.source, d.sources.map((x) => x.source)) },
      { key: 'agentInstance', label: '实例', render: (r) => r.agentInstance || '—' },
      { key: 'agentVersion', label: 'Agent 版本', render: (r) => r.agentVersion || '—' },
      { key: 'pluginVersion', label: '插件版本', render: (r) => r.pluginVersion || '—' },
      { key: 'recordCount', label: '记录', num: true, render: (r) => fmtInt(r.recordCount) },
      { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
      { key: 'maxClientSeq', label: '水位 seq', num: true, render: (r) => fmtInt(r.maxClientSeq) },
      { key: 'lastIngestAt', label: '最后上报', render: (r) => fmtAgo(r.lastIngestAt) },
    ], d.sources) : el('div', { class: 'hint' }, '暂无 Agent 上报')))
  return wrap
}

function editableName(r) {
  const input = el('input', { class: 'input', value: r.name, style: { width: '170px' } })
  input.addEventListener('change', async () => {
    try { await patch('devices/' + encodeURIComponent(r.id), { name: input.value }); await loadView('devices') } catch (e) { setState({ error: e.message }) }
  })
  return el('div', {}, [input, el('div', { class: 'dim mono', style: { fontSize: '11px', marginTop: '3px' } }, r.id.slice(0, 16) + '…')])
}
async function toggleLock(r) { try { await patch('devices/' + encodeURIComponent(r.id), { nameLocked: !r.nameLocked }); await loadView('devices') } catch (e) { setState({ error: e.message }) } }
async function toggleDisabled(r) { try { await patch('devices/' + encodeURIComponent(r.id), { disabled: !r.disabled }); await loadView('devices') } catch (e) { setState({ error: e.message }) } }
async function rotate(r) {
  try {
    const out = await post('devices/' + encodeURIComponent(r.id) + '/rotate-token', {})
    window.prompt('新令牌（只显示这一次，请填入插件配置）：', out.token)
  } catch (e) { setState({ error: e.message }) }
}
async function wipe(r) {
  if (!window.confirm('清空「' + r.name + '」的全部云端记录？（该设备的本地数据不受影响，下次同步会重新上报）')) return
  try { await post('devices/' + encodeURIComponent(r.id) + '/delete-data', {}); await loadView('devices') } catch (e) { setState({ error: e.message }) }
}

// ---------- 趋势 ----------
function viewTrend() {
  const t = data.trend
  if (!t) return el('div', { class: 'hint' }, '加载中…')
  const series = t.series.map((s, i) => Object.assign({}, s, { color: COLOR_LIST[i % COLOR_LIST.length] }))
  const total = series.reduce((s, x) => s + x.points.reduce((a, b) => a + b, 0), 0)
  return panel('花费趋势', el('span', { class: 'hint' }, '合计 ¥' + fmtMoney(total) + ' · 粒度与分组见上方'), [
    stackedBars({ buckets: t.buckets, series }, { formatY: (v) => '¥' + fmtMoney(v, 2), labelSlice: state.bucket === 'month' ? 0 : 5 }),
    legend(series.map((s) => ({ label: s.id, color: s.color }))),
  ])
}

// ---------- 模型 ----------
function viewModels() {
  const m = data.models
  if (!m) return el('div', { class: 'hint' }, '加载中…')
  const items = m.items.filter((x) => x.kind === 'detail')
  const roll = m.items.filter((x) => x.kind === 'rollup')
  const total = items.reduce((s, x) => s + (Number(x.cost) || 0), 0)
  return el('div', {}, [
    panel('模型用量与花费', el('span', { class: 'hint' }, '仅统计明细（日汇总见下表）'),
      items.length ? table([
        { key: 'model', label: '模型' },
        { key: 'provider', label: 'Provider' },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'input', label: '输入', num: true, render: (r) => fmtTokens(r.input) },
        { key: 'cacheRead', label: '缓存命中', num: true, render: (r) => fmtTokens(r.cacheRead) },
        { key: 'output', label: '输出', num: true, render: (r) => fmtTokens(r.output) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        { key: 'share', label: '占比', num: true, render: (r) => fmtPct(total > 0 ? r.cost / total : 0) },
        { key: 'driftAbs', label: '漂移', num: true, render: (r) => (r.driftAbs > 0.01 ? el('span', { class: 'tag amber' }, '¥' + fmtMoney(r.driftAbs)) : '0') },
      ], items) : el('div', { class: 'hint' }, '暂无明细')),
    panel('历史日汇总（明细已超期折叠的部分）', null,
      roll.length ? table([
        { key: 'model', label: '模型' },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
      ], roll) : el('div', { class: 'hint' }, '暂无历史日汇总（明细仍在保留窗口内）')),
  ])
}

// ---------- 记录 ----------
function viewRecords() {
  const r = data.records
  if (!r) return el('div', { class: 'hint' }, '加载中…')
  const wrap = el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, '记录明细'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint' }, '筛选：' + [
        state.filterDevices.length ? state.filterDevices.length + ' 台设备' : '全部设备',
        state.filterSources.length ? state.filterSources.join('/') : '全部 Agent',
      ].join(' · ') + (state.range === 'custom' ? ' · 自定义区间' : '')),
      (state.filterDevices.length || state.filterSources.length || state.range === 'custom')
        ? el('button', { class: 'btn', onClick: () => { setState({ filterDevices: [], filterSources: [], range: '7d', customFrom: 0, customTo: 0, recordsCursor: 0 }); loadView('records') } }, '清除筛选')
        : null,
    ]),
    r.items.length ? table([
      { key: 'ts', label: '时间（北京）', render: (x) => fmtTime(x.ts || Date.parse(x.date + 'T12:00:00+08:00')) },
      { key: 'deviceName', label: '设备' },
      { key: 'source', label: 'Agent', render: (x) => el('span', {}, [el('span', { class: 'tag blue' }, x.source), x.agentInstance ? el('span', { class: 'tag' }, x.agentInstance) : null]) },
      { key: 'kind', label: '类型', render: (x) => x.kind === 'rollup' ? '日汇总' : '明细' },
      { key: 'model', label: '模型', render: (x) => el('span', { class: 'mono' }, x.model) },
      { key: 'sessionId', label: '会话', render: (x) => el('span', { class: 'dim mono', style: { fontSize: '11px' } }, x.sessionId ? x.sessionId.slice(0, 18) : '—') },
      { key: 'input', label: '输入', num: true, render: (x) => fmtTokens(x.input) },
      { key: 'cacheRead', label: '命中', num: true, render: (x) => fmtTokens(x.cacheRead) },
      { key: 'output', label: '输出', num: true, render: (x) => fmtTokens(x.output) },
      { key: 'calls', label: '次数', num: true, render: (x) => fmtInt(x.calls) },
      { key: 'cost', label: '花费', num: true, render: (x) => '¥' + fmtMoney(x.cost, 4) },
      { key: 'costBasis', label: '口径', render: (x) => el('span', { class: 'tag ' + (x.subscription ? 'green' : x.estimated ? 'amber' : '') }, x.subscription ? '订阅' : x.estimated ? '估算' : (x.costBasis || '—')) },
    ], r.items) : el('div', { class: 'hint' }, '没有符合条件的记录'),
    r.hasMore
      ? el('div', { style: { marginTop: '10px' } }, el('button', {
        class: 'btn',
        onClick: async () => {
          try {
            const more = await api('records?' + qs() + '&cursor=' + r.nextCursor + '&limit=50')
            r.items = r.items.concat(more.items)
            r.hasMore = more.hasMore
            r.nextCursor = more.nextCursor
            render()
          } catch (e) { setState({ error: e.message }) }
        },
      }, '加载更多'))
      : null,
  ])
  return wrap
}

// ---------- 设置 ----------
function viewSettings() {
  const c = data.config
  const h = data.health
  const wrap = el('div', {})
  if (!c || !h) return el('div', { class: 'hint' }, '加载中…')
  const p = data.prices ? data.prices.prices : null
  wrap.appendChild(panel('服务信息', null, [
    el('div', { class: 'kv', style: { marginTop: '8px' } }, [
      el('span', { class: 'k' }, '服务版本'), el('span', { class: 'mono' }, h.serviceVersion + ' · syncVer ' + h.syncVer),
      el('span', { class: 'k' }, '运行时长'), el('span', {}, fmtDur(h.uptimeMs)),
      el('span', { class: 'k' }, '数据库'), el('span', { class: 'mono', style: { wordBreak: 'break-all' } }, h.db.file + '（user_version=' + h.db.userVersion + '）'),
      el('span', { class: 'k' }, '最近一次上报'), el('span', {}, h.lastIngestAt ? fmtAgo(h.lastIngestAt) : '—'),
      el('span', { class: 'k' }, '时区口径'), el('span', {}, c.timezone + '（今日 = ' + c.todayKey + '）'),
      el('span', { class: 'k' }, '设备自注册'), el('span', {}, c.allowSelfRegister ? el('span', { class: 'tag amber' }, '已开启') : '已关闭'),
      el('span', { class: 'k' }, '共享引导令牌'), el('span', {}, c.deviceTokenSet ? '已设置' : '未设置'),
      el('span', { class: 'k' }, '上报限流'), el('span', {}, c.rateLimitPerMin + ' 次/分钟 · 单批上限 ' + c.maxBatchRecords + ' 条'),
      el('span', { class: 'k' }, '反代信任'), el('span', {}, c.trustProxy ? '信任 X-Forwarded-For' : '不信任（直连）'),
      el('span', { class: 'k' }, '单价表来源'), el('span', { class: 'mono' }, c.pricing.source),
    ]),
    c.insecureDev ? el('div', { class: 'banner err', style: { marginTop: '10px' } }, '当前以 ALLOW_INSECURE_DEV=1 运行：口令与会话密钥为开发默认值，切勿暴露到公网。') : null,
  ]))

  wrap.appendChild(panel('接入新 Agent（适配器作者）',
    el('span', { class: 'hint' }, '本服务对任意 Agent 开放：按契约实现即可接入，无需改服务端'),
    [
      el('div', { class: 'kv', style: { marginTop: '4px' } }, [
        el('span', { class: 'k' }, '契约文档'), el('span', {}, 'docs/INGEST-API.zh.md · docs/INGEST-API.md'),
        el('span', { class: 'k' }, '机器可读契约'), el('span', {}, el('a', { href: '/api/v1/protocol', target: '_blank' }, '/api/v1/protocol')),
        el('span', { class: 'k' }, '能力协商'), el('span', {}, el('a', { href: '/api/v1/health', target: '_blank' }, '/api/v1/health')),
        el('span', { class: 'k' }, '上报端点'), el('span', { class: 'mono' }, 'POST /api/v1/ingest/records'),
        el('span', { class: 'k' }, '必填字段'), el('span', {}, 'source（agent 标识）+ ts/provider/model/tokens'),
        el('span', { class: 'k' }, '设备身份'), el('span', {}, '同一台机器的所有 Agent 必须共用同一个 machineId'),
      ]),
      el('div', { class: 'hint', style: { marginTop: '8px' } },
        '提示：同一台机器上不同 Agent 各生成一个 machineId 会被统计成多台设备 —— 请让适配器共用 ~/.dsh-cost/device.json。'),
    ]))

  wrap.appendChild(el('div', { class: 'grid-2' }, [
    panel('管理员口令', null, passwordForm()),
    panel('已接入 Agent', null,
      (data.devices && data.devices.sources.length)
        ? table([
          { key: 'source', label: 'Agent' },
          { key: 'agents', label: '实例', render: (r) => r.agents.join(', ') || '—' },
          { key: 'records', label: '记录', num: true, render: (r) => fmtInt(r.records) },
          { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        ], aggregateSources(data.devices.sources))
        : el('div', { class: 'hint' }, '暂无 Agent 上报')),
  ]))

  if (p) {
    wrap.appendChild(panel('当前单价表（云端重算口径）',
      el('span', { class: 'hint' }, p.currentEra + ' · ' + p.eraLabel + ' · 峰时段 ' + p.peakWindows + ' · 闲时 ×' + p.offPeakFactor),
      table([
        { key: 'model', label: '模型' },
        { key: 'input', label: '输入（未命中）', num: true },
        { key: 'cacheRead', label: '缓存命中', num: true },
        { key: 'output', label: '输出', num: true },
      ], Object.keys(p.eras[p.eras.length - 1].models).map((k) => Object.assign({ model: k }, p.eras[p.eras.length - 1].models[k])))))
  }
  return wrap
}

function aggregateSources(sources) {
  const m = new Map()
  for (const s of sources) {
    let x = m.get(s.source)
    if (!x) { x = { source: s.source, agents: new Set(), records: 0, cost: 0 }; m.set(s.source, x) }
    x.agents.add(s.deviceId.slice(0, 12))
    x.records += s.recordCount
    x.cost += s.cost
  }
  return Array.from(m.values()).map((x) => Object.assign({}, x, { agents: Array.from(x.agents) }))
}

function passwordForm() {
  const cur = el('input', { class: 'input', type: 'password', placeholder: '当前口令' })
  const next = el('input', { class: 'input', type: 'password', placeholder: '新口令（≥8 位）' })
  const out = el('div', { class: 'hint mono', style: { marginTop: '8px', wordBreak: 'break-all' } })
  const btn = el('button', { class: 'btn primary' }, '生成哈希')
  btn.addEventListener('click', async () => {
    out.textContent = ''
    try {
      const r = await post('password', { currentPassword: cur.value, newPassword: next.value })
      out.textContent = '已生成 ADMIN_PASSWORD_HASH（写入 .env 后重启生效）：\n' + r.hash
    } catch (e) { out.textContent = '失败：' + e.message }
  })
  return el('div', { style: { marginTop: '8px' } }, [
    el('div', { class: 'row' }, [cur, next, btn]),
    out,
    el('div', { class: 'hint', style: { marginTop: '6px' } }, '口令以 scrypt 哈希存储，浏览器永远拿不到明文。'),
  ])
}

// ---------- 数据加载 ----------
async function loadView(view, opts) {
  const o = opts || {}
  if (!o.silent) setState({ loading: true, error: '' })
  try {
    if (!data.devices) await refreshDimensions()
    switch (view) {
      case 'overview':
        data.overview = await api('overview?' + qs())
        data.miniHeat = await api('heatmap?' + qs({ days: 30 }))
        if (!data.syncHealth) data.syncHealth = await api('sync-health')
        break
      case 'heatmap': {
        const win = HEAT_WINDOWS.find((x) => x.id === state.heatWindow) || HEAT_WINDOWS[1]
        data.heatmap = await api('heatmap?' + qs(win.days ? { days: win.days } : { range: win.id }))
        break
      }
      case 'subscriptions':
        data.subscriptions = await api('subscriptions?' + qs({ range: state.subWindow || 'all' }))
        break
      case 'monitor':
        data.health = await api('health')
        data.config = await api('config')
        data.syncHealth = await api('sync-health')
        data.overview = await api('overview?' + qs())
        // 订阅闲置天数本质是「全时段」问题（套餐可能上月才用过），必须用无下界窗口判断
        data.subscriptions = await api('subscriptions?range=all')
        data.miniHeat = await api('heatmap?' + qs({ days: 30 }))
        break
      case 'matrix':
        data.matrix = await api('matrix?' + qs())
        data.overview = await api('overview?' + qs())
        if (!data.syncHealth) data.syncHealth = await api('sync-health')
        break
      case 'devices': await refreshDimensions(); data.devices = await api('devices'); break
      case 'trend': data.trend = await api('trend?' + qs() + '&bucket=' + state.bucket + '&groupBy=' + state.trendGroup); break
      case 'models': data.models = await api('models?' + qs()); break
      case 'records': data.records = await api('records?' + qs() + '&limit=50'); break
      case 'settings':
        data.config = await api('config')
        data.health = await api('health')
        data.prices = await api('prices')
        await refreshDimensions()
        break
      default: break
    }
    recomputeAlerts()
    setState({ lastLoadedAt: Date.now(), autoRefresh: state.autoRefresh })
  } catch (e) {
    if (e.code === 'UNAUTHORIZED') { setState({ authed: false }); render(); return }
    if (!o.silent) setState({ error: e.message })
  }
  if (!o.silent) setState({ loading: false })
  render()
}

/** 用当前已加载的数据重算告警（纯函数，缺哪块数据就少算哪几条规则） */
function recomputeAlerts() {
  state.alerts = computeAlerts({
    prefs: state.prefs,
    health: data.health,
    config: data.config,
    overview: data.overview,
    syncHealth: data.syncHealth,
    subscriptions: data.subscriptions,
    heatmap: data.miniHeat || data.heatmap,
  })
  return state.alerts
}

// ---------- 自动刷新 ----------
function armAutoRefresh() {
  const sec = Number(state.autoRefresh) || 0
  if (!sec) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
    autoRemain = 0
    return
  }
  if (autoTimer) return
  autoRemain = sec
  autoTimer = setInterval(() => {
    autoRemain -= 1
    if (autoRemain <= 0) {
      autoRemain = Number(state.autoRefresh) || 60
      loadView(state.view, { silent: true })
    }
    if (autoLabel) autoLabel.textContent = autoText()
  }, 1000)
}

async function refreshDimensions() {
  try {
    const d = await api('devices')
    data.devices = d
    data.sourcesAll = Array.from(new Set(d.sources.map((s) => s.source))).map((s) => ({ source: s }))
  } catch (e) { /* 保留旧数据 */ }
}

async function loadAll() {
  await refreshDimensions()
  await Promise.all([
    api('health').then((x) => { data.health = x }).catch(() => {}),
    api('config').then((x) => { data.config = x }).catch(() => {}),
  ])
  await loadView(state.view)
}

async function logout() {
  try { await post('logout', {}) } catch (e) {}
  setState({ authed: false })
  render()
}

boot()
