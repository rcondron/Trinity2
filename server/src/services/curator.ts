import { cleanProfileName, getProfileName, setProfileName } from "../db/sqlite.js";
import { newMemoryId, type MemoryStore } from "../db/memory.js";
import { getEndpoints, live } from "../settings.js";
import type { MemoryDoc } from "../types.js";
import { mordiemChat } from "./llm.js";

export type ExtractedMemory = Pick<MemoryDoc, "type" | "text" | "tags" | "salience"> & {
  /** Id of a known memory this one updates ("now prefers tea" over "prefers coffee"). */
  replaces?: string;
  /** The user's own name, when they said it. */
  name?: string;
};

const TYPES: MemoryDoc["type"][] = ["fact", "event", "preference", "summary", "note"];

/**
 * A tool already acted on the user's request in this exchange: the request itself (a reminder
 * just set, a question just answered from memory) isn't a memory — but anything else they said
 * in the same breath ("I'm Ryan, remind me at five…") still is.
 */
export type Handled = "schedule" | "recall";
const HANDLED: Record<Handled, string> = {
  schedule: "The assistant has already set the reminder or scheduled task the user asked for: don't save that reminder, task or plan.",
  recall: "The assistant has already answered the user's question from memory: don't save the question or its answer.",
};

/**
 * How auto-curation treats an exchange that tools acted on (`fired`: each action, and whether
 * it worked). A remember that worked already saved what the user said, their name too: the
 * exchange is skipped. After schedule or recall the request itself is handled, but anything else
 * the user said is still curated (see Handled). Otherwise it's curated as usual (null).
 */
export function curationAfter(fired: { action: string; ok: boolean }[]): "skip" | Handled | null {
  if (fired.some((f) => f.action === "remember" && f.ok)) return "skip";
  return fired.find((f): f is { action: Handled; ok: boolean } => f.action === "schedule" || f.action === "recall")?.action ?? null;
}

/**
 * Auto-curation: after an exchange, ask the brain to extract any DURABLE facts,
 * preferences, or commitments about the user worth remembering long-term —
 * ignoring pleasantries, ephemera, and what's already known (`known`, which it may
 * update instead). Returns a (possibly empty) list; never throws.
 */
export async function extractMemories(
  userText: string,
  trinityText: string,
  known: MemoryDoc[] = [],
  opts: CurateOptions = {},
): Promise<ExtractedMemory[]> {
  if (!live.brain) return [];
  const ids = known.map((d, i) => [`k${i + 1}`, d] as const);
  // (In a call the agent's line is the one the user was answering; in text it's the reply to them.)
  const assistant = trinityText.trim() ? (opts.agentFirst ? `Assistant (just before): ${trinityText}\n` : `\nAssistant: ${trinityText}`) : "";
  const prompt =
    `From this exchange, extract any durable facts, preferences, plans, or commitments ` +
    `about the USER that are worth remembering in future conversations. Ignore greetings, ` +
    `questions, and anything ephemeral. Take them only from what the user says: the assistant's ` +
    `words help you understand the user, but nothing the assistant says (a reminder it set, a plan ` +
    `it confirms) is a memory. Skip what the known memories already say; if the user ` +
    `changed one of them, return the new version with "replaces" set to its id. If the user says ` +
    `their own name, always include it as a fact with "name" set to just the name, even when a known memory ` +
    `already says it. If nothing is worth keeping, return [].\n\n` +
    (opts.handled ? `${HANDLED[opts.handled]} Keep only other lasting facts about the user (their name included).\n\n` : "") +
    `Return ONLY a JSON array (max 3, not counting the user's name) of objects: ` +
    `{"type":"fact|preference|event|note","text":"<one concise third-person sentence about the user, e.g. The user's sister Maya lives in Denver.>","tags":["..."],"salience":0.0-1.0,"replaces":null,"name":null}.\n\n` +
    `Known memories:\n${ids.map(([id, d]) => `[${id}] ${d.text}`).join("\n") || "(none)"}\n\n` +
    (opts.agentFirst ? `${assistant}User: ${userText}` : `User: ${userText}${assistant}`);
  try {
    const raw = await mordiemChat(
      getEndpoints().brainModel,
      [
        { role: "system", content: "You extract durable memories as strict JSON. Output ONLY the JSON array, nothing else." },
        { role: "user", content: prompt },
      ],
      { maxTokens: 500, temperature: 0, timeoutMs: 30_000 },
    );
    const byId = new Map<string, MemoryDoc>(ids);
    const found = parseJsonArray(raw).filter((m) => Boolean(m && typeof m.text === "string" && m.text.trim()));
    // Three at most, besides the user's name: it's asked for even when a known memory says it, so it
    // mustn't push a new fact out.
    const named = found.find((m) => typeof m.name === "string" && m.name.trim());
    const others = found.filter((m) => m !== named).slice(0, 3);
    return found
      .filter((m) => m === named || others.includes(m))
      .map((m) => ({
        type: (TYPES.includes(m.type as MemoryDoc["type"]) ? m.type : "note") as MemoryDoc["type"],
        text: String(m.text).trim().slice(0, 400).replace(/([^.!?])$/, "$1."),
        tags: Array.isArray(m.tags) ? m.tags.map((t) => String(t).toLowerCase()).slice(0, 6) : ["user"],
        salience: typeof m.salience === "number" ? Math.max(0, Math.min(1, m.salience)) : 0.6,
        replaces: typeof m.replaces === "string" ? byId.get(m.replaces)?._id : undefined,
        name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined,
      }));
  } catch (err) {
    console.warn("[curator] extraction failed:", (err as Error).message);
    return [];
  }
}

export interface CurateOptions {
  /** A tool already acted on the request (see Handled). */
  handled?: Handled;
  /** The agent's line came before the user's words (a call: the line they were answering), not after (a typed reply). */
  agentFirst?: boolean;
}

/**
 * Curate one exchange into the store: extract, then save what's new — a memory that updates
 * a known one replaces it, a near-duplicate is skipped — and keep the profile name in step
 * when the user says theirs. Returns the docs written (for the channel's memory events).
 */
export async function curateExchange(
  memory: MemoryStore,
  userText: string,
  trinityText: string,
  opts: CurateOptions = {},
): Promise<MemoryDoc[]> {
  const known = await memory.search(`${userText} ${trinityText}`, { limit: 6 });
  const items = await extractMemories(userText, trinityText, known, opts);
  // Their name is one memory (see nameMemory): the item that states it, else "The user's name is …".
  // An item that only mentions it ("The user, Rob, works as a nurse.") is a fact of its own.
  const name = items.find((m) => m.name)?.name;
  const before = getProfileName();
  if (name && name !== before) setProfileName(name);
  if (name && !items.some((m) => statesOwnName(m.text, name)))
    items.push({ type: "fact", text: `The user's name is ${name}.`, tags: ["name"], salience: 0.9 });
  const written: MemoryDoc[] = [];
  const ids = new Set<string>(); // saved in this call
  for (const m of items) {
    const { replaces, name: _said, ...fields } = m;
    // A new name replaces the name memory; the same name again leaves it as it is.
    const ownName = Boolean(name) && statesOwnName(m.text, name!);
    const own = ownName ? await nameMemory(memory) : null;
    if (own && saysName(own.text, name!)) continue;
    const target = own ?? (replaces ? await memory.get(replaces) : null);
    if (!target) {
      const near = await memory.search(m.text, { limit: 1 });
      if (near[0] && tokenOverlap(near[0].text, m.text) > 0.6) continue;
    }
    // One update per memory: a second item aimed at one this call already saved gets its own.
    const old = target && !ids.has(target._id) ? target : null;
    // A name memory that says more than the name keeps it, with just the name changed (see renamedText).
    const kept = own && old === own && !isBareName(own.text) ? own : null;
    const saved = await memory.put({
      _id: old?._id ?? newMemoryId(),
      ts: Date.now(),
      ...fields,
      text: kept ? renamedText(kept.text, before, name!, fields.text) : fields.text,
      tags: [...new Set([...(kept ? withoutNameTags(kept.tags, before, name) : []), ...fields.tags, ...(ownName ? ["name"] : [])])],
      meta: { ...(old?.meta ?? {}), source: "curated" },
    });
    ids.add(saved._id);
    written.push(saved);
  }
  return written;
}

function parseJsonArray(raw: string): Partial<Record<keyof ExtractedMemory, unknown>>[] {
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

/** A name as a word of its own in a text: "Rob" in "…is Rob, and…", never in "Robert". */
const nameWord = (name: string, flags = "u") =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, flags);

/** Whether a memory says this name as a word of its own: "The user's name is Rob." says "Rob" (not "Ro"). */
function saysName(text: string, name: string): boolean {
  return nameWord(name).test(text);
}

/**
 * "The user's name is …", "The user goes by …": the user's own name, never someone else's ("The user's son is
 * named Ryan Jr."). (Older memories say "The user's name is …".)
 */
const OWN_NAME = /\b(?:caller|user)(?:['’]s (?:first |full |real |preferred )?name is| goes by| is called| is named(?! after)| prefers to be called)\b/i;
const OWN_NAME_IS = "The (?:caller|user)(?:['’]s (?:first |full |real |preferred )?name is| goes by| is called| is named| prefers to be called)";
/** A name as written: its first word, then any capitalized ones ("Ana María", "J. R. Smith", "Juan de la Cruz"). */
const NAME_SAID = "[\\p{L}'’.-]+(?:\\s+(?:\\p{Lu}[\\p{L}'’.-]*|de|da|del|di|du|la|le|van|von|der|bin|ibn|al|el))*";
/** A memory that states the user's name and nothing else: "The user's name is Ana María.", "The user goes by Rob." */
const BARE_NAME = new RegExp(`^${OWN_NAME_IS} (?:\\p{Lu}[\\p{L}'’.-]*(?: (?:\\p{Lu}[\\p{L}'’.-]*|de|da|del|di|du|la|le|van|von|der|bin|ibn|al|el)){0,3}|[\\p{L}'’-]+)\\.?$`, "u");

/** Whether a memory states the user's own name (when given, this one). */
export function statesOwnName(text: string, name?: string): boolean {
  return OWN_NAME.test(text) && (!name || saysName(text, name));
}

/** Whether a memory says nothing but the user's name (see BARE_NAME) — one that carries other facts too isn't. */
export function isBareName(text: string): boolean {
  return BARE_NAME.test(text.trim());
}

/** The name a memory states as the user's own: "The user's name is Ryan, and he works nights." → "Ryan". */
export function ownNameIn(text: string): string | null {
  const said = new RegExp(`\\b(?:[Cc]aller|[Uu]ser)(?:['’]s (?:first |full |real |preferred )?name is| goes by| is called| is named(?! after)| prefers to be called)\\s+(${NAME_SAID})`, "u")
    .exec(text)?.[1]
    // (A sentence that ends after the name isn't more of it: "…is Ryan. He works nights." A title's dot ends
    // nothing: "Dr. Smith".)
    ?.replace(/(?<!\p{L})(?!(?:dr|mr|mrs|ms|mx|prof|rev|fr|st)\.)(\p{L}{2,})\.\s.*$/iu, "$1");
  const name = said ? cleanProfileName(said) : null;
  // (No name at all: "…name is not shared", "…name is unknown".)
  return name && !/^(?:by|their|his|her|the|a|an|my|your|not|unknown|unclear|undisclosed|private|secret|anonymous|withheld)$/i.test(name) ? name : null;
}

/**
 * The user's name memory restated for a new name: one that says nothing else becomes `statement` ("The user
 * goes by Rob."); one that also carries other facts ("The user's name is Ryan, and he works nights as a nurse.")
 * keeps them, with the old name (`from`, else the one it states) swapped for the new one inside it.
 */
export function renamedText(text: string, from: string | null, to: string, statement: string): string {
  if (isBareName(text)) return statement;
  // Only the name it states as theirs ("…and his son is Ryan Jr." keeps the son's).
  const start = OWN_NAME.exec(text)?.index ?? 0;
  const tail = text.slice(start);
  const old = from && saysName(tail, from) ? from : ownNameIn(text);
  const at = old ? tail.search(nameWord(old)) : -1;
  // (No name to swap in it: the new one goes first, and nothing it said is lost.)
  return at < 0 ? `${statement} ${text}` : `${text.slice(0, start + at)}${to}${tail.slice(at + old!.length)}`;
}

/**
 * The user's name memory once they've cleared their name: null when it said nothing else (it goes); one that also
 * carries other facts keeps them without its own-name clause ("The user's name is Ryan, and he works nights." →
 * "The user works nights."). One that can't be taken apart stays as it is.
 */
export function unnamedText(text: string): string | null {
  if (isBareName(text)) return null;
  if (!ownNameIn(text)) return text;
  // The clause, up to what else it says: after a comma or a full stop, or an "and", "who", "from"…
  const clause = new RegExp(
    `^${OWN_NAME_IS}\\s+${NAME_SAID}(?:\\s*[,;:–-]\\s*|\\s*\\.\\s+|\\s+(?=(?:and|but|who|which|from|in|at|of|a|an|the)\\b))` +
      `(?:(?:and|but|who|which)\\s+)?(?:(?:[Hh]e|[Ss]he|[Tt]hey)(?:['’](?:s|re))?\\s+)?`,
    "u",
  ).exec(text);
  if (!clause) {
    // (A word or two after the name — "…goes by Rob these days." — say nothing else; more is kept as it is.)
    const named = new RegExp(`^${OWN_NAME_IS}\\s+${NAME_SAID}`, "u").exec(text);
    return named && text.slice(named[0].length).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length <= 2 ? null : text;
  }
  const rest = text.slice(clause[0].length).trim();
  if (!rest || /^[.!?]*$/.test(rest)) return null;
  if (/^(?:a|an|the|from|in|at|of)\b/i.test(rest)) return `The user is ${rest}`;
  if (/^(?:his|her|their)\s/i.test(rest)) return `The user's ${rest.replace(/^\S+\s+/, "")}`;
  return `The user ${rest}`;
}

/** Tags without the old name's own ("ryan" on a memory that now says Rob). */
export function withoutNameTags(tags: string[], from: string | null, to: string | null = null): string[] {
  const words = (n: string | null) => (n ? [n, ...n.split(/\s+/)].map((w) => w.toLowerCase()) : []);
  const keep = new Set([...words(to), "name"]);
  const stale = new Set(words(from).filter((w) => !keep.has(w)));
  return tags.filter((t) => !stale.has(t.toLowerCase()));
}

/**
 * The memory holding the user's own name: one tagged "name" that states it ("The user's name is
 * Rob.", "The user goes by Rob."). One about someone else ("The user's son is named Ryan Jr.")
 * or one that only mentions it ("The user, Rob, works as a nurse.") isn't it.
 */
export async function nameMemory(memory: MemoryStore): Promise<MemoryDoc | null> {
  const tagged = await memory.search("", { tags: ["name"], limit: 20 });
  return tagged.find((d) => statesOwnName(d.text)) ?? null;
}
