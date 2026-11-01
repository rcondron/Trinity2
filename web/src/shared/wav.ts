// Pure PCM + WAV helpers (no DOM, no Web Audio) — shared by the settings page's
// voice builder and anything else that needs to package speech as a WAV.
//
// The voice-sample pipeline (see prepareVoiceSample) is what turns a raw
// recording or upload into a clean PersonaPlex voice prompt:
//   mono 24 kHz input → trim leading/trailing silence (RMS threshold, clicks
//   ignored) → keep the best ≤ 8 s (keep the start, end on a natural pause) →
//   short fades → peak-normalize to about -1 dBFS → 16-bit PCM WAV.

/** Float32 audio backed by a plain ArrayBuffer (what the Web Audio APIs accept). */
export type F32 = Float32Array<ArrayBuffer>;

// ─── Basic signal helpers ────────────────────────────────────────────────────

/** Average any number of channels into one (lengths are clipped to the shortest). */
export function downmix(channels: readonly Float32Array[]): F32 {
  if (channels.length === 0) return new Float32Array(0);
  let len = Infinity;
  for (const c of channels) len = Math.min(len, c.length);
  const out = new Float32Array(len);
  if (channels.length === 1) {
    out.set(channels[0]!.subarray(0, len));
    return out;
  }
  const scale = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < len; i++) out[i] = out[i]! + ch[i]! * scale;
  }
  return out;
}

/** RMS of each consecutive frame of `frame` samples (the last frame may be short). */
export function frameRms(samples: Float32Array, frame: number): F32 {
  const size = Math.max(1, Math.floor(frame));
  const n = Math.ceil(samples.length / size);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const start = f * size;
    const end = Math.min(samples.length, start + size);
    let acc = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i]!;
      acc += v * v;
    }
    out[f] = Math.sqrt(acc / Math.max(1, end - start));
  }
  return out;
}

/** RMS over samples[start, end) — clamped to the array bounds. */
export function rangeRms(samples: Float32Array, start: number, end: number): number {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(samples.length, Math.floor(end));
  if (e <= s) return 0;
  let acc = 0;
  for (let i = s; i < e; i++) {
    const v = samples[i]!;
    acc += v * v;
  }
  return Math.sqrt(acc / (e - s));
}

/** Absolute peak (0..1+). */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}

export function toDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/** Linear fade-in / fade-out in place (milliseconds). */
export function applyFades(samples: Float32Array, sampleRate: number, inMs: number, outMs: number): void {
  const fin = Math.min(samples.length, Math.round((sampleRate * inMs) / 1000));
  const fout = Math.min(samples.length, Math.round((sampleRate * outMs) / 1000));
  for (let i = 0; i < fin; i++) samples[i] = samples[i]! * (i / fin);
  for (let i = 0; i < fout; i++) {
    const idx = samples.length - 1 - i;
    samples[idx] = samples[idx]! * (i / fout);
  }
}

// ─── Speech detection ────────────────────────────────────────────────────────

/** Below this frame RMS (about -54 dBFS) we treat the whole sample as silence. */
export const SILENCE_RMS = 0.002;

export interface SpeechBounds {
  /** First sample to keep (includes the lead-in pad). */
  start: number;
  /** One past the last sample to keep (includes the tail pad). */
  end: number;
  /** RMS threshold that separated speech from background. */
  threshold: number;
  maxRms: number;
}

export interface SpeechBoundsOptions {
  frameMs?: number;
  /** Speech must stay above the threshold this long; shorter blips (mouse clicks) are ignored. */
  minRunMs?: number;
  padStartMs?: number;
  padEndMs?: number;
}

/**
 * Find where speech starts and ends. The threshold adapts to the recording:
 * at least 5% of the loudest frame (-26 dB), raised toward twice the noise floor
 * (10th-percentile frame) but never above 10% of the loudest frame, so soft
 * syllables in continuous speech survive. Returns null when nothing but
 * silence or isolated clicks is present.
 */
export function findSpeechBounds(
  samples: Float32Array,
  sampleRate: number,
  opts: SpeechBoundsOptions = {},
): SpeechBounds | null {
  const frameMs = opts.frameMs ?? 20;
  const minRunMs = opts.minRunMs ?? 60;
  const padStartMs = opts.padStartMs ?? 150;
  const padEndMs = opts.padEndMs ?? 250;

  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const rms = frameRms(samples, frame);
  if (rms.length === 0) return null;

  let maxRms = 0;
  for (let i = 0; i < rms.length; i++) maxRms = Math.max(maxRms, rms[i]!);
  if (maxRms < SILENCE_RMS) return null;

  const sorted = Float32Array.from(rms).sort();
  const noise = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? 0;
  const threshold = Math.max(SILENCE_RMS, maxRms * 0.05, Math.min(noise * 2, maxRms * 0.1));
  const run = Math.max(1, Math.round(minRunMs / frameMs));

  let first = -1;
  for (let f = 0, streak = 0; f < rms.length; f++) {
    streak = rms[f]! >= threshold ? streak + 1 : 0;
    if (streak >= run) {
      first = f - run + 1;
      break;
    }
  }
  let last = -1;
  for (let f = rms.length - 1, streak = 0; f >= 0; f--) {
    streak = rms[f]! >= threshold ? streak + 1 : 0;
    if (streak >= run) {
      last = f + run - 1;
      break;
    }
  }
  if (first < 0 || last < first) return null;

  const start = Math.max(0, first * frame - Math.round((sampleRate * padStartMs) / 1000));
  const end = Math.min(samples.length, (last + 1) * frame + Math.round((sampleRate * padEndMs) / 1000));
  return { start, end, threshold, maxRms };
}

/**
 * Where to end a sample that is longer than `maxSec`: keep the start and cut at
 * the quietest moment (a pause between words) in the last `searchSec` before the
 * limit, so the clip doesn't end mid-word. Returns an end index ≤ start + maxSec.
 */
export function chooseCut(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
  maxSec: number,
  searchSec = 2.5,
): number {
  const maxLen = Math.round(maxSec * sampleRate);
  if (end - start <= maxLen) return end;
  const hardEnd = start + maxLen;
  const searchFrom = Math.max(start + Math.round(sampleRate * 0.5), hardEnd - Math.round(searchSec * sampleRate));
  const win = Math.max(1, Math.round(sampleRate * 0.06)); // 60 ms analysis window
  const step = Math.max(1, Math.round(sampleRate * 0.01)); // 10 ms hop

  let bestPos = hardEnd;
  let bestVal = Infinity;
  // Walk backwards from the limit: a later cut only loses to a clearly quieter one.
  for (let center = hardEnd - Math.ceil(win / 2); center >= searchFrom; center -= step) {
    const v = rangeRms(samples, center - win / 2, center + win / 2);
    if (v < bestVal * 0.9) {
      bestVal = v;
      bestPos = center;
    }
  }
  return Math.min(hardEnd, Math.max(start + 1, bestPos));
}

// ─── The voice-sample pipeline ───────────────────────────────────────────────

export interface SampleInfo {
  /** Length of the audio handed in (after resampling). */
  inputSec: number;
  /** Silence removed from the start / end. */
  leadTrimSec: number;
  tailTrimSec: number;
  /** True when the speech ran past maxSec and was cut at a pause. */
  truncated: boolean;
  /** Speech dropped by that cut (0 when not truncated). */
  cutSec: number;
  /** Length of the finished sample. */
  finalSec: number;
  /** Peak level before normalization (dBFS). */
  peakDb: number;
  /** Gain applied by normalization (dB; negative = attenuated). */
  gainDb: number;
  /** No speech was found — samples is empty. */
  silent: boolean;
}

export interface PreparedSample {
  samples: F32;
  sampleRate: number;
  info: SampleInfo;
}

export interface PrepareOptions {
  /** Longest sample to keep (seconds). Default 8. */
  maxSec?: number;
  /** Peak level after normalization (dBFS). Default -1. */
  targetPeakDb?: number;
  /** Never boost more than this (dB), so a near-silent take isn't blown up into noise. Default 30. */
  maxGainDb?: number;
}

/** Trim, cut to the best ≤ maxSec, fade, and peak-normalize a mono sample. */
export function prepareVoiceSample(input: Float32Array, sampleRate: number, opts: PrepareOptions = {}): PreparedSample {
  const maxSec = opts.maxSec ?? 8;
  const targetPeakDb = opts.targetPeakDb ?? -1;
  const maxGainDb = opts.maxGainDb ?? 30;
  const inputSec = input.length / sampleRate;

  const bounds = findSpeechBounds(input, sampleRate);
  if (!bounds) {
    return {
      samples: new Float32Array(0),
      sampleRate,
      info: {
        inputSec,
        leadTrimSec: 0,
        tailTrimSec: 0,
        truncated: false,
        cutSec: 0,
        finalSec: 0,
        peakDb: toDb(peakOf(input)),
        gainDb: 0,
        silent: true,
      },
    };
  }

  const cut = chooseCut(input, sampleRate, bounds.start, bounds.end, maxSec);
  const truncated = cut < bounds.end;
  const out = input.slice(bounds.start, cut);
  applyFades(out, sampleRate, 8, truncated ? 60 : 20);

  const peak = peakOf(out);
  const peakDb = toDb(peak);
  const gainDb = peak > 0 ? Math.min(maxGainDb, targetPeakDb - peakDb) : 0;
  const gain = Math.pow(10, gainDb / 20);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]! * gain));

  return {
    samples: out,
    sampleRate,
    info: {
      inputSec,
      leadTrimSec: bounds.start / sampleRate,
      tailTrimSec: (input.length - bounds.end) / sampleRate,
      truncated,
      cutSec: (bounds.end - cut) / sampleRate,
      finalSec: out.length / sampleRate,
      peakDb,
      gainDb,
      silent: false,
    },
  };
}

// ─── Waveform peaks ──────────────────────────────────────────────────────────

/** min/max pairs for `buckets` equal slices of the signal: [min0, max0, min1, max1, …]. */
export function computePeaks(samples: Float32Array, buckets: number): F32 {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(n * 2);
  if (samples.length === 0) return out;
  const per = samples.length / n;
  for (let b = 0; b < n; b++) {
    const s = Math.floor(b * per);
    const e = Math.max(s + 1, Math.min(samples.length, Math.floor((b + 1) * per)));
    let lo = 0;
    let hi = 0;
    for (let i = s; i < e; i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

// ─── WAV encode / inspect ────────────────────────────────────────────────────

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode mono Float32 PCM in [-1, 1] as a 16-bit PCM RIFF/WAVE file. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const rate = Math.round(sampleRate);
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return new Uint8Array(buffer);
}

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSec: number;
}

/** Read the fmt/data chunks of a RIFF/WAVE file (walks the chunk list). Null if it isn't one. */
export function parseWavInfo(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = -1;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataBytes = Math.min(size, bytes.length - body);
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!sampleRate || !channels || !bitsPerSample || dataBytes < 0) return null;
  const frameBytes = channels * (bitsPerSample / 8);
  return {
    format,
    channels,
    sampleRate,
    bitsPerSample,
    dataBytes,
    durationSec: frameBytes > 0 ? dataBytes / frameBytes / sampleRate : 0,
  };
}

/** Base64 for arbitrarily large byte arrays (chunked so the call stack never overflows). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
