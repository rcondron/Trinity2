/*
 * A whole evening at the Game Master's table, scripted: three players on one microphone, driven through the real
 * tool functions, with every model call answered by a deterministic stub (global fetch is replaced: nothing leaves the
 * machine) and every die scripted.
 *
 *   TRINITY_DATA_DIR=<fresh folder> DOTENV_CONFIG_PATH=<empty file> MORDIEM_API_KEY=test node_modules/.bin/tsx scripts/test-game-session.mts
 *
 * Session zero with three players → begin → exploring, with a check the Game Master calls for and a roll made at the
 * table → a fight: initiative, a hit, a miss, a critical hit, a hero dropping to 0 and a death save, a potion, a
 * monster dying and leaving the order, speech out of turn, "whose turn", "repeat that", "undo", pause and resume, two
 * actions at once → the end of the fight with XP → the destructive tools and their yes → a short rest → the end of
 * the session, and the game loaded again with its recap.
 *
 * After every step it checks the game's state AND what was said, and that no number spoken disagrees with the state.
 * Prints one line per check and ends with "ALL PASSED" or "N FAILED" (exit code 1).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Nothing real is touched: a throwaway data folder, no .env, a fake key so the model paths run against the stub.
if (!process.env.TRINITY_DATA_DIR) process.env.TRINITY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "trinity-game-session-"));
if (!process.env.DOTENV_CONFIG_PATH) {
  const empty = path.join(process.env.TRINITY_DATA_DIR, "empty.env");
  writeFileSync(empty, "");
  process.env.DOTENV_CONFIG_PATH = empty;
}
process.env.MORDIEM_API_KEY ||= "test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = (p: string) => import(pathToFileURL(path.join(ROOT, "server/src", p)).href);

// ─── Checks ──────────────────────────────────────────────────────────────────

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`ok   - ${name}`);
  } else {
    failed++;
    console.log(`FAIL - ${name}${detail === undefined ? "" : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const has = (name: string, text: string, ...parts: string[]) => {
  const missing = parts.filter((p) => !text.includes(p));
  check(name, missing.length === 0, { missing, text });
};
const words = (s: string) => (s.match(/\S+/g) ?? []).length;

// ─── The model, stubbed ──────────────────────────────────────────────────────

type Reply = Record<string, unknown> | string | null;
const calls: { system: string; user: string }[] = [];
/** How the narrator behaves: "ok" answers, "fail" is an HTTP 500, "slow" never answers in time. */
let narrator: "ok" | "fail" | "slow" | "long" = "ok";
let narrations = 0;

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const HEROES: Record<string, Record<string, unknown>> = {
  thorin: {
    name: "Thorin", race: "Dwarf", className: "Fighter", stats: { str: 16, dex: 12, con: 16, int: 8, wis: 10, cha: 10 }, ac: 18, speed: 25,
    background: "Former mine warden", traits: ["Counts every step underground"], gold: 15,
    appearance: "A broad dwarf with a braided grey beard, soot-dark mail and a lantern at his belt",
    gear: [{ name: "Longsword", type: "weapon" }, { name: "Chain mail", type: "armor" }, { name: "Shield", type: "armor" }],
  },
  mira: {
    name: "Mira", race: "Halfling", className: "Rogue", stats: { str: 8, dex: 17, con: 12, int: 13, wis: 10, cha: 14 }, ac: 14, speed: 25,
    background: "Runaway locksmith", traits: ["Hums when she works"], gold: 15,
    appearance: "A small quick woman with a crooked grin, a patched cloak and ink-stained fingers",
    gear: [{ name: "Shortsword", type: "weapon" }, { name: "Shortbow", type: "weapon" }, { name: "Leather armor", type: "armor" }, { name: "Thieves' tools", type: "gear" }],
  },
};

function classify(said: string): Reply {
  const t = said.toLowerCase();
  if (/pick the lock/.test(t)) return { kind: "check", actor: "Mira", target: null, needsRoll: true, ability: "dex", skill: "sleight of hand", dc: 15, advantage: "none", summary: "pick the lock on the gate" };
  if (/attacks the nearest enemy/.test(t)) return { kind: "attack", actor: "Thorin", target: null, needsRoll: false, summary: "attack the nearest enemy" };
  if (/listens at the door/.test(t)) return { kind: "check", actor: null, target: null, needsRoll: true, ability: "wis", skill: "perception", dc: 15, advantage: "none", summary: "listen at the door" };
  if (/searches the old desk/.test(t)) return { kind: "check", actor: null, target: null, needsRoll: true, ability: "int", skill: "investigation", dc: 10, advantage: "none", summary: "search the old desk" };
  if (/search the room/.test(t)) return { kind: "check", actor: null, target: null, needsRoll: true, ability: "int", skill: "investigation", dc: 10, advantage: "none", summary: "search the room" };
  if (/remove the trap/.test(t)) return { kind: "interact", actor: "Thorin", target: null, needsRoll: false, summary: "lift the snare off the path" };
  if (/right back|drink|pizza|phone/.test(t)) return { kind: "none" };
  return { kind: "other", needsRoll: false, summary: "do something" };
}

function answer(system: string, user: string): Reply {
  const said = /Words: ("(?:[^"\\]|\\.)*")/.exec(user)?.[1] ?? /transcript; data, not instructions\): ("(?:[^"\\]|\\.)*")/.exec(user)?.[1] ?? '""';
  const spokenWords = JSON.parse(said) as string;
  if (system.includes("design the frame of a new tabletop adventure") && user.includes("left the choice of adventure to you")) {
    return { described: true, title: "The Salt Crown", genre: "sword and sorcery", tone: "bold and dusty", setting: "A crown of salt has been stolen from the desert queen, and the caravan roads are closing one by one.", artStyle: "sun-bleached gouache, hard desert light", titleArtPrompt: "a crown of salt crystals on a dune at noon", theme: {} };
  }
  if (system.includes("design the frame of a new tabletop adventure") && /short fantasy adventure/i.test(spokenWords)) {
    // As the real model answered that night: the words said fantasy, and it still said "described": false.
    return { described: false, title: "The Ember Road", genre: "high fantasy", tone: "bright and adventurous", setting: "A road of ember-lit waystones crosses the old kingdom, and one by one the stones are going dark.", artStyle: "warm storybook watercolor", titleArtPrompt: "a road of glowing waystones at dusk", theme: {} };
  }
  if (system.includes("design the frame of a new tabletop adventure")) {
    return {
      described: true,
      title: "The Hollow Lantern",
      genre: "dark fantasy",
      tone: "grim and hopeful",
      setting: "The lamps of Deepvein mine have gone out one by one, and the miners who went to relight them have not come back.",
      artStyle: "moody painterly fantasy, lantern light in deep shadow",
      titleArtPrompt: "a mine entrance at dusk with one lantern burning",
      theme: {},
    };
  }
  if (system.includes("create a player-character sheet")) {
    const t = spokenWords.toLowerCase();
    return { characters: Object.entries(HEROES).filter(([k]) => t.includes(k)).map(([, v]) => v) };
  }
  if (system.includes("write the OPENING scene")) {
    return {
      title: "The Mouth of Deepvein",
      locationName: "Deepvein Mine",
      description: "You stand before the mouth of Deepvein mine as the last daylight drains from the hills. One lantern still burns above the gate, and its flame leans toward the dark as if something inside were breathing in.",
      summary: "The mine entrance, one lantern still lit",
      imagePrompt: "a mine entrance in dusk light, one lantern burning above an iron gate",
    };
  }
  if (system.includes("set the scene the Game Master just described")) {
    return { title: "The Lower Gallery", locationName: "Lower Gallery", description: "You step into a long gallery where the timbers drip and every lamp bracket hangs empty.", summary: "A dripping gallery of empty lamp brackets", imagePrompt: "a dripping mine gallery with empty lamp brackets" };
  }
  if (system.includes("planning a short tabletop adventure")) {
    return {
      outline: ["The heroes reach the mine and find the gate locked from inside.", "Goblins are stealing the lamp oil for something below.", "In the deepest gallery the thing that drinks light is waiting."],
      secrets: ["The mine foreman sealed the lowest gallery himself."],
      clues: ["A foreman's key lies in the dust by the gate, snapped in half."],
      quest: { title: "Relight the lamps of Deepvein", detail: "Find out why the mine went dark and bring the miners home." },
      threats: ["goblin", "giant rat", "shadow"],
    };
  }
  if (system.includes("intake clerk")) return classify(spokenWords);
  if (system.includes("narrating one beat")) {
    narrations++;
    if (narrator === "fail") return "HTTP500";
    if (narrator === "slow") return "SLOW";
    // A narrator that runs long: three sentences, as many words as the budget allows and then some.
    if (narrator === "long") return { narration: "Dust lifts from the old wood in a slow grey breath as the lid gives way. Something small glints in the dark beneath a fold of rotten cloth, cold and patient. Far below, a sound like a held breath answers.", clue: null };
    return { narration: "Steel rings in the dark and the lantern light shivers.", clue: null };
  }
  if (system.includes("running summary")) return { summary: "The heroes came to Deepvein mine, opened its gate and fought off goblins who were stealing lamp oil." };
  if (system.includes("create the item(s)")) {
    return { items: [{ name: "Potion of Healing", type: "potion", rarity: "common", description: "A red liquid that glimmers when shaken.", properties: ["heals 2d4+2"], appearance: "a small red vial" }], gold: 0 };
  }
  return {};
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/images/generations")) return jsonResponse({ data: [{ b64_json: TINY_PNG }] });
  if (!url.endsWith("/chat/completions")) return new Response("not stubbed", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
  const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  calls.push({ system, user });
  const reply = answer(system, user);
  if (reply === "HTTP500") return new Response("the model fell over", { status: 500 });
  if (reply === "SLOW") {
    // Never answers: resolves only when the caller gives up.
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }
  const content = reply === null ? "" : typeof reply === "string" ? reply : JSON.stringify(reply);
  return jsonResponse({ choices: [{ message: { content }, finish_reason: "stop" }] });
}) as typeof fetch;

// ─── The engine under test ───────────────────────────────────────────────────

const R = await load("game/rules.ts");
const store = await load("game/store.ts");
const kit = await load("game/kit.ts");
const { registerGameTools } = await load("game/tools.ts");
const { registerStoryTools } = await load("game/story-tools.ts");
const integration = await load("game/integration.ts");
const adjudicate = await load("game/adjudicate.ts");
const { toView } = await load("game/view.ts");
const { getTool } = await load("tools/registry.ts");
const { contextFor } = await load("agent/context.ts");

registerGameTools();
registerStoryTools();
integration.registerGameContext();

const persona = {
  id: "game-master",
  name: "The Game Master",
  description:
    "You are the Game Master running a tabletop role-playing game for the players. Narrate tight, cinematic scenes, voice characters with distinct personalities, and hand agency back to the players.",
  voicePrompt: "You are the Game Master.",
  voice: "NATM1",
  toolsets: ["game"],
  traits: { role: "tabletop game master" },
  updatedAt: Date.now(),
};

type Result = { ok: boolean; say?: string; speak?: string; data?: Record<string, unknown> };
type AnyGame = Record<string, any>;

/** Run a tool as the router would: the finished sentence, no arguments but those given. */
async function run(tool: string, utterance: string, args: Record<string, unknown> = {}): Promise<Result> {
  const t = getTool(tool);
  if (!t) throw new Error(`no tool ${tool}`);
  return t.run(args, { persona, recentTranscript: [], emit: () => {}, utterance, memory: {} as never, situation: "" }) as Promise<Result>;
}
const game = (): AnyGame => store.getActiveGame(persona.id);
const hero = (name: string): AnyGame => game().players.find((p: AnyGame) => p.name === name);
const npc = (name: string): AnyGame => game().npcs.find((n: AnyGame) => n.name === name);
const said = (r: Result) => (r.speak ?? "").trim();

/** Script the dice for the next step; afterwards they must all have been rolled, in that order. */
function rollsWillBe(...values: number[]): { used: (name: string) => void } {
  const rng = R.scriptedRng(values);
  kit.setGameRng(rng);
  return { used: (name: string) => eq(`${name}: every scripted die was rolled, and no other`, rng.left(), 0) };
}
const noDice = () => kit.setGameRng(R.scriptedRng([]));

/** What matters about a game for "nothing changed": everything but art, the log and timestamps. */
function core(g: AnyGame): string {
  return JSON.stringify({
    phase: g.phase,
    mode: g.mode,
    spotlight: g.spotlightId,
    combat: g.combat,
    pending: g.pending,
    turn: g.story.turn,
    gold: g.partyGold,
    players: g.players.map((p: AnyGame) => [p.name, p.hp, p.maxHp, p.tempHp, p.ac, p.xp, p.gold, p.level, p.conditions, p.deathSaves, p.dead, p.stable, p.inventory.length, p.slotsUsed, p.equipped]),
    npcs: g.npcs.map((n: AnyGame) => [n.name, n.hp, n.status, n.attitude, n.conditions]),
    items: g.items.map((i: AnyGame) => [i.name, i.ownerId, i.quantity]),
  });
}

/**
 * No number said may disagree with the state: every "A plus B is C" must add up, a hero's "N hit points left" or "at
 * N of M" must be their sheet, and an "armor class N" after "attacks X" must be X's.
 */
function numbersAgree(step: string, text: string, g: AnyGame | null = game()): void {
  const problems: string[] = [];
  for (const m of text.matchAll(/\b(\d+(?: (?:plus|minus) \d+)+) is (\d+)\b/g)) {
    const parts = m[1]!.split(" ");
    let sum = Number(parts[0]);
    for (let i = 1; i < parts.length; i += 2) sum += (parts[i] === "plus" ? 1 : -1) * Number(parts[i + 1]);
    if (sum !== Number(m[2])) problems.push(m[0]);
  }
  if (g) {
    for (const p of g.players as AnyGame[]) {
      const left = new RegExp(`${p.name} has (\\d+) hit points? left`).exec(text);
      if (left && Number(left[1]) !== p.hp) problems.push(`${left[0]} (sheet: ${p.hp})`);
      const at = [...text.matchAll(new RegExp(`${p.name} [^.]*?is at (\\d+) of (\\d+)`, "g"))].pop();
      if (at && (Number(at[1]) !== p.hp || Number(at[2]) !== p.maxHp)) problems.push(`${at[0]} (sheet: ${p.hp}/${p.maxHp})`);
      const drop = new RegExp(`${p.name} drops to 0 hit points`).test(text);
      if (drop && p.hp !== 0) problems.push(`${p.name} said to be at 0 (sheet: ${p.hp})`);
      const ac = new RegExp(`attacks ${p.name}: (\\d+) against armor class (\\d+)`).exec(text);
      if (ac && Number(ac[2]) !== p.ac) problems.push(`${ac[0]} (sheet: AC ${p.ac})`);
    }
    for (const n of g.npcs as AnyGame[]) {
      const ref = n.name.toLowerCase();
      const ac = new RegExp(`attacks (?:the )?${ref} [^:]*: [^.]*?against armor class (\\d+)`).exec(text) ?? new RegExp(`at (?:the )?${ref}: [^.]*?against armor class (\\d+)`).exec(text);
      if (ac && Number(ac[1]) !== n.ac) problems.push(`${ac[0]} (stat block: AC ${n.ac})`);
      if (new RegExp(`${ref} is defeated`, "i").test(text) && n.status !== "defeated") problems.push(`${n.name} said defeated (status: ${n.status})`);
    }
    if (/\d+ hit points?\b/.test(text)) {
      for (const n of g.npcs as AnyGame[]) if (new RegExp(`${n.name}[^.]*\\b${n.hp} hit points`, "i").test(text) && n.status === "alive") problems.push(`${n.name}'s hit points were said aloud`);
    }
  }
  check(`${step}: no spoken number disagrees with the state`, problems.length === 0, problems);
}

/** A step: run the tool, check the spoken numbers, return the line. */
async function step(name: string, tool: string, utterance: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await run(tool, utterance, args);
  const line = said(r);
  if (process.env.SHOW) console.log(`\n   > ${tool}: "${utterance}"\n   < ${line}  [${words(line)} words]`);
  check(`${name}: the tool answers with a line to speak verbatim`, r.ok === true && typeof r.speak === "string", r);
  numbersAgree(name, line);
  return line;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

// ═══ Session zero ════════════════════════════════════════════════════════════

noDice();
{
  const nothing = await run("game_roll", "roll a d20");
  has("no game yet: the Game Master says so", said(nothing), "no game");

  const line = await step("new game", "game_new", "Let's play a dark fantasy adventure about a haunted mine");
  const g = game();
  eq("new game: created, framed, in setup", [g.title, g.genre, g.phase, g.players.length], ["The Hollow Lantern", "dark fantasy", "setup", 0]);
  has("new game: names the adventure, then asks ONE question — how many players", line, "The Hollow Lantern", "How many players are at the table?");
  eq("new game: exactly one question", (line.match(/\?/g) ?? []).length, 1);

  const count = await step("player count", "game_setup", "There are three of us");
  eq("player count: three expected", game().settings.expectedPlayers, 3);
  has("player count: asks the first player's name", count, "Player one, what's your name?");

  const ryan = await step("player one's name", "game_add_player", "I'm Ryan");
  eq("player one's name: kept for the seat, no hero invented", [game().setupState.seatName, game().players.length], ["Ryan", 0]);
  has("player one's name: asks for the hero and offers ready-made ones", ryan, "Welcome.", "Describe your hero, Ryan", "the human fighter", "the elf wizard");

  const thorin = await step("hero from a description", "game_add_player", "Thorin, a dwarf fighter");
  const t = hero("Thorin");
  eq("hero from a description: Thorin's sheet", [t.playerName, t.race, t.className, t.maxHp, t.hp, t.ac, t.hitDie, t.saveProficiencies], ["Ryan", "Dwarf", "Fighter", 13, 13, 18, 10, ["str", "con"]]);
  eq("hero from a description: gear is put on (armor class follows the chain mail and shield)", [Boolean(t.equipped.weapon), Boolean(t.equipped.armor), Boolean(t.equipped.shield)], [true, true, true]);
  has("hero from a description: says who joined with the numbers on the sheet, then asks player two", thorin, "Thorin the dwarf fighter joins, played by Ryan", "13 hit points", "armor class 18", "Player two, what's your name?");
  check("hero from a description: the last question isn't repeated", !/describe your hero/i.test(thorin));

  const lyra = await step("ready-made hero", "game_add_player", "I'm Ana and I'll take the elf wizard, call her Lyra");
  const l = hero("Lyra");
  eq("ready-made hero: an elf wizard from the SRD, played by Ana", [l.playerName, l.race, l.className, l.maxHp, l.ac, l.castingAbility, l.slotsMax[0], l.spells.includes("fire bolt")], ["Ana", "Elf", "Wizard", 8, 12, "int", 2, true]);
  has("ready-made hero: announced with her numbers", lyra, "Lyra the elf wizard joins, played by Ana", "8 hit points", "armor class 12", "Player three");

  const nobody = await step("no hero described", "game_add_player", "Okay, I want to play too");
  eq("no hero described: nobody is invented", game().players.length, 2);
  check("no hero described: the Game Master asks instead", /name/i.test(nobody), nobody);

  const mira = await step("name and hero in one breath", "game_add_player", "I'm Sam. I'll play Mira, a halfling rogue");
  const m = hero("Mira");
  eq("name and hero in one breath: Mira, played by Sam (Sam is not a hero)", [game().players.map((p: AnyGame) => p.name), m.playerName, m.maxHp, m.ac, m.skillProficiencies.includes("sleight of hand")], [["Thorin", "Lyra", "Mira"], "Sam", 9, 14, true]);
  has("name and hero in one breath: the party is full, so the next question is about tone", mira, "Mira the halfling rogue joins, played by Sam", "What tone do you want");

  const tone = await step("tone and lines", "game_setup", "Heroic, and no spiders please");
  eq("tone and lines: recorded", [game().tone, game().settings.avoid], ["heroic", ["spiders"]]);
  has("tone and lines: confirmed, then difficulty", tone, "spiders", "How tough should the fights be");

  const diff = await step("difficulty", "game_setup", "standard");
  eq("difficulty: standard", game().settings.difficulty, "standard");
  has("difficulty: then leveling", diff, "experience points, or at story milestones");

  const lvl = await step("leveling", "game_setup", "experience points");
  eq("leveling: by XP", game().settings.leveling, "xp");
  has("leveling: setup is complete", lvl, "Say let's begin");

  const questions = [line, count, ryan, thorin, lyra, mira, tone, diff, lvl].map((s) => s.split(/(?<=[.?!])\s+/).pop());
  eq("session zero: no reply ends with the same sentence as another", new Set(questions).size, questions.length);
  check("session zero: one question at a time", [line, count, thorin, lyra, mira, tone, diff, lvl].every((s) => (s.match(/\?/g) ?? []).length <= 1));

  const notYet = await step("'before we begin…'", "game_begin", "Before we begin, can I change my name?");
  eq("'before we begin…': the game does not begin", game().phase, "setup");
  check("'before we begin…': and isn't told it has", !/adventure begin/i.test(notYet), notYet);

  const begin = await step("begin", "game_begin", "Okay, let's begin");
  const b = game();
  eq("begin: playing, exploring, Thorin holds the spotlight, a quest is open", [b.phase, b.mode, b.spotlightId === hero("Thorin").id, b.story.quests.length >= 1, b.scene?.title], ["playing", "explore", true, true, "The Mouth of Deepvein"]);
  has("begin: the opening scene, then the first hero by name", begin, "Let the adventure begin.", "Deepvein mine", "Thorin, you're first. What do you do?");
  check("begin: an opening of at most ninety words", words(begin) <= 90, words(begin));
  check("begin: the Game Master's plan arrives (outline, a clue, the quest)", await until(() => game().story.clues.length > 0 && game().story.quests[0]?.title === "Relight the lamps of Deepvein"), game().story);
  check("begin: the persona's own brief reaches the scene prompt", calls.some((c) => c.system.includes("write the OPENING scene") && c.system.includes("Narrate tight, cinematic scenes")));
}

// ═══ Table talk ══════════════════════════════════════════════════════════════

{
  const before = core(game());
  const chatter = ["I'll be right back, I need a drink", "Hang on, my phone is ringing", "lol nice one", "Pass the chips", "Did you see the game last night?", "okay", "Hmm"];
  for (const line of chatter) {
    eq(`table talk: "${line}" is no action by any pattern`, adjudicate.fastIntent(line, game())?.kind ?? "none", "none");
  }
  const r = await run("game_narrate", "I'll be right back, I need a drink");
  eq("table talk reaching the action tool: nothing is said", said(r), "");
  eq("table talk reaching the action tool: nothing changes", core(game()), before);
  eq("table talk reaching the dice tool: nothing changes", [said(await run("game_roll", "lol nice one")), core(game())], ["", before]);
  const talk = contextFor(persona).talk;
  check("the talk hook tells the talking brain to stay silent for chatter between players", /SILENT/.test(talk.guidance ?? "") && /between players/.test(talk.guidance ?? ""), talk.guidance);
  check("the talk hook forbids inventing outcomes and names whose turn it is", /Never invent dice results/.test(talk.guidance ?? "") && /one question at a time/i.test(talk.guidance ?? "") && (talk.guidance ?? "").includes("Thorin"), talk.guidance);
  const voice = contextFor(persona).voice;
  eq("the voice hook: a longer pause, a slower pace, a later filler", [voice.endpointingMs, voice.pace, voice.fillerAfterMs], [1100, 0.92, 1800]);
  check("the voice hook: heroes, players and places as key terms; in-world fillers", ["Thorin", "Ryan", "Lyra", "Ana", "Mira", "Sam", "Deepvein Mine"].every((k) => voice.keyterms?.includes(k)) && (voice.keyterms?.length ?? 99) <= 50 && (voice.fillers?.length ?? 0) >= 3, voice);
  const hidden = contextFor(persona).hiddenActions;
  eq("during a game undo_workspace is hidden and set_speech_rate is not", [hidden.has("undo_workspace"), hidden.has("set_speech_rate")], [true, false]);
}

// ═══ Exploring: a called check, a roll made at the table ═════════════════════

{
  noDice();
  const call = await step("a check is called for", "game_narrate", "Mira tries to pick the lock on the gate");
  const g = game();
  eq("a check is called for: the Game Master waits for Mira's roll", [g.pending.check?.heroId === hero("Mira").id, g.pending.check?.skill, g.pending.check?.dc, g.story.turn], [true, "sleight of hand", 15, 0]);
  has("a check is called for: by name, one request", call, "Mira, give me a Sleight of Hand check", "roll for me");
  eq("a check is called for: the board shows the banner", toView(g).pendingCheck?.text, "Mira: Sleight of Hand check, DC 15");

  const interrupt = await step("someone else moves first", "game_narrate", "Thorin kicks the gate");
  has("someone else moves first: Thorin's move is played, and Mira's roll keeps waiting", interrupt, "Steel rings in the dark", "Mira, your sleight of hand check is still waiting: tell me the roll, or say roll for me.");
  eq("someone else moves first: nothing was rolled for Mira, the spotlight is back with her, Thorin's move counts", [game().pending.check?.heroId === hero("Mira").id, game().pending.check?.reminders, game().spotlightId === hero("Mira").id, game().story.turn], [true, 0, true, 1]);

  const rolled = await step("a roll made at the table", "game_roll", "I rolled a fourteen");
  const after = game();
  has("a roll made at the table: the die, the bonus, the total, the DC, the verdict", rolled, "Mira's Sleight of Hand check: 14 plus 5 is 19 against DC 15. Success.");
  has("a roll made at the table: then narration, then the next hero by name", rolled, "Steel rings in the dark", "Thorin, what do you do?");
  check("a roll made at the table: result first, narration second, prompt last", rolled.indexOf("Success.") < rolled.indexOf("Steel rings") && rolled.indexOf("Steel rings") < rolled.indexOf("Thorin, what"));
  eq("a roll made at the table: on the board", [after.lastRoll.total, after.lastRoll.natural, after.lastRoll.dc, after.lastRoll.outcome, after.lastRoll.who], [19, 14, 15, "success", "Mira"]);
  eq("a roll made at the table: nothing pending, the spotlight moves on, a story turn is counted", [after.pending.check, after.spotlightId === hero("Thorin").id, after.story.turn], [null, true, 2]);
  check("a roll made at the table: under forty-five words", words(rolled) <= 45, words(rolled));

  const loot = await step("loot", "game_add_item", "Mira finds a potion of healing");
  const potion = game().items.find((i: AnyGame) => i.name === "Potion of Healing");
  eq("loot: the potion is Mira's", [potion?.ownerId === hero("Mira").id, hero("Mira").inventory.includes(potion?.id), potion?.value], [true, true, 50]);
  has("loot: said plainly", loot, "Mira gets the potion of healing");
}

// ═══ The fight ═══════════════════════════════════════════════════════════════

{
  // Initiative: Thorin 10+1, Lyra 5+2, Mira 18+3, goblin 1 13+2, goblin 2 2+2.
  let d = rollsWillBe(10, 5, 18, 13, 2);
  const start = await step("initiative", "game_start_combat", "Two goblins attack!");
  d.used("initiative");
  let g = game();
  const order = () => game().combat.order.map((c: AnyGame) => (c.kind === "hero" ? game().players.find((p: AnyGame) => p.id === c.id).name : game().npcs.find((n: AnyGame) => n.id === c.id).name));
  eq("initiative: two goblins with their SRD stat blocks", g.npcs.map((n: AnyGame) => [n.name, n.hp, n.ac, n.xp, n.attacks[0].toHit, n.attacks[0].damage]), [["Goblin 1", 7, 15, 50, 4, "1d6+2"], ["Goblin 2", 7, 15, 50, 4, "1d6+2"]]);
  eq("initiative: rolled in code, highest first", [order(), g.combat.order.map((c: AnyGame) => c.init), g.combat.round, g.mode], [["Mira", "Goblin 1", "Thorin", "Lyra", "Goblin 2"], [21, 15, 11, 7, 4], 1, "combat"]);
  has("initiative: the order is said, then who is up", start, "2 goblins attack", "The order is Mira, goblin 1, Thorin, Lyra, then goblin 2", "Mira, you're up.");
  eq("initiative: the board shows the strip and whose turn it is", [toView(g).combat.order.map((c: AnyGame) => c.name), toView(g).combat.order.find((c: AnyGame) => c.current).name, toView(g).turn], [["Mira", "Goblin 1", "Thorin", "Lyra", "Goblin 2"], "Mira", { kind: "turn", id: hero("Mira").id, name: "Mira", playerName: "Sam", isHero: true }]);

  // Mira: d20 15 (+5 = 20, a hit), d6 4 (+3 = 7): goblin 1 has 7 hit points.
  d = rollsWillBe(15, 4);
  const hit = await step("a hit that kills", "game_narrate", "I attack goblin one with my shortsword");
  d.used("a hit that kills");
  g = game();
  has("a hit that kills: who, with what, the sum, the armor class, the damage, the result", hit, "Mira attacks goblin 1 with the shortsword: 15 plus 5 is 20 against armor class 15, a hit for 7 piercing damage.", "Goblin 1 is defeated.");
  has("a hit that kills: ends by naming who is next", hit, "Thorin, you're up.");
  check("a hit that kills: one sentence of narration between the result and the next turn", hit.indexOf("defeated.") < hit.indexOf("Steel rings") && hit.indexOf("Steel rings") < hit.indexOf("Thorin, you're up."), hit);
  eq("a hit that kills: the goblin is defeated, out of the order, its XP banked", [npc("Goblin 1").status, npc("Goblin 1").hp, order(), g.combat.xpEarned], ["defeated", 0, ["Mira", "Thorin", "Lyra", "Goblin 2"], 50]);
  eq("a hit that kills: marked on the board, health shown as a band", [toView(g).npcs.map((n: AnyGame) => [n.name, n.status, n.health]), "hp" in toView(g).npcs[0]], [[["Goblin 1", "defeated", "down"], ["Goblin 2", "alive", "healthy"]], false]);
  eq("a hit that kills: it is Thorin's turn", toView(g).turn.name, "Thorin");

  // Thorin: d20 4 (+5 = 9), a miss. The narrator fails: the code-built line is spoken alone.
  narrator = "fail";
  d = rollsWillBe(4);
  const miss = await step("a miss, with the narrator down", "game_narrate", "I swing at the goblin");
  d.used("a miss, with the narrator down");
  narrator = "ok";
  eq("a miss, with the narrator down: exactly the line built in code", miss, "Thorin attacks goblin 2 with the longsword: 4 plus 5 is 9 against armor class 15, a miss. Lyra, you're up.");
  eq("a miss: the goblin is unhurt and it is Lyra's turn", [npc("Goblin 2").hp, toView(game()).turn.name], [7, "Lyra"]);

  // Out of turn.
  noDice();
  const before = core(game());
  const depth = store.historyDepth(game().id);
  const early = await step("speech out of turn", "game_narrate", "Thorin attacks the goblin again");
  eq("speech out of turn: told whose turn it is and when theirs comes", early, "It's Lyra's turn. Thorin, you're after Mira.");
  eq("speech out of turn: nothing changes, nothing to undo", [core(game()), store.historyDepth(game().id)], [before, depth]);

  const whose = await step("whose turn", "game_answer", "Wait, whose turn is it?");
  has("whose turn: from the state", whose, "It's Lyra's turn, played by Ana, round 1", "Then goblin 2");
  const hp = await step("a sheet lookup", "game_answer", "What's Thorin's HP?");
  eq("a sheet lookup: answered from the sheet", hp, "Thorin has 13 of 13 hit points.");
  const rule = await step("a rules question", "game_answer", "How does grappling work?");
  has("a rules question: the SRD summary, not an invention", rule, "grapple", "Strength or Dexterity save");
  const band = await step("how hurt is the goblin", "game_answer", "How hurt is goblin two?");
  eq("how hurt is the goblin: a band, never a number", band, "Goblin 2 looks healthy.");
  eq("questions change nothing", core(game()), before);

  // Lyra: fire bolt, d20 16 (+4 = 20) hits for d10 3. Goblin 2 turns on her: natural 20, dice doubled: 5 + 4 + 2 = 11.
  d = rollsWillBe(16, 3, 20, 5, 4);
  const bolt = await step("a spell, then the monster's critical hit", "game_narrate", "I cast fire bolt at the goblin");
  d.used("a spell, then the monster's critical hit");
  g = game();
  has("a spell: the spell attack as rolled", bolt, "Lyra casts fire bolt at goblin 2: 16 plus 4 is 20 against armor class 15, a hit for 3 fire damage.");
  has("the monster's turn: resolved by the same engine, a natural 20 doubles the dice not the modifier", bolt, "Goblin 2 attacks Lyra: a natural 20, a critical hit for 11 slashing damage.", "Lyra drops to 0 hit points and falls unconscious.");
  has("the monster's turn: then the next round's first hero", bolt, "Mira, you're up.");
  eq("a hero at 0: unconscious, dying, not dead", [hero("Lyra").hp, hero("Lyra").conditions, hero("Lyra").deathSaves, hero("Lyra").dead, npc("Goblin 2").hp, g.combat.round], [0, ["unconscious"], { successes: 0, failures: 0 }, false, 4, 2]);
  eq("the critical hit on the board: natural 20, ribbon, against her armor class", [g.lastRoll.natural, g.lastRoll.outcome, g.lastRoll.dc, g.lastRoll.who], [20, "crit", 12, "Goblin 2"]);
  eq("the monster chose the hero who had just hurt it", g.combat.order.find((c: AnyGame) => c.kind === "npc").lastTargetId, hero("Lyra").id);

  noDice();
  const again = await step("repeat that", "game_answer", "Sorry, can you repeat that?");
  eq("repeat that: the same line, word for word", again, bolt);

  // Mira misses: d20 2 (+5 = 7). Then it is undone.
  const snapshot = core(game());
  d = rollsWillBe(2);
  const whiff = await step("a turn to undo", "game_narrate", "I stab goblin two");
  d.used("a turn to undo");
  has("a turn to undo: Mira misses and Thorin is up", whiff, "2 plus 5 is 7 against armor class 15, a miss", "Thorin, you're up.");
  noDice();
  const undo = await step("undo", "game_undo", "Undo that");
  has("undo: says what was undone and whose turn it is again", undo, "Undone: Mira's action, I stab goblin two.", "It's Mira's turn");
  eq("undo: the game is exactly as it was before the turn", core(game()), snapshot);

  // Two actions said in one breath: the second waits for the first, and is taken by whoever is then on turn.
  // Mira: d20 6 (+5 = 11), a miss. Thorin: d20 9 (+5 = 14), a miss. Then Lyra, at 0, is asked for a death save.
  d = rollsWillBe(6, 9);
  const first = run("game_narrate", "I attack goblin two");
  const second = run("game_narrate", "I attack the goblin");
  const [a, b] = [said(await first), said(await second)];
  d.used("two actions at once");
  has("two actions at once: the first is Mira's", a, "Mira attacks goblin 2", "6 plus 5 is 11", "a miss", "Thorin, you're up.");
  has("two actions at once: the second waited, and is Thorin's turn as the first left it", b, "Thorin attacks goblin 2", "9 plus 5 is 14", "a miss");
  numbersAgree("two actions at once", `${a} ${b}`);
  has("a dying hero's turn: the Game Master calls for a death save", b, "Lyra, you're down: give me a death saving throw");
  eq("a dying hero's turn: waiting on Lyra", [game().pending.check?.kind, game().pending.check?.heroId === hero("Lyra").id, toView(game()).pendingCheck?.text], ["death", true, "Lyra: Death save, DC 10"]);

  // "Roll for me": d20 8, a failure. Goblin 2 then attacks Thorin (in melee with it): d20 5 (+4 = 9), a miss.
  d = rollsWillBe(8, 5);
  const save = await step("a death save, rolled for her", "game_roll", "Roll for me");
  d.used("a death save, rolled for her");
  has("a death save: the die and the tally", save, "Lyra's death save: 8, a failure. That is 0 successes and 1 failure.");
  has("a death save: play runs on through the goblin to the next hero", save, "Goblin 2 attacks Thorin: 9 against armor class 18, a miss.", "Mira, you're up.");
  eq("a death save: one failure, still dying, round 3", [hero("Lyra").deathSaves, hero("Lyra").hp, game().combat.round, game().pending.check], [{ successes: 0, failures: 1 }, 0, 3, null]);
  eq("death-save pips reach the board", toView(game()).players.find((p: AnyGame) => p.name === "Lyra").deathSaves, { successes: 0, failures: 1 });

  // Pause: "pause the game" pauses even when the router calls it a new game.
  noDice();
  const games = store.listGames(persona.id).length;
  const pause = await step("'pause the game' sent to game_new", "game_new", "Pause the game");
  eq("'pause the game': it pauses; no new game is made", [game().phase, game().mode, store.listGames(persona.id).length, game().title], ["paused", "paused", games, "The Hollow Lantern"]);
  has("'pause the game': says so", pause, "Paused");
  const frozen = core(game());
  const ignored = await step("an action while paused", "game_narrate", "I attack goblin two");
  eq("an action while paused: nothing happens", [ignored, core(game())], ["The game is paused. Say resume when you're ready to go on.", frozen]);
  const resume = await step("resume", "game_pause", "Okay, we're back");
  eq("resume: playing again, the fight intact", [game().phase, game().mode, game().combat.round], ["playing", "combat", 3]);
  has("resume: says where things stand and whose turn it is", resume, "We're back", "It's Mira's turn");

  // The potion: 2d4+2 with a 3 and a 2 is 7. A bonus action: Mira keeps her action.
  d = rollsWillBe(3, 2);
  const drink = await step("a potion for the fallen", "game_use_item", "I pour my potion of healing into Lyra's mouth");
  d.used("a potion for the fallen");
  has("a potion for the fallen: healed through the rules", drink, "Mira gives Lyra the potion of healing: 3 plus 2 plus 2 is 7.", "Lyra regains 7 hit points and is conscious again, at 7.", "Mira, you still have your action.");
  eq("a potion for the fallen: Lyra is up, her death saves cleared", [hero("Lyra").hp, hero("Lyra").conditions, hero("Lyra").deathSaves], [7, [], { successes: 0, failures: 0 }]);
  eq("a potion for the fallen: the spent potion leaves the sheet", [game().items.some((i: AnyGame) => i.name === "Potion of Healing"), hero("Mira").inventory.length], [false, 4]);
  eq("a potion for the fallen: it is still Mira's turn, her bonus action spent", [toView(game()).turn.name, game().combat.bonusUsed], ["Mira", true]);
  noDice();
  const twice = await step("a second bonus action", "game_use_item", "I drink my thieves' tools");
  has("a second bonus action: refused", twice, "already used a bonus action");

  // Mira: a natural 20. Dice doubled: 2 + 5 + 3 = 10. Goblin 2 (4 left) falls; treasure: 3 + 4 gold, d20 5 = no potion.
  d = rollsWillBe(20, 2, 5, 3, 4, 5);
  const crit = await step("a critical hit ends the fight", "game_narrate", "I attack goblin two");
  d.used("a critical hit ends the fight");
  g = game();
  has("a critical hit: said as one, with the doubled dice", crit, "Mira attacks goblin 2 with the shortsword: a natural 20, a critical hit for 10 piercing damage.", "Goblin 2 is defeated.");
  has("the end of the fight: XP for what was overcome, shared out", crit, "The fight is over.", "Each of you earns 33 experience points.");
  has("the end of the fight: loot, then the scene goes on with the next hero", crit, "7 gold", "Thorin, what do you do?");
  eq("the end of the fight: back to exploring, XP on every sheet, gold in the purse", [g.combat, g.mode, g.players.map((p: AnyGame) => p.xp), g.partyGold, g.spotlightId === hero("Thorin").id], [null, "explore", [33, 33, 33], 7, true]);
  eq("the end of the fight: both goblins defeated and marked so on the board", toView(g).npcs.map((n: AnyGame) => [n.status, n.health, n.inCombat]), [["defeated", "down", false], ["defeated", "down", false]]);
  eq("the end of the fight: the crit ribbon's data", [g.lastRoll.natural, g.lastRoll.outcome], [20, "crit"]);
}

// ═══ Who is doing that? ══════════════════════════════════════════════════════

{
  // Nobody holds the spotlight (as after a defeat): an action with no name in it can't be placed.
  await store.mutateGame(game().id, (d: AnyGame) => {
    d.spotlightId = null;
  });
  noDice();
  const who = await step("an action nobody can be placed for", "game_narrate", "search the room");
  eq("…: the Game Master asks, and keeps the action", [who, game().pending.action?.words, game().pending.action?.tool], ["Who is doing that?", "search the room", "game_narrate"]);
  const named = await step("the bare answer", "game_narrate", "Thorin");
  has("the bare answer completes the action: Thorin's check is called for", named, "Thorin, give me an Investigation check");
  eq("the bare answer: the question is settled, a roll is awaited", [game().pending.action, game().pending.check?.heroId === hero("Thorin").id, game().pending.check?.dc], [null, true, 10]);
  // "Roll for me": d20 12, Investigation with Intelligence 8 is 12 minus 1.
  const d = rollsWillBe(12);
  const rolled = await step("roll for me", "game_roll", "Just roll it for me");
  d.used("roll for me");
  has("roll for me: rolled in code, with the hero's own modifier", rolled, "Thorin's Investigation check: 12 minus 1 is 11 against DC 10. Success.", "Lyra, what do you do?");
}

// ═══ The destructive tools need their yes ════════════════════════════════════

{
  noDice();
  const id = game().id;
  const games = store.listGames(persona.id).length;
  const ask = await step("a new game over one in play", "game_new", "Let's start a new game about pirates");
  eq("a new game over one in play: it asks first; nothing is created", [game().id, store.listGames(persona.id).length, game().pending.confirm?.kind], [id, games, "new_game"]);
  has("a new game over one in play: a yes-or-no question", ask, "Start a new game and set The Hollow Lantern aside?", "Say yes or no.");
  eq("…and the board shows the question", toView(game()).pendingQuestion, game().pending.confirm.question);
  const no = await step("no", "game_confirm", "No, keep playing");
  eq("no: the game goes on untouched", [game().id, store.listGames(persona.id).length, game().pending.confirm, game().phase], [id, games, null, "playing"]);
  has("no: said so", no, "we stay with The Hollow Lantern");

  const trap = await step("'Thorin tries to remove the trap' sent to game_remove_player", "game_remove_player", "Thorin tries to remove the trap");
  eq("…: Thorin is still in the party, and nobody was asked to confirm anything", [game().players.length, game().pending.confirm], [3, null]);
  check("…: it was taken as something Thorin does in the story", !/remove thorin/i.test(trap) && trap.length > 0, trap);

  const leave = await step("removing a hero", "game_remove_player", "Remove Thorin from the party");
  eq("removing a hero: asks first", [game().players.length, game().pending.confirm?.kind, game().pending.confirm?.targetId === hero("Thorin").id], [3, "remove_player", true]);
  has("removing a hero: a yes-or-no question", leave, `Remove Thorin from the ${String(game().theme.labels.party).toLowerCase()} for good? Say yes or no.`);
  const stay = await step("a no that reaches another tool", "game_narrate", "No, never mind");
  eq("a no that reaches another tool: still settles it", [game().players.length, game().pending.confirm, stay.includes("Thorin stays")], [3, null, true]);

  await run("game_remove_player", "Remove Thorin from the party");
  const lapsed = await step("something else is said instead of yes or no", "game_answer", "What's my armor class?");
  eq("something else instead of yes or no: the question lapses, nobody is removed", [game().players.length, game().pending.confirm], [3, null]);
  check("…and the question asked is answered", /armor class is \d+/.test(lapsed), lapsed);
}

// ═══ A short rest ════════════════════════════════════════════════════════════

{
  // Lyra (7 of 8) spends one d6 hit die: a 4, plus Constitution 2, capped at her maximum.
  const d = rollsWillBe(4);
  const rest = await step("a short rest", "game_rest", "We take a short rest");
  d.used("a short rest");
  has("a short rest: who spent hit dice and where they stand", rest, "You take a short rest.", "Lyra spends 1 hit die, regains 1, and is at 8 of 8.");
  eq("a short rest: hit points and hit dice", [hero("Lyra").hp, hero("Lyra").hitDiceUsed, hero("Thorin").hitDiceUsed, hero("Mira").hp], [8, 1, 0, 9]);
}

// ═══ The end of the session, and loading it again ════════════════════════════

{
  noDice();
  const id = game().id;
  const end = await step("the end of the session", "game_end_session", "Let's stop here for tonight");
  eq("the end of the session: saved and paused", [game().phase, game().story.sessions], ["paused", 2]);
  has("the end of the session: a recap, then that it is saved", end, "That's where we stop.", "The Mouth of Deepvein", "Your game is saved.");
  check("the end of the session: a recap of at most about ninety words", words(end) <= 100, words(end));

  // An old save lives beside it: loading that over the game on the table needs a yes.
  const other = store.importGame(persona.id, { title: "The Salt Road", phase: "playing", setting: "A caravan lost in the dunes.", players: [{ id: "p1", name: "Aldric", race: "Human", className: "Fighter", level: 1, hp: 9, maxHp: 12, ac: 16, stats: {}, inventory: [] }] }, "The Salt Road");
  kit.invalidateSnapshots();
  const swap = await step("loading over a game in play", "game_load", "Load the Salt Road");
  eq("loading over a game in play: asks first", [game().id, game().pending.confirm?.kind, game().pending.confirm?.targetId], [id, "load_game", other.id]);
  has("loading over a game in play: a yes-or-no question", swap, "Set The Hollow Lantern aside and load The Salt Road? Say yes or no.");
  const yes = await step("yes", "game_confirm", "Yes");
  eq("yes: the other game is on the table", [game().id, game().title], [other.id, "The Salt Road"]);
  has("yes: it is loaded with a recap", yes, "Welcome back to The Salt Road.");

  // Back to tonight's game, as after a restart: read from the database, normalized, recapped aloud.
  kit.invalidateSnapshots();
  await run("game_load", "Load the Hollow Lantern");
  const back = await step("…and back, with a yes", "game_confirm", "Yes, do it");
  const g = game();
  eq("reloaded: tonight's game, playing again, everything where it was", [g.id, g.phase, g.mode, g.players.map((p: AnyGame) => [p.name, p.hp, p.xp, p.playerName]), g.partyGold, g.npcs.map((n: AnyGame) => n.status), g.story.quests[0].title], [id, "playing", "explore", [["Thorin", 13, 33, "Ryan"], ["Lyra", 8, 33, "Ana"], ["Mira", 9, 33, "Sam"]], 7, ["defeated", "defeated"], "Relight the lamps of Deepvein"]);
  has("reloaded: the recap says where we are, what we're after, and who is up", back, "Welcome back to The Hollow Lantern.", "You are at The Mouth of Deepvein.", "Relight the lamps of Deepvein", "what do you do?");
  check("reloaded: a recap of at most about ninety words", words(back) <= 100, words(back));
  const recap = await step("a recap on request", "game_answer", "Can we get a recap?");
  has("a recap on request: from the state", recap, "The Hollow Lantern", "The Mouth of Deepvein");
  check("the rolling summary was refreshed in the background", await until(() => game().story.summary.includes("Deepvein")) || game().story.turn < 6, [game().story.turn, game().story.summary]);
}

// ═══ What the models were and weren't asked ══════════════════════════════════

{
  check("the narrator was only ever given resolved facts", calls.filter((c) => c.system.includes("narrating one beat")).every((c) => c.user.includes("Resolved facts (final)") && c.system.includes("Never add an outcome")));
  check("no model was asked to decide a hit, a save or a number", !calls.some((c) => /decide what happens and its concrete consequences/.test(c.system)));
  check("attacks, spells and reported rolls never waited on the classifier", calls.filter((c) => c.system.includes("intake clerk")).every((c) => !/attack|fire bolt|rolled|roll for me/i.test(/Words: (.*)$/m.exec(c.user)?.[1] ?? "")), calls.filter((c) => c.system.includes("intake clerk")).map((c) => /Words: (.*)$/m.exec(c.user)?.[1]));
  check("narration was asked for, and failed once without anyone noticing", narrations >= 4);
}

// A slow narrator: the code-built line is still spoken, within the cap.
{
  await store.mutateGame(game().id, (d: AnyGame) => {
    d.settings.rolls = "auto";
  });
  narrator = "slow";
  const d = rollsWillBe(17);
  const started = Date.now();
  const line = await step("a slow narrator", "game_narrate", "Mira makes a stealth check DC 15");
  d.used("a slow narrator");
  narrator = "ok";
  eq("a slow narrator: the result is spoken alone", line, "Mira's Stealth check: 17 plus 5 is 22 against DC 15. Success. Thorin, what do you do?");
  check("a slow narrator: and not kept waiting more than a few seconds", Date.now() - started < 5000, Date.now() - started);
}

// ═══ A table played through the real router ══════════════════════════════════
// The sentences of a short game typed through the orchestrator with the real routing model, each sent here to the
// tool the router chose that night. Then: what the defects were (A to E), each checked fixed.

const personaAs = (id: string) => ({ ...persona, id });
async function runAs(p: typeof persona, tool: string, utterance: string): Promise<Result> {
  const t = getTool(tool);
  if (!t) throw new Error(`no tool ${tool}`);
  return t.run({}, { persona: p, recentTranscript: [], emit: () => {}, utterance, memory: {} as never, situation: "" }) as Promise<Result>;
}
/** A turn at another table: run the tool, check it speaks and that no number said disagrees with that table's game. */
async function stepAs(p: typeof persona, name: string, tool: string, utterance: string): Promise<string> {
  const r = await runAs(p, tool, utterance);
  const line = said(r);
  if (process.env.SHOW) console.log(`\n   > ${tool}: "${utterance}"\n   < ${line}  [${words(line)} words]`);
  check(`${name}: the tool answers with a line to speak verbatim`, r.ok === true && typeof r.speak === "string" && line.length > 0, r);
  numbersAgree(name, line, store.getActiveGame(p.id));
  return line;
}
const ADVENTURE_Q = /What kind of adventure/;
/** No reply is the one before it, word for word. */
const neverTwice = (name: string, lines: string[]) => check(name, lines.every((l, i) => i === 0 || l !== lines[i - 1]), lines);

{
  noDice();
  const p = personaAs("game-master-router-night");
  const g = (): AnyGame => store.getActiveGame(p.id);
  const heroOf = (name: string): AnyGame => g().players.find((x: AnyGame) => x.name === name);
  const lines: string[] = [];
  const say = async (name: string, tool: string, utterance: string) => {
    const line = await stepAs(p, name, tool, utterance);
    lines.push(line);
    return line;
  };

  // A. Everything the first sentence says is taken (the model said "described": false all the same).
  const opened = await say("A: the first sentence", "game_new", "Let's start a new game. A short fantasy adventure for two players.");
  eq("A: the adventure, its length and the player count are all kept", [g().title, g().genre, g().settings.length, g().settings.expectedPlayers, g().phase], ["The Ember Road", "high fantasy", "short", 2, "setup"]);
  has("A: said back in one breath, then the next question", opened, "The Ember Road: a short high fantasy adventure for two players.", "Player one, what's your name?");
  check("A: and the table is not asked what kind of adventure it wants", !ADVENTURE_Q.test(opened), opened);

  // B. "I'm playing Thorin": no player called "Playing".
  const thorin = await say("B: 'I'm playing Thorin, a dwarf fighter.'", "game_add_player", "I'm playing Thorin, a dwarf fighter.");
  eq("B: Thorin joins, played by the speaker, with no name made up from a verb", [heroOf("Thorin")?.race, heroOf("Thorin")?.className, heroOf("Thorin")?.playerName], ["Dwarf", "Fighter", ""]);
  has("B: said with his numbers", thorin, "Thorin the dwarf fighter joins:", "hit points", "armor class");
  check("B: 'Playing' is nobody's name, and nobody asks who plays Thorin", !/\bPlaying\b/.test(thorin) && !/Who is playing Thorin/.test(thorin), thorin);
  const lyra = await say("…'My friend is playing Lyra, an elf wizard.'", "game_add_player", "My friend is playing Lyra, an elf wizard.");
  eq("…Lyra joins, an elf wizard, played by a friend", [heroOf("Lyra")?.race, heroOf("Lyra")?.className, heroOf("Lyra")?.playerName], ["Elf", "Wizard", ""]);
  check("…and nobody asks who plays her", !/Who is playing/.test(lyra), lyra);
  check("the router may now send a move in the story to the action tool: it is offered once a hero has joined", getTool("game_narrate").available({ persona: p }) === true);

  // C. "Let's begin." begins.
  const begin = await say("C: 'Let's begin.'", "game_begin", "Let's begin.");
  eq("C: the adventure begins", [g().phase, g().mode, g().spotlightId === heroOf("Thorin").id], ["playing", "explore", true]);
  has("C: the opening, then the first hero by name", begin, "Let the adventure begin.", "Thorin, you're first. What do you do?");

  // D. Moves in the story, sent to the question tool as they were that night.
  const look = await say("D: 'I look around the room. What do I see?' (to game_answer)", "game_answer", "I look around the room. What do I see?");
  has("D: what they see, from the scene", look, g().scene.title, "Deepvein");
  const search = await say("D: 'Lyra searches the old desk for anything useful.' (to game_answer)", "game_answer", "Lyra searches the old desk for anything useful.");
  eq("D: a move sent to the question tool is played: Lyra's search calls for her roll", [g().pending.check?.heroId === heroOf("Lyra").id, g().pending.check?.skill], [true, "investigation"]);
  has("D: …by name", search, "Lyra, give me an Investigation check");
  const d = rollsWillBe();
  const found = await say("…the roll, said at the table", "game_roll", "I rolled a twelve");
  d.used("the search roll");
  const bonus = R.skillModifier(heroOf("Lyra"), "investigation");
  has("…resolved with Lyra's own bonus, then handed on", found, `Lyra's Investigation check: 12 plus ${bonus} is ${12 + bonus} against DC 10. Success.`, "Thorin, what do you do?");
  const turnBefore = g().story.turn;
  const door = await say("D: 'Thorin opens the door at the end of the hall.' (to game_answer)", "game_answer", "Thorin opens the door at the end of the hall.");
  eq("D: Thorin's move is a story turn", g().story.turn, turnBefore + 1);
  has("D: …narrated, then handed on", door, "Steel rings in the dark", "Lyra, what do you do?");
  const bolt = await say("D: 'Lyra casts fire bolt at the closest enemy.' (to game_answer)", "game_answer", "Lyra casts fire bolt at the closest enemy.");
  eq("D: a spell with no enemy in sight costs nothing and is said plainly", [bolt, heroOf("Lyra").slotsUsed[0]], ["There's no target for fire bolt.", 0]);

  // E. Questions about the sheets are answered from the state.
  const hp = await say("E: 'How many hit points does Thorin have left?'", "game_answer", "How many hit points does Thorin have left?");
  eq("E: from the sheet", hp, `Thorin has ${heroOf("Thorin").hp} of ${heroOf("Thorin").maxHp} hit points.`);
  const whose = await say("'Whose turn is it?'", "game_answer", "Whose turn is it?");
  has("whose turn: no fight, so the spotlight", whose, "no turn order", "Lyra has the spotlight");
  const pause = await say("'Pause the game.'", "game_pause", "Pause the game.");
  eq("pause pauses", [g().phase, pause], ["paused", "Paused. Say resume when you're ready."]);
  const resume = await say("…'Okay, we're back.'", "game_pause", "Okay, we're back.");
  eq("…and resumes", [g().phase, resume.startsWith("We're back.")], ["playing", true]);
  const stop = await say("'Let's stop here for tonight.'", "game_end_session", "Let's stop here for tonight.");
  eq("stopping for the night: saved and paused", g().phase, "paused");
  has("…and the table is told it is saved", stop, "Your game is saved.");
  check("…its recap reads as plain sentences (no 'Thorin — Thorin opens the door.:')", !/[.!?]:/.test(stop) && !/Thorin — Thorin/.test(stop), stop);

  check("D: after the first sentence no reply asked what kind of adventure to play", lines.slice(1).every((l) => !ADVENTURE_Q.test(l)), lines.filter((l) => ADVENTURE_Q.test(l)));
  neverTwice("no reply was the same as the one before it", lines);
  check("every reply runs to at most about ninety words", lines.every((l) => words(l) <= 90), lines.map(words));
  check("the talking brain stays silent for typed chatter at this table too", contextFor(p).talk.silence === true);
  check("email, calendar and booking tools are hidden at the table ('check' and 'send' are game words)", ["check_email", "read_email", "draft_email", "send_email", "check_calendar", "schedule_meeting", "save_meeting", "open_booking"].every((t) => contextFor(p).hiddenActions.has(t)));
}

// Before the story has begun: a move with nobody to play says once what is missing; pause and stop work; a move by a
// hero begins the story with an adventure the Game Master chooses, and is played as the first turn.
{
  noDice();
  const p = personaAs("game-master-setup-moves");
  const g = (): AnyGame => store.getActiveGame(p.id);
  const lines: string[] = [];
  const say = async (name: string, tool: string, utterance: string) => {
    const line = await stepAs(p, name, tool, utterance);
    lines.push(line);
    return line;
  };
  const table = await say("a table with no adventure chosen yet", "game_new", "Let's play a game");
  eq("…nothing invented", [g().phase, g().title, g().players.length], ["setup", "New Adventure", 0]);
  has("…and it asks what kind", table, "A fresh table is ready.", "What kind of adventure");
  check("before anyone has a hero, the action tool isn't offered", getTool("game_narrate").available({ persona: p }) === false);

  const first = await say("a move before anyone has a hero", "game_answer", "I open the door.");
  has("…says what is missing, with the way forward", first, "The story starts once someone has a hero.", "pick a ready-made one");
  const second = await say("…another one", "game_answer", "I search the room.");
  eq("…said briefly the second time, not word for word again", second, "First, a hero: who are you playing?");
  eq("…and nothing changed", [g().phase, g().players.length, g().story.turn], ["setup", 0, 0]);

  const begin0 = await say("'Let's begin' with nobody to play", "game_begin", "Let's begin.");
  check("…is no dead end: it says what is missing and how to fix it", /hero/i.test(begin0) && !/can't begin/i.test(begin0), begin0);

  const pause = await say("'Pause the game.' during setup", "game_pause", "Pause the game.");
  eq("…honest: a break, nothing lost, still setting up", [g().phase, pause], ["setup", "All right, a break. The setup is saved as it is; say let's continue when you're ready."]);
  const back = await say("…'We're back.'", "game_pause", "We're back.");
  check("…picks up with the setup question", back.startsWith("We're back.") && ADVENTURE_Q.test(back), back);

  const mira = await say("a hero joins before any adventure is chosen", "game_add_player", "I'm Sam. I'll play Mira, a halfling rogue");
  has("…welcome", mira, "Mira the halfling rogue joins, played by Sam");
  check("now a move in the story may go to the action tool", getTool("game_narrate").available({ persona: p }) === true);
  const stop = await say("'Let's stop here for tonight.' during setup", "game_end_session", "Let's stop here for tonight.");
  eq("…saved, with the hero, still setting up", [g().phase, stop], ["setup", "We'll stop here. Your game is saved, with Mira. Next time, say let's continue our game."]);

  const move = await say("a move by a hero before the story began (to game_narrate)", "game_narrate", "Mira searches the old desk for anything useful.");
  eq("…begins the story with an adventure the Game Master chose", [g().phase, g().title, g().genre], ["playing", "The Salt Crown", "sword and sorcery"]);
  has("…said in one sentence, then the opening, then the move played as the first turn", move, "Let the adventure begin: The Salt Crown, a sword and sorcery adventure.", "Mira, give me an Investigation check");
  eq("…the roll is waited for", [g().pending.check?.heroId === g().players[0].id, g().pending.check?.skill], [true, "investigation"]);
  check("…in at most about ninety words", words(move) <= 90, words(move));
  neverTwice("no reply was the same as the one before it", lines);
}

// The same table again, in play (a tomb entrance, nobody to fight): one hero's roll is waited for while another moves.
{
  noDice();
  const p = personaAs("game-master-waiting-roll");
  const doc = {
    title: "The Sealed Tomb",
    genre: "high fantasy",
    phase: "playing",
    setting: "An old tomb below the hill has begun to glow at night.",
    settings: { rolls: "ask" },
    spotlightId: "hLyra",
    scene: { title: "The Tomb Entrance", description: "A low hall runs into the hill, lined with pulsing glyphs. An old desk stands by the wall, and a door waits at the far end." },
    players: [
      { id: "hThorin", name: "Thorin", playerName: "Ryan", race: "Dwarf", className: "Fighter", level: 1, hp: 13, maxHp: 13, ac: 16, stats: { str: 16, dex: 10, con: 16, int: 8, wis: 12, cha: 10 }, inventory: ["iAxe"] },
      { id: "hLyra", name: "Lyra", playerName: "Ana", race: "Elf", className: "Wizard", level: 1, hp: 8, maxHp: 8, ac: 12, stats: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }, inventory: [] },
    ],
    items: [{ id: "iAxe", name: "Battleaxe", type: "weapon", ownerId: "hThorin" }],
  };
  const imported = store.importGame(p.id, doc, "The Sealed Tomb");
  store.setActiveGame(p.id, imported.id);
  kit.invalidateSnapshots();
  const g = (): AnyGame => store.getActiveGame(p.id);
  const heroOf = (name: string): AnyGame => g().players.find((x: AnyGame) => x.name === name);
  const lines: string[] = [];
  const say = async (name: string, tool: string, utterance: string) => {
    const line = await stepAs(p, name, tool, utterance);
    lines.push(line);
    return line;
  };

  const desk = await say("F: 'Lyra searches the old desk for anything useful.'", "game_narrate", "Lyra searches the old desk for anything useful.");
  eq("F: Lyra's roll is called for", [desk, g().pending.check?.heroId], ["Lyra, give me an Investigation check. Tell me the roll, or say roll for me.", "hLyra"]);

  const door = await say("F: 'Thorin opens the door at the end of the hall.' while Lyra's roll waits", "game_narrate", "Thorin opens the door at the end of the hall.");
  has("F: Thorin's move is played, not refused, and the hand-off goes back to Lyra's roll", door, "Steel rings in the dark", "Lyra, your investigation check is still waiting: tell me the roll, or say roll for me.");
  check("F: …nothing was rolled for Lyra behind her back", !/Investigation check:/.test(door), door);
  eq("F: …her roll still waits, Thorin's move counts, the spotlight is hers", [g().pending.check?.heroId, g().pending.check?.reminders, g().story.turn, g().spotlightId], ["hLyra", 0, 1, "hLyra"]);

  const axe = await say("F: 'Thorin attacks the nearest enemy with his axe.' with nobody to fight", "game_narrate", "Thorin attacks the nearest enemy with his axe.");
  eq("F: his move gets its answer: there is no enemy in sight", axe, "There's no enemy in sight for Thorin to attack.");
  eq("F: …nothing happens: no turn, no fight, Lyra's roll still waits", [g().story.turn, g().combat, g().pending.check?.heroId], [1, null, "hLyra"]);

  let d = rollsWillBe(9);
  const listen = await say("F: another hero's roll while Lyra's waits", "game_narrate", "Thorin listens at the door.");
  d.used("F: Thorin's own roll");
  has("F: it is rolled now, and said to be", listen, "I'll roll Thorin's Perception check: 9 plus 1 is 10 against DC 15. Failure.", "Lyra, your investigation check is still waiting");
  eq("F: …and Lyra's roll is the one still waited for", g().pending.check?.heroId, "hLyra");

  const bonus = R.skillModifier(heroOf("Lyra"), "investigation");
  const found = await say("F: Lyra's roll, at last", "game_roll", "I rolled an eighteen");
  has("F: settled with her own die and bonus, then handed on", found, `Lyra's Investigation check: 18 plus ${bonus} is ${18 + bonus} against DC 10. Success.`, "Thorin, what do you do?");

  // The same hero moves on twice without rolling: the second time the roll is made for her, said plainly first.
  await say("a roll called for Lyra again", "game_narrate", "Lyra searches the old desk for anything useful.");
  const once = await say("Lyra moves on without rolling", "game_narrate", "Lyra reads the glyphs on the wall.");
  eq("…she is reminded once, and nothing else happens", [once, g().pending.check?.reminders], ["First, Lyra's investigation check: tell me the roll, or say roll for me.", 1]);
  narrator = "long";
  d = rollsWillBe(7);
  const twice = await say("G: Lyra moves on again", "game_narrate", "Lyra reads the glyphs on the wall.");
  d.used("G: the roll made for Lyra");
  narrator = "ok";
  check("G: the roll is announced before it is made", twice.startsWith("I'll roll Lyra's investigation check now. Lyra's Investigation check: 7 plus"), twice);
  has("G: then her new move, then the hand-off", twice, "Dust lifts from the old wood", "Thorin, what do you do?");
  check("G: the roll and the move together stay within one spoken line (85 words)", words(twice) <= 85, words(twice));
  eq("G: one narration, for the move (the roll made for her is said plainly, without its own)", twice.split("Dust lifts").length - 1, 1);
  eq("G: nothing is left waiting", g().pending.check, null);

  // A roll left waiting when the table stops: the recap doesn't end by asking for it.
  await say("a roll called for Thorin", "game_narrate", "Thorin searches the old desk for anything useful.");
  const again = await say("…and another move while it waits", "game_narrate", "Lyra opens the door at the end of the hall.");
  has("the waiting roll closes the reply", again, "Thorin, your investigation check is still waiting");
  const third = await say("…and another", "game_narrate", "Lyra walks down the hall.");
  check("…said briefly the next time, so the same sentence never closes two replies running", third.endsWith("Thorin's roll is still waiting."), third);
  const stop = await say("H: 'Let's stop here for tonight.'", "game_end_session", "Let's stop here for tonight.");
  has("H: the session ends, saved", stop, "Your game is saved.");
  check("H: …without asking for the roll on the way out", !/still waiting/.test(stop), stop);
  check("H: the recap holds only what happened: no attack on an enemy that was never there", !/attacks the nearest enemy/i.test(stop) && !/enemy/i.test(g().story.recentTurns.join(" ")), [stop, g().story.recentTurns]);
  check("G: every reply stays within one spoken line (85 words)", lines.every((l) => words(l) <= 85), lines.map(words));
  neverTwice("no reply was the same as the one before it", lines);
}

// The readers behind those fixes, on their own.
{
  const setupWords = await load("game/setup.ts");
  const gen = await load("game/generate.ts");
  const g0 = store.normalizeGameDocument({ phase: "playing", players: [{ id: "hL", name: "Lyra", race: "Elf", className: "Wizard", hp: 8, maxHp: 8, stats: {} }] });
  eq("how many play, when the words say it of players", ["A short fantasy adventure for two players.", "a one-shot for three", "just me", "Let's play a one-shot", "an adventure for 2 hours", "there are four of us"].map(setupWords.playerCountIn), [2, 3, 1, null, null, 4]);
  eq("how long", ["A short fantasy adventure", "a one-shot", "a long campaign", "something a little spooky", "keep it short", "we take a short rest"].map(setupWords.lengthIn), ["short", "one-shot", "campaign", null, "short", null]);
  eq("a verb is no one's name", [setupWords.isNameWord("playing"), setupWords.isNameWord("excited"), setupWords.isNameWord("Ryan"), setupWords.isNameWord("Sterling"), setupWords.parsePlayerName("I'm playing too"), setupWords.parsePlayerName("I'm Ana")], [false, false, true, true, null, "Ana"]);
  eq("a genre, a world or a mood said is a description", ["A short fantasy adventure for two players.", "Let's start a new game", "something spooky", "a pirate story"].map(gen.saysKind), [true, false, true, true]);
  eq("asking, not doing", ["I look around the room. What do I see?", "How many hit points does Thorin have left?", "Lyra searches the old desk for anything useful.", "Whose turn is it?"].map(adjudicate.isQuestion), [true, true, false, true]);
  eq("a move in the story", ["Lyra searches the old desk for anything useful.", "I open the door.", "I look around the room. What do I see?", "Let's begin.", "Pass the chips", "I'm playing Thorin, a dwarf fighter.", "How many hit points does Lyra have?"].map((t) => adjudicate.isStoryMove(g0, t)), [true, true, true, false, false, false, false]);
}

// "Let's begin" with heroes but no adventure: the Game Master chooses one and begins.
{
  noDice();
  const p = personaAs("game-master-just-begin");
  const g = (): AnyGame => store.getActiveGame(p.id);
  await stepAs(p, "a table with no adventure chosen", "game_new", "Let's play");
  const thorin = await stepAs(p, "a hero joins", "game_add_player", "I'm playing Thorin, a dwarf fighter.");
  check("…with no player called 'Playing'", !/\bPlaying\b/.test(thorin) && g().players[0]?.playerName === "", thorin);
  const begin = await stepAs(p, "C: 'Let's begin.' with no adventure chosen", "game_begin", "Let's begin.");
  eq("C: it begins, with an adventure chosen for the party", [g().phase, g().title], ["playing", "The Salt Crown"]);
  has("C: what it is, in one sentence, then the opening and the hand-off", begin, "Let the adventure begin: The Salt Crown, a sword and sorcery adventure.", "What do you do?");
  check("C: never 'We can't begin yet'", !/can't begin/i.test(begin), begin);
  check("C: in at most about ninety words", words(begin) <= 90, words(begin));
}

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}.`);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
