import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { getEndpoints } from "../settings.js";
// (voice-samples imports this module too; neither uses the other at load time.)
import { deleteSample, listSamples, type SamplesOverview } from "./voice-samples.js";

/**
 * Voices for PersonaPlex: the built-in presets plus a local library of custom samples that are
 * synced to the GPU pod.
 *
 * A persona's `voice` is a built-in id ("NATF2" → the pod's precomputed "NATF2.pt") or a custom
 * sample ("custom:<slug>" → "<slug>.wav"). Samples live in data/voices/<slug>.wav, with metadata in
 * data/voices/index.json, and reach the pod through the routes pod/patch_voices.py adds to the moshi
 * server: on save, on demand (re-sync), and right before a call (ensureVoiceOnPod) — so a voice made
 * while the pod was down, or a pod that was rebuilt, still gets the right sample.
 *
 * PersonaPlex reads a .wav prompt with sphn, resamples it to 24 kHz and loudness-normalizes it with a
 * MONO-only normalizer (a stereo file breaks it), so every sample is stored as 16-bit mono PCM.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

export const MAX_SAMPLE_BYTES = 5 * 1024 * 1024;
export const MAX_SAMPLE_SEC = 12;
export const MIN_SAMPLE_SEC = 1;
const MAX_NAME_CHARS = 60;
const SLUG_MAX = 40;
/** Peak below this (≈ −60 dBFS) means the "sample" is silence. */
const SILENT_PEAK = 33;

const POD_TIMEOUT_MS = 20_000;
const LIST_TTL_MS = 30_000;
const LIST_FAIL_TTL_MS = 5_000;
/** ensureVoiceOnPod's whole budget — the call waits on it, and voice-call gives up at 25 s. */
const ENSURE_BUDGET_MS = 15_000;
/** How long GET /voices waits on the pod before answering with what it already knows. */
const OVERVIEW_BUDGET_MS = 3_500;

// ─── Built-in presets ────────────────────────────────────────────────────────

export interface BuiltinVoice {
  id: string;
  label: string;
}

const FAMILIES = [
  ["NATF", "Natural Female", 4],
  ["NATM", "Natural Male", 4],
  ["VARF", "Varied Female", 5],
  ["VARM", "Varied Male", 5],
] as const;

/** The presets every PersonaPlex pod ships (voices.tgz): NATF0–3, NATM0–3, VARF0–4, VARM0–4. */
export const BUILTIN_VOICES: readonly BuiltinVoice[] = FAMILIES.flatMap(([prefix, label, count]) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, label: `${label} ${i}` })),
);
const BUILTIN_IDS = new Set(BUILTIN_VOICES.map((v) => v.id));

export function isBuiltinVoice(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

// ─── Voice values ────────────────────────────────────────────────────────────

const CUSTOM_PREFIX = "custom:";
/** The pod's filename rule (patch_voices.py) without ".wav"; the slugs made here are a subset. */
const POD_STEM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WAV_FILE_RE = /^([a-z0-9][a-z0-9_-]{0,63})\.wav$/;
/** An explicit voice-prompt filename (legacy persona values such as "NATF2.pt"). No slashes. */
const POD_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,80})\.(pt|wav)$/i;

export type VoiceRef =
  | { kind: "builtin"; id: string }
  | { kind: "custom"; slug: string }
  | { kind: "file"; file: string }
  | { kind: "unknown"; value: string };

/** The persona `voice` value for a custom sample. */
export function customVoiceValue(slug: string): string {
  return `${CUSTOM_PREFIX}${slug}`;
}

/** Classify a persona `voice` value (pure). */
export function parseVoiceValue(value: string): VoiceRef {
  const v = String(value ?? "").trim();
  const upper = v.toUpperCase();
  if (BUILTIN_IDS.has(upper)) return { kind: "builtin", id: upper };
  if (v.startsWith(CUSTOM_PREFIX)) {
    const slug = v.slice(CUSTOM_PREFIX.length);
    return POD_STEM_RE.test(slug) ? { kind: "custom", slug } : { kind: "unknown", value: v };
  }
  const file = POD_FILE_RE.exec(v);
  if (file) {
    const stem = file[1]!.toUpperCase();
    if (file[2]!.toLowerCase() === "pt" && BUILTIN_IDS.has(stem)) return { kind: "builtin", id: stem };
    return { kind: "file", file: v };
  }
  return { kind: "unknown", value: v };
}

function builtinOr(value: string, dflt = "NATF2"): string {
  const id = String(value ?? "")
    .trim()
    .replace(/\.pt$/i, "")
    .toUpperCase();
  return BUILTIN_IDS.has(id) ? id : dflt;
}

/**
 * PersonaPlex `voice_prompt` filename for a persona voice value (pure): "NATF2" → "NATF2.pt",
 * "custom:ava" → "ava.wav", an explicit "x.pt"/"x.wav" as-is, anything else → `<fallback>.pt`.
 */
export function voicePromptFile(value: string, fallback = "NATF2"): string {
  const ref = parseVoiceValue(value);
  if (ref.kind === "builtin") return `${ref.id}.pt`;
  if (ref.kind === "custom") return `${ref.slug}.wav`;
  if (ref.kind === "file") return ref.file;
  return `${builtinOr(fallback)}.pt`;
}

function defaultBuiltin(): string {
  return builtinOr(getEndpoints().personaplexVoice);
}

// ─── Slugs ───────────────────────────────────────────────────────────────────

/** "Deep Narrator (v2)" → "deep-narrator-v2": lowercase a-z0-9 and dashes, at most 40 characters. */
export function slugify(name: string): string {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "voice";
}

/** `base`, or `base-2`, `base-3`, … — never a taken slug or a built-in id ("natf2"). */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const free = (s: string) => !taken.has(s) && !BUILTIN_IDS.has(s.toUpperCase());
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(slug)) return slug;
  }
}

// ─── WAV ─────────────────────────────────────────────────────────────────────

/** A user-facing problem with a sample or request; `status` is the HTTP status to answer with. */
export class VoiceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "VoiceError";
    this.status = status;
  }
}

export interface WavInfo {
  encoding: "pcm" | "float";
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  frames: number;
  durationSec: number;
  dataOffset: number;
  dataBytes: number;
}

/** KSDATAFORMAT_SUBTYPE_{PCM,IEEE_FLOAT} after the 2-byte format tag (WAVE_FORMAT_EXTENSIBLE). */
const SUBTYPE_GUID_TAIL = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Parse and validate a RIFF/WAVE header. Accepts uncompressed PCM (8/16/24/32-bit) or 32-bit float,
 * mono or stereo, 8–192 kHz, 1–12 s, ≤ 5 MB. Throws VoiceError with a message fit for the user.
 */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length > MAX_SAMPLE_BYTES) {
    throw new VoiceError(
      `That file is ${megabytes(buf.length)} — voice samples are limited to 5 MB (4–8 seconds of speech is plenty).`,
      413,
    );
  }
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") {
    throw new VoiceError("That isn't a WAV file — save the sample as an uncompressed 16-bit PCM .wav.", 415);
  }
  let fmt: { tag: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { offset: number; bytes: number } | null = null;
  for (let off = 12; off + 8 <= buf.length && !(fmt && data); ) {
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    const avail = buf.length - body;
    if (id === "fmt ") {
      if (size < 16 || avail < 16) throw new VoiceError("The WAV header is damaged (its format block is too short).");
      let tag = buf.readUInt16LE(body);
      if (tag === 0xfffe) {
        if (size < 40 || avail < 40) throw new VoiceError("The WAV header is damaged (its format block is too short).");
        tag = buf.subarray(body + 26, body + 40).equals(SUBTYPE_GUID_TAIL) ? buf.readUInt16LE(body + 24) : -1;
      }
      fmt = { tag, channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      // Streaming writers leave 0 or 0xFFFFFFFF here, and a cut-off file is shorter than declared.
      data = { offset: body, bytes: size === 0 || size > avail ? avail : size };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) throw new VoiceError("The WAV file has no format block — export it again as 16-bit PCM.");
  if (!data) throw new VoiceError("The WAV file has no audio in it.");

  const { tag, channels, sampleRate, bits } = fmt;
  const encoding = tag === 1 ? "pcm" : tag === 3 ? "float" : null;
  if (!encoding) throw new VoiceError("That WAV is compressed — save it as uncompressed 16-bit PCM.", 415);
  if (encoding === "pcm" ? ![8, 16, 24, 32].includes(bits) : bits !== 32) {
    throw new VoiceError(`${bits}-bit ${encoding === "float" ? "float " : ""}audio isn't supported — save the sample as 16-bit PCM.`, 415);
  }
  if (channels !== 1 && channels !== 2) {
    throw new VoiceError(`The sample has ${channels} channels — use a mono or stereo recording.`, 415);
  }
  if (sampleRate < 8000 || sampleRate > 192_000) {
    throw new VoiceError(`A ${sampleRate} Hz sample rate isn't supported — use 16–48 kHz.`, 415);
  }
  const frameBytes = channels * (bits / 8);
  const frames = Math.floor(data.bytes / frameBytes);
  const durationSec = frames / sampleRate;
  if (frames > MAX_SAMPLE_SEC * sampleRate) {
    throw new VoiceError(
      `That sample is ${durationSec.toFixed(1)} seconds — keep it to ${MAX_SAMPLE_SEC} seconds or less (4–8 seconds of clear speech works best).`,
    );
  }
  if (durationSec < MIN_SAMPLE_SEC) {
    throw new VoiceError(`That sample is only ${durationSec.toFixed(1)} seconds — record 4–8 seconds of natural speech.`);
  }
  return {
    encoding,
    channels,
    sampleRate,
    bitsPerSample: bits,
    frames,
    durationSec,
    dataOffset: data.offset,
    dataBytes: frames * frameBytes,
  };
}

/** Decode the samples to 16-bit mono (channels averaged). */
export function toMono16(buf: Buffer, w: WavInfo): Int16Array {
  const out = new Int16Array(w.frames);
  const step = w.bitsPerSample / 8;
  const stride = step * w.channels;
  if (w.encoding === "pcm" && w.bitsPerSample === 16 && w.channels === 1) {
    for (let i = 0; i < w.frames; i++) out[i] = buf.readInt16LE(w.dataOffset + i * 2);
    return out;
  }
  const read: (at: number) => number =
    w.encoding === "float"
      ? (at) => {
          const v = buf.readFloatLE(at);
          return Number.isFinite(v) ? v : 0;
        }
      : w.bitsPerSample === 8
        ? (at) => (buf.readUInt8(at) - 128) / 128
        : w.bitsPerSample === 16
          ? (at) => buf.readInt16LE(at) / 32768
          : w.bitsPerSample === 24
            ? (at) => buf.readIntLE(at, 3) / 8388608
            : (at) => buf.readInt32LE(at) / 2147483648;
  for (let i = 0; i < w.frames; i++) {
    const at = w.dataOffset + i * stride;
    let sum = 0;
    for (let c = 0; c < w.channels; c++) sum += read(at + c * step);
    out[i] = Math.max(-32768, Math.min(32767, Math.round((sum / w.channels) * 32768)));
  }
  return out;
}

/** A canonical 44-byte-header, 16-bit mono PCM WAV. */
export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2);
  return buf;
}

/** A zero-copy Uint8Array view (this toolchain's Node typings won't take a Buffer as a view). */
function bytesOf(b: Buffer): Uint8Array {
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(bytesOf(data)).digest("hex");
}

export interface PreparedSample {
  wav: Buffer;
  sampleRate: number;
  durationSec: number;
  sha256: string;
}

/** Validate a WAV and convert it to the stored form (16-bit mono PCM, original rate). */
export function prepareSample(input: Buffer): PreparedSample {
  const info = parseWav(input);
  const mono = toMono16(input, info);
  let peak = 0;
  for (const s of mono) {
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  if (peak < SILENT_PEAK) throw new VoiceError("That sample is silent — check the microphone and record again.");
  const wav = encodeWav(mono, info.sampleRate);
  return {
    wav,
    sampleRate: info.sampleRate,
    durationSec: Math.round((mono.length / info.sampleRate) * 100) / 100,
    sha256: sha256(wav),
  };
}

// ─── Library (data/voices) ───────────────────────────────────────────────────

export const VOICES_DIR = path.join(DATA_DIR, "voices");
/** Rendered voice samples (voice-samples.ts): a subfolder, since a stray .wav in VOICES_DIR itself is adopted as a custom voice. */
export const SAMPLES_DIR = path.join(VOICES_DIR, "samples");
const INDEX_FILE = path.join(VOICES_DIR, "index.json");

export interface VoiceRecord {
  slug: string;
  name: string;
  createdAt: number;
  durationSec: number;
  sampleRate: number;
  bytes: number;
  /** sha256 of data/voices/<slug>.wav. */
  sha256: string;
  /** The pod (HTTP base) that last confirmed holding this sample, and the hash it confirmed. */
  syncedTo: string | null;
  syncedHash: string | null;
  syncedAt: number | null;
  /** Why the last sync failed (cleared by the next success). */
  syncError: string | null;
}

/** What GET /voices lists for a custom voice. */
export interface CustomVoiceInfo {
  /** "custom:<slug>" — the value a persona stores in `voice`. */
  id: string;
  slug: string;
  name: string;
  durationSec: number;
  createdAt: number;
  /** true: the pod holds this exact sample; false: it doesn't (or the last upload failed); null: unknown. */
  synced: boolean | null;
  syncError: string | null;
}

function wavPath(slug: string): string {
  if (!POD_STEM_RE.test(slug)) throw new VoiceError("Bad voice id.", 400);
  return path.join(VOICES_DIR, `${slug}.wav`);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via a temp file + rename, retrying briefly when Windows has the target open. */
export function atomicWrite(dest: string, data: Buffer): void {
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, bytesOf(data));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

function normalizeRecord(raw: unknown): VoiceRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug : "";
  if (!POD_STEM_RE.test(slug)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    slug,
    name: (typeof r.name === "string" && r.name.trim()) || slug,
    createdAt: num(r.createdAt),
    durationSec: num(r.durationSec),
    sampleRate: num(r.sampleRate),
    bytes: num(r.bytes),
    sha256: str(r.sha256) ?? "",
    syncedTo: str(r.syncedTo),
    syncedHash: str(r.syncedHash),
    syncedAt: typeof r.syncedAt === "number" && Number.isFinite(r.syncedAt) ? r.syncedAt : null,
    syncError: str(r.syncError),
  };
}

function readIndex(): VoiceRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(INDEX_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[voices] can't read ${INDEX_FILE}: ${(err as Error).message}`);
    }
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Keep the damaged file for a human; the library is rebuilt from the samples on disk.
    const aside = `${INDEX_FILE}.damaged-${Date.now()}`;
    try {
      fs.renameSync(INDEX_FILE, aside);
      console.warn(`[voices] index.json was damaged — moved it to ${aside}; rebuilding from the samples`);
    } catch {
      /* leave it */
    }
    return [];
  }
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { voices?: unknown }).voices)
      ? (raw as { voices: unknown[] }).voices
      : [];
  const out: VoiceRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const rec = normalizeRecord(item);
    if (rec && !seen.has(rec.slug)) {
      seen.add(rec.slug);
      out.push(rec);
    }
  }
  return out;
}

function writeIndex(records: VoiceRecord[]): void {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  atomicWrite(INDEX_FILE, Buffer.from(`${JSON.stringify({ version: 1, voices: records }, null, 2)}\n`, "utf8"));
}

const unusableFiles = new Set<string>();

/** Bring a .wav found in data/voices without an index entry into the library. */
function adoptSample(slug: string): VoiceRecord | null {
  const file = wavPath(slug);
  let key = slug;
  try {
    const stat = fs.statSync(file);
    key = `${slug}:${stat.size}:${stat.mtimeMs}`;
    if (unusableFiles.has(key)) return null;
    const input = fs.readFileSync(file);
    const sample = prepareSample(input);
    if (!sample.wav.equals(input)) atomicWrite(file, sample.wav);
    console.log(`[voices] added data/voices/${slug}.wav to the voice library`);
    const pretty = slug.replace(/[-_]+/g, " ");
    return {
      slug,
      name: pretty.charAt(0).toUpperCase() + pretty.slice(1),
      createdAt: Math.round(stat.mtimeMs),
      durationSec: sample.durationSec,
      sampleRate: sample.sampleRate,
      bytes: sample.wav.length,
      sha256: sample.sha256,
      syncedTo: null,
      syncedHash: null,
      syncedAt: null,
      syncError: null,
    };
  } catch (err) {
    if (!unusableFiles.has(key)) {
      unusableFiles.add(key);
      console.warn(`[voices] ignoring data/voices/${slug}.wav: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Index records whose sample exists, adopting stray samples and filling in missing hashes. */
function loadLibrary(): VoiceRecord[] {
  const records = readIndex();
  const files = new Set(safeReaddir(VOICES_DIR));
  let changed = false;
  for (const f of files) {
    const m = WAV_FILE_RE.exec(f);
    if (!m || records.some((r) => r.slug === m[1])) continue;
    const rec = adoptSample(m[1]!);
    if (rec) {
      records.push(rec);
      changed = true;
    }
  }
  for (const r of records) {
    if (r.sha256 || !files.has(`${r.slug}.wav`)) continue;
    try {
      r.sha256 = sha256(fs.readFileSync(wavPath(r.slug)));
      changed = true;
    } catch {
      /* unreadable right now — try again next time */
    }
  }
  if (changed) {
    try {
      writeIndex(records);
    } catch (err) {
      console.warn(`[voices] couldn't update index.json: ${(err as Error).message}`);
    }
  }
  return records.filter((r) => files.has(`${r.slug}.wav`));
}

/** Change one record (re-read inside, so concurrent updates never lose each other), unless `when` says no. */
function updateRecord(slug: string, patch: Partial<Omit<VoiceRecord, "slug">>, when?: (rec: VoiceRecord) => boolean): void {
  try {
    const records = readIndex();
    const rec = records.find((r) => r.slug === slug);
    if (!rec || (when && !when(rec))) return;
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => rec[k] !== patch[k]);
    if (!changed) return;
    Object.assign(rec, patch);
    writeIndex(records);
  } catch (err) {
    console.warn(`[voices] couldn't record the sync state of ${slug}: ${(err as Error).message}`);
  }
}

/** Custom voices in the library, by name. */
export function listCustomVoices(): VoiceRecord[] {
  return loadLibrary().sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.createdAt - b.createdAt,
  );
}

export function getVoice(slug: string): VoiceRecord | null {
  if (!POD_STEM_RE.test(String(slug ?? ""))) return null;
  return loadLibrary().find((r) => r.slug === slug) ?? null;
}

/** Absolute path of a custom voice's sample (for previews), or null if there's no such voice. */
export function voiceFilePath(slug: string): string | null {
  return getVoice(slug) ? wavPath(slug) : null;
}

export function toCustomVoiceInfo(rec: VoiceRecord, synced: boolean | null): CustomVoiceInfo {
  return {
    id: customVoiceValue(rec.slug),
    slug: rec.slug,
    name: rec.name,
    durationSec: rec.durationSec,
    createdAt: rec.createdAt,
    synced,
    syncError: synced === true ? null : rec.syncError,
  };
}

/** The local view: built-ins plus custom voices with their last known sync state (no network). */
export function listVoices(): { builtin: BuiltinVoice[]; custom: CustomVoiceInfo[] } {
  const base = podHttpBase();
  return {
    builtin: [...BUILTIN_VOICES],
    custom: listCustomVoices().map((r) => toCustomVoiceInfo(r, knownSynced(r, base))),
  };
}

function cleanName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!s) throw new VoiceError("Give the voice a name.");
  const chars = Array.from(s);
  return chars.length > MAX_NAME_CHARS ? chars.slice(0, MAX_NAME_CHARS).join("").trim() : s;
}

/**
 * Validate a WAV sample and add it to the library as data/voices/<slug>.wav (16-bit mono).
 * Throws VoiceError for a bad name or sample. Doesn't touch the pod — call syncVoice after.
 */
export function addVoice(name: string, wav: Buffer): VoiceRecord {
  const display = cleanName(name);
  const sample = prepareSample(wav);
  const records = loadLibrary(); // (adopts strays first, so a rebuilt index keeps every voice)
  const taken = new Set(records.map((r) => r.slug));
  for (const f of safeReaddir(VOICES_DIR)) {
    const m = WAV_FILE_RE.exec(f);
    if (m) taken.add(m[1]!);
  }
  const slug = uniqueSlug(slugify(display), taken);
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  const dest = wavPath(slug);
  atomicWrite(dest, sample.wav);
  const rec: VoiceRecord = {
    slug,
    name: display,
    createdAt: Date.now(),
    durationSec: sample.durationSec,
    sampleRate: sample.sampleRate,
    bytes: sample.wav.length,
    sha256: sample.sha256,
    syncedTo: null,
    syncedHash: null,
    syncedAt: null,
    syncError: null,
  };
  try {
    writeIndex([...records, rec]);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  console.log(`[voices] saved “${display}” as ${slug}.wav (${sample.durationSec}s)`);
  return rec;
}

/**
 * Remove a custom voice from the library, with its rendered sample (the pod's copy stays; it's
 * harmless). The voice file goes first, so a failure can't leave a stray file that would be
 * re-adopted. False if there was none.
 */
export function deleteVoice(slug: string): boolean {
  if (!POD_STEM_RE.test(String(slug ?? ""))) return false;
  const file = wavPath(slug);
  const records = readIndex();
  const i = records.findIndex((r) => r.slug === slug);
  const existed = i >= 0 || fs.existsSync(file);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(file, { force: true });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EBUSY")) {
        sleepSync(40 * (attempt + 1));
        continue;
      }
      throw new VoiceError("The sample is in use right now — try deleting it again in a moment.", 409);
    }
  }
  if (i >= 0) {
    records.splice(i, 1);
    writeIndex(records);
  }
  deleteSample(customVoiceValue(slug));
  if (existed) console.log(`[voices] deleted ${slug}.wav`);
  return existed;
}

// ─── The pod ─────────────────────────────────────────────────────────────────

const NO_POD = "No PersonaPlex pod is configured — set its URL in Settings → Models.";
const NO_TOKEN =
  "Trinity needs the pod's admin token to upload voices — copy /root/pod/admin_token from the pod into Settings → Models → PersonaPlex admin token.";
const NOT_PATCHED =
  "The voice pod is running but can't take custom voices yet — run pod/setup.sh on the pod (it applies pod/patch_voices.py), then restart pod/serve.sh.";
const NOT_RUNNING =
  "The voice pod isn't answering — start it in Runpod, or check the PersonaPlex URL in Settings → Models.";

/** The PersonaPlex URL as HTTP: wss→https, ws→http, without a trailing "/api/chat". Null if unset/invalid. */
export function httpBaseFromWs(wsUrl: string): string | null {
  const raw = String(wsUrl ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const proto = ({ "wss:": "https:", "ws:": "http:", "https:": "https:", "http:": "http:" } as Record<string, string>)[
    u.protocol
  ];
  if (!proto || !u.host) return null;
  const prefix = u.pathname.replace(/\/+$/, "").replace(/\/api\/chat$/i, "").replace(/\/+$/, "");
  return `${proto}//${u.host}${prefix}`;
}

/** HTTP base of the configured PersonaPlex pod (see httpBaseFromWs), or null. */
export function podHttpBase(): string | null {
  return httpBaseFromWs(getEndpoints().personaplexWsUrl);
}

type PodReply =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null; network: boolean; error: string };

function errorDetail(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (j && typeof j.error === "string") return j.error.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function podErrorMessage(status: number, text: string, hadToken: boolean): string {
  const detail = errorDetail(text);
  if (status === 401) {
    return hadToken
      ? "The voice pod rejected Trinity's admin token — copy /root/pod/admin_token from the pod into Settings → Models → PersonaPlex admin token."
      : NO_TOKEN;
  }
  if (status === 403) {
    return "Voice uploads are switched off on the pod (it has no admin token) — run pod/setup.sh on the pod, then restart pod/serve.sh.";
  }
  if (status === 404 || status === 405) return NOT_PATCHED;
  if (status === 413) return "The voice pod refused the sample as too large.";
  if (status >= 502 && status <= 504) return "The voice pod isn't answering — it may still be starting up.";
  return `The voice pod answered HTTP ${status}${detail ? ` — ${detail}` : ""}.`;
}

async function podRequest(
  base: string,
  pathQuery: string,
  init: { method: "GET" | "POST"; token: string; body?: Uint8Array<ArrayBuffer>; timeoutMs: number },
): Promise<PodReply> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body) headers["Content-Type"] = "audio/wav";
  const timeoutMs = Math.max(1, init.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${base}${pathQuery}`, {
      method: init.method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      return { ok: false, status: null, network: true, error: `The voice pod didn't answer within ${Math.ceil(timeoutMs / 1000)} s.` };
    }
    const why = e.cause?.code ?? e.cause?.message ?? e.message;
    return { ok: false, status: null, network: true, error: `Couldn't reach the voice pod (${why}).` };
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* body cut off — the status is what matters */
  }
  if (!res.ok) return { ok: false, status: res.status, network: false, error: podErrorMessage(res.status, text, Boolean(init.token)) };
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: true, status: res.status, body };
}

interface PodFile {
  bytes: number | null;
  sha256: string | null;
}

type PodListing =
  | { ok: true; at: number; files: Map<string, PodFile> }
  | { ok: false; at: number; status: number | null; network: boolean; error: string };

function parseListing(body: unknown): Map<string, PodFile> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { voices?: unknown; files?: unknown };
  if (!Array.isArray(b.voices)) return null;
  const files = new Map<string, PodFile>();
  for (const v of b.voices) if (typeof v === "string") files.set(v, { bytes: null, sha256: null });
  if (b.files && typeof b.files === "object") {
    for (const [name, info] of Object.entries(b.files as Record<string, unknown>)) {
      const i = (info && typeof info === "object" ? info : {}) as { bytes?: unknown; sha256?: unknown };
      files.set(name, {
        bytes: typeof i.bytes === "number" ? i.bytes : null,
        sha256: typeof i.sha256 === "string" ? i.sha256.toLowerCase() : null,
      });
    }
  }
  return files;
}

function podKey(base: string, token: string): string {
  const t = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 16) : "-";
  return `${base}#${t}`;
}

let listCache: { key: string; listing: PodListing } | null = null;
const listInflight = new Map<string, Promise<PodListing>>();

/** The pod's voice files (cached 30 s; failures 5 s; concurrent users share one request). Never throws. */
async function podListing(opts: { fresh?: boolean; timeoutMs?: number } = {}): Promise<PodListing> {
  const base = podHttpBase();
  if (!base) return { ok: false, at: Date.now(), status: null, network: false, error: NO_POD };
  const token = getEndpoints().personaplexAdminToken;
  const key = podKey(base, token);
  if (!opts.fresh && listCache?.key === key) {
    const ttl = listCache.listing.ok ? LIST_TTL_MS : LIST_FAIL_TTL_MS;
    if (Date.now() - listCache.listing.at < ttl) return listCache.listing;
  }
  const running = listInflight.get(key);
  if (running) return running;
  const p = (async (): Promise<PodListing> => {
    let listing: PodListing;
    try {
      const r = await podRequest(base, "/api/voices", { method: "GET", token, timeoutMs: opts.timeoutMs ?? POD_TIMEOUT_MS });
      if (!r.ok) {
        listing = { ok: false, at: Date.now(), status: r.status, network: r.network, error: r.error };
      } else {
        const files = parseListing(r.body);
        listing = files
          ? { ok: true, at: Date.now(), files }
          : { ok: false, at: Date.now(), status: r.status, network: false, error: "The voice pod's answer wasn't a voice list — check the PersonaPlex URL." };
      }
    } catch (err) {
      listing = { ok: false, at: Date.now(), status: null, network: true, error: `Couldn't list the pod's voices (${(err as Error).message}).` };
    }
    listCache = { key, listing };
    return listing;
  })().finally(() => listInflight.delete(key));
  listInflight.set(key, p);
  return p;
}

/** Keep a fresh listing in step with an upload we just made. */
function rememberOnPod(base: string, token: string, file: string, info: PodFile): void {
  if (listCache?.key === podKey(base, token) && listCache.listing.ok) listCache.listing.files.set(file, info);
}

/** The pod's voice files (filenames), for tools and diagnostics. Never throws. */
export async function listPodVoices(
  opts: { fresh?: boolean } = {},
): Promise<{ ok: true; voices: string[] } | { ok: false; error: string; status: number | null }> {
  const l = await podListing(opts);
  return l.ok ? { ok: true, voices: [...l.files.keys()].sort() } : { ok: false, error: l.error, status: l.status };
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

export interface PodStatus {
  /** A PersonaPlex URL is set. */
  configured: boolean;
  /** The pod answered (null: not checked / unknown). */
  reachable: boolean | null;
  /** Uploads work end to end: patched pod, token on both sides (null: unknown). */
  uploads: boolean | null;
  /** Trinity has the admin token. */
  tokenSet: boolean;
  /** The pod's HTTP base (from the PersonaPlex URL). */
  base: string | null;
  /** What's wrong, in words, when something is. */
  error?: string;
  checkedAt: number | null;
}

let rootProbe: { base: string; at: number; up: boolean } | null = null;

/** Is the moshi web server itself answering at `base`? (Tells "not patched" from "not running".) */
async function podIsServing(base: string, fresh: boolean): Promise<boolean> {
  if (!fresh && rootProbe?.base === base && Date.now() - rootProbe.at < LIST_TTL_MS) return rootProbe.up;
  let up = false;
  try {
    const res = await fetch(`${base}/`, { method: "GET", signal: AbortSignal.timeout(8_000) });
    up = res.ok;
    await res.body?.cancel().catch(() => {});
  } catch {
    up = false;
  }
  rootProbe = { base, at: Date.now(), up };
  return up;
}

async function probePod(fresh: boolean): Promise<{ status: PodStatus; listing: PodListing | null }> {
  const base = podHttpBase();
  const tokenSet = Boolean(getEndpoints().personaplexAdminToken);
  if (!base) {
    return { status: { configured: false, reachable: null, uploads: null, tokenSet, base: null, error: NO_POD, checkedAt: null }, listing: null };
  }
  const listing = await podListing({ fresh });
  const s = { configured: true, tokenSet, base, checkedAt: listing.at };
  if (listing.ok) return { status: { ...s, reachable: true, uploads: true }, listing };
  if (listing.network) return { status: { ...s, reachable: false, uploads: null, error: listing.error }, listing };
  if (listing.status === 404) {
    const up = await podIsServing(base, fresh);
    return { status: { ...s, reachable: up, uploads: up ? false : null, error: up ? NOT_PATCHED : NOT_RUNNING }, listing };
  }
  if (listing.status !== null && listing.status >= 502 && listing.status <= 504) {
    return { status: { ...s, reachable: false, uploads: null, error: listing.error }, listing };
  }
  return { status: { ...s, reachable: true, uploads: false, error: listing.error }, listing };
}

/** Whether the pod is configured, reachable, and taking uploads — with the reason when not. Never throws. */
export async function podStatus(opts: { fresh?: boolean } = {}): Promise<PodStatus> {
  try {
    return (await probePod(Boolean(opts.fresh))).status;
  } catch (err) {
    return {
      configured: Boolean(podHttpBase()),
      reachable: null,
      uploads: null,
      tokenSet: Boolean(getEndpoints().personaplexAdminToken),
      base: podHttpBase(),
      error: `Couldn't check the voice pod (${(err as Error).message}).`,
      checkedAt: null,
    };
  }
}

/** Sync state from local records alone (no listing to go on). */
function knownSynced(rec: VoiceRecord, base: string | null): boolean | null {
  if (!base) return null;
  if (rec.syncedTo === base && rec.syncedHash === rec.sha256) return true;
  if (rec.syncError) return false;
  return null;
}

function podHasSample(listing: PodListing & { ok: true }, rec: VoiceRecord): { present: boolean; same: boolean } {
  const f = listing.files.get(`${rec.slug}.wav`);
  if (!f) return { present: false, same: false };
  return { present: true, same: f.sha256 === null || f.sha256 === rec.sha256 };
}

/**
 * The pod holds sample `hash` of this voice. Only recorded while that is still the voice's sample: the
 * user may have read the record before an await, and the voice may have been deleted and re-created
 * under the same slug since.
 */
function noteSynced(slug: string, base: string, hash: string): void {
  updateRecord(slug, { syncedTo: base, syncedHash: hash, syncedAt: Date.now(), syncError: null }, (r) => r.sha256 === hash);
}

export interface VoicesOverview {
  builtin: BuiltinVoice[];
  custom: CustomVoiceInfo[];
  pod: PodStatus;
  /** The rendered samples (what they say, who has the voice right now, which voices have one). */
  samples: SamplesOverview;
}

/**
 * Everything GET /voices shows. Waits at most ~3.5 s on the pod (the check keeps going in the
 * background and warms the cache); sync states come from the pod's listing when it answered.
 */
export async function voicesOverview(opts: { fresh?: boolean; budgetMs?: number } = {}): Promise<VoicesOverview> {
  const base = podHttpBase();
  const probe = base ? await raceTimeout(probePod(Boolean(opts.fresh)), opts.budgetMs ?? OVERVIEW_BUDGET_MS) : null;
  const records = listCustomVoices();
  const pod: PodStatus = base
    ? (probe?.status ?? {
        configured: true,
        reachable: null,
        uploads: null,
        tokenSet: Boolean(getEndpoints().personaplexAdminToken),
        base,
        error: "Still checking the voice pod — refresh in a moment.",
        checkedAt: null,
      })
    : {
        configured: false,
        reachable: null,
        uploads: null,
        tokenSet: Boolean(getEndpoints().personaplexAdminToken),
        base: null,
        error: NO_POD,
        checkedAt: null,
      };
  const listing = probe?.listing?.ok ? probe.listing : null;
  const custom = records.map((rec) => {
    if (!base || !listing) return toCustomVoiceInfo(rec, knownSynced(rec, base));
    const { present, same } = podHasSample(listing, rec);
    if (present && same) {
      if (rec.syncedTo !== base || rec.syncedHash !== rec.sha256 || rec.syncError) noteSynced(rec.slug, base, rec.sha256);
      return toCustomVoiceInfo({ ...rec, syncError: null }, true);
    }
    if (rec.syncedTo === base) updateRecord(rec.slug, { syncedTo: null, syncedHash: null }); // the pod lost it
    return toCustomVoiceInfo(rec, false);
  });
  return { builtin: [...BUILTIN_VOICES], custom, pod, samples: listSamples() };
}

export interface SyncResult {
  synced: boolean;
  /** True when this call uploaded the sample (false: it was already there). */
  uploaded?: boolean;
  error?: string;
}

function syncFailed(slug: string, error: string): SyncResult {
  updateRecord(slug, { syncError: error });
  return { synced: false, error };
}

/** In-flight uploads by pod + slug, with the hash of the record they were started for. */
const uploads = new Map<string, { hash: string; done: Promise<SyncResult> }>();

/** Whether data/voices/<slug>.wav is exactly `hash` right now (false if it's gone). */
function sampleIs(slug: string, hash: string): boolean {
  try {
    return sha256(fs.readFileSync(wavPath(slug))) === hash;
  } catch {
    return false;
  }
}

async function uploadSample(rec: VoiceRecord, base: string, token: string, timeoutMs: number): Promise<SyncResult> {
  const file = `${rec.slug}.wav`;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(wavPath(rec.slug));
  } catch {
    return syncFailed(rec.slug, "The sample file is missing from data/voices — delete this voice and create it again.");
  }
  const hash = sha256(bytes);
  const started = Date.now();
  const r = await podRequest(base, `/api/voices?name=${encodeURIComponent(file)}`, {
    method: "POST",
    token,
    body: new Uint8Array(bytes),
    timeoutMs,
  });
  // If the voice was deleted (and maybe re-created under this slug) meanwhile, this upload was of an
  // old sample: it says nothing about the record that's there now.
  const current = sampleIs(rec.slug, hash);
  if (!r.ok) {
    console.warn(`[voices] uploading ${file} failed: ${r.error}`);
    return current ? syncFailed(rec.slug, r.error) : { synced: false, error: r.error };
  }
  const echoed = (r.body as { sha256?: unknown } | null)?.sha256;
  if (typeof echoed === "string" && echoed.toLowerCase() !== hash) {
    const error = "The voice pod stored a damaged copy of the sample — sync it again.";
    return current ? syncFailed(rec.slug, error) : { synced: false, error };
  }
  rememberOnPod(base, token, file, { bytes: bytes.length, sha256: hash });
  if (!current) return { synced: false, error: "The sample changed while it was uploading — sync it again." };
  // sha256 too: the file on disk is what was sent (this also fixes a hash left stale by a sample replaced by hand).
  updateRecord(rec.slug, { sha256: hash, syncedTo: base, syncedHash: hash, syncedAt: Date.now(), syncError: null });
  console.log(`[voices] uploaded ${file} (${Math.round(bytes.length / 1024)} KB) to the voice pod in ${Date.now() - started} ms`);
  return { synced: true, uploaded: true };
}

/**
 * Make sure the pod has this exact sample: skip if its listing already shows it (unless `force`),
 * else upload. Concurrent syncs of one sample share a single upload. Never throws.
 */
export async function syncVoice(slug: string, opts: { force?: boolean; timeoutMs?: number } = {}): Promise<SyncResult> {
  try {
    const rec = getVoice(slug);
    if (!rec) return { synced: false, error: `There's no custom voice called “${slug}”.` };
    const base = podHttpBase();
    if (!base) return syncFailed(rec.slug, NO_POD);
    const token = getEndpoints().personaplexAdminToken;
    if (!token) return syncFailed(rec.slug, NO_TOKEN);
    const timeoutMs = Math.min(opts.timeoutMs ?? POD_TIMEOUT_MS, POD_TIMEOUT_MS);
    if (!opts.force) {
      const listing = await raceTimeout(podListing({ timeoutMs }), timeoutMs);
      if (listing?.ok) {
        const { present, same } = podHasSample(listing, rec);
        if (present && same) {
          noteSynced(rec.slug, base, rec.sha256);
          return { synced: true, uploaded: false };
        }
      }
    }
    // One upload per voice file at a time. A running upload of this same sample is shared; one of an
    // older sample (the voice was deleted and re-created under this slug) finishes first, so the pod
    // ends up with this one.
    const key = `${base}\n${rec.slug}`;
    const deadline = Date.now() + timeoutMs;
    for (let running = uploads.get(key); running; running = uploads.get(key)) {
      if (running.hash === rec.sha256) return await running.done;
      await running.done;
    }
    const done = uploadSample(rec, base, token, Math.max(1_000, deadline - Date.now())).finally(() => uploads.delete(key));
    uploads.set(key, { hash: rec.sha256, done });
    return await done;
  } catch (err) {
    return { synced: false, error: `Sync failed: ${(err as Error).message}` };
  }
}

// ─── Before a call ───────────────────────────────────────────────────────────

export interface VoicePrep {
  /** The PersonaPlex `voice_prompt` filename to connect with. */
  file: string;
  source: "builtin" | "custom" | "file" | "fallback";
  /** The pod was seen holding this exact sample, or it was just uploaded. */
  verified?: boolean;
  uploaded?: boolean;
  /** Why the default voice is used instead, or why the sample couldn't be checked. */
  note?: string;
}

/**
 * Resolve a persona voice for a call. Built-ins map straight to "<ID>.pt". A custom voice is
 * checked against the pod (listing cached 30 s) and uploaded when missing or different; if that
 * can't be done and the pod was never confirmed to hold it, the default built-in voice is used
 * instead — a missing voice file would make PersonaPlex refuse the whole session. Bounded by
 * `budgetMs` (default 15 s). Never throws.
 */
export async function prepareVoice(value: string, opts: { budgetMs?: number } = {}): Promise<VoicePrep> {
  const deadline = Date.now() + (opts.budgetMs ?? ENSURE_BUDGET_MS);
  const left = () => Math.max(0, deadline - Date.now());
  const fallback = (why: string): VoicePrep => ({ file: `${defaultBuiltin()}.pt`, source: "fallback", note: why });
  try {
    let ref = parseVoiceValue(value);
    if (ref.kind === "file") {
      const m = WAV_FILE_RE.exec(ref.file); // "ava.wav" names a library voice the same as "custom:ava"
      if (m && getVoice(m[1]!)) ref = { kind: "custom", slug: m[1]! };
    }
    if (ref.kind === "builtin") return { file: `${ref.id}.pt`, source: "builtin" };
    if (ref.kind === "file") return { file: ref.file, source: "file" };
    if (ref.kind === "unknown") return fallback(`Unknown voice “${ref.value}”.`);

    const rec = getVoice(ref.slug);
    if (!rec) return fallback(`The custom voice “${ref.slug}” isn't in the voice library.`);
    const file = `${rec.slug}.wav`;
    const base = podHttpBase();
    if (!base) return { file, source: "custom", verified: false, note: NO_POD };
    const token = getEndpoints().personaplexAdminToken;
    const confirmedBefore = rec.syncedTo === base && rec.syncedHash === rec.sha256;

    const listing = await raceTimeout(podListing({ timeoutMs: left() }), left());
    if (listing?.ok) {
      const { present, same } = podHasSample(listing, rec);
      if (present && same) {
        if (!confirmedBefore) noteSynced(rec.slug, base, rec.sha256);
        return { file, source: "custom", verified: true };
      }
      const up = token && left() > 500 ? await syncVoice(rec.slug, { force: true, timeoutMs: left() }) : { synced: false, error: token ? "out of time" : NO_TOKEN };
      if (up.synced) return { file, source: "custom", verified: true, uploaded: true };
      if (present) return { file, source: "custom", verified: false, note: `Couldn't refresh the sample on the pod (${up.error}); using the copy already there.` };
      return fallback(`“${rec.name}” isn't on the voice pod and couldn't be uploaded: ${up.error}`);
    }

    // No listing: trust an earlier confirmed upload of this exact sample to this pod.
    if (confirmedBefore) return { file, source: "custom", verified: false, note: listing?.error ?? "The voice pod didn't answer in time." };
    // A transient failure might not stop an upload; a refusal (401/403/404/405) would.
    const transient = !listing || listing.network || listing.status === null || listing.status >= 500;
    if (token && transient && left() > 1000) {
      const up = await syncVoice(rec.slug, { force: true, timeoutMs: left() });
      if (up.synced) return { file, source: "custom", verified: true, uploaded: true };
      return fallback(`“${rec.name}” couldn't be uploaded to the voice pod: ${up.error}`);
    }
    return fallback(`“${rec.name}” couldn't be checked on the voice pod: ${listing?.error ?? (token ? "it didn't answer in time" : NO_TOKEN)}`);
  } catch (err) {
    return fallback(`Voice check failed: ${(err as Error).message}`);
  }
}

/**
 * The PersonaPlex `voice_prompt` filename for a persona voice, making sure a custom sample is on the
 * pod first (see prepareVoice). Plugs into voice-call's setVoiceResolver. Never throws.
 */
export async function ensureVoiceOnPod(value: string): Promise<string> {
  const prep = await prepareVoice(value);
  if (prep.source === "fallback") console.warn(`[voices] ${prep.note} Using ${prep.file} for this call.`);
  else if (prep.note) console.warn(`[voices] ${prep.file}: ${prep.note}`);
  return prep.file;
}
