// Live-voice audio I/O. Captures a turn of mic audio as a WAV data: URI (the
// format PersonaPlex/fal accepts — verified) using the Web Audio API, since
// MediaRecorder only produces WebM/Opus. Also plays back the WAV fal returns.

const TARGET_RATE = 16000; // speech-friendly; keeps the data URI small

export class AudioIO {
  recording = false;
  private ctx?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private stream?: MediaStream;
  private chunks: Float32Array[] = [];
  private rate = TARGET_RATE;
  private current?: HTMLAudioElement;

  get supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)
    );
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Ask for 16kHz directly; some browsers ignore it, so we read back the real rate.
    try { this.ctx = new AC({ sampleRate: TARGET_RATE }); } catch { this.ctx = new AC(); }
    this.rate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    this.recording = true;
  }

  /** Stop and resolve with a WAV `data:` URI of the recorded turn. */
  async stop(): Promise<string> {
    this.recording = false;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    return `data:audio/wav;base64,${encodeWavBase64(flatten(this.chunks), this.rate)}`;
  }

  play(url: string): void {
    this.current?.pause();
    this.current = new Audio(url);
    void this.current.play().catch(() => {});
  }

  stopPlayback(): void {
    this.current?.pause();
    this.current = undefined;
  }
}

// ─── WAV encoding (pure; exported for testing) ────────────────────────────────

export function flatten(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Encode mono Float32 PCM [-1,1] as a 16-bit PCM WAV, base64-encoded. */
export function encodeWavBase64(samples: Float32Array, sampleRate: number): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
