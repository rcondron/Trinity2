import { registerContextProvider } from "../agent/context.js";
import { onPersonaActivated } from "../events.js";
import { getActivePersona } from "../db/sqlite.js";
import { imageExists } from "../services/images.js";
import type { Persona } from "../types.js";
import { onScreenGameId, presentGame } from "./present.js";
import { describeGameForAgent, setupView } from "./setup.js";
import { getActiveGame, getGame, listGames, mutateGame } from "./store.js";

/**
 * Wires the game module into the engine: what Jev and the reply writer know about the
 * active game, which actions make sense in each phase, how the Game Master speaks, and
 * keeping the workspace showing the right game across persona switches and restarts.
 */

const isGM = (p: Persona) => (p.toolsets ?? []).includes("game");

/** General tools that only add noise to Jev's choices while a game is running (the game tools cover play). */
const HIDDEN_DURING_GAME = ["build_ui", "make_image", "make_audio", "make_video", "create_skill", "remember", "recall", "schedule", "ask_brain", "roll_dice", "get_time"];
/** The Game Master without a game: no skill-making, memory-keeping or scheduling. */
const HIDDEN_WITHOUT_GAME = ["create_skill", "remember", "schedule"];

export function registerGameContext(): void {
  registerContextProvider({
    describe(persona) {
      if (!isGM(persona)) return null;
      return describeGameForAgent(getActiveGame(persona.id));
    },

    rules(persona) {
      if (!isGM(persona)) return [];
      const g = getActiveGame(persona.id);
      if (!g) {
        return [
          "When the caller wants to play, start, or set up a game or adventure, choose game_new; to continue an earlier game, choose game_load.",
        ];
      }
      if (g.phase === "setup") {
        return [
          "Game setup is in progress, and the caller is usually answering the Game Master's last question — an answer counts as asking for the matching action.",
          "Describing the kind of adventure (genre, setting, tone, title) means game_configure; describing a character (a name, race, or class) means game_add_player; changing details of a hero who already joined means game_update_player; 'that's everyone' or 'let's start' means game_begin.",
          "Never start a new game while one is being set up unless the caller clearly asks for a different, brand-new game.",
        ];
      }
      return [
        "A game is being played: prefer the game tools for anything that happens in the story.",
        "When the caller says what their character does or tries, choose game_narrate; when they ask about stats, HP, gear, the scene, or the rules, choose game_answer.",
      ];
    },

    hiddenActions(persona) {
      if (!isGM(persona)) return [];
      // The game screen owns the workspace while a game exists; memories are curated separately.
      return getActiveGame(persona.id) ? HIDDEN_DURING_GAME : HIDDEN_WITHOUT_GAME;
    },

    replyStyle(persona) {
      if (!isGM(persona)) return null;
      const g = getActiveGame(persona.id);
      // Computed when the reply is written, so the question matches the game as it is NOW.
      const next = g ? setupView(g).next : null;
      if (next) {
        // One in-character reaction, then the setup question itself — appended verbatim so the
        // walk-through never stalls on a reply that forgot to ask it.
        return {
          maxWords: 24,
          maxSentences: 1,
          guidance:
            "You are the Game Master guiding game setup: vivid, warm and dramatic. React in ONE short sentence, in character, that names what just happened: the adventure by its name, or each new hero by name and class. Don't ask a question — the next setup question is added after your sentence.",
          append: next,
        };
      }
      return {
        maxWords: 34,
        maxSentences: 2,
        guidance: "You are the Game Master: vivid, warm and dramatic. React in character in one or two short sentences, using the details of what just happened.",
      };
    },

    // In-character talk ("I'm Thorin, a dwarf who hates elves") isn't a fact about the user.
    suppressCuration(persona) {
      return isGM(persona) && getActiveGame(persona.id) !== null;
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
