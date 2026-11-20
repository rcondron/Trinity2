// The skill sandbox and the safe fetcher, against local test servers: the known ways past the old in-realm network
// guard (replacing Array.prototype.some, RegExp.prototype.test, Function.prototype.call; process._getActiveHandles; a
// name that resolves to 127.0.0.1) must not reach a local server — with the built-ins frozen as the sandbox runs them,
// and again with that flag taken away, when the replacements do take effect — a skill's ordinary fetch must still
// work, and the shared fetcher must refuse loopback, a redirect to loopback, private-range literals and an oversized body.
//   node_modules/.bin/tsx scripts/test-sandbox.mts
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { REPO, check, finish, imp, sleep, testEnv } from "./test-env.mts";

const DIR = testEnv("test-sandbox");
const { runSkill, describeSkill, sandboxArgs } = await imp("sandbox/host.ts");
const { safeFetch, isPrivateAddress, SafeFetchError } = await imp("services/safe-fetch.ts");
const { cacheRemoteImage } = await imp("services/remote-images.ts");

// ── two local servers: SECRET stands for the engine's own API (must never be reached); PUBLIC stands for a public
// web API (reached only through the test's explicit exception) ──
const secretHits: string[] = [];
const secret = http.createServer((req, res) => {
  secretHits.push(`${req.method} ${req.url}`);
  res.end("TOP-SECRET");
});
await new Promise<void>((r) => secret.listen(0, "127.0.0.1", r));
const SECRET_PORT = (secret.address() as { port: number }).port;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const publicHits: string[] = [];
const pub = http.createServer((req, res) => {
  publicHits.push(`${req.method} ${req.url}`);
  const url = req.url ?? "/";
  if (url === "/data") {
    res.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
    return res.end(JSON.stringify({ rate: 0.92, host: req.headers.host, ua: req.headers["user-agent"] }));
  }
  if (url === "/echo") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, body, type: req.headers["content-type"] }));
    });
  }
  if (url === "/hop") {
    res.writeHead(302, { location: "/data" });
    return res.end();
  }
  if (url === "/to-secret") {
    res.writeHead(302, { location: `http://127.0.0.1:${SECRET_PORT}/redirected` });
    return res.end();
  }
  if (url === "/to-secret-name") {
    res.writeHead(307, { location: `http://rebind.example.test:${SECRET_PORT}/redirected-name` });
    return res.end();
  }
  if (url === "/big") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(2 * 1024 * 1024) });
    return res.end(Buffer.alloc(2 * 1024 * 1024, 65));
  }
  if (url === "/big-chunked") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    for (let i = 0; i < 32; i++) res.write(Buffer.alloc(64 * 1024, 66));
    return res.end();
  }
  if (url === "/huge") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    for (let i = 0; i < 96; i++) res.write(Buffer.alloc(64 * 1024, 67));
    return res.end();
  }
  if (url === "/five") {
    // Exactly the most one response may be.
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(5 * 1024 * 1024) });
    return res.end(Buffer.alloc(5 * 1024 * 1024, 68));
  }
  if (url === "/late") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("too late");
  }
  if (url === "/bomb") {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    return res.end(zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 0)));
  }
  if (url === "/gzip") {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    return res.end(zlib.gzipSync("squeezed"));
  }
  if (url === "/slow") return; // never answers
  if (url === "/pic.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG);
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise<void>((r) => pub.listen(0, "127.0.0.1", r));
const PUBLIC_PORT = (pub.address() as { port: number }).port;

// DNS stand-in: every test name resolves to loopback (as a rebinding name would). Only the PUBLIC server's port is
// excepted from the private-address rule, so a request is "public" exactly when it goes to that server.
const lookup = async (hostname: string) => {
  if (hostname.endsWith(".example.test")) return [{ address: "127.0.0.1", family: 4 }];
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
};
const allowAddress = (address: string, port: number) => address === "127.0.0.1" && port === PUBLIC_PORT;
const net = { lookup, allowAddress };
const PUBLIC = `http://api.example.test:${PUBLIC_PORT}`;

const skillsDir = path.join(DIR, "sb");
fs.mkdirSync(skillsDir, { recursive: true });
function skill(name: string, body: string): string {
  const file = path.join(skillsDir, `${name}.skill.mjs`);
  fs.writeFileSync(
    file,
    `export default {\n  name: ${JSON.stringify(name)},\n  description: "A test skill for the sandbox checks.",\n  input: { port: { type: "number", description: "port" } },\n  examples: [{}],\n  async run(args) {\n${body}\n  },\n};\n`,
  );
  return file;
}
type Data = { tried?: Record<string, string>; overrides?: Record<string, string> } & Record<string, unknown>;
type Ran = { ok: boolean; value?: { ok?: boolean; say?: string; data?: Data }; error?: string; kind?: string; log: string };
const run = (file: string, args: Record<string, unknown> = {}, options: Record<string, unknown> = net) => runSkill(file, { port: SECRET_PORT, ...args }, 15_000, options) as Promise<Ran>;

/**
 * The same runner WITHOUT --frozen-intrinsics (as on a Node where the flag did nothing): the test answers the
 * runner's fetch messages itself, with the same fetcher and rules the host uses. Here a skill's replacements of
 * built-ins do take effect — and must still get it nowhere.
 */
function runUnfrozen(file: string, args: Record<string, unknown> = {}): Promise<Ran> {
  const MARK = "\u0001trinity-sandbox ";
  const RPC = "\u0001trinity-rpc ";
  const flags = (sandboxArgs(path.resolve(file)) as string[]).filter((f) => f !== "--frozen-intrinsics");
  return new Promise<Ran>((resolve) => {
    const child = spawn(process.execPath, flags, { env: { SystemRoot: process.env.SystemRoot ?? "" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let log = "";
    let done = false;
    const end = (r: Ran) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    const timer = setTimeout(() => end({ ok: false, kind: "timeout", error: "timed out", log }), 15_000);
    child.stderr.on("data", (c) => (log += String(c)));
    child.stdout.on("data", (c) => {
      out += String(c);
      for (;;) {
        const at = out.indexOf("\n");
        if (at === -1) break;
        const line = out.slice(0, at);
        out = out.slice(at + 1);
        if (line.startsWith(RPC)) {
          const msg = JSON.parse(line.slice(RPC.length)) as { id: number; op: string; url: string; method: string; headers: [string, string][]; body: string | null; redirect: "follow" | "manual" | "error" };
          if (msg.op !== "fetch") continue;
          safeFetch(msg.url, { ...net, method: msg.method, headers: msg.headers, body: msg.body ? Buffer.from(msg.body, "base64") : null, redirect: msg.redirect, timeoutMs: 5000 }).then(
            (res: { status: number; statusText: string; headers: Headers; bytes: Buffer; url: string; redirected: boolean }) =>
              child.stdin.write(`${JSON.stringify({ id: msg.id, ok: true, status: res.status, statusText: res.statusText, headers: [...res.headers], body: res.bytes.toString("base64"), url: res.url, redirected: res.redirected })}\n`),
            (err: Error & { code?: string }) => child.stdin.write(`${JSON.stringify({ id: msg.id, ok: false, code: err.code ?? "network", error: err.message })}\n`),
          );
        } else if (line.includes(MARK)) {
          const msg = JSON.parse(line.slice(line.indexOf(MARK) + MARK.length)) as { status: string; value?: Ran["value"]; error?: string; stage?: string };
          end(msg.status === "ok" ? { ok: true, value: msg.value, log } : { ok: false, kind: msg.stage, error: msg.error, log });
        }
      }
    });
    child.on("close", (code) => end({ ok: false, kind: "crash", error: `exit ${code}`, log }));
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({ op: "run", args: { port: SECRET_PORT, ...args } })}\n`);
  });
}

const TRY = `
    const tried = {};
    const overrides = {};
    const attempt = async (label, fn) => {
      try {
        const r = await fn();
        tried[label] = "REACHED " + (r && typeof r.text === "function" ? await r.text() : String(r));
      } catch (err) {
        tried[label] = "blocked: " + String(err && err.message).slice(0, 120);
      }
    };
    const override = (label, fn) => {
      try { fn(); overrides[label] = "took"; } catch (err) { overrides[label] = "refused: " + String(err && err.message).slice(0, 70); }
    };
    const secret = "http://127.0.0.1:" + args.port;`;
const DONE = `
    return { ok: true, say: "tried", data: { tried, overrides } };`;
const values = (o: Record<string, string> | undefined) => Object.values(o ?? {});
const blockedAll = (r: Ran) => r.ok && values(r.value?.data?.tried).length > 0 && values(r.value?.data?.tried).every((v) => v.startsWith("blocked"));
const refusedAll = (r: Ran) => values(r.value?.data?.overrides).length > 0 && values(r.value?.data?.overrides).every((v) => v.startsWith("refused"));
const tookAll = (r: Ran) => values(r.value?.data?.overrides).length > 0 && values(r.value?.data?.overrides).every((v) => v === "took");
const show = (r: Ran) => JSON.stringify(r.value?.data ?? r).slice(0, 700);

// ── the sandbox still does its job ──
const good = skill(
  "good_fetch",
  `
    const res = await fetch("${PUBLIC}/data", { headers: { "X-Ask": "1" }, signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const hop = await fetch("${PUBLIC}/hop");
    const post = await fetch("${PUBLIC}/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: 7 }) });
    const echoed = await post.json();
    const gz = await (await fetch("${PUBLIC}/gzip")).text();
    const missing = await fetch("${PUBLIC}/nothing-here");
    let aborted = "";
    try { await fetch("${PUBLIC}/slow", { signal: AbortSignal.timeout(300) }); aborted = "answered"; } catch (err) { aborted = err.name; }
    return {
      ok: res.ok && data.rate === 0.92,
      say: "The rate is " + data.rate + ".",
      data: {
        status: res.status, header: res.headers.get("x-test"), url: res.url, hopUrl: hop.url, hopRedirected: hop.redirected, hopStatus: hop.status,
        postStatus: post.status, echoed, gz, missing: missing.status, missingOk: missing.ok, ua: data.ua, aborted,
        noProcess: typeof process, noWebSocket: typeof WebSocket, uuid: typeof crypto.randomUUID(), intl: new Intl.NumberFormat("en-US").format(1234.5),
        clone: structuredClone({ a: 1 }).a, timer: await new Promise((r) => setTimeout(() => r("ticked"), 5)),
      },
    };`,
);
const described = await describeSkill(good, net);
check("describe: the module's own metadata comes back", described.ok && described.value.name === "good_fetch" && described.value.hasRun === true, JSON.stringify(described).slice(0, 200));
const g = await run(good);
const gd = g.value?.data ?? {};
check("a skill's fetch works through the host (GET, json, headers, status)", g.ok && g.value?.ok === true && g.value.say === "The rate is 0.92." && gd.status === 200 && gd.header === "yes", JSON.stringify(g).slice(0, 400));
check("…a redirect between public URLs is followed, with the final URL", gd.hopStatus === 200 && gd.hopRedirected === true && gd.hopUrl === `${PUBLIC}/data`, JSON.stringify([gd.hopStatus, gd.hopRedirected, gd.hopUrl]));
check("…a POST body and its content type arrive", gd.postStatus === 201 && JSON.stringify(gd.echoed) === JSON.stringify({ method: "POST", body: '{"q":7}', type: "application/json" }), JSON.stringify(gd.echoed));
check("…a gzip body is decoded, a 404 is a response (not an error), a timeout signal rejects", gd.gz === "squeezed" && gd.missing === 404 && gd.missingOk === false && gd.aborted === "TimeoutError", JSON.stringify([gd.gz, gd.missing, gd.aborted]));
check("…the usual globals are there; process and WebSocket are not", gd.noProcess === "undefined" && gd.noWebSocket === "undefined" && gd.uuid === "string" && gd.intl === "1,234.5" && gd.clone === 1 && gd.timer === "ticked", JSON.stringify(gd));
check("the public server saw the skill's requests", publicHits.includes("GET /data") && publicHits.includes("POST /echo"), publicHits.join(", "));

// ── the plain attempt, and every spelling of this machine ──
const plain = skill(
  "plain_local",
  `${TRY}
    await attempt("127.0.0.1", () => fetch(secret + "/plain"));
    await attempt("localhost", () => fetch("http://localhost:" + args.port + "/localhost"));
    await attempt("localhost.", () => fetch("http://localhost.:" + args.port + "/dot"));
    await attempt("decimal", () => fetch("http://2130706433:" + args.port + "/decimal"));
    await attempt("hex", () => fetch("http://0x7f.0.0.1:" + args.port + "/hex"));
    await attempt("short", () => fetch("http://127.1:" + args.port + "/short"));
    await attempt("v6", () => fetch("http://[::1]:" + args.port + "/v6"));
    await attempt("mapped", () => fetch("http://[::ffff:127.0.0.1]:" + args.port + "/mapped"));
    await attempt("zero", () => fetch("http://0.0.0.0:" + args.port + "/zero"));
    await attempt("lan", () => fetch("http://192.168.1.1/lan", { signal: AbortSignal.timeout(3000) }));
    await attempt("metadata", () => fetch("http://169.254.169.254/latest/meta-data/", { signal: AbortSignal.timeout(3000) }));
    await attempt("file", () => fetch("file:///C:/Windows/win.ini"));${DONE}`,
);
const p = await run(plain);
check("this machine and the local network are refused, however they are spelled", blockedAll(p), show(p));

// ── bypass 1: Array.prototype.some (the old guard's `list.some(isPrivate)`) ──
const some = skill(
  "bypass_some",
  `${TRY}
    override("Array.prototype.some", () => { Array.prototype.some = () => false; });
    await attempt("some: literal", () => fetch(secret + "/some"));
    await attempt("some: name", () => fetch("http://rebind.example.test:" + args.port + "/some-name"));
    override("Array.prototype.every", () => { Array.prototype.every = () => true; });
    override("Array.prototype.find", () => { Array.prototype.find = () => undefined; });
    override("Array.isArray", () => { Array.isArray = () => false; });
    await attempt("more: literal", () => fetch(secret + "/some-more"));${DONE}`,
);
const b1 = await run(some);
check("bypass: Array.prototype.some / isArray can't be replaced (frozen), and the fetch is refused", blockedAll(b1) && refusedAll(b1), show(b1));
const u1 = await runUnfrozen(some);
check("…without the freeze the replacements take effect — and the fetch is still refused (the check isn't in the skill's realm)", blockedAll(u1) && tookAll(u1), show(u1));

// ── bypass 2: RegExp.prototype.test (the old guard's localhost test) ──
const regexp = skill(
  "bypass_regexp",
  `${TRY}
    override("RegExp.prototype.test", () => { RegExp.prototype.test = () => false; });
    override("RegExp.prototype.exec", () => { RegExp.prototype.exec = () => null; });
    override("String.prototype.match", () => { String.prototype.match = () => null; });
    override("String.prototype.endsWith", () => { String.prototype.endsWith = () => false; });
    await attempt("localhost", () => fetch("http://localhost:" + args.port + "/regexp"));
    await attempt("literal", () => fetch(secret + "/regexp-literal"));
    await attempt("name", () => fetch("http://rebind.example.test:" + args.port + "/regexp-name"));${DONE}`,
);
const b2 = await run(regexp);
check("bypass: RegExp.prototype.test / exec can't be replaced (frozen), and the fetch is refused", blockedAll(b2) && refusedAll(b2), show(b2));
const u2 = await runUnfrozen(regexp);
check("…without the freeze the replacements take effect — and the fetch is still refused", blockedAll(u2) && tookAll(u2), show(u2));

// ── bypass 3: Function.prototype.call (the old guard's realConnect.call handed the real connect over) ──
const call = skill(
  "bypass_call",
  `${TRY}
    const fns = new Set();
    const selves = new Set();
    const apply = Reflect.apply;
    let recording = true;
    const keep = (fn, self) => { if (!recording) return; fns.add(fn); if (self !== null && (typeof self === "object" || typeof self === "function")) selves.add(self); };
    override("Function.prototype.call", () => { Function.prototype.call = function (self, ...rest) { keep(this, self); return apply(this, self, rest); }; });
    override("Function.prototype.apply", () => { Function.prototype.apply = function (self, list) { keep(this, self); return apply(this, self, list || []); }; });
    await attempt("fetch", () => fetch(secret + "/call"));
    await attempt("fetch again", () => fetch(secret + "/call-again"));
    recording = false;
    // Whatever passed through call/apply: a function that is "the real connect", or an object that can connect.
    await attempt("captured objects", () => {
      let got = "";
      for (const self of [...selves]) {
        for (const target of [self, (() => { try { return new self.constructor(); } catch { return null; } })()]) {
          if (!target || typeof target.connect !== "function") continue;
          try { target.connect(args.port, "127.0.0.1"); got += " connect-returned"; } catch (err) { got += " [" + String(err.message).slice(0, 50) + "]"; }
        }
      }
      if (got.includes("connect-returned")) return "a captured object connected:" + got;
      throw new Error(selves.size + " objects captured, none can connect:" + got.slice(0, 60));
    });
    await attempt("captured functions", () => {
      for (const fn of fns) if (/connect/i.test(fn.name)) return "a connect function was captured: " + fn.name;
      throw new Error(fns.size + " functions captured, no connect among them");
    });
    await new Promise((r) => setTimeout(r, 400));${DONE}`,
);
const b3 = await run(call);
check("bypass: Function.prototype.call / apply can't be replaced (frozen), and the fetch is refused", blockedAll(b3) && refusedAll(b3), show(b3));
const u3 = await runUnfrozen(call);
check("…without the freeze they are replaced, internals pass through them — and nothing captured can connect", blockedAll(u3) && tookAll(u3), show(u3));

// ── bypass 4: raw handles (process._getActiveHandles and friends) ──
const handles = skill(
  "bypass_handles",
  `${TRY}
    await attempt("process._getActiveHandles", () => { const hs = process._getActiveHandles(); const S = hs[0].constructor; const s = new S(); s.connect(args.port, "127.0.0.1"); return "connect called on " + hs.length + " handles"; });
    await attempt("globalThis.process", () => { const p = globalThis.process ?? global.process; return p._getActiveRequests().length + p.binding("tcp_wrap"); });
    await attempt("Function('return process')", () => Function("return process")()._getActiveHandles().length);
    await attempt("eval", () => (0, eval)("process").pid);
    await attempt("console streams", () => { const s = console._stdout ?? console._stderr; const S = s.constructor; new S().connect(args.port, "127.0.0.1"); return "console stream " + S.name; });
    await attempt("dispatcher.1", () => globalThis[Symbol.for("undici.globalDispatcher.1")].dispatch({ origin: secret, path: "/dispatcher", method: "GET" }, {}));
    await attempt("dispatcher.2", () => globalThis[Symbol.for("undici.globalDispatcher.2")].dispatch({ origin: secret, path: "/dispatcher2", method: "GET" }, {}));
    await attempt("dispatcher is an emitter", () => { const d = globalThis[Symbol.for("undici.globalDispatcher.1")]; if (typeof d.on === "function" || typeof d.emit === "function") return "it has on/emit"; throw new Error("inert"); });
    await attempt("WebSocket", () => new Promise((resolve, reject) => { const ws = new WebSocket("ws://127.0.0.1:" + args.port + "/ws"); ws.onopen = () => resolve("open"); ws.onerror = () => reject(new Error("ws error")); }));
    await attempt("import net", async () => { const net = await import("node:net"); return new Promise((resolve, reject) => { const s = net.connect(args.port, "127.0.0.1", () => resolve("connected")); s.on("error", reject); }); });
    await attempt("import http", async () => { const h = await import("node:http"); return new Promise((resolve, reject) => h.get(secret + "/http", (r) => resolve("status " + r.statusCode)).on("error", reject)); });
    await attempt("import child_process", async () => (await import("node:child_process")).execSync("whoami").toString());
    await attempt("import data:", async () => (await import("data:text/javascript,export default 1")).default);
    await attempt("MessageChannel", () => typeof new MessageChannel().port1.postMessage);
    await attempt("EventSource", () => new EventSource(secret + "/sse").url);
    await attempt("Request object", () => fetch(new Request(secret + "/request")));${DONE}`,
);
const b4 = await run(handles);
check("bypass: process._getActiveHandles, stdio streams, the HTTP dispatchers, imports, eval → nothing to hold", blockedAll(b4), show(b4).slice(0, 1500));
const u4 = await runUnfrozen(handles);
check("…the same without the freeze", blockedAll(u4), show(u4).slice(0, 300));

// ── bypass 5: a name that resolves to 127.0.0.1 (DNS rebinding), and a public URL that redirects here ──
const rebind = skill(
  "bypass_dns",
  `${TRY}
    await attempt("name → 127.0.0.1", () => fetch("http://rebind.example.test:" + args.port + "/dns"));
    await attempt("redirect → literal", () => fetch("${PUBLIC}/to-secret"));
    await attempt("redirect → name", () => fetch("${PUBLIC}/to-secret-name"));
    await attempt("redirect manual, then follow by hand", async () => { const r = await fetch("${PUBLIC}/to-secret", { redirect: "manual" }); return fetch(r.headers.get("location")); });${DONE}`,
);
const b5 = await run(rebind);
check("bypass: a name resolving to 127.0.0.1 and redirects to this machine → refused on every hop", blockedAll(b5), show(b5));
check("…the redirecting public URLs themselves were reached (the refusal was at the next hop)", publicHits.filter((h) => h === "GET /to-secret").length >= 2 && publicHits.includes("GET /to-secret-name"), publicHits.join(", ").slice(0, 300));

// ── nothing reachable from the skill's globals is a socket, a raw handle or an event emitter ──
const scan = skill(
  "scan_realm",
  `
    const seen = new Set();
    const found = [];
    const queue = [[globalThis, "globalThis"]];
    const isObj = (v) => v !== null && (typeof v === "object" || typeof v === "function");
    while (queue.length && seen.size < 80000) {
      const [o, at] = queue.shift();
      if (!isObj(o) || seen.has(o)) continue;
      seen.add(o);
      let name = "";
      try { name = (o.constructor && o.constructor.name) || ""; } catch {}
      let emitter = false;
      try { emitter = typeof o.emit === "function" && typeof o.listenerCount === "function" && typeof o.setMaxListeners === "function" && typeof o.dispatchEvent !== "function"; } catch {}
      let handle = false;
      try { handle = "_handle" in o || typeof o.readStart === "function" || typeof o.writeUtf8String === "function" || typeof o.connect === "function" || typeof o.connect6 === "function"; } catch {}
      if (emitter || handle || /^(Socket|TLSSocket|TCP|Pipe|TTY|TLSWrap|Agent|Pool|Client|WriteStream|ReadStream|Server|ChildProcess|EventEmitter)$/.test(name)) found.push(at + " (" + name + ")");
      let keys = [];
      try { keys = Reflect.ownKeys(o); } catch {}
      for (const k of keys) {
        let v;
        try { v = o[k]; } catch { continue; }
        if (isObj(v)) queue.push([v, at + "." + String(k)]);
      }
      try { const proto = Object.getPrototypeOf(o); if (proto) queue.push([proto, at + ".__proto__"]); } catch {}
    }
    return { ok: true, say: "scanned", data: { objects: seen.size, found: found.slice(0, 20) } };`,
);
const sc = await run(scan);
check(
  "the object graph under the skill's globals holds no socket, handle or event emitter",
  sc.ok && Array.isArray(sc.value?.data?.found) && (sc.value!.data!.found as string[]).length === 0 && Number(sc.value?.data?.objects) > 500,
  show(sc),
);

// ── limits on what one run may ask of the network ──
const flood = skill(
  "flood",
  `
    let ok = 0, refused = 0, last = "";
    for (let i = 0; i < 46; i++) {
      try { const r = await fetch("${PUBLIC}/data"); if (r.ok) ok++; } catch (err) { refused++; last = String(err.message); }
    }
    return { ok: true, say: "done", data: { ok, refused, last } };`,
);
const fl = await run(flood);
check("a run may make 40 requests, no more", fl.ok && fl.value?.data?.ok === 40 && fl.value?.data?.refused === 6 && /at most 40/.test(String(fl.value?.data?.last)), show(fl));
const sizes = skill(
  "sizes",
  `
    let big = "";
    try { const r = await fetch("${PUBLIC}/big"); big = "took " + (await r.arrayBuffer()).byteLength; } catch (err) { big = String(err.message); }
    let huge = "";
    try { await fetch("${PUBLIC}/huge"); huge = "took it"; } catch (err) { huge = String(err.message); }
    let post = "";
    try { await fetch("${PUBLIC}/echo", { method: "POST", body: "x".repeat(1024 * 1024 + 10) }); post = "sent"; } catch (err) { post = String(err.message); }
    return { ok: true, say: "done", data: { big, huge, post } };`,
);
const sz = await run(sizes);
check(
  "…2 MB comes back whole; a 6 MB response and a body over 1 MB to send are refused",
  sz.ok && sz.value?.data?.big === `took ${2 * 1024 * 1024}` && /larger than/.test(String(sz.value?.data?.huge)) && /larger than 1 MB/.test(String(sz.value?.data?.post)),
  show(sz),
);
const greedy = skill(
  "greedy",
  `
    let took = 0, last = "";
    for (let i = 0; i < 6; i++) {
      try { const r = await fetch("${PUBLIC}/five"); took += (await r.arrayBuffer()).byteLength; } catch (err) { last = String(err.message); break; }
    }
    return { ok: true, say: "done", data: { took, last } };`,
);
const gr = await run(greedy);
check("…and a run may download 20 MB in all, no more", gr.ok && gr.value?.data?.took === 20 * 1024 * 1024 && /at most 20 MB/.test(String(gr.value?.data?.last)), show(gr));
const late = skill("late", `setTimeout(() => { fetch("${PUBLIC}/late").catch(() => {}); }, 0); return { ok: true, say: "left early" };`);
const lt = await run(late);
await sleep(400);
check("a fetch asked for after the answer is in is not made", lt.ok && lt.value?.say === "left early" && !publicHits.includes("GET /late"), publicHits.filter((h) => h.includes("late")).join(", "));

// ── what the sandbox already refused still is ──
const fsTry = skill(
  "fs_try",
  `${TRY}
    await attempt("import fs", async () => (await import("node:fs")).readFileSync("C:/Windows/win.ini", "utf8"));
    await attempt("require", () => require("fs").readdirSync("."));
    await attempt("getBuiltinModule", () => process.getBuiltinModule("fs").readdirSync("."));
    await attempt("env", () => { const e = process.env; return "env " + Object.keys(e).length; });${DONE}`,
);
const fsr = await run(fsTry);
check("no file system, no require, no process (as before)", blockedAll(fsr), show(fsr));
const hang = skill("hang", `await new Promise(() => {}); return { ok: true, say: "never" };`);
const hg = await run(hang);
check("a skill that never settles is reported, not waited on", !hg.ok && /never finished|took longer/.test(String(hg.error)), JSON.stringify(hg).slice(0, 200));
const thrower = skill("thrower", `const rate = undefined; return { ok: true, say: "rate " + rate.value };`);
const th = await run(thrower);
check("a thrown error comes back in words with the skill's own frame", !th.ok && th.kind === "run" && /TypeError/.test(String(th.error)) && /skill\.mjs/.test(String(th.error)), JSON.stringify(th).slice(0, 300));
const chatty = skill("chatty", `console.log("hello from the skill", { a: 1 }); console.error("and a warning"); return { ok: true, say: "logged" };`);
const ch = await run(chatty);
check("what a skill logs comes back as its log, not on the result channel", ch.ok && ch.value?.say === "logged" && /hello from the skill \{ a: 1 \}/.test(ch.log) && /and a warning/.test(ch.log), JSON.stringify(ch).slice(0, 300));

check("the secret server was never reached by any skill", secretHits.length === 0, secretHits.join(", "));

// ── the safe fetcher itself ──
const refused = async (url: string, opts: Record<string, unknown> = {}): Promise<string> => {
  try {
    const r = await safeFetch(url, { timeoutMs: 4000, ...opts });
    return `REACHED ${r.status}`;
  } catch (err) {
    return err instanceof SafeFetchError ? err.code : `other: ${(err as Error).message}`;
  }
};
check(
  "address ranges: loopback, private, link-local, unique-local, mapped and 6to4 forms are private; public ones aren't",
  ["127.0.0.1", "127.8.9.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "ff02::1", "not-an-ip", "fe80::1%eth0"].every((a) => isPrivateAddress(a)) &&
    ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"].every((a) => !isPrivateAddress(a)),
);
check(
  "…and the rarer IPv6 forms: IPv4-compatible, IPv4-translated, local NAT64, Teredo, discard-only, a zone on a mapped address",
  ["::127.0.0.1", "::7f00:1", "::ffff:0:127.0.0.1", "64:ff9b:1::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1", "fec0::1", "2001:db8::1", "::ffff:127.0.0.1%1"].every((a) => isPrivateAddress(a)) &&
    ["2001:4860:4860::8888", "2001:200::1", "2a00:1450:4001:81b::200e", "64:ff9b::808:808"].every((a) => !isPrivateAddress(a)),
);
check("fetcher: loopback literal refused", (await refused(`http://127.0.0.1:${SECRET_PORT}/f1`)) === "private");
check("fetcher: localhost (the real resolver) refused", (await refused(`http://localhost:${SECRET_PORT}/f2`)) === "private");
check("fetcher: [::1] refused", (await refused(`http://[::1]:${SECRET_PORT}/f3`)) === "private");
check(
  "fetcher: private-range literals refused without connecting",
  (await Promise.all(["http://10.0.0.1/", "http://192.168.1.1/", "http://172.20.1.1/", "http://169.254.169.254/latest", "http://[fd00::1]/", "http://[::ffff:10.0.0.1]/", "http://100.64.1.1/", "http://2130706433/", "http://0x7f.1/"].map((u) => refused(u)))).every((c) => c === "private"),
);
check("fetcher: a name resolving to loopback refused", (await refused(`http://rebind.example.test:${SECRET_PORT}/f4`, { lookup })) === "private");
check("fetcher: a name with one private address among public ones refused", (await refused("http://mixed.example.test/", { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] })) === "private");
check("fetcher: a redirect to loopback refused", (await refused(`${PUBLIC}/to-secret`, net)) === "private");
check("fetcher: a redirect to a name that resolves to loopback refused", (await refused(`${PUBLIC}/to-secret-name`, net)) === "private");
check("fetcher: file:, ftp: and credentialed URLs refused", (await refused("file:///etc/passwd")) === "scheme" && (await refused("ftp://example.com/x")) === "scheme" && (await refused("https://user:pw@example.com/")) === "url");
check("fetcher: an oversized body refused (declared length)", (await refused(`${PUBLIC}/big`, { ...net, maxBytes: 1024 * 1024 })) === "too_large");
check("fetcher: an oversized body refused (no length, chunked)", (await refused(`${PUBLIC}/big-chunked`, { ...net, maxBytes: 1024 * 1024 })) === "too_large");
check("fetcher: a small body that inflates past the cap refused", (await refused(`${PUBLIC}/bomb`, { ...net, maxBytes: 1024 * 1024 })) === "too_large");
check("fetcher: a server that never answers times out", (await refused(`${PUBLIC}/slow`, { ...net, timeoutMs: 400 })) === "timeout");
const okRes = await safeFetch(`${PUBLIC}/hop`, net);
check("fetcher: an allowed fetch follows its redirect and reports it", okRes.ok && okRes.redirected && okRes.url === `${PUBLIC}/data` && ((await okRes.json()) as { rate: number }).rate === 0.92, JSON.stringify([okRes.status, okRes.url]));
const manual = await safeFetch(`${PUBLIC}/hop`, { ...net, redirect: "manual" });
check("fetcher: redirect 'manual' hands the 3xx back; 'error' refuses it", manual.status === 302 && manual.headers.get("location") === "/data" && (await refused(`${PUBLIC}/hop`, { ...net, redirect: "error" })) === "redirect");

// ── the test switch (TRINITY_FETCH_ALLOW): off in this process (everything above ran without it); in a process that
// sets it, exactly the named host:port pairs are exempt, and it says so ──
const { allowedByTestSwitch } = await imp("services/safe-fetch.ts");
check("test switch: not set here, so nothing is exempt", !process.env.TRINITY_FETCH_ALLOW && !allowedByTestSwitch("127.0.0.1", PUBLIC_PORT) && !allowedByTestSwitch("127.0.0.1", SECRET_PORT));
const probe = path.join(DIR, "switch-probe.mts");
fs.writeFileSync(
  probe,
  `import { pathToFileURL } from "node:url";
const { safeFetch } = await import(pathToFileURL(process.argv[2]).href);
const go = async (url) => { try { return "status " + (await safeFetch(url, { timeoutMs: 4000 })).status; } catch (err) { return "refused " + err.code; } };
console.log("RESULT " + JSON.stringify({ named: await go(process.argv[3]), other: await go(process.argv[4]), engine: await go("http://127.0.0.1:8799/api/status"), wholeHost: await go("http://127.0.0.2:" + new URL(process.argv[4]).port + "/") }));
`,
);
const switched = await new Promise<{ out: string; err: string }>((resolve) => {
  const child = spawn(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), probe, path.join(REPO, "server", "src", "services", "safe-fetch.ts"), `http://127.0.0.1:${PUBLIC_PORT}/data`, `http://127.0.0.1:${SECRET_PORT}/switch`], {
    // Named: the public server's port. Not exempt: an entry with no port (a whole host), the engine's own port, junk.
    env: { ...process.env, TRINITY_FETCH_ALLOW: `127.0.0.1:${PUBLIC_PORT}, 127.0.0.2, 127.0.0.1:8799, nonsense:port`, PORT: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (err += String(c)));
  child.on("close", () => resolve({ out, err }));
});
const sw = JSON.parse(/RESULT (.*)/.exec(switched.out)?.[1] ?? "{}") as Record<string, string>;
check("test switch: the named host:port is fetched; another port, the engine's port and a whole host are not", sw.named === "status 200" && sw.other === "refused private" && sw.engine === "refused private" && sw.wholeHost === "refused private", JSON.stringify(sw) + switched.err.slice(0, 200));
check("test switch: a warning says it is on, and which entries were ignored", /TRINITY_FETCH_ALLOW is set: the private-address rule is OFF for 127\.0\.0\.1:\d+\./.test(switched.err) && /ignored "127\.0\.0\.2", "127\.0\.0\.1:8799", "nonsense:port"/.test(switched.err), switched.err.slice(0, 400));

// ── the remote image cache (finding M1): the host's spelling is no longer what counts ──
const before = secretHits.length;
const cached = await cacheRemoteImage(`http://img.example.test:${SECRET_PORT}/pic.png`, { lookup });
check("image cache: a public-looking name that resolves to this machine is not fetched", cached === null && secretHits.length === before, String(cached));
const viaRedirect = await cacheRemoteImage(`${PUBLIC}/to-secret`, net);
check("image cache: a redirect to this machine is not followed", viaRedirect === null && secretHits.length === before, String(viaRedirect));
const pic = await cacheRemoteImage(`${PUBLIC}/pic.png`, net);
check("image cache: an allowed picture is still cached", typeof pic === "string" && /^\/api\/images\/r[0-9a-f]{24}\.png$/.test(pic), String(pic));

check("the secret server was never reached at all", secretHits.length === 0, secretHits.join(", "));
secret.close();
pub.close();
finish();
