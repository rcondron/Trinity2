import type { Block, ContentSpec, ContentType, LabelValue, Mood } from "../content-spec.js";
import { addCard, boardBlocked, getCard, tagsFromText, updateCard } from "../../workspace/board.js";
import { renderContentCard } from "../../workspace/content-card.js";

/*
 * The assistant tools' cards on the board: the inbox (numbered, so "open the second one" has something to point at),
 * an open message, an email draft, a day's calendar, a meeting that is filled in but not saved. Each is an ordinary
 * content card — a ContentSpec laid out by workspace/content-card.ts, which escapes every string — and each kind keeps
 * one card: checking the inbox again rewrites the inbox card instead of piling up a new one.
 */

export type AssistCard = "inbox" | "message" | "draft" | "calendar" | "meeting";

const LOOK: Record<AssistCard, { type: ContentType; accent: string; mood: Mood; w: number; h: number }> = {
  inbox: { type: "list", accent: "#2563eb", mood: "editorial", w: 40, h: 62 },
  message: { type: "other", accent: "#2563eb", mood: "editorial", w: 40, h: 62 },
  draft: { type: "other", accent: "#0f766e", mood: "calm", w: 38, h: 56 },
  calendar: { type: "plan", accent: "#7c3aed", mood: "cool", w: 38, h: 62 },
  meeting: { type: "event", accent: "#7c3aed", mood: "cool", w: 36, h: 48 },
};

export interface CardContent {
  /** The card's name on the board ("Inbox", "Draft to Sam"). */
  title: string;
  subtitle?: string;
  /** What it says in a sentence (the board's caption, and what a card reader is told). */
  summary: string;
  meta?: LabelValue[];
  blocks: Block[];
}

const marker = (kind: AssistCard): string => `<!-- assist:${kind} -->`;
const numbers = new Map<AssistCard, number>();

/**
 * Put a card of this kind on the board, or rewrite the one that is there. Returns its number — null while a game
 * owns the screen (nothing is shown then, and the spoken line must not point at a card).
 */
export function showAssistCard(kind: AssistCard, content: CardContent): number | null {
  if (boardBlocked()) return null;
  const look = LOOK[kind];
  const spec: ContentSpec = {
    type: look.type,
    title: content.title.slice(0, 120),
    ...(content.subtitle ? { subtitle: content.subtitle.slice(0, 160) } : {}),
    summary: content.summary.slice(0, 400),
    theme: { accent: look.accent, mood: look.mood },
    image: null,
    meta: (content.meta ?? []).slice(0, 5),
    blocks: content.blocks.slice(0, 10),
    sources: [],
  };
  // The renderer's first line names the card; ours follows it, so the card can be found again.
  const html = renderContentCard(spec).replace(/^(<!-- title: [^\n]*-->\n)/, `$1${marker(kind)}\n`);
  const patch = {
    title: content.title.slice(0, 80),
    text: content.summary.slice(0, 600),
    tags: tagsFromText(content.title, kind === "inbox" || kind === "message" || kind === "draft" ? "email mail" : "calendar"),
    html,
  };
  const n = numbers.get(kind);
  const existing = n === undefined ? null : getCard(n);
  if (existing && existing.kind === "widget" && existing.html?.includes(marker(kind))) {
    if (updateCard(existing.n, { ...patch, status: "ready", error: undefined })) return existing.n;
  }
  let card: { n: number };
  try {
    card = addCard({ kind: "widget", status: "ready", w: look.w, h: look.h, ...patch });
  } catch (err) {
    // A full board (BoardLimitError): no card this time; what was found is still said.
    console.warn(`[assist] no ${kind} card added:`, (err as Error).message);
    return null;
  }
  numbers.set(kind, card.n);
  return card.n;
}

/** The number of this kind's card, while it is still on the board. */
export function assistCardNumber(kind: AssistCard): number | null {
  const n = numbers.get(kind);
  const card = n === undefined ? null : getCard(n);
  return card && card.html?.includes(marker(kind)) ? card.n : null;
}

/** A long text as paragraphs of a few sentences each (a page's text arrives with its line breaks gone). */
export function paragraphs(text: string, perParagraph = 3, max = 12): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length && out.length < max; i += perParagraph) out.push(parts.slice(i, i + perParagraph).join(" "));
  return out.length ? out : text.trim() ? [text.trim()] : [];
}
