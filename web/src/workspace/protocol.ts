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
  updatedAt: number;
}

export type ToastTone = "info" | "success" | "warn" | "error";

export type AgentKind = "decision" | "tool" | "tool_result" | "reply";

/** Server → window. */
export type WorkspaceEvent =
  | { type: "snapshot"; snapshot: WorkspaceSnapshot }
  | { type: "state"; version: number; state: unknown; title: string }
  | { type: "template"; version: number; template: WorkspaceTemplate; state: unknown; title?: string }
  | { type: "html"; version: number; title: string; html: string }
  | { type: "toast"; text: string; tone: ToastTone }
  | { type: "activity"; id: string; text: string; busy: boolean }
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
  | { type: "render_error"; templateId: string; message: string };

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
export type HostToFrame = { type: "state"; state: unknown } | { type: "asset"; url: string; blob: Blob | null };

/** Cross-tab coordination on BroadcastChannel("trinity"). */
export type TrinityBroadcast =
  | { type: "workspace-window"; open: boolean }
  | { type: "workspace-dock" }
  | { type: "workspace-focus" }
  | { type: "settings-changed"; what: "personas" | "voices" | "endpoints" | "games" | "heartbeat" | "skills" | "memory" };
