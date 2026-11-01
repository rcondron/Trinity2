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
// The heartbeat asks for due tasks every few seconds.
db.exec("CREATE INDEX IF NOT EXISTS heartbeat_due ON heartbeat_tasks (enabled, nextRunAt)");

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

// ─── Profile (who the caller is) ─────────────────────────────────────────────
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

/** The caller's name (setting `user_name`), when they've told Trinity or set it in Settings. */
export function getProfileName(): string | null {
  return cleanProfileName(getSetting("user_name"));
}
/** Set (or with null/blank, forget) the caller's name. Returns what was stored. */
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
interface HeartbeatRow extends Omit<HeartbeatTask, "enabled" | "once"> {
  enabled: number;
  once: number;
}
function rowToTask(r: HeartbeatRow): HeartbeatTask {
  return { ...r, enabled: Boolean(r.enabled), once: Boolean(r.once) };
}

export function listTasks(): HeartbeatTask[] {
  const rows = db.prepare("SELECT * FROM heartbeat_tasks ORDER BY nextRunAt").all() as HeartbeatRow[];
  return rows.map(rowToTask);
}
export function dueTasks(now: number): HeartbeatTask[] {
  const rows = db
    .prepare("SELECT * FROM heartbeat_tasks WHERE enabled = 1 AND nextRunAt <= ? ORDER BY nextRunAt")
    .all(now) as HeartbeatRow[];
  return rows.map(rowToTask);
}
/** A recurring task this far apart (or more) is worth having the voice up for, like a one-time item; an every-few-minutes one isn't. */
const VOICE_MIN_INTERVAL_SEC = 3600;

/**
 * Enabled items due by `by` that the voice is kept up for (a standby session isn't let go, a "wake"
 * warms one): one-time items — coming up, or due and not yet said — and recurring tasks that run
 * at most hourly.
 */
export function dueForVoice(by: number): HeartbeatTask[] {
  const rows = db
    .prepare("SELECT * FROM heartbeat_tasks WHERE enabled = 1 AND (once = 1 OR intervalSec >= ?) AND nextRunAt <= ? ORDER BY nextRunAt")
    .all(VOICE_MIN_INTERVAL_SEC, by) as HeartbeatRow[];
  return rows.map(rowToTask);
}
export function getTask(id: string): HeartbeatTask | null {
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
/** A one-time item ran: it stays listed as done (disabled). Targeted, like rescheduleTask. */
export function finishTask(id: string, ranAt: number): void {
  db.prepare("UPDATE heartbeat_tasks SET lastRunAt = ?, enabled = 0 WHERE id = ?").run(ranAt, id);
}
export function saveTask(t: HeartbeatTask): void {
  db.prepare(
    `INSERT INTO heartbeat_tasks (id, title, instruction, intervalSec, nextRunAt, lastRunAt, enabled, once)
     VALUES (@id, @title, @instruction, @intervalSec, @nextRunAt, @lastRunAt, @enabled, @once)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, instruction=excluded.instruction, intervalSec=excluded.intervalSec,
       nextRunAt=excluded.nextRunAt, lastRunAt=excluded.lastRunAt, enabled=excluded.enabled, once=excluded.once`,
  ).run({
    id: t.id,
    title: t.title,
    instruction: t.instruction,
    intervalSec: t.intervalSec,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt ?? null,
    enabled: t.enabled ? 1 : 0,
    once: t.once ? 1 : 0,
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

export default db;
