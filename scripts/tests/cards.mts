// Content cards against a fake Mordiem + fake Tavily: show_card end to end (placeholder → written card → hero
// picture), the slow-designer path (acknowledge now, tell later), a card removed mid-flight, the renderer and
// normalizer on hostile input, and keyless routing of the phrases that must reach show_card (and must not).
// Run from a scratch cwd with TRINITY_DATA_DIR under it, MORDIEM_API_KEY=test, TAVILY_API_KEY=test, no other keys.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through the runner (npm test -- --only <name>): it gives each suite a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);
const DATA = process.env.TRINITY_DATA_DIR!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ── canned designer replies ───────────────────────────────────────────────────
const RECIPE = {
  type: "recipe",
  title: "Bakery-Style Blueberry Muffins",
  subtitle: "Tall domes, crunchy sugar tops, bursting with berries",
  summary: "Here's a blueberry muffin recipe that makes twelve, about forty minutes start to finish, with a crunchy sugar top.",
  theme: { accent: "#3b82f6", mood: "warm" },
  image: { prompt: "blueberry muffins cooling on a rack, bakery style, soft morning light", alt: "Blueberry muffins" },
  meta: [{ label: "Prep", value: "15 min" }, { label: "Bake", value: "22 min" }, { label: "Serves", value: "12" }],
  blocks: [
    { kind: "text", paragraphs: ["Tall, tender muffins with a sugar crust <b>& extra</b> berries."] },
    { kind: "list", title: "Ingredients", style: "check", items: ["2½ cups flour", "1 cup sugar", "2 cups blueberries", "<script>alert(1)</script>"] },
    { kind: "steps", title: "Method", items: ["Heat the oven to 425°F.", "Whisk the dry ingredients.", "Fold in the berries.", "Bake 5 minutes, then lower to 375°F for 17 more."] },
    { kind: "note", tone: "tip", text: "Toss the berries in a spoonful of flour so they don't sink." },
    { kind: "facts", title: "Per muffin", items: [{ label: "Calories", value: "310" }, { label: "Protein", value: "5 g" }] },
    { kind: "tags", items: ["vegetarian", "breakfast", "**bake**"] },
  ],
  sources: [],
};
const NEWS = (urls: string[]) => ({
  type: "news",
  title: "Today's headlines",
  subtitle: "Sunday, 1 November 2026",
  summary: "Top of the news today: a budget vote, a storm in the Gulf, and a record for the women's marathon.",
  theme: { accent: "#dc2626", mood: "editorial" },
  image: { prompt: "a newspaper", alt: "news" },
  meta: [{ label: "As of", value: "this morning" }],
  blocks: [
    { kind: "text", title: "What's happening", paragraphs: ["Three stories lead the day."] },
    {
      kind: "headlines",
      items: [
        { title: "Budget vote passes", summary: "The chamber approved it late last night.", source: "Reuters", url: urls[0], when: "2h ago" },
        { title: "Storm nears the Gulf coast", source: "AP", url: urls[1], when: "4h ago" },
        { title: "Marathon record falls", source: "Made Up", url: "https://invented.example/story", when: "6h ago" },
      ],
    },
  ],
  sources: [{ title: "Reuters", url: urls[0] }, { title: "Invented", url: "https://invented.example/" }, { title: "javascript", url: "javascript:alert(1)" }],
});
const PERSON = {
  type: "person",
  title: "Marie Curie",
  subtitle: "Physicist and chemist who discovered polonium and radium",
  summary: "Marie Curie was the physicist and chemist who discovered polonium and radium and won two Nobel Prizes.",
  theme: { accent: "not-a-colour", mood: "editorial" },
  image: { prompt: "a 1900s laboratory bench with glowing vials, no people", alt: "A laboratory" },
  meta: [{ label: "Born", value: "7 Nov 1867, Warsaw" }, { label: "Died", value: "4 Jul 1934" }],
  blocks: [
    { kind: "text", paragraphs: ["Born Maria Skłodowska in Warsaw.", "She moved to Paris in 1891."] },
    { kind: "timeline", items: [{ when: "1891", what: "Moves to Paris" }, { when: "1903", what: "Nobel Prize in Physics" }, { when: "1911", what: "Nobel Prize in Chemistry" }] },
    { kind: "stats", items: [{ value: "2", label: "Nobel Prizes" }, { value: "1898", label: "Radium found" }] },
    { kind: "quote", text: "Nothing in life is to be feared, it is only to be understood.", by: "Marie Curie" },
    { kind: "table", columns: ["Year", "Prize"], rows: [["1903", "Physics"], ["1911", "Chemistry"]] },
    { kind: "pros_cons", title: "Legacy", pros: ["Radiology"], cons: ["Radiation exposure"] },
    { kind: "schedule", items: [{ when: "Day 1", title: "Visit the Curie Museum", detail: "Paris, 5th arrondissement" }] },
    { kind: "bogus", items: ["dropped"] },
  ],
  sources: [],
};

let slowOnce = false;
let designerCalls = 0;
let imageCalls: string[] = [];
let tavilyCalls = 0;
const TAVILY = {
  answer: "A budget vote and a storm lead the news.",
  results: [
    { title: "Budget vote passes", url: "https://www.reuters.com/world/budget-vote", content: "The chamber approved the budget late last night." },
    { title: "Storm nears the Gulf", url: "https://apnews.com/article/storm-gulf", content: "A tropical storm is expected to reach the coast by Tuesday." },
  ],
};

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (u.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { role: string; content: string }[]; model: string };
    const system = body.messages[0]?.content ?? "";
    designerCalls++;
    if (slowOnce) {
      slowOnce = false;
      await sleep(11_000);
    }
    const spec = /is a news card/.test(system) ? NEWS(TAVILY.results.map((r) => r.url)) : /is a profile card/.test(system) ? PERSON : RECIPE;
    return json({ choices: [{ message: { content: `Here you go:\n\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` } }] });
  }
  if (u.endsWith("/images/generations")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt: string };
    imageCalls.push(body.prompt);
    await sleep(200);
    return json({ data: [{ b64_json: PNG_B64 }] });
  }
  if (u.includes("api.tavily.com")) {
    tavilyCalls++;
    return json(TAVILY);
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

const { registerBuiltins } = await imp("tools/builtins.ts");
const { registerCodingTools } = await imp("tools/coding.ts");
const { registerAskTools } = await imp("tools/ask.ts");
const { registerMemoryTools } = await imp("tools/memory.ts");
const { registerScheduleTools } = await imp("tools/schedule.ts");
const { getTools } = await imp("tools/registry.ts");
const { workspace } = await imp("workspace/bus.ts");
const { listCards, removeCard, describeBoard } = await imp("workspace/board.ts");
const { contextFor } = await imp("agent/context.ts");
const { decide } = await imp("agent/router.ts");
const { live } = await imp("settings.ts");
const { renderContentCard } = await imp("workspace/content-card.ts");
const { normalizeSpec, guessType, topicFrom, wantsWeb, earlyImagePrompt } = await imp("services/content-spec.ts");
registerBuiltins();
registerCodingTools();
registerAskTools();
registerMemoryTools();
registerScheduleTools();

type AnyTool = { name: string; description: string; input: Record<string, unknown>; run: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>> };
const tools = getTools() as AnyTool[];
const tool = (n: string) => tools.find((t) => t.name === n)!;
const persona = { id: "trinity", name: "Trinity", description: "You are Trinity, warm and quick.", voicePrompt: "", voice: "NATF2", traits: {}, toolsets: [], updatedAt: 0 };
const emitted: Record<string, unknown>[] = [];
const ctx = (utterance: string) => ({ persona, recentTranscript: [], emit: (e: Record<string, unknown>) => emitted.push(e), utterance, memory: {}, situation: contextFor(persona).summary });
type Card = { n: number; kind: string; status: string; title: string; text: string; html?: string | null; tags?: string[]; w: number; h?: number; model?: string };
const cards = () => listCards() as Card[];
const card = (n: number) => cards().find((c) => c.n === n)!;

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

console.log("live:", JSON.stringify({ mordiem: live.mordiem, jev: live.jev, web: live.web }));
check("show_card registered", Boolean(tool("show_card")), tools.map((t) => t.name).join(", "));
check("show_card has type + quality options", "type" in tool("show_card").input && "quality" in tool("show_card").input);

// ── helpers under test ──────────────────────────────────────────────────────
check("guessType recipe", guessType("can you give me a blueberry muffin recipe") === "recipe");
check("guessType news", guessType("what's in the news today") === "news");
check("guessType person", guessType("who was Marie Curie") === "person");
check("guessType comparison", guessType("compare the iPhone 17 and the Pixel 10") === "comparison");
check("guessType howto", guessType("how do I fix a leaking tap") === "howto");
check("guessType weather", guessType("what's the weather in Austin this weekend") === "weather");
check("guessType explainer", guessType("what is quantum computing") === "explainer");
check("guessType list", guessType("top 10 sci-fi novels") === "list");
check("topicFrom strips request words", topicFrom("Trinity, can you please put a blueberry muffin recipe on the workspace for me?") === "blueberry muffin recipe", JSON.stringify(topicFrom("Trinity, can you please put a blueberry muffin recipe on the workspace for me?")));
check("topicFrom keeps a question", topicFrom("who was Marie Curie?") === "who was Marie Curie", JSON.stringify(topicFrom("who was Marie Curie?")));
check("topicFrom: tell me about", topicFrom("tell me about Lisbon") === "Lisbon", JSON.stringify(topicFrom("tell me about Lisbon")));
check("wantsWeb news always", wantsWeb("news", "the news") === true);
check("wantsWeb recipe never", wantsWeb("recipe", "latest blueberry muffin recipe") === false);
check("wantsWeb person only when fresh", wantsWeb("person", "who was Marie Curie") === false && wantsWeb("person", "who is the current UN secretary general") === true);
check("early image for a recipe topic", typeof earlyImagePrompt("recipe", "blueberry muffin recipe") === "string");
check("no early image for a how-question topic", earlyImagePrompt("howto", "how do I fix a leaking tap") === null);

// ── show_card: recipe, fast designer, early picture ────────────────────────────
let r = await tool("show_card").run({}, ctx("can you give me a blueberry muffin recipe"));
check("recipe: ok with spoken summary", r.ok === true && typeof r.speak === "string" && /blueberry muffin recipe/i.test(String(r.speak)) && /card 1/.test(String(r.speak)), JSON.stringify(r).slice(0, 300));
let c = card(1);
check("recipe: widget card, tall", c?.kind === "widget" && c.status === "ready" && c.h === 74 && c.w === 42, JSON.stringify({ kind: c?.kind, status: c?.status, w: c?.w, h: c?.h }));
check("recipe: title from the designer", c.title === "Recipe · Bakery-Style Blueberry Muffins", c.title);
let html = String(c.html ?? "");
check("recipe: ingredients as a check list", /<ul class="list check">/.test(html) && /2½ cups flour/.test(html));
check("recipe: numbered steps", /<ol class="steps">/.test(html) && /425°F/.test(html));
check("recipe: meta chips", /<span class="chip"><span>Prep<\/span><b>15 min<\/b><\/span>/.test(html));
check("recipe: hostile strings escaped", !/<script>alert/.test(html) && /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(html) && !/<b>& extra<\/b>/.test(html));
check("recipe: markdown stripped from tags", /<span class="tag">bake<\/span>/.test(html));
check("recipe: accent + mood applied", /--accent:#3b82f6/.test(html) && /#fbf5ec/.test(html));
await sleep(600);
html = String(card(1).html ?? "");
check("recipe: hero picture in the card (engine image URL)", /<img src="\/api\/images\/[A-Za-z0-9_-]+\.png" alt="Blueberry muffins"/.test(html), html.slice(html.indexOf("<figure"), html.indexOf("<figure") + 160));
check("recipe: early picture used the topic, not the designer's brief", imageCalls.length === 1 && /^blueberry muffin recipe, beautifully plated/.test(imageCalls[0]!), JSON.stringify(imageCalls));
check("recipe: no web search", tavilyCalls === 0);
check("recipe: designer called once", designerCalls === 1);
check("board describes the card with tags", /card 1 \(widget, ready, (?:left|right|top|bottom|center|top left|top right|bottom left|bottom right), editable HTML[^)]*\), about: [^)]*(bakery|blueberry|muffins)/.test(describeBoard()), describeBoard());

// ── news: Jev said the type; web first; no picture; only given URLs survive ────
r = await tool("show_card").run({ type: "news" }, ctx("what's in the news today"));
check("news: ok", r.ok === true && /budget vote/i.test(String(r.speak)), JSON.stringify(r).slice(0, 300));
c = card(2);
html = String(c.html ?? "");
check("news: searched the web first", tavilyCalls === 1);
check("news: headlines with source links", /<ul class="hl">/.test(html) && /href="https:\/\/www\.reuters\.com\/world\/budget-vote"/.test(html) && /Reuters/.test(html));
check("news: invented link dropped from headline", !/invented\.example/.test(html));
check("news: sources footer with domains, no javascript link", /<footer class="src"><b>Sources<\/b><a href="https:\/\/www\.reuters\.com\/world\/budget-vote"[^>]*>reuters\.com<\/a><\/footer>/.test(html), html.slice(html.indexOf("<footer")));
check("news: no generated picture", imageCalls.length === 1 && /<header class="mast">/.test(html));
check("news: editorial palette", /#ffffff/.test(html) && /--accent:#dc2626/.test(html));

// ── person: designer's picture brief; bad accent falls back; every block kind renders ──
r = await tool("show_card").run({ type: "person" }, ctx("who was Marie Curie"));
check("person: ok", r.ok === true && /two Nobel Prizes/.test(String(r.speak)));
await sleep(600);
c = card(3);
html = String(c.html ?? "");
check("person: picture from the designer's brief", imageCalls.length === 2 && /1900s laboratory bench/.test(imageCalls[1]!), JSON.stringify(imageCalls));
check("person: accent fell back to the profile default", /--accent:#4f46e5/.test(html));
check("person: timeline, stats, quote, table, pros/cons, schedule render", ["<ol class=\"tl\">", "<div class=\"stats\">", "<blockquote class=\"quote\"", "<table>", "<div class=\"pc\">", "<ol class=\"sch\">"].every((s) => html.includes(s)));
check("person: unknown block kind dropped", !/dropped/.test(html));
check("person: hero image with alt", /<img src="\/api\/images\/[A-Za-z0-9_-]+\.png" alt="A laboratory"/.test(html));

// ── slow designer: acknowledge now, tell when written ──────────────────────────
slowOnce = true;
emitted.length = 0;
const t0 = Date.now();
r = await tool("show_card").run({ type: "recipe" }, ctx("give me a banana bread recipe"));
const waited = Date.now() - t0;
check("slow: answered within the speak wait", r.ok === true && r.inProgress === "started" && waited < 10_500 && /Card 4 is on the board/.test(String(r.say)), `${waited} ms ${JSON.stringify(r).slice(0, 200)}`);
check("slow: placeholder card up meanwhile", card(4)?.status === "pending" && /is writing the card/.test(String(card(4).html)));
await sleep(3_000);
check("slow: card written later", card(4)?.status === "ready" && /Blueberry Muffins/.test(card(4).title));
const told = emitted.find((e) => e.type === "transcript") as { turn?: { text: string; proactive?: boolean } } | undefined;
check("slow: summary told as a proactive line", Boolean(told?.turn?.proactive) && /card 4/.test(told?.turn?.text ?? ""), JSON.stringify(told));

// ── removed mid-flight: nothing comes back ─────────────────────────────────────
slowOnce = true;
const p = tool("show_card").run({ type: "recipe" }, ctx("give me a scone recipe"));
await sleep(300);
removeCard(5);
r = await p;
check("removed: tool still answers", r.ok === true && r.inProgress === "started");
await sleep(2_500);
check("removed: card stays gone", !cards().some((x) => x.n === 5), cards().map((x) => x.n).join(","));

// ── normalizer on junk ───────────────────────────────────────────────────────
check("normalizeSpec: empty → null", normalizeSpec({}, "recipe", "x") === null);
const junk = normalizeSpec(
  { type: "nope", title: 42, summary: "**Bold** _sum_", theme: { accent: "#ABCDEF", mood: "loud" }, image: { prompt: "p" }, blocks: [{ kind: "list", items: Array.from({ length: 30 }, (_, i) => `item ${i}`) }, { kind: "table", columns: ["a"], rows: [["1"]] }], sources: [{ title: "t", url: "https://ok.example/x" }] },
  "weather",
  "austin",
);
check("normalizeSpec: caps, allow-lists, no picture for weather", junk && junk.type === "weather" && junk.theme.accent === "#abcdef" && junk.theme.mood === "calm" && junk.image === null && junk.blocks.length === 1 && (junk.blocks[0] as { items: string[] }).items.length === 14 && junk.summary === "Bold sum" && junk.sources.length === 1, JSON.stringify(junk));
const rendered = renderContentCard(junk!, { imagePending: true });
check("renderContentCard: pending hero shimmer", /<div class="shim"><\/div>/.test(rendered) && /<!-- title: 42 -->/.test(rendered));

// ── keyless routing ───────────────────────────────────────────────────────────
const conv = (u: string) => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (finished speaking): ${u}`;
const route = async (u: string) => (await decide({ persona, conversation: conv(u), done: [] })).action as string;
const routes: [string, string][] = [
  ["give me a blueberry muffin recipe", "show_card"],
  ["put the blueberry muffin recipe on the workspace", "show_card"],
  ["what's in the news today", "show_card"],
  ["who was Marie Curie", "show_card"],
  ["tell me about Lisbon", "show_card"],
  ["compare the iPhone 17 and the Pixel 10", "show_card"],
  ["how do I fix a leaking tap", "show_card"],
  ["what's the weather in Austin", "show_card"],
  ["top 10 sci-fi novels", "show_card"],
  ["what is quantum computing", "show_card"],
  ["draw me a picture of blueberry muffins", "make_image"],
  ["add a note that says buy milk", "make_text"],
  ["clear the workspace", "clear_workspace"],
  ["build me a countdown timer", "build_ui"],
  ["search for the best pizza in austin", "web_search"],
  ["what's on the screen", "describe_workspace"],
  ["who is this song by", "!show_card"],
  ["tell me about yourself", "!show_card"],
  ["what is the time", "!show_card"],
];
for (const [u, want] of routes) {
  const got = await route(u);
  const ok = want.startsWith("!") ? !want.slice(1).split(",").includes(got) : got === want;
  check(`route: "${u}" → ${got}`, ok, ok ? "" : `wanted ${want}`);
}

const pngs = fs.existsSync(path.join(DATA, "images")) ? fs.readdirSync(path.join(DATA, "images")).length : 0;
console.log(`\nimages on disk: ${pngs}; cards: ${cards().map((x) => `${x.n}:${x.kind}:${x.status}`).join(" ")}`);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
workspace.clear();
process.exit(fails ? 1 : 0);
