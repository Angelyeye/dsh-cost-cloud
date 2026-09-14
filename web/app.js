// ============================================================
// dsh-cost-cloud 看板 —— 应用装配
//   · 登录门（Cookie 会话）
//   · 导航（概览 / 设备×Agent / 设备 / 趋势 / 模型 / 记录 / 设置）
//   · 时间范围与设备、来源筛选
// 无构建、无依赖：原生 ES 模块
// ============================================================
import { state, setState, api, post, patch, el, qs, RANGES, fmtMoney, fmtInt, fmtTokens, fmtTime, fmtAgo, colorForSource, download } from './state.js'
import { cards, table, stackedBars, legend, matrixTable, sourceDot, barList, deviceTag } from './views.js'

const VIEWS = [
  { id: 'overview', label: '概览', icon: '▤' },
  { id: 'matrix', label: '设备 × Agent', icon: '▦' },
  { id: 'devices', label: '设备', icon: '🖥' },
  { id: 'trend', label: '趋势', icon: '◱' },
  { id: 'models', label: '模型', icon: '◎' },
  { id: 'records', label: '记录', icon: '☰' },
  { id: 'settings', label: '设置', icon: '⚙' },
]

const data = {
  overview: null, matrix: null, devices: null, trend: null, models: null,
  records: null, health: null, config: null, syncHealth: null, prices: null,
}

async function boot() {
  try {
    const s = await api('session')
    setState({ authed: true, sessionExpiresAt: s.expiresAt })
  } catch (e) {
    setState({ authed: false, error: '' })
  }
  render()
}

function render() {
  const root = document.getElementById('app')
  root.innerHTML = ''
  root.className = ''
  if (!state.authed) { root.appendChild(loginView()); return }
  root.appendChild(layout())
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

function layout() {
  const nav = el('div', { class: 'rail' }, [
    el('div', { class: 'brand' }, [el('span', { class: 'dot' }), el('span', {}, ['DSH 花费云端', el('span', { class: 'brand-sub' }, '多机 · 多 Agent')])]),
    ...VIEWS.map((v) => el('button', {
      class: 'nav-item ' + (state.view === v.id ? 'on' : ''),
      onClick: () => { setState({ view: v.id, error: '', drill: null }); loadView(v.id) },
    }, [el('span', {}, v.icon), el('span', {}, v.label)])),
    el('div', { class: 'rail-foot' }, [
      el('div', {}, '服务 ' + (data.health ? 'v' + data.health.serviceVersion : '—')),
      el('div', {}, 'syncVer ' + (data.config ? data.config.syncVer : '—') + ' · 北京时区'),
      el('div', { style: { marginTop: '8px' } }, el('button', { class: 'btn', onClick: logout }, '退出登录')),
    ]),
  ])
  const main = el('div', { class: 'main' }, [header(), body()])
  return el('div', { class: 'layout' }, [nav, main])
}

function header() {
  const rangeGroup = el('div', { class: 'btn-group' }, RANGES.map((r) => el('button', {
    class: state.range === r.id ? 'on' : '',
    onClick: () => { setState({ range: r.id, recordsCursor: 0 }); loadView(state.view) },
  }, r.label)))
  const devSel = el('select', {
    class: 'select', multiple: 'true', size: '1',
    onChange: (e) => { setState({ filterDevices: Array.from(e.target.selectedOptions).map((o) => o.value) }); loadView(state.view) },
  }, (data.devices || []).map((d) => el('option', { value: d.id, selected: state.filterDevices.includes(d.id) }, d.name)))
  const srcSel = el('select', {
    class: 'select', multiple: 'true', size: '1',
    onChange: (e) => { setState({ filterSources: Array.from(e.target.selectedOptions).map((o) => o.value) }); loadView(state.view) },
  }, (data.sourcesAll || []).map((s) => el('option', { value: s.source, selected: state.filterSources.includes(s.source) }, s.source)))
  const title = (VIEWS.find((v) => v.id === state.view) || {}).label
  return el('div', { class: 'head' }, [
    el('h1', { class: 'h1' }, title),
    el('span', { class: 'spacer' }),
    el('span', { class: 'hint' }, '设备'),
    devSel,
    el('span', { class: 'hint' }, 'Agent'),
    srcSel,
    rangeGroup,
    el('button', { class: 'btn', onClick: () => loadView(state.view) }, '刷新'),
    state.view === 'records' || state.view === 'matrix'
      ? el('button', { class: 'btn', onClick: () => download('export.csv?' + qs().toString()) }, '导出 CSV')
      : null,
  ])
}

function body() {
  const wrap = el('div', {})
  if (state.error) wrap.appendChild(el('div', { class: 'banner err' }, ['加载失败：' + state.error]))
  if (state.loading && !data[state.view]) wrap.appendChild(el('div', { class: 'hint' }, '加载中…'))
  switch (state.view) {
    case 'overview': wrap.appendChild(viewOverview()); break
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

// ---------- 概览 ----------
function viewOverview() {
  const o = data.overview
  if (!o) return el('div', { class: 'hint' }, '加载中…')
  const s = o.summary
  const hitRate = (s.input + s.cacheRead) > 0 ? (s.cacheRead / (s.input + s.cacheRead) * 100) : 0
  const wrap = el('div', {})
  wrap.appendChild(cards([
    { title: '区间按量花费', value: '¥' + fmtMoney(s.realCost), sub: '区间 ' + (RANGES.find((r) => r.id === state.range) || {}).label, tag: o.excludedDevice ? '已排除本机' : null, tagKind: 'amber' },
    { title: '区间调用 / Tokens', value: fmtInt(s.realCalls), sub: fmtTokens(s.realTokens) + ' tokens' },
    { title: '订阅等效（参考）', value: '¥' + fmtMoney(s.subEquivalent), sub: fmtInt(s.subCalls) + ' 次 · ' + fmtTokens(s.subTokens) + ' tokens', tag: '订阅', tagKind: 'green' },
    { title: '缓存命中率', value: hitRate.toFixed(1) + '%', sub: '命中 ' + fmtTokens(s.cacheRead) + ' / 未命中 ' + fmtTokens(s.input) },
    { title: '今日（北京）', value: '¥' + fmtMoney(o.today.realCost), sub: fmtInt(o.today.calls) + ' 次 · ' + fmtTokens(o.today.tokens) },
    { title: '本月（北京）', value: '¥' + fmtMoney(o.month.realCost), sub: fmtInt(o.month.calls) + ' 次 · ' + fmtTokens(o.month.tokens) },
    { title: '全时段累计', value: '¥' + fmtMoney(o.all.realCost), sub: '自 ' + (o.firstTs ? fmtTime(o.firstTs) : '—') + ' 起' },
  ]))

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title' }, '按 Agent（source）'), el('span', { class: 'spacer' }), el('span', { class: 'hint' }, '点击行可下钻到该 Agent 记录')]),
    o.sources.length
      ? table([
        { key: 'source', label: 'Agent', render: (r) => sourceDot(r.source, o.sources.map((x) => x.source)) },
        { key: 'cost', label: '花费 (CNY)', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'devices', label: '来自设备', render: (r) => r.devices.length + ' 台' },
      ], o.sources.map((r) => Object.assign({}, r, { __click: () => { setState({ view: 'records', filterSources: [r.source], recordsCursor: 0 }); loadView('records') } })))
      : el('div', { class: 'hint' }, '暂无数据 —— 在插件里配置云端地址与令牌后点击「立即同步」。'),
  ]))

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title' }, '按设备'), el('span', { class: 'spacer' }), el('span', { class: 'hint' }, '默认按机器聚合，可展开查看该机的 Agent')]),
    deviceTable(o.devices, state.view),
  ]))

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
    __click: () => { setState({ filterDevices: [r.device], view: 'trend' }); loadView('trend') },
  })))
}

// ---------- 设备 × Agent 矩阵 ----------
function viewMatrix() {
  const m = data.matrix
  if (!m) return el('div', { class: 'hint' }, '加载中…')
  const wrap = el('div', {})
  const srcs = m.cols
  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, '设备 × Agent 矩阵'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint' }, '单元格口径'),
      el('div', { class: 'btn-group' }, ['cost', 'tokens', 'calls'].map((k) => el('button', {
        class: state.matrixMetric === k ? 'on' : '',
        onClick: () => { setState({ matrixMetric: k }); render() },
      }, k === 'cost' ? '花费' : k === 'tokens' ? 'Tokens' : '调用'))),
    ]),
    srcs.length
      ? matrixTable(m, srcs, state.matrixMetric, (device, source) => {
        setState({ view: 'records', filterDevices: [device], filterSources: [source], recordsCursor: 0 })
        loadView('records')
      })
      : el('div', { class: 'hint' }, '暂无数据'),
    el('div', { class: 'hint', style: { marginTop: '8px' } },
      '行合计 = 该设备所有 Agent 之和，列合计 = 该 Agent 在所有设备之和，右下角 = 区间总计；三者恒等（含明细与历史日汇总）。'),
  ]))

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '各 Agent 占比'),
    barList((data.overview ? data.overview.sources : []).map((s) => ({
      label: s.source, value: s.cost, color: colorForSource(s.source, srcs),
    })), { format: (v) => '¥' + fmtMoney(v) }),
  ]))

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '同步健康度'),
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
      : el('div', { class: 'hint' }, '暂无上报记录'),
  ]))
  return wrap
}

// ---------- 设备 ----------
function viewDevices() {
  const d = data.devices
  if (!d) return el('div', { class: 'hint' }, '加载中…')
  const wrap = el('div', {})
  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title' }, '设备清单（' + d.devices.length + '）'), el('span', { class: 'spacer' }),
      el('span', { class: 'hint' }, '改名后可在插件端继续上报，名称不会被覆盖（名称锁定）')]),
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
    ], d.devices) : el('div', { class: 'hint' }, '还没有设备上报'),
  ]))

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '设备 × Agent 明细'),
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
    ], d.sources) : el('div', { class: 'hint' }, '暂无 Agent 上报'),
  ]))
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
  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('span', { class: 'panel-title' }, '花费趋势'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint' }, '粒度'),
      el('div', { class: 'btn-group' }, ['day', 'week', 'month'].map((b) => el('button', {
        class: state.bucket === b ? 'on' : '',
        onClick: () => { setState({ bucket: b }); loadView('trend') },
      }, b === 'day' ? '按天' : b === 'week' ? '按周' : '按月'))),
      el('span', { class: 'hint' }, '分组'),
      el('div', { class: 'btn-group' }, [['device', '设备'], ['source', 'Agent'], ['model', '模型'], ['project', '项目']].map(([k, label]) => el('button', {
        class: state.trendGroup === k ? 'on' : '',
        onClick: () => { setState({ trendGroup: k }); loadView('trend') },
      }, label))),
    ]),
    stackedBars({ buckets: t.buckets, series }, { formatY: (v) => '¥' + fmtMoney(v, 2), labelSlice: state.bucket === 'month' ? 0 : 5 }),
    legend(series.map((s) => ({ label: s.id, color: s.color }))),
  ])
}
const COLOR_LIST = ['#4176e6', '#d97706', '#16a34a', '#7c3aed', '#dc2626', '#0891b2', '#c026d3', '#65a30d', '#ea580c', '#0ea5e9']

// ---------- 模型 ----------
function viewModels() {
  const m = data.models
  if (!m) return el('div', { class: 'hint' }, '加载中…')
  const items = m.items.filter((x) => x.kind === 'detail')
  const roll = m.items.filter((x) => x.kind === 'rollup')
  return el('div', {}, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('span', { class: 'panel-title' }, '模型用量与花费'), el('span', { class: 'spacer' }),
        el('span', { class: 'hint' }, '仅统计明细（日汇总见下表）')]),
      items.length ? table([
        { key: 'model', label: '模型' },
        { key: 'provider', label: 'Provider' },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'input', label: '输入', num: true, render: (r) => fmtTokens(r.input) },
        { key: 'cacheRead', label: '缓存命中', num: true, render: (r) => fmtTokens(r.cacheRead) },
        { key: 'output', label: '输出', num: true, render: (r) => fmtTokens(r.output) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
        { key: 'driftAbs', label: '漂移', num: true, render: (r) => (r.driftAbs > 0.01 ? el('span', { class: 'tag amber' }, '¥' + fmtMoney(r.driftAbs)) : '0') },
      ], items) : el('div', { class: 'hint' }, '暂无明细'),
    ]),
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-title' }, '历史日汇总（明细已超期折叠的部分）'),
      roll.length ? table([
        { key: 'model', label: '模型' },
        { key: 'calls', label: '调用', num: true, render: (r) => fmtInt(r.calls) },
        { key: 'tokens', label: 'Tokens', num: true, render: (r) => fmtTokens(r.tokens) },
        { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
      ], roll) : el('div', { class: 'hint' }, '暂无历史日汇总（明细仍在保留窗口内）'),
    ]),
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
      ].join(' · ')),
      (state.filterDevices.length || state.filterSources.length)
        ? el('button', { class: 'btn', onClick: () => { setState({ filterDevices: [], filterSources: [], recordsCursor: 0 }); loadView('records') } }, '清除筛选')
        : null,
    ]),
    r.items.length ? table([
      { key: 'ts', label: '时间（北京）', render: (x) => fmtTime(x.ts || (x.date + 'T12:00:00Z')) },
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
  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '服务信息'),
    el('div', { class: 'kv', style: { marginTop: '8px' } }, [
      el('span', { class: 'k' }, '服务版本'), el('span', { class: 'mono' }, h.serviceVersion + ' · syncVer ' + h.syncVer),
      el('span', { class: 'k' }, '运行时长'), el('span', {}, Math.floor(h.uptimeMs / 60000) + ' 分钟'),
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

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '接入新 Agent（适配器作者）'),
    el('div', { class: 'hint', style: { marginTop: '6px' } },
      '本服务对任意 agent 开放：任何统计插件/采集器按 docs/INGEST-API.md 实现即可接入，无需修改服务端代码。'),
    el('div', { class: 'kv', style: { marginTop: '8px' } }, [
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

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '管理员口令'),
    passwordForm(),
  ]))

  wrap.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'panel-title' }, '已接入 Agent'),
    (data.devices && data.devices.sources.length)
      ? table([
        { key: 'source', label: 'Agent' },
        { key: 'agents', label: '实例', render: (r) => r.agents.join(', ') || '—' },
        { key: 'records', label: '记录', num: true, render: (r) => fmtInt(r.records) },
        { key: 'cost', label: '花费', num: true, render: (r) => '¥' + fmtMoney(r.cost) },
      ], aggregateSources(data.devices.sources))
      : el('div', { class: 'hint' }, '暂无 Agent 上报'),
  ]))

  if (p) {
    wrap.appendChild(el('div', { class: 'panel' }, [
      el('div', { class: 'panel-title' }, '当前单价表（云端重算口径）'),
      el('div', { class: 'hint', style: { marginTop: '4px' } }, p.currentEra + ' · ' + p.eraLabel + ' · 峰时段 ' + p.peakWindows + ' · 闲时 ×' + p.offPeakFactor),
      table([
        { key: 'model', label: '模型' },
        { key: 'input', label: '输入（未命中）', num: true },
        { key: 'cacheRead', label: '缓存命中', num: true },
        { key: 'output', label: '输出', num: true },
      ], Object.keys(p.eras[p.eras.length - 1].models).map((k) => Object.assign({ model: k }, p.eras[p.eras.length - 1].models[k]))),
    ]))
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
async function loadView(view) {
  setState({ loading: true, error: '' })
  try {
    if (!data.devices) await refreshDimensions()
    switch (view) {
      case 'overview': data.overview = await api('overview?' + qs()); break
      case 'matrix':
        data.matrix = await api('matrix?' + qs())
        data.overview = await api('overview?' + qs())
        data.syncHealth = await api('sync-health')
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
  } catch (e) {
    if (e.code === 'UNAUTHORIZED') { setState({ authed: false }); render(); return }
    setState({ error: e.message })
  }
  setState({ loading: false })
  render()
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
