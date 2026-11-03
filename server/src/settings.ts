import fs from "node:fs";
import path from "node:path";
import { config, DATA_DIR } from "./config.js";
import { browserConnected } from "./services/browser-bridge.js";
import type { ServiceStatus } from "./types.js";

/**
 * Runtime-adjustable endpoints & models. Defaults come from .env (config.ts);
 * the Settings page writes overrides here, which take effect immediately without
 * a restart. Stored as JSON beside the SQLite DB so a redeploy of code keeps them.
 */
export interface Endpoints {
  // Real-time voice (patched, self-hosted PersonaPlex — e.g. on a Runpod pod).
  personaplexWsUrl: string;
  personaplexVoice: string;
  personaplexAdminToken: string;
  // Live transcription.
  deepgramUrl: string;
  deepgramKey: string;
  // Decision model (Jev / TypeSafe).
  typesafeUrl: string;
  typesafeKey: string;
  jevModel: string;
  // Text models (Mordiem gateway).
  mordiemUrl: string;
  mordiemKey: string;
  brainModel: string;
  /** Writes information cards (show_card): facts, layout, look and picture brief. Blank = brainModel. */
  cardModel: string;
  /** The coding skill's coders: a quick one (the default; the "glm" slot) and a strong one for big apps (the "kimi" slot). */
  glmModel: string;
  kimiModel: string;
  /** The problem solver behind figure_out (blank = brainModel). */
  plannerModel: string;
  coderDefault: "glm" | "kimi";
  replyModel: string;
  fastModel: string;
  imageModel: string;
  /** Stronger image model when the user asks for detail / photorealism (falls back to imageModel if blank). */
  imageProModel: string;
  /** Text-to-speech for audio clips the user asks for (make_audio), and the voice name that model takes. */
  ttsModel: string;
  /** Richer TTS when the user asks for natural / expressive audio (falls back to ttsModel if blank). */
  ttsProModel: string;
  ttsVoice: string;
  /** Default text-to-video model (make_video). */
  videoModel: string;
  /** Stronger video model for cinematic / high-quality asks (falls back to videoModel if blank). */
  videoProModel: string;
  // Other services.
  tavilyKey: string;
  /** SerpApi: live Google Shopping / Flights / Hotels results for the shopping and travel cards. */
  serpapiKey: string;
  falKey: string;
  // Behaviour.
  /** "auto": skills Trinity creates are sandbox-tested and usable at once; "manual": they wait for approval. */
  skillApproval: "auto" | "manual";
  // Live-loop timing.
  routeEveryMs: number;
  minConfidence: number;
  fillerAfterMs: number;
  /** What the workspace window draws over the board besides the cards (every open window follows at once). */
  workspaceOverlays: "all" | "alerts" | "none";
}

const STORE = path.join(DATA_DIR, "endpoints.json");
/** Keys are secret — never returned to the browser. */
const SECRET_KEYS: (keyof Endpoints)[] = ["deepgramKey", "typesafeKey", "mordiemKey", "personaplexAdminToken", "tavilyKey", "serpapiKey", "falKey"];

function envDefaults(): Endpoints {
  return {
    personaplexWsUrl: config.personaplex.wsUrl,
    personaplexVoice: config.personaplex.voice,
    personaplexAdminToken: config.personaplex.adminToken,
    deepgramUrl: config.deepgram.url,
    deepgramKey: config.deepgram.key,
    typesafeUrl: config.typesafe.base,
    typesafeKey: config.typesafe.key,
    jevModel: config.typesafe.model,
    mordiemUrl: config.mordiem.base,
    mordiemKey: config.mordiem.key,
    brainModel: config.mordiem.brainModel,
    cardModel: config.mordiem.cardModel,
    glmModel: config.mordiem.glmModel,
    kimiModel: config.mordiem.kimiModel,
    plannerModel: config.mordiem.plannerModel,
    coderDefault: config.mordiem.coderDefault,
    replyModel: config.mordiem.replyModel,
    fastModel: config.mordiem.fastModel,
    imageModel: config.mordiem.imageModel,
    imageProModel: config.mordiem.imageProModel,
    ttsModel: config.mordiem.ttsModel,
    ttsProModel: config.mordiem.ttsProModel,
    ttsVoice: config.mordiem.ttsVoice,
    videoModel: config.mordiem.videoModel,
    videoProModel: config.mordiem.videoProModel,
    tavilyKey: config.web.key,
    serpapiKey: config.web.serpapiKey,
    falKey: config.fal.key,
    skillApproval: config.skills.approval,
    routeEveryMs: config.timing.routeEveryMs,
    minConfidence: config.timing.minConfidence,
    fillerAfterMs: config.timing.fillerAfterMs,
    workspaceOverlays: config.workspace.overlays,
  };
}

function readStore(): Partial<Endpoints> {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as Partial<Endpoints>;
  } catch {
    return {};
  }
}

/** Env defaults with stored overrides applied (blank/undefined overrides ignored). */
export function getEndpoints(): Endpoints {
  const base = envDefaults();
  const stored = readStore();
  const merged = { ...base };
  for (const [k, v] of Object.entries(stored)) {
    if (v === undefined || v === null || v === "") continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/** Settings that only take one of a few values; anything else is ignored. */
const CHOICES: Partial<Record<keyof Endpoints, readonly string[]>> = {
  coderDefault: ["glm", "kimi"],
  skillApproval: ["auto", "manual"],
  workspaceOverlays: ["all", "alerts", "none"],
};

/** Apply a partial update. Blank string clears an override back to the env default. */
export function setEndpoints(patch: Partial<Endpoints>): Endpoints {
  const stored = readStore();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in envDefaults())) continue;
    const choices = CHOICES[k as keyof Endpoints];
    if (choices && v !== "" && v !== undefined && v !== null && !choices.includes(String(v))) continue;
    if (v === "" || v === undefined || v === null) delete (stored as Record<string, unknown>)[k];
    else (stored as Record<string, unknown>)[k] = v;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(stored, null, 2), "utf8");
  return getEndpoints();
}

/** The coding skill's model: the named coder ("glm" is the quick slot, "kimi" the strong one), else the configured default. */
export function coderModel(which?: "glm" | "kimi"): string {
  const e = getEndpoints();
  const pick = which ?? (e.coderDefault === "kimi" ? "kimi" : "glm");
  return pick === "kimi" ? e.kimiModel : e.glmModel;
}

const MODEL_NAMES: Record<string, string> = {
  "mercury-3": "Mercury 3",
  "mercury-2-5": "Mercury 2.5",
  "kimi-k3": "Kimi K3",
  "kimi-k3-fast-api": "Kimi K3 fast",
  "z-ai-glm-5-3-flash": "GLM 5.3 flash",
  "z-ai-glm-5-3": "GLM 5.3",
  "deepseek-v4-flash-0731-fast": "DeepSeek V4 flash",
  "qwen3-coder-480b-a35b-instruct-turbo": "Qwen3 Coder",
  "openai-gpt-54-mini": "GPT-5.4 mini",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
};

/** A model id as a name to say and show: "mercury-3" → "Mercury 3", "some-vendor-model-2-1-turbo" → "Model 2.1 turbo". */
export function modelName(id: string): string {
  const known = MODEL_NAMES[id];
  if (known) return known;
  const words = id.replace(/^(?:z-ai|zai-org|openai|nvidia|e2ee|google|xiaomi)-/, "").split("-");
  const out: string[] = [];
  for (const w of words) {
    if (/^\d+$/.test(w) && /^\d+$/.test(out[out.length - 1] ?? "")) out[out.length - 1] += `.${w}`;
    else out.push(/^[a-z]/.test(w) && w.length <= 3 && !/^(v\d|pro|max)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
  }
  return out.join(" ");
}

/** The coder's name, for what the workspace shows ("Mercury 3 is building…") and Jev's choice labels. */
export function coderName(which: "glm" | "kimi"): string {
  return modelName(coderModel(which));
}

/** Safe-to-send view: secret keys become booleans (`*Set`), values withheld. */
export function publicEndpoints(): Record<string, unknown> {
  const e = getEndpoints();
  const out: Record<string, unknown> = { ...e };
  for (const k of SECRET_KEYS) {
    out[`${k}Set`] = Boolean(e[k]);
    delete out[k];
  }
  return out;
}

// ─── Liveness (dynamic: reflects both .env and Settings overrides) ────────────

export const live = {
  get voice(): boolean {
    return Boolean(getEndpoints().falKey); // legacy turn-based voice (fal)
  },
  get stream(): boolean {
    const e = getEndpoints();
    return Boolean(e.personaplexWsUrl && e.deepgramKey && e.typesafeKey);
  },
  get jev(): boolean {
    return Boolean(getEndpoints().typesafeKey);
  },
  get brain(): boolean {
    return Boolean(getEndpoints().mordiemKey);
  },
  get mordiem(): boolean {
    return Boolean(getEndpoints().mordiemKey);
  },
  get web(): boolean {
    return true; // keyless DuckDuckGo baseline; Tavily is used when its key is set
  },
  /** Live shopping, flight and hotel results (SerpApi). Without it those cards fall back to web search. */
  get travel(): boolean {
    return Boolean(getEndpoints().serpapiKey);
  },
  /** The Chrome extension is connected: Trinity can drive the user's browser. */
  get browser(): boolean {
    return browserConnected();
  },
};

export function serviceStatus(): ServiceStatus {
  const m = (b: boolean): "live" | "mock" => (b ? "live" : "mock");
  return {
    voice: m(live.voice),
    stream: m(live.stream),
    jev: m(live.jev),
    brain: m(live.brain),
    mordiem: m(live.mordiem),
    web: m(live.web),
    travel: m(live.travel),
    browser: m(live.browser),
  };
}
