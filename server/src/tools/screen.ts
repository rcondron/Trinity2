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
  lineUpCards,
  nudgeCard,
  parseLayerPlace,
  parsePlace,
  removeCards,
  resizeCard,
  resizeCards,
  resolveCard,
  resolveMoveTargets,
  swapCards,
  touchCards,
  type ArrangeLayout,
  type BoardCard,
  type MovePlace,
  type ResizeAmount,
  type ResizeHow,
} from "../workspace/board.js";
import { cardName, cardOptions, cardsLabel, impliedCard, selectCards } from "../workspace/card-select.js";
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
  if (
    /\b(?:restore|bring (?:back|up)|bring [\w ]{1,30}? back|(?:open|show|expand|un-?hide) (?:up )?(?:the |all the |my )?(?:minimi[sz]ed|collapsed|hidden|tucked)|un-?maximi[sz]e|un-?minimi[sz]e|normal size|regular size|usual size|default size|back to (?:normal|its (?:old |usual |normal )?size|the way it was))\b/.test(t)
  )
    return { how: "restore", amount };
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
  if (r.layout === "shuffle") return `Shuffled ${n} cards into a grid in a random order.`;
  if (r.layout === "scatter") return `Scattered ${n} cards around the board.`;
  if (r.layout === "by_kind") return `Grouped ${n} cards by kind — pictures, videos, widgets, then notes and audio.`;
  if (r.layout === "newest_first") return `Arranged ${n} cards newest first, ${r.cols} across.`;
  return `Arranged ${n} cards in numerical order, ${r.cols} across${r.rows > 1 ? ` in ${r.rows} rows` : ""}.`;
}

/** "stack the cards", "in a row", "one under the other" → the layout asked for; the grid otherwise. */
function parseLayout(raw: unknown, utterance: string): ArrangeLayout {
  const given = String(raw ?? "").toLowerCase();
  const t = utterance.toLowerCase();
  // The words decide when they name a layout; Jev's pick otherwise.
  if (/\b(?:shuffle|randomi[sz]e|jumble|mix (?:them |the cards |it |everything )?up)\b/.test(t)) return "shuffle";
  if (/\b(?:scatter|strew|toss|throw (?:them|the cards|everything) around|spread (?:them |the cards )?(?:out )?(?:randomly|around|all over)|messy|mess (?:them|it|the cards) up)\b/.test(t)) return "scatter";
  if (/\bby (?:type|kind)\b|\bgroup (?:them|the cards|everything)\b|\b(?:put|keep) (?:the )?(?:pictures|videos|notes|widgets) together\b|\b(?:sort|arrange|organi[sz]e) (?:them |the cards )?by (?:type|kind)\b/.test(t)) return "by_kind";
  if (/\b(?:newest|latest|most recent) (?:ones? )?first\b|\breverse (?:the )?order\b|\bbackwards\b/.test(t)) return "newest_first";
  if (/\b(?:stack|cascade|pile)\b/.test(t)) return "stack";
  if (/\b(?:in|into)\s+(?:a|one|a single)\s+row\b|\bside by side\b|\bin a line across\b/.test(t)) return "row";
  if (/\b(?:in|into)\s+(?:a|one|a single)\s+column\b|\bone (?:under|below|on top of) (?:the )?(?:other|another)\b|\btop to bottom\b/.test(t)) return "column";
  if (given === "stack" || given === "row" || given === "column" || given === "shuffle" || given === "scatter" || given === "by_kind" || given === "newest_first") return given;
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
    "Undo the last change to the board — a clear, a remove, a move, a resize, an arrangement, a rename or a note edit — bringing back what was there. Use when the user says undo, put it back, bring it back, go back, or oops that was a mistake. (Restoring a card that is still on the board — maximized, minimized, resized — is resize_card.)",
  input: {},
  source: "builtin",
  available: () => workspace.canUndo(),
  async run(_args, ctx) {
    // "Restore card 2" while card 2 is on the board, shrunk or filling it: its size, not an undo — whichever tool Jev picked.
    const asks = /\b(?:restore|put back|bring back|un-?maximi[sz]e|un-?minimi[sz]e|normal size)\b/i.test(ctx.utterance);
    const named = asks ? resolveCard("", ctx.utterance) : null;
    if (named && (named.prev || isMinimized(named) || isMaximized(named))) {
      const card = resizeCard(named.n, "restore");
      if (card) return { ok: true, say: `Restored card ${named.n}.`, speak: `Restored card ${named.n}.`, data: { card: named.n, how: "restore" } };
    }
    // "Restore everything" / "bring them all back" while cards sit minimized or full screen: back to their sizes.
    if (asks && /\b(?:all|everything|every card|them|the cards|minimi[sz]ed|maximi[sz]ed)\b/i.test(ctx.utterance)) {
      const shrunk = listCards().filter((c) => isMinimized(c) || isMaximized(c));
      if (shrunk.length) {
        const done = resizeCards(shrunk.map((c) => c.n), "restore");
        const line = `Restored ${cardsLabel(done)}.`;
        return { ok: true, say: line, speak: line, data: { cards: done.map((c) => c.n), how: "restore" } };
      }
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


const missingLine = (ns: number[]) => `I don't see ${cardsLabel(ns.map((n) => ({ n })))} on the board.`;

const removeCardTool: Tool = {
  name: "remove_card",
  description:
    "Remove one or several floating cards from the board — by number, kind, what they show, place or recency (“remove card 2”, “close cards 2 and 3”, “delete all the pictures”, “close everything except the timer”, “get rid of the last two”). Clearing every card and page at once is clear_workspace.",
  input: {
    card: { type: "string", description: "which card — a number or what it shows (only when one card is meant)" },
  },
  options: (arg) => (arg === "card" ? cardOptions() : undefined),
  argMode: "raw",
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    const s = selectCards(ctx.utterance, { hint: args.card });
    if (!s.cards.length) return { ok: false, say: s.missing.length ? missingLine(s.missing) : "Which card should I remove — a number, or say what it shows?" };
    const removed = removeCards(s.cards.map((c) => c.n));
    if (!removed.length) return { ok: false, say: "Those cards aren't on the board any more." };
    const left = listCards().length;
    const what = removed.length === 1 ? cardName(removed[0]!) : cardsLabel(removed);
    const kept = s.how === "except" && s.except.length ? ` Kept ${cardsLabel(s.except)}.` : "";
    const missing = s.missing.length ? ` (${missingLine(s.missing)})` : "";
    return {
      ok: true,
      say: `Removed ${what}.${kept}${missing} ${left ? `${left} card${left === 1 ? "" : "s"} left.` : "The board is empty now."} Say undo to bring ${removed.length === 1 ? "it" : "them"} back.`,
      data: { cards: removed.map((c) => c.n) },
    };
  },
};

/** "a bit to the left", "up a little", "move it down", "further right" → a step; null for "to the left" (a place). */
function parseNudge(utterance: string): { dx: number; dy: number } | null {
  const t = utterance.toLowerCase();
  if (/\bto the (?:top|bottom|left|right|middle|center|centre|front|back)\b|\bcorner\b/.test(t) && !/\b(?:a (?:little|bit|tad|touch)|slightly|a few|some|more|further)\b/.test(t)) return null;
  const dir =
    /\b(?:(?:a (?:little|bit|tad|touch)|slightly|some|more|further|a few (?:steps|inches))\s+(?:more\s+)?(?:to the\s+)?|nudge\b[^.?!]{0,30}?\b|(?:move|shift|scoot|push|slide|bump|bring)\s+(?:it|this|that|card\s*\d+|the\s+[\w ]{1,24}?)\s+)(left|right|up|down|higher|lower)\b/.exec(t) ??
    /\b(left|right|up|down|higher|lower)\s+(?:a (?:little|bit|tad|touch)|slightly|some|more)\b/.exec(t);
  if (!dir) return null;
  const step = /\b(?:a (?:lot|ways)|way|much|far)\b/.test(t) ? 20 : /\b(?:a (?:tad|touch)|slightly|tiny)\b/.test(t) ? 4 : 8;
  const d = dir[1]!;
  return d === "left" ? { dx: -step, dy: 0 } : d === "right" ? { dx: step, dy: 0 } : d === "up" || d === "higher" ? { dx: 0, dy: -step } : { dx: 0, dy: step };
}

const moveCardTool: Tool = {
  name: "move_card",
  description:
    "Move a floating card by number or by what it shows: to a place (“move card 2 to the top-left”), next to another (“move the tiger under the panda”), a step (“move it a bit to the left”, “move it up”), in front of or behind another (“put the tiger behind the panda”, “bring card 2 forward”), swap two (“swap card 1 and card 3”), or line several up along one side (“put the pictures on the left”).",
  input: {
    card: { type: "string", description: "which card — a number or what it shows (only when one card is meant)" },
    place: {
      type: "string",
      description: "where on the board, or under/above/beside another card",
      options: PLACE_OPTIONS,
    },
  },
  options: (arg) => (arg === "card" ? cardOptions() : undefined),
  argMode: "raw",
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    const t = ctx.utterance.toLowerCase();
    // Swap: "swap card 1 and card 3", "switch the tiger and the panda", "trade places".
    if (/\b(?:swap|switch|trade|exchange)\b/.test(t)) {
      const s = selectCards(ctx.utterance, { hint: args.card });
      const pair = s.cards.length >= 2 ? s.cards.slice(0, 2) : s.cards.length === 1 && impliedCard() && impliedCard()!.n !== s.cards[0]!.n ? [s.cards[0]!, impliedCard()!] : [];
      if (pair.length === 2) {
        const done = swapCards(pair[0]!.n, pair[1]!.n);
        if (done) {
          touchCards(pair.map((c) => c.n));
          return { ok: true, say: `Swapped ${cardName(pair[0]!)} and ${cardName(pair[1]!)}.`, data: { swapped: pair.map((c) => c.n) } };
        }
      }
      if (s.missing.length) return { ok: false, say: missingLine(s.missing) };
      return { ok: false, say: "Which two cards should trade places?" };
    }
    // Several cards to one side: "put the pictures on the left", "move all the notes to the right side".
    const group = selectCards(ctx.utterance, { hint: args.card });
    const side = /\b(?:to|on|along|at|over to|down to|up to)\s+the\s+(left|right|top|bottom)(?:\s+(?:side|edge|of the (?:board|screen)))?\b/.exec(t)?.[1] as "left" | "right" | "top" | "bottom" | undefined;
    if (group.plural && group.cards.length > 1 && side) {
      const moved = lineUpCards(group.cards.map((c) => c.n), side);
      touchCards(moved.map((c) => c.n));
      return { ok: true, say: `Lined ${cardsLabel(moved)} up along the ${side}.`, data: { cards: moved.map((c) => c.n), side } };
    }
    // A step: "a bit to the left", "move it up", "nudge card 3 down".
    const nudge = parseNudge(ctx.utterance);
    if (nudge) {
      const one = selectCards(ctx.utterance, { hint: args.card, fallback: "implied" }).cards[0];
      if (!one) return { ok: false, say: "Which card should I move?" };
      const moved = nudgeCard(one.n, nudge.dx, nudge.dy);
      if (!moved) return { ok: false, say: `I couldn't move card ${one.n}.` };
      touchCards([one.n]);
      const way = nudge.dx < 0 ? "left" : nudge.dx > 0 ? "right" : nudge.dy < 0 ? "up" : "down";
      return { ok: true, say: `Moved ${cardName(one)} a little ${way}.`, data: { card: one.n, ...nudge } };
    }
    // Layering: "put the tiger behind the panda", "bring card 2 forward", "layer the timer on top of the chart".
    const layer = parseLayerPlace(ctx.utterance) ?? parseLayerPlace(String(args.place ?? ""));
    if (layer) {
      const m = /\b(?:move|put|place|bring|send|layer|stack|shift)\s+(?:the\s+)?(.+?)\s+(?:in front of|behind|on top of|forwards?|backwards?|up|down)\b/i.exec(ctx.utterance);
      const n = (m?.[1] ? resolveCard(m[1], m[1])?.n : null) ?? whichCard(args.card, ctx.utterance) ?? impliedCard()?.n ?? null;
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
    "Organize all the floating cards at once: an aligned grid in numerical order (“organize the cards”, “tidy up the board”), a stack / cascade, one row, one column, a shuffle (“shuffle the cards”), scattered around (“scatter them”), grouped by kind, or newest first. Undo brings the old layout back.",
  input: {
    layout: {
      type: "string",
      description: "how to lay the cards out",
      options: {
        grid: "an even grid in numerical order (the default)",
        stack: "a cascade, each card a little down and right of the one before",
        row: "one row across",
        column: "one column down",
        shuffle: "a grid in a random order",
        scatter: "strewn around the board at random",
        by_kind: "grouped by kind — pictures, videos, widgets, notes, audio",
        newest_first: "a grid with the newest card first",
      },
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
    "Change the size of one or several floating cards: maximize / full screen, minimize to a small tile, restore, or make them bigger, smaller, wider, narrower, taller or shorter — by number, kind or what they show (“maximize card 2”, “make the tiger bigger”, “minimize all the cards”, “minimize everything except the timer”, “restore them”). A picture's own width percentage or its markup is edit_html.",
  input: {
    card: { type: "string", description: "which card — a number or what it shows (only when one card is meant)" },
    how: { type: "string", description: "how to change its size", options: RESIZE_OPTIONS },
  },
  options: (arg) => (arg === "card" ? cardOptions() : undefined),
  argMode: "raw",
  available: () => boardActive() && listCards().length > 0,
  source: "builtin",
  async run(args, ctx) {
    if (!boardActive()) return { ok: false, say: "There aren't any floating cards on the board right now." };
    const parsed = parseResize(ctx.utterance);
    const given = String(args.how ?? "").toLowerCase() as ResizeHow;
    // The words decide when they say how ("minimize", "a little smaller"); Jev's pick fills in the rest.
    const how: ResizeHow | null = parsed?.how ?? (given in RESIZE_OPTIONS ? given : null);
    if (!how) return { ok: false, say: "Bigger, smaller, full screen, minimized, or back to normal — which?" };
    const amount = parsed?.amount ?? "normal";
    const sized = (c: BoardCard) => Boolean(c.prev) || isMinimized(c) || isMaximized(c);
    let s = selectCards(ctx.utterance, { hint: args.card, fallback: how === "restore" ? "none" : "implied" });
    if (!s.cards.length && how === "restore") {
      // "Restore it" / "back to normal": the card that was maximized or minimized last.
      const back = listCards().filter(sized);
      const one = impliedCard(back);
      if (one) s = { ...s, cards: [one] };
    }
    if (!s.cards.length) return { ok: false, say: s.missing.length ? missingLine(s.missing) : "Which card — a number, or say what it shows?" };
    let cards = s.cards;
    if (how === "restore") {
      const changed = cards.filter(sized);
      // Nothing there was ever resized: "restore the cards" after a remove or a clear means undo.
      if (!changed.length && s.plural && workspace.canUndo()) {
        const r = workspace.undo();
        return { ok: r.ok, say: r.say, speak: r.ok ? r.say : undefined };
      }
      if (changed.length) cards = changed;
    }
    if (how === "maximize" && cards.length > 1) {
      // Only one card can fill the board: "maximize them all" spreads them over it instead.
      if (cards.length === listCards().length) {
        const r = arrangeCards("grid");
        return { ok: Boolean(r), say: r ? `Spread all ${r.count} cards across the board, as big as they fit.` : "I couldn't arrange the cards." };
      }
      cards = cards.slice(-1);
    }
    const done = resizeCards(cards.map((c) => c.n), how, amount);
    if (!done.length) return { ok: false, say: "Those cards aren't on the board any more." };
    touchCards(done.map((c) => c.n));
    const which = done.length === 1 ? cardName(done[0]!) : cardsLabel(done);
    const kept = s.how === "except" && s.except.length ? ` Left ${cardsLabel(s.except)} as ${s.except.length === 1 ? "it was" : "they were"}.` : "";
    const line =
      how === "maximize"
        ? `Maximized ${which} — say restore to put it back.`
        : how === "minimize"
          ? `Minimized ${which} to the bottom row — say restore to bring ${done.length === 1 ? "it" : "them"} back.`
          : how === "restore"
            ? `Restored ${which}.`
            : `Made ${which} ${how}${amount === "bit" ? ", a little" : amount === "lot" ? ", a lot" : ""}.`;
    return { ok: true, say: `${line}${kept}`, data: { cards: done.map((c) => c.n), how, amount } };
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
        ? ["clear_workspace", "describe_workspace", "remove_card", "move_card", "arrange_cards", "resize_card", "control_card", "read_card", "edit_note", "rename_card", "duplicate_card", "make_text", "show_card", "edit_html", "set_speech_rate", "browser_open", "browser_tabs", "browser_read", "browser_act", "browser_modify", "browser_save", "browser_share"]
        : [],
  });
}
