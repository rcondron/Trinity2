import { getImageJob, requestImage, type ImageKind } from "../services/images.js";
import { live } from "../settings.js";
import type { Persona, ToolContext, ToolResult } from "../types.js";
import { isNo, isYes, parseRollAnswer } from "./adjudicate.js";
import type { Monster } from "./bestiary.js";
import { actingHero, heroById, heroes, joinCombat, spawn } from "./engine.js";
import { joinLines, tighten } from "./lines.js";
import { findHero, namedActor } from "./names.js";
import { setBusy } from "./present.js";
import { cryptoRng, type Rng } from "./rules.js";
import { isFramed, realPlayers } from "./setup.js";
import { addLog, emptySlot, getActiveGame, listGames, mutateGame, newId, setImageStatus, subscribeGameChanges } from "./store.js";
import type { Game, ImageSlot, Npc, PendingAction, PendingConfirm, Player } from "./types.js";

/**
 * What every Game Master tool shares: the die, the one-turn-at-a-time queue, the spoken-result helpers, art, the
 * router's view of the active game, and the pre-flight that settles a pending question before any tool runs: a yes
 * or no to a destructive step, the bare name that answers "Who is doing that?", the number that answers a called roll.
 */

// ─── The die ─────────────────────────────────────────────────────────────────

let gameRng: Rng = cryptoRng;

/** The die every game tool rolls. */
export const dice = (): Rng => gameRng;

/** Swap the die (tests script it); pass nothing to go back to real randomness. */
export function setGameRng(rng?: Rng): void {
  gameRng = rng ?? cryptoRng;
}

// ─── One story turn at a time ────────────────────────────────────────────────

const turns = new Map<string, Promise<unknown>>();

/**
 * Run a story turn for a game after every turn already under way for it has finished, so a second action that arrives
 * while one is resolving waits and then sees the game as that one left it, never a stale snapshot.
 */
export function withTurn<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
  const prev = turns.get(gameId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  turns.set(gameId, tail);
  void tail.then(() => {
    if (turns.get(gameId) === tail) turns.delete(gameId);
  });
  return run;
}

/** Story turns queued or running for a game (0 when idle). */
export const turnsWaiting = (gameId: string): boolean => turns.has(gameId);

// ─── Results ─────────────────────────────────────────────────────────────────

export const NO_GAME: ToolResult = (() => {
  const text = "There's no game on the table yet. Say you'd like to start a new game, or continue a saved one.";
  return { ok: true, say: text, speak: text };
})();

/** A line the Game Master says exactly as written (built in code from the game's state). */
export function spoken(lines: string | (string | null | undefined | false)[], data?: unknown): ToolResult {
  const text = Array.isArray(lines) ? joinLines(tighten(lines)) : lines.replace(/\s+/g, " ").trim();
  return data === undefined ? { ok: true, say: text, speak: text } : { ok: true, say: text, speak: text, data };
}

/** Nothing to say and nothing done: the words weren't for the Game Master (table talk). */
export function silent(why = "table talk"): ToolResult {
  return { ok: true, say: `(${why}: nothing said, nothing changed)`, silent: true, data: { silent: true } };
}

export function wordsOf(args: Record<string, unknown>, ctx: ToolContext): string {
  const u = typeof ctx.utterance === "string" ? ctx.utterance.trim() : "";
  if (u) return u;
  for (const k of ["text", "utterance", "description", "instruction", "query"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** The last few turns, for generators that benefit from context (e.g. "I'm a dwarf" after "I'm Thorin"). */
export function recentLines(ctx: ToolContext, utterance: string): string[] {
  const turnsSaid = (ctx.recentTranscript ?? []).slice(-6);
  const last = turnsSaid[turnsSaid.length - 1];
  const body = last && last.text.trim() === utterance.trim() ? turnsSaid.slice(0, -1) : turnsSaid;
  return body
    .filter((t) => t.text.trim())
    .slice(-4)
    .map((t) => `${t.speaker === "user" ? "Player" : t.speaker === "trinity" ? "Game Master" : "Note"}: ${t.text.trim().slice(0, 300)}`);
}

export const partyWord = (g: Game) => (g.theme.labels.party || "Party").toLowerCase();

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

// ─── Creatures ───────────────────────────────────────────────────────────────

const COUNT_IN: [RegExp, number][] = [
  [/\b(?:a pair of|a couple of|two|2)\b/i, 2],
  [/\b(?:three|3|a few)\b/i, 3],
  [/\b(?:four|4|a pack of|a band of|a gang of|several)\b/i, 4],
  [/\b(?:five|5)\b/i, 5],
  [/\b(?:six|6|a horde of|a swarm of|a dozen)\b/i, 6],
];
/** How many creatures some words speak of ("two goblins", "a pack of wolves"): 1 when they don't say. */
export const countIn = (text: string): number => COUNT_IN.find(([re]) => re.test(text))?.[1] ?? 1;

/** Put bestiary creatures into the scene (at most six at once), one shared portrait a kind, joining a fight already on. */
export function spawnCreatures(g: Game, monster: Monster, count: number): Npc[] {
  const made = spawn(g, monster, Math.min(6, Math.max(1, count)));
  const portrait = paint(g, "portrait", `${monster.name}, ${monster.type}, menacing`, `Painting the ${monster.name.toLowerCase()}…`);
  for (const n of made) {
    n.portrait = { ...portrait };
    if (g.combat) joinCombat(g, dice(), n);
  }
  const what = monster.name.toLowerCase();
  addLog(g, "narration", made.length === 1 ? `${/^[aeiou]/.test(what) ? "An" : "A"} ${what} appears.` : `${made.length} ${what}s appear.`);
  return made;
}

// ─── Who is acting ───────────────────────────────────────────────────────────

export type Actor = { hero: Player; how: "named" | "turn" | "spotlight" | "only" | "given" } | { hero: null; how: "ask" };

/**
 * Who a sentence is about, in order: a hero (or their player) the sentence names as acting; in a fight, the hero whose
 * turn it is; outside one, the hero who holds the spotlight; the only hero there is; and when none of that settles it,
 * nobody can tell and the Game Master asks. `given` is a hero already settled (the answer to that question);
 * `routerPick` is the router's own guess, used only before asking.
 */
export function resolveActor(g: Game, utterance: string, given?: string | null, routerPick?: unknown): Actor {
  const forced = heroById(g, given);
  if (forced) return { hero: forced, how: "given" };
  const named = namedActor(g, utterance);
  if (named) return { hero: named, how: "named" };
  if (g.combat) {
    const onTurn = actingHero(g);
    if (onTurn) return { hero: onTurn, how: "turn" };
  } else {
    const lit = heroById(g, g.spotlightId);
    if (lit && !lit.dead) return { hero: lit, how: "spotlight" };
  }
  const able = heroes(g).filter((p) => !p.dead);
  if (able.length === 1) return { hero: able[0]!, how: "only" };
  const picked = typeof routerPick === "string" ? heroById(g, routerPick.trim()) : null;
  if (picked) return { hero: picked, how: "given" };
  return { hero: null, how: "ask" };
}

/** The question asked when nobody can tell who is acting; the action is kept so a bare name completes it. */
export async function askWho(g: Game, tool: string, words: string, question = "Who is doing that?"): Promise<ToolResult> {
  await mutateGame(g.id, (game) => {
    game.pending.action = { id: newId(), tool, words, question, need: "actor", actorId: null, askedAt: Date.now() };
  });
  return spoken(question);
}

// ─── Pending questions ───────────────────────────────────────────────────────

const PENDING_TTL_MS = 120_000;

type ConfirmHandler = (ctx: ToolContext, game: Game, confirm: PendingConfirm, yes: boolean) => Promise<ToolResult>;
/** What a resumed tool is handed besides the words: the hero who answered "who?", the words that answered "which one?", or `quiet` (no narration of its own: the story opening just said it). */
export interface ResumeExtra {
  actorId?: string;
  targetWords?: string;
  quiet?: boolean;
}
type Resumer = (ctx: ToolContext, words: string, extra: ResumeExtra) => Promise<ToolResult>;
type CheckHandler = (ctx: ToolContext, words: string) => Promise<ToolResult>;

let confirmHandler: ConfirmHandler | null = null;
let checkHandler: CheckHandler | null = null;
const resumers = new Map<string, Resumer>();

export function onConfirm(fn: ConfirmHandler): void {
  confirmHandler = fn;
}
export function onRollAnswer(fn: CheckHandler): void {
  checkHandler = fn;
}
/** A tool that can be finished later, once its question is answered (or handed a sentence by another tool). */
export function resumable(tool: string, fn: Resumer): void {
  resumers.set(tool, fn);
}
/** Hand a sentence to another game tool's runner ("roll initiative" starts the fight). Null when it isn't registered. */
export function resumeTool(tool: string, ctx: ToolContext, words: string, extra: ResumeExtra = {}): Promise<ToolResult> | null {
  return resumers.get(tool)?.(ctx, words, extra) ?? null;
}

const CONFIRM_TOOL: Record<PendingConfirm["kind"], string> = {
  new_game: "game_new",
  remove_player: "game_remove_player",
  load_game: "game_load",
  end_campaign: "game_end_session",
};

/** A short reply that is just a hero's (or player's) name: "Thorin", "me, Mira", "that was Thorin". */
function namedOnly(g: Game, utterance: string): Player | null {
  const words = utterance.trim().split(/\s+/);
  if (words.length > 5) return null;
  return findHero(g, utterance);
}

/**
 * Before any game tool runs: is the table answering something the Game Master asked? A yes or no to a destructive
 * step settles it; a bare name finishes the action that was waiting for an actor; a number (or "roll for me") resolves
 * the roll that was called for. Any other sentence lets an old question lapse. Returns the result to say, or null to
 * let the tool run.
 */
async function preflight(name: string, ctx: ToolContext, utterance: string): Promise<ToolResult | null> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return null;
  const now = Date.now();

  const confirm = game.pending.confirm;
  if (confirm) {
    const fresh = now - confirm.askedAt < PENDING_TTL_MS;
    if (fresh && confirmHandler && (isYes(utterance) || isNo(utterance))) return confirmHandler(ctx, game, confirm, isYes(utterance));
    if (!fresh || (name !== "game_confirm" && name !== CONFIRM_TOOL[confirm.kind])) {
      await mutateGame(game.id, (g) => {
        g.pending.confirm = null;
      });
    }
  }

  const action = game.pending.action;
  if (action) {
    const fresh = now - action.askedAt < PENDING_TTL_MS;
    const resume = resumers.get(action.tool);
    const who = action.need === "actor" ? namedOnly(game, utterance) : null;
    await mutateGame(game.id, (g) => {
      g.pending.action = null;
    });
    if (fresh && resume && who) return resume(ctx, action.words, { actorId: who.id });
    if (fresh && resume && action.need === "target" && utterance.trim().split(/\s+/).length <= 6) return resume(ctx, action.words, { actorId: action.actorId ?? undefined, targetWords: utterance });
  }

  if (game.pending.check && checkHandler && name !== "game_narrate" && name !== "game_roll" && parseRollAnswer(utterance)) return checkHandler(ctx, utterance);
  return null;
}

/** The pending question's own record, for tools that ask one. */
export function pendingAction(tool: string, words: string, question: string, need: PendingAction["need"], actorId: string | null = null): PendingAction {
  return { id: newId(), tool, words, question, need, actorId, askedAt: Date.now() };
}

// ─── Wrapping a tool ─────────────────────────────────────────────────────────

export type ToolRun = (args: Record<string, unknown>, ctx: ToolContext, utterance: string) => Promise<ToolResult>;

/** Run a tool with the pre-flight above, timing in the log, and a spoken apology instead of a thrown error. */
export function guarded(name: string, fn: ToolRun) {
  return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const started = Date.now();
    try {
      const utterance = wordsOf(args ?? {}, ctx);
      const res = (await preflight(name, ctx, utterance)) ?? (await fn(args ?? {}, ctx, utterance));
      console.log(`[game] ${name} ${res.ok ? "ok" : "declined"} in ${Date.now() - started}ms`);
      return res;
    } catch (err) {
      console.warn(`[game] ${name} failed:`, err);
      return { ok: false, say: "Something went wrong at the game table — let's try that again.", error: (err as Error).message };
    }
  };
}

// ─── Availability & dynamic options (Jev's choices) ──────────────────────────
// The router asks every tool's `available()` and `options()` on each poll (~400ms), so they
// read a short-lived snapshot of the active game. Every saved change (and every switch of
// the active game) invalidates it, so Jev always sees new heroes immediately.

const snapshots = new Map<string, { at: number; game: Game | null }>();
const savedGames = new Map<string, { at: number; value: Record<string, string> | undefined }>();

export function invalidateSnapshots(): void {
  snapshots.clear();
  savedGames.clear();
}
subscribeGameChanges(invalidateSnapshots);

export function activeSnapshot(personaId: string): Game | null {
  const hit = snapshots.get(personaId);
  if (hit && Date.now() - hit.at < 300) return hit.game;
  const game = getActiveGame(personaId);
  snapshots.set(personaId, { at: Date.now(), game });
  if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value!);
  return game;
}

export const heroLine = (p: Player): string => `${p.race} ${p.className}`.trim().toLowerCase() || "hero";

export function playerOptions(persona: Persona): Record<string, string> | undefined {
  const g = activeSnapshot(persona.id);
  const party = g ? realPlayers(g) : [];
  if (!party.length) return undefined;
  return Object.fromEntries(party.map((p) => [p.id, `${p.name} (${heroLine(p)}${p.playerName ? `, played by ${p.playerName}` : ""})`]));
}

export function gameOptions(persona: Persona): Record<string, string> | undefined {
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

export type Avail = (ctx: { persona: Persona }) => boolean;
const phaseIs =
  (...phases: Game["phase"][]): Avail =>
  ({ persona }) => {
    const g = activeSnapshot(persona.id);
    return g !== null && phases.includes(g.phase);
  };
export const hasActiveGame: Avail = ({ persona }) => activeSnapshot(persona.id) !== null;
export const inSetup: Avail = phaseIs("setup");
export const inPlay: Avail = phaseIs("playing");
export const inPlayOrPaused: Avail = phaseIs("playing", "paused");
export const notEnded: Avail = phaseIs("setup", "playing");
/** Any phase but the end: setup, play, or a pause. */
export const notOver: Avail = phaseIs("setup", "playing", "paused");
export const inCombat: Avail = ({ persona }) => {
  const g = activeSnapshot(persona.id);
  return g !== null && g.phase === "playing" && g.combat !== null;
};
export const exploring: Avail = ({ persona }) => {
  const g = activeSnapshot(persona.id);
  return g !== null && g.phase === "playing" && g.combat === null;
};
export const hasHeroes: Avail = ({ persona }) => {
  const g = activeSnapshot(persona.id);
  return g !== null && g.phase !== "ended" && g.phase !== "paused" && realPlayers(g).length > 0;
};
export const hasSavedGames: Avail = ({ persona }) => gameOptions(persona) !== undefined;
export const confirmPending: Avail = ({ persona }) => (activeSnapshot(persona.id)?.pending.confirm ?? null) !== null;
