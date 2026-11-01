// Game Master domain types. `Game` is what we persist; `GameView` is what the
// workspace game screen renders (template contract v1: window.render(state, prev)).

export type ImageStatus = "none" | "pending" | "ready" | "error";

/** Persisted reference to a generated image (see services/images.ts). */
export interface ImageSlot {
  id: string | null;
  status: ImageStatus;
}

/** What templates receive: an absolute-able URL ("/api/images/<id>.png") once ready. */
export interface ImageRef {
  url: string | null;
  status: ImageStatus;
}

export interface Stats {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export interface Player {
  id: string;
  name: string;
  race: string;
  className: string;
  level: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  stats: Stats;
  background: string;
  traits: string[];
  conditions: string[];
  gold: number;
  xp: number;
  /** Item ids. */
  inventory: string[];
  notes: string;
  /** Visual description used for the portrait prompt. */
  appearance: string;
  portrait: ImageSlot;
  /** True while the character sheet is still being generated (placeholder card). */
  pending?: boolean;
}

export type ItemType = "weapon" | "armor" | "potion" | "scroll" | "wondrous" | "gear" | "treasure" | "quest";
export type Rarity = "common" | "uncommon" | "rare" | "very rare" | "legendary" | "artifact";

export interface Item {
  id: string;
  name: string;
  type: ItemType;
  rarity: Rarity;
  description: string;
  properties: string[];
  /** Player id, or null for party loot. */
  ownerId: string | null;
  appearance: string;
  icon: ImageSlot;
}

export type Attitude = "friendly" | "neutral" | "hostile" | "unknown";

export interface Npc {
  id: string;
  name: string;
  role: string;
  description: string;
  attitude: Attitude;
  appearance: string;
  portrait: ImageSlot;
}

export interface Location {
  id: string;
  name: string;
  description: string;
  /** Normalized map coordinates, 0..1. */
  x: number;
  y: number;
  /** Ids of connected locations. */
  connections: string[];
  visited: boolean;
  image: ImageSlot;
}

export type LogKind = "narration" | "roll" | "combat" | "loot" | "party" | "system";

export interface LogEntry {
  id: string;
  ts: number;
  kind: LogKind;
  text: string;
}

export interface Roll {
  id: string;
  /** Player name (or null for the GM). */
  who: string | null;
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  label: string | null;
  ts: number;
}

export interface Scene {
  title: string;
  description: string;
  image: ImageSlot;
}

export type GamePhase = "setup" | "playing";

/**
 * Per-scenario look for the game screen, generated with the game frame (~2s), so the
 * screen re-skins itself for the scenario almost immediately (e.g. a sci-fi HUD with
 * "Crew" / "Bridge Log" vs. a parchment fantasy table with "Party" / "Adventure Log").
 * Colors are CSS hex strings.
 */
export interface GameTheme {
  palette: {
    bg: string;
    panel: string;
    ink: string;
    muted: string;
    accent: string;
    accent2: string;
    danger: string;
    good: string;
  };
  /** Mapped by templates to system font stacks (no web fonts in the sandbox). */
  font: "serif" | "sans" | "mono" | "display";
  texture: "parchment" | "stone" | "wood" | "hud" | "neon" | "none";
  labels: { party: string; scene: string; log: string; npcs: string; items: string; map: string };
  /** A glyph used as a section ornament, e.g. "⚔", "✦", "◈". */
  ornament: string;
}

export interface Game {
  id: string;
  personaId: string;
  title: string;
  genre: string;
  tone: string;
  /** One or two sentence premise. */
  setting: string;
  /** Shared art-style prefix for every image in this campaign (visual consistency). */
  artStyle: string;
  theme: GameTheme;
  phase: GamePhase;
  round: number;
  activePlayerId: string | null;
  titleImage: ImageSlot;
  scene: Scene | null;
  players: Player[];
  npcs: Npc[];
  items: Item[];
  locations: Location[];
  currentLocationId: string | null;
  log: LogEntry[];
  lastRoll: Roll | null;
  createdAt: number;
  updatedAt: number;
}

export interface SetupStep {
  key: "adventure" | "party" | "begin";
  label: string;
  done: boolean;
}

export interface SetupView {
  steps: SetupStep[];
  /** The Game Master's next setup question, or null once playing. */
  next: string | null;
}

// ─── View (what the game-screen template renders) ────────────────────────────

export interface PlayerView extends Omit<Player, "portrait" | "appearance"> {
  portrait: ImageRef;
}
export interface ItemView extends Omit<Item, "icon" | "appearance"> {
  icon: ImageRef;
}
export interface NpcView extends Omit<Npc, "portrait" | "appearance"> {
  portrait: ImageRef;
}
export interface LocationView extends Omit<Location, "image"> {
  image: ImageRef;
}
export interface SceneView {
  title: string;
  description: string;
  image: ImageRef;
}

export interface GameView {
  kind: "game";
  id: string;
  title: string;
  genre: string;
  tone: string;
  setting: string;
  theme: GameTheme;
  phase: GamePhase;
  setup: SetupView;
  round: number;
  activePlayerId: string | null;
  titleImage: ImageRef;
  scene: SceneView | null;
  players: PlayerView[];
  npcs: NpcView[];
  items: ItemView[];
  locations: LocationView[];
  currentLocationId: string | null;
  /** Oldest first (templates usually display newest first). Capped to the last 200. */
  log: LogEntry[];
  lastRoll: Roll | null;
  /** Short status of background work, e.g. "Painting Thorin's portrait…" (empty when idle). */
  busy: string[];
  updatedAt: number;
}
