// figure_out: for a request no other tool covers, the problem solver (services/agent-loop.ts) works it out with the
// tools Trinity has, in the background when it takes long, and says what happened. Also here: picking a paused run up
// again when the user answers the solver's question (resumeSolve), replaying a procedure skill's plan, and the scope
// a caller uses to keep tools away from any solver run it starts (withHiddenTools).
import { AsyncLocalStorage } from "node:async_hooks";
import { contextFor } from "../agent/context.js";
import { visibleTools } from "../agent/router.js";
import { tell } from "../agent/tell.js";
import { recentTurns } from "../db/conversations.js";
import { sharedMemory } from "../db/memory.js";
import { getActivePersona } from "../db/sqlite.js";
import { clearPausedSolve, hasPausedSolve, pausedSolve, solve, type SolveInput, type SolveResult } from "../services/agent-loop.js";
import { listForged, procedureText, setProcedureRunner } from "../services/skill-forge.js";
import { getEndpoints, live, modelName } from "../settings.js";
import type { ServerEvent, Tool, ToolContext, ToolResult } from "../types.js";
import { bg } from "../util/bg.js";
import { workspace } from "../workspace/bus.js";
import { registerTool } from "./registry.js";
import { hiddenTools } from "./scope.js";

export { hasPausedSolve } from "../services/agent-loop.js";

/** How long the user waits for a result before being told it's in hand. */
const SPEAK_WAIT_MS = 8_000;
/** …and when they have just answered the solver's question: long enough to know whether their words were an answer at all. */
const RESUME_WAIT_MS = 20_000;
/** Tools the solver never calls on its own: itself, the user's answer to its own question, and a knob that isn't a step of any job. */
const NOT_FOR_SOLVER = new Set(["figure_out", "answer_followup", "set_speech_rate"]);

// ─── Tools hidden from a run ──────────────────────────────────────────────────────────────

const depthScope = new AsyncLocalStorage<number>();

// Run `fn` with tools kept away from every problem-solver run it starts, however deep (figure_out, a procedure
// skill): see tools/scope.ts. The heartbeat wraps a scheduled run in it with the tools such a run may not pick
// itself — schedule, remember, create_skill and the rest — so the solver can't reach them for it either.
export { withHiddenTools } from "./scope.js";

/**
 * What is hidden for this call: the caller's scope, and a `hiddenTools` set on the tool context if it carries one.
 * Read once, when the run starts, and kept for all of it (a run that goes on in the background after its caller
 * was answered is still held to it).
 */
function hiddenFor(ctx: ToolContext): Set<string> {
  const onContext = (ctx as ToolContext & { hiddenTools?: Iterable<string> }).hiddenTools;
  return new Set([...hiddenTools(), ...(onContext ?? [])]);
}

// ─── Running the solver for a tool ────────────────────────────────────────────────────────

interface RunOptions {
  /** The request to work out. */
  ask: string;
  hidden: Set<string>;
  guidance?: string;
  resume?: SolveInput["resume"];
  model?: string;
  noTrace?: boolean;
  /** How long to wait before answering "I'm working on it". */
  waitMs?: number;
  label?: string;
}

function toResult(r: SolveResult, model: string): ToolResult {
  const data = { steps: r.steps, used: r.used, forged: r.forged, model, ...(r.question ? { question: true } : {}) };
  // A question is the solver's own words too: said as written (the run waits for the answer).
  if (r.ok || r.question) return { ok: r.ok, say: r.say, speak: r.say, data };
  return { ok: false, say: r.say, data };
}

/** Null: a resumed run found the user's words weren't an answer (they start something else). */
async function runSolve(ctx: ToolContext, o: RunOptions): Promise<ToolResult | null> {
  const depth = depthScope.getStore() ?? 0;
  if (depth >= 2) return { ok: false, say: "That would have me going in circles, so I stopped." };
  const e = getEndpoints();
  const model = o.model || e.plannerModel || e.brainModel;
  const id = `solve:${Date.now().toString(36)}`;
  workspace.activity(id, `${modelName(model)} is working it out…`);
  // While a plan is being replayed (or inside another solver run), the plans themselves are off the list: a plan doesn't call a plan.
  const procedures = depth >= 1 || o.guidance ? listForged().filter((s) => s.kind === "procedure").map((s) => s.name) : [];
  const hidden = new Set([...o.hidden, ...procedures]);
  const solving = depthScope
    .run(depth + 1, () =>
      solve({
        persona: ctx.persona,
        utterance: o.ask,
        situation: ctx.situation,
        recentTranscript: ctx.recentTranscript,
        // Asked again before every step: what a step puts on the board (or forges) is there for the next one.
        tools: () => visibleTools(ctx.persona, contextFor(ctx.persona).hiddenActions).filter((t: Tool) => !NOT_FOR_SOLVER.has(t.name)),
        hidden,
        model,
        ...(o.guidance ? { guidance: o.guidance } : {}),
        ...(o.resume ? { resume: o.resume } : {}),
        ...(o.noTrace ? { noTrace: true } : {}),
        io: {
          persona: ctx.persona,
          memory: ctx.memory,
          emit: (ev) => ctx.emit(ev as unknown as ServerEvent),
          recentTranscript: ctx.recentTranscript,
          situation: ctx.situation,
          minConfidence: e.minConfidence,
        },
        onStep: (text) => workspace.activity(id, text),
      }),
    )
    .finally(() => workspace.activity(id, null));
  const first = await Promise.race([solving, new Promise<"later">((r) => setTimeout(() => r("later"), o.waitMs ?? SPEAK_WAIT_MS))]);
  if (first !== "later") return first.unrelated ? null : toResult(first, model);
  // Slower than the user should wait: say it's in hand; the answer (or the solver's question) is told when it lands.
  bg(o.label ?? "figure_out", solving.then((r) => (r.unrelated ? undefined : tell(ctx, r.say, o.label ?? "figure_out"))));
  return { ok: true, say: `I'm working that out with ${modelName(model)}; I'll say what I find.`, inProgress: "started", data: { model } };
}

const figureOut: Tool = {
  name: "figure_out",
  description:
    "Work out how to do something none of the other tools covers — a job that takes several steps, a site or service with no tool yet, 'figure out how to…', 'find a way to…' — by trying the tools available and making a new skill if none fits. Not for questions, chat, or anything another tool does directly.",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx: ToolContext): Promise<ToolResult> {
    if (!live.mordiem) return { ok: false, say: "Working things out needs a text model — add a Mordiem key in Settings." };
    const ask = ctx.utterance.trim();
    if (!ask) return { ok: false, say: "What should I work out?" };
    // A new request replaces a question nobody answered.
    clearPausedSolve();
    return (await runSolve(ctx, { ask, hidden: hiddenFor(ctx) })) ?? { ok: false, say: "I couldn't work out how to do that." };
  },
};

// ─── Picking a paused run up again ────────────────────────────────────────────────────────

/** A tool context for work that starts without one (the user answered between tools): the active persona, the shared memory, the stored conversation. */
function standingContext(utterance: string): ToolContext | null {
  try {
    const memory = sharedMemory();
    if (!memory) return null;
    const persona = getActivePersona();
    return { persona, recentTranscript: recentTurns(6, { withinMs: 30 * 60_000 }), emit: () => {}, utterance, memory, situation: contextFor(persona).summary };
  } catch (err) {
    console.warn("[solver] no standing context to resume in:", (err as Error).message);
    return null;
  }
}

/**
 * The user's next words after the solver asked them something: the paused run goes on with their answer. Returns
 * what to say (like a tool result: `speak` verbatim when set; a new question pauses the run again), or null when
 * there is nothing to resume or their words weren't an answer — then handle them as any other sentence. "Never
 * mind" drops the run. Pass the tool context of the turn when there is one.
 */
export async function resumeSolve(answer: string, ctx?: ToolContext): Promise<ToolResult | null> {
  const paused = pausedSolve();
  const said = String(answer ?? "").trim();
  if (!paused || !said) return null;
  // One answer per question: whatever happens next, this question is no longer open.
  clearPausedSolve();
  if (/^(?:(?:oh|ok(?:ay)?|no|nah|actually)[,\s]+)*(?:never ?mind|cancel(?: (?:that|it))?|forget (?:it|that|about it)|skip it|leave it|stop)\b[\s.!]*$/i.test(said)) {
    const line = "Okay, I'll leave that.";
    return { ok: true, say: line, speak: line };
  }
  if (!live.mordiem) return null;
  const context = ctx ?? standingContext(said);
  if (!context) return null;
  return runSolve(context, {
    ask: paused.request,
    hidden: new Set([...paused.hidden, ...hiddenFor(context)]),
    ...(paused.guidance ? { guidance: paused.guidance } : {}),
    ...(paused.model ? { model: paused.model } : {}),
    resume: { history: paused.history, used: paused.used, trace: paused.trace, question: paused.question, answer: said },
    waitMs: RESUME_WAIT_MS,
    label: "figure_out",
  });
}

/**
 * answer_followup: the user's answer to the question the solver asked ("Which city should I check?"). Offered only
 * while that question is waiting (ten minutes), and its description carries the question, so the router can tell
 * an answer from a new request. The paused run goes on with the answer; words that turn out not to be one are
 * worked out as a request of their own. (A channel that calls resumeSolve itself before routing gets there first:
 * the question is then no longer waiting, and this tool is not offered.)
 */
const answerFollowup: Tool = {
  name: "answer_followup",
  get description(): string {
    const question = pausedSolve()?.question.replace(/\s+/g, " ").trim().slice(0, 200);
    return `The user answers the question Trinity just asked while working something out for them${question ? ` (“${question}”)` : ""}: any answer to it, a detail it asked for, or "never mind" — only while that question is waiting.`;
  },
  input: {},
  argMode: "raw",
  source: "builtin",
  available: () => hasPausedSolve(),
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const words = (ctx.userWords ?? ctx.utterance).trim();
    return (await resumeSolve(words, ctx)) ?? figureOut.run(args, { ...ctx, utterance: words });
  },
};

export function registerSolveTools(): void {
  registerTool(figureOut);
  registerTool(answerFollowup);
  // A procedure skill (a plan learned from a job done twice) is replayed here: the solver, with the plan as its guide.
  setProcedureRunner(async (skill, ctx) => {
    if (!live.mordiem) return { ok: false, say: "Replaying that needs a text model — add a Mordiem key in Settings." };
    const ask = (ctx.userWords ?? ctx.utterance).trim() || skill.procedure?.request || skill.need;
    return (await runSolve(ctx, { ask, hidden: hiddenFor(ctx), guidance: procedureText(skill), noTrace: true, label: skill.name })) ?? { ok: false, say: "I couldn't do that this time." };
  });
}
