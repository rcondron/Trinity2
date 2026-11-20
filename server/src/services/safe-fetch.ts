import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

/*
 * The one way the engine fetches a URL it didn't write itself: a picture a search result names, a media URL a
 * gateway hands back, anything a skill asks for (the sandbox has no network of its own: sandbox/host.ts does
 * its requests here). Rules, enforced in this process:
 *  - http and https only;
 *  - the host is resolved here and every address it resolves to must be public: loopback, link-local, private,
 *    unique-local, carrier-NAT, multicast and the documentation ranges are refused. The check runs inside the
 *    connection's own lookup, so the address checked is the address used, and the connected peer is checked again;
 *  - redirects are followed by hand, each hop through the same checks (a public URL can't bounce to localhost);
 *  - a time limit for the whole call and a size limit for the body (after decompression).
 * It never keeps a connection for a later call. The only way round the address rule is the test switch below
 * (an environment variable naming exact host:port pairs), which nothing at run time can set.
 */

export type SafeFetchCode = "url" | "scheme" | "private" | "dns" | "redirect" | "too_large" | "timeout" | "aborted" | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | Uint8Array | Buffer | null;
  /** Limit for the whole call: connecting, every redirect, the body. Default 10 s. */
  timeoutMs?: number;
  /** Largest body kept, after decompression. Default 5 MB. */
  maxBytes?: number;
  /** Redirect hops followed. Default 5. */
  maxRedirects?: number;
  /** "follow" (default), "manual" (hand the 3xx back) or "error". */
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
  /** The resolver (tests stand in for DNS with it). Default: the system resolver, every address. */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** An explicit exception to the private-range rule: tests reach their own local server with it. Never set from a request. */
  allowAddress?: (address: string, port: number) => boolean;
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  /** The URL the body came from (after redirects). */
  url: string;
  redirected: boolean;
  bytes: Buffer;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_REDIRECTS = 5;

// ─── Which addresses are public ───────────────────────────────────────────────────────────

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // "this network" (0.0.0.0 reaches localhost)
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback: the engine's own API lives here
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast, reserved, broadcast
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], // unspecified, loopback, and the retired IPv4-compatible range (::a.b.c.d)
  ["::ffff:0:0:0", 96], // IPv4-translated (a translator could carry it to a local IPv4 address)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 23], // protocol assignments (Teredo, ORCHID, benchmarking): no web host lives here
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (retired, still routed inside some networks)
  ["ff00::", 8], // multicast
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

/** The IPv4 address carried inside an IPv6 one (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16), else null. */
function embeddedV4(v6: string): string | null {
  let h: string;
  try {
    h = new URL(`http://[${v6}]/`).hostname.slice(1, -1).toLowerCase(); // the canonical spelling
  } catch {
    return null;
  }
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const tail = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (tail) return quad(parseInt(tail[1]!, 16), parseInt(tail[2]!, 16));
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(h);
  if (sixToFour) return quad(parseInt(sixToFour[1]!, 16), parseInt(sixToFour[2]!, 16));
  return null;
}

/** Whether an IP address is one a web fetch must not reach. Anything that isn't a plain IP address counts as private. */
export function isPrivateAddress(address: string): boolean {
  try {
    const family = net.isIP(address);
    if (family === 4) return blocked.check(address, "ipv4");
    if (family === 6) {
      const v4 = embeddedV4(address);
      return v4 ? blocked.check(v4, "ipv4") : blocked.check(address, "ipv6");
    }
  } catch {
    /* unparseable (a zone id, say): refused */
  }
  return true;
}

// ─── The test switch ──────────────────────────────────────────────────────────────────────

/**
 * TRINITY_FETCH_ALLOW="127.0.0.1:8123,[::1]:9000,fixtures.test:8080" exempts exactly those host:port pairs from
 * the private-address rule, so a test suite can serve its fixtures from its own local server. It is read from
 * the environment once, when this module loads: nothing in Settings, the API or a request can set or widen it.
 * An entry needs a port (a whole host is never exempt), and a warning is logged whenever the switch is on.
 */
function readAllowList(raw: string | undefined): Set<string> {
  const pairs = new Set<string>();
  const ignored: string[] = [];
  // The engine's own port is never exempt: the switch is for a suite's fixture server, not a way back to the API.
  const enginePort = Number(process.env.PORT) || 8799;
  for (const entry of (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(entry);
    const port = Number(m?.[2]);
    if (!m || !(port >= 1 && port <= 65_535) || port === enginePort) {
      ignored.push(entry);
      continue;
    }
    pairs.add(`${m[1]!.toLowerCase().replace(/^\[(.*)\]$/, "$1")}:${port}`);
  }
  if (ignored.length) console.warn(`[safe-fetch] TRINITY_FETCH_ALLOW: ignored ${ignored.map((e) => JSON.stringify(e.slice(0, 60))).join(", ")} (each entry must be host:port, and never the engine's own port)`);
  if (pairs.size)
    console.warn(`[safe-fetch] TRINITY_FETCH_ALLOW is set: the private-address rule is OFF for ${[...pairs].join(", ")}. This is a test switch; unset it for normal use.`);
  return pairs;
}
const ENV_ALLOWED: ReadonlySet<string> = readAllowList(process.env.TRINITY_FETCH_ALLOW);

/** Whether the test switch exempts this host (a name or an address, as written or as resolved) on this port. */
export function allowedByTestSwitch(host: string, port: number): boolean {
  return ENV_ALLOWED.size > 0 && ENV_ALLOWED.has(`${host.toLowerCase().replace(/^\[(.*)\]$/, "$1")}:${port}`);
}

const systemLookup = (hostname: string): Promise<ResolvedAddress[]> =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/** A URL's host without the brackets an IPv6 literal carries. */
const bareHost = (u: URL) => u.hostname.replace(/^\[(.*)\]$/, "$1");

/**
 * Resolve a host and check every address: all of them must be public (a name with one private address among
 * public ones is refused, since which one gets used isn't ours to choose). Throws SafeFetchError.
 */
export async function resolvePublic(hostname: string, port: number, opts: Pick<SafeFetchOptions, "lookup" | "allowAddress"> = {}): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  const ok = (address: string) => !isPrivateAddress(address) || opts.allowAddress?.(address, port) === true || allowedByTestSwitch(address, port) || allowedByTestSwitch(host, port);
  if (net.isIP(host)) {
    if (!ok(host)) throw new SafeFetchError("private", `${host} is a private or local address`);
    return [{ address: host, family: net.isIP(host) }];
  }
  let list: ResolvedAddress[];
  try {
    list = await (opts.lookup ?? systemLookup)(host);
  } catch (err) {
    throw new SafeFetchError("dns", `${host} could not be resolved (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  if (!Array.isArray(list) || list.length === 0) throw new SafeFetchError("dns", `${host} has no address`);
  const bad = list.find((a) => !ok(a.address));
  if (bad) throw new SafeFetchError("private", `${host} resolves to a private or local address (${bad.address})`);
  return list;
}

// ─── One request ──────────────────────────────────────────────────────────────────────────

interface Hop {
  status: number;
  statusText: string;
  raw: string[];
  body: Buffer;
}

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "proxy-connection", "expect"]);

function headerPairs(h: SafeFetchOptions["headers"]): [string, string][] {
  const pairs = Array.isArray(h) ? h : Object.entries(h ?? {});
  return pairs
    .filter(([k, v]) => typeof k === "string" && typeof v === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) && !/[\r\n\0]/.test(v))
    .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    .filter(([k]) => !HOP_BY_HOP.has(k));
}

function requestOnce(u: URL, method: string, headers: [string, string][], body: Buffer | null, opts: SafeFetchOptions, signal: AbortSignal, maxBytes: number, wantBody: boolean): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const fail = (err: unknown) => reject(err instanceof SafeFetchError ? err : new SafeFetchError("network", (err as Error)?.message || "the request failed"));
    // The connection's own lookup: the addresses checked are the addresses used.
    const lookup = (hostname: string, options: unknown, callback?: unknown) => {
      const cb = (typeof options === "function" ? options : callback) as (err: Error | null, address?: string | ResolvedAddress[], family?: number) => void;
      const o = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean; family?: number };
      resolvePublic(hostname, port, opts).then(
        (list) => {
          const fit = o.family === 4 || o.family === 6 ? list.filter((a) => a.family === o.family) : list;
          const use = fit.length ? fit : list;
          if (o.all) cb(null, use);
          else cb(null, use[0]!.address, use[0]!.family);
        },
        (err: Error) => cb(err),
      );
    };
    const out: Record<string, string> = { "user-agent": "node", accept: "*/*", "accept-encoding": "gzip, deflate, br" };
    for (const [k, v] of headers) out[k] = v;
    if (body) out["content-length"] = String(body.length);
    let req: http.ClientRequest;
    try {
      req = (u.protocol === "https:" ? https : http).request(u, { method, headers: out, agent: false, lookup: lookup as net.LookupFunction, signal });
    } catch (err) {
      return fail(err);
    }
    req.on("socket", (socket) => {
      // Belt and braces: whatever the lookup said, the peer actually connected to must be public too.
      const check = () => {
        const peer = socket.remoteAddress;
        const excepted = peer !== undefined && (opts.allowAddress?.(peer, port) === true || allowedByTestSwitch(peer, port) || allowedByTestSwitch(u.hostname, port));
        if (peer && isPrivateAddress(peer) && !excepted) req.destroy(new SafeFetchError("private", `${u.hostname} connected to a private or local address (${peer})`));
      };
      if (socket.connecting) socket.once("connect", check);
      else check();
    });
    req.on("error", (err) => fail(signal.aborted && signal.reason instanceof SafeFetchError ? signal.reason : err));
    req.on("response", (res) => {
      const done = (bytes: Buffer) => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", raw: res.rawHeaders, body: bytes });
      if (!wantBody || method === "HEAD" || res.statusCode === 204 || res.statusCode === 304) {
        res.resume();
        return done(Buffer.alloc(0));
      }
      const declared = Number(res.headers["content-length"]);
      const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
      if (!encoding && Number.isFinite(declared) && declared > maxBytes) {
        req.destroy();
        return fail(new SafeFetchError("too_large", `the response is larger than ${maxBytes} bytes`));
      }
      let stream: Readable = res;
      if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          stream.destroy();
          fail(new SafeFetchError("too_large", `the response is larger than ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => {
        const whole = Buffer.allocUnsafe(size);
        let at = 0;
        for (const chunk of chunks) at += chunk.copy(whole, at);
        done(whole);
      });
      stream.on("error", (err) => fail(signal.aborted && signal.reason instanceof SafeFetchError ? signal.reason : err));
      res.on("error", (err) => fail(signal.aborted && signal.reason instanceof SafeFetchError ? signal.reason : err));
    });
    req.end(body ?? undefined);
  });
}

/**
 * Fetch a URL under the rules above. Resolves with the response (any status); throws SafeFetchError when the
 * URL isn't allowed, a hop leads somewhere private, the body is too large, or the call ran out of time.
 */
export async function safeFetch(url: string | URL, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new SafeFetchError("url", "that is not a URL");
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_REDIRECTS;
  const mode = opts.redirect ?? "follow";
  let method = (opts.method ?? "GET").toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new SafeFetchError("url", `the method ${method.slice(0, 12)} isn't allowed`);
  let headers = headerPairs(opts.headers);
  let body: Buffer | null = opts.body === undefined || opts.body === null ? null : Buffer.from(opts.body as string);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new SafeFetchError("timeout", "the request took too long")), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ac.abort(new SafeFetchError("aborted", "the request was cancelled"));
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (let hop = 0; ; hop++) {
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new SafeFetchError("scheme", `only http and https URLs can be fetched (not ${u.protocol})`);
      if (u.username || u.password) throw new SafeFetchError("url", "URLs that carry a user name or password aren't fetched");
      if (ac.signal.aborted) throw ac.signal.reason;
      // (A literal address is checked here: the connection asks no resolver about it. A name is checked in the lookup.)
      const host = bareHost(u);
      if (net.isIP(host)) await resolvePublic(host, Number(u.port) || (u.protocol === "https:" ? 443 : 80), opts);
      const res = await requestOnce(u, method, headers, body, opts, ac.signal, maxBytes, true);
      const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? headerOf(res.raw, "location") : null;
      if (location && mode !== "manual") {
        if (mode === "error") throw new SafeFetchError("redirect", "the URL redirects, and redirects aren't followed here");
        if (hop >= maxRedirects) throw new SafeFetchError("redirect", `more than ${maxRedirects} redirects`);
        let next: URL;
        try {
          next = new URL(location, u);
        } catch {
          throw new SafeFetchError("redirect", "the redirect doesn't lead to a URL");
        }
        // As a browser does: 303 (and a POST sent on by 301/302) becomes a GET without its body; credentials stay with the host they were for.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = null;
          headers = headers.filter(([k]) => !k.startsWith("content-"));
        }
        if (next.host !== u.host) headers = headers.filter(([k]) => k !== "authorization" && k !== "cookie");
        u = next;
        continue;
      }
      return response(res, u.href, hop > 0);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function headerOf(raw: string[], name: string): string | null {
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) return raw[i + 1]!;
  return null;
}

function response(hop: Hop, url: string, redirected: boolean): SafeResponse {
  const headers = new Headers();
  for (let i = 0; i + 1 < hop.raw.length; i += 2) {
    try {
      headers.append(hop.raw[i]!, hop.raw[i + 1]!);
    } catch {
      /* a header name the Headers class refuses: left out */
    }
  }
  // (The body is handed over decoded.)
  headers.delete("content-encoding");
  headers.delete("content-length");
  const bytes = hop.body;
  return {
    ok: hop.status >= 200 && hop.status < 300,
    status: hop.status,
    statusText: hop.statusText,
    headers,
    url,
    redirected,
    bytes,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    text: async () => bytes.toString("utf8"),
    json: async () => JSON.parse(bytes.toString("utf8")) as unknown,
  };
}
