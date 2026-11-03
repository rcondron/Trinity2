/*
 * The card-skill library — what a user might say about the cards on Trinity's workspace board, as a test.
 *
 * Each phrase goes through the real router (Jev with a TypeSafe key, the keyword fallback without one) on a fresh
 * eight-card board, then the tool it picked runs on that board, with a simulated workspace window answering card
 * commands (the real in-card runtime is exercised in a browser; this checks routing, which cards are meant, what was
 * done, and what Trinity would say). Models are the real ones from .env: read_card and edit_note ask the brain
 * model, figure_out asks the problem solver, so a full run makes a few dozen model calls. It never touches the
 * engine's data: everything happens in a temporary folder.
 *
 *   npm run eval:cards                               everything
 *   npm run eval:cards -- --only control,read        some skills (remove resize arrange move control read note
 *                                                    rename copy board compound not-cards)
 *   npm run eval:cards -- --route-only               routing only, no tool runs
 *   npm run eval:cards -- --verbose                  every reply, not just the misses
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATA = mkdtempSync(path.join(tmpdir(), "trinity-eval-cards-"));
process.env.TRINITY_DATA_DIR = DATA;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = (p: string) => import(pathToFileURL(path.join(ROOT, "server/src", p)).href);

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 ? new Set(String(argv[i + 1] ?? "").split(",").filter(Boolean)) : null;
})();
const routeOnly = argv.includes("--route-only");
const verbose = argv.includes("--verbose");

const board = await load("workspace/board.ts");
const { workspace } = await load("workspace/bus.ts");
const { decide, confidentOptions } = await load("agent/router.ts");
const { getEndpoints, live } = await load("settings.ts");
const { describeScreen } = await load("tools/screen.ts");
const { createMemoryStore } = await load("db/memory.ts");
for (const [file, fn] of [
  ["tools/builtins.ts", "registerBuiltins"],
  ["tools/coding.ts", "registerCodingTools"],
  ["tools/ask.ts", "registerAskTools"],
  ["tools/memory.ts", "registerMemoryTools"],
  ["tools/schedule.ts", "registerScheduleTools"],
  ["tools/forge.ts", "registerForgeTools"],
] as const)
  (await load(file))[fn]();
const memory = await createMemoryStore();

type Card = {
  n: number;
  kind: string;
  status: string;
  x: number;
  y: number;
  w: number;
  h?: number;
  z: number;
  title: string;
  text: string;
  tags?: string[];
  url: string | null;
  html?: string | null;
  prev?: unknown;
};
type ToolResult = { ok: boolean; say?: string; speak?: string; data?: Record<string, unknown> };
type Tool = { name: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult> };

// ─── The board every phrase starts from ──────────────────────────────────────

const TIMER_HTML = `<!-- title: Pomodoro timer -->
<style>.t{display:grid;gap:10px;padding:16px;text-align:center}.time{font-size:40px;font-weight:700}</style>
<div class="t"><div class="time" id="time">25:00</div>
<label>Minutes <input id="mins" type="number" value="25" min="1" max="90"></label>
<div><button id="start">Start</button> <button id="pause">Pause</button> <button id="reset">Reset</button></div></div>`;
const RECIPE_HTML = `<!-- title: Blueberry muffins -->
<article><h1>Blueberry muffins</h1><p>Soft, bakery-style muffins in about 35 minutes.</p>
<h2>Ingredients</h2><ul><li>2 cups flour</li><li>1 cup blueberries</li><li>2 eggs</li><li>1/2 cup sugar</li><li>1/2 cup milk</li></ul>
<h2>Steps</h2><ol><li>Heat the oven to 375°F.</li><li>Mix the batter and fold in the berries.</li><li>Bake for 20 minutes.</li></ol></article>`;

function seed(): Card[] {
  const g = board.gridFor(8) as { cols: number; w: number; h: number; x0: number; y0: number; gap: number };
  const base = [
    { n: 1, kind: "image", title: "A tiger", text: "a tiger in the snow", url: "/api/images/tiger0000001.png" },
    { n: 2, kind: "image", title: "A panda", text: "a panda eating bamboo", url: "/api/images/panda0000001.png" },
    { n: 3, kind: "text", title: "Note: Shopping list: milk, bread, coffee", text: "Shopping list: milk, bread, coffee", url: null },
    { n: 4, kind: "widget", title: "Pomodoro timer", text: "build me a pomodoro timer", url: null, html: TIMER_HTML },
    { n: 5, kind: "video", title: "Ocean waves", text: "ocean waves at sunset", url: "/api/videos/ocean000001.mp4" },
    { n: 6, kind: "audio", title: "Rain sounds", text: "gentle rain sounds", url: "/api/audio/rain0000001.wav" },
    { n: 7, kind: "widget", title: "Recipe: Blueberry muffins", text: "show me a recipe for blueberry muffins", url: null, html: RECIPE_HTML },
    { n: 8, kind: "text", title: "Note: To do: call mom, pay rent", text: "To do:\n- call mom\n- pay rent", url: null },
  ];
  return base.map((c, i) => ({
    ...c,
    status: "ready",
    tags: board.tagsFromText(c.title, c.text),
    x: Math.round((g.x0 + (i % g.cols) * (g.w + g.gap)) * 10) / 10,
    y: Math.round((g.y0 + Math.floor(i / g.cols) * (g.h + g.gap)) * 10) / 10,
    w: g.w,
    h: g.h,
    z: i + 1,
  }));
}

const ALL = [1, 2, 3, 4, 5, 6, 7, 8];
const cards = (): Card[] => board.listCards();
const card = (n: number): Card | undefined => cards().find((c) => c.n === n);

function reset(touch: number[]) {
  while (workspace.canUndo()) workspace.undo();
  workspace.showApp(board.BOARD_TEMPLATE, { cards: seed() }, "Workspace", board.BOARD_OWNER);
  board.touchCards(touch);
  sent.length = 0;
}

// ─── A simulated workspace window: answers card commands the way the board would ──

const sent: { n: number; op: string; arg: unknown }[] = [];
const MEDIA_OPS = new Set(["play", "pause", "restart", "reset", "mute", "unmute", "louder", "quieter", "forward", "back", "loop", "no_loop", "faster", "slower", "normal_speed"]);
const SYN: Record<string, string[]> = {
  play: ["start", "play", "resume", "go"],
  pause: ["pause", "stop"],
  reset: ["reset", "clear"],
  restart: ["restart", "replay"],
  next: ["next"],
  previous: ["previous", "back", "prev"],
  mute: ["mute"],
  unmute: ["unmute"],
};
const textOf = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->|<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<\/(?:p|li|h\d|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();

function simulate(c: Card | undefined, op: string, arg: unknown): Record<string, unknown> {
  if (!c) return { ok: false, reason: "missing" };
  const media = (c.kind === "video" || c.kind === "audio") && !c.html;
  if (op === "read") return { ok: true, via: "read", text: media ? `${c.kind} playing at 0:05 of 0:30` : c.html ? textOf(c.html) : c.text };
  if (media) {
    if (!MEDIA_OPS.has(op)) return { ok: false, reason: "no-control", controls: ["play", "pause", "mute"] };
    return {
      ok: true,
      via: "media",
      media: { paused: op === "pause" || op === "reset", t: 5, dur: 30, muted: op === "mute", volume: op === "louder" ? 0.8 : op === "quieter" ? 0.4 : 0.6, rate: op === "faster" ? 1.25 : op === "slower" ? 0.75 : 1, loop: op === "loop" },
    };
  }
  if (!c.html) return { ok: false, reason: "no-media" };
  const labels = [...c.html.matchAll(/<button[^>]*>([^<]{1,40})<\/button>/g)].map((m) => m[1]!.trim().toLowerCase());
  if (op === "controls") return { ok: true, controls: labels };
  if (op === "set") return /<input/.test(c.html) ? { ok: true, via: "input", label: "minutes", detail: String((arg as { value?: string })?.value ?? arg) } : { ok: false, reason: "no-field", controls: labels };
  if (op.startsWith("scroll")) return { ok: true, via: "scroll" };
  if (op === "press") {
    const want = String(arg ?? "").toLowerCase();
    const hit = labels.find((l) => l === want || l.includes(want) || want.includes(l));
    return hit ? { ok: true, via: "click", label: hit } : { ok: false, reason: "no-control", controls: labels };
  }
  const hit = labels.find((l) => (SYN[op] ?? []).includes(l));
  if (hit) return { ok: true, via: "click", label: hit };
  if (op === "restart" && labels.includes("reset")) return { ok: true, via: "click", label: "reset + start" };
  if (op === "play" && labels.includes("pause") && !labels.includes("start")) return { ok: true, already: "running", label: "pause" };
  return { ok: false, reason: "no-control", controls: labels };
}

workspace.subscribe((e: { type: string; cmd?: { id: string; n: number; op: string; arg: unknown } }) => {
  if (e.type !== "command" || !e.cmd) return;
  const { id, n, op, arg } = e.cmd;
  sent.push({ n, op, arg });
  const answer = simulate(card(n), op, arg);
  setTimeout(() => workspace.handleClient({ type: "board", evt: { op: "cmd_result", id, n, ...answer } }), 5);
});

// ─── The library ─────────────────────────────────────────────────────────────

interface Run {
  result: ToolResult | null;
  board: Card[];
  sent: { n: number; op: string; arg: unknown }[];
  targets: number[] | null;
}
interface Case {
  cat: string;
  say: string;
  /** The tool it should route to ("NONE" for nothing); several are all fine. */
  tool: string | string[];
  /** The cards the tool should act on. */
  cards?: number[];
  /** control_card: the operation. */
  op?: string;
  /** Anything else to check after the run: null when fine, else what's wrong. */
  check?: (r: Run) => string | null;
  /** Board changes before the phrase (a removal to undo, cards to restore). */
  setup?: () => void;
  /** What was just made or used ("it", "them"): the video by default. */
  touch?: number[];
  /** Routing only: tools that make new things (pictures, builds) aren't run here. */
  run?: false;
}

const said = (re: RegExp, what: string) => (r: Run) => (re.test(r.result?.say ?? "") ? null : `should say ${what}`);
const isMin = (c?: Card) => Boolean(c && board.isMinimized(c));
const isMax = (c?: Card) => Boolean(c && board.isMaximized(c));
const textNow = (n: number) => card(n)?.text ?? "";

const CASES: Case[] = [
  // ── remove: one, several, by kind, by content, all but some, recency, place, pronouns ──
  { cat: "remove", say: "close card 2", tool: "remove_card", cards: [2] },
  { cat: "remove", say: "close cards 2 and 3", tool: "remove_card", cards: [2, 3] },
  { cat: "remove", say: "remove cards 1 through 3", tool: "remove_card", cards: [1, 2, 3] },
  { cat: "remove", say: "Alright, close 2, 3 and 5.", tool: "remove_card", cards: [2, 3, 5] },
  { cat: "remove", say: "Can you close cards 4 and 6?", tool: "remove_card", cards: [4, 6] },
  { cat: "remove", say: "delete all the pictures", tool: "remove_card", cards: [1, 2] },
  { cat: "remove", say: "close the tiger and the panda", tool: "remove_card", cards: [1, 2] },
  { cat: "remove", say: "get rid of everything except the timer", tool: "remove_card", cards: [1, 2, 3, 5, 6, 7, 8] },
  { cat: "remove", say: "keep the timer and close the rest", tool: "remove_card", cards: [1, 2, 3, 5, 6, 7, 8] },
  { cat: "remove", say: "close all the notes", tool: "remove_card", cards: [3, 8] },
  { cat: "remove", say: "remove the last two cards", tool: "remove_card", cards: [7, 8] },
  { cat: "remove", say: "close the oldest card", tool: "remove_card", cards: [1] },
  { cat: "remove", say: "close the video", tool: "remove_card", cards: [5] },
  { cat: "remove", say: "close the card in the top right", tool: "remove_card", cards: [3] },
  { cat: "remove", say: "trash the recipe card", tool: "remove_card", cards: [7] },
  { cat: "remove", say: "take the recipe off the board", tool: "remove_card", cards: [7] },
  { cat: "remove", say: "remove it", tool: "remove_card", cards: [5] },
  { cat: "remove", say: "close card 9", tool: "remove_card", check: (r) => (r.result && !r.result.ok && /card 9/.test(r.result.say ?? "") ? null : "should say there's no card 9") },
  { cat: "remove", say: "clear the workspace", tool: "clear_workspace" },
  { cat: "remove", say: "close everything", tool: ["clear_workspace", "remove_card"] },

  // ── resize: one card or many; maximize, minimize, restore, steps ──
  { cat: "resize", say: "minimize all the cards", tool: "resize_card", cards: ALL, check: (r) => (r.board.every(isMin) ? null : "not every card is minimized") },
  { cat: "resize", say: "Alright, minimize everything.", tool: "resize_card", cards: ALL },
  { cat: "resize", say: "minimize everything except the timer", tool: "resize_card", cards: [1, 2, 3, 5, 6, 7, 8], check: (r) => (!isMin(card(4)) ? null : "the timer was minimized too") },
  { cat: "resize", say: "maximize the video", tool: "resize_card", cards: [5], check: (r) => (isMax(card(5)) ? null : "the video isn't full screen") },
  { cat: "resize", say: "full screen card 7", tool: "resize_card", cards: [7] },
  { cat: "resize", say: "make all the pictures smaller", tool: "resize_card", cards: [1, 2] },
  { cat: "resize", say: "make the timer a little bigger", tool: "resize_card", cards: [4] },
  { cat: "resize", say: "Could you make the panda a little bigger?", tool: "resize_card", cards: [2] },
  { cat: "resize", say: "make card 3 twice as big", tool: "resize_card", cards: [3] },
  { cat: "resize", say: "make it wider", tool: "resize_card", cards: [5] },
  { cat: "resize", say: "shrink everything", tool: "resize_card", cards: ALL },
  { cat: "resize", say: "maximize all the cards", tool: "resize_card", check: said(/Spread all/, "it spread the cards over the board") },
  {
    cat: "resize",
    say: "restore everything",
    tool: ["resize_card", "undo_workspace"],
    setup: () => board.resizeCards(ALL, "minimize"),
    check: (r) => (r.board.some(isMin) ? "cards are still minimized" : null),
  },
  {
    cat: "resize",
    say: "bring back the minimized cards",
    tool: ["resize_card", "undo_workspace"],
    setup: () => board.resizeCards([1, 2], "minimize"),
    check: (r) => (r.board.some(isMin) ? "cards are still minimized" : null),
  },
  { cat: "resize", say: "restore card 4", tool: ["resize_card", "undo_workspace"], setup: () => board.resizeCards([4], "maximize"), check: () => (isMax(card(4)) ? "card 4 is still full screen" : null) },
  { cat: "resize", say: "hide the video", tool: ["resize_card", "remove_card"] },

  // ── arrange: the whole board at once ──
  { cat: "arrange", say: "shuffle the cards", tool: "arrange_cards", check: said(/Shuffled/, "it shuffled them") },
  { cat: "arrange", say: "scatter the cards around", tool: "arrange_cards", check: said(/Scattered/, "it scattered them") },
  { cat: "arrange", say: "group the cards by type", tool: "arrange_cards", check: said(/Grouped/, "it grouped them by kind") },
  { cat: "arrange", say: "put the newest cards first", tool: "arrange_cards", check: said(/newest first/, "newest first") },
  { cat: "arrange", say: "organize the board", tool: "arrange_cards", check: said(/Arranged/, "it arranged them") },
  { cat: "arrange", say: "tidy up", tool: "arrange_cards" },
  { cat: "arrange", say: "stack them all up", tool: "arrange_cards", check: said(/Stacked/, "it stacked them") },
  { cat: "arrange", say: "spread the cards out", tool: "arrange_cards" },
  { cat: "arrange", say: "line the cards up in a row", tool: "arrange_cards" },

  // ── move: places, steps, layering, swaps, a group to one side ──
  {
    cat: "move",
    say: "swap card 1 and card 2",
    tool: "move_card",
    cards: [1, 2],
    check: () => (card(1)!.x > card(2)!.x ? null : "cards 1 and 2 didn't trade places"),
  },
  { cat: "move", say: "switch the tiger and the panda", tool: "move_card", cards: [1, 2] },
  { cat: "move", say: "move the timer a bit to the left", tool: "move_card", cards: [4], check: () => (card(4)!.x < 2.1 && card(4)!.x >= 0 ? null : `the timer is at x ${card(4)!.x}`) },
  { cat: "move", say: "move it up", tool: "move_card", cards: [5], check: () => (card(5)!.y < 34.7 ? null : "the video didn't move up") },
  { cat: "move", say: "nudge card 3 down a little", tool: "move_card", cards: [3], check: () => (card(3)!.y > 2 ? null : "card 3 didn't move down") },
  { cat: "move", say: "put the tiger behind the panda", tool: "move_card", cards: [1], check: () => (card(1)!.z < card(2)!.z ? null : "the tiger isn't behind the panda") },
  { cat: "move", say: "bring card 2 forward", tool: "move_card", cards: [2] },
  { cat: "move", say: "bring the timer to the front", tool: "move_card", cards: [4], check: () => (card(4)!.z === Math.max(...cards().map((c) => c.z)) ? null : "the timer isn't in front") },
  { cat: "move", say: "move the pictures to the left side", tool: "move_card", cards: [1, 2], check: () => (card(1)!.x === 2 && card(2)!.x === 2 ? null : "the pictures aren't along the left") },
  { cat: "move", say: "put all the notes on the right", tool: "move_card", cards: [3, 8] },
  { cat: "move", say: "move card 5 to the top right", tool: "move_card", cards: [5] },
  { cat: "move", say: "move the tiger under the panda", tool: "move_card", cards: [1] },

  // ── control: timers, videos, audio, buttons, values, scrolling, several at once ──
  { cat: "control", say: "start the timer", tool: "control_card", cards: [4], op: "play" },
  { cat: "control", say: "Please pause the timer.", tool: "control_card", cards: [4], op: "pause" },
  { cat: "control", say: "stop the timer", tool: "control_card", cards: [4], op: "pause" },
  { cat: "control", say: "restart the timer", tool: "control_card", cards: [4], op: "restart" },
  { cat: "control", say: "reset the timer", tool: "control_card", cards: [4], op: "reset" },
  { cat: "control", say: "play the video", tool: "control_card", cards: [5], op: "play" },
  { cat: "control", say: "pause the video", tool: "control_card", cards: [5], op: "pause" },
  { cat: "control", say: "start the video over", tool: "control_card", cards: [5], op: "restart" },
  { cat: "control", say: "resume the video", tool: "control_card", cards: [5], op: "play" },
  { cat: "control", say: "mute the video", tool: "control_card", cards: [5], op: "mute" },
  { cat: "control", say: "unmute the video", tool: "control_card", cards: [5], op: "unmute" },
  { cat: "control", say: "make the video louder", tool: "control_card", cards: [5], op: "louder" },
  { cat: "control", say: "turn the volume down on the rain", tool: "control_card", cards: [6], op: "quieter" },
  { cat: "control", say: "skip ahead 30 seconds", tool: "control_card", cards: [5], op: "forward", check: () => (sent.some((s) => s.op === "forward" && s.arg === 30) ? null : "it didn't skip 30 seconds") },
  { cat: "control", say: "rewind ten seconds", tool: "control_card", cards: [5], op: "back" },
  { cat: "control", say: "loop the video", tool: "control_card", cards: [5], op: "loop" },
  { cat: "control", say: "stop looping the video", tool: "control_card", cards: [5], op: "no_loop" },
  { cat: "control", say: "play it faster", tool: "control_card", cards: [5], op: "faster" },
  { cat: "control", say: "play the rain sounds", tool: "control_card", cards: [6], op: "play" },
  { cat: "control", say: "turn the rain sounds off", tool: "control_card", cards: [6], op: "pause" },
  { cat: "control", say: "pause everything", tool: "control_card", op: "pause", check: (r) => (r.targets && [4, 5, 6].every((n) => r.targets!.includes(n)) ? null : "not everything was paused") },
  { cat: "control", say: "mute everything", tool: "control_card", op: "mute", check: (r) => (r.targets && [5, 6].every((n) => r.targets!.includes(n)) ? null : "the video and audio weren't both muted") },
  { cat: "control", say: "press reset on the timer", tool: "control_card", cards: [4], op: "reset" },
  { cat: "control", say: "hit start on card 4", tool: "control_card", cards: [4], op: "play" },
  { cat: "control", say: "click the lap button on the timer", tool: "control_card", cards: [4], op: "press", check: said(/no control|Start|Pause|Reset/, "that the timer has no lap control") },
  { cat: "control", say: "set the timer to 10 minutes", tool: "control_card", cards: [4], op: "set", check: () => (sent.some((s) => s.op === "set" && /10 minutes/.test(JSON.stringify(s.arg))) ? null : "it didn't set 10 minutes") },
  { cat: "control", say: "scroll down on the recipe", tool: "control_card", cards: [7], op: "scroll_down" },

  // ── read: what a card says or shows right now ──
  { cat: "read", say: "read me the shopping list", tool: "read_card", cards: [3], check: said(/milk/i, "the list's items") },
  { cat: "read", say: "what does card 3 say", tool: "read_card", cards: [3] },
  { cat: "read", say: "Okay, read me card 8.", tool: "read_card", cards: [8], check: said(/mom|rent/i, "the to-do items") },
  { cat: "read", say: "what does the to-do list say", tool: "read_card", cards: [8] },
  { cat: "read", say: "how much time is left on the timer", tool: "read_card", cards: [4], check: said(/25|twenty[- ]five/i, "twenty-five minutes") },
  { cat: "read", say: "what are the ingredients on the recipe card", tool: "read_card", cards: [7], check: said(/flour|blueberr/i, "the ingredients") },
  { cat: "read", say: "what does the recipe say about baking time", tool: "read_card", cards: [7], check: said(/20|twenty/i, "twenty minutes") },
  { cat: "read", say: "what's on card 7", tool: "read_card", cards: [7] },
  { cat: "read", say: "what's in the tiger picture", tool: "read_card", cards: [1], check: said(/snow|tiger/i, "a tiger in the snow") },
  { cat: "read", say: "is the video playing", tool: "read_card", cards: [5], check: said(/playing|yes/i, "that it's playing") },
  { cat: "read", say: "read card 9", tool: "read_card", check: said(/card 9/, "that there's no card 9") },

  // ── notes: change the words ──
  { cat: "note", say: "add eggs to the shopping list", tool: "edit_note", cards: [3], check: () => (/eggs/.test(textNow(3)) ? null : "no eggs on the list") },
  { cat: "note", say: "add butter and jam to the list", tool: "edit_note", cards: [3], check: () => (/butter/.test(textNow(3)) && /jam/.test(textNow(3)) ? null : "butter and jam aren't on the list") },
  { cat: "note", say: "put call the dentist on my to-do list", tool: "edit_note", cards: [8], check: () => (/call the dentist/i.test(textNow(8)) ? null : "the dentist isn't on the to-do list") },
  { cat: "note", say: "cross off milk", tool: "edit_note", cards: [3], check: () => (/✓\s*milk/i.test(textNow(3)) || !/milk/i.test(textNow(3)) ? null : "milk isn't crossed off") },
  { cat: "note", say: "remove bread from the shopping list", tool: "edit_note", cards: [3], check: () => (!/bread/i.test(textNow(3)) ? null : "bread is still there") },
  { cat: "note", say: "change the shopping list to say apples and pears", tool: "edit_note", cards: [3], check: () => (/apples and pears/i.test(textNow(3)) ? null : "it doesn't say apples and pears") },
  { cat: "note", say: "clear the to-do list", tool: "edit_note", cards: [8], check: () => (textNow(8).trim() === "" ? null : "the to-do list isn't empty") },

  // ── rename, copy ──
  { cat: "rename", say: "rename card 3 to Groceries", tool: "rename_card", cards: [3], check: () => (card(3)!.title === "Groceries" ? null : `title is ${card(3)!.title}`) },
  { cat: "rename", say: "call the timer Tea timer", tool: "rename_card", cards: [4], check: () => (card(4)!.title === "Tea timer" ? null : `title is ${card(4)!.title}`) },
  { cat: "rename", say: "change the title of card 7 to Muffins", tool: "rename_card", cards: [7] },
  { cat: "copy", say: "duplicate the timer", tool: "duplicate_card", cards: [4], check: () => (cards().length === 9 && card(9)?.html ? null : "no copy of the timer") },
  { cat: "copy", say: "make a copy of card 3", tool: "duplicate_card", cards: [3] },
  { cat: "copy", say: "copy the tiger picture", tool: "duplicate_card", cards: [1] },

  // ── the board as a whole ──
  { cat: "board", say: "what's on the board", tool: "describe_workspace" },
  { cat: "board", say: "how many cards are there", tool: "describe_workspace" },
  { cat: "board", say: "undo that", tool: "undo_workspace", setup: () => board.removeCards([2]), check: () => (cards().length === 8 ? null : "card 2 didn't come back") },
  { cat: "board", say: "put the cards back", tool: "undo_workspace", setup: () => board.removeCards([1, 2]), check: () => (cards().length === 8 ? null : "the cards didn't come back") },

  // ── several actions at once: the problem solver chains the tools ──
  {
    cat: "compound",
    say: "close the pictures and start the timer",
    tool: "figure_out",
    check: () => (!card(1) && !card(2) && sent.some((s) => s.n === 4 && s.op === "play") ? null : "the pictures aren't gone or the timer didn't start"),
  },
  {
    cat: "compound",
    say: "minimize everything except the video and play it",
    tool: "figure_out",
    check: () => (!isMin(card(5)) && [1, 2, 3, 4, 6, 7, 8].every((n) => isMin(card(n))) && sent.some((s) => s.n === 5 && s.op === "play") ? null : "not everything else is minimized, or the video didn't play"),
  },
  {
    cat: "compound",
    say: "mute the video and make it full screen",
    tool: "figure_out",
    check: () => (sent.some((s) => s.n === 5 && s.op === "mute") && isMax(card(5)) ? null : "the video isn't muted and full screen"),
  },

  // ── not about the cards: these must not become card operations ──
  { cat: "not-cards", say: "start a timer for five minutes", tool: "build_ui", run: false },
  { cat: "not-cards", say: "make a video of a dancing cat", tool: "make_video", run: false },
  { cat: "not-cards", say: "add a note that says hello", tool: "make_text", run: false },
  { cat: "not-cards", say: "show me a recipe for pancakes", tool: "show_card", run: false },
  { cat: "not-cards", say: "draw me a picture of a fox", tool: "make_image", run: false },
  { cat: "not-cards", say: "that's funny", tool: "NONE", run: false },
  { cat: "not-cards", say: "what's the capital of France", tool: ["ask_brain", "web_search", "NONE", "show_card"], run: false },
];

// ─── Running it ──────────────────────────────────────────────────────────────

const persona = { id: "trinity", name: "Trinity", description: "You are Trinity.", voicePrompt: "", voice: "NATF2", traits: { role: "general companion & agent" }, toolsets: [], updatedAt: 0 };
const conv = (u: string) => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (finished speaking): ${u}`;
const sorted = (xs: number[]) => xs.slice().sort((a, b) => a - b);
const same = (a: number[], b: number[]) => a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i]);

function targetsOf(data: Record<string, unknown> | undefined): number[] | null {
  if (!data) return null;
  if (Array.isArray(data.cards)) return sorted(data.cards as number[]);
  if (typeof data.card === "number") return [data.card];
  if (Array.isArray(data.swapped)) return sorted(data.swapped as number[]);
  if (Array.isArray(data.copies)) return sorted((data.copies as { from: number }[]).map((c) => c.from));
  return null;
}

const min = getEndpoints().minConfidence as number;
console.log(`card-skill library — ${live.jev ? "Jev" : "keyword fallback (no TypeSafe key)"} routing, ${live.mordiem ? "real models" : "no Mordiem key: model steps skipped"}, ${routeOnly ? "routing only" : "tools run on a simulated window"}\n`);

const tally = new Map<string, { n: number; routed: number; done: number }>();
let failures = 0;
for (const c of CASES) {
  if (only && !only.has(c.cat)) continue;
  reset(c.touch ?? [5]);
  c.setup?.();
  const t0 = Date.now();
  const d = await decide({ persona, conversation: conv(c.say), done: [] });
  const want = Array.isArray(c.tool) ? c.tool : [c.tool];
  const routed = want.includes(d.action);
  const problems: string[] = [];
  if (!routed) problems.push(`routed to ${d.action}, wanted ${want.join(" or ")}`);
  let run: Run | null = null;
  if (routed && !routeOnly && c.run !== false && d.tool) {
    const tool = d.tool as Tool;
    let result: ToolResult | null = null;
    try {
      // --verbose shows each step a tool takes for you (the problem solver's tool calls and their answers).
      const emit = (ev: { type?: string; tool?: string; args?: unknown; result?: unknown }) => {
        if (verbose && (ev.type === "tool" || ev.type === "tool_result")) console.log(`       ${ev.type === "tool" ? "→" : "←"} ${ev.tool} ${JSON.stringify(ev.type === "tool" ? ev.args : ev.result).slice(0, 160)}`);
      };
      result = await tool.run(confidentOptions(d, min), { persona, recentTranscript: [], emit, utterance: c.say, memory, situation: describeScreen(persona) ?? "" });
    } catch (err) {
      problems.push(`threw: ${(err as Error).message}`);
    }
    run = { result, board: cards(), sent: sent.slice(), targets: targetsOf(result?.data) };
    // Work that went on in the background (the problem solver past its wait): give it up to a minute to land.
    if ((result as { inProgress?: string } | null)?.inProgress && c.check) {
      for (let i = 0; i < 120 && c.check({ ...run, board: cards(), sent: sent.slice() }); i++) await new Promise((r) => setTimeout(r, 500));
      run = { ...run, board: cards(), sent: sent.slice() };
    }
    if (c.cards && !(run.targets && same(run.targets, c.cards))) problems.push(`acted on ${run.targets ? `[${run.targets.join(",")}]` : "nothing"}, wanted [${c.cards.join(",")}]`);
    if (c.op && result?.data?.op !== c.op) problems.push(`did ${String(result?.data?.op ?? "nothing")}, wanted ${c.op}`);
    const extra = c.check?.(run);
    if (extra) problems.push(extra);
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  const row = tally.get(c.cat) ?? { n: 0, routed: 0, done: 0 };
  row.n++;
  if (routed) row.routed++;
  if (ok) row.done++;
  tally.set(c.cat, row);
  const conf = `${Math.round(d.confidence * 100)}%`.padStart(4);
  console.log(`${ok ? "ok  " : "FAIL"} ${c.cat.padEnd(9)} ${JSON.stringify(c.say).padEnd(58)} → ${String(d.action).padEnd(17)} ${conf} ${String(Date.now() - t0).padStart(5)}ms${ok ? "" : `   ✗ ${problems.join("; ")}`}`);
  if ((verbose || !ok) && run?.result) console.log(`       says: ${(run.result.speak ?? run.result.say ?? "").slice(0, 220)}`);
}

console.log("\nskill       routed   done");
let n = 0;
let r = 0;
let k = 0;
for (const [cat, row] of tally) {
  console.log(`${cat.padEnd(10)} ${`${row.routed}/${row.n}`.padStart(7)} ${`${row.done}/${row.n}`.padStart(7)}`);
  n += row.n;
  r += row.routed;
  k += row.done;
}
console.log(`${"total".padEnd(10)} ${`${r}/${n}`.padStart(7)} ${`${k}/${n}`.padStart(7)}`);
try {
  rmSync(DATA, { recursive: true, force: true });
} catch {
  /* PouchDB may still hold it open; the OS cleans temp folders */
}
process.exit(failures ? 1 : 0);
