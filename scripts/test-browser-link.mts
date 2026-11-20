// Pairing v2 and the handshake between the engine and the Chrome extension, end to end over a real socket:
// the real bridge (server/src/services/browser-bridge.ts) on a scratch port against a fake extension in Node that
// runs the extension's own protocol code (extension/proto.js) on WebCrypto. Right and wrong codes, the attempt limit,
// an expired code, the MAC both ways, a rogue "engine" that can't prove the key, sockets that never proved anything,
// a replayed `auth`, the Origin gate, replacement, and sealed fill envelopes (only Ks opens them; they expire).
//
//   TRINITY_DATA_DIR=<fresh folder> DOTENV_CONFIG_PATH=<empty file> TRINITY_API_KEY=test-key npx tsx scripts/test-browser-link.mts
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";

// Never the real data folder or .env: a fresh folder and an empty env file, set before the engine's modules load.
const RUN = process.env.TRINITY_DATA_DIR ? path.resolve(process.env.TRINITY_DATA_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), "trinity-link-"));
fs.mkdirSync(RUN, { recursive: true });
process.env.TRINITY_DATA_DIR = RUN;
if (!process.env.DOTENV_CONFIG_PATH) {
  process.env.DOTENV_CONFIG_PATH = path.join(RUN, "empty.env");
  fs.writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
}
process.env.TRINITY_API_KEY = "test-key";
process.env.TRINITY_AUTH = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let passes = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// Everything the engine prints is kept, to prove no code and no secret ever reaches a log line.
const logged: string[] = [];
for (const level of ["log", "warn", "error", "info", "debug"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    real(...args);
  };
}

const bridge = await import("../server/src/services/browser-bridge.ts");
const { requireAuth } = await import("../server/src/auth.ts");
const { browserRouter } = await import("../server/src/routes/browser.ts");
const proto = await import("../extension/proto.js");
const { FakeExtension, rawSocket, FAKE_ID } = await import("./fixtures/browser/fake-extension.mjs");

const app = express();
app.use("/api", requireAuth, browserRouter());
const server = createServer(app);
const upgradeUrls: string[] = [];
server.on("upgrade", (req, sock, head) => {
  upgradeUrls.push(String(req.url));
  bridge.handleBrowserUpgrade(req, sock, head);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const PAIRING_FILE = path.join(RUN, "extension-pairing.json");
const codes: string[] = [];
const issue = () => {
  const c = bridge.newPairingCode();
  codes.push(c.code);
  return c.code;
};
const hmac = (key: string | Buffer, text: string) => crypto.createHmac("sha256", key).update(text, "utf8").digest("base64");

// ── nothing gets in before pairing ────────────────────────────────────────────
type Conn = { state: string; code?: number; reason?: string };
const calls: { method: string; params: Record<string, unknown> }[] = [];
const tabsA = [
  { id: 1, windowId: 1, index: 0, active: true, title: "Sign in — Example", url: "https://www.example.com/login" },
  // Trinity's own page: the app (Vite, WEB_PORT). The engine's own address serves no pages and isn't one of hers.
  { id: 2, windowId: 1, index: 1, active: false, title: "Trinity", url: `http://localhost:${Number(process.env.WEB_PORT) || 5173}/` },
];
const extA = new FakeExtension({
  onCall: (call: { method: string; params: Record<string, unknown> }) => {
    calls.push({ method: call.method, params: call.params });
    return { echo: call.method };
  },
  describe: () => ({ version: "0.2.0", chrome: "156", caps: { userScripts: false, pageCapture: true, fill: true }, tabs: tabsA }),
});
await extA.init();

let r: Conn = await extA.connect(port);
check("unpaired, no code: the upgrade is refused (403)", r.state === "closed" && r.code === 403 && !bridge.browserConnected(), JSON.stringify(r));
check("the extension's own logic won't say hello without a pinned engine key", extA.sent.length === 0);
let raw = rawSocket(port, FAKE_ID, null);
check("no Origin header: refused (403)", (await raw.opened).status === 403);
raw = rawSocket(port, FAKE_ID, "http://localhost:5173");
check("a web page's origin: refused (403)", (await raw.opened).status === 403);
const first = issue();
check("a pairing code is 8 characters from the unambiguous alphabet", /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(first), "(code not shown)");
raw = rawSocket(port, FAKE_ID, "chrome-extension://tooshort");
check("a malformed extension origin: refused (403) even while a code is live", (await raw.opened).status === 403);
raw = rawSocket(port, FAKE_ID, null);
check("still no socket without an Origin while a code is live", (await raw.opened).status === 403);

// ── wrong code, wrong MAC, wrong id ───────────────────────────────────────────
r = await extA.connect(port, { code: "WRONGCDE" });
check("wrong code → closed 4401, nothing paired", r.state === "closed" && r.code === 4401 && !bridge.pairingInfo().paired && extA.enginePub === null, JSON.stringify(r));
raw = rawSocket(port);
await raw.opened;
raw.send({ type: "hello", id: FAKE_ID, nonce: proto.randomNonce() });
check("hello from an extension that never paired → 4401", (await raw.closed) === 4401);
raw = rawSocket(port);
await raw.opened;
raw.send({ type: "call", id: "x", method: "tabs.list", params: {} });
check("anything but pair / hello first → closed (4400)", (await raw.closed) === 4400);
const pubA = await proto.exportPublic(extA.keys.publicKey);
raw = rawSocket(port);
await raw.opened;
raw.send({ type: "pair", id: "ponmlkjihgfedcbaponmlkjihgfedcba", pub: pubA, mac: hmac(first, `trinity-pair-v2|${pubA}`) });
check("right code but an id that isn't the socket's Origin → 4401, nothing paired", (await raw.closed) === 4401 && !bridge.pairingInfo().paired);
raw = rawSocket(port);
await raw.opened;
const junkKey = Buffer.alloc(65, 7);
junkKey[0] = 4;
raw.send({ type: "pair", id: FAKE_ID, pub: junkKey.toString("base64"), mac: hmac(first, `trinity-pair-v2|${junkKey.toString("base64")}`) });
check("right code but a key that isn't on the curve → 4401, nothing paired", (await raw.closed) === 4401 && !bridge.pairingInfo().paired);
check("the code survives three wrong tries of its five", bridge.pairingInfo().codeExpiresAt !== null);

// ── the right code ────────────────────────────────────────────────────────────
r = await extA.connect(port, { code: first.toLowerCase().replace(/^(.{4})/, "$1-") });
check("right code (typed lower-case with a dash) → paired and live", r.state === "live" && bridge.browserConnected(), JSON.stringify(r));
check("the code never crossed the wire", !JSON.stringify(extA.sent).includes(first) && !extA.frames.join("").includes(first));
check("nothing secret in the socket URL", upgradeUrls.every((u) => u === "/ext"), upgradeUrls.join(","));
const order = extA.received.map((m: { type: string }) => m.type);
check("message order: paired, challenge, welcome — and no call before welcome", order.join(",") === "paired,challenge,welcome", order.join(","));
check("the extension pinned the engine's key (65 bytes)", typeof extA.enginePub === "string" && Buffer.from(extA.enginePub, "base64").length === 65);
check("the code is used up", bridge.pairingInfo().codeExpiresAt === null && bridge.pairingInfo().paired && bridge.pairingInfo().extensionId === FAKE_ID);
const file = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf8")) as { engine: { publicKey: string; privateKey: string }; extension: { id: string; publicKey: string } };
check("the pairing file holds the engine's pair and the extension's public key and id — not the code", file.engine.publicKey === extA.enginePub && file.extension.id === FAKE_ID && file.extension.publicKey === pubA && !fs.readFileSync(PAIRING_FILE, "utf8").includes(first));
const st = bridge.browserState();
check("auth carried the version, Chrome and tabs", st.version === "0.2.0" && st.chrome === "156" && st.tabs.length === 2 && st.caps.fill === true, JSON.stringify(st).slice(0, 160));
check("welcome names Trinity's own origins", Array.isArray(extA.welcome?.own) && extA.welcome.own.some((o: string) => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o)), JSON.stringify(extA.welcome));
check("Trinity's own tab is known as hers; the current tab is the web page", bridge.isOwnTab(st.tabs[1]!) && !bridge.isOwnTab(st.tabs[0]!) && bridge.currentBrowserTab()?.id === 1 && bridge.activeTabHost() === "www.example.com");
check("the routing line names hosts, never titles", /example\.com/.test(bridge.describeBrowser() ?? "") && !/Sign in/.test(bridge.describeBrowser() ?? ""), bridge.describeBrowser() ?? "");
let echoed = await bridge.browserCall<{ echo: string }>("tabs.list", {});
check("calls flow once both sides proved the key", echoed.echo === "tabs.list" && calls.length === 1);
const goodHello = extA.sent.find((m: { type: string }) => m.type === "hello");
const goodAuth = extA.sent.find((m: { type: string }) => m.type === "auth");
const goodChallenge = extA.received.find((m: { type: string }) => m.type === "challenge");
check("hello carries an id and a 16-byte nonce, auth a 32-byte proof — no key, no code", Buffer.from(goodHello.nonce, "base64").length === 16 && Buffer.from(goodAuth.proof, "base64").length === 32 && !("pub" in goodHello) && !("token" in goodHello));

// ── a socket that hasn't proved the key never replaces the one that has ────────
raw = rawSocket(port);
await raw.opened;
raw.send({ type: "hello", id: FAKE_ID, nonce: proto.randomNonce() });
const ch1 = await raw.next();
check("a hello from the paired id gets a challenge", ch1?.type === "challenge" && Buffer.from(ch1.nonce, "base64").length === 16);
raw.send({ type: "auth", proof: crypto.randomBytes(32).toString("base64"), version: "9", chrome: "9", caps: {}, tabs: [{ id: 666, windowId: 1, index: 0, active: true, title: "evil", url: "https://evil.example/" }] });
check("a wrong proof → 4401", (await raw.closed) === 4401);
check("…and the proved extension is still the browser", bridge.browserConnected() && bridge.browserState().tabs.length === 2 && bridge.browserState().version === "0.2.0");
const idle = rawSocket(port);
await idle.opened;
idle.send({ type: "hello", id: FAKE_ID, nonce: proto.randomNonce() });
await idle.next();
const idleAt = Date.now();
for (const type of ["tabs", "result", "share", "pong"]) {
  const s = rawSocket(port);
  await s.opened;
  s.send({ type, tabs: [{ id: 667, windowId: 1, index: 0, active: true, title: "evil", url: "https://evil.example/" }], id: "x", ok: true, result: {}, kind: "page", title: "evil", url: "https://evil.example/" });
  check(`an unproved socket sending "${type}" is closed (4400) and changes nothing`, (await s.closed) === 4400 && bridge.browserState().tabs.every((t: { id: number }) => t.id !== 667));
}
echoed = await bridge.browserCall<{ echo: string }>("page.snapshot", {});
check("the first socket still gets the calls", echoed.echo === "page.snapshot" && extA.ws.readyState === extA.ws.OPEN);

// ── replaying an old auth ─────────────────────────────────────────────────────
raw = rawSocket(port);
await raw.opened;
raw.send(goodHello);
const ch2 = await raw.next();
check("the same hello again gets a different challenge", ch2?.type === "challenge" && ch2.nonce !== goodChallenge.nonce && ch2.proof !== goodChallenge.proof);
raw.send(goodAuth);
check("a replayed auth → 4401", (await raw.closed) === 4401 && bridge.browserConnected());
raw = rawSocket(port);
await raw.opened;
raw.send(goodAuth);
check("auth with no hello first → closed (4400)", (await raw.closed) === 4400);
raw = rawSocket(port);
await raw.opened;
raw.send({ type: "hello", id: FAKE_ID, nonce: "short" });
check("a hello with a bad nonce → closed", [4400, 4401].includes(await raw.closed));

// ── a rogue engine can't prove the key: the extension's own logic refuses it ──
const rogueCalls: string[] = [];
const rogue = (behaviour: (ws: import("ws").WebSocket, msg: Record<string, unknown>) => void) =>
  new Promise<{ port: number; close: () => void }>((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve({ port: (wss.address() as { port: number }).port, close: () => wss.close() }));
    wss.on("connection", (ws) => ws.on("message", (rawMsg) => behaviour(ws, JSON.parse(String(rawMsg)) as Record<string, unknown>)));
  });
const victim = new FakeExtension({
  onCall: (call: { method: string }) => {
    rogueCalls.push(call.method);
    return { ok: true };
  },
});
victim.keys = extA.keys;
victim.enginePub = extA.enginePub;
const evilCall = { type: "call", id: "evil", method: "page.inject", params: { js: "alert(1)" } };
let rg = await rogue((ws, msg) => {
  if (msg.type === "hello") {
    ws.send(JSON.stringify({ type: "challenge", nonce: proto.randomNonce(), proof: crypto.randomBytes(32).toString("base64") }));
    ws.send(JSON.stringify({ type: "welcome" }));
    ws.send(JSON.stringify(evilCall));
  }
});
r = await victim.connect(rg.port);
await sleep(100);
check("rogue engine, made-up proof → refused as engine-unproven; no auth sent, no call run", r.state === "refused" && r.reason === "engine-unproven" && !victim.sent.some((m: { type: string }) => m.type === "auth") && rogueCalls.length === 0, JSON.stringify(r));
rg.close();
rg = await rogue((ws, msg) => {
  if (msg.type === "hello") {
    ws.send(JSON.stringify({ type: "welcome" }));
    ws.send(JSON.stringify(evilCall));
  }
});
r = await victim.connect(rg.port);
await sleep(100);
check("rogue engine skipping the challenge → refused; no call run", r.state === "refused" && rogueCalls.length === 0, JSON.stringify(r));
rg.close();
rg = await rogue((ws, msg) => {
  if (msg.type === "hello") {
    ws.send(JSON.stringify(goodChallenge)); // a real proof, but for another connection's nonce
    ws.send(JSON.stringify(evilCall));
  }
});
r = await victim.connect(rg.port);
await sleep(100);
check("rogue engine replaying a real challenge → refused (the proof covers this connection's nonce)", r.state === "refused" && r.reason === "engine-unproven" && rogueCalls.length === 0, JSON.stringify(r));
rg.close();
// This one speaks first: a call before anything at all was proved.
const speaksFirst = await new Promise<{ port: number; close: () => void }>((resolve) => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve({ port: (wss.address() as { port: number }).port, close: () => wss.close() }));
  wss.on("connection", (ws) => ws.send(JSON.stringify(evilCall)));
});
r = await victim.connect(speaksFirst.port);
await sleep(100);
check("a call from an engine that has proved nothing is never run", rogueCalls.length === 0 && r.state !== "live", JSON.stringify(r));
speaksFirst.close();
// Pairing with a rogue: it doesn't know the code, so its `paired` can't carry the right MAC, and the pin doesn't move.
const rogueKeys = crypto.createECDH("prime256v1");
rogueKeys.generateKeys();
rg = await rogue((ws, msg) => {
  if (msg.type === "pair") ws.send(JSON.stringify({ type: "paired", pub: rogueKeys.getPublicKey().toString("base64"), mac: hmac("GUESSED1", `trinity-paired-v2|${rogueKeys.getPublicKey().toString("base64")}|${String(msg.pub)}`) }));
});
const pinBefore = victim.enginePub;
r = await victim.connect(rg.port, { code: "ABCDEFGH" });
check("a rogue's `paired` with a MAC it couldn't make → pair-refused; the pinned key is unchanged", r.state === "refused" && r.reason === "pair-refused" && victim.enginePub === pinBefore, JSON.stringify(r));
rg.close();
rg = await rogue((ws, msg) => {
  if (msg.type === "hello") ws.send(JSON.stringify({ type: "paired", pub: rogueKeys.getPublicKey().toString("base64"), mac: "AAAA" }));
});
r = await victim.connect(rg.port);
check("an unasked-for `paired` can't re-pin the engine key", r.state === "refused" && victim.enginePub === pinBefore, JSON.stringify(r));
rg.close();
check("the real link sat through all that", bridge.browserConnected() && extA.ws.readyState === extA.ws.OPEN);

// ── a newer proved socket replaces the older one (4409) ───────────────────────
const twin = new FakeExtension({
  onCall: (call: { method: string }) => ({ echo: `twin:${call.method}` }),
  describe: () => ({ version: "0.2.1", chrome: "157", caps: { userScripts: true, pageCapture: true, fill: true }, tabs: [tabsA[0]] }),
});
twin.keys = extA.keys;
twin.enginePub = extA.enginePub;
const oldClosed = new Promise<number>((resolve) => extA.ws.on("close", (c: number) => resolve(c)));
const spam = setInterval(() => extA.send({ type: "tabs", tabs: [{ id: 666, windowId: 1, index: 0, active: true, title: "stale", url: "https://stale.example/" }] }), 1);
r = await twin.connect(port);
const oldCode = await oldClosed;
clearInterval(spam);
await sleep(60);
check("a second proved socket takes over; the first is closed with 4409", r.state === "live" && oldCode === 4409, `${JSON.stringify(r)} ${oldCode}`);
check("messages from the replaced socket don't count", bridge.browserState().tabs.length === 1 && bridge.browserState().tabs[0]!.id === 1 && bridge.browserState().version === "0.2.1", JSON.stringify(bridge.browserState().tabs));
echoed = await bridge.browserCall<{ echo: string }>("tabs.list", {});
check("calls go to the newer socket", echoed.echo === "twin:tabs.list");
twin.close();
await sleep(80);
check("closed: not connected, and a call is refused at once", !bridge.browserConnected() && (await bridge.browserCall("tabs.list", {}).then(() => "ran", (e: Error) => e.message)) === "the browser extension isn't connected");

// ── reconnecting needs no code ────────────────────────────────────────────────
r = await extA.connect(port);
check("reconnect with hello alone (the keys interoperate again)", r.state === "live" && extA.sent[0].type === "hello" && bridge.browserConnected(), JSON.stringify(r));

// ── expired code, attempt limit ───────────────────────────────────────────────
const extB = new FakeExtension({ id: "bcdefghijklmnopabcdefghijklmnopa", onCall: () => ({ echo: "B" }) });
await extB.init();
const stale = issue();
const realNow = Date.now;
Date.now = () => realNow() + 11 * 60_000;
r = await extB.connect(port, { code: stale });
Date.now = realNow;
check("an expired code is refused", r.state === "closed" && (r.code === 4401 || r.code === 403) && bridge.pairingInfo().extensionId === FAKE_ID, JSON.stringify(r));
const limited = issue();
const wrong: Conn[] = [];
for (let i = 0; i < 5; i++) wrong.push(await extB.connect(port, { code: `WRONG${i}XY` }));
check("five wrong tries are each closed 4401", wrong.every((w) => w.state === "closed" && w.code === 4401), JSON.stringify(wrong));
r = await extB.connect(port, { code: limited });
check("after five wrong tries even the right code is refused", r.state === "closed" && (r.code === 4401 || r.code === 403) && bridge.pairingInfo().extensionId === FAKE_ID && bridge.pairingInfo().codeExpiresAt === null, JSON.stringify(r));
check("the paired extension was untouched by all that", bridge.browserConnected() && extA.ws.readyState === extA.ws.OPEN);
r = await extB.connect(port);
check("another extension, no code live: its origin is refused at the upgrade (403)", r.state === "closed" && r.code === 403, JSON.stringify(r));

// ── pairing another extension replaces the pairing ────────────────────────────
const aClosed = new Promise<number>((resolve) => extA.ws.on("close", (c: number) => resolve(c)));
r = await extB.connect(port, { code: issue() });
check("a new code pairs another extension", r.state === "live" && bridge.pairingInfo().extensionId === extB.id, JSON.stringify(r));
check("the extension paired before is closed with 4401 (pair again)", (await aClosed) === 4401);
r = await extA.connect(port);
check("…and its old key no longer opens anything", r.state === "closed" && r.code === 403, JSON.stringify(r));
issue();
r = await extA.connect(port);
check("even with a code live, hello from the unpaired id → 4401", r.state === "closed" && r.code === 4401, JSON.stringify(r));

// ── sealed fills ──────────────────────────────────────────────────────────────
const CANARY = "s3cr3t-CANARY-pass-7Q";
const CARD = "4242424242424242";
type FillCall = { id: string; method: string; params: { tabId: number; documentId: string; origin: string; sealed: { iv: string; ct: string } } };
let lastFill: FillCall | null = null;
let fillMode: "open" | "throw" | "lie" | "wrong-tab" | "wrong-origin" | "wrong-id" | "late" = "open";
let opened: Record<string, string> | null = null;
let openError = "";
extB.onCall = async (call: FillCall, link: { openFill: (id: string, origin: string, tabId: number, sealed: unknown) => Promise<Record<string, string>> }) => {
  if (call.method !== "page.fill") return { echo: call.method };
  lastFill = call;
  opened = null;
  openError = "";
  const p = call.params;
  const realNow2 = Date.now;
  try {
    if (fillMode === "late") Date.now = () => realNow2() + 11_000;
    opened = await link.openFill(fillMode === "wrong-id" ? "another-call" : call.id, fillMode === "wrong-origin" ? "https://evil.example" : p.origin, fillMode === "wrong-tab" ? p.tabId + 1 : p.tabId, p.sealed);
  } catch (err) {
    openError = String((err as { code?: string }).code);
    return { ok: false, code: openError === "expired" ? "expired" : "gone" };
  } finally {
    Date.now = realNow2;
  }
  if (fillMode === "throw") throw new Error(`boom ${opened.password}`);
  if (fillMode === "lie") return { ok: true, filled: ["username", "password", opened.password, "cc-number<script>"], missing: [opened.username], step: "done", value: opened.password, frames: 2, note: opened.password };
  return { ok: true, filled: Object.keys(opened), missing: [], step: "done" };
};
const fill = (values: Record<string, string>, origin = "https://www.example.com", tabId = 7) => bridge.browserSecretCall("page.fill", { tabId, documentId: "DOC1", origin, values });
let fr = await fill({ username: "ryan@example.com", password: CANARY });
check("a sealed fill opens with this connection's key and comes back as kinds only", fr.ok === true && fr.filled.join(",") === "username,password" && opened !== null && (opened as Record<string, string>).password === CANARY, JSON.stringify(fr));
check("the envelope on the wire holds no plaintext", !extB.frames.join("\n").includes(CANARY) && !extB.frames.join("\n").includes("ryan@example.com") && typeof lastFill!.params.sealed.ct === "string" && Buffer.from(lastFill!.params.sealed.iv, "base64").length === 12);
const sealed1 = lastFill!;
for (const mode of ["wrong-tab", "wrong-origin", "wrong-id"] as const) {
  fillMode = mode;
  fr = await fill({ password: CANARY });
  check(`the envelope is bound to its ${mode.replace("wrong-", "")}: opening it for another fails`, fr.ok === false && openError === "sealed" && opened === null, `${JSON.stringify(fr)} ${openError}`);
}
fillMode = "late";
fr = await fill({ password: CANARY });
check("an envelope older than ten seconds is refused (expired)", fr.ok === false && fr.code === "expired" && openError === "expired", JSON.stringify(fr));
fillMode = "lie";
fr = await fill({ username: "ryan@example.com", password: CANARY, "cc-number": CARD });
check("only whitelisted fields and known kinds come back, whatever the extension says", fr.ok === true && fr.filled.join(",") === "username,password" && fr.missing.length === 0 && fr.frames === 2 && !JSON.stringify(fr).includes(CANARY) && !JSON.stringify(fr).includes("ryan@"), JSON.stringify(fr));
fillMode = "throw";
fr = await fill({ password: CANARY });
check("an extension error becomes a fixed code — its words are dropped", fr.ok === false && fr.code === "failed" && !JSON.stringify(fr).includes("boom"), JSON.stringify(fr));
fillMode = "open";
fr = await fill({ password: CANARY }, "http://www.example.com");
check("an http origin is refused before anything is sent (insecure)", fr.ok === false && fr.code === "insecure" && lastFill!.params.origin !== "http://www.example.com", JSON.stringify(fr));
fr = await fill({ password: CANARY }, "https://www.example.com/login");
check("an origin with a path is refused before anything is sent", fr.ok === false && fr.code === "origin-mismatch", JSON.stringify(fr));
const viaPlain = await bridge.browserCall("page.fill", { tabId: 7, values: { password: CANARY } }).then(() => "sent", (e: Error) => e.message);
check("page.fill can't go through the plain call path", /browserSecretCall/.test(viaPlain) && !extB.frames.join("\n").includes(CANARY), viaPlain);
// Another connection has another Ks: yesterday's envelope is noise to it.
extB.close();
await sleep(60);
r = await extB.connect(port);
let crossSession = "";
try {
  await extB.link.openFill(sealed1.id, sealed1.params.origin, sealed1.params.tabId, sealed1.params.sealed);
  crossSession = "opened";
} catch (err) {
  crossSession = String((err as { code?: string }).code);
}
check("an envelope from one connection can't be opened in the next (Ks is per connection)", r.state === "live" && crossSession === "sealed", crossSession);
// A key that isn't Ks at all.
const stray = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["decrypt"]);
const strayOpen = await proto.openSealed(stray, sealed1.params.sealed, proto.fillAad(sealed1.id, sealed1.params.origin, sealed1.params.tabId)).then(() => "opened", () => "refused");
check("only Ks opens an envelope", strayOpen === "refused");
extB.close();
await sleep(60);
fr = await fill({ password: CANARY });
check("no extension: the fill says not-connected", fr.ok === false && fr.code === "not-connected", JSON.stringify(fr));

// ── unpairing ─────────────────────────────────────────────────────────────────
r = await extB.connect(port);
const bClosed = new Promise<number>((resolve) => extB.ws.on("close", (c: number) => resolve(c)));
check("unpair: the extension is forgotten and its socket closed 4401", r.state === "live" && bridge.unpairBrowser() === true && (await bClosed) === 4401 && !bridge.pairingInfo().paired && !bridge.browserConnected());
r = await extB.connect(port);
check("…and it can't come back without a code", r.state === "closed" && r.code === 403, JSON.stringify(r));

// ── the HTTP side: behind auth, and no key or token in it ─────────────────────
const http = async (method: string, route: string, key?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
check("GET /api/browser needs auth", (await http("GET", "/browser")).status === 401);
check("POST /api/browser/pairing-code needs auth", (await http("POST", "/browser/pairing-code")).status === 401 && (await http("POST", "/browser/pairing-code", "wrong-key")).status === 401);
const made = await http("POST", "/browser/pairing-code", "test-key");
check("POST /api/browser/pairing-code gives a code and its expiry", made.status === 200 && /^[A-HJKMNP-Z2-9]{8}$/.test(String(made.body?.code)) && Number(made.body?.expiresAt) > Date.now());
codes.push(String(made.body?.code));
r = await extA.connect(port, { code: String(made.body?.code) });
const got = await http("GET", "/browser", "test-key");
const gotText = JSON.stringify(got.body);
check("GET /api/browser: state, paired, tabs as host + title — no token, no key, no code, no full address", got.status === 200 && got.body?.paired === true && got.body?.connected === true && !("token" in got.body!) && !/privateKey|publicKey/.test(gotText) && !codes.some((c) => gotText.includes(c)) && !/https?:\/\//.test(JSON.stringify(got.body?.tabs)) && /"host":"example\.com"/.test(gotText) && typeof got.body?.extensionDir === "string", gotText.slice(0, 260));
check("DELETE /api/browser/pairing needs auth, then unpairs", (await http("DELETE", "/browser/pairing")).status === 401 && (await http("DELETE", "/browser/pairing", "test-key")).body?.wasPaired === true && !bridge.pairingInfo().paired);

// ── sockets that prove nothing don't linger, and can't shut the real extension out ──
const idleCode = await idle.closed;
check("a socket that never finishes the handshake is closed (4408) within ten seconds", idleCode === 4408 && Date.now() - idleAt < 10_500, `${idleCode} after ${Date.now() - idleAt} ms`);
issue();
const lurkers = [];
for (let i = 0; i < 8; i++) {
  const s = rawSocket(port);
  await s.opened;
  lurkers.push(s);
}
await sleep(50);
const evicted = await Promise.race([lurkers[0]!.closed, sleep(1000).then(() => "open")]);
r = await extA.connect(port, { code: codes[codes.length - 1]! });
check("idle unproved sockets are few (the oldest makes room) and the real extension still pairs", evicted === 4408 && r.state === "live", `${evicted} ${JSON.stringify(r)}`);
for (const s of lurkers) s.ws.terminate();

// ── nothing secret was ever logged ────────────────────────────────────────────
const logText = logged.join("\n");
check("no pairing code in any log line", codes.every((c) => !logText.includes(c)));
check("no fill value in any log line", !logText.includes(CANARY) && !logText.includes(CARD) && !logText.includes("ryan@example.com"));
check("no key material in any log line", !logText.includes(file.engine.privateKey) && !logText.includes(file.engine.publicKey));

extA.close();
server.close();
console.log(`\n${passes} passed, ${fails} failed`);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
