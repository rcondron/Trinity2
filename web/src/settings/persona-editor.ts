// The persona editor panel: identity, voice (+ preview and the short voice
// prompt), toolsets, and traits, with dirty tracking, validation, and a sticky
// save bar. The Personas section owns persistence; this only edits fields.

import { api, type Persona, type PersonaFields, type Toolset, type VoiceLibrary } from "./api.js";
import { player } from "./player.js";
import {
  avatar,
  badge,
  button,
  field,
  h,
  hashHue,
  icon,
  isMac,
  linkButton,
  relTime,
  setChildren,
  setIcon,
  uid,
  withBusy,
  type FieldParts,
} from "./ui.js";

export const VOICE_PROMPT_MAX = 160;
export const VOICE_PROMPT_WARN = 120;
// The engine refuses anything longer (PERSONA_LIMITS in server/src/http.ts) — keep these in step.
// (Its voice prompt cap is 200; VOICE_PROMPT_MAX above is the editor's stricter one.)
const NAME_MAX = 80;
const DESCRIPTION_MAX = 6000;
const TRAITS_MAX = 30;
const TRAIT_KEY_MAX = 40;
const TRAIT_VALUE_MAX = 200;
const TRAIT_KEYS_ID = "trait-key-suggestions";
const TRAIT_KEY_SUGGESTIONS = ["tone", "role", "pace", "builds", "style", "quirks", "catchphrase", "expertise", "humor"];

export interface EditorContext {
  voices: VoiceLibrary;
  toolsets: Toolset[];
  isActive: boolean;
  canDelete: boolean;
  /** A draft that hasn't been created on the engine yet. */
  isNew: boolean;
  /** Treat the draft as unsaved work from the start (e.g. a duplicate). */
  startDirty?: boolean;
}

export interface EditorHandlers {
  /** Persist. `id` null = create. Resolve the saved persona, or null if it failed (already reported). */
  save(fields: PersonaFields, id: string | null): Promise<Persona | null>;
  activate(): void;
  remove(): void;
  duplicate(): void;
  discardDraft(): void;
  /** Dirty flag or a card-visible field (name, voice, toolsets) changed — the list mirrors it live. */
  changed(dirty: boolean, live: PersonaFields): void;
}

interface TraitRow {
  el: HTMLElement;
  key: HTMLInputElement;
  value: HTMLInputElement;
}

export function fieldsOf(p: Pick<Persona, keyof PersonaFields>): PersonaFields {
  return {
    name: p.name ?? "",
    description: p.description ?? "",
    voicePrompt: p.voicePrompt ?? "",
    voice: p.voice ?? "",
    toolsets: Array.isArray(p.toolsets) ? [...p.toolsets] : [],
    traits: p.traits && typeof p.traits === "object" ? { ...p.traits } : {},
  };
}

/** Canonical form: trimmed, voice prompt on one line, sorted unique toolsets, no empty traits. */
export function normalizeFields(f: PersonaFields): PersonaFields {
  const traits: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.traits)) {
    const key = k.trim();
    if (key) traits[key] = String(v).trim();
  }
  return {
    name: f.name.trim().replace(/\s+/g, " "),
    description: f.description.trim(),
    voicePrompt: f.voicePrompt.trim().replace(/\s+/g, " "),
    voice: f.voice,
    toolsets: [...new Set(f.toolsets)].sort(),
    traits,
  };
}

function sameFields(a: PersonaFields, b: PersonaFields): boolean {
  const key = (f: PersonaFields) =>
    JSON.stringify({ ...f, traits: Object.entries(f.traits).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)) });
  return key(normalizeFields(a)) === key(normalizeFields(b));
}

/** First sentence of the personality, trimmed to fit the voice prompt limit at a word boundary. */
export function suggestVoicePrompt(description: string): string {
  const text = description.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const first = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  if (first.length <= VOICE_PROMPT_MAX) return first;
  const cut = first.slice(0, VOICE_PROMPT_MAX - 1);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:\s]+$/, "");
  return `${atWord}.`;
}

function ensureTraitDatalist(): void {
  if (document.getElementById(TRAIT_KEYS_ID)) return;
  document.body.appendChild(
    h("datalist", { id: TRAIT_KEYS_ID }, TRAIT_KEY_SUGGESTIONS.map((k) => h("option", { value: k }))),
  );
}

export class PersonaEditor {
  readonly el: HTMLElement;

  private persona: Persona;
  private ctx: EditorContext;
  private original: PersonaFields;
  private lastCardKey = "";
  private lastName = "";
  private saving = false;
  private previewing = false;

  private readonly nameInput: HTMLInputElement;
  private readonly descInput: HTMLTextAreaElement;
  private readonly descCount: HTMLSpanElement;
  private readonly promptInput: HTMLTextAreaElement;
  private readonly promptCounter: HTMLSpanElement;
  private readonly promptMeter: HTMLSpanElement;
  private readonly suggestBtn: HTMLButtonElement;
  private readonly voiceSelect: HTMLSelectElement;
  private readonly previewBtn: HTMLButtonElement;
  private readonly voiceNote: HTMLDivElement;
  private readonly toolsetBox: HTMLDivElement;
  private readonly traitsBox: HTMLDivElement;
  private readonly traitsEmpty: HTMLDivElement;
  private readonly addTraitBtn: HTMLButtonElement;
  private traitRows: TraitRow[] = [];

  private readonly fName: FieldParts;
  private readonly fDesc: FieldParts;
  private readonly fPrompt: FieldParts;
  private readonly fTraits: FieldParts;

  private readonly head: HTMLDivElement;
  private readonly headAvatarSlot: HTMLSpanElement;
  private readonly headTitle: HTMLHeadingElement;
  private readonly headBadges: HTMLSpanElement;
  private readonly headMeta: HTMLDivElement;
  private readonly headActions: HTMLDivElement;
  private readonly footStatus: HTMLDivElement;
  private readonly revertBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;

  constructor(persona: Persona, ctx: EditorContext, private readonly handlers: EditorHandlers) {
    ensureTraitDatalist();
    this.persona = persona;
    this.ctx = { ...ctx };
    const base = fieldsOf(persona);
    this.original = normalizeFields(base);
    const ids = { name: uid("p-name"), desc: uid("p-desc"), prompt: uid("p-prompt"), voice: uid("p-voice") };

    // ── Header ──
    this.headAvatarSlot = h("span", { class: "editor-avatar" });
    this.headTitle = h("h2", { class: "editor-title" });
    this.headBadges = h("span", { class: "editor-badges" });
    this.headMeta = h("div", { class: "editor-meta" });
    this.headActions = h("div", { class: "editor-actions" });
    this.head = h(
      "div",
      { class: "editor-head" },
      this.headAvatarSlot,
      h("div", { class: "editor-head-text" }, h("div", { class: "editor-title-row" }, this.headTitle, this.headBadges), this.headMeta),
      this.headActions,
    );

    // ── Identity ──
    this.nameInput = h("input", {
      class: "input input-lg",
      id: ids.name,
      value: base.name,
      placeholder: "e.g. Nova — Research Assistant",
      maxLength: NAME_MAX,
      autocomplete: "off",
      spellcheck: false,
    });
    this.fName = field({
      label: "Name",
      control: this.nameInput,
      hint: "Shown in the persona picker. A role after a dash reads nicely: “Nova — Assistant”.",
    });

    this.descInput = h("textarea", {
      class: "textarea",
      id: ids.desc,
      rows: 7,
      value: base.description,
      placeholder: "Who they are, how they talk, what they're great at, and what they build in the workspace as you talk…",
    });
    this.descCount = h("span", { class: "counter" });
    this.fDesc = field({
      label: "Personality",
      control: this.descInput,
      extra: this.descCount,
      hint: `The full character brief for the brain and the reply writer. It can be long (up to ${DESCRIPTION_MAX.toLocaleString()} characters) — it doesn't slow down connecting.`,
    });

    // ── Voice ──
    this.voiceSelect = h("select", { class: "select", id: ids.voice, "aria-describedby": `${ids.voice}-note` });
    this.previewBtn = button(null, { icon: "play", title: "Preview this voice", onclick: () => this.togglePreview() });
    this.voiceNote = h("div", { class: "field-hint", id: `${ids.voice}-note` });
    const fVoice = field({
      label: "Voice",
      id: ids.voice,
      control: h("div", { class: "input-row" }, this.voiceSelect, this.previewBtn),
    });
    fVoice.el.insertBefore(this.voiceNote, fVoice.error);

    this.promptInput = h("textarea", {
      class: "textarea textarea-compact",
      id: ids.prompt,
      rows: 2,
      value: base.voicePrompt,
      placeholder: "One or two short sentences: who they are and how they sound.",
    });
    this.promptCounter = h("span", { class: "counter", "aria-live": "polite" });
    this.promptMeter = h("span", { class: "len-meter-fill" });
    this.suggestBtn = linkButton("Suggest from personality", () => this.suggestPrompt(), "wand");
    this.fPrompt = field({
      label: "Voice prompt",
      id: ids.prompt,
      control: h("div", { class: "prompt-wrap" }, this.promptInput, h("div", { class: "len-meter", "aria-hidden": "true" }, this.promptMeter)),
      extra: this.promptCounter,
      hint: h(
        "div",
        { class: "hint-row" },
        h("span", null, icon("timer", "hint-icon"), "Shorter voice prompts connect faster — every word is a model step before the call starts."),
        this.suggestBtn,
      ),
    });

    // ── Abilities ──
    this.toolsetBox = h("div", { class: "toggle-grid" });

    // ── Traits ──
    this.traitsBox = h("div", { class: "traits" });
    this.traitsEmpty = h("div", { class: "traits-empty" }, "No traits yet — add short notes like tone → warm, playful.");
    this.addTraitBtn = button("Add trait", {
      icon: "plus",
      size: "sm",
      variant: "subtle",
      onclick: () => {
        if (this.traitRows.length >= TRAITS_MAX) return;
        const row = this.addTraitRow("", "");
        row.key.focus();
        this.onChange();
      },
    });
    this.fTraits = field({
      label: "Traits",
      hideLabel: true,
      control: h("div", { class: "traits-wrap" }, this.traitsBox, this.traitsEmpty, h("div", null, this.addTraitBtn)),
    });

    // ── Footer ──
    this.footStatus = h("div", { class: "editor-status", "aria-live": "polite" });
    this.revertBtn = button("Revert", { variant: "ghost", onclick: () => this.revert() });
    this.saveBtn = button("Save changes", { variant: "primary", icon: "check", onclick: () => void this.save() });

    const group = (title: string, ic: Parameters<typeof icon>[0], ...children: HTMLElement[]) =>
      h("section", { class: "group" }, h("h3", { class: "group-title" }, icon(ic), title), h("div", { class: "group-body" }, children));

    this.el = h(
      "div",
      { class: "card editor", role: "form", "aria-label": "Persona editor" },
      this.head,
      h(
        "div",
        { class: "editor-body" },
        group("Identity", "users", this.fName.el, this.fDesc.el),
        group("Voice", "waveform", fVoice.el, this.fPrompt.el),
        group(
          "Abilities",
          "sparkles",
          h("p", { class: "group-lede" }, "Extra tool groups this persona can use on a call."),
          this.toolsetBox,
        ),
        group(
          "Traits",
          "edit",
          h("p", { class: "group-lede" }, "Short key/value notes surfaced into the prompt and used for routing."),
          this.fTraits.el,
        ),
      ),
      h("div", { class: "editor-foot" }, this.footStatus, h("div", { class: "editor-foot-actions" }, this.revertBtn, this.saveBtn)),
    );

    // Fill dynamic parts.
    this.renderVoiceOptions(base.voice);
    // A persona without a voice shows the default preset; don't count that as an edit.
    if (!base.voice) this.original = { ...this.original, voice: this.voiceSelect.value };
    this.renderToolsets(base.toolsets);
    for (const [k, v] of Object.entries(base.traits)) this.addTraitRow(k, v);
    this.renderHeader();

    this.el.addEventListener("input", (e) => {
      const t = e.target;
      if (t === this.nameInput) this.fName.setError(null);
      if (t === this.descInput) this.fDesc.setError(null);
      if (t === this.promptInput) this.fPrompt.setError(null);
      if (t instanceof HTMLInputElement && this.traitsBox.contains(t)) this.fTraits.setError(null);
      this.onChange();
    });
    this.el.addEventListener("change", () => this.onChange());
    this.el.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.save();
      }
    });
    this.voiceSelect.addEventListener("change", () => {
      if (this.previewing) player.stop();
      this.updateVoiceExtras();
    });
    this.lastName = base.name;
    this.onChange(true);
  }

  // ── Public API ──

  get personaId(): string | null {
    return this.ctx.isNew ? null : this.persona.id;
  }

  values(): PersonaFields {
    const toolsets = [...this.toolsetBox.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .filter((i) => i.checked)
      .map((i) => i.value);
    const traits: Record<string, string> = {};
    for (const r of this.traitRows) {
      const k = r.key.value.trim();
      if (k) traits[k] = r.value.value.trim();
    }
    return {
      name: this.nameInput.value,
      description: this.descInput.value,
      voicePrompt: this.promptInput.value,
      voice: this.voiceSelect.value,
      toolsets,
      traits,
    };
  }

  isDirty(): boolean {
    if (this.ctx.isNew && this.ctx.startDirty) return true;
    return !sameFields(this.values(), this.original);
  }

  /** Validate and save. Resolves true when everything is persisted. */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    const fields = normalizeFields(this.values());
    if (!this.validate(fields)) return false;
    if (!this.ctx.isNew && !this.isDirty()) return true;
    this.saving = true;
    try {
      const saved = await withBusy(
        this.saveBtn,
        () => this.handlers.save(fields, this.ctx.isNew ? null : this.persona.id),
        this.ctx.isNew ? "Creating…" : "Saving…",
      );
      if (!saved) return false;
      this.markSaved(saved);
      return true;
    } finally {
      this.saving = false;
    }
  }

  /** Throw away edits and show the last saved values. */
  revert(): void {
    const f = this.original;
    this.nameInput.value = f.name;
    this.descInput.value = f.description;
    this.promptInput.value = f.voicePrompt;
    this.renderVoiceOptions(f.voice);
    this.renderToolsets(f.toolsets);
    this.traitRows = [];
    this.traitsBox.replaceChildren();
    for (const [k, v] of Object.entries(f.traits)) this.addTraitRow(k, v);
    this.fName.setError(null);
    this.fDesc.setError(null);
    this.fPrompt.setError(null);
    this.fTraits.setError(null);
    if (this.ctx.isNew) this.ctx.startDirty = false;
    this.onChange();
  }

  setVoices(lib: VoiceLibrary): void {
    this.ctx.voices = lib;
    this.renderVoiceOptions(this.voiceSelect.value || this.original.voice);
  }

  setToolsets(list: Toolset[]): void {
    this.ctx.toolsets = list;
    this.renderToolsets(this.values().toolsets);
  }

  setActive(isActive: boolean): void {
    if (this.ctx.isActive === isActive) return;
    this.ctx.isActive = isActive;
    this.renderHeader();
  }

  setCanDelete(canDelete: boolean): void {
    if (this.ctx.canDelete === canDelete) return;
    this.ctx.canDelete = canDelete;
    this.renderHeader();
  }

  /** The persona was changed elsewhere; adopt it if there are no local edits. Returns true if adopted. */
  adopt(p: Persona): boolean {
    if (this.isDirty() || this.ctx.isNew) return false;
    this.persona = p;
    this.original = normalizeFields(fieldsOf(p));
    this.revert();
    this.renderHeader();
    return true;
  }

  focusName(): void {
    this.nameInput.focus();
    this.nameInput.select();
  }

  destroy(): void {
    if (this.previewing) player.stop();
    this.el.remove();
  }

  // ── Internals ──

  private markSaved(p: Persona): void {
    this.persona = p;
    this.ctx.isNew = false;
    this.ctx.startDirty = false;
    this.original = normalizeFields(fieldsOf(p));
    this.renderHeader();
    this.onChange();
  }

  private onChange(initial = false): void {
    this.updateCounters();
    const v = this.values();
    const name = v.name.trim();
    if (name !== this.lastName || initial) {
      this.lastName = name;
      this.renderHeaderIdentity(name);
    }
    this.traitsEmpty.hidden = this.traitRows.length > 0;
    const traitsFull = this.traitRows.length >= TRAITS_MAX;
    this.addTraitBtn.disabled = traitsFull;
    this.addTraitBtn.title = traitsFull ? `A persona can have up to ${TRAITS_MAX} traits.` : "";
    this.suggestBtn.hidden = !v.description.trim() || normalizeFields(v).voicePrompt === suggestVoicePrompt(v.description);
    const dirty = this.isDirty();
    this.renderFooter(dirty);
    const cardKey = JSON.stringify([dirty, name, v.voice, [...v.toolsets].sort()]);
    if (!initial && cardKey !== this.lastCardKey) this.handlers.changed(dirty, { ...v, name });
    this.lastCardKey = cardKey;
  }

  private updateCounters(): void {
    const len = this.promptInput.value.trim().replace(/\s+/g, " ").length;
    this.promptCounter.textContent = `${len} / ${VOICE_PROMPT_MAX}`;
    const state = len > VOICE_PROMPT_MAX ? "over" : len > VOICE_PROMPT_WARN ? "warn" : len === 0 ? "empty" : "ok";
    this.promptCounter.className = `counter is-${state}`;
    this.promptMeter.style.width = `${Math.min(100, (len / VOICE_PROMPT_MAX) * 100)}%`;
    this.promptMeter.className = `len-meter-fill is-${state}`;
    const dl = this.descInput.value.trim().length;
    const near = dl > DESCRIPTION_MAX * 0.8;
    this.descCount.textContent = !dl ? "" : near ? `${dl.toLocaleString()} / ${DESCRIPTION_MAX.toLocaleString()}` : `${dl.toLocaleString()} chars`;
    this.descCount.className = `counter${dl > DESCRIPTION_MAX ? " is-over" : near ? " is-warn" : ""}`;
  }

  private renderHeaderIdentity(name: string): void {
    const seed = this.persona.id || "draft";
    setChildren(this.headAvatarSlot, avatar(name || "New persona", seed, "lg"));
    this.head.style.setProperty("--h", String(hashHue(seed)));
    this.headTitle.textContent = name || (this.ctx.isNew ? "New persona" : "Unnamed persona");
  }

  private renderHeader(): void {
    this.renderHeaderIdentity(this.values().name.trim());
    setChildren(
      this.headBadges,
      this.ctx.isActive ? badge("Active", "ok", "dot") : null,
      this.ctx.isNew ? badge("Draft", "accent") : null,
    );
    if (this.ctx.isNew) {
      setChildren(this.headMeta, h("span", null, "Not saved yet — create it to use it on a call."));
    } else {
      setChildren(
        this.headMeta,
        h("span", { class: "meta-id", title: "Persona id" }, "ID ", h("code", null, this.persona.id)),
        h("span", { class: "meta-sep", "aria-hidden": "true" }, "·"),
        h("span", null, `Updated ${relTime(this.persona.updatedAt)}`),
      );
    }

    const actions: HTMLElement[] = [];
    if (this.ctx.isNew) {
      actions.push(button("Discard draft", { icon: "x", variant: "ghost", onclick: () => this.handlers.discardDraft() }));
    } else {
      if (!this.ctx.isActive) {
        actions.push(
          button("Set active", {
            icon: "power",
            variant: "subtle",
            title: "Use this persona for new calls",
            onclick: () => this.handlers.activate(),
          }),
        );
      }
      actions.push(button(null, { icon: "copy", title: "Duplicate as a new persona", onclick: () => this.handlers.duplicate() }));
      actions.push(
        button(null, {
          icon: "trash",
          variant: "danger",
          title: this.ctx.canDelete ? "Delete persona" : "You need at least one persona",
          disabled: !this.ctx.canDelete,
          onclick: () => this.handlers.remove(),
        }),
      );
    }
    setChildren(this.headActions, actions);
    this.saveBtn.querySelector(".btn-label")!.textContent = this.ctx.isNew ? "Create persona" : "Save changes";
  }

  private renderFooter(dirty: boolean): void {
    const shortcut = isMac() ? "⌘S" : "Ctrl+S";
    if (this.ctx.isNew) {
      setChildren(this.footStatus, h("span", { class: "status-dot is-accent" }), "New persona — not saved yet", h("kbd", null, shortcut));
    } else if (dirty) {
      setChildren(this.footStatus, h("span", { class: "status-dot is-warn" }), "Unsaved changes", h("kbd", null, shortcut));
    } else {
      setChildren(this.footStatus, icon("check", "status-ok"), "All changes saved");
    }
    this.el.classList.toggle("is-dirty", dirty);
    this.revertBtn.disabled = !dirty || (this.ctx.isNew && !this.ctx.startDirty && sameFields(this.values(), this.original));
    this.revertBtn.hidden = this.ctx.isNew;
    this.saveBtn.disabled = !this.ctx.isNew && !dirty;
  }

  private renderVoiceOptions(selected: string): void {
    const lib = this.ctx.voices;
    const sel = this.voiceSelect;
    sel.replaceChildren();
    sel.append(h("optgroup", { label: "Built-in voices" }, lib.builtin.map((b) => h("option", { value: b.id }, b.label))));
    if (lib.custom.length) {
      sel.append(
        h(
          "optgroup",
          { label: "Your voices" },
          [...lib.custom].sort((a, b) => a.name.localeCompare(b.name)).map((c) => h("option", { value: c.id }, c.name)),
        ),
      );
    }
    const known = new Set([...lib.builtin.map((b) => b.id), ...lib.custom.map((c) => c.id)]);
    if (selected && !known.has(selected)) {
      const label = selected.startsWith("custom:") ? `Missing voice (${selected.slice(7)})` : selected;
      sel.append(h("optgroup", { label: "Not in the library" }, h("option", { value: selected }, label)));
    }
    sel.value = selected || lib.builtin[0]?.id || "NATF2";
    this.updateVoiceExtras();
  }

  private updateVoiceExtras(): void {
    const value = this.voiceSelect.value;
    const lib = this.ctx.voices;
    const custom = value.startsWith("custom:") ? lib.custom.find((c) => c.id === value) : undefined;
    const canPreview = Boolean(custom) && lib.customAvailable;
    this.previewBtn.disabled = !canPreview;
    this.previewBtn.title = canPreview
      ? "Preview this voice"
      : value.startsWith("custom:")
        ? "This voice isn't in the library"
        : "Previews are available for custom voices";
    if (custom) {
      setChildren(
        this.voiceNote,
        `Custom voice · ${custom.durationSec ? `${custom.durationSec.toFixed(1)} s sample` : "sample"}`,
        custom.synced === false ? h("span", { class: "note-warn" }, " · not synced to the GPU pod yet") : null,
      );
    } else if (value.startsWith("custom:")) {
      setChildren(
        this.voiceNote,
        h("span", { class: "note-warn" }, "This custom voice isn't in the library anymore — pick another, or recreate it in "),
        h("a", { href: "#voices" }, "Voices"),
        ".",
      );
    } else {
      setChildren(this.voiceNote, "A built-in PersonaPlex preset. Make your own from a voice sample in ", h("a", { href: "#voices" }, "Voices"), ".");
    }
  }

  private togglePreview(): void {
    const value = this.voiceSelect.value;
    if (!value.startsWith("custom:")) return;
    const slug = value.slice("custom:".length);
    player.toggle(api.voices.audioUrl(slug), (playing) => {
      this.previewing = playing;
      setIcon(this.previewBtn, playing ? "stop" : "play");
      this.previewBtn.classList.toggle("is-playing", playing);
      this.previewBtn.setAttribute("aria-label", playing ? "Stop preview" : "Preview this voice");
    });
  }

  private renderToolsets(selected: readonly string[]): void {
    const known = this.ctx.toolsets;
    const extra = selected
      .filter((id) => !known.some((t) => t.id === id))
      .map((id): Toolset => ({ id, label: id, description: "Not offered by this engine — kept as is." }));
    setChildren(
      this.toolsetBox,
      [...known, ...extra].map((t) => {
        const input = h("input", { type: "checkbox", class: "check", value: t.id, checked: selected.includes(t.id) });
        return h(
          "label",
          { class: "toggle-card" },
          input,
          h(
            "span",
            { class: "toggle-text" },
            h("span", { class: "toggle-title" }, t.id === "game" ? icon("dice") : icon("sparkles"), t.label),
            t.description ? h("span", { class: "toggle-desc" }, t.description) : null,
          ),
        );
      }),
    );
  }

  private addTraitRow(k: string, v: string): TraitRow {
    const key = h("input", {
      class: "input",
      value: k,
      placeholder: "trait",
      "aria-label": "Trait name",
      list: TRAIT_KEYS_ID,
      maxLength: TRAIT_KEY_MAX,
      spellcheck: false,
      autocomplete: "off",
    });
    const value = h("input", { class: "input", value: v, placeholder: "value", "aria-label": "Trait value", maxLength: TRAIT_VALUE_MAX });
    const row: TraitRow = { el: h("div", { class: "trait-row" }, key, value), key, value };
    row.el.append(
      button(null, {
        icon: "x",
        size: "sm",
        variant: "ghost",
        title: "Remove trait",
        onclick: () => {
          const idx = this.traitRows.indexOf(row);
          row.el.remove();
          this.traitRows = this.traitRows.filter((r) => r !== row);
          this.fTraits.setError(null);
          this.onChange();
          (this.traitRows[Math.min(idx, this.traitRows.length - 1)]?.key ?? this.el.querySelector<HTMLElement>(".traits-wrap .btn"))?.focus();
        },
      }),
    );
    this.traitRows.push(row);
    this.traitsBox.append(row.el);
    return row;
  }

  private suggestPrompt(): void {
    const s = suggestVoicePrompt(this.descInput.value);
    if (!s) return;
    this.promptInput.value = s;
    this.fPrompt.setError(null);
    this.onChange();
    this.promptInput.focus();
  }

  private validate(f: PersonaFields): boolean {
    const problems: { parts: FieldParts; message: string; focus: HTMLElement }[] = [];
    this.fName.setError(null);
    this.fDesc.setError(null);
    this.fPrompt.setError(null);
    this.fTraits.setError(null);
    if (!f.name) problems.push({ parts: this.fName, message: "Give this persona a name.", focus: this.nameInput });
    else if (f.name.length > NAME_MAX) {
      problems.push({ parts: this.fName, message: `Shorten the name to ${NAME_MAX} characters.`, focus: this.nameInput });
    }
    if (f.description.length > DESCRIPTION_MAX) {
      problems.push({
        parts: this.fDesc,
        message: `Shorten the personality to ${DESCRIPTION_MAX.toLocaleString()} characters (it's ${f.description.length.toLocaleString()}).`,
        focus: this.descInput,
      });
    }
    if (!f.voicePrompt) {
      problems.push({
        parts: this.fPrompt,
        message: "Add a short voice prompt — the voice model needs one to start a call.",
        focus: this.promptInput,
      });
    } else if (f.voicePrompt.length > VOICE_PROMPT_MAX) {
      problems.push({
        parts: this.fPrompt,
        message: `Trim the voice prompt to ${VOICE_PROMPT_MAX} characters (it's ${f.voicePrompt.length}).`,
        focus: this.promptInput,
      });
    }
    const seen = new Set<string>();
    const traitCount = Object.keys(f.traits).length;
    if (traitCount > TRAITS_MAX) {
      const extra = this.traitRows.filter((r) => r.key.value.trim())[TRAITS_MAX];
      problems.push({ parts: this.fTraits, message: `Keep it to ${TRAITS_MAX} traits (there are ${traitCount}).`, focus: extra?.key ?? this.addTraitBtn });
    }
    for (const r of this.traitRows) {
      const k = r.key.value.trim();
      const v = r.value.value.trim();
      if (!k && v) {
        problems.push({ parts: this.fTraits, message: "Every trait needs a name.", focus: r.key });
        break;
      }
      if (k.length > TRAIT_KEY_MAX || v.length > TRAIT_VALUE_MAX) {
        const long = k.length > TRAIT_KEY_MAX;
        problems.push({
          parts: this.fTraits,
          message: long ? `Shorten the trait name “${k.slice(0, 20)}…” to ${TRAIT_KEY_MAX} characters.` : `Shorten “${k}” to ${TRAIT_VALUE_MAX} characters.`,
          focus: long ? r.key : r.value,
        });
        break;
      }
      if (k) {
        const lower = k.toLowerCase();
        if (seen.has(lower)) {
          problems.push({ parts: this.fTraits, message: `“${k}” is listed twice — keep one.`, focus: r.key });
          break;
        }
        seen.add(lower);
      }
    }
    for (const p of problems) p.parts.setError(p.message);
    const first = problems[0];
    if (first) {
      first.focus.focus({ preventScroll: true });
      first.parts.el.scrollIntoView({ block: "center", behavior: "smooth" });
      return false;
    }
    return true;
  }
}
