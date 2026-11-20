/**
 * The live workspace view — shared by the standalone workspace window (chrome on) and the
 * main app's workspace pane (chrome off).
 *
 *  - Subscribes to /ws/workspace (auto-reconnect with exponential backoff 0.5s → 8s).
 *  - Renders every mode inside a sandboxed iframe (opaque origin): empty placeholder,
 *    freeform HTML builds, and app templates (contract v1: window.render(state, prev)).
 *  - App data changes are posted into the running template — the frame is never reloaded
 *    for a state change, so animations, canvases, scroll and focus survive.
 *  - Template / HTML swaps build the new frame underneath and crossfade once it reports
 *    "ready" (it has rendered); the old frame stays visible until then.
 *  - Overlay outside the frame: connection indicator, stacked toasts, activity chips, the
 *    agent trail (every Jev decision / tool / reply), the notice (a render error, or a link
 *    a page asks to open — it opens only once the viewer OKs the URL there), and (with chrome)
 *    a title bar with focus / full-screen controls.
 *  - Secure forms (the vault): a sheet over the stage, drawn here in the trusted page — never in a
 *    frame — while the frames are inert. What is typed goes to POST /api/vault/forms/<id> on this
 *    page's own origin and nowhere else: not the socket, not a frame, not the diagnostics.
 */
import { ensureSession } from "../auth.js";
import "./workspace.css";
import { buildFrameDoc, type FrameKind } from "./frame.js";
import type {
  AgentKind,
  FormEnd,
  FormField,
  FormRequest,
  FrameToHost,
  HostToFrame,
  ToastTone,
  WorkspaceActivity,
  WorkspaceClientEvent,
  WorkspaceEvent,
  WorkspaceMode,
  WorkspaceSnapshot,
  WorkspaceTemplate,
} from "./protocol.js";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface MountWorkspaceOptions {
  /** Show the title bar (standalone window). Default false (embedded pane). */
  chrome?: boolean;
  /** The workspace title changed (e.g. to mirror it in document.title or a pane header). */
  onTitle?: (title: string) => void;
  /** The connection state changed. */
  onConnection?: (state: ConnectionState) => void;
  /** The workspace mode changed (empty | html | app). */
  onMode?: (mode: WorkspaceMode) => void;
  /** A template called window.trinity.send(evt) (reserved for future interactivity). */
  onUiEvent?: (evt: unknown) => void;
  /** Override the socket URL (default `ws(s)://<host>/ws/workspace`). */
  url?: string;
}

export interface WorkspaceFrameInfo {
  id: number;
  kind: FrameKind;
  templateId: string | null;
  ready: boolean;
  errored: boolean;
}

export interface WorkspaceStats {
  connection: ConnectionState;
  /** Socket connections opened so far (1 + reconnects). */
  connects: number;
  lastVersion: number;
  mode: WorkspaceMode;
  title: string;
  templateId: string | null;
  focusMode: boolean;
  frame: WorkspaceFrameInfo | null;
  pending: WorkspaceFrameInfo | null;
  /** iframes created (srcdoc builds) — a state change must never increase this. */
  framesBuilt: number;
  framesCommitted: number;
  statesReceived: number;
  statesPosted: number;
  renderErrors: number;
  renderErrorsReported: number;
  lastRenderError: string | null;
  toasts: number;
  activities: string[];
  /** The last few ui_event payloads from templates. */
  uiEvents: unknown[];
  /** Secure forms open in this view (a count: nothing typed into them is ever part of the diagnostics). */
  secureForms: number;
}

export interface WorkspaceHandle {
  /** The view's root element (already appended to the container). */
  readonly root: HTMLElement;
  /** Close the socket, drop the frames and remove the view. */
  destroy(): void;
  /** Focus mode hides the title bar (presentation view). Toggles when `on` is omitted; returns the new state. */
  focusMode(on?: boolean): boolean;
  /** Drop the socket and connect again right away (the snapshot re-syncs without a flash). */
  reconnect(): void;
  /** Briefly glow the view (e.g. when another window asks to focus it). */
  attention(): void;
  /** Diagnostics. */
  stats(): WorkspaceStats;
}

/**
 * Mount the live workspace into `container`.
 * @example const ws = mountWorkspace(document.getElementById("pane")!, { onTitle: (t) => (h2.textContent = t) });
 */
export function mountWorkspace(container: HTMLElement, opts: MountWorkspaceOptions = {}): WorkspaceHandle {
  const view = new WorkspaceView(container, opts);
  return {
    root: view.root,
    destroy: () => view.destroy(),
    focusMode: (on?: boolean) => view.focusMode(on),
    reconnect: () => view.reconnect(),
    attention: () => view.attention(),
    stats: () => view.stats(),
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** `allow-forms` only so submit events reach the page's own JS (the runtime cancels navigation). */
const SANDBOX = "allow-scripts allow-forms";
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const OFFLINE_AFTER_FAILURES = 4;
const TOAST_MS = 3500;
const MAX_TOASTS = 4;
const FADE_MS = 300;
const READY_TIMEOUT_MS = 4000;
const LOAD_GRACE_MS = 600;
const ERROR_GRACE_MS = 1200;
const HTML_NOTICE_MS = 12000;
/**
 * A link question's Open button ignores clicks this soon after it appears (the second half of a double-click),
 * and a tap this soon after the one before it is part of a burst, not a deliberate press.
 */
const LINK_ARM_MS = 1000;
/** A pointer move onto the Open button counts as a deliberate move only once the notice has settled. */
const LINK_MOVE_MS = 300;
const ACTIVITY_DONE_MS = 900;
/** A secure form's Approve button ignores a click this soon after the sheet appears (a click that was already on its way to something else). */
const SHEET_ARM_MS = 800;
/** After the socket reconnects, a sheet the engine doesn't announce again within this long is no longer open. */
const SHEET_SWEEP_MS = 1500;
const SHEET_NOTE = "Typed here, this goes straight into Trinity's vault. Trinity and its models never see it.";
const SHEET_CONFIRM_NOTE = "Asked by Trinity's own window, not by a page: your answer goes straight to the engine. No model sees it or can give it for you.";
const FORM_PURPOSES: readonly FormRequest["purpose"][] = ["save-login", "save-card", "save-identity", "save-secret", "one-time", "confirm", "unlock"];
const FIELD_TYPES: readonly FormField["type"][] = ["text", "password", "email", "tel", "card-number", "expiry", "cvc", "otp-secret", "checkbox"];
/** Draws a plain text field as dots. */
const TEXT_MASK = "-webkit-text-security";

/**
 * Whether a text field can be drawn masked here. A type=password field is the browser's password manager's business:
 * it may offer to save what was typed into it, even with no <form> around it. Where a text field can be masked
 * instead, a secret is typed into one, and the manager never sees a password field on the sheet.
 */
function canMaskText(): boolean {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(TEXT_MASK, "disc");
  } catch {
    return false;
  }
}
/**
 * The engine's media files by the exact names its routes serve (services/images.ts, speech.ts, videos.ts). Only these
 * are ever fetched for a frame: an address with ".." or anything else in it could reach another route of the API with
 * this page's session, and hand what came back to the frame.
 */
const ASSET_FILE =
  "(?:images/[A-Za-z0-9_-]{6,40}\\.(?:png|jpg|webp|gif)|audio/[A-Za-z0-9_-]{6,40}\\.(?:mp3|wav|ogg|webm|flac|aac|m4a)|videos/[A-Za-z0-9_-]{6,40}\\.mp4)";
const ASSET_PATH = new RegExp(`^/api/${ASSET_FILE}$`);
const INLINE_IMAGE_FILE = "/api/images/[A-Za-z0-9_-]{6,40}\\.(?:png|jpg|webp|gif)(?![A-Za-z0-9_.%/-])";
const RESYNC_MIN_GAP_MS = 2000;
const DEFAULT_TITLE = "Workspace";
const TONES: readonly ToastTone[] = ["info", "success", "warn", "error"];
const TONE_ICON: Record<ToastTone, string> = { info: "i", success: "✓", warn: "!", error: "✕" };

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  focus: svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
  exitFocus: svg('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>'),
  fullscreen: svg(
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  ),
  exitFullscreen: svg(
    '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  ),
  open: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'),
};

interface Frame {
  id: number;
  el: HTMLIFrameElement;
  kind: FrameKind;
  template: WorkspaceTemplate | null;
  templateId: string | null;
  /** Template source or HTML — the content identity used to skip no-op rebuilds. */
  source: string;
  ready: boolean;
  committed: boolean;
  errored: boolean;
  reported: boolean;
  error: string | null;
  /** Newest raw (un-mapped) state this frame represents — for no-op detection. */
  rawState: unknown;
  /** Newest state waiting for the frame to report ready. */
  queued: { state: unknown } | null;
  /** Engine image URLs whose bytes were already posted into this frame. */
  assetsSent: Set<string>;
  timers: number[];
}

interface ToastRecord {
  el: HTMLElement;
  text: string;
  tone: ToastTone;
  timer: number;
  deadline: number;
  remaining: number;
  leaving: boolean;
}

interface ActivityRecord {
  el: HTMLElement;
  label: HTMLElement;
  timers: number[];
  done: boolean;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Open one of the engine's own pages (a file) in a new tab, keeping this page's address as the referrer — the file
 * route wants it — and cutting the new tab's link back to this one. False when the browser held it back.
 */
function openTab(url: string): boolean {
  const tab = window.open(url, "_blank");
  if (!tab) return false;
  try {
    tab.opener = null;
  } catch {
    /* already cut */
  }
  return true;
}

function restartClass(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // reflow so the animation runs again
  el.classList.add(cls);
}

/** The engine's card board (board@N): it hosts its widgets in isolated child frames of its own (see FramePayload.nested), and only it may run card commands or speak for the board. */
const isBoardTemplate = (t: WorkspaceTemplate | null): boolean => /^board@\d+$/.test(t?.id ?? "");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Deep-map strings that start with "/api/" to absolute URLs (srcdoc frames have no useful base) — and,
 * inside HTML strings (a widget card's markup), every "/api/images|audio|videos/…" reference too.
 */
function absolutize(value: unknown, origin: string, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("/api/")) return origin + value;
    if (value.length > 24 && value.includes("/api/") && value.includes("<"))
      return value.replace(/(["'(=\s])\/api\/(images|audio|videos)\//g, `$1${origin}/api/$2/`);
    return value;
  }
  if (value === null || typeof value !== "object" || depth > 64) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      const m = absolutize(v, origin, depth + 1);
      if (m !== v) {
        out ??= value.slice();
        out[i] = m;
      }
    }
    return out ?? value;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // only plain JSON objects
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const m = absolutize(v, origin, depth + 1);
    if (m !== v) {
      out ??= { ...(value as Record<string, unknown>) };
      out[k] = m;
    }
  }
  return out ?? value;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function prettyTemplateName(name: string | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw || /^test\b/i.test(raw)) return "";
  const words = raw.replace(/[-_:]+/g, " ").replace(/\s+/g, " ").trim();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}

function frameInfo(f: Frame | null): WorkspaceFrameInfo | null {
  return f ? { id: f.id, kind: f.kind, templateId: f.templateId, ready: f.ready, errored: f.errored } : null;
}

function agentTag(kind: AgentKind, tool: string): string {
  if (kind === "decision") return tool && tool !== "NONE" ? "Jev" : "Jev";
  if (kind === "tool") return "Run";
  if (kind === "tool_result") return "Done";
  return "Say";
}

function agentLabel(kind: AgentKind, tool: string, text: string, ok?: boolean, confidence?: number): string {
  const pretty = tool && tool !== "NONE" ? tool.replace(/_/g, " ") : "";
  const clip = (s: string, n = 96) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (kind === "decision") {
    if (!pretty) return text ? `Listening: ${clip(text, 72)}` : "";
    const conf = typeof confidence === "number" && Number.isFinite(confidence) ? ` · ${Math.round(confidence * 100)}%` : "";
    return `${pretty}${conf}${text ? ` — ${clip(text, 64)}` : ""}`;
  }
  if (kind === "tool") return pretty ? `${pretty}${text ? ` — ${clip(text, 72)}` : ""}` : clip(text);
  if (kind === "tool_result") {
    const mark = ok === false ? "failed" : "ok";
    return `${pretty || "tool"} ${mark}${text ? `: ${clip(text, 80)}` : ""}`;
  }
  return clip(text || pretty);
}

// ─── Secure forms: pieces ─────────────────────────────────────────────────────

interface SheetField {
  field: FormField;
  input: HTMLInputElement;
  /** The whole row (label, input, message): hidden when the field doesn't apply. */
  row: HTMLElement;
  error: HTMLElement | null;
}

interface Sheet {
  form: FormRequest;
  el: HTMLDivElement;
  fields: SheetField[];
  error: HTMLElement;
  submit: HTMLButtonElement;
  cancel: HTMLButtonElement;
  busy: boolean;
  /** When it came to the front. */
  shownAt: number;
  /** Announced again by the engine since the socket last reconnected. */
  confirmed: boolean;
  timers: number[];
}

/** A form descriptor from the socket, kept to what this window can draw — or null. */
function cleanForm(raw: unknown): FormRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
  const id = typeof r.id === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(r.id) ? r.id : "";
  const purpose = FORM_PURPOSES.find((p) => p === r.purpose);
  if (!id || !purpose) return null;
  const fields: FormField[] = [];
  for (const f of Array.isArray(r.fields) ? (r.fields as unknown[]).slice(0, 16) : []) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    const type = FIELD_TYPES.find((t) => t === x.type);
    const name = typeof x.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(x.name) ? x.name : "";
    if (!type || !name || fields.some((k) => k.name === name)) continue;
    const plain = type === "text" || type === "email" || type === "tel" || type === "checkbox";
    fields.push({
      name,
      type,
      label: text(x.label, 80) || name,
      required: x.required === true,
      placeholder: text(x.placeholder, 80),
      // A value may only come filled in for a field that isn't secret.
      value: plain ? text(x.value, 200) : "",
    });
  }
  const host = typeof r.host === "string" && /^[a-z0-9.-]{1,253}$/.test(r.host) ? r.host : "";
  return {
    id,
    purpose,
    title: text(r.title, 100) || "Secure form",
    detail: text(r.detail, 400),
    ...(host ? { host } : {}),
    fields: purpose === "confirm" ? [] : fields,
    submitLabel: text(r.submitLabel, 40) || (purpose === "confirm" ? "Approve" : "Save"),
    expiresAt: typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? r.expiresAt : Date.now() + 10 * 60_000,
  };
}

/** A padlock, built node by node (the sheet never takes markup from anywhere). */
function lockIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const body = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ x: "5", y: "10.5", width: "14", height: "9.5", rx: "2.2" })) body.setAttribute(k, v);
  const shackle = document.createElementNS(NS, "path");
  shackle.setAttribute("d", "M8 10.5V7.6a4 4 0 0 1 8 0v2.9");
  svg.append(body, shackle);
  return svg;
}

/** The card's brand from its first digits (the engine decides for real when it saves: vault/items.ts). */
export function cardBrandOf(digits: string): string {
  const n = (len: number): number => Number(digits.slice(0, len));
  if (digits.length < 1) return "";
  if (/^4/.test(digits)) return "Visa";
  if (digits.length >= 2 && ((n(2) >= 51 && n(2) <= 55) || (digits.length >= 4 && n(4) >= 2221 && n(4) <= 2720))) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (digits.length >= 4 && n(4) >= 3528 && n(4) <= 3589) return "JCB";
  if ((digits.length >= 3 && n(3) >= 300 && n(3) <= 305) || /^3[689]/.test(digits)) return "Diners Club";
  if (/^6011/.test(digits) || /^65/.test(digits) || (digits.length >= 3 && n(3) >= 644 && n(3) <= 649)) return "Discover";
  if (/^62/.test(digits)) return "UnionPay";
  if (/^(?:50|5[6-9]|6304|67)/.test(digits)) return "Maestro";
  return "";
}

/** The Luhn check every card number passes. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/** "4242424242424242" → "4242 4242 4242 4242" (at most nineteen digits). */
export function groupCardNumber(typed: string): string {
  return typed
    .replace(/\D/g, "")
    .slice(0, 19)
    .replace(/(.{4})(?=.)/g, "$1 ");
}

/** What was typed for an expiry, tidied as it is typed: "0827" → "08/27"; "8/27" stays as it is. */
export function tidyExpiry(typed: string): string {
  const split = /^\s*(\d{0,2})\s*[/\-. ]\s*(\d{0,4})/.exec(typed);
  if (split) return `${split[1]}/${split[2]}`;
  const d = typed.replace(/\D/g, "").slice(0, 6);
  return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

class WorkspaceView {
  readonly root: HTMLDivElement;
  private readonly opts: MountWorkspaceOptions;
  private readonly chrome: boolean;
  private readonly wsUrl: string;
  private readonly httpOrigin: string;

  // DOM
  private readonly stage: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly activityBox: HTMLDivElement;
  private readonly agentBox: HTMLDivElement;
  private readonly toastBox: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private readonly noticeTitle: HTMLElement;
  private readonly noticeMsg: HTMLElement;
  private readonly noticeOpen: HTMLButtonElement;
  private readonly noticeClose: HTMLButtonElement;
  private bootEl: HTMLDivElement | null;
  private readonly bootText: HTMLElement;
  private readonly connEls: HTMLButtonElement[] = [];
  private titleEl: HTMLElement | null = null;
  private kindEl: HTMLElement | null = null;
  private focusBtn: HTMLButtonElement | null = null;
  private fsBtn: HTMLButtonElement | null = null;

  // Socket
  private ws: WebSocket | null = null;
  private conn: ConnectionState = "connecting";
  private everLive = false;
  private failures = 0;
  private connects = 0;
  private reconnectTimer = 0;
  private outbox: WorkspaceClientEvent[] = [];
  private destroyed = false;

  // Workspace
  private lastVersion = -1;
  private titleVersion = -1;
  private title = DEFAULT_TITLE;
  private mode: WorkspaceMode = "empty";
  private template: WorkspaceTemplate | null = null;
  private current: Frame | null = null;
  private pending: Frame | null = null;
  private readonly leaving = new Set<Frame>();
  private frameSeq = 0;
  private lastResyncAt = 0;
  private kindLabel = "";

  // Overlay state
  private readonly toasts: ToastRecord[] = [];
  private readonly activities = new Map<string, ActivityRecord>();
  private readonly agentRows: { el: HTMLDivElement; timer: number }[] = [];
  private static readonly AGENT_KEEP = 10;
  private static readonly AGENT_TTL_MS = 14_000;
  private noticeTimer = 0;
  private dismissedNoticeFor: Frame | null = null;
  /**
   * A link a page asked to open, waiting in the notice for the viewer's OK; it goes when that page does. `file`: a file
   * from the board's file card whose pop-up the browser held back (its name) — opened from here instead.
   */
  private linkAsk: { href: string; at: number; frame: Frame; file?: string } | null = null;
  /** A real pointer move (or a deliberate touch or pen press) has landed on the Open button since this question appeared (a click needs one). */
  private linkMoved = false;
  /** When a press last landed on the Open button (a burst of taps never counts as a deliberate one). */
  private linkPressAt = 0;
  private focus = false;
  private focusBeforeFullscreen: boolean | null = null;
  private peekTimer = 0;
  private wakeLock: { release(): Promise<void> } | null = null;

  // Secure forms (see "Secure forms" below)
  private readonly sheetLayer: HTMLDivElement;
  /** The forms open here, oldest first; the newest is the one on show. */
  private readonly sheets = new Map<string, Sheet>();
  private sheetSeq = 0;
  private sheetSweep = 0;
  /** A socket has just (re)connected: its first snapshot settles which sheets are still open. */
  private freshSocket = false;
  /** Where the focus was before the first sheet took it. */
  private sheetReturn: HTMLElement | null = null;
  /** "Secure form open", in the title bar (the standalone window). */
  private sheetFlag: HTMLElement | null = null;

  // Diagnostics
  private readonly counters = {
    framesBuilt: 0,
    framesCommitted: 0,
    statesReceived: 0,
    statesPosted: 0,
    renderErrors: 0,
    renderErrorsReported: 0,
  };
  private lastRenderError: string | null = null;
  private readonly uiEvents: unknown[] = [];
  private readonly cleanups: Array<() => void> = [];

  constructor(container: HTMLElement, opts: MountWorkspaceOptions) {
    this.opts = opts;
    this.chrome = Boolean(opts.chrome);
    this.wsUrl = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/workspace`;
    this.httpOrigin = WorkspaceView.httpOriginFor(this.wsUrl);

    const root = h("div", "tw-root");
    root.dataset.conn = "connecting";
    root.dataset.mode = "empty";
    if (this.chrome) root.classList.add("tw-has-chrome");
    this.root = root;

    if (this.chrome) this.buildBar();

    this.stage = h("div", "tw-stage");
    this.overlay = h("div", "tw-overlay");

    // Boot screen (until the first snapshot).
    this.bootEl = h("div", "tw-boot");
    const bootInner = h("div", "tw-boot-inner");
    this.bootText = h("span");
    this.bootText.textContent = "Connecting to Trinity…";
    bootInner.append(h("span", "tw-spin", { "aria-hidden": "true" }), this.bootText);
    this.bootEl.append(bootInner);

    this.activityBox = h("div", "tw-activity", { role: "status", "aria-live": "polite", "aria-label": "Background work" });
    this.agentBox = h("div", "tw-agent", { role: "log", "aria-live": "polite", "aria-label": "What Jev is doing" });
    this.toastBox = h("div", "tw-toasts"); // each toast is its own status/alert region

    const float = h("div", "tw-float");
    float.append(this.connButton("tw-conn-float"));
    if (this.chrome) {
      const exit = this.iconButton(ICONS.exitFocus, "Exit focus mode (Esc)", "tw-btn tw-exit-focus");
      exit.addEventListener("click", () => this.focusMode(false));
      float.append(exit);
    }

    // Notice: a render error, or a link a page asked to open (it opens from here, once OK'd).
    this.notice = h("div", "tw-notice", { role: "alert" });
    this.notice.hidden = true;
    const noticeIcon = h("span", "tw-notice-icon", { "aria-hidden": "true" });
    noticeIcon.textContent = "!";
    const noticeBody = h("div", "tw-notice-body");
    this.noticeTitle = h("strong", "tw-notice-title");
    this.noticeMsg = h("span", "tw-notice-msg");
    noticeBody.append(this.noticeTitle, this.noticeMsg);
    this.noticeOpen = h("button", "tw-notice-close", { type: "button", "aria-label": "Open it in a new tab", title: "Open it in a new tab" });
    this.noticeOpen.innerHTML = ICONS.open;
    this.noticeOpen.hidden = true;
    this.noticeOpen.addEventListener("click", (e) => this.openAsked(e));
    // A page can drop a button under the resting cursor where Open will appear; only count a click
    // once the pointer has really moved onto Open after the notice settled (keyboard needs no move).
    this.noticeOpen.addEventListener("pointermove", (e) => {
      if (this.linkAsk && (e.movementX || e.movementY) && Date.now() - this.linkAsk.at > LINK_MOVE_MS) this.linkMoved = true;
    });
    // Touch and pen have no resting cursor to park over Open: a fresh press once the notice has armed is
    // deliberate, unless it's one of a burst of taps landing there (the one before came under LINK_ARM_MS ago).
    this.noticeOpen.addEventListener("pointerdown", (e) => {
      const now = Date.now();
      if (this.linkAsk && e.pointerType !== "mouse" && now - this.linkAsk.at > LINK_ARM_MS && now - this.linkPressAt > LINK_ARM_MS) this.linkMoved = true;
      this.linkPressAt = now;
    });
    this.noticeClose = h("button", "tw-notice-close", { type: "button", "aria-label": "Dismiss", title: "Dismiss" });
    this.noticeClose.innerHTML = ICONS.close;
    this.noticeClose.addEventListener("click", () => {
      if (this.linkAsk) {
        this.linkAsk = null; // not opened
        this.renderNotice();
        return;
      }
      this.dismissedNoticeFor = this.current;
      this.notice.hidden = true;
    });
    this.notice.append(noticeIcon, noticeBody, this.noticeOpen, this.noticeClose);

    // Secure forms: one layer over everything else on the stage — a scrim, and the sheet on it.
    this.sheetLayer = h("div", "tw-sheet-layer");
    this.sheetLayer.hidden = true;
    const scrim = h("div", "tw-sheet-scrim", { "aria-hidden": "true" });
    this.sheetLayer.append(scrim);
    this.sheetLayer.addEventListener("keydown", (e) => this.onSheetKey(e, true));
    // A click beside the sheet neither closes it (what was typed would be lost) nor takes the focus out of it.
    this.sheetLayer.addEventListener("mousedown", (e) => {
      if (e.target !== this.sheetLayer && e.target !== scrim) return;
      e.preventDefault();
      const top = this.topSheet();
      if (top && !top.el.contains(document.activeElement)) this.focusSheet(top);
    });

    this.overlay.append(this.bootEl, this.activityBox, this.agentBox, this.toastBox, this.notice, float, this.sheetLayer);
    this.stage.append(this.overlay);
    root.append(this.stage);
    container.append(root);

    this.on(document, "keydown", (e) => this.onSheetKey(e as KeyboardEvent, false));
    this.on(window, "message", (e) => this.onFrameMessage(e as MessageEvent));
    this.on(window, "online", () => this.retryNow());
    this.on(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.retryNow();
    });
    this.on(document, "fullscreenchange", () => this.onFullscreenChange());

    this.connect();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.noticeTimer);
    window.clearTimeout(this.peekTimer);
    window.clearTimeout(this.sheetSweep);
    // Secure forms leave with the view: what was typed is wiped. (They stay open in the engine for another window.)
    for (const id of [...this.sheets.keys()]) this.closeSheet(id);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "workspace view closed");
    } catch {
      /* already closed */
    }
    for (const f of [this.pending, this.current, ...this.leaving]) if (f) this.dropFrame(f);
    for (const t of this.toasts) window.clearTimeout(t.timer);
    for (const a of this.activities.values()) for (const id of a.timers) window.clearTimeout(id);
    for (const r of this.agentRows) window.clearTimeout(r.timer);
    this.agentRows.length = 0;
    for (const off of this.cleanups.splice(0)) off();
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => undefined);
    void this.releaseWake();
    this.root.remove();
  }

  focusMode(on?: boolean): boolean {
    const next = on === undefined ? !this.focus : Boolean(on);
    if (next === this.focus) return next;
    this.focus = next;
    this.root.classList.toggle("tw-focus", next);
    this.root.classList.remove("tw-peek");
    if (this.focusBtn) {
      this.focusBtn.setAttribute("aria-pressed", String(next));
    }
    return next;
  }

  reconnect(): void {
    if (this.destroyed) return;
    const old = this.ws;
    this.ws = null;
    try {
      old?.close(1000, "reconnect");
    } catch {
      /* ignore */
    }
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.failures = 0;
    this.setConn(this.everLive ? "reconnecting" : "connecting");
    this.connect();
  }

  attention(): void {
    restartClass(this.root, "tw-attention");
    window.setTimeout(() => this.root.classList.remove("tw-attention"), 1400);
  }

  stats(): WorkspaceStats {
    return {
      connection: this.conn,
      connects: this.connects,
      lastVersion: this.lastVersion,
      mode: this.mode,
      title: this.title,
      templateId: this.template?.id ?? null,
      focusMode: this.focus,
      frame: frameInfo(this.current),
      pending: frameInfo(this.pending),
      ...this.counters,
      lastRenderError: this.lastRenderError,
      toasts: this.toasts.filter((t) => !t.leaving).length,
      activities: [...this.activities.entries()].filter(([, a]) => !a.done).map(([id]) => id),
      uiEvents: [...this.uiEvents],
      secureForms: this.sheets.size,
    };
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────

  private on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanups.push(() => target.removeEventListener(type, fn));
  }

  private iconButton(icon: string, label: string, className = "tw-btn"): HTMLButtonElement {
    const b = h("button", className, { type: "button", title: label, "aria-label": label });
    b.innerHTML = icon;
    return b;
  }

  private connButton(className: string): HTMLButtonElement {
    const b = h("button", className, { type: "button", title: "Connecting…" });
    const text = h("span", "tw-conn-text");
    text.textContent = "Connecting…";
    b.append(h("span", "tw-dot", { "aria-hidden": "true" }), text);
    b.addEventListener("click", () => {
      if (this.conn !== "live") this.retryNow();
    });
    this.connEls.push(b);
    return b;
  }

  private buildBar(): void {
    const bar = h("header", "tw-bar");
    const brand = h("div", "tw-brand");
    const brandName = h("span", "tw-brand-name");
    brandName.textContent = "Trinity";
    brand.append(h("span", "tw-orb", { "aria-hidden": "true" }), brandName);

    const heading = h("div", "tw-heading");
    const title = h("h1", "tw-title");
    title.textContent = DEFAULT_TITLE;
    const kind = h("span", "tw-kind");
    kind.hidden = true;
    // Lit while a secure form is up. It sits in the window's own bar, where no page in the frame can draw.
    const flag = h("span", "tw-sheet-flag");
    flag.textContent = "Secure form open";
    flag.hidden = true;
    this.sheetFlag = flag;
    heading.append(title, kind, flag);

    const actions = h("div", "tw-actions");
    const focusBtn = this.iconButton(ICONS.focus, "Focus mode — hide this bar (F)");
    focusBtn.setAttribute("aria-pressed", "false");
    focusBtn.addEventListener("click", () => this.focusMode());
    const fsBtn = this.iconButton(ICONS.fullscreen, "Full screen");
    fsBtn.setAttribute("aria-pressed", "false");
    fsBtn.addEventListener("click", () => this.toggleFullscreen());
    if (!document.fullscreenEnabled) fsBtn.hidden = true;
    actions.append(this.connButton("tw-conn"), focusBtn, fsBtn);

    bar.append(brand, h("span", "tw-sep", { "aria-hidden": "true" }), heading, actions);

    // Focus mode: hovering the top edge peeks the bar over the content.
    const peek = h("div", "tw-peek-zone", { "aria-hidden": "true" });
    peek.addEventListener("mouseenter", () => {
      window.clearTimeout(this.peekTimer);
      if (this.focus) this.root.classList.add("tw-peek");
    });
    bar.addEventListener("mouseenter", () => window.clearTimeout(this.peekTimer));
    bar.addEventListener("mouseleave", () => {
      window.clearTimeout(this.peekTimer);
      this.peekTimer = window.setTimeout(() => this.root.classList.remove("tw-peek"), 450);
    });

    this.root.append(bar, peek);
    this.titleEl = title;
    this.kindEl = kind;
    this.focusBtn = focusBtn;
    this.fsBtn = fsBtn;
  }

  // ── Connection ───────────────────────────────────────────────────────────

  private static httpOriginFor(wsUrl: string): string {
    try {
      const u = new URL(wsUrl, location.href);
      const protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
      return `${protocol}//${u.host}`;
    } catch {
      return location.origin;
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    // The engine answers only a linked browser (auth.ts): link this one first, then open the socket.
    void ensureSession().then((linked) => {
      if (linked) this.openSocket();
      else this.scheduleReconnect();
    });
  }

  private openSocket(): void {
    if (this.destroyed || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connects++;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.freshSocket = true;
      this.rawSend(ws, { type: "hello" });
      for (const evt of this.outbox.splice(0)) this.rawSend(ws, evt);
    };
    ws.onmessage = (m: MessageEvent) => {
      if (this.ws === ws) this.onSocketMessage(m.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* a close event always follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const base = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)] ?? 8000;
    this.failures++;
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    this.setConn(this.failures > OFFLINE_AFTER_FAILURES ? "offline" : this.everLive ? "reconnecting" : "connecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      this.connect();
    }, delay);
  }

  /** Reconnect now if we're not connected (tab visible again, back online, pill clicked). */
  private retryNow(): void {
    if (this.destroyed) return;
    const ws = this.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.connect();
  }

  private rawSend(ws: WebSocket, evt: WorkspaceClientEvent): void {
    try {
      ws.send(JSON.stringify(evt));
    } catch {
      /* socket closing */
    }
  }

  private sendClient(evt: WorkspaceClientEvent): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.rawSend(ws, evt);
      return;
    }
    this.outbox.push(evt);
    if (this.outbox.length > 10) this.outbox.splice(0, this.outbox.length - 10);
  }

  private setConn(state: ConnectionState): void {
    if (state === this.conn) return;
    this.conn = state;
    this.root.dataset.conn = state;
    const label =
      state === "live"
        ? "Live"
        : state === "connecting"
          ? "Connecting…"
          : state === "reconnecting"
            ? "Reconnecting…"
            : "Offline · retrying";
    const tip = state === "live" ? "Live — updates stream in as Trinity works" : `${label} (click to retry now)`;
    for (const b of this.connEls) {
      b.title = tip;
      b.setAttribute("aria-label", `Connection: ${label}`);
      const text = b.querySelector(".tw-conn-text");
      if (text) text.textContent = label;
    }
    if (this.bootEl && !this.everLive) {
      this.bootText.textContent =
        state === "offline" ? "Can’t reach the Trinity engine — retrying…" : "Connecting to Trinity…";
    }
    this.safe(() => this.opts.onConnection?.(state));
  }

  private onLive(): void {
    this.failures = 0;
    this.everLive = true;
    this.setConn("live");
    const boot = this.bootEl;
    if (boot) {
      this.bootEl = null;
      boot.classList.add("is-gone");
      window.setTimeout(() => boot.remove(), 360);
    }
  }

  // ── Protocol ─────────────────────────────────────────────────────────────

  private onSocketMessage(data: unknown): void {
    let evt: WorkspaceEvent;
    try {
      evt = JSON.parse(String(data)) as WorkspaceEvent;
    } catch {
      return;
    }
    if (!evt || typeof evt !== "object" || typeof (evt as { type?: unknown }).type !== "string") return;
    try {
      this.handle(evt);
    } catch (err) {
      console.warn("[workspace] failed to apply event", evt.type, err);
    }
  }

  private handle(evt: WorkspaceEvent): void {
    switch (evt.type) {
      case "snapshot":
        this.applySnapshot(evt.snapshot, false);
        // On a socket that has just connected, the engine announces its open forms right after this snapshot.
        if (this.freshSocket) {
          this.freshSocket = false;
          this.sweepSheets();
        }
        return;
      case "form":
        this.openSheet(evt.form);
        return;
      case "form_closed":
        this.endSheet(evt.id, evt.status);
        return;
      case "state": {
        this.counters.statesReceived++;
        if (!this.accept(evt.version)) return;
        if (typeof evt.title === "string") this.setTitle(evt.title, evt.version);
        if (!this.pushState(evt.state)) this.resync();
        return;
      }
      case "template": {
        if (!this.accept(evt.version)) return;
        const t = evt.template;
        if (!t || typeof t.source !== "string") return;
        this.template = t;
        this.setMode("app");
        this.adoptTemplateTitle(evt.version, evt.state, (evt as { title?: unknown }).title);
        this.showFrame("app", t.source, t, evt.state);
        return;
      }
      case "html": {
        if (!this.accept(evt.version)) return;
        this.template = null;
        this.setMode("html");
        this.setTitle(evt.title, evt.version);
        this.showFrame("html", typeof evt.html === "string" ? evt.html : "", null);
        return;
      }
      case "toast":
        this.toast(evt.text, evt.tone);
        return;
      case "activity":
        this.setActivity(evt.id, evt.busy && evt.text ? evt.text : null);
        return;
      case "overlays":
        this.setOverlays(evt.overlays);
        return;
      case "command":
        this.postCommand(evt.cmd);
        return;
      case "agent":
        this.pushAgent(evt);
        return;
    }
  }

  /** Versioned events older than what we've applied are stale (the snapshot is always accepted). */
  private accept(version: unknown): boolean {
    if (typeof version !== "number" || !Number.isFinite(version)) return true;
    if (version <= this.lastVersion) return false;
    this.lastVersion = version;
    return true;
  }

  private applySnapshot(snap: WorkspaceSnapshot | null | undefined, fetched: boolean): void {
    if (!snap || typeof snap !== "object") return;
    const version = typeof snap.version === "number" && Number.isFinite(snap.version) ? snap.version : 0;
    if (fetched && version < this.lastVersion) return; // a newer event already arrived
    if (!fetched) {
      this.onLive();
      this.titleVersion = -1; // the engine may have restarted with a lower version
    }
    this.lastVersion = version;
    this.syncActivities(Array.isArray(snap.activities) ? snap.activities : []);
    this.setOverlays(snap.overlays);
    this.setTitle(snap.title, version);

    const latest = this.pending ?? this.current;
    const t = snap.template;
    if (snap.mode === "app" && t && typeof t.source === "string") {
      this.template = t;
      this.setMode("app");
      const same = latest?.kind === "app" && latest.templateId === t.id && latest.source === t.source;
      if (!same) this.showFrame("app", t.source, t, snap.state);
      else if (!sameJson(latest.rawState, snap.state)) this.pushState(snap.state);
      return;
    }
    if (snap.mode === "html" && typeof snap.html === "string") {
      this.template = null;
      this.setMode("html");
      if (!(latest?.kind === "html" && latest.source === snap.html)) this.showFrame("html", snap.html, null);
      return;
    }
    this.template = null;
    this.setMode("empty");
    if (latest?.kind !== "empty") this.showFrame("empty", "", null);
  }

  /** We got a state for an app we aren't showing — fetch the snapshot to re-sync. */
  private resync(): void {
    const now = Date.now();
    if (now - this.lastResyncAt < RESYNC_MIN_GAP_MS) return;
    this.lastResyncAt = now;
    void this.fetchSnapshot().then((snap) => {
      if (snap && !this.destroyed) this.applySnapshot(snap, true);
    });
  }

  private async fetchSnapshot(): Promise<WorkspaceSnapshot | null> {
    try {
      const res = await fetch(`${this.httpOrigin}/api/workspace`, { cache: "no-store" });
      return res.ok ? ((await res.json()) as WorkspaceSnapshot) : null;
    } catch {
      return null;
    }
  }

  /**
   * Template events don't carry a title: use one if a newer protocol sends it, else the
   * state's own title, and confirm against the snapshot in the background.
   */
  private adoptTemplateTitle(version: number, state: unknown, explicit: unknown): void {
    if (typeof explicit === "string") {
      this.setTitle(explicit, version);
      return;
    }
    const own = state && typeof state === "object" ? (state as { title?: unknown }).title : undefined;
    if (typeof own === "string" && own.trim()) this.setTitle(own, version);
    void this.fetchSnapshot().then((snap) => {
      if (!snap || this.destroyed || typeof snap.version !== "number" || snap.version < version) return;
      this.setTitle(snap.title, snap.version);
    });
  }

  private setTitle(raw: unknown, version?: number): void {
    if (version !== undefined) {
      if (version < this.titleVersion) return;
      this.titleVersion = version;
    }
    const next = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_TITLE;
    if (next === this.title) return;
    this.title = next;
    if (this.titleEl) {
      this.titleEl.textContent = next;
      this.titleEl.title = next;
      restartClass(this.titleEl, "is-changed");
    }
    for (const f of [this.current, this.pending]) if (f) f.el.title = this.frameTitle();
    this.safe(() => this.opts.onTitle?.(next));
  }

  private frameTitle(): string {
    return this.title === DEFAULT_TITLE ? "Trinity workspace" : `Workspace: ${this.title}`;
  }

  private setMode(mode: WorkspaceMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      this.root.dataset.mode = mode;
      this.safe(() => this.opts.onMode?.(mode));
    }
    this.updateKind();
  }

  private updateKind(): void {
    const el = this.kindEl;
    if (!el) return;
    let label = "";
    let custom = false;
    if (this.mode === "app" && this.template) {
      custom = this.template.kind === "custom";
      label = custom ? "✦ Custom screen" : prettyTemplateName(this.template.name) || "Live app";
    } else if (this.mode === "html") {
      label = "Live build";
    }
    if (label === this.kindLabel) return;
    this.kindLabel = label;
    el.hidden = !label;
    el.textContent = label;
    el.classList.toggle("is-custom", custom);
    if (label) restartClass(el, "is-changed");
  }

  // ── Frames ───────────────────────────────────────────────────────────────

  private mapState(state: unknown): unknown {
    return absolutize(state ?? null, this.httpOrigin);
  }

  /** Build a new frame underneath the current one; it crossfades in once it reports ready. */
  private showFrame(kind: FrameKind, source: string, template: WorkspaceTemplate | null, state?: unknown): void {
    const mapped = kind === "app" ? this.mapState(state) : undefined;
    const el = document.createElement("iframe");
    const frame: Frame = {
      id: ++this.frameSeq,
      el,
      kind,
      template,
      templateId: template?.id ?? null,
      source,
      ready: false,
      committed: false,
      errored: false,
      reported: false,
      error: null,
      rawState: kind === "app" ? (state ?? null) : null,
      queued: null,
      assetsSent: new Set(),
      timers: [],
    };
    el.className = "tw-frame is-pending";
    el.setAttribute("sandbox", SANDBOX);
    el.setAttribute("referrerpolicy", "no-referrer");
    // An audio clip card may start playing on its own once this page has had a gesture (an opaque origin needs "*").
    el.setAttribute("allow", "autoplay *");
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.title = this.frameTitle();
    // While a secure form is up, no frame can take the focus or a click.
    if (this.sheets.size) el.inert = true;

    if (this.pending) this.dropFrame(this.pending);
    this.pending = frame;
    // Insert and lay the frame out BEFORE navigating it: an isolated (opaque-origin) frame
    // that starts loading while detached runs its first scripts at 0x0 — a build that sizes
    // its canvas from innerWidth at startup would come out blank.
    this.stage.insertBefore(el, this.overlay);
    void el.offsetWidth;
    el.srcdoc =
      kind === "app"
        ? buildFrameDoc("app", { source, state: mapped, nested: isBoardTemplate(template) })
        : buildFrameDoc(kind, { source });
    el.addEventListener("load", () => this.onFrameLoad(frame));
    this.counters.framesBuilt++;
    frame.timers.push(
      window.setTimeout(() => {
        // Never leave the old frame up forever because the new one didn't say "ready".
        this.markReady(frame);
        this.commit(frame);
      }, READY_TIMEOUT_MS),
    );
  }

  /**
   * Fallback only: the runtime always posts "ready" (after the first render for apps). A
   * load event without it — e.g. a payload that broke our runtime — commits after a grace.
   */
  private onFrameLoad(frame: Frame): void {
    if (frame.ready) return;
    frame.timers.push(window.setTimeout(() => this.onFrameReady(frame), LOAD_GRACE_MS));
  }

  private markReady(frame: Frame): boolean {
    if (frame.ready) return false;
    frame.ready = true;
    const q = frame.queued;
    if (q) {
      frame.queued = null;
      this.postState(frame, q.state);
    } else if (frame.kind === "app") {
      this.sendAssets(frame, this.mapState(frame.rawState)); // images in the state the frame booted with
    }
    return true;
  }

  // ── Images ──────────────────────────────────────────────────────────────
  // A sandboxed (opaque-origin) frame can't load the engine's http://localhost images —
  // Chromium's local-network protections block them — so the host (same origin) fetches each
  // image once (the engine marks them immutable, so repeats come from the HTTP cache) and posts
  // the bytes in; the frame's runtime swaps the URLs for its own blob: URLs.

  private readonly assetBlobs = new Map<string, Promise<Blob | null>>();

  /** One of the engine's media files, by the exact name its routes serve — the only thing fetched for a frame. */
  private isAssetUrl(url: string): boolean {
    return url.startsWith(`${this.httpOrigin}/`) && ASSET_PATH.test(url.slice(this.httpOrigin.length));
  }

  private assetBlob(url: string): Promise<Blob | null> {
    if (!this.isAssetUrl(url)) return Promise.resolve(null);
    let p = this.assetBlobs.get(url);
    if (!p) {
      p = fetch(url, { redirect: "error" })
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      this.assetBlobs.set(url, p);
      if (this.assetBlobs.size > 300) this.assetBlobs.delete(this.assetBlobs.keys().next().value!);
    }
    return p;
  }

  private sendAssets(frame: Frame, mapped: unknown): void {
    // (Engine images, and the audio clips make_audio records: the frame can't load either itself.)
    // Only whole file names the engine's own routes serve: "/api/images/../anything" is never fetched (it would be
    // read with this page's session and its bytes handed to the frame).
    // Images embedded in a widget card's HTML (a content card's hero) travel the same way; the frame inlines them.
    const inlineImages = new RegExp(`${escapeRegExp(this.httpOrigin)}${INLINE_IMAGE_FILE}`, "g");
    const found = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
      if (typeof v === "string") {
        if (this.isAssetUrl(v)) found.add(v);
        else if (v.length > 24 && v.includes("/api/images/")) for (const m of v.matchAll(inlineImages)) found.add(m[0]);
      } else if (v && typeof v === "object" && depth < 64) {
        for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
      }
    };
    walk(mapped, 0);
    for (const url of found) {
      if (frame.assetsSent.has(url)) continue;
      frame.assetsSent.add(url);
      void this.assetBlob(url).then((blob) => {
        const win = frame.el.contentWindow;
        if (!win || this.destroyed || !frame.el.isConnected) return;
        const msg: HostToFrame = { type: "asset", url, blob };
        try {
          win.postMessage(msg, "*");
        } catch {
          /* the frame went away */
        }
      });
    }
  }

  private onFrameReady(frame: Frame): void {
    if (!this.markReady(frame) || frame !== this.pending) return;
    if (frame.errored && frame.kind === "app" && this.current) {
      // Its first render failed: keep the old screen up briefly — the engine usually
      // answers a render_error with a fallback template right away.
      frame.timers.push(window.setTimeout(() => this.commit(frame), ERROR_GRACE_MS));
      return;
    }
    this.commit(frame);
  }

  private commit(frame: Frame): void {
    if (frame !== this.pending || this.destroyed) return;
    this.pending = null;
    const old = this.current;
    this.current = frame;
    frame.committed = true;
    this.counters.framesCommitted++;
    frame.el.classList.remove("is-pending");
    frame.el.removeAttribute("aria-hidden");
    frame.el.tabIndex = 0;
    if (old) {
      // The new frame fades in on top; drop the old one once it's fully covered.
      this.leaving.add(old);
      old.el.classList.add("is-leaving");
      old.el.setAttribute("aria-hidden", "true");
      old.el.tabIndex = -1;
      old.timers.push(window.setTimeout(() => this.dropFrame(old), FADE_MS + 120));
    }
    this.root.dataset.frame = frame.kind;
    this.renderNotice();
  }

  private dropFrame(frame: Frame): void {
    for (const id of frame.timers) window.clearTimeout(id);
    frame.timers = [];
    frame.el.remove();
    this.leaving.delete(frame);
    if (this.pending === frame) this.pending = null;
    if (this.current === frame) this.current = null;
    if (this.linkAsk?.frame === frame) {
      this.linkAsk = null; // the page that asked is gone
      this.renderNotice();
    }
  }

  /** A card command: into the live card board (only the board's own template runs it, and answers through a ui_event). */
  private postCommand(cmd: unknown): void {
    const frame = this.current;
    if (!frame || frame.kind !== "app" || !frame.ready || !isBoardTemplate(frame.template)) return;
    const msg: HostToFrame = { type: "command", cmd: cmd as Extract<HostToFrame, { type: "command" }>["cmd"] };
    try {
      frame.el.contentWindow?.postMessage(msg, "*");
    } catch {
      /* the frame went away; the engine times out */
    }
  }

  /** Hot update: post the state into the live frame (queued until it's ready). */
  private pushState(raw: unknown): boolean {
    const target = this.pending ?? this.current;
    if (!target || target.kind !== "app") return false;
    target.rawState = raw ?? null;
    const mapped = this.mapState(raw);
    if (!target.ready) {
      target.queued = { state: mapped };
      return true;
    }
    this.postState(target, mapped);
    return true;
  }

  private postState(frame: Frame, state: unknown): void {
    const win = frame.el.contentWindow;
    if (!win) return;
    const msg: HostToFrame = { type: "state", state };
    try {
      win.postMessage(msg, "*");
    } catch {
      // Not structured-cloneable — send a plain JSON copy instead.
      try {
        win.postMessage({ type: "state", state: JSON.parse(JSON.stringify(state ?? null)) as unknown }, "*");
      } catch {
        return;
      }
    }
    this.counters.statesPosted++;
    this.sendAssets(frame, state);
  }

  private frameFor(source: MessageEventSource | null): Frame | null {
    if (!source) return null;
    for (const f of [this.current, this.pending]) if (f && f.el.contentWindow === source) return f;
    return null;
  }

  private onFrameMessage(e: MessageEvent): void {
    const frame = this.frameFor(e.source);
    if (!frame) return; // not one of our frames (or one that's on its way out)
    const msg = e.data as FrameToHost | null;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        this.onFrameReady(frame);
        return;
      case "render_error":
        this.onFrameError(frame, typeof msg.message === "string" ? msg.message : String(msg.message));
        return;
      case "ui_event":
        this.onUiEvent(frame, msg.evt);
        return;
    }
  }

  private onFrameError(frame: Frame, message: string): void {
    const text = message.trim() || "Unknown error";
    this.counters.renderErrors++;
    this.lastRenderError = text;
    frame.errored = true;
    frame.error = text;
    if (frame.kind === "app" && frame.templateId && !frame.reported) {
      frame.reported = true;
      this.counters.renderErrorsReported++;
      this.sendClient({ type: "render_error", templateId: frame.templateId, message: text });
    }
    if (frame === this.current) this.renderNotice();
  }

  private onUiEvent(frame: Frame, evt: unknown): void {
    const internal = evt && typeof evt === "object" ? (evt as { __trinity?: unknown }).__trinity : undefined;
    // (The diagnostics keep what kind of event it was, not what a card kept or said.)
    this.uiEvents.push(internal === "board" ? { __trinity: "board", op: (evt as { op?: unknown }).op } : evt);
    if (this.uiEvents.length > 20) this.uiEvents.shift();
    if (internal === "alert") {
      const text = String((evt as { text?: unknown }).text ?? "").trim();
      if (text) this.toast(text, "info");
      return;
    }
    if (internal === "link") {
      this.askToOpen(frame, String((evt as { href?: unknown }).href ?? ""));
      return;
    }
    // A file card's Open or Download: done from this page (the board's frame can't download or send the session).
    if (internal === "file") {
      if (frame.kind === "app" && isBoardTemplate(frame.template)) this.openFile(frame, evt as Record<string, unknown>);
      return;
    }
    // The card board's own events (a command's answer, a card moved or resized by hand) go to the engine — and only
    // from the board template: a built page in the workspace can't speak for the board.
    if (internal === "board") {
      if (frame.kind === "app" && isBoardTemplate(frame.template)) this.sendClient({ type: "board", evt: evt as Record<string, unknown> });
      return;
    }
    this.safe(() => this.opts.onUiEvent?.(evt));
  }

  /**
   * A page asked to open a link (a click on one, or window.open). A click anywhere in the frame
   * lends this window the user activation window.open needs, so a page could carry data out in a
   * URL: the link opens only from the notice, once the viewer has seen the URL and OK'd it. One
   * question at a time, so the URL can't change under the viewer's cursor.
   */
  private askToOpen(frame: Frame, raw: string): void {
    if (this.linkAsk) return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    this.linkAsk = { href: url.href, at: Date.now(), frame };
    this.linkMoved = false;
    this.renderNotice();
  }

  private openAsked(e?: MouseEvent): void {
    const ask = this.linkAsk;
    if (!ask || Date.now() - ask.at < LINK_ARM_MS) return;
    // A mouse click opens the link only after a deliberate move onto the button (a lured click on a
    // button dropped under a resting cursor has none), a tap only when it isn't one of a burst;
    // keyboard activation (detail 0) opens directly.
    if (e && e.detail > 0 && !this.linkMoved) return;
    this.linkAsk = null;
    this.linkMoved = false;
    if (ask.file) openTab(ask.href);
    else window.open(ask.href, "_blank", "noopener,noreferrer");
    this.renderNotice();
  }

  /**
   * Open or download the file on one of the board's "file" cards. The board says only which card and what to do; the
   * file's address is built here from that card as the engine sent it (its file id and its name) — never from the
   * message — and opened from this page, so the browser sends the session and this page's address with it (the file
   * route wants both). A pop-up the browser holds back is offered in the notice, to open from there.
   */
  private openFile(frame: Frame, evt: Record<string, unknown>): void {
    const cardId = typeof evt.card === "string" ? evt.card : "";
    const action = evt.action === "download" ? "download" : evt.action === "open" ? "open" : "";
    if (!cardId || !action) return;
    const cards = (frame.rawState as { cards?: unknown } | null)?.cards;
    const card = Array.isArray(cards) ? (cards as Record<string, unknown>[]).find((c) => c && typeof c === "object" && c.id === cardId && c.kind === "file") : undefined;
    const data = card?.data as { id?: unknown; name?: unknown } | undefined;
    const id = typeof data?.id === "string" && /^[0-9a-f]{16}$/.test(data.id) ? data.id : "";
    const name = typeof data?.name === "string" && data.name.length <= 160 && !/[\\/]/.test(data.name) ? data.name : "";
    if (!id || !name) return;
    const url = `/api/files/${id}/${encodeURIComponent(name)}`;
    if (action === "download") {
      const a = h("a", undefined, { href: `${url}?download=1`, download: name, rel: "noopener" });
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    if (openTab(url)) return;
    if (this.linkAsk) return;
    this.linkAsk = { href: new URL(url, location.href).href, at: Date.now(), frame, file: name };
    this.linkMoved = false;
    this.renderNotice();
  }

  private renderNotice(): void {
    window.clearTimeout(this.noticeTimer);
    const ask = this.linkAsk;
    const dismiss = ask ? "Don’t open it" : "Dismiss";
    this.noticeClose.title = dismiss;
    this.noticeClose.setAttribute("aria-label", dismiss);
    this.noticeOpen.hidden = !ask;
    if (ask) {
      // A link waiting for the viewer's OK comes first; a render error shows again once it's answered.
      this.notice.classList.add("is-warn");
      this.noticeTitle.textContent = ask.file ? `Open “${ask.file}”?` : "This page wants to open a link";
      this.noticeMsg.textContent = ask.file ? "The browser held it back as a pop-up. Open it from here." : ask.href;
      this.noticeMsg.title = ask.href;
      this.notice.hidden = false;
      return;
    }
    const f = this.current;
    if (!f || !f.errored || !f.error || this.dismissedNoticeFor === f || f.kind === "empty") {
      this.notice.hidden = true;
      return;
    }
    const isApp = f.kind === "app";
    this.notice.classList.toggle("is-warn", !isApp);
    this.noticeTitle.textContent = isApp
      ? f.reported
        ? "This screen hit a rendering error — reported to Trinity"
        : "This screen hit a rendering error"
      : "This build hit a script error";
    this.noticeMsg.textContent = f.error;
    this.noticeMsg.title = f.error;
    this.notice.hidden = false; // (re)appearing from display:none replays its entrance animation
    if (!isApp) this.noticeTimer = window.setTimeout(() => (this.notice.hidden = true), HTML_NOTICE_MS);
  }

  // ── Secure forms ─────────────────────────────────────────────────────────
  // The vault's forms (server/src/vault/forms.ts). The engine sends a descriptor — a title, the fields, never a value —
  // and this page draws the form itself: here, in the trusted host page, over the stage, never inside a frame (a frame
  // is where generated and web-derived pages run). While a sheet is up the frames are inert, so nothing in them can
  // take the focus, be clicked, or pass for the form. What is typed leaves this page in exactly one way: the body of
  // POST /api/vault/forms/<id> on this page's own origin. It is never sent over the socket, never posted into a frame,
  // never kept in the diagnostics, and it is wiped from the inputs before the sheet is taken down.
  // Built with createElement / textContent only: nothing in a descriptor is ever treated as markup.

  private topSheet(): Sheet | null {
    let top: Sheet | null = null;
    for (const s of this.sheets.values()) top = s;
    return top;
  }

  private openSheet(raw: unknown): void {
    const form = cleanForm(raw);
    if (!form || this.destroyed) return;
    const known = this.sheets.get(form.id);
    if (known) {
      known.confirmed = true; // announced again after a reconnect: it stays, with what was typed
      return;
    }
    // What is typed is posted to this page's own origin only — so a form is drawn only for the engine this page came from.
    if (this.httpOrigin !== location.origin) {
      this.toast("A secure form is waiting. Open Trinity's own workspace window to fill it in.", "warn");
      return;
    }
    if (this.sheets.size >= 8) return;
    const sheet = this.buildSheet(form);
    this.sheets.set(form.id, sheet);
    this.sheetLayer.append(sheet.el);
    // The engine says when a form lapses; this is only for a window that has lost the engine.
    sheet.timers.push(window.setTimeout(() => this.closeSheet(form.id, "That secure form timed out."), Math.max(0, form.expiresAt - Date.now()) + 5000));
    this.syncSheets();
  }

  /** The engine closed a form (it was submitted or cancelled somewhere, or it lapsed). */
  private endSheet(rawId: unknown, status: FormEnd): void {
    const id = typeof rawId === "string" ? rawId : "";
    if (!this.sheets.has(id)) return;
    this.closeSheet(id, status === "expired" ? "That secure form timed out. Ask Trinity again when you're ready." : undefined);
  }

  /** After a reconnect: sheets the engine doesn't announce again are no longer open there (it restarted, or they ended). */
  private sweepSheets(): void {
    if (!this.sheets.size) return;
    for (const s of this.sheets.values()) s.confirmed = false;
    window.clearTimeout(this.sheetSweep);
    this.sheetSweep = window.setTimeout(() => {
      for (const [id, s] of [...this.sheets]) if (!s.confirmed) this.closeSheet(id, "That secure form is no longer open. Ask Trinity again.");
    }, SHEET_SWEEP_MS);
  }

  private buildSheet(form: FormRequest): Sheet {
    const seq = ++this.sheetSeq;
    const titleId = `tw-sheet-${seq}-title`;
    const detailId = `tw-sheet-${seq}-detail`;
    const el = h("div", "tw-sheet", { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId });
    el.dataset.purpose = form.purpose;

    const head = h("div", "tw-sheet-head");
    const mark = h("span", "tw-sheet-mark", { "aria-hidden": "true" });
    mark.append(lockIcon());
    const title = h("h2", "tw-sheet-title", { id: titleId });
    title.textContent = form.title;
    head.append(mark, title);
    el.append(head);

    if (form.detail) {
      const detail = h("p", "tw-sheet-detail", { id: detailId });
      detail.textContent = form.detail;
      el.setAttribute("aria-describedby", detailId);
      el.append(detail);
    }
    if (form.host) {
      const host = h("p", "tw-sheet-host");
      const where = h("strong");
      where.textContent = form.host;
      host.append("For ", where);
      el.append(host);
    }

    const fields = form.fields.map((f, i) => this.buildSheetField(f, `tw-sheet-${seq}-f${i}`));
    if (fields.length) {
      const box = h("div", "tw-sheet-fields");
      for (const f of fields) box.append(f.row);
      el.append(box);
      // "Keep the security code" decides whether there is a security code to type at all.
      const keep = fields.find((f) => f.field.type === "checkbox" && f.field.name === "keepCvc");
      const code = fields.find((f) => f.field.type === "cvc");
      if (keep && code) {
        const sync = (): void => {
          code.row.hidden = !keep.input.checked;
          if (!keep.input.checked) code.input.value = "";
        };
        keep.input.addEventListener("change", sync);
        sync();
      }
    }

    const error = h("p", "tw-sheet-error", { role: "alert" });
    error.hidden = true;
    const actions = h("div", "tw-sheet-actions");
    const cancel = h("button", "tw-sheet-btn", { type: "button" });
    cancel.textContent = "Cancel";
    const submit = h("button", "tw-sheet-btn tw-sheet-primary", { type: "button" });
    submit.textContent = form.submitLabel;
    actions.append(cancel, submit);
    const note = h("p", "tw-sheet-note");
    note.textContent = fields.length ? SHEET_NOTE : SHEET_CONFIRM_NOTE;
    el.append(error, actions, note);

    const sheet: Sheet = { form, el, fields, error, submit, cancel, busy: false, shownAt: Date.now(), confirmed: true, timers: [] };
    cancel.addEventListener("click", () => this.cancelSheet(sheet));
    submit.addEventListener("click", (e) => void this.submitSheet(sheet, e));
    return sheet;
  }

  private buildSheetField(f: FormField, id: string): SheetField {
    if (f.type === "checkbox") {
      const row = h("label", "tw-sheet-check");
      const input = h("input", "tw-sheet-box", { type: "checkbox", id });
      input.checked = f.value === "true";
      const text = h("span");
      text.textContent = f.label;
      row.append(input, text);
      return { field: f, input, row, error: null };
    }
    const masked = f.type === "password" || f.type === "cvc" || f.type === "otp-secret";
    const numeric = f.type === "card-number" || f.type === "expiry" || f.type === "cvc";
    const errorId = `${id}-error`;
    const row = h("div", "tw-sheet-field");
    const label = h("label", "tw-sheet-label", { for: id });
    label.textContent = f.label;
    const control = h("div", "tw-sheet-control");
    // Masked as dots on a plain text field where the browser can draw one so (see canMaskText); a password field otherwise.
    const maskText = masked && canMaskText();
    const input = h("input", "tw-sheet-input", {
      id,
      type: masked && !maskText ? "password" : f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text",
      // Keep the browser's own password and card managers out of it: nothing here is theirs to fill in or to keep.
      autocomplete: masked && !maskText ? "new-password" : "off",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      "data-lpignore": "true",
      "data-1p-ignore": "true",
      "data-bwignore": "true",
      "data-form-type": "other",
      "aria-describedby": errorId,
    });
    if (maskText) input.style.setProperty(TEXT_MASK, "disc");
    if (f.required) input.setAttribute("aria-required", "true");
    if (f.placeholder) input.placeholder = f.placeholder;
    if (numeric) input.inputMode = "numeric";
    input.maxLength = f.type === "card-number" ? 23 : f.type === "expiry" ? 7 : f.type === "cvc" ? 4 : f.type === "password" || f.type === "otp-secret" ? 1000 : 320;
    if (!masked && !numeric && f.value) input.value = f.value;
    control.append(input);

    const error = h("p", "tw-sheet-field-error", { id: errorId });
    error.hidden = true;
    const clear = (): void => {
      if (error.hidden) return;
      error.hidden = true;
      error.textContent = "";
      row.classList.remove("is-invalid");
      input.removeAttribute("aria-invalid");
    };

    if (masked) {
      const toggle = h("button", "tw-sheet-toggle", { type: "button", "aria-pressed": "false", "aria-label": `Show ${f.label}` });
      toggle.textContent = "Show";
      toggle.addEventListener("click", () => {
        const show = maskText ? input.style.getPropertyValue(TEXT_MASK) !== "none" : input.type === "password";
        if (maskText) input.style.setProperty(TEXT_MASK, show ? "none" : "disc");
        else input.type = show ? "text" : "password";
        toggle.textContent = show ? "Hide" : "Show";
        toggle.setAttribute("aria-pressed", String(show));
        toggle.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${f.label}`);
        input.focus();
      });
      control.append(toggle);
    }
    if (f.type === "card-number") {
      const brand = h("span", "tw-sheet-brand", { "aria-live": "polite" });
      control.append(brand);
      input.addEventListener("input", () => {
        const before = input.value;
        const caret = input.selectionStart ?? before.length;
        const digitsBefore = before.slice(0, caret).replace(/\D/g, "").length;
        const grouped = groupCardNumber(before);
        if (grouped !== before) {
          input.value = grouped;
          // The caret stays after the same digit it was after.
          let pos = 0;
          for (let seen = 0; pos < grouped.length && seen < digitsBefore; pos++) if (/\d/.test(grouped.charAt(pos))) seen++;
          try {
            input.setSelectionRange(pos, pos);
          } catch {
            /* not a text selection */
          }
        }
        brand.textContent = cardBrandOf(grouped.replace(/\D/g, ""));
        clear();
      });
    } else if (f.type === "expiry") {
      input.addEventListener("input", () => {
        const tidy = tidyExpiry(input.value);
        if (tidy !== input.value) input.value = tidy;
        clear();
      });
    } else if (f.type === "cvc") {
      input.addEventListener("input", () => {
        const digits = input.value.replace(/\D/g, "").slice(0, 4);
        if (digits !== input.value) input.value = digits;
        clear();
      });
    } else {
      input.addEventListener("input", clear);
    }
    row.append(label, control, error);
    return { field: f, input, row, error };
  }

  /** The newest sheet on show, the others behind it; the frames inert while any is up; the focus kept in the sheet. */
  private syncSheets(): void {
    const top = this.topSheet();
    for (const s of this.sheets.values()) {
      const front = s === top;
      if (s.el.hidden === front) {
        s.el.hidden = !front;
        if (front) s.shownAt = Date.now();
      }
    }
    this.sheetLayer.hidden = !top;
    this.root.classList.toggle("tw-has-sheet", Boolean(top));
    if (this.sheetFlag) this.sheetFlag.hidden = !top;
    for (const f of [this.current, this.pending, ...this.leaving]) if (f) f.el.inert = Boolean(top);
    if (top) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!active || !top.el.contains(active)) {
        if (!this.sheetReturn && active && active !== document.body && !this.sheetLayer.contains(active)) this.sheetReturn = active;
        if (active && this.frameFor((active as HTMLIFrameElement).contentWindow ?? null)) active.blur();
        this.focusSheet(top);
      }
    } else if (this.sheetReturn) {
      const back = this.sheetReturn;
      this.sheetReturn = null;
      if (back.isConnected) back.focus({ preventScroll: true });
    }
  }

  /** What can take the focus in a sheet right now, in order. */
  private sheetFocusables(sheet: Sheet): HTMLElement[] {
    return [...sheet.el.querySelectorAll<HTMLElement>("input, button")].filter((el) => !(el as HTMLInputElement).disabled && !el.closest("[hidden]"));
  }

  /** A form to type into starts in its first field; a question to approve starts on Cancel, so a stray Enter approves nothing. */
  private focusSheet(sheet: Sheet): void {
    const first = sheet.form.fields.length ? this.sheetFocusables(sheet).find((el) => el.tagName === "INPUT") : null;
    (first ?? sheet.cancel).focus({ preventScroll: true });
  }

  /** Keys while a sheet is up: Escape cancels it, Tab stays inside it, Enter in a field submits it. */
  private onSheetKey(e: KeyboardEvent, inside: boolean): void {
    const sheet = this.topSheet();
    if (!sheet) return;
    if (inside) {
      e.stopPropagation(); // a modal: the page's own shortcuts stay out of it
    } else {
      // From elsewhere on the page: only when nothing else has the focus (or something in this view does).
      const active = document.activeElement;
      if (active && active !== document.body && !this.root.contains(active)) return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancelSheet(sheet);
      return;
    }
    if (!inside) return;
    if (e.key === "Tab") {
      const items = this.sheetFocusables(sheet);
      e.preventDefault();
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items[items.length - 1] : items[at - 1]) : at < 0 || at === items.length - 1 ? items[0] : items[at + 1];
      next?.focus();
      return;
    }
    const target = e.target as HTMLInputElement | null;
    if (e.key === "Enter" && !e.isComposing && target && target.tagName === "INPUT" && target.type !== "checkbox") {
      e.preventDefault();
      void this.submitSheet(sheet);
    }
  }

  private sheetError(sheet: Sheet, message: string, fieldName?: string): void {
    const f = fieldName ? sheet.fields.find((x) => x.field.name === fieldName && x.error && !x.row.hidden) : undefined;
    if (f?.error) {
      f.error.textContent = message;
      f.error.hidden = false;
      f.row.classList.add("is-invalid");
      f.input.setAttribute("aria-invalid", "true");
      sheet.error.hidden = true;
      sheet.error.textContent = "";
      f.input.focus();
      return;
    }
    sheet.error.textContent = message;
    sheet.error.hidden = false;
  }

  private setSheetBusy(sheet: Sheet, busy: boolean): void {
    sheet.busy = busy;
    sheet.submit.disabled = busy;
    sheet.cancel.disabled = busy;
    sheet.el.setAttribute("aria-busy", String(busy));
  }

  /** What was typed, by field name — or null when something is plainly missing or wrong (and says so in the sheet). */
  private sheetValues(sheet: Sheet): Record<string, string | boolean> | null {
    const values: Record<string, string | boolean> = {};
    for (const f of sheet.fields) {
      if (f.row.hidden) continue;
      const t = f.field.type;
      if (t === "checkbox") {
        values[f.field.name] = f.input.checked;
        continue;
      }
      const masked = t === "password" || t === "cvc" || t === "otp-secret";
      // A password is sent exactly as typed; everything else without the spaces around it.
      const value = t === "card-number" ? f.input.value.replace(/\D/g, "") : masked ? f.input.value : f.input.value.trim();
      const needed = f.field.required === true || (t === "cvc" && !f.row.hidden && sheet.fields.some((x) => x.field.name === "keepCvc"));
      if (needed && !value.trim()) {
        this.sheetError(sheet, "Fill this in.", f.field.name);
        return null;
      }
      if (t === "card-number" && value && !luhnValid(value)) {
        this.sheetError(sheet, "That card number doesn't look right. Check the digits.", f.field.name);
        return null;
      }
      values[f.field.name] = value;
    }
    return values;
  }

  /** The one way out for what was typed: this page's own origin, by a relative address, in the request body. */
  private sendForm(id: string, values: Record<string, string | boolean>): Promise<Response> {
    return fetch(`/api/vault/forms/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
  }

  private async submitSheet(sheet: Sheet, click?: MouseEvent): Promise<void> {
    const id = sheet.form.id;
    if (sheet.busy || this.sheets.get(id) !== sheet) return;
    // A pointer click on Approve that lands as the sheet appears was on its way to something else.
    if (sheet.form.purpose === "confirm" && click && click.detail > 0 && Date.now() - sheet.shownAt < SHEET_ARM_MS) return;
    sheet.error.hidden = true;
    const values = this.sheetValues(sheet);
    if (!values) return;
    this.setSheetBusy(sheet, true);
    let res: Response | null = null;
    try {
      res = await this.sendForm(id, values);
      // Unlinked meanwhile: link this browser again, once, and send it again.
      if (res.status === 401 && (await ensureSession())) res = await this.sendForm(id, values);
    } catch {
      res = null;
    } finally {
      for (const k of Object.keys(values)) values[k] = "";
    }
    if (this.destroyed || this.sheets.get(id) !== sheet) return; // it was closed meanwhile
    this.setSheetBusy(sheet, false);
    if (!res) {
      this.sheetError(sheet, "Couldn't reach Trinity's engine. What you typed is still here: try again.");
      return;
    }
    if (res.ok) {
      const purpose = sheet.form.purpose;
      this.closeSheet(id);
      if (purpose === "unlock") this.toast("The vault is unlocked.", "success");
      else if (purpose.startsWith("save-")) this.toast("Saved in the vault.", "success");
      return;
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown> | null;
    } catch {
      body = null;
    }
    const code = typeof body?.code === "string" ? body.code : "";
    if (code === "gone" || res.status === 404) {
      this.closeSheet(id, "That secure form is no longer open. Ask Trinity again.");
      return;
    }
    // (The engine's messages are fixed sentences; they are shown as text.)
    const message = typeof body?.error === "string" && body.error.length <= 300 ? body.error : "That didn't go through. Try again.";
    if (code === "wrong-passphrase" || code === "wait") for (const f of sheet.fields) if (f.input.type !== "checkbox") f.input.value = "";
    this.sheetError(sheet, message, typeof body?.field === "string" ? body.field : code === "wrong-passphrase" ? sheet.fields[0]?.field.name : undefined);
    const wait = code === "wait" && typeof body?.retryAfterMs === "number" ? Math.min(body.retryAfterMs, 15 * 60_000) : 0;
    if (wait > 0) {
      sheet.submit.disabled = true;
      sheet.timers.push(window.setTimeout(() => (sheet.submit.disabled = sheet.busy), wait));
    }
  }

  /** Cancel: tell the engine (so whatever waits on the form knows) and take the sheet down. */
  private cancelSheet(sheet: Sheet): void {
    if (this.sheets.get(sheet.form.id) !== sheet) return;
    void fetch(`/api/vault/forms/${encodeURIComponent(sheet.form.id)}`, { method: "DELETE", cache: "no-store", credentials: "same-origin", redirect: "error" }).catch(() => undefined);
    this.closeSheet(sheet.form.id);
  }

  /** Take a sheet down. What was typed is wiped from its inputs first. */
  private closeSheet(id: string, why?: string): void {
    const sheet = this.sheets.get(id);
    if (!sheet) return;
    this.sheets.delete(id);
    for (const t of sheet.timers) window.clearTimeout(t);
    sheet.timers = [];
    for (const f of sheet.fields) {
      if (f.input.type === "checkbox") f.input.checked = false;
      else f.input.value = "";
    }
    sheet.el.remove();
    if (why && !this.destroyed) this.toast(why, "info");
    this.syncSheets();
  }

  // ── Toasts ───────────────────────────────────────────────────────────────

  /** Settings → Workspace window → Overlays: "alerts" hides the agent trail; "none" hides the chips and toasts too (the notice and the connection dot stay). */
  private setOverlays(raw: unknown): void {
    const overlays = raw === "alerts" || raw === "none" ? raw : "all";
    if (this.overlay.dataset.overlays !== overlays) this.overlay.dataset.overlays = overlays;
  }

  private toast(rawText: unknown, rawTone: unknown): void {
    const text = (typeof rawText === "string" ? rawText : String(rawText ?? "")).trim();
    if (!text) return;
    const tone: ToastTone = TONES.includes(rawTone as ToastTone) ? (rawTone as ToastTone) : "info";
    const dup = this.toasts.find((t) => !t.leaving && t.text === text && t.tone === tone);
    if (dup) {
      this.armToast(dup, TOAST_MS);
      restartClass(dup.el, "is-bumped");
      return;
    }
    const el = h("div", `tw-toast tw-tone-${tone}`, { role: tone === "error" ? "alert" : "status" });
    const icon = h("span", "tw-toast-icon", { "aria-hidden": "true" });
    icon.textContent = TONE_ICON[tone];
    const body = h("span", "tw-toast-text");
    body.textContent = text;
    el.append(icon, body);
    const rec: ToastRecord = { el, text, tone, timer: 0, deadline: 0, remaining: TOAST_MS, leaving: false };
    el.title = "Click to dismiss";
    el.addEventListener("click", () => this.dismissToast(rec));
    el.addEventListener("mouseenter", () => this.pauseToast(rec));
    el.addEventListener("mouseleave", () => this.armToast(rec, Math.max(rec.remaining, 1200)));
    this.toastBox.append(el);
    this.toasts.push(rec);
    this.armToast(rec, TOAST_MS);
    const visible = this.toasts.filter((t) => !t.leaving);
    for (let i = 0; i < visible.length - MAX_TOASTS; i++) {
      const oldest = visible[i];
      if (oldest) this.dismissToast(oldest);
    }
  }

  private armToast(rec: ToastRecord, ms: number): void {
    if (rec.leaving) return;
    window.clearTimeout(rec.timer);
    rec.remaining = ms;
    rec.deadline = Date.now() + ms;
    rec.timer = window.setTimeout(() => this.dismissToast(rec), ms);
  }

  private pauseToast(rec: ToastRecord): void {
    if (rec.leaving) return;
    window.clearTimeout(rec.timer);
    rec.remaining = Math.max(0, rec.deadline - Date.now());
  }

  private dismissToast(rec: ToastRecord): void {
    if (rec.leaving) return;
    rec.leaving = true;
    window.clearTimeout(rec.timer);
    rec.el.classList.add("is-leaving");
    window.setTimeout(() => {
      rec.el.remove();
      const i = this.toasts.indexOf(rec);
      if (i >= 0) this.toasts.splice(i, 1);
    }, 260);
  }

  // ── Agent trail (Jev decisions + tools + replies) ────────────────────────

  private pushAgent(evt: Extract<WorkspaceEvent, { type: "agent" }>): void {
    const kind = (evt.kind ?? "decision") as AgentKind;
    const tool = typeof evt.tool === "string" ? evt.tool : "";
    const text = typeof evt.text === "string" ? evt.text.trim() : "";
    const label = agentLabel(kind, tool, text, evt.ok, evt.confidence);
    if (!label) return;
    const el = h("div", `tw-agent-row tw-agent-${kind}`, { title: text || tool || kind });
    const tag = h("span", "tw-agent-tag");
    tag.textContent = agentTag(kind, tool);
    const body = h("span", "tw-agent-text");
    body.textContent = label;
    el.append(tag, body);
    this.agentBox.append(el);
    const timer = window.setTimeout(() => this.dropAgent(el), WorkspaceView.AGENT_TTL_MS);
    this.agentRows.push({ el, timer });
    while (this.agentRows.length > WorkspaceView.AGENT_KEEP) {
      const old = this.agentRows.shift();
      if (old) {
        window.clearTimeout(old.timer);
        this.dropAgent(old.el, true);
      }
    }
  }

  private dropAgent(el: HTMLDivElement, immediate = false): void {
    const i = this.agentRows.findIndex((r) => r.el === el);
    if (i >= 0) {
      window.clearTimeout(this.agentRows[i]!.timer);
      this.agentRows.splice(i, 1);
    }
    if (immediate || !el.isConnected) {
      el.remove();
      return;
    }
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 260);
  }

  // ── Activity chips ───────────────────────────────────────────────────────

  private setActivity(rawId: unknown, text: string | null): void {
    const id = typeof rawId === "string" ? rawId : String(rawId ?? "");
    if (!id) return;
    const rec = this.activities.get(id);
    if (text) {
      if (rec) {
        for (const t of rec.timers) window.clearTimeout(t);
        rec.timers = [];
        rec.done = false;
        rec.el.classList.remove("is-done", "is-leaving");
        rec.label.textContent = text;
        rec.el.title = text;
        return;
      }
      const el = h("div", "tw-chip", { title: text });
      const label = h("span", "tw-chip-text");
      label.textContent = text;
      el.append(h("span", "tw-spin", { "aria-hidden": "true" }), label);
      this.activityBox.append(el);
      this.activities.set(id, { el, label, timers: [], done: false });
      return;
    }
    if (!rec || rec.done) return;
    // Finished: the spinner turns into a check, then the chip slips away.
    rec.done = true;
    rec.el.classList.add("is-done");
    rec.timers.push(window.setTimeout(() => rec.el.classList.add("is-leaving"), ACTIVITY_DONE_MS));
    rec.timers.push(
      window.setTimeout(() => {
        rec.el.remove();
        if (this.activities.get(id) === rec) this.activities.delete(id);
      }, ACTIVITY_DONE_MS + 280),
    );
  }

  private syncActivities(list: WorkspaceActivity[]): void {
    const busy = new Set<string>();
    for (const a of list) {
      if (!a || typeof a.id !== "string" || typeof a.text !== "string" || !a.text) continue;
      busy.add(a.id);
      this.setActivity(a.id, a.text);
    }
    for (const [id, rec] of this.activities) if (!busy.has(id) && !rec.done) this.setActivity(id, null);
  }

  // ── Full screen ──────────────────────────────────────────────────────────

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (!this.root.requestFullscreen) return;
    void this.root.requestFullscreen({ navigationUI: "hide" }).catch(() => {
      this.toast("Full screen isn’t available here.", "warn");
    });
  }

  private onFullscreenChange(): void {
    const active = document.fullscreenElement === this.root;
    if (active === this.root.classList.contains("tw-fullscreen")) return;
    this.root.classList.toggle("tw-fullscreen", active);
    if (this.fsBtn) {
      this.fsBtn.setAttribute("aria-pressed", String(active));
      this.fsBtn.innerHTML = active ? ICONS.exitFullscreen : ICONS.fullscreen;
      const label = active ? "Exit full screen" : "Full screen";
      this.fsBtn.title = label;
      this.fsBtn.setAttribute("aria-label", label);
    }
    if (active) {
      // Presenting: hide the bar and keep the screen awake while players watch.
      this.focusBeforeFullscreen = this.focus;
      this.focusMode(true);
      void this.lockWake();
    } else {
      if (this.focusBeforeFullscreen === false) this.focusMode(false);
      this.focusBeforeFullscreen = null;
      void this.releaseWake();
    }
  }

  private async lockWake(): Promise<void> {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } })
        .wakeLock;
      if (wl && !this.wakeLock) this.wakeLock = await wl.request("screen");
    } catch {
      /* not permitted — fine */
    }
  }

  private async releaseWake(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    try {
      await lock?.release();
    } catch {
      /* already released */
    }
  }

  // ── misc ─────────────────────────────────────────────────────────────────

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.warn("[workspace] callback failed:", err);
    }
  }
}
