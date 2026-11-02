import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { getEndpoints } from "../settings.js";
import { SILENCE_FRAME, frame, lendVoice, returnVoice, voiceUse, type VoiceLoan, type VoiceUse } from "./voice-call.js";
import { SAMPLES_DIR, VoiceError, atomicWrite, customVoiceValue, encodeWav, getVoice, parseVoiceValue, prepareVoice } from "./voices.js";

/**
 * Voice samples for Settings → Voices — what each voice sounds like. A built-in preset is only an
 * embedding on the pod, with nothing to play, so PersonaPlex itself says a fixed line in the voice
 * (0x03 forced words, held quiet otherwise — the protocol a call speaks, see voice-call.ts) and what
 * it streams back is kept as data/voices/samples/<stem>.wav, listed in index.json beside it.
 *
 * The pod has ONE session. A sample borrows it (lendVoice): from nobody, or from a warm standby,
 * whose tab is told and comes back once the voice is free — never from a live call. A call that
 * starts mid-render takes the voice back at once, and the sample fails with 409.
 *
 * (In an import cycle with voices.ts, whose deleteVoice removes a voice's sample: nothing from it or
 * from voice-call.ts is used at load time.)
 */

/** What every sample says. Changing it makes every sample on disk stale (see textHash). */
export const SAMPLE_TEXT = "Hi there! This is how I sound. I can look things up, set reminders, and build you something while we talk.";
/** The pod's text_prompt: short, so the handshake is quick (each token costs a model step — see voicePromptText). */
export const SAMPLE_PROMPT = "You are a friendly, natural voice assistant.";

const SAMPLE_RATE = 24_000;
const FRAME_MS = 80; // one model step; the pod steps only when an input frame arrives
const HELLO_TIMEOUT_MS = 60_000;
const RENDER_CAP_MS = 20_000; // after hello: whatever was collected by then is the sample
const ECHO_SETTLED_MS = 700; // no word echoed for this long, the line covered, the tail quiet → it's said
const ECHO_GIVEUP_MS = 1_500; // no word echoed for this long at all → done with what there is
const QUIET_TAIL_MS = 400;
const LINE_COVERAGE = 0.9; // share of the line's letters the pod must have echoed (0x02) back
/** RMS of 16-bit samples below this (≈ −45 dBFS) counts as quiet. */
const QUIET_RMS = 184;
const TRIM_WINDOW_MS = 20;
const LEAD_IN_MS = 120; // silence kept before the first sound…
const TAIL_MS = 250; // …and after the last
const MIN_SECONDS = 0.5;
const TEXT_HASH = crypto.createHash("sha256").update(SAMPLE_TEXT).digest("hex").slice(0, 16);
const SAMPLE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}\.wav$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const samples = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);
const letters = (s: string) => s.replace(/[^a-z]/gi, "").length;

class BusyError extends Error {}

export interface SampleInfo {
  /** The voice value: "NATF2" or "custom:<slug>". */
  voice: string;
  durationSec: number;
  createdAt: number;
  /** The sample on disk was handed back; nothing was rendered. */
  cached: boolean;
}

/** The `samples` part of GET /voices. */
export interface SamplesOverview {
  /** What every sample says. */
  text: string;
  /** Who has the pod's session right now; a sample can only be made while it's "nobody" or "standby". */
  use: VoiceUse;
  items: Record<string, { durationSec: number; createdAt: number }>;
}

interface SampleRef {
  /** The index key: "NATF2" or "custom:<slug>". */
  key: string;
  /** The file stem: the pod's for a built-in ("NATF2"), "custom-<slug>" for a custom voice. */
  stem: string;
  slug?: string;
}

interface IndexItem {
  file: string;
  durationSec: number;
  createdAt: number;
}

/** A voice value's sample key and file stem; null unless it's a built-in or a custom voice. */
function sampleRef(voice: string): SampleRef | null {
  const ref = parseVoiceValue(voice);
  if (ref.kind === "builtin") return { key: ref.id, stem: ref.id };
  if (ref.kind === "custom") return { key: customVoiceValue(ref.slug), stem: `custom-${ref.slug}`, slug: ref.slug };
  return null;
}

// ─── The index (data/voices/samples/index.json) ──────────────────────────────

const indexFile = () => path.join(SAMPLES_DIR, "index.json");

/** Best effort: Windows may still have the file open (a tab is playing it); the next render replaces it anyway. */
function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.warn(`[voice-samples] couldn't remove ${file}: ${(err as Error).message}`);
  }
}

function writeItems(items: Record<string, IndexItem>): void {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  atomicWrite(indexFile(), Buffer.from(`${JSON.stringify({ version: 1, textHash: TEXT_HASH, items }, null, 2)}\n`, "utf8"));
}

/** The samples on disk that say the current line. */
function readItems(): Record<string, IndexItem> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[voice-samples] can't read ${indexFile()}: ${(err as Error).message}`);
    return {};
  }
  const idx = (raw && typeof raw === "object" ? raw : {}) as { textHash?: unknown; items?: unknown };
  const items: Record<string, IndexItem> = {};
  for (const [voice, v] of Object.entries((idx.items && typeof idx.items === "object" ? idx.items : {}) as Record<string, unknown>)) {
    const it = (v && typeof v === "object" ? v : {}) as Partial<IndexItem>;
    if (typeof it.file !== "string" || !SAMPLE_FILE_RE.test(it.file) || typeof it.durationSec !== "number" || typeof it.createdAt !== "number") continue;
    items[voice] = { file: it.file, durationSec: it.durationSec, createdAt: it.createdAt };
  }
  if (idx.textHash !== TEXT_HASH) {
    // The line changed (a code change): every sample says the old one. Drop them; they're remade on demand.
    for (const it of Object.values(items)) removeFile(path.join(SAMPLES_DIR, it.file));
    if (Object.keys(items).length) writeItems({});
    return {};
  }
  for (const [voice, it] of Object.entries(items)) if (!fs.existsSync(path.join(SAMPLES_DIR, it.file))) delete items[voice];
  return items;
}

export function listSamples(): SamplesOverview {
  const items: SamplesOverview["items"] = {};
  for (const [voice, it] of Object.entries(readItems())) items[voice] = { durationSec: it.durationSec, createdAt: it.createdAt };
  return { text: SAMPLE_TEXT, use: voiceUse(), items };
}

/** Absolute path of a voice's sample, or null when there's none (or it says an old line). */
export function sampleFilePath(voice: string): string | null {
  const ref = sampleRef(voice);
  const it = ref ? readItems()[ref.key] : undefined;
  return it ? path.join(SAMPLES_DIR, it.file) : null;
}

/** Remove a voice's sample (deleteVoice does this for a custom voice). Never throws. */
export function deleteSample(voice: string): void {
  const ref = sampleRef(voice);
  if (!ref) return;
  try {
    const items = readItems();
    removeFile(path.join(SAMPLES_DIR, `${ref.stem}.wav`));
    if (ref.key in items) {
      delete items[ref.key];
      writeItems(items);
    }
  } catch (err) {
    console.warn(`[voice-samples] couldn't update the sample index: ${(err as Error).message}`);
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Renders run one at a time (one session), each handing the loan on to the next; a second request for a voice joins its render. */
let chain: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<SampleInfo>>();

/**
 * The sample for a voice ("NATF2", "custom:<slug>"): the one on disk, unless `force` or there is
 * none — then the pod renders it (≈ 10 s; up to ~75 s with a slow handshake). Throws VoiceError:
 * 404 no such voice, 409 the voice is in use or a call took it, 502 the pod didn't deliver, 503 no pod.
 */
export async function renderVoiceSample(voice: string, opts: { force?: boolean } = {}): Promise<SampleInfo> {
  const ref = sampleRef(voice);
  if (!ref) throw new VoiceError(`There's no voice called “${voice}”.`, 404);
  if (ref.slug && !getVoice(ref.slug)) {
    deleteSample(ref.key); // a sample left behind by a voice that's gone
    throw new VoiceError(`There's no voice called “${ref.key}”.`, 404);
  }
  if (!opts.force) {
    const have = readItems()[ref.key];
    if (have) return { voice: ref.key, durationSec: have.durationSec, createdAt: have.createdAt, cached: true };
  }
  const running = inflight.get(ref.key);
  if (running) return running;
  const run = chain.then(() => render(ref));
  const settled = run.then(
    () => {},
    () => {},
  );
  chain = settled;
  inflight.set(ref.key, run);
  void settled.then(() => inflight.delete(ref.key));
  return run;
}

function busyMessage(use: VoiceUse): string {
  if (use === "call") return "Trinity is in a call right now — samples are made when the voice is free.";
  if (use === "warming") return "The voice is still warming up — try again in a few seconds.";
  return "The voice was needed for a call — try again in a moment.";
}

const takenForCall = () => new VoiceError("The voice was needed for a call — try again in a moment.", 409);

async function render(ref: SampleRef): Promise<SampleInfo> {
  if (ref.slug && !getVoice(ref.slug)) throw new VoiceError(`There's no voice called “${ref.key}”.`, 404);
  const prep = await prepareVoice(ref.key); // a custom sample is checked/uploaded on the pod first (≤ 15 s)
  if (prep.source === "fallback") throw new VoiceError(prep.note ?? `The voice “${ref.key}” isn't on the voice pod.`, 502);
  if (prep.note) console.warn(`[voice-samples] ${prep.file}: ${prep.note}`);
  const wsUrl = getEndpoints().personaplexWsUrl;
  if (!wsUrl) throw new VoiceError("No streaming PersonaPlex configured — set its URL in Settings.", 503);
  const loan = await lendVoice("a voice sample");
  if (!loan) throw new VoiceError(busyMessage(voiceUse()), 409);
  const started = Date.now();
  try {
    const params = new URLSearchParams({ voice_prompt: prep.file, text_prompt: SAMPLE_PROMPT, pcm: "1", no_wait: "1" });
    const pcm = trimSilence(toSamples(await captureWithRetry(`${wsUrl}/api/chat?${params}`, loan)));
    if (!pcm || pcm.length < samples(MIN_SECONDS * 1000)) throw new VoiceError("The voice didn't produce a sample — try again.", 502);
    // (A custom voice deleted while its sample was made: nothing to keep it for.)
    if (ref.slug && !getVoice(ref.slug)) throw new VoiceError(`There's no voice called “${ref.key}”.`, 404);
    const info = saveSample(ref, pcm);
    console.log(`[voice-samples] rendered ${ref.key} (${info.durationSec}s) in ${Date.now() - started} ms`);
    return info;
  } finally {
    returnVoice(loan);
  }
}

function saveSample(ref: SampleRef, pcm: Int16Array): SampleInfo {
  const items = readItems(); // first: a stale index drops the old files, which would include the one written next
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const file = `${ref.stem}.wav`;
  atomicWrite(path.join(SAMPLES_DIR, file), encodeWav(pcm, SAMPLE_RATE));
  const item: IndexItem = { file, durationSec: Math.round((pcm.length / SAMPLE_RATE) * 100) / 100, createdAt: Date.now() };
  writeItems({ ...items, [ref.key]: item });
  return { voice: ref.key, durationSec: item.durationSec, createdAt: item.createdAt, cached: false };
}

/** Connect with ?no_wait=1; while the pod is still releasing the previous session (the standby just let go) it answers "busy" — retry. */
async function captureWithRetry(url: string, loan: VoiceLoan): Promise<Buffer[]> {
  const delays = [500, 1000, 2000, 4000];
  for (let i = 0; ; i++) {
    if (loan.aborted !== null) throw takenForCall();
    try {
      return await capture(url, loan);
    } catch (err) {
      if (!(err instanceof BusyError)) throw err;
      if (i >= delays.length) throw new VoiceError("The voice model is busy with another session (another tab or device?) — try again in a moment.", 409);
      await sleep(delays[i]!);
    }
  }
}

/**
 * One take: connect, have the pod say the line, collect its audio, close. The line is done when the
 * pod has echoed (0x02) ≥ 90 % of its letters, nothing more for 700 ms and the last 400 ms are quiet
 * (the sound runs a little behind the words); or 1.5 s after the last echo; or 20 s after hello. The
 * pod closing after hello ends the take with what it said — unless that's short of the line, which is
 * a failure, not a sample. An abort of the loan (a call started) cuts it off at once. The socket is
 * closed on every path.
 */
function capture(url: string, loan: VoiceLoan): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 0, perMessageDeflate: false });
    const frames: Buffer[] = [];
    let spoken = "";
    let lastEchoAt = 0;
    let hello = false;
    let settled = false;
    let pump: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout>;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(pump);
      ws.terminate();
      if (err) reject(err);
      else resolve(frames);
    };
    const covered = () => letters(spoken) >= LINE_COVERAGE * letters(SAMPLE_TEXT);
    deadline = setTimeout(() => finish(new VoiceError("The voice model didn't answer within 60 s.", 504)), HELLO_TIMEOUT_MS);
    loan.onAbort(() => finish(takenForCall()));
    // The model steps only when audio arrives: feed it silence, and see whether the line is done.
    const tick = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(SILENCE_FRAME);
      if (!lastEchoAt) return;
      const quietFor = Date.now() - lastEchoAt;
      if (quietFor >= ECHO_GIVEUP_MS || (quietFor >= ECHO_SETTLED_MS && covered() && quietTail(frames))) finish();
    };
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const buf = data as Buffer;
      if (!hello) {
        hello = true;
        if (!isBinary || buf[0] !== 0x00) return finish(new VoiceError("The voice model refused the session.", 502));
        clearTimeout(deadline);
        deadline = setTimeout(() => finish(), RENDER_CAP_MS);
        ws.send(frame(4, [1])); // hold: nothing but the line
        ws.send(frame(3, Buffer.from(SAMPLE_TEXT, "utf8")));
        pump = setInterval(tick, FRAME_MS);
        return;
      }
      if (!isBinary || buf.length < 2) return;
      if (buf[0] === 1) frames.push(buf.subarray(1));
      else if (buf[0] === 2) {
        spoken += buf.toString("utf8", 1);
        lastEchoAt = Date.now();
      }
    });
    ws.on("error", (err: Error) => {
      if (!hello) finish(new VoiceError(`Couldn't reach the voice model (${err.message}).`, 502));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (hello) return finish(covered() ? undefined : new VoiceError("The voice stopped before the line was said — try again.", 502));
      const why = reason.toString() || `code ${code}`;
      finish(code === 1013 ? new BusyError(why) : new VoiceError(`The voice model closed the connection (${why}).`, 502));
    });
  });
}

// ─── Audio ───────────────────────────────────────────────────────────────────

function toSamples(frames: Buffer[]): Int16Array {
  const out = new Int16Array(Math.floor(frames.reduce((n, f) => n + f.length, 0) / 2));
  let i = 0;
  for (const f of frames) for (let at = 0; at + 1 < f.length && i < out.length; at += 2) out[i++] = f.readInt16LE(at);
  return out;
}

function rms(pcm: Int16Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Whether the last QUIET_TAIL_MS of the collected audio is quiet (false until there's that much). */
function quietTail(frames: Buffer[]): boolean {
  let need = samples(QUIET_TAIL_MS);
  let sum = 0;
  for (let f = frames.length - 1; f >= 0 && need > 0; f--) {
    const buf = frames[f]!;
    for (let at = buf.length - 2; at >= 0 && need > 0; at -= 2, need--) {
      const v = buf.readInt16LE(at);
      sum += v * v;
    }
  }
  return need === 0 && Math.sqrt(sum / samples(QUIET_TAIL_MS)) < QUIET_RMS;
}

/** The speech with a little room around it, or null when there's no sound at all. */
function trimSilence(pcm: Int16Array): Int16Array | null {
  const win = samples(TRIM_WINDOW_MS);
  let first = -1;
  let last = -1;
  for (let at = 0; at + win <= pcm.length; at += win) {
    if (rms(pcm, at, at + win) < QUIET_RMS) continue;
    if (first < 0) first = at;
    last = at + win;
  }
  if (first < 0) return null;
  return pcm.subarray(Math.max(0, first - samples(LEAD_IN_MS)), Math.min(pcm.length, last + samples(TAIL_MS)));
}
