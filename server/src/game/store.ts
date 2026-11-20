import fs from "node:fs";
import { nanoid } from "nanoid";
import db, { getSetting, setSetting } from "../db/sqlite.js";
import { getImageJob, imagePath } from "../services/images.js";
import { findMonster, genericStatBlock, snapCr, statBlockOf, type StatBlock } from "./bestiary.js";
import { ABILITIES, CONDITIONS, isSkill, parseDice, slotsFor, xpForCr } from "./rules.js";
import { armorStats, classProfile, itemPrice, speciesResistances, weaponStats } from "./srd.js";
import type {
  AbilityKey,
  Adv,
  Attack,
  AttackRider,
  Attitude,
  Breath,
  Clue,
  Combat,
  Combatant,
  Game,
  GamePhase,
  GameTheme,
  ImageSlot,
  ImageStatus,
  Item,
  ItemType,
  Location,
  LogEntry,
  LogKind,
  Npc,
  NpcStatus,
  Pending,
  PendingAction,
  PendingCheck,
  PendingConfirm,
  Player,
  Quest,
  Rarity,
  Roll,
  RollOutcome,
  Scene,
  Secret,
  SetupState,
  Stats,
  Story,
  TableSettings,
} from "./types.js";

/**
 * Game persistence. One row per game in the shared SQLite DB; the game itself is a JSON
 * document (normalized on every load, so old or partial rows always come back complete:
 * a game saved before heroes had spell slots or monsters had stat blocks loads with
 * sensible ones).
 *
 * All writes to a game's data go through `mutateGame`, which serializes mutations per
 * game id: each one re-reads the latest row inside the queue, applies the mutator, saves,
 * then notifies listeners (the presenter). Read-modify-write races are impossible as long
 * as nobody holds a Game across an await and saves it later — there is deliberately no
 * public "saveGame".
 *
 * `checkpointGame` keeps the last few documents of a game (one per story turn) so a turn
 * can be undone.
 */

export const NEW_GAME_TITLE = "New Adventure";
/** Display names of placeholder entities while their content is generated. */
export const PLACEHOLDER_NAMES = { player: "New hero", npc: "A figure approaches…", item: "Revealing…" } as const;
export const MAX_PLAYERS = 8;
/** Stored log length (the view shows the last 200). */
export const MAX_LOG = 500;
/** How many story turns can be undone. */
export const MAX_HISTORY = 20;

export const ITEM_TYPES: readonly ItemType[] = ["weapon", "armor", "potion", "scroll", "wondrous", "gear", "treasure", "quest"];
export const RARITIES: readonly Rarity[] = ["common", "uncommon", "rare", "very rare", "legendary", "artifact"];
export const ATTITUDES: readonly Attitude[] = ["friendly", "neutral", "hostile", "unknown"];
export const LOG_KINDS: readonly LogKind[] = ["narration", "roll", "combat", "loot", "party", "system"];
const IMAGE_STATUSES: readonly ImageStatus[] = ["none", "pending", "ready", "error"];
const FONTS: readonly GameTheme["font"][] = ["serif", "sans", "mono", "display"];
const TEXTURES: readonly GameTheme["texture"][] = ["parchment", "stone", "wood", "hud", "neon", "none"];
const PHASES: readonly GamePhase[] = ["setup", "playing", "paused", "ended"];
const NPC_STATUSES: readonly NpcStatus[] = ["alive", "defeated", "fled"];
const OUTCOMES: readonly RollOutcome[] = ["success", "failure", "hit", "miss", "crit", "fumble"];

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id              TEXT PRIMARY KEY,
    persona_id      TEXT NOT NULL,
    title           TEXT NOT NULL,
    data            TEXT NOT NULL,
    custom_template TEXT,
    created         INTEGER NOT NULL,
    updated         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS games_by_persona ON games (persona_id, updated);
  CREATE TABLE IF NOT EXISTS game_history (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    label   TEXT NOT NULL,
    data    TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS game_history_by_game ON game_history (game_id, seq);
`);

interface GameRow {
  id: string;
  persona_id: string;
  title: string;
  data: string;
  created: number;
  updated: number;
}

const COLS = "id, persona_id, title, data, created, updated";
const stmt = {
  insert: db.prepare(
    `INSERT INTO games (id, persona_id, title, data, custom_template, created, updated)
     VALUES (@id, @personaId, @title, @data, NULL, @created, @updated)`,
  ),
  get: db.prepare(`SELECT ${COLS} FROM games WHERE id = ?`),
  listAll: db.prepare(`SELECT ${COLS} FROM games ORDER BY updated DESC`),
  listByPersona: db.prepare(`SELECT ${COLS} FROM games WHERE persona_id = ? ORDER BY updated DESC`),
  // Never touches custom_template, so template writes and data writes can't clobber each other.
  update: db.prepare(`UPDATE games SET title = @title, data = @data, updated = @updated WHERE id = @id`),
  delete: db.prepare(`DELETE FROM games WHERE id = ?`),
  getTemplate: db.prepare(`SELECT custom_template FROM games WHERE id = ?`),
  setTemplate: db.prepare(`UPDATE games SET custom_template = ? WHERE id = ?`),
  deleteSetting: db.prepare(`DELETE FROM settings WHERE key = ?`),
  rawData: db.prepare(`SELECT data FROM games WHERE id = ?`),
  pushHistory: db.prepare(`INSERT INTO game_history (game_id, label, data, created) VALUES (?, ?, ?, ?)`),
  lastHistory: db.prepare(`SELECT seq, label, data FROM game_history WHERE game_id = ? ORDER BY seq DESC LIMIT 1`),
  dropHistory: db.prepare(`DELETE FROM game_history WHERE seq = ?`),
  trimHistory: db.prepare(
    `DELETE FROM game_history WHERE game_id = ? AND seq NOT IN (SELECT seq FROM game_history WHERE game_id = ? ORDER BY seq DESC LIMIT ?)`,
  ),
  clearHistory: db.prepare(`DELETE FROM game_history WHERE game_id = ?`),
  countHistory: db.prepare(`SELECT COUNT(*) AS n FROM game_history WHERE game_id = ?`),
};

// ─── Ids, defaults ───────────────────────────────────────────────────────────

export function newId(): string {
  return nanoid(10);
}

export function emptySlot(): ImageSlot {
  return { id: null, status: "none" };
}

/** A slot for an entity whose real content is still being generated (shimmer). */
export function placeholderSlot(): ImageSlot {
  return { id: null, status: "pending" };
}

/** Polished dark-fantasy look used until a game's own theme is generated. */
export function defaultTheme(): GameTheme {
  return {
    palette: {
      bg: "#13100d",
      panel: "#1e1914",
      ink: "#f2e8d5",
      muted: "#b6a487",
      accent: "#d9a441",
      accent2: "#c0643b",
      danger: "#e0574c",
      good: "#7cbf6e",
    },
    font: "serif",
    texture: "parchment",
    labels: { party: "Party", scene: "Scene", log: "Adventure Log", npcs: "NPCs", items: "Items & Loot", map: "Map" },
    ornament: "✦",
  };
}

const nine = (xs: number[] = []): number[] => Array.from({ length: 9 }, (_, i) => Math.max(0, Math.round(xs[i] ?? 0)));

/** A complete, empty character sheet: every field a hero has, at its default. */
export function blankPlayer(id: string, name: string): Player {
  return {
    id,
    name,
    playerName: "",
    race: "",
    className: "",
    level: 1,
    hp: 1,
    maxHp: 1,
    tempHp: 0,
    ac: 10,
    speed: 30,
    stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    background: "",
    traits: [],
    conditions: [],
    conditionRounds: {},
    exhaustion: 0,
    gold: 0,
    xp: 0,
    inventory: [],
    notes: "",
    appearance: "",
    portrait: emptySlot(),
    hitDie: 8,
    hitDiceUsed: 0,
    saveProficiencies: [],
    skillProficiencies: [],
    castingAbility: null,
    slotsMax: nine(),
    slotsUsed: nine(),
    spells: [],
    concentration: null,
    inspiration: false,
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    dead: false,
    equipped: { weapon: null, armor: null, shield: null },
    resistances: [],
  };
}

/** A story NPC with a stat block: the bestiary's when its name or role names a creature, a default otherwise. */
export function defaultStatBlock(name: string, role: string, attitude: Attitude): StatBlock {
  const known = findMonster(`${name} ${role}`);
  if (known) return statBlockOf(known);
  return { ...genericStatBlock(attitude === "hostile" ? 0.5 : 0), statted: false };
}

export function emptyStory(premise = ""): Story {
  return {
    premise,
    outline: [],
    beat: 0,
    secrets: [],
    clues: [],
    quests: [],
    facts: [],
    threats: [],
    summary: "",
    summaryTurn: 0,
    turn: 0,
    recentTurns: [],
    lastTurn: "",
    lastNarration: "",
    sessions: 0,
  };
}

export function defaultSettings(): TableSettings {
  return { difficulty: "standard", leveling: "xp", rolls: "ask", avoid: [], expectedPlayers: null, length: null };
}

// ─── Placeholder registry ────────────────────────────────────────────────────
// Placeholders (pending player cards, "a figure approaches…" NPCs, unrevealed items) are
// replaced once generation finishes. If the engine restarts mid-generation they'd shimmer
// forever, so normalization drops any placeholder this process isn't currently filling.

const livePlaceholders = new Set<string>();

export function trackPlaceholder(id: string): void {
  livePlaceholders.add(id);
}
export function releasePlaceholder(id: string): void {
  livePlaceholders.delete(id);
}

// ─── Normalization ───────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const IMG_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function str(v: unknown, max = 2000): string {
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
function num(v: unknown, def: number, min: number, max: number): number {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
}
function int(v: unknown, def: number, min: number, max: number): number {
  return Math.round(num(v, def, min, max));
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function strs(v: unknown, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  for (const x of list(v)) {
    const s = str(x, maxLen).trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}
const lower = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}
function validId(v: unknown): string | null {
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}
function hex(v: unknown, def: string): string {
  if (typeof v !== "string") return def;
  const t = v.trim();
  if (!HEX_RE.test(t)) return def;
  const full = t.length === 4 ? `#${[...t.slice(1)].map((c) => c + c).join("")}` : t;
  return full.toLowerCase();
}
const abilityKey = (v: unknown): AbilityKey | null => (typeof v === "string" && (ABILITIES as readonly string[]).includes(v) ? (v as AbilityKey) : null);
const adv = (v: unknown): Adv => (v === "adv" || v === "dis" ? v : null);

/** Coerce anything into a complete theme; missing/invalid parts come from `base`. */
export function normalizeTheme(raw: unknown, base: GameTheme = defaultTheme()): GameTheme {
  const t = isObj(raw) ? raw : {};
  const p = isObj(t.palette) ? t.palette : {};
  const l = isObj(t.labels) ? t.labels : {};
  const label = (k: keyof GameTheme["labels"]): string => {
    const v = str(l[k], 60).replace(/\s+/g, " ").trim();
    return v && v.length <= 24 ? v : base.labels[k];
  };
  const orn = str(t.ornament, 12).trim();
  const P = base.palette;
  return {
    palette: {
      bg: hex(p.bg, P.bg),
      panel: hex(p.panel, P.panel),
      ink: hex(p.ink, P.ink),
      muted: hex(p.muted, P.muted),
      accent: hex(p.accent, P.accent),
      accent2: hex(p.accent2, P.accent2),
      danger: hex(p.danger, P.danger),
      good: hex(p.good, P.good),
    },
    font: oneOf(t.font, FONTS, base.font),
    texture: oneOf(t.texture, TEXTURES, base.texture),
    labels: {
      party: label("party"),
      scene: label("scene"),
      log: label("log"),
      npcs: label("npcs"),
      items: label("items"),
      map: label("map"),
    },
    ornament: orn && [...orn].length <= 2 && !/[A-Za-z0-9<>&"']/.test(orn) ? orn : base.ornament,
  };
}

/** A pending image this process doesn't know about (engine restarted mid-paint): trust the disk. */
function reconcilePending(id: string): ImageStatus {
  const job = getImageJob(id);
  if (job) return job.status;
  try {
    return fs.existsSync(imagePath(id)) ? "ready" : "error";
  } catch {
    return "error";
  }
}

function slot(raw: unknown): ImageSlot {
  if (!isObj(raw)) return emptySlot();
  const status = oneOf(raw.status, IMAGE_STATUSES, "none");
  const id = typeof raw.id === "string" && IMG_ID_RE.test(raw.id) ? raw.id : null;
  if (!id) return { id: null, status: status === "pending" || status === "error" ? status : "none" };
  return { id, status: status === "pending" ? reconcilePending(id) : status };
}

/** True for the image slot of a placeholder entity (an NPC/item whose content is still being generated). */
export const isPlaceholderSlot = (s: ImageSlot) => s.id === null && s.status === "pending";

/** Entities that are real (not in-flight placeholders) — what prompts and summaries should mention. */
export function settledNpcs(game: Game): Npc[] {
  return game.npcs.filter((n) => !isPlaceholderSlot(n.portrait));
}
export function settledItems(game: Game): Item[] {
  return game.items.filter((it) => !isPlaceholderSlot(it.icon));
}

function normStats(raw: unknown): Stats {
  const s = isObj(raw) ? raw : {};
  const v = (k: keyof Stats) => int(s[k], 10, 1, 30);
  return { str: v("str"), dex: v("dex"), con: v("con"), int: v("int"), wis: v("wis"), cha: v("cha") };
}

function normRounds(raw: unknown, conditions: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const c of conditions) {
    const n = raw[c];
    if (typeof n === "number" && Number.isFinite(n) && n >= 1) out[c] = Math.min(1000, Math.round(n));
  }
  return out;
}

/** Heroes whose saved sheet had no `equipped` (a game from before equipment): what they carry is put on after items load. */
const unequippedSheets = new WeakSet<Player>();

function normPlayer(raw: unknown): Player | null {
  if (!isObj(raw)) return null;
  const className = str(raw.className, 40).trim();
  const race = str(raw.race, 40).trim();
  const profile = classProfile(className);
  const level = int(raw.level, 1, 1, 20);
  const maxHp = int(raw.maxHp, 1, 1, 999);
  const dead = raw.dead === true;
  const hp = dead ? 0 : int(raw.hp, maxHp, 0, maxHp);
  let conditions = lower(strs(raw.conditions, 12, 40));
  if (hp > 0) conditions = conditions.filter((c) => c !== "unconscious");
  else if (!dead && !conditions.includes("unconscious")) conditions.push("unconscious");
  const hitDie = [6, 8, 10, 12].includes(Number(raw.hitDie)) ? Number(raw.hitDie) : profile.hitDie;
  const slotsMax = Array.isArray(raw.slotsMax) ? nine(raw.slotsMax.map((x) => int(x, 0, 0, 9))) : slotsFor(profile.caster, level);
  const slotsUsed = nine(list(raw.slotsUsed).map((x) => int(x, 0, 0, 9))).map((u, i) => Math.min(u, slotsMax[i] ?? 0));
  const casts = slotsMax.some((n) => n > 0) || profile.caster !== null;
  const castingAbility = "castingAbility" in raw ? abilityKey(raw.castingAbility) : profile.ability;
  const ds = isObj(raw.deathSaves) ? raw.deathSaves : {};
  const eq = isObj(raw.equipped) ? raw.equipped : null;
  const p: Player = {
    id: validId(raw.id) ?? newId(),
    name: str(raw.name, 60).trim() || "Unnamed hero",
    playerName: str(raw.playerName, 40).replace(/\s+/g, " ").trim(),
    race,
    className,
    level,
    hp,
    maxHp,
    tempHp: int(raw.tempHp, 0, 0, 999),
    ac: int(raw.ac, 10, 0, 40),
    speed: int(raw.speed, 30, 0, 200),
    stats: normStats(raw.stats),
    background: str(raw.background, 80).trim(),
    traits: strs(raw.traits, 6, 100),
    conditions,
    conditionRounds: normRounds(raw.conditionRounds, conditions),
    exhaustion: int(raw.exhaustion, 0, 0, 6),
    gold: int(raw.gold, 0, 0, 1e9),
    xp: int(raw.xp, 0, 0, 1e9),
    inventory: strs(raw.inventory, 300, 40),
    notes: str(raw.notes, 2000),
    appearance: str(raw.appearance, 600).trim(),
    portrait: slot(raw.portrait),
    hitDie,
    hitDiceUsed: int(raw.hitDiceUsed, 0, 0, level),
    saveProficiencies: Array.isArray(raw.saveProficiencies)
      ? [...new Set(raw.saveProficiencies.map(abilityKey).filter((k): k is AbilityKey => k !== null))]
      : [...profile.saves],
    skillProficiencies: Array.isArray(raw.skillProficiencies) ? lower(strs(raw.skillProficiencies, 18, 20)).filter(isSkill) : [...profile.skills],
    castingAbility: casts ? castingAbility : null,
    slotsMax,
    slotsUsed,
    spells: Array.isArray(raw.spells) ? strs(raw.spells, 40, 40) : casts ? [...profile.spells] : [],
    concentration: typeof raw.concentration === "string" && raw.concentration.trim() ? raw.concentration.trim().slice(0, 40) : null,
    inspiration: raw.inspiration === true,
    deathSaves: { successes: int(ds.successes, 0, 0, 3), failures: int(ds.failures, 0, 0, 3) },
    stable: raw.stable === true && hp === 0 && !dead,
    dead,
    equipped: { weapon: validId(eq?.weapon), armor: validId(eq?.armor), shield: validId(eq?.shield) },
    resistances: Array.isArray(raw.resistances) ? lower(strs(raw.resistances, 8, 20)) : speciesResistances(race),
  };
  if (hp > 0) p.deathSaves = { successes: 0, failures: 0 };
  if (raw.pending === true) p.pending = true;
  if (!eq) unequippedSheets.add(p);
  return p;
}

function normItem(raw: unknown): Item | null {
  if (!isObj(raw)) return null;
  const it: Item = {
    id: validId(raw.id) ?? newId(),
    name: str(raw.name, 80).trim() || "Curious item",
    type: oneOf(raw.type, ITEM_TYPES, "gear"),
    rarity: oneOf(raw.rarity, RARITIES, "common"),
    description: str(raw.description, 600).trim(),
    properties: strs(raw.properties, 8, 60),
    ownerId: validId(raw.ownerId),
    appearance: str(raw.appearance, 600).trim(),
    icon: slot(raw.icon),
    quantity: int(raw.quantity, 1, 1, 999),
    value: 0,
  };
  it.value = typeof raw.value === "number" && Number.isFinite(raw.value) ? int(raw.value, 0, 0, 1e7) : itemPrice(it);
  return it;
}

const dice = (v: unknown, def: string | null): string | null => (typeof v === "string" && parseDice(v) ? v.replace(/\s+/g, "").slice(0, 20) : def);

function normRider(raw: unknown): AttackRider | null {
  if (!isObj(raw)) return null;
  const ability = abilityKey(raw.ability);
  if (!ability) return null;
  return {
    ability,
    dc: int(raw.dc, 10, 1, 30),
    condition: typeof raw.condition === "string" && raw.condition.trim() ? raw.condition.trim().toLowerCase().slice(0, 30) : null,
    rounds: typeof raw.rounds === "number" && raw.rounds >= 1 ? int(raw.rounds, 1, 1, 1000) : null,
    damage: dice(raw.damage, null),
    damageType: typeof raw.damageType === "string" && raw.damageType.trim() ? raw.damageType.trim().toLowerCase().slice(0, 20) : null,
    half: raw.half === true,
  };
}

function normAttack(raw: unknown): Attack | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 40).trim();
  const damage = dice(raw.damage, null);
  if (!name || !damage) return null;
  return {
    name,
    toHit: int(raw.toHit, 2, -5, 25),
    damage,
    damageType: str(raw.damageType, 20).trim().toLowerCase() || "bludgeoning",
    ranged: raw.ranged === true,
    range: int(raw.range, 5, 5, 1200),
    extraDamage: dice(raw.extraDamage, null),
    extraType: typeof raw.extraType === "string" && raw.extraType.trim() ? raw.extraType.trim().toLowerCase().slice(0, 20) : null,
    rider: normRider(raw.rider),
  };
}

function normBreath(raw: unknown): Breath | null {
  if (!isObj(raw)) return null;
  const ability = abilityKey(raw.ability);
  const damage = dice(raw.damage, null);
  if (!ability || !damage) return null;
  return {
    name: str(raw.name, 40).trim() || "Breath",
    ability,
    dc: int(raw.dc, 12, 1, 30),
    damage,
    damageType: str(raw.damageType, 20).trim().toLowerCase() || "fire",
    recharge: int(raw.recharge, 5, 2, 6),
    ready: raw.ready !== false,
    targets: int(raw.targets, 2, 1, 6),
  };
}

function normNpc(raw: unknown): Npc | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 60).trim() || "Stranger";
  const role = str(raw.role, 60).trim();
  const attitude = oneOf(raw.attitude, ATTITUDES, "unknown");
  // A character saved before stat blocks existed gets one now: the bestiary's if it names a creature, a default otherwise.
  const hasBlock = typeof raw.maxHp === "number" && Array.isArray(raw.attacks);
  const base = defaultStatBlock(name, role, attitude);
  const attacks = hasBlock ? list(raw.attacks).map(normAttack).filter((a): a is Attack => a !== null).slice(0, 6) : [];
  const maxHp = hasBlock ? int(raw.maxHp, base.maxHp, 1, 2000) : base.maxHp;
  const status = oneOf(raw.status, NPC_STATUSES, "alive");
  const conditions = lower(strs(raw.conditions, 12, 40));
  const saves: Partial<Record<AbilityKey, number>> = {};
  if (hasBlock && isObj(raw.saves)) for (const k of ABILITIES) if (typeof raw.saves[k] === "number") saves[k] = int(raw.saves[k], 0, -5, 20);
  const cr = hasBlock ? snapCr(raw.cr, base.cr) : base.cr;
  return {
    id: validId(raw.id) ?? newId(),
    name,
    role,
    description: str(raw.description, 600).trim(),
    attitude,
    appearance: str(raw.appearance, 600).trim(),
    portrait: slot(raw.portrait),
    kind: hasBlock ? str(raw.kind, 40).trim() : base.kind,
    creatureType: hasBlock ? str(raw.creatureType, 20).trim() || "creature" : base.creatureType,
    hp: status === "defeated" ? 0 : hasBlock ? int(raw.hp, maxHp, 0, maxHp) : base.hp,
    maxHp,
    tempHp: int(raw.tempHp, 0, 0, 999),
    ac: hasBlock ? int(raw.ac, base.ac, 1, 30) : base.ac,
    speed: hasBlock ? int(raw.speed, 30, 0, 200) : base.speed,
    stats: hasBlock ? normStats(raw.stats) : base.stats,
    attacks: attacks.length ? attacks : base.attacks,
    attacksPerTurn: hasBlock ? int(raw.attacksPerTurn, 1, 1, 5) : base.attacksPerTurn,
    breath: hasBlock ? normBreath(raw.breath) : base.breath,
    saves: hasBlock ? saves : base.saves,
    cr,
    xp: hasBlock ? int(raw.xp, xpForCr(cr), 0, 200000) : base.xp,
    status,
    conditions,
    conditionRounds: normRounds(raw.conditionRounds, conditions),
    resistances: hasBlock ? lower(strs(raw.resistances, 10, 20)) : base.resistances,
    vulnerabilities: hasBlock ? lower(strs(raw.vulnerabilities, 10, 20)) : base.vulnerabilities,
    immunities: hasBlock ? lower(strs(raw.immunities, 10, 20)) : base.immunities,
    regen: hasBlock ? int(raw.regen, 0, 0, 50) : base.regen,
    regenBlocked: raw.regenBlocked === true,
    statted: hasBlock ? raw.statted !== false : base.statted,
  };
}

function normLocation(raw: unknown): Location | null {
  if (!isObj(raw)) return null;
  return {
    id: validId(raw.id) ?? newId(),
    name: str(raw.name, 60).trim() || "Unknown place",
    description: str(raw.description, 400).trim(),
    x: num(raw.x, 0.5, 0, 1),
    y: num(raw.y, 0.5, 0, 1),
    connections: strs(raw.connections, 40, 40),
    visited: raw.visited === true,
    image: slot(raw.image),
  };
}

function normLog(raw: unknown): LogEntry | null {
  if (!isObj(raw)) return null;
  const text = str(raw.text, 1000).trim();
  if (!text) return null;
  return {
    id: validId(raw.id) ?? newId(),
    ts: int(raw.ts, Date.now(), 0, 8.64e15),
    kind: oneOf(raw.kind, LOG_KINDS, "system"),
    text,
  };
}

function normRoll(raw: unknown): Roll | null {
  if (!isObj(raw)) return null;
  const rolls = list(raw.rolls)
    .map((r) => int(r, 0, -1e6, 1e6))
    .slice(0, 100);
  const intOrNull = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? int(v, 0, lo, hi) : null);
  return {
    id: validId(raw.id) ?? newId(),
    who: typeof raw.who === "string" && raw.who.trim() ? raw.who.trim().slice(0, 60) : null,
    notation: str(raw.notation, 40).trim() || "1d20",
    rolls,
    modifier: int(raw.modifier, 0, -1000, 1000),
    total: int(raw.total, 0, -1e6, 1e6),
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 80) : null,
    ts: int(raw.ts, Date.now(), 0, 8.64e15),
    adv: adv(raw.adv),
    kept: intOrNull(raw.kept, 1, 1000),
    natural: intOrNull(raw.natural, 1, 20),
    dc: intOrNull(raw.dc, 0, 100),
    outcome: typeof raw.outcome === "string" && (OUTCOMES as readonly string[]).includes(raw.outcome) ? (raw.outcome as RollOutcome) : null,
  };
}

function normScene(raw: unknown): Scene | null {
  if (!isObj(raw)) return null;
  const title = str(raw.title, 120).trim();
  const description = str(raw.description, 1500).trim();
  if (!title && !description && !isObj(raw.image)) return null;
  return { title, description, image: slot(raw.image) };
}

function normStory(raw: unknown, setting: string): Story {
  const s = isObj(raw) ? raw : {};
  const base = emptyStory(setting);
  const text = (v: unknown, max: number) => str(v, max).replace(/\s+/g, " ").trim();
  const quests: Quest[] = [];
  for (const q of list(s.quests).slice(0, 12)) {
    if (!isObj(q)) continue;
    const title = text(q.title, 80);
    if (!title) continue;
    quests.push({ id: validId(q.id) ?? newId(), title, detail: text(q.detail, 300), status: oneOf(q.status, ["open", "done", "failed"] as const, "open") });
  }
  const clues: Clue[] = [];
  for (const c of list(s.clues).slice(0, 12)) {
    const t = isObj(c) ? text(c.text, 240) : "";
    if (isObj(c) && t) clues.push({ id: validId(c.id) ?? newId(), text: t, found: c.found === true });
  }
  const secrets: Secret[] = [];
  for (const c of list(s.secrets).slice(0, 12)) {
    const t = isObj(c) ? text(c.text, 240) : "";
    if (isObj(c) && t) secrets.push({ id: validId(c.id) ?? newId(), text: t, revealed: c.revealed === true });
  }
  const outline = strs(s.outline, 8, 240);
  const turn = int(s.turn, 0, 0, 1e6);
  return {
    premise: text(s.premise, 800) || base.premise,
    outline,
    beat: int(s.beat, 0, 0, Math.max(0, outline.length - 1)),
    secrets,
    clues,
    quests,
    facts: strs(s.facts, 30, 200),
    threats: lower(strs(s.threats, 8, 40)),
    summary: text(s.summary, 1200),
    summaryTurn: int(s.summaryTurn, 0, 0, turn),
    turn,
    recentTurns: list(s.recentTurns)
      .map((x) => text(x, 400))
      .filter(Boolean)
      .slice(-12),
    lastTurn: text(s.lastTurn, 400),
    lastNarration: text(s.lastNarration, 1200),
    sessions: int(s.sessions, 0, 0, 1e5),
  };
}

function normSettings(raw: unknown): TableSettings {
  const s = isObj(raw) ? raw : {};
  const base = defaultSettings();
  return {
    difficulty: oneOf(s.difficulty, ["easy", "standard", "hard"] as const, base.difficulty),
    leveling: oneOf(s.leveling, ["xp", "milestone"] as const, base.leveling),
    rolls: oneOf(s.rolls, ["ask", "auto"] as const, base.rolls),
    avoid: strs(s.avoid, 10, 80),
    expectedPlayers: typeof s.expectedPlayers === "number" ? int(s.expectedPlayers, 1, 1, MAX_PLAYERS) : null,
    length: s.length === "one-shot" || s.length === "short" || s.length === "campaign" ? s.length : null,
  };
}

function normSetupState(raw: unknown): SetupState {
  const s = isObj(raw) ? raw : {};
  const asked: Record<string, number> = {};
  if (isObj(s.asked)) for (const [k, v] of Object.entries(s.asked).slice(0, 40)) if (typeof v === "number" && /^[a-z0-9-]{1,24}$/.test(k)) asked[k] = int(v, 0, 0, 99);
  return { seatName: str(s.seatName, 40).replace(/\s+/g, " ").trim(), asked, answered: lower(strs(s.answered, 40, 20)) };
}

function normPending(raw: unknown, playerIds: Set<string>): Pending {
  const p = isObj(raw) ? raw : {};
  let check: PendingCheck | null = null;
  if (isObj(p.check)) {
    const heroId = validId(p.check.heroId);
    if (heroId && playerIds.has(heroId)) {
      const skill = typeof p.check.skill === "string" && isSkill(p.check.skill) ? p.check.skill : null;
      check = {
        id: validId(p.check.id) ?? newId(),
        heroId,
        kind: oneOf(p.check.kind, ["check", "save", "death"] as const, "check"),
        ability: abilityKey(p.check.ability),
        skill,
        label: str(p.check.label, 60).trim() || "Check",
        // Kept as asked: a DC a creature sets (a passive score, a save DC) is not on the easy-to-hard ladder.
        dc: p.check.kind === "death" ? 10 : int(p.check.dc, 15, 1, 30),
        adv: adv(p.check.adv),
        reason: str(p.check.reason, 160).trim(),
        words: str(p.check.words, 400),
        askedAt: int(p.check.askedAt, Date.now(), 0, 8.64e15),
        reminders: int(p.check.reminders, 0, 0, 99),
        endsTurn: p.check.endsTurn === true,
      };
    }
  }
  let confirm: PendingConfirm | null = null;
  if (isObj(p.confirm)) {
    const kind = oneOf(p.confirm.kind, ["new_game", "remove_player", "load_game", "end_campaign"] as const, "new_game");
    confirm = {
      id: validId(p.confirm.id) ?? newId(),
      kind,
      targetId: validId(p.confirm.targetId),
      words: str(p.confirm.words, 400),
      question: str(p.confirm.question, 240).trim(),
      askedAt: int(p.confirm.askedAt, Date.now(), 0, 8.64e15),
    };
  }
  let action: PendingAction | null = null;
  if (isObj(p.action)) {
    const tool = str(p.action.tool, 40).trim();
    const words = str(p.action.words, 400).trim();
    if (tool && words) {
      const actorId = validId(p.action.actorId);
      action = {
        id: validId(p.action.id) ?? newId(),
        tool,
        words,
        question: str(p.action.question, 240).trim(),
        need: p.action.need === "target" ? "target" : "actor",
        actorId: actorId && playerIds.has(actorId) ? actorId : null,
        askedAt: int(p.action.askedAt, Date.now(), 0, 8.64e15),
      };
    }
  }
  return { check, confirm, action };
}

function normCombat(raw: unknown, playerIds: Set<string>, npcs: Npc[]): Combat | null {
  if (!isObj(raw)) return null;
  const live = new Map(npcs.filter((n) => n.status === "alive").map((n) => [n.id, n]));
  const order: Combatant[] = [];
  const seen = new Set<string>();
  for (const c of list(raw.order)) {
    if (!isObj(c)) continue;
    const id = validId(c.id);
    const kind = c.kind === "npc" ? "npc" : "hero";
    if (!id || seen.has(id) || (kind === "hero" ? !playerIds.has(id) : !live.has(id))) continue;
    seen.add(id);
    order.push({
      id,
      kind,
      init: int(c.init, 0, -20, 60),
      roll: int(c.roll, 10, 1, 20),
      surprised: c.surprised === true,
      reactionUsed: c.reactionUsed === true,
      engaged: strs(c.engaged, 20, 40),
      lastTargetId: validId(c.lastTargetId),
      lastAttackerId: validId(c.lastAttackerId),
    });
  }
  if (!order.length) return null;
  const vacant = raw.vacant === true;
  return {
    round: int(raw.round, 1, 1, 1e5),
    index: int(raw.index, 0, vacant ? -1 : 0, order.length - 1),
    vacant,
    order,
    bonusUsed: raw.bonusUsed === true,
    disengaged: raw.disengaged === true,
    xpEarned: int(raw.xpEarned, 0, 0, 1e7),
    overcome: strs(raw.overcome, 40, 60),
  };
}

function uniqueById<T extends { id: string }>(xs: (T | null)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    if (!x) continue;
    if (seen.has(x.id)) x.id = newId();
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

/** Put on what a hero carries: the first weapon, the first armor and a shield. Never changes the armor class by itself. */
export function autoEquip(p: Player, items: Item[]): void {
  const mine = p.inventory.map((id) => items.find((it) => it.id === id)).filter((it): it is Item => !!it);
  const usable = (id: string | null, ok: (it: Item) => boolean) => (id && mine.some((it) => it.id === id && ok(it)) ? id : null);
  const isWeapon = (it: Item) => it.type === "weapon" && weaponStats(it) !== null;
  const isArmor = (it: Item) => armorStats(it)?.kind === "armor";
  const isShield = (it: Item) => armorStats(it)?.kind === "shield";
  p.equipped = {
    weapon: usable(p.equipped.weapon, (it) => weaponStats(it) !== null) ?? mine.find(isWeapon)?.id ?? null,
    armor: usable(p.equipped.armor, isArmor) ?? mine.find(isArmor)?.id ?? null,
    shield: usable(p.equipped.shield, isShield) ?? mine.find(isShield)?.id ?? null,
  };
}

interface RowMeta {
  id: string;
  personaId: string;
  title: string;
  created: number;
  updated: number;
}

/** Coerce any stored/partial JSON into a complete, internally consistent Game. */
function normalizeGame(raw: unknown, meta: RowMeta): Game {
  const g = isObj(raw) ? raw : {};
  const live = (id: string) => livePlaceholders.has(id);

  const players = uniqueById(list(g.players).map(normPlayer)).filter((p) => !p.pending || live(p.id));
  const playerIds = new Set(players.map((p) => p.id));
  const heroIds = new Set(players.filter((p) => !p.pending).map((p) => p.id));

  const items = uniqueById(list(g.items).map(normItem))
    .filter((it) => !isPlaceholderSlot(it.icon) || live(it.id))
    .map((it) => (it.ownerId && !playerIds.has(it.ownerId) ? { ...it, ownerId: null } : it));

  // Inventory mirrors item ownership (ownerId is the source of truth); keep the stored order.
  const owned = new Map<string, string[]>();
  for (const it of items) {
    if (!it.ownerId) continue;
    const mine = owned.get(it.ownerId) ?? [];
    mine.push(it.id);
    owned.set(it.ownerId, mine);
  }
  for (const p of players) {
    const mine = owned.get(p.id) ?? [];
    const ordered = p.inventory.filter((id) => mine.includes(id));
    for (const id of mine) if (!ordered.includes(id)) ordered.push(id);
    p.inventory = ordered;
    if (unequippedSheets.has(p)) autoEquip(p, items);
    else {
      // What is held must still be carried.
      for (const k of ["weapon", "armor", "shield"] as const) if (p.equipped[k] && !ordered.includes(p.equipped[k]!)) p.equipped[k] = null;
    }
  }

  const npcs = uniqueById(list(g.npcs).map(normNpc)).filter((n) => !isPlaceholderSlot(n.portrait) || live(n.id));

  const locations = uniqueById(list(g.locations).map(normLocation));
  const locIds = new Set(locations.map((l) => l.id));
  for (const l of locations) l.connections = l.connections.filter((c) => c !== l.id && locIds.has(c));
  // Connections are symmetric.
  const byId = new Map(locations.map((l) => [l.id, l]));
  for (const l of locations) {
    for (const c of l.connections) {
      const other = byId.get(c);
      if (other && !other.connections.includes(l.id)) other.connections.push(l.id);
    }
  }

  const log = list(g.log)
    .map(normLog)
    .filter((e): e is LogEntry => e !== null)
    .slice(-MAX_LOG);

  const phase = oneOf(g.phase, PHASES, "setup");
  const inPlay = phase === "playing" || phase === "paused";
  const combat = inPlay ? normCombat(g.combat, heroIds, npcs) : null;
  const firstUp = players.find((p) => !p.pending && !p.dead)?.id ?? null;
  const saved = (v: unknown) => {
    const id = validId(v);
    return id && heroIds.has(id) ? id : null;
  };
  // A game saved before the spotlight existed: the hero last acted on holds it. (A saved null means nobody does.)
  const spotlightId = !inPlay ? null : "spotlightId" in g ? saved(g.spotlightId) : (saved(g.activePlayerId) ?? firstUp);
  const current = combat && !combat.vacant ? combat.order[combat.index] : null;
  const activePlayerId = combat ? (current?.kind === "hero" ? current.id : null) : inPlay ? spotlightId : saved(g.activePlayerId);
  const currentLocationId = validId(g.currentLocationId);
  const setting = str(g.setting, 800).trim();
  const pending = normPending(g.pending, heroIds);
  if (!inPlay) pending.check = null;

  return {
    id: meta.id,
    personaId: meta.personaId,
    title: str(g.title, 120).trim() || meta.title.trim() || NEW_GAME_TITLE,
    genre: str(g.genre, 60).trim(),
    tone: str(g.tone, 60).trim(),
    setting,
    artStyle: str(g.artStyle, 300).trim(),
    theme: normalizeTheme(g.theme),
    phase,
    mode: phase === "paused" ? "paused" : combat ? "combat" : "explore",
    round: combat ? combat.round : 0,
    activePlayerId,
    spotlightId,
    combat,
    pending,
    story: normStory(g.story, setting),
    settings: normSettings(g.settings),
    setupState: normSetupState(g.setupState),
    partyGold: int(g.partyGold, 0, 0, 1e9),
    titleImage: slot(g.titleImage),
    scene: normScene(g.scene),
    players,
    npcs,
    items,
    locations,
    currentLocationId: currentLocationId && locIds.has(currentLocationId) ? currentLocationId : null,
    log,
    lastRoll: normRoll(g.lastRoll),
    createdAt: int(g.createdAt, meta.created, 0, 8.64e15) || meta.created,
    updatedAt: meta.updated,
  };
}

/** Normalize a document as a saved row would be (exported for tests of old saved games). */
export function normalizeGameDocument(raw: unknown, meta: { id?: string; personaId?: string; title?: string } = {}): Game {
  const now = Date.now();
  return normalizeGame(raw, { id: meta.id ?? "preview", personaId: meta.personaId ?? "game-master", title: meta.title ?? "", created: now, updated: now });
}

function fromRow(r: GameRow): Game {
  let raw: unknown = {};
  try {
    raw = JSON.parse(r.data);
  } catch {
    console.warn(`[game] game ${r.id} has unreadable data — starting it fresh`);
  }
  return normalizeGame(raw, { id: r.id, personaId: r.persona_id, title: r.title, created: r.created, updated: r.updated });
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Create and persist a game with full defaults (placeholder title, default theme, setup phase). */
export function createGame(personaId: string, init: Partial<Game> = {}): Game {
  const now = Date.now();
  const id = newId();
  const game = normalizeGame(
    { ...init, createdAt: now },
    { id, personaId, title: typeof init.title === "string" ? init.title : NEW_GAME_TITLE, created: now, updated: now },
  );
  stmt.insert.run({ id, personaId, title: game.title, data: JSON.stringify(game), created: now, updated: now });
  return game;
}

/** Store a raw document as a game (a saved game from elsewhere, or a test fixture); it is normalized when read. */
export function importGame(personaId: string, raw: unknown, title = NEW_GAME_TITLE): Game {
  const now = Date.now();
  const id = newId();
  stmt.insert.run({ id, personaId, title, data: JSON.stringify(raw ?? {}), created: now, updated: now });
  return getGame(id)!;
}

export function getGame(id: string): Game | null {
  const r = stmt.get.get(id) as GameRow | undefined;
  return r ? fromRow(r) : null;
}

/** Saved games, most recently updated first (optionally just one persona's). */
export function listGames(personaId?: string): Game[] {
  const rows = (personaId ? stmt.listByPersona.all(personaId) : stmt.listAll.all()) as GameRow[];
  return rows.map(fromRow);
}

/** Delete a game (and clear it as its persona's active game). Returns false if it didn't exist. */
export function deleteGame(id: string): boolean {
  const r = stmt.get.get(id) as GameRow | undefined;
  if (!r) return false;
  stmt.delete.run(id);
  stmt.clearHistory.run(id);
  const key = activeKey(r.persona_id);
  if (getSetting(key) === id) stmt.deleteSetting.run(key);
  return true;
}

const activeKey = (personaId: string) => `active_game:${personaId}`;

export function getActiveGameId(personaId: string): string | null {
  const id = getSetting(activeKey(personaId));
  return id || null;
}

export function getActiveGame(personaId: string): Game | null {
  const id = getActiveGameId(personaId);
  return id ? getGame(id) : null;
}

export function setActiveGame(personaId: string, id: string | null): void {
  if (id) setSetting(activeKey(personaId), id);
  else stmt.deleteSetting.run(activeKey(personaId));
}

export function getCustomTemplate(id: string): string | null {
  const r = stmt.getTemplate.get(id) as { custom_template: string | null } | undefined;
  return r?.custom_template || null;
}

export function setCustomTemplate(id: string, src: string | null): void {
  stmt.setTemplate.run(src && src.trim() ? src : null, id);
}

// ─── Serialized mutation ─────────────────────────────────────────────────────

/**
 * Mutate `game` in place (or return a replacement). Keep it quick and synchronous where
 * possible: the game's queue waits for it. Never `await mutateGame(sameId, …)` inside a
 * mutator — that would wait on itself.
 */
export type GameMutator = (game: Game) => void | Game | Promise<void | Game>;
type ChangeListener = (game: Game) => void;

const queues = new Map<string, Promise<Game | null>>();
const listeners = new Set<ChangeListener>();

/** Called after every successful save (the presenter re-presents the game if it's on screen). */
export function subscribeGameChanges(cb: ChangeListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Serialize all mutations of one game: each runs only after the previous one saved,
 * against the LATEST stored row. Resolves with the saved game, or null if the game
 * doesn't exist (or was deleted meanwhile — it is never resurrected) or the mutator threw.
 */
export function mutateGame(id: string, fn: GameMutator): Promise<Game | null> {
  const prev = queues.get(id) ?? Promise.resolve(null);
  const run = prev
    .then(() => applyMutation(id, fn))
    .catch((err: unknown) => {
      console.warn(`[game] mutation of ${id} failed:`, err);
      return null;
    });
  queues.set(id, run);
  void run.then(() => {
    if (queues.get(id) === run) queues.delete(id);
  });
  return run;
}

async function applyMutation(id: string, fn: GameMutator): Promise<Game | null> {
  const current = getGame(id);
  if (!current) return null;
  const { personaId, createdAt, updatedAt: before } = current;

  const out = await fn(current);
  const draft = out && typeof out === "object" ? out : current;
  const updatedAt = Math.max(Date.now(), before + 1);
  const next = normalizeGame(draft, { id, personaId, title: draft.title, created: createdAt, updated: updatedAt });
  next.createdAt = createdAt;

  const res = stmt.update.run({ id, title: next.title, data: JSON.stringify(next), updated: updatedAt });
  if (res.changes === 0) return null; // deleted while we were working
  for (const cb of listeners) {
    try {
      cb(next);
    } catch (err) {
      console.warn("[game] change listener failed:", (err as Error).message);
    }
  }
  return next;
}

// ─── History (undo) ──────────────────────────────────────────────────────────

/**
 * Keep the game as it is right now, labelled with what is about to happen ("Thorin attacks the goblin"). Called
 * once per story turn, before the turn changes anything; only the last MAX_HISTORY are kept.
 */
export function checkpointGame(id: string, label: string): void {
  const row = stmt.rawData.get(id) as { data: string } | undefined;
  if (!row) return;
  stmt.pushHistory.run(id, label.replace(/\s+/g, " ").trim().slice(0, 160) || "the last turn", row.data, Date.now());
  stmt.trimHistory.run(id, id, MAX_HISTORY);
}

export function historyDepth(id: string): number {
  return (stmt.countHistory.get(id) as { n: number } | undefined)?.n ?? 0;
}

/** Throw away the newest checkpoint (a turn that ended up changing nothing). */
export function dropCheckpoint(id: string): void {
  const last = stmt.lastHistory.get(id) as { seq: number } | undefined;
  if (last) stmt.dropHistory.run(last.seq);
}

/**
 * Take the game back to its newest checkpoint: the document as it was before the last story turn. Resolves with
 * the restored game and the label of the turn that was undone, or null when there is nothing to undo.
 */
export async function undoGame(id: string): Promise<{ game: Game; label: string } | null> {
  const last = stmt.lastHistory.get(id) as { seq: number; label: string; data: string } | undefined;
  if (!last) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(last.data);
  } catch {
    stmt.dropHistory.run(last.seq);
    return null;
  }
  const restored = await mutateGame(id, () => doc as Game);
  if (!restored) return null;
  stmt.dropHistory.run(last.seq);
  return { game: restored, label: last.label };
}

// ─── Small pure helpers for mutators ─────────────────────────────────────────

/** Append a log entry (in place). */
export function addLog(game: Game, kind: LogKind, text: string): LogEntry {
  const entry: LogEntry = { id: newId(), ts: Date.now(), kind, text: text.trim().slice(0, 1000) };
  game.log.push(entry);
  if (game.log.length > MAX_LOG) game.log.splice(0, game.log.length - MAX_LOG);
  return entry;
}

/** Set the status of every slot that shows image `imageId`. Returns how many changed. */
export function setImageStatus(game: Game, imageId: string, status: ImageStatus): number {
  let changed = 0;
  const touch = (s: ImageSlot | undefined | null) => {
    if (s && s.id === imageId && s.status !== status) {
      s.status = status;
      changed++;
    }
  };
  touch(game.titleImage);
  touch(game.scene?.image);
  for (const p of game.players) touch(p.portrait);
  for (const n of game.npcs) touch(n.portrait);
  for (const it of game.items) touch(it.icon);
  for (const l of game.locations) touch(l.image);
  return changed;
}

/** The fourteen SRD conditions (a sheet may also carry free-form tags such as "hidden"). */
export const SRD_CONDITIONS: readonly string[] = CONDITIONS;
