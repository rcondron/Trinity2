import { getSetting, setSetting } from "../db/sqlite.js";

/**
 * How fast Trinity's voice plays back. PersonaPlex itself has a fixed cadence; we store a
 * rate here and the browser stretches/compresses PCM (and browser-TTS rate) to match.
 * 1 = normal, below 1 slower, above 1 faster. Clamped to a natural range.
 */

export const SPEECH_RATE_MIN = 0.7;
export const SPEECH_RATE_MAX = 1.4;
export const SPEECH_RATE_DEFAULT = 1;

type Listener = (rate: number) => void;
const listeners = new Set<Listener>();

export function getSpeechRate(): number {
  const raw = Number(getSetting("speech_rate"));
  if (!Number.isFinite(raw)) return SPEECH_RATE_DEFAULT;
  return clampRate(raw);
}

export function setSpeechRate(rate: number): number {
  const next = clampRate(rate);
  setSetting("speech_rate", String(next));
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* ignore */
    }
  }
  return next;
}

/** Notify live /call sessions (and anyone else) when the rate changes. */
export function onSpeechRateChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clampRate(n: number): number {
  return Math.round(Math.max(SPEECH_RATE_MIN, Math.min(SPEECH_RATE_MAX, n)) * 100) / 100;
}

/** Parse "slower", "a bit faster", "slow down", "1.2x", "half speed" from the user's words. */
export function parseSpeechRateIntent(utterance: string, current = getSpeechRate()): number | null {
  const u = utterance.toLowerCase().replace(/\s+/g, " ").trim();
  if (!/\b(slow|fast|quicker|slower|faster|speed|pace|tempo)\b/.test(u)) return null;

  const abs = /\b(\d(?:\.\d+)?)\s*x\b|\bat\s+(\d(?:\.\d+)?)\b|\b(\d{2,3})\s*%/.exec(u);
  if (abs) {
    if (abs[3]) return clampRate(Number(abs[3]) / 100);
    return clampRate(Number(abs[1] || abs[2]));
  }
  if (/\b(normal|default|reset)\b/.test(u) && /\b(speed|pace|tempo|rate)\b/.test(u)) return SPEECH_RATE_DEFAULT;
  if (/\bhalf(\s*-?\s*speed)?\b/.test(u)) return clampRate(0.75);

  const mild = /\b(a little|a bit|slightly|somewhat)\b/.test(u);
  const strong = /\b(much|way|a lot|really|lots?)\b/.test(u);
  const slower = /\b(slow(?:er|down)?|less quick)\b/.test(u);
  const faster = /\b(fast(?:er)?|quicker|speed up|hurry)\b/.test(u);
  if (slower === faster) return null;
  const step = strong ? 0.2 : mild ? 0.08 : 0.15;
  return clampRate(current + (faster ? step : -step));
}

export function describeSpeechRate(rate = getSpeechRate()): string {
  if (Math.abs(rate - 1) < 0.03) return "normal speed";
  if (rate < 1) return `${Math.round((1 - rate) * 100)}% slower than normal`;
  return `${Math.round((rate - 1) * 100)}% faster than normal`;
}
