import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { BUILD_PREVIEW_TEMPLATE } from "./build-preview.js";

/**
 * The workspace bus: ONE shared workspace that every channel (voice /call, text /ws,
 * heartbeat, tools) writes to, and every window (the standalone workspace window and
 * the main app's pane) subscribes to over /ws/workspace. Windows hot-update from
 * these events — app-mode data changes are posted into the running template without
 * reloading it.
 */
export type WorkspaceMode = "empty" | "html" | "app";

export interface WorkspaceTemplate {
  id: string;
  kind: "default" | "custom";
  name: string;
  /** HTML fragment implementing template contract v1: window.render(state, prev). */
  source: string;
}

export interface WorkspaceActivity {
  id: string;
  text: string;
}

export interface WorkspaceSnapshot {
  /** Changes on every engine boot — windows reset their version tracking when it does. */
  epoch: string;
  version: number;
  mode: WorkspaceMode;
  title: string;
  html: string | null;
  template: WorkspaceTemplate | null;
  state: unknown | null;
  /** Who owns the current app (e.g. "game:<id>"); late updates from other owners are dropped. */
  owner: string | null;
  activities: WorkspaceActivity[];
  updatedAt: number;
}

export type ToastTone = "info" | "success" | "warn" | "error";

/** A Jev / tool lifecycle step mirrored into every workspace window. */
export type AgentKind = "decision" | "tool" | "tool_result" | "reply";

export interface AgentEvent {
  type: "agent";
  kind: AgentKind;
  at: number;
  /** Tool name, or the decision action ("NONE", "make_image", …). */
  tool?: string;
  /** Short human text (utterance snippet, say line, reply). */
  text?: string;
  ok?: boolean;
  confidence?: number;
  args?: Record<string, unknown>;
}

export type WorkspaceEvent =
  | { type: "snapshot"; snapshot: WorkspaceSnapshot }
  | { type: "state"; version: number; state: unknown; title: string }
  | { type: "template"; version: number; template: WorkspaceTemplate; state: unknown; title: string }
  | { type: "html"; version: number; title: string; html: string }
  | { type: "toast"; text: string; tone: ToastTone }
  | { type: "activity"; id: string; text: string; busy: boolean }
  | AgentEvent;

export type WorkspaceClientEvent =
  | { type: "hello" }
  | { type: "render_error"; templateId: string; message: string };

type Send = (e: WorkspaceEvent) => void;

const STORE = path.join(DATA_DIR, "workspace.json");
const STATE_DEBOUNCE_MS = 40;
const STATE_MAX_WAIT_MS = 150;
const EPOCH = `${Date.now().toString(36)}-${process.pid}`;

/** A streaming BUILD's live preview: temporary, it never outlives the build showing it. */
export function isBuildPreview(s: { template?: WorkspaceTemplate | null }): boolean {
  return s.template?.id === BUILD_PREVIEW_TEMPLATE.id;
}

/** A restorable workspace screen (what was on the board before a clear / remove). */
export interface WorkspaceUndoEntry {
  at: number;
  reason: string;
  /** Short human label, e.g. "board with 3 cards". */
  label: string;
  mode: WorkspaceMode;
  title: string;
  html: string | null;
  template: WorkspaceTemplate | null;
  state: unknown | null;
  owner: string | null;
}

const MAX_UNDO = 12;

function cloneJson<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function undoLabelOf(mode: WorkspaceMode, title: string, owner: string | null, state: unknown): string {
  if (mode === "empty") return "empty workspace";
  if (owner === "board") {
    const cards = state && typeof state === "object" && Array.isArray((state as { cards?: unknown }).cards)
      ? ((state as { cards: unknown[] }).cards.length)
      : 0;
    return cards ? `board with ${cards} card${cards === 1 ? "" : "s"}` : "empty board";
  }
  if (owner?.startsWith("game:")) return `game “${title || "Untitled"}”`;
  if (mode === "app") return `app “${title || "Workspace"}”`;
  if (mode === "html") return `page “${title || "Workspace"}”`;
  return title || "workspace";
}

export class WorkspaceBus {
  private snap: WorkspaceSnapshot = {
    epoch: EPOCH,
    version: 0,
    mode: "empty",
    title: "Workspace",
    html: null,
    template: null,
    state: null,
    owner: null,
    activities: [],
    updatedAt: Date.now(),
  };
  private subs = new Set<Send>();
  private activities = new Map<string, string>();
  private badTemplates = new Set<string>();
  private errorListeners = new Set<(templateId: string, message: string) => void>();
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stateDirty = false;
  private firstDirtyAt = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest screen not yet on disk (never a build preview). */
  private unsaved: WorkspaceSnapshot | null = null;
  /** Recent screens that clear / remove can bring back. */
  private undoStack: WorkspaceUndoEntry[] = [];

  constructor(private persistPath: string | null = STORE) {
    this.restore();
  }

  snapshot(): WorkspaceSnapshot {
    return { ...this.snap, activities: [...this.activities].map(([id, text]) => ({ id, text })) };
  }

  /** True when there's a prior screen to restore (after a clear or card remove). */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Label of the most recent undo entry, or null. */
  undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  /**
   * Remember the current screen so clear / remove / accidental wipes can be undone.
   * No-ops when empty or when a transient build preview is showing.
   */
  pushUndo(reason: string): boolean {
    if (this.snap.mode === "empty") return false;
    if (isBuildPreview(this.snap)) return false;
    this.flushState();
    const entry: WorkspaceUndoEntry = {
      at: Date.now(),
      reason: reason.slice(0, 64),
      label: undoLabelOf(this.snap.mode, this.snap.title, this.snap.owner, this.snap.state),
      mode: this.snap.mode,
      title: this.snap.title,
      html: this.snap.html,
      template: cloneJson(this.snap.template),
      state: cloneJson(this.snap.state),
      owner: this.snap.owner,
    };
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    return true;
  }

  /**
   * Restore the most recent remembered screen. Returns a short say-line for the tool.
   */
  undo(): { ok: boolean; say: string; label?: string } {
    const entry = this.undoStack.pop();
    if (!entry) return { ok: false, say: "There's nothing to bring back — the undo stack is empty." };
    this.cancelPendingState();
    this.snap = {
      ...this.snap,
      mode: entry.mode,
      title: entry.title,
      html: entry.html,
      template: entry.template,
      state: entry.state,
      owner: entry.owner,
    };
    this.bump();
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
    return { ok: true, say: `Restored ${entry.label}.`, label: entry.label };
  }

  /** Subscribe a window; it receives the full snapshot immediately. */
  subscribe(send: Send): () => void {
    this.subs.add(send);
    this.safeSend(send, { type: "snapshot", snapshot: this.snapshot() });
    return () => this.subs.delete(send);
  }

  /** How many windows are watching (the standalone workspace window, the main app's pane). */
  get subscribers(): number {
    return this.subs.size;
  }

  /** Freeform UI (a BUILD): replace the workspace with an HTML fragment. */
  showHtml(html: string, title: string, owner: string | null = null): void {
    this.cancelPendingState();
    this.snap = { ...this.snap, mode: "html", html, title, template: null, state: null, owner };
    const version = this.bump();
    this.broadcast({ type: "html", version, title, html });
  }

  /** Structured app: a template rendering `state`. Data updates later via setState. */
  showApp(template: WorkspaceTemplate, state: unknown, title: string, owner: string | null = null): void {
    this.cancelPendingState();
    this.snap = { ...this.snap, mode: "app", template, state, title, html: null, owner };
    const version = this.bump();
    this.broadcast({ type: "template", version, template, state, title });
  }

  /** Who owns what's on screen ("game:<id>", or null for freeform/none). */
  get owner(): string | null {
    return this.snap.owner;
  }

  /**
   * Swap the template of the current app, keeping its state (e.g. custom game screen
   * ready). Ignored unless the app is still owned by `owner` (when given).
   */
  setTemplate(template: WorkspaceTemplate, owner?: string): boolean {
    if (this.snap.mode !== "app" || (owner !== undefined && owner !== this.snap.owner)) return false;
    this.flushState();
    this.snap = { ...this.snap, template };
    const version = this.bump();
    this.broadcast({ type: "template", version, template, state: this.snap.state, title: this.snap.title });
    return true;
  }

  /**
   * Replace the app state. Coalesced: bursts within ~40ms become one push, but a
   * continuous stream still flushes at least every ~150ms. Ignored unless the app is
   * still owned by `owner` (when given) — a late update for game A never lands on game B.
   */
  setState(state: unknown, owner?: string): boolean {
    if (this.snap.mode !== "app" || (owner !== undefined && owner !== this.snap.owner)) return false;
    this.snap = { ...this.snap, state };
    if (!this.stateDirty) {
      this.stateDirty = true;
      this.firstDirtyAt = Date.now();
    }
    if (this.stateTimer) clearTimeout(this.stateTimer);
    const waited = Date.now() - this.firstDirtyAt;
    const delay = waited >= STATE_MAX_WAIT_MS ? 0 : Math.min(STATE_DEBOUNCE_MS, STATE_MAX_WAIT_MS - waited);
    this.stateTimer = setTimeout(() => this.flushState(), delay);
    return true;
  }

  /** Push any coalesced state now. */
  flushState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (!this.stateDirty) return;
    this.stateDirty = false;
    const version = this.bump();
    this.broadcast({ type: "state", version, state: this.snap.state, title: this.snap.title });
  }

  /**
   * Rename the workspace. In app mode the new title rides on the next (coalesced) state
   * push; otherwise windows get a snapshot (an unchanged html build is not rebuilt).
   */
  setTitle(title: string): void {
    if (this.snap.title === title) return;
    this.snap = { ...this.snap, title };
    if (this.snap.mode === "app") this.setState(this.snap.state);
    else {
      this.bump();
      this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
    }
  }

  clear(): void {
    this.pushUndo("clear");
    this.cancelPendingState();
    this.snap = { ...this.snap, mode: "empty", html: null, template: null, state: null, owner: null, title: "Workspace" };
    this.bump();
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
  }

  get mode(): WorkspaceMode {
    return this.snap.mode;
  }

  /** Current app state (what the template is rendering), or null. */
  get state(): unknown {
    return this.snap.state;
  }

  get templateId(): string | null {
    return this.snap.template?.id ?? null;
  }

  toast(text: string, tone: ToastTone = "info"): void {
    this.broadcast({ type: "toast", text, tone });
  }

  /** Show (text) or clear (null) a background-work indicator, e.g. "Painting Lyra's portrait…". */
  activity(id: string, text: string | null): void {
    if (text) this.activities.set(id, text);
    else if (!this.activities.delete(id)) return;
    this.broadcast({ type: "activity", id, text: text ?? "", busy: Boolean(text) });
  }

  /**
   * Relay a Jev decision / tool lifecycle step into every workspace window.
   * Not versioned or persisted — it's a live trail of what the agent is doing.
   */
  agent(kind: AgentKind, detail: Omit<AgentEvent, "type" | "kind" | "at"> = {}): void {
    const text = typeof detail.text === "string" ? detail.text.replace(/\s+/g, " ").trim().slice(0, 280) : undefined;
    const tool = typeof detail.tool === "string" ? detail.tool.slice(0, 64) : undefined;
    let args: Record<string, unknown> | undefined;
    if (detail.args && typeof detail.args === "object") {
      try {
        args = JSON.parse(JSON.stringify(detail.args, (_k, v) => (typeof v === "string" ? v.slice(0, 120) : v))) as Record<
          string,
          unknown
        >;
      } catch {
        args = undefined;
      }
    }
    this.broadcast({
      type: "agent",
      kind,
      at: Date.now(),
      tool,
      text: text || undefined,
      ok: detail.ok,
      confidence: typeof detail.confidence === "number" ? detail.confidence : undefined,
      args,
    });
  }

  /** A window reported that a template threw while rendering. Fires once per template id. */
  onRenderError(cb: (templateId: string, message: string) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  isTemplateBad(id: string): boolean {
    return this.badTemplates.has(id);
  }

  handleClient(evt: WorkspaceClientEvent): void {
    if (evt.type === "render_error") {
      if (!evt.templateId || this.badTemplates.has(evt.templateId)) return; // loop guard
      this.badTemplates.add(evt.templateId);
      console.warn(`[workspace] template ${evt.templateId} failed to render: ${String(evt.message).slice(0, 300)}`);
      for (const cb of this.errorListeners) {
        try {
          cb(evt.templateId, String(evt.message));
        } catch (err) {
          console.warn("[workspace] render-error listener failed:", (err as Error).message);
        }
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private bump(): number {
    this.snap.version += 1;
    this.snap.updatedAt = Date.now();
    this.scheduleSave();
    return this.snap.version;
  }

  private cancelPendingState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.stateDirty = false;
  }

  private broadcast(e: WorkspaceEvent): void {
    for (const send of this.subs) this.safeSend(send, e);
  }

  private safeSend(send: Send, e: WorkspaceEvent): void {
    try {
      send(e);
    } catch {
      this.subs.delete(send);
    }
  }

  private scheduleSave(): void {
    if (!this.persistPath) return;
    // A build preview is temporary: the screen it covers stays on disk, so a restart
    // mid-build never comes back to a half-written page that nothing will finish.
    if (!isBuildPreview(this.snap)) this.unsaved = { ...this.snap };
    if (this.saveTimer || !this.unsaved) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const snap = this.unsaved;
      this.unsaved = null;
      if (!snap) return;
      try {
        fs.mkdirSync(path.dirname(this.persistPath!), { recursive: true });
        const tmp = `${this.persistPath}.tmp`;
        const { activities: _a, ...rest } = snap;
        fs.writeFileSync(tmp, JSON.stringify(rest));
        fs.renameSync(tmp, this.persistPath!);
      } catch (err) {
        console.warn("[workspace] could not persist snapshot:", (err as Error).message);
      }
    }, 500);
  }

  private restore(): void {
    if (!this.persistPath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as Partial<WorkspaceSnapshot>;
      // A saved build preview (an older file) has no build behind it any more: start empty.
      if (saved && (saved.mode === "html" || saved.mode === "app" || saved.mode === "empty") && !isBuildPreview(saved)) {
        this.snap = {
          epoch: EPOCH,
          version: Number(saved.version) || 0,
          mode: saved.mode,
          title: typeof saved.title === "string" ? saved.title : "Workspace",
          html: saved.html ?? null,
          template: saved.template ?? null,
          state: saved.state ?? null,
          owner: typeof saved.owner === "string" ? saved.owner : null,
          activities: [],
          updatedAt: Number(saved.updatedAt) || Date.now(),
        };
      }
    } catch {
      /* first run or unreadable — start empty */
    }
  }
}

/** The single shared workspace. */
export const workspace = new WorkspaceBus();
