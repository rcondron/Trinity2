// Skills: the tools Jev can call while you talk, grouped by where they come
// from. Skills Trinity created on the fly come first — each runs in its own
// sandbox; switch it on or off, read its code, test it, or delete it — with the
// approval mode for new ones and the list waiting for approval. Then a box to
// ask for a new skill, and the built-in, hand-written, and toolset tools (like
// the Game Master's).

import {
  ApiError,
  FALLBACK_TOOLSETS,
  api,
  isNotAvailable,
  type PendingSkill,
  type Skill,
  type SkillTestResult,
  type ToolArgSpec,
  type Toolset,
} from "./api.js";
import { withoutLinks } from "../workspace/frame.js";
import { announce } from "./channel.js";
import { endpointsRes, skillsRes, toolsetsRes, type SkillsData } from "./store.js";
import {
  badge,
  button,
  confirmAction,
  emptyState,
  errorState,
  field,
  h,
  icon,
  plural,
  relTime,
  sectionHead,
  segmented,
  setChildren,
  skeletonLines,
  switchInput,
  toast,
  uid,
  withBusy,
  type Section,
} from "./ui.js";

const FORGED = "forged";

/** Ideas for the "Create a skill" box — things a sandboxed skill with web access does well. */
const IDEAS = [
  "Convert between currencies using today's exchange rates",
  "Get the weather forecast for any city",
  "Look up the definition of an English word",
  "Tell me what time it is in another city",
];

interface GroupInfo {
  title: string;
  sub: string;
  badge: string;
  tone: "default" | "accent" | "info";
  order: number;
}

const SOURCE_GROUPS: Record<string, GroupInfo> = {
  builtin: { title: "Built-in", sub: "Ship with the engine and are available to every persona.", badge: "Built-in", tone: "default", order: 0 },
  skill: {
    title: "Hand-written",
    sub: "Skill modules in the engine's skills folder (server/skills). They run inside the engine.",
    badge: "Hand-written",
    tone: "accent",
    order: 1,
  },
};

/** Group key: "toolset:<id>" for toolset tools (reported, or inferred from a "<id>_" name prefix), else the source. */
function groupKey(s: Skill, toolsets: readonly Toolset[]): string {
  if (s.toolset) return `toolset:${s.toolset}`;
  const t = toolsets.find((x) => s.name.startsWith(`${x.id}_`));
  return t ? `toolset:${t.id}` : s.source || "other";
}

function groupInfo(key: string, toolsets: readonly Toolset[]): GroupInfo {
  if (key.startsWith("toolset:")) {
    const id = key.slice("toolset:".length);
    const t = toolsets.find((x) => x.id === id);
    const label = t?.label ?? `${id.charAt(0).toUpperCase()}${id.slice(1)} tools`;
    return {
      title: label,
      sub: "Only offered to personas that have this toolset turned on (Personas → Abilities).",
      badge: label.replace(/\s+tools?$/i, ""),
      tone: "info",
      order: 2,
    };
  }
  return (
    SOURCE_GROUPS[key] ?? {
      title: key && key !== "other" ? `${key.charAt(0).toUpperCase()}${key.slice(1)} tools` : "Other tools",
      sub: "",
      badge: key || "Other",
      tone: "default",
      order: 3,
    }
  );
}

function lineCount(code: string): number {
  return code ? code.split("\n").length : 0;
}

function codeBlock(name: string, code: string): HTMLElement {
  const copy = button(null, {
    icon: "copy",
    size: "sm",
    variant: "ghost",
    title: "Copy the code",
    onclick: () => {
      void navigator.clipboard?.writeText(code).then(
        () => toast("Copied the code", "success"),
        () => toast("Couldn't copy — select the code instead", "warn"),
      );
    },
  });
  return h(
    "div",
    { class: "code-wrap" },
    h("div", { class: "code-head" }, icon("code"), `${name}.skill.mjs`, h("span", { class: "spacer" }), plural(lineCount(code), "line"), copy),
    h("pre", { class: "code", tabIndex: 0, "aria-label": `Source code of ${name}` }, h("code", null, code)),
  );
}

// ─── Test form: arguments built from the skill's `input` ─────────────────────

type ReadResult = { ok: true; value: unknown } | { ok: false; error: string };

interface ArgReader {
  /** The argument's name — null for the free-form JSON box, which reads the whole args object. */
  name: string | null;
  focus(): void;
  read(): ReadResult;
  setError(message: string | null): void;
}

class ArgsForm {
  readonly el: HTMLElement;
  private readonly readers: ArgReader[] = [];

  constructor(input: Record<string, ToolArgSpec> | null, example: Record<string, unknown> | undefined, onSubmit: () => void) {
    const fields: HTMLElement[] = [];
    if (input) {
      for (const [name, spec] of Object.entries(input)) {
        const id = uid("arg");
        const t = spec.type.toLowerCase();
        const ex = example?.[name];
        let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        let parse: (raw: string) => ReadResult;
        if (spec.options && Object.keys(spec.options).length) {
          control = h(
            "select",
            { class: "select", id },
            spec.required ? null : h("option", { value: "" }, "—"),
            Object.entries(spec.options).map(([v, label]) => h("option", { value: v }, label === v ? v : `${label} (${v})`)),
          );
          parse = (raw) => ({ ok: true, value: raw });
        } else if (t === "number" || t === "integer") {
          control = h("input", { class: "input", id, type: "number", step: t === "integer" ? "1" : "any", inputMode: "decimal" });
          parse = (raw) => (Number.isFinite(Number(raw)) ? { ok: true, value: Number(raw) } : { ok: false, error: "Enter a number." });
        } else if (t === "boolean") {
          control = h("select", { class: "select", id }, h("option", { value: "" }, "—"), h("option", { value: "true" }, "true"), h("option", { value: "false" }, "false"));
          parse = (raw) => ({ ok: true, value: raw === "true" });
        } else if (t === "object" || t === "array" || t.endsWith("[]")) {
          control = h("textarea", { class: "textarea textarea-compact mono", id, rows: 2, spellcheck: false, placeholder: t === "object" ? "{ }" : "[ ]" });
          parse = (raw) => {
            try {
              return { ok: true, value: JSON.parse(raw) };
            } catch {
              return { ok: false, error: "That isn't valid JSON." };
            }
          };
        } else {
          control = h("input", { class: "input", id, type: "text", autocomplete: "off" });
          parse = (raw) => ({ ok: true, value: raw });
        }
        if (ex !== undefined && ex !== null) control.value = typeof ex === "object" ? JSON.stringify(ex) : String(ex);
        if (control instanceof HTMLInputElement) {
          control.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          });
        }
        const f = field({
          label: name,
          control,
          hint: spec.description || undefined,
          extra: spec.required ? badge("Required", "accent") : h("span", { class: "muted small" }, "optional"),
          cls: "arg-field",
        });
        control.addEventListener("input", () => f.setError(null));
        fields.push(f.el);
        this.readers.push({
          name,
          focus: () => control.focus(),
          setError: (m) => f.setError(m),
          read: () => {
            const raw = control.value.trim();
            if (!raw) return spec.required ? { ok: false, error: `Fill in ${name}.` } : { ok: true, value: undefined };
            return parse(raw);
          },
        });
      }
    } else {
      // The engine didn't describe the arguments: take them as JSON.
      const id = uid("args");
      const ta = h("textarea", {
        class: "textarea mono",
        id,
        rows: 4,
        spellcheck: false,
        value: JSON.stringify(example ?? {}, null, 2),
      });
      const f = field({
        label: "Arguments (JSON)",
        control: ta,
        hint: "An object with the skill's arguments — see its code for the names.",
      });
      ta.addEventListener("input", () => f.setError(null));
      ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSubmit();
      });
      fields.push(f.el);
      this.readers.push({
        name: null,
        focus: () => ta.focus(),
        setError: (m) => f.setError(m),
        read: () => {
          try {
            const v: unknown = JSON.parse(ta.value.trim() || "{}");
            if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "Use a JSON object, like { \"city\": \"Paris\" }." };
            return { ok: true, value: v };
          } catch {
            return { ok: false, error: "That isn't valid JSON." };
          }
        },
      });
    }
    this.el = fields.length
      ? h("div", { class: "args-grid" }, fields)
      : h("p", { class: "muted small args-none" }, "This skill takes no arguments.");
  }

  /** The args object, or null after marking what's wrong. */
  values(): Record<string, unknown> | null {
    let args: Record<string, unknown> = {};
    let firstBad: (() => void) | null = null;
    for (const r of this.readers) {
      const res = r.read();
      r.setError(res.ok ? null : res.error);
      if (!res.ok) {
        firstBad ??= () => r.focus();
        continue;
      }
      if (r.name === null) args = res.value as Record<string, unknown>;
      else if (res.value !== undefined) args[r.name] = res.value;
    }
    if (firstBad) {
      firstBad();
      return null;
    }
    return args;
  }
}

/**
 * The workspace frame's limits for model-written HTML (web/src/workspace/frame.ts frameCsp): nothing
 * remote — images and media only from data:/blob: and this app's own origin — so the preview shows
 * what a call would, and can't send requests of its own.
 */
function previewCsp(): string {
  const origin = /^https?:/.test(location.origin) ? location.origin : "";
  const media = ["data:", "blob:", origin].filter(Boolean).join(" ");
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${media}; media-src ${media}; font-src data:`;
}

function resultView(r: SkillTestResult): HTMLElement {
  const res = r.result;
  const ok = r.ok && (res?.ok ?? true);
  const secs = r.ms !== null ? (r.ms < 1000 ? `${Math.round(r.ms)} ms` : `${(r.ms / 1000).toFixed(1)} s`) : null;
  const parts: HTMLElement[] = [
    h(
      "div",
      { class: "test-status" },
      ok ? badge("Worked", "ok", "check") : badge("Failed", "danger", "alert"),
      secs ? h("span", { class: "muted small" }, `in ${secs}`) : null,
    ),
  ];
  if (res?.say) parts.push(h("div", { class: "test-say" }, h("span", { class: "test-k" }, "Says"), h("q", null, res.say)));
  const error = r.error ?? res?.error;
  if (error) parts.push(h("div", { class: "notice notice-error notice-compact" }, icon("alert"), h("span", null, error)));
  if (res?.data !== undefined) {
    let text: string;
    try {
      text = JSON.stringify(res.data, null, 2);
    } catch {
      text = String(res.data);
    }
    if (text.length > 6000) text = `${text.slice(0, 6000)}\n…`;
    parts.push(h("details", { class: "test-data" }, h("summary", null, "Data"), h("pre", { class: "code" }, h("code", null, text))));
  }
  if (res?.render) {
    // Model-written HTML: shown in an opaque, script-less sandbox, under the workspace frame's CSP (and,
    // like there, without its <link> hints, which reach their host whatever the CSP says).
    const frame = h("iframe", {
      class: "test-render",
      title: "What the skill shows in the workspace",
      srcdoc: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp()}"><style>html{color-scheme:dark}body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;color:#e9e9f2;background:#0f0f19}</style>${withoutLinks(res.render)}`,
      referrerPolicy: "no-referrer",
      loading: "lazy",
    });
    frame.setAttribute("sandbox", "");
    parts.push(h("div", { class: "test-k" }, "In the workspace"), frame);
  }
  if (!res && !error) parts.push(h("p", { class: "muted small" }, "The skill returned nothing."));
  return h("div", { class: ["test-result", ok ? "is-ok" : "is-fail"], role: "status" }, parts);
}

// ─── A skill Trinity created ─────────────────────────────────────────────────

interface RowHandlers {
  toggled(skill: Skill): void;
  deleted(name: string): void;
}

class ForgedRow {
  readonly el: HTMLElement;
  private skill: Skill;
  private panel: "code" | "test" | null = null;
  private code: string | null = null;
  private codeError: string | null = null;
  private codeLoading = false;
  /** Argument specs learned from the source endpoint, when the list didn't carry them. */
  private extra: Pick<Skill, "input" | "examples"> | null = null;
  private form: ArgsForm | null = null;
  private result: HTMLElement | null = null;
  private testing = false;
  private readonly head: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly sw: { el: HTMLLabelElement; input: HTMLInputElement };
  private readonly codeBtn: HTMLButtonElement;
  private readonly testBtn: HTMLButtonElement;
  private readonly runBtn: HTMLButtonElement;

  constructor(skill: Skill, private readonly handlers: RowHandlers) {
    this.skill = skill;
    this.sw = switchInput({ checked: skill.enabled, label: "", onchange: (on, input) => void this.toggle(on, input) });
    this.codeBtn = button("View code", { icon: "code", size: "sm", variant: "ghost", onclick: () => this.open("code") });
    this.testBtn = button("Test", { icon: "flask", size: "sm", variant: "ghost", onclick: () => this.open("test") });
    this.runBtn = button("Run test", { icon: "play", size: "sm", variant: "primary", onclick: () => void this.runTest() });
    const del = button(null, { icon: "trash", size: "sm", variant: "danger", title: "Delete skill", onclick: () => void this.remove() });
    this.head = h("div", { class: "forged-main" });
    this.panelEl = h("div", { class: "forged-panel", hidden: true });
    this.el = h(
      "article",
      { class: "forged-row", dataset: { skill: skill.name } },
      h("div", { class: "forged-top" }, this.sw.el, this.head, h("div", { class: "forged-actions" }, this.codeBtn, this.testBtn, del)),
      this.panelEl,
    );
    this.renderHead();
    this.renderPanel();
  }

  /** New data from the list: the head only — an open panel (code scroll, typed arguments) stays put. */
  update(skill: Skill): void {
    this.skill = skill;
    this.renderHead();
  }

  flash(): void {
    this.el.classList.remove("is-new");
    void this.el.offsetWidth; // restart the animation
    this.el.classList.add("is-new");
    this.el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private renderHead(): void {
    const s = this.skill;
    this.sw.input.checked = s.enabled;
    const label = s.enabled ? `Turn off “${s.name}”` : `Turn on “${s.name}”`;
    this.sw.input.setAttribute("aria-label", label);
    this.sw.el.title = label;
    this.el.classList.toggle("is-off", !s.enabled);
    const meta: (string | HTMLElement)[] = [];
    if (s.createdAt) meta.push(`Made ${relTime(s.createdAt)}`);
    if (s.model) meta.push(h("span", { class: "chip chip-mono", title: "The coder that wrote it" }, s.model));
    setChildren(
      this.head,
      h(
        "div",
        { class: "forged-name-row" },
        h("span", { class: "skill-name" }, s.name),
        s.problem ? badge("Can't load", "danger", "alert") : s.enabled ? null : badge("Off"),
      ),
      h("div", { class: "skill-desc" }, s.description || "No description."),
      s.problem ? h("div", { class: "field-error", role: "status" }, s.problem) : null,
      s.need ? h("div", { class: "forged-need" }, icon("sparkles"), h("span", null, "Made for: ", h("q", null, s.need))) : null,
      meta.length ? h("div", { class: "forged-meta" }, meta.flatMap((m, i) => (i ? [h("span", { class: "meta-sep", "aria-hidden": "true" }, "·"), m] : [m]))) : null,
    );
    for (const [btn, which] of [
      [this.codeBtn, "code"],
      [this.testBtn, "test"],
    ] as const) {
      btn.setAttribute("aria-expanded", String(this.panel === which));
      btn.classList.toggle("is-on", this.panel === which);
    }
  }

  private open(which: "code" | "test"): void {
    this.panel = this.panel === which ? null : which;
    const notFetched = this.code === null && !this.codeError && !this.codeLoading;
    if (this.panel === "code" && this.code === null && !this.codeLoading) void this.loadCode();
    // No argument specs in the list: the source endpoint may have them.
    else if (this.panel === "test" && !this.form && !this.skill.input && notFetched) void this.loadCode();
    this.renderHead();
    this.renderPanel();
    if (this.panel === "test") requestAnimationFrame(() => this.panelEl.querySelector<HTMLElement>("input, select, textarea")?.focus());
  }

  /** The source endpoint gives the code — and, on some engines, the argument specs too. */
  private async loadCode(): Promise<void> {
    this.codeLoading = true;
    this.codeError = null;
    this.renderPanel();
    try {
      const r = await api.skills.source(this.skill.name, { quiet: true });
      this.code = r.code;
      if (r.skill?.input || r.skill?.examples) this.extra = { input: r.skill.input, examples: r.skill.examples };
    } catch (err) {
      this.codeError = isNotAvailable(err)
        ? "Viewing code needs an engine update."
        : (err as Error).message || "The engine didn't answer.";
    } finally {
      this.codeLoading = false;
      this.renderPanel();
    }
  }

  private renderPanel(): void {
    const p = this.panel;
    this.panelEl.hidden = !p;
    if (!p) {
      this.panelEl.replaceChildren();
      return;
    }
    if (p === "code") {
      setChildren(
        this.panelEl,
        this.codeLoading
          ? h("div", { class: "card-pad" }, skeletonLines(4))
          : this.codeError
            ? h("div", { class: "notice notice-error notice-compact" }, icon("alert"), h("span", null, this.codeError))
            : codeBlock(this.skill.name, this.code ?? ""),
      );
      return;
    }
    // Test: wait for the specs if they're being fetched, then build the form once (keeps what's typed).
    const input = this.skill.input ?? this.extra?.input ?? null;
    if (!this.form && this.codeLoading && !input) {
      setChildren(this.panelEl, h("div", { class: "card-pad" }, skeletonLines(2)));
      return;
    }
    const examples = this.skill.examples ?? this.extra?.examples;
    this.form ??= new ArgsForm(input, examples?.[0], () => void this.runTest());
    setChildren(
      this.panelEl,
      h(
        "div",
        { class: "test-panel" },
        h(
          "p",
          { class: "test-lede" },
          icon("shield"),
          "Runs once in the skill's sandbox — its own process, no files or keys, a 15-second limit — exactly as Trinity would run it.",
        ),
        this.form.el,
        h(
          "div",
          { class: "form-actions test-actions" },
          examples?.length ? h("span", { class: "muted small" }, "Filled in from the skill's own example.") : null,
          h("span", { class: "spacer" }),
          this.runBtn,
        ),
        this.result,
      ),
    );
  }

  private async runTest(): Promise<void> {
    if (this.testing || !this.form) return;
    const args = this.form.values();
    if (!args) return;
    this.testing = true;
    try {
      const r = await withBusy(this.runBtn, () => api.skills.test(this.skill.name, args, { quiet: true }), "Running…");
      this.result = resultView(r);
    } catch (err) {
      const msg = isNotAvailable(err) ? "Testing skills needs an engine update." : (err as Error).message || "The test didn't finish.";
      this.result = resultView({ ok: false, result: null, ms: null, error: msg });
    } finally {
      this.testing = false;
      this.renderPanel();
    }
  }

  private async toggle(on: boolean, input: HTMLInputElement): Promise<void> {
    input.disabled = true;
    try {
      const updated = await api.skills.setEnabled(this.skill.name, on, { quiet: (e) => e.notAvailable });
      this.skill = updated ?? { ...this.skill, enabled: on };
      this.handlers.toggled(this.skill);
      toast(on ? `“${this.skill.name}” is on — Jev can use it` : `“${this.skill.name}” is off`, "info");
    } catch (err) {
      if (isNotAvailable(err)) toast("Turning skills on and off needs an engine update.", "warn");
      input.checked = !on;
    } finally {
      input.disabled = false;
      this.renderHead();
    }
  }

  private async remove(): Promise<void> {
    const ok = await confirmAction({
      title: `Delete “${this.skill.name}”?`,
      message: "Trinity can't use it anymore, and its code is removed. She can make a new one if you ask again.",
      confirmLabel: "Delete skill",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.skills.remove(this.skill.name, { quiet: (e) => e.notAvailable });
      this.handlers.deleted(this.skill.name);
      toast(`Deleted “${this.skill.name}”`, "success");
    } catch (err) {
      if (isNotAvailable(err)) toast("Deleting skills needs an engine update.", "warn");
    }
  }
}

// ─── Section ─────────────────────────────────────────────────────────────────

export function createSkillsSection(): Section {
  let data: SkillsData | null = null;
  let loadFailed: string | null = null;
  let filter = "";
  let toolsets: Toolset[] = toolsetsRes.peek() ?? FALLBACK_TOOLSETS;
  const rows = new Map<string, ForgedRow>();
  const openPending = new Set<string>();
  /** A skill just created from the box below — flashed once its row exists. */
  let highlight: string | null = null;

  const pendingEl = h("div", { class: "skills-pending", hidden: true });
  const forgedCard = h("div", { class: "card forged-card" });
  const forgeCard = h("div", { class: "card forge-card" });
  const otherCard = h("div", { class: "card" });

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-skills" },
    sectionHead({
      id: "sec-skills",
      title: "Skills",
      lede: "The tools Jev can call while you talk. When you ask for something Trinity can't do yet, she writes a new skill on the fly — each one runs in its own sandbox and is tested before she uses it.",
    }),
    h("div", { class: "skills-stack" }, pendingEl, forgedCard, forgeCard, otherCard),
  );

  // ── Approval mode (Endpoints.skillApproval) ──

  const approvalNote = h("span", { class: "approval-state" });
  const approval = segmented({
    look: "cards",
    value: "",
    options: [
      { value: "auto", label: "Use right away", icon: "zap", hint: "After its sandbox test passes, Trinity starts using it and tells you." },
      { value: "manual", label: "Ask me first", icon: "shield", hint: "It waits here until you read the code and approve it." },
    ],
    onchange: (v) => void setApproval(v === "manual" ? "manual" : "auto"),
  });
  const approvalRow = h(
    "div",
    { class: "approval-row" },
    h("div", { class: "approval-text" }, h("div", { class: "field-label", id: "skill-approval-label" }, "When Trinity makes a new skill"), approvalNote),
    approval.el,
  );
  approval.el.setAttribute("aria-labelledby", "skill-approval-label");

  function renderApproval(): void {
    const ep = endpointsRes.peek();
    const mode = ep?.skillApproval;
    const known = mode === "auto" || mode === "manual";
    approval.set(known ? mode : "");
    approval.setDisabled(!known);
    setChildren(approvalNote, ep && !known ? badge("Needs engine update", "info") : null);
  }

  async function setApproval(mode: "auto" | "manual"): Promise<void> {
    approval.setDisabled(true);
    try {
      const updated = await api.endpoints.update({ skillApproval: mode }, { action: "change how new skills are approved" });
      if (updated.skillApproval !== mode) throw new Error("not taken");
      endpointsRes.set(updated);
      announce("endpoints");
      toast(mode === "manual" ? "New skills will wait for your approval." : "New skills are used as soon as they pass their sandbox test.", "success");
    } catch (err) {
      if (err instanceof Error && err.message === "not taken") toast("This engine can't change the approval mode yet.", "warn");
    } finally {
      renderApproval();
      renderPending();
    }
  }

  // ── Waiting for approval ──

  function pendingCard(s: PendingSkill): HTMLElement {
    const isOpen = openPending.has(s.name);
    const toggle = button(isOpen ? "Hide code" : "Review code", {
      icon: "code",
      size: "sm",
      variant: "ghost",
      onclick: () => {
        if (openPending.has(s.name)) openPending.delete(s.name);
        else openPending.add(s.name);
        renderPending();
      },
    });
    toggle.setAttribute("aria-expanded", String(isOpen));
    const discard = button("Discard", { size: "sm", variant: "danger", icon: "trash" });
    discard.addEventListener("click", () => void discardSkill(s, discard));
    const approve = button("Approve", { size: "sm", variant: "primary", icon: "check" });
    approve.addEventListener("click", () => void approveSkill(s, approve));
    const meta = [s.createdAt ? `Made ${relTime(s.createdAt)}` : null, s.model ?? null].filter(Boolean) as string[];
    return h(
      "article",
      { class: "card pending-card" },
      h(
        "div",
        { class: "pending-head" },
        h("span", { class: "card-icon" }, icon("sparkles")),
        h(
          "div",
          { class: "pending-text" },
          h("div", { class: "skill-name" }, s.name),
          h("div", { class: "skill-desc" }, s.description || "No description."),
          s.need ? h("div", { class: "forged-need" }, icon("sparkles"), h("span", null, "Made for: ", h("q", null, s.need))) : null,
          meta.length ? h("div", { class: "forged-meta" }, meta.join(" · ")) : null,
        ),
        badge("Needs review", "accent"),
      ),
      isOpen && s.code ? h("div", { class: "pending-code" }, codeBlock(s.name, s.code)) : null,
      h("div", { class: "pending-actions" }, s.code ? toggle : null, h("span", { class: "spacer" }), discard, approve),
    );
  }

  function renderPending(): void {
    const list = data?.pending ?? [];
    if (!list.length) {
      setChildren(pendingEl);
      pendingEl.hidden = true;
      return;
    }
    pendingEl.hidden = false;
    setChildren(
      pendingEl,
      h(
        "div",
        { class: "pending-banner" },
        icon("sparkles"),
        h(
          "div",
          null,
          h("strong", null, `${plural(list.length, "new skill")} waiting for your approval`),
          h("span", null, " — Trinity made these and they passed their sandbox test. Read the code, then approve or discard."),
        ),
      ),
      h("div", { class: "pending-list" }, list.map(pendingCard)),
    );
  }

  async function approveSkill(s: PendingSkill, btn: HTMLButtonElement): Promise<void> {
    const ok = await confirmAction({
      title: `Approve “${s.name}”?`,
      message: "Trinity can use it on calls right away. It runs in its own sandbox; you can turn it off or delete it here later.",
      confirmLabel: "Approve skill",
    });
    if (!ok) return;
    try {
      await withBusy(btn, () => api.skills.approve(s.name), "Approving…");
      toast(`“${s.name}” is ready — Jev can use it now`, "success");
      highlight = s.name;
      skillsRes.update((d) => ({ ...d, pending: d.pending.filter((p) => p.name !== s.name) }));
      announce("skills");
      void skillsRes.refresh().catch(() => {});
    } catch {
      /* reported */
    }
  }

  async function discardSkill(s: PendingSkill, btn: HTMLButtonElement): Promise<void> {
    const ok = await confirmAction({
      title: `Discard “${s.name}”?`,
      message: "The draft is deleted. Trinity can make a new one if you ask again.",
      confirmLabel: "Discard draft",
      danger: true,
    });
    if (!ok) return;
    try {
      await withBusy(btn, () => api.skills.discard(s.name), "Discarding…");
      skillsRes.update((d) => ({ ...d, pending: d.pending.filter((p) => p.name !== s.name) }));
      toast(`Discarded “${s.name}”`, "success");
      announce("skills");
    } catch {
      /* reported */
    }
  }

  // ── Created by Trinity ──

  const forgedCount = h("span", { class: "count", hidden: true });
  const forgedBody = h("div", { class: "forged-body" });
  forgedCard.append(
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon("wand")),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, "Created by Trinity", forgedCount),
        h("p", { class: "card-sub" }, "Skills she wrote for herself. Each runs in its own sandbox: no files, no API keys, a 15-second limit — it can call public web services."),
      ),
    ),
    approvalRow,
    forgedBody,
  );

  const rowHandlers: RowHandlers = {
    toggled: (skill) => {
      skillsRes.update((d) => ({ ...d, all: d.all.map((x) => (x.name === skill.name ? { ...x, ...skill } : x)) }));
      announce("skills");
    },
    deleted: (name) => {
      rows.get(name)?.el.remove();
      rows.delete(name);
      skillsRes.update((d) => ({ ...d, all: d.all.filter((x) => x.name !== name) }));
      announce("skills");
    },
  };

  function renderForged(): void {
    if (loadFailed) {
      forgedCount.hidden = true;
      setChildren(forgedBody, errorState(loadFailed, () => void load(true), true));
      return;
    }
    if (!data) {
      setChildren(forgedBody, h("div", { class: "card-pad" }, skeletonLines(3)));
      return;
    }
    const forged = data.all
      .filter((s) => s.source === FORGED)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name));
    forgedCount.hidden = !forged.length;
    forgedCount.textContent = String(forged.length);
    for (const name of [...rows.keys()]) if (!forged.some((s) => s.name === name)) rows.delete(name);
    if (!forged.length) {
      setChildren(
        forgedBody,
        emptyState({
          icon: "wand",
          compact: true,
          title: "No skills yet",
          body: "Ask Trinity for something she can't do yet — “make a skill that converts currencies” — or describe one below. It shows up here.",
        }),
      );
      return;
    }
    const els = forged.map((s) => {
      let row = rows.get(s.name);
      if (row) row.update(s);
      else {
        row = new ForgedRow(s, rowHandlers);
        rows.set(s.name, row);
      }
      return row.el;
    });
    // Re-attach in order without rebuilding rows (open panels and typed arguments survive).
    const list = forgedBody.querySelector<HTMLElement>(".forged-list") ?? h("div", { class: "forged-list" });
    if (!list.isConnected) setChildren(forgedBody, list);
    els.forEach((rowEl, i) => {
      if (list.children[i] !== rowEl) list.insertBefore(rowEl, list.children[i] ?? null);
    });
    while (list.children.length > els.length) list.lastElementChild?.remove();
    if (highlight && rows.has(highlight)) {
      rows.get(highlight)?.flash();
      highlight = null;
    }
  }

  // ── Create a skill ──

  const need = h("textarea", {
    class: "textarea",
    id: "forge-need",
    rows: 3,
    maxLength: 600,
    placeholder: "e.g. Convert between currencies using today's exchange rates.",
  });
  const fNeed = field({
    label: "What should the new skill do?",
    control: need,
    hint: "Plain words work. Name a web service if you have one in mind — skills can call public APIs, but get no API keys.",
  });
  const ideas = h(
    "div",
    { class: "presets ideas", role: "group", "aria-label": "Ideas" },
    h("span", { class: "ideas-label" }, "Try:"),
    IDEAS.map((idea) =>
      h(
        "button",
        {
          type: "button",
          class: "preset",
          onclick: () => {
            need.value = idea;
            fNeed.setError(null);
            need.focus();
          },
        },
        idea,
      ),
    ),
  );
  const forgeBtn = button("Create skill", { icon: "wand", variant: "primary" });
  const forgeStatus = h("div", { class: "forge-status", "aria-live": "polite" });
  let forging = false;
  let forgeAvailable = true;

  forgeCard.append(
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon("plus")),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, "Create a skill"),
        h("p", { class: "card-sub" }, "Trinity writes it with the coding skill, tests it in the sandbox, fixes it once if the test fails, and adds it to her tools. You can also just ask on a call."),
      ),
    ),
    h(
      "div",
      { class: "card-pad form-stack" },
      fNeed.el,
      ideas,
      forgeStatus,
      h("div", { class: "form-actions" }, h("span", { class: "muted small forge-time" }, "Usually takes 30–90 seconds."), h("span", { class: "spacer" }), forgeBtn),
    ),
  );

  need.addEventListener("input", () => fNeed.setError(null));
  need.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void forge();
  });
  forgeBtn.addEventListener("click", () => void forge());

  function setForgeNotice(kind: "info" | "error" | "warn" | "ok" | null, ...content: (string | HTMLElement)[]): void {
    if (!kind) {
      setChildren(forgeStatus);
      return;
    }
    const ic = kind === "ok" ? "check" : kind === "info" ? "clock" : "alert";
    setChildren(forgeStatus, h("div", { class: `notice notice-${kind} notice-compact` }, icon(ic), h("span", null, content)));
  }

  /** Re-read the skills every 10 s (for up to 5 min) until one that wasn't there before shows up. */
  async function watchForNewSkill(before: Set<string>): Promise<void> {
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10_000));
      const fresh = await skillsRes.refresh().catch(() => null);
      const made = fresh && [...fresh.all.map((s) => s.name), ...fresh.pending.map((p) => p.name)].find((n) => !before.has(n));
      if (made) {
        highlight = made;
        setForgeNotice("ok", h("strong", null, `Made “${made}”. `), "It's listed below.");
        renderForged();
        announce("skills");
        return;
      }
    }
    setForgeNotice("error", "It's taking unusually long — check back in a minute, or try again.");
  }

  async function forge(): Promise<void> {
    if (forging || !forgeAvailable) return;
    const text = need.value.trim().replace(/\s+/g, " ");
    if (text.length < 8) {
      fNeed.setError("Describe the skill in a few words.");
      need.focus();
      return;
    }
    forging = true;
    need.disabled = true;
    const started = Date.now();
    const known = skillsRes.peek();
    const before = new Set([...(known?.all ?? []).map((s) => s.name), ...(known?.pending ?? []).map((p) => p.name)]);
    const tick = () => setForgeNotice("info", `Writing and testing the skill… ${Math.round((Date.now() - started) / 1000)} s`);
    tick();
    const timer = window.setInterval(tick, 1000);
    try {
      const r = await withBusy(forgeBtn, () => api.skills.forge(text, { quiet: (e) => e.notAvailable }), "Creating…");
      if (!r.ok) {
        setForgeNotice("error", h("strong", null, "Couldn't make that skill. "), r.reason);
        return;
      }
      const fresh = await skillsRes.refresh().catch(() => null);
      const waiting = fresh?.pending.some((p) => p.name === r.skill.name) ?? false;
      need.value = "";
      if (waiting) {
        setForgeNotice("ok", h("strong", null, `Made “${r.skill.name}”. `), "It's waiting for your approval at the top of this page.");
        pendingEl.scrollIntoView({ block: "start", behavior: "smooth" });
      } else {
        highlight = r.skill.name;
        setForgeNotice("ok", h("strong", null, `Made “${r.skill.name}”. `), r.skill.description || "Jev can use it now.");
        renderForged();
      }
      announce("skills");
    } catch (err) {
      if (isNotAvailable(err)) {
        forgeAvailable = false;
        renderForgeAvailability();
      } else if (err instanceof ApiError && err.status === 0) {
        // The request timed out, but the engine keeps working (skills are made one at a time, and two
        // coders plus a repair round can take minutes): watch for the new skill to appear.
        setForgeNotice("info", h("strong", null, "Still working. "), "It will appear here when it's done.");
        void watchForNewSkill(before);
      } else {
        setForgeNotice("error", (err as Error).message || "The engine didn't answer.");
      }
    } finally {
      window.clearInterval(timer);
      forging = false;
      need.disabled = !forgeAvailable;
    }
  }

  function renderForgeAvailability(): void {
    need.disabled = !forgeAvailable;
    forgeBtn.disabled = !forgeAvailable;
    for (const b of ideas.querySelectorAll<HTMLButtonElement>("button")) b.disabled = !forgeAvailable;
    if (!forgeAvailable) {
      setForgeNotice("warn", "Creating skills here needs an engine update. You can still ask Trinity for a new skill on a call.");
    }
  }

  // ── Built-in, hand-written, and toolset tools ──

  const search = h("input", {
    class: "input input-search",
    type: "search",
    placeholder: "Filter tools…",
    "aria-label": "Filter tools",
    autocomplete: "off",
  });
  search.addEventListener("input", () => {
    filter = search.value.trim().toLowerCase();
    renderOther();
  });
  const otherCount = h("span", { class: "count", hidden: true });
  const otherBody = h("div", { class: "active-body" });
  otherCard.append(
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon card-icon-muted" }, icon("sparkles")),
      h(
        "div",
        { class: "card-head-text" },
        h("h2", { class: "card-title" }, "Other tools", otherCount),
        h("p", { class: "card-sub" }, "Built into the engine, written by hand, or added by a persona's toolset."),
      ),
      h("div", { class: "card-head-side" }, search),
    ),
    otherBody,
  );

  function renderOther(): void {
    const all = data && !loadFailed ? data.all.filter((s) => s.source !== FORGED) : [];
    otherCount.hidden = !all.length;
    otherCount.textContent = String(all.length);
    search.hidden = all.length <= 6;
    if (loadFailed) {
      setChildren(otherBody, h("div", { class: "card-pad muted" }, "Couldn't load the tool list."));
      return;
    }
    if (!data) {
      setChildren(otherBody, h("div", { class: "card-pad" }, skeletonLines(4)));
      return;
    }
    if (!all.length) {
      setChildren(otherBody, emptyState({ icon: "sparkles", compact: true, title: "No tools loaded", body: "The engine didn't report any tools." }));
      return;
    }
    const shown = filter ? all.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(filter)) : all;
    const groups = new Map<string, Skill[]>();
    for (const s of shown) {
      const key = groupKey(s, toolsets);
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const body = shown.length
      ? h(
          "div",
          { class: "skill-groups" },
          [...groups.entries()]
            .map(([key, list]) => ({ key, list, info: groupInfo(key, toolsets) }))
            .sort((a, b) => a.info.order - b.info.order || a.key.localeCompare(b.key))
            .map(({ key, list, info }) =>
              h(
                "div",
                { class: ["skill-group", key.startsWith("toolset:") && "is-toolset"] },
                h("h3", { class: "mini-title" }, info.title, h("span", { class: "mini-count" }, String(list.length))),
                info.sub ? h("p", { class: "mini-sub" }, info.sub) : null,
                h(
                  "div",
                  { class: "skill-grid" },
                  [...list]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((s) =>
                      h(
                        "div",
                        { class: ["skill-card", !s.enabled && "is-off"] },
                        h(
                          "div",
                          { class: "skill-card-top" },
                          h("span", { class: "skill-name" }, s.name),
                          s.enabled ? badge(info.badge, info.tone) : badge("Off"),
                        ),
                        h("div", { class: "skill-desc" }, s.description || "No description."),
                      ),
                    ),
                ),
              ),
            ),
        )
      : h("div", { class: "card-pad muted" }, `No tools match “${filter}”.`);
    setChildren(otherBody, body);
  }

  function render(): void {
    renderPending();
    renderApproval();
    renderForged();
    renderOther();
  }

  async function load(force = false): Promise<void> {
    loadFailed = null;
    render();
    void endpointsRes.get().catch(() => {});
    try {
      data = force ? await skillsRes.refresh() : await skillsRes.get();
    } catch (err) {
      loadFailed = (err as Error).message || "The engine didn't answer.";
    }
    render();
  }

  skillsRes.subscribe((d) => {
    data = d;
    loadFailed = null;
    render();
  });
  toolsetsRes.subscribe((list) => {
    toolsets = list;
    renderOther();
  });
  endpointsRes.subscribe(() => renderApproval());

  let started = false;
  return {
    el,
    show() {
      if (!started) {
        started = true;
        void load();
      } else void skillsRes.refresh().catch(() => {});
    },
    refresh() {
      if (started) void skillsRes.refresh().catch(() => {});
    },
  };
}
