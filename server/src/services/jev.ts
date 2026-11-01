import { getEndpoints, live } from "../settings.js";
import type { MemoryDoc, Tool, TranscriptTurn } from "../types.js";

/**
 * Jev (TypeSafe AI) helpers outside the router. Routing itself lives in
 * agent/router.ts; this file keeps Jev-based memory selection and the heuristic
 * argument filler used as a fallback when the fast model is unavailable.
 */

/**
 * Jev-selected recall: given keyword-prefiltered candidate memories, ask Jev (one
 * `noul` question per candidate, batched) which are actually relevant to the current
 * turn. Falls back to the top keyword matches when Jev isn't available.
 */
export async function selectMemories(
  input: { userText: string; transcript: TranscriptTurn[] },
  candidates: MemoryDoc[],
): Promise<MemoryDoc[]> {
  if (candidates.length === 0) return [];
  if (!live.jev) return candidates.slice(0, 4);

  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  candidates.forEach((d, i) => {
    questions[`m${i}`] = {
      type: "noul",
      instructions: `This stored memory is relevant to the user's latest message and worth recalling now: "${d.text}"`,
    };
  });
  const state =
    input.transcript.slice(-4).map((t) => `${t.speaker}: ${t.text}`).join("\n") +
    `\nlatest user turn: ${input.userText}`;

  const ep = getEndpoints();
  try {
    const res = await fetch(`${ep.typesafeUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.typesafeKey}` },
      body: JSON.stringify({ model: ep.jevModel, state, questions }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    const kept = candidates.filter((_, i) => (data.answers?.[`m${i}`]?.noul ?? 0) > 0.5);
    return kept.slice(0, 5);
  } catch (err) {
    console.warn("[jev] memory selection failed, using top matches:", (err as Error).message);
    return candidates.slice(0, 4);
  }
}

/** Best-effort argument filler (fallback when the fast model can't extract arguments). */
export function inferArgs(tool: Tool, text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let ni = 0;
  // Only the first text argument gets the whole sentence (a query, a note). Repeating it in
  // every text argument ("from", "to", "city") would hand a skill nonsense instead of "missing".
  let textUsed = false;
  for (const [key, spec] of Object.entries(tool.input)) {
    if (spec.type === "number" || spec.type === "integer") {
      if (ni < numbers.length) args[key] = numbers[ni++];
    } else if (spec.type === "boolean") {
      args[key] = /\b(yes|true|on|enable|please)\b/i.test(text);
    } else if (/notation|dice/i.test(key)) {
      const m = text.toLowerCase().match(/\d*d\d+([+-]\d+)?/);
      args[key] = m ? m[0] : text;
    } else if (!textUsed && spec.type !== "array" && spec.type !== "object") {
      args[key] = text;
      textUsed = true;
    }
  }
  return args;
}
