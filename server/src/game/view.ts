import { imageUrl } from "../services/images.js";
import { setupView } from "./setup.js";
import type {
  Game,
  GameView,
  ImageRef,
  ImageSlot,
  ItemView,
  LocationView,
  NpcView,
  PlayerView,
} from "./types.js";

/** What the game-screen template renders (template contract v1). */

export const VIEW_LOG_LIMIT = 200;

export function toImageRef(slot: ImageSlot | null | undefined): ImageRef {
  if (!slot) return { url: null, status: "none" };
  return { url: slot.status === "ready" && slot.id ? imageUrl(slot.id) : null, status: slot.status };
}

export function toView(game: Game, busy: string[] = []): GameView {
  const players: PlayerView[] = game.players.map(({ portrait, appearance: _a, ...p }) => ({
    ...p,
    traits: [...p.traits],
    conditions: [...p.conditions],
    inventory: [...p.inventory],
    stats: { ...p.stats },
    portrait: toImageRef(portrait),
  }));
  const items: ItemView[] = game.items.map(({ icon, appearance: _a, ...it }) => ({
    ...it,
    properties: [...it.properties],
    icon: toImageRef(icon),
  }));
  const npcs: NpcView[] = game.npcs.map(({ portrait, appearance: _a, ...n }) => ({ ...n, portrait: toImageRef(portrait) }));
  const locations: LocationView[] = game.locations.map(({ image, ...l }) => ({
    ...l,
    connections: [...l.connections],
    image: toImageRef(image),
  }));
  return {
    kind: "game",
    id: game.id,
    title: game.title,
    genre: game.genre,
    tone: game.tone,
    setting: game.setting,
    theme: structuredClone(game.theme),
    phase: game.phase,
    setup: setupView(game),
    round: game.round,
    activePlayerId: game.activePlayerId,
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
