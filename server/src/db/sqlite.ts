import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "../config.js";
import type { HeartbeatTask, Persona } from "../types.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "trinity.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS personas (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    description TEXT NOT NULL,
    voice      TEXT NOT NULL DEFAULT '',
    traits     TEXT NOT NULL DEFAULT '{}',
    updatedAt  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS heartbeat_tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    instruction TEXT NOT NULL,
    intervalSec INTEGER NOT NULL,
    nextRunAt   INTEGER NOT NULL,
    lastRunAt   INTEGER,
    enabled     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS skills (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    code        TEXT NOT NULL,
    createdAt   INTEGER NOT NULL
  );
`);

// ─── Migrations (additive, idempotent) ───────────────────────────────────────
function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}
function addColumn(table: string, column: string, ddl: string): void {
  if (hasColumn(table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (err) {
    // Another engine process may have added it a moment ago.
    if (!/duplicate column/i.test((err as Error).message)) throw err;
  }
}
addColumn("personas", "voicePrompt", "TEXT NOT NULL DEFAULT ''");
addColumn("personas", "toolsets", "TEXT NOT NULL DEFAULT '[]'");
addColumn("heartbeat_tasks", "once", "INTEGER NOT NULL DEFAULT 0");
// Weekday rules ("1,2,3,4,5" = Monday to Friday; '' = every day), the kind ('' = an ordinary reminder or task,
// 'system' = a silent engine job such as the nightly reflection, 'checkin' = the quiet check-in), and a one-time
// item's delivery state: how often it was tried, and when the next try may run.
addColumn("heartbeat_tasks", "days", "TEXT NOT NULL DEFAULT ''");
addColumn("heartbeat_tasks", "kind", "TEXT NOT NULL DEFAULT ''");
addColumn("heartbeat_tasks", "attempts", "INTEGER NOT NULL DEFAULT 0");
addColumn("heartbeat_tasks", "retryAt", "INTEGER");
// The heartbeat asks for due tasks every few seconds.
db.exec("CREATE INDEX IF NOT EXISTS heartbeat_due ON heartbeat_tasks (enabled, nextRunAt)");

db.exec(`
  -- Sentences the local pre-filter flagged as likely to hold a lasting fact: read at the next reflection.
  CREATE TABLE IF NOT EXISTS reflect_queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    sessionId TEXT NOT NULL DEFAULT '',
    userText  TEXT NOT NULL,
    agentText TEXT NOT NULL DEFAULT '',
    note      TEXT NOT NULL DEFAULT ''
  );

  -- Multi-step jobs the problem solver finished: a request seen twice becomes a procedure skill.
  CREATE TABLE IF NOT EXISTS solver_traces (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    request  TEXT NOT NULL,
    topic    TEXT NOT NULL DEFAULT '',
    steps    TEXT NOT NULL,
    say      TEXT NOT NULL DEFAULT '',
    skill    TEXT NOT NULL DEFAULT ''
  );
`);

// ─── Settings ────────────────────────────────────────────────────────────────
export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ─── Profile (who the user is) ─────────────────────────────────────────────
const MAX_NAME = 40;

/** A usable name: trimmed, one line, no wrapping quotes or trailing punctuation; null if nothing is left. */
export function cleanProfileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’.,!?;:]+$/g, "")
    .trim();
  if (!name || name.length > MAX_NAME || !/\p{L}/u.test(name)) return null;
  return name;
}

/** The user's name (setting `user_name`), when they've told Trinity or set it in Settings. */
export function getProfileName(): string | null {
  return cleanProfileName(getSetting("user_name"));
}
/** Set (or with null/blank, forget) the user's name. Returns what was stored. */
export function setProfileName(name: string | null): string | null {
  const clean = cleanProfileName(name);
  if (clean) setSetting("user_name", clean);
  else deleteSetting("user_name");
  return clean;
}

// ─── Personas ────────────────────────────────────────────────────────────────
interface PersonaRow {
  id: string;
  name: string;
  description: string;
  voicePrompt: string;
  voice: string;
  toolsets: string;
  traits: string;
  updatedAt: number;
}
function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
function rowToPersona(r: PersonaRow): Persona {
  const toolsets = parseJson<unknown>(r.toolsets, []);
  return {
    ...r,
    voicePrompt: r.voicePrompt ?? "",
    toolsets: Array.isArray(toolsets) ? toolsets.map(String) : [],
    traits: parseJson<Record<string, string>>(r.traits, {}),
  };
}

export function listPersonas(): Persona[] {
  const rows = db.prepare("SELECT * FROM personas ORDER BY name").all() as PersonaRow[];
  return rows.map(rowToPersona);
}
export function getPersona(id: string): Persona | null {
  const r = db.prepare("SELECT * FROM personas WHERE id = ?").get(id) as PersonaRow | undefined;
  return r ? rowToPersona(r) : null;
}
export function savePersona(p: Persona): void {
  db.prepare(
    `INSERT INTO personas (id, name, description, voicePrompt, voice, toolsets, traits, updatedAt)
     VALUES (@id, @name, @description, @voicePrompt, @voice, @toolsets, @traits, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description, voicePrompt=excluded.voicePrompt,
       voice=excluded.voice, toolsets=excluded.toolsets, traits=excluded.traits, updatedAt=excluded.updatedAt`,
  ).run({
    id: p.id,
    name: p.name,
    description: p.description,
    voicePrompt: p.voicePrompt ?? "",
    voice: p.voice,
    toolsets: JSON.stringify(p.toolsets ?? []),
    traits: JSON.stringify(p.traits ?? {}),
    updatedAt: p.updatedAt,
  });
}
export function deletePersona(id: string): void {
  db.prepare("DELETE FROM personas WHERE id = ?").run(id);
  // Tombstone so the seeder never brings a deleted built-in persona back.
  const gone = new Set(parseJson<string[]>(getSetting("deleted_personas") ?? "[]", []));
  gone.add(id);
  setSetting("deleted_personas", JSON.stringify([...gone]));
}
export function deletedPersonaIds(): Set<string> {
  return new Set(parseJson<string[]>(getSetting("deleted_personas") ?? "[]", []));
}

export function getActivePersona(): Persona {
  const id = getSetting("active_persona");
  const p = (id && getPersona(id)) || listPersonas()[0];
  if (!p) throw new Error("No personas exist — seeding failed");
  return p;
}
export function setActivePersona(id: string): void {
  setSetting("active_persona", id);
}

// ─── Heartbeat tasks ─────────────────────────────────────────────────────────

/** '' = an ordinary reminder or task; "system" = a silent engine job (never spoken, runs with nobody connected); "checkin" = the quiet check-in. */
export type TaskKind = "" | "system" | "checkin";

/** A heartbeat task with what the scheduler keeps beside the shared shape. */
export interface ScheduledTask extends HeartbeatTask {
  /** Weekdays a recurring task runs on (0 = Sunday … 6 = Saturday). Absent = every day. */
  days?: number[];
  kind?: TaskKind;
  /** A one-time item: how many deliveries were tried (it stays due until one works). */
  attempts?: number;
  /** A one-time item whose delivery failed: not before this. */
  retryAt?: number | null;
}

interface HeartbeatRow extends Omit<HeartbeatTask, "enabled" | "once"> {
  enabled: number;
  once: number;
  days: string | null;
  kind: string | null;
  attempts: number | null;
  retryAt: number | null;
}

/** "1,2,3,4,5" → [1, 2, 3, 4, 5]; anything else → none. */
function parseDays(s: string | null | undefined): number[] {
  if (!s) return [];
  return [...new Set(s.split(",").map((d) => Number(d.trim())).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

function rowToTask(r: HeartbeatRow): ScheduledTask {
  const { days: rawDays, kind, attempts, retryAt, ...rest } = r;
  const days = parseDays(rawDays);
  // (The extra fields appear only when they say something, so an ordinary task keeps its shape.)
  return {
    ...rest,
    enabled: Boolean(r.enabled),
    once: Boolean(r.once),
    ...(days.length && days.length < 7 ? { days } : {}),
    ...(kind === "system" || kind === "checkin" ? { kind } : {}),
    ...(attempts ? { attempts } : {}),
    ...(retryAt ? { retryAt } : {}),
  };
}

/** The user's reminders and tasks, and the check-in (not the engine's own silent jobs). */
export function listTasks(): ScheduledTask[] {
  const rows = db.prepare("SELECT * FROM heartbeat_tasks WHERE kind != 'system' ORDER BY nextRunAt").all() as HeartbeatRow[];
  return rows.map(rowToTask);
}
/** Every task, the engine's own included. */
export function listAllTasks(): ScheduledTask[] {
  const rows = db.prepare("SELECT * FROM heartbeat_tasks ORDER BY nextRunAt").all() as HeartbeatRow[];
  return rows.map(rowToTask);
}
/** Enabled tasks whose time has come (a one-time item whose delivery failed waits for its retry time). */
export function dueTasks(now: number): ScheduledTask[] {
  const rows = db
    .prepare("SELECT * FROM heartbeat_tasks WHERE enabled = 1 AND nextRunAt <= ? AND (retryAt IS NULL OR retryAt <= ?) ORDER BY nextRunAt")
    .all(now, now) as HeartbeatRow[];
  return rows.map(rowToTask);
}
/** A recurring task this far apart (or more) is worth having the voice up for, like a one-time item; an every-few-minutes one isn't. */
const VOICE_MIN_INTERVAL_SEC = 3600;

/**
 * Enabled items due by `by` that the voice is kept up for (a standby session isn't let go, a "wake"
 * warms one): one-time items — coming up, or due and not yet said — and recurring tasks that run
 * at most hourly.
 */
export function dueForVoice(by: number): ScheduledTask[] {
  // (Only what gets said: never the engine's silent jobs or the check-in, which speaks only when something needs it.)
  const rows = db
    .prepare("SELECT * FROM heartbeat_tasks WHERE enabled = 1 AND kind = '' AND (once = 1 OR intervalSec >= ?) AND nextRunAt <= ? ORDER BY nextRunAt")
    .all(VOICE_MIN_INTERVAL_SEC, by) as HeartbeatRow[];
  return rows.map(rowToTask);
}
export function getTask(id: string): ScheduledTask | null {
  const r = db.prepare("SELECT * FROM heartbeat_tasks WHERE id = ?").get(id) as HeartbeatRow | undefined;
  return r ? rowToTask(r) : null;
}
/**
 * Record a run (or a skipped slot): only the run times change, so an edit made meanwhile is
 * kept and a deleted task stays deleted.
 */
export function rescheduleTask(id: string, lastRunAt: number | null, nextRunAt: number): void {
  db.prepare("UPDATE heartbeat_tasks SET lastRunAt = ?, nextRunAt = ? WHERE id = ?").run(lastRunAt, nextRunAt, id);
}
/** A one-time item was delivered: it stays listed as done (disabled). Targeted, like rescheduleTask. */
export function finishTask(id: string, ranAt: number): void {
  db.prepare("UPDATE heartbeat_tasks SET lastRunAt = ?, enabled = 0, retryAt = NULL WHERE id = ?").run(ranAt, id);
}
/**
 * A one-time item's delivery didn't work (or it was only shown, and the voice still owes it): it stays due and is
 * tried again at `retryAt`. Targeted: an edit made meanwhile is kept.
 */
export function deferTask(id: string, attempts: number, retryAt: number): void {
  db.prepare("UPDATE heartbeat_tasks SET attempts = ?, retryAt = ? WHERE id = ?").run(attempts, retryAt, id);
}
/** Save a task (insert, or replace the saved fields). `days`, `kind`, `attempts` and `retryAt` are kept when the task carries them. */
export function saveTask(t: HeartbeatTask | ScheduledTask): void {
  const s = t as ScheduledTask;
  db.prepare(
    `INSERT INTO heartbeat_tasks (id, title, instruction, intervalSec, nextRunAt, lastRunAt, enabled, once, days, kind, attempts, retryAt)
     VALUES (@id, @title, @instruction, @intervalSec, @nextRunAt, @lastRunAt, @enabled, @once, @days, @kind, @attempts, @retryAt)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, instruction=excluded.instruction, intervalSec=excluded.intervalSec,
       nextRunAt=excluded.nextRunAt, lastRunAt=excluded.lastRunAt, enabled=excluded.enabled, once=excluded.once,
       days=excluded.days, kind=excluded.kind, attempts=excluded.attempts, retryAt=excluded.retryAt`,
  ).run({
    id: t.id,
    title: t.title,
    instruction: t.instruction,
    intervalSec: t.intervalSec,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt ?? null,
    enabled: t.enabled ? 1 : 0,
    once: t.once ? 1 : 0,
    days: parseDays((s.days ?? []).join(",")).join(","),
    kind: s.kind === "system" || s.kind === "checkin" ? s.kind : "",
    attempts: s.attempts ?? 0,
    retryAt: s.retryAt ?? null,
  });
}
export function deleteTask(id: string): void {
  db.prepare("DELETE FROM heartbeat_tasks WHERE id = ?").run(id);
}

// ─── Skills registry (metadata + source) ─────────────────────────────────────
export interface SkillRow {
  name: string;
  description: string;
  code: string;
  createdAt: number;
}
export function listSkillRows(): SkillRow[] {
  return db.prepare("SELECT * FROM skills ORDER BY createdAt").all() as SkillRow[];
}
export function saveSkillRow(s: SkillRow): void {
  db.prepare(
    `INSERT INTO skills (name, description, code, createdAt)
     VALUES (@name, @description, @code, @createdAt)
     ON CONFLICT(name) DO UPDATE SET description=excluded.description, code=excluded.code`,
  ).run(s);
}

// ─── Reflection queue (sentences the pre-filter flagged; see services/curator.ts, services/reflect.ts) ──────────
export interface QueuedSentence {
  id: number;
  ts: number;
  sessionId: string;
  userText: string;
  agentText: string;
  /** What a tool already did with the request ("schedule", "recall"), or '' . */
  note: string;
}
const QUEUE_MAX = 500;

export function queueSentence(q: { userText: string; agentText?: string; sessionId?: string; note?: string; ts?: number }): void {
  db.prepare("INSERT INTO reflect_queue (ts, sessionId, userText, agentText, note) VALUES (?, ?, ?, ?, ?)").run(
    q.ts ?? Date.now(),
    q.sessionId ?? "",
    q.userText.slice(0, 1000),
    (q.agentText ?? "").slice(0, 600),
    q.note ?? "",
  );
  // (Never unbounded: with no model to reflect, the oldest go.)
  db.prepare("DELETE FROM reflect_queue WHERE id <= (SELECT MAX(id) FROM reflect_queue) - ?").run(QUEUE_MAX);
}
export function queuedSentences(limit = 200): QueuedSentence[] {
  return db.prepare("SELECT * FROM reflect_queue ORDER BY id LIMIT ?").all(limit) as QueuedSentence[];
}
export function clearQueued(ids: number[]): void {
  const del = db.prepare("DELETE FROM reflect_queue WHERE id = ?");
  db.transaction(() => ids.forEach((id) => del.run(id)))();
}
export function clearAllQueued(): void {
  db.prepare("DELETE FROM reflect_queue").run();
}
/**
 * The flagged sentences of one session: those queued under one of its ids, and those queued under none while it
 * ran (`from`…`to`). They go when the session is deleted — what the user removed must not come back as a memory.
 */
export function clearQueuedFor(sessionIds: string[], from: number, to: number): number {
  const byId = db.prepare("DELETE FROM reflect_queue WHERE sessionId = ?");
  const loose = db.prepare("DELETE FROM reflect_queue WHERE sessionId = '' AND ts >= ? AND ts <= ?");
  return db.transaction(() => sessionIds.filter(Boolean).reduce((n, id) => n + byId.run(id).changes, 0) + loose.run(from, to).changes)();
}

// ─── Solver traces (multi-step jobs that worked; see services/agent-loop.ts, services/reflect.ts) ───────────────
export interface TraceStep {
  tool: string;
  /** The step in words ("close the pictures"), as the planner gave it. */
  words: string;
  args: Record<string, string>;
}
export interface SolverTrace {
  id: number;
  ts: number;
  request: string;
  /** The request's topic words, sorted: two traces with the same topic are the same job asked twice. */
  topic: string;
  steps: TraceStep[];
  say: string;
  /** The procedure skill made from it, or ''. */
  skill: string;
}
const TRACES_MAX = 200;

export function saveTrace(t: { request: string; topic: string; steps: TraceStep[]; say: string; ts?: number }): number {
  const info = db
    .prepare("INSERT INTO solver_traces (ts, request, topic, steps, say) VALUES (?, ?, ?, ?, ?)")
    .run(t.ts ?? Date.now(), t.request.slice(0, 600), t.topic.slice(0, 300), JSON.stringify(t.steps).slice(0, 8000), t.say.slice(0, 400));
  db.prepare("DELETE FROM solver_traces WHERE id <= (SELECT MAX(id) FROM solver_traces) - ?").run(TRACES_MAX);
  return Number(info.lastInsertRowid);
}
export function listTraces(limit = TRACES_MAX): SolverTrace[] {
  const rows = db.prepare("SELECT * FROM solver_traces ORDER BY id DESC LIMIT ?").all(limit) as (Omit<SolverTrace, "steps"> & { steps: string })[];
  return rows.map((r) => ({ ...r, steps: parseJson<TraceStep[]>(r.steps, []) }));
}
/** Forget the jobs that haven't become a skill (their requests are the user's words: they go with the history). Returns how many. */
export function clearOpenTraces(): number {
  return db.prepare("DELETE FROM solver_traces WHERE skill = ''").run().changes;
}
/** Record that these traces became a procedure skill (they aren't proposed again). */
export function markTraces(ids: number[], skill: string): void {
  const set = db.prepare("UPDATE solver_traces SET skill = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id) => set.run(skill, id)))();
}

export default db;
