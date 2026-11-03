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
 */
import "./workspace.css";
import { buildFrameDoc, type FrameKind } from "./frame.js";
import type {
  AgentKind,
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
  /** A link a page asked to open, waiting in the notice for the viewer's OK; it goes when that page does. */
  private linkAsk: { href: string; at: number; frame: Frame } | null = null;
  /** A real pointer move (or a deliberate touch or pen press) has landed on the Open button since this question appeared (a click needs one). */
  private linkMoved = false;
  /** When a press last landed on the Open button (a burst of taps never counts as a deliberate one). */
  private linkPressAt = 0;
  private focus = false;
  private focusBeforeFullscreen: boolean | null = null;
  private peekTimer = 0;
  private wakeLock: { release(): Promise<void> } | null = null;

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

    this.overlay.append(this.bootEl, this.activityBox, this.agentBox, this.toastBox, this.notice, float);
    this.stage.append(this.overlay);
    root.append(this.stage);
    container.append(root);

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
    heading.append(title, kind);

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

  private assetBlob(url: string): Promise<Blob | null> {
    let p = this.assetBlobs.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      this.assetBlobs.set(url, p);
      if (this.assetBlobs.size > 300) this.assetBlobs.delete(this.assetBlobs.keys().next().value!);
    }
    return p;
  }

  private sendAssets(frame: Frame, mapped: unknown): void {
    // (Engine images, and the audio clips make_audio records: the frame can't load either itself.)
    const prefixes = [`${this.httpOrigin}/api/images/`, `${this.httpOrigin}/api/audio/`, `${this.httpOrigin}/api/videos/`];
    // Images embedded in a widget card's HTML (a content card's hero) travel the same way; the frame inlines them.
    const inlineImages = new RegExp(`${escapeRegExp(this.httpOrigin)}/api/images/[A-Za-z0-9_.-]+`, "g");
    const found = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
      if (typeof v === "string") {
        if (prefixes.some((p) => v.startsWith(p))) found.add(v);
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
    this.uiEvents.push(evt);
    if (this.uiEvents.length > 20) this.uiEvents.shift();
    const internal = evt && typeof evt === "object" ? (evt as { __trinity?: unknown }).__trinity : undefined;
    if (internal === "alert") {
      const text = String((evt as { text?: unknown }).text ?? "").trim();
      if (text) this.toast(text, "info");
      return;
    }
    if (internal === "link") {
      this.askToOpen(frame, String((evt as { href?: unknown }).href ?? ""));
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
    window.open(ask.href, "_blank", "noopener,noreferrer");
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
      this.noticeTitle.textContent = "This page wants to open a link";
      this.noticeMsg.textContent = ask.href;
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
