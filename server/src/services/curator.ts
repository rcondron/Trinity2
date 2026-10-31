import { getEndpoints, live } from "../settings.js";
import type { MemoryDoc } from "../types.js";
import { mordiemChat } from "./llm.js";

export type ExtractedMemory = Pick<MemoryDoc, "type" | "text" | "tags" | "salience">;

/**
 * Auto-curation: after an exchange, ask the brain to extract any DURABLE facts,
 * preferences, or commitments about the user worth remembering long-term —
 * ignoring pleasantries and ephemera. Returns a (possibly empty) list; never throws.
 */
export async function extractMemories(userText: string, trinityText: string): Promise<ExtractedMemory[]> {
  if (!live.brain) return [];
  const prompt =
    `From this exchange, extract any durable facts, preferences, plans, or commitments ` +
    `about the USER that are worth remembering in future conversations. Ignore greetings, ` +
    `questions, and anything ephemeral. If nothing is worth keeping, return [].\n\n` +
    `Return ONLY a JSON array (max 3) of objects: ` +
    `{"type":"fact|preference|event|note","text":"<concise, third-person>","tags":["..."],"salience":0.0-1.0}.\n\n` +
    `User: ${userText}\nAssistant: ${trinityText}`;
  try {
    const raw = await mordiemChat(
      getEndpoints().brainModel,
      [
        { role: "system", content: "You extract durable memories as strict JSON. Output ONLY the JSON array, nothing else." },
        { role: "user", content: prompt },
      ],
      { maxTokens: 400, temperature: 0 },
    );
    const arr = parseJsonArray(raw);
    return arr
      .filter((m): m is ExtractedMemory => Boolean(m && typeof m.text === "string" && m.text.trim()))
      .slice(0, 3)
      .map((m) => ({
        type: (["fact", "event", "preference", "summary", "note"].includes(m.type as string) ? m.type : "note") as MemoryDoc["type"],
        text: m.text.trim(),
        tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 6) : ["user"],
        salience: typeof m.salience === "number" ? Math.max(0, Math.min(1, m.salience)) : 0.6,
      }));
  } catch (err) {
    console.warn("[curator] extraction failed:", (err as Error).message);
    return [];
  }
}

function parseJsonArray(raw: string): Partial<ExtractedMemory>[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Jaccard token overlap, for de-duplicating against existing memories. */
export function tokenOverlap(a: string, b: string): number {
  const toks = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const sa = toks(a);
  const sb = toks(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
