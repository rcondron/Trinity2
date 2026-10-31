import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (two levels up from server/src). */
export const ROOT = path.resolve(__dirname, "..", "..");
export const DATA_DIR = path.join(ROOT, "data");
export const SKILLS_DIR = path.join(ROOT, "server", "skills");

export const config = {
  port: Number(process.env.PORT) || 8799,

  fal: {
    key: process.env.FAL_KEY || "",
    model: "fal-ai/personaplex",
  },
  openrouter: {
    key: process.env.OPENROUTER_API_KEY || "",
    base: "https://openrouter.ai/api/v1",
    jevModel: process.env.JEV_MODEL || "typesafe/jev",
    brainModel: process.env.BRAIN_MODEL || "anthropic/claude-sonnet-5-5",
  },
  morph: {
    key: process.env.MORPH_API_KEY || "",
    base: "https://api.morphllm.com/v1",
    model: process.env.MORPH_MODEL || "morph-v3-fast",
  },
  web: {
    key: process.env.WEB_SEARCH_API_KEY || "",
  },
} as const;

/** Which services have real credentials. Everything else runs in mock mode. */
export const live = {
  voice: Boolean(config.fal.key),
  jev: Boolean(config.openrouter.key),
  brain: Boolean(config.openrouter.key),
  morph: Boolean(config.morph.key),
  web: Boolean(config.web.key),
};

export function serviceStatus() {
  const m = (b: boolean): "live" | "mock" => (b ? "live" : "mock");
  return {
    voice: m(live.voice),
    jev: m(live.jev),
    brain: m(live.brain),
    morph: m(live.morph),
    web: m(live.web),
  };
}
