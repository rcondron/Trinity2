/**
 * The runtime every widget card's document starts with. A widget is model-written HTML in a nested sandboxed frame
 * (opaque origin) inside the board's frame; this gives that document what the board's own frame has
 * (web/src/workspace/frame.ts), so a built page behaves the same wherever it runs:
 *
 *  - no side channels: WebRTC off, no frames of its own, and a <link> a script creates is a <div> (a preconnect hint
 *    reaches its host the moment it is inserted, which no CSP covers);
 *  - storage that works: an opaque origin has no localStorage, sessionStorage or cookies (touching them throws), so
 *    each is an in-memory stand-in for the life of the page — what must last is kept with trinity.saveState;
 *  - dialogs: alert() and confirm() become a toast in the window (confirm answers yes), prompt() takes its default;
 *  - links and forms never navigate the card away: an http(s) link is handed to the window (which asks the user before
 *    opening it), "#section" scrolls to the section, and a <form> runs its own submit handlers and goes nowhere;
 *  - script errors and unhandled rejections are reported to the board (capped and counted), which tells the engine: a
 *    freshly built page that throws gets one repair, and the card says what went wrong;
 *  - trinity: what a card may ask for — trinity.saveState(obj) / trinity.loadState() keep a small JSON object with the
 *    card (replayed in every window and after a restart; trinity.onstate hears another window change it), and
 *    trinity.emit(event) tells Trinity the user did something that needs her (only from a real click or key press,
 *    small, and seldom).
 *
 * Everything here talks to window.parent — the board — and nothing else; the board checks which of its frames a
 * message came from. Plain ES5 with no backticks, no "${" and no closing tags: it sits in a script tag inside a string.
 */

/** A widget document's own Content-Security-Policy (the board frame's, less its own origin: a nested frame can load neither). */
export const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** What a widget may keep with trinity.saveState, and send with trinity.emit, in characters of JSON. */
export const WIDGET_LIMITS = { state: 16_384, event: 2_048, error: 300 };

export const WIDGET_RUNTIME = String.raw`(function () {
  "use strict";
  if (window.__trinityWidget) return;
  window.__trinityWidget = true;
  var host = window.parent;
  var BOOT = window.__trinityBoot || {};
  try { delete window.__trinityBoot; } catch (e) { window.__trinityBoot = undefined; }
  function post(msg) { try { host.postMessage(msg, "*"); } catch (e) { /* the board went away */ } }

  // ── No side channels, no realms of its own ──
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription"].forEach(function (name) {
    try { Object.defineProperty(window, name, { configurable: false, writable: false, value: undefined }); } catch (e) { /* leave it */ }
  });
  var NESTED = /^(?:iframe|frame|object|embed)$/i;
  var HTML_NS = "http://www.w3.org/1999/xhtml";
  function neutral(ns, name) { return ns === HTML_NS && (NESTED.test(name) || name === "link"); }
  try {
    var realCreate = Document.prototype.createElement;
    var realCreateNS = Document.prototype.createElementNS;
    Object.defineProperty(Document.prototype, "createElement", {
      configurable: false,
      value: function () {
        var el = realCreate.apply(this, arguments);
        return neutral(el.namespaceURI, el.localName) ? realCreate.call(this, "div") : el;
      }
    });
    Object.defineProperty(Document.prototype, "createElementNS", {
      configurable: false,
      value: function () {
        var el = realCreateNS.apply(this, arguments);
        return neutral(el.namespaceURI, el.localName) ? realCreateNS.call(this, HTML_NS, "div") : el;
      }
    });
  } catch (e) { /* leave it */ }
  try {
    var realDefine = CustomElementRegistry.prototype.define;
    Object.defineProperty(CustomElementRegistry.prototype, "define", {
      configurable: false,
      value: function (name, ctor, options) {
        var base = options === undefined || options === null ? undefined : options.extends;
        base = base === undefined || base === null ? null : String(base);
        if (base !== null && neutral(HTML_NS, base)) throw new DOMException("A card can't extend <" + base + ">.", "NotSupportedError");
        return realDefine.call(this, name, ctor, base === null ? undefined : { extends: base });
      }
    });
  } catch (e) { /* leave it */ }
  try {
    var drop = function (node) {
      if (!node || node.nodeType !== 1) return;
      if (NESTED.test(node.nodeName)) { if (node.parentNode) node.parentNode.removeChild(node); return; }
      if (node.querySelectorAll) {
        var inner = node.querySelectorAll("iframe,frame,object,embed");
        for (var i = 0; i < inner.length; i++) if (inner[i].parentNode) inner[i].parentNode.removeChild(inner[i]);
      }
    };
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) drop(added[j]);
      }
    }).observe(document, { childList: true, subtree: true });
  } catch (e) { /* leave it */ }

  // ── Storage and cookies that work (in memory) ──
  function memoryStorage() {
    var data = Object.create(null);
    var store = {
      getItem: function (key) { key = String(key); return key in data ? data[key] : null; },
      setItem: function (key, value) { data[String(key)] = String(value); },
      removeItem: function (key) { delete data[String(key)]; },
      clear: function () { data = Object.create(null); },
      key: function (index) { var keys = Object.keys(data); return index >= 0 && index < keys.length ? keys[index] : null; }
    };
    Object.defineProperty(store, "length", { get: function () { return Object.keys(data).length; } });
    return store;
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var usable = false;
    try { usable = !!window[name]; } catch (e) { usable = false; }
    if (usable) return;
    try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true, writable: true }); } catch (e) { /* leave it */ }
  });
  try { void document.cookie; } catch (e) {
    var jar = Object.create(null);
    try {
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: function () { return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; "); },
        set: function (value) {
          var pair = String(value).split(";")[0] || "";
          var at = pair.indexOf("=");
          if (at > 0) jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
        }
      });
    } catch (x) { /* ignore */ }
  }

  // ── Dialogs and popups ──
  var lastAlert = 0;
  function say(message) {
    var now = Date.now();
    if (now - lastAlert < 800) return;
    lastAlert = now;
    post({ __trinity: "alert", text: (message === undefined ? "" : String(message)).slice(0, 300) });
  }
  try {
    window.alert = function (message) { say(message); };
    window.confirm = function (message) { say(message); return true; };
    window.prompt = function (message, value) { return value === undefined || value === null ? "" : String(value); };
    window.open = function (url) {
      var href = url === undefined || url === null ? "" : String(url);
      if (/^\s*https?:\/\//i.test(href)) post({ __trinity: "link", href: href.trim() });
      return null;
    };
  } catch (e) { /* ignore */ }

  // ── Links and forms never take the card anywhere ──
  function jump(hash) {
    try {
      var name = decodeURIComponent(hash.slice(1));
      var target = name ? (document.getElementById(name) || document.getElementsByName(name)[0]) : null;
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "start" });
      else if (!name || name === "top") window.scrollTo(0, 0);
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("click", function (event) {
    var t = event.target;
    var link = t && t.closest ? t.closest("a[href]") : null;
    if (!link) return;
    var raw = String(link.getAttribute("href") || "").trim();
    if (/^javascript:/i.test(raw)) return;
    if (raw.charAt(0) === "#") {
      // A srcdoc page resolves "#x" against the page that holds it: followed, it would load THAT page into the card.
      // The jump is made here instead — unless the page's own handler cancels the click (a tab strip, an accordion).
      var cancelled = false;
      try { Object.defineProperty(event, "preventDefault", { configurable: true, value: function () { cancelled = true; } }); } catch (e) { /* ignore */ }
      Event.prototype.preventDefault.call(event);
      setTimeout(function () { if (!cancelled) jump(raw); }, 0);
      return;
    }
    event.preventDefault();
    if (/^https?:\/\//i.test(raw)) post({ __trinity: "link", href: raw });
  }, true);
  // A form's own submit handlers run; the submission itself goes nowhere.
  window.addEventListener("submit", function (event) { event.preventDefault(); }, true);
  try {
    HTMLFormElement.prototype.submit = function () {
      var ev;
      try { ev = new SubmitEvent("submit", { bubbles: true, cancelable: true }); }
      catch (e) { ev = new Event("submit", { bubbles: true, cancelable: true }); }
      this.dispatchEvent(ev);
    };
  } catch (e) { /* ignore */ }

  // ── Script errors go to the board (a few, short) ──
  var reported = [];
  var lastError = "";
  var lastErrorAt = 0;
  function describe(err) {
    try {
      if (err === null || err === undefined) return "Unknown error";
      if (typeof err === "string") return err;
      var message = err.message !== undefined ? String(err.message) : String(err);
      if (message === "[object Object]") { try { message = JSON.stringify(err); } catch (e) { /* keep it */ } }
      var name = err.name ? String(err.name) : "";
      if (name && name !== "Error" && message.indexOf(name) !== 0) message = name + ": " + message;
      return message;
    } catch (e) { return "Unknown error"; }
  }
  function report(err, where) {
    var message = describe(err);
    if (/ResizeObserver loop/i.test(message)) return;
    if (where) message = where + ": " + message;
    message = message.replace(/\s+/g, " ").slice(0, 300);
    var now = Date.now();
    if (message === lastError && now - lastErrorAt < 5000) return;
    while (reported.length && now - reported[0] > 60000) reported.shift();
    if (reported.length >= 4) return;
    reported.push(now);
    lastError = message;
    lastErrorAt = now;
    post({ __trinity: "error", message: message });
  }
  window.addEventListener("error", function (event) {
    if (!event) return;
    // (A picture or a clip that failed to load is not a script error: those events have no message.)
    if (event.error === undefined && !event.message) return;
    report(event.error !== undefined && event.error !== null ? event.error : event.message);
  });
  window.addEventListener("unhandledrejection", function (event) { report(event ? event.reason : null, "Unhandled promise rejection"); });

  // ── trinity: what a card may keep and say ──
  var MAX_STATE = 16384;
  var MAX_EVENT = 2048;
  var state = BOOT.state === undefined ? null : BOOT.state;
  var stateJson = "null";
  try { stateJson = JSON.stringify(state); } catch (e) { state = null; }
  var saveTimer = 0;
  var unsent = false;
  var sent = [];
  function copy(value) { return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value)); }
  function flush() {
    saveTimer = 0;
    if (!unsent) return;
    var now = Date.now();
    while (sent.length && now - sent[0] > 60000) sent.shift();
    // Too many saves in a minute: the newest still goes, a little later.
    if (sent.length >= 40) { saveTimer = setTimeout(flush, 3000); return; }
    sent.push(now);
    unsent = false;
    post({ __trinity: "state", state: state });
  }
  // A real press: a trusted event (script can't forge one) in the last second — and, where the browser says so, user activation.
  var lastGesture = 0;
  ["pointerdown", "pointerup", "click", "keydown", "keyup", "input", "change", "submit", "touchend"].forEach(function (type) {
    window.addEventListener(type, function (event) { if (event && event.isTrusted) lastGesture = Date.now(); }, true);
  });
  function pressed() {
    if (Date.now() - lastGesture > 1000) return false;
    try { if (navigator.userActivation && !navigator.userActivation.isActive) return false; } catch (e) { /* no such flag here */ }
    return true;
  }
  var emitted = [];
  var api = {
    version: 1,
    saveState: function (value) {
      var json;
      try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { return false; }
      if (typeof json !== "string" || json.length > MAX_STATE) return false;
      if (json === stateJson) return true;
      state = JSON.parse(json);
      stateJson = json;
      unsent = true;
      if (!saveTimer) saveTimer = setTimeout(flush, 200);
      return true;
    },
    loadState: function () { return copy(state); },
    emit: function (event) {
      if (!pressed()) return false;
      var now = Date.now();
      while (emitted.length && now - emitted[0] > 10000) emitted.shift();
      if (emitted.length >= 3) return false;
      var json;
      try { json = JSON.stringify(event === undefined ? null : event); } catch (e) { return false; }
      if (typeof json !== "string" || json.length > MAX_EVENT) return false;
      emitted.push(now);
      post({ __trinity: "emit", event: JSON.parse(json) });
      return true;
    },
    onstate: null
  };
  try { Object.defineProperty(window, "trinity", { value: api, configurable: false, writable: false }); } catch (e) { window.trinity = api; }
  // The same card in another window saved something: this one takes it, and tells the page.
  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var d = event.data;
    if (!d || d.__trinity !== "state") return;
    var json;
    try { json = JSON.stringify(d.state === undefined ? null : d.state); } catch (e) { return; }
    if (json === stateJson || json.length > MAX_STATE) return;
    state = JSON.parse(json);
    stateJson = json;
    unsent = false;
    if (typeof api.onstate === "function") {
      try { api.onstate(copy(state)); } catch (err) { report(err, "onstate"); }
    }
  });
  window.addEventListener("pagehide", function () { if (saveTimer) { clearTimeout(saveTimer); flush(); } });
})();`;
