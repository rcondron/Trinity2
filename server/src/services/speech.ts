import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { DATA_DIR } from "../config.js";
import { getSetting, setSetting } from "../db/sqlite.js";
import { getEndpoints, live } from "../settings.js";

/**
 * Spoken audio via Mordiem's OpenAI-compatible text-to-speech endpoint (POST /audio/speech →
 * the audio bytes; measured: tts-kokoro ~1 s for a sentence). As with images.ts, a request
 * answers at once with an id — show a player while it's made — and `done` resolves when the file
 * is on disk. Identical requests are de-duplicated, at most 2 run at a time, a persisted daily
 * budget stops runaway spend, and failures aren't cached so they can be retried.
 */
export type SpeechJobStatus = "pending" | "ready" | "error";

export interface SpeechJob {
  id: string;
  text: string;
  status: SpeechJobStatus;
  /** "/api/audio/<id>.mp3" once ready (the extension is whatever the model answered with). */
  url: string | null;
  error?: string;
  ms?: number;
}

export const AUDIO_DIR = path.join(DATA_DIR, "audio");
export const MAX_SPEECH_CHARS = 1500;
const FILE_RE = /^([A-Za-z0-9_-]{6,40})\.(mp3|wav|ogg|webm|flac|aac|m4a)$/;
const MAX_CONCURRENT = 2;
const DAILY_BUDGET = Number(process.env.SPEECH_DAILY_BUDGET) || 300;
const ATTEMPT_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;
/** The gateway's content type → the file's extension (mp3 is asked for; some models only make wav). */
const EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
};
const MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));

const jobs = new Map<string, SpeechJob>();
const byKey = new Map<string, { id: string; done: Promise<SpeechJob> }>();

// ── slots ─────────────────────────────────────────────────────────────────────
let active = 0;
const waiting: (() => void)[] = [];
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((go) => waiting.push(() => go()));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

// ── daily budget (persisted so restarts don't reset it) ───────────────────────
function takeBudget(): boolean {
  const key = `speech_budget:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(getSetting(key) ?? 0);
  if (used >= DAILY_BUDGET) return false;
  setSetting(key, String(used + 1));
  return true;
}

export function audioUrl(file: string): string {
  return `/api/audio/${file}`;
}

export function getSpeechJob(id: string): SpeechJob | undefined {
  return jobs.get(id);
}

/**
 * Queue spoken audio of `text` (cut at MAX_SPEECH_CHARS, at a sentence end when there is one).
 * Returns at once with the id; `done` resolves (never rejects) with the finished job — status
 * "ready" with a url, or "error".
 */
export function requestSpeech(text: string, opts: { voice?: string; model?: string } = {}): { id: string; done: Promise<SpeechJob> } {
  const { ttsModel, ttsVoice } = getEndpoints();
  const model = opts.model?.trim() || ttsModel;
  const voice = opts.voice?.trim() || ttsVoice;
  const spoken = clip(text.replace(/\s+/g, " ").trim());
  const key = crypto.createHash("sha1").update(`${model}\n${voice}\n${spoken}`).digest("hex");
  const cached = byKey.get(key);
  if (cached) return cached;

  const id = nanoid(16);
  const job: SpeechJob = { id, text: spoken, status: "pending", url: null };
  jobs.set(id, job);

  const done = (async (): Promise<SpeechJob> => {
    if (!spoken) return fail(job, key, "nothing to say");
    if (!live.mordiem) return fail(job, key, "speech needs a Mordiem key");
    if (!takeBudget()) return fail(job, key, `daily speech budget of ${DAILY_BUDGET} reached`);
    const started = Date.now();
    try {
      const { bytes, ext } = await generate(spoken, model, voice);
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      const file = `${id}.${ext}`;
      const dest = path.join(AUDIO_DIR, file);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      fs.renameSync(tmp, dest);
      job.status = "ready";
      job.url = audioUrl(file);
      job.ms = Date.now() - started;
      return job;
    } catch (err) {
      return fail(job, key, (err as Error).message);
    }
  })();

  const entry = { id, done };
  // A request that failed before its first await (no key, budget spent) is already settled — never cache it.
  if (job.status !== "error") {
    byKey.set(key, entry);
    if (byKey.size > 1000) byKey.delete(byKey.keys().next().value!);
  }
  return entry;
}

/** The first MAX_SPEECH_CHARS, ending at the last sentence end inside them when there is one past the middle. */
function clip(text: string): string {
  if (text.length <= MAX_SPEECH_CHARS) return text;
  const head = text.slice(0, MAX_SPEECH_CHARS);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return end > MAX_SPEECH_CHARS / 2 ? head.slice(0, end + 1) : `${head.replace(/\s+\S*$/, "")}…`;
}

function fail(job: SpeechJob, key: string, message: string): SpeechJob {
  job.status = "error";
  job.error = message;
  if (byKey.get(key)?.id === job.id) byKey.delete(key); // don't cache failures — the same line can be retried
  console.warn(`[speech] ${job.id} failed: ${message}`);
  return job;
}

type HttpError = Error & { status?: number; retryAfterMs?: number; body?: string };

async function attempt(text: string, model: string, voice: string, format: string): Promise<{ bytes: Buffer; ext: string }> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  const res = await fetch(`${mordiemUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
    body: JSON.stringify({ model, input: text, voice, response_format: format }),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const e = new Error(`Mordiem speech ${res.status}: ${body.slice(0, 200)}`) as HttpError;
    e.status = res.status;
    e.body = body;
    const ra = Number(res.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra * 1000;
    throw e;
  }
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 64) throw new Error("speech response was empty");
  // (An answer with no usable type is taken for what was asked for.)
  return { bytes, ext: EXT[mime] ?? (format === "wav" ? "wav" : "mp3") };
}

/** Up to 3 attempts; a model that can't make mp3 is asked for wav instead; the slot is released between attempts. */
async function generate(text: string, model: string, voice: string): Promise<{ bytes: Buffer; ext: string }> {
  let format = "mp3";
  let lastErr: HttpError | null = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await acquire();
    try {
      return await attempt(text, model, voice, format);
    } catch (err) {
      lastErr = err as HttpError;
    } finally {
      release();
    }
    const status = lastErr.status;
    if (status === 400 && format === "mp3" && /format/i.test(lastErr.body ?? "")) {
      format = "wav";
      continue;
    }
    const transient = status === undefined || status === 429 || status >= 500;
    if (!transient) break;
    await new Promise((r) => setTimeout(r, lastErr?.retryAfterMs ?? 1500 * 2 ** i));
  }
  throw lastErr ?? new Error("speech generation failed");
}

/** Serves generated audio at GET /audio/<id>.<ext> (mounted under /api). */
export function audioRouter(): Router {
  const r = express.Router();
  r.get("/audio/:file", (req, res) => {
    const m = FILE_RE.exec(String(req.params.file ?? ""));
    if (!m) return res.status(400).end();
    const p = path.join(AUDIO_DIR, m[0]);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader("Content-Type", MIME[m[2]!] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(p);
  });
  return r;
}
