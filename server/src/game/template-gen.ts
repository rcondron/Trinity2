import vm from "node:vm";
import { coderModel, live } from "../settings.js";
import { workspace } from "../workspace/bus.js";
import { textChatDetailed } from "./generate.js";
import { isGameOnScreen, presentGame, setBusy } from "./present.js";
import { blankPlayer, getGame, setCustomTemplate } from "./store.js";
import type { Game, GameView, ImageRef, NpcView, PlayerView } from "./types.js";
import { missingViewParts, toView } from "./view.js";

/**
 * Bespoke game screens: the coding skill's stronger coder (Kimi, see settings.coderModel) designs a
 * template for THIS scenario — parchment and wax seals for a fantasy table, a HUD for a
 * starship crew. Slow (15–90s), so it always runs in the background: the default screen
 * shows instantly and the custom one swaps in when it's ready and validated. A custom screen
 * that throws in the browser is dropped automatically (present.ts) and regenerated once with
 * the error as feedback. A screen that leaves out a required part of the game (the initiative
 * order, the roll being waited for, the quests…) is never used: the default table is shown instead.
 */

const MAX_BYTES = 90_000;
const MAX_ATTEMPTS_PER_GAME = 3;
/** Dense CSS/JS runs ~2.2 chars/token, so a ~28 KB screen needs ~13k tokens; leave headroom. */
const MAX_TOKENS = 16_000;
const TRUNCATED = "was too long and got cut off before the end";

const CONTRACT = `TEMPLATE CONTRACT v2 (follow exactly):
- A template is an HTML fragment (no <html>, <head> or <body>): an optional <style>, markup with <div id="app"></div>, and <script> blocks.
- It MUST define window.render = function (state, prev) { ... }. It is called after load with the first state and on EVERY state change (prev = the previous state or null). It must be idempotent and fast (a full re-render via innerHTML is OK; diff prev by id to add "is-new" animation classes). It must never throw on missing or empty fields.
- Runtime helpers are defined BEFORE your script runs: window.trinity.esc(s) HTML-escapes any value to a string; window.trinity.send(evt) is reserved (do not use it).
- No network or external resources: no <script src>, no <link>, no fetch / XMLHttpRequest / import() / WebSocket, no web fonts, no external images or CSS url(). Images are absolute URLs inside state. Use system font stacks only.
- The page runs in a sandboxed iframe (sandbox="allow-scripts", opaque origin): no localStorage, cookies, alert() or popups. Errors thrown by render are reported and the host falls back to a default screen.`;

const VIEW_TS = `type ImageStatus = "none" | "pending" | "ready" | "error";
interface ImageRef { url: string | null; status: ImageStatus }   // show an <img> only when status === "ready" && url
interface Stats { str: number; dex: number; con: number; int: number; wis: number; cha: number }   // modifier = Math.floor((score - 10) / 2)
interface ConditionView { name: string; rounds: number | null }   // rounds left, null = until removed
interface PlayerView {
  id: string; name: string;
  playerName: string;           // the person at the table who plays this hero ("" if unknown)
  race: string; className: string; level: number;
  hp: number; maxHp: number; tempHp: number; ac: number; speed: number; stats: Stats;
  background: string; traits: string[];
  conditions: string[]; conditionInfo: ConditionView[];   // show conditionInfo: the name and, when rounds is a number, the rounds left
  exhaustion: number;           // 0-6
  gold: number; xp: number;
  inventory: string[];          // item ids — look them up in state.items
  slots: { level: number; max: number; used: number }[];   // spell slots by spell level (empty for non-casters): draw one pip per slot, used ones dimmed
  concentration: string | null; inspiration: boolean;
  deathSaves: { successes: number; failures: number };   // draw 3 + 3 pips while hp === 0 and not stable/dead
  stable: boolean; dead: boolean;
  isTurn: boolean;              // this hero is acting now (their turn in a fight, or the spotlight while exploring)
  notes: string; portrait: ImageRef;
  pending?: boolean;            // true = placeholder card while the character sheet is being generated
}
interface ItemView {
  id: string; name: string;
  type: "weapon" | "armor" | "potion" | "scroll" | "wondrous" | "gear" | "treasure" | "quest";
  rarity: "common" | "uncommon" | "rare" | "very rare" | "legendary" | "artifact";
  description: string; properties: string[]; quantity: number;
  ownerId: string | null;       // a player id, or null = the party's shared loot
  equipped: boolean;            // held or worn by its owner
  icon: ImageRef;
}
interface NpcView {
  id: string; name: string; role: string; description: string;
  attitude: "friendly" | "neutral" | "hostile" | "unknown";
  status: "alive" | "defeated" | "fled";        // defeated / fled: draw it struck through or dimmed
  health: "healthy" | "bloodied" | "near death" | "down" | null;   // how hurt it LOOKS: a band, never numbers (null = a bystander)
  conditionInfo: ConditionView[]; inCombat: boolean; isTurn: boolean;
  portrait: ImageRef;
}
interface LocationView {
  id: string; name: string; description: string;
  x: number; y: number;         // normalized map position, 0..1
  connections: string[];        // ids of connected locations (symmetric)
  visited: boolean; image: ImageRef;
}
interface LogEntry { id: string; ts: number; kind: "narration" | "roll" | "combat" | "loot" | "party" | "system"; text: string }
interface Roll {
  id: string; who: string | null; notation: string; rolls: number[]; modifier: number; total: number; label: string | null; ts: number;
  adv: "adv" | "dis" | null;    // rolled with advantage / disadvantage: rolls holds both d20s
  kept: number | null;          // the d20 that counted
  natural: number | null;       // the d20 that counted: 20 = natural 20, 1 = natural 1 (use THIS for the crit ribbon, not rolls.length)
  dc: number | null;            // what it was rolled against (a DC or an armor class)
  outcome: "success" | "failure" | "hit" | "miss" | "crit" | "fumble" | null;
}
interface GameTheme {
  palette: { bg: string; panel: string; ink: string; muted: string; accent: string; accent2: string; danger: string; good: string };  // CSS hex colors
  font: "serif" | "sans" | "mono" | "display";
  texture: "parchment" | "stone" | "wood" | "hud" | "neon" | "none";
  labels: { party: string; scene: string; log: string; npcs: string; items: string; map: string };  // section titles
  ornament: string;             // a decorative glyph for section headers
}
interface GameView {
  kind: "game"; id: string; title: string; genre: string; tone: string; setting: string; theme: GameTheme;
  phase: "setup" | "playing" | "paused" | "ended";
  mode: "explore" | "combat" | "paused";
  setup: { steps: { key: string; label: string; done: boolean }[]; next: string | null };
  round: number;                // the combat round, 0 outside a fight — show "Round N" ONLY while combat is not null
  turn: { kind: "turn" | "spotlight"; id: string; name: string; playerName: string; isHero: boolean } | null;   // who is acting now
  combat: { round: number; order: { id: string; kind: "hero" | "npc"; name: string; init: number; current: boolean; down: boolean }[] } | null;   // the initiative order
  pendingCheck: { heroId: string; hero: string; label: string; dc: number; adv: "adv" | "dis" | null; text: string } | null;   // a roll the Game Master is waiting for: text = "Mira: Dexterity save, DC 13"
  pendingQuestion: string | null;   // a yes/no or "who?" question waiting for an answer
  quests: { id: string; title: string; detail: string; status: "open" | "done" | "failed" }[];
  storyTurn: number; partyGold: number;
  activePlayerId: string | null; spotlightId: string | null; titleImage: ImageRef;
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

function samplePlayer(over: Partial<PlayerView> & { id: string; name: string }): PlayerView {
  const { portrait: _p, appearance: _a, ...sheet } = blankPlayer(over.id, over.name);
  return { ...sheet, portrait: img("", "none"), conditionInfo: [], slots: [], isTurn: false, ...over };
}

function sampleNpc(over: Partial<NpcView> & { id: string; name: string }): NpcView {
  return { role: "", description: "", attitude: "unknown", portrait: img("", "none"), status: "alive", health: null, conditionInfo: [], inCombat: false, isTurn: false, ...over };
}

/** The game's real view, padded with example entities so the model designs for a full table in the middle of a fight. */
function sampleState(game: Game): GameView {
  const v = toView(game, ["Painting the scene…"]);
  const abs = (r: ImageRef): ImageRef => (r.url ? { ...r, url: `${ORIGIN}${r.url}` } : r);
  v.titleImage = v.titleImage.url ? abs(v.titleImage) : img("example-title");
  const now = Date.now();
  if (!v.players.some((p) => !p.pending)) {
    v.players = [
      samplePlayer({
        id: "p1", name: "Aria Vance", playerName: "Sam", race: "Human", className: "Ranger", level: 2, hp: 14, maxHp: 18, ac: 15,
        stats: { str: 12, dex: 16, con: 13, int: 10, wis: 14, cha: 8 }, background: "Exiled scout", traits: ["Hums when nervous"],
        gold: 24, xp: 350, inventory: ["i1", "i2"], portrait: img("example-portrait-1"), isTurn: true, inspiration: true,
        slots: [{ level: 1, max: 2, used: 1 }],
      }),
      samplePlayer({
        id: "p2", name: "Bram Holt", playerName: "Ana", race: "Dwarf", className: "Cleric", level: 2, hp: 0, maxHp: 19, ac: 18, speed: 25,
        stats: { str: 14, dex: 8, con: 16, int: 10, wis: 16, cha: 12 }, background: "Temple smith", traits: ["Speaks to his hammer"],
        conditions: ["unconscious", "poisoned"], conditionInfo: [{ name: "unconscious", rounds: null }, { name: "poisoned", rounds: 2 }],
        deathSaves: { successes: 1, failures: 2 }, gold: 7, xp: 350, portrait: img("", "pending"), slots: [{ level: 1, max: 3, used: 3 }],
      }),
      samplePlayer({ id: "p3", name: "New hero", portrait: img("", "pending"), pending: true }),
    ];
    v.activePlayerId = "p1";
    v.spotlightId = "p1";
    v.turn = { kind: "turn", id: "p1", name: "Aria Vance", playerName: "Sam", isHero: true };
  } else {
    v.players = v.players.map((p) => ({ ...p, portrait: abs(p.portrait) }));
  }
  const firstId = v.players[0]?.id ?? null;
  if (!v.items.length) {
    v.items = [
      { id: "i1", name: "Moonlit Longbow", type: "weapon", rarity: "rare", description: "Arrows loosed under starlight never miss their first mark.", properties: ["+1 to hit", "1d8 piercing"], ownerId: firstId, icon: img("example-icon-1"), quantity: 1, value: 500, equipped: true },
      { id: "i2", name: "Potion of Healing", type: "potion", rarity: "common", description: "Tastes of mint and copper.", properties: ["heals 2d4+2"], ownerId: firstId, icon: img("", "none"), quantity: 2, value: 50, equipped: false },
      { id: "i3", name: "Sealed Letter", type: "quest", rarity: "uncommon", description: "Wax seal of a house that no longer exists.", properties: [], ownerId: null, icon: img("", "pending"), quantity: 1, value: 0, equipped: false },
    ];
  } else v.items = v.items.map((it) => ({ ...it, icon: abs(it.icon) }));
  if (!v.npcs.length) {
    v.npcs = [
      sampleNpc({ id: "n1", name: "Mother Ilse", role: "innkeeper", description: "Knows every secret in town and sells them by the cup.", attitude: "friendly", portrait: img("example-npc-1") }),
      sampleNpc({ id: "n2", name: "Ghoul 1", role: "ghoul", description: "A ghoul, ready to fight.", attitude: "hostile", portrait: img("", "error"), health: "bloodied", inCombat: true, conditionInfo: [{ name: "prone", rounds: null }] }),
      sampleNpc({ id: "n3", name: "Ghoul 2", role: "ghoul", description: "A ghoul, ready to fight.", attitude: "hostile", status: "defeated", health: "down" }),
    ];
  } else v.npcs = v.npcs.map((n) => ({ ...n, portrait: abs(n.portrait) }));
  if (!v.combat) {
    const hero = v.players.find((p) => !p.pending);
    const foe = v.npcs.find((n) => n.status === "alive" && n.attitude === "hostile");
    v.mode = "combat";
    v.round = 2;
    v.combat = {
      round: 2,
      order: [
        ...(hero ? [{ id: hero.id, kind: "hero" as const, name: hero.name, init: 17, current: true, down: false }] : []),
        ...(foe ? [{ id: foe.id, kind: "npc" as const, name: foe.name, init: 12, current: false, down: false }] : []),
        ...v.players.filter((p) => !p.pending && p !== hero).map((p) => ({ id: p.id, kind: "hero" as const, name: p.name, init: 8, current: false, down: p.hp <= 0 })),
      ],
    };
  }
  const second = v.players.filter((p) => !p.pending)[1];
  v.pendingCheck ??= second ? { heroId: second.id, hero: second.name, label: "Death save", dc: 10, adv: null, text: `${second.name}: Death save, DC 10` } : null;
  if (!v.quests.length) {
    v.quests = [
      { id: "q1", title: "Find the missing miller", detail: "He was last seen going down to the cellar.", status: "open" },
      { id: "q2", title: "Reach Harrow's Rest", detail: "", status: "done" },
    ];
  }
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
      { id: "g1", ts: now - 60_000, kind: "party", text: "Aria Vance, a human ranger, joins the party, played by Sam." },
      { id: "g2", ts: now - 40_000, kind: "narration", text: "The Old Mill: Rain hammers the sagging roof as the great wheel groans in the dark." },
      { id: "g3", ts: now - 20_000, kind: "combat", text: "Ghoul 1 hits Bram Holt with claws for 6 slashing damage (0/19 HP)." },
      { id: "g4", ts: now - 5_000, kind: "roll", text: "Aria Vance — Perception check: 20 vs DC 15, success" },
    ];
  }
  v.lastRoll ??= { id: "r1", who: "Aria Vance", notation: "1d20+5", rolls: [20, 7], modifier: 5, total: 25, label: "Attack with longbow", ts: now - 5_000, adv: "adv", kept: 20, natural: 20, dc: 12, outcome: "crit" };
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

REQUIRED SECTIONS AND BEHAVIOR (a screen that leaves one out is discarded)
1. Header bar: the title (large, display treatment, with the ornament), genre and tone chips, a phase badge (SETUP / PLAYING / PAUSED / ENDED), "Round N" ONLY while state.combat is not null (N = state.combat.round), the title art (state.titleImage) as a thumbnail or banner, and state.busy as small pills with a spinner.
2. Setup card, ONLY while state.phase === "setup": a prominent "Setting up your adventure" card with the checklist from state.setup.steps (✓ done, ○ to do) and a highlighted "Next:" line with state.setup.next. Hidden otherwise.
3. Initiative strip, ONLY while state.combat is not null: state.combat.order in order as chips (name and initiative), the one with current === true highlighted, heroes with down === true dimmed, and the round number.
4. Pending-roll banner, ONLY while state.pendingCheck is not null: a highlighted banner showing state.pendingCheck.text (e.g. "Mira: Dexterity save, DC 13"). Also show state.pendingQuestion when it is not null.
5. Party (title = state.theme.labels.party): one card per player — portrait (<img> when ready, shimmer skeleton when pending, initials monogram otherwise), name, playerName when set, race · class · level, an HP bar (width = hp / maxHp, color shifting good → accent → danger as it falls, animated) with tempHp noted, an AC badge, six stat chips with modifiers (+2 / −1), conditions from conditionInfo as tags (with the rounds left when not null), death-save pips (deathSaves) while hp is 0, spell-slot pips (slots), gold and XP, inventory chips (item names from state.items, colored by rarity). The player with isTurn === true is highlighted and badged "Turn" in a fight (state.combat) or "Spotlight" otherwise. A player with pending: true is a placeholder card ("A new hero approaches…" with shimmer). dead === true is shown as fallen.
6. Scene (labels.scene): scene art in a FIXED-HEIGHT frame — e.g. height:clamp(140px,26vh,240px); width:100%; object-fit:cover (shimmer while pending). NEVER use unconstrained aspect-ratio:16/9 on a full-width image: it grows with the column and pushes the log off-screen. Then the scene title and description as read-aloud italic text. A graceful empty state when scene is null.
7. Quests: state.quests with their status (open / done / failed).
8. Log (labels.log): newest first, the latest ~40 entries, an icon per kind (🎲 roll — emphasize the numbers, ⚔ combat, 💰 loot, 🧝 party, 📜 narration, ⚙ system).
9. Last roll: a big total that animates (pop / tumble) when lastRoll.id differs from prev?.lastRoll?.id; notation, the individual dice (both d20s when lastRoll.adv is set, the kept one emphasized, with "Advantage" / "Disadvantage"), modifier, label, who rolled, and the outcome against lastRoll.dc; celebrate lastRoll.natural === 20 and mourn lastRoll.natural === 1.
10. NPCs (labels.npcs): portrait thumb, name, role, attitude color (friendly = good, hostile = danger, neutral = muted, unknown = accent2); for creatures with health not null a health band (healthy / bloodied / near death) drawn as a bar WITHOUT numbers; conditions from conditionInfo; status defeated or fled struck through and dimmed; the one with isTurn highlighted.
11. Items (labels.items): icon with a rarity-colored border (shimmer while pending, a type glyph otherwise), name (×quantity when above 1), rarity, the owner's name or "Party", and an "in use" mark when equipped.
12. Map (labels.map): a <canvas> sized to its container × devicePixelRatio; draw the connection lines, the nodes (visited = filled, unvisited = hollow and dim), a glowing current location (state.currentLocationId) and the labels; redraw on every render and on resize. An empty-state message when there are no locations.

LAYOUT AND LOOK
- Target a 1280×860 window and degrade gracefully down to ~700px wide (stack the columns) without horizontal overflow. Suggested: the header across the top, the initiative strip and pending banner under it, then three columns — party on the left, scene + quests + log in the center (widest), last roll / NPCs / items / map on the right. Let columns scroll on their own when content is long; at 1280×860 the page itself shouldn't need to scroll. Keep #app height-bound to the viewport (height:100%; overflow:hidden; flex column with min-height:0 on columns) so images never expand the page.
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
- Keep the WHOLE template under 28 KB: compact CSS (shared classes, no repeated declarations), no comments, no dead code — an unfinished template is useless, so finish it.
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

/** Structural safety + sanity checks for a generated template (every script must compile, every required part must be drawn). */
export function validateTemplate(src: string): TemplateCheck {
  if (src.length < 1500) return { ok: false, reason: `too short (${src.length} chars)` };
  if (Buffer.byteLength(src, "utf8") > MAX_BYTES) return { ok: false, reason: `too large (${Math.round(src.length / 1024)} KB)` };
  if (!src.includes("window.render")) return { ok: false, reason: "missing window.render" };
  for (const [re, what] of BANNED) if (re.test(src)) return { ok: false, reason: `uses ${what}` };
  if (!/trinity\.esc|\besc\s*\(/.test(src)) return { ok: false, reason: "doesn't escape state text with trinity.esc" };
  const missing = missingViewParts(src);
  if (missing.length) return { ok: false, reason: `doesn't draw state.${missing.join(", state.")}` };
  // Full-width 16:9 scene art expands with the column and shoves the rest of the board off-screen.
  if (/\.(?:scene-art|art)\s*\{[^}]*aspect-ratio\s*:\s*16\s*\/\s*9/i.test(src)) {
    return { ok: false, reason: "scene art uses unconstrained aspect-ratio:16/9 (must use a fixed max-height frame)" };
  }
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
