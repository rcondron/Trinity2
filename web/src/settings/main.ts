// Trinity settings page: shell, hash router (#personas, #models, #voices,
// #skills, #memory, #heartbeat, #games — with an optional "/<sub>" such as a
// persona id), sidebar badges, the active-persona footer, unsaved-changes
// guards, and cross-tab refresh.

import "./settings.css";
import { onBroadcast, type SettingsTopic } from "./channel.js";
import { createGamesSection } from "./games.js";
import { createHeartbeatSection } from "./heartbeat.js";
import { isIconName, svgIcon } from "./icons.js";
import { createMemorySection } from "./memory.js";
import { createModelsSection, missingRequiredKeys } from "./models.js";
import { createPersonasSection } from "./personas.js";
import { createSkillsSection } from "./skills.js";
import {
  endpointsRes,
  gamesRes,
  heartbeatRes,
  personasRes,
  profileRes,
  skillsRes,
  statusRes,
  toolsetsRes,
  voicesRes,
} from "./store.js";
import { avatar, confirmAction, h, icon, setChildren, type Section } from "./ui.js";
import { createVoicesSection } from "./voices.js";

type SectionId = "personas" | "models" | "voices" | "skills" | "memory" | "heartbeat" | "games";

// Nav order. Saved games is last: only the Game Master persona uses it.
const SECTIONS: Record<SectionId, { title: string; create: () => Section }> = {
  personas: { title: "Personas", create: createPersonasSection },
  models: { title: "Models & API keys", create: createModelsSection },
  voices: { title: "Voices", create: createVoicesSection },
  skills: { title: "Skills", create: createSkillsSection },
  memory: { title: "Memory", create: createMemorySection },
  heartbeat: { title: "Heartbeat", create: createHeartbeatSection },
  games: { title: "Saved games", create: createGamesSection },
};
const ORDER = Object.keys(SECTIONS) as SectionId[];
const DEFAULT_SECTION: SectionId = "personas";

const content = document.getElementById("content") as HTMLElement;
const sidebarFoot = document.getElementById("sidebarFoot") as HTMLElement;
const created = new Map<SectionId, Section>();
let current: SectionId | null = null;
let firstRoute = true;
let suppressUnloadPrompt = false;

// ─── Static icons in the HTML shell ──────────────────────────────────────────

for (const el of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  const name = el.dataset.icon ?? "";
  if (isIconName(name)) el.innerHTML = svgIcon(name);
}

// ─── Router ──────────────────────────────────────────────────────────────────

function parseHash(): { id: SectionId; sub: string | null; valid: boolean } {
  let raw = location.hash.replace(/^#\/?/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep the raw text */
  }
  const [head = "", ...rest] = raw.split("/");
  const known = (ORDER as string[]).includes(head);
  return { id: known ? (head as SectionId) : DEFAULT_SECTION, sub: rest.length ? rest.join("/") || null : null, valid: known };
}

function updateNav(id: SectionId): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
    const on = a.dataset.section === id;
    if (on) {
      a.setAttribute("aria-current", "page");
      // Keep the active tab visible in the narrow-screen tab bar.
      if (window.matchMedia("(max-width: 760px)").matches) a.scrollIntoView({ inline: "center", block: "nearest" });
    } else a.removeAttribute("aria-current");
  }
}

function route(): void {
  const { id, sub, valid } = parseHash();
  if (!valid) history.replaceState(null, "", `#${id}`);
  let section = created.get(id);
  if (!section) {
    section = SECTIONS[id].create();
    section.el.hidden = true;
    created.set(id, section);
    content.append(section.el);
  }
  if (current !== id) {
    const prev = current ? created.get(current) : undefined;
    prev?.hide?.();
    if (prev) prev.el.hidden = true;
    section.el.hidden = false;
    current = id;
    updateNav(id);
    document.title = `${SECTIONS[id].title} · Settings — Trinity`;
    if (!firstRoute) {
      window.scrollTo({ top: 0 });
      section.el.querySelector<HTMLElement>(".sec-head h1")?.focus({ preventScroll: true });
    }
  }
  firstRoute = false;
  section.show(sub);
}

window.addEventListener("hashchange", route);

// ─── Sidebar badges ──────────────────────────────────────────────────────────

function setBadge(id: SectionId, text: string, tone: "default" | "accent" | "warn" = "default", title = ""): void {
  const b = document.querySelector<HTMLElement>(`[data-badge="${id}"]`);
  if (!b) return;
  b.textContent = text;
  b.title = title;
  b.classList.toggle("is-accent", tone === "accent");
  b.classList.toggle("is-warn", tone === "warn");
}

personasRes.subscribe((list) => setBadge("personas", String(list.length)));
endpointsRes.subscribe((ep) => {
  // Drawn as a dot; the text is for screen readers, the title for the tooltip.
  const missing = missingRequiredKeys(ep);
  setBadge("models", missing.length ? "Keys missing" : "", "warn", missing.length ? `Missing: ${missing.join(", ")}` : "");
});
voicesRes.subscribe((lib) => setBadge("voices", lib.customAvailable && lib.custom.length ? String(lib.custom.length) : ""));
gamesRes.subscribe((g) => setBadge("games", g.available && g.games.length ? String(g.games.length) : ""));
heartbeatRes.subscribe((tasks) => {
  // Upcoming reminders and running recurring tasks (finished reminders stay listed but are off).
  const on = tasks.filter((t) => t.enabled).length;
  setBadge("heartbeat", on ? `${on} on` : "");
});
skillsRes.subscribe((s) =>
  setBadge("skills", s.pending.length ? `${s.pending.length} new` : "", "accent", s.pending.length ? "Waiting for your approval" : ""),
);

// ─── Sidebar footer: active persona + engine state ───────────────────────────

let engineDown = false;

function renderFoot(): void {
  const s = statusRes.peek();
  if (engineDown) {
    setChildren(
      sidebarFoot,
      h(
        "div",
        { class: "engine-state is-down" },
        h("span", { class: "engine-dot" }),
        h("span", null, "Engine offline"),
        h(
          "button",
          {
            class: "link-btn",
            type: "button",
            onclick: () => {
              void statusRes.refresh().catch(() => {});
            },
          },
          "Retry",
        ),
      ),
    );
    return;
  }
  if (!s) {
    setChildren(sidebarFoot, h("div", { class: "skeleton", style: "height:52px;border-radius:12px" }));
    return;
  }
  const p = s.persona;
  const states = Object.values(s.services);
  const live = states.filter((v) => v === "live").length;
  setChildren(
    sidebarFoot,
    h(
      "a",
      { class: "active-card", href: `#personas/${encodeURIComponent(p.id)}`, title: "Edit the active persona" },
      avatar(p.name, p.id, "sm"),
      h("span", { class: "active-text" }, h("span", { class: "active-label" }, "Active persona"), h("span", { class: "active-name" }, p.name)),
      icon("chevronRight", "active-chev"),
    ),
    h(
      "a",
      { class: "engine-state is-up", href: "#models", title: "See service status" },
      h("span", { class: "engine-dot" }),
      h("span", null, "Engine connected"),
      h("span", { class: "engine-sub" }, `${live}/${states.length} live`),
    ),
  );
}

statusRes.subscribe(() => {
  engineDown = false;
  renderFoot();
});

function loadStatus(): void {
  statusRes.get().catch(() => {
    engineDown = true;
    renderFoot();
  });
}

// ─── Leaving the page ────────────────────────────────────────────────────────

function anyDirty(): boolean {
  for (const s of created.values()) if (s.isDirty?.()) return true;
  return false;
}

window.addEventListener("beforeunload", (e) => {
  if (suppressUnloadPrompt || !anyDirty()) return;
  e.preventDefault();
  e.returnValue = "";
});

function sameOriginOpener(): Window | null {
  try {
    const o = window.opener as Window | null;
    if (o && !o.closed && o.location.origin === location.origin) return o;
  } catch {
    /* cross-origin opener */
  }
  return null;
}

/**
 * "Back to Trinity": when this tab was opened from the main app, return to that
 * tab instead of loading a second copy of the app (which would compete for the
 * single GPU voice session). Otherwise it's a normal link to "/".
 */
for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-back]")) {
  a.addEventListener("click", async (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const opener = sameOriginOpener();
    if (!opener) return;
    e.preventDefault();
    if (anyDirty()) {
      const ok = await confirmAction({
        title: "Leave without saving?",
        message: "You have unsaved changes on this page. They'll be lost if you go back now.",
        confirmLabel: "Leave anyway",
        cancelLabel: "Stay",
        danger: true,
      });
      if (!ok) return;
    }
    suppressUnloadPrompt = true;
    try {
      opener.focus();
    } catch {
      /* ignore */
    }
    window.close();
    // If the browser refused to close this tab, just navigate.
    window.setTimeout(() => {
      if (!window.closed) location.href = "/";
    }, 250);
  });
}

// ─── Refresh when coming back to the tab / when other tabs change things ─────

let lastRefresh = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 4000) return;
  lastRefresh = Date.now();
  void statusRes.refresh().catch(() => {});
  if (current) created.get(current)?.refresh?.();
});

onBroadcast((msg) => {
  if (msg.type !== "settings-changed") return;
  const quietly = (p: Promise<unknown>) => void p.catch(() => {});
  switch (msg.what as SettingsTopic) {
    case "personas":
      quietly(personasRes.refresh());
      quietly(statusRes.refresh());
      break;
    case "voices":
      quietly(voicesRes.refresh());
      break;
    case "endpoints":
      quietly(endpointsRes.refresh());
      quietly(statusRes.refresh());
      break;
    case "games":
      quietly(gamesRes.refresh());
      break;
    case "heartbeat":
      quietly(heartbeatRes.refresh());
      break;
    case "skills":
      quietly(skillsRes.refresh());
      break;
    case "memory":
      quietly(profileRes.refresh());
      created.get("memory")?.refresh?.();
      break;
  }
});

// ─── Go ──────────────────────────────────────────────────────────────────────

renderFoot();
loadStatus();
route();
// Warm the caches behind the sidebar badges (each section also loads its own).
for (const r of [personasRes, endpointsRes, voicesRes, toolsetsRes, gamesRes, heartbeatRes, skillsRes] as const) {
  void (r.get() as Promise<unknown>).catch(() => {});
}
document.body.classList.add("is-ready");
