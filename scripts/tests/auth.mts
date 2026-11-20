// Authentication of the engine's HTTP API and sockets: a scratch engine on 8891, attacked every way the security review
// described — no credentials, a page on another port, a relayed cookie, a forged Referer, a guessed pairing code — and
// used the two legitimate ways: a linked browser on the app's own pages, and the API key.
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through its launcher (npm test -- --only <name>, or npm run harness for the app harness): it gives the engine a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const PORT = 8891;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
await import(pathToFileURL(`${REPO}/server/src/index.ts`).href);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "http://localhost:5173"; // the Vite app's origin
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(250);
}

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
// Browser traffic reaches the engine through Trinity's own web server (Vite's proxy), which adds this secret: the
// helpers send it by default, as that proxy would; `bare` sends exactly the headers given (a page talking to the engine
// straight, or a different program on the app's port).
const PROXY_KEY = fs.readFileSync(`${process.env.TRINITY_DATA_DIR}/proxy.key`, "utf8").trim();
const viaProxy = (headers: Record<string, string>) => ({ "x-trinity-proxy": PROXY_KEY, ...headers });
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${BASE}${path}`, { headers: viaProxy(headers) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: viaProxy({ "content-type": "application/json", ...headers }), body: JSON.stringify(body) });
const bare = (path: string, headers: Record<string, string>, method = "GET") => fetch(`${BASE}${path}`, { method, headers });
/** Headers a browser sends from the app's own page on a same-origin GET. */
const sameOrigin = (cookie: string, origin = APP) => ({ cookie, "sec-fetch-site": "same-origin", referer: `${origin}/` });
function ws(path: string, headers: Record<string, string> & { bare?: string }): Promise<"open" | number> {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers: headers.bare ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "bare")) : viaProxy(headers) });
    s.on("open", () => {
      s.close();
      resolve("open");
    });
    s.on("unexpected-response", (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    s.on("error", () => resolve(0));
  });
}

// 1 — nobody is linked yet, and nothing gets in without credentials
check("health check stays open", (await get("/healthz")).status === 200);
check("no credentials: the API refuses", (await get("/api/status")).status === 401);
check("no credentials: memories refused", (await get("/api/memory")).status === 401);
check("no credentials: a write is refused", (await post("/api/heartbeat", { instruction: "Remind me to x.", once: true, intervalSec: 60 })).status === 401);
const st0 = (await (await get("/api/auth/status")).json()) as Record<string, unknown>;
check("status: not linked, and no code needed for the first browser", st0.auth === "on" && st0.linked === false && st0.needsCode === false, JSON.stringify(st0));
check("socket /ws refused without credentials", (await ws("/ws", {})) === 401);
check("socket /call refused without credentials", (await ws("/call?standby=1", {})) === 401);
check("socket /ws/workspace refused without credentials", (await ws("/ws/workspace", {})) === 401);

// 2 — linking: only from the app's own origin
check("link refused from another port's page", (await post("/api/auth/enroll", {}, { origin: "http://localhost:3000" })).status === 403);
check("link refused with no Origin at all", (await post("/api/auth/enroll", {})).status === 403);
const first = await post("/api/auth/enroll", {}, { origin: APP });
const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
check("the first browser links freely and gets a cookie", first.status === 200 && cookie.startsWith("trinity_session="), first.headers.get("set-cookie")?.replace(/=[^;]+/, "=…") ?? "");
check("the cookie is HttpOnly and SameSite=Strict", /HttpOnly/i.test(first.headers.get("set-cookie") ?? "") && /SameSite=Strict/i.test(first.headers.get("set-cookie") ?? ""));

// 3 — a linked browser, on the app's own pages
check("linked browser, same-origin GET: allowed", (await get("/api/status", sameOrigin(cookie))).status === 200);
check("linked browser, POST with the app's Origin: allowed", (await post("/api/auth/code", {}, { cookie, origin: APP })).status === 200);
check("linked browser, user opened the address directly: allowed", (await get("/api/status", { cookie, "sec-fetch-site": "none" })).status === 200);
check("socket /ws with cookie + the app's Origin: opens", (await ws("/ws", { cookie, origin: APP })) === "open");
check("socket /ws/workspace with cookie + the app's Origin: opens", (await ws("/ws/workspace", { cookie, origin: "http://127.0.0.1:5173" })) === "open");

// 3b — the same cookie and the app's own origin, but not through Trinity's web server: a different program on the
// app's port (its pages are on the app's origin, and cookies don't keep to a port)
check("cookie + the app's Origin, straight to the engine without the proxy's secret: refused", (await bare("/api/status", { ...sameOrigin(cookie) })).status === 401);
check("…a POST that way: refused", (await bare("/api/auth/code", { cookie, origin: APP }, "POST")).status === 401);
check("…with a wrong secret: refused", (await bare("/api/status", { ...sameOrigin(cookie), "x-trinity-proxy": "nope" })).status === 401);
check("…a socket that way: refused", (await ws("/ws", { cookie, origin: APP, bare: "1" })) === 401);
check("…and linking from there: refused", (await bare("/api/auth/enroll", { origin: APP, "content-type": "application/json" }, "POST")).status === 403);
check("the engine's own address is not an app page any more (it serves none)", (await get("/api/status", { cookie, origin: `http://127.0.0.1:${PORT}` })).status === 401);

// 4 — the same cookie, from somewhere that is not the app
check("cookie + another port's Origin: refused", (await get("/api/status", { cookie, origin: "http://localhost:3000" })).status === 401);
check("cookie, same-site request from another port: refused", (await get("/api/memory", { cookie, "sec-fetch-site": "same-site" })).status === 401);
check("cookie relayed by another port's server (its Referer): refused", (await get("/api/memory", sameOrigin(cookie, "http://localhost:3000"))).status === 401);
check("cookie relayed with the Referer stripped: refused", (await get("/api/memory", { cookie, "sec-fetch-site": "same-origin" })).status === 401);
check("cookie from a program (no browser headers): refused", (await get("/api/status", { cookie })).status === 401);
check("cookie + cross-site POST: refused", (await post("/api/heartbeat", { instruction: "x", once: true, intervalSec: 60 }, { cookie, origin: "https://evil.example" })).status === 401);
check("socket with cookie + another port's Origin: refused", (await ws("/ws", { cookie, origin: "http://localhost:3000" })) === 401);
check("a made-up cookie: refused", (await get("/api/status", sameOrigin("trinity_session=abc.def"))).status === 401);

// 5 — a second browser needs the pairing code
const st1 = (await (await get("/api/auth/status")).json()) as Record<string, unknown>;
check("status for an unlinked browser now says a code is needed", st1.linked === false && st1.needsCode === true, JSON.stringify(st1));
check("second browser without a code: refused", (await post("/api/auth/enroll", {}, { origin: APP })).status === 403);
const { code } = (await (await post("/api/auth/code", {}, { cookie, origin: APP })).json()) as { code: string };
check("a linked browser can show a six-digit code", /^\d{6}$/.test(code));
const wrong = code === "000000" ? "111111" : "000000";
check("second browser with a wrong code: refused", (await post("/api/auth/enroll", { code: wrong }, { origin: APP })).status === 403);
const second = await post("/api/auth/enroll", { code }, { origin: APP });
const cookie2 = (second.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
check("second browser with the right code: linked", second.status === 200 && cookie2.startsWith("trinity_session=") && cookie2 !== cookie);
check("the code works once", (await post("/api/auth/enroll", { code }, { origin: APP })).status === 403);
// five wrong guesses use the code up
const { code: code2 } = (await (await post("/api/auth/code", {}, { cookie, origin: APP })).json()) as { code: string };
for (let i = 0; i < 5; i++) await post("/api/auth/enroll", { code: code2 === "000000" ? "111111" : "000000" }, { origin: APP });
check("after five wrong guesses the code is dead", (await post("/api/auth/enroll", { code: code2 }, { origin: APP })).status === 403);

// 6 — the API key, for scripts
const stored = JSON.parse(fs.readFileSync(`${process.env.TRINITY_DATA_DIR}/auth.json`, "utf8")) as { apiKey: string; browsers: { hash: string }[] };
check("auth.json holds a key and only hashes of the cookies", stored.apiKey.length >= 32 && stored.browsers.length === 2 && !JSON.stringify(stored).includes(cookie.split(".")[1] ?? "?"));
check("API key: allowed", (await get("/api/status", { authorization: `Bearer ${stored.apiKey}` })).status === 200);
check("wrong API key: refused", (await get("/api/status", { authorization: "Bearer nope" })).status === 401);
check("socket with the API key: opens", (await ws("/ws", { authorization: `Bearer ${stored.apiKey}` })) === "open");

// 6b — a body that isn't valid JSON is never quoted back (it may hold something typed into a form)
for (const where of ["/api/settings/endpoints", "/api/vault/forms/nope", "/api/vault/not-a-route"]) {
  const bad = await fetch(`${BASE}${where}`, {
    method: where.includes("settings") ? "PUT" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${stored.apiKey}` },
    body: '{"password": "CANARY-7f3a-do-not-echo',
  });
  const text = await bad.text();
  check(`a broken body to ${where} is not echoed`, bad.status >= 400 && bad.status < 500 && !text.includes("CANARY") && !text.includes("7f3a"), `${bad.status} ${text.slice(0, 80)}`);
}

// 7 — unlinking
const list = (await (await get("/api/auth/browsers", sameOrigin(cookie))).json()) as { browsers: { id: string }[] };
check("the linked browsers are listed without their secrets", list.browsers.length === 2 && !JSON.stringify(list).includes("hash"));
const id2 = cookie2.slice("trinity_session=".length).split(".")[0];
check("unlink the second browser", (await fetch(`${BASE}/api/auth/browsers/${id2}`, { method: "DELETE", headers: viaProxy({ cookie, origin: APP }) })).status === 200);
check("its cookie stops working", (await get("/api/status", sameOrigin(cookie2))).status === 401);
check("the first still works", (await get("/api/status", sameOrigin(cookie))).status === 200);

// 8 — the review's fixes
check(
  "a planted cookie sent first doesn't lock the user out",
  (await get("/api/status", { ...sameOrigin(cookie), cookie: `trinity_session=planted.x; ${cookie}` })).status === 200,
);
check("an address typed into the browser: a GET is let in", (await get("/api/status", { cookie, "sec-fetch-site": "none" })).status === 200);
check(
  "…but never a POST or a DELETE (only a page can send those)",
  (await fetch(`${BASE}/api/heartbeat`, { method: "POST", headers: viaProxy({ cookie, "sec-fetch-site": "none", "content-type": "application/json" }), body: "{}" })).status === 401 &&
    (await fetch(`${BASE}/api/auth/browsers/x`, { method: "DELETE", headers: viaProxy({ cookie, "sec-fetch-site": "none" }) })).status === 401,
);
process.env.TRINITY_ORIGINS = "mypc:5173,file:///C:/x,localhost:3000";
check("TRINITY_ORIGINS entries with no origin of their own don't let \"null\" in", (await get("/api/status", { cookie, origin: "null" })).status === 401);
process.env.TRINITY_ORIGINS = "";
const malformed = await new Promise<string>((resolve) => {
  const s = net.connect(PORT, "127.0.0.1", () =>
    s.write(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`),
  );
  let got = "";
  s.on("data", (d) => (got += d.toString()));
  s.on("close", () => resolve(got));
  s.on("error", () => resolve(got));
  setTimeout(() => s.destroy(), 2000);
});
check("an upgrade to a malformed address is turned away, and the engine carries on", /^HTTP\/1\.1 400/.test(malformed) && (await fetch(`${BASE}/healthz`)).ok, malformed.split("\r\n")[0]);
// Once a browser has been linked, unlinking every one doesn't make the next link free.
const id1 = cookie.slice("trinity_session=".length).split(".")[0];
check("unlink the last browser", (await fetch(`${BASE}/api/auth/browsers/${id1}`, { method: "DELETE", headers: viaProxy({ cookie, origin: APP }) })).status === 200);
const again = await post("/api/auth/enroll", {}, { origin: APP });
check("with none linked now, a link still needs the code (no free link comes back)", again.status === 403 && /pairing-required/.test(await again.text()));
const st3 = (await (await get("/api/auth/status", { origin: APP })).json()) as { needsCode: boolean };
check("…and the status says so", st3.needsCode === true, JSON.stringify(st3));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
