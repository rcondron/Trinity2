import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import { getSetting, setSetting } from "../db/sqlite.js";
import { safeInterval } from "../util/bg.js";

/*
 * The caller's Chrome, through the Trinity Browser Bridge extension (extension/): it keeps one WebSocket
 * to the engine (/ext, paired with a token the Settings page shows), reports its tabs, carries what the
 * caller shares from a page, and runs the engine's calls — open / close / switch tabs, read a page,
 * click and type, inject CSS / HTML / JavaScript, save files. tools/browser.ts turns those calls into
 * Trinity's tools. One extension at a time: a second connection replaces the first.
 */

export interface BrowserTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  title: string;
  url: string;
}

export interface BrowserCaps {
  /** chrome.userScripts is on (the "Allow User Scripts" toggle): JavaScript runs even on sites whose CSP blocks eval. */
  userScripts: boolean;
  pageCapture: boolean;
}

export interface BrowserShare {
  kind: "page" | "selection" | "link" | "image" | "text";
  title: string;
  url: string;
  text?: string;
  /** The image's own URL, for an image share. */
  src?: string;
}

export interface BrowserState {
  connected: boolean;
  since: number;
  version: string;
  chrome: string;
  caps: BrowserCaps;
  tabs: BrowserTab[];
}

const TOKEN_KEY = "browser_ext_token";
const PING_MS = 20_000;
const CALL_TIMEOUT_MS = 12_000;
const MAX_FRAME = 24 * 1024 * 1024; // a screenshot or a page capture

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | null = null;
let info: { version: string; chrome: string; caps: BrowserCaps } | null = null;
let tabs: BrowserTab[] = [];
let since = 0;
let awaitingPong = false;
const pending = new Map<string, Pending>();
const shareHandlers = new Set<(s: BrowserShare) => void>();
const changeHandlers = new Set<() => void>();

// ─── Pairing token ────────────────────────────────────────────────────────────

/** The token the extension must present (made on first use; Settings → Browser extension shows it). */
export function browserToken(): string {
  let t = getSetting(TOKEN_KEY);
  if (!t || t.length < 16) {
    t = nanoid(32);
    setSetting(TOKEN_KEY, t);
  }
  return t;
}

/** A new token; the connected extension (which has the old one) is dropped. */
export function rotateBrowserToken(): string {
  const t = nanoid(32);
  setSetting(TOKEN_KEY, t);
  if (socket) socket.close(4401, "token rotated");
  return t;
}

function tokenOk(given: string | null): boolean {
  if (!given) return false;
  const a = new Uint8Array(Buffer.from(given));
  const b = new Uint8Array(Buffer.from(browserToken()));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── State ────────────────────────────────────────────────────────────────────

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function tab(raw: unknown): BrowserTab | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : NaN;
  if (!Number.isFinite(id)) return null;
  return {
    id,
    windowId: typeof r.windowId === "number" ? r.windowId : 0,
    index: typeof r.index === "number" ? r.index : 0,
    active: r.active === true,
    title: str(r.title, 200),
    url: str(r.url, 2000),
  };
}

function setTabs(raw: unknown): void {
  tabs = (Array.isArray(raw) ? raw : []).map(tab).filter((t): t is BrowserTab => t !== null);
  for (const fn of changeHandlers) {
    try {
      fn();
    } catch (err) {
      console.warn("[browser] change handler failed:", (err as Error).message);
    }
  }
}

export function browserConnected(): boolean {
  return socket !== null && socket.readyState === socket.OPEN;
}

export function browserTabs(): BrowserTab[] {
  return browserConnected() ? tabs : [];
}

export function activeBrowserTab(): BrowserTab | null {
  return browserTabs().find((t) => t.active) ?? null;
}

export function browserCaps(): BrowserCaps {
  return info?.caps ?? { userScripts: false, pageCapture: false };
}

export function browserState(): BrowserState {
  return {
    connected: browserConnected(),
    since,
    version: info?.version ?? "",
    chrome: info?.chrome ?? "",
    caps: browserCaps(),
    tabs: browserTabs(),
  };
}

/** "amazon.com" from a URL; the scheme for pages that aren't web pages. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname.replace(/^www\./, "");
    return u.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

/** The browser as a sentence for Jev and the reply writer; null when no extension is connected. */
export function describeBrowser(): string | null {
  if (!browserConnected()) return null;
  const active = activeBrowserTab();
  const name = (t: BrowserTab) => `“${(t.title || hostOf(t.url) || "untitled").slice(0, 60)}”`;
  const others = tabs
    .filter((t) => t.id !== active?.id)
    .slice(0, 6)
    .map(name);
  const count = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
  const act = active ? ` The active tab is ${name(active)}${hostOf(active.url) ? ` (${hostOf(active.url)})` : ""}.` : "";
  const rest = others.length ? ` Other tabs: ${others.join(", ")}${tabs.length - 1 > others.length ? ", …" : ""}.` : "";
  return `The caller's Chrome browser is connected to Trinity (${count}).${act}${rest}`;
}

/** Something the caller shared from the browser (a page, a selection, a link, an image). */
export function onBrowserShare(fn: (s: BrowserShare) => void): () => void {
  shareHandlers.add(fn);
  return () => shareHandlers.delete(fn);
}

/** Connected / disconnected / tabs changed. */
export function onBrowserChange(fn: () => void): () => void {
  changeHandlers.add(fn);
  return () => changeHandlers.delete(fn);
}

// ─── Calls ────────────────────────────────────────────────────────────────────

/** Run one extension method; rejects when the browser isn't connected, the call fails, or it takes too long. */
export function browserCall<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const ws = socket;
  if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error("the browser extension isn't connected"));
  const id = nanoid(10);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the browser didn't answer ${method} in time`));
    }, timeoutMs);
    pending.set(id, { method, resolve: (v) => resolve(v as T), reject, timer });
    ws.send(JSON.stringify({ type: "call", id, method, params }), (err) => {
      if (!err) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    });
  });
}

function failPending(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

function share(raw: Record<string, unknown>): void {
  const kind = str(raw.kind, 16);
  if (!["page", "selection", "link", "image", "text"].includes(kind)) return;
  const s: BrowserShare = { kind: kind as BrowserShare["kind"], title: str(raw.title, 200), url: str(raw.url, 2000) };
  const text = typeof raw.text === "string" ? raw.text.replace(/\r/g, "").trim().slice(0, 12_000) : "";
  if (text) s.text = text;
  const src = str(raw.src, 2000);
  if (src) s.src = src;
  for (const fn of shareHandlers) {
    try {
      fn(s);
    } catch (err) {
      console.warn("[browser] share handler failed:", (err as Error).message);
    }
  }
}

function onMessage(ws: WebSocket, data: unknown): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(data)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hello": {
      const caps = (msg.caps && typeof msg.caps === "object" ? msg.caps : {}) as Record<string, unknown>;
      info = { version: str(msg.version, 24), chrome: str(msg.chrome, 24), caps: { userScripts: caps.userScripts === true, pageCapture: caps.pageCapture === true } };
      setTabs(msg.tabs);
      ws.send(JSON.stringify({ type: "welcome", engine: "trinity" }));
      console.log(`[browser] extension connected: v${info.version} on Chrome ${info.chrome}, ${tabs.length} tab(s)${info.caps.userScripts ? ", user scripts on" : ""}`);
      return;
    }
    case "tabs":
      setTabs(msg.tabs);
      return;
    case "pong":
      awaitingPong = false;
      return;
    case "share":
      share(msg);
      return;
    case "result": {
      const p = pending.get(String(msg.id));
      if (!p) return;
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(str(msg.error, 400) || `${p.method} failed in the browser`));
      else p.resolve(msg.result);
      return;
    }
    default:
      return;
  }
}

/** The /ext upgrade: the token must match; then this socket is the browser. */
export function handleBrowserUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  if (!tokenOk(token)) {
    console.warn("[browser] an extension tried to connect with the wrong token");
    wss.handleUpgrade(req, sock, head, (ws) => ws.close(4401, "bad token"));
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    if (socket && socket !== ws) {
      console.log("[browser] another extension connected; the earlier one is dropped");
      socket.close(4409, "replaced");
    }
    socket = ws;
    info = null;
    tabs = [];
    since = Date.now();
    awaitingPong = false;
    ws.on("message", (data) => onMessage(ws, data));
    const gone = () => {
      if (socket !== ws) return;
      socket = null;
      info = null;
      tabs = [];
      failPending("the browser extension disconnected");
      console.log("[browser] extension disconnected");
      for (const fn of changeHandlers) {
        try {
          fn();
        } catch {
          /* already logged elsewhere */
        }
      }
    };
    ws.on("close", gone);
    ws.on("error", gone);
    for (const fn of changeHandlers) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  });
}

// The extension's service worker stays alive while messages flow; a missed pong means it's gone.
safeInterval(
  "browser-ping",
  () => {
    const ws = socket;
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (awaitingPong) {
      ws.terminate();
      return;
    }
    awaitingPong = true;
    ws.send(JSON.stringify({ type: "ping" }));
  },
  PING_MS,
);
