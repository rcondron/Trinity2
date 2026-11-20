// Settings hardening and the model check: a key goes only to the address it was entered for; updates are validated; a
// configured model the gateway no longer serves is stood in for, and Settings is told. A fake gateway (8890) serves the
// model catalog.
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through its launcher (npm test -- --only <name>, or npm run harness for the app harness): it gives the engine a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);

const catalog = { ids: ["claude-sonnet-5-5", "claude-haiku-5-5", "deepseek-v4-1-flash-1017-ultrafast", "z-ai-glm-5-3-flash", "kimi-k3", "nvidia-nemotron-3-nano-30b-a3b", "deepseek-v4-1-flash"], up: true };
const gateway = http.createServer((req, res) => {
  if (!catalog.up) {
    res.writeHead(503);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: catalog.ids.map((id) => ({ id })) }));
});
await new Promise<void>((r) => gateway.listen(8890, "127.0.0.1", r));

const settings = await imp("settings.ts");
const health = await imp("services/model-health.ts");
const STORE = `${process.env.TRINITY_DATA_DIR}/endpoints.json`;
const stored = () => (fs.existsSync(STORE) ? (JSON.parse(fs.readFileSync(STORE, "utf8")) as Record<string, unknown>) : {});

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
const ENV_URL = process.env.MORDIEM_URL!;

// ── a key goes only to the address it was entered for ──
check("the .env key is used with the .env address", settings.getEndpoints().mordiemKey === "env-key" && settings.getEndpoints().mordiemUrl === ENV_URL);
settings.setEndpoints({ mordiemUrl: "https://elsewhere.example/api/v1" });
check("address repointed in Settings: the .env key is withheld", settings.getEndpoints().mordiemUrl === "https://elsewhere.example/api/v1" && settings.getEndpoints().mordiemKey === "", settings.getEndpoints().mordiemKey);
check("…and Settings shows the key as missing", settings.publicEndpoints().mordiemKeySet === false);
settings.setEndpoints({ mordiemUrl: "" });
check("address cleared back to .env: the .env key is used again", settings.getEndpoints().mordiemKey === "env-key");
settings.setEndpoints({ mordiemUrl: "https://new.example/v1", mordiemKey: "key-for-new" });
check("a key saved with its address is used there", settings.getEndpoints().mordiemKey === "key-for-new" && (stored().keyFor as Record<string, string>)?.mordiemKey === "https://new.example/v1");
settings.setEndpoints({ mordiemUrl: "https://other.example/v1" });
check("address changed without a new key: the saved key is dropped", settings.getEndpoints().mordiemKey === "" && !("mordiemKey" in stored()), JSON.stringify(Object.keys(stored())));
// a key that fails the checks is not stored, and must not carry the saved key to a new address
for (const bad of [123, true, [], {}, "x".repeat(2001)]) {
  settings.setEndpoints({ mordiemUrl: "https://new.example/v1", mordiemKey: "key-for-new" });
  settings.setEndpoints({ mordiemUrl: "https://evil.example/v1", mordiemKey: bad as unknown as string });
  check(
    `a ${Array.isArray(bad) ? "list" : typeof bad === "string" ? "too-long string" : typeof bad} for the key doesn't rebind the saved key to the new address`,
    settings.getEndpoints().mordiemKey === "" && (stored().keyFor as Record<string, string> | undefined)?.mordiemKey !== "https://evil.example/v1",
    JSON.stringify(stored().keyFor ?? null),
  );
}
// a key saved before addresses were remembered stays with the address in effect
fs.writeFileSync(STORE, JSON.stringify({ mordiemUrl: "https://legacy.example/v1", mordiemKey: "legacy-key" }));
check("a key saved before this change still works with its address", settings.getEndpoints().mordiemKey === "legacy-key");
fs.writeFileSync(STORE, "{}");

// ── updates are validated ──
const tries: [Record<string, unknown>, string, (e: Record<string, unknown>) => boolean][] = [
  [{ mordiemUrl: "http://evil.example/v1" }, "plain http to another machine is refused", (e) => e.mordiemUrl === ENV_URL],
  [{ mordiemUrl: "https://user:pw@evil.example/v1" }, "an address with a password in it is refused", (e) => e.mordiemUrl === ENV_URL],
  [{ typesafeUrl: "javascript:alert(1)" }, "a non-address is refused", (e) => /^https:/.test(String(e.typesafeUrl))],
  [{ personaplexWsUrl: "ws://203.0.113.9:8998/api/chat" }, "the voice pod may be a bare ws address", (e) => e.personaplexWsUrl === "ws://203.0.113.9:8998/api/chat"],
  [{ minConfidence: 0 }, "a confidence of zero is refused", (e) => e.minConfidence === 0.7],
  [{ minConfidence: "0.8" }, "a number sent as text is refused", (e) => e.minConfidence === 0.7],
  [{ minConfidence: 0.8 }, "a sane confidence is taken", (e) => e.minConfidence === 0.8],
  [{ skillApproval: "whatever" }, "an unknown choice is refused", (e) => e.skillApproval === "auto"],
  [{ talkStyle: "free" }, "the talk style is a known choice", (e) => e.talkStyle === "free"],
  [{ notASetting: "x", brainModel: ["a"] }, "unknown keys and wrong types are ignored", (e) => !("notASetting" in e) && typeof e.brainModel === "string"],
];
for (const [patch, name, ok] of tries) {
  const e = settings.setEndpoints(patch) as Record<string, unknown>;
  check(name, ok(e), JSON.stringify(patch));
}
fs.writeFileSync(STORE, "{}");

// ── a model the gateway dropped ──
let swaps = (await health.checkModels()) as { key: string; configured: string; using: string }[];
const quick = swaps.find((s) => s.key === "glmModel");
check("the missing quick coder is noticed and stood in for", quick?.configured === "mercury-3" && quick?.using === "deepseek-v4-1-flash-1017-ultrafast", JSON.stringify(swaps));
check("callers get the stand-in", settings.getEndpoints().glmModel === "deepseek-v4-1-flash-1017-ultrafast" && settings.coderModel("glm") === "deepseek-v4-1-flash-1017-ultrafast");
check("Settings still shows what was configured, with the swap listed", settings.publicEndpoints().glmModel === "mercury-3" && (settings.publicEndpoints().modelIssues as unknown[]).length === swaps.length);
check("models that exist are left alone", !swaps.some((s) => s.key === "brainModel" || s.key === "replyModel"), JSON.stringify(swaps.map((s) => s.key)));
settings.setEndpoints({ glmModel: "kimi-k3" });
swaps = await health.checkModels();
check("picking an available model clears the swap", !swaps.some((s) => s.key === "glmModel") && settings.getEndpoints().glmModel === "kimi-k3");
settings.setEndpoints({ glmModel: "" });
catalog.ids.push("mercury-3");
await new Promise((r) => setTimeout(r, 50));
// (The catalog is cached for ten minutes: a fresh process would see the model back. Here, check the "unreachable" rule.)
catalog.up = false;
check("an unreachable gateway changes nothing", Array.isArray(await health.checkModels()));

// ── the speech rate ──
const speech = await imp("services/speech-rate.ts");
check("a speech rate that was never set is normal speed, not the slowest", speech.getSpeechRate() === 1, String(speech.getSpeechRate()));
check("a set rate is kept, within its range", speech.setSpeechRate(0.85) === 0.85 && speech.getSpeechRate() === 0.85 && speech.setSpeechRate(9) === speech.SPEECH_RATE_MAX);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
gateway.close();
process.exit(fails ? 1 : 0);
