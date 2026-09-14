// ============================================================
// dsh-cost-cloud 看板 —— 视图
// 所有视图返回 DOM 节点；数据由 app.js 传入（避免重复请求）
// ============================================================
import { el, fmtMoney, fmtInt, fmtTokens, fmtTime, fmtAgo, colorForSource, SOURCE_COLORS } from './state.js'

export function cards(items) {
  return el('div', { class: 'cards' }, items.map((c) => el('div', { class: 'card' }, [
    el('div', { class: 't' }, [c.title, c.tag ? el('span', { class: 'tag ' + (c.tagKind || 'blue') }, c.tag) : null]),
    el('div', { class: 'v' }, c.value),
    c.sub ? el('div', { class: 's' }, c.sub) : null,
  ])))
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
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('class', 'chart')
  svg.setAttribute('preserveAspectRatio', 'none')
  const mk = (tag, attrs) => {
    const n = document.createElementNS(svgNS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
    return n
  }
  // Y 轴网格
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + ih - (ih * i / 4)
    svg.appendChild(mk('line', { x1: padL, x2: w - padR, y1: y, y2: y, stroke: 'var(--line2)', 'stroke-width': 1 }))
    const t = mk('text', { x: padL - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--ink3)' })
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
      svg.appendChild(mk('rect', {
        x, y, width: bw, height: Math.max(0.6, bh), rx: 1.5,
        fill: (s.color || SOURCE_COLORS[si % SOURCE_COLORS.length]),
      }))
    })
    if (buckets.length <= 40 || i % Math.ceil(buckets.length / 20) === 0) {
      const t = mk('text', { x: x + bw / 2, y: h - 8, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--ink3)' })
      t.textContent = String(b).slice(o.labelSlice === undefined ? 5 : o.labelSlice)
      svg.appendChild(t)
    }
  })
  return svg
}

export function legend(items) {
  return el('div', { class: 'legend' }, items.map((i) => el('span', {}, [
    el('span', { class: 'sw', style: { background: i.color } }), i.label,
  ])))
}

export function table(cols, rows, opts) {
  const o = opts || {}
  const thead = el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.num ? 'num' : '' }, c.label))))
  const tbody = el('tbody', {}, rows.map((r) => el('tr', {
    class: (r.__click ? 'clickable ' : '') + (r.__total ? 'total' : ''),
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

export { fmtMoney, fmtInt, fmtTokens, fmtTime, fmtAgo }
