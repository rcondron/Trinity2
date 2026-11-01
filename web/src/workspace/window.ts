/**
 * The standalone workspace window (web/workspace.html).
 *
 * Opened by the main app with
 *   window.open("/workspace.html", "trinity-workspace", "popup,width=1280,height=860")
 * it mounts the live workspace full-viewport with chrome, keeps document.title in step with
 * the workspace title, and announces itself on BroadcastChannel("trinity") so the main app
 * can collapse its embedded pane while this window is open:
 *   → {type:"workspace-window", open:true}   on load and every 2s
 *   → {type:"workspace-window", open:false}  on pagehide / beforeunload / dock
 *   ← {type:"workspace-dock"}                → close this window
 *   ← {type:"workspace-focus"}               → focus this window
 * While it shows the workspace it also holds the Web Lock "trinity-workspace-window" (shared),
 * which the main app and Settings check: unlike the heartbeat it can't go quiet when this
 * window is hidden and its timers are throttled, and the browser drops it if the window crashes.
 * Keys: F toggles focus mode (hides the bar), Esc leaves it.
 */
import { mountWorkspace, type WorkspaceHandle } from "./view.js";
import type { TrinityBroadcast } from "./protocol.js";

const PAGE_TITLE = "Trinity — Workspace";
const HEARTBEAT_MS = 2000;

function pageTitle(title: string): string {
  const t = title.trim();
  return !t || t === "Workspace" ? PAGE_TITLE : `${t} — Trinity`;
}

const mountPoint =
  document.getElementById("workspace-root") ?? document.body.appendChild(document.createElement("div"));
document.title = PAGE_TITLE;

const view: WorkspaceHandle = mountWorkspace(mountPoint, {
  chrome: true,
  onTitle: (title) => {
    document.title = pageTitle(title);
  },
});

// Diagnostics handle (e.g. `__trinityWorkspace.stats()` in devtools).
(window as unknown as { __trinityWorkspace?: WorkspaceHandle }).__trinityWorkspace = view;

// ─── Presence on BroadcastChannel("trinity") ─────────────────────────────────

const channel: BroadcastChannel | null = typeof BroadcastChannel === "function" ? new BroadcastChannel("trinity") : null;
let announcing = true;

function broadcast(msg: TrinityBroadcast): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel closed */
  }
}

function announce(): void {
  if (announcing) broadcast({ type: "workspace-window", open: true });
}

function goodbye(): void {
  broadcast({ type: "workspace-window", open: false });
}

const PRESENCE_LOCK = "trinity-workspace-window";
let presence: AbortController | null = null;

/** Hold the presence lock until dropPresence() (or until this window goes away). */
function holdPresence(): void {
  if (presence || !("locks" in navigator)) return;
  const hold = new AbortController();
  presence = hold;
  navigator.locks
    .request(PRESENCE_LOCK, { mode: "shared", signal: hold.signal }, () =>
      new Promise<void>((release) => {
        if (hold.signal.aborted) release();
        else hold.signal.addEventListener("abort", () => release(), { once: true });
      }),
    )
    .catch(() => {
      /* dropped before it was granted, or no lock here — the heartbeat still tells */
    });
}

function dropPresence(): void {
  presence?.abort();
  presence = null;
}

announce();
holdPresence();
window.setInterval(announce, HEARTBEAT_MS);
window.addEventListener("pagehide", () => {
  goodbye();
  dropPresence();
});
window.addEventListener("beforeunload", goodbye);
window.addEventListener("pageshow", (e) => {
  // Restored from the back/forward cache: say hello again straight away.
  if (e.persisted && announcing) {
    announce();
    holdPresence();
  }
});

channel?.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as TrinityBroadcast | null;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "workspace-dock") {
    dock();
  } else if (msg.type === "workspace-focus") {
    try {
      window.focus();
    } catch {
      /* the browser may refuse; the glow still shows where to look */
    }
    view.attention();
  }
});

function dock(): void {
  announcing = false;
  goodbye();
  dropPresence();
  window.close();
  // Scripts may only close windows they opened; if this one was opened by hand, say so.
  window.setTimeout(() => {
    if (!window.closed) showDockedCard();
  }, 300);
}

function showDockedCard(): void {
  if (document.querySelector(".tw-docked")) return;
  const wrap = document.createElement("div");
  wrap.className = "tw-docked";
  const card = document.createElement("div");
  card.className = "tw-docked-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "twDockedTitle");
  const orb = document.createElement("span");
  orb.className = "tw-docked-orb";
  orb.setAttribute("aria-hidden", "true");
  const heading = document.createElement("h2");
  heading.id = "twDockedTitle";
  heading.textContent = "Docked in the main window";
  const text = document.createElement("p");
  text.textContent = "The workspace is back in Trinity’s main window. You can close this tab.";
  const actions = document.createElement("div");
  actions.className = "tw-docked-actions";
  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "tw-docked-keep";
  keep.textContent = "Keep it here";
  keep.addEventListener("click", () => {
    wrap.remove();
    announcing = true;
    announce();
    holdPresence();
  });
  actions.append(keep);
  card.append(orb, heading, text, actions);
  wrap.append(card);
  document.body.append(wrap);
  keep.focus();
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    view.focusMode();
  } else if (e.key === "Escape") {
    view.focusMode(false);
  }
});
