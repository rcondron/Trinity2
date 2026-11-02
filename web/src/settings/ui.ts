// Small DOM toolkit for the settings page: an element builder, icons, toasts,
// dialogs, formatting helpers, and shared building blocks (fields, empty states,
// skeletons, buttons). Text always goes in as text nodes — never as HTML.

import { svgIcon, type IconName } from "./icons.js";

export type { IconName };

/** One routed page of the settings app (see main.ts). */
export interface Section {
  el: HTMLElement;
  /** Called every time the section becomes visible. `sub` is the hash part after "/" (e.g. a persona id). */
  show(sub: string | null): void;
  hide?(): void;
  /** True when leaving the page would lose edits. */
  isDirty?(): boolean;
  /** Light refresh when the tab regains focus. */
  refresh?(): void;
}

// ─── Element builder ─────────────────────────────────────────────────────────

export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type Props = Record<string, unknown>;

/** Attributes whose DOM properties are read-only (or absent) — always set as attributes. */
const ATTR_ONLY = new Set(["list", "form", "for", "role"]);

/**
 * `h("button", { class: "btn", onclick: fn, "aria-label": "Close" }, icon("x"), "Close")`
 * - `class` takes a string or an array (falsy entries dropped); `style` a CSS string;
 *   `dataset` an object; `html` trusted markup; `on<event>` listeners.
 * - Known DOM properties (value, checked, disabled, type, title, rows…) are set as
 *   properties; everything else (aria-*, data-*, role, for, list) as attributes.
 * - `value` is applied after children so a <select> can pick one of its options.
 * - null / undefined / false values are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  let value: unknown;
  let hasValue = false;
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === "value") {
        value = val;
        hasValue = true;
      } else if (key === "class") {
        el.className = Array.isArray(val) ? val.filter(Boolean).join(" ") : String(val);
      } else if (key === "style") {
        el.setAttribute("style", String(val));
      } else if (key === "dataset") {
        Object.assign(el.dataset, val as Record<string, string>);
      } else if (key === "html") {
        el.innerHTML = String(val);
      } else if (key.startsWith("on") && typeof val === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (!ATTR_ONLY.has(key) && !key.includes("-") && key in el) {
        (el as unknown as Record<string, unknown>)[key] = val;
      } else {
        el.setAttribute(key, val === true ? "" : String(val));
      }
    }
  }
  append(el, children);
  if (hasValue) (el as unknown as { value: unknown }).value = value;
  return el;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (c instanceof Node) parent.appendChild(c);
    else if (typeof c === "string" || typeof c === "number") parent.appendChild(document.createTextNode(String(c)));
    else append(parent, c);
  }
}

/** Replace all children. */
export function setChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function icon(name: IconName, cls = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls ? `i ${cls}` : "i";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = svgIcon(name);
  return s;
}

let uidCounter = 0;
export function uid(prefix = "f"): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

export type ButtonVariant = "default" | "primary" | "danger" | "danger-solid" | "ghost" | "subtle";

export interface ButtonOptions {
  icon?: IconName;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Tooltip; also the accessible name of icon-only buttons. */
  title?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  cls?: string;
  onclick?: (ev: MouseEvent) => void;
}

/** A button with an optional leading icon. `label: null` makes an icon-only button. */
export function button(label: string | null, o: ButtonOptions = {}): HTMLButtonElement {
  const cls = [
    "btn",
    o.variant && o.variant !== "default" ? `btn-${o.variant}` : "",
    o.size === "sm" ? "btn-sm" : "",
    label === null ? "btn-icon" : "",
    o.cls ?? "",
  ];
  const b = h(
    "button",
    {
      class: cls,
      type: o.type ?? "button",
      title: o.title,
      "aria-label": label === null ? o.title : undefined,
      disabled: o.disabled,
      onclick: o.onclick,
    },
    o.icon ? icon(o.icon) : null,
    label !== null ? h("span", { class: "btn-label" }, label) : null,
  );
  return b;
}

/** Change a button's label text (keeps its icon). */
export function setButtonLabel(btn: HTMLButtonElement, label: string): void {
  const span = btn.querySelector(".btn-label");
  if (span) span.textContent = label;
}

/** Swap the icon inside a button (or any element holding an `.i` icon span). */
export function setIcon(el: Element, name: IconName): void {
  const span = el.querySelector(".i");
  if (span) span.innerHTML = svgIcon(name);
}

/**
 * Run `fn` with the button disabled and spinning; restores it afterwards.
 * Optional `busyLabel` swaps the text while working.
 */
export async function withBusy<T>(btn: HTMLButtonElement, fn: () => Promise<T>, busyLabel?: string): Promise<T> {
  const label = btn.querySelector(".btn-label");
  const prevText = label?.textContent ?? null;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add("is-busy");
  btn.setAttribute("aria-busy", "true");
  if (busyLabel && label) label.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
    btn.disabled = wasDisabled;
    if (busyLabel && label && prevText !== null) label.textContent = prevText;
  }
}

// ─── Toasts ──────────────────────────────────────────────────────────────────

export type Tone = "info" | "success" | "warn" | "error";

export interface ToastOptions {
  action?: { label: string; run: () => void };
  timeoutMs?: number;
}

const TOAST_ICON: Record<Tone, IconName> = { info: "info", success: "check", warn: "alert", error: "alert" };
let toastRegion: HTMLElement | null = null;
const recentToasts = new Map<string, number>();

/** Show a toast (bottom-right). Identical toasts within 2s are collapsed into one. */
export function toast(message: string, tone: Tone = "info", opts: ToastOptions = {}): void {
  const key = `${tone}:${message}`;
  const now = Date.now();
  if ((recentToasts.get(key) ?? 0) > now - 2000) return;
  recentToasts.set(key, now);
  if (recentToasts.size > 50) recentToasts.clear();

  if (!toastRegion || !toastRegion.isConnected) {
    toastRegion = h("div", { class: "toasts", role: "region", "aria-label": "Notifications" });
    document.body.appendChild(toastRegion);
  }

  let timer = 0;
  const el: HTMLDivElement = h("div", {
    class: `toast tone-${tone}`,
    role: tone === "error" ? "alert" : "status",
  });
  const close = () => {
    window.clearTimeout(timer);
    if (!el.isConnected || el.classList.contains("is-leaving")) return;
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 180);
  };
  append(el, [
    h("span", { class: "toast-icon" }, icon(TOAST_ICON[tone])),
    h("div", { class: "toast-msg" }, message),
    opts.action
      ? h(
          "button",
          {
            class: "toast-action",
            type: "button",
            onclick: () => {
              opts.action?.run();
              close();
            },
          },
          opts.action.label,
        )
      : null,
    h("button", { class: "toast-close", type: "button", "aria-label": "Dismiss", onclick: close }, icon("x")),
  ]);
  toastRegion.appendChild(el);
  while (toastRegion.children.length > 4) toastRegion.firstElementChild?.remove();

  const ms = opts.timeoutMs ?? (tone === "error" ? 7000 : tone === "warn" ? 5500 : 3800);
  timer = window.setTimeout(close, ms);
  el.addEventListener("mouseenter", () => window.clearTimeout(timer));
  el.addEventListener("mouseleave", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(close, 2200);
  });
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────

export interface DialogButton {
  label: string;
  value: string;
  tone?: "default" | "primary" | "danger";
}

export interface ChooseOptions {
  title: string;
  message?: Child;
  buttons: DialogButton[];
  /** Returned on Escape / backdrop click. Default "cancel". */
  cancelValue?: string;
  icon?: IconName;
  tone?: "default" | "danger" | "warn";
}

/** A modal choice. Resolves with the clicked button's value (or cancelValue). */
export function choose(o: ChooseOptions): Promise<string> {
  return new Promise((resolve) => {
    const cancelValue = o.cancelValue ?? "cancel";
    const titleId = uid("dlg");
    const dlg = h("dialog", { class: `dialog tone-${o.tone ?? "default"}`, "aria-labelledby": titleId });
    let settled = false;
    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const buttons = o.buttons.map((b) =>
      button(b.label, {
        variant: b.tone === "primary" ? "primary" : b.tone === "danger" ? "danger-solid" : "default",
        onclick: () => finish(b.value),
      }),
    );
    append(dlg, [
      h(
        "div",
        { class: "dialog-inner" },
        h(
          "div",
          { class: "dialog-head" },
          h("span", { class: "dialog-icon" }, icon(o.icon ?? (o.tone === "danger" ? "trash" : o.tone === "warn" ? "alert" : "info"))),
          h("h2", { id: titleId, class: "dialog-title" }, o.title),
        ),
        o.message !== undefined ? h("div", { class: "dialog-body" }, o.message) : null,
        h("div", { class: "dialog-actions" }, buttons),
      ),
    ]);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(cancelValue);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) finish(cancelValue);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    // Focus the safest choice for destructive prompts, otherwise the primary one.
    const preferred = o.tone === "danger" ? buttons[0] : buttons[buttons.length - 1];
    preferred?.focus();
  });
}

/** Two-button confirm. */
export async function confirmAction(o: {
  title: string;
  message?: Child;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const v = await choose({
    title: o.title,
    message: o.message,
    tone: o.danger ? "danger" : "default",
    buttons: [
      { label: o.cancelLabel ?? "Cancel", value: "cancel" },
      { label: o.confirmLabel, value: "ok", tone: o.danger ? "danger" : "primary" },
    ],
  });
  return v === "ok";
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "Mar 3". */
export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return "never";
  const d = now - ts;
  if (d < 0) return relFuture(ts, now);
  if (d < 45_000) return "just now";
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 14 * DAY) return `${Math.round(d / DAY)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 * DAY ? "numeric" : undefined });
}

/** "now", "in 40 s", "in 5 min", "in 3 h", "in 2 days". */
export function relFuture(ts: number, now = Date.now()): string {
  const d = ts - now;
  if (d <= 5_000) return "now";
  if (d < MIN) return `in ${Math.round(d / 1000)} s`;
  if (d < HOUR) return `in ${Math.round(d / MIN)} min`;
  if (d < DAY) return `in ${Math.round(d / HOUR)} h`;
  return `in ${Math.round(d / DAY)} days`;
}

/** Local clock time in the browser's format: "3:45 PM" / "15:45". */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** When something happens next, in words: "in 8 min", "today at 3:45 PM", "tomorrow at 8:00 AM", "Monday at 9:00 AM", "Nov 12 at 9:00 AM". */
export function whenInWords(ts: number, now = Date.now()): string {
  const d = ts - now;
  if (d <= 30_000) return "now";
  if (d < 55 * MIN) return `in ${Math.max(1, Math.round(d / MIN))} min`;
  // Round: a day across a DST change is 23 or 25 hours long.
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
  const at = clockTime(ts);
  if (days <= 0) return `today at ${at}`;
  if (days === 1) return `tomorrow at ${at}`;
  if (days < 7) return `${new Date(ts).toLocaleDateString(undefined, { weekday: "long" })} at ${at}`;
  const date = new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: days > 300 ? "numeric" : undefined });
  return `${date} at ${at}`;
}

/** Full local date and time, for tooltips: "Saturday, November 1, 2026, 8:00 AM". */
export function fullDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

/** 6.4 → "6.4 s". */
export function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return "–";
  return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
}

/** 4.25 → "0:04.2". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** 300 → "every 5 min", 5400 → "every 1 h 30 min", 86400 → "every day". */
export function fmtInterval(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  if (s % 86400 === 0) return s === 86400 ? "every day" : `every ${s / 86400} days`;
  if (s < 60) return `every ${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `every ${m} min ${r} s` : `every ${m} min`;
  }
  const hrs = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `every ${hrs} h ${m} min` : hrs === 1 ? "every hour" : `every ${hrs} h`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ─── Avatars ─────────────────────────────────────────────────────────────────

export function hashHue(s: string): number {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

/** "Nova — Assistant" → "N", "The Game Master" → "GM". */
export function initials(name: string): string {
  const base = (name.split(/\s+[—–-]\s+/)[0] ?? name).replace(/^the\s+/i, "").trim();
  const words = base.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words
    .slice(0, 2)
    .map((w) => [...w.replace(/^[^\p{L}\p{N}]+/u, "")][0] ?? "")
    .join("");
  return (letters || "?").toUpperCase();
}

export function avatar(name: string, seed: string, size: "sm" | "md" | "lg" = "md"): HTMLSpanElement {
  return h("span", { class: `avatar avatar-${size}`, style: `--h:${hashHue(seed)}`, "aria-hidden": "true" }, initials(name));
}

// ─── Building blocks ─────────────────────────────────────────────────────────

export function sectionHead(o: { id: string; title: string; lede: Child; actions?: Child }): HTMLElement {
  return h(
    "header",
    { class: "sec-head" },
    h("div", { class: "sec-head-text" }, h("h1", { id: o.id, tabIndex: -1 }, o.title), h("p", { class: "lede" }, o.lede)),
    o.actions ? h("div", { class: "sec-head-actions" }, o.actions) : null,
  );
}

export interface FieldParts {
  el: HTMLDivElement;
  error: HTMLDivElement;
  setError(message: string | null): void;
}

/** label + control + hint + error slot. `extra` sits at the right end of the label row. */
export function field(o: {
  label: string;
  control: HTMLElement;
  /** Id of the labelled element when `control` is a wrapper (the user sets it on that element). */
  id?: string;
  hint?: Child;
  extra?: Child;
  cls?: string;
  /** Keep the label for assistive tech only (e.g. when a group heading already names it). */
  hideLabel?: boolean;
  /** The control is a group (radio buttons): label it with aria-labelledby instead of <label for>. */
  group?: boolean;
}): FieldParts {
  const id = o.id ?? (o.control.id || uid("f"));
  if (!o.id && !o.control.id) o.control.id = id;
  const error = h("div", { class: "field-error", role: "alert", hidden: true });
  const labelId = o.group ? uid("lbl") : undefined;
  if (labelId) o.control.setAttribute("aria-labelledby", labelId);
  const label = o.group
    ? h("div", { class: ["field-label", o.hideLabel ? "visually-hidden" : ""], id: labelId }, o.label)
    : h("label", { class: ["field-label", o.hideLabel ? "visually-hidden" : ""], for: id || undefined }, o.label);
  const el = h(
    "div",
    { class: ["field", o.cls ?? ""] },
    o.hideLabel && !o.extra
      ? label
      : h("div", { class: "field-top" }, label, o.extra ? h("span", { class: "field-extra" }, o.extra) : null),
    o.control,
    o.hint ? h("div", { class: "field-hint" }, o.hint) : null,
    error,
  );
  return {
    el,
    error,
    setError(message) {
      error.hidden = !message;
      error.textContent = message ?? "";
      el.classList.toggle("is-invalid", Boolean(message));
      const target = el.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? o.control;
      if (message) target.setAttribute("aria-invalid", "true");
      else target.removeAttribute("aria-invalid");
    },
  };
}

/** An accessible on/off switch (a real checkbox underneath). */
export function switchInput(o: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onchange?: (checked: boolean, input: HTMLInputElement) => void;
}): { el: HTMLLabelElement; input: HTMLInputElement } {
  const input = h("input", {
    type: "checkbox",
    role: "switch",
    checked: o.checked,
    disabled: o.disabled,
    "aria-label": o.label,
  });
  if (o.onchange) input.addEventListener("change", () => o.onchange?.(input.checked, input));
  const el = h("label", { class: "switch", title: o.label }, input, h("span", { class: "switch-track", "aria-hidden": "true" }));
  return { el, input };
}

export interface SegmentOption {
  value: string;
  label: string;
  icon?: IconName;
  /** A second line (the "cards" look only). */
  hint?: string;
}

export interface Segmented {
  el: HTMLDivElement;
  /** The chosen value, or "" when none is. */
  get(): string;
  /** Choose a value ("" clears the choice). */
  set(value: string): void;
  setDisabled(disabled: boolean): void;
  focus(): void;
}

/**
 * Mutually exclusive choices: real radio buttons (arrow keys move between them), drawn as a
 * pill bar — or, with `look: "cards"`, as cards with a hint line.
 */
export function segmented(o: {
  /** Accessible name, unless the user labels the group (field({ group: true })). */
  label?: string;
  options: SegmentOption[];
  value: string;
  look?: "pills" | "cards";
  onchange?: (value: string) => void;
}): Segmented {
  const name = uid("seg");
  const inputs: HTMLInputElement[] = [];
  const el = h(
    "div",
    { class: ["segmented", o.look === "cards" ? "segmented-cards" : ""], role: "radiogroup", "aria-label": o.label },
    o.options.map((opt) => {
      const input = h("input", { type: "radio", name, value: opt.value, checked: opt.value === o.value });
      input.addEventListener("change", () => {
        if (input.checked) o.onchange?.(opt.value);
      });
      inputs.push(input);
      return h(
        "label",
        { class: "seg" },
        input,
        h(
          "span",
          { class: "seg-body" },
          h("span", { class: "seg-label" }, opt.icon ? icon(opt.icon) : null, opt.label),
          o.look === "cards" && opt.hint ? h("span", { class: "seg-hint" }, opt.hint) : null,
        ),
      );
    }),
  );
  return {
    el,
    get: () => inputs.find((i) => i.checked)?.value ?? "",
    set(value) {
      for (const i of inputs) i.checked = i.value === value;
    },
    setDisabled(disabled) {
      for (const i of inputs) i.disabled = disabled;
      el.classList.toggle("is-disabled", disabled);
    },
    focus() {
      (inputs.find((i) => i.checked) ?? inputs[0])?.focus();
    },
  };
}

export function badge(text: string, tone: "default" | "ok" | "warn" | "danger" | "accent" | "info" = "default", ic?: IconName): HTMLSpanElement {
  return h("span", { class: `badge${tone === "default" ? "" : ` badge-${tone}`}` }, ic ? icon(ic) : null, text);
}

export function emptyState(o: {
  icon: IconName;
  title: string;
  body?: Child;
  action?: Child;
  tone?: "default" | "soon" | "error";
  compact?: boolean;
}): HTMLElement {
  return h(
    "div",
    { class: ["empty", `empty-${o.tone ?? "default"}`, o.compact ? "empty-compact" : ""] },
    h("div", { class: "empty-icon" }, icon(o.icon)),
    o.tone === "soon" ? h("span", { class: "badge badge-info empty-badge" }, "Not available yet") : null,
    h("div", { class: "empty-title" }, o.title),
    o.body ? h("div", { class: "empty-body" }, o.body) : null,
    o.action ? h("div", { class: "empty-action" }, o.action) : null,
  );
}

/** Friendly failure block with a Retry button. */
export function errorState(message: string, retry: () => void, compact = false): HTMLElement {
  return emptyState({
    icon: "alert",
    tone: "error",
    compact,
    title: "Couldn't load this",
    body: message,
    action: button("Try again", { icon: "refresh", onclick: retry }),
  });
}

export function skeletonLines(count = 3, cls = ""): HTMLElement {
  return h(
    "div",
    { class: ["skeleton-stack", cls], "aria-hidden": "true" },
    Array.from({ length: count }, (_, i) => h("div", { class: "skeleton", style: `width:${92 - ((i * 23) % 40)}%` })),
  );
}

export function skeletonBlock(height: number, cls = ""): HTMLElement {
  return h("div", { class: ["skeleton", "skeleton-block", cls], style: `height:${height}px`, "aria-hidden": "true" });
}

/** Wrap text in a link-styled button. */
export function linkButton(label: string, onclick: () => void, ic?: IconName): HTMLButtonElement {
  return h("button", { class: "link-btn", type: "button", onclick }, ic ? icon(ic) : null, label);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t = 0;
  return (...args: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

/** Auto-grow a textarea to fit its content (between min and max rows' height). */
export function autoGrow(ta: HTMLTextAreaElement, maxPx = 520): void {
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(maxPx, ta.scrollHeight + 2)}px`;
  };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
