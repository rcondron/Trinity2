import crypto from "node:crypto";
import { getImageJob, requestImage, type ImageKind } from "../services/images.js";
import { live } from "../settings.js";
import { registerTool } from "../tools/registry.js";
import type { Persona, Tool, ToolContext, ToolResult } from "../types.js";
import {
  abilityMod,
  aOrAn,
  capped,
  changeFromWords,
  firstSentence,
  frameFromWords,
  genGameFrame,
  genLoot,
  genNpc,
  genPlayerChange,
  genPlayers,
  genRoll,
  genScene,
  hasAdventureDetails,
  heroesFromWords,
  hpFor,
  lootFromWords,
  npcFromWords,
  parseHeroes,
  applyPlayerChange,
  sceneFromWords,
  type GameFrame,
  type GeneratedPlayer,
  type RollSpec,
  type SceneDraft,
} from "./generate.js";
import { presentGame, presentIfCurrent, setBusy } from "./present.js";
import { isFramed, realPlayers, setupView } from "./setup.js";
import {
  MAX_PLAYERS,
  NEW_GAME_TITLE,
  PLACEHOLDER_NAMES,
  addLog,
  createGame,
  defaultTheme,
  emptySlot,
  getActiveGame,
  getGame,
  listGames,
  mutateGame,
  newId,
  placeholderSlot,
  releasePlaceholder,
  setActiveGame,
  setCustomTemplate,
  setImageStatus,
  subscribeGameChanges,
  trackPlaceholder,
} from "./store.js";
import { frameKey, startCustomTemplate } from "./template-gen.js";
import type { Game, ImageSlot, Item, Location, Npc, Player, Roll, Stats } from "./types.js";

/**
 * The Game Master's toolset (toolset "game"). Every tool follows the same rhythm so the
 * screen feels instant and the spoken reply can name things:
 *   1. an immediate mutation + present (placeholder card / busy label) — the workspace reacts in ~100ms,
 *   2. the fast-model generation, awaited with a hard cap and deterministic fallback content,
 *   3. art requested fire-and-forget (slot "pending" → "ready"/"error" via mutateGame when done),
 *   4. a log entry,
 *   5. `{ok, say}` = what happened + (during setup) "Setup next: …" for the reply writer.
 */

/** Hard cap on awaited generation (the agent core times tools out at 10s+). */
const GEN_CAP_MS = 8000;
/** Model request budget, inside the cap. */
const GEN_TIMEOUT_MS = 7500;

const NO_GAME: ToolResult = { ok: false, say: "There's no game running yet — say you want to start a new game." };

// ─── Small helpers ───────────────────────────────────────────────────────────

function wordsOf(args: Record<string, unknown>, ctx: ToolContext): string {
  const u = typeof ctx.utterance === "string" ? ctx.utterance.trim() : "";
  if (u) return u;
  for (const k of ["text", "utterance", "description", "instruction", "query"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** The last few turns, for generators that benefit from context (e.g. "I'm a dwarf" after "I'm Thorin"). */
function recentLines(ctx: ToolContext, utterance: string): string[] {
  const turns = (ctx.recentTranscript ?? []).slice(-6);
  const last = turns[turns.length - 1];
  const body = last && last.text.trim() === utterance.trim() ? turns.slice(0, -1) : turns;
  return body
    .filter((t) => t.text.trim())
    .slice(-4)
    .map((t) => `${t.speaker === "user" ? "Player" : t.speaker === "trinity" ? "Game Master" : "Note"}: ${t.text.trim().slice(0, 300)}`);
}

const partyWord = (g: Game) => (g.theme.labels.party || "Party").toLowerCase();

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function withSetup(game: Game | null, text: string): string {
  const next = game ? setupView(game).next : null;
  return next ? `${text} Setup next: ${next}` : text;
}

function genrePhrase(genre: string): string {
  const g = genre.trim() || "fantasy";
  return /\b(adventure|campaign|game|story|saga|tale|mystery|quest|odyssey|thriller|survival)\b/i.test(g) ? aOrAn(g) : `${aOrAn(g)} adventure`;
}

function heroLine(p: Player): string {
  return `${p.race} ${p.className}`.trim() || "hero";
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function sameName(a: string, b: string): boolean {
  const x = norm(a).replace(/^the /, "");
  const y = norm(b).replace(/^the /, "");
  return x.length > 0 && x === y;
}

const FIRST_PERSON = /\b(i|i'm|im|i'll|me|my|mine|myself)\b/i;
const PRONOUN = /\b(he|she|they|him|her|them|his|hers|their)\b/i;

/** A party member named in the text (full or first name, whole words; earliest mention wins). */
export function findPlayerByName(game: Game, text: string): Player | null {
  const t = ` ${norm(text)} `;
  let best: { p: Player; at: number; len: number } | null = null;
  for (const p of realPlayers(game)) {
    const full = norm(p.name);
    const first = full.split(" ")[0] ?? "";
    for (const cand of new Set([full, first])) {
      if (cand.length < 2) continue;
      const at = t.indexOf(` ${cand} `);
      if (at >= 0 && (!best || at < best.at || (at === best.at && cand.length > best.len))) best = { p, at, len: cand.length };
    }
  }
  return best?.p ?? null;
}

interface ResolveOpts {
  /** Use the only party member when nobody is named. */
  single?: boolean;
  /** Use the most recently active player when the words refer to someone by pronoun. */
  pronoun?: boolean;
  /** Use the only (or active) player when the words are first-person ("I roll…"). */
  firstPerson?: boolean;
}

function resolvePlayer(game: Game, arg: unknown, utterance: string, opts: ResolveOpts = {}): Player | null {
  const heroes = realPlayers(game);
  if (typeof arg === "string" && arg.trim()) {
    const byId = heroes.find((p) => p.id === arg.trim());
    if (byId) return byId;
    const byName = findPlayerByName(game, arg);
    if (byName) return byName;
  }
  const named = findPlayerByName(game, utterance);
  if (named) return named;
  const active = heroes.find((p) => p.id === game.activePlayerId) ?? null;
  if (opts.firstPerson && FIRST_PERSON.test(utterance)) return heroes.length === 1 ? heroes[0]! : active;
  if (opts.single && heroes.length === 1) return heroes[0]!;
  if (opts.pronoun && PRONOUN.test(utterance)) return active;
  return null;
}

// ─── Art ─────────────────────────────────────────────────────────────────────

/**
 * Request an image fire-and-forget and return its slot (status "pending"; set to
 * "ready"/"error" through mutateGame when it lands). Safe to call inside a mutator.
 * `busyText` labels the work on screen; null paints quietly (e.g. starting-gear icons).
 */
export function paint(game: Game, kind: ImageKind, prompt: string, busyText: string | null): ImageSlot {
  const p = prompt.replace(/\s+/g, " ").trim().slice(0, 900);
  if (!p || !live.mordiem) return emptySlot();
  const { id, done } = requestImage(p, kind, { style: game.artStyle || undefined });
  const job = getImageJob(id);
  if (job && job.status !== "pending") return { id, status: job.status };
  const gameId = game.id;
  const key = `art:${id}`;
  if (busyText) setBusy(gameId, key, busyText);
  void done
    .then(async (j) => {
      await mutateGame(gameId, (g) => {
        setImageStatus(g, id, j.status === "ready" ? "ready" : "error");
      });
    })
    .finally(() => {
      if (busyText) setBusy(gameId, key, null);
    });
  return { id, status: "pending" };
}

const portraitPrompt = (p: Player) => `${heroLine(p)}. ${p.appearance}`;

// ─── Entities ────────────────────────────────────────────────────────────────

function placeholderPlayer(id: string, name: string): Player {
  return {
    id,
    name,
    race: "",
    className: "",
    level: 1,
    hp: 1,
    maxHp: 1,
    ac: 10,
    speed: 30,
    stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    background: "",
    traits: [],
    conditions: [],
    gold: 0,
    xp: 0,
    inventory: [],
    notes: "",
    appearance: "",
    portrait: placeholderSlot(),
    pending: true,
  };
}

/** Marks auto-created starting gear, so a revised sheet replaces it (and nothing found later). */
const STARTING_GEAR = "starting gear";

/** A hero's starting gear; each icon is painted quietly (no busy label per item, lowest priority). */
function gearItems(g: Game, h: GeneratedPlayer, ownerId: string): Item[] {
  return h.gear.map((gd) => ({
    id: newId(),
    name: gd.name,
    type: gd.type,
    rarity: "common",
    description: "",
    properties: [STARTING_GEAR],
    ownerId,
    appearance: gd.name,
    icon: paint(g, "icon", `${gd.name}, ${gd.type}`, null),
  }));
}

/** A generated hero → a real party member with starting gear and a portrait on the way. */
function materializePlayer(g: Game, h: GeneratedPlayer, id: string): Player {
  const { gear: _gear, reviseOf: _revise, ...sheet } = h;
  const p: Player = { ...sheet, id, inventory: [], conditions: [], portrait: emptySlot() };
  delete p.pending;
  // Portrait first: priority only orders queued art, and whatever asks first takes a free slot.
  p.portrait = paint(g, "portrait", portraitPrompt(p), `Painting ${p.name}'s portrait…`);
  const items = gearItems(g, h, id);
  g.items.push(...items);
  p.inventory = items.map((i) => i.id);
  return p;
}

/** Auto-created starting gear: marked — or, in games saved before the marker, common with no description and no art. */
const isStartingGear = (it: Item, ownerId: string) =>
  it.ownerId === ownerId &&
  (it.properties.includes(STARTING_GEAR) || (it.rarity === "common" && !it.description && it.icon.status === "none" && !it.icon.id));

/** New details for an existing hero ("I'm Thorin" … "I'm a dwarf fighter"). Keeps id, progress and loot. */
function reviseSheet(g: Game, p: Player, h: GeneratedPlayer): void {
  const looksChanged = norm(heroLine(p)) !== norm(heroLine(h)) || norm(p.appearance) !== norm(h.appearance);
  const full = p.hp >= p.maxHp;
  p.race = h.race;
  p.className = h.className;
  p.stats = { ...h.stats };
  p.maxHp = hpFor(p.className, p.stats.con, p.level);
  p.hp = full ? p.maxHp : Math.min(p.hp, p.maxHp);
  p.ac = h.ac;
  p.speed = h.speed;
  if (h.background) p.background = h.background;
  if (h.traits.length) p.traits = [...h.traits];
  if (h.appearance) p.appearance = h.appearance;
  if (looksChanged || p.portrait.status === "none" || p.portrait.status === "error")
    p.portrait = paint(g, "portrait", portraitPrompt(p), `Painting ${p.name}'s portrait…`);
  if (g.phase === "setup") {
    g.items = g.items.filter((it) => !isStartingGear(it, p.id));
    const items = gearItems(g, h, p.id);
    g.items.push(...items);
    p.inventory = g.items.filter((it) => it.ownerId === p.id).map((it) => it.id);
  }
}

/** A new name for an existing hero: only one the player actually said (the model may invent one) that nobody else has. */
function statedRename(g: Game, p: Player, h: GeneratedPlayer, utterance: string): string | null {
  const name = h.name.trim();
  if (!name || sameName(p.name, name) || !` ${norm(utterance)} `.includes(` ${norm(name)} `)) return null;
  return realPlayers(g).some((o) => o.id !== p.id && sameName(o.name, name)) ? null : name;
}

function matchExisting(g: Game, h: GeneratedPlayer): Player | null {
  const heroes = realPlayers(g);
  if (h.reviseOf) {
    const byRevise = heroes.find((p) => sameName(p.name, h.reviseOf!)) ?? findPlayerByName(g, h.reviseOf);
    if (byRevise) return byRevise;
  }
  return heroes.find((p) => sameName(p.name, h.name)) ?? null;
}

function partyLevel(g: Game): number {
  const heroes = realPlayers(g);
  if (!heroes.length) return 1;
  return Math.max(1, Math.round(heroes.reduce((s, p) => s + p.level, 0) / heroes.length));
}

// ─── Map ─────────────────────────────────────────────────────────────────────

/** A spot near `from` (normalized 0.08–0.92), as far as possible from every other place. */
function placeNear(g: Game, from: Location | null): { x: number; y: number } {
  const clamp = (v: number) => Math.min(0.92, Math.max(0.08, v));
  const anchor = from ?? g.locations[g.locations.length - 1] ?? null;
  if (!anchor) return { x: 0.5, y: 0.5 };
  const base = Math.random() * Math.PI * 2;
  let best = { x: clamp(anchor.x + 0.2), y: clamp(anchor.y), score: -Infinity };
  for (let i = 0; i < 24; i++) {
    const ang = base + (i / 24) * Math.PI * 2;
    for (const dist of [0.22, 0.17, 0.28]) {
      const rx = anchor.x + Math.cos(ang) * dist;
      const ry = anchor.y + Math.sin(ang) * dist * 0.85;
      const x = clamp(rx);
      const y = clamp(ry);
      const nearest = g.locations.reduce((m, o) => Math.min(m, Math.hypot(o.x - x, o.y - y)), Infinity);
      const score = Math.min(nearest, 0.3) - Math.hypot(x - rx, y - ry) * 3 - Math.abs(dist - 0.22) * 0.2;
      if (score > best.score) best = { x, y, score };
    }
  }
  return { x: Math.round(best.x * 1000) / 1000, y: Math.round(best.y * 1000) / 1000 };
}

/**
 * Make a scene current: scene panel, map node (new or revisited, connected to where we were), art, log.
 * Shared by game_set_scene and game_narrate, so every scene change moves the party on the map.
 */
export function applyScene(g: Game, s: SceneDraft, advanceRound: boolean): void {
  const image = paint(g, "scene", s.imagePrompt, `Painting ${s.title}…`);
  g.scene = { title: s.title, description: s.description, image };
  const prev = g.locations.find((l) => l.id === g.currentLocationId) ?? null;
  let loc = g.locations.find((l) => sameName(l.name, s.locationName)) ?? null;
  if (!loc) {
    const pos = placeNear(g, prev);
    loc = {
      id: newId(),
      name: s.locationName,
      description: s.summary,
      x: pos.x,
      y: pos.y,
      connections: [],
      visited: true,
      image: { ...image },
    };
    g.locations.push(loc);
  } else {
    loc.visited = true;
    if (s.summary) loc.description = s.summary;
    if (image.id) loc.image = { ...image };
  }
  if (prev && prev.id !== loc.id) {
    if (!prev.connections.includes(loc.id)) prev.connections.push(loc.id);
    if (!loc.connections.includes(prev.id)) loc.connections.push(prev.id);
  }
  g.currentLocationId = loc.id;
  if (advanceRound && g.phase === "playing") g.round = Math.max(1, g.round) + 1;
  addLog(g, "narration", `${s.title}: ${firstSentence(s.description)}`);
}

// ─── Dice ────────────────────────────────────────────────────────────────────

const fmtMod = (m: number) => (m > 0 ? `+${m}` : m < 0 ? `${m}` : "");

function abilityBonus(p: Player | null, ability: RollSpec["ability"]): number {
  if (!p || !ability) return 0;
  const s = p.stats;
  if (ability === "attack") return Math.max(abilityMod(s.str), abilityMod(s.dex));
  if (ability === "spell") {
    const c = p.className.toLowerCase();
    const key: keyof Stats = /wizard|mage|artificer|scientist|engineer|hacker|inventor|necromancer/.test(c)
      ? "int"
      : /cleric|druid|ranger|priest|monk|shaman|medic|healer/.test(c)
        ? "wis"
        : "cha";
    return abilityMod(s[key]);
  }
  return abilityMod(s[ability]);
}

function rollDice(spec: RollSpec, bonus: number): Omit<Roll, "id" | "who" | "label" | "ts"> & { natural: number | null } {
  const modifier = spec.explicitModifier ? spec.modifier : spec.modifier + bonus;
  if (spec.advantage) {
    const a = crypto.randomInt(1, 21);
    const b = crypto.randomInt(1, 21);
    const kept = spec.advantage === "adv" ? Math.max(a, b) : Math.min(a, b);
    return {
      notation: `1d20${fmtMod(modifier)} (${spec.advantage === "adv" ? "advantage" : "disadvantage"})`,
      rolls: [a, b],
      modifier,
      total: kept + modifier,
      natural: kept,
    };
  }
  const rolls = Array.from({ length: spec.count }, () => crypto.randomInt(1, spec.sides + 1));
  return {
    notation: `${spec.count}d${spec.sides}${fmtMod(modifier)}`,
    rolls,
    modifier,
    total: rolls.reduce((a, b) => a + b, 0) + modifier,
    natural: spec.count === 1 && spec.sides === 20 ? (rolls[0] ?? null) : null,
  };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const REFRAME_RE = /\b(instead|actually|rather|change|switch|make it|different|how about)\b/i;

function resetForNewAdventure(g: Game): void {
  g.title = NEW_GAME_TITLE;
  g.genre = "";
  g.tone = "";
  g.setting = "";
  g.artStyle = "";
  g.theme = defaultTheme();
  g.titleImage = emptySlot();
  g.scene = null;
  g.npcs = [];
  g.items = [];
  g.locations = [];
  g.currentLocationId = null;
  g.lastRoll = null;
  g.round = 0;
  g.log = [];
  g.players = g.players.filter((p) => p.pending);
}

function applyFrame(g: Game, f: GameFrame): void {
  g.title = f.title;
  g.genre = f.genre;
  g.tone = f.tone;
  g.setting = f.setting;
  g.artStyle = f.artStyle;
  g.theme = f.theme;
  g.titleImage = paint(g, "title", f.titleArtPrompt, "Painting the title art…");
  addLog(g, "system", `New adventure: ${f.title} — ${f.setting}`);
}

async function runNewGame(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const pid = ctx.persona.id;
  const ignore = ctx.persona.name.split(/\s+/).filter(Boolean);
  const details = hasAdventureDetails(utterance, ignore);
  const current = getActiveGame(pid);

  // fresh: a brand-new game · frame: name the adventure of a setup game that has none yet ·
  // restart: an empty setup game gets a new adventure · reframe: "actually, make it sci-fi" keeps the party.
  let mode: "fresh" | "frame" | "restart" = "fresh";
  if (current && current.phase === "setup") {
    if (!isFramed(current)) mode = "frame";
    else if (realPlayers(current).length === 0) mode = "restart";
    else if (details && REFRAME_RE.test(utterance)) return runReframe(ctx, utterance, current);
  }

  let gameId: string;
  if (mode === "fresh" || !current) {
    const g = createGame(pid);
    setActiveGame(pid, g.id);
    invalidateSnapshots();
    gameId = g.id;
  } else {
    gameId = current.id;
    if (mode === "restart") {
      await mutateGame(gameId, resetForNewAdventure);
      setCustomTemplate(gameId, null);
    }
  }

  const askAdventure = () => {
    const g = getGame(gameId);
    const lead =
      mode === "fresh" ? "Opened a fresh game table." : mode === "restart" ? "Cleared the table for a brand-new adventure." : "The game table is ready.";
    return { ok: true, say: withSetup(g, lead) };
  };

  if (!details) {
    presentIfCurrent(gameId);
    return askAdventure();
  }
  setBusy(gameId, "frame", "Imagining the adventure…");
  presentIfCurrent(gameId);
  try {
    const frame = await capped(
      genGameFrame(utterance, { timeoutMs: GEN_TIMEOUT_MS, ignoreWords: ignore }),
      GEN_CAP_MS,
      () => frameFromWords(utterance, ignore),
    );
    if (!frame.described) return askAdventure();
    const saved = await mutateGame(gameId, (g) => applyFrame(g, frame));
    if (!saved) return { ok: false, say: "The game table vanished before it was set up — try starting a new game again." };
    if (mode !== "fresh") setCustomTemplate(gameId, null);
    startCustomTemplate(gameId, { fresh: true });
    presentIfCurrent(gameId);
    return { ok: true, say: withSetup(saved, `Started ${saved.title}, ${genrePhrase(saved.genre)}. ${saved.setting}`) };
  } finally {
    setBusy(gameId, "frame", null);
  }
}

/** Adjust the adventure of a game being set up ("make it darker", "call it The Iron Crown"); the party stays. */
async function runReframe(ctx: ToolContext, utterance: string, game: Game): Promise<ToolResult> {
  const ignore = ctx.persona.name.split(/\s+/).filter(Boolean);
  setBusy(game.id, "frame", "Reworking the adventure…");
  presentGame(game.id);
  try {
    const frame = await capped<GameFrame | null>(
      genGameFrame(utterance, { timeoutMs: GEN_TIMEOUT_MS, ignoreWords: ignore, current: game }),
      GEN_CAP_MS,
      () => null,
    );
    // A canned fallback frame would throw away the real one — say so instead.
    if (!frame || frame.source === "fallback") return { ok: false, say: "I couldn't rework the adventure just now — say what to change once more." };
    if (!frame.described) return { ok: true, say: withSetup(game, `The adventure stays ${game.title}.`) };
    const before = frameKey(game);
    const saved = await mutateGame(game.id, (g) => {
      const lookChanged =
        norm(g.genre) !== norm(frame.genre) ||
        norm(g.tone) !== norm(frame.tone) ||
        norm(g.setting) !== norm(frame.setting) ||
        norm(g.artStyle) !== norm(frame.artStyle);
      g.title = frame.title;
      g.genre = frame.genre;
      g.tone = frame.tone;
      g.setting = frame.setting;
      if (lookChanged) {
        g.artStyle = frame.artStyle;
        g.theme = frame.theme;
        g.titleImage = paint(g, "title", frame.titleArtPrompt, "Painting the title art…");
      }
      addLog(g, "system", `The adventure is reshaped: ${frame.title} — ${frame.setting}`);
    });
    if (!saved) return { ok: false, say: "The game was closed before the adventure could change." };
    if (frameKey(saved) !== before) {
      setCustomTemplate(saved.id, null);
      startCustomTemplate(saved.id, { fresh: true });
    }
    presentIfCurrent(saved.id);
    return { ok: true, say: withSetup(saved, `Updated the adventure: ${saved.title}, ${genrePhrase(saved.genre)}. ${saved.setting}`) };
  } finally {
    setBusy(game.id, "frame", null);
  }
}

/** Set the kind of adventure while setting up: frames a game that has none, adjusts one that has. */
async function runConfigure(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (game?.phase === "playing")
    return { ok: false, say: `${game.title} is already underway — start a new game to play something different.` };
  if (game && isFramed(game)) return runReframe(ctx, utterance, game);
  return runNewGame(ctx, utterance); // no game yet → create one; a setup game without a frame → frame it
}

async function runAddPlayer(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const room = MAX_PLAYERS - realPlayers(game).length;
  if (room <= 0) return { ok: false, say: `The ${partyWord(game)} is full — ${MAX_PLAYERS} heroes is the most the table can hold.` };

  // Placeholder cards right away (named when the words make it unambiguous).
  const guesses = parseHeroes(utterance);
  const strong = guesses.length > 0 && guesses.every((h) => h.name && (h.race || h.className));
  const count = Math.min(room, strong ? guesses.length : Math.max(1, guesses.filter((h) => h.race || h.className).length));
  const ids = Array.from({ length: count }, () => newId());
  ids.forEach(trackPlaceholder);
  const busyKey = `sheet:${ids[0]}`;
  try {
    await mutateGame(game.id, (g) => {
      ids.forEach((id, i) =>
        g.players.push(placeholderPlayer(id, strong ? (guesses[i]?.name ?? PLACEHOLDER_NAMES.player) : PLACEHOLDER_NAMES.player)),
      );
    });
    const names = strong ? guesses.map((h) => h.name!).slice(0, count) : [];
    setBusy(game.id, busyKey, names.length ? `Creating ${listNames(names)}…` : "Creating a new hero…");
    presentIfCurrent(game.id);

    const fresh = getGame(game.id) ?? game;
    const level = fresh.phase === "playing" ? partyLevel(fresh) : 1;
    const heroes = await capped(
      genPlayers(utterance, fresh, { recent: recentLines(ctx, utterance), level, timeoutMs: GEN_TIMEOUT_MS }),
      GEN_CAP_MS,
      () => heroesFromWords(utterance, fresh, level),
    );

    const out = { added: [] as Player[], revised: [] as Player[] };
    const saved = await mutateGame(game.id, (g) => {
      const queue = [...ids];
      for (const h of heroes) {
        const existing = matchExisting(g, h);
        if (existing) {
          // The model sometimes repeats a hero who already joined (from the recent talk), even one
          // the words mention. Only a new race or class (which re-rolls the sheet) or a new name the
          // player said is a revision; re-rolling an unchanged echo would throw the hero's sheet away.
          const rename = statedRename(g, existing, h, utterance);
          const recast = norm(heroLine(existing)) !== norm(heroLine(h));
          if (!rename && !recast) continue;
          if (rename) existing.name = rename;
          if (recast) reviseSheet(g, existing, h);
          if (!out.revised.includes(existing)) out.revised.push(existing);
          continue;
        }
        if (realPlayers(g).length >= MAX_PLAYERS) break;
        const phId = queue.shift();
        const at = phId ? g.players.findIndex((p) => p.id === phId) : -1;
        const p = materializePlayer(g, h, phId ?? newId());
        if (at >= 0) g.players[at] = p;
        else g.players.push(p);
        out.added.push(p);
      }
      g.players = g.players.filter((p) => !(p.pending && queue.includes(p.id)));
      const focus = out.added[0] ?? out.revised[0];
      if (focus) g.activePlayerId = focus.id;
      for (const p of out.added) addLog(g, "party", `${p.name}, ${aOrAn(heroLine(p).toLowerCase())}, joins the ${partyWord(g)}.`);
      for (const p of out.revised) addLog(g, "party", `${p.name}'s character sheet is updated: ${heroLine(p)}.`);
    });
    if (!saved) return { ok: false, say: "The game was closed before the new hero could join." };
    presentIfCurrent(saved);

    const party = partyWord(saved);
    const parts: string[] = [];
    const { added, revised } = out;
    if (added.length === 1) {
      const p = added[0]!;
      parts.push(
        `${p.name} joins the ${party}: ${aOrAn(heroLine(p))}${p.background ? ` (${p.background})` : ""} with ${p.maxHp} HP and AC ${p.ac}.` +
          (p.traits[0] ? ` Trait: ${p.traits[0]}.` : ""),
      );
    } else if (added.length > 1) {
      parts.push(`${listNames(added.map((p) => p.name))} join the ${party}: ${added.map((p) => `${p.name} the ${heroLine(p)}`).join(", ")}.`);
    }
    for (const p of revised) parts.push(`Updated ${p.name}: now ${aOrAn(heroLine(p))} with ${p.maxHp} HP and AC ${p.ac}.`);
    if (!parts.length) {
      // Nobody joined: a full table, or words that only echoed heroes who are already here.
      const why =
        realPlayers(saved).length >= MAX_PLAYERS
          ? `The ${party} is full — no room for another hero.`
          : "I couldn't make out the new hero — tell me their name, race and class.";
      return { ok: false, say: withSetup(saved, why) };
    }
    return { ok: true, say: withSetup(saved, parts.join(" ")) };
  } finally {
    ids.forEach(releasePlaceholder);
    setBusy(game.id, busyKey, null);
  }
}

async function runUpdatePlayer(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const heroes = realPlayers(game);
  const player = resolvePlayer(game, args.player, utterance, { single: true, pronoun: true, firstPerson: true });
  if (!player) {
    return {
      ok: false,
      say: heroes.length ? `Which character — ${listNames(heroes.map((p) => p.name))}?` : `There's nobody in the ${partyWord(game)} yet.`,
    };
  }
  const busyKey = `update:${player.id}:${newId()}`;
  setBusy(game.id, busyKey, `Updating ${player.name}…`);
  try {
    await mutateGame(game.id, (g) => {
      g.activePlayerId = player.id;
    });
    presentIfCurrent(game.id);
    const fresh = getGame(game.id) ?? game;
    const current = fresh.players.find((p) => p.id === player.id) ?? player;
    const change = await capped(genPlayerChange(current, utterance, fresh, { timeoutMs: 7000 }), 7500, () =>
      changeFromWords(utterance, current),
    );
    const out = { summary: "", changed: false };
    const saved = await mutateGame(game.id, (g) => {
      const p = g.players.find((x) => x.id === player.id);
      if (!p) return;
      const r = applyPlayerChange(p, change);
      out.summary = r.summary;
      out.changed = r.changed;
      if (r.changed) addLog(g, r.kind, r.summary);
    });
    if (!saved) return { ok: false, say: "The game was closed before that could be recorded." };
    if (!out.changed) return { ok: false, say: `I couldn't tell what changed for ${player.name} — try "${player.name} takes 5 damage".` };
    return { ok: true, say: withSetup(saved, `${out.summary}.`) };
  } finally {
    setBusy(game.id, busyKey, null);
  }
}

async function runRemovePlayer(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const heroes = realPlayers(game);
  const player = resolvePlayer(game, args.player, utterance, {});
  if (!player) {
    return {
      ok: false,
      say: heroes.length ? `Who should leave the ${partyWord(game)} — ${listNames(heroes.map((p) => p.name))}?` : `There's nobody in the ${partyWord(game)} to remove.`,
    };
  }
  const out = { removed: false, hadGear: false };
  const saved = await mutateGame(game.id, (g) => {
    const at = g.players.findIndex((p) => p.id === player.id);
    if (at < 0) return;
    g.players.splice(at, 1);
    for (const it of g.items) {
      if (it.ownerId === player.id) {
        it.ownerId = null;
        out.hadGear = true;
      }
    }
    if (g.activePlayerId === player.id) g.activePlayerId = null;
    addLog(g, "party", `${player.name} leaves the ${partyWord(g)}.`);
    out.removed = true;
  });
  if (!saved) return { ok: false, say: "The game was closed before that could be recorded." };
  presentIfCurrent(saved.id);
  if (!out.removed) return { ok: false, say: `${player.name} isn't in the ${partyWord(saved)} anymore.` };
  const party = partyWord(saved);
  return { ok: true, say: withSetup(saved, `${player.name} has left the ${party}${out.hadGear ? `; their gear stays with the ${party}` : ""}.`) };
}

async function runAddItem(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const owner =
    args.owner === "party" ? null : resolvePlayer(game, args.owner, utterance, { firstPerson: realPlayers(game).length === 1 });
  const phId = newId();
  trackPlaceholder(phId);
  const busyKey = `item:${phId}`;
  try {
    await mutateGame(game.id, (g) => {
      g.items.push({
        id: phId,
        name: PLACEHOLDER_NAMES.item,
        type: "gear",
        rarity: "common",
        description: "",
        properties: [],
        ownerId: owner?.id ?? null,
        appearance: "",
        icon: placeholderSlot(),
      });
    });
    setBusy(game.id, busyKey, owner ? `Finding something for ${owner.name}…` : "Unpacking the loot…");
    presentIfCurrent(game.id);

    const fresh = getGame(game.id) ?? game;
    const loot = await capped(genLoot(utterance, fresh, owner?.name ?? null, { timeoutMs: GEN_TIMEOUT_MS }), GEN_CAP_MS, () =>
      lootFromWords(utterance, fresh),
    );

    const out = { made: [] as Item[], gold: 0, holder: null as string | null };
    const saved = await mutateGame(game.id, (g) => {
      const holder = owner ? (realPlayers(g).find((p) => p.id === owner.id) ?? null) : null;
      out.holder = holder?.name ?? null;
      const at = g.items.findIndex((it) => it.id === phId);
      if (at >= 0) g.items.splice(at, 1);
      const made: Item[] = loot.items.map((d, i) => ({
        id: i === 0 ? phId : newId(),
        name: d.name,
        type: d.type,
        rarity: d.rarity,
        description: d.description,
        properties: d.properties,
        ownerId: holder?.id ?? null,
        appearance: d.appearance,
        icon: emptySlot(),
      }));
      for (const it of made) it.icon = paint(g, "icon", `${it.name}: ${it.appearance}`, `Painting the ${it.name}…`);
      if (loot.gold > 0) {
        if (holder) {
          holder.gold += loot.gold;
          out.gold = loot.gold;
        } else {
          made.push({
            id: newId(),
            name: `Pouch of ${loot.gold} gold`,
            type: "treasure",
            rarity: "common",
            description: `${loot.gold} gold coins, shared by the ${partyWord(g)}.`,
            properties: [],
            ownerId: null,
            appearance: "a leather coin pouch",
            icon: emptySlot(),
          });
        }
      }
      g.items.splice(at >= 0 ? at : g.items.length, 0, ...made);
      if (holder) {
        holder.inventory.push(...made.map((it) => it.id));
        g.activePlayerId = holder.id;
      }
      out.made = made;
      const what = listNames([...made.map((it) => it.name), ...(out.gold ? [`${out.gold} gold`] : [])]);
      if (what) addLog(g, "loot", holder ? `${holder.name} receives ${what}.` : `The ${partyWord(g)} gains ${what}.`);
    });
    if (!saved) return { ok: false, say: "The game was closed before the item could be added." };
    presentIfCurrent(saved.id);

    const party = partyWord(saved);
    const { made, gold, holder } = out;
    let say: string;
    if (made.length === 1) {
      const it = made[0]!;
      const kind = aOrAn(`${it.rarity} ${it.type}`);
      say = holder
        ? `Gave ${holder} the ${it.name}, ${kind}${it.description ? `: ${it.description}` : "."}`
        : `Added the ${it.name} to the ${party}'s loot — ${kind}${it.description ? `: ${it.description}` : "."}`;
    } else if (made.length > 1) {
      say = holder ? `Gave ${holder} ${listNames(made.map((it) => it.name))}.` : `Added ${listNames(made.map((it) => it.name))} to the ${party}'s loot.`;
    } else {
      say = holder ? `${holder} gains ${gold} gold.` : `The ${party} gains ${gold} gold.`;
    }
    if (made.length && gold && holder) say += ` Plus ${gold} gold.`;
    return { ok: true, say: withSetup(saved, say) };
  } finally {
    releasePlaceholder(phId);
    setBusy(game.id, busyKey, null);
  }
}

async function runAddNpc(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const phId = newId();
  trackPlaceholder(phId);
  const busyKey = `npc:${phId}`;
  try {
    await mutateGame(game.id, (g) => {
      g.npcs.push({
        id: phId,
        name: PLACEHOLDER_NAMES.npc,
        role: "",
        description: "",
        attitude: "unknown",
        appearance: "",
        portrait: placeholderSlot(),
      });
    });
    setBusy(game.id, busyKey, "Someone new enters the story…");
    presentIfCurrent(game.id);

    const fresh = getGame(game.id) ?? game;
    const npc = await capped(genNpc(utterance, fresh, { timeoutMs: GEN_TIMEOUT_MS }), GEN_CAP_MS, () => npcFromWords(utterance, fresh));

    const out = { returning: false };
    const saved = await mutateGame(game.id, (g) => {
      const at = g.npcs.findIndex((n) => n.id === phId);
      const existing = g.npcs.find((n) => n.id !== phId && sameName(n.name, npc.name));
      if (existing) {
        if (at >= 0) g.npcs.splice(at, 1);
        existing.role = npc.role || existing.role;
        existing.description = npc.description || existing.description;
        existing.attitude = npc.attitude;
        if (npc.appearance) existing.appearance = npc.appearance;
        if (existing.portrait.status === "none" || existing.portrait.status === "error")
          existing.portrait = paint(g, "portrait", `${existing.role}: ${existing.appearance}`, `Painting ${existing.name}…`);
        out.returning = true;
        addLog(g, "narration", `${existing.name} returns.`);
        return;
      }
      const n: Npc = { id: phId, ...npc, portrait: emptySlot() };
      n.portrait = paint(g, "portrait", `${npc.role}: ${npc.appearance}`, `Painting ${npc.name}…`);
      if (at >= 0) g.npcs[at] = n;
      else g.npcs.push(n);
      addLog(g, "narration", `${npc.name}, ${aOrAn(npc.role || "stranger")}, enters the story.`);
    });
    if (!saved) return { ok: false, say: "The game was closed before they could appear." };
    presentIfCurrent(saved.id);
    const lead = out.returning ? `${npc.name} is back` : `Introduced ${npc.name}, ${aOrAn(npc.role || "stranger")}`;
    return { ok: true, say: withSetup(saved, `${lead} (${npc.attitude}): ${npc.description}`) };
  } finally {
    releasePlaceholder(phId);
    setBusy(game.id, busyKey, null);
  }
}

async function runSetScene(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  // During setup, an answer to "what kind of adventure?" can land here — treat it as the frame.
  if (game.phase === "setup" && !isFramed(game) && hasAdventureDetails(utterance, ctx.persona.name.split(/\s+/)))
    return runNewGame(ctx, utterance);
  const busyKey = `scene:${newId()}`;
  setBusy(game.id, busyKey, "Setting the scene…");
  presentGame(game.id);
  try {
    const fresh = getGame(game.id) ?? game;
    const draft = await capped(genScene(utterance, fresh, { timeoutMs: GEN_TIMEOUT_MS }), GEN_CAP_MS, () =>
      sceneFromWords(utterance, fresh),
    );
    const saved = await mutateGame(game.id, (g) => applyScene(g, draft, true));
    if (!saved) return { ok: false, say: "The game was closed before the scene could be set." };
    presentIfCurrent(saved.id);
    const say = withSetup(saved, `New scene — ${draft.title}: ${draft.description}`);
    // While playing, the GM reads the scene exactly as it appears on screen.
    return saved.phase === "playing" ? { ok: true, say, speak: draft.description } : { ok: true, say };
  } finally {
    setBusy(game.id, busyKey, null);
  }
}

async function runRoll(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const player = args.player === "gm" ? null : resolvePlayer(game, args.player, utterance, { firstPerson: true });
  const spec = await capped(genRoll(utterance, { timeoutMs: 4000 }), 4500, (): RollSpec => ({
    count: 1,
    sides: 20,
    modifier: 0,
    explicitModifier: false,
    advantage: null,
    notation: "1d20",
    label: null,
    ability: null,
  }));
  const bonus = abilityBonus(player, spec.ability);
  const r = rollDice(spec, bonus);
  const who = player?.name ?? null;
  const roll: Roll = {
    id: newId(),
    who,
    notation: r.notation,
    rolls: r.rolls,
    modifier: r.modifier,
    total: r.total,
    label: spec.label,
    ts: Date.now(),
  };
  const dice = spec.advantage ? `${r.rolls.join(" and ")}, kept ${r.natural}` : r.rolls.join(" + ");
  const detail = `${r.notation}: ${dice}${r.modifier && !spec.advantage ? ` ${r.modifier > 0 ? "+" : "−"} ${Math.abs(r.modifier)}` : ""}`;
  const crit = r.natural === 20 ? " — a natural 20!" : r.natural === 1 ? " — a natural 1!" : "";
  const saved = await mutateGame(game.id, (g) => {
    g.lastRoll = roll;
    if (player && g.players.some((p) => p.id === player.id)) g.activePlayerId = player.id;
    addLog(g, "roll", `${who ?? "The Game Master"} rolls ${spec.label ?? r.notation}: ${r.total} (${detail})${crit}`);
  });
  if (!saved) return { ok: false, say: "The game was closed before the roll could be recorded." };
  presentIfCurrent(saved.id);
  const label = spec.label;
  const what = !label
    ? ""
    : /damage|healing/i.test(label)
      ? ` ${label.toLowerCase()}`
      : /^initiative$/i.test(label)
        ? " for initiative"
        : ` on the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return { ok: true, say: withSetup(saved, `${who ?? "The Game Master"} rolled ${r.total}${what} (${detail})${crit}.`) };
}

async function runBegin(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "playing") {
    presentGame(game.id);
    return { ok: true, say: `The adventure is already underway — round ${Math.max(1, game.round)}${game.scene ? `, at ${game.scene.title}` : ""}.` };
  }
  if (!isFramed(game)) return { ok: false, say: withSetup(game, "We can't begin yet — the adventure hasn't been chosen.") };
  const heroes = realPlayers(game);
  if (!heroes.length) return { ok: false, say: withSetup(game, `We can't begin yet — nobody has joined the ${partyWord(game)}.`) };
  const names = listNames(heroes.map((p) => p.name));
  const needScene = !game.scene;
  const busyKey = "opening";
  if (needScene) setBusy(game.id, busyKey, "Setting the opening scene…");
  try {
    const started = await mutateGame(game.id, (g) => {
      g.phase = "playing";
      g.round = Math.max(1, g.round);
      addLog(g, "system", `The adventure begins! ${g.theme.labels.party || "Party"}: ${names}.`);
    });
    if (!started) return { ok: false, say: "The game was closed before it could begin." };
    presentIfCurrent(started.id);
    if (!needScene && game.scene) {
      return {
        ok: true,
        say: `The adventure begins with ${names}! We pick up at ${game.scene.title}: ${game.scene.description}`,
        speak: `Let the adventure begin! ${spokenOpening(game.scene.description)}`,
      };
    }
    const draft = await capped(genScene(utterance, started, { opening: true, timeoutMs: GEN_TIMEOUT_MS }), GEN_CAP_MS, () =>
      sceneFromWords("", started, true),
    );
    const saved = await mutateGame(game.id, (g) => applyScene(g, draft, false));
    if (saved) presentIfCurrent(saved.id);
    return {
      ok: true,
      say: `The adventure begins with ${names}! Opening scene — ${draft.title}: ${draft.description}`,
      speak: `Let the adventure begin! ${spokenOpening(draft.description)}`,
    };
  } finally {
    setBusy(game.id, busyKey, null);
  }
}

/** The opening read aloud: the scene's first few sentences, then the spotlight goes to the players. */
function spokenOpening(description: string): string {
  const head = description
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  return /\?["'”’]?\s*$/.test(head) ? head : `${head} What do you do?`;
}

const TITLE_STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "to", "for", "game", "adventure", "campaign"]);

function resolveGame(personaId: string, arg: unknown, utterance: string): Game | null {
  const games = listGames(personaId);
  if (typeof arg === "string" && arg.trim()) {
    const g = games.find((x) => x.id === arg.trim()) ?? getGame(arg.trim());
    if (g) return g;
  }
  const u = ` ${norm(utterance)} `;
  let best: { g: Game; score: number } | null = null;
  for (const g of games) {
    const words = norm(g.title)
      .split(" ")
      .filter((w) => w.length > 2 && !TITLE_STOP.has(w));
    if (!words.length) continue;
    const score = words.filter((w) => u.includes(` ${w} `)).length / words.length;
    if (score > 0 && (!best || score > best.score)) best = { g, score };
  }
  return best?.g ?? games[0] ?? null;
}

async function runLoad(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const pid = ctx.persona.id;
  const game = resolveGame(pid, args.game, utterance);
  if (!game) return { ok: false, say: "There are no saved games yet — say you want to start a new game." };
  setActiveGame(pid, game.id);
  invalidateSnapshots();
  presentGame(game.id);
  const heroes = realPlayers(game);
  const state = game.phase === "playing" ? `round ${Math.max(1, game.round)}` : "still setting up";
  const party = heroes.length ? `with ${listNames(heroes.map((p) => `${p.name} the ${heroLine(p)}`))}` : `with no heroes yet`;
  const title = isFramed(game) ? `${game.title}, ${genrePhrase(game.genre)}` : "the unfinished new game";
  return {
    ok: true,
    say: withSetup(game, `Loaded ${title} — ${state}, ${party}.${game.scene ? ` We left off at ${game.scene.title}.` : ""}`),
  };
}

// ─── Availability & dynamic options (Jev's choices) ──────────────────────────
// The router asks every tool's `available()` and `options()` on each poll (~400ms), so they
// read a short-lived snapshot of the active game. Every saved change (and every switch of
// the active game) invalidates it, so Jev always sees new heroes immediately.

const snapshots = new Map<string, { at: number; game: Game | null }>();
const savedGames = new Map<string, { at: number; value: Record<string, string> | undefined }>();

function invalidateSnapshots(): void {
  snapshots.clear();
  savedGames.clear();
}
subscribeGameChanges(invalidateSnapshots);

function activeSnapshot(personaId: string): Game | null {
  const hit = snapshots.get(personaId);
  if (hit && Date.now() - hit.at < 300) return hit.game;
  const game = getActiveGame(personaId);
  snapshots.set(personaId, { at: Date.now(), game });
  if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value!);
  return game;
}

function playerOptions(persona: Persona): Record<string, string> | undefined {
  const g = activeSnapshot(persona.id);
  const heroes = g ? realPlayers(g) : [];
  if (!heroes.length) return undefined;
  return Object.fromEntries(heroes.map((p) => [p.id, `${p.name} (${heroLine(p).toLowerCase()})`]));
}

function gameOptions(persona: Persona): Record<string, string> | undefined {
  const hit = savedGames.get(persona.id);
  if (hit && Date.now() - hit.at < 1000) return hit.value;
  const games = listGames(persona.id).slice(0, 12);
  const value = games.length
    ? Object.fromEntries(
        games.map((g) => {
          const n = realPlayers(g).length;
          const title = isFramed(g) ? g.title : "Untitled new game";
          return [g.id, `${title} (${g.genre || "adventure"}, ${n} player${n === 1 ? "" : "s"})`];
        }),
      )
    : undefined;
  savedGames.set(persona.id, { at: Date.now(), value });
  return value;
}

type Avail = (ctx: { persona: Persona }) => boolean;
const hasActiveGame: Avail = ({ persona }) => activeSnapshot(persona.id) !== null;
const inSetup: Avail = ({ persona }) => activeSnapshot(persona.id)?.phase === "setup";
const hasHeroes: Avail = ({ persona }) => {
  const g = activeSnapshot(persona.id);
  return g !== null && realPlayers(g).length > 0;
};
const hasSavedGames: Avail = ({ persona }) => gameOptions(persona) !== undefined;

// ─── Registration ────────────────────────────────────────────────────────────

function guarded(name: string, fn: (args: Record<string, unknown>, ctx: ToolContext, utterance: string) => Promise<ToolResult>) {
  return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const started = Date.now();
    try {
      const res = await fn(args ?? {}, ctx, wordsOf(args ?? {}, ctx));
      console.log(`[game] ${name} ${res.ok ? "ok" : "declined"} in ${Date.now() - started}ms`);
      return res;
    } catch (err) {
      console.warn(`[game] ${name} failed:`, err);
      return { ok: false, say: "Something went wrong at the game table — let's try that again.", error: (err as Error).message };
    }
  };
}

const playerArg = (description: string, required = false) => ({ type: "string", description, required });

const TOOL_DEFS: Tool[] = [
  {
    name: "game_new",
    description: "Start a new game, campaign, or adventure.",
    input: {},
    argMode: "raw",
    run: guarded("game_new", (_a, ctx, u) => runNewGame(ctx, u)),
  },
  {
    name: "game_configure",
    description: "Say or change what kind of adventure this is while it's being set up: genre, setting, tone, or title.",
    input: {},
    argMode: "raw",
    available: inSetup,
    run: guarded("game_configure", (_a, ctx, u) => runConfigure(ctx, u)),
  },
  {
    name: "game_add_player",
    description: "Add a player character to the party — the caller describes a hero (name, race, class) or says who is playing.",
    input: {},
    argMode: "raw",
    available: hasActiveGame,
    run: guarded("game_add_player", (_a, ctx, u) => runAddPlayer(ctx, u)),
  },
  {
    name: "game_update_player",
    description: "Change a player character: damage, healing, HP, level up, XP, gold, conditions, stats, or details like race and class.",
    input: { player: playerArg("Which player character changes") },
    argMode: "raw",
    available: hasHeroes,
    options: (arg, { persona }) => (arg === "player" ? playerOptions(persona) : undefined),
    run: guarded("game_update_player", runUpdatePlayer),
  },
  {
    name: "game_remove_player",
    description: "Remove a character from the party.",
    input: { player: playerArg("Which player character leaves the party", true) },
    argMode: "none",
    available: hasHeroes,
    options: (arg, { persona }) => (arg === "player" ? playerOptions(persona) : undefined),
    run: guarded("game_remove_player", runRemovePlayer),
  },
  {
    name: "game_add_item",
    description: "Give, find, buy, or create an item: weapon, armor, potion, scroll, or treasure.",
    input: { owner: playerArg("Who gets the item — a player character, or the party's shared loot") },
    argMode: "raw",
    available: hasActiveGame,
    options: (arg, { persona }) => {
      if (arg !== "owner") return undefined;
      const players = playerOptions(persona);
      return players ? { ...players, party: "the party (shared loot)" } : undefined;
    },
    run: guarded("game_add_item", runAddItem),
  },
  {
    name: "game_add_npc",
    description: "Introduce a non-player character: villain, ally, shopkeeper, or creature.",
    input: {},
    argMode: "raw",
    available: hasActiveGame,
    run: guarded("game_add_npc", (_a, ctx, u) => runAddNpc(ctx, u)),
  },
  {
    name: "game_set_scene",
    description: "Set or describe the current scene or location, or move the party somewhere new.",
    input: {},
    argMode: "raw",
    available: hasActiveGame,
    run: guarded("game_set_scene", (_a, ctx, u) => runSetScene(ctx, u)),
  },
  {
    name: "game_roll",
    description: "Roll dice for a check, attack, damage, or saving throw.",
    input: { player: playerArg("Who is rolling — a player character, or the Game Master") },
    argMode: "raw",
    supersedes: ["roll_dice"],
    available: hasActiveGame,
    options: (arg, { persona }) => {
      if (arg !== "player") return undefined;
      const players = playerOptions(persona);
      return players ? { ...players, gm: "the Game Master (an NPC, a monster, or nobody in particular)" } : undefined;
    },
    run: guarded("game_roll", runRoll),
  },
  {
    name: "game_begin",
    description: "Finish setup and start playing the adventure.",
    input: {},
    argMode: "none",
    available: inSetup,
    run: guarded("game_begin", (_a, ctx, u) => runBegin(ctx, u)),
  },
  {
    name: "game_load",
    description: "Resume or load a saved game.",
    input: { game: { type: "string", description: "saved game to continue", required: true } },
    argMode: "none",
    available: hasSavedGames,
    options: (arg, { persona }) => (arg === "game" ? gameOptions(persona) : undefined),
    run: guarded("game_load", runLoad),
  },
];

export const gameTools: Tool[] = TOOL_DEFS.map((t) => ({ ...t, toolset: "game", source: "builtin" }));

/** Register the Game Master toolset (visible to personas whose toolsets include "game"). */
export function registerGameTools(): void {
  for (const t of gameTools) registerTool(t);
}
