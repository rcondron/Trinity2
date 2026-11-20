// Trinity Browser Bridge — the service worker. One WebSocket to the Trinity engine on this computer
// (ws://127.0.0.1:8799/ext). The engine's calls run here through Chrome's extension APIs, tab changes are
// reported back, and a page, selection, link or image you put on her board from the page's menu goes to
// Trinity's workspace. Everything is local; nothing leaves the machine.
//
// Who is on the other end is proved, not assumed (proto.js): the extension is paired once, with a code from
// Trinity's Settings → Browser; after that every connection is a mutual proof of the shared key, and not one
// call is run for a peer that hasn't made it. Nothing secret is ever put in the socket's address.
//
// What the engine may ask for (services/browser-bridge.ts and tools/browser*.ts in the engine use these):
//   tabs.list / open / close / activate / navigate / history / zoom
//   tabs.move / duplicate / pin / mute / group / ungroup / reopen            windows.create / close / update
//   page.snapshot (text, headings, what can be clicked or typed into, pictures, structure — never a field's value)
//   page.act (click / type / select / scroll / press / focus / submitter)    page.wait (load / password / otp)
//   page.inject (css / html / js)   page.restore   page.capture   page.total
//   page.fillProbe / page.fill (logins, cards and details from Trinity's vault, sealed for this tab and origin)
//   files.download   files.savePage
//
// Rules kept here, whatever the engine asks: Trinity's own tabs are never read, changed, navigated or closed; a
// control whose name says buy / pay / send / delete … is pressed only with that exact name approved; password,
// one-time-code and card fields are never listed, read or typed into (page.js); a fill happens only in the top
// document of an https tab whose origin is the one the fill was sealed for; a tab that holds a filled login
// or card runs no injected script and gives no screenshot until it has left that site; and a document Trinity
// ran a script in is never filled (a reload gives the tab a new one).

import { HANDSHAKE_MS, Link, generateKeys } from "./proto.js";
import { pageEval, pageMain } from "./page.js";
import { forgetEngine, loadKeys, pinEngine, pinnedEngine } from "./store.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_ENGINE = "ws://127.0.0.1:8799";
const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const TABS_DEBOUNCE_MS = 250;

/** The socket in use and its link: {sock, link, pairing, timer, reason, wasLive, settle, done}. Only ever one. */
let conn = null;
/** The queue socket set-ups wait in, so two wake-ups can't open two sockets. */
let connecting = null;
let status = { state: "off", detail: "Not connected yet.", since: 0 };
let reconnectTimer = null;
let backoff = RECONNECT_MIN_MS;
let tabsTimer = null;
/** Trinity's own origins, as the proved engine names them in `welcome`: her pages are never touched. */
let own = [];
/** tabId → {id → css}: what Trinity injected, so it can be undone (kept in session storage: the worker comes and goes). */
let injected = {};
/** tabId → origin: tabs holding something Trinity filled in. */
let filled = {};
/** document id → tabId: the documents themselves (one brought back from the tab's history still holds what went in). */
let filledDocs = {};
/**
 * Documents Trinity ran a script in, or gave a style sheet that can call out: document id → tabId ("tab:<id>" when the
 * document couldn't be told). Nothing from the vault is filled into one of these: what was put there could read it.
 * A reload gives the tab a new document.
 */
let scripted = {};
/** Another copy of this extension took the link (4409): no reconnecting on our own until Connect is pressed. */
let steppedBack = false;
/** The call ids of fills already opened (each envelope is used once; they expire after ten seconds anyway). */
const usedFills = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = chrome.storage.session
  .get(["injected", "filled", "filledDocs", "scripted", "steppedBack"])
  .then((s) => {
    if (s.injected && typeof s.injected === "object") injected = s.injected;
    if (s.filled && typeof s.filled === "object") filled = s.filled;
    if (s.filledDocs && typeof s.filledDocs === "object") filledDocs = s.filledDocs;
    if (s.scripted && typeof s.scripted === "object") scripted = s.scripted;
    steppedBack = s.steppedBack === true;
  })
  .catch(() => {});
const saveSession = () => chrome.storage.session.set({ injected, filled, filledDocs, scripted, steppedBack }).catch(() => {});

// ─── Settings & status ───────────────────────────────────────────────────────

const DETAIL = {
  unpaired: "Not paired — type the code from Trinity's Settings → Browser.",
  paused: "Disconnected — press Connect to let Trinity use this browser again.",
  repair: "Trinity doesn't know this browser any more — pair again with a new code from Settings → Browser.",
  replaced: "Another copy of this extension took over the link. Press Connect to take it back.",
  unproven: "Whatever answered on Trinity's port couldn't prove it is your Trinity, so nothing was sent to it.",
  off: "Not connected — is Trinity running? (If Trinity was reset, pair again.)",
};

async function settings() {
  const { engine, paused, repair } = await chrome.storage.local.get(["engine", "paused", "repair"]);
  const base = String(engine || DEFAULT_ENGINE)
    .trim()
    .replace(/\/+$/, "")
    .replace(/^http(s?):\/\//, "ws$1://");
  return { engine: /^wss?:\/\//.test(base) ? base : `ws://${base}`, paused: Boolean(paused), repair: Boolean(repair) };
}

function setStatus(state, detail) {
  status = { state, detail: detail || "", since: Date.now() };
  const text = state === "connected" ? "" : state === "connecting" || state === "pairing" ? "…" : state === "error" || state === "repair" ? "!" : "off";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === "error" || state === "repair" ? "#dc2626" : "#6b7280" }).catch(() => {});
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

function scheduleReconnect(min = 0) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), Math.max(min, backoff));
  backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
}

function dropSocket(why) {
  const c = conn;
  conn = null;
  if (!c) return;
  clearTimeout(c.timer);
  c.link.close("closed");
  try {
    c.sock.close(1000, why);
  } catch {
    /* already closed */
  }
}

/**
 * Connect (or pair, when a code is given). Resolves with "live", or with why nothing is connected.
 * Single-flight: the short set-up of a socket runs one at a time (`connecting` is that queue), and while a socket is
 * up or coming up another connect simply waits for the same socket — so a worker woken twice opens one, not two.
 */
function connect(opts = {}) {
  const attempt = (connecting || Promise.resolve()).then(() => open(opts));
  connecting = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt.then(
    (r) => r.outcome,
    () => "error",
  );
}

/** Set a socket up (or decide not to). Returns {outcome: a promise of how it ended} as soon as the socket exists. */
async function open(opts) {
  const stay = (state, detail) => {
    setStatus(state, detail);
    return { outcome: Promise.resolve(state) };
  };
  await ready;
  const cfg = await settings();
  const pinned = await pinnedEngine();
  if (opts.code) dropSocket("pairing");
  else {
    if (cfg.paused) return stay("paused", DETAIL.paused);
    if (!pinned) return stay("unpaired", DETAIL.unpaired);
    if (cfg.repair) return stay("repair", DETAIL.repair);
    if (steppedBack && !opts.manual) return stay("replaced", DETAIL.replaced);
    if (conn && conn.sock.readyState <= 1) return { outcome: conn.link.live ? Promise.resolve("live") : conn.done };
  }
  let keys;
  try {
    keys = await loadKeys(generateKeys);
  } catch (err) {
    return stay("error", `This browser couldn't keep its pairing key: ${String((err && err.message) || err)}`);
  }
  setStatus(opts.code ? "pairing" : "connecting", opts.code ? "Pairing with Trinity…" : `Connecting to ${cfg.engine}…`);
  let sock;
  try {
    sock = new WebSocket(`${cfg.engine}/ext`); // nothing but the path: no token, no key, no code
  } catch (err) {
    return stay("error", `Bad engine address: ${String((err && err.message) || err)}`);
  }
  const c = { sock, link: null, pairing: Boolean(opts.code), opened: false, timer: null, reason: "", wasLive: false, settle: null, done: null };
  c.done = new Promise((resolve) => (c.settle = resolve));
  conn = c;
  c.link = new Link({
    id: chrome.runtime.id,
    keys,
    enginePub: pinned ? pinned.pub : null,
    send: (msg) => {
      if (sock.readyState === 1) sock.send(JSON.stringify(msg));
    },
    pin: async (pub) => {
      await pinEngine(pub);
      await chrome.storage.local.set({ repair: false, paused: false });
    },
    describe: async () => ({ version: VERSION, chrome: chromeVersion(), caps: { userScripts: hasUserScripts(), pageCapture: Boolean(chrome.pageCapture), fill: true }, tabs: await listTabs() }),
    onCall: (call, link) => handle(call, link),
    onLive: (welcome) => {
      c.wasLive = true;
      clearTimeout(c.timer);
      own = Array.isArray(welcome.own) ? welcome.own.filter((o) => typeof o === "string").slice(0, 20) : [];
      backoff = RECONNECT_MIN_MS;
      steppedBack = false;
      void saveSession();
      setStatus("connected", "Connected to Trinity.");
      c.settle("live");
    },
    onDead: (reason) => {
      if (reason === "closed") return;
      c.reason = reason;
      try {
        sock.close(1000, "refused");
      } catch {
        /* already closed */
      }
    },
  });
  c.timer = setTimeout(() => {
    if (c.link.live) return;
    c.reason = c.reason || "timeout";
    try {
      sock.close(1000, "timed out");
    } catch {
      /* already closed */
    }
  }, HANDSHAKE_MS);
  sock.onopen = () => {
    c.opened = true;
    void (opts.code ? c.link.pair(opts.code) : c.link.hello());
  };
  sock.onmessage = (ev) => {
    if (conn !== c) return; // a socket that was replaced or dropped says nothing that counts
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    void c.link.receive(msg);
  };
  sock.onclose = (ev) => void closed(c, ev.code);
  sock.onerror = () => {
    /* onclose follows with the reason */
  };
  return { outcome: c.done };
}

const NO_CODE = "Trinity is running, but no pairing code is waiting — it ran out, was used, or had too many wrong tries. Get a fresh one in Trinity's Settings → Browser.";

/** Does anything answer at the engine's address (its /healthz page, which needs no key)? Says nothing about who it is. */
async function engineAnswers(engine) {
  try {
    const res = await fetch(`${engine.replace(/^ws(s?):\/\//i, "http$1://")}/healthz`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(2500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function closed(c, code) {
  clearTimeout(c.timer);
  c.link.close("closed");
  const mine = conn === c;
  if (mine) conn = null;
  let outcome = "closed";
  if (mine) {
    const cfg = await settings();
    const pinned = await pinnedEngine();
    const unproven = c.reason === "engine-unproven" || c.reason === "protocol";
    if (c.pairing && !c.wasLive) {
      // A pairing that didn't happen: say why, and leave whatever pairing there was as it was. A socket that never opened
      // was either turned away before a word was said — the engine takes a browser it doesn't know only while a code is
      // waiting — or found nothing listening; whether the engine's own page answers tells the two apart.
      outcome =
        code === 4401 ? "wrong-code" : c.reason === "pair-refused" || unproven ? "unproven" : !c.opened && (await engineAnswers(cfg.engine)) ? "no-code" : "unreachable";
      const why =
        outcome === "wrong-code"
          ? "That code didn't match, or it has run out. Get a fresh one in Trinity's Settings → Browser."
          : outcome === "unproven"
            ? "Whatever answered couldn't prove it knows the code, so this browser didn't pair with it."
            : outcome === "no-code"
              ? NO_CODE
              : "Couldn't reach Trinity to pair — is it running?";
      if (!pinned) setStatus("unpaired", why);
      else if (cfg.repair) setStatus("repair", why);
      else {
        setStatus("error", why);
        // The engine answered (the code was wrong or spent): the pairing in place comes straight back, however many
        // codes were mistyped. The growing wait is for an engine that isn't there.
        if (outcome === "wrong-code" || outcome === "no-code") backoff = RECONNECT_MIN_MS;
        scheduleReconnect(2000);
      }
    } else if (cfg.paused) {
      setStatus("paused", DETAIL.paused);
      outcome = "paused";
    } else if (code === 4401 || c.reason === "unpaired") {
      // The engine doesn't know this key (it was reset, or paired with another browser). Retrying won't change that.
      await chrome.storage.local.set({ repair: true });
      setStatus("repair", DETAIL.repair);
      outcome = "repair";
    } else if (code === 4409) {
      // Another copy of this extension proved the same key and took the link: step back instead of fighting it.
      steppedBack = true;
      await saveSession();
      setStatus("replaced", DETAIL.replaced);
      outcome = "replaced";
    } else if (unproven) {
      setStatus("error", DETAIL.unproven);
      outcome = "unproven";
      scheduleReconnect(10_000);
    } else {
      setStatus("off", DETAIL.off);
      outcome = "unreachable";
      scheduleReconnect();
    }
  }
  c.settle(outcome);
}

function sendLive(msg) {
  return Boolean(conn && conn.link.send(msg));
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function tabInfo(t, focusedWindowId) {
  const info = {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: Boolean(t.active) && (focusedWindowId === undefined || t.windowId === focusedWindowId),
    title: t.title || "",
    url: t.url || t.pendingUrl || "",
  };
  if (t.pinned) info.pinned = true;
  if (t.mutedInfo && t.mutedInfo.muted) info.muted = true;
  if (t.audible) info.audible = true;
  if (typeof t.groupId === "number" && t.groupId >= 0) info.groupId = t.groupId;
  if (typeof t.lastAccessed === "number") info.lastAccessed = Math.round(t.lastAccessed);
  return info;
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
    if (conn && conn.link.live) sendLive({ type: "tabs", tabs: await listTabs() });
  }, TABS_DEBOUNCE_MS);
}

function originOf(url) {
  try {
    const u = new URL(url || "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}
const isOwn = (tab) => {
  const o = originOf(tab.url || tab.pendingUrl);
  return o !== null && own.includes(o);
};
const isFilled = (tab) => typeof filled[tab.id] === "string" && filled[tab.id] === originOf(tab.url);
const HOLDS_FILL = "that tab holds a login or card Trinity filled in — no scripts, screenshots or saved copies there until it leaves that site";

/** The tab a call is about: the given id, else the active tab of the last-used window. Never one of Trinity's own. */
async function tabFor(params, allowOwn = false) {
  let tab;
  if (params && typeof params.tabId === "number") tab = await chrome.tabs.get(params.tabId);
  else {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true });
  }
  if (!tab) throw new Error("no tab is open");
  if (!allowOwn && isOwn(tab)) throw new Error("that is Trinity's own tab, which is left alone");
  return tab;
}

const OPENABLE = /^(https?:|chrome:\/\/newtab\/?$|about:blank$)/i;
function checkUrl(url) {
  if (!OPENABLE.test(url)) throw new Error("only web addresses can be opened");
}
function webPage(tab) {
  if (!/^https?:\/\//i.test(tab.url || "")) throw new Error("that tab isn't a web page");
}

/**
 * Back or forward one page. Chrome's own back and forward (and chrome.tabs.goBack / goForward with them) skip a page
 * that was left without a click or a key in it — and every page Trinity navigates away from by voice is left that way,
 * so "go to …, go back" would find nothing to go back to. The page's own history still steps there: that is the way
 * taken when Chrome's is refused. Nothing to step to at all → Chrome's refusal, as it was.
 */
async function stepHistory(t, step) {
  try {
    await (step < 0 ? chrome.tabs.goBack(t.id) : chrome.tabs.goForward(t.id));
    return;
  } catch (err) {
    if (!/^https?:\/\//i.test(t.url || "")) throw err;
    const before = t.url;
    const [r] = await chrome.scripting
      .executeScript({
        target: { tabId: t.id, frameIds: [0] },
        world: "ISOLATED",
        func: (n) => {
          window.history.go(n);
          return true;
        },
        args: [step],
      })
      .catch(() => [null]);
    if (!r || r.result !== true) throw err;
    for (let i = 0; i < 10; i++) {
      await sleep(150);
      const now = await chrome.tabs.get(t.id).catch(() => null);
      if (!now || now.url !== before || now.status === "loading") return;
    }
    throw err;
  }
}

/** The page-side code, in the page's isolated world, in one frame (the top one unless told otherwise). */
async function inPage(tabId, cmd, frameId = 0) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "ISOLATED", func: pageMain, args: [cmd] });
  return r ? r.result : undefined;
}

const DOCS_MAX = 300;
/** Note a document (or, as "tab:<id>", a whole tab) in one of the registries above; the oldest documents drop out past DOCS_MAX. */
function noteDoc(map, key, tabId) {
  map[key] = tabId;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - DOCS_MAX))) if (!k.startsWith("tab:")) delete map[k];
}
/** Forget a closed tab's documents, or hand them to the tab that replaced it. True when anything changed. */
function moveDocs(map, from, to) {
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k] !== from) continue;
    delete map[k];
    if (to !== null) map[k === `tab:${from}` ? `tab:${to}` : k] = to;
    changed = true;
  }
  return changed;
}

/** The id of the document in a tab's top frame; null when Chrome won't say. */
async function topDocument(tabId) {
  try {
    const f = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return f && typeof f.documentId === "string" && f.documentId ? f.documentId : null;
  } catch {
    return null;
  }
}

async function markFilled(tabId, origin, documentId) {
  filled[tabId] = origin;
  if (typeof documentId === "string" && documentId) noteDoc(filledDocs, documentId, tabId);
  await saveSession();
}
/**
 * Does this tab hold something Trinity filled in? Yes while it stays on the site it was filled on — and yes when the
 * document in it is one that was filled, however the tab came back to it (a page out of the history keeps its fields).
 */
async function holdsFill(tab) {
  if (isFilled(tab)) return true;
  if (!Object.keys(filledDocs).length) return false;
  const doc = await topDocument(tab.id);
  return doc !== null && Object.hasOwn(filledDocs, doc);
}

/** The document now in this tab has (or is about to have) something of Trinity's in it that could read the page. */
async function markScripted(tabId) {
  const doc = await topDocument(tabId);
  // A document that can't be told apart counts for the whole tab, for as long as the tab lives.
  noteDoc(scripted, doc === null ? `tab:${tabId}` : doc, tabId);
  await saveSession();
}
const isScripted = (tabId, documentId) => Object.hasOwn(scripted, `tab:${tabId}`) || (typeof documentId === "string" && Object.hasOwn(scripted, documentId));
/** A style sheet that can fetch something (a picture, another sheet) can carry what it matches away. */
const CALLS_OUT = /url\s*\(|@import/i;

// ─── Calls ───────────────────────────────────────────────────────────────────

async function handle(call, link) {
  await ready;
  const { method, params } = call;
  switch (method) {
    case "tabs.list":
      return { tabs: await listTabs() };
    case "tabs.open": {
      const url = String(params.url || "");
      checkUrl(url);
      if (params.where === "current") {
        const t = await tabFor(params);
        return tabInfo(await chrome.tabs.update(t.id, { url, active: true }));
      }
      const options = { url, active: params.active !== false };
      if (typeof params.windowId === "number") options.windowId = params.windowId;
      return tabInfo(await chrome.tabs.create(options));
    }
    case "tabs.close": {
      if (params.others) {
        const kept = await chrome.tabs.get(Number(params.keep));
        const spare = Array.isArray(params.spare) ? params.spare.map(Number) : [];
        const tabs = await chrome.tabs.query({ windowId: kept.windowId });
        const ids = tabs.filter((t) => t.id !== kept.id && !t.pinned && typeof t.id === "number" && !isOwn(t) && !spare.includes(t.id)).map((t) => t.id);
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
      if (params.action === "back" || params.action === "forward") await stepHistory(t, params.action === "back" ? -1 : 1);
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
    case "tabs.move": {
      const t = await tabFor(params, true);
      const to = String(params.to || "");
      if (to === "new-window") {
        if (isOwn(t)) throw new Error("that is Trinity's own tab, which is left alone");
        const w = await chrome.windows.create({ tabId: t.id, focused: true });
        return { ok: true, windowId: w.id };
      }
      const index = typeof params.index === "number" ? params.index : to === "start" ? 0 : to === "end" ? -1 : to === "left" ? Math.max(0, t.index - 1) : t.index + 1;
      const moved = await chrome.tabs.move(t.id, { index });
      return { ok: true, index: moved.index, moved: moved.index !== t.index };
    }
    case "tabs.duplicate": {
      const t = await tabFor(params);
      return tabInfo(await chrome.tabs.duplicate(t.id));
    }
    case "tabs.pin": {
      const t = await tabFor(params, true);
      return tabInfo(await chrome.tabs.update(t.id, { pinned: params.pinned !== false }));
    }
    case "tabs.mute": {
      const t = await tabFor(params, true);
      return tabInfo(await chrome.tabs.update(t.id, { muted: params.muted !== false }));
    }
    case "tabs.group": {
      const ids = (Array.isArray(params.tabIds) ? params.tabIds : []).map(Number).filter((n) => Number.isFinite(n));
      if (!ids.length) throw new Error("no tabs to group");
      const groupId = await chrome.tabs.group({ tabIds: ids });
      const title = String(params.title || "").slice(0, 40);
      if (title && chrome.tabGroups) await chrome.tabGroups.update(groupId, { title }).catch(() => {});
      return { ok: true, groupId, count: ids.length };
    }
    case "tabs.ungroup": {
      const ids = (Array.isArray(params.tabIds) ? params.tabIds : []).map(Number).filter((n) => Number.isFinite(n));
      if (!ids.length) throw new Error("no tabs to ungroup");
      await chrome.tabs.ungroup(ids);
      return { ok: true, count: ids.length };
    }
    case "tabs.reopen": {
      const s = await chrome.sessions.restore();
      const t = s && (s.tab || (s.window && s.window.tabs && s.window.tabs[0]));
      return t ? { ok: true, tab: tabInfo(t), window: Boolean(s.window) } : { ok: false };
    }
    case "windows.create": {
      const options = { focused: true };
      if (params.url) {
        checkUrl(String(params.url));
        options.url = String(params.url);
      }
      const w = await chrome.windows.create(options);
      return { ok: true, windowId: w.id, tabId: w.tabs && w.tabs[0] ? w.tabs[0].id : undefined };
    }
    case "windows.close": {
      const windowId = typeof params.windowId === "number" ? params.windowId : (await tabFor(params, true)).windowId;
      const tabs = await chrome.tabs.query({ windowId });
      if (tabs.some(isOwn)) throw new Error("that window holds Trinity's own tab, so it stays open");
      await chrome.windows.remove(windowId);
      return { ok: true, closed: tabs.length };
    }
    case "windows.update": {
      const windowId = typeof params.windowId === "number" ? params.windowId : (await tabFor(params, true)).windowId;
      const state = ["minimized", "maximized", "normal", "fullscreen"].includes(String(params.state)) ? String(params.state) : null;
      if (state === "minimized" && (await chrome.tabs.query({ windowId })).some(isOwn)) throw new Error("that window holds Trinity's own tab, so it stays up");
      const w = await chrome.windows.update(windowId, state ? { state } : { focused: true });
      return { ok: true, state: w.state };
    }
    case "page.wait": {
      const t = await tabFor(params);
      const want = String(params.for || "load");
      const deadline = Date.now() + Math.min(20_000, Math.max(300, Number(params.timeoutMs) || 8000));
      await sleep(Math.min(1000, Math.max(0, Number(params.settleMs) || 250))); // a navigation just asked for needs a moment to begin
      let loaded = false;
      let found = false;
      let origin = "";
      for (;;) {
        let tab;
        try {
          tab = await chrome.tabs.get(t.id);
        } catch {
          throw new Error("that tab is gone");
        }
        loaded = tab.status === "complete";
        origin = originOf(tab.url) || "";
        if (loaded && want === "load") break;
        if (loaded && /^https?:\/\//i.test(tab.url || "")) {
          const p = await inPage(t.id, { op: "probe" }).catch(() => null);
          if (p && Array.isArray(p.kinds) && p.kinds.includes(want)) {
            found = true;
            break;
          }
        }
        if (Date.now() >= deadline) break;
        await sleep(200);
      }
      return { ok: true, loaded, found: want === "load" ? loaded : found, origin };
    }
    case "page.snapshot": {
      const t = await tabFor(params);
      webPage(t);
      const cmd = { op: "snapshot", maxChars: Number(params.maxChars) || 6000, interactive: params.interactive !== false };
      const frames = cmd.interactive && params.frames !== false;
      let results;
      try {
        results = await chrome.scripting.executeScript({ target: frames ? { tabId: t.id, allFrames: true } : { tabId: t.id, frameIds: [0] }, world: "ISOLATED", func: pageMain, args: [cmd] });
      } catch (err) {
        if (!frames) throw err;
        results = await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, world: "ISOLATED", func: pageMain, args: [cmd] });
      }
      const top = results.find((r) => r.frameId === 0) || results[0];
      const snap = top && top.result;
      if (!snap || typeof snap !== "object") throw new Error("that page couldn't be read");
      // Frames add what can be pressed in them: refs k*1000+n, each carrying its frame's id.
      let k = 0;
      for (const r of results) {
        if (r === top || !r.result || !Array.isArray(r.result.interactive) || !r.result.interactive.length) continue;
        if (++k > 8) break;
        for (const item of r.result.interactive) snap.interactive.push(Object.assign({}, item, { ref: k * 1000 + item.ref, frame: r.frameId }));
      }
      return snap;
    }
    case "page.act": {
      const t = await tabFor(params);
      webPage(t);
      const frameId = Number(params.frameId) || 0;
      const hasRef = params.ref !== undefined && params.ref !== null;
      const cmd = {
        op: "act",
        action: String(params.action || ""),
        ref: hasRef ? (frameId ? Number(params.ref) % 1000 : Number(params.ref)) : null,
        selector: params.selector ? String(params.selector) : null,
        text: params.text === undefined ? "" : String(params.text),
        direction: params.direction ? String(params.direction) : "down",
        amount: Number(params.amount) || 0,
        key: params.key ? String(params.key) : "Enter",
        shift: params.shift === true,
        submit: Boolean(params.submit),
        clear: params.clear !== false,
      };
      if (typeof params.approved === "string") cmd.approved = params.approved;
      const res = await inPage(t.id, cmd, frameId);
      // A link that wants a new tab: the extension opens it (a page can't, without a real click).
      if (res && res.ok && typeof res.open === "string" && /^https?:\/\//i.test(res.open)) {
        const made = await chrome.tabs.create({ url: res.open, active: true, openerTabId: t.id, index: t.index + 1 });
        return { ok: true, name: res.name, detail: res.detail, opened: made.id };
      }
      return res;
    }
    case "page.total": {
      const t = await tabFor(params);
      webPage(t);
      return inPage(t.id, { op: "total" });
    }
    case "page.inject": {
      const t = await tabFor(params);
      webPage(t);
      const held = await holdsFill(t);
      if (held && params.js) throw new Error(HOLDS_FILL);
      const id = String(params.id || `t${Date.now().toString(36)}`);
      const out = {};
      // On a tab that holds a filled login, a stylesheet that can call out (url(), @import) could carry it away.
      const callsOut = Boolean(params.css) && CALLS_OUT.test(String(params.css));
      if (held && callsOut) throw new Error(HOLDS_FILL);
      // The other way round: a document that takes a script, or such a style sheet, is never filled afterwards. Noted
      // before anything goes in, and again after (the tab may have moved to another document in between).
      const reads = Boolean(params.js) || callsOut;
      if (reads) await markScripted(t.id);
      try {
        if (params.css) {
          const css = String(params.css);
          const mine = injected[t.id] || (injected[t.id] = {});
          // The same id again replaces the sheet: the old one comes out first, so undo never leaves it behind.
          if (typeof mine[id] === "string") await chrome.scripting.removeCSS({ target: { tabId: t.id }, css: mine[id], origin: "USER" }).catch(() => {});
          await chrome.scripting.insertCSS({ target: { tabId: t.id }, css, origin: "USER" });
          mine[id] = css;
          await saveSession();
          out.cssId = id;
        }
        if (params.html && typeof params.html === "object") {
          const r = await inPage(t.id, { op: "insertHtml", html: String(params.html.html || ""), position: params.html.position === "bottom" ? "bottom" : "top", selector: params.html.selector ? String(params.html.selector) : null });
          out.html = Boolean(r && r.ok);
          if (r && r.error) out.htmlError = r.error;
        }
        if (params.js) out.js = await runScript(t.id, String(params.js));
      } finally {
        if (reads) await markScripted(t.id);
      }
      return out;
    }
    case "page.restore": {
      const t = await tabFor(params);
      const mine = injected[t.id] || {};
      const ids = Array.isArray(params.ids) ? params.ids.map(String) : [];
      let removed = 0;
      for (const cid of Object.keys(mine)) {
        if (!params.all && !ids.includes(cid)) continue;
        await chrome.scripting.removeCSS({ target: { tabId: t.id }, css: mine[cid], origin: "USER" }).catch(() => {});
        delete mine[cid];
        removed++;
      }
      if (!Object.keys(mine).length) delete injected[t.id];
      await saveSession();
      if (params.all && /^https?:\/\//i.test(t.url || "")) {
        const r = await inPage(t.id, { op: "removeInjected" }).catch(() => null);
        if (r && typeof r.removed === "number") removed += r.removed;
      }
      return { ok: true, removed };
    }
    case "page.capture": {
      const t = await tabFor(params);
      if (await holdsFill(t)) throw new Error(HOLDS_FILL);
      // Chrome can only photograph the tab in front of its window: a background tab is brought forward for the shot.
      let front = null;
      if (!t.active) {
        const [was] = await chrome.tabs.query({ active: true, windowId: t.windowId });
        await chrome.tabs.update(t.id, { active: true });
        front = was && was.id !== t.id ? was.id : null;
        await sleep(350);
      }
      try {
        const now = await chrome.tabs.get(t.id);
        if (!now.active) throw new Error("that tab couldn't be brought to the front for a screenshot");
        const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: params.format === "jpeg" ? "jpeg" : "png", quality: 85 });
        return { dataUrl };
      } finally {
        if (front !== null) await chrome.tabs.update(front, { active: true }).catch(() => {});
      }
    }
    case "page.fillProbe": {
      const t = await tabFor(params);
      if (!/^https:\/\//i.test(t.url || "")) return { ok: false, code: "insecure" };
      let r;
      try {
        [r] = await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, world: "ISOLATED", func: pageMain, args: [{ op: "probe" }] });
      } catch {
        return { ok: false, code: "gone" };
      }
      const p = r && r.result;
      if (!p || p.ok !== true || typeof r.documentId !== "string" || p.origin !== originOf(t.url)) return { ok: false, code: "gone" };
      if (isScripted(t.id, r.documentId)) return { ok: false, code: "scripted" };
      return { ok: true, documentId: r.documentId, origin: p.origin, kinds: p.kinds, submitRef: p.submitRef, submitName: p.submitName, formAction: p.formAction, formLeaves: p.formLeaves, frames: p.frames, signup: p.signup };
    }
    case "page.fill":
      return fill(call, link);
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
      if (await holdsFill(t)) throw new Error(HOLDS_FILL);
      const blob = await chrome.pageCapture.saveAsMHTML({ tabId: t.id });
      const dataUrl = await blobToDataUrl(blob);
      const filename = String(params.filename || "page.mhtml");
      const id = await chrome.downloads.download({ url: dataUrl, filename, conflictAction: "uniquify" });
      return { id, filename, bytes: blob.size };
    }
    default:
      throw new Error(`unknown method ${String(method).slice(0, 40)}`);
  }
}

/**
 * A sealed fill. Checked here — not by the engine, not by a model — before one character is typed: the origin asked
 * for is an https origin; the tab is not Trinity's own; the tab's own address is https and has exactly that origin;
 * the envelope opens with this connection's key for exactly this call, origin and tab, and is not older than ten
 * seconds; the document is still the one that was probed, and is not one Trinity ran a script in. Inside the page
 * (page.js): top document only, the same origin again, a secure context, visible enabled fields only, never a form
 * that posts elsewhere.
 * What goes back is which KINDS of field were filled. On any failure, a fixed code — never a value, never a reason.
 */
async function fill(call, link) {
  const p = call.params;
  const tabId = Number(p.tabId);
  const origin = String(p.origin || "");
  const documentId = String(p.documentId || "");
  let want;
  try {
    want = new URL(origin);
  } catch {
    return { ok: false, code: "origin-mismatch" };
  }
  if (want.origin !== origin) return { ok: false, code: "origin-mismatch" };
  if (want.protocol !== "https:") return { ok: false, code: "insecure" };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, code: "gone" };
  }
  if (isOwn(tab)) return { ok: false, code: "origin-mismatch" };
  let at;
  try {
    at = new URL(tab.url || "");
  } catch {
    return { ok: false, code: "gone" };
  }
  if (at.protocol !== "https:") return { ok: false, code: "insecure" };
  if (at.origin !== origin) return { ok: false, code: "origin-mismatch" };
  if (!documentId) return { ok: false, code: "gone" };
  // A document Trinity ran a script in (or gave a style sheet that calls out) is not filled: reload it first.
  if (isScripted(tabId, documentId)) return { ok: false, code: "scripted" };
  // An envelope is for one fill: the same call arriving a second time is refused, whatever it holds.
  if (usedFills.has(call.id)) return { ok: false, code: "expired" };
  let values;
  try {
    values = await link.openFill(call.id, origin, tabId, p.sealed);
  } catch (err) {
    return { ok: false, code: err && err.code === "expired" ? "expired" : "failed" };
  }
  if (usedFills.size > 400) usedFills.clear();
  usedFills.add(call.id);
  let res;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: "ISOLATED", func: pageMain, args: [{ op: "fill", origin, values }] });
    res = r && r.result;
  } catch {
    return { ok: false, code: "gone" }; // the document that was probed is no longer the one in the tab: nothing ran
  } finally {
    values = null;
  }
  const answered = Boolean(res) && typeof res === "object";
  // The page code ran. Unless it says itself that it typed nothing, this tab now holds a fill — also when the fill
  // then failed, or its answer was lost: something may have been left in a box.
  if (!answered || res.ok === true || res.typed !== false) await markFilled(tabId, origin, documentId);
  if (!answered) return { ok: false, code: "gone" };
  if (res.ok !== true) return { ok: false, code: String(res.code || "failed").slice(0, 24) };
  return { ok: true, filled: res.filled, missing: res.missing, step: res.step, frames: res.frames };
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
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || "multipart/related"};base64,${btoa(s)}`;
  });
}

// ─── Sharing from the page's menu / the popup ─────────────────────────────────

async function share(kind, info, tab) {
  await connect();
  if (tab && isOwn(tab)) return false;
  const base = { type: "share", title: (tab && tab.title) || "", url: (tab && tab.url) || (info && info.pageUrl) || "" };
  let msg;
  if (kind === "share-selection") msg = { ...base, kind: "selection", text: String((info && info.selectionText) || "") };
  else if (kind === "share-link") msg = { ...base, kind: "link", title: String((info && (info.linkText || info.linkUrl)) || ""), url: String((info && info.linkUrl) || "") };
  else if (kind === "share-image") msg = { ...base, kind: "image", src: String((info && info.srcUrl) || "") };
  else {
    let text = "";
    try {
      if (tab && /^https?:\/\//i.test(tab.url || "")) {
        const snap = await inPage(tab.id, { op: "snapshot", maxChars: 2500, interactive: false });
        text = (snap && snap.text) || "";
      }
    } catch {
      /* a page we can't read: the title and link still go */
    }
    msg = { ...base, kind: "page", text };
  }
  const sent = sendLive(msg);
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
  // The pairing token of the first version is of no use to anything now.
  chrome.storage.local.remove("token").catch(() => {});
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("trinity-keepalive", { periodInMinutes: 0.5 });
  void connect();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "trinity-keepalive") void connect(); // does nothing while paused, unpaired, refused or stepped back
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.engine) return;
  dropSocket("settings changed");
  backoff = RECONNECT_MIN_MS;
  void connect();
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void share(String(info.menuItemId), info, tab);
});
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.windows.onFocusChanged])
  ev.addListener(() => scheduleTabs());
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  const docs = [moveDocs(scripted, tabId, null), moveDocs(filledDocs, tabId, null)].some(Boolean);
  if (!(tabId in injected) && !(tabId in filled) && !docs) return;
  delete injected[tabId];
  delete filled[tabId];
  await saveSession();
});
chrome.tabs.onReplaced.addListener(async (added, removed) => {
  await ready;
  // The same page under a new tab id (a prerendered page swapped in): what was true of it stays true.
  const docs = [moveDocs(scripted, removed, added), moveDocs(filledDocs, removed, added)].some(Boolean);
  if (!(removed in filled) && !(removed in injected) && !docs) return;
  if (removed in filled) filled[added] = filled[removed];
  delete filled[removed];
  delete injected[removed];
  await saveSession();
});
// A new document in a tab's top frame: Trinity's style sheets went with the old one, and a tab that has left the
// site a login was filled on no longer holds it.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await ready;
  let changed = false;
  if (d.tabId in injected) {
    delete injected[d.tabId];
    changed = true;
  }
  if (d.tabId in filled && originOf(d.url) !== filled[d.tabId]) {
    delete filled[d.tabId];
    changed = true;
  }
  if (changed) await saveSession();
});

/**
 * Is this message from one of this extension's own pages — the popup, in its bubble or opened in a tab of its own?
 * The address and origin are the browser's, not the sender's say: what this worker injects into a web page runs with
 * the extension's id too, but carries that page's address, so it can never steer the worker.
 */
const OWN_PAGES = chrome.runtime.getURL("");
function fromOwnPage(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== "string" || !sender.url.startsWith(OWN_PAGES)) return false;
  return sender.origin === undefined || `${sender.origin}/` === OWN_PAGES;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only this extension's own pages may steer it. (Not "no tab": the popup opened in a tab is in one, and Edge and
  // Chrome both let a person do that.)
  if (!msg || typeof msg !== "object" || !fromOwnPage(sender)) return false;
  const answer = async () => {
    const cfg = await settings();
    const pinned = await pinnedEngine();
    return { status, engine: cfg.engine, paired: Boolean(pinned), pairedAt: pinned ? pinned.pairedAt : null, paused: cfg.paused, userScripts: hasUserScripts(), version: VERSION };
  };
  if (msg.type === "status") {
    answer().then(reply);
    return true;
  }
  if (msg.type === "pair") {
    (async () => {
      // The code is used for this one exchange and kept nowhere.
      const outcome = await connect({ code: String(msg.code || "") });
      reply({ ...(await answer()), outcome });
    })();
    return true;
  }
  if (msg.type === "disconnect") {
    (async () => {
      await chrome.storage.local.set({ paused: true });
      clearTimeout(reconnectTimer);
      dropSocket("disconnect");
      setStatus("paused", DETAIL.paused);
      reply(await answer());
    })();
    return true;
  }
  if (msg.type === "connect") {
    (async () => {
      await chrome.storage.local.set({ paused: false });
      backoff = RECONNECT_MIN_MS;
      const outcome = await Promise.race([connect({ manual: true }), sleep(4000).then(() => "waiting")]);
      reply({ ...(await answer()), outcome });
    })();
    return true;
  }
  if (msg.type === "forget") {
    (async () => {
      clearTimeout(reconnectTimer);
      dropSocket("forgotten");
      await forgetEngine();
      await chrome.storage.local.set({ repair: false });
      setStatus("unpaired", DETAIL.unpaired);
      reply(await answer());
    })();
    return true;
  }
  if (msg.type === "share") {
    (async () => {
      let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      // The popup opened in a tab is itself the tab in front: the page meant is the web page used last before it.
      if (tab && sender.tab && tab.id === sender.tab.id)
        [tab] = (await chrome.tabs.query({})).filter((t) => t.id !== sender.tab.id && /^https?:\/\//i.test(t.url || "")).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      const sent = tab ? await share("share-page", { pageUrl: tab.url }, tab) : false;
      reply({ ok: sent });
    })();
    return true;
  }
  return false;
});

void connect();
