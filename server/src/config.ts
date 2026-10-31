import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (two levels up from server/src). */
export const ROOT = path.resolve(__dirname, "..", "..");
/** Override with TRINITY_DATA_DIR to run multiple instances (e.g. for tests). */
export const DATA_DIR = process.env.TRINITY_DATA_DIR
  ? path.resolve(process.env.TRINITY_DATA_DIR)
  : path.join(ROOT, "data");
export const SKILLS_DIR = path.join(ROOT, "server", "skills");

export const config = {
  port: Number(process.env.PORT) || 8799,

  fal: {
    key: process.env.FAL_KEY || "",
    // fal QUEUE base for PersonaPlex. The sync fal.run endpoint hangs; the queue
    // API (submit -> poll status -> fetch result) is the working path.
    url: process.env.PERSONAPLEX_URL || "https://queue.fal.run/fal-ai/personaplex",
    defaultVoice: process.env.PERSONAPLEX_VOICE || "NATF2",
  },
  // Jev (TypeSafe AI) — a custom "System One" decision API, not OpenAI-compatible.
  typesafe: {
    key: process.env.TYPESAFE_API_KEY || "",
    base: process.env.TYPESAFE_URL || "https://api.typesafe.ai",
    model: process.env.JEV_MODEL || "jev-latest",
  },
  // Mordiem — OpenAI-compatible gateway (Morpheus network). Powers BOTH the UI
  // codegen model and the general-knowledge "brain".
  mordiem: {
    key: process.env.MORDIEM_API_KEY || process.env.MORPH_API_KEY || "",
    base: process.env.MORDIEM_URL || "https://api.mordiem.com/api/v1",
    genModel: process.env.MORDIEM_GEN_MODEL || "qwen3-coder-480b-a35b-instruct-turbo",
    brainModel: process.env.BRAIN_MODEL || "claude-sonnet-5-5",
  },
  web: {
    // Tavily search. Reads TAVILY_API_KEY (or legacy WEB_SEARCH_API_KEY).
    key: process.env.TAVILY_API_KEY || process.env.WEB_SEARCH_API_KEY || "",
  },
} as const;

/** Which services have real credentials. Everything else runs in mock mode. */
export const live = {
  voice: Boolean(config.fal.key),
  jev: Boolean(config.typesafe.key),
  brain: Boolean(config.mordiem.key),
  mordiem: Boolean(config.mordiem.key),
  web: Boolean(config.web.key),
};

export function serviceStatus() {
  const m = (b: boolean): "live" | "mock" => (b ? "live" : "mock");
  return {
    voice: m(live.voice),
    jev: m(live.jev),
    brain: m(live.brain),
    mordiem: m(live.mordiem),
    web: m(live.web),
  };
}
