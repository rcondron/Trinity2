// One shared audio player for the settings page, so only one preview plays at a
// time. Each play() gets a state callback (playing → true/false) that drives the
// user's ▶/■ button; starting another preview stops the previous one.

import { toast } from "./ui.js";

type StateFn = (playing: boolean) => void;

class Player {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private onState: StateFn | null = null;

  /** The element currently playing (for progress displays), if any. */
  get current(): HTMLAudioElement | null {
    return this.audio;
  }

  isPlaying(url?: string): boolean {
    return Boolean(this.audio) && (url === undefined || this.url === url);
  }

  async play(url: string, onState?: StateFn): Promise<void> {
    this.stop();
    const audio = new Audio(url);
    audio.preload = "auto";
    this.audio = audio;
    this.url = url;
    this.onState = onState ?? null;
    audio.addEventListener("ended", () => {
      if (this.audio === audio) this.stop();
    });
    audio.addEventListener("error", () => {
      if (this.audio !== audio) return;
      this.stop();
      toast("Couldn't play that audio — the file may be missing on the engine.", "error");
    });
    onState?.(true);
    try {
      await audio.play();
    } catch (err) {
      if (this.audio !== audio) return; // superseded by another preview
      this.stop();
      if ((err as DOMException)?.name !== "AbortError") toast("Playback was blocked by the browser.", "warn");
    }
  }

  /** Play, or stop if this url is already playing. */
  toggle(url: string, onState?: StateFn): void {
    if (this.isPlaying(url)) this.stop();
    else void this.play(url, onState);
  }

  stop(): void {
    const audio = this.audio;
    const cb = this.onState;
    this.audio = null;
    this.url = null;
    this.onState = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    cb?.(false);
  }
}

export const player = new Player();
