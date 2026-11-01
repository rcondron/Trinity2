import path from "node:path";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { listPersonas } from "../db/sqlite.js";
import { renderVoiceSample, sampleFilePath } from "./voice-samples.js";
import {
  MAX_SAMPLE_BYTES,
  VoiceError,
  addVoice,
  customVoiceValue,
  deleteVoice,
  getVoice,
  parseVoiceValue,
  syncVoice,
  toCustomVoiceInfo,
  voiceFilePath,
  voicesOverview,
} from "./voices.js";

/**
 * The Voices API (mounted under /api):
 *   GET    /voices                → {builtin: [{id, label}], custom: [{id, slug, name, durationSec, createdAt,
 *                                    synced, syncError, usedBy}], pod: {configured, reachable, uploads, tokenSet, base, error?},
 *                                    samples: {text, use, items: {[voice]: {durationSec, createdAt}}}}
 *                                    (?fresh=1 re-checks the pod instead of using the 30 s cache)
 *   POST   /voices                → {voice, synced, syncError?}   body: {name, wavBase64}
 *                                    (or a raw audio/wav body with ?name=…)
 *   DELETE /voices/:slug          → {ok, usedBy: [persona names that used it]}
 *   POST   /voices/:slug/sync     → {synced, error?}               (re-uploads to the pod)
 *   GET    /voices/:slug/audio    → audio/wav                      (preview)
 *   POST   /voices/:voice/sample  → {voice, durationSec, createdAt, cached}   (the pod renders one unless there is one;
 *                                    ?force=1 re-renders; ≈ 10 s, up to ~75 s; 409 while the voice is in a call)
 *   GET    /voices/:voice/sample.wav → audio/wav                   (404 when there's none yet)
 * `:voice` is a built-in id ("NATF2") or "custom:<slug>" (URL-encoded).
 * Errors are {error: "<what to do about it>"} with a 4xx/5xx status.
 */

const MAX_BASE64_CHARS = Math.ceil(MAX_SAMPLE_BYTES / 3) * 4;
const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

type Handler = (req: Request, res: Response) => unknown;

/** Express 4 doesn't catch async errors: route every failure to a JSON answer. */
function handle(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => {
        if (res.headersSent) return next(err);
        if (err instanceof VoiceError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        console.error("[voices] request failed:", err);
        res.status(500).json({ error: `The voice library hit an error: ${(err as Error)?.message ?? String(err)}` });
      });
  };
}

function decodeWavBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new VoiceError("Send the sample as JSON {name, wavBase64} — a base64-encoded WAV file.");
  }
  let s = value.trim();
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma < 0) throw new VoiceError("wavBase64 is a data: URL without any data.");
    s = s.slice(comma + 1);
  }
  s = s.replace(/\s+/g, "");
  if (s.length > MAX_BASE64_CHARS + 4) {
    throw new VoiceError("That sample is over 5 MB — 4–8 seconds of speech is plenty.", 413);
  }
  if (!BASE64_RE.test(s)) throw new VoiceError("wavBase64 isn't valid base64.");
  return Buffer.from(s, "base64");
}

function readUpload(req: Request): { name: string; wav: Buffer } {
  if (Buffer.isBuffer(req.body)) {
    const name = typeof req.query.name === "string" ? req.query.name : "";
    return { name, wav: req.body };
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as { name?: unknown; wavBase64?: unknown };
  return { name: typeof body.name === "string" ? body.name : "", wav: decodeWavBase64(body.wavBase64) };
}

/** Names of the personas whose voice is `value` (empty if the persona store can't be read). */
function usedBy(value: string): string[] {
  try {
    return listPersonas()
      .filter((p) => p.voice === value)
      .map((p) => p.name);
  } catch {
    return [];
  }
}

function slugParam(req: Request): string {
  return String(req.params.slug ?? "");
}

function noSuchVoice(slug: string): VoiceError {
  return new VoiceError(`There's no custom voice called “${slug}”.`, 404);
}

/** The `:voice` of a sample route — a built-in id or "custom:<slug>"; anything else is no voice. */
function voiceParam(req: Request): string {
  const raw = String(req.params.voice ?? "");
  const ref = parseVoiceValue(raw);
  if (ref.kind === "builtin") return ref.id;
  if (ref.kind === "custom") return customVoiceValue(ref.slug);
  throw new VoiceError(`There's no voice called “${raw}”.`, 404);
}

export function voicesRouter(): Router {
  const r = express.Router();
  // The API router already parses JSON (12 MB); these keep this router working on its own too
  // (body-parser skips a body that's already been parsed).
  const json = express.json({ limit: "12mb" });
  const raw = express.raw({ type: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"], limit: "6mb" });

  r.get(
    "/voices",
    handle(async (req, res) => {
      const fresh = req.query.fresh === "1" || req.query.fresh === "true";
      const overview = await voicesOverview({ fresh });
      res.json({ ...overview, custom: overview.custom.map((v) => ({ ...v, usedBy: usedBy(v.id) })) });
    }),
  );

  r.post(
    "/voices",
    json,
    raw,
    handle(async (req, res) => {
      const { name, wav } = readUpload(req);
      const rec = addVoice(name, wav);
      const sync = await syncVoice(rec.slug, { force: true });
      const fresh = getVoice(rec.slug) ?? rec;
      res.json({
        voice: { ...toCustomVoiceInfo(fresh, sync.synced), usedBy: [] as string[] },
        synced: sync.synced,
        ...(sync.synced ? {} : { syncError: sync.error ?? "The sample couldn't be uploaded to the voice pod." }),
      });
    }),
  );

  r.delete(
    "/voices/:slug",
    handle((req, res) => {
      const slug = slugParam(req);
      if (!deleteVoice(slug)) throw noSuchVoice(slug);
      res.json({ ok: true, usedBy: usedBy(customVoiceValue(slug)) });
    }),
  );

  r.post(
    "/voices/:slug/sync",
    handle(async (req, res) => {
      const slug = slugParam(req);
      if (!getVoice(slug)) throw noSuchVoice(slug);
      const result = await syncVoice(slug, { force: true });
      res.json(result.synced ? { synced: true } : { synced: false, error: result.error ?? "Sync failed." });
    }),
  );

  r.get(
    "/voices/:slug/audio",
    handle((req, res) => {
      const slug = slugParam(req);
      const file = voiceFilePath(slug);
      if (!file) throw noSuchVoice(slug);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-cache");
      // `root` keeps send's dot-file check to the file name (DATA_DIR may sit under a dot folder).
      res.sendFile(path.basename(file), { root: path.dirname(file) }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "The sample file is missing." });
      });
    }),
  );

  // Rendering takes ≈ 10 s (up to ~75 s): Node puts no time limit on a response, and neither does the Vite proxy.
  r.post(
    "/voices/:voice/sample",
    handle(async (req, res) => {
      const force = req.query.force === "1" || req.query.force === "true";
      res.json(await renderVoiceSample(voiceParam(req), { force }));
    }),
  );

  r.get(
    "/voices/:voice/sample.wav",
    handle((req, res) => {
      const file = sampleFilePath(voiceParam(req));
      if (!file) throw new VoiceError("There's no sample for this voice yet.", 404);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.basename(file), { root: path.dirname(file) }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "The sample file is missing." });
      });
    }),
  );

  // Body-parser failures inside this router (too large, bad JSON) as JSON, not an HTML page.
  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = (err ?? {}) as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    const error =
      e.type === "entity.too.large"
        ? "That upload is too large — voice samples are limited to 5 MB."
        : e.type === "entity.parse.failed"
          ? "The request body isn't valid JSON."
          : (e.message ?? "The request failed.");
    res.status(status >= 400 && status < 600 ? status : 500).json({ error });
  });

  return r;
}
