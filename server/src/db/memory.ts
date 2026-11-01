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

/** Words that say nothing about a topic ("what's my …", "the caller's …") — never a match on their own. */
const STOPWORDS = new Set(
  (
    "a an and any are as at be been but by can could did do does doing for from had has have he her hers him his how " +
    "i i'm if in into is it its just me my myself of on or our ours please she so some than that the their them then " +
    "there these they this those to too us was we were what when where which who whom whose why will with would you " +
    "your yours yourself am also about again tell remember recall said say saying know knew told caller callers user users"
  ).split(" "),
);

/** Topic words: lowercase, possessives dropped ("caller's" → "caller"), split on anything not a letter or digit. */
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
      // light salience + recency nudges so ties resolve sensibly
      const ageDays = (now - d.ts) / 86_400_000;
      return { d, s: s + d.salience * 0.3 + Math.max(0, 1 - ageDays / 30) * 0.2 };
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

export async function createMemoryStore(): Promise<MemoryStore> {
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
