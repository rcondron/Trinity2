import { dueForVoice, dueTasks, finishTask, rescheduleTask } from "./db/sqlite.js";
import type { Orchestrator } from "./orchestrator.js";
import { hasVoiceCall } from "./services/voice-call.js";
import { isReminder } from "./tools/schedule.js";
import type { HeartbeatTask, ServerEvent } from "./types.js";
import { bg, safeInterval } from "./util/bg.js";
import { workspace } from "./workspace/bus.js";

const TICK_MS = 5_000;
/** Items already overdue when the engine starts wait this long, so a warm call can reconnect and hear them. */
const BOOT_GRACE_MS = 20_000;
/** A scheduled run (Jev → tool → reply) taking longer than this is stopped, and says nothing (see Orchestrator.runHeartbeat). */
const RUN_LIMIT_MS = 90_000;
/** A recurring task missed by more than this — or by half its interval — (the engine was off) skips to its next slot. */
const MAX_LATE_MS = 3 * 3600_000;
/** An item due this soon (see dueForVoice) wakes the app's voice if none is up (connecting takes 5–10 s), so it's heard. */
const WAKE_AHEAD_MS = 45_000;

/**
 * The task's next slot strictly after `after`, keeping its rhythm: "every 30 minutes" stays on
 * its half hours, and a daily (or weekly) task keeps its wall-clock time across daylight saving.
 */
export function nextSlot(task: Pick<HeartbeatTask, "intervalSec" | "nextRunAt">, after: number): number {
  const step = task.intervalSec * 1000;
  if (!(step > 0)) return after + 60_000;
  if (task.nextRunAt > after) return task.nextRunAt;
  const missed = Math.floor((after - task.nextRunAt) / step);
  if (task.intervalSec % 86_400 === 0) {
    const days = task.intervalSec / 86_400;
    const d = new Date(task.nextRunAt);
    d.setDate(d.getDate() + missed * days);
    while (d.getTime() <= after) d.setDate(d.getDate() + days);
    return d.getTime();
  }
  return task.nextRunAt + (missed + 1) * step;
}

/**
 * The heartbeat: every 5 seconds (one indexed query), act on what's due. First the bookkeeping —
 * a one-time item is marked done, a recurring task moves to its next slot (so a failing task
 * can't fire every tick) — then the delivery: a plain reminder is said at once, anything else
 * runs through the agent core as a proactive turn. Agent runs go one at a time so they never talk
 * over each other, and never delay a reminder. Either way it's spoken in the live call if there
 * is one, and shown to text clients and the workspace (see Orchestrator.proactive).
 *
 * With nobody to tell (`canDeliver`: no app or workspace window open, no call) a one-time item stays
 * due until someone is back, and a recurring task skips that slot. An item coming up while no voice
 * call is up (a one-time item, or a recurring task that runs at most hourly) asks the app to warm
 * one (a "wake" event), so it's said aloud rather than only shown.
 */
export function startHeartbeat(
  orchestrator: Orchestrator,
  broadcast: (e: ServerEvent) => void,
  opts: { tickMs?: number; bootGraceMs?: number; canDeliver?: () => boolean } = {},
): () => void {
  const startedAt = Date.now();
  const bootGrace = opts.bootGraceMs ?? BOOT_GRACE_MS;
  const canDeliver = opts.canDeliver ?? (() => true);
  const queued = new Set<string>(); // tasks waiting for (or in) their agent run
  const woken = new Set<string>(); // items ("id@nextRunAt": one per slot) the app was asked to warm the voice for
  let chain: Promise<void> = Promise.resolve();

  const run = async (task: HeartbeatTask) => {
    const chip = `heartbeat:${task.id}`;
    // A plain reminder is said instantly; a task that does work shows that it's on it.
    if (!isReminder(task.instruction)) workspace.activity(chip, `Scheduled: ${task.title}…`);
    // Past the limit the run is stopped: nothing it was still working on gets said.
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new Error("took too long")), RUN_LIMIT_MS);
    try {
      await orchestrator.runHeartbeat(task, broadcast, limit.signal);
    } catch (err) {
      broadcast({ type: "error", text: `Heartbeat "${task.title}" failed: ${(err as Error).message}` });
      // A one-time item won't come round again: say plainly that it didn't happen (a recurring task just runs next time).
      const why = limit.signal.aborted ? "it took too long" : "I couldn't get an answer from the model";
      if (task.once) bg("heartbeat", orchestrator.proactive(`Your scheduled "${task.title}" didn't run — ${why}.`, broadcast, task.title));
    } finally {
      clearTimeout(timer);
      workspace.activity(chip, null);
    }
  };

  /** An item due soon (or a one-time one due and waiting) with no voice call up: wake the app's voice, once per item. */
  const wake = (now: number) => {
    const keys = dueForVoice(now + WAKE_AHEAD_MS).map((t) => `${t.id}@${t.nextRunAt}`);
    for (const k of woken) if (!keys.includes(k)) woken.delete(k);
    if (hasVoiceCall() || keys.every((k) => woken.has(k))) return;
    for (const k of keys) woken.add(k);
    broadcast({ type: "wake" });
  };

  const tick = () => {
    const now = Date.now();
    const deliverable = canDeliver();
    for (const t of dueTasks(now)) {
      // Overdue from before this boot: give the voice call a moment to reconnect first.
      if (now - startedAt < bootGrace && t.nextRunAt < startedAt) continue;
      let task: HeartbeatTask;
      if (t.once) {
        // Nobody to tell: it stays due until someone's back, then is said as late (its time is kept).
        if (!deliverable) continue;
        finishTask(t.id, now);
        task = { ...t, enabled: false, lastRunAt: now };
      } else {
        if (queued.has(t.id)) continue; // its previous run hasn't finished yet
        const next = nextSlot(t, now);
        if (now - t.nextRunAt > Math.min(MAX_LATE_MS, t.intervalSec * 500)) {
          rescheduleTask(t.id, t.lastRunAt, next);
          console.log(`[heartbeat] "${t.title}" missed its slot (engine off or busy); next run ${new Date(next).toLocaleString()}`);
          continue;
        }
        if (!deliverable) {
          rescheduleTask(t.id, t.lastRunAt, next);
          console.log(`[heartbeat] "${t.title}" skipped: nobody to tell (no app open, no call); next run ${new Date(next).toLocaleString()}`);
          continue;
        }
        rescheduleTask(t.id, now, next);
        task = { ...t, lastRunAt: now, nextRunAt: next };
      }
      broadcast({ type: "heartbeat", task, fired: true });
      // A plain reminder needs no model calls and never waits; work for the agent core goes one run at a time.
      if (isReminder(task.instruction)) {
        bg("heartbeat", run(task));
        continue;
      }
      const id = task.id;
      queued.add(id);
      chain = chain.then(() => run(task)).finally(() => queued.delete(id));
    }
    if (deliverable) wake(now);
  };

  const tickMs = opts.tickMs ?? TICK_MS;
  const handle = safeInterval("heartbeat", tick, tickMs);
  console.log(`[heartbeat] running every ${tickMs / 1000}s`);
  return () => clearInterval(handle);
}
