import { NEW_GAME_TITLE, settledNpcs } from "./store.js";
import type { Game, SetupStep, SetupView } from "./types.js";

/**
 * The guided setup flow the Game Master walks players through: choose the adventure →
 * assemble the party → begin. `setupView(game).next` is the next setup question, phrased for
 * the players: the game screen shows it, the GM asks it in character, and every game tool
 * appends it to its outcome ("Setup next: …") so each spoken confirmation also moves setup
 * forward.
 */

/** The adventure frame exists once the title was generated or a premise is set. */
export function isFramed(game: Game): boolean {
  return game.title.trim() !== NEW_GAME_TITLE || game.setting.trim() !== "";
}

export function realPlayers(game: Game) {
  return game.players.filter((p) => !p.pending);
}

export function setupView(game: Game): SetupView {
  const framed = isFramed(game);
  const party = realPlayers(game).length;
  const playing = game.phase === "playing";
  const partyWord = (game.theme.labels.party || "Party").toLowerCase();
  const steps: SetupStep[] = [
    { key: "adventure", label: "Choose the adventure", done: framed },
    { key: "party", label: `Assemble the ${partyWord}`, done: party > 0 },
    { key: "begin", label: "Begin the adventure", done: playing },
  ];
  let next: string | null = null;
  if (!playing) {
    if (!framed) next = "What kind of adventure shall we play? Pick a genre, a mood and a setting.";
    else if (party === 0) next = "Who's playing? Describe your hero: a name, a race and a class.";
    else next = "Anyone else joining? Describe your hero, or say “let's begin” when the party is ready.";
  }
  return { steps, next };
}

function heroSummary(p: Game["players"][number]): string {
  const what = [p.race, p.className].filter(Boolean).join(" ").toLowerCase() || "hero";
  const extra = p.conditions.length ? `, ${p.conditions.slice(0, 3).join(", ")}` : "";
  return `${p.name} (${what}, ${p.hp}/${p.maxHp} HP${extra})`;
}

/**
 * One compact paragraph about the game for Jev's page text and the reply writer:
 * title, genre, phase, round, party ("Thorin (dwarf fighter, 12/12 HP)"), scene, NPCs, setup next.
 */
export function describeGameForAgent(game: Game | null): string {
  if (!game) return "No game is running yet — the caller can ask to start a new one.";
  const parts: string[] = [];
  const framed = isFramed(game);
  parts.push(
    framed
      ? `Game: "${game.title}"${game.genre ? `, ${game.genre}` : ""}${game.tone ? ` (${game.tone})` : ""}.`
      : "Game: a new game whose adventure hasn't been chosen yet.",
  );
  parts.push(game.phase === "playing" ? `Phase: playing, round ${Math.max(1, game.round)}.` : "Phase: setup.");
  const heroes = realPlayers(game);
  const pending = game.players.length - heroes.length;
  const label = game.theme.labels.party || "Party";
  parts.push(
    heroes.length
      ? `${label} (${heroes.length}): ${heroes.map(heroSummary).join(", ")}.`
      : `${label}: nobody yet.`,
  );
  if (pending > 0) parts.push(`${pending} more hero${pending > 1 ? "es are" : " is"} being created.`);
  if (game.scene?.title) parts.push(`Scene: ${game.scene.title}.`);
  const npcs = settledNpcs(game);
  if (npcs.length) parts.push(`NPCs: ${npcs.slice(-6).map((n) => n.name).join(", ")}.`);
  if (game.lastRoll) {
    const r = game.lastRoll;
    parts.push(`Last roll: ${r.who ?? "the GM"} ${r.total}${r.label ? ` (${r.label})` : ""}.`);
  }
  const next = setupView(game).next;
  if (next) parts.push(`Setup next: ${next}`);
  return parts.join(" ");
}
