// The polished talk style, on a simulated call: the real VoiceCall against a fake PersonaPlex (8895; it improvises its own
// words 200 ms after the user stops unless it is held — as the real one does), a fake Deepgram (8894) and a fake model
// gateway (8893) that streams scripted replies with realistic delays. What must hold: the voice never says a word of its
// own; what no tool takes is answered by the talking brain, short and soon; a tool still takes its turn; and the turn-
// handling bugs from the review stay fixed.
import { EventEmitter } from "node:events";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through its launcher (npm test -- --only <name>, or npm run harness for the app harness): it gives the engine a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

// ── fake model gateway ───────────────────────────────────────────────────────
interface Seen {
  model: string;
  system: string;
  user: string;
  history: string[];
  stream: boolean;
  at: number;
  aborted: boolean;
}
const gw = {
  seen: [] as Seen[],
  /** Extra delay before a model's first token, by model id. */
  delay: {} as Record<string, number>,
  /** Models that answer 500. */
  down: new Set<string>(),
};
const LONG = "Once there was a lighthouse keeper named Odd. He counted ships every night. One night a ship counted him back. It blinked its lamps three times. Odd blinked his lamp in answer. They have been friends ever since.";
function scripted(model: string, system: string, user: string): string {
  if (model === "reply-x") return /slow/i.test(user) ? "The slow thing is finished." : "Done, that card is closed.";
  if (!/live voice call/.test(system)) return "{}";
  const u = user.toLowerCase();
  const markers = /Two special replies/.test(system);
  if (u.includes("how are you")) return "I'm doing great, thanks for asking.";
  if (u.includes("sky blue")) return "Air scatters blue light the most. That is called Rayleigh scattering. Sunsets are red for the same reason. Violet scatters even more. Our eyes are less sensitive to it. So the sky looks blue.";
  if (u.includes("book me a table")) return markers ? "ACT" : "I can't book tables yet, but I can find the number for you.";
  if (u === "okay." || u === "hmm.") return markers ? "SILENT" : "Okay.";
  if (u.includes("i want to")) return "Sure, what would you like?";
  if (u.includes("order a pizza")) return "Pizza it is. What toppings?";
  if (u.includes("long story")) return LONG;
  if (u.includes("favorite color")) return "Probably violet.";
  if (u.includes("flight")) return "It takes about 13 hours and costs around $900.";
  return "Okay.";
}
const gateway = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ["brain-x", "fast-x", "reply-x", "plan-x"].map((id) => ({ id })) }));
    return;
  }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as { model: string; stream?: boolean; messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages[body.messages.length - 1]?.content ?? "";
    const rec: Seen = { model: body.model, system, user, history: body.messages.slice(1, -1).map((m) => `${m.role}: ${m.content}`), stream: Boolean(body.stream), at: Date.now(), aborted: false };
    gw.seen.push(rec);
    if (gw.down.has(body.model)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
      return;
    }
    const text = scripted(body.model, system, user);
    if (!body.stream) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      }, 150);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tokens = text.split(/(?<=\s)/);
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (i >= tokens.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i++] } }] })}\n\n`);
      timer = setTimeout(next, 25); // ~40 tokens a second
    };
    timer = setTimeout(next, 350 + (gw.delay[body.model] ?? 0)); // time to the first token
    res.on("close", () => {
      if (i < tokens.length) rec.aborted = true;
      clearTimeout(timer);
    });
  });
});
await new Promise<void>((r) => gateway.listen(8893, "127.0.0.1", r));

// ── fake PersonaPlex ─────────────────────────────────────────────────────────
type Sock = { send: (d: unknown) => void; on: (e: string, f: (...a: unknown[]) => void) => void };
const pp = { sock: null as Sock | null, held: false, holds: [] as boolean[], forced: [] as { t: number; text: string }[], own: [] as string[], flushes: 0 };
const ppServer = new WebSocketServer({ port: 8895, host: "127.0.0.1" });
ppServer.on("connection", (ws: Sock) => {
  pp.sock = ws;
  pp.held = false;
  ws.send(Buffer.from([0x00]));
  ws.on("message", (data: unknown, isBinary: unknown) => {
    if (!isBinary) return;
    const b = data as Buffer;
    if (b[0] === 4) {
      pp.held = b[1] === 1;
      pp.holds.push(pp.held);
    } else if (b[0] === 3) {
      const text = b.subarray(1).toString("utf8");
      pp.forced.push({ t: Date.now(), text });
      ws.send(Buffer.concat([Buffer.from([2]), Buffer.from(` ${text}`, "utf8")])); // the pod echoes what it says
    } else if (b[0] === 5) pp.flushes++;
  });
});
/** What the model would say by itself, 200 ms after the user stops — unless it is held. */
function improvise() {
  const words = ["I", "can't", "really", "say."];
  let i = 0;
  const until = Date.now() + 2500;
  const tick = () => {
    if (i >= words.length || !pp.sock || Date.now() > until) return;
    if (pp.held) return void setTimeout(tick, 40);
    pp.own.push(words[i]!);
    pp.sock.send(Buffer.concat([Buffer.from([2]), Buffer.from(` ${words[i++]}`, "utf8")]));
    setTimeout(tick, 150);
  };
  setTimeout(tick, 200);
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

// ── the engine ───────────────────────────────────────────────────────────────
const { createMemoryStore } = await imp("db/memory.ts");
const memory = await createMemoryStore();
await (await imp("db/seed.ts")).seed(memory);
for (const [file, fn] of [
  ["tools/builtins.ts", "registerBuiltins"],
  ["tools/coding.ts", "registerCodingTools"],
  ["tools/ask.ts", "registerAskTools"],
  ["tools/memory.ts", "registerMemoryTools"],
] as const)
  (await imp(file))[fn]();
const { registerTool } = await imp("tools/registry.ts");
// A slow tool with a long answer (named so the keyless router picks it from its name).
registerTool({
  name: "slowthing",
  description: "Run the slowthing.",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run() {
    await sleep(1500);
    return { ok: true, say: "The slow thing ran.", speak: "The slow thing is finished." };
  },
});
const WORDS200 = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} has five words.`).join(" ");
registerTool({
  name: "longread",
  description: "Read the longread aloud.",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run() {
    return { ok: true, say: "Read it.", speak: WORDS200 };
  },
});
const board = await imp("workspace/board.ts");
board.addCard({ kind: "text", title: "Note: hello", text: "hello", status: "ready", url: null });
board.addCard({ kind: "text", title: "Note: milk", text: "milk", status: "ready", url: null });

class FakeTab extends EventEmitter {
  readyState = 1;
  events: Record<string, unknown>[] = [];
  send(s: unknown) {
    if (typeof s !== "string") return;
    try {
      this.events.push(JSON.parse(s));
    } catch {
      /* audio */
    }
  }
  ping() {
    this.emit("pong");
  }
  terminate() {}
  close() {}
  tab(obj: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
  of(type: string) {
    return this.events.filter((e) => e.type === type);
  }
}
const { VoiceCall } = await imp("services/voice-call.ts");
async function newCall(): Promise<{ tab: FakeTab; call: { stop: () => void } & Record<string, unknown> }> {
  const tab = new FakeTab();
  const call = new VoiceCall(tab, memory, { voice: "NATF2", standby: false });
  await call.start();
  await waitFor(() => tab.of("ready").length > 0);
  await sleep(100);
  return { tab, call };
}

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
/** Speak a sentence: interim results word by word, then the final 300 ms after the last word (Deepgram's endpointing). */
async function speak(sentence: string, opts: { final?: boolean; pace?: number } = {}): Promise<number> {
  const words = sentence.split(" ");
  for (let i = 1; i <= words.length; i++) {
    results(words.slice(0, i).join(" "), false, false);
    await sleep(opts.pace ?? 160);
  }
  const stop = Date.now();
  improvise();
  if (opts.final !== false) {
    await sleep(300);
    results(sentence, true, true);
  }
  return stop;
}
const reset = () => {
  pp.forced.length = 0;
  pp.own.length = 0;
  pp.flushes = 0;
  gw.seen.length = 0;
};
const forcedText = () => pp.forced.map((f) => f.text).join(" ").replace(/\s+/g, " ").trim();
const lastReply = (tab: FakeTab) => tab.of("reply").slice(-1)[0] ?? {};

let { tab, call } = await newCall();
check("the call starts held: polished talk", tab.of("ready")[0]?.talk === "polished" && pp.held === true, `talk=${tab.of("ready")[0]?.talk} held=${pp.held}`);

// 1 — small talk: the brain answers, soon, and the voice never says a word of its own
reset();
let stop = await speak("how are you doing today");
await waitFor(() => pp.forced.length > 0, 4000);
let first = pp.forced[0] ? pp.forced[0].t - stop : -1;
await sleep(1500);
check("small talk: the talking brain's words are spoken", /doing great/.test(forcedText()), forcedText());
check("small talk: first words within 1.5 s of the user stopping", first > 0 && first < 1500, `${first} ms`);
check("small talk: the voice said nothing of its own", pp.own.length === 0, pp.own.join(" "));
check("small talk: the request went to the brain model with the call's rules", gw.seen.some((s) => s.model === "brain-x" && /live voice call/.test(s.system) && /one or two short sentences/.test(s.system)));
check("small talk: the reply is reported as talk, with its timing", lastReply(tab).talk === "said" && typeof lastReply(tab).first_ms === "number", JSON.stringify(lastReply(tab)).slice(0, 140));

// 2 — a question: answered by the brain, and capped at two sentences however much the model writes
reset();
stop = await speak("why is the sky blue");
await waitFor(() => tab.of("reply").some((r) => /scatter/.test(String(r.text))), 6000);
await sleep(300);
const sky = forcedText();
check("question: answered in the brain's words", /Air scatters blue light/.test(sky), sky);
check("question: cut at the cap (3 sentences for a why), not the six the model wrote", !/So the sky looks blue/.test(sky) && !/Violet scatters/.test(sky) && sky.split(/[.!?]/).filter((x) => x.trim()).length <= 3, sky);
check("question: nothing of its own", pp.own.length === 0);

// 3 — a request a tool takes: the tool's reply is spoken, the brain's is not
reset();
stop = await speak("close card 2");
await waitFor(() => tab.of("reply").some((r) => r.action === "remove_card"), 6000);
await sleep(600);
check("tool turn: the tool ran and its reply was spoken", /card/i.test(forcedText()) && tab.of("tool").some((t) => t.tool === "remove_card"), forcedText());
check("tool turn: no talk reply was spoken as well", !tab.of("reply").some((r) => r.talk === "said" && Number(r.ms) > 0 && /Okay\./.test(String(r.text))) && pp.own.length === 0, forcedText());

// 4 — the brain says the words ask for something to be done: the solver gets them
reset();
tab.events.length = 0;
stop = await speak("book me a table at an Italian place tonight");
await waitFor(() => tab.of("decision").some((d) => d.via === "talk"), 6000);
check("ACT: handed to the solver", tab.of("decision").some((d) => d.via === "talk" && d.tool === "figure_out"), JSON.stringify(tab.of("decision").slice(-1)[0] ?? {}).slice(0, 120));
check("ACT: the marker itself is never spoken", !/\bACT\b/.test(forcedText()), forcedText());
await sleep(2500);

// 5 — nothing to answer: silence
reset();
tab.events.length = 0;
await speak("okay.");
await waitFor(() => tab.of("reply").some((r) => r.talk === "silent"), 5000);
check("filler word: nothing is said", pp.forced.length === 0 && lastReply(tab).talk === "silent" && pp.own.length === 0, forcedText());

// 6 — half a thought, then the rest: one answer, to the whole thought
reset();
tab.events.length = 0;
await speak("I want to");
await sleep(450);
await speak("order a pizza");
await waitFor(() => /Pizza it is/.test(forcedText()), 6000);
await sleep(800);
check("half a thought: only the whole thought is answered", /Pizza it is/.test(forcedText()) && !/what would you like/.test(forcedText()), forcedText());
const pizza = gw.seen.filter((s) => /live voice call/.test(s.system) && /order a pizza/.test(s.user)).slice(-1)[0];
check("half a thought: the brain saw both parts", Boolean(pizza && pizza.history.some((h) => /I want to/.test(h))), JSON.stringify(pizza?.history ?? []).slice(0, 160));

// 7 — barge-in: one word stops her, at the pod and in the tab
reset();
tab.events.length = 0;
await speak("tell me a long story");
await waitFor(() => pp.forced.length >= 1, 5000);
await sleep(700);
const before = pp.forced.length;
results("stop", false, false);
await sleep(300);
results("stop", true, true);
await sleep(1500);
check("barge-in: the pod is told to drop the rest", pp.flushes >= 1, `flushes ${pp.flushes}`);
check("barge-in: the tab is told to drop its queued audio", tab.of("flush").length >= 1);
check("barge-in: the rest of the story isn't said", !/friends ever since/.test(forcedText()), `${before} → ${pp.forced.length} chunks: ${forcedText().slice(-80)}`);
await sleep(1200);

// 7b — a nod from the listener while she is talking doesn't cut her short
reset();
tab.events.length = 0;
await speak("tell me a long story");
await waitFor(() => pp.forced.length >= 1, 5000);
await sleep(500);
results("yeah", false, false); // one word, not a cut-in
await sleep(300);
results("yeah", true, true);
await waitFor(() => /friends ever since/.test(forcedText()), 30000);
check("a nod while she talks: the story goes on to its end", /friends ever since/.test(forcedText()) && pp.flushes === 0, `${pp.forced.length} chunks, flushes ${pp.flushes}`);
await sleep(1500);

// 8 — talking over the filler doesn't cancel the answer behind it
reset();
tab.events.length = 0;
await speak("run the slowthing now");
await waitFor(() => pp.forced.some((f) => /moment/i.test(f.text)), 4000);
results("thank you", false, false); // over the filler
await sleep(250);
results("thank you", true, true);
await waitFor(() => /slow thing is finished/i.test(forcedText()), 6000);
check("filler: said while the tool was slow", pp.forced.some((f) => /moment/i.test(f.text)), forcedText());
check("filler: the answer is still said after the user talked over the filler", /slow thing is finished/i.test(forcedText()), forcedText());
await sleep(1500);

// 9 — a long line read out: a budget, then "keep going"
reset();
tab.events.length = 0;
const vc = await imp("services/voice-call.ts");
const cut = vc.splitForSpeech(Array.from({ length: 40 }, (_, i) => `Sentence ${i} has five words.`).join(" "));
check("long line: split at whole sentences near ninety words", cut.now.split(/(?<=[.])\s+/).length === 18 && cut.rest.startsWith("Sentence 18 "), `${cut.now.split(/(?<=[.])\s+/).length} now`);
await speak("read the longread to me");
await waitFor(() => pp.forced.length >= 1, 6000);
const left = String((call as unknown as { remainder: string }).remainder);
check("long line: the part past the budget is kept for later, not read on", /^Sentence number sixteen /.test(left) && pp.forced.length <= 3, left.slice(0, 50));
results("stop", false, false); // (cut the read-out short so the test moves on)
await sleep(300);
results("stop", true, true);
await sleep(1200);
reset();
await speak("keep going");
await waitFor(() => pp.forced.length >= 1, 6000);
check("keep going: the next part is read, with no model call", /^Sentence number sixteen /.test(forcedText()) && gw.seen.filter((s) => /live voice call/.test(s.system)).length === 0, forcedText().slice(0, 60));
results("stop", false, false);
await sleep(300);
results("stop", true, true);
await sleep(1500);
check("a bare stop gets silence, not an answer", !gw.seen.some((s) => /live voice call/.test(s.system) && /^stop/i.test(s.user)));

// 10 — a typed turn gets an answer too
reset();
tab.events.length = 0;
tab.tab({ type: "text", text: "what's your favorite color" });
await waitFor(() => /violet/.test(forcedText()), 5000);
check("typed turn: answered in the voice", /Probably violet/.test(forcedText()), forcedText());

// 11 — numbers are read as words
reset();
await speak("how long is the flight and what does it cost");
await waitFor(() => pp.forced.length > 0, 5000);
await sleep(800);
check("numbers are spoken as words", /thirteen hours/.test(forcedText()) && /nine hundred dollars/.test(forcedText()), forcedText());

// 12 — the tap that ends the turn doesn't drop the answer on its way
reset();
tab.events.length = 0;
await speak("how are you doing today");
tab.tab({ type: "mic", on: false }); // tap right after the question, before the answer
await waitFor(() => /doing great/.test(forcedText()), 5000);
check("mic off right after asking: the answer is still said", /doing great/.test(forcedText()), forcedText());
tab.tab({ type: "mic", on: true });
await sleep(800);

// 13 — the chat model is slow: the fast model takes the turn
reset();
gw.delay["brain-x"] = 4000;
stop = await speak("how are you doing today");
await waitFor(() => pp.forced.length > 0, 6000);
first = pp.forced[0] ? pp.forced[0].t - stop : -1;
check("slow chat model: the backup model answers instead", /doing great/.test(forcedText()) && gw.seen.some((s) => s.model === "backup-x" && /live voice call/.test(s.system)), `${first} ms`);
check("slow chat model: still within 2.5 s", first > 0 && first < 2500, `${first} ms`);
delete gw.delay["brain-x"];
await sleep(1500);

// 14 — no model answers: say so once; twice running, the voice is let free rather than leave silence
reset();
tab.events.length = 0;
gw.down.add("brain-x");
gw.down.add("backup-x");
await speak("how are you doing today");
await waitFor(() => /lost my thread/.test(forcedText()), 6000);
check("brain down: she says so once", /lost my thread/.test(forcedText()), forcedText());
await sleep(2500);
await speak("are you there at all");
await waitFor(() => tab.of("status").some((s) => /on its own/.test(String(s.text))), 6000);
check("brain down twice: the voice is released for this call", tab.of("status").some((s) => /on its own/.test(String(s.text))) && pp.held === false, `held=${pp.held}`);
gw.down.clear();
call.stop();
await sleep(400);

// 16 — the live-call review's fixes
({ tab, call } = await newCall());
(await imp("tools/pending.ts")).registerPendingTools();
const { askYesNo, pendingQuestion, dropPending } = await imp("agent/pending.ts");
// (a) her own "Okay." heard back through the speakers doesn't answer a waiting question
const answers: boolean[] = [];
askYesNo({
  question: "Fill your Visa ending 4242?",
  onAnswer: (yes: boolean) => (answers.push(yes), { ok: true, say: yes ? "Filled it in." : "Left it out.", speak: yes ? "Filled it in." : "Left it out." }),
});
reset();
await speak("one sec");
await waitFor(() => /Okay/.test(forcedText()), 6000);
await sleep(300);
results("Okay.", false, false);
await sleep(250);
results("Okay.", true, true);
await sleep(2000);
check("her own short reply heard back doesn't answer a waiting question", answers.length === 0 && pendingQuestion() !== null, `answers=${JSON.stringify(answers)} said=${forcedText()}`);
dropPending();
// (b) the first tap after an idle spell: the pod's silence while nothing was sent says nothing about it
await sleep(9000);
const closedBefore = tab.of("status").filter((e) => /stopped answering/.test(String(e.text))).length;
tab.tab({ type: "mic", on: true });
for (let i = 0; i < 18; i++) {
  tab.emit("message", Buffer.alloc(3840), true);
  await sleep(80);
}
await sleep(300);
check(
  "the first tap after nine idle seconds doesn't end the call",
  tab.of("status").filter((e) => /stopped answering/.test(String(e.text))).length === closedBefore && !(call as unknown as { closed: boolean }).closed,
);
// (c) a typed turn while the mic-off wait is on doesn't run the spoken words twice
reset();
board.addCard({ kind: "text", title: "Note: eggs", text: "eggs", status: "ready", url: null });
const toolsBefore = tab.of("tool").length;
results("close card two", false, false);
await sleep(200);
tab.tab({ type: "mic", on: false });
await sleep(100);
tab.tab({ type: "text", text: "thanks" });
await sleep(200);
dg.sock?.send(JSON.stringify({ type: "Results", is_final: true, speech_final: false, from_finalize: true, channel: { alternatives: [{ transcript: "close card two" }] } }));
await sleep(2500);
const removes = tab.of("tool").slice(toolsBefore).filter((e) => e.tool === "remove_card").length;
check("a typed turn during the mic-off wait: the spoken request runs once", removes === 1, `remove_card ran ${removes} time(s)`);
call.stop();
await sleep(400);

// 15 — free style keeps the old behaviour: the voice answers small talk itself
process.env.TALK_STYLE_OVERRIDE = "free";
const settings = await imp("settings.ts");
settings.setEndpoints({ talkStyle: "free" });
({ tab, call } = await newCall());
reset();
await speak("how are you doing today");
await sleep(1500);
check("free style: the voice improvises small talk, and the brain isn't asked", tab.of("ready")[0]?.talk === "free" && pp.own.length > 0 && !gw.seen.some((s) => /live voice call/.test(s.system) && /Two special replies/.test(s.system)), `own=${pp.own.join(" ")}`);
// The pend hold must not outlive a tool that fired mid-sentence and is picked again at the end (review defect).
reset();
await speak("clear the board");
await sleep(1500);
const holds = [...((call as unknown as { holds: Map<string, number> }).holds.keys())];
check("free style: no sentence hold is left behind after a repeat pick", !holds.some((h) => h.startsWith("pend:")), holds.join(","));
settings.setEndpoints({ talkStyle: "" });
call.stop();

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
ppServer.close();
dgServer.close();
gateway.close();
process.exit(fails ? 1 : 0);
