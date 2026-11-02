// Cross-tab coordination on BroadcastChannel("trinity"): tell the main app what
// changed, and track whether the standalone workspace window is open.

import type { TrinityBroadcast } from "../workspace/protocol.js";

/**
 * What changed. "memory" (memories and the user's profile) only matters to other settings
 * tabs — the main app treats every settings-changed message the same way.
 */
export type SettingsTopic = Extract<TrinityBroadcast, { type: "settings-changed" }>["what"];

const channel: BroadcastChannel | null = typeof BroadcastChannel === "function" ? new BroadcastChannel("trinity") : null;
const listeners = new Set<(msg: TrinityBroadcast) => void>();
let workspaceSeenAt = 0;
let workspaceOpen = false;
let goodbyeAt = 0;

// The workspace window also holds this Web Lock while it's open (workspace/window.ts). Its
// heartbeat goes quiet for up to a minute while that window is hidden (throttled timers); the
// lock doesn't. Checked in the background so isWorkspaceWindowOpen() can answer at once —
// window.open() has to run inside the click.
const WINDOW_LOCK = "trinity-workspace-window";
let workspaceLocked = false;

async function checkWorkspaceLock(): Promise<void> {
  try {
    const { held = [] } = await navigator.locks.query();
    // A window that just said goodbye may hold the lock a moment longer while it closes.
    workspaceLocked = held.some((l) => l.name === WINDOW_LOCK) && Date.now() - goodbyeAt > 1000;
  } catch {
    workspaceLocked = false;
  }
}
if ("locks" in navigator) {
  void checkWorkspaceLock();
  window.setInterval(() => void checkWorkspaceLock(), 2000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void checkWorkspaceLock();
  });
}

channel?.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as TrinityBroadcast | null;
  if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return;
  if (msg.type === "workspace-window") {
    workspaceOpen = msg.open;
    workspaceSeenAt = msg.open ? Date.now() : 0;
    if (!msg.open) {
      goodbyeAt = Date.now();
      workspaceLocked = false;
    }
  }
  for (const fn of [...listeners]) fn(msg);
});

function post(msg: TrinityBroadcast): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel closed — nothing to tell */
  }
}

/** Let the main app (and other settings tabs) know something changed. */
export function announce(what: SettingsTopic): void {
  post({ type: "settings-changed", what });
}

export function onBroadcast(fn: (msg: TrinityBroadcast) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Open if the workspace window holds its lock, or (no Web Locks) heartbeated recently — every 2s. */
export function isWorkspaceWindowOpen(): boolean {
  return workspaceLocked || (workspaceOpen && Date.now() - workspaceSeenAt < 5000);
}

/** Bring the workspace window forward, opening it if it isn't running. Call inside a click. */
export function showWorkspaceWindow(): void {
  if (isWorkspaceWindowOpen()) {
    post({ type: "workspace-focus" }); // it glows
    // A window can't raise itself without a click of its own, but a handle taken inside OUR click
    // can. An empty URL doesn't navigate an existing window; if none is in reach, a blank one
    // opens instead — close it (the glow still shows).
    try {
      const w = window.open("", "trinity-workspace");
      if (w && w.location.href === "about:blank") w.close();
      else w?.focus();
    } catch {
      /* blocked — the glow is all we can do */
    }
    return;
  }
  const w = window.open("/workspace.html", "trinity-workspace", "popup,width=1280,height=860");
  w?.focus();
}
