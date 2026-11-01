// Browser side of the voice builder: decode uploads, resample to 24 kHz mono with
// an OfflineAudioContext, record raw PCM from the mic (AudioWorklet, no lossy
// codec), and draw waveforms. The pure DSP lives in ../shared/wav.ts.

import {
  bytesToBase64,
  computePeaks,
  downmix,
  encodeWav16,
  prepareVoiceSample,
  type F32,
  type SampleInfo,
} from "../shared/wav.js";

export const TARGET_RATE = 24_000;
export const MAX_RECORD_SEC = 10;
export const MAX_SAMPLE_SEC = 8;
export const MIN_SAMPLE_SEC = 1;
export const IDEAL_MIN_SEC = 4;
export const MAX_FILE_BYTES = 60 * 1024 * 1024;

/** A user-facing problem with a sample (shown inline, not as a crash). */
export class SampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleError";
  }
}

export interface VoiceSample {
  samples: F32;
  sampleRate: number;
  info: SampleInfo;
  wav: Uint8Array<ArrayBuffer>;
  base64: string;
  /** Object URL of the WAV for previews — revoke with disposeSample(). */
  url: string;
  peaks: F32;
  /** Where it came from: a file name or "Recording". */
  source: string;
}

export function disposeSample(sample: VoiceSample | null): void {
  if (sample) URL.revokeObjectURL(sample.url);
}

// ─── Decode + resample ───────────────────────────────────────────────────────

const AUDIO_EXT = /\.(wav|wave|mp3|m4a|mp4|aac|ogg|oga|opus|webm|flac|aiff?|caf)$/i;

export function looksLikeAudio(file: File): boolean {
  return file.type.startsWith("audio/") || (file.type === "" && AUDIO_EXT.test(file.name)) || AUDIO_EXT.test(file.name);
}

/** Decode any browser-supported audio file into float channels. */
export async function decodeAudioFile(file: Blob): Promise<{ channels: F32[]; sampleRate: number }> {
  if (file.size > MAX_FILE_BYTES) throw new SampleError("That file is too large — use a clip under 60 MB.");
  const bytes = await file.arrayBuffer();
  // Decoding on a 24 kHz offline context has the browser's decoder resample for us.
  const ctx = new OfflineAudioContext(1, 1, TARGET_RATE);
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(bytes);
  } catch {
    throw new SampleError("Couldn't read that file. Try a WAV, MP3, M4A, or OGG recording.");
  }
  const channels: F32[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  return { channels, sampleRate: audio.sampleRate };
}

/** Resample mono audio with an OfflineAudioContext (the browser's high-quality resampler). */
export async function resampleMono(samples: F32, fromRate: number, toRate = TARGET_RATE): Promise<F32> {
  if (Math.round(fromRate) === toRate || samples.length === 0) return samples;
  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const ctx = new OfflineAudioContext(1, outLength, toRate);
  const buffer = ctx.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Full pipeline: downmix → 24 kHz → trim → best ≤ 8 s → normalize → WAV. */
export async function buildVoiceSample(channels: readonly Float32Array[], sampleRate: number, source: string): Promise<VoiceSample> {
  const mono = downmix(channels);
  if (mono.length < sampleRate * 0.25) throw new SampleError("That clip is too short — record 4–8 seconds of speech.");
  const at24k = await resampleMono(mono, sampleRate, TARGET_RATE);
  const prepared = prepareVoiceSample(at24k, TARGET_RATE, { maxSec: MAX_SAMPLE_SEC, targetPeakDb: -1 });
  if (prepared.info.silent) throw new SampleError("We couldn't hear any speech in that clip. Check your mic or try another file.");
  if (prepared.info.finalSec < MIN_SAMPLE_SEC)
    throw new SampleError("There's less than a second of speech — record 4–8 seconds of natural talking.");
  const wav = encodeWav16(prepared.samples, TARGET_RATE);
  return {
    samples: prepared.samples,
    sampleRate: TARGET_RATE,
    info: prepared.info,
    wav,
    base64: bytesToBase64(wav),
    url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })),
    peaks: computePeaks(prepared.samples, 720),
    source,
  };
}

// ─── Mic recorder ────────────────────────────────────────────────────────────

const RECORDER_WORKLET = `
class TrinitySampleRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        if (this.n > 0) this.port.postMessage(this.buf.slice(0, this.n));
        this.n = 0;
        this.port.postMessage("flushed");
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("trinity-sample-recorder", TrinitySampleRecorder);
`;

export interface RecorderEvents {
  /** ~60×/s while recording: RMS and peak of the latest audio (0..1). */
  onLevel?: (rms: number, peak: number) => void;
  /** Elapsed seconds, ~60×/s. */
  onTick?: (elapsedSec: number) => void;
  /** Fired once when the time limit is reached; the owner should call stop(). */
  onLimit?: () => void;
}

/** Records raw mono PCM from the microphone. */
export class MicRecorder {
  static get supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode === "function" &&
      typeof AudioContext === "function"
    );
  }

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private raf = 0;
  private limitTimer = 0;
  private limitFired = false;
  private flushed: (() => void) | null = null;
  private workletUrl: string | null = null;
  private cancelled = false;
  /** start() finished setting up (ctx is set earlier, while it still awaits the worklet). */
  private live = false;

  constructor(private readonly events: RecorderEvents = {}) {}

  /** Capturing — false while start() is still setting up, so a stop click then can't race it. */
  get recording(): boolean {
    return this.live;
  }

  /** Ask for the mic and start capturing. Rejects with a SampleError users can read. */
  async start(): Promise<void> {
    if (this.ctx) return;
    this.cancelled = false;
    if (!MicRecorder.supported) throw new SampleError("This browser can't record audio here — upload a file instead.");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: false },
      });
      // cancel() may have been called while the permission prompt was open.
      if (this.cancelled) {
        this.cleanup();
        throw new SampleError("Recording was cancelled.");
      }
    } catch (err) {
      if (err instanceof SampleError) throw err;
      const name = (err as DOMException)?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError")
        throw new SampleError("Microphone access was blocked. Allow it from the address bar, or upload a file instead.");
      if (name === "NotFoundError" || name === "OverconstrainedError")
        throw new SampleError("No microphone was found. Plug one in, or upload a file instead.");
      throw new SampleError("Couldn't start the microphone. Try again, or upload a file instead.");
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.workletUrl = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(this.workletUrl);
      if (this.cancelled || !this.stream) throw new SampleError("Recording was cancelled.");
      const src = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, "trinity-sample-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      node.port.onmessage = (e: MessageEvent) => {
        if (e.data instanceof Float32Array) this.chunks.push(e.data);
        else if (e.data === "flushed") this.flushed?.();
      };
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(node);
      src.connect(analyser);
      // Keep the worklet pulled without playing the mic back.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      this.node = node;
      this.analyser = analyser;
      if (ctx.state === "suspended") await ctx.resume();
      if (this.cancelled || this.ctx !== ctx) throw new SampleError("Recording was cancelled.");
      this.chunks = [];
      this.limitFired = false;
      this.startedAt = performance.now();
      this.raf = requestAnimationFrame(this.loop);
      // rAF pauses in background tabs; a timer guarantees the auto-stop still happens.
      this.limitTimer = window.setTimeout(() => this.fireLimit(), MAX_RECORD_SEC * 1000 + 60);
      this.live = true;
    } catch (err) {
      this.cleanup();
      throw err instanceof SampleError ? err : new SampleError("Couldn't start recording in this browser.");
    }
  }

  private readonly loop = (): void => {
    if (!this.ctx || !this.analyser) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let acc = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      acc += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    this.events.onLevel?.(Math.sqrt(acc / buf.length), peak);
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.events.onTick?.(Math.min(elapsed, MAX_RECORD_SEC));
    if (elapsed >= MAX_RECORD_SEC) this.fireLimit();
    if (this.ctx) this.raf = requestAnimationFrame(this.loop);
  };

  private fireLimit(): void {
    if (this.limitFired || !this.ctx) return;
    this.limitFired = true;
    this.events.onLimit?.();
  }

  /** Stop and return everything captured. */
  async stop(): Promise<{ samples: F32; sampleRate: number; durationSec: number }> {
    const ctx = this.ctx;
    if (!this.live || !ctx || !this.node) {
      // A start() still setting up is aborted (it checks `cancelled`), so it can't leave the mic open.
      this.cancel();
      throw new SampleError("Not recording.");
    }
    const rate = ctx.sampleRate;
    // Drain the worklet's partial buffer (with a safety timeout).
    await new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, 400);
      this.flushed = () => {
        window.clearTimeout(t);
        resolve();
      };
      this.node?.port.postMessage("flush");
    });
    const chunks = this.chunks;
    this.cleanup();
    let total = 0;
    for (const c of chunks) total += c.length;
    // Respect the time limit exactly (the flush may add a few ms).
    const limit = Math.round(rate * MAX_RECORD_SEC);
    const samples = new Float32Array(Math.min(total, limit));
    let off = 0;
    for (const c of chunks) {
      if (off >= samples.length) break;
      const take = Math.min(c.length, samples.length - off);
      samples.set(c.subarray(0, take), off);
      off += take;
    }
    return { samples, sampleRate: rate, durationSec: samples.length / rate };
  }

  /** Stop without keeping anything (also aborts a start() that is still waiting for the mic). */
  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    this.live = false;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.limitTimer);
    this.flushed = null;
    try {
      this.node?.port.close();
      this.node?.disconnect();
    } catch {
      /* already gone */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.analyser = null;
    this.workletUrl = null;
    this.chunks = [];
  }
}

// ─── Waveform drawing ────────────────────────────────────────────────────────

export interface WaveStyle {
  bar: string;
  barPlayed: string;
  live: string;
  guide: string;
  playhead: string;
}

function readStyle(canvas: HTMLCanvasElement): WaveStyle {
  const cs = getComputedStyle(canvas);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bar: v("--wave-bar", "#7c6cf0"),
    barPlayed: v("--wave-played", "#22d3ee"),
    live: v("--wave-live", "#f87171"),
    guide: v("--wave-guide", "rgba(148,148,180,.25)"),
    playhead: v("--wave-head", "#e9e9f2"),
  };
}

/** Match the canvas backing store to its CSS size × devicePixelRatio. Returns CSS size. */
function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D } | null {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { w, h, ctx };
}

function roundedBar(ctx: CanvasRenderingContext2D, x: number, mid: number, width: number, half: number): void {
  const hh = Math.max(1, half);
  const r = Math.min(width / 2, hh);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, mid - hh, width, hh * 2, r);
  else ctx.rect(x, mid - hh, width, hh * 2);
  ctx.fill();
}

/** Draw a finished sample as mirrored bars; `progress` (0..1) tints the played part. */
export function drawWaveform(canvas: HTMLCanvasElement, peaks: Float32Array | null, progress = -1): void {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { w, h, ctx } = fit;
  const style = readStyle(canvas);
  const mid = h / 2;
  const barW = 2;
  const gap = 1.5;
  const count = Math.max(1, Math.floor((w - 16) / (barW + gap)));
  const x0 = (w - count * (barW + gap) + gap) / 2;

  if (!peaks || peaks.length < 2) {
    ctx.fillStyle = style.guide;
    for (let i = 0; i < count; i++) roundedBar(ctx, x0 + i * (barW + gap), mid, barW, 1);
    return;
  }
  const buckets = peaks.length / 2;
  let max = 0.0001;
  for (let i = 0; i < peaks.length; i++) max = Math.max(max, Math.abs(peaks[i]!));
  const usable = mid - 6;
  for (let i = 0; i < count; i++) {
    const b0 = Math.floor((i / count) * buckets);
    const b1 = Math.max(b0 + 1, Math.floor(((i + 1) / count) * buckets));
    let amp = 0;
    for (let b = b0; b < b1 && b < buckets; b++) {
      amp = Math.max(amp, Math.abs(peaks[b * 2]!), Math.abs(peaks[b * 2 + 1]!));
    }
    const norm = Math.pow(amp / max, 0.8);
    const x = x0 + i * (barW + gap);
    ctx.fillStyle = progress >= 0 && i / count <= progress ? style.barPlayed : style.bar;
    roundedBar(ctx, x, mid, barW, Math.max(1, norm * usable));
  }
  if (progress >= 0 && progress <= 1) {
    const px = x0 + progress * (count * (barW + gap) - gap);
    ctx.fillStyle = style.playhead;
    ctx.fillRect(Math.round(px), 6, 1.5, h - 12);
  }
}

/** Draw a live recording: bars fill left → right, the full width spanning the time limit. */
export function drawLiveLevels(canvas: HTMLCanvasElement, levels: readonly number[], elapsedSec: number, limitSec: number): void {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { w, h, ctx } = fit;
  const style = readStyle(canvas);
  const mid = h / 2;
  const barW = 2;
  const gap = 1.5;
  const count = Math.max(1, Math.floor((w - 16) / (barW + gap)));
  const x0 = (w - count * (barW + gap) + gap) / 2;
  const usable = mid - 6;
  // Time axis: the full canvas spans the recording limit.
  const filled = Math.min(count, Math.round((elapsedSec / limitSec) * count));
  for (let i = 0; i < count; i++) {
    const x = x0 + i * (barW + gap);
    if (i >= filled) {
      ctx.fillStyle = style.guide;
      roundedBar(ctx, x, mid, barW, 1);
      continue;
    }
    const from = Math.floor((i / Math.max(1, filled)) * levels.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / Math.max(1, filled)) * levels.length));
    let lvl = 0;
    for (let k = from; k < to && k < levels.length; k++) lvl = Math.max(lvl, levels[k] ?? 0);
    // Speech RMS sits around 0.02–0.3; a gentle log scale reads well.
    const norm = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(lvl, 1e-5)) + 60) / 54));
    ctx.fillStyle = style.live;
    roundedBar(ctx, x, mid, barW, Math.max(1, norm * usable));
  }
}
