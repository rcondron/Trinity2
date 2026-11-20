import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { deleteTask, getTask, listTasks, saveTask, type ScheduledTask } from "../db/sqlite.js";
import { CHECKIN_ID, ensureSystemTasks, getCheckinSettings, nextSlot, setCheckinSettings, type CheckinSettings } from "../heartbeat.js";
import { getChecklist, PROFILE_LIMITS, setChecklist } from "../services/profile.js";

const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 366 * 86_400;
const LIMITS = { title: 80, instruction: 2000 };
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** POST/PUT body: any of these (PUT merges). `runAt` (epoch ms or a date string) sets the next run. */
interface TaskBody {
  title?: unknown;
  instruction?: unknown;
  intervalSec?: unknown;
  once?: unknown;
  runAt?: unknown;
  nextRunAt?: unknown;
  enabled?: unknown;
  /** Weekdays a recurring task keeps to: numbers (0 = Sunday … 6 = Saturday) or names; [] or null = every day. */
  days?: unknown;
}

function time(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** [1, 2, "wednesday"] → [1, 2, 3]; null for something that isn't a list of weekdays. */
function weekdays(v: unknown): number[] | null {
  if (v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const d of v) {
    const n = typeof d === "number" ? d : typeof d === "string" && /^\d$/.test(d.trim()) ? Number(d) : DAY_NAMES.findIndex((name) => typeof d === "string" && name.startsWith(d.trim().toLowerCase().slice(0, 3)) && d.trim().length >= 3);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** A title from the instruction's first words: "Remind me to stretch." → "Stretch". */
function titleFrom(instruction: string, once: boolean): string {
  const words = instruction.replace(/^remind me\s+(to\s+)?/i, "").trim().split(/\s+/).slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : once ? "Reminder" : "Recurring task";
}

/**
 * Apply a body to a task (a fresh one for POST): validates as it goes and returns the task, or
 * an error naming the field. A one-time reminder needs a time (runAt, or intervalSec as a delay);
 * a recurring task needs an interval of a minute or more, and starts at runAt or one interval from now.
 */
function applyBody(base: ScheduledTask, b: TaskBody, isNew: boolean): ScheduledTask | { error: string } {
  const now = Date.now();
  const t: ScheduledTask = { ...base };
  if (b.title !== undefined) {
    if (typeof b.title !== "string") return { error: "title must be text" };
    t.title = b.title.trim();
  }
  if (b.instruction !== undefined) {
    if (typeof b.instruction !== "string") return { error: "instruction must be text" };
    t.instruction = b.instruction.trim();
  }
  if (b.once !== undefined) t.once = b.once === true || b.once === "true";
  if (b.enabled !== undefined) t.enabled = b.enabled === true || b.enabled === "true";
  if (b.days !== undefined) {
    const days = weekdays(b.days);
    if (days === null) return { error: "days must be a list of weekdays (0–6, Sunday first, or their names)" };
    t.days = days.length && days.length < 7 ? days : undefined;
  }
  if (!t.instruction) t.instruction = t.title;
  if (!t.instruction) return { error: "instruction is required" };
  if (!t.title) t.title = titleFrom(t.instruction, Boolean(t.once));
  if (t.title.length > LIMITS.title) return { error: `title is too long (the limit is ${LIMITS.title} characters)` };
  if (t.instruction.length > LIMITS.instruction) return { error: `instruction is too long (the limit is ${LIMITS.instruction} characters)` };

  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  let interval: number | null = null;
  if (given(b.intervalSec)) {
    interval = Number(b.intervalSec);
    if (!Number.isFinite(interval) || interval <= 0) return { error: "intervalSec must be a positive number of seconds" };
  }
  if ((given(b.runAt) && time(b.runAt) === null) || (given(b.nextRunAt) && time(b.nextRunAt) === null))
    return { error: "runAt must be a time (milliseconds since 1970, or a date string)" };
  const runAt = time(b.runAt) ?? time(b.nextRunAt);

  if (t.once) {
    if (runAt !== null) t.nextRunAt = runAt;
    else if (interval !== null) t.nextRunAt = now + interval * 1000; // "in N seconds"
    else if (isNew || !base.once) return { error: "a one-time reminder needs runAt (or intervalSec as a delay)" };
    t.intervalSec = 0;
    t.days = undefined;
    // A new time makes it a reminder that hasn't run yet (one that fired would still read as done when paused).
    if (t.nextRunAt !== base.nextRunAt) t.lastRunAt = null;
    // A reminder whose time has passed would just fire at once: it needs a new time to be (re)enabled.
    // (One still enabled with its time unchanged is waiting for someone to be around: it can be reworded.)
    const waiting = !isNew && base.once && base.enabled && t.nextRunAt === base.nextRunAt;
    if (t.enabled && t.nextRunAt < now - 60_000 && !waiting)
      return { error: isNew ? "that time is in the past — pick a time in the future" : "that time has passed — edit the reminder and pick a new time" };
  } else {
    if (interval !== null) {
      if (interval < MIN_INTERVAL_SEC) return { error: "intervalSec must be at least 60 (once a minute)" };
      if (interval > MAX_INTERVAL_SEC) return { error: "intervalSec must be at most a year" };
      t.intervalSec = Math.round(interval);
    } else if (isNew) t.intervalSec = 1800;
    if (!(t.intervalSec > 0)) return { error: "a recurring task needs intervalSec" };
    if (runAt !== null) t.nextRunAt = runAt;
    // A new rhythm (or a reminder turned recurring) starts counting now.
    else if (isNew || base.once || (interval !== null && t.intervalSec !== base.intervalSec)) t.nextRunAt = now + t.intervalSec * 1000;
    // Resumed after a pause: its next slot, not a burst of the missed ones.
    else if (t.enabled && t.nextRunAt <= now) t.nextRunAt = nextSlot(t, now);
    // A weekday rule: its next run is on one of its days (the same time of day, on the task's own rhythm).
    if (t.days?.length && !t.days.includes(new Date(t.nextRunAt).getDay())) t.nextRunAt = nextSlot(t, t.nextRunAt);
  }
  // An edited task starts clean: no failed deliveries behind it.
  t.attempts = 0;
  t.retryAt = null;
  return t;
}

/** What GET /heartbeat/checkin answers: the check-in's settings and its checklist. */
function checkinView(): CheckinSettings & { checklist: string; limit: number } {
  return { ...getCheckinSettings(), checklist: getChecklist(), limit: PROFILE_LIMITS.checklist };
}

/**
 * Heartbeat API (mounted under /api): recurring tasks (with an optional weekday rule) and one-time reminders,
 * and the quiet check-in — its checklist, active hours and idle time. The engine's own silent jobs aren't listed.
 */
export function heartbeatRouter(): Router {
  const r = express.Router();

  // The user's reminders and tasks (?all=1 adds the check-in's own task).
  r.get("/heartbeat", (req, res) => res.json(listTasks().filter((t) => req.query.all === "1" || !t.kind)));

  // ── The check-in ──
  r.get("/heartbeat/checkin", (_req, res) => {
    ensureSystemTasks();
    res.json(checkinView());
  });
  r.put("/heartbeat/checkin", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.checklist !== undefined) {
      if (typeof b.checklist !== "string") return res.status(400).json({ error: "checklist must be text" });
      const done = setChecklist(b.checklist);
      if (!done.ok) return res.status(400).json({ error: done.error ?? "the checklist could not be saved" });
    }
    const patch: Partial<CheckinSettings> = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled === true || b.enabled === "true";
    if (b.everyMin !== undefined) patch.everyMin = Number(b.everyMin);
    if (b.idleMin !== undefined) patch.idleMin = Number(b.idleMin);
    if (b.activeFrom !== undefined) patch.activeFrom = String(b.activeFrom);
    if (b.activeTo !== undefined) patch.activeTo = String(b.activeTo);
    const saved = setCheckinSettings(patch);
    if ("error" in saved) return res.status(400).json(saved);
    res.json(checkinView());
  });

  r.get("/heartbeat/:id", (req, res) => {
    const t = getTask(req.params.id);
    return t && t.kind !== "system" ? res.json(t) : res.status(404).json({ error: "not found" });
  });
  r.post("/heartbeat", (req, res) => {
    const blank: ScheduledTask = {
      id: nanoid(10),
      title: "",
      instruction: "",
      intervalSec: 0,
      nextRunAt: 0,
      lastRunAt: null,
      enabled: true,
      once: false,
    };
    const out = applyBody(blank, (req.body ?? {}) as TaskBody, true);
    if ("error" in out) return res.status(400).json(out);
    saveTask(out);
    res.json(out);
  });
  r.put("/heartbeat/:id", (req, res) => {
    const existing = getTask(req.params.id);
    if (!existing || existing.kind === "system") return res.status(404).json({ error: "not found" });
    // (The check-in is changed through its own route: it has no instruction to edit.)
    if (existing.kind === "checkin" || existing.id === CHECKIN_ID) return res.status(400).json({ error: "the check-in is changed under /heartbeat/checkin" });
    const out = applyBody(existing, (req.body ?? {}) as TaskBody, false);
    if ("error" in out) return res.status(400).json(out);
    saveTask(out);
    res.json(out);
  });
  r.delete("/heartbeat/:id", (req, res) => {
    const existing = getTask(req.params.id);
    // The engine's own tasks stay (the check-in is switched off, not deleted).
    if (existing?.kind) return res.status(400).json({ error: "that task belongs to the engine: switch the check-in off instead" });
    deleteTask(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
