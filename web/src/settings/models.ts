// Models & API keys: the keys, models, and endpoints behind every part of
// Trinity — her voice, ears, decisions, and the models her tools use (the coding
// skill's GLM and Kimi among them). Cards in order: API keys, Models, Endpoints,
// Live-loop timing. Write-only secrets, per-field "reset to .env default", a
// sticky save bar, and a diff-only PUT. A service-status strip on top shows
// what's live. Settings an older engine doesn't report show as "needs an
// engine update" instead of pretending to save.

import { api, type EndpointsPatch, type ModelCatalog, type PublicEndpoints, type VoiceLibrary } from "./api.js";
import { announce } from "./channel.js";
import { endpointsRes, modelCatalogRes, statusRes, voicesRes } from "./store.js";
import {
  badge,
  button,
  errorState,
  field,
  h,
  icon,
  plural,
  sectionHead,
  segmented,
  setChildren,
  setIcon,
  skeletonBlock,
  skeletonLines,
  toast,
  uid,
  withBusy,
  type FieldParts,
  type IconName,
  type Section,
  type SegmentOption,
} from "./ui.js";

type Kind = "url" | "text" | "model" | "number" | "secret" | "voice" | "choice";

interface FieldDef {
  key: string;
  label: string;
  kind: Kind;
  hint?: string;
  protocols?: string[];
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  list?: string;
  /** For secrets: the `<key>Set` flag in GET /settings/endpoints. */
  flag?: string;
  /** For secrets: calls or tools don't work without it. */
  required?: boolean;
  /** For choices. */
  options?: SegmentOption[];
  /** A note under the field for some values (e.g. a thinking-only model). */
  note?: (value: string) => string | null;
  /** Span the whole row of the card's field grid. */
  wide?: boolean;
}

interface SubgroupDef {
  title: string;
  icon: IconName;
  sub: string;
  fields: FieldDef[];
}

interface GroupDef {
  id: string;
  title: string;
  icon: IconName;
  sub: string;
  services?: string[];
  /** "keys": one row per secret; "grid" (default): a field grid, optionally split into subgroups. */
  layout?: "keys" | "grid";
  fields?: FieldDef[];
  subgroups?: SubgroupDef[];
}

// Suggestions only — every model field takes any id the gateway knows. GET /settings/models adds more.
const TEXT_MODELS = [
  "claude-sonnet-5-5",
  "kimi-k3",
  "z-ai-glm-5-3-flash",
  "z-ai-glm-5-3",
  "qwen3-coder-480b-a35b-instruct-turbo",
  "nvidia-nemotron-3-nano-30b-a3b",
  "gpt-oss-120b",
  "llama-3.3-70b",
];
const CODER_MODELS = [
  "mercury-3",
  "mercury-2-5",
  "kimi-k3",
  "deepseek-v4-flash-0731-fast",
  "qwen3-coder-480b-a35b-instruct-turbo",
  "openai-gpt-54-mini",
  "claude-haiku-5-5",
  "z-ai-glm-5-3-flash",
  "claude-sonnet-5-5",
];
const IMAGE_MODELS = ["krea-2-turbo", "chroma", "grok-imagine-image", "flux-2-pro"];
const TTS_MODELS = ["tts-kokoro", "elevenlabs-tts-v4", "elevenlabs-tts-v4-turbo", "tts-chatterbox-hd", "tts-inworld-1-5-max", "tts-minimax-speech-02-hd", "tts-orpheus"];
/** Kokoro's voice names (other models take their own ids). */
const TTS_VOICES = ["af_heart", "af_bella", "af_nova", "af_sarah", "af_sky", "am_adam", "am_michael", "am_eric", "bf_emma", "bf_isabella", "bm_george", "bm_lewis"];
const JEV_MODELS = ["jev-latest"];

const GROUPS: GroupDef[] = [
  {
    id: "keys",
    title: "API keys",
    icon: "key",
    sub: "Saved by the engine and never shown again. Paste a key to replace it; clear one to fall back to the value in .env.",
    layout: "keys",
    fields: [
      {
        key: "mordiemKey",
        label: "Mordiem",
        kind: "secret",
        flag: "mordiemKeySet",
        required: true,
        hint: "The model gateway: the brain, the coding skill (GLM and Kimi), spoken replies, fast JSON, and images.",
      },
      {
        key: "typesafeKey",
        label: "TypeSafe (Jev)",
        kind: "secret",
        flag: "typesafeKeySet",
        required: true,
        hint: "Jev reads the live transcript and decides which tool to run while you're still talking.",
      },
      {
        key: "deepgramKey",
        label: "Deepgram",
        kind: "secret",
        flag: "deepgramKeySet",
        required: true,
        hint: "Live transcription of what you say on a call.",
      },
      {
        key: "tavilyKey",
        label: "Tavily",
        kind: "secret",
        flag: "tavilyKeySet",
        hint: "Better web search. Without it Trinity uses keyless DuckDuckGo.",
      },
      {
        key: "falKey",
        label: "fal",
        kind: "secret",
        flag: "falKeySet",
        hint: "The legacy turn-based voice. The real-time call doesn't need it.",
      },
      {
        key: "personaplexAdminToken",
        label: "PersonaPlex admin token",
        kind: "secret",
        flag: "personaplexAdminTokenSet",
        hint: "Lets Trinity upload your custom voices to the GPU pod (PP_ADMIN_TOKEN there).",
      },
    ],
  },
  {
    id: "models",
    title: "Models",
    icon: "cpu",
    sub: "Which model does each job. Text and image models run through the Mordiem gateway; Jev runs on TypeSafe.",
    services: ["mordiem", "jev"],
    subgroups: [
      {
        title: "Coding skill",
        icon: "code",
        sub: "Builds the interactive UI in the workspace window — apps, tools, games, charts, dashboards, forms. Jev picks the quick or the strong coder from what you ask; otherwise the default coder writes it. If a build fails, Trinity retries once with the other one.",
        fields: [
          {
            key: "glmModel",
            label: "Quick coder",
            kind: "model",
            list: "dl-coder-models",
            hint: "Most pages, widgets and charts. Measured on a timer and a chart: mercury-3 ≈ 3 s a page · deepseek-v4-flash-0731-fast ≈ 11 s · openai-gpt-54-mini ≈ 10–15 s · z-ai-glm-5-3-flash ≈ 31 s.",
            note: (v) =>
              /glm-5-3(?!-flash)/i.test(v)
                ? "This model thinks before it writes — ~16 s of reasoning before any code appears (the build preview shows “Thinking…”)."
                : null,
          },
          {
            key: "kimiModel",
            label: "Strong coder",
            kind: "model",
            list: "dl-coder-models",
            hint: "Big or complex apps and games, or when you ask for it by name; also the fallback. kimi-k3 ≈ 20–30 s, the most polished.",
          },
          {
            key: "coderDefault",
            label: "Default coder",
            kind: "choice",
            wide: true,
            options: [
              { value: "glm", label: "Quick", icon: "zap", hint: "Seconds — most pages, widgets, and charts" },
              { value: "kimi", label: "Strong", icon: "sparkles", hint: "Slower, more polished — big apps and games" },
            ],
            hint: "Writes the build when Jev doesn't pick a coder.",
          },
        ],
      },
      {
        title: "Conversation & tools",
        icon: "sparkles",
        sub: "The models behind answers, spoken replies, tool arguments, pictures, spoken audio clips, and tool choice.",
        fields: [
          {
            key: "brainModel",
            label: "Brain",
            kind: "model",
            list: "dl-text-models",
            hint: "Questions that need real knowledge or careful reasoning, and scheduled heartbeat turns.",
          },
          { key: "replyModel", label: "Reply writer", kind: "model", list: "dl-text-models", hint: "The one spoken sentence after a tool runs." },
          {
            key: "fastModel",
            label: "Fast JSON",
            kind: "model",
            list: "dl-text-models",
            hint: "Tool arguments, memory notes, and reminder times. nemotron-3-nano ≈ 2 s, supports JSON mode.",
          },
          {
            key: "imageModel",
            label: "Images",
            kind: "model",
            list: "dl-image-models",
            hint: "Pictures for the workspace. krea-2-turbo ≈ 4.7 s · chroma ≈ 6.5 s · grok-imagine-image ≈ 9.4 s · flux-2-pro ≈ 15.6 s.",
          },
          {
            key: "ttsModel",
            label: "Speech",
            kind: "model",
            list: "dl-tts-models",
            hint: "Spoken audio clips the caller asks for (“read this aloud”). tts-kokoro ≈ 1 s a sentence; elevenlabs-tts-v4 and tts-chatterbox-hd are richer and slower.",
          },
          {
            key: "ttsVoice",
            label: "Speech voice",
            kind: "model",
            list: "dl-tts-voices",
            hint: "The voice name that speech model takes — kokoro: af_heart, af_bella, af_nova, am_adam, am_michael, bm_george…; ElevenLabs: a voice id.",
          },
          { key: "jevModel", label: "Jev model", kind: "model", list: "dl-jev-models", hint: "The decision model on TypeSafe." },
        ],
      },
    ],
  },
  {
    id: "endpoints",
    title: "Endpoints",
    icon: "link",
    sub: "Where each service lives: the voice pod, transcription, Jev, and the model gateway.",
    services: ["stream"],
    fields: [
      {
        key: "personaplexWsUrl",
        label: "PersonaPlex URL",
        kind: "url",
        protocols: ["ws:", "wss:"],
        wide: true,
        hint: "The real-time voice model on your GPU pod (ws:// or wss://). /api/chat is added automatically.",
      },
      { key: "personaplexVoice", label: "Default voice", kind: "voice", hint: "Used when a persona doesn't pick its own voice." },
      {
        key: "deepgramUrl",
        label: "Deepgram URL",
        kind: "url",
        protocols: ["ws:", "wss:"],
        wide: true,
        hint: "Live socket — 16-bit PCM at 24 kHz with interim results.",
      },
      { key: "typesafeUrl", label: "Jev URL", kind: "url", protocols: ["http:", "https:"] },
      { key: "mordiemUrl", label: "Mordiem URL", kind: "url", protocols: ["http:", "https:"] },
    ],
  },
  {
    id: "timing",
    title: "Live-loop timing",
    icon: "timer",
    sub: "How eagerly the live loop routes your words and fills silences.",
    fields: [
      {
        key: "routeEveryMs",
        label: "Route every",
        kind: "number",
        unit: "ms",
        min: 100,
        max: 5000,
        step: 50,
        integer: true,
        hint: "How often Jev reads your in-progress sentence. Lower is snappier, but makes more calls.",
      },
      {
        key: "minConfidence",
        label: "Minimum confidence",
        kind: "number",
        min: 0,
        max: 1,
        step: 0.05,
        hint: "Jev must be at least this sure (0–1) before a tool fires.",
      },
      {
        key: "fillerAfterMs",
        label: "Filler after",
        kind: "number",
        unit: "ms",
        min: 0,
        max: 10000,
        step: 50,
        integer: true,
        hint: "Say a quick “one sec” when a reply takes longer than this.",
      },
    ],
  },
];

const groupFields = (g: GroupDef): FieldDef[] => [...(g.fields ?? []), ...(g.subgroups ?? []).flatMap((s) => s.fields)];
const KNOWN_KEYS = new Set(GROUPS.flatMap((g) => groupFields(g).map((f) => f.key)));
/** Reported by older engines but retired: the coding skill's GLM / Kimi models replaced it. */
const RETIRED_KEYS = new Set(["genModel"]);
/** Shown by the Skills page instead (Skills → "New skills"). */
const ELSEWHERE_KEYS = new Set(["skillApproval"]);

const REQUIRED_SECRETS = GROUPS.flatMap((g) => groupFields(g)).filter((f) => f.kind === "secret" && f.required);

/** Labels of the keys calls or tools need that aren't set (for the sidebar badge). */
export function missingRequiredKeys(ep: PublicEndpoints): string[] {
  return REQUIRED_SECRETS.filter((f) => f.flag && f.flag in ep && !ep[f.flag]).map((f) => f.label);
}

const SERVICE_INFO: Record<string, { label: string; icon: IconName; live: string; mock: string }> = {
  stream: {
    label: "Real-time voice",
    icon: "mic",
    live: "PersonaPlex URL, Deepgram key, and Jev key are all set.",
    mock: "Needs the PersonaPlex URL, a Deepgram key, and a TypeSafe (Jev) key.",
  },
  jev: { label: "Decisions", icon: "target", live: "Jev key is set.", mock: "No TypeSafe key — tool routing runs in mock mode." },
  brain: { label: "Brain", icon: "sparkles", live: "Mordiem key is set.", mock: "No Mordiem key — answers come from the mock brain." },
  mordiem: {
    label: "Mordiem",
    icon: "wand",
    live: "Mordiem key is set.",
    mock: "No Mordiem key — the coding skill, spoken replies, and images are off.",
  },
  web: { label: "Web search", icon: "search", live: "Keyless DuckDuckGo, or Tavily when its key is set.", mock: "Web search is off." },
  voice: {
    label: "Turn-based voice",
    icon: "waveform",
    live: "The legacy fal voice path is configured.",
    mock: "The legacy fal voice path isn't configured — the real-time call doesn't need it.",
  },
};
const SERVICE_ORDER = ["stream", "jev", "brain", "mordiem", "web", "voice"];

function humanize(key: string): string {
  const s = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The model suggestion lists; re-filled when the engine's model catalog arrives. */
function renderDatalists(catalog: ModelCatalog | null | undefined): void {
  const merge = (base: string[], extra: string[] = []) => [...new Set([...base, ...extra])];
  const lists: [string, string[]][] = [
    ["dl-text-models", merge(TEXT_MODELS, catalog?.text)],
    ["dl-coder-models", merge(CODER_MODELS, catalog?.text)],
    ["dl-image-models", merge(IMAGE_MODELS, catalog?.image)],
    ["dl-tts-models", merge(TTS_MODELS, catalog?.tts)],
    ["dl-tts-voices", TTS_VOICES],
    ["dl-jev-models", JEV_MODELS],
  ];
  for (const [id, values] of lists) {
    let dl = document.getElementById(id);
    if (!dl) {
      dl = h("datalist", { id });
      document.body.appendChild(dl);
    }
    setChildren(dl, values.map((v) => h("option", { value: v })));
  }
}

// ─── One field ───────────────────────────────────────────────────────────────

interface Control {
  el: HTMLElement;
  get(): string;
  set(value: string): void;
  setDisabled(disabled: boolean): void;
  focus(): void;
}

function inputControl(input: HTMLInputElement | HTMLSelectElement, el: HTMLElement = input): Control {
  return {
    el,
    get: () => input.value,
    set: (v) => {
      input.value = v;
    },
    setDisabled: (d) => {
      input.disabled = d;
    },
    focus: () => input.focus(),
  };
}

class EndpointField {
  readonly el: HTMLElement;
  private readonly control: Control;
  private readonly parts: FieldParts | null = null;
  private readonly stateSlot: HTMLSpanElement;
  private readonly noteEl: HTMLDivElement;
  private readonly errorEl: HTMLDivElement;
  private readonly resetBtn: HTMLButtonElement | null = null;
  private readonly select: HTMLSelectElement | null = null;
  private readonly secretInput: HTMLInputElement | null = null;
  private initial = "";
  private secretSet = false;
  /** Secrets: a staged "clear" (PUT "" on save). */
  private clearing = false;
  /** False when the engine doesn't report this setting (an older build). */
  private available = true;
  private voices: VoiceLibrary | null = null;

  constructor(
    readonly def: FieldDef,
    private readonly onChange: () => void,
    layout: "field" | "row" = "field",
  ) {
    const id = `ep-${def.key}`;
    this.stateSlot = h("span", { class: "field-state" });
    this.noteEl = h("div", { class: "field-note", hidden: true });

    if (def.kind === "voice") {
      this.select = h("select", { class: "select", id });
      this.control = inputControl(this.select);
    } else if (def.kind === "choice") {
      // The radios' input events bubble to this.el, which reports the change.
      const seg = segmented({ options: def.options ?? [], value: "", look: "cards" });
      seg.el.id = id;
      this.control = seg;
    } else if (def.kind === "secret") {
      const input = h("input", { class: "input mono", id, type: "password", autocomplete: "new-password", spellcheck: false });
      this.secretInput = input;
      const reveal = button(null, {
        icon: "eye",
        size: "sm",
        variant: "ghost",
        title: "Show what you typed",
        cls: "reveal-btn",
        onclick: () => {
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          setIcon(reveal, show ? "eyeOff" : "eye");
          reveal.title = show ? "Hide" : "Show what you typed";
          reveal.setAttribute("aria-label", reveal.title);
          reveal.setAttribute("aria-pressed", String(show));
        },
      });
      reveal.setAttribute("aria-pressed", "false");
      this.control = inputControl(input, h("div", { class: "input-reveal" }, input, reveal));
    } else if (def.kind === "number") {
      const input = h("input", {
        class: "input",
        id,
        type: "number",
        inputMode: def.integer ? "numeric" : "decimal",
        min: def.min !== undefined ? String(def.min) : undefined,
        max: def.max !== undefined ? String(def.max) : undefined,
        step: def.step !== undefined ? String(def.step) : undefined,
        placeholder: ".env default",
      });
      this.control = inputControl(input, def.unit ? h("div", { class: "input-unit" }, input, h("span", { class: "unit" }, def.unit)) : input);
    } else {
      const input = h("input", {
        class: "input mono",
        id,
        type: "text",
        spellcheck: false,
        autocomplete: "off",
        list: def.list,
        placeholder: "Blank uses the .env default",
      });
      this.control = inputControl(input);
    }

    if (def.kind === "secret") {
      // Clear = forget the key saved here (the .env value, if any, applies again). Staged until Save.
      this.resetBtn = button(null, {
        icon: "reset",
        size: "sm",
        variant: "ghost",
        title: "Clear the saved key (falls back to .env)",
        onclick: () => this.toggleClear(),
      });
    } else {
      this.resetBtn = h(
        "button",
        {
          class: "icon-link",
          type: "button",
          title: "Reset to the .env default (applies when you save)",
          "aria-label": `Reset ${def.label} to the .env default`,
          onclick: () => this.resetToDefault(),
        },
        icon("reset"),
      );
    }

    if (layout === "row") {
      // An API key: name + what it's for | input | state + clear.
      this.errorEl = h("div", { class: "field-error", role: "alert", hidden: true });
      this.secretInput?.setAttribute("aria-describedby", `${id}-hint`);
      this.el = h(
        "div",
        { class: "key-row", dataset: { key: def.key } },
        h(
          "div",
          { class: "key-info" },
          h(
            "div",
            { class: "key-name-row" },
            h("label", { class: "key-name", for: id }, def.label),
            def.required ? badge("Required", "accent") : badge("Optional"),
          ),
          h("div", { class: "key-desc", id: `${id}-hint` }, def.hint ?? ""),
        ),
        h("div", { class: "key-input" }, this.control.el, this.noteEl, this.errorEl),
        h("div", { class: "key-side" }, this.stateSlot, this.resetBtn),
      );
    } else {
      this.parts = field({
        label: def.label,
        id,
        control: this.control.el,
        group: def.kind === "choice",
        hint: def.kind === "secret" ? `${def.hint ? `${def.hint} ` : ""}Write-only — leave blank to keep the current key.` : def.hint,
        extra: h("span", { class: "field-extra-row" }, this.stateSlot, this.resetBtn),
        cls: [def.wide ? "is-wide" : "", `kind-${def.kind}`].join(" "),
      });
      this.parts.el.insertBefore(this.noteEl, this.parts.error);
      this.errorEl = this.parts.error;
      this.el = this.parts.el;
    }

    this.el.addEventListener("input", () => this.changed());
    if (def.kind !== "choice") this.el.addEventListener("change", () => this.changed());
  }

  load(ep: PublicEndpoints): void {
    const d = this.def;
    this.available = d.kind === "secret" ? (d.flag ?? `${d.key}Set`) in ep : d.key in ep;
    this.clearing = false;
    if (d.kind === "secret") {
      this.secretSet = Boolean(ep[d.flag ?? `${d.key}Set`]);
      this.initial = "";
      this.control.set("");
      if (this.secretInput) this.secretInput.placeholder = this.placeholder();
    } else {
      const raw = ep[d.key];
      this.initial = raw === undefined || raw === null ? "" : String(raw);
      if (d.kind === "voice") this.renderVoiceOptions(this.initial);
      this.control.set(this.initial);
    }
    this.control.setDisabled(!this.available);
    this.setError(null);
    this.renderState();
  }

  setVoices(lib: VoiceLibrary): void {
    this.voices = lib;
    if (this.def.kind === "voice") {
      const current = this.control.get() || this.initial;
      this.renderVoiceOptions(current);
      this.control.set(current);
      this.renderState();
    }
  }

  value(): string {
    return this.control.get().trim();
  }

  isModified(): boolean {
    if (!this.available) return false;
    return this.def.kind === "secret" ? this.clearing || this.value() !== "" : this.value() !== this.initial.trim();
  }

  /** The PUT value: "" resets a field (or a saved key) to its .env default. */
  patchValue(): string | number {
    if (this.clearing) return "";
    const v = this.value();
    if (this.def.kind === "number" && v !== "") return Number(v);
    return v;
  }

  /** A staged reset to .env (a cleared field or a cleared key). */
  isReset(): boolean {
    return this.isModified() && (this.clearing || (this.def.kind !== "secret" && this.value() === ""));
  }

  validate(): string | null {
    const v = this.value();
    const d = this.def;
    let err: string | null = null;
    if (v !== "" && d.kind === "url") {
      try {
        const u = new URL(v);
        if (d.protocols && !d.protocols.includes(u.protocol)) err = `Use a ${d.protocols.map((p) => `${p}//`).join(" or ")} URL.`;
      } catch {
        err = "That isn't a valid URL.";
      }
    } else if (v !== "" && d.kind === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) err = "Enter a number.";
      else if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) err = `Use a value from ${d.min} to ${d.max}.`;
      else if (d.integer && !Number.isInteger(n)) err = "Use a whole number.";
    } else if (v !== "" && d.kind === "model" && /\s/.test(v)) {
      err = "Model ids don't contain spaces.";
    } else if (v !== "" && d.kind === "secret" && /\s/.test(v)) {
      err = "Keys don't contain spaces — check what you pasted.";
    }
    this.setError(err);
    return err;
  }

  discard(): void {
    this.clearing = false;
    this.control.set(this.def.kind === "secret" ? "" : this.initial);
    if (this.def.kind === "secret") this.control.setDisabled(!this.available);
    this.setError(null);
    this.renderState();
  }

  focus(): void {
    this.control.focus();
  }

  private placeholder(): string {
    if (this.clearing) return "Cleared on save — .env applies";
    return this.secretSet ? "•••••••• saved — paste to replace" : "Paste a key";
  }

  private setError(message: string | null): void {
    if (this.parts) {
      this.parts.setError(message);
      return;
    }
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
    this.el.classList.toggle("is-invalid", Boolean(message));
    if (message) this.secretInput?.setAttribute("aria-invalid", "true");
    else this.secretInput?.removeAttribute("aria-invalid");
  }

  private toggleClear(): void {
    this.clearing = !this.clearing;
    this.control.set("");
    this.control.setDisabled(this.clearing || !this.available);
    if (this.secretInput) this.secretInput.placeholder = this.placeholder();
    this.changed();
    if (!this.clearing) this.control.focus();
  }

  private resetToDefault(): void {
    this.control.set("");
    this.changed();
    if (this.def.kind !== "voice" && this.def.kind !== "choice") this.control.focus();
  }

  private changed(): void {
    this.setError(null);
    this.renderState();
    this.onChange();
  }

  private renderState(): void {
    const d = this.def;
    const modified = this.isModified();
    this.el.classList.toggle("is-modified", modified);
    this.el.classList.toggle("is-unavailable", !this.available);
    let note: string | null = null;
    if (!this.available) {
      const b = badge("Needs engine update", "info");
      b.title = "This engine doesn't have this setting yet — it works once the engine is updated.";
      setChildren(this.stateSlot, b);
    } else if (d.kind === "secret") {
      setChildren(
        this.stateSlot,
        this.clearing
          ? badge("Will clear", "info")
          : modified
            ? badge("Will replace", "info")
            : this.secretSet
              ? badge("Set", "ok", "check")
              : badge("Not set", d.required ? "warn" : "default"),
      );
    } else {
      const resetting = modified && this.value() === "";
      setChildren(this.stateSlot, resetting ? badge("Resets to .env", "info") : modified ? badge("Edited", "info") : null);
      note = d.note?.(this.value()) ?? null;
    }
    if (this.resetBtn) {
      if (d.kind === "secret") {
        // Clearing only makes sense for a key that is set; while staged, the same button undoes it.
        this.resetBtn.hidden = !this.available || (!this.secretSet && !this.clearing) || (!this.clearing && this.value() !== "");
        setIcon(this.resetBtn, this.clearing ? "x" : "reset");
        const t = this.clearing ? "Keep the saved key" : "Clear the saved key (falls back to .env)";
        this.resetBtn.title = t;
        this.resetBtn.setAttribute("aria-label", `${t} — ${d.label}`);
      } else {
        this.resetBtn.hidden = !this.available;
      }
    }
    this.noteEl.hidden = !note;
    this.noteEl.textContent = note ?? "";
    // A model-specific caution (e.g. a thinking-only model) reads as a warning.
    this.noteEl.classList.toggle("is-warn", Boolean(note) && this.available);
  }

  private renderVoiceOptions(selected: string): void {
    const sel = this.select;
    if (!sel) return;
    const lib = this.voices;
    sel.replaceChildren();
    const builtin = lib?.builtin.length ? lib.builtin : null;
    if (builtin) sel.append(h("optgroup", { label: "Built-in voices" }, builtin.map((b) => h("option", { value: b.id }, `${b.label} (${b.id})`))));
    if (lib?.custom.length) sel.append(h("optgroup", { label: "Your voices" }, lib.custom.map((c) => h("option", { value: c.id }, c.name))));
    const known = new Set([...(lib?.builtin ?? []).map((b) => b.id), ...(lib?.custom ?? []).map((c) => c.id)]);
    if (selected && !known.has(selected)) sel.append(h("option", { value: selected }, selected));
    sel.append(h("option", { value: "" }, "Reset to the .env default"));
  }
}

// ─── Section ─────────────────────────────────────────────────────────────────

export function createModelsSection(): Section {
  renderDatalists(modelCatalogRes.peek());
  const strip = h("div", { class: "card status-card" });
  const cardsEl = h("div", { class: "models-stack" });
  const changeCount = h("span", { class: "savebar-text" });
  const discardBtn = button("Discard", { variant: "ghost", onclick: () => discardAll() });
  const saveBtn = button("Save changes", { variant: "primary", icon: "check", onclick: () => void saveAll() });
  const savebar = h(
    "div",
    { class: "savebar", hidden: true, role: "region", "aria-label": "Unsaved changes" },
    h("span", { class: "status-dot is-warn" }),
    changeCount,
    h("span", { class: "spacer" }),
    discardBtn,
    saveBtn,
  );

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-models" },
    sectionHead({
      id: "sec-models",
      title: "Models & API keys",
      lede: "The keys, models, and endpoints behind every part of Trinity — her voice, her ears, her decisions, and the models her tools use. Changes apply immediately, no restart. Clear a field to fall back to its .env default.",
    }),
    strip,
    cardsEl,
    savebar,
  );

  let fields: EndpointField[] = [];
  let built = false;
  let started = false;
  let keysSummary: HTMLElement | null = null;

  // ── Status strip ──

  function renderStrip(): void {
    const s = statusRes.peek();
    const refresh = button(null, {
      icon: "refresh",
      size: "sm",
      variant: "ghost",
      title: "Refresh status",
      onclick: (e) => {
        const b = e.currentTarget as HTMLButtonElement;
        void withBusy(b, () => statusRes.refresh()).catch(() => {});
      },
    });
    if (!s) {
      setChildren(strip, h("div", { class: "status-row" }, h("span", { class: "status-label" }, "Services"), skeletonLines(1, "status-skel"), refresh));
      return;
    }
    const keys = [...SERVICE_ORDER.filter((k) => k in s.services), ...Object.keys(s.services).filter((k) => !SERVICE_ORDER.includes(k))];
    const liveCount = keys.filter((k) => s.services[k] === "live").length;
    setChildren(
      strip,
      h(
        "div",
        { class: "status-row" },
        h("span", { class: "status-label" }, icon("pulse"), `Services · ${liveCount} of ${keys.length} live`),
        h(
          "div",
          { class: "svc-list" },
          keys.map((k) => {
            const state = s.services[k] === "live" ? "live" : "mock";
            const info = SERVICE_INFO[k];
            return h(
              "span",
              { class: `svc svc-${state}`, title: info ? info[state] : `${k}: ${state}` },
              h("span", { class: "svc-dot" }),
              info?.label ?? humanize(k),
              h("span", { class: "svc-state" }, state === "live" ? "Live" : "Mock"),
            );
          }),
        ),
        refresh,
      ),
    );
  }

  // ── Cards ──

  function serviceBadges(services: string[] | undefined): HTMLElement | null {
    const s = statusRes.peek();
    if (!services?.length || !s) return null;
    const states = services.map((k) => s.services[k]).filter(Boolean);
    if (!states.length) return null;
    const live = states.every((x) => x === "live");
    return badge(live ? "Live" : "Mock", live ? "ok" : "warn", "dot");
  }

  function renderKeysSummary(data: PublicEndpoints): void {
    if (!keysSummary) return;
    const secrets = (GROUPS.find((g) => g.id === "keys")?.fields ?? []).filter((f) => f.flag && f.flag in data);
    const set = secrets.filter((f) => data[f.flag!]).length;
    const missing = missingRequiredKeys(data);
    setChildren(
      keysSummary,
      missing.length
        ? badge(`${missing.length} required ${missing.length === 1 ? "key" : "keys"} missing`, "warn", "alert")
        : badge(`${set} of ${secrets.length} set`, "ok", "check"),
    );
  }

  function card(g: GroupDef, body: HTMLElement[], side: HTMLElement | null): HTMLElement {
    return h(
      "div",
      { class: ["card", "model-card", g.layout === "keys" && "keys-card"], dataset: { group: g.id } },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "card-icon" }, icon(g.icon)),
        h("div", { class: "card-head-text" }, h("h2", { class: "card-title" }, g.title), h("p", { class: "card-sub" }, g.sub)),
        h("div", { class: "card-head-side", dataset: { services: (g.services ?? []).join(",") } }, side),
      ),
      body,
    );
  }

  function build(data: PublicEndpoints): void {
    fields = [];
    const cards: HTMLElement[] = [];
    const groups = [...GROUPS];
    // Anything the engine reports that this page doesn't describe yet gets its own card.
    const extra: FieldDef[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (KNOWN_KEYS.has(k) || RETIRED_KEYS.has(k) || ELSEWHERE_KEYS.has(k)) continue;
      if (k.endsWith("Set") && typeof v === "boolean") {
        const key = k.slice(0, -3);
        if (!KNOWN_KEYS.has(key)) extra.push({ key, label: humanize(key), kind: "secret", flag: k });
        continue;
      }
      if (typeof v === "number") extra.push({ key: k, label: humanize(k), kind: "number" });
      else if (typeof v === "string") extra.push({ key: k, label: humanize(k), kind: /url$/i.test(k) ? "url" : "text" });
    }
    if (extra.length) groups.push({ id: "other", title: "Other settings", icon: "sliders", sub: "Settings this page doesn't describe yet.", fields: extra });

    for (const g of groups) {
      if (g.layout === "keys") {
        const rows = (g.fields ?? []).map((d) => new EndpointField(d, onFieldChange, "row"));
        fields.push(...rows);
        keysSummary = h("span", { class: "keys-summary" });
        cards.push(card(g, [h("div", { class: "key-list" }, rows.map((f) => f.el))], keysSummary));
        continue;
      }
      const body: HTMLElement[] = [];
      if (g.subgroups?.length) {
        for (const sg of g.subgroups) {
          const sgFields = sg.fields.map((d) => new EndpointField(d, onFieldChange));
          fields.push(...sgFields);
          const titleId = uid("sg");
          body.push(
            h(
              "section",
              { class: "subgroup", "aria-labelledby": titleId },
              h("h3", { class: "subgroup-title", id: titleId }, icon(sg.icon), sg.title),
              h("p", { class: "subgroup-sub" }, sg.sub),
              h("div", { class: "fields-grid" }, sgFields.map((f) => f.el)),
            ),
          );
        }
      }
      if (g.fields?.length) {
        const gFields = g.fields.map((d) => new EndpointField(d, onFieldChange));
        fields.push(...gFields);
        body.push(h("div", { class: "fields-grid" }, gFields.map((f) => f.el)));
      }
      cards.push(card(g, body, serviceBadges(g.services)));
    }
    setChildren(cardsEl, cards);
    built = true;
    const lib = voicesRes.peek();
    if (lib) for (const f of fields) f.setVoices(lib);
    for (const f of fields) f.load(data);
    renderKeysSummary(data);
    onFieldChange();
  }

  function refreshServiceBadges(): void {
    for (const side of cardsEl.querySelectorAll<HTMLElement>(".card-head-side[data-services]")) {
      const services = (side.dataset.services ?? "").split(",").filter(Boolean);
      if (services.length) setChildren(side, serviceBadges(services));
    }
  }

  function modified(): EndpointField[] {
    return fields.filter((f) => f.isModified());
  }

  function onFieldChange(): void {
    const n = modified().length;
    savebar.hidden = n === 0;
    changeCount.textContent = n ? `${plural(n, "unsaved change")}` : "";
  }

  function discardAll(): void {
    for (const f of fields) f.discard();
    onFieldChange();
  }

  /** Did the engine take the new value? (A build that doesn't know a key ignores it.) */
  function landed(f: EndpointField, sent: string | number, updated: PublicEndpoints): boolean {
    const d = f.def;
    if (d.kind === "secret") return sent === "" || Boolean(updated[d.flag ?? `${d.key}Set`]);
    if (sent === "") return true;
    return String(updated[d.key] ?? "") === String(sent);
  }

  async function saveAll(): Promise<void> {
    const changed = modified();
    if (!changed.length) return;
    const invalid = changed.filter((f) => f.validate() !== null);
    if (invalid.length) {
      invalid[0]?.focus();
      invalid[0]?.el.scrollIntoView({ block: "center", behavior: "smooth" });
      toast(`Fix ${invalid.length === 1 ? "the highlighted field" : `${invalid.length} highlighted fields`} first.`, "warn");
      return;
    }
    const patch: EndpointsPatch = {};
    for (const f of changed) patch[f.def.key] = f.patchValue();
    const resets = changed.filter((f) => f.isReset()).length;
    try {
      const updated = await withBusy(saveBtn, () => api.endpoints.update(patch), "Saving…");
      const ignored = changed.filter((f) => !landed(f, patch[f.def.key] ?? "", updated));
      endpointsRes.set(updated);
      for (const f of fields) f.load(updated);
      onFieldChange();
      announce("endpoints");
      if (ignored.length) {
        toast(`The engine didn't accept ${ignored.map((f) => f.def.label).join(", ")} — check the value and try again.`, "warn");
      } else {
        toast(
          `Saved ${plural(changed.length, "change")}${resets ? ` (${resets} reset to the .env default)` : ""} — live now.`,
          "success",
        );
      }
      void statusRes.refresh().catch(() => {});
      if (changed.some((f) => f.def.key.startsWith("personaplex"))) void voicesRes.refresh().catch(() => {});
    } catch {
      /* reported */
    }
  }

  async function load(): Promise<void> {
    renderStrip();
    if (!built) {
      setChildren(cardsEl, Array.from({ length: 3 }, () => h("div", { class: "card model-card" }, skeletonBlock(70), h("div", { class: "card-pad" }, skeletonLines(3)))));
    }
    void statusRes.get().catch(() => {});
    void voicesRes.get().catch(() => {});
    void modelCatalogRes.get().catch(() => {});
    try {
      const data = await endpointsRes.get();
      if (!built) build(data);
    } catch (err) {
      setChildren(cardsEl, errorState((err as Error).message || "The engine didn't answer.", () => void load()));
    }
  }

  endpointsRes.subscribe((data) => {
    if (!built) {
      if (started) build(data);
      return;
    }
    // Changed elsewhere (another tab, or the Skills page): adopt it unless there are local edits.
    if (!modified().length) for (const f of fields) f.load(data);
    renderKeysSummary(data);
  });
  statusRes.subscribe(() => {
    renderStrip();
    refreshServiceBadges();
  });
  voicesRes.subscribe((lib) => {
    for (const f of fields) f.setVoices(lib);
  });
  modelCatalogRes.subscribe((catalog) => renderDatalists(catalog));

  // Ctrl/Cmd+S saves while this section is open.
  el.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveAll();
    }
  });

  return {
    el,
    show() {
      if (!started) {
        started = true;
        void load();
      } else {
        void statusRes.refresh().catch(() => {});
      }
    },
    isDirty: () => modified().length > 0,
    refresh() {
      if (!started) return;
      void statusRes.refresh().catch(() => {});
      if (!modified().length) void endpointsRes.refresh().catch(() => {});
    },
  };
}
