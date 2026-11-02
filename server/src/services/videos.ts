import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { DATA_DIR } from "../config.js";
import { getSetting, setSetting } from "../db/sqlite.js";
import { getEndpoints, live } from "../settings.js";

/**
 * Video generation via Mordiem's Venice pass-through
 * (POST /video/queue → poll POST /video/retrieve → MP4 bytes or download_url).
 * Same async job pattern as images.ts / speech.ts: users get an id at once,
 * and `done` resolves when the MP4 is on disk under data/videos/.
 */

export type VideoJobStatus = "pending" | "ready" | "error";

export interface VideoJob {
  id: string;
  prompt: string;
  model: string;
  status: VideoJobStatus;
  url: string | null;
  error?: string;
  ms?: number;
}

export const VIDEOS_DIR = path.join(DATA_DIR, "videos");
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_CONCURRENT = 1;
const DAILY_BUDGET = Number(process.env.VIDEO_DAILY_BUDGET) || 40;
const CREATE_TIMEOUT_MS = 45_000;
const POLL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const POLL_EVERY_MS = 5_000;
const MAX_WAIT_MS = 8 * 60_000;

const jobs = new Map<string, VideoJob>();
const byKey = new Map<string, { id: string; done: Promise<VideoJob> }>();

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

function takeBudget(): boolean {
  const key = `video_budget:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(getSetting(key) ?? 0);
  if (used >= DAILY_BUDGET) return false;
  setSetting(key, String(used + 1));
  return true;
}

export function videoUrl(id: string): string {
  return `/api/videos/${id}.mp4`;
}

export function getVideoJob(id: string): VideoJob | undefined {
  return jobs.get(id);
}

/** Veo-family durations on Mordiem/Venice. Wan/Seedance often use 5s/10s instead. */
const VEO_DURATIONS = [4, 6, 8] as const;
const WAN_DURATIONS = [5, 10] as const;

/** Pick the nearest allowed duration string for this model (e.g. `"4s"`, `"6s"`). */
function durationOf(seconds: number, model: string): string {
  const n = Math.max(1, Math.min(30, Math.round(seconds)));
  const allowed: readonly number[] = /wan-|seedance|happyhorse/i.test(model) ? WAN_DURATIONS : VEO_DURATIONS;
  let best = allowed[0] ?? 4;
  for (const a of allowed) if (Math.abs(a - n) < Math.abs(best - n)) best = a;
  return `${best}s`;
}

/** Parse `Expected '4s' | '6s' | '8s'` (or similar) out of a 400 body. */
function durationsFromError(text: string): string[] {
  const m = /Expected\s+((?:'?\d+s'?\s*\|\s*)+'?\d+s'?)/i.exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/(\d+)s/gi)].map((x) => `${x[1]}s`);
}

/**
 * Queue a text-to-video render. Returns at once with the id; `done` resolves
 * (never rejects) with status "ready" + url, or "error".
 */
export function requestVideo(
  prompt: string,
  opts: { model?: string; seconds?: number } = {},
): { id: string; done: Promise<VideoJob> } {
  const { videoModel } = getEndpoints();
  const model = opts.model?.trim() || videoModel;
  const spoken = prompt.replace(/\s+/g, " ").trim().slice(0, 800);
  const seconds = opts.seconds && opts.seconds > 0 ? Math.min(30, Math.round(opts.seconds)) : 4;
  const duration = durationOf(seconds, model);
  const key = crypto.createHash("sha1").update(`${model}\n${duration}\n${spoken}`).digest("hex");
  const cached = byKey.get(key);
  if (cached) return cached;

  const id = nanoid(16);
  const job: VideoJob = { id, prompt: spoken, model, status: "pending", url: null };
  jobs.set(id, job);

  const done = (async (): Promise<VideoJob> => {
    if (!spoken) return fail(job, key, "nothing to show");
    if (!live.mordiem) return fail(job, key, "video needs a Mordiem key");
    if (!model) return fail(job, key, "no video model configured — set one in Settings → Models");
    if (!takeBudget()) return fail(job, key, `daily video budget of ${DAILY_BUDGET} reached`);
    const started = Date.now();
    try {
      const bytes = await generate(spoken, model, duration);
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
      const dest = path.join(VIDEOS_DIR, `${id}.mp4`);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      fs.renameSync(tmp, dest);
      job.status = "ready";
      job.url = videoUrl(id);
      job.ms = Date.now() - started;
      return job;
    } catch (err) {
      return fail(job, key, (err as Error).message);
    }
  })();

  const entry = { id, done };
  if (job.status !== "error") {
    byKey.set(key, entry);
    if (byKey.size > 200) byKey.delete(byKey.keys().next().value!);
  }
  return entry;
}

function fail(job: VideoJob, key: string, message: string): VideoJob {
  job.status = "error";
  job.error = message;
  if (byKey.get(key)?.id === job.id) byKey.delete(key);
  console.warn(`[videos] ${job.id} failed: ${message}`);
  return job;
}

type HttpError = Error & { status?: number; body?: string };

interface QueueResponse {
  model?: string;
  queue_id?: string;
  download_url?: string;
  error?: string | { message?: string };
}

interface RetrieveStatus {
  status?: string;
  average_execution_time?: number;
  execution_duration?: number;
  error?: string | { message?: string };
  download_url?: string;
}

function errText(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === "string") return err.trim() || fallback;
  if (typeof err === "object" && err && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return fallback;
}

async function postQueue(payload: Record<string, unknown>): Promise<{ ok: true; data: QueueResponse } | { ok: false; status: number; text: string }> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  const res = await fetch(`${mordiemUrl}/video/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status, text: (await res.text()).slice(0, 400) };
  return { ok: true, data: (await res.json()) as QueueResponse };
}

async function queueJob(prompt: string, model: string, duration: string): Promise<QueueResponse> {
  // Venice: aspect_ratio and duration enums are model-dependent — retry without / with allowed values.
  let dur = duration;
  const tryOnce = (d: string, withAspect: boolean) =>
    postQueue(withAspect ? { model, prompt, duration: d, resolution: "720p", aspect_ratio: "16:9" } : { model, prompt, duration: d, resolution: "720p" });

  let hit = await tryOnce(dur, true);
  if (!hit.ok && hit.status === 400 && /aspect[_\s-]?ratio/i.test(hit.text)) {
    hit = await tryOnce(dur, false);
  }
  if (!hit.ok && hit.status === 400 && /duration/i.test(hit.text)) {
    const allowed = durationsFromError(hit.text);
    const pick =
      allowed.find((d) => d === dur) ??
      allowed.sort((a, b) => Math.abs(parseInt(a, 10) - parseInt(dur, 10)) - Math.abs(parseInt(b, 10) - parseInt(dur, 10)))[0];
    if (pick && pick !== dur) {
      dur = pick;
      hit = await tryOnce(dur, true);
      if (!hit.ok && hit.status === 400 && /aspect[_\s-]?ratio/i.test(hit.text)) {
        hit = await tryOnce(dur, false);
      }
    }
  }
  if (!hit.ok) {
    const e = new Error(`Mordiem video ${hit.status}: ${hit.text.slice(0, 200)}`) as HttpError;
    e.status = hit.status;
    e.body = hit.text;
    throw e;
  }
  return hit.data;
}

async function retrieveJob(
  model: string,
  queueId: string,
): Promise<{ kind: "mp4"; bytes: Buffer } | { kind: "json"; data: RetrieveStatus }> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  const res = await fetch(`${mordiemUrl}/video/retrieve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
    body: JSON.stringify({ model, queue_id: queueId, delete_media_on_completion: true }),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const e = new Error(`Mordiem video poll ${res.status}: ${text.slice(0, 200)}`) as HttpError;
    e.status = res.status;
    e.body = text;
    throw e;
  }
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("video/mp4") || ctype.includes("application/octet-stream")) {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 256) throw new Error("video response was empty");
    return { kind: "mp4", bytes };
  }
  return { kind: "json", data: (await res.json()) as RetrieveStatus };
}

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`video download ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 256) throw new Error("video download was empty");
  return bytes;
}

async function completeJob(model: string, queueId: string): Promise<void> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  try {
    await fetch(`${mordiemUrl}/video/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
      body: JSON.stringify({ model, queue_id: queueId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* best-effort cleanup */
  }
}

async function generate(prompt: string, model: string, duration: string): Promise<Buffer> {
  await acquire();
  try {
    const queued = await queueJob(prompt, model, duration);
    const queueId = queued.queue_id?.trim();
    const queuedModel = (queued.model?.trim() || model).trim();
    if (!queueId) throw new Error(errText(queued.error, "video queue returned no job id"));
    const downloadUrlHint = typeof queued.download_url === "string" ? queued.download_url : null;

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const hit = await retrieveJob(queuedModel, queueId);
      if (hit.kind === "mp4") {
        void completeJob(queuedModel, queueId);
        return hit.bytes;
      }
      const status = (hit.data.status ?? "").toUpperCase();
      if (status === "COMPLETED" || status === "COMPLETE" || status === "SUCCEEDED" || status === "SUCCESS") {
        const url =
          (typeof hit.data.download_url === "string" && hit.data.download_url) || downloadUrlHint;
        if (!url) throw new Error("video completed but no download url was returned");
        const bytes = await downloadUrl(url);
        void completeJob(queuedModel, queueId);
        return bytes;
      }
      if (status === "FAILED" || status === "ERROR" || status === "CANCELLED" || status === "CANCELED") {
        throw new Error(errText(hit.data.error, "video generation failed"));
      }
      // PROCESSING / QUEUED / unknown — wait and poll again.
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    }
    throw new Error("video generation timed out");
  } finally {
    release();
  }
}

/** Serves generated videos at GET /videos/<id>.mp4 (mounted under /api). */
export function videosRouter(): Router {
  const r = express.Router();
  r.get("/videos/:file", (req, res) => {
    const m = /^([A-Za-z0-9_-]{6,40})\.mp4$/.exec(String(req.params.file ?? ""));
    if (!m || !ID_RE.test(m[1]!)) return res.status(400).end();
    const p = path.join(VIDEOS_DIR, `${m[1]}.mp4`);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(p);
  });
  return r;
}
