import fs from "node:fs";
import { nanoid } from "nanoid";
import db, { getSetting, setSetting } from "../db/sqlite.js";
import { getImageJob, imagePath } from "../services/images.js";
import type {
  Attitude,
  Game,
  GameTheme,
  ImageSlot,
  ImageStatus,
  Item,
  ItemType,
  Location,
  LogEntry,
  LogKind,
  Npc,
  Player,
  Rarity,
  Roll,
  Scene,
  Stats,
} from "./types.js";

/**
 * Game persistence. One row per game in the shared SQLite DB; the game itself is a JSON
 * document (normalized on every load, so old or partial rows always come back complete).
 *
 * All writes to a game's data go through `mutateGame`, which serializes mutations per
 * game id: each one re-reads the latest row inside the queue, applies the mutator, saves,
 * then notifies listeners (the presenter). Read-modify-write races are impossible as long
 * as nobody holds a Game across an await and saves it later — there is deliberately no
 * public "saveGame".
 */

export const NEW_GAME_TITLE = "New Adventure";
/** Display names of placeholder entities while their content is generated. */
export const PLACEHOLDER_NAMES = { player: "New hero", npc: "A figure approaches…", item: "Revealing…" } as const;
export const MAX_PLAYERS = 8;
/** Stored log length (the view shows the last 200). */
export const MAX_LOG = 500;

export const ITEM_TYPES: readonly ItemType[] = ["weapon", "armor", "potion", "scroll", "wondrous", "gear", "treasure", "quest"];
export const RARITIES: readonly Rarity[] = ["common", "uncommon", "rare", "very rare", "legendary", "artifact"];
export const ATTITUDES: readonly Attitude[] = ["friendly", "neutral", "hostile", "unknown"];
export const LOG_KINDS: readonly LogKind[] = ["narration", "roll", "combat", "loot", "party", "system"];
const IMAGE_STATUSES: readonly ImageStatus[] = ["none", "pending", "ready", "error"];
const FONTS: readonly GameTheme["font"][] = ["serif", "sans", "mono", "display"];
const TEXTURES: readonly GameTheme["texture"][] = ["parchment", "stone", "wood", "hud", "neon", "none"];

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

function normPlayer(raw: unknown): Player | null {
  if (!isObj(raw)) return null;
  const maxHp = int(raw.maxHp, 1, 1, 999);
  const p: Player = {
    id: validId(raw.id) ?? newId(),
    name: str(raw.name, 60).trim() || "Unnamed hero",
    race: str(raw.race, 40).trim(),
    className: str(raw.className, 40).trim(),
    level: int(raw.level, 1, 1, 20),
    hp: int(raw.hp, maxHp, 0, maxHp),
    maxHp,
    ac: int(raw.ac, 10, 0, 40),
    speed: int(raw.speed, 30, 0, 200),
    stats: normStats(raw.stats),
    background: str(raw.background, 80).trim(),
    traits: strs(raw.traits, 6, 100),
    conditions: strs(raw.conditions, 12, 40),
    gold: int(raw.gold, 0, 0, 1e9),
    xp: int(raw.xp, 0, 0, 1e9),
    inventory: strs(raw.inventory, 300, 40),
    notes: str(raw.notes, 2000),
    appearance: str(raw.appearance, 600).trim(),
    portrait: slot(raw.portrait),
  };
  if (raw.pending === true) p.pending = true;
  return p;
}

function normItem(raw: unknown): Item | null {
  if (!isObj(raw)) return null;
  return {
    id: validId(raw.id) ?? newId(),
    name: str(raw.name, 80).trim() || "Curious item",
    type: oneOf(raw.type, ITEM_TYPES, "gear"),
    rarity: oneOf(raw.rarity, RARITIES, "common"),
    description: str(raw.description, 600).trim(),
    properties: strs(raw.properties, 8, 60),
    ownerId: validId(raw.ownerId),
    appearance: str(raw.appearance, 600).trim(),
    icon: slot(raw.icon),
  };
}

function normNpc(raw: unknown): Npc | null {
  if (!isObj(raw)) return null;
  return {
    id: validId(raw.id) ?? newId(),
    name: str(raw.name, 60).trim() || "Stranger",
    role: str(raw.role, 60).trim(),
    description: str(raw.description, 600).trim(),
    attitude: oneOf(raw.attitude, ATTITUDES, "unknown"),
    appearance: str(raw.appearance, 600).trim(),
    portrait: slot(raw.portrait),
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
  return {
    id: validId(raw.id) ?? newId(),
    who: typeof raw.who === "string" && raw.who.trim() ? raw.who.trim().slice(0, 60) : null,
    notation: str(raw.notation, 40).trim() || "1d20",
    rolls,
    modifier: int(raw.modifier, 0, -1000, 1000),
    total: int(raw.total, 0, -1e6, 1e6),
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 80) : null,
    ts: int(raw.ts, Date.now(), 0, 8.64e15),
  };
}

function normScene(raw: unknown): Scene | null {
  if (!isObj(raw)) return null;
  const title = str(raw.title, 120).trim();
  const description = str(raw.description, 1500).trim();
  if (!title && !description && !isObj(raw.image)) return null;
  return { title, description, image: slot(raw.image) };
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

  const activePlayerId = validId(g.activePlayerId);
  const currentLocationId = validId(g.currentLocationId);

  return {
    id: meta.id,
    personaId: meta.personaId,
    title: str(g.title, 120).trim() || meta.title.trim() || NEW_GAME_TITLE,
    genre: str(g.genre, 60).trim(),
    tone: str(g.tone, 60).trim(),
    setting: str(g.setting, 800).trim(),
    artStyle: str(g.artStyle, 300).trim(),
    theme: normalizeTheme(g.theme),
    phase: g.phase === "playing" ? "playing" : "setup",
    round: int(g.round, 0, 0, 1e6),
    activePlayerId: activePlayerId && playerIds.has(activePlayerId) ? activePlayerId : null,
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
