// Owed lines: an unprompted line that no voice anyone can hear could say waits, and the next call that can be heard says
// it — never another voice. The real VoiceCall, announce(), tell() and Orchestrator.proactive() against a fake PersonaPlex
// (8895) and a fake Deepgram (8894); each "tab" is a fake browser socket that reports playback the way call.ts does.
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
async function waitFor(fn: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

// ── fake PersonaPlex: hello, then records forced words (kind 3); `dropNext` hangs up on the next forced words ──
type Sock = { send: (d: unknown) => void; close: () => void; on: (e: string, f: (...a: unknown[]) => void) => void };
const pp = { forced: [] as string[], dropNext: false };
const ppServer = new WebSocketServer({ port: 8895, host: "127.0.0.1" });
ppServer.on("connection", (ws: Sock) => {
  ws.send(Buffer.from([0x00]));
  ws.on("message", (data: unknown, isBinary: unknown) => {
    if (!isBinary) return;
    const b = data as Buffer;
    if (b[0] !== 3) return;
    if (pp.dropNext) {
      pp.dropNext = false;
      ws.close();
      return;
    }
    pp.forced.push(b.subarray(1).toString("utf8"));
  });
});
// ── fake Deepgram: takes the stream, says nothing ──
const dgServer = new WebSocketServer({ port: 8894, host: "127.0.0.1" });
dgServer.on("connection", (ws: Sock) => ws.on("message", () => {}));

// ── the engine ──
const { createMemoryStore } = await imp("db/memory.ts");
const memory = await createMemoryStore();
await (await imp("db/seed.ts")).seed(memory);
const vc = await imp("services/voice-call.ts");
const { tellEveryone, setTellFallback } = await imp("agent/tell.ts");
const { Orchestrator } = await imp("orchestrator.ts");
let wakes = 0;
vc.setWakeNotifier(() => wakes++);

class FakeTab extends EventEmitter {
  readyState = 1;
  events: Record<string, unknown>[] = [];
  send(s: unknown) {
    if (typeof s !== "string") return; // audio
    try {
      this.events.push(JSON.parse(s));
    } catch {
      /* not JSON */
    }
  }
  ping() {
    this.emit("pong");
  }
  terminate() {}
  close() {}
  /** A message from the tab, as call.ts sends it. */
  tab(obj: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
  of(type: string) {
    return this.events.filter((e) => e.type === type);
  }
}

/** A standby call from this tab; `plays`: the tab already had a tap, so it reports playback as its socket opens. */
async function openCall(tab: FakeTab, opts: Record<string, unknown> = {}, plays = false) {
  const call = new vc.VoiceCall(tab, memory, { voice: "NATF2", standby: true, ...opts });
  if (plays) tab.tab({ type: "playback", on: true });
  await call.start();
  await waitFor(() => tab.of("ready").length > 0);
  return call;
}
const announced = (tab: FakeTab) => tab.of("announced").map((e) => `${e.turnId}:${e.spoken}`).join(" ");

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}

// 1 — no call anywhere
check("no call, with a turn to show it as: owed", (await vc.announce("Quick reminder: time to stretch.", "t1")) === "owed");
check("no call: the tabs are asked to warm a voice", wakes === 1, `wakes ${wakes}`);
check("no turn to show it as: unsaid, and not kept", (await vc.announce("Nothing to show it as.")) === "unsaid" && vc.owedLines() === 1);

// 2 — a standby in a tab that can't play yet
const tab1 = new FakeTab();
const call1 = await openCall(tab1);
await sleep(600);
check("can't be heard: nothing is said", pp.forced.length === 0, pp.forced.join(" | "));
check("can't be heard: its tab is asked for a tap", tab1.of("owed").length === 1);
check("can't be heard: a new line is owed too", (await vc.announce("Your new skill is ready.", "t2")) === "owed" && vc.owedLines() === 2);
check("can't be heard: asked for a tap only once", tab1.of("owed").length === 1);
check("a call is up: no wake for that line", wakes === 1, `wakes ${wakes}`);

// 3 — the tap sets playback up: what's owed is said, oldest first, each under its turn
tab1.tab({ type: "playback", on: true });
await waitFor(() => tab1.of("announced").length >= 2, 15_000);
check("after the tap: both said, oldest first", announced(tab1) === "t1:said t2:said", announced(tab1));
check("the pod got their words", /stretch/.test(pp.forced.join(" ")) && /skill/.test(pp.forced.join(" ")), pp.forced.join(" | "));
check("each starts with an announce for its turn", tab1.of("announce").map((e) => e.turnId).join(" ") === "t1 t2");
check("nothing waits", vc.owedLines() === 0);

// 4 — a call that can be heard: said at once, as before
check("heard: said at once", (await vc.announce("Time to call mom.", "t3")) === "said" && vc.owedLines() === 0);
call1.stop();
await sleep(300);

// 5 — proactive(): shown at once as an owed turn…
const orch = new Orchestrator(memory);
const shown: Record<string, unknown>[] = [];
const saidNow = await orch.proactive("Stand up and stretch.", (e: Record<string, unknown>) => shown.push(e), "Stretch");
const turn = shown.find((e) => e.type === "transcript")?.turn as Record<string, unknown> | undefined;
check(
  "proactive, no voice: an owed turn at once",
  !saidNow && turn?.owed === true && turn?.voiced === false && turn?.proactive === true,
  JSON.stringify(turn),
);
// 6 — …and a wake call from a tab that already plays says it as soon as it's up, under that turn's id
const tab2 = new FakeTab();
const call2 = await openCall(tab2, { wake: true }, true);
await waitFor(() => tab2.of("announced").length >= 1, 15_000);
check("a wake call that plays: says it once up, as that turn", announced(tab2) === `${turn?.id}:said`, announced(tab2));
check("…and never asks for a tap", tab2.of("owed").length === 0);
call2.stop();
await sleep(300);

// 7 — tell(): news with no voice up is owed, under the id the app shows it as
const told: { text: string; spoken: string; id: string }[] = [];
setTellFallback((text: string, spoken: string, id: string) => told.push({ text, spoken, id }));
tellEveryone("Your report card is ready.");
await waitFor(() => told.length > 0);
check("tell, no voice: owed, shown under an id", told[0]?.spoken === "owed" && !!told[0]?.id, JSON.stringify(told[0]));

// 8 — opening the mic counts as the tap
const tab3 = new FakeTab();
const call3 = await openCall(tab3);
await sleep(300);
check("the news waits in a standby that can't be heard", tab3.of("announced").length === 0 && tab3.of("owed").length === 1);
tab3.tab({ type: "mic", on: true });
await waitFor(() => tab3.of("announced").length >= 1, 15_000);
check("mic on: the owed line is said", announced(tab3) === `${told[0]?.id}:said`, announced(tab3));
tab3.tab({ type: "mic", on: false });
call3.stop();
await sleep(300);

// 9 — the call drops mid-line: the line waits for the next call
check("owed again with no call", (await vc.announce("A line the dropped call never finished.", "t9")) === "owed");
const tab4 = new FakeTab();
pp.dropNext = true;
await openCall(tab4, {}, true);
await waitFor(() => tab4.of("announced").length >= 1, 10_000);
check("the call dropped mid-line: unsaid", announced(tab4) === "t9:unsaid", announced(tab4));
check("…and it waits for the next call", vc.owedLines() === 1);
const tab5 = new FakeTab();
const call5 = await openCall(tab5, {}, true);
await waitFor(() => tab5.of("announced").length >= 1, 15_000);
check("the next call says it", announced(tab5) === "t9:said", announced(tab5));
call5.stop();
await sleep(300);

// 10 — at most five wait (the oldest go), and none past ten minutes
for (let i = 1; i <= 7; i++) await vc.announce(`Backlog line ${i}.`, `b${i}`);
check("at most five wait", vc.owedLines() === 5, String(vc.owedLines()));
const tab6 = new FakeTab();
const call6 = await openCall(tab6, {}, true);
await waitFor(() => tab6.of("announced").length >= 5, 30_000);
check("the oldest two went; the rest are said in order", announced(tab6) === "b3:said b4:said b5:said b6:said b7:said", announced(tab6));
call6.stop();
await sleep(300);
await vc.announce("A line nobody hears in time.", "s1");
const realNow = Date.now;
Date.now = () => realNow() + 11 * 60_000;
const stale = vc.owedLines();
Date.now = realNow;
check("past ten minutes: it's dropped (it stays the text it was shown as)", stale === 0, String(stale));

console.log(fails ? `\n${fails} FAILED` : "\nALL GOOD");
ppServer.close();
dgServer.close();
process.exit(fails ? 1 : 0);
