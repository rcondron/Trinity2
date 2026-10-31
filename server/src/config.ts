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
/** Forged-but-unapproved skills live here; the loader does NOT scan this dir. */
export const PENDING_SKILLS_DIR = path.join(SKILLS_DIR, "pending");

/** Default Deepgram live-transcription socket (nova-3, 16-bit PCM @ 24 kHz). */
const DEEPGRAM_DEFAULT =
  "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=24000&channels=1" +
  "&interim_results=true&endpointing=300&utterance_end_ms=1000&smart_format=true";

/**
 * Static defaults, read once from the environment. These seed the runtime
 * endpoint settings (see settings.ts), which the Settings page can override
 * without editing .env.
 */
export const config = {
  port: Number(process.env.PORT) || 8799,

  fal: {
    key: process.env.FAL_KEY || "",
    // fal QUEUE base for PersonaPlex (legacy turn-based path). The streaming loop
    // uses the self-hosted patched server instead — see personaplex below.
    url: process.env.PERSONAPLEX_URL || "https://queue.fal.run/fal-ai/personaplex",
    defaultVoice: process.env.PERSONAPLEX_VOICE || "NATF2",
  },

  // Real-time voice: a self-hosted PATCHED PersonaPlex server (e.g. on Modal)
  // that speaks over a persistent WebSocket and accepts the 0x03/0x04 say/hold
  // protocol. Empty until you deploy one and set PERSONAPLEX_WS_URL.
  personaplex: {
    wsUrl: process.env.PERSONAPLEX_WS_URL || "",
    voice: process.env.PERSONAPLEX_VOICE || "NATF2",
  },

  // Deepgram — live transcription of the caller, running beside PersonaPlex.
  deepgram: {
    key: process.env.DEEPGRAM_API_KEY || "",
    url: process.env.DEEPGRAM_URL || DEEPGRAM_DEFAULT,
  },

  // Jev (TypeSafe AI) — a custom "System One" decision API, not OpenAI-compatible.
  typesafe: {
    key: process.env.TYPESAFE_API_KEY || "",
    base: process.env.TYPESAFE_URL || "https://api.typesafe.ai",
    model: process.env.JEV_MODEL || "jev-latest",
  },

  // Mordiem — OpenAI-compatible gateway (Morpheus network). Powers the UI codegen
  // model, the general-knowledge "brain", and the fast one-sentence reply writer.
  mordiem: {
    key: process.env.MORDIEM_API_KEY || process.env.MORPH_API_KEY || "",
    base: process.env.MORDIEM_URL || "https://api.mordiem.com/api/v1",
    genModel: process.env.MORDIEM_GEN_MODEL || "qwen3-coder-480b-a35b-instruct-turbo",
    brainModel: process.env.BRAIN_MODEL || "claude-sonnet-5-5",
    // Fast model that writes the one spoken sentence after a tool runs.
    replyModel: process.env.REPLY_MODEL || "nvidia-nemotron-3-nano-30b-a3b",
  },

  web: {
    // Tavily search. Reads TAVILY_API_KEY (or legacy WEB_SEARCH_API_KEY).
    key: process.env.TAVILY_API_KEY || process.env.WEB_SEARCH_API_KEY || "",
  },

  // Live-loop timing defaults (overridable in Settings).
  timing: {
    routeEveryMs: Number(process.env.ROUTE_EVERY_MS) || 400,
    minConfidence: Number(process.env.MIN_CONFIDENCE) || 0.7,
    fillerAfterMs: Number(process.env.FILLER_AFTER_MS) || 500,
  },
} as const;
