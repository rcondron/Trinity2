import { nanoid } from "nanoid";
import type { TranscriptTurn } from "../types.js";
import { topicWords } from "./memory.js";
import db, { clearQueuedFor, getSetting, setSetting } from "./sqlite.js";

/*
 * The conversation log: every session (a voice call, the text channel, a scheduled run) and its turns — what the
 * user said, what Trinity said, which tool ran and whether it worked — in SQLite, with full-text search (FTS5,
 * stemmed). It is what survives a restart (recentTurns seeds the context again), what "what did we say about…" is
 * answered from (searchConversations), and what reflection reads when a session ends (services/reflect.ts). A
 * call ends when it hangs up; a typed session, which nobody ends, is over after half an hour of quiet.
 *
 * Everything callers use here is cheap (one prepared statement) and never throws: a log that can't be written
 * must not take a call down. Nothing from the vault is logged — callers don't pass it, a turn flagged `secret` is
 * dropped, and anything that still looks like a password, key or card number is blanked before it is stored.
 * History older than the retention setting (default 180 days) is deleted; a session, or everything, can be
 * deleted from Settings → Memory.
 */

export type SessionKind = "call" | "text" | "scheduled";

export interface LoggedTurn {
  speaker: "user" | "trinity" | "system";
  text: string;
  /** A tool outcome: the tool's name… */
  tool?: string;
  /** …and whether it worked. */
  ok?: boolean;
  ts?: number;
  /** Came from the vault, or carries a secret: never stored. */
  secret?: boolean;
}

export interface ConversationHit {
  sessionId: string;
  ts: number;
  speaker: string;
  text: string;
  /** Set on a tool outcome. */
  tool?: string;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  persona: string;
  startedAt: number;
  endedAt: number | null;
  turns: number;
  /** The user's first words in it. */
  preview: string;
}

export interface StoredTurn {
  id: number;
  sessionId: string;
  ts: number;
  speaker: "user" | "trinity" | "system";
  text: string;
  tool: string | null;
  ok: boolean | null;
}

const DEFAULT_RETENTION_DAYS = 180;
const MAX_TURN_CHARS = 4000;
const PRUNE_EVERY_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;

let ready = false;
/** Full-text search is available (FTS5 is compiled into every better-sqlite3 build we've seen; without it, search falls back to a word scan). */
let fts = false;
let warned = false;

function warn(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[history] ${what}: ${(err as Error)?.message ?? err} (further history errors are not logged)`);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conv_sessions (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      persona     TEXT NOT NULL DEFAULT '',
      startedAt   INTEGER NOT NULL,
      endedAt     INTEGER,
      turns       INTEGER NOT NULL DEFAULT 0,
      reflect     INTEGER NOT NULL DEFAULT 0,
      reflectedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS conv_turns (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      speaker   TEXT NOT NULL,
      text      TEXT NOT NULL,
      tool      TEXT,
      ok        INTEGER
    );
    CREATE INDEX IF NOT EXISTS conv_turns_session ON conv_turns (sessionId, id);
    CREATE INDEX IF NOT EXISTS conv_turns_ts ON conv_turns (ts);
  `);
  ready = true;
} catch (err) {
  warn("the conversation log could not be set up", err);
}
if (ready) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(text, content='conv_turns', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS conv_turns_ai AFTER INSERT ON conv_turns BEGIN
        INSERT INTO conv_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_turns_ad AFTER DELETE ON conv_turns BEGIN
        INSERT INTO conv_fts(conv_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
    `);
    fts = true;
    try {
      // Deleted words leave the index at once, not at the next merge (SQLite 3.42+; older builds ignore it).
      db.exec("INSERT INTO conv_fts(conv_fts, rank) VALUES ('secure-delete', 1)");
    } catch {
      /* not supported by this SQLite */
    }
  } catch (err) {
    console.warn(`[history] full-text search is unavailable (${(err as Error).message}); searching by word scan instead`);
  }
}

/** Whether history search uses the FTS5 index (false: the word-scan fallback). */
export function historySearchKind(): "fts5" | "scan" {
  return fts ? "fts5" : "scan";
}

// ─── Secrets never reach the log ──────────────────────────────────────────────────────────

/** Luhn check: a run of 13–19 digits that passes is a card number. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const KEY_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})\b/g;
const SAID_SECRET =
  /\b((?:pass ?word|pass ?code|pass ?phrase|security code|cvv|cvc|api[ -]?key|secret key|client secret|access token|api token|auth token|social security(?: number)?|ssn)\s*(?:is|was|:|=)\s+)(["'“]?)([^\s"'”,;]{3,})/gi;
const SAID_PIN = /\b(pin(?: number| code)?\s*(?:is|was|:|=)\s*)\d{3,8}\b/gi;
const CARD_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Text with anything that looks like a secret blanked: a card number (13–19 digits that pass the Luhn check), a
 * US social security number, a key or token by its shape, and what follows "my password is", "the PIN is" and
 * the like. Returns the text and whether anything was blanked.
 */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const blank = (label: string) => {
    redacted = true;
    return `[${label}]`;
  };
  const out = text
    .replace(KEY_SHAPES, () => blank("key removed"))
    .replace(CARD_RUN, (run) => {
      const digits = run.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? blank("card number removed") : run;
    })
    .replace(SSN, () => blank("number removed"))
    .replace(SAID_SECRET, (_all, lead: string) => `${lead}${blank("removed")}`)
    .replace(SAID_PIN, (_all, lead: string) => `${lead}${blank("removed")}`);
  return { text: out, redacted };
}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────

/** Days of history kept (default 180). 0 = keep everything. */
export function getRetentionDays(): number {
  try {
    const raw = getSetting("history_retention_days");
    const n = raw === null ? DEFAULT_RETENTION_DAYS : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 3650) : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}
export function setRetentionDays(days: number): number {
  const n = Number.isFinite(days) && days >= 0 ? Math.min(Math.round(days), 3650) : DEFAULT_RETENTION_DAYS;
  setSetting("history_retention_days", String(n));
  pruneHistory();
  return n;
}
/** Whether conversations are logged at all (default yes). */
export function historyEnabled(): boolean {
  try {
    return getSetting("history_enabled") !== "0";
  } catch {
    return true;
  }
}
export function setHistoryEnabled(on: boolean): void {
  setSetting("history_enabled", on ? "1" : "0");
}

// ─── Sessions and turns ───────────────────────────────────────────────────────────────────

const ended: ((sessionId: string) => void)[] = [];
/** Called when a session ends and is queued for reflection (services/reflect.ts listens). */
export function onSessionEnded(fn: (sessionId: string) => void): void {
  ended.push(fn);
}

let lastPruneAt = 0;

/**
 * The text channel has no "goodbye": nobody ends its session. So a typed session ends by itself once nothing was
 * said in it for this long (it is then reflected on like a call that hung up), and the next turn opens a new one.
 * The caller keeps the one id it was given: `continued` says which session that id's turns go to now.
 */
const TEXT_IDLE_MS = 30 * 60_000;
const continued = new Map<string, string>();

/** The stored session a caller's id leads to now. */
export function sessionFor(sessionId: string): string {
  return continued.get(sessionId) ?? sessionId;
}

/** Begin a session; returns its id (use it for logTurn and endSession). Never throws. */
export function startSession(kind: SessionKind, persona: string): string {
  const id = nanoid(12);
  if (!ready) return id;
  try {
    const now = Date.now();
    db.prepare("INSERT INTO conv_sessions (id, kind, persona, startedAt) VALUES (?, ?, ?, ?)").run(id, kind === "call" || kind === "scheduled" ? kind : "text", String(persona ?? "").slice(0, 120), now);
    if (now - lastPruneAt > PRUNE_EVERY_MS) pruneHistory(now);
  } catch (err) {
    warn("a session could not be started", err);
  }
  return id;
}

/** Add one turn to a session. A blank turn, or one flagged `secret`, is dropped. Never throws. */
export function logTurn(sessionId: string, turn: LoggedTurn): void {
  if (!ready || !sessionId || !turn || turn.secret === true) return;
  try {
    if (!historyEnabled()) return;
    const raw = typeof turn.text === "string" ? turn.text.replace(/\s+/g, " ").trim() : "";
    if (!raw) return;
    const { text } = redactSecrets(raw.length > MAX_TURN_CHARS ? `${raw.slice(0, MAX_TURN_CHARS - 1)}…` : raw);
    const speaker = turn.speaker === "user" || turn.speaker === "trinity" ? turn.speaker : "system";
    const ts = typeof turn.ts === "number" && Number.isFinite(turn.ts) ? turn.ts : Date.now();
    const tool = typeof turn.tool === "string" && turn.tool ? turn.tool.slice(0, 80) : null;
    const ok = typeof turn.ok === "boolean" ? (turn.ok ? 1 : 0) : null;
    const id = currentSession(sessionId, ts);
    db.prepare("INSERT INTO conv_turns (sessionId, ts, speaker, text, tool, ok) VALUES (?, ?, ?, ?, ?, ?)").run(id, ts, speaker, text, tool, ok);
    const known = db.prepare("UPDATE conv_sessions SET turns = turns + 1 WHERE id = ?").run(id);
    // (A turn for a session nobody started — a caller that kept an id across a restart: the session is made for it.)
    if (known.changes === 0) db.prepare("INSERT OR IGNORE INTO conv_sessions (id, kind, persona, startedAt, turns) VALUES (?, 'text', '', ?, 1)").run(id, ts);
  } catch (err) {
    warn("a turn could not be logged", err);
  }
}

/**
 * The session a caller's id stands for at this moment. A typed session that went quiet for half an hour (or was
 * ended for that by closeIdleSessions) is over: the turn opens a new one, which the same id leads to from then on.
 */
function currentSession(sessionId: string, ts: number): string {
  const id = continued.get(sessionId) ?? sessionId;
  const s = db.prepare("SELECT kind, persona, endedAt FROM conv_sessions WHERE id = ?").get(id) as { kind: string; persona: string; endedAt: number | null } | undefined;
  if (s?.kind !== "text") return id;
  if (s.endedAt === null) {
    const last = (db.prepare("SELECT ts FROM conv_turns WHERE sessionId = ? ORDER BY id DESC LIMIT 1").get(id) as { ts: number } | undefined)?.ts;
    if (last === undefined || ts - last <= TEXT_IDLE_MS) return id;
    endStored(id, last);
  }
  const next = startSession("text", s.persona);
  continued.set(sessionId, next);
  return next;
}

/** End a session and queue it for reflection (when the user said anything in it). Never throws. */
export function endSession(sessionId: string): void {
  if (!ready || !sessionId) return;
  const id = continued.get(sessionId) ?? sessionId;
  continued.delete(sessionId);
  endStored(id);
}

/**
 * End the typed sessions nothing was said in for half an hour (reflect.ts calls this from the heartbeat, about
 * once a minute). Returns how many ended. Never throws.
 */
export function closeIdleSessions(now = Date.now()): number {
  if (!ready) return 0;
  try {
    const open = db
      .prepare(
        `SELECT id, COALESCE((SELECT ts FROM conv_turns WHERE sessionId = s.id ORDER BY id DESC LIMIT 1), s.startedAt) AS last
         FROM conv_sessions AS s WHERE kind = 'text' AND endedAt IS NULL`,
      )
      .all() as { id: string; last: number }[];
    const idle = open.filter((s) => s.last < now - TEXT_IDLE_MS);
    for (const s of idle) endStored(s.id, s.last);
    return idle.length;
  } catch (err) {
    warn("idle sessions could not be closed", err);
    return 0;
  }
}

/** `at`: when it ended (a session that went quiet ended at its last turn, not when that was noticed). */
function endStored(sessionId: string, at = Date.now()): void {
  try {
    const said = db.prepare("SELECT COUNT(*) AS n FROM conv_turns WHERE sessionId = ? AND speaker = 'user'").get(sessionId) as { n: number };
    const done = db
      .prepare("UPDATE conv_sessions SET endedAt = ?, reflect = ? WHERE id = ? AND endedAt IS NULL")
      .run(at, said.n > 0 ? 1 : 0, sessionId);
    if (done.changes === 0) return;
    if (said.n === 0) {
      // Nothing was said: not worth a row.
      db.prepare("DELETE FROM conv_sessions WHERE id = ? AND turns = 0").run(sessionId);
      return;
    }
    for (const fn of ended) {
      try {
        fn(sessionId);
      } catch (err) {
        warn("a session-end listener failed", err);
      }
    }
  } catch (err) {
    warn("a session could not be ended", err);
  }
}

/** Sessions the last run left open (the engine stopped mid-call): ended at their last turn, queued for reflection. */
function closeStaleSessions(): void {
  if (!ready) return;
  try {
    db.exec(`
      UPDATE conv_sessions SET
        endedAt = COALESCE((SELECT MAX(ts) FROM conv_turns WHERE sessionId = conv_sessions.id), startedAt),
        reflect = CASE WHEN EXISTS (SELECT 1 FROM conv_turns WHERE sessionId = conv_sessions.id AND speaker = 'user') THEN 1 ELSE 0 END
      WHERE endedAt IS NULL;
      DELETE FROM conv_sessions WHERE turns = 0 AND endedAt IS NOT NULL;
    `);
  } catch (err) {
    warn("stale sessions could not be closed", err);
  }
}
closeStaleSessions();

interface TurnRow {
  id: number;
  sessionId: string;
  ts: number;
  speaker: string;
  text: string;
  tool: string | null;
  ok: number | null;
}
const asTurn = (r: TurnRow): StoredTurn => ({
  id: r.id,
  sessionId: r.sessionId,
  ts: r.ts,
  speaker: r.speaker === "user" || r.speaker === "trinity" ? r.speaker : "system",
  text: r.text,
  tool: r.tool,
  ok: r.ok === null ? null : r.ok === 1,
});

/**
 * The last turns across sessions, oldest first — what the user and Trinity said (tool outcomes are left out),
 * to seed the context again after a restart. `withinMs` keeps only turns that recent.
 */
export function recentTurns(limit: number, opts: { withinMs?: number } = {}): TranscriptTurn[] {
  if (!ready) return [];
  try {
    const n = Math.max(0, Math.min(Math.floor(limit) || 0, 500));
    if (!n) return [];
    const since = opts.withinMs && opts.withinMs > 0 ? Date.now() - opts.withinMs : 0;
    const rows = db
      .prepare("SELECT id, sessionId, ts, speaker, text, tool, ok FROM conv_turns WHERE speaker IN ('user', 'trinity') AND ts >= ? ORDER BY id DESC LIMIT ?")
      .all(since, n) as TurnRow[];
    return rows.reverse().map((r) => ({ id: `h${r.id}`, speaker: r.speaker === "user" ? "user" : "trinity", text: r.text, ts: r.ts }));
  } catch (err) {
    warn("recent turns could not be read", err);
    return [];
  }
}

/** When the user last said anything (0: never). */
export function lastUserTurnAt(): number {
  if (!ready) return 0;
  try {
    return (db.prepare("SELECT MAX(ts) AS ts FROM conv_turns WHERE speaker = 'user'").get() as { ts: number | null }).ts ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Search what was said. `sinceMs` narrows it: a span ("the last week" = 7 × 86 400 000) or, when it is a
 * timestamp (anything past the year 1973), the moment to search from. `exclude` leaves out a turn that is the
 * question itself. Best matches first; never throws.
 */
export function searchConversations(query: string, opts: { limit?: number; sinceMs?: number; exclude?: string; speaker?: "user" | "trinity" } = {}): ConversationHit[] {
  if (!ready) return [];
  try {
    const terms = [...new Set(topicWords(String(query ?? "")))].slice(0, 12);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
    const s = opts.sinceMs;
    const since = typeof s === "number" && Number.isFinite(s) && s > 0 ? (s < 1e11 ? Date.now() - s : s) : 0;
    const speaker = opts.speaker ?? null;
    const skip = opts.exclude?.replace(/\s+/g, " ").trim().toLowerCase();
    let rows: (TurnRow & { excerpt?: string })[];
    if (fts) {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      rows = db
        .prepare(
          `SELECT t.id, t.sessionId, t.ts, t.speaker, t.text, t.tool, t.ok, snippet(conv_fts, 0, '', '', '…', 48) AS excerpt
           FROM conv_fts JOIN conv_turns t ON t.id = conv_fts.rowid
           WHERE conv_fts MATCH ? AND t.ts >= ? AND (? IS NULL OR t.speaker = ?)
           ORDER BY bm25(conv_fts), t.ts DESC LIMIT ?`,
        )
        .all(match, since, speaker, speaker, limit + 4) as (TurnRow & { excerpt?: string })[];
    } else {
      // No FTS5: the newest turns holding any of the words, those holding more of them first.
      const like = terms.map(() => "text LIKE ?").join(" OR ");
      const found = db
        .prepare(`SELECT id, sessionId, ts, speaker, text, tool, ok FROM conv_turns WHERE ts >= ? AND (? IS NULL OR speaker = ?) AND (${like}) ORDER BY id DESC LIMIT 400`)
        .all(since, speaker, speaker, ...terms.map((t) => `%${t.replace(/[%_]/g, "")}%`)) as TurnRow[];
      const score = (r: TurnRow) => terms.filter((t) => r.text.toLowerCase().includes(t)).length;
      rows = found.sort((a, b) => score(b) - score(a) || b.ts - a.ts).slice(0, limit + 4);
    }
    return rows
      .filter((r) => !skip || r.text.replace(/\s+/g, " ").trim().toLowerCase() !== skip)
      .slice(0, limit)
      .map((r) => ({
        sessionId: r.sessionId,
        ts: r.ts,
        speaker: r.speaker,
        text: r.text.length > 320 && r.excerpt ? r.excerpt : r.text.length > 320 ? `${r.text.slice(0, 319)}…` : r.text,
        ...(r.tool ? { tool: r.tool } : {}),
      }));
  } catch (err) {
    warn("a history search failed", err);
    return [];
  }
}

// ─── Reading, deleting, pruning (Settings → Memory; reflection) ───────────────────────────

export function listSessions(limit = 50): SessionInfo[] {
  if (!ready) return [];
  try {
    return db
      .prepare(
        `SELECT s.id, s.kind, s.persona, s.startedAt, s.endedAt, s.turns,
           COALESCE((SELECT text FROM conv_turns WHERE sessionId = s.id AND speaker = 'user' ORDER BY id LIMIT 1), '') AS preview
         FROM conv_sessions s WHERE s.turns > 0 ORDER BY s.startedAt DESC, s.rowid DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500)))
      .map((r) => {
        const s = r as SessionInfo;
        return { ...s, preview: s.preview.length > 140 ? `${s.preview.slice(0, 139)}…` : s.preview };
      });
  } catch (err) {
    warn("sessions could not be listed", err);
    return [];
  }
}

export function getSession(id: string): SessionInfo | null {
  if (!ready) return null;
  try {
    const r = db.prepare("SELECT id, kind, persona, startedAt, endedAt, turns, '' AS preview FROM conv_sessions WHERE id = ?").get(id) as SessionInfo | undefined;
    return r ?? null;
  } catch {
    return null;
  }
}

/** A session's turns, oldest first. */
export function sessionTurns(id: string, limit = 2000): StoredTurn[] {
  if (!ready) return [];
  try {
    return (db.prepare("SELECT id, sessionId, ts, speaker, text, tool, ok FROM conv_turns WHERE sessionId = ? ORDER BY id LIMIT ?").all(id, limit) as TurnRow[]).map(asTurn);
  } catch (err) {
    warn("a session could not be read", err);
    return [];
  }
}

/** Sessions that ended and wait for reflection, oldest first. */
export function sessionsToReflect(limit = 10): SessionInfo[] {
  if (!ready) return [];
  try {
    return db
      .prepare("SELECT id, kind, persona, startedAt, endedAt, turns, '' AS preview FROM conv_sessions WHERE reflect = 1 AND reflectedAt IS NULL AND endedAt IS NOT NULL ORDER BY endedAt LIMIT ?")
      .all(limit) as SessionInfo[];
  } catch {
    return [];
  }
}
export function markReflected(id: string): void {
  if (!ready) return;
  try {
    db.prepare("UPDATE conv_sessions SET reflect = 0, reflectedAt = ? WHERE id = ?").run(Date.now(), id);
  } catch (err) {
    warn("a session could not be marked reflected", err);
  }
}

/**
 * Delete one session and everything said in it — and the sentences flagged in it for reflection: what the user
 * deleted must not come back later as a memory. Returns whether it existed.
 */
export function deleteSession(id: string): boolean {
  if (!ready) return false;
  const run = db.transaction(() => {
    const s = db.prepare("SELECT startedAt, endedAt FROM conv_sessions WHERE id = ?").get(id) as { startedAt: number; endedAt: number | null } | undefined;
    if (s) {
      const span = db.prepare("SELECT MIN(ts) AS first, MAX(ts) AS last FROM conv_turns WHERE sessionId = ?").get(id) as { first: number | null; last: number | null };
      // Queued under its id (or the id a caller still uses for it), or under none while it ran. (A sentence is
      // queued a moment after it is logged, once its tools have finished: hence the minute's grace.)
      const callers = [...continued].filter(([, stored]) => stored === id).map(([caller]) => caller);
      clearQueuedFor([id, ...callers], Math.min(s.startedAt, span.first ?? s.startedAt), Math.max(s.endedAt ?? Date.now(), span.last ?? 0) + 60_000);
    }
    db.prepare("DELETE FROM conv_turns WHERE sessionId = ?").run(id);
    return db.prepare("DELETE FROM conv_sessions WHERE id = ?").run(id).changes > 0;
  });
  return run();
}

/** Delete the whole history: every session, every turn, the search index. Returns how many turns went. */
export function deleteAllHistory(): number {
  if (!ready) return 0;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM conv_turns").get() as { n: number }).n;
  db.transaction(() => {
    // (The index first, in one go: a row-by-row trigger over a large history is slow.)
    if (fts) db.exec("DROP TRIGGER IF EXISTS conv_turns_ad");
    db.exec("DELETE FROM conv_turns; DELETE FROM conv_sessions;");
    if (fts) {
      db.exec(`
        INSERT INTO conv_fts(conv_fts) VALUES ('delete-all');
        CREATE TRIGGER IF NOT EXISTS conv_turns_ad AFTER DELETE ON conv_turns BEGIN
          INSERT INTO conv_fts(conv_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
      `);
    }
  })();
  try {
    // What was deleted leaves the file too, not just the tables.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  } catch {
    /* busy: the pages are reused anyway */
  }
  return n;
}

/** Delete history older than the retention setting. Returns how many turns went. */
export function pruneHistory(now = Date.now()): number {
  if (!ready) return 0;
  lastPruneAt = now;
  try {
    const days = getRetentionDays();
    if (days <= 0) return 0;
    const cutoff = now - days * DAY_MS;
    const gone = db.prepare("DELETE FROM conv_turns WHERE ts < ?").run(cutoff).changes;
    db.prepare("DELETE FROM conv_sessions WHERE startedAt < ? AND NOT EXISTS (SELECT 1 FROM conv_turns WHERE sessionId = conv_sessions.id)").run(cutoff);
    if (gone) db.prepare("UPDATE conv_sessions SET turns = (SELECT COUNT(*) FROM conv_turns WHERE sessionId = conv_sessions.id) WHERE startedAt < ?").run(cutoff + DAY_MS);
    return gone;
  } catch (err) {
    warn("old history could not be pruned", err);
    return 0;
  }
}

export function historyStats(): { sessions: number; turns: number; oldest: number | null; retentionDays: number; enabled: boolean; search: "fts5" | "scan" } {
  const base = { sessions: 0, turns: 0, oldest: null as number | null, retentionDays: getRetentionDays(), enabled: historyEnabled(), search: historySearchKind() };
  if (!ready) return base;
  try {
    const s = db.prepare("SELECT COUNT(*) AS n FROM conv_sessions WHERE turns > 0").get() as { n: number };
    const t = db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM conv_turns").get() as { n: number; oldest: number | null };
    return { ...base, sessions: s.n, turns: t.n, oldest: t.oldest };
  } catch {
    return base;
  }
}
