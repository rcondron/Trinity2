/*
 * Commands into the cards on the open workspace windows, and their answers. The engine sends {id, n, op, arg}; the
 * board (workspace/board.ts) runs it on that card — a video or audio element, or a widget's own controls inside
 * its frame — and reports what actually happened, so Trinity only says "started the timer" when a Start control was
 * pressed. The same channel carries layouts the user makes by hand (dragging or resizing a card), which the engine
 * keeps so the next update doesn't snap the card back.
 */
import { nanoid } from "nanoid";
import { applyCardLayout, boardActive } from "./board.js";
import { workspace } from "./bus.js";

export type CardOp =
  | "play"
  | "pause"
  | "restart"
  | "reset"
  | "mute"
  | "unmute"
  | "louder"
  | "quieter"
  | "forward"
  | "back"
  | "next"
  | "previous"
  | "loop"
  | "no_loop"
  | "faster"
  | "slower"
  | "normal_speed"
  | "press"
  | "set"
  | "scroll_down"
  | "scroll_up"
  | "read"
  | "controls";

export interface MediaState {
  paused: boolean;
  t: number;
  dur: number;
  muted: boolean;
  volume: number;
  rate: number;
  loop: boolean;
}

export interface CardResult {
  n: number;
  ok: boolean;
  /** How it was done: "media", "hook", "click", "input", "scroll", "read". */
  via?: string;
  /** The control pressed or the field set. */
  label?: string;
  /** Already that way ("running", "paused"): nothing needed doing. */
  already?: string;
  /**
   * Why not: "no-window" (no workspace window open), "no-answer", "no-control", "no-field", "no-media", "blocked"
   * (the browser wants a click first), "external" (a web page in the card), "missing", "pending", "at-end", "error".
   */
  reason?: string;
  detail?: string;
  /** The card's controls, when none matched the request. */
  controls?: string[];
  /** read: the card's live text. */
  text?: string;
  media?: MediaState;
}

const pending = new Map<string, { n: number; resolve: (r: CardResult) => void; timer: ReturnType<typeof setTimeout> }>();

/** Run one command on card n in the open workspace windows; the first window to answer wins. */
export function sendCardCommand(n: number, op: CardOp, arg: unknown = null, timeoutMs = 2500): Promise<CardResult> {
  if (!boardActive()) return Promise.resolve({ n, ok: false, reason: "missing" });
  if (workspace.subscribers === 0) return Promise.resolve({ n, ok: false, reason: "no-window" });
  const id = nanoid(10);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ n, ok: false, reason: "no-answer" });
    }, timeoutMs);
    pending.set(id, { n, resolve, timer });
    workspace.command({ id, n, op, arg: arg ?? null });
  });
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A window's answer, kept to what the engine uses (it comes from a page the engine wrote, but stays bounded). */
function clean(n: number, e: Record<string, unknown>): CardResult {
  const media = e.media && typeof e.media === "object" ? (e.media as Record<string, unknown>) : null;
  return {
    n,
    ok: e.ok === true,
    via: str(e.via, 20),
    label: str(e.label, 80),
    already: str(e.already, 20),
    reason: str(e.reason, 30),
    detail: str(e.detail, 200),
    controls: Array.isArray(e.controls) ? e.controls.filter((c): c is string => typeof c === "string").slice(0, 30).map((c) => c.slice(0, 60)) : undefined,
    text: str(e.text, 4000),
    media: media
      ? {
          paused: media.paused === true,
          t: num(media.t),
          dur: num(media.dur),
          muted: media.muted === true,
          volume: num(media.volume),
          rate: num(media.rate) || 1,
          loop: media.loop === true,
        }
      : undefined,
  };
}

// Board events from the windows: command answers, and layouts the user made by hand.
workspace.onBoardEvent((evt) => {
  if (evt.op === "cmd_result") {
    const id = String(evt.id ?? "");
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(clean(waiting.n, evt));
    return;
  }
  if (evt.op === "layout") {
    const n = Number(evt.n);
    if (!Number.isInteger(n) || n < 1) return;
    const h = evt.h === null || evt.h === undefined ? null : Number(evt.h);
    applyCardLayout(n, { x: Number(evt.x), y: Number(evt.y), w: Number(evt.w), h: h !== null && Number.isFinite(h) ? h : null, z: Number(evt.z) });
  }
});
