/*
 * The pace control of the live voice, checked without a browser: the time stretcher
 * (web/src/time-stretch.ts) and the Speaker worklet that plays through it (web/src/call.ts).
 *
 *   node_modules/.bin/tsx scripts/test-time-stretch.mts
 *
 * One line per check; the last line is ALL PASSED, or N FAILED with exit code 1.
 *
 * The stretcher is tested from the outside: on a voiced-speech-like tone (duration, pitch, clicks,
 * streaming, look-ahead), on hiss and on plosive-like bursts. The Speaker is the very source call.ts hands
 * the browser, run in a bare scope with stand-ins for AudioWorkletProcessor, registerProcessor and
 * sampleRate, and fed the way the pod feeds it: one 80 ms chunk per 80 ms, silence included — which is
 * where a pace under 1 has to catch up with the live stream (checks a, b, c).
 * The last check bundles call.ts minified, the way the build does, and runs that worklet source too.
 * Nothing here listens: how it sounds is still for ears to judge.
 */
import { resolveObjectURL } from "node:buffer";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { LiveCall, WORKLETS, playbackRate } from "../web/src/call.ts";
import { TimeStretcher } from "../web/src/time-stretch.ts";

const SR = 24000;
const RATES = [0.7, 0.85, 1.15, 1.4];

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const f = (v: number, digits = 2): string => v.toFixed(digits);
const ms = (samples: number): number => (1000 * samples) / SR;
const pct = (v: number, digits = 2): string => `${(100 * v).toFixed(digits)}%`;

// ───────────────────────────────────────────── signals ─────────────────────────────────────────────

/** Repeatable noise, 0–1. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A voiced-speech-like tone: twelve glottal-pulse-like harmonics, falling off, on a fundamental that
 * glides slowly between 120 and 180 Hz (once up and down in 5 s; `from` is where in that glide it starts).
 */
function voiced(seconds: number, from = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f0 = 150 - 30 * Math.cos((2 * Math.PI * (from + i / SR)) / 5);
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.cos(h * phase) / Math.pow(h, 1.3);
    x[i] = 0.2 * v;
  }
  return x;
}

/** Fade the two ends in and out (in place). */
function faded(x: Float32Array, millis = 15): Float32Array {
  const n = Math.round((millis * SR) / 1000);
  for (let i = 0; i < n && i < x.length; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    x[i] = x[i]! * g;
    x[x.length - 1 - i] = x[x.length - 1 - i]! * g;
  }
  return x;
}

/** Steady noise at an RMS level. */
function hiss(seconds: number, level: number, seed: number): Float32Array {
  const n = Math.round(seconds * SR);
  const r = rng(seed);
  const x = new Float32Array(n);
  const a = level * Math.sqrt(3);
  for (let i = 0; i < n; i++) x[i] = (r() * 2 - 1) * a;
  return x;
}

/** What the pod sends between phrases: not zeros, a floor at about -70 dBFS. */
const pause = (seconds: number, seed: number): Float32Array => hiss(seconds, 3.2e-4, seed);

function joined(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Plosive-like syllables on that floor: a sudden 5 ms burst of noise, a breath, then a short vowel.
 * Each burst's waveform is returned, to look for in the output.
 */
function syllables(count: number, seed: number): { x: Float32Array; bursts: Array<{ at: number; shape: Float32Array }> } {
  const r = rng(seed);
  const every = Math.round(0.3 * SR);
  const x = pause((count * every) / SR + 1, seed + 100);
  const bursts: Array<{ at: number; shape: Float32Array }> = [];
  let phase = 0;
  for (let k = 0; k < count; k++) {
    const at = Math.round(0.2 * SR) + k * every + Math.floor(r() * 700);
    const shape = new Float32Array(120);
    for (let i = 0; i < 120; i++) {
      shape[i] = (r() * 2 - 1) * 0.35 * (i < 72 ? 1 : (120 - i) / 48);
      x[at + i] = x[at + i]! + shape[i]!;
    }
    bursts.push({ at, shape });
    for (let i = 120; i < 408; i++) x[at + i] = x[at + i]! + (r() * 2 - 1) * 0.01;
    const length = Math.round(0.15 * SR);
    const f0 = 110 + 90 * r();
    for (let i = 0; i < length; i++) {
      phase += (2 * Math.PI * (f0 + (10 * i) / length)) / SR;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.cos(h * phase) / Math.pow(h, 1.3);
      x[at + 408 + i] = x[at + 408 + i]! + 0.2 * v * Math.min(1, i / 240) * Math.min(1, (length - i) / 720);
    }
  }
  return { x, bursts };
}

// ───────────────────────────────────────────── measures ─────────────────────────────────────────────

/** The fundamental around `center`, by normalized autocorrelation over 40 ms (70–400 Hz); 0 if there is none to find. */
function pitchAt(x: Float32Array, center: number): number {
  const win = 960;
  const lmin = 60;
  const lmax = 343;
  const start = Math.round(center) - win / 2;
  if (start < 0 || start + win + lmax + 2 > x.length) return 0;
  let e0 = 0;
  for (let i = 0; i < win; i++) e0 += x[start + i]! * x[start + i]!;
  if (e0 < 1e-6) return 0;
  const r = new Float64Array(lmax + 2);
  for (let lag = lmin - 1; lag <= lmax + 1; lag++) {
    let dot = 0;
    let e1 = 0;
    for (let i = 0; i < win; i++) {
      const b = x[start + i + lag]!;
      dot += x[start + i]! * b;
      e1 += b * b;
    }
    r[lag] = dot / Math.sqrt(e0 * e1 + 1e-18);
  }
  let best = lmin;
  for (let lag = lmin; lag <= lmax; lag++) if (r[lag]! > r[best]!) best = lag;
  // the first peak nearly as high: a period, not two of them
  for (let lag = lmin; lag < best; lag++) {
    if (r[lag]! > 0.93 * r[best]! && r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!) {
      best = lag;
      break;
    }
  }
  if (r[best]! < 0.5) return 0;
  const a = r[best - 1]!;
  const b = r[best]!;
  const c = r[best + 1]!;
  const bend = a - 2 * b + c;
  return SR / (best + (bend < 0 ? (0.5 * (a - c)) / bend : 0));
}

/**
 * The pitch check: the fundamental of `y` at each moment against that of `x` at the moment it came from
 * (`rate` times as far in). Returns the largest relative difference and how many moments were compared.
 */
function pitchGap(x: Float32Array, y: Float32Array, rate: number, step = 600): { worst: number; n: number } {
  let worst = 0;
  let n = 0;
  for (let c = 1200; c < y.length - 1200; c += step) {
    const out = pitchAt(y, c);
    const inn = pitchAt(x, c * rate);
    if (!inn) continue;
    n++;
    const gap = out ? Math.abs(out / inn - 1) : 1;
    if (gap > worst) worst = gap;
  }
  return { worst, n };
}

/** The largest step from one sample to the next. */
function maxStep(x: Float32Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) {
    const d = Math.abs(x[i]! - x[i - 1]!);
    if (d > m) m = d;
  }
  return m;
}

/** The longest run of exact zeros between the first and the last sample that are not zero. */
function zeroRun(x: Float32Array): number {
  let first = 0;
  let last = x.length - 1;
  while (first < x.length && x[first] === 0) first++;
  while (last > first && x[last] === 0) last--;
  let run = 0;
  let longest = 0;
  for (let i = first; i <= last; i++) {
    run = x[i] === 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return Math.sqrt(e / Math.max(1, to - from));
}

function energy(x: Float32Array, from = 0, to = x.length): number {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return e;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const p = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const q = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

function worstDifference(a: Float32Array, b: Float32Array): number {
  let worst = Math.abs(a.length - b.length) > 0 ? Infinity : 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > worst) worst = d;
  }
  return worst;
}

/** The stretches of `y` that are sound: [start, end) in samples, by level over 5 ms, short dips bridged. */
function soundings(y: Float32Array, level = 0.02): Array<[number, number]> {
  const w = 120;
  const out: Array<[number, number]> = [];
  let start = -1;
  let quiet = 0;
  for (let p = 0; p + w <= y.length; p += w) {
    if (rms(y, p, p + w) > level) {
      if (start < 0) start = p;
      quiet = 0;
    } else if (start >= 0 && ++quiet > 6) {
      out.push([start, p - (quiet - 1) * w]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, y.length - quiet * w]);
  return out;
}

// ───────────────────────────────────────── running the stretcher ─────────────────────────────────────────

type Stretcher = new (sampleRate: number) => TimeStretcher;

/** Everything in at once, everything out; then the last few ms it kept for look-ahead. */
function allAtOnce(x: Float32Array, rate: number, Class: Stretcher = TimeStretcher): Float32Array {
  const t = new Class(SR);
  t.setRate(rate);
  t.push(x);
  const out = new Float32Array(Math.ceil(x.length / rate) + SR);
  const block = new Float32Array(4096);
  let n = 0;
  for (let k = t.pull(block); k > 0; k = t.pull(block)) {
    out.set(block.subarray(0, k), n);
    n += k;
  }
  for (let k = t.drain(block); k > 0; k = t.drain(block)) {
    out.set(block.subarray(0, k), n);
    n += k;
  }
  return out.subarray(0, n);
}

/** The way the worklet does it: 1920-sample chunks in, 128-sample blocks out. */
function streamed(x: Float32Array, rate: number, Class: Stretcher = TimeStretcher, chunk = 1920, size = 128): Float32Array {
  const t = new Class(SR);
  t.setRate(rate);
  const out = new Float32Array(Math.ceil(x.length / rate) + SR);
  const block = new Float32Array(size);
  let n = 0;
  for (let p = 0; p < x.length; p += chunk) {
    t.push(x.subarray(p, Math.min(x.length, p + chunk)));
    for (;;) {
      const k = t.pull(block);
      out.set(block.subarray(0, k), n);
      n += k;
      if (k < size) break;
    }
  }
  for (let k = t.drain(block); k > 0; k = t.drain(block)) {
    out.set(block.subarray(0, k), n);
    n += k;
  }
  return out.subarray(0, n);
}

/** The old way, for comparison: resampling by `rate` with linear interpolation (what the Speaker used to do). */
function resampled(x: Float32Array, rate: number): Float32Array {
  const out = new Float32Array(Math.floor((x.length - 1) / rate));
  for (let i = 0; i < out.length; i++) {
    const pos = i * rate;
    const k = Math.floor(pos);
    out[i] = x[k]! + (x[k + 1]! - x[k]!) * (pos - k);
  }
  return out;
}

/**
 * Look-ahead, from the outside: feed 1 ms at a time and note how much input had to be in before each output
 * sample could be had, over and above where an ideal stretcher would be reading (`rate` × the output so far).
 */
function lookAhead(x: Float32Array, rate: number): number {
  const t = new TimeStretcher(SR);
  t.setRate(rate);
  const block = new Float32Array(4096);
  let made = 0;
  let worst = 0;
  for (let p = 0; p < x.length; p += 24) {
    t.push(x.subarray(p, p + 24));
    for (let k = t.pull(block); k > 0; k = t.pull(block)) {
      const ahead = p + 24 - made * rate; // for the first of these k samples: the one that waited longest
      if (made > 2400 && ahead > worst) worst = ahead;
      made += k;
    }
  }
  return worst;
}

// ───────────────────────────────────────────── the stretcher ─────────────────────────────────────────────

const tone = voiced(5);
const toneStep = maxStep(tone);
/** A bit of everything, for the checks that are about more than a steady voice. */
const mixed = joined([voiced(2), syllables(8, 4).x, hiss(1, 0.05, 8), pause(0.3, 9), voiced(1, 2)]);

for (const rate of RATES) {
  const y = allAtOnce(tone, rate);

  const want = tone.length / rate;
  check(`rate ${rate}: 5 s in gives ${f(want / SR, 3)} s out, within 2%`, Math.abs(y.length / want - 1) <= 0.02, `${f(y.length / SR, 3)} s, ${pct(y.length / want - 1)}`);

  const gap = pitchGap(tone, y, rate);
  check(`rate ${rate}: the pitch stays within 1.5% of the input's`, gap.n > 100 && gap.worst <= 0.015, `worst ${pct(gap.worst)} over ${gap.n} moments`);

  const old = pitchGap(tone, resampled(tone, rate), rate);
  check(`rate ${rate}: the old resampler fails that same pitch check`, old.n > 100 && old.worst > 0.015, `worst ${pct(old.worst, 1)}`);

  const step = maxStep(y) / toneStep;
  const zeros = zeroRun(y);
  check(`rate ${rate}: no clicks, no gaps`, step <= 1.5 && zeros < 4, `largest step ${f(step, 3)}x the input's, longest run of zeros ${zeros}`);

  const s = streamed(tone, rate);
  const diff = worstDifference(y, s);
  check(`rate ${rate}: 1920 in / 128 out gives what all-at-once gives`, y.length === s.length && diff <= 1e-6, `${s.length} vs ${y.length} samples, worst difference ${diff}`);

  const ahead = Math.max(lookAhead(tone, rate), lookAhead(mixed, rate));
  check(`rate ${rate}: added latency no more than 50 ms`, ahead <= 0.05 * SR + 24, `needs at most ${f(ms(ahead), 1)} ms more input than an ideal stretcher`);
}

{
  // Rate 1: an exact passthrough, with nothing held back.
  const x = joined([voiced(1.2), hiss(0.8, 0.1, 5), pause(0.5, 6), voiced(0.7, 2)]);
  const t = new TimeStretcher(SR);
  const out = new Float32Array(x.length);
  const block = new Float32Array(1920);
  let n = 0;
  let prompt = true;
  for (let p = 0; p < x.length; p += 1920) {
    const chunk = x.subarray(p, Math.min(x.length, p + 1920));
    t.push(chunk);
    if (t.available() !== chunk.length) prompt = false;
    const k = t.pull(block);
    if (k !== chunk.length) prompt = false;
    out.set(block.subarray(0, k), n);
    n += k;
  }
  check("rate 1: bit-identical to the input, with no delay", prompt && n === x.length && sameBits(out, x) && sameBits(streamed(x, 1), x), `${n} of ${x.length} samples, each chunk out as soon as it was in: ${prompt}`);
}

{
  // The pace changed in the middle of a stream.
  const x = voiced(6);
  const half = 38 * 1920;
  const t = new TimeStretcher(SR);
  t.setRate(0.7);
  const out = new Float32Array(x.length * 2);
  const block = new Float32Array(128);
  let n = 0;
  for (let p = 0; p < x.length; p += 1920) {
    if (p === half) t.setRate(1.3);
    t.push(x.subarray(p, Math.min(x.length, p + 1920)));
    for (;;) {
      const k = t.pull(block);
      out.set(block.subarray(0, k), n);
      n += k;
      if (k < 128) break;
    }
  }
  for (let k = t.drain(block); k > 0; k = t.drain(block)) {
    out.set(block.subarray(0, k), n);
    n += k;
  }
  const y = out.subarray(0, n);
  const want = half / 0.7 + (x.length - half) / 1.3;
  const step = maxStep(y) / maxStep(x);
  check("pace changed mid-stream (0.7 to 1.3): no click, right length", step <= 1.5 && zeroRun(y) < 4 && Math.abs(n / want - 1) <= 0.02, `largest step ${f(step, 3)}x, ${f(n / SR, 3)} s for ${f(want / SR, 3)} s, ${pct(n / want - 1)}`);
}

{
  // The pace on the move, through 1 and back: every 40 ms a new one.
  const x = voiced(8);
  const t = new TimeStretcher(SR);
  const out = new Float32Array(x.length * 3);
  const block = new Float32Array(128);
  let n = 0;
  let want = 0;
  for (let p = 0, i = 0; p < x.length; p += 960, i++) {
    const rate = Math.abs(((i % 60) - 30) / 30) < 0.1 ? 1 : 1 + 0.45 * Math.sin((2 * Math.PI * i) / 60);
    t.setRate(rate);
    want += 960 / rate;
    t.push(x.subarray(p, Math.min(x.length, p + 960)));
    for (;;) {
      const k = t.pull(block);
      out.set(block.subarray(0, k), n);
      n += k;
      if (k < 128) break;
    }
  }
  for (let k = t.drain(block); k > 0; k = t.drain(block)) {
    out.set(block.subarray(0, k), n);
    n += k;
  }
  const y = out.subarray(0, n);
  const step = maxStep(y) / maxStep(x);
  check("pace swept 0.55 to 1.45 and back, through 1: no click, right length", step <= 1.5 && zeroRun(y) < 4 && Math.abs(n / want - 1) <= 0.02, `largest step ${f(step, 3)}x, ${pct(n / want - 1)} off`);
}

{
  // flush() empties it, and what comes next starts clean.
  const t = new TimeStretcher(SR);
  t.setRate(0.7);
  t.push(voiced(1));
  t.pull(new Float32Array(4000));
  const held = t.pending() > 0 && t.available() > 0;
  t.flush();
  const empty = t.available() === 0 && t.pending() === 0 && t.pull(new Float32Array(128)) === 0 && t.drain(new Float32Array(128)) === 0;
  const next = voiced(0.5, 3);
  t.push(next);
  const first = new Float32Array(360);
  const k = t.pull(first);
  check("flush() empties it and the next output starts clean", held && empty && k === 360 && sameBits(first, next.subarray(0, 360)), `held before: ${held}; empty after: ${empty}; then the new input's own first ${k} samples`);
}

{
  // available() is a promise: asked for no more than that, pull() delivers in full.
  const x = joined([voiced(2), hiss(1, 0.05, 9), syllables(6, 3).x]);
  const r = rng(11);
  let broken = 0;
  let asked = 0;
  for (const rate of [0.5, 0.7, 0.85, 1, 1.15, 1.4, 2]) {
    const t = new TimeStretcher(SR);
    t.setRate(rate);
    for (let p = 0; p < x.length; ) {
      const n = 1 + Math.floor(r() * 3000);
      t.push(x.subarray(p, Math.min(x.length, p + n)));
      p += n;
      for (let i = 0; i < 4; i++) {
        const sure = t.available();
        if (sure <= 0) break;
        const take = 1 + Math.floor(r() * sure);
        asked++;
        if (t.pull(new Float32Array(take)) !== take) broken++;
      }
    }
  }
  check("available() never promises more than pull() gives", broken === 0 && asked > 1000, `${asked} pulls at 7 paces, ${broken} short`);
}

{
  // Anything goes in, nothing odd comes out: random chunks, pulls, paces and flushes.
  const r = rng(21);
  const x = joined([syllables(8, 5).x, hiss(1, 0.2, 6), voiced(2), pause(0.5, 7), new Float32Array(2400), voiced(1, 1)]);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  let odd = 0;
  let total = 0;
  for (let run = 0; run < 12; run++) {
    const t = new TimeStretcher(SR);
    const block = new Float32Array(1 + Math.floor(r() * 700));
    const look = (k: number): void => {
      for (let i = 0; i < k; i++) if (!(Math.abs(block[i]!) <= peak * 1.5)) odd++;
      total += k;
    };
    for (let p = 0; p < x.length; ) {
      const pick = r();
      if (pick < 0.3) t.setRate(r() < 0.2 ? 1 : 0.5 + 1.5 * r());
      else if (pick < 0.31) t.flush();
      const n = 1 + Math.floor(r() * (r() < 0.1 ? 9000 : 2500));
      t.push(x.subarray(p, Math.min(x.length, p + n)));
      p += n;
      const pulls = Math.floor(r() * 12);
      for (let i = 0; i < pulls; i++) look(t.pull(block));
      if (t.pending() < 0 || t.available() < 0) odd++;
    }
    for (let k = t.pull(block); k > 0; k = t.pull(block)) look(k);
    for (let k = t.drain(block); k > 0; k = t.drain(block)) look(k);
    if (t.pending() !== 0 || t.available() !== 0) odd++;
  }
  check("random chunks, pulls, paces and flushes: every sample finite and in range", odd === 0 && total > 1e6, `${total} samples out, ${odd} odd`);
}

{
  // Hiss keeps its level through the joins: its quietest 5 ms stay as quiet as the input's, no quieter.
  const x = hiss(6, 0.05, 31);
  const dips = (y: Float32Array): number => {
    const levels: number[] = [];
    for (let p = 2400; p + 120 <= y.length - 2400; p += 120) levels.push(20 * Math.log10(rms(y, p, p + 120)));
    levels.sort((a, b) => a - b);
    return levels[Math.floor(levels.length * 0.02)]! - levels[Math.floor(levels.length / 2)]!;
  };
  const inDip = dips(x);
  const out = [0.7, 1.4].map((rate) => {
    const y = allAtOnce(x, rate);
    return { rate, dip: dips(y), level: 20 * Math.log10(rms(y) / rms(x)) };
  });
  check(
    "hiss keeps its level through the joins",
    out.every((o) => Math.abs(o.dip - inDip) <= 0.5 && Math.abs(o.level) <= 0.3),
    `quietest 2% of 5 ms windows against the median: input ${f(inDip)} dB, ${out.map((o) => `at ${o.rate} ${f(o.dip)} dB (overall ${f(o.level)} dB)`).join(", ")}`,
  );
}

{
  // Plosive-like bursts come through once, whole: each burst's own waveform is looked for in the output.
  const results: string[] = [];
  let ok = true;
  for (const rate of RATES) {
    let whole = 0;
    let twice = 0;
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const s = syllables(14, seed);
      const y = allAtOnce(s.x, rate);
      for (const b of s.bursts) {
        total++;
        const es = energy(b.shape);
        let best = 0;
        let bestAt = 0;
        let bestGain = 0;
        const from = Math.max(0, Math.round(b.at / rate - 0.08 * SR));
        const to = Math.min(y.length - 120, Math.round(b.at / rate + 0.08 * SR));
        const found: Array<{ at: number; like: number }> = [];
        for (let p = from; p <= to; p++) {
          let dot = 0;
          let ey = 0;
          for (let i = 0; i < 120; i++) {
            dot += b.shape[i]! * y[p + i]!;
            ey += y[p + i]! * y[p + i]!;
          }
          const like = dot / Math.sqrt(es * ey + 1e-18);
          if (like > best) {
            best = like;
            bestAt = p;
            bestGain = dot / es;
          }
          if (like >= 0.5) found.push({ at: p, like });
        }
        if (best >= 0.9 && bestGain >= 0.9) whole++;
        if (found.some((o) => Math.abs(o.at - bestAt) > 24)) twice++;
      }
    }
    results.push(`at ${rate} ${whole}/${total} whole, ${twice} twice`);
    if (whole !== total || twice !== 0) ok = false;
  }
  check("plosive-like bursts come through once, whole", ok, results.join("; "));
}

{
  // Fast enough for the audio thread, with room to spare.
  const long = voiced(30);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    allAtOnce(long, 0.7);
    best = Math.min(best, performance.now() - t0);
  }
  check("30 s of audio at rate 0.7 stretched in under 1.5 s", best < 1500, `${f(best, 0)} ms, ${f(best / 30000, 4)}x real time`);
}

{
  // The embedding: the class's own source text, evaluated on its own, is the same stretcher.
  let detail = "";
  let ok = false;
  try {
    const source = `const TimeStretcher = ${TimeStretcher.toString()};`;
    const Embedded = new Function(`${source}\nreturn TimeStretcher;`)() as Stretcher;
    const x = joined([voiced(1.5), syllables(4, 9).x, hiss(0.5, 0.05, 3)]);
    ok = RATES.concat(1).every((rate) => sameBits(streamed(x, rate, Embedded), streamed(x, rate)) && sameBits(allAtOnce(x, rate, Embedded), allAtOnce(x, rate)));
    detail = `${source.length} characters, named ${Embedded.name}`;
  } catch (e) {
    detail = String(e);
  }
  check("the class embedded by its source text gives the same output as the imported one", ok, detail);
}

// ───────────────────────────────────────────── the Speaker ─────────────────────────────────────────────

interface Speaker {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  queued: number;
  playing: boolean;
  cushion: number;
  rate: number;
  pace: number;
  dropped: number;
  ts: TimeStretcher;
}

/**
 * Load the worklet module the way a browser would: in strict mode (a module is), in a scope with nothing in
 * it but the language and the three things an AudioWorkletGlobalScope adds — so the source has to stand
 * entirely on its own.
 */
function load(source: string): Record<string, new () => Speaker> {
  const registry: Record<string, new () => Speaker> = {};
  class AudioWorkletProcessor {
    port = { onmessage: null, postMessage(): void {} };
  }
  const scope = vm.createContext({
    AudioWorkletProcessor,
    registerProcessor: (name: string, processor: new () => Speaker): void => {
      registry[name] = processor;
    },
    sampleRate: SR,
  });
  vm.runInContext(`"use strict";${source}`, scope);
  return registry;
}

const send = (sp: Speaker, data: unknown): void => sp.port.onmessage!({ data });
const block = (sp: Speaker): Float32Array => {
  const out = new Float32Array(128);
  sp.process([], [[out]]);
  return out;
};
const silent = (x: Float32Array): boolean => x.every((v) => v === 0);

interface Played {
  out: Float32Array;
  /** After each block: the backlog (input queued and not yet played, in seconds) and the pace playing. */
  backlog: Float64Array;
  pace: Float64Array;
  /** Energy of what was handed to the stretcher: against the input's, it shows what was left out. */
  fed: number;
}

/**
 * Play `input` as a live stream: one 1920-sample chunk every 15 blocks of 128 — real time, like the pod —
 * and `more` seconds of blocks after the last chunk. (`chunk`: another size, a multiple of 128.)
 */
function live(sp: Speaker, input: Float32Array, more = 0, chunk = 1920): Played {
  const every = chunk / 128;
  const chunks = Math.ceil(input.length / chunk);
  const blocks = chunks * every + Math.round((more * SR) / 128);
  const out = new Float32Array(blocks * 128);
  const backlog = new Float64Array(blocks);
  const pace = new Float64Array(blocks);
  let fed = 0;
  const push = sp.ts.push.bind(sp.ts);
  sp.ts.push = (chunk: Float32Array, start?: number, end?: number): void => {
    fed += energy(chunk, start ?? 0, end ?? chunk.length);
    push(chunk, start, end);
  };
  const one = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    if (b % every === 0 && b / every < chunks) send(sp, input.slice((b / every) * chunk, Math.min(input.length, (b / every + 1) * chunk)));
    one.fill(0);
    sp.process([], [[one]]);
    out.set(one, b * 128);
    backlog[b] = sp.queued / SR;
    pace[b] = sp.pace;
  }
  return { out, backlog, pace, fed };
}

const max = (x: Float64Array): number => x.reduce((m, v) => (v > m ? v : m), -Infinity);

let registry: Record<string, new () => Speaker> = {};
let loaded = "";
try {
  registry = load(WORKLETS);
  // and as what the browser is given: an ES module (here with the three names lent to it for the moment)
  const names: string[] = [];
  const lent = globalThis as Record<string, unknown>;
  lent.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage(): void {} };
  };
  lent.registerProcessor = (name: string): void => void names.push(name);
  lent.sampleRate = SR;
  try {
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(WORKLETS)}`);
  } finally {
    delete lent.AudioWorkletProcessor;
    delete lent.registerProcessor;
    delete lent.sampleRate;
  }
  loaded = names.join();
} catch (e) {
  loaded = String(e);
}
const SpeakerClass = registry.speaker;
check("the worklet source stands alone: runs in a bare strict scope, and loads as a module", !!SpeakerClass && !!registry.mic && loaded === "mic,speaker", `${WORKLETS.length} characters; registered as a module: ${loaded}`);

if (SpeakerClass) {
  const fresh = (rate?: number): Speaker => {
    const sp = new SpeakerClass();
    if (rate !== undefined) send(sp, { rate });
    return sp;
  };

  {
    // The cushion: nothing until 240 ms is queued, then from the first sample. At pace 1 "queued" is exact.
    const x = voiced(1);
    const sp = fresh();
    send(sp, x.slice(0, 1920));
    send(sp, x.slice(1920, 3840));
    let held = true;
    for (let i = 0; i < 10; i++) if (!silent(block(sp)) || sp.playing) held = false;
    send(sp, x.slice(3840, 5760));
    const first = block(sp);
    let counted = sp.queued === 5760 - 128;
    for (let i = 0; i < 20; i++) block(sp);
    counted = counted && sp.queued === 5760 - 21 * 128;
    check("Speaker: silent until 240 ms is queued, then plays from the first sample; queued counts what is unplayed", held && sameBits(first, x.subarray(0, 128)) && counted, `held: ${held}, queued after 21 blocks: ${sp.queued}`);
  }

  {
    // Running dry mid-phrase: everything queued is played, then the cushion grows by 80 ms, up to 400 ms.
    const x = voiced(4);
    const sizes: number[] = [];
    const left: number[] = [];
    let waited = true;
    let played = 0;
    let at = 0;
    for (const pace of [1, 0.8]) {
      const sp = fresh(pace);
      at = 0;
      played = 0;
      for (const amount of [5760, 7680, 9600, 9600]) {
        // short of the cushion as it now stands: nothing plays
        send(sp, x.slice(at, at + amount - 1920));
        for (let i = 0; i < 5; i++) if (!silent(block(sp)) || sp.playing) waited = false;
        send(sp, x.slice(at + amount - 1920, at + amount));
        at += amount;
        for (let i = 0; i < 400 && (sp.playing || i === 0); i++) played += block(sp).reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
        sizes.push(sp.cushion);
      }
      left.push(sp.queued + sp.ts.pending() + sp.ts.available());
    }
    const want = at / 0.8;
    check(
      "Speaker: running dry grows the cushion 240 → 320 → 400 ms and no further (pace 1 and 0.8); all that was queued is played first",
      sizes.join() === "7680,9600,9600,9600,7680,9600,9600,9600" && waited && left.join() === "0,0" && played > 0.95 * want && played < 1.02 * want,
      `cushion after each: ${sizes.map((s) => ms(s)).join(", ")} ms; at 0.8 ${f(played / SR, 2)} s played for ${f(want / SR, 2)} s; left over ${left.join(", ")}`,
    );
  }

  {
    // "flush": silence at once, nothing left, and the next audio starts clean.
    const x = voiced(1);
    const sp = fresh(0.8);
    for (let p = 0; p < 9600; p += 1920) send(sp, x.slice(p, p + 1920));
    let sounded = false;
    for (let i = 0; i < 12; i++) if (!silent(block(sp))) sounded = true;
    send(sp, "flush");
    const quietNow = silent(block(sp)) && silent(block(sp)) && sp.queued === 0 && !sp.playing && sp.ts.pending() === 0 && sp.ts.available() === 0;
    const next = voiced(0.5, 2);
    for (let p = 0; p < 5760; p += 1920) send(sp, next.slice(p, p + 1920));
    const first = block(sp);
    check('Speaker: "flush" silences it and empties it; what follows starts from its own first sample', sounded && quietNow && sameBits(first, next.subarray(0, 128)), `sounded before: ${sounded}; silent and empty after: ${quietNow}`);
  }

  {
    // Pace 0.8 on a live stream: 4 s of speech takes 5 s, at the pitch it came with — whatever size the chunks.
    const x = faded(voiced(4));
    const want = x.length / 0.8;
    const results = [1920, 640, 4480].map((chunk) => {
      const run = live(fresh(0.8), x, 2, chunk);
      const parts = soundings(run.out);
      const [start, end] = parts[0] ?? [0, 0];
      const gap = pitchGap(x, run.out.subarray(start, end), 0.8);
      return { chunk, stretches: parts.length, seconds: (end - start) / SR, off: (end - start) / want - 1, gap, backlog: max(run.backlog) };
    });
    check(
      "Speaker at pace 0.8, live: 4 s plays in 5 s (within 2%) at the pitch it came with",
      results.every((r) => r.stretches === 1 && Math.abs(r.off) <= 0.02 && r.gap.n > 50 && r.gap.worst <= 0.015),
      results.map((r) => `${r.chunk}-sample chunks: ${f(r.seconds, 3)} s, pitch within ${pct(r.gap.worst)}, backlog up to ${f(r.backlog, 2)} s`).join("; "),
    );
  }

  {
    // (a) A minute of phrases and pauses at pace 0.8: the pauses pay back what the phrases cost.
    const parts: Float32Array[] = [];
    const bursts: Float32Array[] = [];
    for (let k = 0; k < 17; k++) {
      const burst = faded(voiced(2, k * 0.7));
      bursts.push(burst);
      parts.push(burst, k % 3 === 2 ? new Float32Array(1.5 * SR) : pause(1.5, 40 + k)); // a floor, or plain zeros
    }
    parts.push(pause(0.5, 99));
    const x = joined(parts);
    // in the pod's 80 ms frames, and in smaller ones (should a proxy ever cut them up)
    const results = [1920, 640].map((chunk) => {
      const sp = fresh(0.8);
      const run = live(sp, x, 0, chunk);
      const heard = soundings(run.out);
      let worstLength = 0;
      let worstPitch = 0;
      let moments = 0;
      heard.forEach(([start, end], k) => {
        worstLength = Math.max(worstLength, Math.abs((end - start) / ((2 * SR) / 0.8) - 1));
        const burst = bursts[k];
        if (!burst) return;
        const gap = pitchGap(burst, run.out.subarray(start, end), 0.8, 1200);
        worstPitch = Math.max(worstPitch, gap.worst);
        moments += gap.n;
      });
      const peak = max(run.backlog);
      const last = run.backlog[run.backlog.length - 1]!;
      const ok = peak <= 1.5 && last < 0.5 && heard.length === 17 && worstLength <= 0.03 && moments > 400 && worstPitch <= 0.015 && energy(x) - run.fed <= sp.dropped * 3.2e-6 && max(run.pace) === 0.8;
      return { ok, text: `${chunk}-sample chunks: backlog peak ${f(peak, 2)} s, at the end ${f(last, 2)} s; ${heard.length} phrases, length within ${pct(worstLength)}, pitch within ${pct(worstPitch)}; ${f(sp.dropped / SR, 1)} s of pause left out, none of it audible` };
    });
    check(
      "Speaker (a) 60 s of 2 s phrases and 1.5 s pauses, live at 0.8: backlog never over 1.5 s, under 0.5 s at the end; every phrase whole, in time (3%) and in pitch",
      results.every((r) => r.ok),
      results.map((r) => r.text).join(" | "),
    );
  }

  {
    // The same when the pod's pauses are noisier than "silence" (-50 dBFS): the Speaker goes by the stream's own floor.
    const parts: Float32Array[] = [];
    for (let k = 0; k < 17; k++) parts.push(faded(voiced(2, k * 0.7)), hiss(1.5, 3.2e-3, 140 + k));
    parts.push(hiss(0.5, 3.2e-3, 199));
    const x = joined(parts);
    const sp = fresh(0.8);
    const run = live(sp, x);
    const heard = soundings(run.out);
    const last = run.backlog[run.backlog.length - 1]!;
    const lost = energy(x) - run.fed;
    check(
      "Speaker: pauses with a noise floor at -50 dBFS pay back as well; no phrase is touched",
      max(run.backlog) <= 1.5 && last < 0.5 && heard.length === 17 && sp.dropped > 5 * SR && lost <= sp.dropped * 3.2e-5 && max(run.pace) === 0.8,
      `backlog peak ${f(max(run.backlog), 2)} s (pace up to ${f(max(run.pace), 2)}), at the end ${f(last, 2)} s; ${heard.length} phrases; ${f(sp.dropped / SR, 1)} s of pause left out`,
    );
  }

  {
    // (b) 20 s of speech without a break at pace 0.7, then silence: the lag is held, then paid back.
    const speech = faded(voiced(20));
    const x = joined([speech, pause(8, 77)]);
    const sp = fresh(0.7);
    const run = live(sp, x);
    const end = Math.round((20 * SR) / 128);
    const peak = max(run.backlog);
    let back = -1;
    for (let b = end; b < run.backlog.length; b++) {
      if (run.backlog[b]! <= (sp.cushion + 0.3 * SR) / SR) {
        back = (b - end) * 128;
        break;
      }
    }
    const last = run.backlog[run.backlog.length - 1]!;
    const heard = soundings(run.out);
    const lost = energy(x) - run.fed;
    let step = 0;
    for (let b = 1; b < run.pace.length; b++) step = Math.max(step, Math.abs(run.pace[b]! - run.pace[b - 1]!));
    const finalPace = run.pace[run.pace.length - 1]!;
    check(
      "Speaker (b) 20 s of unbroken speech, live at 0.7, then silence: backlog paid back within 8 s; no speech dropped; the pace gives way to 1 and comes back smoothly",
      back >= 0 && back <= 8 * SR && peak < 3 && last < 0.5 && heard.length === 1 && lost <= sp.dropped * 3.2e-6 && max(run.pace) === 1 && Math.abs(finalPace - 0.7) < 1e-6 && step <= 0.0021,
      `backlog peak ${f(peak, 2)} s (pace eased to ${f(max(run.pace), 2)}), ${f(run.backlog[end]!, 2)} s when the speech ended, paid back ${f(back / SR, 2)} s into the silence, ${f(last, 2)} s at the end; pace back at ${f(finalPace, 2)}, largest pace step ${f(step, 4)}`,
    );
  }

  {
    // (c) Pace 1 is what it always was: the input, bit for bit, one cushion later; nothing left out.
    const parts: Float32Array[] = [];
    for (let k = 0; k < 5; k++) parts.push(faded(voiced(2, k)), pause(1.5, 60 + k), new Float32Array(4800));
    const x = joined(parts);
    const sp = fresh();
    const run = live(sp, x, 0.5);
    const delay = 30 * 128;
    const exact = sameBits(run.out.subarray(delay, delay + x.length), x) && silent(run.out.subarray(0, delay));
    // and with the whole lot queued at once: still nothing left out
    const sp2 = fresh();
    send(sp2, x.slice());
    const out2 = new Float32Array(Math.ceil(x.length / 128) * 128);
    for (let p = 0; p < out2.length; p += 128) out2.set(block(sp2), p);
    const exact2 = sameBits(out2.subarray(0, x.length), x);
    check(
      "Speaker (c) pace 1: a bit-exact passthrough, live or queued all at once; nothing dropped",
      exact && exact2 && sp.dropped === 0 && sp2.dropped === 0 && max(run.pace) === 1,
      `live: identical from ${ms(delay)} ms on (the cushion filling): ${exact}, backlog ${f(max(run.backlog), 2)} s; all at once: identical: ${exact2}; dropped ${sp.dropped + sp2.dropped}`,
    );
  }

  {
    // Faster than live there is nothing to make up: the queue runs dry and waits, as before. Nothing is dropped.
    const x = joined([faded(voiced(4)), pause(1, 3), faded(voiced(2, 1))]);
    const sp = fresh(1.25);
    const run = live(sp, x, 1);
    const heard = soundings(run.out, 0.02);
    const sounding = heard.reduce((n, [a, b]) => n + (b - a), 0);
    const want = (6 * SR) / 1.25;
    check(
      "Speaker at pace 1.25, live: plays all of it, drops nothing, and waits for audio when it runs dry",
      sp.dropped === 0 && Math.abs(energy(x) - run.fed) < 1e-6 * energy(x) && sp.cushion === 9600 && Math.abs(sounding / want - 1) <= 0.03 && sp.queued === 0,
      `${f(sounding / SR, 2)} s of sound for ${f(want / SR, 2)} s, in ${heard.length} stretches; cushion grew to ${ms(sp.cushion)} ms; dropped ${sp.dropped}`,
    );
  }

  {
    // Rough traffic: chunks of any size arriving in fits and starts, the pace changed and the queue flushed
    // at random, a few bad messages. Whatever happens, what comes out is finite, in range, and accounted for.
    const r = rng(77);
    const stuff = joined([faded(voiced(3)), pause(1.2, 1), syllables(8, 6).x, new Float32Array(SR), hiss(1, 0.1, 2), faded(voiced(2, 1)), pause(2, 3)]);
    let peak = 0;
    for (let i = 0; i < stuff.length; i++) peak = Math.max(peak, Math.abs(stuff[i]!));
    let odd = 0;
    let blocks = 0;
    let problem = "";
    try {
      for (let run = 0; run < 6; run++) {
        const sp = fresh();
        let at = 0;
        let owed = 0; // input that has "arrived at the pod" but is held up on the way
        let stall = 0;
        for (let b = 0; b < 6000; b++) {
          owed += 128;
          if (stall > 0) stall--;
          else if (r() < 0.004) stall = Math.floor(r() * 150);
          else if (owed >= 1920 || r() < 0.02) {
            const n = Math.min(owed, 1 + Math.floor(r() * 4000));
            const chunk = new Float32Array(n);
            for (let i = 0; i < n; i++) chunk[i] = stuff[(at + i) % stuff.length]!;
            at += n;
            owed -= n;
            send(sp, chunk);
          }
          const pick = r();
          if (pick < 0.004) send(sp, { rate: r() < 0.25 ? 1 : 0.5 + 1.5 * r() });
          else if (pick < 0.005) send(sp, "flush");
          else if (pick < 0.006) send(sp, { rate: [Number.NaN, 0, 5, -1][Math.floor(r() * 4)] });
          const out = block(sp);
          blocks++;
          for (let i = 0; i < 128; i++) if (!(Math.abs(out[i]!) <= peak * 1.5)) odd++;
          if (!(sp.queued >= 0) || sp.ts.pending() < 0 || !(sp.rate >= 0.5 && sp.rate <= 2) || !(sp.pace >= 0.5 && sp.pace <= 2)) odd++;
        }
      }
    } catch (e) {
      problem = String(e);
    }
    check("Speaker under rough traffic (odd chunks, stalls, pace changes, flushes, bad messages): output finite and in range throughout", odd === 0 && !problem && blocks === 36000, problem || `${blocks} blocks, ${odd} odd`);
  }

  {
    // The pace is two factors: the user's own setting and the persona's pace. The speaker plays at their product.
    const cases: Array<[number, number, number]> = [
      [1, 1, 1],
      [0.8, 0.92, 0.736],
      [1.4, 1.5, 2],
      [0.5, 0.5, 0.5],
      [2, 0.5, 1],
      [1.25, 1.2, 1.5],
      [Number.NaN, 1, 1],
    ];
    const wrong = cases.filter(([rate, pace, want]) => Math.abs(playbackRate(rate, pace) - want) > 1e-12);
    check("playbackRate(): the user's rate times the persona's pace, kept within 0.5–2", wrong.length === 0, wrong.length ? `wrong for ${JSON.stringify(wrong)}` : `${cases.length} cases, 0.8 x 0.92 = ${playbackRate(0.8, 0.92)}`);
  }

  {
    // LiveCall itself, with stand-ins for the browser around it: a socket to speak for the engine, a store, and
    // an audio context whose worklet nodes are the real processors — loaded from the very Blob URL LiveCall makes.
    interface FakeSocket {
      onmessage: ((m: { data: unknown }) => void) | null;
      sent: string[];
    }
    const sockets: FakeSocket[] = [];
    const speakers: Speaker[] = [];
    const stored = new Map<string, string>([["trinity.speechRate", "0.9"]]);
    const part = (): object => {
      const param = (): { value: number } => ({ value: 0 });
      return { type: "", gain: param(), frequency: param(), Q: param(), threshold: param(), ratio: param(), knee: param(), attack: param(), release: param(), connect: (to: unknown) => to, disconnect: (): void => {} };
    };
    const stand: Record<string, unknown> = {
      WebSocket: class {
        static OPEN = 1;
        readyState = 1;
        binaryType = "";
        onopen = null;
        onmessage = null;
        onclose = null;
        sent: string[] = [];
        constructor() {
          sockets.push(this);
        }
        send(data: unknown): void {
          this.sent.push(String(data));
        }
        close(): void {}
      },
      AudioContext: class {
        state = "running";
        destination = part();
        processors: Record<string, new () => Speaker> = {};
        audioWorklet = {
          addModule: async (url: string): Promise<void> => {
            const blob = resolveObjectURL(url);
            if (!blob) throw new Error(`no module at ${url}`);
            this.processors = load(await blob.text());
          },
        };
        async resume(): Promise<void> {}
        createGain = part;
        createBiquadFilter = part;
        createDynamicsCompressor = part;
      },
      AudioWorkletNode: class {
        port: { onmessage: null; postMessage(data: unknown): void };
        constructor(context: { processors: Record<string, new () => Speaker> }, name: string) {
          const processor = new context.processors[name]!();
          if (name === "speaker") speakers.push(processor);
          this.port = { onmessage: null, postMessage: (data: unknown): void => processor.port.onmessage!({ data }) };
        }
        connect(to: unknown): unknown {
          return to;
        }
        disconnect(): void {}
      },
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, String(value)), removeItem: (key: string) => void stored.delete(key) },
    };
    const kept = Object.keys(stand).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    let ok = false;
    let detail = "";
    try {
      for (const [name, value] of Object.entries(stand)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
      const call = new LiveCall();
      call.flushPlayback(); // nothing to flush yet, and no harm
      const seen: string[] = [];
      let queuedWhenTold = -1;
      call.connect("ws://engine.test/call", {
        onEvent: (e) => {
          seen.push(e.type);
          if (e.type === "flush") queuedWhenTold = speakers[0]?.queued ?? -1;
        },
      });
      await call.ensurePlayback();
      const socket = sockets[0]!;
      const sp = speakers[0]!;
      const say = (event: object): void => socket.onmessage!({ data: JSON.stringify(event) });
      const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
      const steps: Array<[string, boolean]> = [];
      steps.push(["starts at the stored setting", close(sp.rate, 0.9)]);
      say({ type: "ready", speechRate: 0.8, pace: 0.92 });
      steps.push(["ready: 0.8 x 0.92", close(sp.rate, 0.736) && call.getSpeechRate() === 0.8 && stored.get("trinity.speechRate") === "0.8"]);
      say({ type: "speech_rate", rate: 1.3 });
      steps.push(["the user's setting changes, the pace stays", close(sp.rate, 1.3 * 0.92) && stored.get("trinity.speechRate") === "1.3"]);
      say({ type: "ready", speechRate: 1 });
      steps.push(["ready without a pace keeps it", close(sp.rate, 0.92)]);
      say({ type: "ready", speechRate: 1.4, pace: 1.5 });
      steps.push(["the product is kept to 2", sp.rate === 2 && call.getSpeechRate() === 1.4]);
      call.setSpeechRate(1);
      call.setPace(9);
      steps.push(["the pace is kept to 1.5", close(sp.rate, 1.5)]);
      call.setPace(0.01);
      call.setSpeechRate(0.5);
      steps.push(["and the product to 0.5", sp.rate === 0.5 && stored.get("trinity.speechRate") === "0.5"]);
      call.setPace(1);
      call.setSpeechRate(1);
      // the user cuts in: the engine says {type: "flush"}, and the queue is gone before the app hears of it
      const pcm = new Int16Array(1920);
      const frame = (): void => {
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin(i * 0.05));
        socket.onmessage!({ data: pcm.slice().buffer });
      };
      for (let i = 0; i < 6; i++) frame();
      let sounded = false;
      for (let i = 0; i < 20; i++) if (!silent(block(sp))) sounded = true;
      const before = sp.queued;
      say({ type: "flush" });
      steps.push(["a flush event empties the speaker before it reaches the app", sounded && before > 0 && queuedWhenTold === 0 && sp.queued === 0 && !sp.playing && silent(block(sp))]);
      for (let i = 0; i < 6; i++) frame();
      for (let i = 0; i < 5; i++) block(sp);
      call.flushPlayback();
      steps.push(["flushPlayback() does the same", sp.queued === 0 && silent(block(sp))]);
      steps.push(["events still reach the app", seen.join() === "ready,speech_rate,ready,ready,flush"]);
      steps.push(["the engine is told playback is on", socket.sent.some((s) => s.includes('"playback"'))]);
      call.close();
      const failedSteps = steps.filter(([, good]) => !good).map(([name]) => name);
      ok = failedSteps.length === 0;
      detail = ok ? `${steps.length} steps: stored 0.9 → ready 0.8 x 0.92 = ${f(0.8 * 0.92, 3)} → … → kept to 2, 1.5, 0.5; flush left ${queuedWhenTold} queued` : `failed: ${failedSteps.join("; ")}`;
    } catch (e) {
      detail = String(e);
    } finally {
      for (const [name, descriptor] of kept) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
    check("LiveCall: the speaker is sent rate x pace (the setting alone is stored); a flush event, or flushPlayback(), empties it at once", ok, detail);
  }

  {
    // What ships is minified: bundle call.ts the way Vite does (Rolldown, minified) and run that worklet source.
    let source = "";
    let why = "";
    try {
      const bundler = "rolldown";
      const { rolldown } = (await import(bundler)) as { rolldown: (options: object) => Promise<{ generate(options: object): Promise<{ output: Array<{ code: string }> }>; close(): Promise<void> }> };
      const bundle = await rolldown({ input: fileURLToPath(new URL("../web/src/call.ts", import.meta.url)), logLevel: "silent" });
      const { output } = await bundle.generate({ format: "iife", name: "TrinityCall", minify: true });
      await bundle.close();
      source = (new Function(`${output[0]!.code}\nreturn TrinityCall;`)() as { WORKLETS: string }).WORKLETS;
    } catch (e) {
      why = String(e).split("\n")[0]!;
    }
    if (!source) console.log(`skip  the minified build's worklet source  (no bundler to try it with: ${why})`);
    else {
      let ok = false;
      let detail = "";
      try {
        const Minified = load(source).speaker!;
        const x = joined([faded(voiced(2)), pause(1, 8), syllables(4, 2).x]);
        const a = live(new Minified(), x, 1);
        const sp = new Minified();
        send(sp, { rate: 0.8 });
        const b = live(sp, x, 1);
        ok = sameBits(a.out, live(fresh(), x, 1).out) && sameBits(b.out, live(fresh(0.8), x, 1).out);
        detail = `${source.length} characters against ${WORKLETS.length} here; same output at pace 1 and 0.8`;
      } catch (e) {
        detail = String(e);
      }
      check("the minified build's worklet source runs on its own and plays the same", ok, detail);
    }
  }
}

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
