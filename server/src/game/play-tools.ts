import { registerTool } from "../tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { buildEncounter, findMonster } from "./bestiary.js";
import {
  advanceTurn,
  currentCombatant,
  delayTurn,
  encounterDifficulty,
  endCombat,
  foes,
  heroById,
  longRestParty,
  partyLevels,
  passSpotlight,
  promptLine,
  shortRestParty,
  standing,
  startCombat,
  turnHero,
  whoseTurn,
} from "./engine.js";
import {
  countIn,
  dice,
  exploring,
  guarded,
  inCombat,
  inPlay,
  inPlayOrPaused,
  NO_GAME,
  notOver,
  resumable,
  spawnCreatures,
  spoken,
  withTurn,
} from "./kit.js";
import { joinLines } from "./lines.js";
import { listNames } from "./names.js";
import { askNext, questionText, realPlayers, setupQuestion } from "./setup.js";
import { recap, rememberSpoken, rememberTurn } from "./memory.js";
import { presentGame, presentIfCurrent } from "./present.js";
import { addLog, checkpointGame, getActiveGame, getGame, historyDepth, mutateGame, newId, undoGame } from "./store.js";
import type { Game } from "./types.js";

/**
 * The tools that run play itself: starting and ending a fight, passing the turn, resting, undoing a turn, pausing
 * and resuming, and ending the session. Each changes the game through the engine in one mutation and says what the
 * engine resolved; none of them asks a model anything.
 */

const PAUSED = "The game is paused. Say resume when you're ready to go on.";

function notPlaying(g: Game): ToolResult | null {
  if (g.phase === "paused") return spoken(PAUSED);
  if (g.phase === "setup") return spoken("We're still setting up. Say let's begin when the party is ready.");
  if (g.phase === "ended") return spoken("This adventure has ended. Say you'd like a new game, or load another one.");
  return null;
}

// ─── Fights ──────────────────────────────────────────────────────────────────

const WANTS_FOES = /\b(encounter|monsters?|enemies|enemy|something attacks|we(?:'re| are) attacked|a fight breaks out|ambush\w*|random (?:encounter|fight)|send (?:in )?(?:the )?(?:monsters|enemies)|bring on)\b/i;

/**
 * game_start_combat: creatures named in the words appear ("two goblins attack"); with none named and nobody hostile
 * here, an encounter is built to the party's XP budget when the words ask for one. Then initiative is rolled for
 * everyone, in code.
 */
async function runStartCombat(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const blocked = notPlaying(game);
  if (blocked) return blocked;
  if (game.combat) return spoken(`The fight is already on. ${whoseTurn(game)}`);
  presentGame(game.id);
  return withTurn(game.id, async () => {
    checkpointGame(game.id, "the start of a fight");
    let lines: string[] = [];
    let started = false;
    const saved = await mutateGame(game.id, (g) => {
      const named = findMonster(utterance);
      const here = foes(g);
      if (named && !here.some((n) => n.kind === named.key)) {
        const made = spawnCreatures(g, named, countIn(utterance));
        lines.push(made.length === 1 ? `${/^[aeiou]/i.test(named.name) ? "An" : "A"} ${named.name.toLowerCase()} attacks.` : `${made.length} ${named.name.toLowerCase()}s attack.`);
      } else if (!here.length && WANTS_FOES.test(utterance)) {
        const plan = buildEncounter({
          levels: partyLevels(g),
          difficulty: encounterDifficulty(g),
          rng: dice(),
          theme: [g.scene?.title, g.scene?.description, g.setting, g.genre].filter(Boolean).join(" "),
          favor: g.story.threats,
        });
        for (const pick of plan.picks) spawnCreatures(g, pick.monster, pick.count);
        const what = plan.picks.map((p) => (p.count === 1 ? `${/^[aeiou]/i.test(p.monster.name) ? "an" : "a"} ${p.monster.name.toLowerCase()}` : `${p.count} ${p.monster.name.toLowerCase()}s`)).join(" and ");
        lines.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} ${plan.picks.length === 1 && plan.picks[0]!.count === 1 ? "attacks" : "attack"}.`);
        addLog(g, "system", `Encounter: ${plan.why}.`);
      }
      const surprise = /\b(?:we|i)\s+(?:ambush|surprise|sneak up on|jump)\b/i.test(utterance)
        ? "foes"
        : /\b(?:ambush(?:ed|es)? us|surpris(?:e|es|ed) us|we(?:'re| are) (?:ambushed|surprised)|they (?:ambush|surprise|jump))\b/i.test(utterance)
          ? "heroes"
          : null;
      const fight = startCombat(g, dice(), { surprise });
      started = fight.started;
      lines.push(...fight.lines);
      if (started) rememberTurn(g, joinLines(lines.filter((l) => !/you're up\.$/.test(l))), joinLines(lines));
      else rememberSpoken(g, joinLines(lines));
    });
    if (!saved) return { ok: false, say: "The game was closed before the fight could start." };
    presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

/** game_end_combat: the fight is over or called off. XP for what was overcome is shared out. */
async function runEndCombat(ctx: ToolContext, _utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const blocked = notPlaying(game);
  if (blocked) return blocked;
  if (!game.combat) return spoken("There's no fight going on.");
  return withTurn(game.id, async () => {
    checkpointGame(game.id, "the end of the fight");
    let lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      if (!g.combat) return;
      const anyFoe = g.combat.order.some((c) => c.kind === "npc");
      lines = endCombat(g, dice(), anyFoe ? "stopped" : "victory").lines;
      if (standing(g).length) lines.push(promptLine(g));
      rememberTurn(g, joinLines(lines.slice(0, -1)), joinLines(lines));
    });
    if (!saved) return { ok: false, say: "The game was closed before the fight could end." };
    presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

/** game_next_turn: the hero on turn is done ("that's my turn", "I pass", "skip me"), or steps back one place ("I delay"). */
async function runNextTurn(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const blocked = notPlaying(game);
  if (blocked) return blocked;
  return withTurn(game.id, async () => {
    const g0 = getGame(game.id) ?? game;
    if (g0.pending.check) {
      const owes = heroById(g0, g0.pending.check.heroId);
      return spoken(`First, ${owes?.name ?? "that"}'s ${g0.pending.check.label.toLowerCase()}: tell me the roll, or say roll for me.`);
    }
    checkpointGame(game.id, g0.combat ? `${turnHero(g0)?.name ?? "the"} turn passing` : "passing the spotlight");
    let lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      if (g.combat) {
        const who = turnHero(g);
        const delay = /\b(delay|wait|hold (?:my|his|her|their) (?:turn|action)|go after)\b/i.test(utterance);
        lines = [who ? `${who.name} ${delay ? "waits" : "passes"}.` : "", ...(delay ? delayTurn(g, dice()) : advanceTurn(g, dice()))];
        if (!g.combat && standing(g).length) lines.push(promptLine(g));
      } else {
        passSpotlight(g, g.spotlightId);
        lines = [promptLine(g)];
      }
      rememberSpoken(g, joinLines(lines));
    });
    if (!saved) return { ok: false, say: "The game was closed before the turn could pass." };
    presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

// ─── Rests ───────────────────────────────────────────────────────────────────

const LONG_REST = /\b(long rest|sleep|for the night|overnight|make camp|set up camp|camp here|eight hours|until (?:morning|dawn)|full rest|bed down|turn in)\b/i;

async function runRest(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  const blocked = notPlaying(game);
  if (blocked) return blocked;
  if (game.combat) return spoken("You can't rest in the middle of a fight.");
  return withTurn(game.id, async () => {
    const long = LONG_REST.test(utterance);
    checkpointGame(game.id, long ? "a long rest" : "a short rest");
    let lines: string[] = [];
    const saved = await mutateGame(game.id, (g) => {
      lines = long ? longRestParty(g) : shortRestParty(g, dice());
      rememberTurn(g, joinLines(lines), joinLines([...lines, promptLine(g)]));
      lines.push(promptLine(g));
    });
    if (!saved) return { ok: false, say: "The game was closed before the rest." };
    presentIfCurrent(saved.id);
    return spoken(lines);
  });
}

// ─── Undo, pause, the end of the session ─────────────────────────────────────

/** game_undo: the game goes back to how it was before the last story turn (up to twenty turns back). */
async function runUndo(ctx: ToolContext, _utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "setup") return spoken("There's nothing to undo yet.");
  return withTurn(game.id, async () => {
    if (!historyDepth(game.id)) return spoken("There's nothing left to undo.");
    const undone = await undoGame(game.id);
    if (!undone) return spoken("I couldn't undo that.");
    const g = undone.game;
    presentGame(g.id);
    const where = g.pending.check ? whoseTurn(g) : g.combat ? whoseTurn(g) : g.phase === "playing" ? promptLine(g) : "";
    const line = joinLines([`Undone: ${undone.label}.`, where]);
    await mutateGame(g.id, (d) => {
      addLog(d, "system", `Undone: ${undone.label}.`);
    });
    return spoken(line);
  });
}

const RESUME = /\b(resume|unpause|continue|we'?re back|i'?m back|back now|carry on|keep going|let'?s (?:go on|continue|keep going|get back)|pick (?:it|up) (?:back )?up|where were we)\b/i;

/** game_pause: stop the story for a break, or pick it up again. Nothing happens in the game while it is paused. */
async function runPause(ctx: ToolContext, utterance: string): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "setup") {
    // Nothing runs during setup, so there is nothing to stop: say so, and that nothing is lost.
    if (RESUME.test(utterance) && !/(pause|break|hold)/i.test(utterance)) {
      let ask = "";
      await mutateGame(game.id, (g) => {
        const q = setupQuestion(g);
        ask = askNext(g) || (q ? questionText(g, q, true) : "");
      });
      return spoken(["We're back.", ask]);
    }
    await mutateGame(game.id, (g) => {
      addLog(g, "system", "A break during setup.");
    });
    return spoken("All right, a break. The setup is saved as it is; say let's continue when you're ready.");
  }
  if (game.phase === "ended") return spoken("This adventure has ended.");
  const resume = game.phase === "paused" && (RESUME.test(utterance) || !/\bpause\b/i.test(utterance));
  if (game.phase === "paused" && !resume) return spoken(PAUSED);
  if (game.phase === "playing" && RESUME.test(utterance) && !/\b(pause|break|hold)\b/i.test(utterance)) return spoken(["We're not paused.", game.combat ? whoseTurn(game) : promptLine(game)]);
  let line = "";
  const saved = await mutateGame(game.id, (g) => {
    if (resume) {
      g.phase = "playing";
      const where = g.scene ? `You are at ${g.scene.title}.` : "";
      const waiting = g.pending.check ? whoseTurn(g) : g.combat ? whoseTurn(g) : promptLine(g);
      line = joinLines(["We're back.", where, waiting]);
      addLog(g, "system", "The game resumes.");
    } else {
      g.phase = "paused";
      line = "Paused. Say resume when you're ready.";
      addLog(g, "system", "The game is paused.");
    }
  });
  if (!saved) return { ok: false, say: "The game was closed." };
  presentIfCurrent(saved.id);
  return spoken(line);
}

const CAMPAIGN_OVER = /\b(campaign|adventure|story|game)\b[^.?!]{0,30}\b(is over|is finished|is done|is complete|has ended|ends here|for good|forever)\b|\b(end|finish|close|wrap up)\b[^.?!]{0,20}\b(campaign|adventure|story) (?:for good|forever|completely)\b|\bthe end\b/i;

/**
 * game_end_session: stop for the night. The story so far is recapped and the game is left paused and saved, ready to
 * be loaded another day. Ending the whole adventure for good is a different thing and asks for a yes first.
 */
async function runEndSession(ctx: ToolContext, utterance: string, confirmed = false): Promise<ToolResult> {
  const game = getActiveGame(ctx.persona.id);
  if (!game) return NO_GAME;
  if (game.phase === "setup") {
    // Stopping before the story begins: everything said so far is kept, and the next time picks up from here.
    const party = realPlayers(game).map((p) => p.name);
    await mutateGame(game.id, (g) => {
      addLog(g, "system", "The table stops for now during setup. The game is saved.");
    });
    return spoken([`We'll stop here. Your game is saved${party.length ? `, with ${listNames(party)}` : ""}.`, "Next time, say let's continue our game."]);
  }
  if (game.phase === "ended") return spoken("This adventure has already ended.");
  if (CAMPAIGN_OVER.test(utterance) || confirmed) {
    if (!confirmed) {
      const question = `End ${game.title} for good? It stays in your saved games, but play stops here. Say yes or no.`;
      await mutateGame(game.id, (g) => {
        g.pending.confirm = { id: newId(), kind: "end_campaign", targetId: null, words: utterance, question, askedAt: Date.now() };
      });
      return spoken(question, { confirm: "end_campaign" });
    }
    let line = "";
    await mutateGame(game.id, (g) => {
      g.pending = { check: null, confirm: null, action: null };
      g.combat = null;
      g.phase = "ended";
      line = joinLines([recap(g, { lead: `And so ends ${g.title}.` }), "Thank you for playing."]);
      rememberSpoken(g, line);
      addLog(g, "system", "The adventure has ended.");
    });
    presentIfCurrent(game.id);
    return spoken(line);
  }
  let line = "";
  const saved = await mutateGame(game.id, (g) => {
    g.phase = "playing"; // the recap is of the game in play
    const body = recap(g, { lead: "That's where we stop." });
    g.phase = "paused";
    g.story.sessions += 1;
    // (Stopping for the night is no moment to ask for a move or a roll: the recap's hand-off is left out.)
    const handOff = /\s*(?:(?:\S+, )?(?:what do you do\?|you're up\.|your [^.?!]+ is still waiting: tell me the roll, or say roll for me\.)|\S+'s roll is still waiting\.)\s*$/i;
    line = joinLines([body.replace(handOff, ""), "Your game is saved. Say resume to pick it up again."]);
    rememberSpoken(g, line);
    addLog(g, "system", "The session ends. The game is saved.");
  });
  if (!saved) return { ok: false, say: "The game was closed." };
  presentIfCurrent(saved.id);
  return spoken(line);
}

// ─── Registration ────────────────────────────────────────────────────────────

const PLAY_TOOLS: Tool[] = [
  {
    name: "game_start_combat",
    description: "A fight starts: 'roll initiative', creatures attack ('two goblins attack us'), an ambush, or the players ask for an encounter.",
    input: {},
    argMode: "raw",
    available: exploring,
    run: guarded("game_start_combat", (_a, ctx, u) => runStartCombat(ctx, u)),
  },
  {
    name: "game_end_combat",
    description: "The fight is over or called off: the foes surrender or are gone, or the party breaks away.",
    input: {},
    argMode: "raw",
    available: inCombat,
    run: guarded("game_end_combat", (_a, ctx, u) => runEndCombat(ctx, u)),
  },
  {
    name: "game_next_turn",
    description: "The hero on turn is finished or passes: 'that's my turn', 'I'm done', 'next', 'I pass', 'skip my turn', 'I delay'.",
    input: {},
    argMode: "raw",
    available: inPlay,
    run: guarded("game_next_turn", (_a, ctx, u) => runNextTurn(ctx, u)),
  },
  {
    name: "game_rest",
    description: "The party rests: a short rest (an hour) or a long rest (camp for the night).",
    input: {},
    argMode: "raw",
    available: exploring,
    run: guarded("game_rest", (_a, ctx, u) => runRest(ctx, u)),
  },
  {
    name: "game_undo",
    description: "Take back the last turn of the game: 'undo that', 'take that back', 'that was a mistake, go back'.",
    input: {},
    argMode: "raw",
    available: inPlayOrPaused,
    run: guarded("game_undo", (_a, ctx, u) => runUndo(ctx, u)),
  },
  {
    name: "game_pause",
    description: "Pause the game for a break, or pick it up again: 'pause the game', 'let's take a break', 'we're back', 'resume'.",
    input: {},
    argMode: "raw",
    available: notOver,
    run: guarded("game_pause", (_a, ctx, u) => runPause(ctx, u)),
  },
  {
    name: "game_end_session",
    description: "Stop playing for today: 'let's stop here', 'end the session', 'that's it for tonight'. The story is recapped and saved.",
    input: {},
    argMode: "raw",
    available: notOver,
    run: guarded("game_end_session", (_a, ctx, u) => runEndSession(ctx, u)),
  },
];

export const playTools: Tool[] = PLAY_TOOLS.map((t) => ({ ...t, toolset: "game", source: "builtin" }));

export function registerPlayTools(): void {
  for (const t of playTools) registerTool(t);
  resumable("game_start_combat", (ctx, words) => runStartCombat(ctx, words));
  resumable("game_pause", (ctx, words) => runPause(ctx, words));
  resumable("game_end_session", (ctx, words, extra) => runEndSession(ctx, words, extra.actorId === "confirmed"));
}

/** The hero or creature on turn, for callers that only need the name. */
export function onTurnName(g: Game): string {
  const c = currentCombatant(g);
  return c?.kind === "hero" ? (heroById(g, c.id)?.name ?? "") : "";
}
