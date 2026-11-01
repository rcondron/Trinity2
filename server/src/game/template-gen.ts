import vm from "node:vm";
import { coderModel, live } from "../settings.js";
import { workspace } from "../workspace/bus.js";
import { textChatDetailed } from "./generate.js";
import { isGameOnScreen, presentGame, setBusy } from "./present.js";
import { getGame, setCustomTemplate } from "./store.js";
import type { Game, GameView, ImageRef } from "./types.js";
import { toView } from "./view.js";

/**
 * Bespoke game screens: the coding skill's stronger coder (Kimi, see settings.coderModel) designs a
 * template for THIS scenario — parchment and wax seals for a fantasy table, a HUD for a
 * starship crew. Slow (15–90s), so it always runs in the background: the default screen
 * shows instantly and the custom one swaps in when it's ready and validated. A custom screen
 * that throws in the browser is dropped automatically (present.ts) and regenerated once with
 * the error as feedback.
 */

const MAX_BYTES = 90_000;
const MAX_ATTEMPTS_PER_GAME = 3;
/** Dense CSS/JS runs ~2.2 chars/token, so a ~25 KB screen needs ~12k tokens; leave headroom. */
const MAX_TOKENS = 16_000;
const TRUNCATED = "was too long and got cut off before the end";

const CONTRACT = `TEMPLATE CONTRACT v1 (follow exactly):
- A template is an HTML fragment (no <html>, <head> or <body>): an optional <style>, markup with <div id="app"></div>, and <script> blocks.
- It MUST define window.render = function (state, prev) { ... }. It is called after load with the first state and on EVERY state change (prev = the previous state or null). It must be idempotent and fast (a full re-render via innerHTML is OK; diff prev by id to add "is-new" animation classes). It must never throw on missing or empty fields.
- Runtime helpers are defined BEFORE your script runs: window.trinity.esc(s) HTML-escapes any value to a string; window.trinity.send(evt) is reserved (do not use it).
- No network or external resources: no <script src>, no <link>, no fetch / XMLHttpRequest / import() / WebSocket, no web fonts, no external images or CSS url(). Images are absolute URLs inside state. Use system font stacks only.
- The page runs in a sandboxed iframe (sandbox="allow-scripts", opaque origin): no localStorage, cookies, alert() or popups. Errors thrown by render are reported and the host falls back to a default screen.`;

const VIEW_TS = `type ImageStatus = "none" | "pending" | "ready" | "error";
interface ImageRef { url: string | null; status: ImageStatus }   // show an <img> only when status === "ready" && url
interface Stats { str: number; dex: number; con: number; int: number; wis: number; cha: number }   // modifier = Math.floor((score - 10) / 2)
interface PlayerView {
  id: string; name: string; race: string; className: string; level: number;
  hp: number; maxHp: number; ac: number; speed: number; stats: Stats;
  background: string; traits: string[]; conditions: string[]; gold: number; xp: number;
  inventory: string[];          // item ids — look them up in state.items
  notes: string; portrait: ImageRef;
  pending?: boolean;            // true = placeholder card while the character sheet is being generated
}
interface ItemView {
  id: string; name: string;
  type: "weapon" | "armor" | "potion" | "scroll" | "wondrous" | "gear" | "treasure" | "quest";
  rarity: "common" | "uncommon" | "rare" | "very rare" | "legendary" | "artifact";
  description: string; properties: string[];
  ownerId: string | null;       // a player id, or null = the party's shared loot
  icon: ImageRef;
}
interface NpcView { id: string; name: string; role: string; description: string; attitude: "friendly" | "neutral" | "hostile" | "unknown"; portrait: ImageRef }
interface LocationView {
  id: string; name: string; description: string;
  x: number; y: number;         // normalized map position, 0..1
  connections: string[];        // ids of connected locations (symmetric)
  visited: boolean; image: ImageRef;
}
interface LogEntry { id: string; ts: number; kind: "narration" | "roll" | "combat" | "loot" | "party" | "system"; text: string }
interface Roll { id: string; who: string | null; notation: string; rolls: number[]; modifier: number; total: number; label: string | null; ts: number }
interface GameTheme {
  palette: { bg: string; panel: string; ink: string; muted: string; accent: string; accent2: string; danger: string; good: string };  // CSS hex colors
  font: "serif" | "sans" | "mono" | "display";
  texture: "parchment" | "stone" | "wood" | "hud" | "neon" | "none";
  labels: { party: string; scene: string; log: string; npcs: string; items: string; map: string };  // section titles
  ornament: string;             // a decorative glyph for section headers
}
interface GameView {
  kind: "game"; id: string; title: string; genre: string; tone: string; setting: string; theme: GameTheme;
  phase: "setup" | "playing";
  setup: { steps: { key: "adventure" | "party" | "begin"; label: string; done: boolean }[]; next: string | null };
  round: number; activePlayerId: string | null; titleImage: ImageRef;
  scene: { title: string; description: string; image: ImageRef } | null;
  players: PlayerView[]; npcs: NpcView[]; items: ItemView[]; locations: LocationView[];
  currentLocationId: string | null;
  log: LogEntry[];              // OLDEST first, up to 200 — show newest first
  lastRoll: Roll | null;
  busy: string[];               // background work in progress, e.g. "Painting Thorin's portrait…"
  updatedAt: number;
}`;

const ORIGIN = "http://localhost:5173";
const img = (name: string, status: ImageRef["status"] = "ready"): ImageRef => ({
  url: status === "ready" ? `${ORIGIN}/api/images/${name}.png` : null,
  status,
});

/** The game's real view, padded with example entities so the model designs for a full table. */
function sampleState(game: Game): GameView {
  const v = toView(game, ["Painting the scene…"]);
  const abs = (r: ImageRef): ImageRef => (r.url ? { ...r, url: `${ORIGIN}${r.url}` } : r);
  v.titleImage = v.titleImage.url ? abs(v.titleImage) : img("example-title");
  const now = Date.now();
  if (!v.players.some((p) => !p.pending)) {
    v.players = [
      {
        id: "p1", name: "Aria Vance", race: "Human", className: "Ranger", level: 2, hp: 14, maxHp: 18, ac: 15, speed: 30,
        stats: { str: 12, dex: 16, con: 13, int: 10, wis: 14, cha: 8 }, background: "Exiled scout",
        traits: ["Hums when nervous", "Never leaves a debt unpaid"], conditions: [], gold: 24, xp: 350,
        inventory: ["i1", "i2"], notes: "", portrait: img("example-portrait-1"),
      },
      {
        id: "p2", name: "Bram Holt", race: "Dwarf", className: "Cleric", level: 2, hp: 4, maxHp: 19, ac: 18, speed: 25,
        stats: { str: 14, dex: 8, con: 16, int: 10, wis: 16, cha: 12 }, background: "Temple smith",
        traits: ["Speaks to his hammer"], conditions: ["poisoned"], gold: 7, xp: 350,
        inventory: [], notes: "", portrait: img("", "pending"),
      },
      {
        id: "p3", name: "New hero", race: "", className: "", level: 1, hp: 1, maxHp: 1, ac: 10, speed: 30,
        stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, background: "", traits: [], conditions: [],
        gold: 0, xp: 0, inventory: [], notes: "", portrait: img("", "pending"), pending: true,
      },
    ];
    v.activePlayerId = "p1";
  } else {
    v.players = v.players.map((p) => ({ ...p, portrait: abs(p.portrait) }));
  }
  const firstId = v.players[0]?.id ?? null;
  if (!v.items.length) {
    v.items = [
      { id: "i1", name: "Moonlit Longbow", type: "weapon", rarity: "rare", description: "Arrows loosed under starlight never miss their first mark.", properties: ["+1 to hit", "1d8 piercing"], ownerId: firstId, icon: img("example-icon-1") },
      { id: "i2", name: "Healing Draught", type: "potion", rarity: "common", description: "Tastes of mint and copper.", properties: ["heals 2d4+2"], ownerId: firstId, icon: img("", "none") },
      { id: "i3", name: "Sealed Letter", type: "quest", rarity: "uncommon", description: "Wax seal of a house that no longer exists.", properties: [], ownerId: null, icon: img("", "pending") },
    ];
  } else v.items = v.items.map((it) => ({ ...it, icon: abs(it.icon) }));
  if (!v.npcs.length) {
    v.npcs = [
      { id: "n1", name: "Mother Ilse", role: "innkeeper", description: "Knows every secret in town and sells them by the cup.", attitude: "friendly", portrait: img("example-npc-1") },
      { id: "n2", name: "The Grey Warden", role: "hunter", description: "Has been following the party since the crossroads.", attitude: "hostile", portrait: img("", "error") },
    ];
  } else v.npcs = v.npcs.map((n) => ({ ...n, portrait: abs(n.portrait) }));
  if (!v.locations.length) {
    v.locations = [
      { id: "l1", name: "Harrow's Rest", description: "A sleepy village", x: 0.28, y: 0.62, connections: ["l2"], visited: true, image: img("", "none") },
      { id: "l2", name: "The Old Mill", description: "Where the screams were heard", x: 0.52, y: 0.4, connections: ["l1", "l3"], visited: true, image: img("example-scene") },
      { id: "l3", name: "Black Fen", description: "Unexplored marsh", x: 0.78, y: 0.3, connections: ["l2"], visited: false, image: img("", "none") },
    ];
    v.currentLocationId = "l2";
  } else v.locations = v.locations.map((l) => ({ ...l, image: abs(l.image) }));
  if (!v.scene) {
    v.scene = {
      title: "The Old Mill",
      description: "Rain hammers the sagging roof as the great wheel groans in the dark. Flour drifts like ash across the floorboards — and something has left wet footprints leading down into the cellar.",
      image: img("example-scene"),
    };
  } else v.scene = { ...v.scene, image: abs(v.scene.image) };
  if (v.log.length < 3) {
    v.log = [
      ...v.log,
      { id: "g1", ts: now - 60_000, kind: "party", text: "Aria Vance, a human ranger, joins the party." },
      { id: "g2", ts: now - 40_000, kind: "narration", text: "The Old Mill: Rain hammers the sagging roof as the great wheel groans in the dark." },
      { id: "g3", ts: now - 20_000, kind: "combat", text: "Bram Holt takes 6 damage from the ghoul's claws (4/19 HP)" },
      { id: "g4", ts: now - 5_000, kind: "roll", text: "Aria Vance rolls Perception check: 20 (1d20+3: 17)" },
    ];
  }
  v.lastRoll ??= { id: "r1", who: "Aria Vance", notation: "1d20+3", rolls: [17], modifier: 3, total: 20, label: "Perception check", ts: now - 5_000 };
  return v;
}

const SYSTEM = `You are a senior front-end engineer and game UI designer. You write one self-contained HTML template (CSS + vanilla JS, no frameworks or libraries) for a live tabletop game screen that players watch on a big display while an AI Game Master runs the game by voice. The screen updates many times a minute as the story unfolds, so it must be robust, fast and beautiful — the polish of a premium board-game companion app. Output ONLY the template code.`;

/** Known-good helpers the model builds on (keeps generated screens from tripping on the basics). */
const SKELETON = `<style>
  /* your bespoke design: CSS variables --bg --panel --ink --muted --accent --accent2 --danger --good are set by render */
</style>
<div id="app"></div>
<script>
(function () {
  var esc = window.trinity.esc;
  function A(v) { return Array.isArray(v) ? v : []; }
  function mod(score) { var m = Math.floor(((Number(score) || 10) - 10) / 2); return (m >= 0 ? "+" : "\\u2212") + Math.abs(m); }
  var regions = {};
  // Set a region's HTML only when it changed: no image flicker, animations keep running.
  function put(el, html) { if (!el || regions[el.id] === html) return; regions[el.id] = html; el.innerHTML = html; }
  // An image slot: <img> when ready, a shimmer while pending, otherwise a monogram.
  function pic(ref, label, cls) {
    ref = ref || {};
    if (ref.status === "ready" && ref.url) return '<img class="' + cls + '" src="' + esc(ref.url) + '" alt="">';
    if (ref.status === "pending") return '<div class="' + cls + ' shimmer"></div>';
    return '<div class="' + cls + ' mono">' + esc((String(label || "?").trim().charAt(0) || "?").toUpperCase()) + '</div>';
  }
  var last = null;
  window.render = function (state, prev) {
    var s = state || {}, p = prev || {};
    last = s;
    // 1. apply s.theme (CSS variables, font stack, texture class)  2. build the layout once
    // 3. refresh every region with put(document.getElementById("…"), html)  4. drawMap(s)
  };
  window.addEventListener("resize", function () { if (last) drawMap(last); });
  function drawMap(s) { /* size the canvas to its box × devicePixelRatio, then draw links, nodes, glow, labels */ }
})();
</script>`;

function designBrief(game: Game, sample: GameView, feedback?: string): string {
  const t = game.theme;
  const genre = game.genre || "fantasy";
  return `Design a bespoke game screen for THIS scenario:
- Title: ${JSON.stringify(game.title)}
- Genre: ${genre}${game.tone ? `; tone: ${game.tone}` : ""}
- Setting: ${JSON.stringify(game.setting || "(not set yet)")}
- Art style of the generated images: ${JSON.stringify(game.artStyle || "painterly game art")}
- Theme (read it from state.theme on every render — it can change): palette ${JSON.stringify(t.palette)}, font "${t.font}", texture "${t.texture}", section labels ${JSON.stringify(t.labels)}, ornament ${JSON.stringify(t.ornament)}

${CONTRACT}

STATE SHAPE (TypeScript):
${VIEW_TS}

EXAMPLE STATE (real values will differ — never hard-code names, text, colors or counts from it):
${JSON.stringify(sample)}

REQUIRED SECTIONS AND BEHAVIOR
1. Header bar: the title (large, display treatment, with the ornament), genre and tone chips, a phase badge (SETUP / PLAYING) plus "Round N" while playing, the title art (state.titleImage) as a thumbnail or banner, and state.busy as small pills with a spinner.
2. Setup card, ONLY while state.phase === "setup": a prominent "Setting up your adventure" card with the checklist from state.setup.steps (✓ done, ○ to do) and a highlighted "Next:" line with state.setup.next. Hidden while playing.
3. Party (title = state.theme.labels.party): one card per player — portrait (<img> when ready, shimmer skeleton when pending, initials monogram otherwise), name, race · class · level, an HP bar (width = hp / maxHp, color shifting good → accent → danger as it falls, animated), an AC badge, six stat chips with modifiers (+2 / −1), conditions as tags, gold and XP, inventory chips (item names from state.items, colored by rarity). Highlight state.activePlayerId. A player with pending: true is a placeholder card ("A new hero approaches…" with shimmer).
4. Scene (labels.scene): large 16:9 scene art (shimmer while pending), the scene title, and the description as read-aloud text in an italic storybook style. A graceful empty state when scene is null.
5. Log (labels.log): newest first, the latest ~40 entries, an icon per kind (🎲 roll — emphasize the numbers, ⚔ combat, 💰 loot, 🧝 party, 📜 narration, ⚙ system).
6. Last roll: a big total that animates (pop / tumble) when lastRoll.id differs from prev?.lastRoll?.id; notation, the individual dice, modifier, label and who rolled; celebrate a natural 20 and mourn a natural 1 on single d20 rolls.
7. NPCs (labels.npcs): portrait thumb, name, role, attitude color (friendly = good, hostile = danger, neutral = muted, unknown = accent2).
8. Items (labels.items): icon with a rarity-colored border (shimmer while pending, a type glyph otherwise), name, rarity, and the owner's name or "Party".
9. Map (labels.map): a <canvas> sized to its container × devicePixelRatio; draw the connection lines, the nodes (visited = filled, unvisited = hollow and dim), a glowing current location (state.currentLocationId) and the labels; redraw on every render and on resize. An empty-state message when there are no locations.

LAYOUT AND LOOK
- Target a 1280×860 window and degrade gracefully down to ~700px wide (stack the columns) without horizontal overflow. Suggested: the header across the top, then three columns — party on the left, scene + log in the center (widest), last roll / NPCs / items / map on the right. Let columns scroll on their own when content is long; at 1280×860 the page itself shouldn't need to scroll.
- Make it unmistakably "${genre}": use the "${t.texture}" texture as a CSS-only background (gradients and patterns, no images), the theme's font stack, the ornament in section headers, and genre details — e.g. parchment edges and wax-seal badges for fantasy, HUD corner brackets and scanlines for sci-fi, neon glow for cyberpunk, wood grain and brass for westerns or pirates, grain and vignette for horror.
- Readable from across a table: clear hierarchy, generous spacing, strong contrast, a consistent card system with subtle depth. Tasteful motion: fade/slide-in for new entities (diff ids against prev to add an "is-new" class) and smooth HP bars; put animations inside @media (prefers-reduced-motion: no-preference).
- Long names and text wrap or ellipsize. Handle 0–8 players, 0–30 items, 0–15 NPCs, 0–20 locations and up to 200 log entries.

CODE RULES
- Start from this skeleton. Keep its helpers (esc, A, mod, put, pic) and its shape — one IIFE, window.render assigned once, the last state kept in a closure for the resize redraw — and design everything else:
${SKELETON}
- The HOST calls window.render(state, prev) after load and on every update. Never call render yourself: no load / DOMContentLoaded / window.onload handlers that render, no "initial state" globals. Read nothing from window except window.trinity.
- render must never throw: guard every field (const s = state || {}; arrays via A(x); optional objects via (x || {})).
- Escape EVERY piece of state text with esc() before it goes into HTML, attributes and image URLs included.
- Only emit an <img> for a ready image (use pic()); never set an image src to "".
- Apply the theme on every render: document.documentElement.style.setProperty("--bg", palette.bg) and so on for every palette color. Use only CSS variables you define; for tints use color-mix(in srgb, var(--accent) 20%, transparent).
- Font stacks: serif → Georgia, 'Iowan Old Style', 'Palatino Linotype', serif; sans → system-ui, 'Segoe UI', Roboto, sans-serif; mono → ui-monospace, Consolas, monospace; display → 'Trebuchet MS', Impact, sans-serif.
- No external resources of any kind, no localStorage, no alert(), no never-ending timers (one requestAnimationFrame loop for the map glow is fine).
- Keep the WHOLE template under 24 KB: compact CSS (shared classes, no repeated declarations), no comments, no dead code — an unfinished template is useless, so finish it.
${feedback ? `\nIMPORTANT — a previous version of this screen failed: ${JSON.stringify(feedback.slice(0, 400))}. Make sure that cannot happen again.\n` : ""}
Return ONLY the template: <style>…</style>, the markup (including <div id="app"></div>) and <script>…</script>. No markdown fences, no explanations.`;
}

/** Strip fences, think blocks and document tags so only the fragment remains. */
export function extractTemplate(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fences = [...s.matchAll(/```[a-zA-Z]*[^\S\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  if (fences.length) s = fences.sort((a, b) => b.length - a.length)[0] ?? s;
  s = s.replace(/^\s*```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  s = s
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?html(?:\s[^>]*)?>/gi, "")
    .replace(/<\/?head(?:\s[^>]*)?>/gi, "")
    .replace(/<\/?body(?:\s[^>]*)?>/gi, "")
    .replace(/<meta(?:\s[^>]*)?>/gi, "")
    .replace(/<title>[\s\S]*?<\/title>/gi, "");
  return s.trim();
}

const BANNED: [RegExp, string][] = [
  [/<script\b[^>]*\bsrc\s*=/i, "<script src>"],
  [/<script\b[^>]*type\s*=\s*["']?module/i, "module scripts"],
  [/<link\b/i, "<link>"],
  [/@import\b/i, "CSS @import"],
  [/\bfetch\s*\(/, "fetch()"],
  [/XMLHttpRequest/, "XMLHttpRequest"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/WebSocket|EventSource|sendBeacon/, "network APIs"],
  [/localStorage|sessionStorage|indexedDB/, "storage APIs"],
  [/document\.cookie/, "cookies"],
  [/\beval\s*\(|new\s+Function\s*\(/, "eval"],
  [/url\(\s*['"]?\s*(?:https?:)?\/\//i, "external url()"],
  [/\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, "external src/href"],
  [/\b(?:parent|top|opener)\s*\.\s*(?:postMessage|location|document)/, "reaching outside the frame"],
  // Failure modes seen in real generations:
  [/window\.__\w+|__INITIAL_STATE__|__STATE__/, "host globals instead of the state passed to render"],
  [/addEventListener\(\s*["'](?:load|DOMContentLoaded)["'][\s\S]{0,240}?\brender\s*\(|window\.onload\s*=/, "a load handler that calls render itself (it would wipe the screen with empty state)"],
  [/\.src\s*=\s*(["'])\1|<img\b[^>]*\bsrc\s*=\s*(["'])\2/i, "an empty image src (shows a broken image)"],
];

export type TemplateCheck = { ok: true } | { ok: false; reason: string };

/** Structural safety + sanity checks for a generated template (every script must compile). */
export function validateTemplate(src: string): TemplateCheck {
  if (src.length < 1500) return { ok: false, reason: `too short (${src.length} chars)` };
  if (Buffer.byteLength(src, "utf8") > MAX_BYTES) return { ok: false, reason: `too large (${Math.round(src.length / 1024)} KB)` };
  if (!src.includes("window.render")) return { ok: false, reason: "missing window.render" };
  for (const [re, what] of BANNED) if (re.test(src)) return { ok: false, reason: `uses ${what}` };
  if (!/trinity\.esc|\besc\s*\(/.test(src)) return { ok: false, reason: "doesn't escape state text with trinity.esc" };
  if (!/\.players\b|\[["']players["']\]/.test(src)) return { ok: false, reason: "doesn't render state.players" };
  const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) return { ok: false, reason: "no <script> block" };
  for (const m of scripts) {
    try {
      new vm.Script(m[1] ?? "", { filename: "custom-template.js" }); // compiles only, never runs
    } catch (err) {
      return { ok: false, reason: `script syntax error: ${(err as Error).message}` };
    }
  }
  if ((src.match(/<script\b/gi) ?? []).length !== scripts.length) return { ok: false, reason: "unterminated <script>" };
  return { ok: true };
}

/** The exact system + user prompt used to design a screen for `game` (exported for debugging/tests). */
export function templatePrompt(game: Game, feedback?: string): { system: string; user: string } {
  return { system: SYSTEM, user: designBrief(game, sampleState(game), feedback) };
}

async function generateOnce(game: Game, feedback?: string): Promise<{ src: string | null; reason?: string }> {
  if (!live.mordiem) return { src: null, reason: "no Mordiem key" };
  const out = await textChatDetailed(SYSTEM, designBrief(game, sampleState(game), feedback), {
    model: coderModel("kimi"), // background work: the stronger coder
    maxTokens: MAX_TOKENS,
    timeoutMs: 180_000,
    temperature: 0.5,
  });
  if (!out?.text.trim()) return { src: null, reason: "the model returned nothing" };
  if (out.finish === "length") return { src: null, reason: TRUNCATED };
  const src = extractTemplate(out.text);
  const check = validateTemplate(src);
  if (!check.ok) return { src: null, reason: check.reason };
  return { src };
}

/** Generate a validated custom template for this game, or null. Slow — never await it in a tool. */
export async function generateCustomTemplate(game: Game, opts: { feedback?: string } = {}): Promise<string | null> {
  const r = await generateOnce(game, opts.feedback);
  if (!r.src && r.reason) console.warn(`[game] custom screen for "${game.title}" rejected: ${r.reason}`);
  return r.src;
}

// ─── Background runner ───────────────────────────────────────────────────────

interface Run {
  key: string;
  rerun: boolean;
  feedback?: string;
}
const inflight = new Map<string, Run>();
const attempts = new Map<string, number>();

/** What a design depends on (not the title — templates read it from state): when it changes, an in-flight design is stale. */
export function frameKey(g: Game): string {
  return [g.genre, g.tone, g.artStyle, g.theme.palette.bg, g.theme.palette.accent, g.theme.texture].join("|");
}

/**
 * Design a custom screen for a game in the background (never awaited by tools): busy label
 * "Designing a custom screen…", generate, store, and swap it in if the game is on screen.
 * One run per game at a time; a frame change mid-run triggers a fresh run. Skips silently
 * without a Mordiem key. Returns whether a run is (now) in progress.
 */
export function startCustomTemplate(gameId: string, opts: { feedback?: string; fresh?: boolean } = {}): boolean {
  if (!live.mordiem) return false;
  const game = getGame(gameId);
  if (!game) return false;
  if (opts.fresh) {
    // A new adventure frame: the attempt budget starts over.
    attempts.delete(gameId);
    renderFailures.delete(gameId);
  }
  const running = inflight.get(gameId);
  if (running) {
    if (running.key !== frameKey(game) || opts.feedback) {
      running.rerun = true;
      running.feedback = opts.feedback;
    }
    return true;
  }
  const used = attempts.get(gameId) ?? 0;
  if (used >= MAX_ATTEMPTS_PER_GAME) return false;
  attempts.set(gameId, used + 1);

  const run: Run = { key: frameKey(game), rerun: false };
  inflight.set(gameId, run);
  setBusy(gameId, "template", "Designing a custom screen…");
  const started = Date.now();
  void (async () => {
    let retryFeedback: string | undefined;
    try {
      const r = await generateOnce(game, opts.feedback);
      const latest = getGame(gameId);
      if (!latest) return;
      if (frameKey(latest) !== run.key) {
        run.rerun = true; // designed for an outdated frame
        return;
      }
      if (!r.src) {
        console.warn(`[game] custom screen for "${latest.title}" not used: ${r.reason ?? "unknown"}`);
        if (r.reason === TRUNCATED)
          retryFeedback = "Your previous answer was too long and got cut off. Write a tighter design: the whole template under 18 KB.";
        else if (r.reason && r.reason !== "the model returned nothing" && r.reason !== "no Mordiem key")
          retryFeedback = `It was rejected because it ${r.reason.startsWith("uses") ? r.reason : `had this problem: ${r.reason}`}.`;
        return;
      }
      setCustomTemplate(gameId, r.src);
      console.log(
        `[game] custom screen for "${latest.title}" ready in ${Math.round((Date.now() - started) / 1000)}s (${Math.round(r.src.length / 1024)} KB)`,
      );
      if (isGameOnScreen(gameId)) {
        presentGame(gameId);
        workspace.toast(`A custom screen for ${latest.title} is ready`, "success");
      }
    } catch (err) {
      console.warn(`[game] custom screen failed: ${(err as Error).message}`);
    } finally {
      inflight.delete(gameId);
      setBusy(gameId, "template", null);
      if (run.rerun) startCustomTemplate(gameId, { feedback: run.feedback });
      else if (retryFeedback) startCustomTemplate(gameId, { feedback: retryFeedback });
    }
  })();
  return true;
}

// A custom screen that throws in the browser is dropped by present.ts; design a new one
// once, telling the model what went wrong.
const renderFailures = new Map<string, number>();
workspace.onRenderError((templateId, message) => {
  const m = /^game-custom:([^:]+):/.exec(templateId);
  if (!m?.[1]) return;
  const gameId = m[1];
  const n = (renderFailures.get(gameId) ?? 0) + 1;
  renderFailures.set(gameId, n);
  if (n <= 1) startCustomTemplate(gameId, { feedback: `It threw in the browser: ${message}` });
});
