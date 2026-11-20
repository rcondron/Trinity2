import express, { type Router } from "express";
import {
  deleteAllHistory,
  deleteSession,
  getSession,
  historyStats,
  listSessions,
  searchConversations,
  sessionTurns,
  setHistoryEnabled,
  setRetentionDays,
} from "../db/conversations.js";
import { cleanProfileName, clearAllQueued, clearOpenTraces, getProfileName, queuedSentences, setProfileName } from "../db/sqlite.js";
import { consolidateMemories, effectiveSalience, MEMORY_TYPES, newMemoryId, setSharedMemory, type MemoryStore } from "../db/memory.js";
import { nameMemory, ownNameIn, renamedText, statesOwnName, unnamedText, withoutNameTags } from "../services/curator.js";
import { getProfile, PROFILE_LIMITS, scanEntry, setProfile } from "../services/profile.js";
import { clearPausedSolve } from "../services/agent-loop.js";
import { clearDigest, getDigest, reflectPending } from "../services/reflect.js";
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
    // The same scan as every other way into memory: no hidden characters, nothing that steers the model, no secrets.
    const why = scanEntry(b.text);
    if (why) return { error: `that can't be saved as a memory: ${why}` };
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

/** A memory as the API lists it: with what it weighs now (its salience fades with age unless it was recalled). */
const listed = (d: MemoryDoc) => ({ ...d, effective: Math.round(effectiveSalience(d) * 100) / 100 });

/** What GET /profile answers: the name, both profile texts, their limits. */
function profileView() {
  const p = getProfile();
  return { name: getProfileName(), user: p.user, notes: p.notes, limits: { user: PROFILE_LIMITS.user, notes: PROFILE_LIMITS.notes } };
}

/**
 * Memory API (mounted under /api): what Trinity remembers about the user, who they are (the name and the two
 * always-loaded profile texts), and the conversation history — list, search, delete one session or everything,
 * how long it is kept.
 */
export function memoryRouter(memory: MemoryStore): Router {
  const r = express.Router();
  // (The store the engine runs on: reflection and other background work take it from here.)
  setSharedMemory(memory);

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
      res.json((q ? await memory.search(q, opts) : await memory.recent(limit, opts)).map(listed));
    }),
  );
  // Merge memories that say the same thing (the nightly reflection does this too).
  r.post(
    "/memory/consolidate",
    ah(async (_req, res) => {
      const done = await consolidateMemories(memory);
      res.json({ ok: true, merged: done.merged });
    }),
  );
  r.get(
    "/memory/:id",
    ah(async (req, res) => {
      const doc = await memory.get(String(req.params.id));
      return doc ? res.json(listed(doc)) : res.status(404).json({ error: "not found" });
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

  // ── Profile: the user's name (personalizes the voice prompt and answers) and the two always-loaded texts ──
  r.get("/profile", (_req, res) => res.json(profileView()));
  r.put(
    "/profile",
    ah(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // The profile texts (Settings → Memory): each is capped and scanned; an error names what was wrong.
      for (const part of ["user", "notes"] as const) {
        if (body[part] === undefined) continue;
        if (typeof body[part] !== "string") return res.status(400).json({ error: `${part} must be text` });
        const done = setProfile(part, body[part]);
        if (!done.ok) return res.status(400).json({ error: done.error ?? `${part} could not be saved` });
      }
      if (!("name" in body)) return res.json(profileView());
      const name = body.name;
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
      // The memory as it is now, so Settings can show it at once (and an open edit form of it can't save the old name
      // back) — and the profile texts, whose name entry follows the name.
      res.json({ ...profileView(), name: saved, ...(rewritten ? { memory: rewritten } : {}), ...(removed ? { removed } : {}) });
    }),
  );

  // ── Conversation history: what is kept, for how long, and the ways to delete it ──
  r.get("/history", (_req, res) => res.json({ ...historyStats(), queued: queuedSentences(500).length, digest: getDigest()?.text ?? "" }));
  r.put("/history/settings", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.retentionDays !== undefined) {
      const days = Number(b.retentionDays);
      if (!Number.isFinite(days) || days < 0 || days > 3650) return res.status(400).json({ error: "retentionDays must be a number of days from 0 (keep everything) to 3650" });
      setRetentionDays(days);
    }
    if (b.enabled !== undefined) setHistoryEnabled(b.enabled === true || b.enabled === "true");
    res.json(historyStats());
  });
  r.get("/history/sessions", (req, res) => res.json(listSessions(Math.max(1, Math.min(500, Number(req.query.limit) || 50)))));
  r.get("/history/sessions/:id", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: "not found" });
    res.json({ session, turns: sessionTurns(session.id) });
  });
  r.get("/history/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json(searchConversations(q, { limit: Math.max(1, Math.min(50, Number(req.query.limit) || 20)) }));
  });
  r.delete("/history/sessions/:id", (req, res) => res.json({ ok: true, deleted: deleteSession(String(req.params.id)) }));
  // Everything said: every session and turn, the search index, the sentences waiting for reflection — and what was
  // kept from conversations outside the log: the line left for the next one, a question the solver was waiting on,
  // and the requests it recorded as jobs that might become a skill. (Memories and the profile have their own delete.)
  r.delete("/history", (_req, res) => {
    const turns = deleteAllHistory();
    clearAllQueued();
    clearDigest();
    clearPausedSolve();
    clearOpenTraces();
    res.json({ ok: true, deleted: turns });
  });

  // Reflect now on what waits (the sessions that ended, the flagged sentences), instead of at the end of a call or at night.
  r.post(
    "/reflect",
    ah(async (_req, res) => {
      const results = await reflectPending({ memory });
      res.json({
        ok: true,
        reflections: results.length,
        added: results.reduce((n, x) => n + x.added, 0),
        replaced: results.reduce((n, x) => n + x.replaced, 0),
        removed: results.reduce((n, x) => n + x.removed, 0),
        profile: results.reduce((n, x) => n + x.profile, 0),
        skipped: results.filter((x) => x.skipped).map((x) => x.skipped),
      });
    }),
  );

  return r;
}
