/*
 * What the cards say back to the engine, besides command answers and hand-made layouts (card-commands.ts): the heights
 * a window measured, a script error in a widget's page, and — from a widget's own trinity API — a state to keep and an
 * event for Trinity.
 *
 * All of it arrives from a workspace window over /ws/workspace as a "board" event. The window only passes on what its
 * board template sent, and the board only what came from one of its own card frames — but a widget's page is
 * model-written and may hold text from the web, so everything here is treated as UNTRUSTED: sizes are capped, text is
 * flattened to one short line, rates are limited per card and overall, a card is looked up by its id (an event for a
 * card that is gone does nothing), and nothing a card sends is ever handed to a model as an instruction.
 */
import { pendingQuestion } from "../agent/pending.js";
import { getTools } from "../tools/registry.js";
import { BOARD_LIMITS, cardById, noteCardHeights, patchCard, type BoardCard } from "./board.js";
import { workspace } from "./bus.js";

/** Text from a card as one printable line of at most `max` characters. */
export function cardLine(v: unknown, max: number): string {
  return (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const seen = new Map<string, number[]>();

/** At most `max` in any `ms` for this key (a card and a kind of event, or a kind of event overall). */
export function withinRate(key: string, max: number, ms: number, now = Date.now()): boolean {
  let times = seen.get(key);
  if (!times) seen.set(key, (times = []));
  while (times.length && now - times[0]! > ms) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  if (seen.size > 500) for (const [k, t] of seen) if (!t.length || now - t[t.length - 1]! > 10 * 60_000) seen.delete(k);
  return true;
}

/** The card an event names — by its id only. */
export function eventCard(evt: Record<string, unknown>): BoardCard | null {
  const id = typeof evt.id === "string" && evt.id.length <= 40 ? evt.id : "";
  return id ? cardById(id) : null;
}

type ScriptErrorHandler = (cardId: string, message: string) => unknown;
let scriptError: ScriptErrorHandler | null = null;

/** Who hears about a script error in a widget's page (the coding skill: it repairs a freshly built page once). */
export function setScriptErrorHandler(fn: ScriptErrorHandler | null): void {
  scriptError = fn;
}

// ─── trinity.saveState: what a widget keeps ─────────────────────────────────

/** Names a widget's kept state may not use: a secret never rides on the board (nor in workspace.json). */
const SECRET_KEY = /pass(?:word|code|phrase)|^pin$|otp|one.?time|cvv|cvc|card.?num|credit.?card|ssn|secret|token|api.?key|private.?key/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/** A string that is a card number (thirteen to nineteen digits that pass the card check), however it is spaced. */
const cardNumber = (s: string) => {
  const digits = s.replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digits) && luhn(digits);
};

/**
 * What a widget asked to keep, as it may be kept: plain JSON (objects, arrays, strings, numbers, true and false), no
 * deeper than eight levels, without keys named like a secret and without card numbers, and at most
 * BOARD_LIMITS.cardState characters in all. Undefined when it isn't JSON or is too big.
 */
export function cleanCardState(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return cardNumber(v) ? "" : v.slice(0, 4000);
  if (depth >= 8 || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => cleanCardState(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 400)) {
    if (SECRET_KEY.test(k) || k === "__proto__") continue;
    out[k.slice(0, 80)] = cleanCardState(x, depth + 1);
  }
  return out;
}

/** JSON of at most `max` characters, or null (a value that is too big, or not JSON, is refused whole — never cut). */
function jsonWithin(v: unknown, max: number): string | null {
  try {
    const json = JSON.stringify(v ?? null);
    return typeof json === "string" && json.length <= max ? json : null;
  } catch {
    return null;
  }
}

function keepState(card: BoardCard, raw: unknown): boolean {
  if (card.kind !== "widget" || card.status !== "ready" || !card.html) return false;
  if (jsonWithin(raw, BOARD_LIMITS.cardState) === null) return false;
  const state = cleanCardState(raw);
  try {
    return patchCard(card.id, { state: state ?? null }) !== null;
  } catch {
    return false; // the board can't take it: the widget still has it in this window
  }
}

// ─── trinity.emit: what a widget tells Trinity ──────────────────────────────

/** Something the user did in a widget that is meant for Trinity — all of it from the page: data, never instructions. */
export interface CardEvent {
  cardId: string;
  n: number;
  title: string;
  /** What the user did, in a few of the card's own words: "pressed “Add milk”". */
  what: string;
  /** The event as the widget sent it (at most 2 KB of JSON). */
  event: unknown;
  /** The line for the conversation: "On card 3 (“Shopping helper”) the user pressed “Add milk”." */
  line: string;
  /** What the agent may be handed as if the user had said it ("I pressed “Add milk” on card 3."), or null when it may not. */
  ask: string | null;
  at: number;
}

/** A card event may start only these tools: the board's own, never one marked sensitive (vault, sign-in, payment). */
// (Never control_card: the press already happened in the card — pressing it again would do it twice.)
export const CARD_EVENT_TOOLS: ReadonlySet<string> = new Set([
  "read_card",
  "edit_note",
  "make_text",
  "rename_card",
  "duplicate_card",
  "move_card",
  "resize_card",
  "arrange_cards",
  "describe_workspace",
  "show_card",
  "make_image",
  "show_table",
  "show_chart",
  "show_document",
  "show_code",
  "get_time",
]);

/** What the user did, from the event's own words: "pressed “Add milk”", "chose “Paris”". */
function whatOf(event: unknown): string {
  const quote = (s: string) => `“${s.replace(/[“”"]/g, "'")}”`;
  if (typeof event === "string" || typeof event === "number") return `pressed ${quote(cardLine(event, 80))}`;
  if (!event || typeof event !== "object" || Array.isArray(event)) return "pressed something";
  const e = event as Record<string, unknown>;
  const label = cardLine(e.label ?? e.name ?? e.action ?? e.text ?? e.type ?? "", 80);
  const value = e.value !== undefined && e.value !== null && typeof e.value !== "object" ? cardLine(e.value, 80) : "";
  if (label && value) return `pressed ${quote(label)} with ${quote(value)}`;
  if (label) return `pressed ${quote(label)}`;
  if (value) return `chose ${quote(value)}`;
  return "pressed something";
}

const listeners = new Set<(e: CardEvent) => void>();

/**
 * Hear every card event (after it was checked and capped): the place to add `line` to the conversation as a system
 * turn. Returns an unsubscribe.
 */
export function onCardEvent(fn: (e: CardEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * How an event the agent may act on is handed to it. The default (actOnCardEvent) runs the router and the tool on
 * `ask` with every tool outside CARD_EVENT_TOOLS hidden, as a turn the user did not speak (act refuses a sensitive tool
 * there too); null turns that off. The engine may set its own (one that also knows the conversation).
 */
let router: ((e: CardEvent) => Promise<void>) | null = actOnCardEvent;

export function setCardEventRouter(fn: ((e: CardEvent) => Promise<void>) | null): void {
  router = fn;
}

/** The default router: Jev picks among the card-event tools, the tool runs, and nothing more is said unless it answers. */
export async function actOnCardEvent(e: CardEvent): Promise<void> {
  if (!e.ask) return;
  const [{ decide, firing }, { act }, { contextFor }, { getActivePersona }, { sharedMemory }, { getEndpoints }, { tellEveryone }] = await Promise.all([
    import("../agent/router.js"),
    import("../agent/act.js"),
    import("../agent/context.js"),
    import("../db/sqlite.js"),
    import("../db/memory.js"),
    import("../settings.js"),
    import("../agent/tell.js"),
  ]);
  const memory = sharedMemory();
  if (!memory) return;
  let persona: ReturnType<typeof getActivePersona>;
  try {
    persona = getActivePersona();
  } catch {
    return; // no persona yet (the engine is still starting)
  }
  const hidden = new Set(getTools().filter((t) => !CARD_EVENT_TOOLS.has(t.name) || t.sensitive).map((t) => t.name));
  const conversation = `Conversation so far, oldest first:\n(The user is using card ${e.n} on the workspace board.)\n\nUser's latest words (finished speaking): ${e.ask}`;
  const d = await decide({ persona, conversation, done: [], hidden });
  const min = getEndpoints().minConfidence;
  if (!d.tool || !CARD_EVENT_TOOLS.has(d.tool.name) || d.tool.sensitive || firing(d, true, min) !== "fire") return;
  // Still nothing waiting for a yes or a no (one may have been asked while the router thought).
  if (pendingQuestion()) return;
  const outcome = await act(d, e.ask, { persona, memory, emit: () => {}, recentTranscript: [], situation: contextFor(persona).summary, minConfidence: min, origin: "scheduled" });
  // The card shows what changed; only an answer the tool wants said (a card read out) is spoken.
  if (outcome.ok && outcome.speak) tellEveryone(outcome.speak, "card_event");
}

function cardEvent(card: BoardCard, json: string): void {
  const event = JSON.parse(json) as unknown;
  const title = cardLine(card.title, 60);
  const what = whatOf(event);
  const line = `On card ${card.n} (“${title.replace(/[“”"]/g, "'")}”) the user ${what}.`;
  // To the agent only while no yes/no question waits (a press is never an answer to one), and only a few a minute.
  const mayAct = !pendingQuestion() && withinRate(`agent:${card.id}`, 2, 60_000) && withinRate("agent", 4, 60_000);
  const e: CardEvent = { cardId: card.id, n: card.n, title, what, event, line, ask: mayAct ? `I ${what} on card ${card.n}.` : null, at: Date.now() };
  // In the feed (the windows draw it as text).
  workspace.agent("tool", { tool: "card_event", text: line });
  for (const fn of listeners) {
    try {
      fn(e);
    } catch (err) {
      console.warn("[cards] card-event listener failed:", (err as Error).message);
    }
  }
  if (e.ask && router) {
    void router(e).catch((err: unknown) => console.warn(`[cards] card ${card.n}: its event went nowhere: ${(err as Error).message}`));
  }
}

workspace.onBoardEvent((evt) => {
  if (evt.op === "card_state") {
    const card = eventCard(evt);
    if (!card || jsonWithin(evt.state, BOARD_LIMITS.cardState) === null) return;
    if (!withinRate(`state:${card.id}`, 60, 60_000) || !withinRate("state", 300, 60_000)) return;
    keepState(card, evt.state);
    return;
  }
  if (evt.op === "card_event") {
    const card = eventCard(evt);
    const json = jsonWithin(evt.event, 2048);
    if (!card || json === null || card.kind !== "widget" || card.status !== "ready" || !card.html) return;
    if (!withinRate(`event:${card.id}`, 6, 60_000) || !withinRate("event", 12, 60_000)) return;
    cardEvent(card, json);
    return;
  }
  if (evt.op === "sizes") {
    // Heights a window measured, by card id: for placing cards next to each other without overlap.
    if (evt.sizes && typeof evt.sizes === "object" && !Array.isArray(evt.sizes) && withinRate("sizes", 120, 60_000)) noteCardHeights(evt.sizes as Record<string, unknown>);
    return;
  }
  if (evt.op === "card_error") {
    const card = eventCard(evt);
    const message = cardLine(evt.message, 300);
    if (!card || !message) return;
    if (!withinRate(`error:${card.id}`, 4, 60_000) || !withinRate("error", 24, 60_000)) return;
    console.warn(`[cards] card ${card.n}: its page reported a script error: ${message.slice(0, 160)}`);
    try {
      scriptError?.(card.id, message);
    } catch (err) {
      console.warn("[cards] script-error handler failed:", (err as Error).message);
    }
  }
});
