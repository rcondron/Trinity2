import { registerContextProvider } from "../agent/context.js";
import type { Persona, Tool } from "../types.js";
import {
  boardActive,
  describeBoard,
  listCards,
  moveCard,
  moveCardRelative,
  arrangeCards,
  isMaximized,
  isMinimized,
  layerCard,
  parseLayerPlace,
  parsePlace,
  removeCard,
  resizeCard,
  resolveCard,
  resolveMoveTargets,
  type ArrangeLayout,
  type MovePlace,
  type ResizeAmount,
  type ResizeHow,
} from "../workspace/board.js";
import { isBuildPreview, workspace } from "../workspace/bus.js";
import { registerTool } from "./registry.js";

/**
 * The workspace screen as something the agent can talk about and act on: what's showing (for
 * Jev's page text and the reply writer), clearing it, and removing / moving numbered floating
 * cards on the board — by number or by content tags ("the tiger", "panda picture").
 */

const isGameMaster = (p: Persona) => (p.toolsets ?? []).includes("game");
const gameOwned = () => Boolean(workspace.snapshot().owner?.startsWith("game:"));

/**
 * "The workspace window shows a page: “Tallest buildings chart”." — null for the Game Master while a game owns the
 * screen (the game describes itself); another persona hears about a game screen left behind like any other page.
 */
export function describeScreen(persona?: Persona): string | null {
  const s = workspace.snapshot();
  if (persona && isGameMaster(persona) && gameOwned()) return null;
  if (boardActive()) return describeBoard();
  if (s.mode === "empty") return "The workspace window is empty.";
  const what = isBuildPreview(s)
    ? "a page being built"
    : s.owner?.startsWith("game:")
      ? "a game screen"
      : s.mode === "app"
        ? "an app"
        : "a page";
  return `The workspace window shows ${what}: “${s.title}”.`;
}

function cardNumber(raw: unknown, utterance: string): number | null {
  const fromArg = Number(raw);
  if (Number.isFinite(fromArg) && fromArg >= 1) return Math.floor(fromArg);
  const m = /\bcard\s*(?:number\s*)?(\d+)\b/i.exec(utterance) || /\b(?:number|#)\s*(\d+)\b/i.exec(utterance);
  if (m) return Number(m[1]);
  return null;
}

/** Resolve by number or content tags ("tiger", "the panda"). */
function whichCard(raw: unknown, utterance: string): number | null {
  const n = cardNumber(raw, utterance);
  if (n) return n;
  const hit = resolveCard(String(raw ?? ""), utterance);
  return hit?.n ?? null;
}

const PLACE_OPTIONS: Record<string, string> = {
  "top-left": "upper left corner of the board",
  top: "top center",
  "top-right": "upper right corner",
  left: "middle left",
  center: "center of the board",
  right: "middle right",
  "bottom-left": "lower left corner",
  bottom: "bottom center",
  "bottom-right": "lower right corner",
  front: "bring to the front (on top of other cards)",
  back: "send behind the other cards",
  forward: "one layer up (toward the front)",
  backward: "one layer down (toward the back) — not undo",
  "in-front-of": "layered in front of another card, overlapping it (use with that card's name)",
  behind: "layered behind another card",
  "on-top-of": "on top of another card, overlapping it",
  under: "directly under another card (use with that card's name)",
  above: "directly above another card",
  beside: "beside another card",
};

/** The card the words mean when they don't name one: the only card, or the one in front (the last touched). */
function impliedCard(): number | null {
  const cards = listCards();
  if (!cards.length) return null;
  if (cards.length === 1) return cards[0]!.n;
  return cards.reduce((top, c) => (c.z > top.z ? c : top), cards[0]!).n;
}

/** "maximize", "a little smaller", "twice as big", "wider", "back to normal" → how, and how much. */
function parseResize(utterance: string): { how: ResizeHow; amount: ResizeAmount } | null {
  const t = utterance.toLowerCase();
  const amount: ResizeAmount = /\b(?:a (?:little|bit|tad|touch)|slightly|somewhat)\b/.test(t)
    ? "bit"
    : /\b(?:much|way|a lot|lots|twice|double|half|really|far|massively|significantly)\b/.test(t)
      ? "lot"
      : "normal";
  if (/\b(?:maximi[sz]e|full ?screen|fullscreen|fill (?:up )?the (?:whole |entire )?(?:screen|board|workspace|window)|as big as (?:it (?:can|will) go|possible)|take up the (?:whole|entire) (?:screen|board))\b/.test(t))
    return { how: "maximize", amount };
  if (/\b(?:minimi[sz]e|collapse|tuck (?:it |that |this )?away|out of the way|shrink (?:it |that |this )?(?:all the way )?down)\b/.test(t)) return { how: "minimize", amount };
  if (/\b(?:restore|un-?maximi[sz]e|un-?minimi[sz]e|normal size|regular size|usual size|default size|back to (?:normal|its (?:old |usual |normal )?size|the way it was))\b/.test(t)) return { how: "restore", amount };
  if (/\bwider\b|\bmore wide\b/.test(t)) return { how: "wider", amount };
  if (/\bnarrower\b|\bless wide\b|\bthinner\b/.test(t)) return { how: "narrower", amount };
  if (/\btaller\b|\blonger\b/.test(t)) return { how: "taller", amount };
  if (/\bshorter\b/.test(t)) return { how: "shorter", amount };
  if (/\b(?:bigger|larger|enlarge|expand|grow|blow (?:it |that |this )?up|huge|zoom in|double|twice)\b/.test(t)) return { how: "bigger", amount };
  if (/\b(?:smaller|tinier|shrink|reduce|tiny|half|zoom out)\b/.test(t)) return { how: "smaller", amount };
  return null;
}

const RESIZE_OPTIONS: Record<ResizeHow, string> = {
  maximize: "fill the whole board (full screen)",
  minimize: "shrink to a small tile on the bottom row",
  restore: "back to the size and place it had before (or its usual size)",
  bigger: "larger",
  smaller: "smaller",
  wider: "wider only",
  narrower: "narrower only",
  taller: "taller only",
  shorter: "shorter only",
};

/** What to say about a layout: a stack, a row, a column, or the grid. */
function arrangeLine(r: { count: number; cols: number; rows: number; layout: ArrangeLayout }): string {
  const n = r.count;
  if (n === 1) return "There's just one card on the board — I centered it.";
  if (r.layout === "stack") return `Stacked ${n} cards in numerical order, front to back.`;
  if (r.layout === "row") return `Lined up ${n} cards in a row, in numerical order.`;
  if (r.layout === "column") return `Lined up ${n} cards in a column, in numerical order.`;
  return `Arranged ${n} cards in numerical order, ${r.cols} across${r.rows > 1 ? ` in ${r.rows} rows` : ""}.`;
}

/** "stack the cards", "in a row", "one under the other" → the layout asked for; the grid otherwise. */
function parseLayout(raw: unknown, utterance: string): ArrangeLayout {
  const given = String(raw ?? "").toLowerCase();
  if (given === "stack" || given === "row" || given === "column" || given === "grid") return given;
  const t = utterance.toLowerCase();
  if (/\b(?:stack|cascade|pile)\b/.test(t)) return "stack";
  if (/\b(?:in|into)\s+(?:a|one|a single)\s+row\b|\bside by side\b|\bin a line across\b/.test(t)) return "row";
  if (/\b(?:in|into)\s+(?:a|one|a single)\s+column\b|\bone (?:under|below|on top of) (?:the )?(?:other|another)\b|\btop to bottom\b/.test(t)) return "column";
  return "grid";
}

const clearWorkspace: Tool = {
  name: "clear_workspace",
  description:
    "Clear, wipe, blank, reset, or empty the workspace / screen / board / window — including every floating card and any page or app on it. Use this whenever the user wants the screen cleared, not remove_card (that's one numbered card). Prefer this only when they clearly want everything gone — they can undo_workspace if it was a mistake.",
  input: {},
  source: "builtin",
  async run() {
    const s = workspace.snapshot();
    if (s.mode === "empty") return { ok: true, say: "The workspace is already empty." };
    const cards = boardActive() ? listCards().length : 0;
    workspace.clear();
    return {
      ok: true,
      say: cards
        ? `Cleared the workspace and removed ${cards} card${cards === 1 ? "" : "s"}. Say undo if you want them back.`
        : `Cleared the workspace; it was showing ${s.title}. Say undo if you want it back.`,
    };
  },
};

const undoWorkspace: Tool = {
  name: "undo_workspace",
  description:
    "Undo the last workspace clear or card remove — bring back cards / the previous screen that was closed by accident. Use when the user says undo, put it back, bring it back, go back, or oops that was a mistake. (Restoring a card that is still on the board — maximized, minimized, resized — is resize_card.)",
  input: {},
  source: "builtin",
  available: () => workspace.canUndo(),
  async run(_args, ctx) {
    // "Restore card 2" while card 2 is on the board, shrunk or filling it: its size, not an undo — whichever tool Jev picked.
    const named = /\b(?:restore|put back|bring back|un-?maximi[sz]e|un-?minimi[sz]e|normal size)\b/i.test(ctx.utterance) ? resolveCard("", ctx.utterance) : null;
    if (named && (named.prev || isMinimized(named) || isMaximized(named))) {
      const card = resizeCard(named.n, "restore");
      if (card) return { ok: true, say: `Restored card ${named.n}.`, speak: `Restored card ${named.n}.`, data: { card: named.n, how: "restore" } };
    }
    const result = workspace.undo();
    return { ok: result.ok, say: result.say, speak: result.ok ? result.say : undefined };
  },
};

const describeWorkspace: Tool = {
  name: "describe_workspace",
  description: "Tell the user what the workspace window is showing right now (including numbered cards and what each is about), or that it's empty.",
  input: {},
  source: "builtin",
  async run() {
    const said = describeScreen()!.replace(/^The workspace (?:window|board)/, "The workspace");
    return { ok: true, say: said, speak: said };
  },
};

/** Live card numbers as Jev option ids ("1", "2", …) so it can fire mid-sentence once sure. */
function cardOptions(): Record<string, string> | undefined {
  if (!boardActive()) return undefined;
  const cards = listCards();
  if (!cards.length) return undefined;
  return Object.fromEntries(
    cards.map((c) => {
      const about = (c.tags ?? []).slice(0, 4).join(", ");
      return [String(c.n), `card ${c.n} — ${c.kind}: ${c.title}${about ? ` (${about})` : ""}`];
    }),
  );
}

const removeCardTool: Tool = {
  name: "remove_card",
  description:
    "Remove one floating card from the workspace board by number or by what it shows (e.g. “remove card 2”, “remove the tiger”).",
  input: {
    card: {
      type: "string",
      required: true,
      description: "which card — number or content word (tiger, panda, timer…)",
    },
  },
  options: (arg) => (arg === "card" ? cardOptions() : undefined),
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    const n = whichCard(args.card, ctx.utterance);
    if (!n) return { ok: false, say: "Which card should I remove — a number, or say what it shows?" };
    const removed = removeCard(n);
    if (!removed) return { ok: false, say: `I don't see card ${n} on the board.` };
    const left = listCards().length;
    const label = (removed.tags ?? [])[0] ? ` (${(removed.tags ?? [])[0]})` : "";
    return {
      ok: true,
      say: left
        ? `Removed card ${n}${label}. ${left} card${left === 1 ? "" : "s"} left.`
        : `Removed card ${n}${label}. The board is empty now.`,
      data: { card: n },
    };
  },
};

const moveCardTool: Tool = {
  name: "move_card",
  description:
    "Move a floating card by number or by what it shows (e.g. “move card 2 to the top-left”, “move the tiger under the panda”, “bring the timer to the front”).",
  input: {
    card: {
      type: "string",
      required: true,
      description: "which card — number or content word (tiger, panda…)",
    },
    place: {
      type: "string",
      required: true,
      description: "where on the board, or under/above/beside another card",
      options: PLACE_OPTIONS,
    },
  },
  options: (arg) => (arg === "card" ? cardOptions() : undefined),
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    // Layering: "put the tiger behind the panda", "bring card 2 forward", "layer the timer on top of the chart".
    const layer = parseLayerPlace(ctx.utterance) ?? parseLayerPlace(String(args.place ?? ""));
    if (layer) {
      const m = /\b(?:move|put|place|bring|send|layer|stack|shift)\s+(?:the\s+)?(.+?)\s+(?:in front of|behind|on top of|forwards?|backwards?|up|down)\b/i.exec(ctx.utterance);
      const n = (m?.[1] ? resolveCard(m[1], m[1])?.n : null) ?? whichCard(args.card, ctx.utterance) ?? impliedCard();
      if (!n) return { ok: false, say: "Which card should I move — a number, or say what it shows?" };
      let anchor: number | undefined;
      if (layer !== "forward" && layer !== "backward") {
        const hint = /\b(?:in front of|behind|on top of)\s+(?:the\s+)?(.+?)(?:\s*[.!?]|$)/i.exec(ctx.utterance)?.[1] ?? "";
        const other = hint ? resolveCard(hint, hint) : null;
        if (!other || other.n === n) return { ok: false, say: `Which card should card ${n} go ${layer.replace(/-/g, " ")}?` };
        anchor = other.n;
      }
      const moved = layerCard(n, layer, anchor);
      if (!moved) return { ok: false, say: `I couldn't re-layer card ${n}.` };
      const rel = layer === "forward" ? "forward a layer" : layer === "backward" ? "back a layer" : `${layer.replace(/-/g, " ")} card ${anchor}`;
      return { ok: true, say: `Moved card ${n} ${rel}.`, data: { card: n, layer, anchor } };
    }
    const targets = resolveMoveTargets(ctx.utterance);
    const n = targets.moving?.n ?? whichCard(args.card, ctx.utterance);
    if (!n) return { ok: false, say: "Which card should I move — a number, or say what it shows?" };

    if (targets.relative && targets.anchor) {
      const moved = moveCardRelative(n, targets.relative, targets.anchor.n);
      if (!moved) return { ok: false, say: `I couldn't place card ${n} relative to card ${targets.anchor.n}.` };
      const rel =
        targets.relative === "under"
          ? "under"
          : targets.relative === "above"
            ? "above"
            : targets.relative === "left-of"
              ? "to the left of"
              : targets.relative === "right-of"
                ? "to the right of"
                : "beside";
      const anchorLabel = (targets.anchor.tags ?? [])[0] || targets.anchor.title || `card ${targets.anchor.n}`;
      return {
        ok: true,
        say: `Moved card ${n} ${rel} ${anchorLabel} (card ${targets.anchor.n}).`,
        data: { card: n, relative: targets.relative, anchor: targets.anchor.n },
      };
    }

    let place = parsePlace(args.place);
    if (!place) {
      const m =
        /\b(top[\s-]?left|top[\s-]?right|bottom[\s-]?left|bottom[\s-]?right|top|bottom|left|right|center|middle|front|back)\b/i.exec(
          ctx.utterance,
        );
      place = parsePlace(m?.[1] ?? "");
    }
    if (!place) return { ok: false, say: "Where should I put it — top-left, center, under the panda, front, back…?" };
    const moved = moveCard(n, place as MovePlace);
    if (!moved) return { ok: false, say: `I don't see card ${n} on the board.` };
    const where =
      place === "front" ? "to the front" : place === "back" ? "to the back" : `to the ${place.replace(/-/g, " ")}`;
    return { ok: true, say: `Moved card ${n} ${where}.`, data: { card: n, place } };
  },
};

const arrangeCardsTool: Tool = {
  name: "arrange_cards",
  description:
    "Organize all the floating cards at once, in numerical order: an aligned grid of equal cards (“organize the cards”, “tidy up the board”, “put the cards in a grid”), a stack / cascade (“stack the cards”), one row, or one column. Undo brings the old layout back.",
  input: {
    layout: {
      type: "string",
      description: "how to lay the cards out",
      options: { grid: "an even grid (the default)", stack: "a cascade, each card a little down and right of the one before", row: "one row across", column: "one column down" },
    },
  },
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    const result = arrangeCards(parseLayout(args.layout, ctx.utterance));
    if (!result) return { ok: false, say: "There aren't any floating cards on the board right now." };
    return { ok: true, say: arrangeLine(result), data: result };
  },
};

const resizeCardTool: Tool = {
  name: "resize_card",
  description:
    "Change a floating card's size: maximize / full screen, minimize to a small tile, restore it, or make it bigger, smaller, wider, narrower, taller or shorter — by number or by what it shows (“maximize card 2”, “make the tiger bigger”, “minimize the timer”, “restore it”). A picture's own width percentage or its markup is edit_html.",
  input: {
    card: { type: "string", required: true, description: "which card — number or content word (tiger, panda, timer…)" },
    how: { type: "string", required: true, description: "how to change its size", options: RESIZE_OPTIONS },
  },
  options: (arg) => (arg === "card" ? cardOptions() : undefined),
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    const parsed = parseResize(ctx.utterance);
    const given = String(args.how ?? "").toLowerCase() as ResizeHow;
    const how: ResizeHow | null = given in RESIZE_OPTIONS ? given : (parsed?.how ?? null);
    if (!how) return { ok: false, say: "Bigger, smaller, full screen, minimized, or back to normal — which?" };
    const amount = parsed?.amount ?? "normal";
    let n = whichCard(args.card, ctx.utterance);
    if (!n && how === "restore") n = listCards().find((c) => c.prev)?.n ?? null;
    if (!n) n = impliedCard();
    if (!n) return { ok: false, say: "Which card — a number, or say what it shows?" };
    const card = resizeCard(n, how, amount);
    if (!card) return { ok: false, say: `I don't see card ${n} on the board.` };
    const line =
      how === "maximize"
        ? `Maximized card ${n} — say restore to put it back.`
        : how === "minimize"
          ? `Minimized card ${n} to the bottom row — say restore card ${n} to bring it back.`
          : how === "restore"
            ? `Restored card ${n}.`
            : `Made card ${n} ${how}${amount === "bit" ? ", a little" : amount === "lot" ? ", a lot" : ""}.`;
    return { ok: true, say: line, data: { card: n, how, amount, w: card.w, h: card.h ?? null, x: card.x, y: card.y } };
  },
};

export function registerScreenTools(): void {
  [clearWorkspace, undoWorkspace, describeWorkspace, removeCardTool, moveCardTool, arrangeCardsTool, resizeCardTool].forEach(registerTool);
  registerContextProvider({
    describe: (persona) => {
      const base = describeScreen(persona);
      if (!workspace.canUndo()) return base;
      const hint = `Undo available: restore ${workspace.undoLabel()}.`;
      return base ? `${base} ${hint}` : hint;
    },
    // While the Game Master runs a game on the screen, the game tools are in charge of it ("clear the board" is a move
    // in the story) and the game describes itself. Another persona may clear a game screen left behind.
    // Game integration already hides board tools whenever a game is active; also hide them while a
    // game screen owns the workspace (covers a game left up after the active id was cleared).
    // undo_workspace stays available so an accidental clear can be reversed.
    hiddenActions: (persona) =>
      isGameMaster(persona) && gameOwned()
        ? ["clear_workspace", "describe_workspace", "remove_card", "move_card", "arrange_cards", "resize_card", "make_text", "show_card", "edit_html", "set_speech_rate", "browser_open", "browser_tabs", "browser_read", "browser_act", "browser_modify", "browser_save", "browser_share"]
        : [],
  });
}
