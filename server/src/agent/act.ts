import type { MemoryStore } from "../db/memory.js";
import { addCard, boardBlocked } from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import type { Persona, ServerEvent, ToolResult, TranscriptTurn } from "../types.js";
import { extractArgs } from "./extract.js";
import { argModeOf, confidentOptions, type Decision, type RecentAction } from "./router.js";

/**
 * Executes a routing decision: every action is a tool (the coding skill build_ui, ask_brain,
 * create_skill, remember, a forged skill, a game tool, …). Its free-text arguments are
 * extracted by the fast model when it needs them, the run is awaited (bounded), and the
 * result becomes an Outcome for the reply writer. Slow work (a build streaming in, a skill
 * being forged) continues in the background inside its tool, which returns at once with
 * `inProgress` — so the reply acknowledges it right away without claiming it's done.
 */
export interface ActIO {
  persona: Persona;
  memory: MemoryStore;
  /** Channel events: tool, tool_result, memory, skill_forged, status. */
  emit: (e: Record<string, unknown>) => void;
  recentTranscript: TranscriptTurn[];
  /** Situation summary (agent context) — helps argument extraction. */
  situation: string;
  minConfidence: number;
}

export interface Outcome {
  ok: boolean;
  /** What happened, in words — input to the reply writer. */
  say: string;
  /** Speak this verbatim (skip the reply writer) — grounded narration/answers. */
  speak?: string;
  /** Background work was started (a build, a new skill) or queued behind a running build; the reply must not claim it's finished. */
  inProgress?: "started" | "queued";
  action: string;
  args: Record<string, unknown>;
}

const TOOL_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("tool timed out")), ms)));
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** The recent_actions entry Jev sees for this action (reference format). */
export function recentAction(o: Outcome, text: string): RecentAction {
  const args = Object.entries(o.args)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(", ");
  return { action: `${o.action}(${args})`, kind: "tool", text, page_changed: true };
}

// ─── What tools just found ───────────────────────────────────────────────────

/** A finished tool result, kept briefly so the next action can use it ("chart what we just found"). */
export interface RecentResult {
  tool: string;
  say: string;
  /** The result's data as compact JSON (cut short), when it had any. */
  data?: string;
  at: number;
}

const RESULTS_KEPT = 4;
const results: RecentResult[] = [];

/** Remember a tool's result for later turns ("chart that"). act() does this; call it for a tool run outside act(). */
export function noteResult(tool: string, r: ToolResult): void {
  if (!r.ok || r.inProgress || !r.say) return;
  let data: string | undefined;
  try {
    data = r.data === undefined || r.data === null ? undefined : JSON.stringify(r.data).slice(0, 1500);
  } catch {
    /* not serializable — the words are enough */
  }
  results.push({ tool, say: r.say.slice(0, 600), data, at: Date.now() });
  if (results.length > RESULTS_KEPT) results.shift();
}

/** The last few tool results (oldest first) from the past `maxAgeMs`. */
export function recentResults(maxAgeMs = 10 * 60_000): RecentResult[] {
  const since = Date.now() - maxAgeMs;
  return results.filter((r) => r.at >= since);
}

// ─── Running a tool ──────────────────────────────────────────────────────────

/** A tool's HTML (search results, a skill's page) goes up as a widget card on the board; a page of its own only while a game owns the screen. */
function showRender(toolName: string, html: string): void {
  const title = toolName.replace(/_/g, " ");
  if (boardBlocked()) {
    workspace.showHtml(html, title);
    return;
  }
  addCard({ kind: "widget", title: title.charAt(0).toUpperCase() + title.slice(1), text: title, status: "ready", html, w: 40, h: 60 });
}

export async function act(d: Decision, utterance: string, io: ActIO): Promise<Outcome> {
  const tool = d.tool;
  if (!tool) return { ok: false, say: "I'm not sure what to do with that.", action: d.action, args: {} };
  const preset = confidentOptions(d, io.minConfidence);
  const args = argModeOf(tool) === "llm" ? await extractArgs(tool, utterance, io.situation, preset) : { ...preset };
  io.emit({ type: "tool", tool: tool.name, args });
  // Every Jev action is mirrored into the workspace window (decisions arrive from the caller).
  workspace.agent("tool", { tool: tool.name, text: utterance, args });

  let result: ToolResult;
  try {
    result = await withTimeout(
      tool.run(args, {
        persona: io.persona,
        recentTranscript: io.recentTranscript,
        emit: (e: ServerEvent) => io.emit(e as unknown as Record<string, unknown>),
        utterance,
        memory: io.memory,
        situation: io.situation,
      }),
      TOOL_TIMEOUT_MS,
    );
  } catch (err) {
    result = { ok: false, error: (err as Error).message };
  }
  // Keep channel events small: rendered HTML goes to the workspace, not the transcript.
  io.emit({ type: "tool_result", tool: tool.name, result: { ok: result.ok, say: result.say, error: result.error } });
  workspace.agent("tool_result", {
    tool: tool.name,
    ok: result.ok,
    text: result.ok ? result.say : (result.say ?? result.error),
  });
  if (result.render) showRender(tool.name, result.render);
  noteResult(tool.name, result);

  // A failed tool's own words (a decline, a clarifying question) come first.
  const say = result.ok ? (result.say ?? "Done.") : (result.say ?? `That didn't work: ${result.error ?? "unknown error"}`);
  return {
    ok: result.ok,
    say,
    speak: result.ok ? result.speak : undefined,
    inProgress: result.ok ? result.inProgress : undefined,
    action: tool.name,
    args,
  };
}
