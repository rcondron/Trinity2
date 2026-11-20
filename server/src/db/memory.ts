import path from "node:path";
import { customAlphabet } from "nanoid";
import { DATA_DIR } from "../config.js";
import type { MemoryDoc } from "../types.js";

/** A new memory's id. Letters and digits only: PouchDB refuses an id that starts with "_" (nanoid's own alphabet has one). */
export const newMemoryId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

/**
 * The memory store is the free-form "page database". Primary backing is PouchDB
 * (lightweight, CouchDB-compatible — lets us add multi-device sync later). If the
 * native adapter can't load, we fall back to an in-memory store so Trinity still
 * boots; memories just won't persist across restarts until Pouch is fixed.
 */
export interface MemoryStore {
  kind: "pouchdb" | "memory";
  put(doc: Omit<MemoryDoc, "_rev">): Promise<MemoryDoc>;
  get(id: string): Promise<MemoryDoc | null>;
  /** Newest first (optionally only one type). */
  recent(limit: number, opts?: { type?: MemoryDoc["type"] }): Promise<MemoryDoc[]>;
  all(): Promise<MemoryDoc[]>;
  /**
   * Relevance search: memories sharing a topic word (or a tag) with the query, ranked by
   * how rare the matched words are, then salience & recency. Nothing matches → []. An empty
   * query with `tags` lists the memories carrying those tags.
   */
  search(query: string, opts?: SearchOptions): Promise<MemoryDoc[]>;
  remove(id: string): Promise<void>;
}

export interface SearchOptions {
  tags?: string[];
  limit?: number;
  type?: MemoryDoc["type"];
}

export const MEMORY_TYPES: readonly MemoryDoc["type"][] = ["fact", "event", "preference", "summary", "note"];

/** Words that say nothing about a topic ("what's my …", "the user's …") — never a match on their own. */
const STOPWORDS = new Set(
  (
    "a an and any are as at be been but by can could did do does doing for from had has have he her hers him his how " +
    "i i'm if in into is it its just me my myself of on or our ours please she so some than that the their them then " +
    "there these they this those to too us was we were what when where which who whom whose why will with would you " +
    "your yours yourself am also about again tell remember recall said say saying know knew told caller callers user users"
  ).split(" "),
);

/** Topic words: lowercase, possessives dropped ("user's" → "user"), split on anything not a letter or digit. */
export function topicWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** "name" ~ "named", "color" ~ "colors", "dog" ~ "dogs" — but "car" never matches "carpet". */
function wordMatch(q: string, w: string): boolean {
  if (q === w || w === `${q}s` || q === `${w}s`) return true;
  return (q.length >= 4 && w.startsWith(q)) || (w.length >= 4 && q.startsWith(w));
}

// ─── Decay: a memory nobody asks about fades; one that is recalled is fresh again ─────────

const DAY_MS = 86_400_000;
/** A memory's weight halves every this many days since it was saved or last recalled… */
const HALF_LIFE_DAYS = 120;
/** …down to this share of its salience, never to nothing: an old fact still answers a direct question. */
const DECAY_FLOOR = 0.25;

/** When a memory was last fresh: saved, or recalled since (`meta.recalledAt`). */
export function lastFreshAt(d: MemoryDoc): number {
  const recalled = Number(d.meta?.recalledAt);
  return Math.max(d.ts, Number.isFinite(recalled) ? recalled : 0);
}

/** A memory's salience as it stands now: what it was given, faded by how long ago it was last fresh. */
export function effectiveSalience(d: MemoryDoc, now = Date.now()): number {
  const ageDays = Math.max(0, (now - lastFreshAt(d)) / DAY_MS);
  return d.salience * (DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
}

/** These memories were just used to answer the user: their clock starts again (and they count as a little more important). */
export async function markRecalled(store: MemoryStore, docs: MemoryDoc[], now = Date.now()): Promise<void> {
  for (const d of docs) {
    try {
      const current = await store.get(d._id);
      if (!current) continue;
      const { _rev: _r, ...rest } = current;
      await store.put({
        ...rest,
        salience: Math.min(1, Math.round((current.salience + 0.02) * 100) / 100),
        meta: { ...(current.meta ?? {}), recalledAt: now, recalls: (Number(current.meta?.recalls) || 0) + 1 },
      });
    } catch {
      /* a memory deleted meanwhile, or a write that lost a race: nothing to refresh */
    }
  }
}

/** The day a memory is about, as said to a model or shown: "3 Nov 2026" (its own date when it has one, else when it was saved). */
export function memoryDate(d: MemoryDoc): string {
  // (A plain day — "2026-12-12" — is that day here, not midnight UTC, which is the evening before west of Greenwich.)
  const day = typeof d.meta?.date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.meta.date) : null;
  const own = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : typeof d.meta?.date === "string" ? Date.parse(d.meta.date) : NaN;
  const at = Number.isFinite(own) ? own : d.ts;
  if (!at) return "";
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ─── Duplicates and subjects ──────────────────────────────────────────────────────────────

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));

/** Jaccard token overlap of two texts (0–1). */
export function tokenOverlap(a: string, b: string): number {
  const sa = tokens(a);
  const sb = tokens(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const numbersIn = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).join(" ");
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Two memories that say the same thing: the same words, or nearly (never two that differ in a number: "2 cats" / "3 cats"). */
export function sameFact(a: string, b: string): boolean {
  if (plain(a) === plain(b)) return true;
  return numbersIn(a) === numbersIn(b) && tokenOverlap(a, b) >= 0.85;
}

/** Tags that say where a memory came from, not what it is about. */
const SOURCE_TAGS = new Set(["user", "explicit", "profile", "curated", "reflect", "fact", "preference", "event", "note"]);
const subjectWords = (d: Pick<MemoryDoc, "tags" | "meta">) =>
  new Set([...topicWords(typeof d.meta?.subject === "string" ? d.meta.subject : ""), ...d.tags.map((t) => t.toLowerCase()).filter((t) => !SOURCE_TAGS.has(t))]);

/**
 * Memories about the same subject as a new fact — what it must be compared with before it is saved, so "The user
 * lives in Austin." meets "The user lives in Denver." even when the user's own sentence ("I moved to Austin")
 * shares no word with the old memory. Found by the subject and topic tags the fact was given, then by the words
 * of the fact itself.
 */
export async function relatedBySubject(store: MemoryStore, fact: { text: string; subject?: string; tags?: string[] }, limit = 8): Promise<MemoryDoc[]> {
  const want = new Set([...topicWords(fact.subject ?? ""), ...(fact.tags ?? []).map((t) => t.toLowerCase()).filter((t) => !SOURCE_TAGS.has(t))]);
  const all = await store.all();
  const scored = all
    .map((d) => {
      const have = subjectWords(d);
      let s = 0;
      for (const w of want) if ([...have].some((h) => wordMatch(w, h))) s++;
      return { d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.d.ts - a.d.ts)
    .map((x) => x.d);
  const lexical = rank(all, `${fact.text} ${fact.subject ?? ""} ${(fact.tags ?? []).join(" ")}`, { limit });
  const seen = new Set<string>();
  return [...scored, ...lexical].filter((d) => !seen.has(d._id) && seen.add(d._id)).slice(0, limit);
}

/**
 * Merge memories that say the same thing: the newest wording stays, with the tags of all of them, the highest
 * salience and the earliest date; the others go. Memories that only resemble each other are left alone.
 */
export async function consolidateMemories(store: MemoryStore): Promise<{ merged: number; kept: string[] }> {
  const docs = (await store.all()).filter((d) => d.type !== "summary").sort((a, b) => b.ts - a.ts);
  const keepers: MemoryDoc[] = [];
  const changed = new Map<string, MemoryDoc>();
  let merged = 0;
  for (const d of docs) {
    const twin = keepers.find((k) => sameFact(k.text, d.text));
    if (!twin) {
      keepers.push(d);
      continue;
    }
    const base = changed.get(twin._id) ?? twin;
    const next: MemoryDoc = {
      ...base,
      tags: [...new Set([...base.tags, ...d.tags])].slice(0, 12),
      salience: Math.max(base.salience, d.salience),
      meta: {
        ...(d.meta ?? {}),
        ...(base.meta ?? {}),
        firstSavedAt: Math.min(Number(base.meta?.firstSavedAt) || base.ts, Number(d.meta?.firstSavedAt) || d.ts),
        recalledAt: Math.max(Number(base.meta?.recalledAt) || 0, Number(d.meta?.recalledAt) || 0) || undefined,
        merged: (Number(base.meta?.merged) || 0) + 1,
      },
    };
    changed.set(twin._id, next);
    await store.remove(d._id);
    merged++;
  }
  for (const doc of changed.values()) {
    const { _rev: _r, ...rest } = doc;
    await store.put(rest);
  }
  return { merged, kept: [...changed.keys()] };
}

function rank(docs: MemoryDoc[], query: string, opts: SearchOptions): MemoryDoc[] {
  const pool = opts.type ? docs.filter((d) => d.type === opts.type) : docs;
  const terms = [...new Set(topicWords(query))];
  const wantTags = (opts.tags ?? []).map((t) => t.toLowerCase());
  if (!terms.length && !wantTags.length) return [];
  const words = new Map(pool.map((d) => [d._id, [...new Set(topicWords(`${d.text} ${d.tags.join(" ")}`))]]));
  const hits = (d: MemoryDoc, t: string) => (words.get(d._id) ?? []).some((w) => wordMatch(t, w));
  // Rarer words count more: "Denver" says more than "favorite".
  const idf = new Map(terms.map((t) => [t, 1 + Math.log(pool.length / Math.max(1, pool.filter((d) => hits(d, t)).length))]));
  const now = Date.now();
  return pool
    .map((d) => {
      const tags = d.tags.map((t) => t.toLowerCase());
      let s = 0;
      for (const t of terms) if (hits(d, t)) s += idf.get(t) ?? 1;
      for (const t of wantTags) if (tags.includes(t)) s += 2;
      if (s === 0) return { d, s };
      // light nudges so ties resolve sensibly: how much the memory still weighs (its salience, faded by age
      // unless it was recalled), and how recently it was fresh
      const ageDays = (now - lastFreshAt(d)) / DAY_MS;
      return { d, s: s + effectiveSalience(d, now) * 0.3 + Math.max(0, 1 - ageDays / 30) * 0.2 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.limit ?? 8)
    .map((x) => x.d);
}

function newestFirst(docs: MemoryDoc[], limit: number, type?: MemoryDoc["type"]): MemoryDoc[] {
  return (type ? docs.filter((d) => d.type === type) : docs).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

class InMemoryStore implements MemoryStore {
  kind = "memory" as const;
  private map = new Map<string, MemoryDoc>();
  async put(doc: Omit<MemoryDoc, "_rev">) {
    const saved = { ...doc, _rev: String((this.map.get(doc._id)?.ts ?? 0) + 1) };
    this.map.set(doc._id, saved);
    return saved;
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async all() {
    return [...this.map.values()];
  }
  async recent(limit: number, opts: { type?: MemoryDoc["type"] } = {}) {
    return newestFirst(await this.all(), limit, opts.type);
  }
  async search(query: string, opts: SearchOptions = {}) {
    return rank(await this.all(), query, opts);
  }
  async remove(id: string) {
    this.map.delete(id);
  }
}

class PouchStore implements MemoryStore {
  kind = "pouchdb" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private pdb: any) {}
  async put(doc: Omit<MemoryDoc, "_rev">) {
    const existing = await this.get(doc._id);
    const res = await this.pdb.put(existing ? { ...doc, _rev: existing._rev } : doc);
    return { ...doc, _rev: res.rev } as MemoryDoc;
  }
  async get(id: string) {
    try {
      return (await this.pdb.get(id)) as MemoryDoc;
    } catch {
      return null;
    }
  }
  async all() {
    const res = await this.pdb.allDocs({ include_docs: true });
    // (Design documents aren't memories.)
    return res.rows
      .map((r: { doc: MemoryDoc }) => r.doc)
      .filter((d: MemoryDoc | undefined) => d && !d._id.startsWith("_design/")) as MemoryDoc[];
  }
  async recent(limit: number, opts: { type?: MemoryDoc["type"] } = {}) {
    return newestFirst(await this.all(), limit, opts.type);
  }
  async search(query: string, opts: SearchOptions = {}) {
    return rank(await this.all(), query, opts);
  }
  async remove(id: string) {
    const doc = await this.get(id);
    if (doc?._rev) await this.pdb.remove(id, doc._rev);
  }
}

/**
 * Memories used to be written about "the caller"; the app now says "the user" everywhere, so the saved
 * ones follow. Runs at every start; it only touches a memory that still has the old word. Returns how
 * many changed.
 */
export async function rewordCallerMemories(store: MemoryStore): Promise<number> {
  let changed = 0;
  for (const doc of await store.all()) {
    const text = doc.text.replace(/\b(the|The|THE) caller(s?)\b/g, (_m, the: string, s: string) => `${the} ${the === "THE" ? "USER" : "user"}${s}`);
    if (text === doc.text) continue;
    const { _rev: _r, ...rest } = doc;
    await store.put({ ...rest, text });
    changed++;
  }
  return changed;
}

let shared: MemoryStore | null = null;

/**
 * The engine's memory store, for work that has no tool context to take it from: reflection when a session ends
 * or at night, a paused problem-solver run picked up again. Null until the store is created (index.ts does at boot).
 */
export function sharedMemory(): MemoryStore | null {
  return shared;
}
export function setSharedMemory(store: MemoryStore): void {
  shared = store;
}

export async function createMemoryStore(): Promise<MemoryStore> {
  const store = await openMemoryStore();
  shared = store;
  return store;
}

async function openMemoryStore(): Promise<MemoryStore> {
  try {
    const PouchDB = (await import("pouchdb")).default;
    const pdb = new PouchDB(path.join(DATA_DIR, "memory"));
    try {
      await pdb.info(); // open now so a held LOCK fails here, with a clear message
    } catch (err) {
      if (/LOCK/i.test((err as Error).message)) {
        throw Object.assign(
          new Error(
            "data/memory is locked by another Trinity engine that is still running. " +
              "Stop it (or run `node scripts/free-ports.mjs`) and start again.",
          ),
          { fatal: true },
        );
      }
      throw err;
    }
    console.log("[memory] using PouchDB store");
    return new PouchStore(pdb);
  } catch (err) {
    if ((err as { fatal?: boolean }).fatal) throw err;
    console.warn(
      "[memory] PouchDB unavailable, falling back to in-memory store (no persistence):",
      (err as Error).message,
    );
    return new InMemoryStore();
  }
}
