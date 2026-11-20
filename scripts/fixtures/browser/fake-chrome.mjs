// A pretend Chrome for Node tests: enough of the extension APIs (tabs, windows, scripting, storage, alarms,
// webNavigation, sessions, downloads …), a WebSocket that sends the extension's Origin, and an IndexedDB, to run the
// REAL service worker (extension/background.js) unchanged against the real engine bridge — with pages that are
// mini-DOM documents (mini-dom.mjs), so the real page-side code (extension/page.js) runs in them too.
//
// chrome.scripting.executeScript rebuilds the function from its source text before calling it, as Chrome does: a
// page-side function that leaned on anything outside itself would fail here just as it would in a browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import NodeWebSocket from "ws";
import { enter, loadPage } from "./mini-dom.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(HERE, "..", "..", "..", "extension");
export const FAKE_ID = "abcdefghijklmnopabcdefghijklmnop";

function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => void listeners.add(fn),
    removeListener: (fn) => void listeners.delete(fn),
    fire: (...args) => [...listeners].map((fn) => fn(...args)),
    listeners,
  };
}

function storageArea(name, changed) {
  const data = {};
  const pick = (keys) => {
    if (keys === undefined || keys === null) return structuredClone(data);
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
    return out;
  };
  return {
    data,
    get: async (keys) => pick(keys),
    set: async (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = structuredClone(v);
      }
      changed.fire(changes, name);
    },
    remove: async (keys) => {
      for (const k of typeof keys === "string" ? [keys] : keys) delete data[k];
    },
  };
}

/** IndexedDB, as far as extension/store.js uses it. Values are kept by reference (a CryptoKey stays a CryptoKey). */
function fakeIndexedDb() {
  const dbs = new Map();
  return {
    dbs,
    open(name) {
      const req = {};
      queueMicrotask(() => {
        let stores = dbs.get(name);
        const fresh = !stores;
        if (fresh) dbs.set(name, (stores = new Map()));
        const db = {
          createObjectStore: (store) => void stores.set(store, new Map()),
          transaction: (store) => {
            const tx = {};
            const map = stores.get(store);
            const done = (result) => {
              const r = { result };
              queueMicrotask(() => tx.oncomplete && tx.oncomplete());
              return r;
            };
            tx.objectStore = () => ({ get: (key) => done(map.get(key)), put: (value, key) => done(void map.set(key, value)), delete: (key) => done(void map.delete(key)) });
            return tx;
          },
          close() {},
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

export function createFakeBrowser({ id = FAKE_ID, engine } = {}) {
  const b = {
    id,
    tabs: [],
    nextTabId: 1,
    nextWindowId: 2,
    focusedWindow: 1,
    /** Everything the worker did that a test may want to look at. */
    log: { sockets: [], css: [], downloads: [], captures: [], activations: [], closed: [], created: [], badge: [], history: [] },
    closedSessions: [],
    /** Called with each message from the engine before the worker sees it; may change it, or return false to drop it. */
    intercept: null,
  };
  const ev = {
    installed: event(),
    startup: event(),
    message: event(),
    alarm: event(),
    storage: event(),
    menu: event(),
    committed: event(),
    tabCreated: event(),
    tabRemoved: event(),
    tabUpdated: event(),
    tabActivated: event(),
    tabMoved: event(),
    tabAttached: event(),
    tabDetached: event(),
    tabReplaced: event(),
    focus: event(),
  };
  b.events = ev;
  const local = storageArea("local", ev.storage);
  const session = storageArea("session", ev.storage);
  if (engine) local.data.engine = engine;
  b.storage = { local, session };
  const idb = fakeIndexedDb();
  b.indexedDB = idb;

  const pub = (t) => ({ id: t.id, windowId: t.windowId, index: t.index, active: t.active, title: t.title, url: t.url, status: t.status, pinned: t.pinned, mutedInfo: { muted: t.muted }, audible: false, groupId: t.groupId, lastAccessed: t.lastAccessed });
  const find = (tabId) => {
    const t = b.tabs.find((x) => x.id === tabId);
    if (!t) throw new Error(`No tab with id: ${tabId}.`);
    return t;
  };
  const reindex = (windowId) =>
    b.tabs
      .filter((t) => t.windowId === windowId)
      .sort((x, y) => x.index - y.index)
      .forEach((t, i) => (t.index = i));
  let docSeq = 0;
  const setDocument = (t, url, html) => {
    t.url = url;
    t.documentId = `DOC${++docSeq}`;
    t.status = "complete";
    t.win = /^https?:/.test(url) ? loadPage(html ?? `<!doctype html><html><head><title>${url}</title></head><body><p>${url}</p></body></html>`, { url }) : null;
    t.title = t.win ? t.win.document.title || url : url;
    t.frames = [];
    // The page's own history: logged, and — when a test says where it leads (t.historyTo) — it goes there.
    if (t.win)
      t.win.history = {
        go: (n) => {
          b.log.history.push({ tabId: t.id, step: n, by: "page" });
          const to = t.historyTo && t.historyTo[n];
          if (to) setTimeout(() => b.navigate(t.id, to), 20);
        },
      };
  };

  /** A tab showing `html` at `url`. */
  b.openTab = (url, html, opts = {}) => {
    const windowId = opts.windowId ?? 1;
    const t = { id: b.nextTabId++, windowId, index: b.tabs.filter((x) => x.windowId === windowId).length, active: false, pinned: false, muted: false, groupId: -1, lastAccessed: Date.now(), css: [] };
    setDocument(t, url, html);
    b.tabs.push(t);
    if (opts.active !== false) b.activate(t.id);
    ev.tabCreated.fire(pub(t));
    return t;
  };
  /** A fixture page (scripts/fixtures/browser/<file>) served, as far as the page knows, from `url`. */
  b.openFixture = (file, url, opts = {}) => {
    const html = fs.readFileSync(path.join(HERE, file), "utf8").replaceAll("{{OTHER}}", opts.other ?? "https://collector.evil.example").replaceAll("{{SELF}}", new URL(url).origin);
    return b.openTab(url, html, opts);
  };
  b.activate = (tabId) => {
    const t = find(tabId);
    for (const x of b.tabs) if (x.windowId === t.windowId) x.active = x.id === tabId;
    t.lastAccessed = Date.now();
    b.focusedWindow = t.windowId;
    b.log.activations.push(tabId);
    ev.tabActivated.fire({ tabId, windowId: t.windowId });
  };
  /** The tab goes to another document (a navigation): new document id, style sheets gone, events fired. */
  b.navigate = (tabId, url, html) => {
    const t = find(tabId);
    setDocument(t, url, html);
    t.css = [];
    ev.committed.fire({ tabId, frameId: 0, url });
    ev.tabUpdated.fire(tabId, { url, status: "complete" }, pub(t));
  };
  /** The document a tab shows now, to bring back later (what the back button does with a page kept in the history). */
  b.keepDocument = (tabId) => {
    const t = find(tabId);
    return { url: t.url, documentId: t.documentId, win: t.win, title: t.title, frames: t.frames };
  };
  /** Back to a kept document: the same document, id and field contents included; style sheets of the old page gone. */
  b.bringBack = (tabId, kept) => {
    const t = find(tabId);
    Object.assign(t, kept, { status: "complete" });
    t.css = [];
    ev.committed.fire({ tabId, frameId: 0, url: t.url, documentId: t.documentId, transitionQualifiers: ["forward_back"] });
    ev.tabUpdated.fire(tabId, { url: t.url, status: "complete" }, pub(t));
  };
  /** A frame inside the tab's page (another document, another origin). */
  b.addFrame = (tabId, url, html) => {
    const t = find(tabId);
    const win = loadPage(html, { url, top: t.win });
    t.frames.push({ frameId: t.frames.length + 1, win, documentId: `DOC${++docSeq}` });
    return win;
  };
  b.page = (tabId) => find(tabId).win;
  b.tab = (tabId) => find(tabId);

  const removeTab = (tabId) => {
    const t = find(tabId);
    b.tabs.splice(b.tabs.indexOf(t), 1);
    b.closedSessions.push({ url: t.url, html: null, windowId: t.windowId });
    b.log.closed.push(tabId);
    reindex(t.windowId);
    if (t.active) {
      const next = b.tabs.find((x) => x.windowId === t.windowId);
      if (next) next.active = true;
    }
    ev.tabRemoved.fire(tabId, { windowId: t.windowId, isWindowClosing: false });
  };

  const chrome = {
    runtime: {
      id,
      lastError: null,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8")),
      getURL: (p = "") => `chrome-extension://${id}/${String(p).replace(/^\/+/, "")}`,
      onInstalled: ev.installed,
      onStartup: ev.startup,
      onMessage: ev.message,
    },
    action: {
      setBadgeText: async (o) => void b.log.badge.push(o.text),
      setBadgeBackgroundColor: async () => {},
    },
    storage: { local, session, onChanged: ev.storage },
    alarms: { create: () => {}, onAlarm: ev.alarm },
    contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: ev.menu },
    webNavigation: {
      onCommitted: ev.committed,
      getFrame: async ({ tabId, frameId }) => {
        const t = find(tabId);
        if (b.hideDocuments) return null; // (a test's switch: Chrome not saying which document a tab shows)
        if (frameId === 0) return { errorOccurred: false, url: t.url, parentFrameId: -1, documentId: t.documentId, documentLifecycle: "active", frameType: "outermost_frame" };
        const f = t.frames.find((x) => x.frameId === frameId);
        return f ? { errorOccurred: false, url: String(f.win.location.href), parentFrameId: 0, documentId: f.documentId, documentLifecycle: "active", frameType: "sub_frame" } : null;
      },
    },
    tabs: {
      onCreated: ev.tabCreated,
      onRemoved: ev.tabRemoved,
      onUpdated: ev.tabUpdated,
      onActivated: ev.tabActivated,
      onMoved: ev.tabMoved,
      onAttached: ev.tabAttached,
      onDetached: ev.tabDetached,
      onReplaced: ev.tabReplaced,
      query: async (q = {}) =>
        b.tabs
          .filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId) && (!q.lastFocusedWindow || t.windowId === b.focusedWindow))
          .sort((x, y) => x.windowId - y.windowId || x.index - y.index)
          .map(pub),
      get: async (tabId) => pub(find(tabId)),
      update: async (tabId, props) => {
        const t = find(tabId);
        if (props.url !== undefined) b.navigate(tabId, props.url);
        if (props.active) b.activate(tabId);
        if (props.pinned !== undefined) t.pinned = Boolean(props.pinned);
        if (props.muted !== undefined) t.muted = Boolean(props.muted);
        ev.tabUpdated.fire(tabId, props, pub(t));
        return pub(t);
      },
      create: async (props) => {
        const t = b.openTab(props.url ?? "chrome://newtab/", undefined, { windowId: props.windowId ?? b.focusedWindow, active: props.active !== false });
        if (typeof props.index === "number") {
          for (const x of b.tabs) if (x.windowId === t.windowId && x !== t && x.index >= props.index) x.index++;
          t.index = props.index;
          reindex(t.windowId);
        }
        b.log.created.push({ url: t.url, openerTabId: props.openerTabId, index: t.index });
        return pub(t);
      },
      remove: async (ids) => {
        for (const tabId of Array.isArray(ids) ? ids : [ids]) removeTab(tabId);
      },
      // Chrome refuses these when the only page to step to was left without a click or a key (its history
      // intervention): a test sets `skipHistory` on the tab for that. The page's own history.go() is logged too.
      goBack: async (tabId) => {
        if (find(tabId).skipHistory) throw new Error("Cannot find a next page in history.");
        b.log.history.push({ tabId, step: -1, by: "chrome" });
      },
      goForward: async (tabId) => {
        if (find(tabId).skipHistory) throw new Error("Cannot find a next page in history.");
        b.log.history.push({ tabId, step: 1, by: "chrome" });
      },
      reload: async () => {},
      getZoom: async (tabId) => find(tabId).zoom ?? 1,
      setZoom: async (tabId, factor) => void (find(tabId).zoom = factor),
      move: async (tabId, { index }) => {
        const t = find(tabId);
        const sibs = b.tabs.filter((x) => x.windowId === t.windowId && x !== t).sort((x, y) => x.index - y.index);
        const at = index < 0 ? sibs.length : Math.min(index, sibs.length);
        sibs.splice(at, 0, t);
        sibs.forEach((x, i) => (x.index = i));
        ev.tabMoved.fire(tabId, {});
        return pub(t);
      },
      duplicate: async (tabId) => {
        const t = find(tabId);
        const copy = b.openTab(t.url, undefined, { windowId: t.windowId, active: true });
        return pub(copy);
      },
      group: async ({ tabIds }) => {
        const gid = 100 + b.tabs.filter((t) => t.groupId >= 0).length;
        for (const tabId of tabIds) find(tabId).groupId = gid;
        return gid;
      },
      ungroup: async (ids) => {
        for (const tabId of Array.isArray(ids) ? ids : [ids]) find(tabId).groupId = -1;
      },
      captureVisibleTab: async (windowId) => {
        const front = b.tabs.find((t) => t.windowId === windowId && t.active);
        b.log.captures.push(front ? front.id : null);
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      },
    },
    windows: {
      onFocusChanged: ev.focus,
      getLastFocused: async () => ({ id: b.focusedWindow }),
      update: async (windowId, props) => {
        if (props.focused) b.focusedWindow = windowId;
        b.windowState = b.windowState ?? {};
        if (props.state) b.windowState[windowId] = props.state;
        return { id: windowId, state: b.windowState[windowId] ?? "normal" };
      },
      create: async (props = {}) => {
        const windowId = b.nextWindowId++;
        let t;
        if (props.tabId !== undefined) {
          t = find(props.tabId);
          const from = t.windowId;
          t.windowId = windowId;
          t.index = 0;
          t.active = true;
          reindex(from);
          const next = b.tabs.find((x) => x.windowId === from);
          if (next && !b.tabs.some((x) => x.windowId === from && x.active)) next.active = true;
        } else t = b.openTab(props.url ?? "chrome://newtab/", undefined, { windowId });
        if (props.focused) b.focusedWindow = windowId;
        return { id: windowId, tabs: [pub(t)] };
      },
      remove: async (windowId) => {
        for (const t of b.tabs.filter((x) => x.windowId === windowId)) removeTab(t.id);
        if (b.focusedWindow === windowId) b.focusedWindow = b.tabs[0] ? b.tabs[0].windowId : 1;
      },
    },
    sessions: {
      restore: async () => {
        const s = b.closedSessions.pop();
        if (!s) return undefined;
        return { tab: pub(b.openTab(s.url, undefined, { windowId: s.windowId })) };
      },
    },
    tabGroups: { update: async (groupId, props) => void ((b.groups = b.groups ?? {})[groupId] = props) },
    downloads: {
      download: async (options) => {
        b.log.downloads.push(options);
        return b.log.downloads.length;
      },
    },
    pageCapture: { saveAsMHTML: async () => new Blob(["MHTML"], { type: "multipart/related" }) },
    scripting: {
      executeScript: async ({ target, func, args = [] }) => {
        const t = find(target.tabId);
        if (!t.win) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
        if (target.documentIds && !target.documentIds.includes(t.documentId)) throw new Error(`No document with id ${target.documentIds[0]} in tab with id ${t.id}`);
        // As Chrome does it: the function travels as text, and its arguments and result as plain data.
        const rebuilt = new Function(`return (${func.toString()});`)();
        const run = (win) => {
          const leave = enter(win);
          try {
            const result = rebuilt(...structuredClone(args));
            return result === undefined ? null : structuredClone(result);
          } finally {
            leave();
          }
        };
        const out = [];
        const wantTop = !target.frameIds || target.frameIds.includes(0);
        if (wantTop) out.push({ frameId: 0, documentId: t.documentId, result: run(t.win) });
        for (const f of t.frames) if (target.allFrames || (target.frameIds && target.frameIds.includes(f.frameId))) out.push({ frameId: f.frameId, documentId: f.documentId, result: run(f.win) });
        return out;
      },
      insertCSS: async ({ target, css }) => {
        find(target.tabId).css.push(css);
        b.log.css.push({ op: "insert", tabId: target.tabId, css });
      },
      removeCSS: async ({ target, css }) => {
        const t = find(target.tabId);
        const i = t.css.indexOf(css);
        if (i >= 0) t.css.splice(i, 1);
        b.log.css.push({ op: "remove", tabId: target.tabId, css, found: i >= 0 });
      },
    },
  };
  b.chrome = chrome;

  /** The browser's WebSocket: the extension's Origin is added by "Chrome", never by the extension's code. */
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.record = { url, open: false, closeCode: null, sent: [], received: [] };
      b.log.sockets.push(this.record);
      b.socket = this;
      const ws = new NodeWebSocket(url, { origin: `chrome-extension://${id}` });
      this.ws = ws;
      ws.on("open", () => {
        this.readyState = 1;
        this.record.open = true;
        if (this.onopen) this.onopen({});
      });
      ws.on("message", (raw) => {
        let data = String(raw);
        if (b.intercept) {
          const changed = b.intercept(JSON.parse(data));
          if (changed === false) return;
          if (changed && typeof changed === "object") data = JSON.stringify(changed);
        }
        this.record.received.push(data);
        if (this.onmessage) this.onmessage({ data });
      });
      const end = (code) => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.record.open = false;
        this.record.closeCode = code;
        if (this.onclose) this.onclose({ code });
      };
      ws.on("close", (code) => end(code));
      ws.on("unexpected-response", () => end(1006));
      ws.on("error", () => {
        if (this.onerror) this.onerror({});
        end(1006);
      });
    }
    send(text) {
      this.record.sent.push(text);
      this.ws.send(text);
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      try {
        if (this.ws.readyState === NodeWebSocket.CONNECTING) this.ws.terminate();
        else this.ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  }

  /** Make this the browser the service worker finds itself in. */
  b.install = () => {
    globalThis.chrome = chrome;
    globalThis.WebSocket = FakeWebSocket;
    globalThis.indexedDB = idb;
  };
  /**
   * A message from the popup (in its bubble: no tab), as Chrome describes the sender — the extension's id, and the
   * popup's own address and origin; resolves with the worker's reply (undefined when the worker doesn't answer).
   */
  const own = `chrome-extension://${id}`;
  const message = (msg, sender) =>
    new Promise((resolve) => {
      const handled = ev.message.fire(msg, sender, (reply) => resolve(reply));
      if (!handled.some((h) => h === true)) resolve(undefined);
    });
  b.popup = (msg) => message(msg, { id, url: `${own}/popup.html`, origin: own });
  /** The same popup opened in a tab of its own (chrome-extension://<id>/popup.html typed into the address bar). */
  b.popupInTab = (msg, tabId) => message(msg, { id, url: `${own}/popup.html`, origin: own, tab: pub(b.tab(tabId)), frameId: 0 });
  /** A message from code running in a web page with the extension's id (what the worker injects runs that way). */
  b.fromPage = (msg, tabId) => {
    const t = b.tab(tabId);
    return message(msg, { id, url: t.url, origin: new URL(t.url).origin, tab: pub(t), frameId: 0 });
  };
  b.fireAlarm = (name = "trinity-keepalive") => ev.alarm.fire({ name });
  b.openSockets = () => b.log.sockets.filter((s) => s.open).length;
  /** Hand the worker a message as if it had just arrived on its socket (a replay, or something the engine never sent). */
  b.deliver = (msg) => {
    if (b.socket && b.socket.readyState === 1 && b.socket.onmessage) b.socket.onmessage({ data: JSON.stringify(msg) });
  };
  /** What the engine sent the worker on the socket in use, parsed. */
  b.received = () => (b.socket ? b.socket.record.received.map((t) => JSON.parse(t)) : []);
  /** The extension's stored key pair and pinned engine key (so a test can play "another copy of this extension"). */
  b.keys = () => {
    const store = idb.dbs.get("trinity-bridge")?.get("keys");
    return { pair: store?.get("pair") ?? null, engine: store?.get("engine") ?? null };
  };
  return b;
}
