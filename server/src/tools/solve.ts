// figure_out: for a request no other tool covers, the problem solver (services/agent-loop.ts) works it out with the
// tools Trinity has, in the background when it takes long, and says what happened.
import { contextFor } from "../agent/context.js";
import { visibleTools } from "../agent/router.js";
import { tell } from "../agent/tell.js";
import { solve } from "../services/agent-loop.js";
import { getEndpoints, live, modelName } from "../settings.js";
import type { ServerEvent, Tool, ToolContext, ToolResult } from "../types.js";
import { bg } from "../util/bg.js";
import { workspace } from "../workspace/bus.js";
import { registerTool } from "./registry.js";

/** How long the user waits for a result before being told it's in hand. */
const SPEAK_WAIT_MS = 8_000;
/** Tools the solver never calls on its own: itself, and a knob that isn't a step of any job. */
const NOT_FOR_SOLVER = new Set(["figure_out", "set_speech_rate"]);

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
    const e = getEndpoints();
    const model = e.plannerModel || e.brainModel;
    const id = `solve:${Date.now().toString(36)}`;
    workspace.activity(id, `${modelName(model)} is working it out…`);
    const tools = visibleTools(ctx.persona, contextFor(ctx.persona).hiddenActions).filter((t) => !NOT_FOR_SOLVER.has(t.name));
    const solving = solve({
      persona: ctx.persona,
      utterance: ask,
      situation: ctx.situation,
      recentTranscript: ctx.recentTranscript,
      tools,
      model,
      io: {
        persona: ctx.persona,
        memory: ctx.memory,
        emit: (ev) => ctx.emit(ev as unknown as ServerEvent),
        recentTranscript: ctx.recentTranscript,
        situation: ctx.situation,
        minConfidence: e.minConfidence,
      },
      onStep: (text) => workspace.activity(id, text),
    }).finally(() => workspace.activity(id, null));
    const first = await Promise.race([solving, new Promise<"later">((r) => setTimeout(() => r("later"), SPEAK_WAIT_MS))]);
    if (first !== "later") {
      return {
        ok: first.ok,
        say: first.say,
        speak: first.ok ? first.say : undefined,
        data: { steps: first.steps, used: first.used, forged: first.forged, model },
      };
    }
    // Slower than the user should wait: say it's in hand; the answer is told when it lands.
    bg("figure_out", solving.then((r) => tell(ctx, r.say, "figure_out")));
    return { ok: true, say: `I'm working that out with ${modelName(model)}; I'll say what I find.`, inProgress: "started", data: { model } };
  },
};

export function registerSolveTools(): void {
  registerTool(figureOut);
}
