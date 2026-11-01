// "Create a voice": upload (drag-and-drop or picker) or record from the mic,
// process in the browser (24 kHz mono, trimmed, best ≤ 8 s, normalized, 16-bit
// WAV), review with a waveform + preview, name it, and save to the engine,
// which syncs it to the GPU pod.

import { ApiError, api, type CreateVoiceResult, type PodStatus } from "./api.js";
import { player } from "./player.js";
import {
  IDEAL_MIN_SEC,
  MAX_RECORD_SEC,
  MAX_SAMPLE_SEC,
  MicRecorder,
  SampleError,
  buildVoiceSample,
  decodeAudioFile,
  disposeSample,
  drawLiveLevels,
  drawWaveform,
  looksLikeAudio,
  type VoiceSample,
} from "./sample.js";
import {
  button,
  field,
  fmtClock,
  fmtSeconds,
  h,
  icon,
  setButtonLabel,
  setChildren,
  setIcon,
  withBusy,
  type FieldParts,
} from "./ui.js";

type Busy = "idle" | "processing" | "recording" | "saving";

export interface CreatePanelHandlers {
  /** A voice was stored (synced or not). */
  saved(result: CreateVoiceResult): void;
  /** A voice's sync state changed via the panel's Retry button. */
  synced(slug: string): void;
}

/** "my_voice-take2.wav" → "My voice take2". */
export function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return "";
  const nice = base.charAt(0).toUpperCase() + base.slice(1);
  return nice.slice(0, 40).trim();
}

export class CreateVoicePanel {
  readonly el: HTMLElement;

  private sample: VoiceSample | null = null;
  private recorder: MicRecorder | null = null;
  private levels: number[] = [];
  private elapsed = 0;
  private busy: Busy = "idle";
  private available = true;
  private previewRaf = 0;
  private dragDepth = 0;

  private readonly fileInput: HTMLInputElement;
  private readonly dropzone: HTMLLabelElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly recTitle: HTMLDivElement;
  private readonly recTime: HTMLSpanElement;
  private readonly meterMask: HTMLSpanElement;
  private readonly sourceError: HTMLDivElement;
  private readonly sourceCol: HTMLDivElement;
  private readonly reviewCol: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly waveEmpty: HTMLDivElement;
  private readonly waveWrap: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly notes: HTMLDivElement;
  private readonly previewBtn: HTMLButtonElement;
  private readonly discardBtn: HTMLButtonElement;
  private readonly nameInput: HTMLInputElement;
  private readonly nameField: FieldParts;
  private readonly saveBtn: HTMLButtonElement;
  private readonly availNote: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly handlers: CreatePanelHandlers) {
    // ── Source column ──
    this.fileInput = h("input", {
      type: "file",
      accept: "audio/*,.wav,.mp3,.m4a,.ogg,.oga,.opus,.webm,.flac,.aac",
      class: "visually-hidden",
      tabIndex: -1,
      "aria-hidden": "true",
    });
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) void this.useFile(file);
    });
    this.dropzone = h(
      "label",
      { class: "dropzone", tabIndex: 0, role: "button", "aria-label": "Upload an audio file" },
      h("span", { class: "dz-icon" }, icon("upload")),
      h("span", { class: "dz-title" }, "Drop an audio file here"),
      h("span", { class: "dz-sub" }, "or ", h("span", { class: "dz-link" }, "browse your files"), " — WAV, MP3, M4A, OGG"),
      this.fileInput,
    );
    this.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (this.busy === "idle") this.fileInput.click();
      }
    });
    this.dropzone.addEventListener("click", (e) => {
      if (this.busy !== "idle") e.preventDefault();
    });

    this.recBtn = h(
      "button",
      { class: "rec-btn", type: "button", "aria-label": "Start recording", onclick: () => void this.toggleRecord() },
      icon("record"),
    );
    this.recTitle = h("div", { class: "rec-title" }, "Record from your mic");
    this.recTime = h("span", { class: "rec-time" }, fmtClock(0));
    this.meterMask = h("span", { class: "meter-mask" });
    const recorder = h(
      "div",
      { class: "recorder" },
      this.recBtn,
      h(
        "div",
        { class: "rec-info" },
        this.recTitle,
        h("div", { class: "rec-sub" }, this.recTime, h("span", { class: "rec-limit" }, ` / ${fmtClock(MAX_RECORD_SEC)} max`)),
        h("div", { class: "meter", "aria-hidden": "true" }, this.meterMask),
      ),
    );
    if (!MicRecorder.supported) {
      this.recBtn.disabled = true;
      this.recTitle.textContent = "Recording isn't supported in this browser";
    }
    this.sourceError = h("div", { class: "notice notice-error", role: "alert", hidden: true });
    this.sourceCol = h(
      "div",
      { class: "create-col create-source" },
      h("div", { class: "step-label" }, h("span", { class: "step-num" }, "1"), "Add a sample"),
      this.dropzone,
      h("div", { class: "or", role: "separator" }, h("span", null, "or")),
      recorder,
      this.sourceError,
      h(
        "p",
        { class: "tip" },
        icon("info"),
        h("span", null, h("strong", null, "4–8 seconds"), " of clear, natural speech, no music or background noise."),
      ),
    );

    // ── Review column ──
    this.canvas = h("canvas", { class: "wave", role: "img", "aria-label": "Waveform of the voice sample" });
    this.waveEmpty = h("div", { class: "wave-empty" }, icon("waveform"), h("span", null, "Your sample will appear here"));
    this.waveWrap = h("div", { class: "wave-wrap", title: "Click to preview" }, this.canvas, this.waveEmpty);
    this.waveWrap.addEventListener("click", () => {
      if (this.sample && this.busy === "idle") this.togglePreview();
    });
    this.meta = h("div", { class: "sample-meta" });
    this.notes = h("div", { class: "sample-notes" });
    this.previewBtn = button("Preview", { icon: "play", disabled: true, onclick: () => this.togglePreview() });
    this.discardBtn = button("Discard", { icon: "trash", variant: "ghost", disabled: true, onclick: () => this.discard() });
    this.nameInput = h("input", {
      class: "input",
      placeholder: "e.g. Ryan, Narrator, Grumpy Dwarf",
      maxLength: 48,
      autocomplete: "off",
      spellcheck: false,
      disabled: true,
    });
    this.nameInput.addEventListener("input", () => this.nameField.setError(null));
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.save();
      }
    });
    this.nameField = field({
      label: "Voice name",
      control: this.nameInput,
      hint: "How it appears in the persona voice picker.",
    });
    this.saveBtn = button("Save voice", { icon: "check", variant: "primary", disabled: true, onclick: () => void this.save() });
    this.availNote = h(
      "div",
      { class: "notice notice-info", hidden: true },
      icon("info"),
      h(
        "span",
        null,
        "Saving custom voices needs the engine's voice library, which isn't available yet. You can still try the recorder and preview the result.",
      ),
    );
    this.result = h("div", { class: "save-result", "aria-live": "polite", hidden: true });

    this.reviewCol = h(
      "div",
      { class: "create-col create-review is-empty" },
      h("div", { class: "step-label" }, h("span", { class: "step-num" }, "2"), "Review & save"),
      this.waveWrap,
      this.meta,
      this.notes,
      h("div", { class: "review-actions" }, this.previewBtn, this.discardBtn),
      this.nameField.el,
      h("div", { class: "save-row" }, this.saveBtn),
      this.availNote,
      this.result,
    );

    this.el = h(
      "div",
      { class: "card create-card" },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "card-icon" }, icon("mic")),
        h(
          "div",
          { class: "card-head-text" },
          h("h2", { class: "card-title" }, "Create a voice"),
          h(
            "p",
            { class: "card-sub" },
            "Clone a voice from a short sample. It's converted to 24 kHz mono, trimmed, and kept to the best 8 seconds so calls still connect quickly.",
          ),
        ),
      ),
      h("div", { class: "create-grid" }, this.sourceCol, this.reviewCol),
    );

    // Drag & drop anywhere on the card.
    this.el.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.dragDepth++;
      this.dropzone.classList.add("is-over");
    });
    this.el.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = this.busy === "idle" ? "copy" : "none";
    });
    this.el.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (!this.dragDepth) this.dropzone.classList.remove("is-over");
    });
    this.el.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.dragDepth = 0;
      this.dropzone.classList.remove("is-over");
      const file = e.dataTransfer?.files?.[0];
      if (file && this.busy === "idle") void this.useFile(file);
    });

    this.resizeObserver = new ResizeObserver(() => this.redraw());
    this.resizeObserver.observe(this.canvas);
    this.redraw();
    this.renderMeta();
  }

  // ── Public ──

  /** Whether the engine can store custom voices. */
  setAvailable(available: boolean, pod: PodStatus | null): void {
    this.available = available;
    this.availNote.hidden = available;
    this.el.dataset.pod = pod ? (pod.configured ? "configured" : "unconfigured") : "unknown";
    this.updateControls();
  }

  /** The panel became visible: size the waveform canvas to its real layout. */
  onShown(): void {
    requestAnimationFrame(() => this.redraw());
  }

  /** A processed sample exists that hasn't been saved. */
  hasUnsavedSample(): boolean {
    return Boolean(this.sample) || this.busy === "recording";
  }

  /** Stop recording / playback (e.g. when the section is hidden). */
  stopAll(): void {
    if (this.recorder) {
      this.recorder.cancel();
      this.recorder = null;
      this.setBusy("idle");
      this.recTime.textContent = fmtClock(0);
      this.updateMeter(0);
      this.redraw();
    }
    if (this.sample && player.isPlaying(this.sample.url)) player.stop();
  }

  /** Feed a file programmatically (same path as drag-and-drop). */
  async useFile(file: File): Promise<void> {
    if (this.busy !== "idle") return;
    if (!looksLikeAudio(file)) {
      this.showSourceError("That doesn't look like an audio file. Try a WAV, MP3, M4A, or OGG.");
      return;
    }
    this.showSourceError(null);
    this.setBusy("processing");
    try {
      const { channels, sampleRate } = await decodeAudioFile(file);
      const sample = await buildVoiceSample(channels, sampleRate, file.name);
      this.setSample(sample);
      if (!this.nameInput.value.trim()) this.nameInput.value = nameFromFile(file.name);
    } catch (err) {
      this.showSourceError(err instanceof SampleError ? err.message : "Something went wrong while reading that file.");
    } finally {
      this.setBusy("idle");
    }
  }

  // ── Recording ──

  private async toggleRecord(): Promise<void> {
    // `recording` is only true once start() has resolved: a click while the mic is still starting
    // falls through to the busy check below and is ignored (stopping then would race the setup).
    if (this.recorder?.recording) {
      await this.finishRecording();
      return;
    }
    if (this.busy !== "idle") return;
    player.stop();
    this.showSourceError(null);
    this.levels = [];
    this.elapsed = 0;
    const rec = new MicRecorder({
      onLevel: (rms, peak) => {
        this.levels.push(rms);
        this.updateMeter(peak);
      },
      onTick: (sec) => {
        this.elapsed = sec;
        this.recTime.textContent = fmtClock(sec);
        drawLiveLevels(this.canvas, this.levels, sec, MAX_RECORD_SEC);
      },
      onLimit: () => void this.finishRecording(),
    });
    this.recorder = rec;
    this.setBusy("recording");
    try {
      await rec.start();
      this.waveEmpty.hidden = true;
    } catch (err) {
      if (this.recorder !== rec) return; // cancelled by stopAll() while the mic prompt was open
      this.recorder = null;
      this.setBusy("idle");
      this.showSourceError(err instanceof SampleError ? err.message : "Couldn't start recording.");
    }
  }

  private async finishRecording(): Promise<void> {
    const rec = this.recorder;
    if (!rec || !rec.recording) return;
    this.recorder = null;
    this.setBusy("processing");
    this.updateMeter(0);
    try {
      const { samples, sampleRate } = await rec.stop();
      const sample = await buildVoiceSample([samples], sampleRate, "Recording");
      this.setSample(sample);
    } catch (err) {
      this.showSourceError(err instanceof SampleError ? err.message : "Couldn't process the recording.");
      this.redraw();
    } finally {
      this.setBusy("idle");
    }
  }

  private updateMeter(peak: number): void {
    // Peak in dBFS mapped onto the meter: -54 dB → empty, 0 dB → full.
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    const pct = Math.max(0, Math.min(100, ((db + 54) / 54) * 100));
    this.meterMask.style.width = `${100 - pct}%`;
  }

  // ── Sample state ──

  private setSample(sample: VoiceSample): void {
    player.stop();
    disposeSample(this.sample);
    this.sample = sample;
    this.result.hidden = true;
    this.renderMeta();
    this.redraw();
    this.updateControls();
    if (!this.nameInput.disabled) {
      this.nameInput.focus({ preventScroll: true });
      this.nameInput.select();
    }
  }

  private discard(): void {
    if (this.sample && player.isPlaying(this.sample.url)) player.stop();
    disposeSample(this.sample);
    this.sample = null;
    this.renderMeta();
    this.redraw();
    this.updateControls();
  }

  private renderMeta(): void {
    const s = this.sample;
    this.reviewCol.classList.toggle("is-empty", !s);
    this.waveEmpty.hidden = Boolean(s) || this.busy === "recording";
    if (!s) {
      setChildren(this.meta);
      setChildren(this.notes);
      return;
    }
    const i = s.info;
    const trimmed = i.leadTrimSec + i.tailTrimSec;
    setChildren(
      this.meta,
      h("span", { class: "sample-dur" }, fmtSeconds(i.finalSec)),
      h("span", { class: "chip" }, "24 kHz · mono · 16-bit"),
      trimmed >= 0.05 ? h("span", { class: "chip" }, `Trimmed ${fmtSeconds(trimmed)} of silence`) : null,
      Math.abs(i.gainDb) >= 0.5
        ? h("span", { class: "chip" }, i.gainDb > 0 ? `Boosted ${i.gainDb.toFixed(1)} dB` : `Lowered ${(-i.gainDb).toFixed(1)} dB`)
        : null,
      h("span", { class: "chip chip-muted", title: s.source }, s.source === "Recording" ? "Recording" : s.source),
    );
    const notes: HTMLElement[] = [];
    if (i.truncated)
      notes.push(
        note(
          "info",
          `Kept the first ${fmtSeconds(i.finalSec)} of speech, cut at a pause (${fmtSeconds(i.cutSec)} left out) — samples are capped at ${MAX_SAMPLE_SEC} s so calls connect quickly.`,
        ),
      );
    if (i.finalSec < IDEAL_MIN_SEC) notes.push(note("warn", "A little short — 4–8 seconds of speech captures a voice best."));
    if (i.peakDb > -0.3) notes.push(note("warn", "The input may be clipped (too loud). Back away from the mic a little if it sounds harsh."));
    if (i.gainDb > 18) notes.push(note("warn", "This was very quiet and has been boosted, which can add hiss. Move closer to the mic if you can."));
    setChildren(this.notes, notes);
  }

  private updateControls(): void {
    const has = Boolean(this.sample);
    const idle = this.busy === "idle";
    this.previewBtn.disabled = !has || !idle;
    this.discardBtn.disabled = !has || !idle;
    this.nameInput.disabled = !has || this.busy === "saving";
    this.saveBtn.disabled = !has || !idle || !this.available;
    this.saveBtn.title = !this.available ? "The voice library isn't available on this engine yet" : "";
  }

  private setBusy(busy: Busy): void {
    this.busy = busy;
    const recording = busy === "recording";
    this.recBtn.classList.toggle("is-recording", recording);
    setIcon(this.recBtn, recording ? "stop" : "record");
    this.recBtn.setAttribute("aria-label", recording ? "Stop recording" : "Start recording");
    this.recBtn.disabled = !MicRecorder.supported || (busy !== "idle" && !recording);
    this.recTitle.textContent = recording
      ? "Recording… tap to stop"
      : busy === "processing"
        ? "Processing…"
        : MicRecorder.supported
          ? "Record from your mic"
          : "Recording isn't supported in this browser";
    this.sourceCol.classList.toggle("is-recording", recording);
    this.dropzone.classList.toggle("is-disabled", busy !== "idle");
    this.dropzone.setAttribute("aria-disabled", String(busy !== "idle"));
    this.el.classList.toggle("is-processing", busy === "processing");
    if (!recording && busy !== "processing") this.recTime.textContent = fmtClock(this.sample && this.elapsed ? this.elapsed : 0);
    this.waveEmpty.hidden = Boolean(this.sample) || recording;
    this.updateControls();
  }

  private showSourceError(message: string | null): void {
    this.sourceError.hidden = !message;
    setChildren(this.sourceError, message ? [icon("alert"), h("span", null, message)] : []);
  }

  // ── Preview ──

  private togglePreview(): void {
    const s = this.sample;
    if (!s) return;
    player.toggle(s.url, (playing) => {
      setButtonLabel(this.previewBtn, playing ? "Stop" : "Preview");
      setIcon(this.previewBtn, playing ? "stop" : "play");
      this.waveWrap.classList.toggle("is-playing", playing);
      cancelAnimationFrame(this.previewRaf);
      if (playing) this.previewRaf = requestAnimationFrame(this.tickPreview);
      else this.redraw();
    });
  }

  private readonly tickPreview = (): void => {
    const s = this.sample;
    const audio = player.current;
    if (!s || !audio || !player.isPlaying(s.url)) return;
    const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : s.info.finalSec;
    drawWaveform(this.canvas, s.peaks, Math.min(1, audio.currentTime / d));
    this.previewRaf = requestAnimationFrame(this.tickPreview);
  };

  private redraw(): void {
    if (this.busy === "recording") {
      drawLiveLevels(this.canvas, this.levels, this.elapsed, MAX_RECORD_SEC);
      return;
    }
    drawWaveform(this.canvas, this.sample?.peaks ?? null);
  }

  // ── Save ──

  private async save(): Promise<void> {
    const s = this.sample;
    if (!s || this.busy !== "idle") return;
    if (!this.available) {
      this.nameField.setError("Saving needs the voice library, which isn't available on this engine yet.");
      return;
    }
    const name = this.nameInput.value.trim();
    if (!name) {
      this.nameField.setError("Give the voice a name.");
      this.nameInput.focus();
      return;
    }
    this.nameField.setError(null);
    player.stop();
    this.setBusy("saving");
    try {
      const r = await withBusy(this.saveBtn, () => api.voices.create(name, s.base64), "Saving…");
      disposeSample(this.sample);
      this.sample = null;
      this.nameInput.value = "";
      this.elapsed = 0;
      this.renderMeta();
      this.redraw();
      this.showResult(r);
      this.handlers.saved(r);
    } catch (err) {
      this.showFailure(err instanceof ApiError ? err.message : "Couldn't save the voice.");
    } finally {
      this.setBusy("idle");
    }
  }

  private showResult(r: CreateVoiceResult): void {
    this.result.hidden = false;
    const name = r.voice.name;
    if (r.synced) {
      setChildren(
        this.result,
        h(
          "div",
          { class: "notice notice-ok" },
          icon("check"),
          h(
            "span",
            null,
            h("strong", null, `“${name}” is ready`),
            " — saved and synced to the GPU pod. ",
            h("a", { href: `#personas` }, "Assign it to a persona →"),
          ),
        ),
      );
      return;
    }
    const retry = button("Retry sync", { icon: "refresh", size: "sm" });
    retry.addEventListener("click", () => void this.retrySync(r, retry));
    setChildren(
      this.result,
      h(
        "div",
        { class: "notice notice-warn" },
        icon("alert"),
        h(
          "span",
          null,
          h("strong", null, `“${name}” is saved locally`),
          `, but syncing it to the GPU pod failed${r.syncError ? `: ${r.syncError.trim().replace(/[.!]?$/, ".")}` : "."} `,
          "It will be uploaded again before a call that needs it.",
        ),
        retry,
      ),
    );
  }

  private async retrySync(r: CreateVoiceResult, btn: HTMLButtonElement): Promise<void> {
    try {
      const res = await withBusy(btn, () => api.voices.sync(r.voice.slug), "Syncing…");
      this.handlers.synced(r.voice.slug);
      this.showResult({ ...r, synced: res.synced, syncError: res.error });
    } catch {
      /* reported by the API helper */
    }
  }

  private showFailure(message: string): void {
    this.result.hidden = false;
    setChildren(this.result, h("div", { class: "notice notice-error" }, icon("alert"), h("span", null, `Couldn't save the voice: ${message}`)));
  }
}

function hasFiles(e: DragEvent): boolean {
  return Boolean(e.dataTransfer && [...e.dataTransfer.types].includes("Files"));
}

function note(tone: "info" | "warn", text: string): HTMLElement {
  return h("div", { class: `notice notice-${tone} notice-compact` }, icon(tone === "warn" ? "alert" : "info"), h("span", null, text));
}
