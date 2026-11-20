import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { DATA_DIR } from "./config.js";
import { readOrCreateProxyKey } from "./proxy-key.js";

/**
 * Who may talk to the engine.
 *
 * Listening on loopback is not a lock: a page served from any other port on this machine, and any local program, can
 * reach it — and what they could do (send words as the user, read memories, drive the browser, and now ask the vault to
 * fill a login) is everything. So every HTTP request and every socket shows one of two things:
 *
 *  - A linked browser: the session cookie this engine gave that browser (HttpOnly, so no page script can read it;
 *    SameSite=Strict), together with proof that the request comes from one of the app's own pages — an Origin header on
 *    the exact allow-list, or, for requests browsers send without one, Sec-Fetch-Site "none" (the user opened the address
 *    themselves) or "same-origin" with a Referer on the allow-list. Browsers set those headers themselves: a page on
 *    another port can't forge them, and a program that forges them has no cookie.
 *  - The API key (Authorization: Bearer …), for scripts and tests: kept in data/auth.json, or given as TRINITY_API_KEY.
 *
 * The first browser to open the app is linked at once (there is nobody to ask yet). Every later one needs the six-digit
 * pairing code: printed when the engine starts, and shown fresh in Settings on a browser that's already linked.
 * The Chrome extension pairs separately (services/browser-bridge.ts).
 *
 * Not covered, by design: a program running as this Windows user that reads data/auth.json, or a local server the user
 * visits that relays their cookie (cookies on localhost ignore ports). Such a program can already read the keyboard.
 *
 * TRINITY_AUTH=off switches the checks off (debugging). The vault stays locked while they are off.
 */

const FILE = path.join(DATA_DIR, "auth.json");
const COOKIE = "trinity_session";
const COOKIE_MAX_AGE_S = 400 * 24 * 3600; // browsers cap cookie lifetimes at 400 days
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
const SEEN_SAVE_MS = 6 * 3600_000; // "last seen" is written at most this often

export interface LinkedBrowser {
  id: string;
  /** SHA-256 of the session token (the token itself lives only in that browser's cookie). */
  hash: string;
  createdAt: number;
  lastSeenAt: number;
  /** What the browser called itself when it was linked, for the list in Settings. */
  agent: string;
}

interface AuthFile {
  apiKey: string;
  browsers: LinkedBrowser[];
  /** A browser has been linked here before: from then on every link needs the code, even with none linked now. */
  linkedOnce?: boolean;
}

let state: AuthFile | null = null;

function load(): AuthFile {
  if (state) return state;
  let text: string | null = null;
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch {
    text = null; // no file: a fresh start (the first browser links freely)
  }
  if (text === null) {
    state = { apiKey: crypto.randomBytes(32).toString("base64url"), browsers: [] };
    save();
    return state;
  }
  try {
    const raw = JSON.parse(text) as Partial<AuthFile>;
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    const browsers = Array.isArray(raw.browsers) ? raw.browsers.filter((b) => b && typeof b.id === "string" && typeof b.hash === "string") : [];
    state = {
      apiKey: typeof raw.apiKey === "string" && raw.apiKey.length >= 32 ? raw.apiKey : crypto.randomBytes(32).toString("base64url"),
      browsers,
      linkedOnce: raw.linkedOnce === true || browsers.length > 0,
    };
    if (state.apiKey !== raw.apiKey || state.linkedOnce !== raw.linkedOnce) save();
  } catch {
    // Damaged: kept aside for a look, and nothing links freely because of it — every browser needs the code again.
    try {
      fs.renameSync(FILE, `${FILE}.damaged-${Date.now()}`);
    } catch {
      /* it stays; it is overwritten below */
    }
    console.warn("[auth] auth.json couldn't be read: it was kept aside, and every browser must be linked again with the pairing code");
    state = { apiKey: crypto.randomBytes(32).toString("base64url"), browsers: [], linkedOnce: true };
    save();
  }
  return state;
}

function save(): void {
  if (!state) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn("[auth] couldn't save auth.json:", (err as Error).message);
  }
}

export function authOn(): boolean {
  return process.env.TRINITY_AUTH !== "off";
}

/** The key scripts send as "Authorization: Bearer …". */
export function apiKey(): string {
  return process.env.TRINITY_API_KEY || load().apiKey;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Constant-time comparison of two strings (by their SHA-256, so lengths don't matter). */
function safeEqual(a: string, b: string): boolean {
  const x = new Uint8Array(crypto.createHash("sha256").update(a).digest());
  const y = new Uint8Array(crypto.createHash("sha256").update(b).digest());
  return crypto.timingSafeEqual(x, y);
}

/**
 * The app's own origins, exactly: the Vite app and the engine, on localhost and 127.0.0.1, plus TRINITY_ORIGINS
 * (comma-separated, e.g. "http://192.168.1.20:5173" for LAN use).
 */
export function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  // The app's pages (Vite). Not the engine's own address: it serves no pages.
  for (const host of ["localhost", "127.0.0.1"]) out.add(`http://${host}:${Number(process.env.WEB_PORT) || 5173}`);
  for (const raw of (process.env.TRINITY_ORIGINS ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    // Only a web origin of its own: "mypc:5173" or "file:///…" would add "null", the origin of every sandboxed frame.
    let origin = "null";
    try {
      const u = new URL(entry);
      if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
    } catch {
      /* not a URL */
    }
    if (origin === "null") {
      if (!warnedOrigins.has(entry)) {
        warnedOrigins.add(entry);
        console.warn(`[auth] TRINITY_ORIGINS: "${entry}" is not an http(s) origin such as http://192.168.1.20:5173 — ignored`);
      }
      continue;
    }
    out.add(origin);
  }
  return out;
}
const warnedOrigins = new Set<string>();

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The request comes from one of the app's own pages, by headers only a browser sets (see the module comment). `method`
 * is the HTTP method (a socket upgrade is a GET): an address typed into the browser is only ever a GET.
 */
export function fromApp(headers: IncomingHttpHeaders, method = "GET"): boolean {
  const allowed = allowedOrigins();
  const origin = one(headers.origin);
  if (origin !== undefined) return allowed.has(origin);
  const site = one(headers["sec-fetch-site"]);
  if (site === "none") return method === "GET" || method === "HEAD";
  const referer = originOf(one(headers.referer));
  return site === "same-origin" && referer !== null && allowed.has(referer);
}

let proxyKeyCache: string | null = null;
/** The secret Trinity's own web server adds to what it passes on (proxy-key.ts). Made at start if it isn't there. */
export function proxyKey(): string {
  return (proxyKeyCache ??= readOrCreateProxyKey(DATA_DIR));
}

/** The request came through Trinity's own web server (its proxy added the secret), not straight from some page. */
export function viaAppProxy(headers: IncomingHttpHeaders): boolean {
  const given = one(headers["x-trinity-proxy"]);
  return typeof given === "string" && given.length > 0 && safeEqual(given, proxyKey());
}

/** Every trinity_session value the browser sent (a page on another port can plant one that is sent first). */
function sessionCookies(headers: IncomingHttpHeaders): string[] {
  const out: string[] = [];
  for (const part of (one(headers.cookie) ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) out.push(part.slice(i + 1).trim());
  }
  return out.slice(0, 8);
}

/** The linked browser one of the request's session cookies belongs to. */
function linkedFrom(headers: IncomingHttpHeaders): LinkedBrowser | null {
  for (const session of sessionCookies(headers)) {
    const b = browserFor(session);
    if (b) return b;
  }
  return null;
}

function browserFor(session: string | null): LinkedBrowser | null {
  if (!session) return null;
  const dot = session.indexOf(".");
  if (dot <= 0) return null;
  const b = load().browsers.find((x) => x.id === session.slice(0, dot));
  if (!b) return null;
  const hash = crypto.createHash("sha256").update(session.slice(dot + 1)).digest("hex");
  return safeEqual(hash, b.hash) ? b : null;
}

/** May this request (or socket upgrade) use the engine? */
export function authenticate(headers: IncomingHttpHeaders, method = "GET"): boolean {
  if (!authOn()) return true;
  const key = /^Bearer\s+(\S+)$/i.exec(one(headers.authorization) ?? "")?.[1] ?? one(headers["x-trinity-key"]);
  if (key) return safeEqual(key, apiKey());
  const b = linkedFrom(headers);
  if (!b || !fromApp(headers, method) || !viaAppProxy(headers)) return false;
  const now = Date.now();
  if (now - b.lastSeenAt > SEEN_SAVE_MS) {
    b.lastSeenAt = now;
    save();
  }
  return true;
}

// ── pairing code ─────────────────────────────────────────────────────────────

let code: { value: string; until: number; tries: number } | null = null;

/** The current six-digit code for linking another browser (a fresh one when the last expired or was used up). */
export function pairingCode(): { code: string; expiresAt: number } {
  if (!code || Date.now() > code.until || code.tries >= CODE_TRIES)
    code = { value: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), until: Date.now() + CODE_TTL_MS, tries: 0 };
  return { code: code.value, expiresAt: code.until };
}

function codeMatches(given: string): boolean {
  if (!code || Date.now() > code.until || code.tries >= CODE_TRIES) return false;
  code.tries++;
  if (!safeEqual(given.replace(/\D/g, ""), code.value)) return false;
  code = null; // one use
  return true;
}

// ── linking ──────────────────────────────────────────────────────────────────

export type Enrolled = { ok: true; cookie: string } | { ok: false; status: number; error: string };

/**
 * Link the browser that sent this request: the first one freely, a later one with the pairing code. Only from the app's
 * own pages (an exact Origin — every browser sends one on a POST).
 */
export function enroll(headers: IncomingHttpHeaders, given?: string): Enrolled {
  const origin = one(headers.origin);
  if (origin === undefined || !allowedOrigins().has(origin) || !viaAppProxy(headers)) return { ok: false, status: 403, error: "forbidden origin" };
  const s = load();
  if ((s.browsers.length > 0 || s.linkedOnce) && !(given && codeMatches(String(given)))) {
    return { ok: false, status: 403, error: given ? "wrong-code" : "pairing-required" };
  }
  s.linkedOnce = true;
  const id = crypto.randomBytes(9).toString("base64url");
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  s.browsers.push({
    id,
    hash: crypto.createHash("sha256").update(token).digest("hex"),
    createdAt: now,
    lastSeenAt: now,
    agent: (one(headers["user-agent"]) ?? "").slice(0, 160),
  });
  if (s.browsers.length > 20) s.browsers.splice(0, s.browsers.length - 20);
  save();
  return { ok: true, cookie: `${COOKIE}=${id}.${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}` };
}

export function linkedBrowsers(): Omit<LinkedBrowser, "hash">[] {
  return load().browsers.map(({ hash: _hash, ...rest }) => rest);
}

/** Unlink a browser (its cookie stops working). Returns whether it was linked. */
export function unlinkBrowser(id: string): boolean {
  const s = load();
  const i = s.browsers.findIndex((b) => b.id === id);
  if (i < 0) return false;
  s.browsers.splice(i, 1);
  save();
  return true;
}

/** What the engine prints when it starts. */
export function authBanner(): string {
  if (!authOn()) return "auth: OFF (TRINITY_AUTH=off) — anything on this machine can use the engine; the vault stays locked";
  proxyKey(); // made now, so the web server finds it when it starts
  const n = load().browsers.length;
  if (n === 0 && !load().linkedOnce) return "auth: the first browser to open the app is linked automatically";
  const { code: c } = pairingCode();
  return `auth: ${n} linked browser${n === 1 ? "" : "s"}; to link another, enter ${c.slice(0, 3)} ${c.slice(3)} there (valid 10 minutes)`;
}

// ── Express ──────────────────────────────────────────────────────────────────

/** Routes that need no session: is this browser linked, and link it. Mounted before the guard. */
export function authRouter(): Router {
  const r = express.Router();
  r.get("/auth/status", (req, res) => {
    const linked = !authOn() || (linkedFrom(req.headers) !== null && fromApp(req.headers, req.method) && viaAppProxy(req.headers));
    res.json({ auth: authOn() ? "on" : "off", linked, needsCode: authOn() && !linked && (load().browsers.length > 0 || load().linkedOnce === true) });
  });
  r.post("/auth/enroll", express.json({ limit: "2kb" }), (req, res) => {
    if (!authOn()) return res.json({ ok: true });
    const out = enroll(req.headers, typeof req.body?.code === "string" ? req.body.code : undefined);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.setHeader("Set-Cookie", out.cookie);
    res.json({ ok: true });
  });
  return r;
}

/** Everything after this needs a linked browser or the API key. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (authenticate(req.headers, req.method)) return next();
  res.status(401).json({ error: "unauthorized", enroll: true });
}

/** Linked-browser management, for Settings (behind the guard). */
export function authAdminRouter(): Router {
  const r = express.Router();
  r.get("/auth/browsers", (_req, res) => res.json({ browsers: linkedBrowsers() }));
  r.post("/auth/code", (_req, res) => res.json(pairingCode()));
  r.delete("/auth/browsers/:id", (req, res) => {
    if (!unlinkBrowser(String(req.params.id))) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });
  return r;
}
