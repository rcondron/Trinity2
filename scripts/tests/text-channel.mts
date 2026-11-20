// The text channel (a typed turn with no live call): a turn no tool takes is answered by the same talking brain as the
// call — brief, with the profile and the time in view — a request no tool took goes to the solver instead of being
// declined, and there is always a reply, even when the gateway is down. A fake gateway on 8893; no routing model (the
// keyword rules decide), so nothing here reaches a real service.
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through its launcher (npm test -- --only <name>, or npm run harness for the app harness): it gives the engine a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);

// ── fake model gateway ──
interface Seen {
  model: string;
  system: string;
  user: string;
}
const gw = { seen: [] as Seen[], down: false };
function scripted(system: string, user: string): string {
  const u = user.toLowerCase();
  if (/live voice call/.test(system)) {
    const markers = /Two special replies/.test(system);
    if (u.includes("how are you")) return "I'm doing great, thanks for asking.";
    if (u.includes("book me a table")) return markers ? "ACT" : "I can't book tables.";
    if (u.includes("okay")) return markers ? "SILENT" : "Okay.";
    if (u.includes("long story")) return "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.";
    return "Sure thing.";
  }
  if (/Reply as spoken dialogue/.test(system)) return "Plain brain words.";
  return "{}"; // the second opinion, the curator: nothing to add
}
const gateway = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ["brain-x", "fast-x", "reply-x", "plan-x", "backup-x"].map((id) => ({ id })) }));
    return;
  }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as { model: string; stream?: boolean; messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages[body.messages.length - 1]?.content ?? "";
    gw.seen.push({ model: body.model, system, user });
    if (gw.down) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down" }));
      return;
    }
    const text = scripted(system, user);
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const token of text.split(/(?<=\s)/)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => gateway.listen(8893, "127.0.0.1", r));

const { createMemoryStore } = await imp("db/memory.ts");
const memory = await createMemoryStore();
await (await imp("db/seed.ts")).seed(memory);
(await imp("tools/builtins.ts")).registerBuiltins();
const { registerTool, unregisterTool } = await imp("tools/registry.ts");
const { Orchestrator } = await imp("orchestrator.ts");
const { setProfileName } = await imp("db/sqlite.ts");
setProfileName?.("Sam");

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}

type Ev = Record<string, unknown> & { type: string };
const orch = new Orchestrator(memory);
async function turn(text: string): Promise<{ events: Ev[]; said: string; talk: Seen | undefined }> {
  const events: Ev[] = [];
  const from = gw.seen.length;
  await orch.handleUserText(text, (e: Ev) => events.push(e));
  const turns = events.filter((e) => e.type === "transcript").map((e) => e.turn as { speaker: string; text: string });
  return { events, said: turns.filter((t) => t.speaker === "trinity").map((t) => t.text).join(" | "), talk: gw.seen.slice(from).find((s) => /live voice call/.test(s.system)) };
}

// 1 — conversation: the talking brain answers, briefly, with the user and the clock in view
let r = await turn("how are you");
check("a turn no tool takes is answered by the talking brain", r.said === "I'm doing great, thanks for asking.", r.said);
check("its prompt is the call's: the special replies, the user's name, today's date", !!r.talk && /Two special replies/.test(r.talk.system) && /Sam/.test(r.talk.system) && new RegExp(String(new Date().getFullYear())).test(r.talk.system));
r = await turn("tell me a long story");
check("a long answer is capped in code", r.said.split(/(?<=[.!?])\s+/).length <= 6, r.said);

// 2 — a request no tool took: tried, not declined
let ran = 0;
registerTool({
  name: "figure_out",
  description: "Work out how to do something no other tool covers.",
  input: {},
  run: async () => {
    ran++;
    return { ok: true, say: "Worked it out.", speak: "I found the number for Luigi's and put it on the board." };
  },
});
r = await turn("book me a table for two at Luigi's tonight");
check("a request no tool took goes to the solver", ran === 1 && /Luigi/.test(r.said), `${ran} · ${r.said}`);
check("the feed shows the solver took it", r.events.some((e) => e.type === "route" && JSON.stringify(e).includes("figure_out")), JSON.stringify(r.events.filter((e) => e.type === "route")).slice(0, 200));
check("she never says she can't", !/can'?t/i.test(r.said), r.said);
unregisterTool("figure_out");
ran = 0;
r = await turn("book me a table for two at Luigi's tonight");
check("with no solver to hand it to, the brain still answers in words", ran === 0 && r.said.length > 0 && r.said !== "ACT", r.said);

// 3 — a nod still gets a reply on the text channel (nothing is "silent" in a typed conversation)
r = await turn("okay");
check("a typed nod gets words, never a marker", r.said.length > 0 && !/^(ACT|SILENT)$/.test(r.said), r.said);

// 4 — the gateway is down: a reply all the same
gw.down = true;
r = await turn("how are you");
check("gateway down: an honest line, not a canned one, and no marker leaks", /couldn't reach/.test(r.said) && !/I remember:/.test(r.said) && !/^(ACT|SILENT)$/.test(r.said), r.said);
gw.down = false;

// 4b — a tool with nothing to say (table talk at a game): no reply at all, not an empty one
let hushed = 0;
registerTool({ name: "hush_check", description: "Test tool.", input: {}, argMode: "raw", source: "forged", run: async () => (hushed++, { ok: true, say: "(table talk: nothing said)", silent: true }) });
registerTool({ name: "blank_check", description: "Test tool.", input: {}, argMode: "raw", source: "forged", run: async () => (hushed++, { ok: true, say: "(nothing)", speak: " " }) });
r = await turn("run the hush check");
check("a silent result: the tool ran and no reply is shown", hushed === 1 && r.said === "" && !r.events.some((e) => e.type === "transcript" && (e.turn as { speaker: string }).speaker === "trinity"), JSON.stringify(r.said));
r = await turn("run the blank check");
check("an old-style blank line counts as silent too", hushed === 2 && r.said === "", JSON.stringify(r.said));
unregisterTool("hush_check");
unregisterTool("blank_check");

// 5 — a tool that fires is untouched by all this
r = await turn("what time is it");
check("a tool turn fires as before", /\d|o'clock|AM|PM/i.test(r.said) && !r.talk, r.said);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
gateway.close();
process.exit(fails ? 1 : 0);
