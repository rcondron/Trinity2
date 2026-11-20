// Game Master domain types. `Game` is what we persist; `GameView` is what the
// workspace game screen renders (template contract v2: window.render(state, prev)).

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

export type AbilityKey = keyof Stats;
/** Advantage / disadvantage on a d20 (never stacking; one of each cancels to null). */
export type Adv = "adv" | "dis" | null;

export interface DeathSaves {
  successes: number;
  failures: number;
}

/** Item ids of what a hero holds ready: AC and attacks follow these. */
export interface Equipped {
  weapon: string | null;
  armor: string | null;
  shield: string | null;
}

export interface Player {
  id: string;
  /** The character's name. */
  name: string;
  /** The human at the table who plays this hero ("" when not given). */
  playerName: string;
  race: string;
  className: string;
  level: number;
  hp: number;
  maxHp: number;
  /** Temporary hit points: absorb damage first, never stack, never heal. */
  tempHp: number;
  ac: number;
  speed: number;
  stats: Stats;
  background: string;
  traits: string[];
  /** Condition names (SRD conditions plus free-form tags such as "hidden"). */
  conditions: string[];
  /** Rounds left for timed conditions (a condition without an entry lasts until removed). */
  conditionRounds: Record<string, number>;
  /** Exhaustion level 0–6. */
  exhaustion: number;
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
  /** Hit die size (6, 8, 10, 12); a hero has `level` of them. */
  hitDie: number;
  hitDiceUsed: number;
  saveProficiencies: AbilityKey[];
  /** Skill keys (rules.ts SKILLS). */
  skillProficiencies: string[];
  /** Spellcasting ability, or null for a hero who casts no spells. */
  castingAbility: AbilityKey | null;
  /** Spell slots by spell level: index 0 = level 1 … index 8 = level 9. */
  slotsMax: number[];
  slotsUsed: number[];
  /** Spells the hero is known to cast (names). */
  spells: string[];
  /** The spell being concentrated on, if any. */
  concentration: string | null;
  inspiration: boolean;
  deathSaves: DeathSaves;
  /** At 0 HP but no longer dying. */
  stable: boolean;
  dead: boolean;
  equipped: Equipped;
  /** Damage types this hero resists. */
  resistances: string[];
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
  /** How many of it (consumables count down and leave the sheet at 0). */
  quantity: number;
  /** Worth in gold, each. */
  value: number;
}

export type Attitude = "friendly" | "neutral" | "hostile" | "unknown";
export type NpcStatus = "alive" | "defeated" | "fled";

/** A save that rides on a hit: fail it and take the condition and/or the extra damage. */
export interface AttackRider {
  ability: AbilityKey;
  dc: number;
  condition: string | null;
  rounds: number | null;
  damage: string | null;
  damageType: string | null;
  /** Half the rider damage on a successful save. */
  half: boolean;
}

export interface Attack {
  name: string;
  toHit: number;
  /** Dice expression, e.g. "1d6+2". */
  damage: string;
  damageType: string;
  ranged: boolean;
  /** Reach or normal range, in feet. */
  range: number;
  /** Extra damage dice of another type on a hit (a hell hound's fire). */
  extraDamage: string | null;
  extraType: string | null;
  rider: AttackRider | null;
}

/** An area attack that recharges: a save for half damage against a few targets. */
export interface Breath {
  name: string;
  ability: AbilityKey;
  dc: number;
  damage: string;
  damageType: string;
  /** Recharges on a d6 roll of this or more at the start of its turn. */
  recharge: number;
  ready: boolean;
  /** How many heroes it can catch. */
  targets: number;
}

export interface Npc {
  id: string;
  name: string;
  role: string;
  description: string;
  attitude: Attitude;
  appearance: string;
  portrait: ImageSlot;
  /** Bestiary key ("goblin") or "" for a one-off. */
  kind: string;
  creatureType: string;
  hp: number;
  maxHp: number;
  tempHp: number;
  ac: number;
  speed: number;
  stats: Stats;
  attacks: Attack[];
  /** Attacks it makes on its turn (multiattack). */
  attacksPerTurn: number;
  breath: Breath | null;
  /** Saving throw bonuses that differ from the bare ability modifier. */
  saves: Partial<Record<AbilityKey, number>>;
  /** Challenge rating (0.125, 0.25, 0.5, 1, 2 …). */
  cr: number;
  xp: number;
  status: NpcStatus;
  conditions: string[];
  conditionRounds: Record<string, number>;
  resistances: string[];
  vulnerabilities: string[];
  immunities: string[];
  /** Hit points regained at the start of its turn (a troll's 10). */
  regen: number;
  regenBlocked: boolean;
  /** True when the stat block came from the bestiary or a validated generation (false: a default for a story NPC). */
  statted: boolean;
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

export type RollOutcome = "success" | "failure" | "hit" | "miss" | "crit" | "fumble";

export interface Roll {
  id: string;
  /** Who rolled (a hero's or a monster's name), or null for the GM. */
  who: string | null;
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  label: string | null;
  ts: number;
  /** Rolled with advantage or disadvantage (then `rolls` holds both d20s and `kept` the one that counts). */
  adv: Adv;
  kept: number | null;
  /** The d20 that counted, for natural 20 / natural 1. */
  natural: number | null;
  /** What it was rolled against (a DC, or an armor class for an attack). */
  dc: number | null;
  outcome: RollOutcome | null;
}

export interface Scene {
  title: string;
  description: string;
  image: ImageSlot;
}

/** setup → playing ↔ paused → ended. */
export type GamePhase = "setup" | "playing" | "paused" | "ended";
/** What play looks like right now (derived: paused while the phase is paused, combat while a fight runs). */
export type GameMode = "explore" | "combat" | "paused";

export interface Combatant {
  /** A player id or an npc id. */
  id: string;
  kind: "hero" | "npc";
  /** Initiative total. */
  init: number;
  /** The d20 that was kept. */
  roll: number;
  surprised: boolean;
  reactionUsed: boolean;
  /** Ids of creatures it is in melee with (who gets an opportunity attack if it walks away). */
  engaged: string[];
  lastTargetId: string | null;
  /** Who last damaged it (a monster turns on them). */
  lastAttackerId: string | null;
}

export interface Combat {
  round: number;
  /** Whose turn it is: an index into `order`. */
  index: number;
  /**
   * The creature whose turn it was has left the order (it died, or was taken out of the game): nobody is on turn, and
   * `index` rests on the place before the gap (−1 when the gap is at the head) until play runs on.
   */
  vacant: boolean;
  order: Combatant[];
  /** The hero on turn has used their bonus action. */
  bonusUsed: boolean;
  /** The hero on turn took the Disengage action. */
  disengaged: boolean;
  /** XP of the foes overcome so far. */
  xpEarned: number;
  /** Names of the foes overcome so far. */
  overcome: string[];
}

/** A roll the Game Master has called for and is waiting on. */
export interface PendingCheck {
  id: string;
  heroId: string;
  kind: "check" | "save" | "death";
  ability: AbilityKey | null;
  skill: string | null;
  /** "Dexterity saving throw", "Stealth check", "Death saving throw". */
  label: string;
  dc: number;
  adv: Adv;
  /** What it is for ("pick the lock on the gate"). */
  reason: string;
  /** The player's words that led to it. */
  words: string;
  askedAt: number;
  reminders: number;
  /** Resolving it ends the hero's turn (combat). */
  endsTurn: boolean;
}

/** A destructive step waiting for a spoken yes. */
export interface PendingConfirm {
  id: string;
  kind: "new_game" | "remove_player" | "load_game" | "end_campaign";
  targetId: string | null;
  words: string;
  question: string;
  askedAt: number;
}

/** A question the Game Master asked to finish an action ("Who is doing that?"). */
export interface PendingAction {
  id: string;
  /** The tool to finish once answered. */
  tool: string;
  words: string;
  question: string;
  need: "actor" | "target";
  actorId: string | null;
  askedAt: number;
}

export interface Pending {
  check: PendingCheck | null;
  confirm: PendingConfirm | null;
  action: PendingAction | null;
}

export type QuestStatus = "open" | "done" | "failed";
export interface Quest {
  id: string;
  title: string;
  detail: string;
  status: QuestStatus;
}
export interface Clue {
  id: string;
  text: string;
  found: boolean;
}
export interface Secret {
  id: string;
  text: string;
  revealed: boolean;
}

/** Campaign memory: what the story is, what the players haven't found, and what happened so far. */
export interface Story {
  premise: string;
  /** The planned beats, in order. */
  outline: string[];
  /** Index of the beat the story is in. */
  beat: number;
  secrets: Secret[];
  clues: Clue[];
  quests: Quest[];
  /** Notable facts established in play. */
  facts: string[];
  /** Bestiary keys of what lurks in this adventure (the encounter builder draws on them). */
  threats: string[];
  /** Rolling summary, refreshed in the background every few turns. */
  summary: string;
  summaryTurn: number;
  /** Story turns resolved so far. */
  turn: number;
  /** One line of facts per resolved turn, newest last. */
  recentTurns: string[];
  lastTurn: string;
  /** The Game Master's last spoken line, verbatim ("repeat that"). */
  lastNarration: string;
  sessions: number;
}

export type TableDifficulty = "easy" | "standard" | "hard";

/** How long the table wants the adventure to run: one evening, a few sessions, or an open-ended campaign. */
export type AdventureLength = "one-shot" | "short" | "campaign";

export interface TableSettings {
  difficulty: TableDifficulty;
  leveling: "xp" | "milestone";
  /** "ask": the GM calls for checks and death saves and the players roll (or say "roll for me"); "auto": the GM rolls everything. */
  rolls: "ask" | "auto";
  /** Content the table asked to leave out. */
  avoid: string[];
  expectedPlayers: number | null;
  /** As the table asked for it ("a short adventure", "a one-shot"), or null when nobody said. */
  length: AdventureLength | null;
}

/** Session-zero bookkeeping. */
export interface SetupState {
  /** The player name given for the seat being filled, until their hero joins. */
  seatName: string;
  /** How often each setup question was asked (so none is repeated at every turn). */
  asked: Record<string, number>;
  /** Table questions already answered or skipped ("players", "tone", "difficulty", "leveling"). */
  answered: string[];
}

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
  mode: GameMode;
  /** The combat round (0 outside a fight). */
  round: number;
  /** The hero acting now: whose turn it is in a fight, the spotlight hero otherwise. */
  activePlayerId: string | null;
  /** The hero the Game Master last handed the scene to, outside combat. */
  spotlightId: string | null;
  combat: Combat | null;
  pending: Pending;
  story: Story;
  settings: TableSettings;
  setupState: SetupState;
  /** Gold the party holds in common. */
  partyGold: number;
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

export type SetupStepKey = "adventure" | "players" | "party" | "table" | "begin";

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  done: boolean;
}

export interface SetupView {
  steps: SetupStep[];
  /** The Game Master's next setup question, or null once playing. */
  next: string | null;
  /** Which question that is ("adventure", "players", "seat-name", "seat-hero", "tone", "difficulty", "leveling", "begin"). */
  question: string | null;
}

// ─── View (what the game-screen template renders) ────────────────────────────

export interface ConditionView {
  name: string;
  /** Rounds left, or null when it lasts until removed. */
  rounds: number | null;
}

export interface SlotView {
  /** Spell level 1–9. */
  level: number;
  max: number;
  used: number;
}

export interface PlayerView extends Omit<Player, "portrait" | "appearance"> {
  portrait: ImageRef;
  conditionInfo: ConditionView[];
  /** Only the spell levels the hero has slots for. */
  slots: SlotView[];
  /** It is this hero's turn (combat) or they hold the spotlight (exploring). */
  isTurn: boolean;
}

export interface ItemView extends Omit<Item, "icon" | "appearance"> {
  icon: ImageRef;
  /** Held ready by its owner. */
  equipped: boolean;
}

/** How hurt a monster looks. Exact monster hit points never reach the screen. */
export type HealthBand = "healthy" | "bloodied" | "near death" | "down";

export interface NpcView {
  id: string;
  name: string;
  role: string;
  description: string;
  attitude: Attitude;
  portrait: ImageRef;
  status: NpcStatus;
  /** Shown for creatures that can fight; null for a bystander nobody has fought. */
  health: HealthBand | null;
  conditionInfo: ConditionView[];
  inCombat: boolean;
  isTurn: boolean;
}

export interface LocationView extends Omit<Location, "image"> {
  image: ImageRef;
}
export interface SceneView {
  title: string;
  description: string;
  image: ImageRef;
}

export interface CombatantView {
  id: string;
  kind: "hero" | "npc";
  name: string;
  init: number;
  current: boolean;
  /** A hero at 0 hit points. */
  down: boolean;
}

export interface CombatView {
  round: number;
  order: CombatantView[];
}

export interface TurnView {
  /** "turn" in a fight, "spotlight" while exploring. */
  kind: "turn" | "spotlight";
  id: string;
  name: string;
  playerName: string;
  isHero: boolean;
}

export interface PendingCheckView {
  heroId: string;
  hero: string;
  label: string;
  dc: number;
  adv: Adv;
  /** "Mira: Dexterity save, DC 13". */
  text: string;
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
  mode: GameMode;
  setup: SetupView;
  /** The combat round (0 outside a fight). */
  round: number;
  activePlayerId: string | null;
  spotlightId: string | null;
  turn: TurnView | null;
  combat: CombatView | null;
  pendingCheck: PendingCheckView | null;
  /** A yes/no or "who?" question the Game Master is waiting on. */
  pendingQuestion: string | null;
  quests: Quest[];
  /** Story turns resolved so far. */
  storyTurn: number;
  partyGold: number;
  settings: { difficulty: TableDifficulty; leveling: "xp" | "milestone"; rolls: "ask" | "auto" };
  about: { rules: string; attribution: string };
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
