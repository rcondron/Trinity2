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

// ─── Personas ────────────────────────────────────────────────────────────────
interface PersonaRow {
  id: string;
  name: string;
  description: string;
  voice: string;
  traits: string;
  updatedAt: number;
}
function rowToPersona(r: PersonaRow): Persona {
  return { ...r, traits: JSON.parse(r.traits) as Record<string, string> };
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
    `INSERT INTO personas (id, name, description, voice, traits, updatedAt)
     VALUES (@id, @name, @description, @voice, @traits, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description,
       voice=excluded.voice, traits=excluded.traits, updatedAt=excluded.updatedAt`,
  ).run({ ...p, traits: JSON.stringify(p.traits) });
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
interface HeartbeatRow extends Omit<HeartbeatTask, "enabled"> {
  enabled: number;
}
function rowToTask(r: HeartbeatRow): HeartbeatTask {
  return { ...r, enabled: Boolean(r.enabled) };
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
export function saveTask(t: HeartbeatTask): void {
  db.prepare(
    `INSERT INTO heartbeat_tasks (id, title, instruction, intervalSec, nextRunAt, lastRunAt, enabled)
     VALUES (@id, @title, @instruction, @intervalSec, @nextRunAt, @lastRunAt, @enabled)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, instruction=excluded.instruction, intervalSec=excluded.intervalSec,
       nextRunAt=excluded.nextRunAt, lastRunAt=excluded.lastRunAt, enabled=excluded.enabled`,
  ).run({ ...t, enabled: t.enabled ? 1 : 0 });
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
