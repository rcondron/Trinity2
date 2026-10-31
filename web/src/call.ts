// Real-time voice call to the engine's /call socket. Streams 16-bit PCM (24 kHz)
// from the mic up, plays PersonaPlex's PCM back, and relays the engine's JSON
// events (caller/agent transcript, decisions, replies, tools) to a handler.
// Ported from the personaplex-toolcall bench.

// AudioWorklets: the mic in 80 ms pieces of 16-bit audio, and a small jitter
// buffer that plays the agent back smoothly.
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
    this.port.onmessage = (e) => { this.q.push(e.data); this.queued += e.data.length; };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    if (!this.playing) { if (this.queued < 3600) return true; this.playing = true; }  // 150 ms cushion
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.q.shift(); this.pos = 0;
        if (!this.cur) { this.playing = false; break; }
      }
      out[i] = this.cur[this.pos++]; this.queued--;
    }
    return true;
  }
}
registerProcessor("mic", Mic);
registerProcessor("speaker", Speaker);`;

export type CallEvent = Record<string, unknown> & { type: string };
export interface CallHandlers {
  onEvent: (ev: CallEvent) => void;
}

export class LiveCall {
  active = false;
  private ctx?: AudioContext;
  private ws?: WebSocket;
  private stream?: MediaStream;
  private speaker?: AudioWorkletNode;

  get supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices && !!window.AudioContext;
  }

  async start(url: string, handlers: CallHandlers): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: 24000 });
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLETS], { type: "text/javascript" })));
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.speaker = new AudioWorkletNode(this.ctx, "speaker", { outputChannelCount: [1] });
    this.speaker.connect(this.ctx.destination);

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (m) => {
      if (typeof m.data !== "string") {
        const pcm = new Int16Array(m.data as ArrayBuffer);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
        this.speaker?.port.postMessage(f, [f.buffer]);
        return;
      }
      const e = JSON.parse(m.data) as CallEvent;
      if (e.type === "ready") this.wireMic();
      handlers.onEvent(e);
      if (e.type === "status" && (e as { error?: boolean }).error) this.stop();
    };
    this.ws.onclose = () => {
      if (this.active) handlers.onEvent({ type: "_closed" });
      this.active = false;
    };
    this.active = true;
  }

  private wireMic() {
    if (!this.ctx || !this.stream) return;
    const mic = new AudioWorkletNode(this.ctx, "mic");
    this.ctx.createMediaStreamSource(this.stream).connect(mic);
    // Keep the node pulling without audibly looping the mic back.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    mic.connect(sink).connect(this.ctx.destination);
    mic.port.onmessage = (a) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(a.data as ArrayBuffer);
    };
  }

  stop(): void {
    this.active = false;
    try {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop" }));
    } catch {
      /* ignore */
    }
    this.ws?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ws = this.ctx = this.stream = this.speaker = undefined;
  }
}
