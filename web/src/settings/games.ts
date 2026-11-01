// Saved games: every adventure the Game Master has run. Open one to put it back
// on the workspace screen, peek at its party and scene, or delete it.

import { api, type GameSummary, type GameView } from "./api.js";
import { announce, showWorkspaceWindow } from "./channel.js";
import { gamesRes, personasRes } from "./store.js";
import {
  badge,
  button,
  confirmAction,
  emptyState,
  errorState,
  h,
  hashHue,
  icon,
  initials,
  plural,
  relTime,
  sectionHead,
  setChildren,
  skeletonBlock,
  skeletonLines,
  toast,
  withBusy,
  type Section,
} from "./ui.js";

const GENRE_GLYPHS: [RegExp, string][] = [
  [/cyber|punk|neon/i, "◈"],
  [/sci|space|star|galac|future/i, "✦"],
  [/horror|dread|gothic|vampire|zombie/i, "☾"],
  [/myster|noir|detective/i, "◎"],
  [/pirate|sea|naval/i, "⚓"],
  [/western|frontier/i, "★"],
  [/apocal|wasteland|nuclear/i, "☢"],
  [/fantasy|dragon|sword|dungeon|medieval|myth/i, "⚔"],
];

function glyphFor(genre: string): string {
  return GENRE_GLYPHS.find(([re]) => re.test(genre))?.[1] ?? "✧";
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function createGamesSection(): Section {
  const listEl = h("div", { class: "games-body" });
  const details = new Map<string, GameView | "loading" | "error">();
  const expanded = new Set<string>();
  let data: { available: boolean; games: GameSummary[] } | null = null;
  let loadFailed: string | null = null;

  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-games" },
    sectionHead({
      id: "sec-games",
      title: "Saved games",
      lede: "Every adventure the Game Master runs is saved — party, scenes, loot, and art. Open one to put it back on the workspace screen.",
      actions: button("Open workspace window", { icon: "monitor", onclick: () => showWorkspaceWindow() }),
    }),
    listEl,
  );

  function personaName(id: string): string {
    const p = personasRes.peek()?.find((x) => x.id === id);
    return p ? (p.name.split(/\s+[—–-]\s+/)[0] ?? p.name) : "";
  }

  // ── Details (GameView) — fetched lazily, a few at a time ──

  let queue: string[] = [];
  let inflight = 0;
  function want(id: string): void {
    if (details.has(id) || queue.includes(id)) return;
    queue.push(id);
    pump();
  }
  function pump(): void {
    while (inflight < 3 && queue.length) {
      const id = queue.shift()!;
      details.set(id, "loading");
      inflight++;
      api.games
        .get(id, { quiet: true })
        .then((v) => details.set(id, v))
        .catch(() => details.set(id, "error"))
        .finally(() => {
          inflight--;
          rerenderCard(id);
          pump();
        });
    }
  }

  // ── Cards ──

  function banner(g: GameSummary, view: GameView | null): HTMLElement {
    const art = view?.titleImage?.status === "ready" && view.titleImage.url ? view.titleImage.url : null;
    const glyph = h("span", { class: "game-glyph", "aria-hidden": "true" }, glyphFor(g.genre || view?.genre || ""));
    const b = h(
      "div",
      { class: ["game-banner", art ? "has-art" : ""], style: `--h:${hashHue(g.id)}` },
      art ? h("img", { src: art, alt: "", loading: "lazy", decoding: "async" }) : glyph,
      h(
        "div",
        { class: "game-banner-badges" },
        g.active ? badge("Active", "ok", "dot") : null,
        badge(g.phase === "playing" ? "Playing" : g.phase === "setup" ? "Setting up" : cap(g.phase), g.phase === "playing" ? "accent" : "default"),
      ),
    );
    return b;
  }

  function party(view: GameView): HTMLElement | null {
    const players = (view.players ?? []).filter((p) => !p.pending);
    if (!players.length) return null;
    return h(
      "div",
      { class: "game-party" },
      players.slice(0, 6).map((p) => {
        const url = p.portrait?.status === "ready" ? p.portrait.url : null;
        const hp = p.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 1;
        return h(
          "div",
          { class: "hero", title: `${p.name} — ${[p.race, p.className].filter(Boolean).join(" ")}, level ${p.level} · ${p.hp}/${p.maxHp} HP` },
          url
            ? h("img", { class: "hero-img", src: url, alt: "", loading: "lazy" })
            : h("span", { class: "hero-img hero-initials", style: `--h:${hashHue(p.id || p.name)}` }, initials(p.name)),
          h(
            "span",
            { class: "hero-text" },
            h("span", { class: "hero-name" }, p.name),
            h("span", { class: "hero-class" }, [cap(p.race), cap(p.className)].filter(Boolean).join(" ") || "Adventurer"),
            h("span", { class: "hero-hp", "aria-label": `${p.hp} of ${p.maxHp} hit points` }, h("span", { style: `width:${Math.round(hp * 100)}%`, class: hp < 0.34 ? "is-low" : hp < 0.67 ? "is-mid" : "" })),
          ),
        );
      }),
      players.length > 6 ? h("span", { class: "hero-more" }, `+${players.length - 6}`) : null,
    );
  }

  function detailPanel(g: GameSummary, view: GameView | "loading" | "error" | undefined): HTMLElement {
    if (view === "loading" || view === undefined) return h("div", { class: "game-details" }, skeletonLines(3));
    if (view === "error") return h("div", { class: "game-details" }, h("p", { class: "muted" }, "Couldn't load this game's details."));
    const stats: [string, number | string][] = [
      ["Round", view.round || "–"],
      ["NPCs", view.npcs?.length ?? 0],
      ["Items", view.items?.length ?? 0],
      ["Places", view.locations?.length ?? 0],
      ["Log", view.log?.length ?? 0],
    ];
    return h(
      "div",
      { class: "game-details" },
      view.setting ? h("p", { class: "game-setting" }, view.setting) : null,
      view.scene
        ? h(
            "div",
            { class: "game-scene" },
            h("div", { class: "mini-title" }, icon("map"), "Current scene"),
            h("div", { class: "game-scene-title" }, view.scene.title || "Untitled scene"),
            view.scene.description ? h("p", { class: "game-scene-text" }, view.scene.description) : null,
          )
        : null,
      view.phase === "setup" && view.setup?.next
        ? h("div", { class: "notice notice-info notice-compact" }, icon("info"), h("span", null, h("strong", null, "Next in setup: "), view.setup.next))
        : null,
      h(
        "dl",
        { class: "game-stats" },
        stats.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, String(v)))),
      ),
      g.genre || view.tone ? h("div", { class: "game-tags" }, [view.genre || g.genre, view.tone].filter(Boolean).map((t) => h("span", { class: "chip" }, t))) : null,
    );
  }

  function gameCard(g: GameSummary): HTMLElement {
    const d = details.get(g.id);
    const view = d && typeof d === "object" ? d : null;
    const isOpen = expanded.has(g.id);
    const persona = personaName(g.personaId);
    const playerCount = view ? (view.players ?? []).filter((p) => !p.pending).length : g.players;
    const metaBits = [g.genre ? cap(g.genre) : null, plural(playerCount, "player"), persona || null].filter(Boolean) as string[];

    const openBtn = button("Open in workspace", { icon: "monitor", variant: "primary", size: "sm" });
    openBtn.addEventListener("click", () => void openGame(g, openBtn));
    const toggle = button(isOpen ? "Hide details" : "Details", { icon: isOpen ? "chevronDown" : "chevronRight", size: "sm", variant: "ghost" });
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.addEventListener("click", () => {
      if (expanded.has(g.id)) expanded.delete(g.id);
      else {
        expanded.add(g.id);
        want(g.id);
      }
      rerenderCard(g.id);
    });
    const del = button(null, { icon: "trash", size: "sm", variant: "danger", title: "Delete game" });
    del.addEventListener("click", () => void deleteGame(g));

    return h(
      "article",
      { class: ["card", "game-card", g.active && "is-active"], dataset: { game: g.id } },
      banner(g, view),
      h(
        "div",
        { class: "game-body" },
        h("h2", { class: "game-title" }, g.title),
        h("div", { class: "game-meta" }, metaBits.flatMap((m, i) => (i ? [h("span", { class: "meta-sep" }, "·"), m] : [m]))),
        view ? party(view) : null,
        h("div", { class: "game-updated" }, icon("clock"), `Updated ${relTime(g.updatedAt)}`),
        isOpen ? detailPanel(g, d) : null,
      ),
      h("div", { class: "game-actions" }, openBtn, toggle, h("span", { class: "spacer" }), del),
    );
  }

  function rerenderCard(id: string): void {
    const g = data?.games.find((x) => x.id === id);
    const old = listEl.querySelector<HTMLElement>(`[data-game="${CSS.escape(id)}"]`);
    if (!g || !old) return;
    old.replaceWith(gameCard(g));
  }

  function render(): void {
    if (loadFailed) {
      setChildren(listEl, errorState(loadFailed, () => void load(true)));
      return;
    }
    if (!data) {
      setChildren(
        listEl,
        h("div", { class: "games-grid" }, Array.from({ length: 3 }, () => h("div", { class: "card game-card" }, skeletonBlock(96), h("div", { class: "game-body" }, skeletonLines(3))))),
      );
      return;
    }
    if (!data.available) {
      setChildren(
        listEl,
        emptyState({
          icon: "dice",
          tone: "soon",
          title: "Saved games aren't available yet",
          body: "This engine doesn't have the Game Master's game library yet. Once it does, every adventure you start by voice is saved here — open one to put it back on the workspace screen.",
        }),
      );
      return;
    }
    if (!data.games.length) {
      const gm = personasRes.peek()?.find((p) => p.toolsets.includes("game"));
      setChildren(
        listEl,
        emptyState({
          icon: "dice",
          title: "No saved games yet",
          body: gm
            ? `Make “${gm.name}” the active persona, start a call, and say “I want to start a game.” The Game Master walks you through setup, and the adventure is saved here.`
            : "Give a persona the Game Master tools, start a call, and say “I want to start a game.” The adventure is saved here.",
          action: gm
            ? h("a", { class: "btn", href: `#personas/${encodeURIComponent(gm.id)}` }, icon("users"), h("span", { class: "btn-label" }, `Open ${gm.name}`))
            : h("a", { class: "btn", href: "#personas" }, icon("users"), h("span", { class: "btn-label" }, "Go to Personas")),
        }),
      );
      return;
    }
    const games = [...data.games].sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
    setChildren(listEl, h("div", { class: "games-grid" }, games.map(gameCard)));
    for (const g of games.slice(0, 24)) want(g.id);
  }

  // ── Actions ──

  async function openGame(g: GameSummary, btn: HTMLButtonElement): Promise<void> {
    try {
      await withBusy(btn, () => api.games.open(g.id), "Opening…");
      toast(`Opened “${g.title}” in the workspace`, "success", { action: { label: "Show window", run: showWorkspaceWindow } });
      announce("games");
      details.delete(g.id);
      void gamesRes.refresh().catch(() => {});
    } catch {
      /* reported */
    }
  }

  async function deleteGame(g: GameSummary): Promise<void> {
    const ok = await confirmAction({
      title: `Delete “${g.title}”?`,
      message: g.active
        ? "This game is in progress. Its party, log, items, and art are removed for good, and it disappears from the workspace."
        : "Its party, log, items, and art are removed for good. This can't be undone.",
      confirmLabel: "Delete game",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.games.remove(g.id);
      details.delete(g.id);
      expanded.delete(g.id);
      gamesRes.update((d) => ({ ...d, games: d.games.filter((x) => x.id !== g.id) }));
      announce("games");
      toast(`Deleted “${g.title}”`, "success");
    } catch {
      /* reported */
    }
  }

  async function load(force = false): Promise<void> {
    loadFailed = null;
    if (!data) render();
    try {
      data = force ? await gamesRes.refresh() : await gamesRes.get();
      void personasRes.get().catch(() => {});
    } catch (err) {
      loadFailed = (err as Error).message || "The engine didn't answer.";
    }
    render();
  }

  gamesRes.subscribe((d) => {
    data = d;
    loadFailed = null;
    // Details may be stale after a refresh; refetch the ones that changed.
    for (const g of d.games) {
      const v = details.get(g.id);
      if (v && typeof v === "object" && v.updatedAt !== g.updatedAt) details.delete(g.id);
    }
    render();
  });
  personasRes.subscribe(() => {
    if (data) render();
  });

  let started = false;
  return {
    el,
    show() {
      if (!started) {
        started = true;
        void load();
      } else void gamesRes.refresh().catch(() => {});
    },
    refresh() {
      if (started) void gamesRes.refresh().catch(() => {});
    },
  };
}
