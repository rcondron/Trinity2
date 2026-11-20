// arrange_cards against a scratch workspace: the grid geometry, numerical order, uniform cells, undo, the tool's
// spoken line, and keyless routing ("organize the cards" → arrange_cards, "put the cards back" still undo).
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
const { workspace } = await imp("workspace/bus.ts");
registerBuiltins();

type Card = { n: number; x: number; y: number; w: number; h?: number; z: number };
type Run = (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; say: string; data?: Record<string, unknown> }>;
const tool = (n: string) => (getTools() as { name: string; run: Run }[]).find((t) => t.name === n)!;
const persona = { id: "trinity", name: "Trinity", description: "You are Trinity.", voicePrompt: "", voice: "NATF2", traits: { role: "general companion & agent" }, toolsets: [], updatedAt: 0 };
const ctx = (utterance: string) => ({ utterance, persona, conversation: "", done: [] });

// ── the grid ──
for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 16, 20, 25]) {
  const g = board.gridFor(n) as { cols: number; rows: number; w: number; h: number; x0: number; y0: number; gap: number };
  const right = g.x0 + g.cols * g.w + (g.cols - 1) * g.gap;
  const bottom = g.y0 + g.rows * g.h + (g.rows - 1) * g.gap;
  check(
    `grid ${String(n).padStart(2)}: ${g.cols}×${g.rows}, cells ${g.w}×${g.h}, fits the board`,
    g.cols * g.rows >= n && g.w >= 14 && g.h >= 16 && right <= 100.05 && bottom <= 100.05 && g.x0 >= 0 && g.y0 >= 0,
    JSON.stringify(g),
  );
}
check("grid: one card is centered and not huge", (() => { const g = board.gridFor(1); return g.w <= 44 && g.h <= 60 && Math.abs(g.x0 + g.w / 2 - 50) < 0.2 && Math.abs(g.y0 + g.h / 2 - 50) < 0.2; })());

// ── the board ──
check("tool hidden while the board is empty", tool("arrange_cards").run && !(getTools() as { name: string; available?: () => boolean }[]).find((t) => t.name === "arrange_cards")!.available!());
const kinds = ["image", "text", "widget", "audio", "video", "text", "image"];
for (let i = 0; i < 7; i++) board.addCard({ kind: kinds[i], title: `Card ${i + 1}`, text: `card ${i + 1} about thing${i + 1}`, status: "ready", url: null, x: 70 - i * 9, y: (i * 13) % 80 });
board.removeCard(3);
const before = board.listCards() as Card[];
check("setup: six scattered cards numbered 1,2,4,5,6,7", before.length === 6 && before.map((c) => c.n).join() === "1,2,4,5,6,7");
const r = board.arrangeCards() as { count: number; cols: number; rows: number } | null;
const after = board.listCards() as Card[];
check("arrange: six cards → 3 across, 2 rows", r?.count === 6 && r.cols === 3 && r.rows === 2, JSON.stringify(r));
const g6 = board.gridFor(6) as { cols: number; w: number; h: number; x0: number; y0: number; gap: number };
const placed = after.every(
  (c, i) =>
    Math.abs(c.x - (g6.x0 + (i % 3) * (g6.w + g6.gap))) < 0.11 &&
    Math.abs(c.y - (g6.y0 + Math.floor(i / 3) * (g6.h + g6.gap))) < 0.11 &&
    c.w === g6.w &&
    c.h === g6.h &&
    c.z === i + 1,
);
check("arrange: row-major by number, uniform cells, stacked in order", placed, JSON.stringify(after.map((c) => [c.n, c.x, c.y, c.w, c.h, c.z])));
check("arrange: numbers never change", after.map((c) => c.n).join() === "1,2,4,5,6,7");

// ── keyless routing (no TypeSafe key → the heuristics), with cards on the board and an undo entry pending ──
const conv = (u: string) => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (finished speaking): ${u}`;
const route = async (u: string) => (await decide({ persona, conversation: conv(u), done: [] })).action as string;
const routes: [string, string][] = [
  ["organize the cards", "arrange_cards"],
  ["tidy up the board", "arrange_cards"],
  ["put the cards in a grid", "arrange_cards"],
  ["line up the cards", "arrange_cards"],
  ["sort the cards in order", "arrange_cards"],
  ["can you clean up the workspace", "arrange_cards"],
  ["Alright. Organize the cards, please.", "arrange_cards"],
  ["arrange the cards in numerical order", "arrange_cards"],
  ["put the cards back", "undo_workspace"],
  ["undo that", "undo_workspace"],
  ["remove card 2", "remove_card"],
  ["move card 2 to the top left", "move_card"],
  ["move the thing4 under the thing5", "move_card"],
  ["clear the workspace", "clear_workspace"],
];
for (const [u, want] of routes) {
  const got = await route(u);
  check(`route: "${u}" → ${got}`, got === want, got === want ? "" : `wanted ${want}`);
}

// ── undo, the tool, one card ──
const undone = workspace.undo() as { ok: boolean; say: string };
const restored = (board.listCards() as Card[]).every((c) => {
  const b = before.find((x) => x.n === c.n)!;
  return c.x === b.x && c.y === b.y && c.w === b.w;
});
check("undo brings the old layout back", undone.ok && restored, undone.say);
const res = await tool("arrange_cards").run({}, ctx("organize the cards"));
check("tool: arranged, spoken line", res.ok && /^Arranged 6 cards in numerical order, 3 across in 2 rows\.$/.test(res.say), JSON.stringify(res));
for (const n of [1, 2, 4, 5, 6]) board.removeCard(n);
const one = await tool("arrange_cards").run({}, ctx("tidy up"));
const only = (board.listCards() as Card[])[0]!;
check("tool: one card is centered", one.ok && /centered/.test(one.say) && Math.abs(only.x + only.w / 2 - 50) < 0.2, JSON.stringify([one.say, only.x, only.y, only.w, only.h]));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
