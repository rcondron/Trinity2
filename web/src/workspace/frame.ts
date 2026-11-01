/**
 * Workspace frame documents.
 *
 * Everything the workspace shows renders inside a sandboxed iframe (opaque origin — no
 * `allow-same-origin`). This module builds that iframe's `srcdoc`:
 *
 *  - "app":   base CSS + RUNTIME + template source (template contract v1) + BOOT.
 *             The first state is embedded in the document, so the very first paint already
 *             has content and "ready" means "rendered". Later states arrive by postMessage
 *             and are rendered in place — the frame is never reloaded for a data change.
 *  - "html":  base CSS + RUNTIME (error reporting, link/form guards, sandbox shims) + a
 *             freeform HTML fragment (or a full document) + BOOT.
 *  - "empty": the "Ask Trinity to build something" placeholder.
 *
 * Messages (see protocol.ts): frame → host `{type:"ready"}` | `{type:"render_error", message}`
 * | `{type:"ui_event", evt}`; host → frame `{type:"state", state}` | `{type:"asset", url, blob}`
 * (engine images, delivered as bytes — the frame shows them from its own blob: URLs).
 */

export type FrameKind = "html" | "app" | "empty";

export interface FramePayload {
  /** html: an HTML fragment or full document. app: the template source. empty: optional lead text. */
  source?: string;
  /**
   * app only: the first state, rendered synchronously at boot (the host should already have
   * absolutized "/api/..." strings). Omit it to wait for the first posted state instead.
   */
  state?: unknown;
}

/**
 * Generated code — templates (contract v1) and freeform builds alike — may not touch the
 * network: no fetch/XHR/WebSocket and no remote scripts, styles, fonts or images (a remote
 * image is an exfiltration channel too). Images and media load only from data:/blob: and
 * the app's own origin (engine art arrives in state as absolute URLs on that origin).
 */
function frameCsp(): string {
  let origin = "";
  try {
    origin = typeof location !== "undefined" && /^https?:/.test(location.origin) ? location.origin : "";
  } catch {
    /* no location (tests) */
  }
  const media = ["data:", "blob:", origin].filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src ${media}`,
    `media-src ${media}`,
    "font-src data:",
    "connect-src 'none'",
    "worker-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Defaults every frame starts from — dark, matches the app, full-height, tidy scrollbars.
 * Wrapped in :where() (zero specificity) so any template/build rule wins.
 */
const BASE_CSS = `
:root{color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
:where(html,body){height:100%;margin:0}
:where(html){background:#0f0f18}
:where(body){background:#0f0f18;color:#e9e9f2;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
:where(img,video){max-width:100%}
:where(canvas){display:block}
:where(a){color:#a78bfa}
:where(button,input,select,textarea){font:inherit;color:inherit}
:where(:focus-visible){outline:2px solid #8b5cf6;outline-offset:2px}
::selection{background:rgba(139,92,246,.38)}
*{scrollbar-width:thin;scrollbar-color:#34344c transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#2c2c42;border-radius:10px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background-color:#45456c}
::-webkit-scrollbar-corner{background:transparent}
`;

const EMPTY_CSS = `
body.tw-empty{display:grid;place-items:center;min-height:100%;overflow:hidden;
  background:
    radial-gradient(760px 420px at 50% 38%,rgba(139,92,246,.16),transparent 62%),
    radial-gradient(520px 320px at 66% 72%,rgba(34,211,238,.07),transparent 60%),
    #0f0f18}
body.tw-empty::before{content:"";position:fixed;inset:0;pointer-events:none;
  background-image:radial-gradient(rgba(255,255,255,.06) 1px,transparent 1.3px);background-size:24px 24px;
  -webkit-mask-image:radial-gradient(ellipse 70% 62% at 50% 45%,#000 25%,transparent 75%);
  mask-image:radial-gradient(ellipse 70% 62% at 50% 45%,#000 25%,transparent 75%)}
.wrap{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;padding:32px 24px;max-width:560px;animation:rise .7s cubic-bezier(.2,.8,.2,1) both}
.mark{position:relative;width:104px;height:104px;margin-bottom:28px}
.halo{position:absolute;inset:-36px;border-radius:50%;background:radial-gradient(circle,rgba(139,92,246,.34),rgba(34,211,238,.10) 45%,transparent 70%);filter:blur(6px);animation:breathe 5.5s ease-in-out infinite}
.ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(34,211,238,0),rgba(34,211,238,.85),rgba(139,92,246,.9),rgba(139,92,246,0) 72%);
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px));
  mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px));animation:spin 9s linear infinite}
.ring.two{inset:12px;opacity:.45;animation-duration:14s;animation-direction:reverse}
.core{position:absolute;inset:28px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#67e8f9,#8b5cf6 58%,#4c1d95);box-shadow:0 0 30px rgba(139,92,246,.75),inset 0 -6px 14px rgba(0,0,0,.35);animation:breathe 5.5s ease-in-out infinite}
h1{margin:0 0 8px;font-size:21px;font-weight:650;letter-spacing:.01em;color:#f1f1f8}
.lead{margin:0;color:#a5a5c6;font-size:15px;line-height:1.55;max-width:420px}
.ideas{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:26px}
.ideas span{font-size:12.5px;color:#b9b9d4;padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
.ideas span:nth-child(1){animation-delay:.2s}.ideas span:nth-child(2){animation-delay:.3s}.ideas span:nth-child(3){animation-delay:.4s}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.88}50%{transform:scale(1.06);opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;

/**
 * The in-frame runtime (plain ES5 so it runs anywhere, no backticks / no "${").
 * Wrapped as `(function (MODE, HAS_INIT, INIT) { ... })(...)` by runtimeScript().
 */
const RUNTIME_BODY = String.raw`
"use strict";
var host = window.parent;
var booted = false;
var readySent = false;
var hasShown = false;
var shown = null;
var hasLatest = false;
var latest = null;
var scheduled = false;
var lastDrawAt = 0;
var lastError = "";
var lastErrorAt = 0;
// Engine images arrive as bytes from the host ("asset" messages): this opaque-origin frame
// can't load http://localhost URLs itself. url -> blob: URL made here; failed ones in missing.
var rawShown = null;
var assets = Object.create(null);
var missing = Object.create(null);

function post(msg) {
  try { host.postMessage(msg, "*"); } catch (err) { /* the host went away */ }
}

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;";
  });
}

function describe(err) {
  try {
    if (err === null || err === undefined) return "Unknown error";
    if (typeof err === "string") return err;
    var message = err.message !== undefined ? String(err.message) : String(err);
    if (message === "[object Object]") {
      try { message = JSON.stringify(err); } catch (e) { /* keep it */ }
    }
    var name = err.name ? String(err.name) : "";
    // Keep specific names (TypeError: ...) but not the generic "Error: " prefix.
    if (name && name !== "Error" && message.indexOf(name) !== 0) message = name + ": " + message;
    return message;
  } catch (e) {
    return "Unknown error";
  }
}

function report(err, where) {
  var message = describe(err);
  // A benign browser notice, not a template bug.
  if (/ResizeObserver loop/i.test(message)) return;
  if (where) message = where + ": " + message;
  if (message.length > 600) message = message.slice(0, 600) + "…";
  var now = Date.now();
  if (message === lastError && now - lastErrorAt < 2000) return;
  lastError = message;
  lastErrorAt = now;
  post({ type: "render_error", message: message });
}

function normalize(state) {
  return state === null || state === undefined ? {} : state;
}

function findRender() {
  if (typeof window.render === "function") return window.render;
  // Lenient: also accept a global "let/const render = ..." binding.
  try {
    var lexical = (0, eval)("typeof render === \"function\" ? render : null");
    if (typeof lexical === "function") return lexical;
  } catch (e) { /* no such binding */ }
  return null;
}

function isAssetUrl(value) {
  return typeof value === "string" && /\/api\/images\/[^\/?#]+$/.test(value);
}

// The state as the template should see it: engine image URLs swapped for this frame's blob:
// URLs. An image whose bytes haven't arrived yet shows as "pending" (the templates' shimmer).
function swapAssets(value, depth) {
  if (typeof value === "string") return assets[value] || value;
  if (value === null || typeof value !== "object" || depth > 64) return value;
  var out, i, key;
  if (Array.isArray(value)) {
    out = new Array(value.length);
    for (i = 0; i < value.length; i++) out[i] = swapAssets(value[i], depth + 1);
    return out;
  }
  out = {};
  for (key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = swapAssets(value[key], depth + 1);
  }
  if (isAssetUrl(value.url) && typeof value.status === "string" && !assets[value.url]) {
    if (missing[value.url]) { out.url = null; out.status = "error"; }
    else if (value.status === "ready") { out.url = null; out.status = "pending"; }
  }
  return out;
}

function takeAsset(data) {
  var url = typeof data.url === "string" ? data.url : "";
  if (!url || assets[url]) return;
  if (data.blob) {
    try { assets[url] = URL.createObjectURL(data.blob); } catch (e) { missing[url] = true; }
  } else {
    missing[url] = true;
  }
  // Redraw with the image in place (a burst of images coalesces into one render).
  if (booted && hasShown && !hasLatest) { latest = rawShown; hasLatest = true; }
  if (booted && hasLatest) schedule();
}

function draw(nextRaw) {
  lastDrawAt = Date.now();
  rawShown = nextRaw;
  var next = MODE === "app" ? swapAssets(nextRaw, 0) : nextRaw;
  var prev = hasShown ? shown : null;
  shown = next;
  hasShown = true;
  var fn = findRender();
  if (!fn) {
    report("The template does not define window.render(state, prev).");
    return;
  }
  try {
    fn.call(window, next, prev);
  } catch (err) {
    report(err, "render");
  }
}

function flush() {
  scheduled = false;
  if (!hasLatest) return;
  var next = latest;
  latest = null;
  hasLatest = false;
  draw(next);
}

// Coalesce bursts to one render per frame (rAF), with a timer fallback so hidden windows
// still update.
function schedule() {
  if (scheduled) return;
  scheduled = true;
  var fired = false;
  var run = function () {
    if (fired) return;
    fired = true;
    flush();
  };
  try {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  } catch (e) { /* ignore */ }
  setTimeout(run, 50);
}

window.trinity = {
  version: 1,
  mode: MODE,
  esc: esc,
  send: function (evt) {
    try {
      host.postMessage({ type: "ui_event", evt: evt }, "*");
    } catch (err) {
      try { host.postMessage({ type: "ui_event", evt: JSON.parse(JSON.stringify(evt)) }, "*"); } catch (e) { /* not cloneable */ }
    }
  }
};

// The runtime's own listeners, kept so they can go back on when the page replaces its document
// (below): that erases every listener on the window and the document.
var listeners = [];
function listen(target, type, fn, capture) {
  listeners.push([target, type, fn, !!capture]);
  target.addEventListener(type, fn, !!capture);
}
function rearm() {
  for (var i = 0; i < listeners.length; i++) {
    var entry = listeners[i];
    entry[0].addEventListener(entry[1], entry[2], entry[3]); // (one still in place isn't added twice)
  }
}

listen(window, "message", function (event) {
  if (event.source !== host || MODE !== "app") return;
  var data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "asset") {
    takeAsset(data);
    return;
  }
  if (data.type !== "state") return;
  latest = normalize(data.state);
  hasLatest = true;
  if (!booted) return;
  // Spaced-out updates render right away; a burst coalesces to one render per frame.
  if (!scheduled && Date.now() - lastDrawAt >= 32) flush();
  else schedule();
});

listen(window, "error", function (event) {
  if (!event) return;
  report(event.error !== undefined && event.error !== null ? event.error : event.message);
});

listen(window, "unhandledrejection", function (event) {
  report(event ? event.reason : null, "Unhandled promise rejection");
});

// Keep the workspace in place: links never navigate this frame away (absolute http(s)
// links go to the host, which opens them in a new tab once the viewer OKs the URL) and
// forms only run their own JS handlers. (The host page's CSP refuses any navigation of
// this frame anyway: a page could carry data out in the URL.)
function jumpTo(hash) {
  try {
    if (hash.length > 1) location.hash = hash;
    else window.scrollTo(0, 0);
  } catch (e) { /* ignore */ }
}

listen(document, "click", function (event) {
  var target = event.target;
  var link = target && target.closest ? target.closest("a[href]") : null;
  if (!link) return;
  var raw = String(link.getAttribute("href") || "").trim();
  if (/^javascript:/i.test(raw)) return;
  event.preventDefault();
  if (raw.charAt(0) === "#") {
    // A srcdoc document resolves "#x" against the PARENT page's URL, so the default click
    // would load that page into this frame. location.hash resolves against about:srcdoc
    // (a real in-page jump) — unless the page's own handler cancelled the click (JS tabs).
    var pageCancelled = false;
    try {
      Object.defineProperty(event, "preventDefault", { configurable: true, value: function () { pageCancelled = true; } });
    } catch (e) { /* ignore */ }
    setTimeout(function () { if (!pageCancelled) jumpTo(raw); }, 0);
    return;
  }
  if (/^https?:\/\//i.test(raw)) post({ type: "ui_event", evt: { __trinity: "link", href: raw } });
}, true);

listen(window, "submit", function (event) { event.preventDefault(); }, true);

// A loaded page may replace its document — document.open(), or a document.write() that opens a new
// one (a game's "Play again") — and the new one keeps this runtime: the CSP, the sandbox and the
// guards on the window and on prototypes outlive the swap, the frame observer below watches the
// document itself, and the runtime's listeners go straight back on.
try {
  ["open", "write", "writeln"].forEach(function (name) {
    var real = Document.prototype[name];
    Object.defineProperty(Document.prototype, name, {
      configurable: false,
      value: function () {
        try {
          return real.apply(this, arguments);
        } finally {
          if (this === document) rearm();
        }
      }
    });
  });
} catch (e) { /* leave it */ }

try {
  HTMLFormElement.prototype.submit = function () {
    var ev;
    try { ev = new SubmitEvent("submit", { bubbles: true, cancelable: true }); }
    catch (e) { ev = new Event("submit", { bubbles: true, cancelable: true }); }
    this.dispatchEvent(ev);
  };
} catch (e) { /* ignore */ }

// Sandbox shims: an opaque origin has no storage or cookies (accessing them throws),
// and modal dialogs / popups are blocked. Generated UIs use all of these.
function memoryStorage() {
  var data = Object.create(null);
  var store = {
    getItem: function (key) { key = String(key); return key in data ? data[key] : null; },
    setItem: function (key, value) { data[String(key)] = String(value); },
    removeItem: function (key) { delete data[String(key)]; },
    clear: function () { data = Object.create(null); },
    key: function (index) {
      var keys = Object.keys(data);
      return index >= 0 && index < keys.length ? keys[index] : null;
    }
  };
  Object.defineProperty(store, "length", { get: function () { return Object.keys(data).length; } });
  return store;
}

["localStorage", "sessionStorage"].forEach(function (name) {
  var usable = false;
  try { usable = !!window[name]; } catch (e) { usable = false; }
  if (usable) return;
  try {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true, writable: true });
  } catch (e) { /* leave it */ }
});

try {
  void document.cookie;
} catch (e) {
  var jar = Object.create(null);
  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: function () {
        return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; ");
      },
      set: function (value) {
        var pair = String(value).split(";")[0] || "";
        var at = pair.indexOf("=");
        if (at > 0) jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
    });
  } catch (x) { /* ignore */ }
}

try {
  window.alert = function (message) {
    post({ type: "ui_event", evt: { __trinity: "alert", text: message === undefined ? "" : String(message) } });
  };
} catch (e) { /* ignore */ }

// The sandbox would answer confirm() with false and prompt() with null, so the guarded
// action never runs: confirm() goes ahead (its question shows like an alert) and prompt()
// takes its default answer.
try {
  window.confirm = function (message) {
    post({ type: "ui_event", evt: { __trinity: "alert", text: message === undefined ? "" : String(message) } });
    return true;
  };
  window.prompt = function (message, value) {
    return value === undefined || value === null ? "" : String(value);
  };
} catch (e) { /* ignore */ }

try {
  window.open = function (url) {
    var href = url === undefined || url === null ? "" : String(url);
    if (/^\s*https?:\/\//i.test(href)) post({ type: "ui_event", evt: { __trinity: "link", href: href.trim() } });
    return null;
  };
} catch (e) { /* ignore */ }

// No network side channels and no nested realms. The frame's CSP has no directive for WebRTC, so a
// page could reach any host over STUN/TURN (ICE) — the RTC constructors are made unusable. A nested
// frame would be a fresh realm with its own un-neutralized constructors, so creating one yields a
// plain <div>, and any frame that still reaches the DOM (innerHTML, etc.) is removed. A <link> a
// script creates is a <div> too: a preconnect hint reaches its host the moment it's inserted, which
// neither the CSP nor an observer can stop (a build's own <link> tags are stripped before it gets
// here; one a script writes in as markup, through innerHTML and the like, still goes out). Neither
// may be a customized built-in (class X extends HTMLLinkElement), which new X() would make with no
// createElement call. Generated UIs never need any of these, and the CSP already blocks remote frames
// and connections.
["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription"].forEach(function (name) {
  try { Object.defineProperty(window, name, { configurable: false, writable: false, value: undefined }); } catch (e) { /* leave it */ }
});

var NESTED_FRAME = /^(?:iframe|frame|object|embed)$/i;
var HTML_NS = "http://www.w3.org/1999/xhtml";
// An HTML frame, object, embed or link (an XML export's own <link> is just data).
var neutralized = function (namespace, localName) {
  return namespace === HTML_NS && (NESTED_FRAME.test(localName) || localName === "link");
};
try {
  // Made by the document it's called on (a DOMParser or createHTMLDocument document makes its own
  // nodes), then judged by what it made: only those become a <div>.
  var realCreateElement = Document.prototype.createElement;
  var realCreateElementNS = Document.prototype.createElementNS;
  Object.defineProperty(Document.prototype, "createElement", {
    configurable: false,
    value: function () {
      var el = realCreateElement.apply(this, arguments);
      return neutralized(el.namespaceURI, el.localName) ? realCreateElement.call(this, "div") : el;
    }
  });
  Object.defineProperty(Document.prototype, "createElementNS", {
    configurable: false,
    value: function () {
      var el = realCreateElementNS.apply(this, arguments);
      return neutralized(el.namespaceURI, el.localName) ? realCreateElementNS.call(this, HTML_NS, "div") : el;
    }
  });
} catch (e) { /* leave it */ }
try {
  var realDefine = CustomElementRegistry.prototype.define;
  Object.defineProperty(CustomElementRegistry.prototype, "define", {
    configurable: false,
    value: function (name, constructor, options) {
      // Read once, so a getter can't answer this check one way and the browser another.
      var base = options === undefined || options === null ? undefined : options.extends;
      base = base === undefined || base === null ? null : String(base);
      if (base !== null && neutralized(HTML_NS, base)) throw new DOMException("A workspace page can't extend <" + base + ">.", "NotSupportedError");
      return realDefine.call(this, name, constructor, base === null ? undefined : { extends: base });
    }
  });
} catch (e) { /* leave it */ }
try {
  var dropFrames = function (node) {
    if (!node || node.nodeType !== 1) return;
    if (NESTED_FRAME.test(node.nodeName)) {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    if (node.querySelectorAll) {
      var nested = node.querySelectorAll("iframe,frame,object,embed");
      for (var i = 0; i < nested.length; i++) if (nested[i].parentNode) nested[i].parentNode.removeChild(nested[i]);
    }
  };
  // (The document itself, not its root element: a page that replaces either is still watched.)
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) dropFrames(added[j]);
    }
  }).observe(document, { childList: true, subtree: true });
} catch (e) { /* leave it */ }

function finishBoot() {
  if (booted) return;
  booted = true;
  if (MODE === "app") {
    if (hasLatest) flush();
    else if (HAS_INIT) draw(normalize(INIT));
    else if (!findRender()) report("The template does not define window.render(state, prev).");
  }
  if (!readySent) {
    readySent = true;
    post({ type: "ready" });
  }
}

function boot() {
  if (booted) return;
  if (MODE === "app" && !findRender() && document.readyState !== "complete") {
    // The template may define render() late (e.g. in a load handler) — give it until load.
    window.addEventListener("load", function () { setTimeout(finishBoot, 0); });
    return;
  }
  finishBoot();
}

// Called by the BOOT script after the template's markup and scripts; boots once every
// DOMContentLoaded handler (and any module script) has run.
window.__trinityBoot = function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 0); });
  } else {
    setTimeout(boot, 0);
  }
};

// Safety net: if something in the template swallowed the BOOT script, boot at load anyway.
listen(window, "load", function () { setTimeout(boot, 0); });
`;

const BOOT_TAG = "<script>window.__trinityBoot&&window.__trinityBoot();</script>";

const FULL_DOCUMENT = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype|html)[\s>]/i;

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** HTML-escape any value (null/undefined → ""). */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * JSON that is safe to inline inside a <script>: "<" is escaped (so neither "</script" nor
 * "<!--" can appear), along with ">", "&" and the JS line separators.
 */
export function scriptJson(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = undefined; // circular / BigInt — not representable
  }
  return (json ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEP).join("\\u2028")
    .split(PARA_SEP).join("\\u2029");
}

function runtimeScript(kind: FrameKind, init?: { state: unknown }): string {
  return (
    "(function (MODE, HAS_INIT, INIT) {" +
    RUNTIME_BODY +
    "\n})(" +
    JSON.stringify(kind) +
    ", " +
    (init ? "true" : "false") +
    ", " +
    (init ? scriptJson(init.state) : "null") +
    ");"
  );
}

function headFor(kind: FrameKind, init?: { state: unknown }): string {
  return (
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp()}">` +
    // No DNS lookups ahead of the page's links: a host name can carry data out too.
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<style>" +
    BASE_CSS +
    (kind === "empty" ? EMPTY_CSS : "") +
    "</style>" +
    "<script>" +
    runtimeScript(kind, init) +
    "</script>"
  );
}

function insertAt(src: string, index: number, text: string): string {
  return src.slice(0, index) + text + src.slice(index);
}

/** Merge our head/tail into a full document the payload brought along. */
function intoDocument(src: string, head: string, tail: string): string {
  let out = src;
  const headTag = /<head(?:\s[^>]*)?>/i.exec(out);
  if (headTag) {
    out = insertAt(out, headTag.index + headTag[0].length, head);
  } else {
    const htmlTag = /<html(?:\s[^>]*)?>/i.exec(out);
    if (htmlTag) {
      out = insertAt(out, htmlTag.index + htmlTag[0].length, `<head>${head}</head>`);
    } else {
      const doctype = /<!doctype[^>]*>/i.exec(out);
      out = insertAt(out, doctype ? doctype.index + doctype[0].length : 0, `<head>${head}</head>`);
    }
  }
  if (!/^\s*<!doctype/i.test(out)) out = `<!doctype html>${out}`;
  return out + tail;
}

function compose(source: string, head: string, tail: string, bodyClass?: string): string {
  if (FULL_DOCUMENT.test(source)) return intoDocument(source, head, tail);
  const body = bodyClass ? `<body class="${bodyClass}">` : "<body>";
  return `<!doctype html><html lang="en"><head>${head}</head>${body}${source}${tail}</body></html>`;
}

function emptyMarkup(lead: string): string {
  const text = lead.trim() || "Talk to Trinity — what she builds, finds and plans for you appears here live.";
  return (
    '<main class="wrap">' +
    '<div class="mark" aria-hidden="true"><div class="halo"></div><div class="ring"></div><div class="ring two"></div><div class="core"></div></div>' +
    "<h1>Ready when you are</h1>" +
    `<p class="lead">${escapeHtml(text)}</p>` +
    '<div class="ideas" aria-label="Ideas">' +
    "<span>“Build me a pomodoro timer”</span>" +
    "<span>“Chart the tallest buildings in the world”</span>" +
    "<span>“Make a skill that converts currencies”</span>" +
    "</div></main>"
  );
}

/**
 * Model-written HTML without its <link> tags: a preconnect or dns-prefetch hint reaches its host as soon
 * as it's parsed, which no CSP covers, and a generated page needs none (everything it uses is inline). A
 * coder's build comes without them already (mordiem.ts); a skill's card may not. Only the whole tag name
 * counts ("<link-card>" is the page's own), and a space takes each one's place. (A template keeps its code
 * as written: it's the engine's own, or a generated one that was refused if it had any — template-gen.ts.)
 */
export function withoutLinks(html: string): string {
  return html.replace(/<link(?=[\s/>]|$)[^>]*(?:>|$)/gi, " ");
}

/**
 * Build the complete srcdoc for a workspace frame.
 *  - `buildFrameDoc("app", { source: template.source, state })`
 *  - `buildFrameDoc("html", htmlFragmentOrDocument)`
 *  - `buildFrameDoc("empty")`
 */
export function buildFrameDoc(kind: FrameKind, payload: string | FramePayload = {}): string {
  const p: FramePayload = typeof payload === "string" ? { source: payload } : (payload ?? {});
  const source = typeof p.source === "string" ? p.source : "";
  if (kind === "app") {
    const init = Object.prototype.hasOwnProperty.call(p, "state") ? { state: p.state } : undefined;
    return compose(source, headFor("app", init), BOOT_TAG);
  }
  if (kind === "html") return compose(withoutLinks(source), headFor("html"), BOOT_TAG);
  return compose(emptyMarkup(source), headFor("empty"), BOOT_TAG, "tw-empty");
}
