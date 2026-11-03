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
/** Hand-written, trusted skills (source-controlled; run in-process). */
export const SKILLS_DIR = path.join(ROOT, "server", "skills");
/** Skills Trinity creates on the fly (runtime data; each runs in a sandboxed child process). */
export const FORGED_SKILLS_DIR = path.join(DATA_DIR, "skills");
/** Forged skills waiting for approval (only when skill approval is set to "manual"). */
export const PENDING_SKILLS_DIR = path.join(FORGED_SKILLS_DIR, "pending");

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
    // Shared secret for the pod's voice-upload route (PP_ADMIN_TOKEN on the pod).
    adminToken: process.env.PERSONAPLEX_ADMIN_TOKEN || "",
  },

  // Deepgram — live transcription of the user, running beside PersonaPlex.
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

  // Mordiem — OpenAI-compatible gateway (Morpheus network). Powers the coding skill,
  // the general-knowledge "brain", and the fast one-sentence reply writer.
  mordiem: {
    key: process.env.MORDIEM_API_KEY || process.env.MORPH_API_KEY || "",
    base: process.env.MORDIEM_URL || "https://api.mordiem.com/api/v1",
    // The coding skill's two coders (UI builds, forged skills, custom screens): a quick one for most
    // pages and a strong one for big apps. (The keys keep their first names, "glm" and "kimi", so
    // saved settings and Jev's option ids stay valid.) Measured on the engine's own build prompt, a
    // timer and a chart: mercury-3 first code ~1.1 s, done ~3 s; deepseek-v4-flash-0731-fast ~1 s /
    // ~11 s; kimi-k3 ~1 s / ~20–30 s with the most polished result; z-ai-glm-5-3-flash ~31 s (full
    // z-ai-glm-5-3 is thinking-only on Mordiem: ~16 s of reasoning before any code).
    glmModel: process.env.QUICK_CODER || process.env.MORDIEM_GLM_MODEL || "mercury-3",
    kimiModel: process.env.STRONG_CODER || process.env.MORDIEM_KIMI_MODEL || "kimi-k3",
    // The problem solver (figure_out): plans, runs tools in turn, retries, forges a skill when none fits.
    plannerModel: process.env.PLANNER_MODEL || "kimi-k3",
    coderDefault: (process.env.CODER_DEFAULT === "kimi" || process.env.CODER_DEFAULT === "strong" ? "kimi" : "glm") as "glm" | "kimi",
    brainModel: process.env.BRAIN_MODEL || "claude-sonnet-5-5",
    // The card designer: writes information cards (show_card) — the facts, layout, look and picture
    // brief of a recipe / news / profile card. Measured on the real prompt (recipe / profile / explainer):
    // mercury-3 ~1.8 s a card, nemotron-nano ~4.5–5 s (thin), deepseek-v4-flash ~6 s, kimi-k3 6–20 s,
    // claude-sonnet-5-5 ~8.5–9 s (the most careful). The quality tier always uses the brain. Blank = the brain.
    cardModel: process.env.CARD_MODEL || "mercury-3",
    // Fast model that writes the one spoken sentence after a tool runs.
    replyModel: process.env.REPLY_MODEL || "nvidia-nemotron-3-nano-30b-a3b",
    // Fast JSON model for argument extraction and game content (~2s measured).
    fastModel: process.env.FAST_MODEL || "nvidia-nemotron-3-nano-30b-a3b",
    // Image models for game art and pictures the user asks for. Jev / the router pick turbo vs pro.
    imageModel: process.env.IMAGE_MODEL || "krea-2-turbo",
    imageProModel: process.env.IMAGE_PRO_MODEL || "flux-2-pro",
    // Text-to-speech for audio clips the user asks for (tts-kokoro ~1s measured), and its voice.
    ttsModel: process.env.TTS_MODEL || "tts-kokoro",
    ttsProModel: process.env.TTS_PRO_MODEL || "elevenlabs-tts-v4",
    ttsVoice: process.env.TTS_VOICE || "af_heart",
    // Text-to-video via Mordiem/Venice (POST /video/queue → /video/retrieve). Fast vs cinematic slots.
    videoModel: process.env.VIDEO_MODEL || "veo3.1-fast-text-to-video",
    videoProModel: process.env.VIDEO_PRO_MODEL || "wan-3-0-text-to-video",
  },

  web: {
    // Tavily search. Reads TAVILY_API_KEY (or legacy WEB_SEARCH_API_KEY).
    key: process.env.TAVILY_API_KEY || process.env.WEB_SEARCH_API_KEY || "",
    // SerpApi: live Google Shopping / Flights / Hotels results for the shopping and travel cards
    // (free tier 250 searches a month). Without it those cards fall back to web search and say so.
    serpapiKey: process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || "",
  },

  skills: {
    // "auto": a skill Trinity creates is tested in its sandbox and usable at once.
    // "manual": it waits in Settings → Skills for approval.
    approval: (process.env.SKILL_APPROVAL === "manual" ? "manual" : "auto") as "auto" | "manual",
  },

  // Live-loop timing defaults (overridable in Settings).
  timing: {
    routeEveryMs: Number(process.env.ROUTE_EVERY_MS) || 400,
    minConfidence: Number(process.env.MIN_CONFIDENCE) || 0.7,
    // Say "one moment" only if no reply word is ready by then (reply TTFT measured ~0.8s).
    fillerAfterMs: Number(process.env.FILLER_AFTER_MS) || 900,
  },
} as const;
