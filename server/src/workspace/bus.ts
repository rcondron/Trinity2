import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { FormRequest } from "../vault/index.js";
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

/** What windows draw over the board: everything, alerts only (background chips and toasts), or nothing but the board. */
export type WorkspaceOverlays = "all" | "alerts" | "none";

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
  /** Settings → Workspace window → Overlays. */
  overlays: WorkspaceOverlays;
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

/** A command for one card on the board (workspace/card-commands.ts); the board answers with a "board" client event. */
export interface CardCommand {
  id: string;
  n: number;
  op: string;
  arg: unknown;
}

/**
 * A secure form for the windows to draw in their own trusted page (vault/forms.ts): a descriptor — title, fields,
 * where to post — and never a value. What is typed goes from the window to POST /api/vault/forms/<id>, not through here.
 */
export type SecureForm = FormRequest;
export type SecureFormEnd = "submitted" | "approved" | "cancelled" | "expired";

export type WorkspaceEvent =
  | { type: "snapshot"; snapshot: WorkspaceSnapshot }
  | { type: "form"; form: SecureForm }
  | { type: "form_closed"; id: string; status: SecureFormEnd }
  | { type: "command"; cmd: CardCommand }
  | { type: "state"; version: number; state: unknown; title: string }
  | { type: "template"; version: number; template: WorkspaceTemplate; state: unknown; title: string }
  | { type: "html"; version: number; title: string; html: string }
  | { type: "overlays"; overlays: WorkspaceOverlays }
  | { type: "toast"; text: string; tone: ToastTone }
  | { type: "activity"; id: string; text: string; busy: boolean }
  | AgentEvent;

export type WorkspaceClientEvent =
  | { type: "hello" }
  | { type: "render_error"; templateId: string; message: string }
  /** From the card board's own template only (the window checks): a command's answer, or a layout made by hand. */
  | { type: "board"; evt: Record<string, unknown> };

type Send = (e: WorkspaceEvent) => void;

const STORE = path.join(DATA_DIR, "workspace.json");
const STATE_DEBOUNCE_MS = 40;
const STATE_MAX_WAIT_MS = 150;
/** A change is on disk this long after it was made (and at once when the engine goes down — see flushSave). */
const SAVE_DELAY_MS = 300;
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
  /**
   * The screen as the change left it (the last write in the same turn as the push): with `state` it says exactly what
   * the change did, so an undo can take back that and nothing else. Undefined when nothing was written.
   */
  after?: { mode: WorkspaceMode; owner: string | null; state: unknown | null };
  /** No longer taking `after` (the change that pushed it is over). */
  sealed?: boolean;
  /** How many more writes belong to the change (it is sealed after the last). */
  takes?: number;
}

/** What an undo makes of the screen when an owner (the card board) takes back one change instead of the whole screen. */
export interface UndoMerge {
  template: WorkspaceTemplate;
  state: unknown;
  title: string;
  /** What was undone, as a sentence ("Brought back card 4."). */
  say: string;
}

/** Returns the merged screen, "nothing" when the entry would change nothing (the next one is tried), or null to restore the whole screen as it was. */
export type UndoMerger = (entry: WorkspaceUndoEntry, now: { mode: WorkspaceMode; owner: string | null; state: unknown | null }) => UndoMerge | "nothing" | null;

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
    overlays: "all",
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
  /** A write to disk is under way (the next one waits for it). */
  private saving = false;
  /** Recent screens that clear / remove can bring back. */
  private undoStack: WorkspaceUndoEntry[] = [];
  private boardListeners = new Set<(evt: Record<string, unknown>) => void>();
  /** Owners whose state objects are never changed in place (the card board): an undo entry keeps the object itself, not a copy. */
  private frozenOwners = new Set<string>();
  private undoMerger: UndoMerger | null = null;
  private undoListeners = new Set<() => void>();
  /** Takes a freeform page (showHtml with no owner) as a card instead of the whole window; set by the card board. */
  private htmlAdopter: ((html: string, title: string) => boolean) | null = null;
  /**
   * The secure forms open right now, for windows that connect later. Kept apart from `snap` on purpose: a form is
   * never part of a snapshot, never in an undo entry and never written to workspace.json.
   */
  private forms = new Map<string, SecureForm>();

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
  pushUndo(reason: string, writes = Infinity): boolean {
    if (this.snap.mode === "empty") return false;
    if (isBuildPreview(this.snap)) return false;
    this.flushState();
    const frozen = this.snap.owner !== null && this.frozenOwners.has(this.snap.owner);
    const entry: WorkspaceUndoEntry = {
      at: Date.now(),
      reason: reason.slice(0, 64),
      label: undoLabelOf(this.snap.mode, this.snap.title, this.snap.owner, this.snap.state),
      mode: this.snap.mode,
      title: this.snap.title,
      html: this.snap.html,
      // (The board's template and state are never changed in place: the entry keeps them as they are, at no cost.)
      template: frozen ? this.snap.template : cloneJson(this.snap.template),
      state: frozen ? this.snap.state : cloneJson(this.snap.state),
      owner: this.snap.owner,
      takes: writes,
    };
    const open = this.undoStack[this.undoStack.length - 1];
    if (open) open.sealed = true;
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    // What is written next is the change this entry undoes: the next `writes` writes when the change says how many it
    // makes, else everything until it calls sealUndo() — and never anything past the end of this turn.
    queueMicrotask(() => {
      entry.sealed = true;
    });
    return true;
  }

  /** The change that pushed the newest undo entry is over: later writes are not part of it. */
  sealUndo(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.sealed = true;
  }

  /** The screens an undo could still bring back, oldest first. */
  undoEntries(): readonly WorkspaceUndoEntry[] {
    return this.undoStack;
  }

  /** Drop the newest undo entry when it is this one (a change that turned out to be nothing). */
  dropUndo(reason: string): void {
    if (this.undoStack[this.undoStack.length - 1]?.reason === reason.slice(0, 64)) this.undoStack.pop();
  }

  /** States owned by `owner` are never changed in place, so undo entries may keep them without copying. */
  freezeOwner(owner: string): void {
    this.frozenOwners.add(owner);
  }

  /** How an undo takes back one change on a screen that can do better than "put the whole old screen back". */
  setUndoMerger(fn: UndoMerger): void {
    this.undoMerger = fn;
  }

  /** Called after every undo that changed the screen. Returns an unsubscribe. */
  onUndo(cb: () => void): () => void {
    this.undoListeners.add(cb);
    return () => this.undoListeners.delete(cb);
  }

  /** A freeform page with no owner goes where this says (a card on the board) instead of taking the whole window. */
  setHtmlAdopter(fn: (html: string, title: string) => boolean): void {
    this.htmlAdopter = fn;
  }

  /** The newest undo entry, while its turn is still running, learns what the screen became. */
  private noteWrite(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top || top.sealed) return;
    top.after = { mode: this.snap.mode, owner: this.snap.owner, state: this.snap.state };
    top.takes = (top.takes ?? Infinity) - 1;
    if (top.takes <= 0) top.sealed = true;
  }

  /**
   * Restore the most recent remembered screen. Returns a short say-line for the tool.
   */
  undo(): { ok: boolean; say: string; label?: string } {
    let skipped = 0;
    for (let entry = this.undoStack.pop(); entry; entry = this.undoStack.pop()) {
      entry.sealed = true;
      let merged: UndoMerge | "nothing" | null = null;
      try {
        merged = this.undoMerger ? this.undoMerger(entry, { mode: this.snap.mode, owner: this.snap.owner, state: this.snap.state }) : null;
      } catch (err) {
        console.warn("[workspace] undo merge failed, restoring the whole screen:", (err as Error).message);
      }
      // An entry that would change nothing (what it holds is already there, or is gone for good): the one before it.
      if (merged === "nothing") {
        skipped++;
        continue;
      }
      this.cancelPendingState();
      if (merged) {
        this.snap = { ...this.snap, mode: "app", title: merged.title, html: null, template: merged.template, state: merged.state, owner: entry.owner };
      } else {
        this.snap = {
          ...this.snap,
          mode: entry.mode,
          title: entry.title,
          html: entry.html,
          template: entry.template,
          state: entry.state,
          owner: entry.owner,
        };
      }
      this.bump();
      this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
      for (const cb of this.undoListeners) {
        try {
          cb();
        } catch (err) {
          console.warn("[workspace] undo listener failed:", (err as Error).message);
        }
      }
      return merged ? { ok: true, say: merged.say, label: entry.label } : { ok: true, say: `Restored ${entry.label}.`, label: entry.label };
    }
    return { ok: false, say: skipped ? "There's nothing left to bring back." : "There's nothing to bring back — the undo stack is empty." };
  }

  /** Subscribe a window; it receives the full snapshot immediately. */
  subscribe(send: Send): () => void {
    this.subs.add(send);
    this.safeSend(send, { type: "snapshot", snapshot: this.snapshot() });
    // The secure forms waiting for the user, replayed after the snapshot (a window that reconnects keeps the ones it gets again).
    for (const form of this.forms.values()) this.safeSend(send, { type: "form", form });
    return () => this.subs.delete(send);
  }

  /** A secure form for every window to draw (descriptor only — see SecureForm). */
  openForm(form: SecureForm): void {
    this.forms.set(form.id, form);
    this.broadcast({ type: "form", form });
  }

  /** That form is over (submitted, approved, cancelled or lapsed): windows take it down. */
  closeForm(id: string, status: SecureFormEnd): void {
    if (!this.forms.delete(id)) return;
    this.broadcast({ type: "form_closed", id, status });
  }

  /** A command for one card, to every open window (the first answer wins — see card-commands.ts). */
  command(cmd: CardCommand): void {
    this.broadcast({ type: "command", cmd });
  }

  /** Board events from the windows (command answers, hand-made layouts). Returns an unsubscribe. */
  onBoardEvent(cb: (evt: Record<string, unknown>) => void): () => void {
    this.boardListeners.add(cb);
    return () => this.boardListeners.delete(cb);
  }

  /** Settings → Workspace window → Overlays: every open window follows at once. */
  setOverlays(overlays: WorkspaceOverlays): void {
    if (this.snap.overlays === overlays) return;
    this.snap = { ...this.snap, overlays };
    this.broadcast({ type: "overlays", overlays });
  }

  /** How many windows are watching (the standalone workspace window, the main app's pane). */
  get subscribers(): number {
    return this.subs.size;
  }

  /** Freeform UI (a BUILD): replace the workspace with an HTML fragment. */
  showHtml(html: string, title: string, owner: string | null = null): void {
    // A page nobody owns (a skill's output, the test route) is one more card on the board, not the whole window: only
    // an owner that really has the window (a game and its error screen) replaces what is on it.
    if (owner === null && this.htmlAdopter) {
      try {
        if (this.htmlAdopter(html, title)) return;
      } catch (err) {
        console.warn("[workspace] could not add that page as a card:", (err as Error).message);
        this.toast((err as Error).message.slice(0, 200), "warn");
        return;
      }
    }
    this.cancelPendingState();
    this.snap = { ...this.snap, mode: "html", html, title, template: null, state: null, owner };
    this.noteWrite();
    const version = this.bump();
    this.broadcast({ type: "html", version, title, html });
  }

  /** Structured app: a template rendering `state`. Data updates later via setState. */
  showApp(template: WorkspaceTemplate, state: unknown, title: string, owner: string | null = null): void {
    this.cancelPendingState();
    this.snap = { ...this.snap, mode: "app", template, state, title, html: null, owner };
    this.noteWrite();
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
    this.noteWrite();
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
    this.pushUndo("clear", 1);
    this.cancelPendingState();
    this.snap = { ...this.snap, mode: "empty", html: null, template: null, state: null, owner: null, title: "Workspace" };
    this.noteWrite();
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
    if (evt.type === "board") {
      const e = evt.evt;
      if (!e || typeof e !== "object" || Array.isArray(e)) return;
      for (const cb of this.boardListeners) {
        try {
          cb(e);
        } catch (err) {
          console.warn("[workspace] board listener failed:", (err as Error).message);
        }
      }
      return;
    }
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
    if (this.saveTimer || this.saving || !this.unsaved) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DELAY_MS);
  }

  /**
   * Write the latest screen to disk without making the engine wait for the disk: a board can be several megabytes,
   * and a voice call must not stall on it. One write at a time; a change made meanwhile is written right after.
   */
  private async saveNow(): Promise<void> {
    const snap = this.unsaved;
    if (!snap || this.saving || !this.persistPath) return;
    this.unsaved = null;
    this.saving = true;
    const file = this.persistPath;
    const tmp = `${file}.tmp`;
    try {
      const { activities: _a, ...rest } = snap;
      const json = JSON.stringify(rest);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, json);
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.promises.rename(tmp, file);
          break;
        } catch (err) {
          // Windows can hold the file for a moment (a scanner, an indexer): tried again shortly.
          const code = (err as NodeJS.ErrnoException).code;
          if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    } catch (err) {
      console.warn("[workspace] could not persist snapshot:", (err as Error).message);
    } finally {
      this.saving = false;
      if (this.unsaved) this.scheduleSave();
    }
  }

  /**
   * Put the screen on disk NOW, synchronously — for when the process is about to go (exit, Ctrl+C, a stop signal), so
   * the last changes are not lost with the timer that would have written them. Does nothing when everything is saved.
   */
  flushSave(): void {
    if (!this.persistPath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // Something is not on disk yet: a change waiting for the timer, a state not yet pushed to the windows (it is
    // saved when it is pushed), or a write under way (which never finishes once the process goes). What is written is
    // the screen as it is NOW — never a build preview: the screen it covers is what stays on disk.
    if (!this.unsaved && !this.stateDirty && !this.saving) return;
    const snap = isBuildPreview(this.snap) ? this.unsaved : { ...this.snap };
    this.unsaved = null;
    if (!snap) return;
    try {
      // (A data folder that has been taken away — a test's throwaway one — is not made again on the way out.)
      if (!fs.existsSync(path.dirname(this.persistPath))) return;
      const tmp = `${this.persistPath}.exit.tmp`;
      const { activities: _a, ...rest } = snap;
      fs.writeFileSync(tmp, JSON.stringify(rest));
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      console.warn("[workspace] could not persist snapshot on the way out:", (err as Error).message);
    }
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
          overlays: "all", // the setting is applied at boot (index.ts), not kept with the screen
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

// The engine runs under `tsx watch` and is restarted on every save of a source file; whatever was changed in the last
// moments before it goes is written first. (A restart that kills the process outright — as on Windows — can't be
// caught; then at most SAVE_DELAY_MS of changes are lost, and the board settles what was mid-flight at the next boot.)
process.on("exit", () => workspace.flushSave());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  try {
    process.on(signal, () => {
      workspace.flushSave();
      // With no other listener the process would have gone down on this signal: it still does.
      if (process.listenerCount(signal) <= 1) process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    });
  } catch {
    /* a signal this platform doesn't have */
  }
}
