import { registerContextProvider, type TalkStyle, type VoiceTuning } from "../agent/context.js";
import { onPersonaActivated } from "../events.js";
import { getActivePersona } from "../db/sqlite.js";
import { ASSIST_TOOL_LIST } from "../services/assist/routes.js";
import { imageExists } from "../services/images.js";
import type { Persona } from "../types.js";
import { heroById } from "./engine.js";
import { describeGame, keyterms, turnName } from "./memory.js";
import { onScreenGameId, presentGame } from "./present.js";
import { getActiveGame, getGame, listGames, mutateGame } from "./store.js";
import type { Game } from "./types.js";

/**
 * Wires the game module into the engine: what Jev and the talking brain know about the
 * active game, which actions make sense in each phase, how the Game Master speaks and
 * listens at a table of several players on one microphone, and keeping the workspace
 * showing the right game across persona switches and restarts.
 */

const isGM = (p: Persona) => (p.toolsets ?? []).includes("game");

/**
 * General tools that only add noise to Jev's choices while a game is running (the game tools cover play).
 * undo_workspace is among them: "undo" at the table means the last turn (game_undo), never an old board put back
 * over the game. set_speech_rate is NOT: "slow down" must work mid-game.
 */
const HIDDEN_DURING_GAME = [
  "build_ui",
  "make_image",
  "make_audio",
  "make_video",
  "make_text",
  "show_card",
  "remove_card",
  "move_card",
  "arrange_cards",
  "resize_card",
  "control_card",
  "read_card",
  "edit_note",
  "rename_card",
  "duplicate_card",
  "figure_out",
  "edit_html",
  "clear_workspace",
  "undo_workspace",
  "describe_workspace",
  "create_skill",
  "remember",
  "recall",
  "schedule",
  "ask_brain",
  "roll_dice",
  "get_time",
  "browser_open",
  "browser_tabs",
  "browser_read",
  "browser_act",
  "browser_modify",
  "browser_save",
  "browser_share",
  // Email, calendar and bookings: at the table "check" and "send" are game words.
  ...ASSIST_TOOL_LIST,
];
/**
 * The Game Master without a game: hide board/media tooling so Jev can find game_new / game_load
 * among a short list. Clear/describe/speech-rate stay available for the empty desk.
 */
const HIDDEN_WITHOUT_GAME = [
  "create_skill",
  "remember",
  "schedule",
  "build_ui",
  "make_image",
  "make_audio",
  "make_video",
  "make_text",
  "show_card",
  "remove_card",
  "move_card",
  "arrange_cards",
  "resize_card",
  "control_card",
  "read_card",
  "edit_note",
  "rename_card",
  "duplicate_card",
  "figure_out",
  "edit_html",
  "browser_open",
  "browser_tabs",
  "browser_read",
  "browser_act",
  "browser_modify",
  "browser_save",
  "browser_share",
];

/** Said to Jev in every phase of a game: the table is several people, and most of what they say isn't for the Game Master. */
const TABLE_RULES = [
  "Several players share one microphone. Talk between the players themselves — jokes, snacks, the real world, planning aloud, half-finished thoughts, reactions like 'nice' or 'oh no' — is NONE: it is not an action in the game.",
  "Never pick game_new, game_load, game_remove_player or game_end_session unless the words plainly ask for exactly that; 'pause the game' or 'take a break' is game_pause, never game_new.",
];

/** The routing rules for the phase the game is in. */
export function gameRules(g: Game | null): string[] {
  if (!g) {
    return ["When the user wants to play, start, or set up a game or adventure, choose game_new; to continue an earlier game, choose game_load."];
  }
  const confirm = g.pending.confirm ? ["The Game Master just asked a yes-or-no question: a yes ('yes', 'do it', 'go ahead') or a no ('no', 'cancel', 'never mind') is game_confirm."] : [];
  if (g.phase === "setup") {
    return [
      ...TABLE_RULES,
      ...confirm,
      "Game setup is in progress and the players are usually answering the Game Master's last question; an answer counts as asking for the matching action.",
      "The kind of adventure (genre, setting, tone, title) is game_configure. A number of players, a tone or something to leave out, easy / standard / hard, experience points or milestones is game_setup. A player's own name, a hero described (a name, species or class) or a ready-made hero picked is game_add_player. Changing a hero who already joined is game_update_player.",
      "'Let's begin', 'that's everyone, start' is game_begin — but 'before we begin…' or 'not yet' is not.",
      "Once a hero has joined, a hero doing something in the story ('Lyra searches the desk', 'I open the door') is game_narrate: it begins the adventure.",
      "A question (a hero's hit points, whose turn it is, what do I see, how a rule works) is game_answer.",
      "'Pause' or 'take a break' is game_pause; 'let's stop here for tonight' is game_end_session — the game is saved either way.",
    ];
  }
  if (g.phase === "paused") {
    return [...TABLE_RULES, ...confirm, "The game is paused: only 'resume', 'we're back' or 'continue' (game_pause), a question (game_answer), ending the session, or loading a game does anything. Everything else is NONE."];
  }
  if (g.phase === "ended") return [...TABLE_RULES, "This adventure has ended: only starting a new game, loading another, or a question does anything."];
  const waiting = g.pending.check
    ? [`The Game Master is waiting for a roll from ${heroById(g, g.pending.check.heroId)?.name ?? "a player"}: a number said on its own, 'I rolled a fourteen', or 'roll for me' is game_roll.`]
    : [];
  const asked = g.pending.action ? [`The Game Master just asked "${g.pending.action.question}": a hero's or player's name in answer is game_narrate.`] : [];
  return [
    ...TABLE_RULES,
    ...confirm,
    ...waiting,
    ...asked,
    "What a hero does, tries or says in the story — attacking, casting a spell, moving, searching, sneaking, talking to a character — is game_narrate. It needs a hero acting: 'I'll be right back' or 'I need a drink' is NONE.",
    "A question to the Game Master (whose turn is it, my hit points, my spell slots, what can I do, what do I see, repeat that, recap, how does grappling work) is game_answer, not game_narrate.",
    "A number a player rolled, 'roll for me', or a request for a named roll is game_roll. A fight starting ('roll initiative', creatures attack) is game_start_combat. 'That's my turn', 'I pass', 'next' is game_next_turn.",
    "Drinking a potion, equipping or giving an item is game_use_item; buying or selling is game_trade; new loot handed out is game_add_item.",
    "A change stated with its amount ('Thorin takes five damage', 'give everyone fifty XP', 'Mira is poisoned') is game_update_player; for a creature that isn't a hero it is game_update_npc.",
    "'Undo', 'take that back' is game_undo. 'Pause', 'take a break' is game_pause. 'Let's stop here for tonight' is game_end_session. Arriving somewhere new is game_set_scene. A short or long rest is game_rest.",
  ];
}

/** How the talking brain should speak for the Game Master when no tool takes a sentence. */
export function gameTalk(g: Game | null): TalkStyle {
  const base = [
    "You are the Game Master at a table where several players share one microphone. Much of what you hear is the players talking to each other, not to you.",
    "Reply SILENT to chatter between players that isn't addressed to the Game Master: jokes, snacks and drinks, the real world, players planning among themselves, reactions, half-finished thoughts. When in doubt, SILENT.",
  ];
  if (!g) {
    return {
      guidance: [...base, "No game is on the table yet. If they want to play, invite them to say what kind of adventure they'd like, in one short sentence."].join(" "),
      caps: { maxSentences: 1, maxWords: 22 },
    };
  }
  if (g.phase === "setup") {
    return {
      guidance: [
        ...base,
        "The game is being set up, one question at a time; the helpers ask the setup questions and record the answers. If the players answer a setup question, describe a hero, or say what a hero does in the story (that begins the adventure), reply ACT.",
        "Otherwise answer briefly from the situation below and never invent a hero, a rule or a setting detail that isn't there. Ask at most one question, and never repeat the setup question in your own words.",
        "If the table stops for the night or takes a break, say the game is saved as it is.",
      ].join(" "),
      caps: { maxSentences: 2, maxWords: 30 },
      silence: true,
    };
  }
  const turn = turnName(g);
  const waiting = g.pending.check ? ` You are waiting for ${heroById(g, g.pending.check.heroId)?.name ?? "a player"}'s ${g.pending.check.label.toLowerCase()}: if they say a number or ask you to roll, reply ACT.` : "";
  return {
    guidance: [
      ...base,
      "Stay inside the fiction and speak as the narrator, calmly and clearly.",
      "Answer questions about the rules or the state of the game ONLY from the state in the situation below. If it isn't written there, say you'll check rather than guess.",
      "Never invent dice results, numbers, damage, hits, misses, or any outcome, and never narrate the consequences of an action: helpers resolve every action with the rules and say the result. If a player declares that their hero does something, reply ACT.",
      g.phase === "paused" ? "The game is paused: nothing happens in the story until someone says resume. Anything but that is SILENT." : "",
      `Ask at most one question at a time, and never re-ask one in the same breath. When you prompt, name whose turn it is${turn ? `: right now that is ${turn}` : ""}.${waiting}`,
      "No lists. One or two short sentences.",
    ]
      .filter(Boolean)
      .join(" "),
    caps: { maxSentences: 2, maxWords: 34 },
    // Typed chatter between players gets no reply either (the voice already stays quiet for it).
    silence: true,
  };
}

const FILLERS: Record<string, string[]> = {
  fantasy: ["Let me see.", "The dice are rolling.", "One moment, adventurers.", "Fate takes a breath."],
  space: ["Stand by.", "Running the numbers.", "One moment, crew.", "Scanning."],
  dark: ["Let me see.", "The candle gutters.", "One moment.", "Something stirs."],
};

/** Live-voice tuning for the table: a longer pause before a turn ends, names for the transcriber, in-world fillers, a slower pace. */
export function gameVoice(g: Game | null): VoiceTuning | null {
  if (!g) return null;
  const mood = /sci|space|cyber|star|galac|future/i.test(`${g.genre} ${g.theme.texture}`) ? "space" : /horror|dark|grim|gothic|noir/i.test(`${g.genre} ${g.tone}`) ? "dark" : "fantasy";
  return {
    // Players think aloud ("I want to… hmm… check the door"): the turn ends on a real pause, not a breath.
    endpointingMs: g.phase === "setup" ? 900 : 1100,
    keyterms: keyterms(g),
    fillers: FILLERS[mood]!,
    fillerAfterMs: 1800,
    pace: 0.92,
  };
}

export function registerGameContext(): void {
  registerContextProvider({
    describe(persona) {
      if (!isGM(persona)) return null;
      return describeGame(getActiveGame(persona.id));
    },

    rules(persona) {
      if (!isGM(persona)) return [];
      return gameRules(getActiveGame(persona.id));
    },

    hiddenActions(persona) {
      if (!isGM(persona)) return [];
      // The game screen owns the workspace while a game exists; memories are curated separately.
      return getActiveGame(persona.id) ? HIDDEN_DURING_GAME : HIDDEN_WITHOUT_GAME;
    },

    replyStyle(persona) {
      if (!isGM(persona)) return null;
      // Game tools speak their own lines (built in code from the game's state). This only shapes the rare reply
      // the writer still phrases: a declined tool, or a general tool used at the table. Nothing is appended.
      return {
        maxWords: 26,
        maxSentences: 2,
        guidance:
          "You are the Game Master: calm, clear and warm. Say what happened in one or two short sentences, using only the details given. Never add a number, a dice result or an outcome that isn't in them, and don't ask more than one question.",
      };
    },

    // In-character talk ("I'm Thorin, a dwarf who hates elves") isn't a fact about the user.
    suppressCuration(persona) {
      return isGM(persona) && getActiveGame(persona.id) !== null;
    },

    talk(persona) {
      if (!isGM(persona)) return null;
      return gameTalk(getActiveGame(persona.id));
    },

    voice(persona) {
      if (!isGM(persona)) return null;
      return gameVoice(getActiveGame(persona.id));
    },
  });

  // Switching to the Game Master brings their game back onto the workspace.
  onPersonaActivated((persona) => {
    if (!isGM(persona)) return;
    const g = getActiveGame(persona.id);
    if (g) presentGame(g, { force: true });
  });
}

/**
 * After a restart, nothing is generating any more: settle "pending" image slots (the file
 * exists → ready, else error) and drop placeholder heroes whose sheets were never made.
 * Then re-present the game that was on screen so windows show fresh state.
 */
export async function sweepGamesOnBoot(): Promise<void> {
  const settle = (slot: { id: string | null; status: string } | null | undefined) => {
    if (slot && slot.status === "pending") slot.status = imageExists(slot.id) ? "ready" : "error";
  };
  for (const g of listGames()) {
    const needs =
      g.players.some((p) => p.pending || p.portrait.status === "pending") ||
      g.items.some((i) => i.icon.status === "pending") ||
      g.npcs.some((n) => n.portrait.status === "pending") ||
      g.locations.some((l) => l.image.status === "pending") ||
      g.titleImage.status === "pending" ||
      g.scene?.image.status === "pending";
    if (!needs) continue;
    await mutateGame(g.id, (game) => {
      game.players = game.players.filter((p) => !p.pending);
      for (const p of game.players) settle(p.portrait);
      for (const i of game.items) settle(i.icon);
      for (const n of game.npcs) settle(n.portrait);
      for (const l of game.locations) settle(l.image);
      settle(game.titleImage);
      settle(game.scene?.image);
    });
  }
  const onScreen = onScreenGameId();
  if (onScreen && getGame(onScreen)) presentGame(onScreen, { force: true });
  else {
    // Fresh boot with the GM active: show their game if they have one.
    const persona = getActivePersona();
    const g = isGM(persona) ? getActiveGame(persona.id) : null;
    if (g && onScreen === null) presentGame(g, { force: true });
  }
}
