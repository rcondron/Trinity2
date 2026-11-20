// A simulated call: the real VoiceCall against a fake PersonaPlex and a fake Deepgram. The fake voice starts its own
// answer ("I can't…") 200 ms after the user stops — a word every 150 ms — unless it's held, as the real one does; the
// fake Deepgram sends interim transcripts as the words come and the final one 300 ms after they stop (endpointing).
// For each sentence: was the voice held before the user finished, how many of its own words got out, what was decided.
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through the runner (npm test -- --only <name>): it gives each suite a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fake PersonaPlex ─────────────────────────────────────────────────────────
type Sock = { send: (d: unknown) => void; on: (e: string, f: (...a: unknown[]) => void) => void };
const pp = { sock: null as Sock | null, held: false, holds: [] as { t: number; on: boolean }[], forced: [] as { t: number; text: string }[], own: [] as { t: number; word: string }[] };
const ppServer = new WebSocketServer({ port: 8895, host: "127.0.0.1" });
ppServer.on("connection", (ws: Sock) => {
  pp.sock = ws;
  ws.send(Buffer.from([0x00]));
  ws.on("message", (data: unknown, isBinary: unknown) => {
    if (!isBinary) return;
    const b = data as Buffer;
    if (b[0] === 4) {
      pp.held = b[1] === 1;
      pp.holds.push({ t: Date.now(), on: pp.held });
    } else if (b[0] === 3) pp.forced.push({ t: Date.now(), text: b.subarray(1).toString("utf8") });
  });
});
/**
 * The voice's own answer: from `delayMs` after the user stops, a word every 150 ms. While held it waits (it answers
 * once a "nothing to do" decision releases it); a reply forced into it takes the turn, and its own answer is dropped.
 */
function ownAnswer(words: string[], delayMs = 200) {
  let i = 0;
  const forcedAtStart = pp.forced.length;
  const until = Date.now() + 4000;
  const tick = () => {
    if (i >= words.length || !pp.sock || pp.forced.length > forcedAtStart || Date.now() > until) return;
    if (pp.held) {
      setTimeout(tick, 40);
      return;
    }
    const w = (i ? " " : "") + words[i++];
    pp.sock.send(Buffer.concat([Buffer.from([2]), Buffer.from(w, "utf8")]));
    pp.own.push({ t: Date.now(), word: w.trim() });
    setTimeout(tick, 150);
  };
  setTimeout(tick, delayMs);
}

// ── fake Deepgram ────────────────────────────────────────────────────────────
const dg = { sock: null as Sock | null };
const dgServer = new WebSocketServer({ port: 8894, host: "127.0.0.1" });
dgServer.on("connection", (ws: Sock) => {
  dg.sock = ws;
  ws.on("message", () => {});
});
const results = (transcript: string, isFinal: boolean, speechFinal: boolean) =>
  dg.sock?.send(JSON.stringify({ type: "Results", is_final: isFinal, speech_final: speechFinal, channel: { alternatives: [{ transcript }] } }));

// ── the engine: tools, a board, a call ───────────────────────────────────────
const { createMemoryStore } = await imp("db/memory.ts");
const memory = await createMemoryStore();
await (await imp("db/seed.ts")).seed(memory);
for (const [file, fn] of [
  ["tools/builtins.ts", "registerBuiltins"],
  ["tools/coding.ts", "registerCodingTools"],
  ["tools/ask.ts", "registerAskTools"],
  ["tools/memory.ts", "registerMemoryTools"],
  ["tools/schedule.ts", "registerScheduleTools"],
] as const)
  (await imp(file))[fn]();
const board = await imp("workspace/board.ts");
board.addCard({ kind: "video", title: "Ocean waves", text: "ocean waves", status: "ready", url: "/api/videos/x.mp4" });
board.addCard({ kind: "text", title: "Note: hello", text: "hello", status: "ready", url: null });

class FakeBrowser extends EventEmitter {
  readyState = 1;
  events: Record<string, unknown>[] = [];
  send(s: string) {
    try {
      this.events.push(JSON.parse(s));
    } catch {
      /* binary audio */
    }
  }
  ping() {
    this.emit("pong");
  }
  terminate() {}
  close() {}
}
const browser = new FakeBrowser();
const { VoiceCall } = await imp("services/voice-call.ts");
const call = new VoiceCall(browser, memory, { voice: "NATF2", standby: false });
await call.start();
for (let i = 0; i < 50 && !browser.events.some((e) => e.type === "ready"); i++) await sleep(100);
console.log("call ready:", browser.events.some((e) => e.type === "ready"), "| route every", process.env.ROUTE_EVERY_MS, "ms\n");

// ── sentences ────────────────────────────────────────────────────────────────
interface Line {
  say: string;
  /** ask: may wait for a decision; chat: the voice answers at once (no early hold). */
  kind: "ask" | "chat";
  own: string[];
}
const LINES: Line[] = [
  { say: "pause the video", kind: "ask", own: ["I", "can't", "control", "videos,", "sorry."] },
  { say: "close card 2", kind: "ask", own: ["I'm", "not", "able", "to", "do", "that."] },
  { say: "what's on the board", kind: "ask", own: ["I", "can't", "see", "your", "board."] },
  { say: "Alright, make a note that says buy milk", kind: "ask", own: ["Sorry,", "I", "can't", "take", "notes."] },
  { say: "stop", kind: "ask", own: ["Okay,", "stopping."] },
  { say: "how are you doing today", kind: "chat", own: ["I'm", "great,", "thanks!"] },
  { say: "can you hear me okay", kind: "chat", own: ["Yes,", "loud", "and", "clear."] },
  { say: "what's the capital of France", kind: "ask", own: ["Paris."] },
  { say: "that's really funny", kind: "chat", own: ["Ha,", "glad", "you", "liked", "it!"] },
  { say: "I went to the store today", kind: "chat", own: ["Oh,", "what", "did", "you", "get?"] },
];

let bad = 0;
for (const line of LINES) {
  pp.holds.length = 0;
  pp.forced.length = 0;
  pp.own.length = 0;
  const firstEvent = browser.events.length;
  const words = line.say.split(" ");
  const start = Date.now();
  for (let i = 1; i <= words.length; i++) {
    results(words.slice(0, i).join(" "), false, false);
    await sleep(230);
  }
  const stop = Date.now();
  ownAnswer(line.own, 200);
  await sleep(300); // Deepgram's endpointing
  results(line.say, true, true);
  await sleep(3500);
  const early = pp.holds.find((h) => h.on && h.t <= stop);
  const decision = browser.events.slice(firstEvent).filter((e) => e.type === "decision" && e.final === true).pop();
  const own = pp.own.map((o) => o.word).join(" ");
  const forced = pp.forced.map((f) => f.text).join(" ").replace(/\s+/g, " ").trim();
  // The rule: never the voice's own words and a tool's reply in the same turn; and talk is never held early.
  const stumbled = pp.own.length > 0 && pp.forced.length > 0;
  // Held at the moment the user stops (a brief hold mid-sentence that lifted again, "can you hear…", costs nothing).
  const before = pp.holds.filter((h) => h.t <= stop);
  const heldAtStop = before.length ? before[before.length - 1]!.on : false;
  const ok = !stumbled && (line.kind === "chat" ? !heldAtStop : true);
  const firstOwn = pp.own[0] ? `${pp.own[0].t - stop} ms after the end` : "";
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "BAD "} ${line.kind.padEnd(4)} ${JSON.stringify(line.say).padEnd(42)} → ${String(decision?.tool ?? "?").padEnd(16)} ` +
      `held ${heldAtStop && early ? `${stop - early.t} ms before the end` : early ? "briefly mid-sentence, not at the end" : "only after the end"} · its own words: ${own ? `“${own}” (from ${firstOwn})` : "none"}${stumbled ? " — STUMBLE" : ""}` +
      (forced ? `\n       then said: “${forced.slice(0, 110)}”` : ""),
  );
  await sleep(1200);
}
console.log(bad ? `\n${bad} BAD` : "\nALL GOOD");
call.stop();
ppServer.close();
dgServer.close();
process.exit(bad ? 1 : 0);
