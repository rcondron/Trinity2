import { nanoid } from "nanoid";
import { tellEveryone } from "../agent/tell.js";
import { build, pageTitle } from "../services/mordiem.js";
import { coderModel, coderName, getEndpoints } from "../settings.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import {
  boardActive,
  boardBlocked,
  BoardLimitError,
  cardById,
  cardEditableHtml,
  findCardToEdit,
  listCards,
  patchCard,
  setMediaSize,
  summarizeHtml,
  type BoardCard,
  type CardPatch,
} from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import { cardQueueLength, queueOnCard } from "../workspace/card-jobs.js";
import { registerTool } from "./registry.js";

/**
 * The HTML skill: tweak what's already on the board — img width/height %, SVG/canvas markup,
 * widget styles — without rebuilding the whole card or replacing siblings. Size-only requests
 * (e.g. "make the picture smaller") apply immediately; deeper markup edits stream through the coder.
 */

const LEAD =
  /^(?:(?:ok(?:ay)?|alright|all right|so|now|and|also|then|great|cool|nice|perfect|hey|actually|trinity|please|can you|could you|would you|will you|go ahead and|i want you to|i'd like you to)\b[\s,.!]*)*/i;

const SIZE_ONLY =
  /\b(smaller|bigger|larger|tinier|tiny|huge|shrink(?:\s+it)?|enlarge|resize|scale|half(?:\s*-?\s*size)?|full(?:\s*-?\s*size)?|quarter|\d{1,3}\s*%|\d{1,3}\s*percent)\b/i;

const DEEP_HTML =
  /\b(svg|canvas|path|circle|rect|stroke|fill|font|colour|color|background|border|opacity|rotate|padding|margin|button|input|style|css|markup|html|element|label|caption|overlay)\b/i;

const WORD_PCT: Record<string, number> = {
  half: 50,
  quarter: 25,
  full: 100,
  tiny: 35,
  tinier: 30,
  huge: 100,
};

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

/** Parse "smaller", "60%", "half size", "a bit larger" into a target media width %. */
function parseSizeIntent(utterance: string, currentMw: number): { mw: number; mh: number | null; cardFactor: number } | null {
  const u = utterance.replace(LEAD, "");
  if (!SIZE_ONLY.test(u)) return null;

  const pct = /\b(\d{1,3})\s*(%|percent)\b/i.exec(u);
  if (pct) {
    const n = clamp(Number(pct[1]), 10, 100);
    return { mw: n, mh: null, cardFactor: n / Math.max(currentMw, 1) };
  }
  for (const [word, n] of Object.entries(WORD_PCT)) {
    if (new RegExp(String.raw`\b${word}\b`, "i").test(u)) {
      return { mw: n, mh: null, cardFactor: n / Math.max(currentMw, 1) };
    }
  }

  const shrink = /\b(smaller|shrink|tinier|reduce|narrower|shorter)\b/i.test(u);
  const grow = /\b(bigger|larger|enlarge|grow|wider|taller|huge)\b/i.test(u);
  if (!shrink && !grow) return null;

  const mild = /\b(a little|a bit|slightly|somewhat)\b/i.test(u);
  const strong = /\b(much|way|a lot|significantly|really|far)\b/i.test(u);
  const factor = shrink ? (strong ? 0.5 : mild ? 0.85 : 0.65) : strong ? 1.6 : mild ? 1.15 : 1.35;
  const mw = clamp(Math.round(currentMw * factor), 10, 100);
  return { mw, mh: null, cardFactor: factor };
}

function isSizeOnlyRequest(utterance: string): boolean {
  return SIZE_ONLY.test(utterance) && !DEEP_HTML.test(utterance);
}

function photoContentChange(utterance: string): boolean {
  return (
    /\b(picture|image|photo|painting|illustration|tiger|subject|face|eyes|fur)\b/i.test(utterance) &&
    /\b(recolou?r|repaint|redraw|regenerate|different|change (?:the )?(?:look|pose|background|subject)|make (?:it|him|her|them) (?:look|wear|hold))\b/i.test(
      utterance,
    )
  );
}

function applySize(card: BoardCard, utterance: string): ToolResult | null {
  if (!isSizeOnlyRequest(utterance)) return null;
  if (card.kind !== "image" && card.kind !== "video" && !card.html) return null;
  const currentMw = card.mw ?? 100;
  const intent = parseSizeIntent(utterance, currentMw);
  if (!intent) return null;

  const nextW = clamp(Math.round(card.w * Math.sqrt(intent.cardFactor)), 14, 70);
  const updated = setMediaSize(card.n, {
    mw: intent.mw,
    mh: intent.mh,
    cardW: Math.abs(nextW - card.w) >= 2 ? nextW : undefined,
  });
  if (!updated) return { ok: false, say: `I couldn't update card ${card.n}.` };
  return {
    ok: true,
    say: `Made card ${card.n} ${intent.mw < currentMw ? "smaller" : intent.mw > currentMw ? "larger" : "that size"} — the ${card.kind} is now ${intent.mw}% wide.`,
    data: { card: card.n, mw: intent.mw, w: updated.w },
  };
}

/**
 * One HTML edit, run on its card's own queue (workspace/card-jobs.ts) — the same queue build_ui uses — so it starts
 * only once everything asked of that card before it has finished, and it starts from the page the card has THEN:
 * never from a build that is still streaming in. If the edit fails, that same settled page goes back.
 */
async function runHtmlEdit(cardId: string, utterance: string, ctx: ToolContext): Promise<void> {
  const id = `html:${nanoid(6)}`;
  const card0 = cardById(cardId);
  if (!card0) return;
  const cardN = card0.n;
  // What the card shows now that its turn has come (an edit it was left with mid-way keeps its page in the stash).
  const prevHtml = card0.stash ?? (card0.status === "error" ? null : cardEditableHtml(card0));
  if (!prevHtml) {
    workspace.toast(`Card ${cardN} has nothing I can edit as HTML.`, "error");
    return;
  }

  const coder = getEndpoints().coderDefault === "kimi" ? "kimi" : "glm";
  const cancel = new AbortController();
  let lost = false;
  let refused: BoardLimitError | null = null;
  const put = (patch: CardPatch): boolean => {
    if (lost || refused) return false;
    try {
      if (patchCard(cardId, patch)) return true;
      lost = true;
      cancel.abort(new Error("the workspace moved on"));
    } catch (err) {
      if (!(err instanceof BoardLimitError)) throw err;
      refused = err;
      cancel.abort(err);
    }
    return false;
  };
  if (!put({ status: "pending", html: prevHtml, stash: prevHtml, model: coderName(coder), error: undefined })) return;
  workspace.activity(id, `Editing card ${cardN} HTML…`);

  const others = listCards()
    .filter((c) => c.id !== cardId)
    .map((c) => `card ${c.n} (${c.kind}): ${c.title}`)
    .join("; ");
  const context = [
    "You are the HTML skill. Surgically edit ONE existing floating card's HTML fragment.",
    "Keep everything the request does not ask to change. Prefer adjusting style width/height percentages on img, video, svg, and canvas.",
    "You may edit inline SVG paths/shapes, canvas drawing code, CSS, and DOM structure inside this card only.",
    "Do NOT recreate other cards. Do NOT wrap the card in outer chrome. Return ONLY the updated HTML fragment.",
    "Keep any use of trinity.saveState / trinity.loadState / trinity.emit working. Never add fields for passwords, card numbers, security codes or one-time codes: Trinity opens her own secure form for those.",
    others ? `Other cards on the board (leave them alone): ${others}` : "",
    ctx.situation ? `Situation: ${ctx.situation}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const html = await build(utterance, {
      model: coderModel(coder),
      currentHtml: prevHtml,
      currentTitle: card0.title,
      currentIsCard: false,
      context,
      signal: cancel.signal,
      onProgress: (partial) => {
        put({ status: "pending", html: partial, model: coderName(coder) });
      },
    });
    if (lost) return;
    const title = pageTitle(html) ?? card0.title;
    // Pull mw from the edited img/video style when present so later size tweaks stay in sync.
    const mwMatch = /<(?:img|video)\b[^>]*\bstyle\s*=\s*["'][^"']*\bwidth\s*:\s*(\d+(?:\.\d+)?)%/i.exec(html);
    const mw = mwMatch ? clamp(Number(mwMatch[1]), 10, 100) : card0.mw;
    const done = put({
      status: "ready",
      title,
      html,
      mw,
      model: undefined,
      error: undefined,
      stash: undefined,
    });
    if (!done) {
      if (refused) throw refused;
      return;
    }
    workspace.toast(`Card ${cardN}: HTML updated`, "success");
  } catch (err) {
    if (lost) return;
    const why = (refused as BoardLimitError | null)?.message ?? (err as Error).message;
    let kept = false;
    try {
      // Back to the page the card had when this edit's turn came — a settled page, never a half-streamed one.
      kept = Boolean(patchCard(cardId, { status: "ready", html: prevHtml, model: undefined, error: undefined, stash: undefined }));
    } catch (again) {
      console.warn(`[edit_html] card ${cardN}: ${(again as Error).message}`);
    }
    workspace.toast(`Card ${cardN} HTML edit failed: ${why.slice(0, 120)}`, "error");
    // Said once, briefly: a change that didn't happen must not pass in silence.
    if (kept) tellEveryone(`That change to card ${cardN} didn't work, so I left it as it was.`, "edit_html");
  } finally {
    workspace.activity(id, null);
  }
}

const editHtml: Tool = {
  name: "edit_html",
  description:
    "Change what's inside a card already on the workspace: a picture's own width percentage (“make the picture 50 percent”), SVG/canvas/widget markup, styles, or elements. A card's own size — bigger, smaller, full screen, minimized — is resize_card. Use for changes to existing cards — not to create new ones or regenerate a photo.",
  input: {},
  argMode: "raw",
  available: () => boardActive() && listCards().some((c) => c.status === "ready" || Boolean(c.html)),
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    if (boardBlocked()) {
      return { ok: false, say: "A game is on the workspace right now — finish or clear it before I edit cards." };
    }
    if (!boardActive() || !listCards().length) {
      return { ok: false, say: "There's nothing on the board to edit yet." };
    }
    const utterance = ctx.utterance.trim();
    const card = findCardToEdit(utterance);
    if (!card) return { ok: false, say: "Which card should I edit?" };

    if (photoContentChange(utterance) && card.kind === "image") {
      return {
        ok: false,
        say: `Card ${card.n} is a generated picture — I can resize or restyle it with HTML, but changing what it shows means making a new picture.`,
      };
    }

    const sized = applySize(card, utterance);
    if (sized) return sized;

    // A coder job is at work on this card (or waiting to be): this edit waits its turn behind it, on the card's queue.
    const busy = cardQueueLength(card.id) > 0;
    if (card.status === "pending" && !busy) {
      return { ok: false, say: `Card ${card.n} is still being made — ask again once it's ready.` };
    }
    const html = busy ? (card.stash ?? card.html ?? "") : cardEditableHtml(card);
    if (!html && !busy) {
      return {
        ok: false,
        say: `Card ${card.n} (${card.kind}) doesn't have HTML I can tweak. I can resize pictures and videos, or edit widget markup.`,
      };
    }

    // Seed editable HTML onto media cards so later size tweaks and the board stay in sync.
    if (!busy && !card.html && html) patchCard(card.id, { html });

    const { queued } = queueOnCard(card.id, () => runHtmlEdit(card.id, utterance, ctx));

    const tags = html ? summarizeHtml(html) : "its page";
    return {
      ok: true,
      say: queued
        ? `Queued an HTML edit on card ${card.n} (${tags}); it starts when the current edit finishes.`
        : `Editing the HTML on card ${card.n} (${tags}) now.`,
      inProgress: queued ? "queued" : "started",
      data: { card: card.n, elements: tags },
    };
  },
};

export function registerHtmlTools(): void {
  registerTool(editHtml);
}
