import { registerContextProvider } from "../agent/context.js";
import type { Persona, Tool } from "../types.js";
import {
  boardActive,
  describeBoard,
  listCards,
  moveCard,
  moveCardRelative,
  parsePlace,
  removeCard,
  resolveCard,
  resolveMoveTargets,
  type MovePlace,
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
  under: "directly under another card (use with that card's name)",
  above: "directly above another card",
  beside: "beside another card",
};

const clearWorkspace: Tool = {
  name: "clear_workspace",
  description:
    "Clear, wipe, blank, reset, or empty the workspace / screen / board / window — including every floating card and any page or app on it. Use this whenever the caller wants the screen cleared, not remove_card (that's one numbered card).",
  input: {},
  source: "builtin",
  async run() {
    const s = workspace.snapshot();
    if (s.mode === "empty") return { ok: true, say: "The workspace is already empty." };
    const cards = boardActive() ? listCards().length : 0;
    workspace.clear();
    return {
      ok: true,
      say: cards ? `Cleared the workspace and removed ${cards} card${cards === 1 ? "" : "s"}.` : `Cleared the workspace; it was showing ${s.title}.`,
    };
  },
};

const describeWorkspace: Tool = {
  name: "describe_workspace",
  description: "Tell the caller what the workspace window is showing right now (including numbered cards and what each is about), or that it's empty.",
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

export function registerScreenTools(): void {
  [clearWorkspace, describeWorkspace, removeCardTool, moveCardTool].forEach(registerTool);
  registerContextProvider({
    describe: (persona) => describeScreen(persona),
    // While the Game Master runs a game on the screen, the game tools are in charge of it ("clear the board" is a move
    // in the story) and the game describes itself. Another persona may clear a game screen left behind.
    // Game integration already hides board tools whenever a game is active; also hide them while a
    // game screen owns the workspace (covers a game left up after the active id was cleared).
    hiddenActions: (persona) =>
      isGameMaster(persona) && gameOwned()
        ? ["clear_workspace", "describe_workspace", "remove_card", "move_card", "make_text", "show_card", "edit_html", "set_speech_rate", "browser_open", "browser_tabs", "browser_read", "browser_act", "browser_modify", "browser_save", "browser_share"]
        : [],
  });
}
