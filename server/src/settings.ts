import fs from "node:fs";
import path from "node:path";
import { config, DATA_DIR } from "./config.js";
import type { ServiceStatus } from "./types.js";

/**
 * Runtime-adjustable endpoints & models. Defaults come from .env (config.ts);
 * the Settings page writes overrides here, which take effect immediately without
 * a restart. Stored as JSON beside the SQLite DB so a redeploy of code keeps them.
 */
export interface Endpoints {
  // Real-time voice (patched, self-hosted PersonaPlex — e.g. on Modal).
  personaplexWsUrl: string;
  personaplexVoice: string;
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
  genModel: string;
  replyModel: string;
  // Live-loop timing.
  routeEveryMs: number;
  minConfidence: number;
  fillerAfterMs: number;
}

const STORE = path.join(DATA_DIR, "endpoints.json");
/** Keys are secret — never returned to the browser. */
const SECRET_KEYS: (keyof Endpoints)[] = ["deepgramKey", "typesafeKey", "mordiemKey"];

function envDefaults(): Endpoints {
  return {
    personaplexWsUrl: config.personaplex.wsUrl,
    personaplexVoice: config.personaplex.voice,
    deepgramUrl: config.deepgram.url,
    deepgramKey: config.deepgram.key,
    typesafeUrl: config.typesafe.base,
    typesafeKey: config.typesafe.key,
    jevModel: config.typesafe.model,
    mordiemUrl: config.mordiem.base,
    mordiemKey: config.mordiem.key,
    brainModel: config.mordiem.brainModel,
    genModel: config.mordiem.genModel,
    replyModel: config.mordiem.replyModel,
    routeEveryMs: config.timing.routeEveryMs,
    minConfidence: config.timing.minConfidence,
    fillerAfterMs: config.timing.fillerAfterMs,
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

/** Apply a partial update. Blank string clears an override back to the env default. */
export function setEndpoints(patch: Partial<Endpoints>): Endpoints {
  const stored = readStore();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in envDefaults())) continue;
    if (v === "" || v === undefined || v === null) delete (stored as Record<string, unknown>)[k];
    else (stored as Record<string, unknown>)[k] = v;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(stored, null, 2), "utf8");
  return getEndpoints();
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
    return Boolean(config.fal.key); // legacy turn-based (fal); not runtime-settable
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
    return Boolean(config.web.key);
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
  };
}
