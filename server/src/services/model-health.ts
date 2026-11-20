import { rawEndpoints, setModelStandIns, type Endpoints, type ModelStandIn } from "../settings.js";
import { bg, safeInterval } from "../util/bg.js";
import { mordiemModels } from "./llm.js";

/**
 * The gateway's catalog changes under us: a model the settings name can be gone one morning (mercury-3, the default
 * quick coder and card designer, was), and from then on every call to it fails with "not available on this platform" —
 * builds that never arrive, a solver that never plans. So the configured models are checked against the catalog when
 * the engine starts, every ten minutes, and whenever the settings change; one that is missing is stood in for by the
 * first available model of a short list for its role, and Settings says so (the stored setting isn't touched: if the
 * model comes back, it is used again).
 */

type ModelKey = "brainModel" | "chatModel" | "chatBackupModel" | "cardModel" | "glmModel" | "kimiModel" | "plannerModel" | "replyModel" | "fastModel";

/** For each role, models that can do it, best first (measured on this engine's own prompts where a note says so). */
const STAND_INS: Record<ModelKey, string[]> = {
  brainModel: ["claude-sonnet-5-5", "deepseek-v4-1-flash", "claude-haiku-5-5", "z-ai-glm-5-3-flash"],
  chatModel: ["claude-haiku-5-5", "deepseek-v4-1-flash", "claude-sonnet-5-5"],
  chatBackupModel: ["claude-haiku-5-5", "claude-sonnet-5-5", "deepseek-v4-1-flash"],
  cardModel: ["deepseek-v4-1-flash-1017-ultrafast", "claude-haiku-5-5", "z-ai-glm-5-3-flash", "deepseek-v4-1-flash", "nvidia-nemotron-3-nano-30b-a3b"],
  glmModel: ["deepseek-v4-1-flash-1017-ultrafast", "claude-haiku-5-5", "z-ai-glm-5-3-flash", "deepseek-v4-1-flash", "deepseek-v4-flash-0731-fast"],
  kimiModel: ["kimi-k3", "kimi-k3-1-pro", "claude-sonnet-5-5", "z-ai-glm-5-3"],
  plannerModel: ["kimi-k3", "claude-sonnet-5-5", "z-ai-glm-5-3", "deepseek-v4-1-flash"],
  replyModel: ["nvidia-nemotron-3-nano-30b-a3b", "claude-haiku-5-5", "deepseek-v4-1-flash", "llama-3.3-70b"],
  fastModel: ["nvidia-nemotron-3-nano-30b-a3b", "claude-haiku-5-5", "deepseek-v4-1-flash", "llama-3.3-70b"],
};

let checking: Promise<ModelStandIn[]> | null = null;

/** Check the configured text models against the gateway's catalog and stand in for the missing ones. */
export function checkModels(): Promise<ModelStandIn[]> {
  checking ??= run().finally(() => {
    checking = null;
  });
  return checking;
}

async function run(): Promise<ModelStandIn[]> {
  const e = rawEndpoints();
  if (!e.mordiemKey) return [];
  const { text } = await mordiemModels();
  // (An empty catalog means the gateway couldn't be reached: nothing is known, so nothing is swapped.)
  if (!text.length) return [];
  const have = new Set(text);
  const out: ModelStandIn[] = [];
  for (const key of Object.keys(STAND_INS) as ModelKey[]) {
    const configured = (e as Endpoints)[key];
    if (!configured || have.has(configured)) continue; // blank: the role falls back by itself (e.g. chat = brain)
    const using = STAND_INS[key].find((m) => have.has(m)) ?? "";
    out.push({ key, configured, using });
  }
  const before = JSON.stringify(setModelStandIns(out));
  if (JSON.stringify(out) !== before)
    for (const s of out)
      console.warn(`[models] "${s.configured}" (${s.key}) isn't on the gateway any more — ${s.using ? `using "${s.using}" instead` : "and no stand-in is available"}. Pick another in Settings → Models.`);
  return out;
}

/** Check now, and every ten minutes (the catalog is cached for that long). */
export function watchModels(): void {
  bg("models", checkModels());
  safeInterval("models", () => checkModels(), 10 * 60_000 + 5_000);
}
