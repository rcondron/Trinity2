import { nanoid } from "nanoid";
import { announce, type Spoken } from "../services/voice-call.js";
import type { ToolContext } from "../types.js";
import { bg } from "../util/bg.js";

/**
 * News from work that finished after its tool had already answered (a skill forged, a content card
 * written): said in the live call if there is one; when there is none, or the caller cut it off, it's
 * Trinity's line in every open app (index.ts hands that in — the channel that asked may be gone by
 * now: a reload, a persona switch) or, with no fallback set, in the asking channel.
 */
let tellFallback: ((text: string, spoken: Spoken) => void) | null = null;

export function setTellFallback(fn: (text: string, spoken: Spoken) => void): void {
  tellFallback = fn;
}

export function tell(ctx: ToolContext, text: string, label = "tell"): void {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return;
  bg(label, async () => {
    const spoken = await announce(line);
    if (spoken === "said") return;
    if (tellFallback) tellFallback(line, spoken);
    else
      ctx.emit({
        type: "transcript",
        turn: { id: nanoid(8), speaker: "trinity", text: line, ts: Date.now(), proactive: true, ...(spoken === "cut" ? { cut: true } : {}) },
      });
  });
}
