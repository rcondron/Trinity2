// A small DOM for Node: just enough of a browser to run the extension's page-side code (extension/page.js) against
// the fixture pages in tests — elements, attributes, a selector matcher, simple CSS and layout (so "is it visible?" and
// "is something lying over it?" have real answers), form controls with prototype value accessors, events, focus, open
// shadow roots, and the named-property shadowing real documents and forms have (<input name="action"> hides
// form.action). It is a stand-in, not a browser: the same pages are meant to be checked in real Chrome afterwards.
//
// Inside this file, attributes and queries go through the underscore helpers (_ga, _qsa …) so that a page naming its
// controls "getAttribute" breaks the page code under test — if it is careless — and not this DOM.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const INLINE = new Set(["a", "span", "label", "b", "strong", "em", "i", "small", "code", "input", "button", "select", "textarea", "img", "iframe", "output", "summary", "option", "abbr", "u", "sup", "sub"]);
const NO_BOX = new Set(["head", "script", "style", "template", "title", "meta", "link", "base", "option"]);

const decode = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const camel = (p) => p.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
/** The element above, stepping out of a shadow tree to its host. */
const up = (el) => (el.parentNode ? (el.parentNode.nodeType === 1 ? el.parentNode : el.parentNode.nodeType === 11 ? el.parentNode.host : null) : null);

// ─── Events ───────────────────────────────────────────────────────────────────

export class Event {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.composed = Boolean(init.composed);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.isTrusted = false;
    this._stopped = false;
    for (const [k, v] of Object.entries(init)) if (!(k in this)) this[k] = v;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
}
export class MouseEvent extends Event {}
export class PointerEvent extends MouseEvent {}
export class KeyboardEvent extends Event {}

// ─── Selectors ────────────────────────────────────────────────────────────────

function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[" || ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === "]" || ch === ")") {
      depth--;
      cur += ch;
    } else if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseCompound(text) {
  const tests = [];
  let rest = text;
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(rest);
  if (tag) {
    rest = rest.slice(tag[0].length);
    if (tag[0] !== "*") tests.push((el) => el.localName === tag[0].toLowerCase());
  }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) {
      const id = m[1];
      tests.push((el) => el._ga("id") === id);
    } else if ((m = /^\.([\w-]+)/.exec(rest))) {
      const cls = m[1];
      tests.push((el) => (el._ga("class") || "").split(/\s+/).includes(cls));
    } else if ((m = /^\[\s*([\w:-]+)\s*(?:([\^$*~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(rest))) {
      const name = m[1];
      const op = m[2];
      const want = m[3] ?? m[4] ?? m[5] ?? "";
      tests.push((el) => {
        const v = el._ga(name);
        if (v === null) return false;
        if (!op) return true;
        if (op === "=") return v === want;
        if (op === "^=") return want !== "" && v.startsWith(want);
        if (op === "$=") return want !== "" && v.endsWith(want);
        if (op === "*=") return want !== "" && v.includes(want);
        return v.split(/\s+/).includes(want);
      });
    } else if ((m = /^:not\(([^)]*)\)/.exec(rest))) {
      const inner = parseCompound(m[1].trim());
      tests.push((el) => !inner(el));
    } else if ((m = /^:modal/.exec(rest))) tests.push((el) => el._modal === true);
    else throw new Error(`mini-dom: selector not supported: ${text}`);
    rest = rest.slice(m[0].length);
  }
  return (el) => tests.every((t) => t(el));
}

const selectorCache = new Map();
function compile(selector) {
  let fn = selectorCache.get(selector);
  if (fn) return fn;
  const alternatives = splitTop(selector, ",").map((complex) => splitTop(complex, " ").map(parseCompound));
  fn = (el) =>
    alternatives.some((chain) => {
      if (!chain[chain.length - 1](el)) return false;
      let at = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (at && !chain[i](at)) at = at.parentNode && at.parentNode.nodeType === 1 ? at.parentNode : null;
        if (!at) return false;
        at = at.parentNode && at.parentNode.nodeType === 1 ? at.parentNode : null;
      }
      return true;
    });
  selectorCache.set(selector, fn);
  return fn;
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

export class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }
  _doc() {
    return this.nodeType === 9 ? this : this.ownerDocument;
  }
  get isConnected() {
    const root = this.getRootNode();
    return root.nodeType === 9 || (root.nodeType === 11 && root.host ? root.host.isConnected : false);
  }
  get baseURI() {
    const doc = this._doc();
    const base = doc._qsa("base").find((b) => b._ga("href"));
    return base ? new URL(base._ga("href"), doc._url).href : doc._url;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v) {
    this.childNodes = [];
    if (v) this.appendChild(new Text(this._doc(), String(v)));
    this._bump();
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  getRootNode() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  /** 4 when `other` comes after this in the tree (a shadow tree counts as inside its host), 2 when before. */
  compareDocumentPosition(other) {
    const order = this._doc()._order();
    const a = order.get(this);
    const b = order.get(other);
    if (a === undefined || b === undefined) return 1;
    return b > a ? 4 : b < a ? 2 : 0;
  }
  _bump() {
    const doc = this._doc();
    if (doc) doc._version++;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    if (child.parentNode) child.remove();
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, child);
    else this.childNodes.push(child);
    child.parentNode = this;
    this._bump();
    return child;
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.childNodes.indexOf(this);
    if (i >= 0) parent.childNodes.splice(i, 1);
    this.parentNode = null;
    parent._bump();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list && list.includes(fn)) list.splice(list.indexOf(fn), 1);
  }
  dispatchEvent(ev) {
    ev.target = this;
    const path = [this];
    for (let n = this; n.parentNode; ) {
      let next = n.parentNode;
      if (next.nodeType === 11 && next.host) {
        if (!ev.composed) break;
        path.push(next);
        next = next.host;
      }
      path.push(next);
      n = next;
    }
    this._doc()._events.push({ type: ev.type, target: this, event: ev });
    for (const node of ev.bubbles ? path : [this]) {
      ev.currentTarget = node;
      for (const fn of [...(node._listeners.get(ev.type) ?? [])]) fn.call(node, ev);
      if (ev._stopped) break;
    }
    return !ev.defaultPrevented;
  }
  /** Element descendants in tree order (not into shadow roots). */
  _descendants(out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      out.push(c);
      c._descendants(out);
    }
    return out;
  }
  _qsa(selector) {
    const match = compile(selector);
    return this._descendants().filter(match);
  }
  querySelectorAll(selector) {
    return this._qsa(selector);
  }
  querySelector(selector) {
    return this._qsa(selector)[0] ?? null;
  }
}

export class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}

export class DocumentFragment extends Node {
  constructor(doc) {
    super(doc);
    this.nodeType = 11;
    this.host = null;
    this.activeElement = null;
  }
  elementFromPoint(x, y) {
    return this.ownerDocument._hit(x, y, this);
  }
}

export class Element extends Node {
  constructor(doc, name) {
    super(doc);
    this.nodeType = 1;
    this.localName = name.toLowerCase();
    this.tagName = name.toUpperCase();
    this._attrs = new Map();
    this.shadowRoot = null;
    this.scrollTop = 0;
    this.scrollLeft = 0;
  }
  _ga(name) {
    const v = this._attrs.get(String(name).toLowerCase());
    return v === undefined ? null : v;
  }
  _ha(name) {
    return this._attrs.has(String(name).toLowerCase());
  }
  getAttribute(name) {
    return this._ga(name);
  }
  setAttribute(name, value) {
    this._attrs.set(String(name).toLowerCase(), String(value));
    this._bump();
  }
  hasAttribute(name) {
    return this._ha(name);
  }
  removeAttribute(name) {
    this._attrs.delete(String(name).toLowerCase());
    this._bump();
  }
  get attributes() {
    return [...this._attrs].map(([name, value]) => ({ name, value }));
  }
  getAttributeNames() {
    return [...this._attrs.keys()];
  }
  get id() {
    return this._ga("id") ?? "";
  }
  get className() {
    return this._ga("class") ?? "";
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get nextElementSibling() {
    const sibs = this.parentNode ? this.parentNode.childNodes : [];
    for (let i = sibs.indexOf(this) + 1; i < sibs.length; i++) if (sibs[i].nodeType === 1) return sibs[i];
    return null;
  }
  get isContentEditable() {
    for (let n = this; n; n = n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : null) {
      const v = n._ga("contenteditable");
      if (v === "" || v === "true") return true;
      if (v === "false") return false;
    }
    return false;
  }
  get inert() {
    return this._ha("inert");
  }
  matches(selector) {
    return compile(selector)(this);
  }
  _closest(selector) {
    const match = compile(selector);
    for (let n = this; n; n = n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : null) if (match(n)) return n;
    return null;
  }
  closest(selector) {
    return this._closest(selector);
  }
  get innerText() {
    const doc = this.ownerDocument;
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) return void parts.push(n.data);
      if (n.nodeType !== 1 || /^(script|style|template|head|title)$/.test(n.localName)) return;
      if (doc._style(n).display === "none") return;
      if (n.localName === "textarea" || n.localName === "input") return; // what was typed is not page text
      const block = !INLINE.has(n.localName);
      if (block) parts.push("\n");
      for (const c of n.childNodes) walk(c);
      if (block || n.localName === "br") parts.push("\n");
    };
    for (const c of this.childNodes) walk(c);
    return parts
      .join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }
  set innerHTML(html) {
    this.childNodes = [];
    parseInto(this.ownerDocument, this, String(html));
    this._bump();
  }
  getBoundingClientRect() {
    return this.ownerDocument._rect(this);
  }
  _isRoot() {
    return this === this.ownerDocument._root();
  }
  get scrollHeight() {
    const doc = this.ownerDocument;
    if (this._isRoot()) return Math.max(doc._layout().height, doc.defaultView.innerHeight);
    const box = doc._layout().boxes.get(this);
    return box ? Math.max(box.content, box.h) : 0;
  }
  get clientHeight() {
    const doc = this.ownerDocument;
    if (this._isRoot()) return doc.defaultView.innerHeight;
    const box = doc._layout().boxes.get(this);
    return box ? box.h : 0;
  }
  scrollBy(o) {
    this.scrollTo({ top: this.scrollTop + (o.top || 0) });
  }
  scrollTo(o) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this.scrollTop = Math.min(max, Math.max(0, o.top ?? this.scrollTop));
    if (this._isRoot()) this.ownerDocument.defaultView.scrollY = this.scrollTop;
  }
  scrollIntoView() {
    const doc = this.ownerDocument;
    const win = doc.defaultView;
    const r = this.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.top >= 0 && r.bottom <= win.innerHeight) return;
    doc._root().scrollTo({ top: r.top + win.scrollY - win.innerHeight / 2 + r.height / 2 });
  }
  focus() {
    const doc = this.ownerDocument;
    if (!this.isConnected) return;
    let node = this;
    for (let root = node.getRootNode(); root.nodeType === 11 && root.host; root = node.getRootNode()) {
      root.activeElement = node;
      node = root.host;
    }
    doc._active = node;
    doc._focused = this;
  }
  blur() {
    if (this.ownerDocument._focused === this) {
      this.ownerDocument._active = null;
      this.ownerDocument._focused = null;
    }
  }
  attachShadow() {
    const root = new DocumentFragment(this.ownerDocument);
    root.host = this;
    this.shadowRoot = root;
    return root;
  }
}

export class HTMLElement extends Element {
  /** A click with its activation: a submit button submits, a checkbox toggles, a link is followed. */
  click() {
    if (this.disabled === true) return;
    const went = this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    if (!went) return;
    const type = (this._ga("type") || "").toLowerCase();
    if (this.localName === "input" && (type === "checkbox" || type === "radio")) {
      this.checked = type === "radio" ? true : !this.checked;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const submits = (this.localName === "button" && (type === "" || type === "submit")) || (this.localName === "input" && (type === "submit" || type === "image"));
    if (submits && this.form) HTMLFormElement.prototype.requestSubmit.call(this.form, this);
    if (this.localName === "a" && this._ga("href") !== null) this.ownerDocument._navigations.push(this.href);
  }
}

class FormControl extends HTMLElement {
  get disabled() {
    return this._ha("disabled");
  }
  get readOnly() {
    return this._ha("readonly");
  }
  get form() {
    const id = this._ga("form");
    if (id) return this.getRootNode()._qsa("form").find((f) => f._ga("id") === id) ?? null;
    return this._closest("form");
  }
  get labels() {
    const out = [];
    const id = this._ga("id");
    if (id) for (const l of this.getRootNode()._qsa("label")) if (l._ga("for") === id) out.push(l);
    const wrap = this._closest("label");
    if (wrap && !out.includes(wrap)) out.push(wrap);
    return out;
  }
}

export class HTMLInputElement extends FormControl {
  get type() {
    return (this._ga("type") || "text").toLowerCase();
  }
  get value() {
    return this._value ?? this._ga("value") ?? "";
  }
  set value(v) {
    this._value = String(v);
    this._sel = [this._value.length, this._value.length];
  }
  get checked() {
    return this._checked ?? this._ha("checked");
  }
  set checked(v) {
    this._checked = Boolean(v);
  }
  get selectionStart() {
    return this._sel ? this._sel[0] : this.value.length;
  }
  get selectionEnd() {
    return this._sel ? this._sel[1] : this.value.length;
  }
  setSelectionRange(a, b) {
    this._sel = [a, b];
  }
}

export class HTMLTextAreaElement extends FormControl {
  get value() {
    return this._value ?? this.textContent;
  }
  set value(v) {
    this._value = String(v);
    this._sel = [this._value.length, this._value.length];
  }
  get selectionStart() {
    return this._sel ? this._sel[0] : this.value.length;
  }
  get selectionEnd() {
    return this._sel ? this._sel[1] : this.value.length;
  }
  setSelectionRange(a, b) {
    this._sel = [a, b];
  }
}

export class HTMLOptionElement extends HTMLElement {
  get value() {
    return this._ga("value") ?? this.text;
  }
  get text() {
    return this.textContent.replace(/\s+/g, " ").trim();
  }
  get disabled() {
    return this._ha("disabled");
  }
}

export class HTMLSelectElement extends FormControl {
  get options() {
    return this._qsa("option");
  }
  get selectedIndex() {
    const opts = this.options;
    if (this._selected !== undefined) return opts.indexOf(this._selected);
    const marked = opts.findIndex((o) => o._ha("selected"));
    return marked >= 0 ? marked : opts.length ? 0 : -1;
  }
  get value() {
    const o = this.options[this.selectedIndex];
    return o ? o.value : "";
  }
  set value(v) {
    const o = this.options.find((x) => x.value === String(v));
    if (o) this._selected = o;
  }
}

export class HTMLButtonElement extends FormControl {}

export class HTMLFormElement extends HTMLElement {
  /** Validation aside, what a real requestSubmit does: a cancelable submit event, then the form "goes". */
  requestSubmit(submitter) {
    const went = Node.prototype.dispatchEvent.call(this, new Event("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null }));
    this.ownerDocument._submits.push({ form: this, submitter: submitter ?? null, prevented: !went });
  }
}

export class HTMLAnchorElement extends HTMLElement {
  get href() {
    const h = this._ga("href");
    if (h === null) return "";
    try {
      return new URL(h, this.baseURI).href;
    } catch {
      return h;
    }
  }
}

export class HTMLImageElement extends HTMLElement {
  get src() {
    const s = this._ga("src");
    return s ? new URL(s, this.baseURI).href : "";
  }
  get currentSrc() {
    return this.src;
  }
}

export class HTMLDialogElement extends HTMLElement {
  close() {
    this.removeAttribute("open");
    this._modal = false;
  }
}

const CLASSES = { input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement, option: HTMLOptionElement, button: HTMLButtonElement, form: HTMLFormElement, a: HTMLAnchorElement, img: HTMLImageElement, dialog: HTMLDialogElement };

// ─── Document ─────────────────────────────────────────────────────────────────

export class Document extends Node {
  constructor(url) {
    super(null);
    this.nodeType = 9;
    this._url = url;
    this._version = 0;
    this._active = null;
    this._focused = null;
    this._events = [];
    this._submits = [];
    this._navigations = [];
    this._rules = [];
    this._layoutCache = null;
    this._orderCache = null;
    this._styleCache = null;
    this.defaultView = null;
  }
  _root() {
    return this.childNodes.find((n) => n.nodeType === 1) ?? null;
  }
  _body() {
    const root = this._root();
    return root ? (root.childNodes.find((c) => c.nodeType === 1 && c.localName === "body") ?? null) : null;
  }
  get documentElement() {
    return this._root();
  }
  get body() {
    return this._body();
  }
  get title() {
    const t = this._qsa("title")[0];
    return t ? t.textContent.replace(/\s+/g, " ").trim() : "";
  }
  get activeElement() {
    return this._active ?? this._body();
  }
  get scrollingElement() {
    return this._root();
  }
  get fullscreenElement() {
    return null;
  }
  createElement(name) {
    const Ctor = CLASSES[String(name).toLowerCase()] ?? HTMLElement;
    return new Ctor(this, String(name));
  }
  createRange() {
    return { selectNodeContents() {} };
  }
  /** Just the editing commands the page code uses, on the focused editable element. */
  execCommand(command, _ui, value) {
    const el = this._focused;
    if (!el || !el.isContentEditable) return false;
    if (command === "insertText") el.textContent = (this._selectAll ? "" : el.textContent) + String(value ?? "");
    else if (command === "insertParagraph") el.textContent += "\n";
    else if (command === "delete") el.textContent = el.textContent.slice(0, -1);
    else return false;
    this._selectAll = false;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  exitFullscreen() {}
  getElementById(id) {
    return this._qsa("*").find((e) => e._ga("id") === id) ?? null;
  }
  elementFromPoint(x, y) {
    return this._hit(x, y, this);
  }
  /** Every element in painting order: the tree, with each shadow tree inside its host. */
  _flat() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        out.push(c);
        if (c.shadowRoot) walk(c.shadowRoot);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  _order() {
    if (this._orderCache && this._orderCache.version === this._version) return this._orderCache.map;
    const map = new Map();
    this._flat().forEach((el, i) => map.set(el, i));
    this._orderCache = { version: this._version, map };
    return map;
  }

  // ── style: defaults, then the sheet of the element's own tree in source order, then its style attribute ──
  _style(el) {
    if (!this._styleCache || this._styleCache.version !== this._version) this._styleCache = { version: this._version, map: new Map() };
    const cached = this._styleCache.map.get(el);
    if (cached) return cached;
    const parent = up(el);
    const inherited = parent ? this._style(parent) : null;
    const s = {
      display: NO_BOX.has(el.localName) || el._ha("hidden") ? "none" : INLINE.has(el.localName) ? "inline" : "block",
      visibility: inherited ? inherited.visibility : "visible",
      opacity: "1",
      overflow: "visible",
      overflowX: "visible",
      overflowY: "visible",
      position: "static",
      pointerEvents: inherited ? inherited.pointerEvents : "auto",
      zIndex: "auto",
      backgroundColor: "rgba(0, 0, 0, 0)",
      color: inherited ? inherited.color : "rgb(0, 0, 0)",
      fontSize: inherited ? inherited.fontSize : "16px",
    };
    const apply = (decls) => {
      for (const [prop, value] of decls) {
        s[prop] = value;
        if (prop === "overflow") s.overflowX = s.overflowY = value;
      }
    };
    const root = el.getRootNode();
    for (const rule of this._rules) if (rule.root === root && rule.match(el)) apply(rule.decls);
    apply(parseDecls(el._ga("style") || ""));
    this._styleCache.map.set(el, s);
    return s;
  }

  // ── layout: block flow with inline runs, and absolute / fixed boxes ──
  _layout() {
    if (this._layoutCache && this._layoutCache.version === this._version) return this._layoutCache;
    const boxes = new Map();
    const win = this.defaultView;
    const px = (v) => (typeof v === "string" && /^-?[\d.]+px$/.test(v.trim()) ? parseFloat(v) : v === "0" ? 0 : null);
    const textW = (n) => Math.ceil(n.data.replace(/\s+/g, " ").trim().length * 7.2);
    const intrinsic = (el) => {
      const type = (el._ga("type") || "").toLowerCase();
      if (el.localName === "input") return /^(checkbox|radio)$/.test(type) ? [16, 16] : /^(submit|button|reset)$/.test(type) ? [Math.max(64, 16 + 8 * (el._ga("value") || "Submit").length), 30] : [220, 28];
      if (el.localName === "select") return [160, 28];
      if (el.localName === "textarea") return [300, 60];
      if (el.localName === "img") return [Number(el._ga("width")) || 120, Number(el._ga("height")) || 90];
      if (el.localName === "iframe") return [Number(el._ga("width")) || 300, Number(el._ga("height")) || 150];
      return null;
    };
    const zero = (el) => {
      boxes.set(el, { x: 0, y: 0, w: 0, h: 0, fixed: false, content: 0, none: true });
      const inside = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          boxes.set(c, { x: 0, y: 0, w: 0, h: 0, fixed: false, content: 0, none: true });
          if (c.shadowRoot) inside(c.shadowRoot);
          inside(c);
        }
      };
      if (el.shadowRoot) inside(el.shadowRoot);
      inside(el);
    };
    /**
     * Lay `el` out with its top-left at (x, y) in a space `avail` wide; returns [width, height]. `cb` is the corner
     * of the nearest positioned box above: what an absolute box's left / top are measured from.
     */
    const place = (el, x, y, avail, fixedAbove, cb) => {
      const cs = this._style(el);
      if (cs.display === "none") {
        zero(el);
        return [0, 0];
      }
      const fixed = fixedAbove || cs.position === "fixed";
      if (cs.position === "absolute") {
        if (px(cs.left) !== null) x = cb.x + px(cs.left);
        if (px(cs.top) !== null) y = cb.y + px(cs.top);
      } else if (cs.position === "fixed") {
        x = px(cs.left) ?? 0;
        y = px(cs.top) ?? 0;
      }
      const inside = cs.position === "static" ? cb : { x, y };
      const own = intrinsic(el);
      const inline = cs.display === "inline" || cs.display === "inline-block";
      let w = px(cs.width) ?? (own ? own[0] : inline ? null : avail);
      const box = { x, y, w: 0, h: 0, fixed, content: 0 };
      boxes.set(el, box);
      // Children: inline ones run along a line, block ones stack.
      let cy = y;
      let lineX = x;
      let lineH = 0;
      let widest = 0;
      const inner = w ?? avail;
      const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
      if (!own)
        for (const c of kids) {
          if (c.nodeType === 3) {
            const tw = textW(c);
            if (tw) {
              lineX += tw + 4;
              lineH = Math.max(lineH, 18);
            }
            continue;
          }
          if (c.nodeType !== 1) continue;
          const ccs = this._style(c);
          if (ccs.display === "none") {
            zero(c);
            continue;
          }
          if (ccs.position === "absolute" || ccs.position === "fixed") {
            place(c, lineX, cy, win.innerWidth, fixed, inside); // out of the flow: it takes no room here
            continue;
          }
          if (ccs.display === "inline" || ccs.display === "inline-block") {
            const [cw, ch] = place(c, lineX, cy, inner, fixed, inside);
            lineX += cw + 6;
            lineH = Math.max(lineH, ch);
          } else {
            if (lineH) {
              widest = Math.max(widest, lineX - x);
              cy += lineH + 4;
              lineX = x;
              lineH = 0;
            }
            const [cw, ch] = place(c, x, cy, inner, fixed, inside);
            widest = Math.max(widest, cw);
            cy += ch + (ch ? 6 : 0);
          }
        }
      widest = Math.max(widest, lineX - x);
      const content = cy + lineH - y;
      if (w === null) w = Math.max(own ? own[0] : 0, widest);
      if (el.localName === "button" && px(cs.width) === null) w = Math.max(64, widest + 16);
      const h = px(cs.height) ?? (own ? own[1] : el.localName === "button" ? 30 : content);
      box.w = w;
      box.h = h;
      box.content = content;
      return [w, h];
    };
    let height = 0;
    const root = this._root();
    const body = this._body();
    if (root) {
      zero(root);
      const rootBox = { x: 0, y: 0, w: win.innerWidth, h: 0, fixed: false, content: 0 };
      boxes.set(root, rootBox);
      if (body) {
        const [, h] = place(body, 8, 8, win.innerWidth - 16, false, { x: 0, y: 0 });
        height = h + 16;
        for (const b of boxes.values()) if (!b.fixed && !b.none) height = Math.max(height, b.y + b.h);
        rootBox.h = height;
      }
    }
    this._layoutCache = { version: this._version, boxes, height };
    return this._layoutCache;
  }
  _rect(el) {
    const box = this._layout().boxes.get(el);
    const win = this.defaultView;
    if (!box || box.none) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    let left = box.x;
    let top = box.y;
    if (!box.fixed) {
      top -= win.scrollY;
      left -= win.scrollX;
      // Inside a box that scrolls on its own, things move with its scroll position.
      const root = this._root();
      for (let n = up(el); n; n = up(n)) if (n !== root && n.scrollTop) top -= n.scrollTop;
    }
    return { left, top, right: left + box.w, bottom: top + box.h, width: box.w, height: box.h, x: left, y: top };
  }
  /** The element a click at (x, y) lands on, as seen from `scope` (the document, or a shadow root). */
  _hit(x, y, scope) {
    let best = null;
    let bestZ = -Infinity;
    const zOf = (el) => {
      for (let n = el; n; n = up(n)) {
        const cs = this._style(n);
        if (cs.position !== "static" && /^-?\d+$/.test(String(cs.zIndex))) return Number(cs.zIndex);
      }
      return 0;
    };
    const within = (r) => r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    // A box that clips what's inside it (overflow other than visible) hides the parts that stick out.
    const clipped = (el) => {
      for (let n = up(el); n; n = up(n)) {
        const cs = this._style(n);
        if ((cs.overflowX !== "visible" || cs.overflowY !== "visible") && n !== this._root() && n !== this._body() && !within(this._rect(n))) return true;
      }
      return false;
    };
    for (const el of this._flat()) {
      const cs = this._style(el);
      if (cs.display === "none" || cs.visibility !== "visible" || cs.pointerEvents === "none") continue;
      if (!within(this._rect(el)) || clipped(el)) continue;
      const z = zOf(el);
      if (z >= bestZ) {
        best = el;
        bestZ = z;
      }
    }
    if (!best) return null;
    // Seen from outside a shadow tree, what's hit is its host.
    let node = best;
    for (let root = node.getRootNode(); root !== scope && root.nodeType === 11 && root.host; root = node.getRootNode()) node = root.host;
    return node;
  }
}

function parseDecls(text) {
  const out = [];
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = camel(part.slice(0, i).trim().toLowerCase());
    const value = part
      .slice(i + 1)
      .replace(/!important/i, "")
      .trim();
    if (prop) out.push([prop, value]);
  }
  return out;
}

function addRules(doc, root, css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    let match;
    try {
      match = compile(m[1].trim());
    } catch {
      continue; // a selector this DOM doesn't understand (::placeholder, :focus …) styles nothing here
    }
    doc._rules.push({ root, match, decls: parseDecls(m[2]) });
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseInto(doc, parent, html) {
  let i = 0;
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const text = (s) => {
    if (s) top().childNodes.push(Object.assign(new Text(doc, decode(s)), { parentNode: top() }));
  };
  const sheetRoot = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].nodeType === 11) return stack[k];
    const r = parent.getRootNode();
    return r.nodeType === 11 ? r : doc;
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      const name = html
        .slice(lt + 2, end < 0 ? html.length : end)
        .trim()
        .toLowerCase();
      const at = stack.map((n) => n._closeAs ?? n.localName).lastIndexOf(name);
      if (at > 0) stack.length = at;
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const tag = /^<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (!tag) {
      text("<");
      i = lt + 1;
      continue;
    }
    i = lt + tag[0].length;
    const name = tag[1].toLowerCase();
    const attrs = [...tag[2].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g)].map((m) => [m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? "")]);
    // A declarative shadow root: its content becomes the parent's (open) shadow tree.
    if (name === "template" && attrs.some(([k, v]) => k === "shadowrootmode" && v === "open") && top().nodeType === 1) {
      const root = top().attachShadow({ mode: "open" });
      root._closeAs = "template";
      stack.push(root);
      continue;
    }
    const el = doc.createElement(name);
    for (const [k, v] of attrs) el._attrs.set(k, v);
    el.parentNode = top();
    top().childNodes.push(el);
    if (name === "dialog" && el._ha("data-modal")) el._modal = true;
    if (VOID.has(name) || tag[3] === "/") continue;
    if (RAW.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const body = html.slice(i, close < 0 ? html.length : close);
      if (body) el.childNodes.push(Object.assign(new Text(doc, name === "script" || name === "style" ? body : decode(body)), { parentNode: el }));
      if (name === "style") addRules(doc, sheetRoot(), body);
      i = close < 0 ? html.length : html.indexOf(">", close) + 1;
      continue;
    }
    stack.push(el);
  }
  doc._version++;
}

/**
 * A page from its HTML, as a window with a document. `top` makes it a frame of another window.
 * What tests can look at afterwards: doc._events (every event dispatched), doc._submits (forms submitted),
 * doc._navigations (links followed).
 */
export function loadPage(html, { url = "https://www.example.com/", width = 1200, height = 900, top = null } = {}) {
  const doc = new Document(url);
  parseInto(doc, doc, html);
  if (!doc._root() || doc._root().localName !== "html") {
    const kids = doc.childNodes.splice(0);
    const root = doc.createElement("html");
    const body = doc.createElement("body");
    root.parentNode = doc;
    doc.childNodes.push(root);
    body.parentNode = root;
    root.childNodes.push(body);
    for (const k of kids) {
      k.parentNode = body;
      body.childNodes.push(k);
    }
    doc._version++;
  }
  const location = new URL(url);
  const win = {
    document: doc,
    location,
    innerWidth: width,
    innerHeight: height,
    scrollX: 0,
    scrollY: 0,
    isSecureContext: location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname),
    _selection: "",
    getComputedStyle: (el) => doc._style(el),
    getSelection: () => ({
      toString: () => win._selection,
      removeAllRanges() {},
      addRange() {
        doc._selectAll = true;
      },
    }),
    Node,
    Element,
    HTMLElement,
    Document,
    DocumentFragment,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLFormElement,
    Event,
    MouseEvent,
    PointerEvent,
    KeyboardEvent,
    URL,
  };
  win.top = top ?? win;
  win.window = win;
  doc.defaultView = win;
  // What real documents and forms do: an element's name becomes a property that hides the built-in one.
  const shadow = (obj, key, el) => {
    if (key && !key.startsWith("_") && !Object.prototype.hasOwnProperty.call(obj, key)) Object.defineProperty(obj, key, { value: el, configurable: true });
  };
  for (const el of doc._qsa("img, form, embed, object, iframe")) shadow(doc, el._ga("name"), el);
  for (const form of doc._flat().filter((e) => e.localName === "form")) for (const c of form._qsa("input, select, textarea, button")) for (const key of [c._ga("name"), c._ga("id")]) shadow(form, key, c);
  return win;
}

/** Make `win` the page that free `window` / `document` mean (what an injected function sees); returns the undo. */
export function enter(win) {
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = win;
  globalThis.document = win.document;
  return () => {
    globalThis.window = before.window;
    globalThis.document = before.document;
  };
}
