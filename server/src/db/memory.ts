import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { MemoryDoc } from "../types.js";

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
  recent(limit: number): Promise<MemoryDoc[]>;
  all(): Promise<MemoryDoc[]>;
  /** Simple relevance search: token overlap + tag match, ranked by salience & recency. */
  search(query: string, opts?: { tags?: string[]; limit?: number }): Promise<MemoryDoc[]>;
  remove(id: string): Promise<void>;
}

function score(doc: MemoryDoc, terms: string[], tags: string[]): number {
  const hay = (doc.text + " " + doc.tags.join(" ")).toLowerCase();
  let s = 0;
  for (const t of terms) if (t && hay.includes(t)) s += 1;
  for (const tag of tags) if (doc.tags.includes(tag)) s += 2;
  // light recency + salience nudges so ties resolve sensibly
  const ageDays = (Date.now() - doc.ts) / 86_400_000;
  return s + doc.salience + Math.max(0, 1 - ageDays / 30) * 0.5;
}

function rank(docs: MemoryDoc[], query: string, tags: string[], limit: number): MemoryDoc[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  return docs
    .map((d) => ({ d, s: score(d, terms, tags) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.d);
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
  async recent(limit: number) {
    return [...this.map.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
  async search(query: string, opts: { tags?: string[]; limit?: number } = {}) {
    return rank(await this.all(), query, opts.tags ?? [], opts.limit ?? 8);
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
    return res.rows.map((r: { doc: MemoryDoc }) => r.doc).filter(Boolean) as MemoryDoc[];
  }
  async recent(limit: number) {
    return (await this.all()).sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
  async search(query: string, opts: { tags?: string[]; limit?: number } = {}) {
    return rank(await this.all(), query, opts.tags ?? [], opts.limit ?? 8);
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
    console.log("[memory] using PouchDB store");
    return new PouchStore(pdb);
  } catch (err) {
    console.warn(
      "[memory] PouchDB unavailable, falling back to in-memory store (no persistence):",
      (err as Error).message,
    );
    return new InMemoryStore();
  }
}
