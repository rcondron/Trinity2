// End-to-end smoke test for the real-time voice loop — no microphone needed.
// Opens /call in standby, sends typed turns (handled exactly like finished spoken
// sentences), and reports what Jev decided, which tools ran, what the reply writer
// wrote, and — the real check — what PersonaPlex actually SPOKE (its kind-2 word
// echo, relayed as "agent" events). Also prints the workspace after each turn.
//
//   node scripts/e2e-voice.mjs "let's start a new game" "a gritty pirate adventure" ...
//   ENGINE=http://localhost:8799 node scripts/e2e-voice.mjs --persona game-master "..."
import WebSocket from "ws";

const ENGINE = process.env.ENGINE || "http://localhost:8799";
const WS = ENGINE.replace(/^http/, "ws");
const args = process.argv.slice(2);
let persona = null;
let settleSec = 0;
const turns = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--persona") persona = args[++i];
  else if (args[i] === "--settle") settleSec = Number(args[++i]) || 60;
  else turns.push(args[i]);
}
if (!turns.length) {
  console.error('usage: node scripts/e2e-voice.mjs [--persona <id>] [--settle <sec>] "turn one" "@wait 30" "turn two" ...');
  console.error("  --settle: after the last turn, wait (up to <sec>) for background art/screens, then print the full game");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (path, opts = {}) =>
  fetch(ENGINE + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } }).then((r) => r.json());

if (persona) {
  const r = await json(`/api/personas/${persona}/activate`, { method: "POST" });
  console.log(`persona → ${r.persona?.name ?? JSON.stringify(r)}`);
}

const ws = new WebSocket(`${WS}/call?standby=1`);
let ready = false;
let spoken = "";
let turnLog = [];
ws.on("message", (data, isBinary) => {
  if (isBinary) return; // agent audio
  const e = JSON.parse(data.toString());
  switch (e.type) {
    case "ready":
      ready = true;
      console.log(`ready in ${e.handshake_ms}ms (${e.persona})`);
      break;
    case "status":
      console.log(`  · ${e.text}`);
      break;
    case "decision":
      if (e.final || e.tool !== "NONE")
        turnLog.push(`jev ${e.final ? "final" : "mid"} → ${e.tool} ${(e.confidence * 100).toFixed(0)}% (${e.ms}ms)${e.error ? " ERR " + e.error : ""}`);
      break;
    case "tool":
      turnLog.push(`tool ${e.tool}(${JSON.stringify(e.args)})`);
      break;
    case "tool_result":
      turnLog.push(`result ok=${e.result?.ok} ${(e.result?.say || e.result?.error || "").slice(0, 160)}`);
      break;
    case "reply":
      turnLog.push(`reply (first words ${e.first_ms ?? "-"}ms, done ${e.ms}ms${e.filler ? ", filler" : ""}) "${e.text}"`);
      break;
    case "agent":
      spoken += e.text;
      break;
    case "announce":
      // Said unprompted: a due reminder, a background job that finished (a new skill…).
      console.log(`  🔔 announce: "${e.text}"`);
      break;
  }
});
ws.on("error", (e) => {
  console.error("socket error:", e.message);
  process.exit(1);
});

for (let i = 0; i < 120 && !ready; i++) await sleep(500);
if (!ready) {
  console.error("voice session never became ready");
  process.exit(1);
}

for (const text of turns) {
  turnLog = [];
  spoken = "";
  // "@wait 45": stay on the call for 45 s (reminders and background jobs speak up meanwhile).
  const wait = /^@wait\s+(\d+)$/.exec(text);
  if (wait) {
    console.log(`\n⏳ waiting ${wait[1]} s…`);
    await sleep(Number(wait[1]) * 1000);
    if (spoken.trim()) console.log(`  spoken by PersonaPlex meanwhile: "${spoken.trim().replace(/\s+/g, " ").slice(0, 400)}"`);
    continue;
  }
  console.log(`\n▶ "${text}"`);
  ws.send(JSON.stringify({ type: "text", text }));
  // Wait for the reply to be written and spoken (PersonaPlex echoes forced words as it says them).
  const deadline = Date.now() + 45_000;
  let lastLen = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(500);
    const hasReply = turnLog.some((l) => l.startsWith("reply"));
    if (spoken.length !== lastLen) {
      lastLen = spoken.length;
      stableSince = Date.now();
    }
    if (hasReply && Date.now() - stableSince > 2500) break;
  }
  for (const l of turnLog) console.log(`  ${l}`);
  console.log(`  spoken by PersonaPlex: "${spoken.trim().replace(/\s+/g, " ").slice(0, 400)}"`);
  const snap = await json("/api/workspace");
  const s = snap.state && typeof snap.state === "object" ? snap.state : null;
  const summary = s?.kind === "game"
    ? `game "${s.title}" phase=${s.phase} players=[${(s.players || []).map((p) => `${p.name}${p.pending ? "…" : ""}`).join(", ")}] items=${(s.items || []).length} npcs=${(s.npcs || []).length} scene=${s.scene?.title ?? "-"} setup.next=${s.setup?.next ?? "-"}`
    : `${snap.mode} "${snap.title}"`;
  console.log(`  workspace v${snap.version}: ${summary}${snap.activities?.length ? ` · busy: ${snap.activities.map((a) => a.text).join("; ")}` : ""}`);
}

if (settleSec) {
  // Let background work (portraits, item icons, scene art, the custom game screen) finish.
  const until = Date.now() + settleSec * 1000;
  let snap = await json("/api/workspace");
  while (Date.now() < until && snap.activities?.length) {
    await sleep(1000);
    snap = await json("/api/workspace");
  }
  const s = snap.state && typeof snap.state === "object" ? snap.state : null;
  console.log(`\n■ settled (${snap.activities?.length ? `still busy: ${snap.activities.map((a) => a.text).join("; ")}` : "idle"})`);
  console.log(`  template: ${snap.template?.id ?? "-"} (${snap.template?.kind ?? snap.mode})`);
  if (s?.kind === "game") {
    const img = (r) => (r ? r.status : "-");
    console.log(`  game "${s.title}" · ${s.genre || "?"} · ${s.tone || "?"} · phase=${s.phase} round=${s.round ?? "-"} · theme=${s.theme?.texture ?? "-"}/${s.theme?.font ?? "-"} accent=${s.theme?.palette?.accent ?? "-"}`);
    for (const p of s.players || [])
      console.log(`  hero ${p.name}: ${p.race} ${p.className} L${p.level} HP ${p.hp}/${p.maxHp} AC ${p.ac} ${JSON.stringify(p.stats)} portrait=${img(p.portrait)} items=${(p.inventory || []).length}`);
    for (const n of s.npcs || []) console.log(`  npc ${n.name} (${n.role}, ${n.attitude}) portrait=${img(n.portrait)}`);
    for (const it of s.items || []) console.log(`  item ${it.name} [${it.rarity} ${it.type}] icon=${img(it.icon)}`);
    if (s.scene) console.log(`  scene ${s.scene.title} image=${img(s.scene.image)}: ${String(s.scene.description).slice(0, 160)}`);
    for (const e of (s.log || []).slice(-8)) console.log(`  log [${e.kind}] ${e.text}`);
  }
}

ws.close();
await sleep(300);
process.exit(0);
