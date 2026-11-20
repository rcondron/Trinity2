// The Trinity Browser Bridge end to end: the REAL extension (a copy of extension/) in REAL headless Microsoft Edge,
// against a throwaway Trinity engine, on local fixture pages only.
//
//   node scripts/e2e-extension.mjs [--dir <new or empty folder>] [--keep] [--only A,B,C,D]
//
//  1. Copies extension/ into a scratch folder and rewrites ONE line of the copy, DEFAULT_ENGINE, to this run's engine
//     (ws://127.0.0.1:8861). It stops if 8799 — the engine you use every day — is left anywhere in the copy's code.
//  2. Starts a throwaway engine in a child process (this file with --engine): its data folder and its vault folder are
//     inside the scratch folder, its .env is an empty file, it has no keys but a dummy model key whose gateway is a
//     loopback port nothing listens on, and it refuses to start unless vaultDir() is this run's vault folder.
//  3. Serves scripts/fixtures/browser/ over https on 8862 and 8864 (a self-signed certificate made with openssl) and
//     over plain http on 8863.
//  4. Starts Edge headless with the copy loaded (branded Chrome ≥ 137 ignores --load-extension; Edge 157 doesn't), a
//     temporary profile, DevTools on 9381 — and no way to resolve any host name but 127.0.0.1.
//  5. Checks A pairing (the popup, wrong codes, an engine restart, Disconnect / Connect), B tabs and windows, C reading
//     and acting on pages, D filling from the vault (sign-in, card, details, every refusal), then searches everything
//     it can observe for the invented secrets.
//  6. Closes Edge, kills what it started (Edge by its profile folder), deletes the profile — and the whole scratch
//     folder unless --keep.
//
// Ports: 8860 the engine child's control port (token-protected), 8861 the engine, 8862 / 8864 https fixtures, 8863 http
// fixtures, 8869 the dummy model gateway (nothing listens), 9381 Edge's DevTools. Not touched: data/, .env, the engine on
// 8799. Every credential is invented; the card is the published test card 4242 4242 4242 4242.
// --only picks areas (pairing itself always runs). Exit code 0 when every check passed.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ME = fileURLToPath(import.meta.url);
const PORTS = { control: 8860, engine: 8861, https: 8862, http: 8863, other: 8864, app: 8865, gateway: 8869, devtools: 9381 };
const LIVE_ENGINE_PORT = 8799;
const HTTPS = `https://127.0.0.1:${PORTS.https}`;
const OTHER = `https://127.0.0.1:${PORTS.other}`;
const HTTP = `http://127.0.0.1:${PORTS.http}`;
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

/** Poll until `fn` gives something truthy (errors count as "not yet"); its last answer, or undefined. */
async function until(fn, ms = 10_000, every = 150) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      last = undefined;
    }
    if (Date.now() >= end) return last;
    await sleep(every);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The engine child: the real engine in-process, plus a control port the driver uses to run bridge calls and tools.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

async function engineMain() {
  const env = process.env;
  const run = env.E2E_RUN_DIR ? path.resolve(env.E2E_RUN_DIR) : "";
  const inside = (p) => Boolean(p) && run !== "" && path.resolve(p).startsWith(run + path.sep);
  if (!run || !env.E2E_TOKEN || !inside(env.TRINITY_DATA_DIR) || !inside(env.TRINITY_VAULT_DIR) || !inside(env.DOTENV_CONFIG_PATH) || Number(env.PORT) !== PORTS.engine) {
    console.error("[e2e] the engine child runs only from scripts/e2e-extension.mjs, with its own folders and port");
    process.exit(2);
  }
  const src = (p) => pathToFileURL(path.join(ROOT, "server", "src", p)).href;
  // The vault must be this run's folder before anything can be saved.
  const { vaultDir } = await import(src("vault/policy.ts"));
  if (path.resolve(vaultDir()) !== path.resolve(env.TRINITY_VAULT_DIR)) {
    console.error(`[e2e] vaultDir() is ${vaultDir()}, not this run's vault folder: stopping`);
    process.exit(2);
  }
  console.log(`[e2e] vaultDir() = ${vaultDir()}`);
  await import(src("index.ts"));
  const bridge = await import(src("services/browser-bridge.ts"));
  const { getTool } = await import(src("tools/registry.ts"));
  const { act } = await import(src("agent/act.ts"));
  const pending = await import(src("agent/pending.ts"));
  const { getActivePersona } = await import(src("db/sqlite.ts"));
  const vaultFacade = await import(src("vault/index.ts"));

  const routes = {
    "/state": async () => ({
      browser: bridge.browserState(),
      pairing: bridge.pairingInfo(),
      forms: vaultFacade.openForms().map((f) => ({ id: f.id, purpose: f.purpose, title: f.title, host: f.host })),
      question: pending.pendingQuestion()?.question ?? null,
    }),
    "/bridge": async (b) => ({ result: await bridge.browserCall(String(b.method), b.params ?? {}, Number(b.timeoutMs) || 12_000) }),
    // A tool as the engine runs it after routing (agent/act.ts): the user's own words, its arguments as options.
    "/tool": async (b) => {
      const tool = getTool(String(b.name));
      if (!tool) throw new Error(`no tool ${b.name}`);
      const events = [];
      const options = Object.fromEntries(Object.entries(b.args ?? {}).map(([k, v]) => [k, { value: String(v), confidence: 1 }]));
      const io = { persona: getActivePersona(), memory: {}, emit: (e) => events.push(e), recentTranscript: [], situation: "", minConfidence: 0.7, origin: b.origin ?? "user", ...(b.userWords ? { userWords: b.userWords } : {}) };
      const outcome = await act({ action: tool.name, confidence: 1, tool, options, offered: Object.keys(options), ms: 0 }, String(b.utterance ?? ""), io);
      return { outcome, events };
    },
    "/answer": async (b) => ({ result: await pending.answerPending(String(b.words ?? "")) }),
    // A fill envelope built by the bridge itself, for the refusals the extension must make on its own.
    "/secret-fill": async (b) => ({ result: await bridge.browserSecretCall("page.fill", { tabId: Number(b.tabId), documentId: String(b.documentId ?? ""), origin: String(b.origin ?? ""), values: b.values ?? {} }) }),
  };
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-e2e-token"] !== env.E2E_TOKEN) return reply(403, { ok: false, error: "token" });
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const route = routes[new URL(req.url ?? "/", "http://x").pathname];
      if (!route) return reply(404, { ok: false, error: "no such route" });
      try {
        reply(200, { ok: true, ...(await route(raw ? JSON.parse(raw) : {})) });
      } catch (err) {
        reply(200, { ok: false, error: String(err?.message ?? err) });
      }
    });
  });
  server.listen(PORTS.control, "127.0.0.1", () => console.log(`[e2e] control port ${PORTS.control}`));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The driver
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ONLY = (opt("--only") ?? "A,B,C,D").toUpperCase().split(",");
const wants = (area) => ONLY.includes(area);

const results = [];
function check(area, name, ok, detail = "") {
  results.push({ area, name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"} ${area} ${name}${detail ? `  — ${String(detail).slice(0, 400)}` : ""}`);
  return Boolean(ok);
}
const note = (line) => console.log(`     ${line}`);
/** One group of checks: whatever it throws is a failed check of its own, and the run goes on to the next group. */
async function block(area, name, fn) {
  try {
    await fn();
  } catch (err) {
    check(area, `${name} — stopped`, false, String(err?.message ?? err).split("\n")[0]);
  }
}

// ─── processes and folders ─────────────────────────────────────────────────────────────────────────────────────────

const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
}

/** Every Edge process started with this profile folder (the browser and all its helpers). */
function killEdge(profile) {
  if (process.platform !== "win32") return;
  const pattern = `*${profile}*`.replace(/'/g, "''");
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: "ignore" },
  );
}

function rmrf(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},500)"]);
    }
  }
  return !fs.existsSync(dir);
}

function findOpenssl() {
  for (const p of [process.env.OPENSSL, "C:/Program Files/Git/usr/bin/openssl.exe", "C:/Program Files/Git/mingw64/bin/openssl.exe", "openssl"]) {
    if (!p) continue;
    const r = spawnSync(p, ["version"], { stdio: "pipe" });
    if (r.status === 0) return p;
  }
  return null;
}

/** The copy of the extension: only DEFAULT_ENGINE changes. Lines that still say 8799 outside words are refused. */
function copyExtension(to) {
  fs.cpSync(path.join(ROOT, "extension"), to, { recursive: true });
  const bg = path.join(to, "background.js");
  const text = fs.readFileSync(bg, "utf8");
  const line = /^const DEFAULT_ENGINE = "ws:\/\/127\.0\.0\.1:\d+";(\r?)$/m;
  if (!line.test(text)) throw new Error("the DEFAULT_ENGINE line isn't in extension/background.js as expected");
  fs.writeFileSync(bg, text.replace(line, `const DEFAULT_ENGINE = "ws://127.0.0.1:${PORTS.engine}";$1`));
  const left = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!/\.(png|ico)$/i.test(e.name)) {
        fs.readFileSync(full, "utf8")
          .split(/\r?\n/)
          .forEach((l, i) => {
            if (!l.includes(String(LIVE_ENGINE_PORT))) return;
            const words = /\.md$/i.test(e.name) || /^\s*(\/\/|\*|\/\*)/.test(l) || (/\.html$/i.test(e.name) && !l.replace(/placeholder="[^"]*"/g, "").includes(String(LIVE_ENGINE_PORT)));
            if (!words) left.push(`${path.relative(to, full)}:${i + 1}: ${l.trim().slice(0, 120)}`);
          });
      }
    }
  };
  walk(to);
  return left;
}

// ─── the Chrome DevTools protocol ──────────────────────────────────────────────────────────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    this.listeners = new Set();
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      const w = msg.id !== undefined ? this.waiting.get(msg.id) : undefined;
      if (w) {
        this.waiting.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
        else w.resolve(msg.result);
      } else for (const fn of this.listeners) fn(msg);
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      ws.once("open", () => resolve(new Cdp(ws)));
      ws.once("error", reject);
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* closed */
    }
  }
}

/** A tiny PNG reader (8-bit RGB / RGBA, not interlaced): enough to tell which page a screenshot shows. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (depth !== 8 || !bpp || interlace) throw new Error(`PNG kind ${type}/${depth}/${interlace} not handled`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
  }
  return { width, height, at: (x, y) => [...out.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}

/**
 * "red", "green" or "other": what most of a screenshot's empty right-hand side shows — sampled inside the page, clear of
 * a scroll bar at the edge, the fixtures' content on the left and their harness panel at the bottom right.
 */
function marginColour(dataUrl) {
  const png = decodePng(Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
  const tally = { red: 0, green: 0, other: 0 };
  for (let y = Math.floor(png.height * 0.1); y < png.height * 0.5; y += 9)
    for (let x = Math.floor(png.width * 0.7); x < png.width * 0.9; x += 9) {
      const [r, g, b] = png.at(x, y);
      tally[r > 150 && g < 90 && b < 90 ? "red" : g > 110 && r < 90 && b < 90 ? "green" : "other"]++;
    }
  return Object.entries(tally).sort((p, q) => q[1] - p[1])[0][0];
}

/** The average colour of a screenshot, and its size: for saying what a capture showed when it wasn't what was expected. */
function meanColour(dataUrl) {
  const png = decodePng(Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < png.height; y += 9)
    for (let x = 0; x < png.width; x += 9) {
      const px = png.at(x, y);
      for (let i = 0; i < 3; i++) sum[i] += px[i];
      n++;
    }
  return { rgb: sum.map((s) => Math.round(s / Math.max(1, n))), size: `${png.width}x${png.height}` };
}

/** RFC 6238 (SHA-1, 30 s, 6 digits) — to check the code the vault typed, from the invented seed. */
function totp(base32, at = Date.now()) {
  const bits = [...base32.replace(/=+$/, "")].map((ch) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// ─── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function driverMain() {
  const keep = argv.includes("--keep");
  for (const [name, port] of Object.entries(PORTS)) if (name !== "gateway" && (await portBusy(port))) throw new Error(`port ${port} (${name}) is in use: stop whatever holds it first`);
  if (!fs.existsSync(EDGE)) throw new Error(`no Edge at ${EDGE} (set EDGE_PATH)`);
  const openssl = findOpenssl();
  if (!openssl) throw new Error("openssl wasn't found (Git for Windows ships one; or set OPENSSL)");

  const asked = opt("--dir");
  const run = asked ? path.resolve(asked) : fs.mkdtempSync(path.join(os.tmpdir(), "trinity-e2e-ext-"));
  if (asked) {
    if (fs.existsSync(run) && fs.readdirSync(run).length) throw new Error(`${run} isn't empty`);
    fs.mkdirSync(run, { recursive: true });
  }
  const dirs = { ext: path.join(run, "extension"), data: path.join(run, "data"), vault: path.join(run, "vault"), profile: path.join(run, "edge-profile"), tls: path.join(run, "tls") };
  for (const d of [dirs.data, dirs.vault, dirs.tls]) fs.mkdirSync(d, { recursive: true });
  const emptyEnv = path.join(run, "empty.env");
  fs.writeFileSync(emptyEnv, "");
  const engineLogFile = path.join(run, "engine.log");
  const workerLogFile = path.join(run, "worker.log");
  console.log(`run folder: ${run}`);

  const procs = { engine: null, edge: null };
  const servers = [];
  let cdp = null;
  let events = null;
  const cleanup = async () => {
    try {
      if (cdp) await cdp.send("Browser.close", {}, undefined, 5000).catch(() => {});
    } catch {
      /* gone */
    }
    cdp?.close();
    events?.close();
    await sleep(800);
    killEdge(dirs.profile);
    if (procs.edge) killTree(procs.edge.pid);
    if (procs.engine) killTree(procs.engine.pid);
    for (const s of servers) s.close();
    await sleep(800);
    const gone = rmrf(dirs.profile);
    console.log(gone ? "Edge's temporary profile deleted." : `couldn't delete ${dirs.profile} — delete it by hand`);
    if (!keep) console.log(rmrf(run) ? "run folder deleted." : `couldn't delete ${run}`);
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

  try {
    // 1. The copy of the extension.
    const left = copyExtension(dirs.ext);
    if (left.length) throw new Error(`the copy still points at ${LIVE_ENGINE_PORT}:\n${left.join("\n")}`);
    const copied = fs.readFileSync(path.join(dirs.ext, "background.js"), "utf8");
    console.log(`extension copied; its engine: ${/const DEFAULT_ENGINE = "([^"]+)"/.exec(copied)?.[1]} (no ${LIVE_ENGINE_PORT} left in its code)`);

    // 2. Certificates and fixture servers.
    const key = path.join(dirs.tls, "key.pem");
    const cert = path.join(dirs.tls, "cert.pem");
    const made = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" });
    if (made.status !== 0) throw new Error(`openssl failed: ${String(made.stderr).slice(0, 300)}`);
    const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    const { fixtureServer } = await import(pathToFileURL(path.join(ROOT, "scripts", "serve-fixtures.mjs")).href);
    const posts = [];
    const onPost = (p) => posts.push(p);
    servers.push(await fixtureServer({ port: PORTS.https, self: HTTPS, other: OTHER, tls, onPost, quiet: true }));
    servers.push(await fixtureServer({ port: PORTS.other, self: OTHER, other: HTTPS, tls, onPost, quiet: true }));
    servers.push(await fixtureServer({ port: PORTS.http, self: HTTP, other: OTHER, onPost, quiet: true }));
    // A stand-in for Trinity's own app page (the engine is told WEB_PORT is this port): the tab the extension must
    // never read, change, navigate or close.
    const appPage = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><html><head><title>Trinity</title></head><body><h1>Trinity</h1><button>Hang up</button></body></html>");
    });
    await new Promise((resolve) => appPage.listen(PORTS.app, "127.0.0.1", resolve));
    servers.push(appPage);

    // 3. The engine.
    const token = crypto.randomBytes(16).toString("hex");
    let engineOut = "";
    const engineEnv = {
      ...process.env,
      ...Object.fromEntries(
        ["SERPAPI_KEY", "SERPAPI_API_KEY", "FAL_KEY", "TYPESAFE_API_KEY", "DEEPGRAM_API_KEY", "PERSONAPLEX_WS_URL", "PERSONAPLEX_ADMIN_TOKEN", "MORPH_API_KEY", "TAVILY_API_KEY", "WEB_SEARCH_API_KEY", "TRINITY_API_KEY", "TRINITY_AUTH", "TRINITY_ORIGINS", "TRINITY_FETCH_ALLOW", "TRINITY_TEST_HOOKS", "WEB_PORT"].map((k) => [k, ""]),
      ),
      TRINITY_TEST: "1",
      PORT: String(PORTS.engine),
      HOST: "127.0.0.1",
      TRINITY_DATA_DIR: dirs.data,
      TRINITY_VAULT_DIR: dirs.vault,
      DOTENV_CONFIG_PATH: emptyEnv,
      MORDIEM_API_KEY: "test",
      MORDIEM_URL: `http://127.0.0.1:${PORTS.gateway}/api/v1`,
      TYPESAFE_URL: `http://127.0.0.1:${PORTS.gateway}`,
      MAIL_URL: `${HTTPS}/`,
      CALENDAR_URL: `${HTTPS}/`,
      // Trinity's own pages are the app's (WEB_PORT): here a stand-in page on a port of this run's.
      WEB_PORT: String(PORTS.app),
      E2E_RUN_DIR: run,
      E2E_TOKEN: token,
    };
    const loader = pathToFileURL(path.join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const startEngine = async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const child = spawn(process.execPath, ["--import", loader, ME, "--engine"], { cwd: ROOT, env: engineEnv, stdio: ["ignore", "pipe", "pipe"] });
        procs.engine = child;
        let exited = false;
        child.on("exit", () => (exited = true));
        const take = (d) => {
          engineOut += d;
          fs.appendFileSync(engineLogFile, d);
        };
        child.stdout.on("data", take);
        child.stderr.on("data", take);
        const up = await until(async () => {
          if (exited) return "exited";
          const r = await fetch(`http://127.0.0.1:${PORTS.engine}/healthz`);
          return r.ok ? "up" : null;
        }, 90_000, 300);
        if (up === "up" && (await until(() => controlGet("/state").then((r) => r.ok), 20_000))) return;
        killTree(child.pid);
        // Other builders edit the working copy too: an import that fails mid-edit is worth a second try.
        console.log(`the engine didn't start (attempt ${attempt}); its last words:\n${engineOut.split(/\r?\n/).slice(-12).join("\n")}`);
        if (attempt < 3) await sleep(60_000);
      }
      throw new Error("the engine wouldn't start");
    };
    const stopEngine = async () => {
      killTree(procs.engine?.pid);
      procs.engine = null;
      await until(async () => !(await portBusy(PORTS.engine)) && !(await portBusy(PORTS.control)), 15_000);
    };
    const controlGet = async (p) => (await fetch(`http://127.0.0.1:${PORTS.control}${p}`, { method: "POST", headers: { "x-e2e-token": token, "content-type": "application/json" }, body: "{}" })).json();
    const control = async (p, body) => (await fetch(`http://127.0.0.1:${PORTS.control}${p}`, { method: "POST", headers: { "x-e2e-token": token, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
    await startEngine();
    const vaultLine = `[e2e] vaultDir() = ${dirs.vault}`;
    check("D", "the engine's vaultDir() is this run's vault folder (checked before anything is saved)", engineOut.includes(vaultLine), vaultLine);
    const apiKey = JSON.parse(fs.readFileSync(path.join(dirs.data, "auth.json"), "utf8")).apiKey;
    const api = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORTS.engine}/api${p}`, { method, headers: { authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      return { status: res.status, json };
    };

    // What the engine shows its apps (told lines arrive here), for the waits below and for the canary.
    const engineEvents = [];
    const watchEvents = () => {
      const sock = new WebSocket(`ws://127.0.0.1:${PORTS.engine}/ws`, { headers: { authorization: `Bearer ${apiKey}` } });
      sock.on("message", (d) => engineEvents.push(String(d)));
      sock.on("error", () => {});
      return sock;
    };
    events = watchEvents();
    /** A line Trinity told the apps later (work that outlasted its tool), among the events from index `from` on. */
    const told = (re, ms = 20_000, from = 0) =>
      until(() => {
        for (const raw of engineEvents.slice(from)) {
          const e = JSON.parse(raw);
          const text = e?.turn?.text ?? "";
          if (e.type === "transcript" && e.turn?.speaker === "trinity" && re.test(text)) return text;
        }
        return null;
      }, ms);

    const toolLog = [];
    const bridgeTry = (method, params = {}, timeoutMs) => control("/bridge", { method, params, timeoutMs });
    const bridge = async (method, params = {}, timeoutMs) => {
      const r = await bridgeTry(method, params, timeoutMs);
      if (!r.ok) throw new Error(`${method}: ${r.error}`);
      return r.result;
    };
    const tool = async (name, utterance, args) => {
      const r = await control("/tool", { name, utterance, args });
      toolLog.push(r);
      if (!r.ok) return { ok: false, say: `(control) ${r.error}`, raw: r };
      return { ...r.outcome, events: r.events };
    };
    const answer = async (words) => {
      const r = await control("/answer", { words });
      toolLog.push(r);
      return r.result ?? { ok: false, say: r.error };
    };
    const state = () => control("/state", {});

    // 4. Edge.
    const edgeArgs = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${dirs.profile}`,
      `--remote-debugging-port=${PORTS.devtools}`,
      "--ignore-certificate-errors",
      `--load-extension=${dirs.ext}`,
      // No real site can be reached from this browser, and it does no background networking of its own.
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-pings",
      "--disable-domain-reliability",
      "--window-size=1280,900",
      "about:blank",
    ];
    procs.edge = spawn(EDGE, edgeArgs, { stdio: "ignore" });
    const version = await until(async () => (await fetch(`http://127.0.0.1:${PORTS.devtools}/json/version`)).json(), 30_000, 300);
    if (!version?.webSocketDebuggerUrl) throw new Error("Edge's DevTools port never answered");
    console.log(`Edge: ${version.Browser}`);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const sessions = new Map();
    cdp.listeners.add((m) => {
      if (m.method === "Target.detachedFromTarget") for (const [t, s] of sessions) if (s === m.params.sessionId) sessions.delete(t);
    });
    const targets = async () => (await cdp.send("Target.getTargets")).targetInfos;
    const pages = async () => (await targets()).filter((t) => t.type === "page");
    const sessionFor = async (targetId) => {
      if (sessions.has(targetId)) return sessions.get(targetId);
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      sessions.set(targetId, sessionId);
      return sessionId;
    };
    const evalIn = async (targetId, expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, await sessionFor(targetId));
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const targetOf = async (urlPart) => (await pages()).find((t) => t.url.includes(urlPart)) ?? null;
    const targetAt = async (url) => (await pages()).find((t) => t.url === url) ?? null;
    const clickAt = async (targetId, elementExpr) => {
      const box = await evalIn(targetId, `(() => { const el = ${elementExpr}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!box) throw new Error(`nothing to click: ${elementExpr}`);
      const s = await sessionFor(targetId);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, s);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, s);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, s);
    };
    const typeInto = async (targetId, elementExpr, text) => {
      await clickAt(targetId, elementExpr);
      await cdp.send("Input.insertText", { text }, await sessionFor(targetId));
    };

    // The extension's service worker: its id, and its console kept for the canary and for reading failures.
    // (Edge runs built-in extensions of its own, some with a background.js too: ours is found by its name, and the copy
    // it runs must be the one that points at this run's engine.)
    const worker = await until(async () => {
      for (const t of (await targets()).filter((x) => x.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url)))
        if ((await evalIn(t.targetId, "chrome.runtime.getManifest().name").catch(() => null)) === "Trinity Browser Bridge") return t;
      return null;
    }, 20_000);
    if (!worker) throw new Error("the extension's service worker never showed up: Edge didn't load the copy");
    const extId = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url)[1];
    const pointsHere = await evalIn(worker.targetId, `fetch(chrome.runtime.getURL("background.js")).then((r) => r.text()).then((t) => t.includes('const DEFAULT_ENGINE = "ws://127.0.0.1:${PORTS.engine}"') && !t.includes('const DEFAULT_ENGINE = "ws://127.0.0.1:${LIVE_ENGINE_PORT}"'))`);
    if (pointsHere !== true) throw new Error("the extension Edge loaded isn't the copy that points at this run's engine");
    const workerLog = [];
    const watchWorker = async () => {
      const w = (await targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
      if (!w) return;
      const s = await sessionFor(w.targetId);
      await cdp.send("Runtime.enable", {}, s).catch(() => {});
    };
    cdp.listeners.add((m) => {
      if (m.method === "Runtime.consoleAPICalled") {
        const line = `${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`;
        workerLog.push(line);
        fs.appendFileSync(workerLogFile, `${line}\n`);
      } else if (m.method === "Runtime.exceptionThrown") {
        const line = `exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`;
        workerLog.push(line);
        fs.appendFileSync(workerLogFile, `${line}\n`);
      }
    });
    await watchWorker();
    console.log(`extension loaded: ${extId}`);

    // Tabs: open a fixture page through the extension, and find its DevTools target by its (unique) address.
    let opened = 0;
    const fresh = async (page, base = HTTPS) => {
      const url = `${base}/${page}${page.includes("?") ? "&" : "?"}n=${++opened}`;
      const t = await bridge("tabs.open", { url, where: "new", active: true });
      await bridge("page.wait", { tabId: t.id, for: "load", timeoutMs: 10_000 }, 15_000);
      const target = await until(() => targetAt(url), 8000);
      if (!target) throw new Error(`no DevTools target for ${url}`);
      await until(async () => (await state()).browser.tabs.some((x) => x.id === t.id && x.active), 4000);
      return { id: t.id, url, target: target.targetId };
    };
    const tabsNow = async () => (await bridge("tabs.list")).tabs;
    const value = (t, expr) => evalIn(t.target, expr);
    const field = (t, id) => value(t, `document.getElementById(${J(id)}) ? document.getElementById(${J(id)}).value : null`);

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // A. Pairing
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    const POPUP = `chrome-extension://${extId}/popup.html`;
    const { targetId: popup } = await cdp.send("Target.createTarget", { url: POPUP, background: true });
    const popupState = () =>
      evalIn(
        popup,
        `(() => { const $ = (id) => document.getElementById(id); return { status: $("statusText").textContent, detail: $("statusText").title, dot: $("dot").className, conn: $("connBtn").hidden ? null : $("connBtn").textContent, pairShown: !$("pairPanel").hidden, pairTitle: $("pairTitle").textContent, note: $("pairNote").textContent, pairBtn: $("pairBtn").textContent, version: $("version").textContent }; })()`,
      );
    // The popup is read with its tab in front (a background tab's timers are throttled; the real popup is on screen).
    const toFront = () => cdp.send("Target.activateTarget", { targetId: popup });
    const popupShows = async (pred, ms = 8000) => {
      await toFront();
      return until(async () => {
        const s = await popupState();
        return pred(s) ? s : null;
      }, ms);
    };
    /** What the worker itself says right now (the same message the popup sends every two seconds). */
    const workerStatus = () => evalIn(popup, `new Promise((r) => chrome.runtime.sendMessage({ type: "status" }, (res) => r(chrome.runtime.lastError ? null : res)))`);
    const pairWith = async (code) => {
      await toFront();
      if (!(await popupState()).pairShown) {
        // Paired already: the code box is behind "Connection" → "Pair with a new code", as a person finds it.
        if (!(await evalIn(popup, `document.getElementById("setup").open`))) await clickAt(popup, `document.querySelector("#setup summary")`);
        await clickAt(popup, `document.getElementById("repairBtn")`);
        await until(async () => (await popupState()).pairShown, 3000);
      }
      await evalIn(popup, `document.getElementById("code").value = ""`);
      await typeInto(popup, `document.getElementById("code")`, code);
      await clickAt(popup, `document.getElementById("pairBtn")`);
      await sleep(300);
      return until(async () => {
        const s = await popupState();
        return s.pairBtn === "Pair" ? s : null;
      }, 20_000);
    };
    const browserInfo = async () => (await api("GET", "/browser")).json;

    const s0 = await popupShows((s) => s.status !== "Checking…", 10_000);
    check("A", "popup (opened as a tab) before pairing says Not paired and shows the code box", s0?.status === "Not paired" && s0?.pairShown && s0?.conn === null, J(s0));
    let b0 = await browserInfo();
    check("A", "engine before pairing: not paired, not connected", b0.paired === false && b0.connected === false, J({ paired: b0.paired, connected: b0.connected }));
    if (wants("A")) {
      // A code typed while the engine has none waiting (it ran out, or was used up).
      const sNone = await pairWith("ABCD-EFGH");
      check("A", "a code typed when none is waiting is refused, and the popup says why", (await browserInfo()).paired === false && /code|pair/i.test(sNone?.note ?? "") && !/is it running/i.test(sNone?.note ?? ""), J({ status: sNone?.status, note: sNone?.note }));
    }

    let code = (await api("POST", "/browser/pairing-code")).json;
    check("A", "engine shows a pairing code (8 characters, 5 tries, about ten minutes)", /^[A-Z2-9]{8}$/.test(code.code) && code.tries === 5 && code.expiresAt - Date.now() > 9 * 60_000, `tries ${code.tries}`);
    const wrongOf = (c) => [...c].map((ch, i) => (i === 3 ? (ch === "A" ? "B" : "A") : ch)).join("");
    const triesLeft = () => [...engineOut.matchAll(/pairing refused: wrong code \((\d+) tries left\)/g)].map((m) => Number(m[1]));
    let s1 = await pairWith(wrongOf(code.code));
    check("A", "a wrong code is refused in the popup", /didn't match/.test(s1?.note ?? "") && s1?.status !== "Connected — Trinity controls this browser", J(s1));
    check("A", "the wrong code counted against the five tries", triesLeft().at(-1) === 4, `engine log: ${J(triesLeft())}`);
    b0 = await browserInfo();
    check("A", "engine after the wrong code: still not paired", b0.paired === false, J({ paired: b0.paired }));

    const pretty = `${code.code.slice(0, 4).toLowerCase()}-${code.code.slice(4)}`;
    await pairWith(pretty);
    const s2 = await popupShows((s) => s.status.startsWith("Connected"), 15_000);
    check("A", "the right code (typed as abcd-EFGH) pairs; the popup says Connected", Boolean(s2) && s2.conn === "Disconnect" && !s2.pairShown, J(s2 ?? (await popupState())));
    let b1 = await until(async () => {
      const b = await browserInfo();
      return b.connected ? b : null;
    }, 10_000);
    const pageCount = (await pages()).length;
    check("A", "GET /api/browser: connected, paired with this extension, with its tabs", b1?.connected === true && b1?.paired === true && b1?.extensionId === extId && b1?.tabs?.length === pageCount, J({ connected: b1?.connected, paired: b1?.paired, id: b1?.extensionId, tabs: b1?.tabs?.length, pages: pageCount, version: b1?.version, chrome: b1?.chrome, caps: b1?.caps }));
    const pairedAt = b1?.pairedAt;

    if (wants("A")) {
      // The code was used: it pairs nothing now — and the paired browser keeps its pairing.
      const s3 = await pairWith(code.code);
      const b3 = await until(async () => {
        const b = await browserInfo();
        return b.connected ? b : null;
      }, 20_000);
      check("A", "a used code no longer pairs (and the pairing in place survives the try)", b3?.pairedAt === pairedAt && /didn't match|no pairing code/.test(s3?.note ?? ""), J({ note: s3?.note, reconnected: Boolean(b3) }));

      // Five wrong tries kill a code, even for the right one — and a paired browser keeps its pairing throughout.
      const c2 = (await api("POST", "/browser/pairing-code")).json;
      const notes = [];
      for (let i = 0; i < 5; i++) notes.push((await pairWith(wrongOf(c2.code)))?.note ?? "");
      check("A", "five wrong tries: each refused, the engine counting 4, 3, 2, 1, 0 left", J(triesLeft().slice(-5)) === J([4, 3, 2, 1, 0]) && notes.every((n) => /didn't match/.test(n)), J({ left: triesLeft(), notes: [...new Set(notes)] }));
      const s4 = await pairWith(c2.code);
      const b4 = await until(async () => {
        const b = await browserInfo();
        return b.connected ? b : null;
      }, 20_000);
      check("A", "after five wrong tries the right code is refused too", b4?.pairedAt === pairedAt && !/^Connected/.test(s4?.note ?? "") && /didn't match|no pairing code/.test(s4?.note ?? ""), J({ note: s4?.note }));
      check("A", "the existing pairing survived all the failed attempts (reconnected on its own)", b4?.connected === true);
      const sNew = await popupShows((s) => s.status.startsWith("Connected"));
      check("A", "…and the popup reads Connected again", Boolean(sNew), J(sNew ?? (await popupState())));

      // An engine restart (as `tsx watch` does on every save): the extension comes back by itself, with the handshake
      // and no new code.
      await stopEngine();
      events?.close();
      const tDown = Date.now();
      const wDown = await until(async () => {
        const w = await workerStatus();
        return w && w.status.state !== "connected" ? w : null;
      }, 10_000, 100);
      const noticed = ((Date.now() - tDown) / 1000).toFixed(1);
      const sDown = await popupShows((s) => /Not connected|Connecting/.test(`${s.status} ${s.detail}`));
      check("A", "engine stopped: the worker notices and the popup says it isn't connected", Boolean(wDown) && Boolean(sDown), `${noticed} s; worker ${wDown?.status.state}; popup ${J(sDown ? { status: sDown.status, detail: sDown.detail } : await popupState())}`);
      const t0 = Date.now();
      await startEngine();
      const started = ((Date.now() - t0) / 1000).toFixed(1);
      events = watchEvents();
      const t1 = Date.now();
      const back = await until(async () => {
        const b = await browserInfo();
        return b.connected ? b : null;
      }, 60_000, 200);
      check("A", "engine restarted: the extension reconnected by itself (mutual handshake, no new code)", back?.connected === true && back?.pairedAt === pairedAt, `reconnected ${((Date.now() - t1) / 1000).toFixed(1)} s after the engine was up (the engine took ${started} s to start; it was down ${((t1 - tDown) / 1000).toFixed(1)} s)`);
      const sBack = await popupShows((s) => s.status.startsWith("Connected"));
      check("A", "the popup says Connected again", Boolean(sBack), J(sBack ?? (await popupState())));

      // Disconnect holds; Connect resumes.
      await clickAt(popup, `document.getElementById("connBtn")`);
      const sOff = await popupShows((s) => s.status.startsWith("Disconnected"));
      check("A", "Disconnect: the popup says Disconnected, the button reads Connect", sOff?.conn === "Connect", J(sOff ?? (await popupState())));
      const offNow = await until(async () => !(await browserInfo()).connected, 5000);
      await sleep(8000);
      const w8 = await workerStatus();
      const stillOff = !(await browserInfo()).connected && Boolean(await popupShows((s) => s.status.startsWith("Disconnected"), 3000)) && w8?.status.state === "paused";
      check("A", "Disconnect holds (8 s later: the engine shows no extension, the worker is paused)", offNow && stillOff, J({ worker: w8?.status.state }));
      await clickAt(popup, `document.getElementById("connBtn")`);
      const sOn = await popupShows((s) => s.status.startsWith("Connected"));
      const onNow = await until(async () => (await browserInfo()).connected, 10_000);
      check("A", "Connect resumes", Boolean(sOn) && Boolean(onNow), J(sOn ?? (await popupState())));

      await block("A", "the popup's share button", async () => {
        // The popup in a tab of its own is itself the tab in front: what goes on the board is the web page used before it.
        await fresh("login.html?a=share");
        await sleep(300);
        await toFront();
        await until(async () => !(await evalIn(popup, `document.getElementById("shareBtn").disabled`)), 5000);
        await clickAt(popup, `document.getElementById("shareBtn")`);
        const said = await until(async () => {
          const t = await evalIn(popup, `document.getElementById("shareBtn").textContent`);
          return /On the board|Not connected/.test(t) ? t : null;
        }, 6000);
        const board = J((await api("GET", "/workspace")).json);
        check("A", "popup in a tab: 'Put this page on Trinity's board' puts the web page used last there, not the popup", said === "On the board." && board.includes("Sign in — Acme Store") && !board.includes("popup.html"), J({ said }));
      });
    }
    await until(async () => (await state()).browser.connected, 10_000);

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // B. Tabs and windows
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    if (wants("B")) {
      let a = null;
      let bTab = null;
      let own = null;
      const history = async (t) => {
        const h = await cdp.send("Page.getNavigationHistory", {}, await sessionFor(t.target));
        return `${h.currentIndex}: ${h.entries.map((e) => e.url.replace(HTTPS, "")).join(" | ")}`;
      };
      await block("B", "tabs: list, open, activate, navigate, history, zoom", async () => {
        const list0 = await tabsNow();
        check("B", "tabs.list: every tab", list0.length === (await pages()).length, `${list0.length} tabs, ${(await pages()).length} pages`);
        a = await fresh("login.html?b=a");
        bTab = await fresh("checkout.html?b=b");
        check("B", "tabs.open: a fixture page in a new tab", Boolean(a.target) && Boolean(bTab.target));
        await bridge("tabs.activate", { tabId: a.id });
        const l = await until(async () => {
          const tabs = await tabsNow();
          return tabs.find((t) => t.id === a.id)?.active ? tabs : null;
        }, 5000);
        const vis = await value(a, "document.visibilityState");
        check("B", "tabs.activate", Boolean(l) && vis === "visible", `visibility ${vis}`);
        await bridge("tabs.navigate", { tabId: a.id, url: `${HTTPS}/two-step.html?b=nav` });
        await bridge("page.wait", { tabId: a.id, for: "load" });
        check("B", "tabs.navigate", (await tabsNow()).find((t) => t.id === a.id)?.url.includes("two-step.html?b=nav"), await history(a));
        const bk = await bridgeTry("tabs.history", { tabId: a.id, action: "back" });
        const wentBack = await until(async () => (await tabsNow()).find((t) => t.id === a.id)?.url.includes("login.html?b=a"), 5000);
        const afterBack = await history(a);
        await bridge("page.wait", { tabId: a.id, for: "load" });
        const fw = await bridgeTry("tabs.history", { tabId: a.id, action: "forward" });
        const wentOn = fw.ok && (await until(async () => (await tabsNow()).find((t) => t.id === a.id)?.url.includes("two-step.html?b=nav"), 5000));
        const rl = await bridgeTry("tabs.history", { tabId: a.id, action: "reload" });
        check("B", "tabs.history: back, forward, reload", bk.ok && wentBack && wentOn && rl.ok, J({ back: bk.ok ? wentBack : bk.error, forward: fw.ok ? wentOn : fw.error, reload: rl.ok || rl.error, historyAfterBack: afterBack }));
        const z1 = await bridge("tabs.zoom", { tabId: a.id, delta: 0.1 });
        const z0 = await bridge("tabs.zoom", { tabId: a.id, reset: true });
        check("B", "tabs.zoom in and back", z1.factor === 1.1 && z0.factor === 1, J({ z1, z0 }));
      });

      await block("B", "tabs: move, duplicate, pin, mute, group, close, reopen", async () => {
        bTab ??= await fresh("checkout.html?b=b");
        const mv = await bridge("tabs.move", { tabId: bTab.id, to: "start" });
        check("B", "tabs.move to the start", mv.index === 0, J(mv));
        const dup = await bridge("tabs.duplicate", { tabId: bTab.id });
        await sleep(400);
        check("B", "tabs.duplicate", (await tabsNow()).some((t) => t.id === dup.id && t.url.includes("checkout.html?b=b")), J({ dup: dup.id }));
        const pin = await bridge("tabs.pin", { tabId: dup.id, pinned: true });
        const unpin = await bridge("tabs.pin", { tabId: dup.id, pinned: false });
        check("B", "tabs.pin / unpin", pin.pinned === true && !unpin.pinned, J({ pin: pin.pinned, unpin: unpin.pinned ?? false }));
        const mute = await bridge("tabs.mute", { tabId: dup.id, muted: true });
        const unmute = await bridge("tabs.mute", { tabId: dup.id, muted: false });
        check("B", "tabs.mute / unmute", mute.muted === true && !unmute.muted, J({ mute: mute.muted, unmute: unmute.muted ?? false }));
        const g = await bridgeTry("tabs.group", { tabIds: [bTab.id, dup.id], title: "E2E" });
        await sleep(300);
        const grouped = (await tabsNow()).filter((t) => t.groupId !== undefined && t.groupId === g.result?.groupId).length;
        const ug = await bridgeTry("tabs.ungroup", { tabIds: [bTab.id, dup.id] });
        await sleep(300);
        const left = (await tabsNow()).filter((t) => t.groupId !== undefined && t.groupId === g.result?.groupId).length;
        check("B", "tabs.group / ungroup", g.ok && grouped === 2 && ug.ok && left === 0, J({ group: g.ok ? g.result : g.error, grouped, ungroup: ug.ok ? ug.result : ug.error, left }));
        await bridge("tabs.close", { tabId: dup.id });
        const closed = await until(async () => !(await tabsNow()).some((t) => t.id === dup.id), 4000);
        const re = await bridgeTry("tabs.reopen", {});
        await sleep(500);
        const back = (await tabsNow()).find((t) => t.url.includes("checkout.html?b=b") && t.id !== bTab.id);
        check("B", "tabs.close, then tabs.reopen brings it back", closed && re.ok && re.result?.ok === true && Boolean(back), J(re.ok ? re.result : re.error));
        if (back) await bridge("tabs.close", { tabId: back.id });
      });

      await block("B", "Trinity's own tab", async () => {
        // The app's page (WEB_PORT) is one of Trinity's origins: never closed, navigated or read.
        own = await bridge("tabs.open", { url: `http://127.0.0.1:${PORTS.app}/?own=1`, where: "new", active: true });
        await sleep(1000); // (page.wait refuses Trinity's own tab too)
        const cOwn = await bridgeTry("tabs.close", { tabId: own.id });
        const nOwn = await bridgeTry("tabs.navigate", { tabId: own.id, url: `${HTTPS}/login.html` });
        const rOwn = await bridgeTry("page.snapshot", { tabId: own.id });
        check("B", "Trinity's own tab: close, navigate and read are refused", !cOwn.ok && !nOwn.ok && !rOwn.ok && /Trinity's own/.test(cOwn.error ?? ""), J({ close: cOwn.error, navigate: nOwn.error, read: rOwn.error }));
        await until(async () => (await state()).browser.tabs.some((t) => t.id === own.id && t.active), 4000);
        const tOwn = await tool("browser_tabs", "close this tab");
        check("B", "tool: 'close this tab' with Trinity's own tab in front closes nothing", tOwn.ok === false && (await tabsNow()).some((t) => t.id === own.id), tOwn.say);
      });

      await block("B", "windows", async () => {
        const w = await bridge("windows.create", { url: `${HTTPS}/login.html?b=win` });
        await sleep(600);
        const inW = (await tabsNow()).filter((t) => t.windowId === w.windowId);
        check("B", "windows.create (with a fixture page)", inW.length === 1 && inW[0].url.includes("login.html?b=win"), J({ windowId: w.windowId, tabs: inW.length }));
        if (bTab) {
          const wasIn = (await tabsNow()).find((t) => t.id === bTab.id)?.windowId;
          const toW = await bridge("tabs.move", { tabId: bTab.id, to: "new-window" });
          await sleep(400);
          check("B", "tabs.move into a new window", (await tabsNow()).find((t) => t.id === bTab.id)?.windowId === toW.windowId && toW.windowId !== wasIn, J({ ...toW, wasIn }));
        }
        const wc = await bridge("windows.close", { windowId: w.windowId });
        await sleep(400);
        check("B", "windows.close", wc.ok && !(await tabsNow()).some((t) => t.windowId === w.windowId), J(wc));
        if (own) {
          const ownWin = (await tabsNow()).find((t) => t.id === own.id).windowId;
          const wOwn = await bridgeTry("windows.close", { windowId: ownWin });
          check("B", "windows.close refuses the window that holds Trinity's own tab", !wOwn.ok && /Trinity's own/.test(wOwn.error ?? ""), wOwn.error);
        }
      });

      await block("B", "a background tab's screenshot", async () => {
        const front = await fresh("login.html?shot=front");
        const behind = await fresh("checkout.html?shot=behind");
        await value(front, `(() => { const s = document.createElement("style"); s.textContent = "html, body { background: rgb(0, 170, 0) !important; }"; document.head.appendChild(s); return true; })()`);
        await value(behind, `(() => { const s = document.createElement("style"); s.textContent = "html, body { background: rgb(210, 0, 0) !important; }"; document.head.appendChild(s); return true; })()`);
        await bridge("tabs.activate", { tabId: front.id });
        await until(async () => (await tabsNow()).find((t) => t.id === front.id)?.active, 4000);
        const keepShot = (name, dataUrl) => fs.writeFileSync(path.join(run, name), Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
        const shot = await bridgeTry("page.capture", { tabId: behind.id });
        const colour = shot.ok ? marginColour(shot.result.dataUrl) : `refused: ${shot.error}`;
        if (shot.ok) keepShot("shot-behind.png", shot.result.dataUrl);
        await sleep(300);
        const frontAgain = (await tabsNow()).find((t) => t.id === front.id)?.active === true;
        check("B", "page.capture of a background tab captures that tab (red), and the front tab is put back", colour === "red" && frontAgain, J({ colour, mean: shot.ok ? meanColour(shot.result.dataUrl) : null, frontAgain }));
        const shotFront = await bridgeTry("page.capture", { tabId: front.id });
        if (shotFront.ok) keepShot("shot-front.png", shotFront.result.dataUrl);
        check("B", "page.capture of the front tab captures it (green)", shotFront.ok && marginColour(shotFront.result.dataUrl) === "green", shotFront.ok ? `${marginColour(shotFront.result.dataUrl)} ${J(meanColour(shotFront.result.dataUrl))}` : shotFront.error);
      });

      await block("B", "the browser_tabs tool", async () => {
        const t1 = await fresh("login.html?b=tools");
        const onT1 = async () => {
          await bridgeTry("tabs.activate", { tabId: t1.id });
          await until(async () => (await state()).browser.tabs.some((t) => t.id === t1.id && t.active), 3000);
        };
        const run1 = async (words, verify, prep = onT1) => {
          if (prep) await prep();
          const r = await tool("browser_tabs", words);
          await sleep(450);
          const ok = r.ok && (verify ? await verify(r) : true);
          check("B", `tool: '${words}'`, ok, r.say);
          return r;
        };
        const t1Now = async () => (await tabsNow()).find((t) => t.id === t1.id);
        await run1("pin this tab", async () => (await t1Now())?.pinned === true);
        await run1("unpin this tab", async () => !(await t1Now())?.pinned);
        await run1("mute this tab", async () => (await t1Now())?.muted === true);
        await run1("unmute this tab", async () => !(await t1Now())?.muted);
        const before = (await tabsNow()).length;
        await run1("duplicate this tab", async () => (await tabsNow()).length === before + 1);
        await run1("which tabs are open", async (r) => /tabs? open/.test(r.say));
        await run1("move this tab to a new window", async () => {
          const all = await tabsNow();
          const me = all.find((t) => t.id === t1.id);
          return Boolean(me) && all.filter((t) => t.windowId === me.windowId).length === 1;
        });
        await run1("close this window", async () => !(await tabsNow()).some((t) => t.id === t1.id));
        await run1("reopen the closed tab", async () => (await tabsNow()).some((t) => t.url.includes("login.html?b=tools")), null);
        const nw = await tool("browser_tabs", "open a new window");
        await sleep(600);
        check("B", "tool: 'open a new window'", nw.ok, nw.say);
        if (nw.ok) {
          const cw = await tool("browser_tabs", "close this window");
          check("B", "tool: 'close this window' (the new one)", cw.ok, cw.say);
        }
      });
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // C. Reading and acting on pages
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    if (wants("C")) {
      await block("C", "snapshots, clicking and typing", async () => {
        const TYPED = { email: `typed.${crypto.randomBytes(3).toString("hex")}@example.test`, pass: `Typed-${crypto.randomBytes(4).toString("hex")}`, card: "4000056655665556" };
        const L = await fresh("login.html?c=snap");
        await typeInto(L.target, `document.getElementById("email")`, TYPED.email);
        await typeInto(L.target, `document.getElementById("password")`, TYPED.pass);
        const snap = await bridge("page.snapshot", { tabId: L.id });
        const sj = J(snap);
        check("C", "snapshot carries no field values (a typed email and password are absent)", !sj.includes(TYPED.email) && !sj.includes(TYPED.pass), `${snap.interactive.length} items`);
        check("C", "snapshot doesn't list the password field", !snap.interactive.some((i) => i.tag === "input" && (i.type === "password" || /^password$/i.test(i.name))));
        check("C", "snapshot lists the email field by its label", snap.interactive.some((i) => i.tag === "input" && i.name === "Email address"), J(snap.interactive.slice(0, 12).map((i) => `${i.ref}:${i.tag}:${i.name}`)));
        const K = await fresh("checkout.html?c=snap");
        await typeInto(K.target, `document.getElementById("ccnum")`, TYPED.card);
        const ks = await bridge("page.snapshot", { tabId: K.id });
        const cardListed = ks.interactive.filter((i) => /card number|security code|expiry/i.test(i.name)).map((i) => i.name);
        check("C", "snapshot of checkout lists no card field and holds no typed card number", cardListed.length === 0 && !J(ks).includes(TYPED.card), J(cardListed));

        // Click by reference.
        const remember = snap.interactive.find((i) => /keep me signed in/i.test(i.name));
        const clicked = remember ? await bridge("page.act", { tabId: L.id, action: "click", ref: remember.ref }) : null;
        check("C", "click by reference (the 'Keep me signed in' box is ticked)", clicked?.ok && (await value(L, `document.querySelector("input[name=remember]").checked`)) === true, J(clicked));
        // Type into a field, by reference and by the tool.
        const search = snap.interactive.find((i) => i.name === "Search products");
        const typed = search ? await bridge("page.act", { tabId: L.id, action: "type", ref: search.ref, text: "blue widgets" }) : null;
        check("C", "type into a field by reference", typed?.ok && (await value(L, `document.querySelector("input[name=q]").value`)) === "blue widgets", J(typed));
        const secretType = await bridge("page.act", { tabId: L.id, action: "type", selector: "#password", text: "nope" });
        check("C", "typing into a password field is refused", secretType?.ok === false && secretType.error === "secret field", J(secretType));
        await bridge("tabs.activate", { tabId: L.id });
        await until(async () => (await state()).browser.tabs.some((t) => t.id === L.id && t.active), 3000);
        const tn = await tool("browser_act", "type hello there in the newsletter box");
        check("C", "tool: 'type hello there in the newsletter box' (typed, not sent)", tn.ok && (await value(L, `document.getElementById("news").value`)) === "hello there" && !posts.some((p) => p.path === "/newsletter"), tn.say);
        // Typing into a search box is a search (services/browser-words.ts): the box's own form goes.
        const tt = await tool("browser_act", "type red widgets in the search products box");
        const searched = await until(async () => (await tabsNow()).find((t) => t.id === L.id)?.url.includes("/search?q=red+widgets"), 5000);
        check("C", "tool: 'type red widgets in the search products box' types and searches", tt.ok && /searched/.test(tt.say) && Boolean(searched), tt.say);
      });

      await block("C", "a React-controlled input", async () => {
        const R = await fresh("react-form.html?c=react");
        const rs = await bridge("page.snapshot", { tabId: R.id });
        const user = rs.interactive.find((i) => i.name === "Username");
        const rt = user ? await bridge("page.act", { tabId: R.id, action: "type", ref: user.ref, text: "e2e-tester" }) : null;
        await sleep(900);
        const kept = await value(R, `({ value: document.getElementById("user").value, state: document.getElementById("state").textContent })`);
        check("C", "a React-controlled input keeps the typed value after re-renders", rt?.ok && kept.value === "e2e-tester" && /username 10 chars/.test(kept.state), J(kept));
      });

      await block("C", "a form in a shadow root", async () => {
        const S = await fresh("shadow-form.html?c=shadow");
        const ss = await bridge("page.snapshot", { tabId: S.id });
        const su = ss.interactive.find((i) => i.name === "User name");
        const sb = ss.interactive.find((i) => i.name === "Log in");
        const st1 = su ? await bridge("page.act", { tabId: S.id, action: "type", ref: su.ref, text: "shadow-user" }) : null;
        const sv = await value(S, `document.querySelector("login-box").shadowRoot.getElementById("u").value`);
        const sc = sb ? await bridge("page.act", { tabId: S.id, action: "click", ref: sb.ref }) : null;
        await sleep(300);
        const sbt = await value(S, `document.querySelector("login-box").shadowRoot.getElementById("go").textContent`);
        check("C", "shadow-DOM form: listed, typed into and its button pressed", Boolean(su && sb) && st1?.ok && sv === "shadow-user" && sc?.ok && /Logged in/.test(sbt), J({ listed: Boolean(su && sb), typed: sv === "shadow-user", button: sbt }));
      });

      await block("C", "Enter, submit and Pay on a spending page", async () => {
        const P = await fresh("checkout.html?c=spend");
        await clickAt(P.target, `document.getElementById("fullname")`);
        const raw = await bridge("page.act", { tabId: P.id, action: "press", key: "Enter" });
        check("C", "Enter in a pay form: the extension holds it and names the button", raw?.held === true && raw.name === "Pay $51.25", J(raw));
        const enter = await tool("browser_act", "press enter");
        check("C", "tool 'press enter' on checkout asks first, naming the site and the total", enter.ok && /127\.0\.0\.1/.test(enter.say) && /\$51\.25/.test(enter.say) && /Pay \$51\.25/.test(enter.say), enter.say);
        const no1 = await answer("no");
        const sub = await tool("browser_act", "type Ada in the full name box and submit");
        const no2 = sub.ok && /\$51\.25/.test(sub.say) ? await answer("no") : null;
        const pay = await tool("browser_act", "click pay");
        const no3 = pay.ok && /\$51\.25/.test(pay.say) ? await answer("no") : null;
        await sleep(400);
        const payText = await value(P, `document.getElementById("paybtn").textContent`);
        check("C", "'type … and submit' and 'click pay' ask first too; after 'no' nothing was pressed", Boolean(no2) && Boolean(no3) && payText === "Pay $51.25" && !posts.some((p) => p.path === "/pay"), J({ submit: sub.say, click: pay.say, answers: [no1?.say, no2?.say, no3?.say], payText }));
      });

      await block("C", "an inner scroller", async () => {
        const Q = await fresh("scroller.html?c=scroll");
        const sr = await bridge("page.act", { tabId: Q.id, action: "scroll", direction: "down" });
        const top1 = await value(Q, `document.getElementById("list").scrollTop`);
        const ts = await tool("browser_act", "scroll down");
        const top2 = await value(Q, `document.getElementById("list").scrollTop`);
        const tt2 = await tool("browser_act", "scroll to the top");
        const top3 = await value(Q, `document.getElementById("list").scrollTop`);
        check("C", "scrolling moves the inner scroller (down, down again, back to the top)", sr?.ok && sr.moved === true && top1 > 0 && top2 > top1 && top3 === 0, J({ bridge: sr, top1, tool: ts.say, top2, toTop: tt2.say, top3 }));
      });
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // D. Filling from the vault
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
    const hex = (n) => crypto.randomBytes(n).toString("hex");
    const SECRET = {
      user: `ada.fixture.${hex(3)}@example.test`,
      pass: `Invented-${hex(6)}-Pw`,
      totp: [...crypto.randomBytes(16)].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[b & 31]).join(""),
      card: "4242424242424242",
      cvc: "737",
      holder: "Ada Fixture",
      email: `ada.details.${hex(3)}@example.test`,
      phone: "+1 555 0142",
      street: `${100 + crypto.randomInt(800)} Fixture Lane`,
      unit: "Unit 3",
      city: "Testburg",
      zip: "98001",
    };
    if (wants("D")) {
      let saved = false;
      await block("D", "saving invented items", async () => {
        const v0 = (await api("GET", "/vault")).json;
        check("D", "the vault starts empty and may be used", v0.status?.state === "empty" && !v0.status?.blocked, J(v0.status));
        const login = await api("POST", "/vault/items", { kind: "login", values: { label: "Fixture shop", hosts: "127.0.0.1", username: SECRET.user, password: SECRET.pass, totpSecret: SECRET.totp } });
        const card = await api("POST", "/vault/items", { kind: "card", values: { number: "4242 4242 4242 4242", expiry: "12/30", holder: SECRET.holder, keepCvc: true, cvc: SECRET.cvc, label: "Test Visa" } });
        const ident = await api("POST", "/vault/items", {
          kind: "identity",
          values: { label: "Fixture details", fullName: SECRET.holder, email: SECRET.email, phone: SECRET.phone, address1: SECRET.street, address2: SECRET.unit, city: SECRET.city, region: "WA", postalCode: SECRET.zip, country: "United States" },
        });
        saved = check("D", "invented login, card and details saved through the engine", login.json.ok && card.json.ok && ident.json.ok, J([login.json.error, card.json.error, ident.json.error].filter(Boolean)));
        const vaultFiles = fs.readdirSync(dirs.vault);
        check("D", "the vault's files are in this run's vault folder", vaultFiles.length > 0, J(vaultFiles));
      });

      if (saved) {
        await block("D", "sign-in on login.html, and what a filled tab refuses", async () => {
          const L1 = await fresh("login.html?d=fill");
          const s1 = await tool("browser_sign_in", "use my saved password");
          const got1 = await value(L1, `({ u: document.getElementById("email").value === ${J(SECRET.user)}, p: document.getElementById("password").value === ${J(SECRET.pass)}, others: [document.getElementById("news").value, document.querySelector("input[name=q]").value].join("") })`);
          check("D", "sign-in on login.html (https): user name and password filled, nothing else", s1.ok && got1.u && got1.p && got1.others === "" && /^Filled your Fixture shop login on 127\.0\.0\.1/.test(s1.say), `${s1.say} ${J(got1)}`);
          const cap = await bridgeTry("page.capture", { tabId: L1.id });
          const save = await bridgeTry("files.savePage", { tabId: L1.id });
          const js = await bridgeTry("page.inject", { tabId: L1.id, js: "document.title" });
          const css = await bridgeTry("page.inject", { tabId: L1.id, css: "h1 { background: url(/x.png) }" });
          const plain = await bridgeTry("page.inject", { tabId: L1.id, css: "h1 { color: rgb(1, 2, 3) }" });
          check("D", "right after a fill: screenshot, saved copy, script and calling-out CSS refused; plain CSS allowed", !cap.ok && !save.ok && !js.ok && !css.ok && plain.ok, J({ capture: cap.error, save: save.error, js: js.error, css: css.error, plainCss: plain.ok }));
          const saveTool = await tool("browser_save", "save a screenshot of this page");
          check("D", "tool 'save a screenshot' after a fill is refused", saveTool.ok === false, saveTool.say);
          await bridge("tabs.navigate", { tabId: L1.id, url: `${OTHER}/login.html?d=away` });
          await bridge("page.wait", { tabId: L1.id, for: "load" });
          const capAway = await bridgeTry("page.capture", { tabId: L1.id });
          check("D", "after the tab left the site, a screenshot works again", capAway.ok, capAway.error ?? "");
          const bk = await bridgeTry("tabs.history", { tabId: L1.id, action: "back" });
          await until(async () => (await tabsNow()).find((t) => t.id === L1.id)?.url.includes("login.html?d=fill"), 5000);
          await bridgeTry("page.wait", { tabId: L1.id, for: "load" });
          await sleep(300);
          const L1back = await targetOf("login.html?d=fill");
          const restored = L1back ? await evalIn(L1back.targetId, `({ u: document.getElementById("email").value !== "", p: document.getElementById("password").value !== "" })`) : null;
          const capBack = await bridgeTry("page.capture", { tabId: L1.id });
          check("D", "back to the filled page: if it still holds the values, no screenshot", bk.ok && restored && (restored.u || restored.p) ? !capBack.ok : bk.ok, J({ back: bk.ok || bk.error, restored, capture: capBack.ok ? "taken" : capBack.error }));
        });

        await block("D", "sign-in that presses the button", async () => {
          await fresh("login.html?d=submit");
          const before2 = posts.length;
          const mark = engineEvents.length;
          const s2r = await tool("browser_sign_in", "sign in");
          const s2 = s2r.inProgress ? { ...s2r, say: (await told(/Filled your Fixture shop login/, 20_000, mark)) ?? s2r.say } : s2r;
          const sent = await until(() => posts.slice(before2).find((p) => p.path === "/session"), 8000);
          check("D", "'sign in' fills and presses Sign in (the form arrives with both fields)", /pressed the button/.test(s2.say) && sent?.origin === HTTPS && sent.nonEmpty >= 2 && sent.names.includes("password"), `${s2.say} ${J(sent ?? null)}`);
        });

        await block("D", "a sign-in in steps", async () => {
          const T = await fresh("two-step.html?d=steps");
          const mark = engineEvents.length;
          const st = await tool("browser_sign_in", "sign in");
          const stSay = st.inProgress ? ((await told(/Filled your Fixture shop login/, 25_000, mark)) ?? st.say) : st.say;
          const got3 = await value(T, `({ u: document.getElementById("ident").value === ${J(SECRET.user)}, p: document.getElementById("pw").value === ${J(SECRET.pass)}, code: [...document.querySelectorAll("#digits input")].map((i) => i.value).join(""), done: !document.getElementById("done").hidden })`);
          const okCode = [totp(SECRET.totp), totp(SECRET.totp, Date.now() - 30_000), totp(SECRET.totp, Date.now() - 60_000)].includes(got3.code);
          check("D", "two-step.html: user name, Next, password, Sign in, then the 6-box one-time code; Verify not pressed", got3.u && got3.p && okCode && !got3.done && /one-time code/.test(stSay), `${stSay} ${J({ u: got3.u, p: got3.p, codeOk: okCode, verifyPressed: got3.done })}`);
        });

        await block("D", "a card, with a spoken yes", async () => {
          const C1 = await fresh("checkout.html?d=card");
          const c1 = await tool("browser_fill_card", "fill in my card");
          const emptyBefore = (await field(C1, "ccnum")) === "";
          check("D", "card: asks first, naming the card, the site and the total, and the words to say; nothing is filled before the yes", c1.ok && /Test Visa/.test(c1.say) && /127\.0\.0\.1/.test(c1.say) && /\$51\.25/.test(c1.say) && /To go ahead, say: yes, fill it in\.$/.test(c1.say) && emptyBefore, c1.say);
          const bare = await answer("yes");
          check("D", "card: a bare 'yes' fills nothing — the question is asked again", bare.ok === false && /say: yes, fill/.test(bare.say ?? "") && (await field(C1, "ccnum")) === "" && (await state()).question !== null, bare.say);
          const y1 = await answer("yes, fill it in");
          const got4 = await value(C1, `({ num: document.getElementById("ccnum").value.replace(/\\D/g, "") === ${J(SECRET.card)}, name: document.getElementById("ccname").value === ${J(SECRET.holder)}, mm: document.getElementById("expm").value, yy: document.getElementById("expy").value, cvc: document.getElementById("cvc").value === ${J(SECRET.cvc)}, pay: document.getElementById("paybtn").textContent })`);
          check("D", "card filled after 'yes, fill it in' (number, name, expiry 12/30, code); Pay not pressed", y1.ok && got4.num && got4.name && got4.mm === "12" && got4.yy === "30" && got4.cvc && got4.pay === "Pay $51.25" && !posts.some((p) => p.path === "/pay"), `${y1.say} ${J(got4)}`);
        });

        await block("D", "a card above the spending limit", async () => {
          await api("PUT", "/vault/settings", { spendingLimit: 10 });
          try {
            const C2 = await fresh("checkout.html?d=approve");
            const mark = engineEvents.length;
            const c2 = await tool("browser_fill_card", "fill in my card");
            const form = await until(async () => (await state()).forms.find((f) => f.purpose === "confirm"), 5000);
            const nothingYet = (await field(C2, "ccnum")) === "";
            const approved = form ? await api("POST", `/vault/forms/${form.id}`, { values: {} }) : null;
            const c2Said = await told(/Filled your Test Visa/, 15_000, mark);
            const got5 = await value(C2, `document.getElementById("ccnum").value.replace(/\\D/g, "") === ${J(SECRET.card)}`);
            check("D", "card above the spending limit: nothing until the Approve button in the secure form, then filled", /Approve/.test(c2.say) && nothingYet && approved?.json?.status === "approved" && got5 === true, `${c2.say} | ${c2Said}`);
          } finally {
            await api("PUT", "/vault/settings", { spendingLimit: 200 });
          }
        });

        await block("D", "details", async () => {
          const C3 = await fresh("checkout.html?d=details");
          const d1 = await tool("browser_fill_details", "fill in my details");
          const got6 = await value(
            C3,
            `({ name: document.getElementById("fullname").value === ${J(SECRET.holder)}, email: document.getElementById("mail").value === ${J(SECRET.email)}, phone: document.getElementById("phone").value.replace(/\\D/g, "") === ${J(SECRET.phone.replace(/\D/g, ""))}, street: document.getElementById("addr1").value === ${J(SECRET.street)}, unit: document.getElementById("addr2").value === ${J(SECRET.unit)}, city: document.getElementById("city").value, state: document.getElementById("state").value, zip: document.getElementById("zip").value, country: document.getElementById("country").value, card: document.getElementById("ccnum").value + document.getElementById("cvc").value })`,
          );
          check("D", "details filled (name, email, phone, address, state and country chosen); card fields untouched", d1.ok && got6.name && got6.email && got6.phone && got6.street && got6.unit && got6.city === SECRET.city && got6.state === "WA" && got6.zip === SECRET.zip && got6.country === "US" && got6.card === "", `${d1.say} ${J({ ...got6, city: got6.city === SECRET.city, zip: got6.zip === SECRET.zip })}`);
        });

        await block("D", "refusal: a plain-http page", async () => {
          const H = await fresh("login.html?d=http", HTTP);
          const h1 = await tool("browser_sign_in", "sign in");
          const hEmpty = (await field(H, "email")) === "" && (await field(H, "password")) === "";
          const hp = await bridge("page.fillProbe", { tabId: H.id });
          const forged = await control("/secret-fill", { tabId: H.id, documentId: "x", origin: HTTPS, values: { username: "not-a-secret" } });
          const plainOrigin = await control("/secret-fill", { tabId: H.id, documentId: "x", origin: HTTP, values: { username: "not-a-secret" } });
          check("D", "http page: the tool refuses, the probe says insecure, and the extension refuses a fill sealed for https", h1.ok === false && hEmpty && hp.ok === false && hp.code === "insecure" && forged.result?.code === "insecure" && plainOrigin.result?.code === "insecure", `${h1.say} ${J({ probe: hp, forged: forged.result, httpOrigin: plainOrigin.result })}`);
        });

        await block("D", "refusal: hidden fields", async () => {
          const HT = await fresh("hidden-trap.html?d=trap");
          const d2 = await tool("browser_fill_details", "fill in my details");
          const trap = await value(HT, `({ email: document.getElementById("email").value === ${J(SECRET.email)}, others: [...document.querySelectorAll("input")].filter((i) => i.id !== "email" && i.value !== "").map((i) => i.id) })`);
          check("D", "hidden-trap.html: only the visible email is filled", d2.ok && trap.email && trap.others.length === 0, `${d2.say} ${J(trap)}`);
          const c3 = await tool("browser_fill_card", "fill in my card");
          check("D", "hidden-trap.html: no card fields to fill (the hidden ones don't count)", c3.ok === false && /couldn't find card fields/.test(c3.say), c3.say);
        });

        await block("D", "refusal: forms that post elsewhere", async () => {
          const AE = await fresh("action-elsewhere.html?d=elsewhere");
          const a1 = await tool("browser_sign_in", "use my saved password");
          const ae = await value(AE, `Object.fromEntries(["u1","p1","u2","p2","u3","p3","u4","p4"].map((id) => [id, document.getElementById(id).value !== ""]))`);
          check("D", "action-elsewhere.html: no form that posts to another site gets anything; the one that stays is filled", !ae.u1 && !ae.p1 && !ae.u2 && !ae.p2 && !ae.u3 && !ae.p3 && ae.u4 && ae.p4, `${a1.say} ${J(ae)}`);
          await fresh("action-elsewhere.html?d=elsewhere2");
          const before7 = posts.length;
          const mark = engineEvents.length;
          const a2 = await tool("browser_sign_in", "sign in");
          const a2Say = a2.inProgress ? ((await told(/Filled your Fixture shop login|button/, 15_000, mark)) ?? a2.say) : a2.say;
          await sleep(1500);
          const arrived = posts.slice(before7);
          check("D", "action-elsewhere.html with 'sign in': nothing is posted to the other site, and the form pressed is the one that was filled", !arrived.some((p) => p.origin === OTHER) && arrived.some((p) => p.origin === HTTPS && p.path === "/session" && p.nonEmpty >= 2), `${a2Say} ${J(arrived)}`);
        });

        await block("D", "refusal: a card form in another site's frame", async () => {
          const IF = await fresh("iframe-card.html?d=frame");
          const c4 = await tool("browser_fill_card", "fill in my card");
          const y4 = /\?/.test(c4.say) ? await answer("yes, fill it in") : c4;
          const frameTarget = await until(async () => {
            const { frameTree } = await cdp.send("Page.getFrameTree", {}, await sessionFor(IF.target));
            return (frameTree.childFrames ?? []).find((f) => f.frame.url.startsWith(OTHER))?.frame ?? null;
          }, 5000);
          let frameValues = null;
          if (frameTarget) {
            const s = await sessionFor(IF.target);
            const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTarget.id, worldName: "e2e-check" }, s);
            const r = await cdp.send("Runtime.evaluate", { expression: `[...document.querySelectorAll("input")].map((i) => i.value).join("")`, contextId: executionContextId, returnByValue: true }, s);
            frameValues = r.result.value;
          }
          const holder = (await field(IF, "holder")) === SECRET.holder;
          check("D", "iframe-card.html: nothing typed into the payment provider's frame; the reply says so", frameValues === "" && /frame/.test(y4.say ?? ""), `${y4.say} ${J({ frameEmpty: frameValues === "", holderFilled: holder })}`);
        });

        await block("D", "refusal: a page Trinity ran a script in", async () => {
          const SC = await fresh("login.html?d=scripted");
          const inj = await bridgeTry("page.inject", { tabId: SC.id, js: "document.title.length" });
          const sc1 = await tool("browser_sign_in", "use my saved password");
          const scEmpty = (await field(SC, "email")) === "" && (await field(SC, "password")) === "";
          check("D", "a page Trinity ran a script in is not filled", inj.ok && sc1.ok === false && /script/.test(sc1.say) && scEmpty, `${sc1.say}`);
          await bridge("tabs.history", { tabId: SC.id, action: "reload" });
          await bridge("page.wait", { tabId: SC.id, for: "load" });
          await sleep(300);
          const sc2 = await tool("browser_sign_in", "use my saved password");
          check("D", "after a reload (a new document) the same page is filled", sc2.ok && (await field(SC, "password")) === SECRET.pass, sc2.say);
        });

        await block("D", "refusal: envelopes for the wrong origin or document", async () => {
          const OM = await fresh("login.html?d=mismatch");
          const om = await control("/secret-fill", { tabId: OM.id, documentId: "x", origin: OTHER, values: { username: "not-a-secret" } });
          const stale = await control("/secret-fill", { tabId: OM.id, documentId: "0123456789ABCDEF0123456789ABCDEF", origin: HTTPS, values: { username: "not-a-secret" } });
          check("D", "the extension refuses a fill for another origin and for a document that isn't the tab's", om.result?.code === "origin-mismatch" && stale.result?.code === "gone" && (await field(OM, "email")) === "", J({ origin: om.result, stale: stale.result }));
        });
      }

      await block("D", "the canary", async () => {
        // No filled value anywhere it could be seen.
        const needles = [SECRET.pass, SECRET.user, SECRET.totp, SECRET.card, "4242 4242 4242 4242", SECRET.email, SECRET.street];
        const found = [];
        const look = (where, text) => {
          for (const n of needles) if (text.includes(n)) found.push(`${where} holds a filled value (${n === SECRET.pass ? "password" : n === SECRET.totp ? "authenticator key" : n.includes("4242") ? "card number" : "a detail"})`);
        };
        look("the workspace state", J((await api("GET", "/workspace")).json));
        look("a tool result", J(toolLog));
        look("what the engine sent its apps", engineEvents.join("\n"));
        look("the extension's console", workerLog.join("\n"));
        // The data folder is read once the engine has stopped: a running engine holds some of its files shut.
        await stopEngine();
        look("the engine's console", engineOut);
        const unread = [];
        let files = 0;
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else
              try {
                look(`data/${path.relative(dirs.data, full)}`, fs.readFileSync(full).toString("latin1"));
                files++;
              } catch (err) {
                unread.push(`${path.relative(dirs.data, full)} (${err.code ?? err.message})`);
              }
          }
        };
        walk(dirs.data);
        check("D", "no filled value in the engine's console, its data folder, the workspace, any tool result, the app channel or the extension's console", found.length === 0 && unread.length === 0, [...found, ...unread.map((u) => `unreadable: ${u}`)].join("; ") || `${needles.length} values searched for, ${files} data files read`);
      });
    }
  } catch (err) {
    check("-", "the run itself", false, err?.stack ?? String(err));
  } finally {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
    for (const r of bad) console.log(`  FAIL ${r.area} ${r.name}`);
    fs.writeFileSync(path.join(run, "results.json"), JSON.stringify(results, null, 2));
    await cleanup();
    process.exitCode = bad.length ? 1 : 0;
  }
}

if (process.argv.includes("--engine")) await engineMain();
else await driverMain();
