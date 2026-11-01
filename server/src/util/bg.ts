import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Fire-and-forget safely. Node 24 terminates the process on an unhandled rejection,
 * which would drop the live call and every workspace window — so every background
 * promise goes through here and only logs on failure.
 */
export function bg(label: string, work: Promise<unknown> | (() => unknown)): void {
  let p: Promise<unknown>;
  try {
    p = typeof work === "function" ? Promise.resolve(work()) : work;
  } catch (err) {
    p = Promise.reject(err);
  }
  p.catch((err: unknown) => console.warn(`[${label}]`, err instanceof Error ? err.message : err));
}

/** setInterval whose body can't throw out of the timer (sync or async). */
export function safeInterval(label: string, fn: () => unknown, ms: number): ReturnType<typeof setInterval> {
  return setInterval(() => bg(label, fn), ms);
}

/** Express 4 doesn't catch rejected async handlers — route them to the error middleware. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}

/** Lowercase, IPv6 without brackets: "[::1]" → "::1". */
function bareHostname(name: string): string {
  return name.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/** Loopback, plus ALLOWED_HOSTS (comma-separated hostnames or IPs, e.g. for LAN use with HOST=0.0.0.0). */
function allowedHostnames(): Set<string> {
  const extra = (process.env.ALLOWED_HOSTS ?? "").split(",").map(bareHostname).filter(Boolean);
  return new Set(["localhost", "127.0.0.1", "::1", ...extra]);
}

/** Browser origins allowed to talk to the engine (the Vite app and the engine itself, on loopback). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (CLI tools, tests) send no Origin
  try {
    return allowedHostnames().has(bareHostname(new URL(origin).hostname));
  } catch {
    return false;
  }
}

/** "name" or "name:port", where name is a hostname, an IPv4 address, or a bracketed IPv6 address. */
const HOST_HEADER_RE = /^(\[[0-9a-f:.]+\]|[^\s:/?#@[\]]+)(?::\d{1,5})?$/i;

/**
 * Whether a request's Host header names this machine (any port: the Vite proxy keeps the browser's
 * "localhost:5173"). A DNS-rebinding page reaches the engine under its own hostname — same-origin, so
 * the origin checks don't stop its GETs — and this refuses it.
 */
export function isAllowedHost(host: string | undefined): boolean {
  const m = HOST_HEADER_RE.exec(host ?? "");
  return m !== null && allowedHostnames().has(bareHostname(m[1] ?? ""));
}
