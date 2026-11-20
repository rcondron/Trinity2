import { registerTool } from "../tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { isQuestion, isStoryMove, isTableTalk, LOOKING } from "./adjudicate.js";
import { findMonster } from "./bestiary.js";
import {
  addItem,
  buyItem,
  damageWords,
  dismissNpc,
  dropItem,
  equipItem,
  foes,
  giveItem,
  healHero,
  heroArmorClass,
  heroById,
  hurtHero,
  hurtNpc,
  itemsOf,
  joinCombat,
  killHero,
  leaveCombat,
  levelUp,
  living,
  moveGold,
  notYourTurn,
  outfit,
  partyLevel,
  passSpotlight,
  promptLine,
  removeItem,
  sellItem,
  settleFight,
  startCombat,
  turnHero,
  unequipItem,
  useItem,
} from "./engine.js";
import {
  aOrAn,
  capped,
  changeFromWords,
  digitize,
  firstSentence,
  frameFromWords,
  genGameFrame,
  genLoot,
  genNpc,
  genPlayerChange,
  genPlayers,
  genScene,
  hasAdventureDetails,
  heroesFromWords,
  hpFor,
  inferItemType,
  isEmptyChange,
  lootFromWords,
  npcFromWords,
  parseHeroes,
  readyMadeHero,
  saysKind,
  sceneFromWords,
  type GameFrame,
  type GeneratedPlayer,
  type PlayerChange,
  type SceneDraft,
} from "./generate.js";
import {
  confirmPending,
  countIn,
  dice,
  exploring,
  gameOptions,
  guarded,
  hasHeroes,
  hasSavedGames,
  heroLine,
  inPlay,
  inSetup,
  invalidateSnapshots,
  NO_GAME,
  notEnded,
  onConfirm,
  paint,
  partyWord,
  pendingAction,
  playerOptions,
  recentLines,
  resolveActor,
  resumable,
  resumeTool,
  silent,
  spawnCreatures,
  spoken,
  withTurn,
} from "./kit.js";
import { fitSentences, joinLines, npcRef, plural } from "./lines.js";
import { applyStory, fallbackStory, genStory, recap, rememberSpoken } from "./memory.js";
import { findHero, findHeroes, findItem, findNpc, listNames, namedActor, norm, sameName } from "./names.js";
import { registerPlayTools } from "./play-tools.js";
import { presentGame, presentIfCurrent, setBusy } from "./present.js";
import * as R from "./rules.js";
import {
  askNext,
  isEveryone,
  isFramed,
  isNameWord,
  isSkip,
  lengthIn,
  missingLine,
  parseCount,
  parseDifficulty,
  parseLeveling,
  parsePlayerName,
  parseReadyMade,
  parseRolls,
  parseToneAndLines,
  playerCountIn,
  readyMadeOptions,
  realPlayers,
  settle,
  settleWhoPlays,
  setupQuestion,
  setupView,
} from "./setup.js";
import { classProfile, damageTypeIn, healingDice, isConsumable, itemPrice, speciesResistances } from "./srd.js";
import {
  MAX_PLAYERS,
  NEW_GAME_TITLE,
  PLACEHOLDER_NAMES,
  addLog,
  blankPlayer,
  checkpointGame,
  createGame,
  defaultStatBlock,
  defaultTheme,
  emptySlot,
  emptyStory,
  getActiveGame,
  getGame,
  listGames,
  mutateGame,
  newId,
  placeholderSlot,
  releasePlaceholder,
  setActiveGame,
  setCustomTemplate,
  settledNpcs,
  trackPlaceholder,
} from "./store.js";
import { frameKey, startCustomTemplate } from "./template-gen.js";
import type { AdventureLength, Game, Item, Location, Npc, PendingConfirm, Player } from "./types.js";

/**
 * The Game Master's table tools (toolset "game"): session zero, the party, items and gold, characters and creatures,
 * scenes, and the saved games. Each one works the same way: the game changes through one serialized mutation, the
 * screen is told at once, art is requested in the background, and the result is a line built in code and spoken
 * exactly as written (`speak`), so what is said always matches what the board shows.
 *
 * Steps that can't be taken back (starting a new game over one in play, removing a hero, loading over a game in play)
 * fire only on a finished sentence and wait for a spoken yes: the question is kept in the game (pending.confirm) and
 * the next "yes" or "no" settles it, whichever tool the router hands it to (kit.guarded).
 */

/** Hard cap on awaited generation (the agent core times tools out at 15s). */
const GEN_CAP_MS = 8000;
/** Model request budget, inside the cap. */
const GEN_TIMEOUT_MS = 7500;

// ─── Small helpers ───────────────────────────────────────────────────────────

const COUNT_SAID = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** "a short high fantasy adventure for two players": the kind of game, the way the table asked for it. */
function framePhrase(g: Game): string {
  const genre = g.genre.trim() || "fantasy";
  const length = g.settings.length;
  const size = length === "short" ? "short " : length === "one-shot" ? "one-shot " : "";
  const noun = /\b(adventure|campaign|game|story|saga|tale|mystery|quest|odyssey|thriller|survival)\b/i.test(genre) ? "" : length === "campaign" ? " campaign" : " adventure";
  const n = g.settings.expectedPlayers;
  const who = n ? ` for ${n === 1 ? "one player" : `${COUNT_SAID[n] ?? n} players`}` : "";
  return `${aOrAn(`${size}${genre}`)}${noun}${who}`;
}

/**
 * What the words that asked for the game already said about the table, beyond the kind of story: how many are
 * playing ("for two players"), how long ("a short adventure"), a mood ("something spooky") and lines to keep out
 * ("no spiders"). Taken at once, so session zero never asks for what it was just told.
 */
interface FirstWords {
  count: number | null;
  length: AdventureLength | null;
  mood: string | null;
  avoid: string[];
}
function firstWords(utterance: string): FirstWords {
  const said = parseToneAndLines(utterance);
  return { count: playerCountIn(utterance), length: lengthIn(utterance), mood: said.tone, avoid: said.avoid };
}
function takeFirstWords(g: Game, w: FirstWords): void {
  if (w.count !== null) {
    g.settings.expectedPlayers = Math.min(MAX_PLAYERS, Math.max(w.count, realPlayers(g).length));
    settle(g, "players");
  }
  if (w.length) g.settings.length = w.length;
  for (const a of w.avoid) if (!g.settings.avoid.includes(a)) g.settings.avoid.push(a);
  // A mood word that is part of the genre ("dark fantasy") names the genre, not a tone of its own.
  const moods = (w.mood ?? "").split(" and ").filter((m) => m && !g.genre.toLowerCase().includes(m));
  if (moods.length) {
    // The frame's own tone stays when it already says the mood ("grim and haunting" for "something grim").
    if (!moods.every((m) => g.tone.toLowerCase().includes(m))) g.tone = moods.join(" and ");
    settle(g, "mood");
    if (w.avoid.length) settle(g, "tone");
  }
}

const heroTitle = (p: Player) => `${p.name} the ${heroLine(p)}`;
const playedBy = (p: Player) => (p.playerName ? `, played by ${p.playerName}` : "");

export { findHero as findPlayerByName, sameName };

// ─── Entities ────────────────────────────────────────────────────────────────

function placeholderPlayer(id: string, name: string): Player {
  return { ...blankPlayer(id, name), portrait: placeholderSlot(), pending: true };
}

const portraitPrompt = (p: Player) => `${heroLine(p)}. ${p.appearance}`;

/** Marks auto-created starting gear, so a revised sheet replaces it (and nothing found later). */
const STARTING_GEAR = "starting gear";

/** A hero's starting gear; each icon is painted quietly (no busy label per item, lowest priority). */
function addGear(g: Game, h: GeneratedPlayer, ownerId: string): void {
  for (const gd of h.gear) {
    const it = addItem(g, { name: gd.name, type: gd.type, rarity: "common", properties: [STARTING_GEAR], appearance: gd.name }, ownerId);
    it.icon = paint(g, "icon", `${gd.name}, ${gd.type}`, null);
  }
}

/** A generated hero → a real party member with starting gear put on, an armor class that follows it, and a portrait on the way. */
function materializePlayer(g: Game, h: GeneratedPlayer, id: string): Player {
  const { gear: _gear, reviseOf: _revise, ...sheet } = h;
  const p: Player = { ...sheet, id, inventory: [], conditions: [], portrait: emptySlot() };
  delete p.pending;
  // Portrait first: priority only orders queued art, and whatever asks first takes a free slot.
  p.portrait = paint(g, "portrait", portraitPrompt(p), `Painting ${p.name}'s portrait…`);
  return p;
}

/** Auto-created starting gear: marked — or, in games saved before the marker, common with no description and no art. */
const isStartingGear = (it: Item, ownerId: string) =>
  it.ownerId === ownerId &&
  (it.properties.includes(STARTING_GEAR) || (it.rarity === "common" && !it.description && it.icon.status === "none" && !it.icon.id));

/** A hero's class changed: the rules chassis follows (hit die, saves, skills, spellcasting), keeping level and wounds. */
function reclass(p: Player): void {
  const profile = classProfile(p.className);
  const ratio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
  p.hitDie = profile.hitDie;
  p.maxHp = hpFor(p.className, p.stats.con, p.level);
  p.hp = p.dead ? 0 : Math.max(p.hp > 0 ? 1 : 0, Math.round(p.maxHp * ratio));
  p.saveProficiencies = [...profile.saves];
  p.skillProficiencies = [...profile.skills];
  p.castingAbility = profile.ability;
  p.slotsMax = R.slotsFor(profile.caster, p.level);
  p.slotsUsed = p.slotsUsed.map((u, i) => Math.min(u, p.slotsMax[i] ?? 0));
  p.spells = [...profile.spells];
  p.resistances = speciesResistances(p.race);
}

/** New details for an existing hero ("I'm Thorin" … "I'm a dwarf fighter"). Keeps id, progress and loot. */
function reviseSheet(g: Game, p: Player, h: GeneratedPlayer): void {
  const looksChanged = norm(heroLine(p)) !== norm(heroLine(h)) || norm(p.appearance) !== norm(h.appearance);
  p.race = h.race;
  p.className = h.className;
  p.stats = { ...h.stats };
  reclass(p);
  p.speed = h.speed;
  if (h.background) p.background = h.background;
  if (h.traits.length) p.traits = [...h.traits];
  if (h.appearance) p.appearance = h.appearance;
  if (looksChanged || p.portrait.status === "none" || p.portrait.status === "error")
    p.portrait = paint(g, "portrait", portraitPrompt(p), `Painting ${p.name}'s portrait…`);
  if (g.phase === "setup") {
    g.items = g.items.filter((it) => !isStartingGear(it, p.id));
    p.inventory = [];
    p.equipped = { weapon: null, armor: null, shield: null };
    addGear(g, h, p.id);
    p.ac = h.ac;
    outfit(g, p);
  }
}

/** A new name for an existing hero: only one the player actually said (the model may invent one) that nobody else has. */
function statedRename(g: Game, p: Player, h: GeneratedPlayer, utterance: string): string | null {
  const name = h.name.trim();
  if (!name || sameName(p.name, name) || !` ${norm(utterance)} `.includes(` ${norm(name)} `)) return null;
  return realPlayers(g).some((o) => o.id !== p.id && sameName(o.name, name)) ? null : name;
}

function matchExisting(g: Game, h: GeneratedPlayer): Player | null {
  const party = realPlayers(g);
  if (h.reviseOf) {
    const byRevise = party.find((p) => sameName(p.name, h.reviseOf!)) ?? findHero(g, h.reviseOf);
    if (byRevise) return byRevise;
  }
  return party.find((p) => sameName(p.name, h.name)) ?? null;
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
 * Make a scene current: scene panel, map node (new or revisited, connected to where we were), art, log. Moving on
 * leaves the fallen behind: creatures that were defeated or fled are taken off the board.
 */
export function applyScene(g: Game, s: SceneDraft): void {
  const image = paint(g, "scene", s.imagePrompt, `Painting ${s.title}…`);
  g.scene = { title: s.title, description: s.description, image };
  const prev = g.locations.find((l) => l.id === g.currentLocationId) ?? null;
  let loc = g.locations.find((l) => sameName(l.name, s.locationName) || sameName(l.name, s.title)) ?? null;
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
    if (!g.combat) g.npcs = g.npcs.filter((n) => n.status === "alive");
  }
  g.currentLocationId = loc.id;
  addLog(g, "narration", `${s.title}: ${firstSentence(s.description)}`);
}

// ─── A new adventure ─────────────────────────────────────────────────────────

const REFRAME_RE = /\b(instead|actually|rather|change|switch|make it|different|how about)\b/i;
const PAUSE_RE = /\b(pause|take a break|break time|hold the game|stop for (?:now|a (?:bit|minute|moment|sec(?:ond)?))|put (?:the game|it) on hold|resume|unpause)\b/i;
const BEGIN_RE = /\b(let'?s (?:begin|start|go|play)|start the (?:game|adventure)|begin the (?:game|adventure)|we'?re (?:all )?ready|ready to (?:begin|start|play)|that'?s everyone|kick (?:it|things) off)\b/i;
const NEW_RE = /\b(new|another|different|fresh|brand[- ]new|start over|from scratch|scrap (?:this|it)|restart)\b/i;
/** "Before we begin…", "don't start yet", "can we start after dinner?": the word is there, the wish isn't. */
const NOT_YET_RE = /\b(before|until|not yet|don'?t|do not|wait|hold on|after|later|first let|can we (?:not|wait))\b/i;

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
  g.story = emptyStory();
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
  g.story.premise = f.setting;
  addLog(g, "system", `New adventure: ${f.title} — ${f.setting}`);
}

/** Ask a yes/no before a step that can't be taken back, and keep the question in the game until it is answered. */
async function askConfirm(game: Game, kind: PendingConfirm["kind"], targetId: string | null, words: string, question: string): Promise<ToolResult> {
  await mutateGame(game.id, (g) => {
    g.pending.confirm = { id: newId(), kind, targetId, words, question, askedAt: Date.now() };
  });
  presentIfCurrent(game.id);
  return spoken(question, { confirm: kind });
}

/** The next setup question, counted so it is never the same sentence twice in a row. */
async function nextQuestion(gameId: string): Promise<string> {
  let ask = "";
  await mutateGame(gameId, (g) => {
    ask = askNext(g);
  });
  return ask;
}

async function runNewGame(ctx: ToolContext, utterance: string, opts: { confirmed?: boolean } = {}): Promise<ToolResult> {
  const pid = ctx.persona.id;
  const ignore = ctx.persona.name.split(/\s+/).filter(Boolean);
  const details = hasAdventureDetails(utterance, ignore);
  const current = getActiveGame(pid);
  const inPlayNow = current !== null && (current.phase === "playing" || current.phase === "paused");

  if (current && !opts.confirmed) {
    // "Pause the game" pauses, and "let's start" begins, whatever the router called it: never a blank new table.
    if (inPlayNow && PAUSE_RE.test(utterance) && !NEW_RE.test(utterance)) return (await resumeTool("game_pause", ctx, utterance)) ?? spoken("The game is paused.");
    if (current.phase === "setup" && isFramed(current) && BEGIN_RE.test(utterance) && !NEW_RE.test(utterance)) return runBegin(ctx, utterance);
    if (inPlayNow) {
      if (!NEW_RE.test(utterance) && !details) {
        return spoken(current.phase === "paused" ? `${current.title} is paused. Say resume to go on.` : [`${current.title} is already under way.`, promptLine(current)]);
      }
      return askConfirm(current, "new_game", null, utterance, `Start a new game and set ${current.title} aside? It stays saved. Say yes or no.`);
    }
    if (current.phase === "setup" && isFramed(current) && realPlayers(current).length > 0) {
      if (details && REFRAME_RE.test(utterance)) return runReframe(ctx, utterance, current);
      if (NEW_RE.test(utterance)) return askConfirm(current, "new_game", null, utterance, `Drop ${current.title} and its heroes, and start over? Say yes or no.`);
      return spoken([`We're already setting up ${current.title}.`, await nextQuestion(current.id)]);
    }
  }

  // fresh: a brand-new game · frame: name the adventure of a setup game that has none yet ·
  // restart: an empty setup game gets a new adventure.
  let mode: "fresh" | "frame" | "restart" = "fresh";
  if (current && current.phase === "setup" && !opts.confirmed) mode = !isFramed(current) ? "frame" : "restart";
  if (current && current.phase === "setup" && opts.confirmed) mode = "fresh";

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

  // How many, how long, a mood: whatever the first sentence said about the table is kept, framed or not.
  const said = firstWords(utterance);
  const unframed = async (lead: string): Promise<ToolResult> => {
    let ask = "";
    const saved = await mutateGame(gameId, (g) => {
      takeFirstWords(g, said);
      ask = askNext(g);
    });
    presentIfCurrent(gameId);
    const forWho = saved?.settings.expectedPlayers ? ` for ${saved.settings.expectedPlayers === 1 ? "one player" : `${COUNT_SAID[saved.settings.expectedPlayers] ?? saved.settings.expectedPlayers} players`}` : "";
    return spoken([`${lead}${forWho}.`, ask]);
  };
  if (!details) return unframed(mode === "fresh" ? "A fresh table is ready" : mode === "restart" ? "The table is cleared for a new adventure" : "The game table is ready");
  setBusy(gameId, "frame", "Imagining the adventure…");
  presentIfCurrent(gameId);
  try {
    const frame = await capped(genGameFrame(utterance, { timeoutMs: GEN_TIMEOUT_MS, ignoreWords: ignore }), GEN_CAP_MS, () => frameFromWords(utterance, ignore));
    if (!frame.described) return unframed("The game table is ready");
    let ask = "";
    const saved = await mutateGame(gameId, (g) => {
      applyFrame(g, frame);
      takeFirstWords(g, said);
      ask = askNext(g);
    });
    if (!saved) return { ok: false, say: "The game table vanished before it was set up — try starting a new game again." };
    if (mode !== "fresh") setCustomTemplate(gameId, null);
    startCustomTemplate(gameId, { fresh: true });
    presentIfCurrent(gameId);
    return spoken([`${saved.title}: ${framePhrase(saved)}.`, fitSentences(saved.setting, 40) || firstSentence(saved.setting), ask]);
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
    const frame = await capped<GameFrame | null>(genGameFrame(utterance, { timeoutMs: GEN_TIMEOUT_MS, ignoreWords: ignore, current: game }), GEN_CAP_MS, () => null);
    // A canned fallback frame would throw away the real one — say so instead.
    if (!frame || frame.source === "fallback") return spoken("I couldn't rework the adventure just now. Say what to change once more.");
    if (!frame.described) return spoken([`The adventure stays ${game.title}.`, await nextQuestion(game.id)]);
    const before = frameKey(game);
    let ask = "";
    const saved = await mutateGame(game.id, (g) => {
      const lookChanged =
        norm(g.genre) !== norm(frame.genre) || norm(g.tone) !== norm(frame.tone) || norm(g.setting) !== norm(frame.setting) || norm(g.artStyle) !== norm(frame.artStyle);
      g.title = frame.title;
      g.genre = frame.genre;
      g.tone = frame.tone;
      g.setting = frame.setting;
      g.story.premise = frame.setting;
      if (lookChanged) {
        g.artStyle = frame.artStyle;
        g.theme = frame.theme;
        g.titleImage = paint(g, "title", frame.titleArtPrompt, "Painting the title art…");
      }
      addLog(g, "system", `The adventure is reshaped: ${frame.title} — ${frame.setting}`);
      ask = askNext(g);
    });
    if (!saved) return { ok: false, say: "The game was closed before the adventure could change." };
    if (frameKey(saved) !== before) {
      setCustomTemplate(saved.id, null);
      startCustomTemplate(saved.id, { fresh: true });
    }
    presentIfCurrent(saved.id);
    return spoken([`Now it's ${saved.title}: ${framePhrase(saved)}.`, fitSentences(saved.setting, 35) || firstSentence(saved.setting), ask]);
  } finally {
    setBusy(game.id, "frame", null);
  }
}

/** Set the kind of adventure while setting up: frames a game that has none, adjusts one that has. */
async function runConfigure(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (game && game.phase !== "setup") return spoken(`${game.title} is already under way. Say you want a new game to play something different.`);
  if (game) {
    const answered = await setupAnswer(game, utterance);
    if (answered) return answered;
  }
  if (game && isFramed(game)) return runReframe(ctx, utterance, game);
  return runNewGame(ctx, utterance); // no game yet → create one; a setup game without a frame → frame it
}

// ─── Session zero: the table's answers ───────────────────────────────────────

const COUNT_WORDS = /\b(players?|people|of us|persons?|playing|at the table|just me|only me|solo)\b/i;

/**
 * An answer to the setup question on the table (how many players, a player's name, who plays a hero, that's everyone,
 * tone and lines, difficulty, leveling), or a table rule said out of turn ("make the fights hard", "roll for us").
 * Returns what to say, or null when the words aren't one of those.
 */
async function setupAnswer(game: Game, utterance: string, direct = false): Promise<ToolResult | null> {
  const q = game.phase === "setup" ? setupQuestion(game) : null;
  const describes = parseHeroes(utterance).some((h) => h.race || h.className) || parseReadyMade(utterance, readyMadeOptions(game)) !== null;
  const done = async (line: string, change: (g: Game) => void): Promise<ToolResult> => {
    let ask = "";
    const saved = await mutateGame(game.id, (g) => {
      change(g);
      ask = g.phase === "setup" ? askNext(g) : "";
    });
    if (!saved) return { ok: false, say: "The game was closed before that could be noted." };
    presentIfCurrent(saved.id);
    return spoken([line, ask]);
  };

  const count = parseCount(utterance);
  if (count !== null && !describes && (q === "players" || (game.phase === "setup" && COUNT_WORDS.test(utterance) && !parsePlayerName(utterance)))) {
    const n = Math.min(MAX_PLAYERS, Math.max(count, realPlayers(game).length));
    return done(n === 1 ? "A solo adventure, then." : `${n} players.`, (g) => {
      g.settings.expectedPlayers = n;
      settle(g, "players");
    });
  }
  if (q === "players" && isSkip(utterance)) return done("We'll count as you join.", (g) => settle(g, "players"));

  if ((q === "seat-name" || q === "more") && !describes) {
    if (q === "more" && isEveryone(utterance)) return done("That's the party.", (g) => settle(g, "party"));
    const name = parsePlayerName(utterance);
    if (name) return done("Welcome.", (g) => (g.setupState.seatName = name));
  }
  if (q === "who-plays" && !describes) {
    const hero = realPlayers(game).at(-1);
    const name = parsePlayerName(utterance);
    if (hero && name) {
      return done(`${hero.name} is played by ${name}.`, (g) => {
        const h = heroById(g, hero.id);
        if (h) h.playerName = name;
        settleWhoPlays(g, hero.id);
      });
    }
    if (hero && isSkip(utterance)) return done("All right.", (g) => settleWhoPlays(g, hero.id));
  }

  const difficulty = parseDifficulty(utterance);
  const leveling = parseLeveling(utterance);
  const rolls = parseRolls(utterance);
  if (q === "tone" && !difficulty && !leveling && !describes) {
    const parsed = parseToneAndLines(utterance);
    const avoid = parsed.avoid;
    let tone = parsed.tone;
    const skipped = isSkip(utterance);
    // A tone in the table's own words ("like a Saturday morning cartoon") is kept as said, when it was the answer asked for.
    const asSaid = utterance.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
    if (!tone && !avoid.length && !skipped) {
      if (!direct || asSaid.split(" ").length > 8) return null;
      tone = asSaid.toLowerCase();
    }
    const noted = [tone ? `${tone} it is` : "", avoid.length ? `I'll leave out ${listNames(avoid)}` : ""].filter(Boolean).join(", and ");
    return done(noted ? `${noted.charAt(0).toUpperCase()}${noted.slice(1)}.` : "No limits, then.", (g) => {
      if (tone) g.tone = tone;
      for (const a of avoid) if (!g.settings.avoid.includes(a)) g.settings.avoid.push(a);
      settle(g, "tone");
    });
  }
  if (difficulty && (q === "difficulty" || /\b(fights?|battles?|combat|difficulty|encounters?|make it|keep it|go)\b/i.test(utterance))) {
    return done(`${difficulty.charAt(0).toUpperCase()}${difficulty.slice(1)} fights.`, (g) => {
      g.settings.difficulty = difficulty;
      settle(g, "difficulty");
    });
  }
  if (q === "difficulty" && isSkip(utterance)) return done("Standard fights, then.", (g) => settle(g, "difficulty"));
  if (leveling && (q === "leveling" || /\b(level|leveling|levels?)\b/i.test(utterance))) {
    return done(leveling === "xp" ? "Experience points it is." : "Milestones it is.", (g) => {
      g.settings.leveling = leveling;
      settle(g, "leveling");
    });
  }
  if (q === "leveling" && isSkip(utterance)) return done("Experience points, then.", (g) => settle(g, "leveling"));
  if (rolls) return done(rolls === "auto" ? "I'll roll all the dice from here." : "You roll your own checks; just tell me the number.", (g) => (g.settings.rolls = rolls));
  return null;
}

/** game_setup: the table's answer to a setup question, or a table rule changed during play. */
async function runSetup(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const answered = await setupAnswer(game, utterance, true);
  if (answered) return answered;
  if (game.phase !== "setup") return spoken("Tell me what to change: how hard the fights are, leveling by experience or milestones, or who rolls the dice.");
  if (parseHeroes(utterance).some((h) => h.race || h.className) || parseReadyMade(utterance, readyMadeOptions(game))) return runAddPlayer(ctx, utterance);
  if (!isFramed(game) && hasAdventureDetails(utterance, ctx.persona.name.split(/\s+/))) return runNewGame(ctx, utterance);
  if (BEGIN_RE.test(utterance) && !NOT_YET_RE.test(utterance)) return runBegin(ctx, utterance);
  const q = setupQuestion(game);
  return spoken([q === "begin" ? "" : "I didn't catch that.", await nextQuestion(game.id) || setupView(game).next || ""]);
}

// ─── Heroes ──────────────────────────────────────────────────────────────────

const SELF_INTRO = /\b(?:i'm|i’m|i am|my name is|my name's|this is)\s+([\p{L}][\p{L}'’-]{1,20})/iu;
const INTRO_IS_HERO = /\b(?:i'm|i’m|i am|my name is|my name's|this is)\s+[\p{L}][\p{L}'’-]{1,20}(?:\s+[\p{Lu}][\p{L}'’-]+)?\s*,?\s+(?:the|a|an)\s+[\p{L}]/iu;
const NAMED_HERO = /\b(?:named|called|name (?:him|her|them|it)|call (?:him|her|them|it))\s+([\p{L}][\p{L}'’-]{1,20})/iu;
/** "Ana is playing Lyra": a player named in the third person. */
const NAMED_PLAYER = /\b([\p{Lu}][\p{L}'’-]{1,20})\s+(?:is|will be|'s|’s|'ll be|’ll be)\s+(?:playing|going to play)\b/u;
/**
 * Someone says who plays the hero, even without a name: "I'm playing Thorin", "I'll be the wizard", "my hero is…",
 * "my friend is playing Lyra". Then the Game Master doesn't ask "Who is playing Thorin?" right after.
 */
const CLAIMED =
  /\b(?:i(?:'m|’m| am)\s+(?:playing|going to (?:play|be)|gonna (?:play|be))|i(?:'ll|’ll| will)\s+(?:play|be|take)|i\s+(?:play|want to play|wanna play|choose|pick|take)|my (?:hero|character|guy|girl|pc)\b|(?:my|our)\s+(?:friend|buddy|pal|brother|sister|wife|husband|partner|son|daughter|kid|mate|roommate|dad|mom|mum)\s+(?:is|will be|'s|’s|'ll be|’ll be)\s+(?:playing|going to play)|(?:he|she|they)(?:'s|’s| is| are|'ll|’ll| will)\s+(?:be\s+)?playing)/i;

async function runAddPlayer(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "ended") return spoken("This adventure has ended. Start a new game to make new heroes.");
  if (game.phase === "paused") return spoken("The game is paused. Say resume first.");
  const answered = game.phase === "setup" ? await setupAnswer(game, utterance) : null;
  if (answered) return answered;
  if (game.phase === "setup" && !isFramed(game) && hasAdventureDetails(utterance, ctx.persona.name.split(/\s+/)) && !parseHeroes(utterance).some((h) => h.race || h.className))
    return runNewGame(ctx, utterance);
  const room = MAX_PLAYERS - realPlayers(game).length;
  if (room <= 0) return spoken(`The ${partyWord(game)} is full: ${MAX_PLAYERS} heroes is the most the table can hold.`);

  // Who is speaking, and which hero they mean. "I'm Ana and I'll take the elf wizard": Ana is the player.
  // "I'm Thorin, a dwarf fighter": Thorin is the hero.
  let guesses = parseHeroes(utterance);
  const ready = parseReadyMade(utterance, readyMadeOptions(game));
  // "I'm playing Thorin": "playing" is what the speaker does, not who they are. Never a player name from a verb.
  const introWord = SELF_INTRO.exec(utterance)?.[1] ?? null;
  const intro = introWord && isNameWord(introWord) ? introWord : null;
  let playerName = game.setupState.seatName;
  const named = NAMED_PLAYER.exec(utterance)?.[1] ?? null;
  if (named && isNameWord(named) && !guesses.some((h) => h.name && sameName(h.name, named))) playerName = named;
  let claimed = CLAIMED.test(utterance) || Boolean(named && playerName === named);
  if (intro) {
    const own = guesses.find((h) => h.name && sameName(h.name, intro));
    // "I'm Thorin the dwarf fighter" / "I'm Thorin, a dwarf": the name is the hero's. "I'm Ana, I'll take the wizard": the player's.
    const isHero = INTRO_IS_HERO.test(utterance) && own !== undefined && Boolean(own.race || own.className);
    if (isHero) claimed = true; // the speaker introduced themself as the hero: they play it
    if (!isHero && (ready || guesses.some((h) => h !== own && (h.name || h.race || h.className)) || Boolean(own?.race || own?.className))) {
      playerName = intro.charAt(0).toUpperCase() + intro.slice(1);
      if (own && (own.race || own.className)) own.name = null;
      else guesses = guesses.filter((h) => h !== own);
    }
  }
  const q = game.phase === "setup" ? setupQuestion(game) : null;
  // A name alone makes a hero only when it was plainly given as one ("my hero is Lyra", or just "Lyra" when asked).
  const nameGiven = /\b(my (?:character|hero)|i(?:'ll| will) (?:play|be)|i(?:'m| am) playing|add (?:a |another )?(?:hero|character|player)|named|called)\b/i.test(utterance);
  const bareName = utterance.trim().split(/\s+/).length <= 3 && q === "seat-hero" && !isTableTalk(utterance);
  const described = guesses.some((h) => h.race || h.className) || (guesses.some((h) => h.name) && (nameGiven || bareName));

  // Nobody described: no hero is invented. Ask instead.
  if (!ready && !described) {
    if (game.phase === "setup") {
      if (playerName && playerName !== game.setupState.seatName) {
        let ask = "";
        await mutateGame(game.id, (g) => {
          g.setupState.seatName = playerName;
          ask = askNext(g);
        });
        return spoken(["Welcome.", ask]);
      }
      return spoken([await nextQuestion(game.id) || "Tell me about your hero: a name, a species and a class."]);
    }
    return spoken("Tell me about the new hero: a name, a species and a class.");
  }

  const level = game.phase === "playing" ? partyLevel(game) : 1;
  const out = { added: [] as Player[], revised: [] as Player[], ask: "" };
  const join = (g: Game, list: GeneratedPlayer[], placeholders: string[]) => {
    const queue = [...placeholders];
    for (const h of list) {
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
      addGear(g, h, p.id);
      outfit(g, p);
      out.added.push(p);
    }
    g.players = g.players.filter((p) => !(p.pending && queue.includes(p.id)));
    // One new hero takes the seat of whoever just gave their name.
    const who = playerName || out.added[0]?.playerName || "";
    if (out.added.length === 1 && who) out.added[0]!.playerName = who;
    // Whoever plays the hero was said, if not by name ("I'm playing Thorin"): nobody is asked who plays them.
    if (out.added.length === 1 && claimed) settleWhoPlays(g, out.added[0]!.id);
    if (out.added.length) g.setupState.seatName = "";
    for (const p of out.added) addLog(g, "party", `${p.name}, ${aOrAn(heroLine(p))}, joins the ${partyWord(g)}${playedBy(p)}.`);
    for (const p of out.revised) addLog(g, "party", `${p.name}'s character sheet is updated: ${heroLine(p)}.`);
    if (g.phase === "setup") out.ask = askNext(g);
  };

  let saved: Game | null;
  if (ready) {
    // A ready-made hero is built in code: no model, no wait.
    const given = NAMED_HERO.exec(utterance)?.[1] ?? guesses.find((h) => h.name && !sameName(h.name, playerName))?.name ?? null;
    const hero = readyMadeHero(game, ready, given, level);
    saved = await mutateGame(game.id, (g) => join(g, [hero], []));
  } else {
    // Placeholder cards right away (named when the words make it unambiguous).
    const strong = guesses.length > 0 && guesses.every((h) => h.name && (h.race || h.className));
    const count = Math.min(room, strong ? guesses.length : Math.max(1, guesses.filter((h) => h.race || h.className).length));
    const ids = Array.from({ length: count }, () => newId());
    ids.forEach(trackPlaceholder);
    const busyKey = `sheet:${ids[0]}`;
    try {
      await mutateGame(game.id, (g) => {
        ids.forEach((id, i) => g.players.push(placeholderPlayer(id, strong ? (guesses[i]?.name ?? PLACEHOLDER_NAMES.player) : PLACEHOLDER_NAMES.player)));
      });
      const names = strong ? guesses.map((h) => h.name!).slice(0, count) : [];
      setBusy(game.id, busyKey, names.length ? `Creating ${listNames(names)}…` : "Creating a new hero…");
      presentIfCurrent(game.id);
      const fresh = getGame(game.id) ?? game;
      const made = await capped(genPlayers(utterance, fresh, { recent: recentLines(ctx, utterance), level, timeoutMs: GEN_TIMEOUT_MS }), GEN_CAP_MS, () =>
        heroesFromWords(utterance, fresh, level),
      );
      // The player's own name is not a hero.
      const list = made.filter((h) => !(playerName && sameName(h.name, playerName) && made.length > 1));
      saved = await mutateGame(game.id, (g) => join(g, list, ids));
    } finally {
      ids.forEach(releasePlaceholder);
      setBusy(game.id, busyKey, null);
    }
  }
  if (!saved) return { ok: false, say: "The game was closed before the new hero could join." };
  presentIfCurrent(saved);

  const { added, revised, ask } = out;
  const parts: string[] = [];
  if (added.length === 1) {
    const p = added[0]!;
    parts.push(`${heroTitle(p)} joins${playedBy(p)}: ${p.maxHp} hit points, armor class ${p.ac}.`);
  } else if (added.length > 1) parts.push(`${listNames(added.map(heroTitle))} join the ${partyWord(saved)}.`);
  for (const p of revised) parts.push(`${p.name} is now ${aOrAn(heroLine(p))}, with ${p.maxHp} hit points and armor class ${p.ac}.`);
  if (!parts.length) {
    const why = realPlayers(saved).length >= MAX_PLAYERS ? `The ${partyWord(saved)} is full.` : "I couldn't make out the new hero. Tell me their name, species and class.";
    return spoken([why]);
  }
  return spoken([...parts, ask]);
}

const EVERYONE_RE = /\b(everyone|everybody|the (?:whole )?party|all (?:of )?(?:us|them|the heroes)|each (?:of (?:us|them)|hero)|we all)\b/i;

/**
 * Apply a change said at the table to a hero through the rules: damage meets resistance and temporary hit points and
 * can drop or kill, healing wakes the fallen, XP can level up, a sixth level of exhaustion is death. Returns what is
 * said about it (empty when nothing changed).
 */
export function applyChange(g: Game, p: Player, c: PlayerChange): string[] {
  const rng = dice();
  const lines: string[] = [];
  const oldName = p.name;
  if (c.name) p.name = c.name;
  if (c.race) {
    p.race = c.race;
    p.resistances = speciesResistances(p.race);
  }
  if (c.className && c.className !== p.className) {
    p.className = c.className;
    reclass(p);
  }
  if (c.name || c.race || c.className) lines.push(`${oldName} is now ${c.name && c.name !== oldName ? `${c.name}, ` : ""}${aOrAn(heroLine(p))}.`);
  if (c.playerName) {
    p.playerName = c.playerName;
    lines.push(`${p.name} is played by ${p.playerName}.`);
  }
  for (const [k, v] of Object.entries(c.stats ?? {}) as [keyof Player["stats"], number][]) {
    if (typeof v !== "number") continue;
    p.stats[k] = Math.min(30, Math.max(1, Math.round(v)));
    lines.push(`${p.name}'s ${R.ABILITY_NAMES[k]} is now ${p.stats[k]}.`);
  }
  if (typeof c.level === "number") {
    const target = Math.min(20, Math.max(1, Math.round(c.level)));
    if (target > p.level) {
      while (p.level < target) levelUp(p);
      lines.push(`${p.name} reaches level ${p.level}, with ${p.maxHp} hit points at most.`);
      addLog(g, "party", `${p.name} reaches level ${p.level}! (max HP ${p.maxHp})`);
    } else if (target < p.level) {
      p.level = target;
      p.maxHp = hpFor(p.className, p.stats.con, p.level);
      p.hp = Math.min(p.hp, p.maxHp);
      p.slotsMax = R.slotsFor(classProfile(p.className).caster, p.level);
      lines.push(`${p.name} is level ${p.level} now.`);
    }
  }
  if (typeof c.maxHp === "number") {
    p.maxHp = Math.max(1, Math.round(c.maxHp));
    p.hp = Math.min(p.hp, p.maxHp);
    lines.push(`${p.name}'s hit point maximum is ${p.maxHp}.`);
  }
  const cause = c.cause ? ` ${c.cause.replace(/^(?:from|by)\s+/i, "").replace(/^/, "from ")}` : "";
  const delta = typeof c.hp === "number" ? Math.round(c.hp) - p.hp : typeof c.hpDelta === "number" ? Math.round(c.hpDelta) : 0;
  if (delta < 0) {
    const hurt = hurtHero(g, rng, p, -delta, c.damageType ?? "", {});
    lines.push(`${p.name} takes ${hurt.words}${cause}. ${hurt.state}`, ...hurt.after);
    addLog(g, "combat", `${p.name} takes ${-delta} damage${cause} (${p.hp}/${p.maxHp} HP).`);
  } else if (delta > 0) {
    const healed = healHero(g, p, delta);
    lines.push(healed.line);
    addLog(g, "party", `${p.name} heals ${healed.result.healed} (${p.hp}/${p.maxHp} HP).`);
  }
  if (typeof c.tempHp === "number" && c.tempHp > 0) lines.push(`${p.name} has ${plural(R.grantTempHp(p, c.tempHp), "temporary hit point")}.`);
  if (typeof c.xpDelta === "number" && c.xpDelta !== 0) {
    p.xp = Math.max(0, p.xp + Math.round(c.xpDelta));
    lines.push(c.xpDelta > 0 ? `${p.name} earns ${c.xpDelta} experience points.` : `${p.name} loses ${-c.xpDelta} experience points.`);
    if (g.settings.leveling === "xp") {
      const before = p.level;
      while (p.level < 20 && R.levelForXp(p.xp) > p.level) levelUp(p);
      if (p.level > before) lines.push(`${p.name} reaches level ${p.level}.`);
    }
  }
  if (typeof c.goldDelta === "number" && c.goldDelta !== 0) {
    const before = p.gold;
    p.gold = Math.max(0, p.gold + Math.round(c.goldDelta));
    const d = p.gold - before;
    lines.push(d >= 0 ? `${p.name} gains ${d} gold and has ${p.gold}.` : `${p.name} spends ${-d} gold and has ${p.gold} left.`);
    addLog(g, "loot", d >= 0 ? `${p.name} gains ${d} gold (now ${p.gold}).` : `${p.name} spends ${-d} gold (${p.gold} left).`);
  }
  for (const cond of c.addConditions ?? []) {
    const k = cond.toLowerCase().trim();
    if (!k || k === "unconscious" || k === "dead") continue;
    if (R.addCondition(p, k, c.rounds ?? null) || c.rounds) lines.push(`${p.name} is ${k}${c.rounds ? ` for ${plural(c.rounds, "round")}` : ""}.`);
  }
  for (const cond of c.removeConditions ?? []) if (R.removeCondition(p, cond)) lines.push(`${p.name} is no longer ${cond.toLowerCase().trim()}.`);
  if (typeof c.exhaustionDelta === "number" && c.exhaustionDelta !== 0) {
    const ex = R.addExhaustion(p, c.exhaustionDelta);
    if (ex.dead && !p.dead) {
      killHero(g, p);
      lines.push(`${p.name} reaches the sixth level of exhaustion and dies.`);
    } else lines.push(ex.level ? `${p.name} is at exhaustion level ${ex.level}.` : `${p.name} is no longer exhausted.`);
  }
  if (typeof c.inspiration === "boolean") {
    if (c.inspiration) lines.push(R.grantInspiration(p) ? `${p.name} gains inspiration.` : `${p.name} already has inspiration.`);
    else {
      p.inspiration = false;
      lines.push(`${p.name}'s inspiration is spent.`);
    }
  }
  if (c.note) {
    p.notes = `${p.notes ? `${p.notes}\n` : ""}${c.note}`.slice(-1500);
    lines.push(`Noted for ${p.name}.`);
  }
  return lines;
}

async function runUpdatePlayer(args: Record<string, unknown>, ctx: ToolContext, utterance: string, extra: { actorId?: string } = {}): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "paused") return spoken("The game is paused. Say resume first.");
  const party = realPlayers(game);
  if (!party.length) return spoken(`There's nobody in the ${partyWord(game)} yet.`);
  const everyone = !extra.actorId && EVERYONE_RE.test(utterance) && !findHero(game, utterance);
  let targets: Player[];
  if (everyone) targets = living(game);
  else {
    const who = extra.actorId ? heroById(game, extra.actorId) : (findHero(game, utterance) ?? resolveActor(game, utterance, null, args.player).hero);
    if (!who) {
      const question = `Which hero: ${listNames(party.map((p) => p.name))}?`;
      await mutateGame(game.id, (g) => {
        g.pending.action = pendingAction("game_update_player", utterance, question, "actor");
      });
      return spoken(question);
    }
    targets = [who];
  }
  return withTurn(game.id, async () => {
    const fresh = getGame(game.id) ?? game;
    const first = heroById(fresh, targets[0]!.id) ?? targets[0]!;
    const change = await capped(genPlayerChange(first, utterance, fresh, { timeoutMs: 6000 }), 6500, () => changeFromWords(utterance, first));
    if (isEmptyChange(change)) {
      const noNumber = /\b(damage|hurt|heals?|healing|hit points?)\b/i.test(utterance) && !/\d/.test(digitize(utterance));
      return spoken(noNumber ? `How much? Say it with a number, like: ${first.name} takes 5 damage.` : `I couldn't tell what changes for ${everyone ? "the party" : first.name}. Say it plainly, like: ${first.name} takes 5 damage.`);
    }
    if (fresh.phase === "playing") checkpointGame(game.id, `a change to ${everyone ? "the party" : first.name}`);
    const lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      for (const t of targets) {
        const p = heroById(g, t.id);
        if (p) lines.push(...applyChange(g, p, everyone ? { ...change, name: undefined, race: undefined, className: undefined, playerName: undefined } : change));
      }
      if (g.combat) lines.push(...settleFight(g, dice()));
      if (g.phase === "setup") lines.push(askNext(g));
      rememberSpoken(g, joinLines(lines));
    });
    if (!saved) return { ok: false, say: "The game was closed before that could be recorded." };
    presentIfCurrent(saved.id);
    if (!lines.filter(Boolean).length) return spoken(`Nothing changes for ${everyone ? "the party" : first.name}.`);
    // Party-wide results are kept short: the same event for each hero is said once per hero, briefly.
    return spoken(lines);
  });
}

/** Words that really mean a hero leaves the party (not "Thorin tries to remove the trap"). */
const REMOVAL_RE =
  /\b(?:remove|kick|drop|delete|take)\b[^.?!]{0,40}\b(?:from|out of|off)\s+(?:the |our )?(?:party|game|table|group|crew|team)\b|\b(?:leaves?|is leaving|has left|quits?|is quitting|is out|isn'?t playing|not playing|has to (?:go|leave)|went home|is gone|won'?t be playing)\b|\b(?:remove|delete|drop|retire)\s+(?:the |my |our )?(?:hero|character|player)\b|\bretire\b/i;

async function runRemovePlayer(args: Record<string, unknown>, ctx: ToolContext, utterance: string, extra: { actorId?: string } = {}): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const party = realPlayers(game);
  if (!party.length) return spoken(`There's nobody in the ${partyWord(game)} to remove.`);
  const named = extra.actorId ? heroById(game, extra.actorId) : findHero(game, utterance);
  const bare = named !== null && utterance.trim().split(/\s+/).length <= 4 && /\b(remove|delete|drop|kick)\b/i.test(utterance);
  if (!extra.actorId && !REMOVAL_RE.test(utterance) && !bare) {
    // Not a goodbye: it is something happening in the story ("Thorin tries to remove the trap").
    if (game.phase === "playing") return (await resumeTool("game_narrate", ctx, utterance)) ?? spoken("Tell me what your hero does.");
    return spoken([await nextQuestion(game.id)]);
  }
  const player = named ?? (typeof args.player === "string" ? heroById(game, args.player.trim()) : null);
  if (!player) {
    const question = `Who is leaving the ${partyWord(game)}: ${listNames(party.map((p) => p.name))}?`;
    await mutateGame(game.id, (g) => {
      g.pending.action = pendingAction("game_remove_player", utterance, question, "actor");
    });
    return spoken(question);
  }
  return askConfirm(game, "remove_player", player.id, utterance, `Remove ${player.name} from the ${partyWord(game)} for good? Say yes or no.`);
}

async function removePlayer(game: Game, heroId: string): Promise<ToolResult> {
  const out = { name: "", hadGear: false, lines: [] as string[], ask: "" };
  if (game.phase === "playing") checkpointGame(game.id, "removing a hero");
  const saved = await mutateGame(game.id, (g) => {
    g.pending.confirm = null;
    const at = g.players.findIndex((p) => p.id === heroId);
    if (at < 0) return;
    out.name = g.players[at]!.name;
    out.lines = leaveCombat(g, dice(), heroId);
    g.players.splice(at, 1);
    for (const it of g.items) {
      if (it.ownerId === heroId) {
        it.ownerId = null;
        out.hadGear = true;
      }
    }
    if (g.spotlightId === heroId) passSpotlight(g, heroId);
    if (g.pending.check?.heroId === heroId) g.pending.check = null;
    addLog(g, "party", `${out.name} leaves the ${partyWord(g)}.`);
    if (g.phase === "setup") out.ask = askNext(g);
  });
  if (!saved) return { ok: false, say: "The game was closed before that could be recorded." };
  presentIfCurrent(saved.id);
  if (!out.name) return spoken("That hero isn't in the party any more.");
  const party = partyWord(saved);
  return spoken([`${out.name} has left the ${party}${out.hadGear ? `; their gear stays in the ${party}'s loot` : ""}.`, ...out.lines, out.ask]);
}

// ─── Items and gold ──────────────────────────────────────────────────────────

async function runAddItem(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const named = findHero(game, utterance);
  const owner = args.owner === "party" ? null : (named ?? (typeof args.owner === "string" ? heroById(game, args.owner.trim()) : null) ?? (/\b(i|me|my)\b/i.test(utterance) ? resolveActor(game, utterance).hero : null));
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
        quantity: 1,
        value: 0,
      });
    });
    setBusy(game.id, busyKey, owner ? `Finding something for ${owner.name}…` : "Unpacking the loot…");
    presentIfCurrent(game.id);

    const fresh = getGame(game.id) ?? game;
    const loot = await capped(genLoot(utterance, fresh, owner?.name ?? null, { timeoutMs: GEN_TIMEOUT_MS }), GEN_CAP_MS, () => lootFromWords(utterance, fresh));

    const out = { made: [] as Item[], gold: 0, holder: null as string | null };
    if (fresh.phase === "playing") checkpointGame(game.id, "new loot");
    const saved = await mutateGame(game.id, (g) => {
      const holder = owner ? heroById(g, owner.id) : null;
      out.holder = holder?.name ?? null;
      g.items = g.items.filter((it) => it.id !== phId);
      for (const p of g.players) p.inventory = p.inventory.filter((id) => id !== phId);
      for (const d of loot.items) {
        const it = addItem(g, { name: d.name, type: d.type, rarity: d.rarity, description: d.description, properties: d.properties, appearance: d.appearance }, holder?.id ?? null);
        it.icon = paint(g, "icon", `${it.name}: ${it.appearance}`, `Painting the ${it.name}…`);
        out.made.push(it);
      }
      if (loot.gold > 0) {
        out.gold = loot.gold;
        if (holder) holder.gold += loot.gold;
        else g.partyGold += loot.gold;
      }
      const what = listNames([...out.made.map((it) => it.name), ...(out.gold ? [`${out.gold} gold`] : [])]);
      if (what) addLog(g, "loot", holder ? `${holder.name} receives ${what}.` : `The ${partyWord(g)} gains ${what}.`);
    });
    if (!saved) return { ok: false, say: "The game was closed before the item could be added." };
    presentIfCurrent(saved.id);

    const { made, gold, holder } = out;
    const names = made.map((it) => `the ${it.name.toLowerCase()}`);
    const what = listNames([...names, ...(gold ? [`${gold} gold`] : [])]);
    if (!what) return spoken("Nothing turned up.");
    const detail = made.length === 1 && made[0]!.description ? firstSentence(made[0]!.description) : "";
    const line = holder ? `${holder} gets ${what}.` : `${what.charAt(0).toUpperCase()}${what.slice(1)} ${made.length + (gold ? 1 : 0) > 1 ? "go" : "goes"} into the ${partyWord(saved)}'s loot.`;
    let ask = "";
    if (saved.phase === "setup") ask = await nextQuestion(saved.id);
    await mutateGame(saved.id, (g) => rememberSpoken(g, joinLines([line, detail])));
    return spoken([line, detail, ask]);
  } finally {
    releasePlaceholder(phId);
    setBusy(game.id, busyKey, null);
  }
}

type ItemOp = "use" | "give" | "drop" | "equip" | "unequip" | "take";

function itemOp(text: string): ItemOp | null {
  const t = text.toLowerCase();
  if (/\b(unequip|sheathe?s?|stows?|takes? off|doffs?|puts? away|removes? (?:my|his|her|their))\b/.test(t)) return "unequip";
  if (/\b(equips?|wields?|draws?|read(?:y|ies)|wears?|puts? on|dons?|straps? on|switch(?:es)? to|holds?)\b/.test(t)) return "equip";
  if (/\b(drops?|discards?|throws? away|leaves? behind|gets? rid of|tosses? aside)\b/.test(t)) return "drop";
  if (/\b(gives?|hands?|passes?|tosses?|lends?|offers?|shares?)\b/.test(t)) return "give";
  if (/\b(pours?|feeds?|administers?)\b/.test(t)) return "use";
  if (/\b(takes?|grabs?|claims?|picks? up|keeps?)\b/.test(t)) return "take";
  if (/\b(uses?|using|drinks?|quaffs?|eats?|appl(?:y|ies)|reads?|consumes?|lights?|swallows?|chugs?|downs?)\b/.test(t)) return "use";
  return null;
}

const GOLD_RE = /\b(\d+)\s*(?:gold|gp|coins?|gold pieces?|credits)\b/i;

/** game_use_item: a hero uses, equips, gives, takes or drops something they carry, or hands over gold. */
async function runUseItem(args: Record<string, unknown>, ctx: ToolContext, utterance: string, extra: { actorId?: string } = {}): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "paused") return spoken("The game is paused. Say resume first.");
  const who = resolveActor(game, utterance, extra.actorId, args.player);
  if (!who.hero) {
    await mutateGame(game.id, (g) => {
      g.pending.action = pendingAction("game_use_item", utterance, "Who is doing that?", "actor");
    });
    return spoken("Who is doing that?");
  }
  const actor = who.hero;
  if (actor.dead) return spoken(`${actor.name} has died.`);
  if (actor.hp <= 0) return spoken(`${actor.name} is unconscious and can't do that.`);
  if (game.combat) {
    const wait = notYourTurn(game, actor);
    if (wait) return spoken(wait);
  }
  const others = findHeroes(game, utterance)
    .map((f) => f.item)
    .filter((p) => p.id !== actor.id);
  const friend = others[0] ?? null;
  const said = digitize(utterance);
  const op = itemOp(said);

  return withTurn(game.id, async () => {
    const g0 = getGame(game.id) ?? game;
    const me = heroById(g0, actor.id) ?? actor;
    // Gold changing hands.
    const gold = GOLD_RE.exec(said);
    if (gold && (op === "give" || /\bpays?\b/i.test(said))) {
      checkpointGame(game.id, `${me.name} gives gold`);
      let lines: string[] = [];
      const toParty = /\b(party|purse|pot|loot|everyone)\b/i.test(said) && !friend;
      const saved = await mutateGame(game.id, (g) => {
        lines = moveGold(g, heroById(g, me.id), toParty || !friend ? null : heroById(g, friend.id), Number(gold[1]));
        rememberSpoken(g, joinLines(lines));
      });
      if (saved) presentIfCurrent(saved.id);
      return spoken(lines);
    }
    const mine = itemsOf(g0, me.id);
    const loot = g0.items.filter((it) => !it.ownerId);
    const item = op === "take" ? (findItem(loot, said) ?? findItem(mine, said)) : (findItem(mine, said) ?? (op === null ? null : findItem(loot, said)));
    if (!item) {
      const have = mine.slice(0, 4).map((it) => it.name.toLowerCase());
      return spoken(have.length ? `${me.name} isn't carrying that. ${me.name} has ${listNames(have)}${mine.length > 4 ? " and more" : ""}.` : `${me.name} isn't carrying anything.`);
    }
    const heals = healingDice(item) !== null;
    // Handing a healing draught to a friend who is down is using it on them.
    const action: ItemOp = op === "give" && heals && friend && (friend.hp <= 0 || /\b(mouth|lips|drink|pours?|feeds?)\b/i.test(said)) ? "use" : (op ?? (heals || isConsumable(item) ? "use" : "equip"));
    if (g0.combat && action === "use" && g0.combat.bonusUsed) return spoken(`${me.name} has already used a bonus action this turn.`);
    checkpointGame(game.id, `${me.name}: ${utterance}`.slice(0, 150));
    let lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      const h = heroById(g, me.id);
      const it = g.items.find((x) => x.id === item.id);
      if (!h || !it) return;
      const to = friend ? heroById(g, friend.id) : null;
      if (it.ownerId !== h.id && action !== "take") giveItem(g, it, h);
      switch (action) {
        case "use": {
          const used = useItem(g, dice(), h, it, to);
          lines = used.lines;
          if (used.used && g.combat) g.combat.bonusUsed = true;
          break;
        }
        case "give":
          lines = giveItem(g, it, to ?? null);
          break;
        case "take":
          lines = it.ownerId === h.id ? [`${h.name} already has the ${it.name.toLowerCase()}.`] : giveItem(g, it, h);
          break;
        case "drop":
          lines = dropItem(g, h, it);
          break;
        case "equip":
          lines = equipItem(g, h, it).lines;
          break;
        case "unequip":
          lines = unequipItem(g, h, it).lines;
          break;
      }
      if (g.combat && turnHero(g)?.id === h.id) lines.push(action === "use" ? `${h.name}, you still have your action.` : `${h.name}, it's still your turn.`);
      rememberSpoken(g, joinLines(lines));
    });
    if (!saved) return { ok: false, say: "The game was closed before that could happen." };
    presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

/** game_trade: buy or sell for gold. The price is the one said, else the item's listed worth (half of it when selling). */
async function runTrade(args: Record<string, unknown>, ctx: ToolContext, utterance: string, extra: { actorId?: string } = {}): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const who = resolveActor(game, utterance, extra.actorId, args.player);
  if (!who.hero) {
    await mutateGame(game.id, (g) => {
      g.pending.action = pendingAction("game_trade", utterance, "Who is buying or selling?", "actor");
    });
    return spoken("Who is buying or selling?");
  }
  const actor = who.hero;
  const said = digitize(utterance);
  const stated = /\bfor\s+(\d+)\s*(?:gold|gp|coins?|gold pieces?|credits)?\b/i.exec(said) ?? GOLD_RE.exec(said);
  const price = stated ? Number(stated[1]) : null;
  const selling = /\b(sells?|selling|pawns?|trades? in)\b/i.test(said);
  return withTurn(game.id, async () => {
    const g0 = getGame(game.id) ?? game;
    const me = heroById(g0, actor.id) ?? actor;
    if (selling) {
      const item = findItem(itemsOf(g0, me.id), said);
      if (!item) return spoken(`${me.name} isn't carrying that to sell.`);
      checkpointGame(game.id, `${me.name} sells the ${item.name}`);
      let lines: string[] = [];
      const saved = await mutateGame(game.id, (g) => {
        const h = heroById(g, me.id);
        const it = g.items.find((x) => x.id === item.id);
        if (h && it) lines = sellItem(g, h, it, price);
        rememberSpoken(g, joinLines(lines));
      });
      if (saved) presentIfCurrent(saved.id);
      return spoken(lines);
    }
    const m = /\b(?:buys?|buying|purchases?|purchasing|pays? for|gets?|orders?)\s+(?:a |an |the |some |one |two |three )?(.+?)(?:\s+(?:for|at|from)\s+.+)?[.!?]*$/i.exec(said);
    const name = (m?.[1] ?? "").replace(/\b(?:please|then|now)\b/gi, "").replace(/\s+/g, " ").trim();
    if (!name) return spoken(`What is ${me.name} buying?`);
    const title = name.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Of|The|And|A|An)\b/g, (w) => w.toLowerCase()).replace(/^./, (c) => c.toUpperCase());
    const draft = { name: title, type: inferItemType(name), rarity: "common" as const, properties: healingDice({ name, type: "potion", properties: [] }) ? ["heals 2d4+2"] : [] };
    const cost = price ?? itemPrice(draft);
    checkpointGame(game.id, `${me.name} buys ${name}`);
    let lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      const h = heroById(g, me.id);
      if (!h) return;
      const bought = buyItem(g, h, draft, cost);
      lines = bought.lines;
      if (bought.item) bought.item.icon = paint(g, "icon", `${bought.item.name}, ${bought.item.type}`, null);
      rememberSpoken(g, joinLines(lines));
    });
    if (saved) presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

// ─── Characters and creatures ────────────────────────────────────────────────

const ATTACK_NOW = /\b(attacks?|ambush\w*|jumps? out|leaps? out|charges?|bursts? (?:in|out)|springs?|pounces?|strikes?|roll (?:for )?initiative)\b/i;

async function runAddNpc(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "paused") return spoken("The game is paused. Say resume first.");

  // A creature from the bestiary, perhaps several: stat blocks at once, no model.
  const monster = findMonster(utterance);
  if (monster && game.phase === "playing" && !/\b(named|called)\b/i.test(utterance)) {
    return withTurn(game.id, async () => {
      checkpointGame(game.id, "creatures appear");
      const count = countIn(utterance);
      let lines: string[] = [];
      const saved = await mutateGame(game.id, (g) => {
        const made = spawnCreatures(g, monster, count);
        const what = made.length === 1 ? `${aOrAn(monster.name.toLowerCase())} appears` : `${made.length} ${monster.name.toLowerCase()}s appear`;
        lines = [`${what.charAt(0).toUpperCase()}${what.slice(1)}.`];
        if (!g.combat && ATTACK_NOW.test(utterance)) lines.push(...startCombat(g, dice(), { surprise: /\b(ambush\w*|surpris\w*)\b/i.test(utterance) ? "heroes" : null }).lines);
        else if (g.combat) lines.push(made.length === 1 ? "It joins the fight." : "They join the fight.");
        rememberSpoken(g, joinLines(lines));
      });
      if (!saved) return { ok: false, say: "The game was closed before they could appear." };
      presentIfCurrent(saved.id);
      return spoken(lines);
    });
  }

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
        ...defaultStatBlock("", "", "unknown"),
        status: "alive",
        conditions: [],
        conditionRounds: {},
      });
    });
    setBusy(game.id, busyKey, "Someone new enters the story…");
    presentIfCurrent(game.id);

    const fresh = getGame(game.id) ?? game;
    const npc = await capped(genNpc(utterance, fresh, { timeoutMs: GEN_TIMEOUT_MS, maxCr: Math.max(1, partyLevel(fresh)) }), GEN_CAP_MS, () => npcFromWords(utterance, fresh));

    const out = { returning: false, name: npc.name };
    const saved = await mutateGame(game.id, (g) => {
      const at = g.npcs.findIndex((n) => n.id === phId);
      const existing = g.npcs.find((n) => n.id !== phId && sameName(n.name, npc.name));
      if (existing) {
        if (at >= 0) g.npcs.splice(at, 1);
        existing.role = npc.role || existing.role;
        existing.description = npc.description || existing.description;
        existing.attitude = npc.attitude;
        if (existing.status !== "alive") {
          existing.status = "alive";
          existing.hp = existing.maxHp;
        }
        if (npc.appearance) existing.appearance = npc.appearance;
        if (existing.portrait.status === "none" || existing.portrait.status === "error")
          existing.portrait = paint(g, "portrait", `${existing.role}: ${existing.appearance}`, `Painting ${existing.name}…`);
        out.returning = true;
        addLog(g, "narration", `${existing.name} returns.`);
        return;
      }
      const { block, ...who } = npc;
      const n: Npc = { id: phId, ...who, portrait: emptySlot(), ...block, status: "alive", conditions: [], conditionRounds: {} };
      n.portrait = paint(g, "portrait", `${npc.role}: ${npc.appearance}`, `Painting ${npc.name}…`);
      if (at >= 0) g.npcs[at] = n;
      else g.npcs.push(n);
      if (g.combat && n.attitude === "hostile") joinCombat(g, dice(), n);
      addLog(g, "narration", `${npc.name}, ${aOrAn(npc.role || "stranger")}, enters the story.`);
    });
    if (!saved) return { ok: false, say: "The game was closed before they could appear." };
    presentIfCurrent(saved.id);
    const line = out.returning ? `${npc.name} is back.` : `${npc.name}, ${aOrAn(npc.role || "stranger")}.`;
    const detail = fitSentences(npc.description, 30) || firstSentence(npc.description);
    await mutateGame(saved.id, (g) => rememberSpoken(g, joinLines([line, detail])));
    return spoken([line, detail, saved.phase === "setup" ? await nextQuestion(saved.id) : ""]);
  } finally {
    releasePlaceholder(phId);
    setBusy(game.id, busyKey, null);
  }
}

/** game_update_npc: a character or creature flees, dies, leaves, changes attitude, or takes damage or a condition said outright. */
async function runUpdateNpc(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "paused") return spoken("The game is paused. Say resume first.");
  const all = settledNpcs(game);
  const alive = all.filter((n) => n.status === "alive");
  const target = findNpc([...foes(game), ...alive, ...all], utterance);
  const said = digitize(utterance.toLowerCase());
  if (!target) {
    // "Take the rope off the board": an item nobody needs any more.
    const item = /\b(remove|delete|get rid of|take away|discard|erase)\b|\btake\b.{0,40}\boff (?:the |our )?(?:board|table|screen|list|sheet)\b/.test(said) ? findItem(game.items, utterance) : null;
    if (item) {
      await mutateGame(game.id, (g) => {
        const it = g.items.find((x) => x.id === item.id);
        if (!it) return;
        // Whoever wore it is no longer wearing it: their armor class follows.
        const wore = g.players.filter((p) => p.equipped.armor === it.id || p.equipped.shield === it.id);
        removeItem(g, it);
        for (const p of wore) p.ac = heroArmorClass(g, p);
        addLog(g, "loot", `The ${item.name} is gone.`);
      });
      presentIfCurrent(game.id);
      return spoken(`The ${item.name.toLowerCase()} is gone.`);
    }
    return spoken(alive.length ? `Who do you mean: ${listNames(alive.slice(0, 5).map((n) => npcRef(n)))}?` : "There's nobody here but the heroes.");
  }
  return withTurn(game.id, async () => {
    if (game.phase === "playing") checkpointGame(game.id, `a change to ${target.name}`);
    let lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      const n = g.npcs.find((x) => x.id === target.id);
      if (!n) return;
      const who = npcRef(n, true);
      const rng = dice();
      const dmg = /\b(\d+)\s*(?:points? of\s+)?(?:[a-z]+\s+)?damage\b/.exec(said) ?? /\b(?:takes?|suffers?)\s+(\d+)\b/.exec(said);
      const heal = /\b(?:heals?|regains?|recovers?)\s+(?:for\s+)?(\d+)\b/.exec(said);
      const conds = [...R.CONDITIONS, "hidden"].filter((c) => new RegExp(`\\b${c}\\b`).test(said));
      const rounds = /\bfor\s+(\d+)\s+(?:rounds?|turns?)\b/.exec(said);
      if (/\b(flees?|fled|runs? (?:away|off)|escapes?|retreats?|bolts?|slips? away|surrenders?|gives? up)\b/.test(said)) {
        lines = [`${who} ${/\bsurrenders?|gives? up\b/.test(said) ? "surrenders" : "flees"}.`, ...dismissNpc(g, rng, n, "fled")];
        addLog(g, "combat", lines[0]!);
      } else if (/\b(dies|died|is dead|is killed|is slain|is defeated|is destroyed|drops dead|falls dead|perishes)\b/.test(said)) {
        lines = [`${who} is defeated.`, ...dismissNpc(g, rng, n, "defeated")];
        addLog(g, "combat", lines[0]!);
      } else if (/\b(leaves?|left|departs?|is gone|goes away|walks? (?:away|off)|exits?|remove|delete|get rid of|take away)\b/.test(said)) {
        lines = [`${who} is gone.`, ...dismissNpc(g, rng, n, "gone")];
        addLog(g, "narration", `${who} leaves the story.`);
      } else if (dmg) {
        const hurt = hurtNpc(g, n, Number(dmg[1]), damageTypeIn(said) ?? "", null);
        lines = [`${who} takes ${damageWords(hurt.result)}.`, hurt.state, ...hurt.after, ...settleFight(g, rng)];
      } else if (heal) {
        n.hp = Math.min(n.maxHp, n.hp + Number(heal[1]));
        lines = [`${who} recovers.`];
      } else if (conds.length) {
        const removing = /\b(no longer|isn'?t|not|shakes? off|recovers? from|stands? up|gets? up|breaks? free)\b/.test(said);
        for (const c of conds) {
          if (removing) R.removeCondition(n, c);
          else R.addCondition(n, c, rounds ? Number(rounds[1]) : null);
        }
        lines = [`${who} is ${removing ? "no longer " : ""}${listNames(conds)}${!removing && rounds ? ` for ${plural(Number(rounds[1]), "round")}` : ""}.`];
      } else {
        const attitude = /\b(hostile|turns? on|attacks?|enemy|betrays?)\b/.test(said) ? "hostile" : /\b(friendly|friend|ally|allies|helps?|joins? us|on our side)\b/.test(said) ? "friendly" : /\b(neutral|calms? down|stands? down|backs? down)\b/.test(said) ? "neutral" : null;
        if (!attitude) {
          lines = [`What happens to ${npcRef(n)}? It can flee, fall, leave, or change sides.`];
          return;
        }
        const wasFighting = g.combat?.order.some((c) => c.id === n.id) ?? false;
        n.attitude = attitude;
        lines = [`${who} is ${attitude} now.`];
        // It stops fighting but stays in the scene (and counts as overcome); a new enemy joins the fight.
        if (wasFighting && attitude !== "hostile") lines.push(...dismissNpc(g, rng, n, "calmed"));
        else if (g.combat && attitude === "hostile") joinCombat(g, rng, n);
        addLog(g, "narration", `${who} is ${attitude} now.`);
      }
      if (!g.combat && g.phase === "playing" && lines.some((l) => /fight (?:is over|breaks off)/.test(l))) lines.push(promptLine(g));
      rememberSpoken(g, joinLines(lines));
    });
    if (!saved) return { ok: false, say: "The game was closed before that could happen." };
    presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

// ─── Scenes ──────────────────────────────────────────────────────────────────

async function runSetScene(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "paused") return spoken("The game is paused. Say resume first.");
  // During setup, an answer to "what kind of adventure?" can land here — treat it as the frame.
  if (game.phase === "setup" && !isFramed(game) && hasAdventureDetails(utterance, ctx.persona.name.split(/\s+/))) return runNewGame(ctx, utterance);
  if (game.combat) return spoken("You're in the middle of a fight. Finish it, or call it off, before moving on.");
  const busyKey = `scene:${newId()}`;
  setBusy(game.id, busyKey, "Setting the scene…");
  presentGame(game.id);
  try {
    return await withTurn(game.id, async () => {
      const fresh = getGame(game.id) ?? game;
      const draft = await capped(genScene(utterance, fresh, { timeoutMs: GEN_TIMEOUT_MS, brief: ctx.persona.description }), GEN_CAP_MS, () => sceneFromWords(utterance, fresh));
      if (fresh.phase === "playing") checkpointGame(game.id, `moving to ${draft.title}`);
      let line = "";
      const saved = await mutateGame(game.id, (g) => {
        applyScene(g, draft);
        const body = fitSentences(draft.description.replace(/\s*What do you do\?\s*$/i, ""), 60) || firstSentence(draft.description);
        line = joinLines([body, g.phase === "playing" ? promptLine(g) : askNext(g)]);
        rememberSpoken(g, line);
      });
      if (!saved) return { ok: false, say: "The game was closed before the scene could be set." };
      presentIfCurrent(saved.id);
      return spoken(line);
    });
  } finally {
    setBusy(game.id, busyKey, null);
  }
}

// ─── Beginning, loading ──────────────────────────────────────────────────────

/** Choosing an adventure at "let's begin" must leave time for the opening scene inside the 15 s tool cap. */
const CHOOSE_CAP_MS = 4000;
const CHOOSE_TIMEOUT_MS = 3500;
/** The opening scene when the adventure was just chosen, or a move waits to be played after it. */
const QUICK_SCENE_CAP_MS = 5000;
const QUICK_SCENE_TIMEOUT_MS = 4500;

/**
 * Nobody chose an adventure and the table wants to play: the Game Master makes one up that suits the heroes and
 * whatever was said lately ("fantasy", "something short"). Never fails: a ready-made frame stands in for a slow model.
 */
async function chooseAdventure(ctx: ToolContext, game: Game, words: string): Promise<Game | null> {
  const ignore = ctx.persona.name.split(/\s+/).filter(Boolean);
  const heroes = realPlayers(game).map((p) => `${p.name} (${heroLine(p)})`);
  const recent = recentLines(ctx, words);
  setBusy(game.id, "frame", "Choosing the adventure…");
  try {
    const frame = await capped(
      genGameFrame(words, { timeoutMs: CHOOSE_TIMEOUT_MS, ignoreWords: ignore, choose: { heroes, recent } }),
      CHOOSE_CAP_MS,
      () => frameFromWords([...recent, ...heroes, words].join(" "), ignore),
    );
    const saved = await mutateGame(game.id, (g) => {
      applyFrame(g, frame);
      addLog(g, "system", `The Game Master chose the adventure: ${frame.title}.`);
    });
    if (saved) startCustomTemplate(saved.id, { fresh: true });
    return saved;
  } finally {
    setBusy(game.id, "frame", null);
  }
}

/**
 * game_begin: setup is over and the story starts. Never a dead end: with no adventure chosen, the Game Master picks
 * one and says in one sentence what it is; with nobody to play, it says what is missing and how to fix it. `action`
 * is a move someone made before the story began ("Lyra searches the old desk"): the opening scene is set where it
 * happens, and then it is played as the first turn (just looking around needs nothing more than the scene).
 */
async function runBegin(ctx: ToolContext, utterance: string, opts: { action?: string } = {}): Promise<ToolResult> {
  let game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const action = opts.action?.trim() ?? "";
  if (game.phase === "playing") {
    presentGame(game.id);
    // The story began a moment ago (another tool got there first): the move is simply played.
    if (action) return (await resumeTool("game_narrate", ctx, action)) ?? spoken(promptLine(game));
    return spoken([`${game.title} is already under way.`, promptLine(game)]);
  }
  if (game.phase === "paused") return (await resumeTool("game_pause", ctx, "resume")) ?? spoken("The game is paused.");
  if (game.phase === "ended") return spoken("This adventure has ended. Say you'd like a new game.");
  // "Before we begin, can I change my name?" is not a go.
  if (!action && NOT_YET_RE.test(utterance) && !/\b(don'?t|do not) wait\b/i.test(utterance)) return spoken(["No rush.", await nextQuestion(game.id)]);
  if (!realPlayers(game).length) {
    // Nothing to begin with yet: what is missing, said briefly, with the way forward.
    let line = "";
    await mutateGame(game.id, (g) => {
      line = missingLine(g);
    });
    return spoken(line);
  }
  const looking = action !== "" && LOOKING.test(action);
  const playsNext = action !== "" && !looking;
  const busyKey = "opening";
  setBusy(game.id, busyKey, "Setting the opening scene…");
  try {
    let chosen = "";
    if (!isFramed(game)) {
      const picked = await chooseAdventure(ctx, game, action || utterance);
      if (picked) {
        game = picked;
        chosen = `${picked.title}, ${framePhrase(picked)}`;
      }
    }
    const actor = action ? namedActor(game, action) : null;
    const started = await mutateGame(game.id, (g) => {
      g.phase = "playing";
      g.combat = null;
      g.pending = { check: null, confirm: null, action: null };
      g.setupState.seatName = "";
      for (const k of ["players", "party", "tone", "difficulty", "leveling"]) settle(g, k);
      if (g.settings.expectedPlayers === null) g.settings.expectedPlayers = realPlayers(g).length;
      // Whoever made the first move holds the spotlight; otherwise the first hero to join.
      g.spotlightId = (actor ? heroById(g, actor.id)?.id : null) ?? realPlayers(g)[0]?.id ?? null;
      applyStory(g, fallbackStory(g));
      g.story.sessions = Math.max(1, g.story.sessions);
      addLog(g, "system", `The adventure begins! ${g.theme.labels.party || "Party"}: ${listNames(realPlayers(g).map((p) => p.name))}.`);
    });
    if (!started) return { ok: false, say: "The game was closed before it could begin." };
    presentIfCurrent(started.id);
    // The Game Master's private plan (outline, secrets, clues, the first quest) is written in the background.
    void genStory(started, { timeoutMs: 10_000 })
      .then((plan) =>
        mutateGame(started.id, (g) => {
          // The model's plan replaces the stand-in one made above, unless play has already added to it.
          if (g.story.turn <= 1) {
            g.story.outline = plan.outline;
            if (plan.quest && g.story.quests.length <= 1) g.story.quests = [{ id: g.story.quests[0]?.id ?? newId(), title: plan.quest.title, detail: plan.quest.detail, status: "open" }];
            if (!g.story.secrets.length) g.story.secrets = plan.secrets.map((text) => ({ id: newId(), text, revealed: false }));
            if (!g.story.clues.length) g.story.clues = plan.clues.map((text) => ({ id: newId(), text, found: false }));
            if (!g.story.threats.length) g.story.threats = plan.threats;
          }
        }),
      )
      .catch(() => undefined);
    // The opening is set where the first move happens; quicker when time went on choosing the adventure or a move waits.
    const quick = chosen !== "" || action !== "";
    const draft = started.scene
      ? null
      : await capped(
          genScene(action || utterance, started, { opening: true, timeoutMs: quick ? QUICK_SCENE_TIMEOUT_MS : GEN_TIMEOUT_MS, brief: ctx.persona.description }),
          quick ? QUICK_SCENE_CAP_MS : GEN_CAP_MS,
          () => sceneFromWords("", started, true),
        );
    let line = "";
    const saved = await mutateGame(game.id, (g) => {
      if (draft) applyScene(g, draft);
      const scene = g.scene?.description ?? g.setting;
      // Room for what comes after the scene: the chosen adventure's name, and the first move's result.
      const body = fitSentences(scene.replace(/\s*What do you do\?\s*$/i, ""), playsNext ? 40 : chosen ? 50 : 62) || firstSentence(scene);
      const first = heroById(g, g.spotlightId);
      const hand = playsNext ? "" : first && realPlayers(g).length > 1 ? `${first.name}, you're first. What do you do?` : "What do you do?";
      line = joinLines([chosen ? `Let the adventure begin: ${chosen}.` : "Let the adventure begin.", body, hand]);
      rememberSpoken(g, line);
    });
    if (saved) presentIfCurrent(saved.id);
    if (!playsNext || !saved) return spoken(line);
    // The move that started the story is its first turn, said right after the scene (the scene is its narration).
    const played = await resumeTool("game_narrate", ctx, action, { quiet: true });
    const result = played && !played.silent ? (played.speak ?? "").trim() : "";
    const now = getGame(game.id);
    const prompt = now && !now.pending.check && !/(?:\?|you're up\.)$/i.test(result) ? promptLine(now) : "";
    const all = joinLines([line, result, prompt]);
    if (now) await mutateGame(now.id, (g) => rememberSpoken(g, all));
    return spoken(all);
  } finally {
    setBusy(game.id, busyKey, null);
  }
}

/**
 * Words said while the game is being set up that reached a tool meant for play (a question, or a hero doing
 * something), or that no setup tool placed. In order: talk between players (silence); an answer to the setup
 * question; a hero described or picked; the kind of adventure; "let's begin"; a move in the story (the story begins
 * with it when anyone has a hero, else what is missing is said, briefly). Null when it is none of those: a question
 * the caller answers.
 */
export async function setupTurn(ctx: ToolContext, game: Game, words: string): Promise<ToolResult | null> {
  if (isTableTalk(words)) return silent();
  const asking = isQuestion(words);
  if (!asking) {
    const answered = await setupAnswer(game, words);
    if (answered) return answered;
    if (parseHeroes(words).some((h) => h.race || h.className) || parseReadyMade(words, readyMadeOptions(game))) return runAddPlayer(ctx, words);
  }
  const move = isStoryMove(game, words);
  if (!asking && !move && !isFramed(game) && saysKind(words) && hasAdventureDetails(words, ctx.persona.name.split(/\s+/))) return runNewGame(ctx, words);
  if (BEGIN_RE.test(words) && !NOT_YET_RE.test(words)) return runBegin(ctx, words);
  if (move) return runBegin(ctx, words, { action: words });
  return null;
}

const TITLE_STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "to", "for", "game", "adventure", "campaign"]);

function resolveGame(personaId: string, arg: unknown, utterance: string): Game | null {
  const games = listGames(personaId);
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
  if (best) return best.g;
  if (typeof arg === "string" && arg.trim()) {
    const g = games.find((x) => x.id === arg.trim()) ?? getGame(arg.trim());
    if (g) return g;
  }
  return games[0] ?? null;
}

/** Make a saved game the one on the table and say where it stands: a recap, spoken. A paused game picks up again. */
async function loadGame(ctx: ToolContext, target: Game): Promise<ToolResult> {
  const pid = ctx.persona.id;
  const previous = getActiveGame(pid);
  if (previous && previous.id !== target.id && previous.pending.confirm) {
    await mutateGame(previous.id, (g) => {
      g.pending.confirm = null;
    });
  }
  setActiveGame(pid, target.id);
  invalidateSnapshots();
  let line = "";
  const saved = await mutateGame(target.id, (g) => {
    g.pending.confirm = null;
    if (g.phase === "paused") g.phase = "playing";
    if (g.phase === "setup") {
      const next = askNext(g);
      line = joinLines([isFramed(g) ? `${g.title}, still being set up${realPlayers(g).length ? ` with ${listNames(realPlayers(g).map((p) => p.name))}` : ""}.` : "An unfinished new game.", next]);
    } else {
      g.mode = g.combat ? "combat" : "explore";
      line = recap(g, { lead: `Welcome back to ${g.title}.` });
    }
    rememberSpoken(g, line);
  });
  presentGame(target.id, { force: true });
  if (!saved) return { ok: false, say: "That saved game couldn't be opened." };
  return spoken(line);
}

async function runLoad(args: Record<string, unknown>, ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const pid = ctx.persona.id;
  const current = getActiveGame(pid);
  const named = resolveGame(pid, args.game, utterance);
  if (!named) return spoken("There are no saved games yet. Say you'd like to start a new game.");
  // "Continue the game" with that game already on the table: pick it up and say where it stands.
  if (current && named.id === current.id) return loadGame(ctx, current);
  if (current && (current.phase === "playing" || current.phase === "paused") && realPlayers(current).length > 0) {
    return askConfirm(current, "load_game", named.id, utterance, `Set ${current.title} aside and load ${isFramed(named) ? named.title : "the unfinished game"}? Say yes or no.`);
  }
  return loadGame(ctx, named);
}

// ─── Yes and no ──────────────────────────────────────────────────────────────

async function settleConfirm(ctx: ToolContext, game: Game, confirm: PendingConfirm, yes: boolean): Promise<ToolResult> {
  if (!yes) {
    await mutateGame(game.id, (g) => {
      g.pending.confirm = null;
    });
    presentIfCurrent(game.id);
    const stays = confirm.kind === "remove_player" ? heroById(game, confirm.targetId) : null;
    const line = stays ? `All right, ${stays.name} stays.` : confirm.kind === "end_campaign" ? "All right, the adventure goes on." : `All right, we stay with ${game.title}.`;
    return spoken([line, game.phase === "playing" ? promptLine(game) : ""]);
  }
  switch (confirm.kind) {
    case "new_game":
      await mutateGame(game.id, (g) => {
        g.pending.confirm = null;
        if (g.phase === "playing") g.phase = "paused";
      });
      return runNewGame(ctx, confirm.words, { confirmed: true });
    case "remove_player":
      return confirm.targetId ? removePlayer(game, confirm.targetId) : spoken("I've lost track of who was leaving. Say it again.");
    case "load_game": {
      const target = confirm.targetId ? getGame(confirm.targetId) : null;
      await mutateGame(game.id, (g) => {
        g.pending.confirm = null;
        if (g.phase === "playing") g.phase = "paused";
      });
      return target ? loadGame(ctx, target) : spoken("That saved game is gone.");
    }
    case "end_campaign":
      return (await resumeTool("game_end_session", ctx, confirm.words, { actorId: "confirmed" })) ?? spoken("The adventure has ended.");
  }
}

/** game_confirm: reached only when the answer wasn't a plain yes or no (the pre-flight settles those). */
async function runConfirm(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  const confirm = game?.pending.confirm;
  if (!game || !confirm) return spoken("There's nothing waiting on a yes or no.");
  if (/\b(yes|yeah|yep|sure|do it|go ahead|please)\b/i.test(utterance) && !/\b(no|not|don'?t)\b/i.test(utterance)) return settleConfirm(ctx, game, confirm, true);
  if (/\b(no|nope|cancel|never ?mind|don'?t|stop)\b/i.test(utterance)) return settleConfirm(ctx, game, confirm, false);
  return spoken(`Was that a yes or a no? ${confirm.question}`);
}

// ─── Registration ────────────────────────────────────────────────────────────

const heroArg = (description: string, required = false) => ({ type: "string", description, required });
const heroOptions: Tool["options"] = (arg, { persona }) => (arg === "player" ? playerOptions(persona) : undefined);

const TOOL_DEFS: Tool[] = [
  {
    name: "game_new",
    description: "Start a brand-new game or adventure from scratch. Not for continuing, pausing, or beginning the game already on the table.",
    input: {},
    argMode: "raw",
    run: guarded("game_new", (_a, ctx, u) => runNewGame(ctx, u)),
  },
  {
    name: "game_configure",
    description: "During setup: say or change what kind of adventure this is — its genre, setting, tone, or title.",
    input: {},
    argMode: "raw",
    available: inSetup,
    run: guarded("game_configure", (_a, ctx, u) => runConfigure(ctx, u)),
  },
  {
    name: "game_setup",
    description:
      "An answer about the table, or a table rule changed: how many players, the tone or things to leave out of the story, how hard fights are, leveling by experience or milestones, who rolls the dice.",
    input: {},
    argMode: "raw",
    available: notEnded,
    run: guarded("game_setup", (_a, ctx, u) => runSetup(ctx, u)),
  },
  {
    name: "game_add_player",
    description: "A player joins: they say their own name, describe their hero (a name, a species, a class), or pick a ready-made hero.",
    input: {},
    argMode: "raw",
    available: notEnded,
    run: guarded("game_add_player", (_a, ctx, u) => runAddPlayer(ctx, u)),
  },
  {
    name: "game_update_player",
    description:
      "A change to a hero's sheet said outright, with its amount: takes or heals so many hit points, temporary hit points, a condition, XP, gold, a level, inspiration, exhaustion — or a correction to their name, species, class or who plays them.",
    input: { player: heroArg("Which hero changes") },
    argMode: "raw",
    available: hasHeroes,
    options: heroOptions,
    run: guarded("game_update_player", (a, ctx, u) => runUpdatePlayer(a, ctx, u)),
  },
  {
    name: "game_remove_player",
    description: "A hero leaves the party for good because their player is leaving the game. Never for something a hero does in the story.",
    input: { player: heroArg("Which hero leaves the party") },
    argMode: "raw",
    available: hasHeroes,
    options: heroOptions,
    run: guarded("game_remove_player", (a, ctx, u) => runRemovePlayer(a, ctx, u)),
  },
  {
    name: "game_add_item",
    description: "New loot enters the story: something found, rewarded, or handed out by the Game Master that nobody carried before.",
    input: { owner: heroArg("Who gets the item — a hero, or the party's shared loot") },
    argMode: "raw",
    available: inPlay,
    options: (arg, { persona }) => {
      if (arg !== "owner") return undefined;
      const players = playerOptions(persona);
      return players ? { ...players, party: "the party (shared loot)" } : undefined;
    },
    run: guarded("game_add_item", runAddItem),
  },
  {
    name: "game_use_item",
    description:
      "A hero uses something they carry: drinks a potion (or gives it to a fallen friend), equips or puts away a weapon, armor or shield, hands an item or gold to someone, takes something from the party's loot, or drops it.",
    input: { player: heroArg("Which hero is doing it") },
    argMode: "raw",
    available: inPlay,
    options: heroOptions,
    run: guarded("game_use_item", (a, ctx, u) => runUseItem(a, ctx, u)),
  },
  {
    name: "game_trade",
    description: "A hero buys or sells something for gold.",
    input: { player: heroArg("Which hero is buying or selling") },
    argMode: "raw",
    available: exploring,
    options: heroOptions,
    run: guarded("game_trade", (a, ctx, u) => runTrade(a, ctx, u)),
  },
  {
    name: "game_add_npc",
    description: "Someone or something new enters the scene: a villain, an ally, a shopkeeper, or creatures appearing ('two goblins jump out').",
    input: {},
    argMode: "raw",
    available: inPlay,
    run: guarded("game_add_npc", (_a, ctx, u) => runAddNpc(ctx, u)),
  },
  {
    name: "game_update_npc",
    description:
      "Something said outright about a character or creature that isn't a hero: it flees, surrenders, dies, leaves, changes sides, or takes a stated amount of damage or a condition.",
    input: {},
    argMode: "raw",
    available: inPlay,
    run: guarded("game_update_npc", (_a, ctx, u) => runUpdateNpc(ctx, u)),
  },
  {
    name: "game_set_scene",
    description: "The party arrives somewhere new, or the scene is set or described afresh.",
    input: {},
    argMode: "raw",
    available: exploring,
    run: guarded("game_set_scene", (_a, ctx, u) => runSetScene(ctx, u)),
  },
  {
    name: "game_begin",
    description: "Setup is finished and the players say to begin the adventure ('let's begin', 'that's everyone, start').",
    input: {},
    argMode: "raw",
    available: inSetup,
    run: guarded("game_begin", (_a, ctx, u) => runBegin(ctx, u)),
  },
  {
    name: "game_load",
    description: "Continue or load a saved game ('let's continue our game', 'load the pirate adventure').",
    input: { game: { type: "string", description: "saved game to continue", required: false } },
    argMode: "raw",
    available: hasSavedGames,
    options: (arg, { persona }) => (arg === "game" ? gameOptions(persona) : undefined),
    run: guarded("game_load", runLoad),
  },
  {
    name: "game_confirm",
    description: "The user answers yes or no to the question the Game Master just asked.",
    input: {},
    argMode: "raw",
    available: confirmPending,
    run: guarded("game_confirm", (_a, ctx, u) => runConfirm(ctx, u)),
  },
];

export const gameTools: Tool[] = TOOL_DEFS.map((t) => ({ ...t, toolset: "game", source: "builtin" }));

/** Register the Game Master toolset (visible to personas whose toolsets include "game"). */
export function registerGameTools(): void {
  for (const t of gameTools) registerTool(t);
  registerPlayTools();
  onConfirm(settleConfirm);
  resumable("game_update_player", (ctx, words, extra) => runUpdatePlayer({}, ctx, words, extra));
  resumable("game_remove_player", (ctx, words, extra) => runRemovePlayer({}, ctx, words, extra));
  resumable("game_use_item", (ctx, words, extra) => runUseItem({}, ctx, words, extra));
  resumable("game_trade", (ctx, words, extra) => runTrade({}, ctx, words, extra));
}
