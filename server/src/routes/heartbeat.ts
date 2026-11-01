import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { deleteTask, getTask, listTasks, saveTask } from "../db/sqlite.js";
import { nextSlot } from "../heartbeat.js";
import type { HeartbeatTask } from "../types.js";

const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 366 * 86_400;
const LIMITS = { title: 80, instruction: 2000 };

/** POST/PUT body: any of these (PUT merges). `runAt` (epoch ms or a date string) sets the next run. */
interface TaskBody {
  title?: unknown;
  instruction?: unknown;
  intervalSec?: unknown;
  once?: unknown;
  runAt?: unknown;
  nextRunAt?: unknown;
  enabled?: unknown;
}

function time(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
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
function applyBody(base: HeartbeatTask, b: TaskBody, isNew: boolean): HeartbeatTask | { error: string } {
  const now = Date.now();
  const t: HeartbeatTask = { ...base };
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
  }
  return t;
}

/** Heartbeat API (mounted under /api): recurring tasks and one-time reminders. */
export function heartbeatRouter(): Router {
  const r = express.Router();

  r.get("/heartbeat", (_req, res) => res.json(listTasks()));
  r.get("/heartbeat/:id", (req, res) => {
    const t = getTask(req.params.id);
    return t ? res.json(t) : res.status(404).json({ error: "not found" });
  });
  r.post("/heartbeat", (req, res) => {
    const blank: HeartbeatTask = {
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
    if (!existing) return res.status(404).json({ error: "not found" });
    const out = applyBody(existing, (req.body ?? {}) as TaskBody, false);
    if ("error" in out) return res.status(400).json(out);
    saveTask(out);
    res.json(out);
  });
  r.delete("/heartbeat/:id", (req, res) => {
    deleteTask(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
