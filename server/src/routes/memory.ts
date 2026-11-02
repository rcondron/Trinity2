import express, { type Router } from "express";
import { cleanProfileName, getProfileName, setProfileName } from "../db/sqlite.js";
import { MEMORY_TYPES, newMemoryId, type MemoryStore } from "../db/memory.js";
import { nameMemory, ownNameIn, renamedText, statesOwnName, unnamedText, withoutNameTags } from "../services/curator.js";
import type { MemoryDoc } from "../types.js";
import { ah } from "../util/bg.js";

const MAX_TEXT = 2000;
const MAX_TAGS = 12;

type Fields = Pick<MemoryDoc, "text" | "type" | "tags" | "salience">;

/** Validate the editable fields of a body (all optional: PUT merges); an error names the field. */
function fields(b: Record<string, unknown>): Partial<Fields> | { error: string } {
  const out: Partial<Fields> = {};
  if (b.text !== undefined) {
    if (typeof b.text !== "string" || !b.text.trim()) return { error: "text must be non-empty text" };
    if (b.text.length > MAX_TEXT) return { error: `text is too long (the limit is ${MAX_TEXT} characters)` };
    out.text = b.text.trim();
  }
  if (b.type !== undefined) {
    if (!MEMORY_TYPES.includes(b.type as MemoryDoc["type"])) return { error: `type must be one of ${MEMORY_TYPES.join(", ")}` };
    out.type = b.type as MemoryDoc["type"];
  }
  if (b.tags !== undefined) {
    const raw = typeof b.tags === "string" ? b.tags.split(",") : b.tags;
    if (!Array.isArray(raw)) return { error: "tags must be a list of words" };
    out.tags = [...new Set(raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, MAX_TAGS);
  }
  if (b.salience !== undefined) {
    const s = Number(b.salience);
    if (!Number.isFinite(s) || s < 0 || s > 1) return { error: "salience must be a number from 0 to 1" };
    out.salience = s;
  }
  return out;
}

/** Memory API (mounted under /api): what Trinity remembers about the user, and who they are. */
export function memoryRouter(memory: MemoryStore): Router {
  const r = express.Router();

  // ?q= searches (by relevance), otherwise newest first; ?type= narrows to one kind; ?limit= ≤ 500.
  r.get(
    "/memory",
    ah(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const type = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
      if (type && !MEMORY_TYPES.includes(type as MemoryDoc["type"]))
        return res.status(400).json({ error: `type must be one of ${MEMORY_TYPES.join(", ")}` });
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
      const opts = { limit, type: type as MemoryDoc["type"] | undefined };
      res.json(q ? await memory.search(q, opts) : await memory.recent(limit, opts));
    }),
  );
  r.get(
    "/memory/:id",
    ah(async (req, res) => {
      const doc = await memory.get(String(req.params.id));
      return doc ? res.json(doc) : res.status(404).json({ error: "not found" });
    }),
  );
  r.post(
    "/memory",
    ah(async (req, res) => {
      const f = fields((req.body ?? {}) as Record<string, unknown>);
      if ("error" in f) return res.status(400).json(f);
      if (!f.text) return res.status(400).json({ error: "text is required" });
      const doc = await memory.put({
        _id: newMemoryId(),
        type: f.type ?? "fact",
        text: f.text,
        tags: f.tags ?? [],
        salience: f.salience ?? 0.7,
        ts: Date.now(),
        meta: { source: "settings" },
      });
      res.json(doc);
    }),
  );
  r.put(
    "/memory/:id",
    ah(async (req, res) => {
      const existing = await memory.get(String(req.params.id));
      if (!existing) return res.status(404).json({ error: "not found" });
      const f = fields((req.body ?? {}) as Record<string, unknown>);
      if ("error" in f) return res.status(400).json(f);
      const { _rev: _r, ...rest } = existing;
      const edited = { ...rest, ...f };
      // The memory that holds the user's name, edited to state another name: that's their name now (the old
      // name's tag goes with it), so recall and the voice prompt don't hear two.
      const before = getProfileName();
      const stated = edited.tags.includes("name") ? ownNameIn(edited.text) : null;
      const renamed = stated !== null && stated !== before;
      const doc = await memory.put({
        ...edited,
        ...(renamed ? { tags: withoutNameTags(edited.tags, before, stated) } : {}),
        meta: { ...(existing.meta ?? {}), editedAt: Date.now() },
      });
      if (renamed) setProfileName(stated);
      res.json(doc);
    }),
  );
  r.delete(
    "/memory/:id",
    ah(async (req, res) => {
      const existing = await memory.get(String(req.params.id));
      if (existing) await memory.remove(String(req.params.id));
      res.json({ ok: true, deleted: Boolean(existing) });
    }),
  );

  // ── Profile: the user's name (personalizes the voice prompt and answers) ──
  r.get("/profile", (_req, res) => res.json({ name: getProfileName() }));
  r.put(
    "/profile",
    ah(async (req, res) => {
      const name = (req.body ?? {}).name;
      if (name !== null && name !== undefined && typeof name !== "string") return res.status(400).json({ error: "name must be text" });
      if (typeof name === "string" && name.trim().length > 40) return res.status(400).json({ error: "name is too long (the limit is 40 characters)" });
      // A non-blank name that isn't usable ("123") is refused — it must not silently erase the saved one.
      if (typeof name === "string" && name.trim() && !cleanProfileName(name))
        return res.status(400).json({ error: "a name needs at least one letter" });
      const before = getProfileName();
      const saved = setProfileName(typeof name === "string" ? name : null);
      // The memory that holds the name (see nameMemory) follows, or recall would hear both names: a new name goes in
      // it, a cleared one comes out of it — and whatever else it says stays (see renamedText, unnamedText).
      const doc = await nameMemory(memory);
      let rewritten: MemoryDoc | null = null;
      let removed: string | null = null;
      if (doc && !(saved && statesOwnName(doc.text, saved))) {
        const { _rev: _r, ...rest } = doc;
        const text = saved ? renamedText(doc.text, before, saved, `The user's name is ${saved}.`) : unnamedText(doc.text);
        if (text === null) {
          await memory.remove(doc._id);
          removed = doc._id;
        } else {
          // (Cleared, a memory that says more stops being the name memory.)
          const tags = withoutNameTags(doc.tags, before, saved).filter((t) => saved || (t !== "name" && t !== "profile"));
          rewritten = await memory.put({ ...rest, text, tags, ts: Date.now(), meta: { ...(doc.meta ?? {}), editedAt: Date.now() } });
        }
      }
      // The memory as it is now, so Settings can show it at once (and an open edit form of it can't save the old name back).
      res.json({ name: saved, ...(rewritten ? { memory: rewritten } : {}), ...(removed ? { removed } : {}) });
    }),
  );

  return r;
}
