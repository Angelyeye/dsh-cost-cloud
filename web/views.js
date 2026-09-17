// ============================================================
// dsh-cost-cloud 看板 —— 视图
// 所有视图返回 DOM 节点；数据由 app.js 传入（避免重复请求）
// ============================================================
import {
  el, svgEl, fmtMoney, fmtInt, fmtTokens, fmtTime, fmtAgo, fmtPct, fmtDelta, fmtMetric,
  colorForSource, SOURCE_COLORS, DOW_SHORT, DOW_LONG, DOW_ORDER, heatBreaks, heatLevel,
} from './state.js'

export function cards(items) {
  return el('div', { class: 'cards' }, items.map((c) => el('div', { class: 'card' + (c.kind ? ' ' + c.kind : '') }, [
    el('div', { class: 't' }, [
      c.title,
      c.tag ? el('span', { class: 'tag ' + (c.tagKind || 'blue') }, c.tag) : null,
      c.delta !== undefined && c.delta !== null ? deltaBadge(c.delta, { invert: c.invertDelta }) : null,
    ]),
    el('div', { class: 'v' }, c.value),
    c.sub ? el('div', { class: 's' }, c.sub) : null,
    c.spark ? sparkline(c.spark, { width: 120, height: 26, color: c.sparkColor }) : null,
  ])))
}

/** 环比徽标：invert 时「涨」是坏事（花费），否则「涨」是好事 */
export function deltaBadge(delta, opts) {
  const o = opts || {}
  const d = Number(delta) || 0
  if (!Number.isFinite(d)) return null
  const good = o.invert === false ? d >= 0 : d <= 0
  const cls = Math.abs(d) < 0.001 ? '' : (good ? 'down' : 'up')
  return el('span', { class: 'delta ' + cls, title: o.title || '与上一等长区间对比' }, fmtDelta(d))
}

export function barList(items, opts) {
  const o = opts || {}
  const max = Math.max(1, ...items.map((i) => Number(i.value) || 0))
  return el('div', {}, items.map((i) => el('div', { class: 'bar-row' }, [
    el('div', { class: 'lbl', title: i.label }, i.label),
    el('div', { class: 'bar-track' }, el('div', {
      class: 'bar-fill',
      style: { width: Math.max(1, (Number(i.value) || 0) / max * 100) + '%', background: i.color || o.color || 'var(--blue)' },
    })),
    el('div', { class: 'val' }, o.format ? o.format(i.value) : fmtMoney(i.value)),
  ])))
}

/** 通用折线（按天/周/月的多序列堆叠柱状） */
export function stackedBars(data, opts) {
  const o = opts || {}
  const buckets = data.buckets || []
  const series = data.series || []
  const w = 900, h = 220, padL = 52, padB = 26, padT = 10, padR = 8
  const iw = w - padL - padR, ih = h - padT - padB
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + (x.points[i] || 0), 0))
  const max = Math.max(0.0001, ...totals)
  const bw = buckets.length ? Math.max(2, (iw / buckets.length) * 0.66) : 0
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, class: 'chart', preserveAspectRatio: 'none' })
  // Y 轴网格
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + ih - (ih * i / 4)
    svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: 'var(--line2)', 'stroke-width': 1 }))
    const t = svgEl('text', { x: padL - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--ink3)' })
    t.textContent = o.formatY ? o.formatY(max * i / 4) : fmtMoney(max * i / 4, 2)
    svg.appendChild(t)
  }
  buckets.forEach((b, i) => {
    const x = padL + (iw / buckets.length) * i + ((iw / buckets.length) - bw) / 2
    let acc = 0
    series.forEach((s, si) => {
      const v = s.points[i] || 0
      if (v <= 0) return
      const bh = ih * (v / max)
      const y = padT + ih - bh - (ih * (acc / max))
      acc += v
      const rect = svgEl('rect', {
        x, y, width: bw, height: Math.max(0.6, bh), rx: 1.5,
        fill: (s.color || SOURCE_COLORS[si % SOURCE_COLORS.length]),
      })
      rect.appendChild(svgEl('title', {}, `${b} · ${s.id} · ${o.valueFormat ? o.valueFormat(v) : '¥' + fmtMoney(v, 2)}`))
      svg.appendChild(rect)
    })
    if (buckets.length <= 40 || i % Math.ceil(buckets.length / 20) === 0) {
      const t = svgEl('text', { x: x + bw / 2, y: h - 8, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--ink3)' })
      t.textContent = String(b).slice(o.labelSlice === undefined ? 5 : o.labelSlice)
      svg.appendChild(t)
    }
  })
  return svg
}

/** 迷你折线（卡片里看趋势，不占地方） */
export function sparkline(values, opts) {
  const o = opts || {}
  const vals = (values || []).map((v) => Number(v) || 0)
  const w = o.width || 120, h = o.height || 28, pad = 2
  const max = Math.max(0.0001, ...vals)
  const step = vals.length > 1 ? (w - pad * 2) / (vals.length - 1) : 0
  const pts = vals.map((v, i) => [pad + step * i, h - pad - (h - pad * 2) * (v / max)])
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
  const area = line + ` L${(pad + step * (vals.length - 1)).toFixed(1)} ${h - pad} L${pad} ${h - pad} Z`
  const color = o.color || 'var(--blue)'
  return svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, width: w, height: h, preserveAspectRatio: 'none' }, [
    vals.length ? svgEl('path', { d: area, fill: color, opacity: 0.14 }) : null,
    vals.length ? svgEl('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }) : null,
  ])
}

export function legend(items) {
  return el('div', { class: 'legend' }, items.map((i) => el('span', {}, [
    el('span', { class: 'sw', style: { background: i.color } }), i.label,
  ])))
}

/** 色阶图例：少 → 多 */
export function heatLegend(breaks, format, extra) {
  return el('div', { class: 'legend heat-legend' }, [
    el('span', {}, '少'),
    ...breaks.map((b, i) => el('span', { class: 'heat-cell l' + (i + 1), title: format ? format(b) : '' })),
    el('span', {}, '多'),
    format && breaks.length ? el('span', { class: 'dim' }, '（上限 ' + format(breaks[breaks.length - 1]) + '）') : null,
    extra ? el('span', { class: 'dim' }, extra) : null,
  ])
}

export function table(cols, rows, opts) {
  const o = opts || {}
  const thead = el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.num ? 'num' : '' }, c.label))))
  const tbody = el('tbody', {}, rows.map((r) => el('tr', {
    class: (r.__click ? 'clickable ' : '') + (r.__total ? 'total' : '') + (r.__level ? ' lv-' + r.__level : ''),
    onClick: r.__click || undefined,
  }, cols.map((c) => el('td', { class: (c.num ? 'num ' : '') + (c.muted ? 'muted' : '') }, c.render ? c.render(r) : String(r[c.key] === undefined ? '' : r[c.key]))))))
  return el('div', { class: 'table-wrap ' + (o.class || '') }, el('table', { class: 'tbl ' + (o.class || '') }, [thead, tbody]))
}

export function deviceTag(device, name, sources) {
  return el('span', { class: 'row', style: { gap: '6px' } }, [
    el('span', {}, name || device),
    ...(sources || []).slice(0, 4).map((s) => el('span', { class: 'tag blue' }, s)),
  ])
}

export function sourceDot(source, allSources) {
  return el('span', { class: 'row', style: { gap: '5px', alignItems: 'center' } }, [
    el('span', { style: { width: '9px', height: '9px', borderRadius: '3px', background: colorForSource(source, allSources), display: 'inline-block' } }),
    el('span', {}, source || '(未知)'),
  ])
}

/** 设备 × Agent 矩阵 */
export function matrixTable(m, srcs, metric, onCell) {
  const headers = [el('th', {}, '设备 / 设备名'), ...srcs.map((s) => el('th', { class: 'num' }, sourceDot(s, srcs))), el('th', { class: 'num' }, '合计')]
  const fmt = metric === 'tokens' ? (v) => fmtTokens(v) : metric === 'calls' ? (v) => fmtInt(v) : (v) => '¥' + fmtMoney(v)
  const rows = m.rows.map((r) => {
    const tds = [el('td', { class: 'rowhead', title: r.device + ' · ' + r.name }, [
      el('div', {}, r.name),
      el('div', { class: 'dim mono', style: { fontSize: '11px' } }, r.device),
    ])]
    for (const s of srcs) {
      const c = r.cells[s] || { cost: 0, tokens: 0, calls: 0 }
      const v = c[metric] || 0
      tds.push(el('td', {
        class: 'cell ' + (v > 0 ? 'hot' : 'zero'),
        title: r.name + ' · ' + s + ' · 点击下钻',
        style: { cursor: v > 0 ? 'pointer' : 'default' },
        onClick: v > 0 && onCell ? () => onCell(r.device, s) : undefined,
      }, fmt(v)))
    }
    tds.push(el('td', { class: 'cell' }, fmt(r[metric] || 0)))
    return { __cells: tds }
  })
  const totalsRow = { __total: true, __cells: [
    el('td', {}, '合计'),
    ...srcs.map((s) => {
      const v = m.rows.reduce((sum, r) => sum + ((r.cells[s] || {})[metric] || 0), 0)
      return el('td', { class: 'cell' }, fmt(v))
    }),
    el('td', { class: 'cell' }, fmt(m.totals[metric] || 0)),
  ] }
  const thead = el('thead', {}, el('tr', {}, headers))
  const tbody = el('tbody', {}, rows.concat([totalsRow]).map((r) => el('tr', { class: r.__total ? 'total' : '' }, r.__cells)))
  return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl matrix' }, [thead, tbody]))
}

// ============================================================
// 热力图
// ============================================================

/**
 * 日历热力图：列 = 周，行 = 星期（周一在最上）。
 * @param {Array} daily  /api/admin/heatmap 的 daily（已补零，含 dow）
 */
export function heatCalendar(daily, opts) {
  const o = opts || {}
  const metric = o.metric || 'cost'
  const kind = o.kind || 'money'
  const cell = o.cell || 12
  const fmt = (v) => fmtMetric(v, kind)
  const days = Array.isArray(daily) ? daily : []
  const breaks = heatBreaks(days.map((d) => d[metric]), 4)
  // 首日之前补空格，使每列都是完整的周一→周日
  const lead = days.length ? DOW_ORDER.indexOf(Number(days[0].dow)) : 0
  const cells = []
  for (let i = 0; i < lead; i += 1) cells.push(el('div', { class: 'heat-cell pad' }))
  const readout = el('div', { class: 'heat-readout hint' }, days.length ? '把鼠标移到格子上看当天明细' : '区间内没有数据')
  const grid = el('div', {
    class: 'heat-grid',
    style: { gridTemplateRows: `repeat(7, ${cell}px)`, gridAutoFlow: 'column', gridAutoColumns: cell + 'px' },
  }, days.map((d) => {
    const v = Number(d[metric]) || 0
    const lvl = heatLevel(v, breaks)
    const tip = `${d.date}（${DOW_LONG[Number(d.dow) || 0]}） · ${fmt(v)} · ${fmtInt(d.calls)} 次 · ${fmtTokens(d.tokens)} tokens`
    const c = el('div', {
      class: 'heat-cell l' + lvl + (Number(d.dow) === 0 || Number(d.dow) === 6 ? ' wknd' : '') + (v > 0 ? '' : ' zero'),
      style: { width: cell + 'px', height: cell + 'px' },
      title: tip,
      dataset: {
        date: d.date, tip,
        from: String(Date.parse(d.date + 'T00:00:00+08:00')),
        to: String(Date.parse(d.date + 'T00:00:00+08:00') + 86400000),
      },
    })
    return c
  }))
  if (o.onPick) {
    grid.addEventListener('click', (ev) => {
      const t = ev && ev.target
      if (t && t.dataset && t.dataset.date) o.onPick(t.dataset.date, Number(t.dataset.from), Number(t.dataset.to))
    })
    grid.addEventListener('mouseover', (ev) => {
      const t = ev && ev.target
      if (t && t.dataset && t.dataset.tip) readout.textContent = t.dataset.tip + '（点击下钻到记录）'
    })
    grid.addEventListener('mouseleave', () => { readout.textContent = '把鼠标移到格子上看当天明细；点击可下钻到记录' })
  }
  // 月份标签：每月第一天所在的列号
  const months = []
  let lastMonth = ''
  const leadCells = lead
  days.forEach((d, i) => {
    const mk = String(d.date).slice(0, 7)
    if (mk !== lastMonth) {
      lastMonth = mk
      months.push({ label: mk.slice(2).replace('-', '/'), col: Math.floor((leadCells + i) / 7) + 1 })
    }
  })
  const weeks = Math.ceil((lead + days.length) / 7)
  const monthRow = el('div', {
    class: 'heat-months',
    style: { gridTemplateColumns: `repeat(${Math.max(1, weeks)}, ${cell}px)`, gridAutoFlow: 'column' },
  }, months.map((m) => el('span', { style: { gridColumn: String(m.col) }, class: 'heat-month' }, m.label)))
  const weekdayCol = el('div', { class: 'heat-weekdays', style: { gridTemplateRows: `repeat(7, ${cell}px)` } },
    [1, 3, 5].map((i) => el('span', {}, DOW_SHORT[DOW_ORDER[i]])))
  return el('div', { class: 'heat-wrap' }, [
    el('div', { class: 'heat-body' }, [weekdayCol, el('div', { class: 'heat-right' }, [monthRow, grid])]),
    el('div', { class: 'heat-foot' }, [heatLegend(breaks, fmt, o.note || ''), readout]),
  ])
}

/**
 * 星期 × 小时热力图（仅明细，见 query.js 注释）。
 * 高峰计价时段用虚线框标出（周一至周五 9-12 / 14-18）。
 */
export function heatGrid(hourly, opts) {
  const o = opts || {}
  const metric = o.metric || 'cost'
  const kind = o.kind || 'money'
  const fmt = (v) => fmtMetric(v, kind)
  const cellsIn = Array.isArray(hourly) ? hourly : []
  const breaks = heatBreaks(cellsIn.map((c) => c[metric]), 4)
  const map = new Map(cellsIn.map((c) => [Number(c.dow) + ':' + Number(c.hour), c]))
  const readout = el('div', { class: 'heat-readout hint' }, '把鼠标移到格子上看该时段的明细')
  const rows = DOW_ORDER.map((dow, ri) => {
    const kids = [el('span', { class: 'hg-lab' }, DOW_LONG[dow])]
    for (let hour = 0; hour < 24; hour += 1) {
      const c = map.get(dow + ':' + hour) || { dow, hour, cost: 0, realCost: 0, subCost: 0, calls: 0, tokens: 0 }
      const v = Number(c[metric]) || 0
      const tip = `${DOW_LONG[dow]} ${String(hour).padStart(2, '0')}:00 · ${fmt(v)} · ${fmtInt(c.calls)} 次`
      const node = el('div', {
        class: 'hg-cell l' + heatLevel(v, breaks) + (c.peakSlot ? ' pk' : '') + (ri >= 5 ? ' wknd' : ''),
        title: tip + (c.peakSlot ? ' · 高峰计价时段' : ''),
        dataset: { tip },
      })
      kids.push(node)
    }
    return el('div', { class: 'hg-row' }, kids)
  })
  const head = el('div', { class: 'hg-row hg-head' }, [
    el('span', { class: 'hg-lab' }),
    ...Array.from({ length: 24 }, (_, hour) => el('span', { class: 'hg-hour' }, hour % 3 === 0 ? String(hour).padStart(2, '0') : '')),
  ])
  const grid = el('div', { class: 'hg' }, [head, ...rows])
  grid.addEventListener('mouseover', (ev) => {
    const t = ev && ev.target
    if (t && t.dataset && t.dataset.tip) readout.textContent = t.dataset.tip
  })
  return el('div', { class: 'heat-wrap' }, [grid, el('div', { class: 'heat-foot' }, [
    heatLegend(breaks, fmt, '虚线框 = 高峰计价时段（周一至周五 09:00-12:00 / 14:00-18:00，闲时半价）'),
    readout,
  ])])
}

// ============================================================
// 监控
// ============================================================

export function alertList(items, opts) {
  const o = opts || {}
  const list = Array.isArray(items) ? items : []
  if (!list.length) {
    return el('div', { class: 'alerts' }, el('div', { class: 'alert ok' }, [
      el('span', { class: 'dot' }), el('div', {}, [
        el('div', { class: 'a-title' }, '一切正常'),
        el('div', { class: 'a-detail hint' }, '没有命中任何告警规则（阈值可在本页下方调整）。'),
      ]),
    ]))
  }
  return el('div', { class: 'alerts' + (o.compact ? ' compact' : '') }, list.map((a) => el('div', { class: 'alert ' + a.level }, [
    el('span', { class: 'dot' }),
    el('div', { class: 'a-body' }, [
      el('div', { class: 'a-title' }, a.title),
      a.detail ? el('div', { class: 'a-detail hint' }, a.detail) : null,
      a.hint ? el('div', { class: 'a-hint hint' }, '→ ' + a.hint) : null,
    ]),
    el('span', { class: 'tag ' + (a.level === 'error' ? 'red' : a.level === 'warn' ? 'amber' : 'blue') },
      a.level === 'error' ? '严重' : a.level === 'warn' ? '警告' : '提示'),
  ])))
}

/** 新鲜度条：距离上次上报多久（越短越绿） */
export function freshnessBar(ms, maxMs, level) {
  const pct = Math.max(0, Math.min(100, (Number(ms) || 0) / Math.max(1, maxMs) * 100))
  return el('div', { class: 'fresh ' + (level || 'ok'), title: '距上次上报 ' + fmtAgo(Date.now() - (Number(ms) || 0)) }, [
    el('div', { class: 'fresh-fill', style: { width: pct + '%' } }),
  ])
}

export { fmtMoney, fmtInt, fmtTokens, fmtTime, fmtAgo, fmtPct, fmtDelta }
