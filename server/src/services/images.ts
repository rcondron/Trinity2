import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { DATA_DIR } from "../config.js";
import { getSetting, setSetting } from "../db/sqlite.js";
import { getEndpoints, live } from "../settings.js";

/**
 * Image generation via Mordiem's OpenAI-compatible endpoint
 * (POST /images/generations → data[0].b64_json). Measured: krea-2-turbo ~4.7s,
 * flux-2-pro ~15s. Generation is always asynchronous — callers get an id at once
 * (show a placeholder), and `done` resolves when the PNG is on disk.
 *
 * Guards: identical successful prompts are de-duplicated; at most 3 run concurrently,
 * highest priority first (scene/title art before portraits before item icons); a
 * persisted daily budget stops runaway spend; failures are not cached so they can be
 * retried.
 */
/** Game art by its place on the game screen, and a picture the caller asked for (make_image). */
export type ImageKind = "portrait" | "icon" | "scene" | "title" | "picture";
export type ImageJobStatus = "pending" | "ready" | "error";

export interface ImageJob {
  id: string;
  kind: ImageKind;
  prompt: string;
  status: ImageJobStatus;
  url: string | null;
  error?: string;
  ms?: number;
}

export const IMAGES_DIR = path.join(DATA_DIR, "images");
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_CONCURRENT = 3;
const DAILY_BUDGET = Number(process.env.IMAGE_DAILY_BUDGET) || 300;
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

const KIND_HINTS: Record<ImageKind, string> = {
  portrait:
    "character portrait, head and shoulders, centered, expressive face, detailed painterly digital art, dramatic rim lighting, no text",
  icon: "a single game item icon, the object centered on a plain dark background, crisp detail, painterly game art, no text, no border",
  scene: "wide cinematic environment concept art, atmospheric lighting, depth, painterly, no text, no people in the foreground",
  title: "epic key art for a tabletop adventure, cinematic composition, painterly, no text, no letters, no logo",
  // (The caller's own words lead; this only keeps the output clean.)
  picture: "high quality, detailed, well composed, no text, no watermark",
};

/**
 * Requested sizes, from the gateway's accepted set (auto, 256/512/1024 square, 1536x1024,
 * 1024x1536, 1792x1024, 1024x1792 — anything else is a 400 and a wasted request). Some models
 * return 1024x1024 whatever is asked (krea-2-turbo, measured); a 400 still falls back to square.
 */
const KIND_SIZE: Record<ImageKind, string> = {
  portrait: "1024x1024",
  icon: "512x512",
  scene: "1792x1024",
  title: "1792x1024",
  picture: "1024x1024",
};

/** Higher runs first: a picture the caller is waiting for, then what players look at most. */
const KIND_PRIORITY: Record<ImageKind, number> = { picture: 5, scene: 4, title: 3, portrait: 2, icon: 1 };

const jobs = new Map<string, ImageJob>();
const byPrompt = new Map<string, { id: string; done: Promise<ImageJob> }>();

// ── priority slots ────────────────────────────────────────────────────────────
let active = 0;
const waiting: { priority: number; seq: number; go: () => void }[] = [];
let seq = 0;
function acquire(priority: number): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((go) => {
    waiting.push({ priority, seq: seq++, go: () => go() });
    waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  });
}
function release(): void {
  const next = waiting.shift();
  if (next) next.go();
  else active--;
}

// ── daily budget (persisted so restarts don't reset it) ───────────────────────
function budgetKey(): string {
  return `image_budget:${new Date().toISOString().slice(0, 10)}`;
}
function takeBudget(): boolean {
  const key = budgetKey();
  const used = Number(getSetting(key) ?? 0);
  if (used >= DAILY_BUDGET) return false;
  setSetting(key, String(used + 1));
  return true;
}

export function imageUrl(id: string): string {
  return `/api/images/${id}.png`;
}

export function imagePath(id: string): string {
  if (!ID_RE.test(id)) throw new Error("bad image id");
  return path.join(IMAGES_DIR, `${id}.png`);
}

/** True once the image file is on disk (used to sweep stale "pending" slots after a restart). */
export function imageExists(id: string | null | undefined): boolean {
  if (!id || !ID_RE.test(id)) return false;
  return fs.existsSync(path.join(IMAGES_DIR, `${id}.png`));
}

export function getImageJob(id: string): ImageJob | undefined {
  return jobs.get(id);
}

/**
 * Queue an image. Returns immediately with the id; `done` resolves (never rejects)
 * with the finished job — status "ready" with a url, or "error".
 * `style` (e.g. the game's art style) is prefixed so a campaign's art stays consistent.
 */
export function requestImage(
  prompt: string,
  kind: ImageKind,
  opts: { style?: string } = {},
): { id: string; done: Promise<ImageJob> } {
  const full = [opts.style?.trim(), prompt.trim().slice(0, 600), KIND_HINTS[kind]].filter(Boolean).join(". ");
  const key = crypto.createHash("sha1").update(`${kind}\n${full}`).digest("hex");
  const cached = byPrompt.get(key);
  if (cached) return cached;

  const id = nanoid(16);
  const job: ImageJob = { id, kind, prompt: full, status: "pending", url: null };
  jobs.set(id, job);

  const done = (async (): Promise<ImageJob> => {
    if (!live.mordiem) return fail(job, key, "image generation needs a Mordiem key");
    if (!takeBudget()) return fail(job, key, `daily image budget of ${DAILY_BUDGET} reached`);
    const started = Date.now();
    try {
      const png = await generate(full, KIND_SIZE[kind], KIND_PRIORITY[kind]);
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      const dest = imagePath(id);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, new Uint8Array(png.buffer, png.byteOffset, png.byteLength));
      fs.renameSync(tmp, dest);
      job.status = "ready";
      job.url = imageUrl(id);
      job.ms = Date.now() - started;
      return job;
    } catch (err) {
      return fail(job, key, (err as Error).message);
    }
  })();

  const entry = { id, done };
  // A request that failed before its first await (no key, budget spent) is already settled — never cache it.
  if (job.status !== "error") {
    byPrompt.set(key, entry);
    if (byPrompt.size > 1000) byPrompt.delete(byPrompt.keys().next().value!);
  }
  return entry;
}

function fail(job: ImageJob, key: string, message: string): ImageJob {
  job.status = "error";
  job.error = message;
  if (byPrompt.get(key)?.id === job.id) byPrompt.delete(key); // don't cache failures — the same image can be retried
  console.warn(`[images] ${job.kind} ${job.id} failed: ${message}`);
  return job;
}

type HttpError = Error & { status?: number; retryAfterMs?: number };

async function attempt(prompt: string, size: string): Promise<Buffer<ArrayBuffer>> {
  const { mordiemUrl, mordiemKey, imageModel } = getEndpoints();
  const res = await fetch(`${mordiemUrl}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
    body: JSON.stringify({ model: imageModel, prompt, n: 1, size, response_format: "b64_json" }),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const e = new Error(`Mordiem image ${res.status}: ${(await res.text()).slice(0, 200)}`) as HttpError;
    e.status = res.status;
    const ra = Number(res.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra * 1000;
    throw e;
  }
  const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const first = data.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) {
    const img = await fetch(first.url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    if (!img.ok) throw new Error(`image download ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error("image response had no data");
}

/** Up to 3 attempts; the slot is released between attempts so a slow retry never blocks the queue. */
async function generate(prompt: string, size: string, priority: number): Promise<Buffer<ArrayBuffer>> {
  let sz = size;
  let lastErr: HttpError | null = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await acquire(priority);
    try {
      return await attempt(prompt, sz);
    } catch (err) {
      lastErr = err as HttpError;
    } finally {
      release();
    }
    const status = lastErr.status;
    if (status === 400 && sz !== "1024x1024") {
      sz = "1024x1024"; // unsupported size → retry square right away
      continue;
    }
    const transient = status === undefined || status === 429 || status >= 500;
    if (!transient) break;
    await new Promise((r) => setTimeout(r, lastErr?.retryAfterMs ?? 1500 * 2 ** i));
  }
  throw lastErr ?? new Error("image generation failed");
}

/** Serves generated images at GET /images/<id>.png (mounted under /api). */
export function imagesRouter(): Router {
  const r = express.Router();
  r.get("/images/:file", (req, res) => {
    const m = /^([A-Za-z0-9_-]{6,40})\.png$/.exec(String(req.params.file ?? ""));
    if (!m) return res.status(400).end();
    const p = path.join(IMAGES_DIR, `${m[1]}.png`);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(p);
  });
  return r;
}
