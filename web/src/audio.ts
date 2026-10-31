// Live-voice audio I/O: capture a turn of mic audio (push-to-talk) and play back
// the WAV that PersonaPlex returns. Used only when the engine reports voice=live.

export class AudioIO {
  recording = false;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private stream?: MediaStream;
  private current?: HTMLAudioElement;

  get supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices && "MediaRecorder" in window;
  }

  /** Start capturing; resolves once recording is actually running. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start();
    this.recording = true;
  }

  /** Stop capturing and resolve with a base64 data: URI of the recorded clip. */
  stop(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) return reject(new Error("not recording"));
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || "audio/webm" });
        this.stream?.getTracks().forEach((t) => t.stop());
        this.recording = false;
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      };
      this.recorder.stop();
    });
  }

  play(url: string): void {
    this.current?.pause();
    this.current = new Audio(url);
    void this.current.play().catch(() => { /* autoplay may be blocked until user gesture */ });
  }

  stopPlayback(): void {
    this.current?.pause();
    this.current = undefined;
  }
}
