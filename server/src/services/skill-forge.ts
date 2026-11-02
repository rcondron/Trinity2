import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { FORGED_SKILLS_DIR, PENDING_SKILLS_DIR } from "../config.js";
import { describeSkill, runSkill, RUN_TIMEOUT_MS, TEST_TIMEOUT_MS, type SandboxResult, type SkillMeta } from "../sandbox/host.js";
import { coderModel, getEndpoints, live } from "../settings.js";
import { FORGED_SOURCE, getTool, getTools, registerTool, toolSource, unregisterTool } from "../tools/registry.js";
import type { Tool, ToolArgSpec, ToolResult } from "../types.js";
import { mordiemStream, StreamHttpError, type ChatMessage } from "./llm.js";

/**
 * Skills Trinity creates on the fly. A coder (Kimi for quality, GLM when Kimi fails or runs
 * long) writes one ES module; it is described and self-tested in the sandbox (sandbox/host.ts),
 * gets ONE repair round (GLM, fast) with the failure fed back, and is then saved to data/skills/<name>.skill.mjs
 * with an entry in data/skills/index.json. With skill approval "auto" it is registered at
 * once (Jev can route to it on the very next decision); with "manual" it waits in
 * data/skills/pending/ for approval in Settings → Skills. Every run is sandboxed.
 */

/** A skill Trinity created, as recorded in data/skills/index.json. */
export interface ForgedSkill {
  name: string;
  /** One sentence saying when to use it — doubles as its Jev label. */
  description: string;
  input: Record<string, ToolArgSpec>;
  /** 1–2 argument sets: its self-test (and the Settings test form's starting values). */
  examples: Record<string, unknown>[];
  /** Switched on in Settings (only enabled skills are offered to Jev). */
  enabled: boolean;
  /** Waiting for approval (skill approval "manual"); the module is in data/skills/pending/. */
  pending: boolean;
  createdAt: number;
  /** What was asked for, in the user's words. */
  need: string;
  /** The coder model that wrote it. */
  model: string;
  /** sha256 of the module; a module edited by hand is described (and checked) again. */
  hash: string;
  /** Why it can't be used right now (e.g. the module no longer loads). */
  problem?: string;
}

export type ForgeOutcome =
  | { ok: true; skill: ForgedSkill }
  /** kind: "config" (no coder configured), "model" (the coder failed), "test" (it failed its self-test twice). */
  | { ok: false; reason: string; kind: "config" | "model" | "test" };

export interface ForgeOptions {
  /** Recent conversation lines, so "make a tool for that" knows what "that" is. */
  context?: string;
  /** Progress for the workspace chip ("Writing…", "Testing…", "Fixing…"). */
  onStage?: (text: string) => void;
  /** Start from this module instead of asking the coder (it still gets the self-test and the one repair round). */
  draft?: string;
}

/** A lifecycle request that can't be done; `status` is the HTTP status the Skills API answers with. */
export class SkillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const INDEX = path.join(FORGED_SKILLS_DIR, "index.json");
/** Drafts being tested (each gets its own file so the sandbox may read exactly that one). */
const STAGING = path.join(FORGED_SKILLS_DIR, ".staging");
const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;
const FILE_RE = /^([a-z][a-z0-9_]{2,47})\.skill\.mjs$/;
/** The core tools' names (and the Game Master's "game_" prefix): never a forged skill's, registered or not. */
const RESERVED = new Set([
  "build_ui",
  "ask_brain",
  "create_skill",
  "remember",
  "recall",
  "schedule",
  "web_search",
  "get_time",
  "roll_dice",
  "heartbeat_add",
]);
const MAX_SAY = 500;
const MAX_RENDER = 200_000;
const MAX_DATA = 64_000;

const SKILL_SYSTEM = [
  "You write ONE new skill for Trinity, a voice assistant: a single JavaScript ES module (plain JavaScript for Node 24, no TypeScript) that Trinity calls as a tool.",
  "",
  "The module must `export default` an object with:",
  '- name: a snake_case verb phrase of at most 40 characters, e.g. "convert_currency".',
  "- description: ONE sentence saying when to use the skill, starting with a verb, e.g. \"Convert an amount of money between currencies at today's exchange rate.\" Trinity picks skills by this sentence, so make it specific.",
  '- input: an object mapping each argument name to { type: "string" | "number" | "boolean", description, required?: true } — only the few things a user would say out loud.',
  "- examples: an array of 1 or 2 argument objects written the way a user would SAY them (\"British pounds\", \"Christmas\", \"next Friday\", \"new york\"), not in machine format. They are run as the skill's self-test before it is saved, so they must succeed.",
  "- run: async (args) => ({ ok, say, render?, data? }).",
  "",
  "How run behaves:",
  '- Arguments come from speech: accept natural forms and normalize them yourself — numbers may arrive as strings or words, currencies and units as names ("dollars" or "US dollars" means USD), dates as phrases ("Christmas", "next Friday", "July 4th"); trim and fix the case of names.',
  '- say: ONE short sentence that answers out loud, written for speech ("about 92 euros", not "91.8234 EUR"; no markdown, no URLs).',
  '- On any problem (missing or bad input, a service error, nothing found) return { ok: false, say: "<one sentence on what went wrong or what is needed>" }. Never throw.',
  "- render (optional): a small self-contained HTML fragment showing the result in Trinity's workspace: inline styles, dark theme (light text on a dark background), no scripts, no external images, fonts or stylesheets (emoji and inline SVG are fine).",
  "- data (optional): the raw result as plain JSON.",
  "- For live data use the global fetch with keyless public HTTPS APIs only (no API keys, no sign-up), e.g. Open-Meteo (weather and geocoding), Frankfurter (exchange rates), Wikipedia's REST API, dictionaryapi.dev, REST Countries. Check res.ok and pass signal: AbortSignal.timeout(8000) to every request; finish within 10 seconds.",
  "- It runs in a locked-down sandbox: no import or require of anything, no file system, no child processes, no environment variables (there are no API keys), nothing on localhost or the local network. Use only globals (fetch, URL, URLSearchParams, Intl, Math, JSON, crypto, TextEncoder).",
  "",
  "Return ONLY the module source: no markdown fences, no commentary.",
].join("\n");

// ─── Store: data/skills/index.json + one module per skill ─────────────────────────────────

let cache: ForgedSkill[] | null = null;

function entries(): ForgedSkill[] {
  if (cache) return cache;
  cache = [];
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX, "utf8")) as { skills?: unknown };
    if (Array.isArray(raw.skills)) cache = raw.skills.filter(isEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Keep the unreadable index for inspection; the modules themselves are adopted again at boot.
      console.warn("[skills] data/skills/index.json is unreadable, starting over:", (err as Error).message);
      fs.copyFileSync(INDEX, `${INDEX}.bad`);
    }
  }
  return cache;
}

function isEntry(v: unknown): v is ForgedSkill {
  const s = v as ForgedSkill;
  return Boolean(s) && typeof s.name === "string" && NAME_RE.test(s.name) && typeof s.description === "string" && typeof s.input === "object";
}

function save(): void {
  fs.mkdirSync(FORGED_SKILLS_DIR, { recursive: true });
  writeAtomic(INDEX, JSON.stringify({ version: 1, skills: entries() }, null, 2));
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const words = (name: string) => name.replace(/_/g, " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The line of a failure report that says what went wrong (a syntax error's message follows its location). */
function headline(report: string): string {
  const lines = report.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\b[A-Z]\w*Error\b/.test(l)) ?? lines[0] ?? report;
}

function fileOf(s: Pick<ForgedSkill, "name" | "pending">): string {
  return path.join(s.pending ? PENDING_SKILLS_DIR : FORGED_SKILLS_DIR, `${s.name}.skill.mjs`);
}

/** Skills Trinity created and you approved (enabled or not). */
export function listForged(): ForgedSkill[] {
  return entries().filter((s) => !s.pending);
}
/** Skills waiting for approval (skill approval "manual"). */
export function listPending(): ForgedSkill[] {
  return entries().filter((s) => s.pending);
}
export function findForged(name: string): ForgedSkill | undefined {
  return entries().find((s) => s.name === name);
}
/** A forged (or pending) skill's module source, or null. */
export function forgedSource(name: string): string | null {
  const s = findForged(name);
  if (!s) return null;
  try {
    return fs.readFileSync(fileOf(s), "utf8");
  } catch {
    return null;
  }
}

/** Whether a name is taken — by any tool, a forged or pending skill (other than `self`), or reserved. */
function taken(name: string, self?: ForgedSkill): boolean {
  if (RESERVED.has(name) || name.startsWith("game_")) return true;
  const tool = getTool(name);
  if (tool && !(self && toolSource(tool) === "forged" && self.name === name)) return true;
  return entries().some((s) => s !== self && s.name === name);
}

function uniqueName(base: string, self?: ForgedSkill): string {
  if (!taken(base, self)) return base;
  for (let i = 2; ; i++) {
    const name = `${base.slice(0, 44)}_${i}`;
    if (!taken(name, self)) return name;
  }
}

// ─── The sandboxed tool ───────────────────────────────────────────────────────────────────

/** The Tool Jev routes to: arguments are filled by the fast model; every run is sandboxed. */
function toTool(s: ForgedSkill): Tool {
  return {
    name: s.name,
    description: s.description,
    input: s.input,
    source: FORGED_SOURCE,
    run: (args) => {
      const current = findForged(s.name);
      return current
        ? runEntry(current, args, RUN_TIMEOUT_MS)
        : Promise.resolve({ ok: false, say: `The ${words(s.name)} skill was removed.`, error: "no such skill" });
    },
  };
}

/** Coerce arguments to the declared types (only declared ones pass); lists the required ones still missing. */
function prepareArgs(input: Record<string, ToolArgSpec>, raw: Record<string, unknown>): { args: Record<string, unknown>; missing: string[] } {
  const args: Record<string, unknown> = {};
  for (const [arg, spec] of Object.entries(input)) {
    const v = raw[arg];
    if (v === undefined || v === null || v === "") continue;
    if (spec.type === "number") {
      const digits = typeof v === "number" ? "" : String(v).replace(/[^0-9.eE+-]/g, "");
      const n = typeof v === "number" ? v : /\d/.test(digits) ? Number(digits) : NaN;
      args[arg] = Number.isFinite(n) ? n : v; // "a hundred": the skill normalizes it itself
    } else if (spec.type === "boolean") {
      args[arg] = typeof v === "boolean" ? v : /^(true|yes|on|1)$/i.test(String(v));
    } else args[arg] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const missing = Object.entries(input)
    .filter(([arg, spec]) => spec.required && !(arg in args))
    .map(([arg]) => arg);
  return { args, missing };
}

async function runEntry(s: ForgedSkill, raw: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
  const { args, missing } = prepareArgs(s.input, raw);
  if (missing.length) {
    const what = missing.map((m) => `the ${words(m.replace(/([a-z])([A-Z])/g, "$1_$2")).toLowerCase()}`).join(" and ");
    return { ok: false, say: `I need ${what} for that.`, error: `missing ${missing.join(", ")}` };
  }
  return toResult(s.name, await runSkill(fileOf(s), args, timeoutMs));
}

/** What the skill returned → a ToolResult (sizes capped; a sandbox failure in words). */
function toResult(name: string, r: SandboxResult<unknown>): ToolResult {
  if (!r.ok) {
    const why = headline(r.error);
    return { ok: false, say: `My ${words(name)} skill didn't work: ${why}.`, error: why };
  }
  const v = r.value !== null && typeof r.value === "object" ? (r.value as Record<string, unknown>) : null;
  if (!v) return { ok: false, say: `My ${words(name)} skill returned nothing usable.`, error: "no {ok, say} object" };
  const say = typeof v.say === "string" ? clip(v.say.replace(/\s+/g, " ").trim(), MAX_SAY) : "";
  const data = v.data !== undefined && (JSON.stringify(v.data)?.length ?? 0) <= MAX_DATA ? v.data : undefined;
  if (v.ok !== true) return { ok: false, say: say || `My ${words(name)} skill couldn't do that.`, error: say || "the skill reported a failure", data };
  if (BROKEN_VALUE.test(say)) return { ok: false, say: `My ${words(name)} skill got a garbled answer for that.`, error: `broken value: ${say}` };
  const render = typeof v.render === "string" && v.render.trim() && v.render.length <= MAX_RENDER ? v.render : undefined;
  return { ok: true, say: say || "Done.", render, data };
}

// ─── Checking a module ────────────────────────────────────────────────────────────────────

interface SkillSpec {
  name: string;
  description: string;
  input: Record<string, ToolArgSpec>;
  examples: Record<string, unknown>[];
}

type Verdict = { spec: SkillSpec } | { problem: string };

/** Problems visible without running it — each phrased as a fix for the repair round. */
function lintModule(code: string): string | null {
  if (!code) return "the reply contained no module";
  if (code.length > 60_000) return "the module is too long: keep it compact (well under 300 lines)";
  if (!/\bexport\s+default\b/.test(code)) return "the module has no `export default { … }` object";
  if (/^\s*import[\s{*'"]|\bimport\s*\(|\brequire\s*\(/m.test(code))
    return "it imports a module, but skills can't import anything (the sandbox refuses it): use only globals such as fetch, URL, Intl, Math, JSON and crypto";
  if (/\bprocess\.env\b/.test(code))
    return "it reads environment variables, but skills get none (there are no API keys): use a keyless public API";
  return null;
}

function snakeName(raw: unknown): string {
  return typeof raw === "string"
    ? raw
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48)
    : "";
}

/** Validate what the module says about itself (from the sandbox), normalizing what's loose. */
function checkMeta(meta: SkillMeta): Verdict {
  if (!meta.hasRun) return { problem: "the default export has no async run(args) function" };
  const name = snakeName(meta.name);
  if (!NAME_RE.test(name)) return { problem: `name must be a snake_case string of 3 to 48 characters (got ${JSON.stringify(meta.name)})` };
  const description = typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
  if (description.length < 12) return { problem: "description must be one sentence saying when to use the skill" };

  const input: Record<string, ToolArgSpec> = {};
  if (meta.input !== undefined && meta.input !== null) {
    if (typeof meta.input !== "object" || Array.isArray(meta.input))
      return { problem: "input must be an object mapping argument names to { type, description, required? }" };
    const args = Object.entries(meta.input as Record<string, unknown>);
    if (args.length > 8) return { problem: "input has too many arguments (at most 8)" };
    for (const [arg, raw] of args) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(arg)) return { problem: `input argument "${arg}" needs a plain identifier as its name` };
      const s = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const t = String(s.type ?? "string").toLowerCase();
      const spec: ToolArgSpec = {
        type: ["number", "integer", "float"].includes(t) ? "number" : ["boolean", "bool"].includes(t) ? "boolean" : "string",
        description: typeof s.description === "string" && s.description.trim() ? clip(s.description.trim(), 200) : words(arg),
      };
      if (s.required === true) spec.required = true;
      const options = Array.isArray(s.options)
        ? s.options.map((o) => [String(o), String(o)])
        : s.options && typeof s.options === "object"
          ? Object.entries(s.options as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          : [];
      if (options.length) spec.options = Object.fromEntries(options.slice(0, 12));
      input[arg] = spec;
    }
  }

  const examples = (Array.isArray(meta.examples) ? meta.examples : [])
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object" && !Array.isArray(e))
    .slice(0, 2);
  if (examples.length === 0) {
    if (Object.values(input).some((s) => s.required)) return { problem: "examples must be an array of 1 or 2 argument objects (its self-test)" };
    examples.push({});
  }
  return { spec: { name, description: clip(description, 300), input, examples } };
}

/** Run every example in the sandbox: each must come back ok with a spoken sentence. Null = passed. */
async function selfTest(file: string, spec: SkillSpec): Promise<string | null> {
  for (const [i, example] of spec.examples.entries()) {
    const label = `Example ${i + 1} ${JSON.stringify(example)}`;
    const { args, missing } = prepareArgs(spec.input, example);
    if (missing.length) return `${label} is missing the required argument(s): ${missing.join(", ")}.`;
    const r = await runSkill(file, args, TEST_TIMEOUT_MS);
    if (!r.ok) return `${label} failed: ${r.error}${logTail(r.log)}`;
    const v = r.value as Record<string, unknown> | null;
    if (v === null || typeof v !== "object") return `${label} returned ${JSON.stringify(v)} instead of an object { ok, say }.`;
    if (v.ok !== true)
      return `${label} returned ok: ${JSON.stringify(v.ok)} with say: ${JSON.stringify(v.say)} — the examples must succeed.${logTail(r.log)}`;
    if (typeof v.say !== "string" || !v.say.trim()) return `${label} returned no "say" sentence.`;
    const broken = BROKEN_VALUE.exec(v.say);
    if (broken) return `${label} returned ok, but its sentence has a broken value (${broken[0]}): ${JSON.stringify(v.say)}.${logTail(r.log)}`;
    if (v.render !== undefined && typeof v.render !== "string") return `${label} returned a "render" that isn't an HTML string.`;
  }
  return null;
}

/** A computed value that went wrong, spoken as is ("Christmas is in NaN days"). */
const BROKEN_VALUE = /\bNaN\b|\bundefined\b|\[object \w+\]|Invalid Date/;

const logTail = (log: string) => (log.trim() ? `\nIts console output:\n${clip(log.trim().slice(-1500), 1500)}` : "");

/** Lint, describe and self-test a draft, staged as its own file (the one file its sandbox may read). */
async function vet(code: string, stage: (text: string) => void): Promise<Verdict> {
  const lint = lintModule(code);
  if (lint) return { problem: lint };
  const file = path.join(STAGING, `${nanoid(10)}.skill.mjs`);
  try {
    fs.mkdirSync(STAGING, { recursive: true });
    fs.writeFileSync(file, code, "utf8");
    const d = await describeSkill(file);
    if (!d.ok) return { problem: `Loading the module failed: ${d.error}${logTail(d.log)}` };
    const checked = checkMeta(d.value);
    if ("problem" in checked) return checked;
    stage(`Testing ${words(checked.spec.name)}…`);
    const failed = await selfTest(file, checked.spec);
    return failed ? { problem: failed } : checked;
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* still held by a sandbox that's exiting; boot clears the staging folder */
    }
  }
}

// ─── Forging ──────────────────────────────────────────────────────────────────────────────

/** The module from a coder's reply (fences, prose around a fenced block, and <think> dropped). */
function extractModule(raw: string): string {
  const s = raw.replace(/^\s*<think>[\s\S]*?<\/think>/i, "").trim();
  const fenced = [...s.matchAll(/```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi)]
    .map((m) => m[1] ?? "")
    .filter((b) => /export\s+default/.test(b))
    .sort((a, b) => b.length - a.length)[0];
  return (fenced ?? s.replace(/^```[a-z]*[ \t]*\r?\n?/i, "").replace(/\r?\n?```\s*$/, "")).trim();
}

/**
 * Time each coder gets; past it the other coder takes over. Measured on Mordiem with this prompt:
 * kimi-k3 at its default effort thinks before writing and took from ~20 s to past 170 s; with
 * reasoning_effort "low" it writes a ~6 KB skill in 18–24 s (first code after ~1.3 s; "medium":
 * 36–41 s). z-ai-glm-5-3-flash takes ~5 s. The self-test and repair round catch what low effort misses.
 */
const CODER_BUDGET_MS = { kimi: 75_000, glm: 60_000 };
/** Extra request fields per coder (a model that rejects them with HTTP 400 is asked again without). */
const CODER_EXTRA: Record<"kimi" | "glm", Record<string, unknown> | undefined> = { kimi: { reasoning_effort: "low" }, glm: undefined };

/**
 * One coder call; when it fails (HTTP error, stall, over budget, empty reply) the other coder
 * gets the same messages. `progress` labels the chip while the model thinks, then writes.
 */
async function generate(
  messages: ChatMessage[],
  prefer: "kimi" | "glm",
  progress?: { thinking: string; writing: string; stage: (text: string) => void },
): Promise<{ code: string; model: string }> {
  let last: Error | null = null;
  for (const which of prefer === "kimi" ? (["kimi", "glm"] as const) : (["glm", "kimi"] as const)) {
    const model = coderModel(which);
    let shown = "";
    const show = (text: string) => {
      if (progress && shown !== text) progress.stage((shown = text));
    };
    // Reasoning deltas keep the idle timer alive; a thinking model needs room, hence the large max_tokens.
    const call = (extra?: Record<string, unknown>) =>
      mordiemStream(model, messages, () => show(progress?.writing ?? ""), {
        temperature: 0.2,
        maxTokens: 16_000,
        timeoutMs: CODER_BUDGET_MS[which],
        idleMs: 45_000,
        extra,
        onReasoning: () => {
          if (!shown) show(progress?.thinking ?? "");
        },
      });
    try {
      let text: string;
      try {
        text = await call(CODER_EXTRA[which]);
      } catch (err) {
        if (!(CODER_EXTRA[which] && err instanceof StreamHttpError && err.status === 400)) throw err;
        text = await call();
      }
      const code = extractModule(text);
      if (code) return { code, model };
      last = new Error(`${model} returned no code`);
    } catch (err) {
      last = err as Error;
    }
    console.warn(`[skills] coder ${model} failed: ${String(last?.message).slice(0, 200)}`);
  }
  throw last ?? new Error("no coder configured");
}

function requestText(need: string, context?: string): string {
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  const names = [...new Set([...getTools().map((t) => t.name), ...entries().map((s) => s.name)])];
  return [
    `Write a skill for this request: "${clip(need.replace(/"/g, "'"), 1000)}"`,
    context ? `\nThe conversation so far (the request is the user's latest words):\n${clip(context, 2000)}\n` : "",
    `The user's locale is ${locale}, time zone ${timeZone}: default to the units and formats they'd expect.`,
    `Names already taken (pick another): ${names.join(", ") || "none"}.`,
  ].join("\n");
}

let forgeChain: Promise<unknown> = Promise.resolve();
let inFlight = 0;

/** Forges running or waiting (they run one at a time, in the order asked). */
export function forgesInFlight(): number {
  return inFlight;
}

/**
 * Create a skill for `need`: generate → describe + self-test in the sandbox → one repair round
 * on failure → save, and register (approval "auto") or park it for approval ("manual").
 * Never throws; takes ~15–60 s.
 */
export function forgeSkill(need: string, opts: ForgeOptions = {}): Promise<ForgeOutcome> {
  inFlight++;
  const run = forgeChain.then(() => forgeNow(need.trim(), opts));
  forgeChain = run.catch(() => {});
  return run.finally(() => inFlight--);
}

async function forgeNow(need: string, opts: ForgeOptions): Promise<ForgeOutcome> {
  if (!live.mordiem) return { ok: false, kind: "config", reason: "no coding model is configured (add a Mordiem key in Settings)" };
  if (!need) return { ok: false, kind: "config", reason: "say what the skill should do" };
  const stage = opts.onStage ?? (() => {});
  const messages: ChatMessage[] = [
    { role: "system", content: SKILL_SYSTEM },
    { role: "user", content: requestText(need, opts.context) },
  ];
  const started = Date.now();
  let draft: { code: string; model: string };
  let verdict: Verdict;
  try {
    stage(opts.draft ? "Checking the new skill…" : "Writing a new skill…");
    // Kimi writes the draft (quality); GLM, ~10x faster, does the repair round (the fix is usually local).
    draft = opts.draft
      ? { code: extractModule(opts.draft), model: "hand-written" }
      : await generate(messages, "kimi", { thinking: "Planning a new skill…", writing: "Writing a new skill…", stage });
    verdict = await vet(draft.code, stage);
    if ("problem" in verdict) {
      console.warn(`[skills] first draft by ${draft.model} failed its check: ${headline(verdict.problem)}`);
      stage("Fixing the new skill…");
      messages.push(
        { role: "assistant", content: draft.code },
        {
          role: "user",
          content: `That module failed its sandbox test:\n${clip(verdict.problem, 3000)}\n\nFix it and return the complete corrected module (same format, ONLY the code).`,
        },
      );
      draft = await generate(messages, "glm");
      verdict = await vet(draft.code, stage);
      if ("problem" in verdict) {
        console.warn(`[skills] the repaired draft failed too: ${headline(verdict.problem)}`);
        return { ok: false, kind: "test", reason: `it failed its self-test twice (${clip(headline(verdict.problem), 200)})` };
      }
    }
  } catch (err) {
    return { ok: false, kind: "model", reason: `the coding model failed (${clip((err as Error).message, 200)})` };
  }
  try {
    const skill = install(verdict.spec, draft.code, need, draft.model);
    console.log(`[skills] created ${skill.name}${skill.pending ? " (awaiting approval)" : ""} with ${draft.model} in ${Math.round((Date.now() - started) / 1000)}s`);
    return { ok: true, skill };
  } catch (err) {
    return { ok: false, kind: "config", reason: `it couldn't be saved (${(err as Error).message})` };
  }
}

/** Save a tested module and record it; registered now unless approval is manual. Synchronous, so names can't race. */
function install(spec: SkillSpec, code: string, need: string, model: string): ForgedSkill {
  const pending = getEndpoints().skillApproval === "manual";
  const skill: ForgedSkill = {
    ...spec,
    name: uniqueName(spec.name),
    enabled: true,
    pending,
    createdAt: Date.now(),
    need: clip(need, 500),
    model,
    hash: sha256(code),
  };
  const file = fileOf(skill);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, code);
  entries().push(skill);
  save();
  if (!pending) registerTool(toTool(skill));
  return skill;
}

// ─── Lifecycle (Settings → Skills) ────────────────────────────────────────────────────────

/** A module changed on disk since it was recorded (edited by hand): describe and check it again. */
async function refresh(s: ForgedSkill): Promise<void> {
  let code: string;
  try {
    code = fs.readFileSync(fileOf(s), "utf8");
  } catch {
    s.problem = "its module file is missing";
    return;
  }
  const hash = sha256(code);
  if (hash === s.hash && !s.problem) return;
  const lint = lintModule(code);
  const d = lint ? null : await describeSkill(fileOf(s));
  const checked: Verdict = lint
    ? { problem: lint }
    : d && d.ok
      ? checkMeta(d.value)
      : { problem: `it no longer loads: ${d?.ok === false ? headline(d.error) : "unknown error"}` };
  if ("problem" in checked) {
    s.problem = checked.problem;
    return;
  }
  Object.assign(s, { description: checked.spec.description, input: checked.spec.input, examples: checked.spec.examples, hash });
  delete s.problem;
}

/** Register an enabled skill unless a non-forged tool holds its name. */
function activate(s: ForgedSkill): boolean {
  const holder = getTool(s.name);
  if (holder && toolSource(holder) !== "forged") {
    s.problem = `a ${toolSource(holder)} tool already has the name ${s.name}`;
    return false;
  }
  registerTool(toTool(s));
  return true;
}

function deactivate(name: string): void {
  const t = getTool(name);
  if (t && toolSource(t) === "forged") unregisterTool(name);
}

function requireForged(name: string, pending?: boolean): ForgedSkill {
  const s = findForged(name);
  if (!s || (pending !== undefined && s.pending !== pending))
    throw new SkillError(pending ? `no skill named ${name} is waiting for approval` : `no skill Trinity created is named ${name}`, 404);
  return s;
}

/** Switch a forged skill on (registered: Jev can use it) or off. */
export async function setForgedEnabled(name: string, enabled: boolean): Promise<ForgedSkill> {
  const s = requireForged(name, false);
  if (!enabled) {
    s.enabled = false;
    deactivate(name);
    save();
    return s;
  }
  await refresh(s);
  if (s.problem || !activate(s)) {
    deactivate(name); // never leave Jev offering a skill that can't load
    save();
    throw new SkillError(`can't enable ${name}: ${s.problem}`, 409);
  }
  s.enabled = true;
  save();
  return s;
}

/** Remove a forged (or pending) skill: unregistered, module deleted. */
export function deleteForged(name: string): void {
  const s = requireForged(name);
  if (!s.pending) deactivate(name);
  fs.rmSync(fileOf(s), { force: true });
  cache = entries().filter((x) => x !== s);
  save();
}

/** Approve a pending skill: checked again, moved into data/skills/, registered. */
export async function approveSkill(name: string): Promise<ForgedSkill> {
  const s = requireForged(name, true);
  await refresh(s);
  if (s.problem) {
    save();
    throw new SkillError(`can't approve ${name}: ${s.problem}`, 409);
  }
  const from = fileOf(s);
  // A tool may have taken the name while it waited.
  const finalName = uniqueName(s.name, s);
  const to = fileOf({ name: finalName, pending: false });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  Object.assign(s, { name: finalName, pending: false, enabled: true });
  activate(s);
  save();
  return s;
}

/** Throw away a pending skill. */
export function discardSkill(name: string): void {
  requireForged(name, true);
  deleteForged(name);
}

/** Run a forged or pending skill once with these arguments (sandboxed), for Settings' test form. */
export async function testForged(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; ms: number }> {
  const s = requireForged(name);
  const started = Date.now();
  const result = await runEntry(s, args, TEST_TIMEOUT_MS);
  return { result, ms: Date.now() - started };
}

/**
 * Boot: register the enabled skills Trinity created earlier. Modules that changed on disk are
 * checked again; modules without an index entry (copied in by hand, or a lost index) are
 * adopted — enabled when approval is "auto"; entries whose module is gone are dropped.
 */
export async function loadForged(): Promise<string[]> {
  fs.rmSync(STAGING, { recursive: true, force: true }); // drafts a crash left behind
  const list = entries();
  for (const s of [...list]) {
    if (!fs.existsSync(fileOf(s))) {
      console.warn(`[skills] ${s.name}: its module is gone, removing it from the index`);
      cache = entries().filter((x) => x !== s);
    }
  }
  await adoptOrphans();
  const skills = entries();
  await Promise.all(skills.map((s) => refresh(s)));
  const loaded: string[] = [];
  for (const s of skills) {
    if (s.pending || !s.enabled) continue;
    if (s.problem) console.warn(`[skills] ${s.name} not loaded: ${s.problem}`);
    else if (activate(s)) loaded.push(s.name);
  }
  if (skills.length || fs.existsSync(INDEX)) save();
  return loaded;
}

async function adoptOrphans(): Promise<void> {
  const auto = getEndpoints().skillApproval === "auto";
  for (const [dir, pending] of [
    [FORGED_SKILLS_DIR, false],
    [PENDING_SKILLS_DIR, true],
  ] as const) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const name = FILE_RE.exec(f)?.[1] ?? "";
      if (findForged(name)) continue;
      if (taken(name)) {
        console.warn(`[skills] not adopting ${f}: the name ${name} is taken`);
        continue;
      }
      const file = path.join(dir, f);
      const code = fs.readFileSync(file, "utf8");
      const lint = lintModule(code);
      const d = lint ? null : await describeSkill(file);
      const checked: Verdict = lint ? { problem: lint } : d?.ok ? checkMeta(d.value) : { problem: d?.ok === false ? d.error : "unknown" };
      if ("problem" in checked) {
        console.warn(`[skills] not adopting ${f}: ${headline(checked.problem)}`);
        continue;
      }
      entries().push({
        ...checked.spec,
        name,
        enabled: pending || auto,
        pending,
        createdAt: Math.round(fs.statSync(file).mtimeMs),
        need: "(added by hand)",
        model: "unknown",
        hash: sha256(code),
      });
      console.log(`[skills] adopted ${f}${pending ? " (awaiting approval)" : auto ? "" : " (disabled until you enable it)"}`);
    }
  }
}
