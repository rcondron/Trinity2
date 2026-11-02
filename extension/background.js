// Trinity Browser Bridge — the service worker. One WebSocket to the Trinity engine on this computer
// (ws://127.0.0.1:8799/ext, paired with the token from Settings → Browser extension); the engine's
// calls run here through Chrome's extension APIs, tab changes are reported back, and a page, selection,
// link or image you put on her board from the page's menu goes to Trinity's workspace. Everything is
// local; nothing leaves the machine.
//
// What the engine may ask for (services/browser-bridge.ts in the engine lists the same):
//   tabs.list / open / close / activate / navigate / history / zoom
//   page.snapshot (text, headings, the clickable things with refs, pictures, structure, selection)
//   page.act (click / type / select / scroll / press), page.inject (css / html / js), page.restore,
//   page.capture (a screenshot), files.download, files.savePage (a web archive)
//
// Rules kept here, whatever the engine asks: password fields are never listed or typed into; Chrome's
// own pages are left alone; only web and data: URLs are opened or downloaded.

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_ENGINE = "ws://127.0.0.1:8799";
const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const TABS_DEBOUNCE_MS = 250;

let ws = null;
let status = { state: "off", detail: "Not connected yet.", since: 0 };
let reconnectTimer = null;
let backoff = RECONNECT_MIN_MS;
let tabsTimer = null;
/** tabId → Map<id, { css }> — what Trinity injected, so it can be undone. */
const injected = new Map();
/** Disconnect was pressed in the popup: no socket and no reconnecting until Connect (kept in storage, so it survives a worker restart). */
let pausedByUser = false;
const PAUSED_DETAIL = "Disconnected — press Connect to let Trinity use this browser again.";

// ─── Settings & status ───────────────────────────────────────────────────────

async function settings() {
  const { engine, token, paused } = await chrome.storage.local.get(["engine", "token", "paused"]);
  const base = String(engine || DEFAULT_ENGINE)
    .trim()
    .replace(/\/+$/, "")
    .replace(/^http(s?):\/\//, "ws$1://");
  return { engine: /^wss?:\/\//.test(base) ? base : `ws://${base}`, token: String(token || "").trim(), paused: Boolean(paused) };
}

function setStatus(state, detail) {
  status = { state, detail: detail || "", since: Date.now() };
  const text = state === "connected" ? "" : state === "connecting" ? "…" : state === "error" ? "!" : "off";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === "error" ? "#dc2626" : "#6b7280" }).catch(() => {});
}

function chromeVersion() {
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return m ? m[1] : "";
}

function hasUserScripts() {
  try {
    return Boolean(chrome.userScripts && typeof chrome.userScripts.execute === "function");
  } catch {
    return false;
  }
}

// ─── Connection ──────────────────────────────────────────────────────────────

function send(msg) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), backoff);
  backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const { engine, token, paused } = await settings();
  pausedByUser = paused;
  if (paused) {
    setStatus("paused", PAUSED_DETAIL);
    return;
  }
  if (!token) {
    setStatus("off", "No token yet — paste the one from Trinity's Settings → Browser extension.");
    return;
  }
  setStatus("connecting", `Connecting to ${engine}…`);
  let sock;
  try {
    sock = new globalThis.WebSocket(`${engine}/ext?token=${encodeURIComponent(token)}&v=1`);
  } catch (err) {
    setStatus("error", `Bad engine address: ${String((err && err.message) || err)}`);
    return;
  }
  ws = sock;
  sock.onopen = async () => {
    backoff = RECONNECT_MIN_MS;
    send({
      type: "hello",
      version: VERSION,
      chrome: chromeVersion(),
      caps: { userScripts: hasUserScripts(), pageCapture: Boolean(chrome.pageCapture) },
      tabs: await listTabs(),
    });
  };
  sock.onmessage = (ev) => void onMessage(ev.data);
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    if (pausedByUser) return; // closed by Disconnect: the status already says so, and nothing reconnects
    if (ev.code === 4401) setStatus("error", "The engine refused the token — paste the current one from Settings → Browser extension.");
    else if (ev.code === 4409) setStatus("off", "Another copy of the extension connected; this one stepped back.");
    else {
      setStatus("off", "Not connected — is the Trinity engine running?");
      scheduleReconnect();
    }
  };
  sock.onerror = () => {
    /* onclose follows with the reason */
  };
}

async function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "welcome") {
    setStatus("connected", "Connected to Trinity.");
    return;
  }
  if (msg.type === "ping") {
    send({ type: "pong" });
    return;
  }
  if (msg.type === "call") {
    try {
      const result = await handle(String(msg.method), msg.params && typeof msg.params === "object" ? msg.params : {});
      send({ type: "result", id: msg.id, ok: true, result });
    } catch (err) {
      send({ type: "result", id: msg.id, ok: false, error: String((err && err.message) || err).slice(0, 400) });
    }
  }
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function tabInfo(t, focusedWindowId) {
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: Boolean(t.active) && (focusedWindowId === undefined || t.windowId === focusedWindowId),
    title: t.title || "",
    url: t.url || t.pendingUrl || "",
  };
}

/** Every tab; "active" marks the one in the window that was used last. */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  let focused;
  try {
    focused = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    focused = undefined;
  }
  const list = tabs.filter((t) => typeof t.id === "number").map((t) => tabInfo(t, focused));
  if (focused !== undefined && !list.some((t) => t.active)) {
    const first = list.find((t) => t.windowId === focused) || list[0];
    if (first) first.active = true;
  }
  return list;
}

function scheduleTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => {
    if (ws && ws.readyState === 1) send({ type: "tabs", tabs: await listTabs() });
  }, TABS_DEBOUNCE_MS);
}

/** The tab a call is about: the given id, else the active tab of the last-used window. */
async function tabFor(params) {
  if (params && typeof params.tabId === "number") return chrome.tabs.get(params.tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const [any] = await chrome.tabs.query({ active: true });
  if (!any) throw new Error("no tab is open");
  return any;
}

const OPENABLE = /^(https?:|chrome:\/\/newtab\/?$|about:blank$)/i;
function checkUrl(url) {
  if (!OPENABLE.test(url)) throw new Error("only web addresses can be opened");
}
function webPage(tab) {
  if (!/^https?:\/\//i.test(tab.url || "")) throw new Error("that tab isn't a web page");
}

// ─── Calls ───────────────────────────────────────────────────────────────────

async function handle(method, params) {
  switch (method) {
    case "tabs.list":
      return { tabs: await listTabs() };
    case "tabs.open": {
      const url = String(params.url || "");
      checkUrl(url);
      if (params.where === "current") {
        const t = await tabFor(params);
        const u = await chrome.tabs.update(t.id, { url, active: true });
        return tabInfo(u);
      }
      const t = await chrome.tabs.create({ url, active: params.active !== false });
      return tabInfo(t);
    }
    case "tabs.close": {
      if (params.others) {
        const keep = Number(params.keep);
        const kept = await chrome.tabs.get(keep);
        const tabs = await chrome.tabs.query({ windowId: kept.windowId });
        const ids = tabs.filter((t) => t.id !== keep && !t.pinned && typeof t.id === "number").map((t) => t.id);
        if (ids.length) await chrome.tabs.remove(ids);
        return { closed: ids };
      }
      const t = await tabFor(params);
      await chrome.tabs.remove(t.id);
      return { closed: [t.id] };
    }
    case "tabs.activate": {
      const t = await chrome.tabs.update(Number(params.tabId), { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      return tabInfo(t);
    }
    case "tabs.navigate": {
      const url = String(params.url || "");
      checkUrl(url);
      const t = await tabFor(params);
      return tabInfo(await chrome.tabs.update(t.id, { url }));
    }
    case "tabs.history": {
      const t = await tabFor(params);
      if (params.action === "back") await chrome.tabs.goBack(t.id);
      else if (params.action === "forward") await chrome.tabs.goForward(t.id);
      else await chrome.tabs.reload(t.id);
      return { ok: true };
    }
    case "tabs.zoom": {
      const t = await tabFor(params);
      let factor = params.reset ? 1 : (await chrome.tabs.getZoom(t.id)) + Number(params.delta || 0);
      factor = Math.min(5, Math.max(0.25, Math.round(factor * 100) / 100));
      await chrome.tabs.setZoom(t.id, factor);
      return { factor };
    }
    case "page.snapshot": {
      const t = await tabFor(params);
      webPage(t);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: pageSnapshot,
        args: [{ maxChars: Number(params.maxChars) || 6000, interactive: params.interactive !== false }],
      });
      return r && r.result;
    }
    case "page.act": {
      const t = await tabFor(params);
      webPage(t);
      const cmd = {
        action: String(params.action || ""),
        ref: params.ref === undefined || params.ref === null ? null : Number(params.ref),
        selector: params.selector ? String(params.selector) : null,
        text: params.text === undefined ? "" : String(params.text),
        direction: params.direction ? String(params.direction) : "down",
        amount: Number(params.amount) || 0,
        key: params.key ? String(params.key) : "Enter",
        submit: Boolean(params.submit),
        clear: params.clear !== false,
      };
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: pageAct, args: [cmd] });
      return r && r.result;
    }
    case "page.inject": {
      const t = await tabFor(params);
      webPage(t);
      const id = String(params.id || `t${Date.now().toString(36)}`);
      const out = {};
      if (params.css) {
        const css = String(params.css);
        await chrome.scripting.insertCSS({ target: { tabId: t.id }, css, origin: "USER" });
        if (!injected.has(t.id)) injected.set(t.id, new Map());
        injected.get(t.id).set(id, { css });
        out.cssId = id;
      }
      if (params.html && typeof params.html === "object") {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: pageInsertHtml,
          args: [{ html: String(params.html.html || ""), position: params.html.position === "bottom" ? "bottom" : "top", selector: params.html.selector ? String(params.html.selector) : null }],
        });
        out.html = Boolean(r && r.result && r.result.ok);
        if (r && r.result && r.result.error) out.htmlError = r.result.error;
      }
      if (params.js) out.js = await runScript(t.id, String(params.js));
      return out;
    }
    case "page.restore": {
      const t = await tabFor(params);
      const map = injected.get(t.id);
      const ids = Array.isArray(params.ids) ? params.ids.map(String) : [];
      let removed = 0;
      if (map) {
        for (const [cid, entry] of [...map]) {
          if (!params.all && !ids.includes(cid)) continue;
          if (entry.css) await chrome.scripting.removeCSS({ target: { tabId: t.id }, css: entry.css, origin: "USER" }).catch(() => {});
          map.delete(cid);
          removed++;
        }
      }
      if (params.all) await chrome.scripting.executeScript({ target: { tabId: t.id }, func: pageRemoveInjected }).catch(() => {});
      return { ok: true, removed };
    }
    case "page.capture": {
      const t = await tabFor(params);
      const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: params.format === "jpeg" ? "jpeg" : "png", quality: 85 });
      return { dataUrl };
    }
    case "files.download": {
      const url = String(params.url || "");
      if (!/^(https?:|data:)/i.test(url)) throw new Error("only web and data URLs can be downloaded");
      const options = { url, conflictAction: "uniquify", saveAs: Boolean(params.saveAs) };
      if (params.filename) options.filename = String(params.filename);
      const id = await chrome.downloads.download(options);
      return { id, filename: options.filename };
    }
    case "files.savePage": {
      const t = await tabFor(params);
      webPage(t);
      const blob = await chrome.pageCapture.saveAsMHTML({ tabId: t.id });
      const dataUrl = await blobToDataUrl(blob);
      const filename = String(params.filename || "page.mhtml");
      const id = await chrome.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify" });
      return { id, filename, bytes: blob.size };
    }
    default:
      throw new Error(`unknown method ${method}`);
  }
}

/** JavaScript in the page: its main world first (the site's CSP applies), then the user-script world when that's on. */
async function runScript(tabId, code) {
  let mainError = "";
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: pageEval, args: [code] });
    const res = r && r.result;
    if (res && res.ok) return { ok: true, via: "main", result: res.result };
    mainError = (res && res.error) || "no result";
    if (!/unsafe-eval|Content Security Policy|EvalError|not an allowed source/i.test(mainError)) return { ok: false, via: "main", error: mainError };
  } catch (err) {
    mainError = String((err && err.message) || err);
  }
  if (hasUserScripts()) {
    try {
      const results = await chrome.userScripts.execute({ target: { tabId }, js: [{ code }], world: "USER_SCRIPT" });
      const r0 = Array.isArray(results) ? results[0] : null;
      if (r0 && r0.error) return { ok: false, via: "userScripts", error: String((r0.error && r0.error.message) || r0.error) };
      return { ok: true, via: "userScripts", result: r0 && r0.result !== undefined ? safeString(r0.result) : "" };
    } catch (err) {
      return { ok: false, via: "userScripts", error: String((err && err.message) || err) };
    }
  }
  return { ok: false, via: "main", error: mainError || "blocked by the site's Content Security Policy" };
}

function safeString(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.slice(0, 2000);
  try {
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return String(v).slice(0, 2000);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error("couldn't read the page capture"));
      fr.readAsDataURL(blob);
    } catch (err) {
      blob
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          resolve(`data:${blob.type || "multipart/related"};base64,${btoa(s)}`);
        })
        .catch(reject);
    }
  });
}

// ─── Functions that run inside pages (serialized by chrome.scripting; no closures) ──

/** What's on the page: its text, headings, the clickable things (each given a data-trinity-ref), pictures, structure. */
function pageSnapshot(opts) {
  const maxChars = (opts && opts.maxChars) || 6000;
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const main = document.querySelector("main, [role=main], article") || document.body;
  let text = clean((main && main.innerText) || document.body.innerText || "");
  if (text.length < 200 && main !== document.body) text = clean(document.body.innerText || "");
  text = text.slice(0, maxChars);
  const outline = [];
  for (const h of document.querySelectorAll("h1, h2, h3")) {
    if (outline.length >= 40) break;
    if (!visible(h)) continue;
    const t = clean(h.innerText);
    if (t) outline.push({ level: Number(h.tagName[1]), text: t.slice(0, 120) });
  }
  const interactive = [];
  if (!opts || opts.interactive !== false) {
    document.querySelectorAll("[data-trinity-ref]").forEach((el) => el.removeAttribute("data-trinity-ref"));
    const sel =
      "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=textbox], [role=combobox], [contenteditable=true], summary";
    let ref = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (interactive.length >= 150) break;
      if (!visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && type === "password") continue; // never listed, never typed into
      const label = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : "";
      const name = clean(
        (tag === "input" || tag === "textarea" || tag === "select" ? el.getAttribute("aria-label") || el.getAttribute("placeholder") || label || el.getAttribute("title") || el.getAttribute("name") : "") ||
          el.innerText ||
          el.value ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("alt") ||
          label ||
          (el.querySelector("img[alt]") ? el.querySelector("img[alt]").getAttribute("alt") : ""),
      ).slice(0, 80);
      if (!name && tag !== "input" && tag !== "textarea" && tag !== "select") continue;
      ref++;
      el.setAttribute("data-trinity-ref", String(ref));
      const item = { ref, tag: el.isContentEditable && tag !== "input" && tag !== "textarea" ? "contenteditable" : tag, name };
      const role = el.getAttribute("role");
      if (role) item.role = role;
      if (type) item.type = type;
      if (tag === "a") item.href = (el.href || el.getAttribute("href") || "").slice(0, 300);
      if (el.disabled) item.disabled = true;
      if (tag === "input" || tag === "textarea") item.value = clean(el.value).slice(0, 60);
      interactive.push(item);
    }
  }
  const images = [];
  for (const img of document.querySelectorAll("img[src], picture img")) {
    if (images.length >= 20) break;
    const r = img.getBoundingClientRect();
    if (r.width < 48 || r.height < 48) continue;
    const src = img.currentSrc || img.src || "";
    if (!/^https?:\/\//i.test(src)) continue;
    images.push({ src: src.slice(0, 500), alt: clean(img.alt || img.title || "").slice(0, 100), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const count = (q) => document.querySelectorAll(q).length;
  const ids = [];
  for (const el of document.querySelectorAll("[id]")) {
    if (ids.length >= 40) break;
    if (/^[A-Za-z][\w-]{1,40}$/.test(el.id) && !ids.includes(el.id)) ids.push(el.id);
  }
  const classCount = new Map();
  let seen = 0;
  for (const el of document.querySelectorAll("[class]")) {
    if (++seen > 3000) break;
    for (const c of el.classList) if (/^[A-Za-z][\w-]{1,40}$/.test(c)) classCount.set(c, (classCount.get(c) || 0) + 1);
  }
  const classes = [...classCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([c, n]) => `${c}(${n})`);
  const landmarks = ["header", "nav", "main", "aside", "footer", "article", "section", "form", "iframe", "video", "img", "table"].map((t) => `${t}:${count(t)}`).join(" ");
  const bodyStyle = getComputedStyle(document.body);
  return {
    title: document.title,
    url: location.href,
    text,
    outline,
    interactive,
    images,
    structure: { landmarks, ids, classes, bg: bodyStyle.backgroundColor, color: bodyStyle.color, fontSize: getComputedStyle(document.documentElement).fontSize },
    selection: clean(String(getSelection ? getSelection() : "")).slice(0, 2000),
    scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
  };
}

/** Click / type / select / scroll / press on the page. Refs come from the last snapshot. */
function pageAct(cmd) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const byRef = (ref) => (ref === null || ref === undefined ? null : document.querySelector(`[data-trinity-ref="${ref}"]`));
  const el = cmd.ref !== null && cmd.ref !== undefined ? byRef(cmd.ref) : cmd.selector ? document.querySelector(cmd.selector) : null;
  const nameOf = (e) => clean(e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.tagName).slice(0, 60);
  const press = (target, key) => {
    const code = key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : key === " " ? 32 : key === "Backspace" ? 8 : 0;
    for (const type of ["keydown", "keypress", "keyup"]) {
      if (type === "keypress" && key.length > 1 && key !== "Enter") continue;
      target.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
  };
  try {
    switch (cmd.action) {
      case "click": {
        if (!el) return { ok: false, error: "no such element" };
        if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password") return { ok: false, error: "password field" };
        el.scrollIntoView({ block: "center", inline: "nearest" });
        if (typeof el.focus === "function") el.focus();
        el.click();
        return { ok: true, detail: `clicked ${nameOf(el)}` };
      }
      case "type": {
        const target = el || document.activeElement;
        if (!target || target === document.body) return { ok: false, error: "no field to type into" };
        if (target.tagName === "INPUT" && (target.getAttribute("type") || "").toLowerCase() === "password") return { ok: false, error: "password field" };
        target.scrollIntoView({ block: "center", inline: "nearest" });
        target.focus();
        if (target.isContentEditable) {
          if (cmd.clear) {
            const range = document.createRange();
            range.selectNodeContents(target);
            const s = getSelection();
            s.removeAllRanges();
            s.addRange(range);
          }
          document.execCommand("insertText", false, cmd.text);
        } else if ("value" in target) {
          const proto = target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          const next = cmd.clear ? cmd.text : (target.value || "") + cmd.text;
          if (desc && desc.set) desc.set.call(target, next);
          else target.value = next;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        } else return { ok: false, error: "that isn't a text field" };
        if (cmd.submit) {
          press(target, "Enter");
          const form = target.form || target.closest("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
        }
        return { ok: true, detail: `typed into ${nameOf(target)}` };
      }
      case "select": {
        if (!el || el.tagName !== "SELECT") return { ok: false, error: "no dropdown there" };
        const want = clean(cmd.text).toLowerCase();
        const opts = [...el.options];
        const opt = opts.find((o) => clean(o.text).toLowerCase() === want) || opts.find((o) => clean(o.text).toLowerCase().includes(want)) || opts.find((o) => o.value.toLowerCase() === want);
        if (!opt) return { ok: false, error: `no option like ${cmd.text}` };
        el.value = opt.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: `picked ${clean(opt.text)}` };
      }
      case "scroll": {
        const amount = cmd.amount || Math.round(innerHeight * 0.85);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        else if (cmd.direction === "top") scrollTo({ top: 0, behavior: "smooth" });
        else if (cmd.direction === "bottom") scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        else scrollBy({ top: cmd.direction === "up" ? -amount : amount, behavior: "smooth" });
        return { ok: true, y: Math.round(scrollY) };
      }
      case "press": {
        const target = el || document.activeElement || document.body;
        press(target, cmd.key || "Enter");
        if (cmd.key === "Enter") {
          const form = target.form || (target.closest && target.closest("form"));
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
        }
        return { ok: true };
      }
      case "focus": {
        if (!el) return { ok: false, error: "no such element" };
        el.focus();
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown action ${cmd.action}` };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}

/** Static markup into the page, marked so it can be removed; scripts and handlers stripped. */
function pageInsertHtml(spec) {
  try {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-trinity", "html");
    wrap.innerHTML = String(spec.html || "");
    wrap.querySelectorAll("script, iframe, object, embed, link, meta, base, form").forEach((n) => n.remove());
    for (const n of wrap.querySelectorAll("*"))
      for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*(javascript|data):/i.test(a.value))) n.removeAttribute(a.name);
    const target = spec.selector ? document.querySelector(spec.selector) : document.body;
    if (!target) return { ok: false, error: "no such element" };
    if (spec.position === "bottom") target.appendChild(wrap);
    else target.insertBefore(wrap, target.firstChild);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}

function pageRemoveInjected() {
  document.querySelectorAll("[data-trinity]").forEach((n) => n.remove());
  document.querySelectorAll("[data-trinity-ref]").forEach((n) => n.removeAttribute("data-trinity-ref"));
  return { ok: true };
}

/** Runs in the page's main world: the site's own rules apply (a strict CSP refuses eval). */
function pageEval(code) {
  try {
    const v = (0, eval)(code);
    let s = "";
    if (v !== undefined && v !== null) {
      if (typeof v === "string") s = v;
      else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = String(v);
        }
      }
    }
    return { ok: true, result: String(s).slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 400) };
  }
}

// ─── Sharing from the page's menu / the popup ─────────────────────────────────

async function share(kind, info, tab) {
  await connect();
  const base = { type: "share", title: (tab && tab.title) || "", url: (tab && tab.url) || (info && info.pageUrl) || "" };
  let msg;
  if (kind === "share-selection") msg = { ...base, kind: "selection", text: String((info && info.selectionText) || "") };
  else if (kind === "share-link") msg = { ...base, kind: "link", title: String((info && (info.linkText || info.linkUrl)) || ""), url: String((info && info.linkUrl) || "") };
  else if (kind === "share-image") msg = { ...base, kind: "image", src: String((info && info.srcUrl) || "") };
  else {
    let text = "";
    try {
      if (tab && /^https?:\/\//i.test(tab.url || "")) {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSnapshot, args: [{ maxChars: 2500, interactive: false }] });
        text = (r && r.result && r.result.text) || "";
      }
    } catch {
      /* a page we can't read: the title and link still go */
    }
    msg = { ...base, kind: "page", text };
  }
  const sent = send(msg);
  if (!sent) {
    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    setTimeout(() => setStatus(status.state, status.detail), 2500);
  }
  return sent;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "share-page", title: "Put this page on Trinity's board", contexts: ["page"] });
    chrome.contextMenus.create({ id: "share-selection", title: "Put the selection on Trinity's board", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "share-link", title: "Put this link on Trinity's board", contexts: ["link"] });
    chrome.contextMenus.create({ id: "share-image", title: "Put this image on Trinity's board", contexts: ["image"] });
  });
  chrome.alarms.create("trinity-keepalive", { periodInMinutes: 0.5 });
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("trinity-keepalive", { periodInMinutes: 0.5 });
  void connect();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "trinity-keepalive") void connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.engine || changes.token)) return;
  if (ws) {
    try {
      ws.close(1000, "settings changed");
    } catch {
      /* ignore */
    }
    ws = null;
  }
  backoff = RECONNECT_MIN_MS;
  void connect();
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void share(String(info.menuItemId), info, tab);
});
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.windows.onFocusChanged])
  ev.addListener(() => scheduleTabs());
chrome.tabs.onRemoved.addListener((tabId) => injected.delete(tabId));
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "status") {
    settings().then((s) => reply({ status, engine: s.engine, tokenSet: Boolean(s.token), paused: s.paused, userScripts: hasUserScripts(), version: VERSION }));
    return true;
  }
  if (msg.type === "disconnect") {
    (async () => {
      pausedByUser = true;
      await chrome.storage.local.set({ paused: true });
      clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close(1000, "disconnect");
        } catch {
          /* ignore */
        }
        ws = null;
      }
      setStatus("paused", PAUSED_DETAIL);
      reply({ status });
    })();
    return true;
  }
  if (msg.type === "connect") {
    (async () => {
      pausedByUser = false;
      await chrome.storage.local.set({ paused: false });
      if (ws) {
        try {
          ws.close(1000, "reconnect");
        } catch {
          /* ignore */
        }
        ws = null;
      }
      backoff = RECONNECT_MIN_MS;
      await connect();
      await new Promise((r) => setTimeout(r, 900));
      reply({ status });
    })();
    return true;
  }
  if (msg.type === "share") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const sent = tab ? await share("share-page", { pageUrl: tab.url }, tab) : false;
      reply({ ok: sent });
    })();
    return true;
  }
  return false;
});

void connect();
