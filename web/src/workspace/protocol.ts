// Browser mirror of server/src/workspace/bus.ts — the /ws/workspace protocol.

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

/** A command for one card on the board; the board answers through a "board" client event. */
export interface CardCommand {
  id: string;
  n: number;
  op: string;
  arg: unknown;
}

export interface WorkspaceSnapshot {
  /** Changes on every engine boot — reset version tracking when it does. */
  epoch: string;
  version: number;
  mode: WorkspaceMode;
  title: string;
  html: string | null;
  template: WorkspaceTemplate | null;
  state: unknown | null;
  /** Who owns the current app (e.g. "game:<id>"). */
  owner: string | null;
  activities: WorkspaceActivity[];
  /** Settings → Workspace window → Overlays (older engines leave it out: everything). */
  overlays?: WorkspaceOverlays;
  updatedAt: number;
}

export type ToastTone = "info" | "success" | "warn" | "error";

export type AgentKind = "decision" | "tool" | "tool_result" | "reply";

/** One input of a secure form (mirror of FormField in server/src/vault/index.ts). */
export interface FormField {
  name: string;
  label: string;
  type: "text" | "password" | "email" | "tel" | "card-number" | "expiry" | "cvc" | "otp-secret" | "checkbox";
  required?: boolean;
  placeholder?: string;
  /** What the field holds ("username", "cc-number", …) — a description; the window decides what the browser is told. */
  autocomplete?: string;
  /** Already filled in — only ever for fields that aren't secret (a site's name). */
  value?: string;
}

/**
 * A secure form for this window to draw in its own page, over the board (mirror of FormRequest in
 * server/src/vault/index.ts). It is a descriptor: no value ever arrives this way, and what is typed goes straight to
 * POST /api/vault/forms/<id> on this page's own origin — never back over the socket, never into a frame.
 */
export interface FormRequest {
  id: string;
  purpose: "save-login" | "save-card" | "save-identity" | "save-secret" | "one-time" | "confirm" | "unlock";
  title: string;
  detail: string;
  host?: string;
  fields: FormField[];
  submitLabel: string;
  expiresAt: number;
  card?: number;
}

export type FormEnd = "submitted" | "approved" | "cancelled" | "expired";

/** Server → window. */
export type WorkspaceEvent =
  | { type: "snapshot"; snapshot: WorkspaceSnapshot }
  | { type: "form"; form: FormRequest }
  | { type: "form_closed"; id: string; status: FormEnd }
  | { type: "state"; version: number; state: unknown; title: string }
  | { type: "template"; version: number; template: WorkspaceTemplate; state: unknown; title?: string }
  | { type: "html"; version: number; title: string; html: string }
  | { type: "toast"; text: string; tone: ToastTone }
  | { type: "activity"; id: string; text: string; busy: boolean }
  | { type: "overlays"; overlays: WorkspaceOverlays }
  | { type: "command"; cmd: CardCommand }
  | {
      type: "agent";
      kind: AgentKind;
      at: number;
      tool?: string;
      text?: string;
      ok?: boolean;
      confidence?: number;
      args?: Record<string, unknown>;
    };

/** Window → server. */
export type WorkspaceClientEvent =
  | { type: "hello" }
  | { type: "render_error"; templateId: string; message: string }
  | { type: "board"; evt: Record<string, unknown> };

/** Messages between the host page and the sandboxed template iframe. */
export type FrameToHost =
  | { type: "ready" }
  | { type: "render_error"; message: string }
  | { type: "ui_event"; evt: unknown };
/**
 * Host → frame. "asset" delivers an engine image's bytes: sandboxed (opaque-origin) frames
 * can't load http://localhost images themselves (Chromium's local-network protections), so
 * the host fetches them and the frame shows them from its own blob: URLs.
 */
export type HostToFrame = { type: "state"; state: unknown } | { type: "asset"; url: string; blob: Blob | null } | { type: "command"; cmd: CardCommand };

/** Cross-tab coordination on BroadcastChannel("trinity"). */
export type TrinityBroadcast =
  | { type: "workspace-window"; open: boolean }
  | { type: "workspace-dock" }
  | { type: "workspace-focus" }
  | { type: "settings-changed"; what: "personas" | "voices" | "endpoints" | "games" | "heartbeat" | "skills" | "memory" };
