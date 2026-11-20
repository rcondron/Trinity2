// Sizing and layering on a scratch board: maximize / minimize / restore with the saved layout, scaling steps,
// layering in front of / behind / forward / backward, stack / row / column layouts, the tools' spoken lines, and
// keyless routing of the phrasings (including what stays with edit_html and undo).
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through the runner (npm test -- --only <name>): it gives each suite a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const { registerBuiltins } = await imp("tools/builtins.ts");
const { getTools } = await imp("tools/registry.ts");
const { decide } = await imp("agent/router.ts");
const board = await imp("workspace/board.ts");
const { workspace } = await imp("workspace/bus.js".replace(".js", ".ts"));
registerBuiltins();

type Card = { n: number; kind: string; x: number; y: number; w: number; h?: number; z: number; prev?: unknown };
type Run = (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; say: string; data?: Record<string, unknown> }>;
const tool = (n: string) => (getTools() as { name: string; run: Run }[]).find((t) => t.name === n)!;
const persona = { id: "trinity", name: "Trinity", description: "You are Trinity.", voicePrompt: "", voice: "NATF2", traits: { role: "general companion & agent" }, toolsets: [], updatedAt: 0 };
const ctx = (utterance: string) => ({ utterance, persona, conversation: "", done: [] });
const card = (n: number) => (board.listCards() as Card[]).find((c) => c.n === n)!;
const near = (a: number, b: number, eps = 0.11) => Math.abs(a - b) < eps;

// ── four cards: a tiger picture, a note, a timer widget, a panda picture ──
board.addCard({ kind: "image", title: "A tiger", text: "a tiger in the snow", status: "ready", url: null, x: 10, y: 10 });
board.addCard({ kind: "text", title: "Note", text: "shopping list", status: "ready", url: null, x: 50, y: 10 });
board.addCard({ kind: "widget", title: "Pomodoro timer", text: "a pomodoro timer", status: "ready", url: null, html: "<div>timer</div>", x: 10, y: 50, h: 40 });
board.addCard({ kind: "image", title: "A panda", text: "a panda eating bamboo", status: "ready", url: null, x: 50, y: 50 });
check("setup: four cards, z by number", (board.listCards() as Card[]).map((c) => c.z).join() === "1,2,3,4");

// ── maximize / restore ──
const before2 = { ...card(2) };
let c = board.resizeCard(2, "maximize") as Card;
check("maximize: fills the board and comes to the front, layout kept", c.x === 1 && c.y === 1 && c.w === 98 && c.h === 97 && c.z === 5 && !!c.prev && board.isMaximized(c), JSON.stringify([c.x, c.y, c.w, c.h, c.z]));
c = board.resizeCard(2, "restore") as Card;
check("restore: back where it was, in front, nothing kept", c.x === before2.x && c.y === before2.y && c.w === before2.w && c.h === undefined && c.z === 6 && !c.prev, JSON.stringify([c.x, c.y, c.w, c.h, c.z, c.prev]));
c = board.resizeCard(2, "restore") as Card;
check("restore with nothing kept: the usual size for its kind", c.w === 28 && c.h === undefined);

// ── minimize: docked tiles, each in the next slot ──
c = board.resizeCard(3, "minimize") as Card;
const c4 = board.resizeCard(4, "minimize") as Card;
check("minimize: small tiles on the bottom row, side by side", c.w === 16 && c.h === 16 && c.y === 82 && c.x === 2 && c4.x === 20 && board.isMinimized(c) && board.isMinimized(c4), JSON.stringify([c.x, c4.x, c.y, c.w, c.h]));
c = board.resizeCard(3, "restore") as Card;
check("restore a minimized card: its old box and height", c.x === 10 && c.y === 50 && c.h === 40 && !board.isMinimized(c), JSON.stringify([c.x, c.y, c.w, c.h]));
board.resizeCard(4, "restore");

// ── scaling steps ──
const w1 = card(1).w;
c = board.resizeCard(1, "bigger") as Card;
check("bigger: the usual step, height follows when set", near(c.w, Math.round(w1 * 1.35 * 10) / 10) && c.h === undefined, `${w1} → ${c.w}`);
c = board.resizeCard(1, "smaller", "bit") as Card;
check("a little smaller", near(c.w, Math.round(w1 * 1.35 * 0.87 * 10) / 10), String(c.w));
c = board.resizeCard(1, "bigger", "lot") as Card;
check("a lot bigger stays on the board", c.w <= 98 && c.x + c.w <= 100.01, JSON.stringify([c.x, c.w]));
c = board.resizeCard(3, "taller") as Card;
check("taller: height scales", near(c.h!, 52), String(c.h));
c = board.resizeCard(3, "narrower") as Card;
check("narrower: width only", near(c.w, Math.round(38 * 0.77 * 10) / 10) && near(c.h!, 52), JSON.stringify([c.w, c.h]));
board.resizeCard(1, "restore");

// ── layering ──
board.arrangeCards("grid");
let moved = board.layerCard(1, "in-front-of", 3) as Card;
check("in front of: just above the anchor, overlapping it", moved.z === card(3).z + 1 && near(moved.x, card(3).x + 3) && near(moved.y, card(3).y + 3), JSON.stringify([moved.z, card(3).z, moved.x, card(3).x]));
moved = board.layerCard(4, "behind", 2) as Card;
check("behind: just below the anchor, peeking out", moved.z + 1 === card(2).z && near(moved.x, card(2).x - 3), JSON.stringify([moved.z, card(2).z]));
check("the stack is renumbered one to four", (board.listCards() as Card[]).map((x) => x.z).sort().join() === "1,2,3,4");
const bottom = (board.listCards() as Card[]).reduce((m, x) => (x.z < m.z ? x : m));
moved = board.layerCard(bottom.n, "forward") as Card;
check("forward: one step up", moved.z === 2, String(moved.z));
moved = board.layerCard(bottom.n, "backward") as Card;
check("backward: one step down, never below one", moved.z === 1, String(moved.z));

// ── layouts ──
let r = board.arrangeCards("stack") as { layout: string };
const stacked = board.listCards() as Card[];
check("stack: a cascade in number order, front to back", r.layout === "stack" && stacked.every((x, i) => x.x === 4 + i * 3 && x.y === 4 + i * 3 && x.w === 48 && x.h === 64 && x.z === i + 1), JSON.stringify(stacked.map((x) => [x.n, x.x, x.y, x.z])));
r = board.arrangeCards("row") as { layout: string; cols: number };
const row = board.listCards() as Card[];
check("row: four across, one high", r.layout === "row" && r.cols === 4 && row.every((x) => x.y === 20 && x.w === 22.5 && x.h === 60), JSON.stringify(row.map((x) => [x.x, x.y, x.w, x.h])));
r = board.arrangeCards("column") as { layout: string; rows: number };
const col = board.listCards() as Card[];
check("column: one wide, four down", r.layout === "column" && r.rows === 4 && col.every((x) => x.x === 28 && x.w === 44 && x.h === 22.5), JSON.stringify(col.map((x) => [x.x, x.y, x.w, x.h])));
for (let i = 0; i < 4; i++) board.addCard({ kind: "text", title: `Extra ${i}`, text: `extra ${i}`, status: "ready", url: null });
r = board.arrangeCards("row") as { layout: string };
check("a row of eight becomes a grid", r.layout === "grid");
for (const n of [5, 6, 7, 8]) board.removeCard(n);

// ── the tools ──
let res = await tool("resize_card").run({ card: "2", how: "maximize" }, ctx("maximize card 2"));
check("tool: maximize by option", res.ok && /^Maximized card 2 \(Note\) — say restore/.test(res.say) && board.isMaximized(card(2)), res.say);
res = await tool("resize_card").run({}, ctx("make it a little smaller"));
check("tool: 'it' is the card in front, amount parsed", res.ok && (res.data?.cards as number[])?.join() === "2" && res.data?.amount === "bit" && /smaller, a little/.test(res.say), JSON.stringify(res));
res = await tool("resize_card").run({}, ctx("restore it"));
check("tool: restore finds the card with a kept layout", res.ok && (res.data?.cards as number[])?.join() === "2" && !card(2).prev, JSON.stringify(res));
res = await tool("resize_card").run({}, ctx("minimize the tiger"));
check("tool: by content word", res.ok && (res.data?.cards as number[])?.join() === "1" && board.isMinimized(card(1)), JSON.stringify(res));
res = await tool("resize_card").run({ card: "1" }, ctx("restore card 1"));
check("tool: restore by number", res.ok && !board.isMinimized(card(1)), JSON.stringify(res));
res = await tool("resize_card").run({}, ctx("make the panda twice as big"));
check("tool: 'twice' is a lot", res.ok && (res.data?.cards as number[])?.join() === "4" && res.data?.amount === "lot", JSON.stringify(res));
res = await tool("move_card").run({}, ctx("put the tiger behind the panda"));
check("tool: layered behind by content", res.ok && res.data?.layer === "behind" && res.data?.card === 1 && res.data?.anchor === 4 && card(1).z + 1 === card(4).z, JSON.stringify(res));
res = await tool("move_card").run({}, ctx("bring card 1 forward"));
check("tool: forward a layer", res.ok && res.data?.layer === "forward" && card(1).z === card(4).z + 1, JSON.stringify(res));
res = await tool("move_card").run({}, ctx("layer the timer on top of the panda"));
check("tool: on top of", res.ok && res.data?.layer === "on-top-of" && res.data?.card === 3 && res.data?.anchor === 4, JSON.stringify(res));
res = await tool("move_card").run({ card: "2", place: "front" }, ctx("bring card 2 to the front"));
check("tool: plain front still works", res.ok && card(2).z === Math.max(...(board.listCards() as Card[]).map((x) => x.z)), JSON.stringify(res));
res = await tool("arrange_cards").run({ layout: "stack" }, ctx("stack the cards"));
check("tool: stack", res.ok && /^Stacked 4 cards/.test(res.say), res.say);
res = await tool("arrange_cards").run({}, ctx("line the cards up in a row"));
check("tool: a row from the words", res.ok && /in a row/.test(res.say), res.say);
res = await tool("arrange_cards").run({}, ctx("organize the cards"));
check("tool: the grid is still the default", res.ok && /2 across in 2 rows/.test(res.say), res.say);

// ── keyless routing ──
const conv = (u: string) => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (finished speaking): ${u}`;
const route = async (u: string) => (await decide({ persona, conversation: conv(u), done: [] })).action as string;
const routes: [string, string][] = [
  ["maximize card 2", "resize_card"],
  ["make card 2 bigger", "resize_card"],
  ["make the tiger bigger", "resize_card"],
  ["minimize the tiger", "resize_card"],
  ["make it full screen", "resize_card"],
  ["Alright. Shrink the timer a bit.", "resize_card"],
  ["restore card 2", "resize_card"],
  ["put card 2 back to normal size", "resize_card"],
  ["make the timer wider", "resize_card"],
  ["make the picture 50 percent", "edit_html"],
  ["change the background of the timer to blue", "edit_html"],
  ["restore the cards", "undo_workspace"],
  ["put the tiger behind the panda", "move_card"],
  ["bring card 2 forward", "move_card"],
  ["bring card 2 to the front", "move_card"],
  ["move the tiger under the panda", "move_card"],
  ["stack the cards", "arrange_cards"],
  ["line the cards up in a row", "arrange_cards"],
  ["put the cards in a column", "arrange_cards"],
  ["organize the cards", "arrange_cards"],
  ["remove card 2", "remove_card"],
  ["clear the workspace", "clear_workspace"],
];
for (const [u, want] of routes) {
  const got = await route(u);
  check(`route: "${u}" → ${got}`, got === want, got === want ? "" : `wanted ${want}`);
}
// "restore card 2" while card 2 is maximized is a size restore even when it lands on the undo tool.
board.resizeCard(2, "maximize");
board.removeCard(4);
let u = await tool("undo_workspace").run({}, ctx("restore card 2"));
check("undo tool: a card still on the board is a size restore", u.ok && u.data?.how === "restore" && !board.isMaximized(card(2)) && board.listCards().length === 3, JSON.stringify(u));
u = await tool("undo_workspace").run({}, ctx("put the cards back"));
check("undo tool: otherwise a real undo", u.ok && board.listCards().length === 4, JSON.stringify(u));
void workspace;

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
