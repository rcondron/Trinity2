import { dueTasks, saveTask } from "./db/sqlite.js";
import type { Orchestrator } from "./orchestrator.js";
import type { ServerEvent } from "./types.js";

const TICK_MS = 30_000;

/**
 * The heartbeat: every 30 seconds, process any recurring tasks that are due.
 * Each task is a natural-language instruction Trinity acts on proactively.
 */
export function startHeartbeat(
  orchestrator: Orchestrator,
  broadcast: (e: ServerEvent) => void,
): () => void {
  const tick = async () => {
    const now = Date.now();
    for (const task of dueTasks(now)) {
      broadcast({ type: "heartbeat", task, fired: true });
      try {
        await orchestrator.runHeartbeat(task.instruction, broadcast);
      } catch (err) {
        broadcast({ type: "error", text: `Heartbeat "${task.title}" failed: ${(err as Error).message}` });
      }
      saveTask({ ...task, lastRunAt: now, nextRunAt: now + task.intervalSec * 1000 });
    }
  };

  const handle = setInterval(() => void tick(), TICK_MS);
  console.log(`[heartbeat] running every ${TICK_MS / 1000}s`);
  return () => clearInterval(handle);
}
