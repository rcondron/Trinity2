import { imageUrl } from "../services/images.js";
import { healthBand } from "./bestiary.js";
import { checkLabel } from "./engine.js";
import { isSkill } from "./rules.js";
import { setupView } from "./setup.js";
import { RULES_NAME, SRD_ATTRIBUTION } from "./srd.js";
import type {
  CombatView,
  ConditionView,
  Game,
  GameView,
  ImageRef,
  ImageSlot,
  ItemView,
  LocationView,
  NpcView,
  PendingCheckView,
  PlayerView,
  SlotView,
  TurnView,
} from "./types.js";

/**
 * What the game-screen template renders (template contract v2). The view is the whole contract between the engine
 * and a screen: everything a screen needs is computed here (whose turn it is, the initiative strip, a monster's
 * health as a band instead of numbers, conditions with the rounds they have left, the roll being waited for), so a
 * template only has to draw.
 */

export const VIEW_LOG_LIMIT = 200;

/**
 * The fields of the view, by part. One list, used in three places: the default template declares the fields it reads
 * and scripts/test-game-board.mts checks that declaration against this list and against what toView really produces;
 * present.ts uses VIEW_REQUIRED_PARTS to decide whether a generated screen draws enough of the game to be used.
 */
export const VIEW_CONTRACT = {
  top: [
    "kind", "id", "title", "genre", "tone", "setting", "theme", "phase", "mode", "setup", "round", "activePlayerId", "spotlightId", "turn",
    "combat", "pendingCheck", "pendingQuestion", "quests", "storyTurn", "partyGold", "settings", "about", "titleImage", "scene", "players",
    "npcs", "items", "locations", "currentLocationId", "log", "lastRoll", "busy", "updatedAt",
  ],
  player: [
    "id", "name", "playerName", "race", "className", "level", "hp", "maxHp", "tempHp", "ac", "speed", "stats", "background", "traits",
    "conditions", "conditionInfo", "exhaustion", "gold", "xp", "inventory", "portrait", "pending", "slots", "concentration", "inspiration",
    "deathSaves", "stable", "dead", "equipped", "isTurn",
  ],
  npc: ["id", "name", "role", "description", "attitude", "portrait", "status", "health", "conditionInfo", "inCombat", "isTurn"],
  item: ["id", "name", "type", "rarity", "description", "ownerId", "icon", "quantity", "equipped"],
  location: ["id", "name", "x", "y", "connections", "visited"],
  log: ["id", "ts", "kind", "text"],
  roll: ["id", "who", "notation", "rolls", "modifier", "total", "label", "ts", "adv", "kept", "natural", "dc", "outcome"],
  combat: ["round", "order"],
  combatant: ["id", "kind", "name", "init", "current", "down"],
  turn: ["kind", "id", "name", "playerName", "isHero"],
  pendingCheck: ["heroId", "hero", "label", "dc", "adv", "text"],
  quest: ["id", "title", "detail", "status"],
  setup: ["steps", "next"],
  scene: ["title", "description", "image"],
} as const;

/** The parts of the view a screen must draw to be used at all: without these the table can't follow the game. */
export const VIEW_REQUIRED_PARTS = ["players", "npcs", "scene", "log", "lastRoll", "combat", "turn", "pendingCheck", "quests"] as const;

/** The required parts a screen's source never reads (`state.combat`, `s["quests"]`…). Empty: it draws them all. */
export function missingViewParts(source: string): string[] {
  return VIEW_REQUIRED_PARTS.filter((part) => !new RegExp(`\\.${part}\\b|\\[["']${part}["']\\]`).test(source));
}

export function toImageRef(slot: ImageSlot | null | undefined): ImageRef {
  if (!slot) return { url: null, status: "none" };
  return { url: slot.status === "ready" && slot.id ? imageUrl(slot.id) : null, status: slot.status };
}

const conditionInfo = (c: { conditions: string[]; conditionRounds: Record<string, number> }): ConditionView[] =>
  c.conditions.map((name) => ({ name, rounds: c.conditionRounds[name] ?? null }));

function turnView(game: Game): TurnView | null {
  if (game.phase !== "playing" && game.phase !== "paused") return null;
  if (game.combat) {
    const c = game.combat.vacant ? null : game.combat.order[game.combat.index];
    if (!c) return null;
    if (c.kind === "hero") {
      const p = game.players.find((x) => x.id === c.id);
      return p ? { kind: "turn", id: p.id, name: p.name, playerName: p.playerName, isHero: true } : null;
    }
    const n = game.npcs.find((x) => x.id === c.id);
    return n ? { kind: "turn", id: n.id, name: n.name, playerName: "", isHero: false } : null;
  }
  const p = game.players.find((x) => x.id === game.spotlightId);
  return p ? { kind: "spotlight", id: p.id, name: p.name, playerName: p.playerName, isHero: true } : null;
}

function combatView(game: Game): CombatView | null {
  const c = game.combat;
  if (!c) return null;
  return {
    round: c.round,
    order: c.order.map((x, i) => {
      const hero = x.kind === "hero" ? game.players.find((p) => p.id === x.id) : null;
      const npc = x.kind === "npc" ? game.npcs.find((n) => n.id === x.id) : null;
      return { id: x.id, kind: x.kind, name: hero?.name ?? npc?.name ?? "?", init: x.init, current: i === c.index && !c.vacant, down: hero ? hero.hp <= 0 : false };
    }),
  };
}

function pendingCheckView(game: Game): PendingCheckView | null {
  const pc = game.pending.check;
  const hero = pc ? game.players.find((p) => p.id === pc.heroId) : null;
  if (!pc || !hero) return null;
  const label =
    pc.kind === "death"
      ? "Death save"
      : pc.ability
        ? checkLabel({ kind: pc.kind, ability: pc.ability, skill: isSkill(pc.skill) ? pc.skill : null }).replace(/ saving throw$/, " save")
        : pc.label;
  return { heroId: hero.id, hero: hero.name, label, dc: pc.dc, adv: pc.adv, text: `${hero.name}: ${label}, DC ${pc.dc}` };
}

export function toView(game: Game, busy: string[] = []): GameView {
  const turn = turnView(game);
  const inFight = new Set(game.combat?.order.map((c) => c.id) ?? []);
  const players: PlayerView[] = game.players.map(({ portrait, appearance: _a, ...p }) => {
    const slots: SlotView[] = [];
    p.slotsMax.forEach((max, i) => {
      if (max > 0) slots.push({ level: i + 1, max, used: Math.min(max, p.slotsUsed[i] ?? 0) });
    });
    return {
      ...p,
      traits: [...p.traits],
      conditions: [...p.conditions],
      conditionRounds: { ...p.conditionRounds },
      conditionInfo: conditionInfo(p),
      inventory: [...p.inventory],
      stats: { ...p.stats },
      saveProficiencies: [...p.saveProficiencies],
      skillProficiencies: [...p.skillProficiencies],
      slotsMax: [...p.slotsMax],
      slotsUsed: [...p.slotsUsed],
      spells: [...p.spells],
      deathSaves: { ...p.deathSaves },
      equipped: { ...p.equipped },
      resistances: [...p.resistances],
      slots,
      // Always present for a screen (on a sheet it is only set while the hero is still being drawn up).
      pending: p.pending === true,
      isTurn: turn?.id === p.id,
      portrait: toImageRef(portrait),
    };
  });
  const worn = new Set(game.players.flatMap((p) => Object.values(p.equipped).filter((id): id is string => !!id)));
  const items: ItemView[] = game.items.map(({ icon, appearance: _a, ...it }) => ({
    ...it,
    properties: [...it.properties],
    icon: toImageRef(icon),
    equipped: worn.has(it.id),
  }));
  // A creature's numbers stay behind the screen: the table sees how hurt it looks, never its hit points or armor class.
  const npcs: NpcView[] = game.npcs.map((n) => ({
    id: n.id,
    name: n.name,
    role: n.role,
    description: n.description,
    attitude: n.attitude,
    portrait: toImageRef(n.portrait),
    status: n.status,
    health: n.status !== "alive" ? "down" : n.attitude === "hostile" || inFight.has(n.id) || n.hp < n.maxHp ? healthBand(n.hp, n.maxHp) : null,
    conditionInfo: conditionInfo(n),
    inCombat: inFight.has(n.id),
    isTurn: turn?.id === n.id,
  }));
  const locations: LocationView[] = game.locations.map(({ image, ...l }) => ({
    ...l,
    connections: [...l.connections],
    image: toImageRef(image),
  }));
  const question = game.pending.confirm?.question ?? game.pending.action?.question ?? null;
  return {
    kind: "game",
    id: game.id,
    title: game.title,
    genre: game.genre,
    tone: game.tone,
    setting: game.setting,
    theme: structuredClone(game.theme),
    phase: game.phase,
    mode: game.mode,
    setup: setupView(game),
    round: game.combat?.round ?? 0,
    activePlayerId: turn?.isHero ? turn.id : null,
    spotlightId: game.spotlightId,
    turn,
    combat: combatView(game),
    pendingCheck: pendingCheckView(game),
    pendingQuestion: question,
    quests: game.story.quests.map((q) => ({ ...q })),
    storyTurn: game.story.turn,
    partyGold: game.partyGold,
    settings: { difficulty: game.settings.difficulty, leveling: game.settings.leveling, rolls: game.settings.rolls },
    about: { rules: RULES_NAME, attribution: SRD_ATTRIBUTION },
    titleImage: toImageRef(game.titleImage),
    scene: game.scene
      ? { title: game.scene.title, description: game.scene.description, image: toImageRef(game.scene.image) }
      : null,
    players,
    npcs,
    items,
    locations,
    currentLocationId: game.currentLocationId,
    log: game.log.slice(-VIEW_LOG_LIMIT).map((e) => ({ ...e })),
    lastRoll: game.lastRoll ? { ...game.lastRoll, rolls: [...game.lastRoll.rolls] } : null,
    busy: [...busy],
    updatedAt: game.updatedAt,
  };
}
