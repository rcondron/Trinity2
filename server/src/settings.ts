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
  /** Writes what Trinity says when no tool is needed (the talking brain). Blank = brainModel. */
  chatModel: string;
  /** Takes the turn when the chat model is slow to start or fails. Blank = none. */
  chatBackupModel: string;
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
  /** The user's webmail and web calendar (opened in their own signed-in browser through the extension). */
  mailUrl: string;
  calendarUrl: string;
  // Behaviour.
  /** "auto": skills Trinity creates are sandbox-tested and usable at once; "manual": they wait for approval. */
  skillApproval: "auto" | "manual";
  // Live-loop timing.
  routeEveryMs: number;
  minConfidence: number;
  fillerAfterMs: number;
  /** What the workspace window draws over the board besides the cards (every open window follows at once). */
  workspaceOverlays: "all" | "alerts" | "none";
  /** "polished": the live voice only speaks words it is given (tool replies, the talking brain). "free": it improvises small talk. */
  talkStyle: "polished" | "free";
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
    chatModel: config.mordiem.chatModel,
    chatBackupModel: config.mordiem.chatBackupModel,
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
    mailUrl: config.assistant.mailUrl,
    calendarUrl: config.assistant.calendarUrl,
    skillApproval: config.skills.approval,
    routeEveryMs: config.timing.routeEveryMs,
    minConfidence: config.timing.minConfidence,
    fillerAfterMs: config.timing.fillerAfterMs,
    workspaceOverlays: config.workspace.overlays,
    talkStyle: config.voice.talkStyle,
  };
}

/** What Settings has saved: overrides, and for each saved key the address it was entered for. */
type Stored = Partial<Endpoints> & { keyFor?: Partial<Record<keyof Endpoints, string>> };

function readStore(): Stored {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as Stored;
  } catch {
    return {};
  }
}

/** Each service's address and the key that is sent to it. */
const KEY_FOR_URL: [url: keyof Endpoints, key: keyof Endpoints][] = [
  ["mordiemUrl", "mordiemKey"],
  ["typesafeUrl", "typesafeKey"],
  ["deepgramUrl", "deepgramKey"],
  ["personaplexWsUrl", "personaplexAdminToken"],
];

/**
 * Env defaults with stored overrides applied (blank/undefined overrides ignored): what the user configured.
 *
 * A key belongs to the address it was entered for. One saved in Settings is remembered with that address (`keyFor`);
 * one from .env is for the .env address. When the address in effect is a different one, the key is withheld (the
 * service shows as missing its key until the key for the new address is entered) — otherwise repointing an address
 * would hand the old key to whoever answers at the new one.
 */
export function rawEndpoints(): Endpoints {
  const base = envDefaults();
  const stored = readStore();
  const merged = { ...base };
  for (const [k, v] of Object.entries(stored)) {
    if (k === "keyFor" || v === undefined || v === null || v === "") continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  const out = merged as Record<string, unknown>;
  for (const [urlKey, keyName] of KEY_FOR_URL) {
    if (!out[keyName]) continue;
    const savedFor = (stored as Record<string, unknown>)[keyName] ? stored.keyFor?.[keyName] : base[urlKey];
    // (A key saved before addresses were remembered has none recorded: it stays with the address in effect.)
    if (savedFor !== undefined && savedFor !== out[urlKey]) out[keyName] = "";
  }
  return merged;
}

/** A configured model the gateway no longer serves, and the one used in its place ("" = none could be found). */
export interface ModelStandIn {
  key: keyof Endpoints;
  configured: string;
  using: string;
}
let standIns: ModelStandIn[] = [];

/** Set by services/model-health.ts after it has checked the catalog. Returns the previous list. */
export function setModelStandIns(next: ModelStandIn[]): ModelStandIn[] {
  const before = standIns;
  standIns = next;
  return before;
}
export function modelStandIns(): ModelStandIn[] {
  return standIns;
}

/**
 * The settings every caller uses: what the user configured, with a model the gateway no longer serves replaced by its
 * stand-in (only while the setting still names the missing model).
 */
export function getEndpoints(): Endpoints {
  const merged = rawEndpoints();
  const fields = merged as unknown as Record<string, unknown>;
  for (const s of standIns) if (s.using && fields[s.key] === s.configured) fields[s.key] = s.using;
  return merged;
}

/** Settings that only take one of a few values; anything else is ignored. */
const CHOICES: Partial<Record<keyof Endpoints, readonly string[]>> = {
  coderDefault: ["glm", "kimi"],
  skillApproval: ["auto", "manual"],
  workspaceOverlays: ["all", "alerts", "none"],
  talkStyle: ["polished", "free"],
};

/** Numeric settings and the range each must stay in. */
const NUMBERS: Partial<Record<keyof Endpoints, [min: number, max: number]>> = {
  routeEveryMs: [100, 5000],
  minConfidence: [0.3, 0.99],
  fillerAfterMs: [200, 10_000],
};

/**
 * A service address: https or wss anywhere, plain http or ws on this machine — and for the voice pod, which is sent no
 * key on its socket, plain ws too (a pod behind a bare address). Never with a user name or password in it.
 */
function addressOk(key: keyof Endpoints, value: string): boolean {
  try {
    const u = new URL(value);
    if (u.username || u.password) return false;
    if (u.protocol === "https:" || u.protocol === "wss:") return true;
    if (u.protocol !== "http:" && u.protocol !== "ws:") return false;
    return key === "personaplexWsUrl" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** A page to open in the user's browser (webmail, calendar): https only (plain http on this machine, for tests). */
function pageOk(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Apply a partial update. Blank string clears an override back to the env default. Every value is checked for its
 * kind: an unknown key, a wrong type, a number out of range or a bad address is ignored. A key saved here is
 * remembered with the address it is for (see rawEndpoints), and a stored key is dropped when its address changes
 * without a new key in the same update.
 */
export function setEndpoints(patch: Partial<Endpoints>): Endpoints {
  const stored = readStore();
  const defaults = envDefaults();
  const before = rawEndpoints();
  const isAddress = (key: keyof Endpoints) => KEY_FOR_URL.some(([urlKey]) => urlKey === key);
  /** What this update really stored (a value that fails a check is skipped, and must not count as a new key). */
  const accepted = new Set<string>();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in defaults)) continue;
    const key = k as keyof Endpoints;
    const clear = v === "" || v === undefined || v === null;
    if (!clear) {
      const choices = CHOICES[key];
      if (choices && !choices.includes(String(v))) continue;
      const range = NUMBERS[key];
      if (range) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) continue;
      } else if (typeof v !== "string" || v.length > 2000) continue;
      if (isAddress(key) && !addressOk(key, String(v))) continue;
      if ((key === "mailUrl" || key === "calendarUrl") && !pageOk(String(v))) continue;
    }
    if (clear) delete (stored as Record<string, unknown>)[k];
    else {
      (stored as Record<string, unknown>)[k] = v;
      accepted.add(k);
    }
  }
  // Keys and their addresses, once the whole update is in.
  const out = stored as Record<string, unknown>;
  const keyFor: Partial<Record<keyof Endpoints, string>> = { ...(stored.keyFor ?? {}) };
  for (const [urlKey, keyName] of KEY_FOR_URL) {
    const address = String(out[urlKey] ?? defaults[urlKey] ?? "");
    const newKey = accepted.has(keyName);
    if (newKey) keyFor[keyName] = address;
    else if (out[keyName] && address !== before[urlKey]) {
      delete out[keyName]; // entered for the old address
      delete keyFor[keyName];
    }
    if (!out[keyName]) delete keyFor[keyName];
  }
  if (Object.keys(keyFor).length) stored.keyFor = keyFor;
  else delete stored.keyFor;
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
  "deepseek-v4-1-flash-1017-ultrafast": "DeepSeek flash",
  "deepseek-v4-1-flash": "DeepSeek V4.1 flash",
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
  // What the user configured (not the stand-ins): the page edits settings, and lists the swaps beside them.
  const e = rawEndpoints();
  const out: Record<string, unknown> = { ...e };
  for (const k of SECRET_KEYS) {
    out[`${k}Set`] = Boolean(e[k]);
    delete out[k];
  }
  out.modelIssues = standIns;
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
