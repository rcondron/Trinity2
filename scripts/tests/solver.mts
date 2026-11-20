// The second opinion, the problem solver (figure_out) and the never-stuck card, against a fake Mordiem and a fake
// Tavily: what the arbiter fires and when it stays out; the solver's steps, corrections, questions, skill hand-off
// and slow path; the designer retry and the plain fallback card; the topic cleanup.
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through the runner (npm test -- --only <name>): it gives each suite a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

// ── fake Mordiem and Tavily ───────────────────────────────────────────────────
const calls: { kind: string; messages: number }[] = [];
let plannerScript: Record<string, unknown>[] = [];
let plannerDelayMs = 0;
let arbiterReply: Record<string, unknown> = { tool: "none", confidence: 0.2 };
let designerFails = false;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? "";
    let kind = "other";
    let content = JSON.stringify({ task: false });
    if (/second opinion/.test(system)) {
      kind = "arbiter";
      content = JSON.stringify(arbiterReply);
    } else if (/problem-solver/.test(system)) {
      kind = "planner";
      if (plannerDelayMs) await sleep(plannerDelayMs);
      content = JSON.stringify(plannerScript.shift() ?? { done: true, say: "Nothing left to do." });
    } else if (/card designer/.test(system)) {
      kind = "designer";
      calls.push({ kind, messages: body.messages.length });
      if (designerFails) return json({ error: "boom" }, 500);
      content = JSON.stringify({ title: "Blueberry muffins", summary: "A muffin recipe.", blocks: [{ kind: "steps", items: ["Mix", "Bake"] }] });
      return json({ choices: [{ message: { content } }] });
    } else if (/fill in the arguments/.test(system)) {
      kind = "extract";
      content = JSON.stringify({ query: "weather in austin" });
    }
    calls.push({ kind, messages: body.messages.length });
    return json({ choices: [{ message: { content } }] });
  }
  if (u.includes("api.tavily.com")) return json({ answer: "It is sunny in Austin.", results: [{ title: "Austin weather", url: "https://weather.example/austin", content: "Sunny, 75F" }] });
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

const { registerBuiltins } = await imp("tools/builtins.ts");
const { registerAskTools } = await imp("tools/ask.ts");
const { registerForgeTools } = await imp("tools/forge.ts");
const { decide, visibleTools } = await imp("agent/router.ts");
const { looksLikeAsk, secondOpinion } = await imp("agent/arbiter.ts");
const { getTools } = await imp("tools/registry.ts");
const { setTellFallback } = await imp("agent/tell.ts");
const spec = await imp("services/content-spec.ts");
const { createMemoryStore } = await imp("db/memory.ts");
registerBuiltins();
registerAskTools();
registerForgeTools();
const memory = await createMemoryStore();

type Res = { ok: boolean; say: string; speak?: string; inProgress?: string; data?: Record<string, unknown> };
type AnyTool = { name: string; available?: () => boolean; run: (a: Record<string, unknown>, c: unknown) => Promise<Res> };
const persona = { id: "trinity", name: "Trinity", description: "You are Trinity.", voicePrompt: "", voice: "NATF2", traits: { role: "general companion & agent" }, toolsets: [], updatedAt: 0 };
const ctx = (utterance: string) => ({ utterance, persona, recentTranscript: [], emit: () => {}, memory, situation: "" });
const tool = (n: string) => (getTools() as AnyTool[]).find((t) => t.name === n)!;
const conv = (u: string, state = "finished speaking") => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (${state}): ${u}`;
const arbiterCalls = () => calls.filter((c) => c.kind === "arbiter").length;

// ── looksLikeAsk ──
check(
  "ask: explicit requests, handed-over details, figure-outs",
  looksLikeAsk("Login is Ryan Condron.") && looksLikeAsk("Can you turn on the kitchen lights") && looksLikeAsk("Alright. Could you please book me a table for two at seven.") && looksLikeAsk("go ahead and sign in") && looksLikeAsk("please organize my photos by year") && looksLikeAsk("figure out how to export my calendar"),
);
check(
  "ask: not talk, questions, fragments or bare imperatives",
  !looksLikeAsk("That's funny.") && !looksLikeAsk("What's the weather like?") && !looksLikeAsk("I went to the store yesterday") && !looksLikeAsk("ok") && !looksLikeAsk("How do I get there?") && !looksLikeAsk("Tell me more") && !looksLikeAsk("Book me a table for two at seven.") && !looksLikeAsk("Can you hear me?"),
);

// ── the topic ──
check(
  "topic: request words stripped",
  spec.topicFrom("And can you show me a recipe for blueberry muffins") === "blueberry muffins" && spec.topicFrom("put a blueberry muffin recipe on the board") === "blueberry muffin recipe" && spec.topicFrom("Alright, the weather for Austin please") === "Austin",
  JSON.stringify([spec.topicFrom("And can you show me a recipe for blueberry muffins"), spec.topicFrom("put a blueberry muffin recipe on the board"), spec.topicFrom("Alright, the weather for Austin please")]),
);

// ── the designer retry and the plain card ──
const composeInput = {
  persona,
  utterance: "show me a recipe for blueberry muffins",
  topic: "blueberry muffins",
  type: "recipe",
  sources: [{ title: "Best muffins", url: "https://food.example/muffins", snippet: "" }],
  answer: "Mix the batter, then bake at 375 for twenty minutes.",
  quality: "auto",
  timeoutMs: 2_000,
};
designerFails = true;
const composed = await spec.composeContent(composeInput);
check("designer down: the fast model is tried too, then nothing", composed === null && calls.filter((c) => c.kind === "designer").length === 2, `designer calls: ${calls.filter((c) => c.kind === "designer").length}`);
const plain = spec.fallbackSpec(composeInput) as { title: string; summary: string; blocks: { kind: string }[]; sources: unknown[] } | null;
check(
  "fallback card: plain spec with the answer, the sources and a note",
  plain !== null && plain.title === "Blueberry muffins" && plain.blocks.some((b) => b.kind === "text") && plain.blocks.some((b) => b.kind === "list") && plain.blocks.some((b) => b.kind === "note") && plain.sources.length === 1 && /didn't answer/.test(plain.summary),
  JSON.stringify(plain).slice(0, 300),
);
designerFails = false;
const composedOk = await spec.composeContent(composeInput);
check("designer up: composed on the first try", composedOk !== null && composedOk.spec.title === "Blueberry muffins" && calls.filter((c) => c.kind === "designer").length === 3);

// ── the second opinion ──
const tools = visibleTools(persona);
check("figure_out is a visible tool", tools.some((t: { name: string }) => t.name === "figure_out"));
const unsure = { action: "web_search", confidence: 0.55, tool: tool("web_search"), options: {}, offered: ["x"], ms: 1 };
arbiterReply = { tool: "web_search", confidence: 0.92, why: "wants a lookup" };
const second = await secondOpinion({ persona, conversation: conv("look up the weather in austin"), done: [] }, tools, unsure, 0.7);
check("second opinion confirms an unsure pick, nothing left offered", second?.action === "web_search" && second.confidence >= 0.9 && second.offered.length === 0, JSON.stringify(second && [second.action, second.confidence]));
arbiterReply = { tool: "none", confidence: 0.9 };
check("second opinion can say none", (await secondOpinion({ persona, conversation: conv("look up the weather in austin"), done: [] }, tools, unsure, 0.7)) === null);
arbiterReply = { tool: "figure_out", confidence: 0.88, why: "no tool for lights" };
const before = arbiterCalls();
const d = await decide({ persona, conversation: conv("Can you turn on the kitchen lights"), done: [] });
check("NONE for a plain ask → the arbiter → figure_out", d.action === "figure_out" && d.tool?.name === "figure_out" && arbiterCalls() === before + 1, JSON.stringify([d.action, d.confidence]));
const d2 = await decide({ persona, conversation: conv("That's funny."), done: [] });
check("talk stays NONE with no arbiter call", d2.action === "NONE" && arbiterCalls() === before + 1);
const d3 = await decide({ persona, conversation: conv("can you turn on the", "may still be speaking"), done: [] });
check("mid-sentence: never a second opinion", d3.action === "NONE" && arbiterCalls() === before + 1);
const d4 = await decide({ persona, conversation: conv("draw me a picture of a cat"), done: [] });
check("a sure first pick skips the arbiter", d4.action === "make_image" && arbiterCalls() === before + 1, d4.action);

// ── the solver ──
plannerScript = [
  { thought: "look it up", call: { tool: "web_search", args: { query: "weather in austin" } } },
  { thought: "answer", done: true, say: "It's sunny in Austin right now." },
];
const r = await tool("figure_out").run({}, ctx("figure out what the weather is like in austin"));
check("solver: used web_search then answered, spoken verbatim", r.ok && r.speak === "It's sunny in Austin right now." && String((r.data?.used as string[])?.join()) === "web_search" && r.data?.steps === 2, JSON.stringify(r));
check("solver: the result went back into the conversation", calls.filter((c) => c.kind === "planner").at(-1)?.messages === 4, JSON.stringify(calls.filter((c) => c.kind === "planner").map((c) => c.messages)));
plannerScript = [{ call: { tool: "nope" } }, { done: true, say: "Done anyway." }];
const r2 = await tool("figure_out").run({}, ctx("do the thing"));
check("solver: an unknown tool is corrected", r2.ok && r2.say === "Done anyway." && r2.data?.steps === 2, JSON.stringify(r2));
plannerScript = [{ done: false, say: "Which room do you mean?" }];
const r3 = await tool("figure_out").run({}, ctx("turn on the lights"));
check("solver: asks the user when it must", r3.ok === false && r3.say === "Which room do you mean?", JSON.stringify(r3));
plannerScript = [{ call: { tool: "create_skill", args: { need: "a tool that toggles the kitchen lights through the Hue bridge" } } }, { done: true, say: "I'm making a skill for the lights." }];
const r4 = await tool("figure_out").run({}, ctx("turn on the kitchen lights"));
check("solver: hands off to create_skill", r4.ok && r4.data?.forged === true && /making a skill/.test(r4.say), JSON.stringify(r4));
plannerScript = [{ thought: "", say: "" }, { nonsense: true }, { done: true, say: "Third time lucky." }];
const r5 = await tool("figure_out").run({}, ctx("do something odd"));
check("solver: a reply with neither call nor say is corrected", r5.ok && r5.say === "Third time lucky." && r5.data?.steps === 3, JSON.stringify(r5));

const told: string[] = [];
setTellFallback((text: string) => told.push(text));
plannerDelayMs = 4_500;
plannerScript = [{ call: { tool: "web_search", args: { query: "x" } } }, { done: true, say: "Found it later." }];
const r6 = await tool("figure_out").run({}, ctx("find something slow"));
check("solver: slow work is acknowledged, not awaited", r6.ok && r6.inProgress === "started" && /working that out/.test(r6.say), JSON.stringify(r6));
for (let i = 0; i < 80 && !told.length; i++) await sleep(250);
check("solver: the answer is told when it lands", told[0] === "Found it later.", JSON.stringify(told));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
