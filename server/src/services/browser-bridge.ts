import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import { allowedOrigins } from "../auth.js";
import { DATA_DIR } from "../config.js";
import { deleteSetting, getSetting } from "../db/sqlite.js";
import { safeInterval } from "../util/bg.js";

/*
 * The user's Chrome, through the Trinity Browser Bridge extension (extension/): one WebSocket to the engine (/ext) that
 * reports its tabs, carries what the user shares from a page, and runs the engine's calls — tabs and windows, reading a
 * page, clicking and typing, CSS / HTML / JavaScript, files, and filling logins and cards from the vault.
 * tools/browser.ts and tools/browser-fill.ts turn those calls into Trinity's tools.
 *
 * Who may be on that socket (pairing v2; extension/proto.js is the other end of every line here):
 *
 *  - Pairing, once. Settings → Browser shows a one-time code (8 characters, 10 minutes, 5 tries). The user types it into
 *    the extension's popup; the extension sends its public key with HMAC(code, …), the engine answers with its own key
 *    and HMAC(code, …). The code never crosses the wire. Both keys are ECDH P-256; the engine keeps its pair and the
 *    extension's public key and id in <data>/extension-pairing.json, the extension keeps a non-extractable pair in
 *    IndexedDB and pins the engine's key.
 *  - Every connection: hello(nE) → challenge(nS, HMAC(K, "engine|nE|nS")) → auth(HMAC(K, "ext|nS|nE"), …) → welcome,
 *    with K = HKDF(ECDH secret, "trinity-ext-v2", "link"). The engine sends no call before `auth` verifies, and the
 *    extension runs none before the engine's proof does.
 *  - The upgrade is refused unless Origin is chrome-extension://<the paired id> (any chrome-extension origin only while
 *    a pairing code is live). A newer authenticated socket replaces the older one (closed 4409); one that hasn't proved K
 *    never does. Messages from a replaced socket are ignored. 4401 = not paired / wrong proof.
 *  - Fills are sealed (AES-256-GCM) under a per-connection key Ks = HKDF(K, nE + nS, "session"), bound to the call id,
 *    the method, the page's origin and the tab, and expire after ten seconds (browserSecretCall). Nothing about them is
 *    logged, and only field kinds come back.
 */

export interface BrowserTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  title: string;
  url: string;
  pinned?: boolean;
  muted?: boolean;
  audible?: boolean;
  /** Chrome's tab group, when the tab is in one. */
  groupId?: number;
  /** When the tab was last in front (ms), where Chrome says. */
  lastAccessed?: number;
}

export interface BrowserCaps {
  /** chrome.userScripts is on (the "Allow User Scripts" toggle): JavaScript runs even on sites whose CSP blocks eval. */
  userScripts: boolean;
  pageCapture: boolean;
  /** The extension can fill logins and cards from the vault (pairing v2). */
  fill: boolean;
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

const PAIRING_FILE = path.join(DATA_DIR, "extension-pairing.json");
const PING_MS = 20_000;
const CALL_TIMEOUT_MS = 12_000;
const HANDSHAKE_MS = 8_000;
const MAX_FRAME = 24 * 1024 * 1024; // a screenshot or a page capture
const MAX_UNPROVED_FRAME = 1024 * 1024; // before `auth` verifies: a hello, a pair, an auth with its tab list
const MAX_UNPROVED_PEERS = 6;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0 or 1
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
const FILL_TTL_MS = 10_000;
const EXTENSION_ID = /^[a-p]{32}$/;

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

// ─── Keys and the pairing file ────────────────────────────────────────────────

interface PairingFile {
  version: 2;
  /** The engine's own static ECDH P-256 pair (base64; the public half raw, 65 bytes). */
  engine: { privateKey: string; publicKey: string };
  /** The one extension that may connect. */
  extension: { id: string; publicKey: string; pairedAt: number } | null;
}

let pairing: PairingFile | null = null;
/** K for the paired extension (derived once per pairing). */
let linkKey: Uint8Array | null = null;

// Bytes are handled as plain Uint8Array views throughout (this project's type settings don't let a Buffer stand in
// for one where node:crypto asks for bytes).
type Bytes = { readonly buffer: ArrayBufferLike; readonly byteOffset: number; readonly byteLength: number };
const view = (b: Bytes): Uint8Array => new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const b64 = (b: Bytes): string => Buffer.from(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength).toString("base64");
const unb64 = (text: string): Uint8Array => view(Buffer.from(text, "base64"));

/** Strict base64 → bytes of exactly `length`, or null. */
function bytes(text: unknown, length: number): Uint8Array | null {
  if (typeof text !== "string" || text.length > 256 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const buf = unb64(text);
  return buf.length === length ? buf : null;
}

function newEngineKeys(): PairingFile["engine"] {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey("base64"), publicKey: ecdh.getPublicKey("base64") };
}

function savePairing(): void {
  if (!pairing) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PAIRING_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pairing, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, PAIRING_FILE);
}

function loadPairing(): PairingFile {
  if (pairing) return pairing;
  try {
    const raw = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf8")) as Partial<PairingFile>;
    const eng = raw.engine;
    const ext = raw.extension;
    if (!eng || !bytes(eng.privateKey, 32) || !bytes(eng.publicKey, 65)) throw new Error("no engine key");
    pairing = {
      version: 2,
      engine: { privateKey: eng.privateKey, publicKey: eng.publicKey },
      extension: ext && EXTENSION_ID.test(String(ext.id)) && bytes(ext.publicKey, 65) ? { id: ext.id, publicKey: ext.publicKey, pairedAt: Number(ext.pairedAt) || 0 } : null,
    };
  } catch {
    pairing = { version: 2, engine: newEngineKeys(), extension: null };
    try {
      savePairing();
    } catch (err) {
      console.warn("[browser] couldn't save the pairing file:", (err as Error).message);
    }
  }
  // The old pairing (a token the API served) is gone: nothing reads it, and it shouldn't sit in the database.
  try {
    if (getSetting("browser_ext_token") !== null) deleteSetting("browser_ext_token");
  } catch {
    /* the database is not this module's to fix */
  }
  return pairing;
}

/** K = HKDF-SHA256(ECDH(engine private, extension public), "trinity-ext-v2", "link"); null when that key isn't on the curve. */
function deriveLinkKey(enginePrivate: string, extensionPublic: string): Uint8Array | null {
  try {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(unb64(enginePrivate));
    const shared = view(ecdh.computeSecret(unb64(extensionPublic)));
    const k = new Uint8Array(crypto.hkdfSync("sha256", shared, utf8("trinity-ext-v2"), utf8("link"), 32));
    shared.fill(0);
    return k;
  } catch {
    return null;
  }
}

function currentLinkKey(): Uint8Array | null {
  const p = loadPairing();
  if (!p.extension) return null;
  linkKey ??= deriveLinkKey(p.engine.privateKey, p.extension.publicKey);
  return linkKey;
}

const hmac = (key: Uint8Array | string, text: string): Uint8Array => view(crypto.createHmac("sha256", key).update(text, "utf8").digest());

/** Constant-time: is `given` (base64) the 32-byte MAC `want`? */
function macMatches(given: unknown, want: Uint8Array): boolean {
  const got = bytes(given, 32);
  return got !== null && got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ─── Pairing code ─────────────────────────────────────────────────────────────

let code: { value: string; until: number; tries: number } | null = null;

function liveCode(): { value: string; until: number; tries: number } | null {
  if (code && (Date.now() > code.until || code.tries >= CODE_TRIES)) code = null;
  return code;
}

/** A fresh one-time pairing code (the last one stops working). Shown in Settings → Browser, typed into the popup. */
export function newPairingCode(): { code: string; expiresAt: number; tries: number } {
  let value = "";
  for (let i = 0; i < CODE_LENGTH; i++) value += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  code = { value, until: Date.now() + CODE_TTL_MS, tries: 0 };
  return { code: value, expiresAt: code.until, tries: CODE_TRIES };
}

/** Who is paired, and whether a code is waiting to be typed (never the code itself). */
export function pairingInfo(): { paired: boolean; extensionId: string | null; pairedAt: number | null; codeExpiresAt: number | null } {
  const p = loadPairing();
  return { paired: p.extension !== null, extensionId: p.extension?.id ?? null, pairedAt: p.extension?.pairedAt ?? null, codeExpiresAt: liveCode()?.until ?? null };
}

/** Forget the paired extension: its socket is closed and it must pair again with a new code. */
export function unpairBrowser(): boolean {
  const p = loadPairing();
  const had = p.extension !== null;
  p.extension = null;
  linkKey = null;
  code = null;
  savePairing();
  if (live) drop(live, 4401, "unpaired");
  return had;
}

// ─── State ────────────────────────────────────────────────────────────────────

interface Pending {
  method: string;
  peer: Peer;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One socket and how far it has got:  open ──hello──▶ challenged ──auth (proof ok)──▶ live;  dead is final.
 * (`pair` is handled in `open` and leaves the socket there, now paired, waiting for its hello.)
 */
interface Peer {
  ws: WebSocket;
  /** The extension id in the upgrade's Origin header (set by Chrome, not by the extension's code). */
  originId: string;
  phase: "open" | "challenged" | "live" | "dead";
  nE: string;
  nS: string;
  /** K as it was when this socket said hello. */
  key: Uint8Array | null;
  /** Ks, once live. */
  session: Uint8Array | null;
  timer: ReturnType<typeof setTimeout> | null;
  awaitingPong: boolean;
}

const peers = new Set<Peer>();
let live: Peer | null = null;
let info: { version: string; chrome: string; caps: BrowserCaps } | null = null;
let tabs: BrowserTab[] = [];
let since = 0;
const pending = new Map<string, Pending>();
const shareHandlers = new Set<(s: BrowserShare) => void>();
const changeHandlers = new Set<() => void>();

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function tab(raw: unknown): BrowserTab | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : NaN;
  if (!Number.isFinite(id)) return null;
  const t: BrowserTab = {
    id,
    windowId: typeof r.windowId === "number" ? r.windowId : 0,
    index: typeof r.index === "number" ? r.index : 0,
    active: r.active === true,
    title: str(r.title, 200),
    url: str(r.url, 2000),
  };
  if (r.pinned === true) t.pinned = true;
  if (r.muted === true) t.muted = true;
  if (r.audible === true) t.audible = true;
  if (typeof r.groupId === "number" && r.groupId >= 0) t.groupId = r.groupId;
  if (typeof r.lastAccessed === "number" && Number.isFinite(r.lastAccessed)) t.lastAccessed = r.lastAccessed;
  return t;
}

function changed(): void {
  for (const fn of changeHandlers) {
    try {
      fn();
    } catch (err) {
      console.warn("[browser] change handler failed:", (err as Error).message);
    }
  }
}

function setTabs(raw: unknown): void {
  tabs = (Array.isArray(raw) ? raw.slice(0, 2000) : []).map(tab).filter((t): t is BrowserTab => t !== null);
  changed();
}

export function browserConnected(): boolean {
  return live !== null && live.ws.readyState === live.ws.OPEN;
}

export function browserTabs(): BrowserTab[] {
  return browserConnected() ? tabs : [];
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** One of Trinity's own pages (the app, Settings, the workspace window): never read, changed, navigated or closed. */
export function isOwnTab(t: Pick<BrowserTab, "url">): boolean {
  const origin = originOf(t.url);
  return origin !== null && allowedOrigins().has(origin);
}

/** The tab in front in the window used last — whatever it is. */
export function activeBrowserTab(): BrowserTab | null {
  return browserTabs().find((t) => t.active) ?? null;
}

/**
 * The tab "this page" means: the one in front — or, when that is Trinity's own page (the user is talking to her there),
 * the web tab they were on last.
 */
export function currentBrowserTab(): BrowserTab | null {
  const all = browserTabs();
  const active = all.find((t) => t.active) ?? null;
  if (active && !isOwnTab(active)) return active;
  const others = all.filter((t) => !isOwnTab(t));
  if (!others.length) return null;
  const recent = [...others].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]!;
  if (recent.lastAccessed) return recent;
  // No "last used" times: a neighbour in the same window, else the first web tab anywhere.
  const near = active ? others.filter((t) => t.windowId === active.windowId).sort((a, b) => Math.abs(a.index - active.index) - Math.abs(b.index - active.index))[0] : null;
  return near ?? others[0]!;
}

/**
 * The exact host of the page the user is on, when it is an https page ("www.netflix.com") — what a login is saved for.
 * (hostOf() drops "www." and is for speech only.)
 */
export function activeTabHost(): string | null {
  const t = currentBrowserTab();
  if (!t) return null;
  try {
    const u = new URL(t.url);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function browserCaps(): BrowserCaps {
  return info?.caps ?? { userScripts: false, pageCapture: false, fill: false };
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

/** "amazon.com" from a URL, for speech; the scheme for pages that aren't web pages. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname.replace(/^www\./, "");
    return u.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

/**
 * The browser as a sentence for Jev and the reply writer; null when no extension is connected. Hosts only: a tab's
 * title is whatever its page wants it to be, and this line is in every routing prompt.
 */
export function describeBrowser(): string | null {
  if (!browserConnected()) return null;
  const current = currentBrowserTab();
  const host = (t: BrowserTab) => (/^[a-z0-9.-]{1,80}$/i.test(hostOf(t.url)) ? hostOf(t.url) : "a page");
  const others = [...new Set(tabs.filter((t) => t.id !== current?.id && !isOwnTab(t)).map(host))].slice(0, 6);
  const count = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
  const act = current ? ` The current tab is on ${host(current)}.` : "";
  const rest = others.length ? ` Other tabs: ${others.join(", ")}.` : "";
  return `The user's Chrome browser is connected to Trinity (${count}).${act}${rest}`;
}

/** Something the user shared from the browser (a page, a selection, a link, an image). */
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

function send(peer: Peer, msg: Record<string, unknown>): void {
  if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(JSON.stringify(msg));
}

function call<T>(id: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const peer = live;
  if (!peer || peer.ws.readyState !== peer.ws.OPEN) return Promise.reject(new Error("the browser extension isn't connected"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the browser didn't answer ${method} in time`));
    }, timeoutMs);
    pending.set(id, { method, peer, resolve: (v) => resolve(v as T), reject, timer });
    peer.ws.send(JSON.stringify({ type: "call", id, method, params }), (err) => {
      if (!err) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("the browser extension isn't connected"));
    });
  });
}

/** Run one extension method; rejects when the browser isn't connected, the call fails, or it takes too long. */
export function browserCall<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  if (method === "page.fill") return Promise.reject(new Error("page.fill only goes through browserSecretCall"));
  return call<T>(nanoid(10), method, params, timeoutMs);
}

/** The kinds of field a fill may name — the only words a fill result is allowed to carry. */
export const FILL_KINDS = [
  "username",
  "password",
  "otp",
  "email",
  "name",
  "given-name",
  "family-name",
  "tel",
  "street-address",
  "address-line1",
  "address-line2",
  "address-level2",
  "address-level1",
  "postal-code",
  "country",
  "bday",
  "organization",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-name",
] as const;
export type FillKind = (typeof FILL_KINDS)[number];
const FILL_KIND_SET: ReadonlySet<string> = new Set(FILL_KINDS);

/**
 * Why a fill didn't happen. From the extension: the page isn't the one the fill was for, has no fields for it, has
 * changed since it was looked at, isn't https, posts to another site, the envelope ran out — or ("scripted") Trinity
 * ran a script in that very document earlier, which could read what is typed there. The rest are the bridge's own.
 */
export type FillCode = "origin-mismatch" | "no-fields" | "gone" | "insecure" | "form-target" | "expired" | "scripted" | "not-connected" | "timeout" | "failed";
const EXTENSION_CODES: ReadonlySet<string> = new Set(["origin-mismatch", "no-fields", "gone", "insecure", "form-target", "expired", "scripted"]);

export type FillResult =
  | { ok: true; filled: FillKind[]; missing: FillKind[]; step: "done" | "next" | "otp"; frames: number }
  | { ok: false; code: FillCode };

export interface FillRequest {
  tabId: number;
  /** The document that was probed: the fill fails ("gone") if the tab has moved on. */
  documentId: string;
  /** The exact origin the values are for ("https://www.netflix.com"). */
  origin: string;
  /** field kind → value. Secrets: they exist here only for the moment of sealing. */
  values: Record<string, string>;
}

const kindList = (v: unknown): FillKind[] => (Array.isArray(v) ? [...new Set(v.filter((k): k is FillKind => typeof k === "string" && FILL_KIND_SET.has(k)))] : []);

/**
 * A call that carries secrets: only "page.fill". The values are sealed with this connection's key (AES-256-GCM, a fresh
 * IV, bound to the call id, the method, the origin and the tab, good for ten seconds), nothing is logged, every failure
 * becomes one of a few fixed codes, and only field kinds come back — never a value, never the extension's own words.
 */
export async function browserSecretCall(method: "page.fill", req: FillRequest): Promise<FillResult> {
  if (method !== "page.fill") throw new Error("only page.fill carries secrets");
  const peer = live;
  if (!peer || !peer.session || peer.ws.readyState !== peer.ws.OPEN) return { ok: false, code: "not-connected" };
  let origin: URL;
  try {
    origin = new URL(req.origin);
  } catch {
    return { ok: false, code: "origin-mismatch" };
  }
  if (origin.origin !== req.origin) return { ok: false, code: "origin-mismatch" };
  if (origin.protocol !== "https:") return { ok: false, code: "insecure" };
  const id = nanoid(12);
  const plain = utf8(JSON.stringify({ values: req.values, expires: Date.now() + FILL_TTL_MS }));
  const iv = view(crypto.randomBytes(12));
  const cipher = crypto.createCipheriv("aes-256-gcm", peer.session, iv);
  cipher.setAAD(utf8(`${id}|page.fill|${req.origin}|${req.tabId}`));
  // The ciphertext with its tag at the end: the shape WebCrypto's AES-GCM opens.
  const ct = Buffer.concat([view(cipher.update(plain)), view(cipher.final()), view(cipher.getAuthTag())]);
  plain.fill(0);
  let raw: unknown;
  try {
    raw = await call<unknown>(id, "page.fill", { tabId: req.tabId, documentId: req.documentId, origin: req.origin, sealed: { iv: b64(iv), ct: b64(ct) } }, FILL_TTL_MS);
  } catch (err) {
    // The reason is turned into a code and dropped: an error's text is never passed on from here.
    const why = (err as Error).message;
    return { ok: false, code: /isn't connected|disconnected|reconnected/.test(why) ? "not-connected" : /in time/.test(why) ? "timeout" : "failed" };
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.ok === true) {
    const step = r.step === "next" || r.step === "otp" ? r.step : "done";
    return { ok: true, filled: kindList(r.filled), missing: kindList(r.missing), step, frames: typeof r.frames === "number" && r.frames > 0 ? Math.min(99, Math.floor(r.frames)) : 0 };
  }
  const given = typeof r.code === "string" ? r.code : "";
  return { ok: false, code: EXTENSION_CODES.has(given) ? (given as FillCode) : "failed" };
}

function failPending(peer: Peer, reason: string): void {
  for (const [id, p] of pending) {
    if (p.peer !== peer) continue;
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

// ─── The socket: pairing, the handshake, then messages ────────────────────────

/** Close a socket for good: nothing it sends afterwards counts. */
function drop(peer: Peer, closeCode: number, why: string): void {
  const wasLive = live === peer;
  peer.phase = "dead";
  peer.key = null;
  peer.session = null;
  if (peer.timer) clearTimeout(peer.timer);
  peer.timer = null;
  peers.delete(peer);
  if (wasLive) {
    live = null;
    info = null;
    tabs = [];
  }
  failPending(peer, closeCode === 4409 ? "the browser extension reconnected" : "the browser extension disconnected");
  try {
    if (peer.ws.readyState === peer.ws.OPEN || peer.ws.readyState === peer.ws.CONNECTING) peer.ws.close(closeCode, why);
  } catch {
    /* already gone */
  }
  if (wasLive) changed();
}

function onPair(peer: Peer, msg: Record<string, unknown>): void {
  const c = liveCode();
  if (!c) return drop(peer, 4401, "no pairing code");
  c.tries++;
  const pub = bytes(msg.pub, 65);
  const pubText = String(msg.pub);
  const ok = pub !== null && pub[0] === 4 && macMatches(msg.mac, hmac(c.value, `trinity-pair-v2|${pubText}`));
  if (!ok) {
    console.warn(`[browser] pairing refused: wrong code (${Math.max(0, CODE_TRIES - c.tries)} tries left)`);
    return drop(peer, 4401, "wrong code");
  }
  const p = loadPairing();
  // The right code, but the id must be the one Chrome put in the Origin header, and the key a point on the curve.
  if (msg.id !== peer.originId || deriveLinkKey(p.engine.privateKey, pubText) === null) return drop(peer, 4401, "bad pairing request");
  const mac = hmac(c.value, `trinity-paired-v2|${p.engine.publicKey}|${pubText}`);
  code = null; // one use
  p.extension = { id: peer.originId, publicKey: pubText, pairedAt: Date.now() };
  linkKey = null;
  try {
    savePairing();
  } catch (err) {
    console.warn("[browser] couldn't save the pairing:", (err as Error).message);
  }
  // Whoever held the link was paired with the old key.
  if (live && live !== peer) drop(live, 4401, "paired again");
  console.log(`[browser] paired with extension ${peer.originId.slice(0, 8)}…`);
  send(peer, { type: "paired", pub: p.engine.publicKey, mac: b64(mac) });
}

function onHello(peer: Peer, msg: Record<string, unknown>): void {
  const p = loadPairing();
  const key = currentLinkKey();
  if (!p.extension || !key || msg.id !== p.extension.id || peer.originId !== p.extension.id) return drop(peer, 4401, "not paired");
  if (!bytes(msg.nonce, 16)) return drop(peer, 4400, "bad hello");
  peer.nE = String(msg.nonce);
  peer.nS = crypto.randomBytes(16).toString("base64");
  peer.key = key;
  peer.phase = "challenged";
  send(peer, { type: "challenge", nonce: peer.nS, proof: b64(hmac(key, `engine|${peer.nE}|${peer.nS}`)) });
}

function onAuth(peer: Peer, msg: Record<string, unknown>): void {
  const key = peer.key;
  // The pairing may have changed since this socket said hello: the proof must be for the key that is paired now.
  if (!key || key !== currentLinkKey() || !macMatches(msg.proof, hmac(key, `ext|${peer.nS}|${peer.nE}`))) {
    console.warn("[browser] an extension couldn't prove the pairing key");
    return drop(peer, 4401, "bad proof");
  }
  // Proved. A newer proved socket takes the place of the older one; the older one's messages no longer count.
  if (live && live !== peer) {
    console.log("[browser] the extension connected again; the earlier link is dropped");
    drop(live, 4409, "replaced");
  }
  if (peer.timer) clearTimeout(peer.timer);
  peer.timer = null;
  peer.session = new Uint8Array(crypto.hkdfSync("sha256", key, utf8(peer.nE + peer.nS), utf8("session"), 32));
  peer.phase = "live";
  peer.awaitingPong = false;
  live = peer;
  since = Date.now();
  const caps = (msg.caps && typeof msg.caps === "object" ? msg.caps : {}) as Record<string, unknown>;
  info = { version: str(msg.version, 24), chrome: str(msg.chrome, 24), caps: { userScripts: caps.userScripts === true, pageCapture: caps.pageCapture === true, fill: caps.fill === true } };
  // Trinity's own origins ride along, so the extension can refuse to touch her pages whatever it is asked.
  send(peer, { type: "welcome", engine: "trinity", protocol: 2, own: [...allowedOrigins()] });
  console.log(`[browser] extension connected: v${info.version} on Chrome ${info.chrome}${info.caps.userScripts ? ", user scripts on" : ""}`);
  setTabs(msg.tabs);
}

function onMessage(peer: Peer, data: unknown, isBinary: boolean): void {
  if (peer.phase === "dead") return; // a replaced or refused socket: nothing it says counts
  if (isBinary) return drop(peer, 4400, "text frames only");
  const text = String(data);
  if (peer.phase !== "live" && text.length > MAX_UNPROVED_FRAME) return drop(peer, 4400, "too large");
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (peer.phase !== "live") drop(peer, 4400, "not json");
    return;
  }
  if (!msg || typeof msg !== "object") return;
  switch (peer.phase) {
    case "open":
      if (msg.type === "pair") return onPair(peer, msg);
      if (msg.type === "hello") return onHello(peer, msg);
      return drop(peer, 4400, "expected hello");
    case "challenged":
      if (msg.type === "auth") return onAuth(peer, msg);
      return drop(peer, 4400, "expected auth");
    case "live":
      break;
  }
  if (peer !== live) return;
  switch (msg.type) {
    case "tabs":
      setTabs(msg.tabs);
      return;
    case "pong":
      peer.awaitingPong = false;
      return;
    case "share":
      share(msg);
      return;
    case "result": {
      const p = pending.get(String(msg.id));
      if (!p || p.peer !== peer) return;
      pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(str(msg.error, 300) || `${p.method} failed in the browser`));
      else p.resolve(msg.result);
      return;
    }
    default:
      return;
  }
}

/** May a socket with this Origin header try /ext at all? Only the paired extension — or any extension while a code waits. */
export function extensionOriginAllowed(origin: string | undefined): boolean {
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? "");
  if (!m) return false;
  const p = loadPairing();
  if (p.extension && p.extension.id === m[1]) return true;
  return liveCode() !== null;
}

/** The /ext upgrade: the Origin gate, then a socket that must pair or prove the pairing key within a few seconds. */
export function handleBrowserUpgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!extensionOriginAllowed(origin)) {
    sock.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    sock.destroy();
    return;
  }
  // Sockets that haven't proved anything are few and short-lived: the oldest makes room, so idle ones can't shut the
  // real extension out.
  const waiting = [...peers].filter((p) => p.phase !== "live");
  while (waiting.length >= MAX_UNPROVED_PEERS) drop(waiting.shift()!, 4408, "too many waiting");
  const originId = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? "")![1]!;
  wss.handleUpgrade(req, sock, head, (ws) => {
    const peer: Peer = { ws, originId, phase: "open", nE: "", nS: "", key: null, session: null, timer: null, awaitingPong: false };
    peers.add(peer);
    peer.timer = setTimeout(() => {
      if (peer.phase !== "live" && peer.phase !== "dead") drop(peer, 4408, "handshake timed out");
    }, HANDSHAKE_MS);
    ws.on("message", (data, isBinary) => {
      try {
        onMessage(peer, data, isBinary);
      } catch (err) {
        console.warn("[browser] a message from the extension failed:", (err as Error).message);
        if (peer.phase !== "live") drop(peer, 4400, "error");
      }
    });
    const gone = () => {
      if (peer.phase === "dead") return;
      const wasLive = live === peer;
      drop(peer, 1000, "closed");
      if (wasLive) console.log("[browser] extension disconnected");
    };
    ws.on("close", gone);
    ws.on("error", gone);
  });
}

// The extension's service worker stays alive while messages flow; a missed pong means it's gone.
safeInterval(
  "browser-ping",
  () => {
    const peer = live;
    if (!peer || peer.ws.readyState !== peer.ws.OPEN) return;
    if (peer.awaitingPong) {
      peer.ws.terminate();
      return;
    }
    peer.awaitingPong = true;
    send(peer, { type: "ping" });
  },
  PING_MS,
);
