// ============================================================
// 极小 DOM 桩 —— 只实现 web/ 前端真正用到的 API
//
// 目的：让 web/state.js / views.js / app.js（真实浏览器代码，零改动）
//       能在 node --test 里被加载、渲染、甚至"点击"。
// 之所以需要它：前端曾因 addEventListener('Click') 大小写错误导致
//       全站按钮失效（静默失败，无任何报错），只有真跑一遍才能发现。
// ============================================================

function makeNode(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    className: '',
    id: '',
    value: '',
    disabled: false,
    selected: false,
    parentNode: null,
    _listeners: new Map(),
    _text: '',
    _html: '',

    appendChild(c) {
      if (!c) return c
      this.children.push(c)
      if (c.nodeType === 1 || c.nodeType === 3) c.parentNode = this
      return c
    },
    insertBefore(c) { return this.appendChild(c) },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },

    setAttribute(k, v) {
      if (v === undefined || v === null || v === false) return
      this.attributes[k] = String(v)
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null },
    removeAttribute(k) { delete this.attributes[k] },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) },

    // 事件名大小写敏感，这里如实模拟浏览器行为（不会做任何归一化）
    addEventListener(type, fn) {
      const k = String(type)
      if (!this._listeners.has(k)) this._listeners.set(k, [])
      this._listeners.get(k).push(fn)
    },
    removeEventListener(type, fn) {
      const k = String(type)
      this._listeners.set(k, (this._listeners.get(k) || []).filter((x) => x !== fn))
    },
    listenerTypes() { return Array.from(this._listeners.keys()) },
    dispatch(type, extra) {
      const ev = Object.assign({ type: String(type), target: this, preventDefault() {}, stopPropagation() {} }, extra || {})
      for (const fn of (this._listeners.get(String(type)) || [])) fn(ev)
      return ev
    },
    click() { return this.dispatch('click') },
    focus() {},

    querySelector() { return null },
    querySelectorAll() { return [] },

    get textContent() {
      if (this._text) return this._text
      return this.children.map(textOf).join('')
    },
    set textContent(v) { this._text = String(v); this.children = [] },
    set innerHTML(v) { this._html = String(v); this.children = [] },
    get innerHTML() { return this._html },
    get firstChild() { return this.children[0] || null },
    get selectedOptions() {
      return this.children.filter((c) => c.tagName === 'OPTION' && (c.selected === true || c.hasAttribute('selected')))
    },
  }
  return node
}

export function textOf(n) {
  if (!n) return ''
  if (n.nodeType === 3) return n.textContent
  return n.textContent
}

/** 深度优先收集所有元素节点 */
export function findAll(root, pred) {
  const out = []
  const walk = (n) => {
    if (!n || n.nodeType !== 1) return
    if (pred(n)) out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

/** 按 class 找按钮/元素 */
export function byClass(root, cls) {
  return findAll(root, (n) => new RegExp('(^|\\s)' + cls + '(\\s|$)').test(n.className))
}

/**
 * 安装 DOM 到 globalThis。返回 { root, body, document }。
 * 必须在 import web/*.js 之前调用。
 */
export function installDom() {
  const root = makeNode('div')
  root.id = 'app'
  root.className = 'app-loading'
  const body = makeNode('body')

  const document = {
    createElement: (t) => makeNode(t),
    createElementNS: (_ns, t) => makeNode(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    getElementById: (id) => (id === 'app' ? root : null),
    body,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  globalThis.document = document
  globalThis.window = {
    prompt: () => null,
    confirm: () => true,
    addEventListener() {},
    location: { href: '', origin: 'https://example.test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  globalThis.localStorage = globalThis.window.localStorage
  globalThis.alert = () => {}
  return { root, body, document }
}

/** 等待条件成立（默认最多 2s），返回是否成立 */
export async function waitFor(pred, ms = 2000) {
  const t0 = Date.now()
  for (;;) {
    let ok = false
    try { ok = !!pred() } catch (e) { ok = false }
    if (ok) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 5))
  }
}
