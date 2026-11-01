// Typed client for the Trinity engine's HTTP API (everything under /api).
//
// Every helper throws an ApiError on failure and, unless told to stay quiet,
// surfaces it as a toast. Routes that this engine build doesn't mount yet
// (Express answers those with an HTML "Cannot GET" 404) are flagged
// `notAvailable`, so sections can show a friendly "not available yet" state.

import type { HeartbeatTask as WireHeartbeatTask, Persona } from "../protocol.js";
import type { GameView } from "../../../server/src/game/types.js";
import { toast } from "./ui.js";

export type { GameView, Persona };

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceState = "live" | "mock";
export type Services = Record<string, ServiceState>;

export interface StatusResponse {
  services: Services;
  persona: Persona;
}

/** The editable part of a persona. */
export interface PersonaFields {
  name: string;
  description: string;
  voicePrompt: string;
  voice: string;
  toolsets: string[];
  traits: Record<string, string>;
}

/**
 * GET /settings/endpoints — secrets are withheld and reported as `<key>Set` booleans.
 * Optional fields are missing on engines that predate them (the page shows those as
 * "needs an engine update").
 */
export interface PublicEndpoints {
  personaplexWsUrl: string;
  personaplexVoice: string;
  deepgramUrl: string;
  typesafeUrl: string;
  jevModel: string;
  mordiemUrl: string;
  brainModel: string;
  /** The coding skill's coders: GLM (fast) and Kimi (stronger), and which one is the default. */
  glmModel?: string;
  kimiModel?: string;
  coderDefault?: "glm" | "kimi";
  replyModel: string;
  fastModel: string;
  imageModel: string;
  /** "auto": skills Trinity creates are usable at once; "manual": they wait for approval. */
  skillApproval?: "auto" | "manual";
  routeEveryMs: number;
  minConfidence: number;
  fillerAfterMs: number;
  deepgramKeySet: boolean;
  typesafeKeySet: boolean;
  mordiemKeySet: boolean;
  personaplexAdminTokenSet: boolean;
  tavilyKeySet?: boolean;
  falKeySet?: boolean;
  [key: string]: unknown;
}

/** Model ids for the Models card's suggestions (GET /settings/models, when the engine has it). */
export interface ModelCatalog {
  text: string[];
  image: string[];
}

/** PUT /settings/endpoints body: partial; "" resets a field to its .env default. */
export type EndpointsPatch = Record<string, string | number>;

export interface BuiltinVoice {
  id: string;
  label: string;
}

export interface CustomVoice {
  /** "custom:<slug>" — the value a persona stores in `voice`. */
  id: string;
  slug: string;
  name: string;
  durationSec: number;
  createdAt: number;
  /** true = on the GPU pod, false = sync failed, null = unknown. */
  synced: boolean | null;
}

export interface PodStatus {
  configured: boolean;
  reachable: boolean | null;
  uploads: boolean | null;
}

/** Normalized voice library. `customAvailable` is false on engines without the voice library. */
export interface VoiceLibrary {
  builtin: BuiltinVoice[];
  custom: CustomVoice[];
  pod: PodStatus | null;
  customAvailable: boolean;
}

export interface CreateVoiceResult {
  voice: CustomVoice;
  synced: boolean;
  syncError?: string;
}

export interface SyncResult {
  synced: boolean;
  error?: string;
}

export interface GameSummary {
  id: string;
  title: string;
  genre: string;
  phase: string;
  /** Number of players. */
  players: number;
  /** Player names when the server lists them. */
  playerNames: string[];
  personaId: string;
  updatedAt: number;
  active: boolean;
}

export interface GameList {
  /** False when this engine has no games API yet. */
  available: boolean;
  games: GameSummary[];
}

export interface Toolset {
  id: string;
  label: string;
  description: string;
}

/** One argument of a tool, as the engine describes it (server ToolArgSpec). */
export interface ToolArgSpec {
  type: string;
  description: string;
  required?: boolean;
  /** value → label: the argument takes one of these. */
  options?: Record<string, string>;
}

export interface Skill {
  name: string;
  description: string;
  /** "builtin" (ships with the engine), "skill" (hand-written, server/skills), "forged" (Trinity created it). */
  source: string;
  /** Toolset the tool belongs to (e.g. "game"), when the engine reports it. */
  toolset?: string;
  /** Jev can pick it. Engines without the switch report every tool as enabled. */
  enabled: boolean;
  createdAt?: number;
  /** For forged skills: what it was made for, in the caller's words. */
  need?: string;
  /** For forged skills: the coder that wrote it. */
  model?: string;
  /** Arguments, when the engine reports them (builds the test form). */
  input?: Record<string, ToolArgSpec>;
  /** Sample arguments the skill was self-tested with, when reported. */
  examples?: Record<string, unknown>[];
  /** Why a skill Trinity created can't be used right now (e.g. its module no longer loads). */
  problem?: string;
}

/** A skill Trinity created that waits for approval (skillApproval "manual"). */
export interface PendingSkill {
  name: string;
  description: string;
  /** The module's source code, when the engine sends it. */
  code: string;
  createdAt?: number;
  need?: string;
  model?: string;
}

/** What a skill's run() returned (server ToolResult). */
export interface SkillRunResult {
  ok: boolean;
  say?: string;
  render?: string;
  data?: unknown;
  error?: string;
}

export interface SkillTestResult {
  ok: boolean;
  result: SkillRunResult | null;
  /** Wall time of the sandboxed run. */
  ms: number | null;
  error?: string;
}

export type ForgeResult = { ok: true; skill: Skill } | { ok: false; reason: string };

/** A heartbeat task. `once` marks a one-time reminder: it runs once, then stays as a finished item (enabled = false). */
export interface HeartbeatTask extends WireHeartbeatTask {
  once: boolean;
}

/** POST /heartbeat: a recurring task (intervalSec) or a one-time reminder (once + runAt). `runAt` is the first run (epoch ms). */
export interface HeartbeatInput {
  title: string;
  instruction: string;
  intervalSec?: number;
  once?: boolean;
  runAt?: number;
  enabled?: boolean;
}
/** PUT /heartbeat/:id merges any of these; runAt / nextRunAt reschedule the task. */
export type HeartbeatPatch = Partial<HeartbeatInput & { nextRunAt: number }>;

export type MemoryType = "fact" | "preference" | "event" | "note" | "summary";

/** One thing Trinity remembers (server MemoryDoc). */
export interface Memory {
  id: string;
  type: string;
  text: string;
  tags: string[];
  /** 0..1 — how important it is; ranks recall. */
  salience: number;
  ts: number;
}

export interface MemoryInput {
  text: string;
  type?: string;
  tags?: string[];
  salience?: number;
}

export interface MemoryQuery {
  /** Search text; without it the engine lists the most recent memories. */
  q?: string;
  limit?: number;
  type?: string;
}

/** What Trinity knows about the caller directly. `available` is false on engines without /profile. */
export interface Profile {
  name: string;
  available: boolean;
}

/** A saved name, and what the engine did to the memory that holds it (older engines say neither). */
export interface ProfileSaved extends Profile {
  /** That memory, rewritten for the new name. */
  memory?: Memory;
  /** Its id, when clearing the name removed it. */
  removed?: string;
}

// ─── Request core ────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the engine couldn't be reached or timed out. */
    readonly status: number,
    /** The route isn't mounted on this engine build (HTML 404). */
    readonly notAvailable: boolean,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  /** Don't toast on failure (true), or decide per error. */
  quiet?: boolean | ((err: ApiError) => boolean);
  /** What we were doing, for the toast: "save the persona" → "Couldn't save the persona: …". */
  action?: string;
  timeoutMs?: number;
}

function errorMessage(data: unknown, text: string): string | null {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.error === "string" && d.error) return d.error;
    if (typeof d.message === "string" && d.message) return d.message;
  }
  const t = text.trim();
  if (t && t.length < 200 && !t.startsWith("<")) return t;
  return null;
}

function isQuiet(err: ApiError, opts: RequestOptions): boolean {
  return typeof opts.quiet === "function" ? opts.quiet(err) : Boolean(opts.quiet);
}

/** Combine a caller's quiet option with an extra "stay quiet for these errors" rule. */
function quietAlso(opts: RequestOptions, rule: (err: ApiError) => boolean): (err: ApiError) => boolean {
  return (err) => rule(err) || isQuiet(err, opts);
}

const UNREACHABLE = "Can't reach the Trinity engine — is it running?";

function report(err: ApiError, opts: RequestOptions): void {
  if (isQuiet(err, opts)) return;
  // One identical toast for every request that fails because the engine is down.
  if (err.message === UNREACHABLE) {
    toast(UNREACHABLE, "error");
    return;
  }
  const msg = err.message.replace(/\.$/, "");
  toast(opts.action ? `Couldn't ${opts.action}: ${msg}` : msg, "error");
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (cause) {
    window.clearTimeout(timer);
    const timedOut = ctrl.signal.aborted;
    const err = new ApiError(timedOut ? "The engine took too long to answer" : UNREACHABLE, 0, false, path);
    err.cause = cause;
    report(err, opts);
    throw err;
  }

  let text = "";
  let data: unknown = null;
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  try {
    text = await res.text();
    if (isJson && text) data = JSON.parse(text);
  } catch {
    data = null;
  } finally {
    window.clearTimeout(timer);
  }

  if (!res.ok) {
    const notAvailable = res.status === 404 && !isJson;
    let message: string;
    if (notAvailable) message = "This feature isn't available on this engine yet";
    else if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status === 500 && !text.trim()))
      message = UNREACHABLE;
    else message = errorMessage(data, text) ?? `The engine answered ${res.status}`;
    const err = new ApiError(message, res.status, notAvailable, path);
    report(err, opts);
    throw err;
  }
  if (!isJson) {
    const err = new ApiError("The engine sent an unexpected response", res.status, false, path);
    report(err, opts);
    throw err;
  }
  return data as T;
}

const enc = encodeURIComponent;

// ─── Normalizers (wire data is untrusted: coerce shapes defensively) ─────────

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v == null ? fallback : String(v));
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || fallback);

export const BUILTIN_VOICE_IDS = [
  "NATF0", "NATF1", "NATF2", "NATF3", "NATM0", "NATM1", "NATM2", "NATM3",
  "VARF0", "VARF1", "VARF2", "VARF3", "VARF4", "VARM0", "VARM1", "VARM2", "VARM3", "VARM4",
];

/** "NATF2" → "Natural Female 2", "VARM0" → "Varied Male 0". */
export function builtinVoiceLabel(id: string): string {
  const m = /^(NAT|VAR)([FM])(\d+)$/i.exec(id);
  if (!m) return id;
  const kind = m[1]!.toUpperCase() === "NAT" ? "Natural" : "Varied";
  const sex = m[2]!.toUpperCase() === "F" ? "Female" : "Male";
  return `${kind} ${sex} ${m[3]}`;
}

function normalizeVoices(raw: unknown): VoiceLibrary {
  // Older engines: a bare list of built-in preset ids.
  if (Array.isArray(raw)) {
    const ids = raw.map((v) => str(v)).filter(Boolean);
    return {
      builtin: (ids.length ? ids : BUILTIN_VOICE_IDS).map((id) => ({ id, label: builtinVoiceLabel(id) })),
      custom: [],
      pod: null,
      customAvailable: false,
    };
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const builtinRaw = Array.isArray(o.builtin) ? o.builtin : BUILTIN_VOICE_IDS;
  const builtin = builtinRaw
    .map((b): BuiltinVoice => {
      if (typeof b === "string") return { id: b, label: builtinVoiceLabel(b) };
      const r = (b ?? {}) as Record<string, unknown>;
      const id = str(r.id);
      return { id, label: str(r.label) || builtinVoiceLabel(id) };
    })
    .filter((b) => b.id);
  const custom = (Array.isArray(o.custom) ? o.custom : [])
    .map((c): CustomVoice => {
      const r = (c ?? {}) as Record<string, unknown>;
      const slug = str(r.slug) || str(r.id).replace(/^custom:/, "");
      return {
        id: str(r.id) || `custom:${slug}`,
        slug,
        name: str(r.name) || slug,
        durationSec: num(r.durationSec),
        createdAt: num(r.createdAt),
        synced: typeof r.synced === "boolean" ? r.synced : null,
      };
    })
    .filter((c) => c.slug);
  const p = o.pod && typeof o.pod === "object" ? (o.pod as Record<string, unknown>) : null;
  const tri = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    builtin,
    custom,
    pod: p ? { configured: Boolean(p.configured), reachable: tri(p.reachable), uploads: tri(p.uploads) } : null,
    customAvailable: true,
  };
}

function fallbackVoices(): VoiceLibrary {
  return {
    builtin: BUILTIN_VOICE_IDS.map((id) => ({ id, label: builtinVoiceLabel(id) })),
    custom: [],
    pod: null,
    customAvailable: false,
  };
}

function normalizeCustomVoice(raw: unknown): CustomVoice {
  const lib = normalizeVoices({ builtin: [], custom: [raw] });
  return (
    lib.custom[0] ?? { id: "custom:unknown", slug: "unknown", name: "Custom voice", durationSec: 0, createdAt: Date.now(), synced: null }
  );
}

function normalizeGame(raw: unknown): GameSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const playersRaw = r.players;
  const playerNames = Array.isArray(playersRaw)
    ? playersRaw
        .map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? str((p as Record<string, unknown>).name) : ""))
        .filter(Boolean)
    : [];
  return {
    id: str(r.id),
    title: str(r.title) || "Untitled adventure",
    genre: str(r.genre),
    phase: str(r.phase) || "setup",
    players: Array.isArray(playersRaw) ? playersRaw.length : num(playersRaw),
    playerNames,
    personaId: str(r.personaId),
    updatedAt: num(r.updatedAt),
    active: Boolean(r.active),
  };
}

export const FALLBACK_TOOLSETS: Toolset[] = [
  {
    id: "game",
    label: "Game Master tools",
    description: "Run a tabletop game by voice: set up the party, roll dice, set scenes, hand out loot, and drive a live game screen in the workspace.",
  },
];

function normalizeToolsets(raw: unknown): Toolset[] {
  if (!Array.isArray(raw)) return FALLBACK_TOOLSETS;
  const list = raw
    .map((t): Toolset => {
      const r = (t ?? {}) as Record<string, unknown>;
      const id = str(r.id);
      return { id, label: str(r.label) || id, description: str(r.description) };
    })
    .filter((t) => t.id);
  return list.length ? list : FALLBACK_TOOLSETS;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const FORGED_SOURCE = "forged";
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A list from a bare array or a wrapper object ({ data: [...] }, { memories: [...] }, …). */
function listOf(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const o = obj(raw);
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

function normalizeArgSpecs(raw: unknown): Record<string, ToolArgSpec> | undefined {
  const o = obj(raw);
  const out: Record<string, ToolArgSpec> = {};
  for (const [name, spec] of Object.entries(o)) {
    const s = obj(spec);
    const arg: ToolArgSpec = { type: str(s.type) || "string", description: str(s.description) };
    if (s.required === true) arg.required = true;
    const opts = obj(s.options);
    if (Object.keys(opts).length) arg.options = Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, str(v) || k]));
    out[name] = arg;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeExamples(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
  return list.length ? list : undefined;
}

function normalizeSkill(raw: unknown): Skill {
  const r = obj(raw);
  const skill: Skill = {
    name: str(r.name),
    description: str(r.description),
    source: str(r.source) || "builtin",
    // Engines without the enable switch don't send it: every tool they list is live.
    enabled: r.enabled !== false,
  };
  if (typeof r.toolset === "string" && r.toolset) skill.toolset = r.toolset;
  const createdAt = optNum(r.createdAt);
  if (createdAt) skill.createdAt = createdAt;
  const need = optStr(r.need);
  if (need) skill.need = need;
  const model = optStr(r.model);
  if (model) skill.model = model;
  const input = normalizeArgSpecs(r.input);
  if (input) skill.input = input;
  const examples = normalizeExamples(r.examples);
  if (examples) skill.examples = examples;
  const problem = optStr(r.problem);
  if (problem) {
    skill.problem = problem;
    skill.enabled = false; // it can't run, whatever its switch said
  }
  return skill;
}

function normalizeSkills(raw: unknown): Skill[] {
  return listOf(raw, "skills", "tools").map(normalizeSkill).filter((s) => s.name);
}

/** Pending skills carry their module code — as `code`, or (older engines) in `source`. */
function normalizePending(raw: unknown): PendingSkill[] {
  return listOf(raw, "skills", "pending")
    .map((s): PendingSkill => {
      const r = obj(s);
      const source = str(r.source);
      const code = str(r.code) || (/[\n;{]/.test(source) ? source : "");
      const p: PendingSkill = { name: str(r.name), description: str(r.description), code };
      const createdAt = optNum(r.createdAt);
      if (createdAt) p.createdAt = createdAt;
      const need = optStr(r.need);
      if (need) p.need = need;
      const model = optStr(r.model);
      if (model) p.model = model;
      return p;
    })
    .filter((s) => s.name);
}

function normalizeRunResult(raw: unknown): SkillRunResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = obj(raw);
  const out: SkillRunResult = { ok: r.ok !== false && !optStr(r.error) };
  const say = optStr(r.say);
  if (say) out.say = say;
  const render = optStr(r.render);
  if (render) out.render = render;
  if (r.data !== undefined && r.data !== null) out.data = r.data;
  const error = optStr(r.error);
  if (error) out.error = error;
  return out;
}

function normalizeTask(raw: unknown): HeartbeatTask {
  const r = obj(raw);
  const lastRunAt = optNum(r.lastRunAt);
  return {
    id: str(r.id),
    title: str(r.title),
    instruction: str(r.instruction),
    intervalSec: num(r.intervalSec),
    nextRunAt: num(r.nextRunAt),
    lastRunAt: lastRunAt ?? null,
    enabled: Boolean(r.enabled),
    once: r.once === true || r.once === 1,
  };
}

function normalizeMemory(raw: unknown): Memory {
  const r = obj(raw);
  return {
    id: str(r._id) || str(r.id),
    type: str(r.type) || "note",
    text: str(r.text),
    tags: Array.isArray(r.tags) ? r.tags.map((t) => str(t).trim()).filter(Boolean) : [],
    salience: Math.max(0, Math.min(1, num(r.salience, 0.5))),
    ts: num(r.ts),
  };
}

/** Engines may answer a write with the document or { ok, doc | memory }. */
function memoryFrom(raw: unknown): Memory | null {
  const r = obj(raw);
  const doc = r._id || r.id ? r : obj(r.doc ?? r.memory);
  const m = normalizeMemory(doc);
  return m.id ? m : null;
}

const IMAGE_MODEL_RE = /image|imagine|flux|krea|chroma|diffusion|sdxl|dall|seedream|recraft|ideogram/i;

/** Accepts ["id", …], [{ id }, …], { data: [...] }, or { text: [...], image: [...] }. */
function normalizeCatalog(raw: unknown): ModelCatalog | null {
  const idOf = (m: unknown) => (typeof m === "string" ? m : str(obj(m).id) || str(obj(m).name));
  const o = obj(raw);
  if (Array.isArray(o.text) || Array.isArray(o.image)) {
    const text = listOf(o.text).map(idOf).filter(Boolean);
    const image = listOf(o.image).map(idOf).filter(Boolean);
    return text.length || image.length ? { text, image } : null;
  }
  const all = listOf(raw, "data", "models").map((m) => ({ id: idOf(m), kind: str(obj(m).type) || str(obj(m).kind) }));
  const ids = all.filter((m) => m.id);
  if (!ids.length) return null;
  const isImage = (m: { id: string; kind: string }) => /image/i.test(m.kind) || (!m.kind && IMAGE_MODEL_RE.test(m.id));
  return { text: ids.filter((m) => !isImage(m)).map((m) => m.id), image: ids.filter(isImage).map((m) => m.id) };
}

/** A route this engine build doesn't mount. */
export function isNotAvailable(err: unknown): boolean {
  return err instanceof ApiError && err.notAvailable;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export const api = {
  status: (opts: RequestOptions = {}) => request<StatusResponse>("GET", "/status", undefined, { action: "load the engine status", ...opts }),

  personas: {
    list: (opts: RequestOptions = {}) => request<Persona[]>("GET", "/personas", undefined, { action: "load personas", ...opts }),
    get: (id: string) => request<Persona>("GET", `/personas/${enc(id)}`, undefined, { action: "load the persona" }),
    /** Create — no id, so the engine assigns a fresh one (never merges into an existing persona). */
    create: (fields: PersonaFields) => request<Persona>("POST", "/personas", fields, { action: "create the persona" }),
    update: (id: string, fields: Partial<PersonaFields>) =>
      request<Persona>("PUT", `/personas/${enc(id)}`, fields, { action: "save the persona" }),
    remove: (id: string) =>
      request<{ ok: boolean; active?: string }>("DELETE", `/personas/${enc(id)}`, undefined, { action: "delete the persona" }),
    activate: (id: string) =>
      request<{ ok: boolean; persona?: Persona }>("POST", `/personas/${enc(id)}/activate`, undefined, {
        action: "make the persona active",
      }),
  },

  endpoints: {
    get: (opts: RequestOptions = {}) =>
      request<PublicEndpoints>("GET", "/settings/endpoints", undefined, { action: "load settings", ...opts }),
    update: (patch: EndpointsPatch, opts: RequestOptions = {}) =>
      request<PublicEndpoints>("PUT", "/settings/endpoints", patch, { action: "save settings", ...opts }),
  },

  models: {
    /** Suggestions for the model fields; null when the engine doesn't list models (they stay free text). */
    async catalog(): Promise<ModelCatalog | null> {
      try {
        return normalizeCatalog(await request<unknown>("GET", "/settings/models", undefined, { quiet: true, timeoutMs: 8000 }));
      } catch {
        return null;
      }
    },
  },

  heartbeat: {
    list: async (opts: RequestOptions = {}) =>
      listOf(await request<unknown>("GET", "/heartbeat", undefined, { action: "load heartbeat tasks", ...opts }), "tasks")
        .map(normalizeTask)
        .filter((t) => t.id),
    create: async (task: HeartbeatInput) =>
      normalizeTask(await request<unknown>("POST", "/heartbeat", task, { action: task.once ? "add the reminder" : "add the task" })),
    update: async (id: string, patch: HeartbeatPatch, opts: RequestOptions = {}) =>
      normalizeTask(await request<unknown>("PUT", `/heartbeat/${enc(id)}`, patch, { action: "update the task", ...opts })),
    remove: (id: string, opts: RequestOptions = {}) =>
      request<{ ok: boolean }>("DELETE", `/heartbeat/${enc(id)}`, undefined, { action: "delete the task", ...opts }),
  },

  skills: {
    list: async (opts: RequestOptions = {}) =>
      normalizeSkills(await request<unknown>("GET", "/skills", undefined, { action: "load skills", ...opts })),
    /** Never rejects for a missing route — an engine without approvals has nothing pending. */
    async pending(opts: RequestOptions = {}): Promise<PendingSkill[]> {
      try {
        const raw = await request<unknown>("GET", "/skills/pending", undefined, {
          action: "load pending skills",
          ...opts,
          quiet: quietAlso(opts, (e) => e.notAvailable),
        });
        return normalizePending(raw);
      } catch (err) {
        if (isNotAvailable(err)) return [];
        throw err;
      }
    },
    /** The module source of a skill Trinity created. */
    async source(name: string, opts: RequestOptions = {}): Promise<{ code: string; skill: Skill | null }> {
      const r = obj(await request<unknown>("GET", `/skills/${enc(name)}/source`, undefined, { action: "load the code", ...opts }));
      const code = str(r.source) || str(r.code);
      // An engine may describe the skill (input, examples) alongside its code.
      const skill = r.input || r.examples ? normalizeSkill({ name, ...r, source: "forged" }) : null;
      return { code, skill };
    },
    async setEnabled(name: string, enabled: boolean, opts: RequestOptions = {}): Promise<Skill | null> {
      const r = obj(
        await request<unknown>("POST", `/skills/${enc(name)}/${enabled ? "enable" : "disable"}`, undefined, {
          action: enabled ? "turn the skill on" : "turn the skill off",
          ...opts,
        }),
      );
      const s = r.skill ? normalizeSkill(r.skill) : null;
      return s?.name ? s : null;
    },
    remove: (name: string, opts: RequestOptions = {}) =>
      request<{ ok: boolean }>("DELETE", `/skills/${enc(name)}`, undefined, { action: "delete the skill", ...opts }),
    /** Run a skill Trinity created once, in its sandbox. */
    async test(name: string, args: Record<string, unknown>, opts: RequestOptions = {}): Promise<SkillTestResult> {
      const r = obj(
        await request<unknown>("POST", `/skills/${enc(name)}/test`, { args }, { action: "test the skill", timeoutMs: 45_000, ...opts }),
      );
      const result = normalizeRunResult(r.result);
      const error = optStr(r.error) ?? optStr(r.reason);
      const out: SkillTestResult = { ok: r.ok !== false && (result?.ok ?? true), result, ms: optNum(r.ms) ?? null };
      if (error) out.error = error;
      return out;
    },
    /** Have Trinity write, sandbox-test, and save a new skill. Slow: a coder writes it, then it's tested (and maybe repaired). */
    async forge(need: string, opts: RequestOptions = {}): Promise<ForgeResult> {
      const r = obj(await request<unknown>("POST", "/skills/forge", { need }, { action: "create the skill", timeoutMs: 240_000, ...opts }));
      if (r.ok === false) return { ok: false, reason: optStr(r.reason) ?? optStr(r.error) ?? "The skill couldn't be made." };
      // normalizeSkill defaults a missing source to "builtin"; anything forged here is Trinity's.
      const skill = normalizeSkill({ source: FORGED_SOURCE, ...obj(r.skill ?? r) });
      if (!skill.name) return { ok: false, reason: "The engine didn't say which skill it made." };
      return { ok: true, skill };
    },
    approve: (name: string) =>
      request<{ ok: boolean; name?: string }>("POST", `/skills/${enc(name)}/approve`, undefined, { action: "approve the skill" }),
    discard: (name: string) =>
      request<{ ok: boolean }>("POST", `/skills/${enc(name)}/discard`, undefined, { action: "discard the skill" }),
  },

  memory: {
    async list(query: MemoryQuery = {}, opts: RequestOptions = {}): Promise<Memory[]> {
      const params = new URLSearchParams();
      if (query.q?.trim()) params.set("q", query.q.trim());
      if (query.limit) params.set("limit", String(query.limit));
      if (query.type) params.set("type", query.type);
      const qs = params.toString();
      const raw = await request<unknown>("GET", `/memory${qs ? `?${qs}` : ""}`, undefined, { action: "load memories", ...opts });
      return listOf(raw, "memories", "results", "docs").map(normalizeMemory).filter((m) => m.id);
    },
    async create(input: MemoryInput, opts: RequestOptions = {}): Promise<Memory | null> {
      return memoryFrom(await request<unknown>("POST", "/memory", input, { action: "save the memory", ...opts }));
    },
    async update(id: string, input: MemoryInput, opts: RequestOptions = {}): Promise<Memory | null> {
      return memoryFrom(await request<unknown>("PUT", `/memory/${enc(id)}`, input, { action: "save the memory", ...opts }));
    },
    remove: (id: string, opts: RequestOptions = {}) =>
      request<{ ok: boolean }>("DELETE", `/memory/${enc(id)}`, undefined, { action: "delete the memory", ...opts }),
  },

  profile: {
    /** Never rejects for a missing route — reports `available: false` instead. */
    async get(opts: RequestOptions = {}): Promise<Profile> {
      try {
        const r = obj(
          await request<unknown>("GET", "/profile", undefined, {
            action: "load your profile",
            ...opts,
            quiet: quietAlso(opts, (e) => e.notAvailable),
          }),
        );
        return { name: str(r.name), available: true };
      } catch (err) {
        if (isNotAvailable(err)) return { name: "", available: false };
        throw err;
      }
    },
    async set(name: string): Promise<ProfileSaved> {
      const r = obj(await request<unknown>("PUT", "/profile", { name }, { action: "save your name" }));
      // What the engine stored (it trims, and answers null when the name was cleared).
      const saved: ProfileSaved = { name: "name" in r ? str(r.name) : name, available: true };
      const memory = r.memory ? memoryFrom(r.memory) : null;
      if (memory) saved.memory = memory;
      const removed = optStr(r.removed);
      if (removed) saved.removed = removed;
      return saved;
    },
  },

  voices: {
    /** Never rejects for a missing route — falls back to the built-in presets. */
    async list(opts: RequestOptions = {}): Promise<VoiceLibrary> {
      try {
        const raw = await request<unknown>("GET", "/voices", undefined, {
          action: "load voices",
          ...opts,
          quiet: quietAlso(opts, (e) => e.notAvailable || e.status === 404),
        });
        return normalizeVoices(raw);
      } catch (err) {
        if (err instanceof ApiError && (err.notAvailable || err.status === 404)) return fallbackVoices();
        throw err;
      }
    },
    async create(name: string, wavBase64: string): Promise<CreateVoiceResult> {
      const r = await request<Record<string, unknown>>("POST", "/voices", { name, wavBase64 }, {
        action: "save the voice",
        timeoutMs: 60_000,
      });
      return {
        voice: normalizeCustomVoice(r.voice),
        synced: Boolean(r.synced),
        syncError: typeof r.syncError === "string" ? r.syncError : undefined,
      };
    },
    remove: (slug: string) => request<{ ok: boolean }>("DELETE", `/voices/${enc(slug)}`, undefined, { action: "delete the voice" }),
    async sync(slug: string): Promise<SyncResult> {
      const r = await request<Record<string, unknown>>("POST", `/voices/${enc(slug)}/sync`, undefined, {
        action: "sync the voice",
        timeoutMs: 45_000,
      });
      return { synced: Boolean(r.synced), error: typeof r.error === "string" ? r.error : undefined };
    },
    audioUrl: (slug: string) => `/api/voices/${enc(slug)}/audio`,
  },

  games: {
    /** Never rejects for a missing route — reports `available: false` instead. */
    async list(opts: RequestOptions = {}): Promise<GameList> {
      try {
        const raw = await request<unknown>("GET", "/games", undefined, {
          action: "load saved games",
          ...opts,
          quiet: quietAlso(opts, (e) => e.notAvailable),
        });
        const games = (Array.isArray(raw) ? raw : []).map(normalizeGame).filter((g) => g.id);
        return { available: true, games };
      } catch (err) {
        if (err instanceof ApiError && err.notAvailable) return { available: false, games: [] };
        throw err;
      }
    },
    get: (id: string, opts: RequestOptions = {}) =>
      request<GameView>("GET", `/games/${enc(id)}`, undefined, { action: "load the game", ...opts }),
    open: (id: string) =>
      request<{ ok: boolean }>("POST", `/games/${enc(id)}/open`, undefined, { action: "open the game" }),
    remove: (id: string) => request<{ ok: boolean }>("DELETE", `/games/${enc(id)}`, undefined, { action: "delete the game" }),
  },

  toolsets: {
    /** Falls back to the Game Master toolset when the engine doesn't list toolsets. */
    async list(): Promise<Toolset[]> {
      try {
        return normalizeToolsets(await request<unknown>("GET", "/toolsets", undefined, { quiet: true }));
      } catch {
        return FALLBACK_TOOLSETS;
      }
    },
  },
};
