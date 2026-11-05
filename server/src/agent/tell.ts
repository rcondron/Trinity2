import { nanoid } from "nanoid";
import { announce, type Spoken } from "../services/voice-call.js";
import type { ToolContext } from "../types.js";
import { bg } from "../util/bg.js";

/**
 * News from work that finished after its tool had already answered (a skill forged, a content card
 * written): said in the live call if there is one that can be heard; when there is none (it's owed:
 * the next one says it), or the user cut it off, it's Trinity's line in every open app (index.ts
 * hands that in — the channel that asked may be gone by now: a reload, a persona switch) or, with
 * no fallback set, in the asking channel. `id` is the turn it's shown as.
 */
let tellFallback: ((text: string, spoken: Spoken, id: string) => void) | null = null;

export function setTellFallback(fn: (text: string, spoken: Spoken, id: string) => void): void {
  tellFallback = fn;
}

/** The same, from somewhere with no tool context (a share from the browser): the live call, else every open app. */
export function tellEveryone(text: string, label = "tell"): void {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return;
  bg(label, async () => {
    const id = nanoid(8);
    const spoken = await announce(line, id);
    if (spoken === "said") return;
    if (tellFallback) tellFallback(line, spoken, id);
    else console.log(`[${label}] ${line}`);
  });
}

export function tell(ctx: ToolContext, text: string, label = "tell"): void {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return;
  bg(label, async () => {
    const id = nanoid(8);
    const spoken = await announce(line, id);
    if (spoken === "said") return;
    if (tellFallback) tellFallback(line, spoken, id);
    else
      ctx.emit({
        type: "transcript",
        turn: {
          id,
          speaker: "trinity",
          text: line,
          ts: Date.now(),
          proactive: true,
          ...(spoken === "cut" ? { cut: true } : {}),
          ...(spoken === "owed" ? { owed: true } : {}),
        },
      });
  });
}
