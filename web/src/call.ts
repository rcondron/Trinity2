// Real-time voice call to the engine's /call socket, built for WARM STANDBY:
//   connect()      — open the socket at page load; the engine connects PersonaPlex +
//                    Deepgram in the background (no mic, no audio context yet).
//   startAudio()   — call inside the mic-tap gesture: resumes playback, opens the mic,
//                    and starts streaming 16-bit PCM @ 24 kHz. Instant once warm.
//   stopAudio()    — end the turn-taking (mic off); the session stays warm.
//   sendText()     — a typed turn, spoken back through the same live voice.
// Ported from the personaplex-toolcall bench's worklets.
import { buildVoiceChain, type VoiceChain } from "./voice-chain.js";

const WORKLETS = `
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
    super(); this.q = []; this.cur = null; this.pos = 0; this.queued = 0; this.playing = false;
    this.rate = 1; this.readPos = 0;
    // Audio queued before playback starts: 240 ms, grown by 80 ms each time the queue runs dry mid-phrase
    // (network jitter over the pod's proxy), up to 400 ms — a gap in a word costs more than the delay.
    this.cushion = 5760;
    this.port.onmessage = (e) => {
      if (e.data === "flush") { this.q = []; this.cur = null; this.pos = 0; this.readPos = 0; this.queued = 0; this.playing = false; return; }
      if (e.data && typeof e.data === "object" && e.data.rate != null) {
        var r = Number(e.data.rate); if (isFinite(r) && r >= 0.5 && r <= 2) this.rate = r;
        return;
      }
      this.q.push(e.data); this.queued += e.data.length;
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    if (!this.playing) { if (this.queued < this.cushion) return true; this.playing = true; }
    const step = this.rate > 0 ? this.rate : 1;
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.readPos >= this.cur.length - 1) {
        if (this.cur) this.queued = Math.max(0, this.queued - this.cur.length);
        this.cur = this.q.shift(); this.readPos = 0;
        if (!this.cur) {
          this.playing = false;
          if (i > 0 && this.cushion < 9600) this.cushion += 1920;
          break;
        }
      }
      const idx = Math.floor(this.readPos);
      const frac = this.readPos - idx;
      const a = this.cur[idx] || 0;
      const b = this.cur[Math.min(idx + 1, this.cur.length - 1)] || a;
      out[i] = a + (b - a) * frac;
      this.readPos += step;
    }
    return true;
  }
}
registerProcessor("mic", Mic);
registerProcessor("speaker", Speaker);`;

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
  private speechRate = 1;

  get supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices && !!window.AudioContext;
  }

  /** Playback is set up (a mic tap or a typed turn through the call did it): what the voice says is heard here. */
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
      }
      if (e.type === "speech_rate" && typeof e.rate === "number") this.setSpeechRate(e.rate);
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
      this.speaker.port.postMessage({ rate: this.speechRate });
    }
  }

  /** Run the voice through the clean-up chain, or straight to the speakers (Settings → Voices). */
  setClarity(on: boolean): void {
    this.chain?.setClarity(on);
  }

  /** Playback pace for streamed PersonaPlex PCM (1 = normal). Also used by browser TTS. */
  setSpeechRate(rate: number): void {
    const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
    this.speechRate = r;
    try {
      localStorage.setItem("trinity.speechRate", String(r));
    } catch {
      /* private mode */
    }
    this.speaker?.port.postMessage({ rate: r });
  }

  getSpeechRate(): number {
    return this.speechRate;
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
    this.speaker?.port.postMessage("flush");
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
