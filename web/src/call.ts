// Real-time voice call to the engine's /call socket, built for WARM STANDBY:
//   connect()      — open the socket at page load; the engine connects PersonaPlex +
//                    Deepgram in the background (no mic, no audio context yet).
//   startAudio()   — call inside the mic-tap gesture: resumes playback, opens the mic,
//                    and starts streaming 16-bit PCM @ 24 kHz. Instant once warm.
//   stopAudio()    — end the turn-taking (mic off); the session stays warm.
//   sendText()     — a typed turn, spoken back through the same live voice.
// Ported from the personaplex-toolcall bench's worklets.
import { TimeStretcher } from "./time-stretch.js";
import { buildVoiceChain, type VoiceChain } from "./voice-chain.js";

/**
 * The two worklet processors, as the source of one module. A worklet cannot import from the page, so the
 * time stretcher's class is written into the source as text — it is self-contained for exactly that
 * (see time-stretch.ts). Exported for scripts/test-time-stretch.mts, which runs the Speaker without a browser.
 */
export const WORKLETS = `
const TimeStretcher = ${TimeStretcher.toString()};
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1920); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = Math.max(-1, Math.min(1, ch[i])) * 32767;
      if (this.n === this.buf.length) { const out = this.buf.slice(); this.port.postMessage(out.buffer, [out.buffer]); this.n = 0; }
    }
    return true;
  }
}
class Speaker extends AudioWorkletProcessor {
  constructor() {
    super();
    // Chunks as they arrived; q[0] is used up to "at". "waiting" counts what is left in the queue, "queued"
    // that plus what the stretcher holds unplayed: the backlog, in input samples.
    this.q = []; this.at = 0; this.waiting = 0; this.queued = 0; this.playing = false;
    // Pace without pitch: the queue plays through a time stretcher instead of being resampled.
    // "rate" is the pace asked for, "pace" the one playing now (they differ only while catching up).
    this.ts = new TimeStretcher(sampleRate); this.rate = 1; this.pace = 1;
    // Audio queued before playback starts: 240 ms, grown by 80 ms each time the queue runs dry mid-phrase
    // (network jitter over the pod's proxy), up to 400 ms — a gap in a word costs more than the delay.
    this.cushion = 5760;
    // Catching up with the live stream (feed, steer): input goes to the stretcher 20 ms at a time. "floor" is
    // the stream's noise floor (mean square), "hush" how many samples of silence in a row have gone by,
    // "dropped" how many were left out so far.
    this.block = Math.round(sampleRate * 0.02); this.floor = 1; this.hush = 0;
    this.behind = false; this.rush = false; this.dropped = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.q = []; this.at = 0; this.waiting = 0; this.queued = 0; this.playing = false;
        this.hush = 0; this.behind = false; this.rush = false; this.pace = this.rate;
        this.ts.flush(); this.ts.setRate(this.rate);
        return;
      }
      if (e.data && typeof e.data === "object" && e.data.rate != null) {
        var r = Number(e.data.rate);
        if (isFinite(r) && r >= 0.5 && r <= 2) {
          // At once — unless playback is off the asked pace to catch up, when steer() eases over to it.
          if (this.pace === this.rate) { this.pace = r; this.ts.setRate(r); }
          this.rate = r;
        }
        return;
      }
      this.q.push(e.data); this.waiting += e.data.length; this.queued += e.data.length;
    };
  }
  // Mean square of c[from..to).
  power(c, from, to) {
    let e = 0;
    for (let i = from; i < to; i++) e += c[i] * c[i];
    return to > from ? e / (to - from) : 1;
  }
  // Hand the stretcher input until it can make "need" samples — no further ahead, so the backlog stays in
  // the queue. This is also where lost time is paid back: the pod sends in real time, silence included, and
  // a pace under 1 plays less than arrives. Once behind (steer), the silence of a pause is left out
  // instead of played — after its first 160 ms, and never the block just before sound, so every word still
  // starts from the silence it came with and a short gap inside a phrase is untouched. Speech is never dropped.
  feed(need) {
    const ts = this.ts, q = this.q, size = this.block, enough = this.cushion + 0.1 * sampleRate;
    while (q.length && ts.available() < need) {
      const c = q[0], from = this.at, to = Math.min(c.length, from + size);
      // Silence: under about -55 dBFS — or, if the stream's own floor is noisier than that, within 6 dB of
      // the floor (the quietest block so far, creeping up 6 dB in 10 s), but never over -45 dBFS.
      const p = this.power(c, from, to);
      this.floor = Math.min(p, this.floor * (1 + 0.003 * (to - from) / size) + 1e-9);
      const still = Math.min(3.2e-5, Math.max(3.2e-6, 4 * this.floor));
      let drop = false;
      if (p >= still) {
        this.hush = 0;
        if (this.waiting + ts.pending() <= enough) this.behind = false;
      } else {
        if (this.hush >= 0.16 * sampleRate && this.behind && this.waiting + ts.pending() > enough) {
          drop = (to < c.length ? this.power(c, to, Math.min(c.length, to + size)) : q.length > 1 ? this.power(q[1], 0, Math.min(q[1].length, size)) : 1) < still;
        }
        this.hush += to - from;
      }
      if (drop) this.dropped += to - from; else ts.push(c, from, to);
      this.waiting -= to - from;
      if (to < c.length) this.at = to; else { q.shift(); this.at = 0; }
    }
  }
  // How far behind the live stream playback may get at a pace under 1. More than 300 ms over the cushion:
  // the pauses pay it back (feed). Only if that is not enough — 2.5 s behind — does the pace give way:
  // 1 (and past 4 s, up to 1.15) until the backlog is under a second, then back to the asked pace. The pace
  // moves a little per block (0.3 takes under a second), so neither change is heard as a step.
  // At 1 or faster there is nothing to make up: the queue just runs dry and waits, as it always has.
  steer() {
    const lag = this.queued, sr = sampleRate, slow = this.rate < 1;
    if (slow && lag > this.cushion + 0.3 * sr) this.behind = true;
    if (!slow || lag < sr) this.rush = false; else if (lag > 2.5 * sr) this.rush = true;
    const goal = !this.rush ? this.rate : lag > 4 * sr ? Math.min(1.15, 1 + 0.15 * (lag - 4 * sr) / sr) : 1;
    if (goal !== this.pace) {
      const d = goal - this.pace;
      this.pace = d > 0.002 ? this.pace + 0.002 : d < -0.002 ? this.pace - 0.002 : goal;
      this.ts.setRate(this.pace);
    }
  }
  process(_, outputs) {
    const out = outputs[0][0], ts = this.ts;
    if (!this.playing) { if (this.queued < this.cushion) return true; this.playing = true; }
    this.steer();
    this.feed(out.length);
    let n = ts.pull(out);
    if (n < out.length) {
      // The queue ran dry. The stretcher keeps the last few ms back for look-ahead: they play as they are,
      // then silence until the cushion — a step bigger now — has refilled.
      n += ts.drain(out, n);
      if (n < out.length) {
        this.playing = false;
        if (this.cushion < 9600) this.cushion += 1920;
      }
    }
    this.queued = this.waiting + ts.pending();
    return true;
  }
}
registerProcessor("mic", Mic);
registerProcessor("speaker", Speaker);`;

/**
 * The rate the speaker plays at: the user's own setting times the persona's pace, kept within what the
 * time stretcher takes (0.5–2).
 */
export function playbackRate(speechRate: number, pace: number): number {
  const rate = speechRate * pace;
  return Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1;
}

export type CallEvent = Record<string, unknown> & { type: string };
export type CallState = "idle" | "connecting" | "standby" | "live" | "closed";

export interface CallHandlers {
  onEvent: (ev: CallEvent) => void;
  onState?: (state: CallState) => void;
}

export class LiveCall {
  state: CallState = "idle";
  private ws?: WebSocket;
  private handlers?: CallHandlers;
  private ctx?: AudioContext;
  private workletReady?: Promise<void>;
  private speaker?: AudioWorkletNode;
  private chain?: VoiceChain;
  private stream?: MediaStream;
  private micSource?: MediaStreamAudioSourceNode;
  private mic?: AudioWorkletNode;
  private micSink?: GainNode;
  private micStarting?: Promise<void>;
  private micEpoch = 0; // bumped by teardownMic: a mic still opening then is stale
  private speechRate = 1; // the user's setting
  private pace = 1; // the persona's own pace, from the engine

  get supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices && !!window.AudioContext;
  }

  /**
   * Playback is set up (a tap or key press anywhere on the page, a mic tap or a typed turn did it):
   * what the voice says is heard here. The engine is told ("playback") — it says an unprompted line
   * only where it can be heard, and keeps it (owed) until then.
   */
  get canPlay(): boolean {
    return !!this.speaker && this.ctx?.state === "running";
  }

  /** The socket is open and the engine reported the voice model ready. */
  get ready(): boolean {
    return this.state === "standby" || this.state === "live";
  }

  private setState(s: CallState) {
    if (this.state === s) return;
    this.state = s;
    this.handlers?.onState?.(s);
  }

  /** Open the call socket (warm standby). Safe to call at page load — no permission prompts. */
  connect(url: string, handlers: CallHandlers): void {
    this.close();
    this.handlers = handlers;
    this.setState("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    // Playback set up before this call (a re-warm, a wake): the engine knows at once that it's heard here.
    ws.onopen = () => {
      if (ws === this.ws && this.canPlay) ws.send(JSON.stringify({ type: "playback", on: true }));
    };
    ws.onmessage = (m) => {
      if (ws !== this.ws) return;
      if (typeof m.data !== "string") {
        if (!this.speaker) return; // no playback until the first user gesture
        const pcm = new Int16Array(m.data as ArrayBuffer);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
        this.speaker.port.postMessage(f, [f.buffer]);
        return;
      }
      let e: CallEvent;
      try {
        e = JSON.parse(m.data) as CallEvent;
      } catch {
        return;
      }
      if (e.type === "ready") {
        this.setState(this.stream ? "live" : "standby");
        if (typeof e.speechRate === "number") this.setSpeechRate(e.speechRate);
        if (typeof e.pace === "number") this.setPace(e.pace);
      }
      if (e.type === "speech_rate" && typeof e.rate === "number") this.setSpeechRate(e.rate);
      // The user cut in: what is still queued here must not play out.
      if (e.type === "flush") this.flushPlayback();
      handlers.onEvent(e);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.teardownMic();
      this.setState("closed");
      handlers.onEvent({ type: "_closed" });
    };
  }

  /** Create/resume playback. Must run inside a user gesture (click, key press). */
  async ensurePlayback(): Promise<void> {
    const could = this.canPlay;
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.workletReady = this.ctx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([WORKLETS], { type: "text/javascript" })),
      );
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.workletReady;
    if (!this.speaker) {
      this.speaker = new AudioWorkletNode(this.ctx, "speaker", { outputChannelCount: [1] });
      // Through the clean-up chain (voice-chain.ts): the codec's voice, brought closer; off per browser in Settings → Voices.
      this.chain = buildVoiceChain(this.ctx, this.ctx.destination);
      this.speaker.connect(this.chain.input);
      try {
        const saved = Number(localStorage.getItem("trinity.speechRate"));
        if (Number.isFinite(saved) && saved > 0) this.speechRate = saved;
      } catch {
        /* ignore */
      }
      this.postRate();
    }
    // Heard here from now on: the engine says what it kept for a voice that can be heard.
    if (!could && this.canPlay) this.sendJson({ type: "playback", on: true });
  }

  /** Run the voice through the clean-up chain, or straight to the speakers (Settings → Voices). */
  setClarity(on: boolean): void {
    this.chain?.setClarity(on);
  }

  /**
   * Playback pace for streamed PersonaPlex PCM (1 = normal): the user's setting. Also used by browser TTS.
   * The pace changes, the pitch does not: the speaker worklet time-stretches (time-stretch.ts).
   * What the speaker plays at is this times the persona's own pace (setPace).
   */
  setSpeechRate(rate: number): void {
    const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
    this.speechRate = r;
    try {
      localStorage.setItem("trinity.speechRate", String(r));
    } catch {
      /* private mode */
    }
    this.postRate();
  }

  getSpeechRate(): number {
    return this.speechRate;
  }

  /**
   * The persona's own pace (1 = as the voice comes; a narrator's might be 0.92), 0.5–1.5. The engine sends
   * it with "ready"; it is not remembered here — the user's setting is theirs, and multiplies with it.
   */
  setPace(pace: number): void {
    this.pace = Math.max(0.5, Math.min(1.5, Number(pace) || 1));
    this.postRate();
  }

  /** Tell the speaker the rate to play at: the user's setting times the persona's pace. */
  private postRate(): void {
    this.speaker?.port.postMessage({ rate: playbackRate(this.speechRate, this.pace) });
  }

  /**
   * Drop whatever the speaker still has queued: it is silent from the next audio block. The engine asks
   * for this ({type: "flush"}) when the user cuts in, so the voice stops there instead of playing out.
   */
  flushPlayback(): void {
    this.speaker?.port.postMessage("flush");
  }

  /** Start talking: call from the mic-tap gesture. A tap while the mic is still opening joins that start. */
  startAudio(): Promise<void> {
    if (!this.micStarting) {
      const starting: Promise<void> = this.openMic().finally(() => {
        if (this.micStarting === starting) this.micStarting = undefined;
      });
      this.micStarting = starting;
    }
    return this.micStarting;
  }

  private async openMic(): Promise<void> {
    const epoch = this.micEpoch;
    const stale = () => epoch !== this.micEpoch; // the call closed or the turn ended meanwhile
    await this.ensurePlayback();
    if (stale()) return;
    if (!this.stream) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (stale() || this.stream) {
        stream.getTracks().forEach((t) => t.stop()); // never leave a capture nobody will stop
        return;
      }
      this.stream = stream;
    }
    const ctx = this.ctx!;
    if (!this.mic) {
      this.mic = new AudioWorkletNode(ctx, "mic");
      this.micSource = ctx.createMediaStreamSource(this.stream);
      this.micSource.connect(this.mic);
      // Keep the node pulling without audibly looping the mic back.
      this.micSink = ctx.createGain();
      this.micSink.gain.value = 0;
      this.mic.connect(this.micSink).connect(ctx.destination);
      this.mic.port.onmessage = (a) => {
        if (this.ws?.readyState === WebSocket.OPEN && this.state === "live") this.ws.send(a.data as ArrayBuffer);
      };
    }
    this.sendJson({ type: "mic", on: true });
    if (this.ready) this.setState("live");
  }

  /** End the turn (mic off). The voice session stays warm for the next tap. */
  stopAudio(): void {
    this.sendJson({ type: "mic", on: false });
    this.flushPlayback();
    this.teardownMic();
    if (this.state === "live") this.setState("standby");
  }

  /** A typed turn, handled exactly like speech (and spoken back in the live voice). */
  async sendText(text: string): Promise<void> {
    try {
      await this.ensurePlayback();
    } catch {
      /* playback is optional for typed turns */
    }
    this.sendJson({ type: "text", text });
  }

  close(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        /* ignore */
      }
      ws.onclose = null;
      ws.close();
    }
    this.teardownMic();
    if (this.state !== "idle") this.setState("closed");
  }

  private teardownMic() {
    this.micEpoch++;
    this.micStarting = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    if (this.mic) this.mic.port.onmessage = null;
    this.micSource?.disconnect();
    this.mic?.disconnect();
    this.micSink?.disconnect();
    this.micSource = undefined;
    this.mic = undefined;
    this.micSink = undefined;
  }

  private sendJson(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
