/*
 * A game saved before the rules engine existed must keep loading.
 *
 *   TRINITY_DATA_DIR=<fresh folder> DOTENV_CONFIG_PATH=<empty file> MORDIEM_API_KEY=test node_modules/.bin/tsx scripts/test-game-compat.mts
 *
 * The fixture below is written by hand in the shape games had before this build (Player without hit dice, saves,
 * slots or death saves; Npc without a stat block; Item without a quantity; Roll without advantage; Game with only
 * `phase: "setup" | "playing"`, `round` and `activePlayerId` — no story, fight, pending questions, table settings).
 * It is stored as a raw document and read back the way every saved game is. Every new field must come back with a
 * sensible default, the result must be stable when saved and read again, and the old game must then play through
 * the real tools: a recap on load, a fight with initiative, a hit rolled in code, and an undo.
 *
 * Prints one line per check and ends with "ALL PASSED" or "N FAILED" (exit code 1).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_DATA_DIR) process.env.TRINITY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "trinity-game-compat-"));
if (!process.env.DOTENV_CONFIG_PATH) {
  const empty = path.join(process.env.TRINITY_DATA_DIR, "empty.env");
  writeFileSync(empty, "");
  process.env.DOTENV_CONFIG_PATH = empty;
}
process.env.MORDIEM_API_KEY ||= "test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = (p: string) => import(pathToFileURL(path.join(ROOT, "server/src", p)).href);

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

// ─── The model, stubbed: only the narrator is ever needed here ───────────────

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const modelCalls: string[] = [];
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/images/generations")) return jsonResponse({ data: [{ b64_json: TINY_PNG }] });
  if (!url.endsWith("/chat/completions")) return new Response("not stubbed", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
  const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
  modelCalls.push(system.slice(0, 80));
  const reply = system.includes("narrating one beat") ? { narration: "The blade bites and the goblin reels.", clue: null } : system.includes("running summary") ? { summary: "The heroes went below the chapel." } : {};
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }] });
}) as typeof fetch;

// ─── A saved game in the old shape ───────────────────────────────────────────

const T0 = 1_760_000_000_000;
const noImage = { id: null, status: "none" };
const OLD_GAME = {
  id: "oldgame001",
  personaId: "game-master",
  title: "The Sunken Bell",
  genre: "fantasy",
  tone: "eerie",
  setting: "A drowned chapel tolls at night beneath Lake Varn, and the fisherfolk have begun to walk into the water.",
  artStyle: "muted watercolor, lantern light on dark water",
  theme: {
    palette: { bg: "#0d1418", panel: "#16222a", ink: "#e6f0f2", muted: "#8aa4ad", accent: "#58b8c9", accent2: "#c98a58", danger: "#e0574c", good: "#7cbf6e" },
    font: "serif",
    texture: "stone",
    labels: { party: "Party", scene: "Scene", log: "Chronicle", npcs: "Folk & Foes", items: "Treasures", map: "Map" },
    ornament: "≈",
  },
  phase: "playing",
  round: 4,
  activePlayerId: "heroElara1",
  titleImage: { id: "imgTitle01", status: "ready" },
  scene: { title: "The Flooded Nave", description: "Black water laps at the pews, and a green light pulses under the altar.", image: noImage },
  players: [
    {
      id: "heroBorin1", name: "Borin", race: "Dwarf", className: "Fighter", level: 2, hp: 18, maxHp: 20, ac: 18, speed: 25,
      stats: { str: 16, dex: 12, con: 15, int: 9, wis: 11, cha: 10 }, background: "Soldier", traits: ["Never leaves a friend behind"], conditions: [],
      gold: 12, xp: 300, inventory: ["itemSword1", "itemMail01", "itemShld01"], notes: "", appearance: "A stout dwarf in dented mail", portrait: noImage,
    },
    {
      id: "heroElara1", name: "Elara", race: "Elf", className: "Wizard", level: 3, hp: 12, maxHp: 14, ac: 12, speed: 30,
      stats: { str: 8, dex: 14, con: 12, int: 17, wis: 12, cha: 10 }, background: "Sage", traits: [], conditions: ["Poisoned", "blessed"],
      gold: 30, xp: 900, inventory: ["itemStaff1", "itemPotn01"], notes: "Owes the ferryman a favor.", appearance: "A tall elf in a rain-dark cloak", portrait: { id: "imgElara01", status: "ready" },
    },
    {
      id: "heroZeph01", name: "Zeph", race: "Tiefling", className: "Warlock", level: 1, hp: 6, maxHp: 9, ac: 13, speed: 30,
      stats: { str: 10, dex: 14, con: 13, int: 12, wis: 10, cha: 16 }, background: "Charlatan", traits: [], conditions: [],
      gold: 3, xp: 0, inventory: [], notes: "", appearance: "A thin tiefling with a brass ring in one horn", portrait: noImage,
    },
    // A card that was still being drawn up when the engine stopped: it must not come back as a hero.
    { id: "heroGhost1", name: "New hero", race: "", className: "", level: 1, hp: 1, maxHp: 1, ac: 10, speed: 30, stats: {}, background: "", traits: [], conditions: [], gold: 0, xp: 0, inventory: [], notes: "", appearance: "", portrait: { id: null, status: "pending" }, pending: true },
  ],
  npcs: [
    { id: "npcGoblin1", name: "Goblin", role: "Bell thief", description: "A wiry goblin with a sack of stolen candles.", attitude: "hostile", appearance: "a wiry goblin", portrait: noImage },
    { id: "npcMirela1", name: "Mirela", role: "Innkeeper", description: "She has not slept since the bell began to toll.", attitude: "friendly", appearance: "a tired woman in an apron", portrait: noImage },
    { id: "npcSkelet1", name: "Skeleton", role: "Drowned sexton", description: "It still holds the bell rope.", attitude: "unknown", appearance: "a skeleton in a rotted cassock", portrait: noImage },
  ],
  items: [
    { id: "itemSword1", name: "Longsword", type: "weapon", rarity: "common", description: "Notched but true.", properties: ["versatile"], ownerId: "heroBorin1", appearance: "a notched longsword", icon: noImage },
    { id: "itemMail01", name: "Chain mail", type: "armor", rarity: "common", description: "", properties: [], ownerId: "heroBorin1", appearance: "", icon: noImage },
    { id: "itemShld01", name: "Shield", type: "armor", rarity: "common", description: "", properties: [], ownerId: "heroBorin1", appearance: "", icon: noImage },
    { id: "itemStaff1", name: "Quarterstaff", type: "weapon", rarity: "common", description: "", properties: [], ownerId: "heroElara1", appearance: "", icon: noImage },
    { id: "itemPotn01", name: "Potion of Healing", type: "potion", rarity: "common", description: "Red and faintly warm.", properties: ["heals 2d4+2"], ownerId: "heroElara1", appearance: "a red vial", icon: noImage },
    { id: "itemBell01", name: "Silver bell clapper", type: "quest", rarity: "uncommon", description: "It hums when held under water.", properties: [], ownerId: null, appearance: "a silver clapper", icon: noImage },
    // Its owner left the party long ago.
    { id: "itemRing01", name: "Brass ring", type: "treasure", rarity: "common", description: "", properties: [], ownerId: "heroGone01", appearance: "", icon: noImage },
  ],
  locations: [
    { id: "locShore01", name: "Lake Varn shore", description: "Reeds and overturned boats.", x: 0.2, y: 0.6, connections: ["locNave001"], visited: true, image: noImage },
    { id: "locNave001", name: "The Flooded Nave", description: "", x: 0.6, y: 0.4, connections: ["locShore01"], visited: true, image: noImage },
  ],
  currentLocationId: "locNave001",
  log: [
    { id: "logEntry01", ts: T0 - 90_000, kind: "narration", text: "The chapel doors hang open under the water." },
    { id: "logEntry02", ts: T0 - 30_000, kind: "roll", text: "Elara rolled 1d20+5: 17 + 5 = 22 (Arcana)" },
  ],
  lastRoll: { id: "rollOld001", who: "Elara", notation: "1d20+5", rolls: [17], modifier: 5, total: 22, label: "Arcana", ts: T0 - 30_000 },
  createdAt: T0 - 86_400_000,
  updatedAt: T0,
};

const store = await load("game/store.ts");
const R = await load("game/rules.ts");
const kit = await load("game/kit.ts");
const view = await load("game/view.ts");
const { registerGameTools } = await load("game/tools.ts");
const { registerStoryTools } = await load("game/story-tools.ts");
const integration = await load("game/integration.ts");
const { getTool } = await load("tools/registry.ts");

type Any = Record<string, any>;
const PERSONA = "game-master";

// Stored as it was, read as every saved game is.
const g: Any = store.importGame(PERSONA, OLD_GAME, OLD_GAME.title);
check("the old game loads", !!g && g.title === "The Sunken Bell");

// ─── The game itself ─────────────────────────────────────────────────────────

eq("what the old game knew is kept", [g.title, g.genre, g.tone, g.setting, g.artStyle, g.theme.texture, g.theme.labels.log, g.theme.ornament, g.scene.title, g.currentLocationId, g.titleImage], [
  "The Sunken Bell", "fantasy", "eerie", OLD_GAME.setting, OLD_GAME.artStyle, "stone", "Chronicle", "≈", "The Flooded Nave", "locNave001", { id: "imgTitle01", status: "ready" },
]);
eq("phase and mode: playing, exploring, no fight", [g.phase, g.mode, g.combat], ["playing", "explore", null]);
eq("the old round counter is not a combat round: outside a fight the round is 0", g.round, 0);
eq("the hero who was active holds the spotlight", [g.spotlightId, g.activePlayerId], ["heroElara1", "heroElara1"]);
eq("nothing is pending", g.pending, { check: null, confirm: null, action: null });
eq("table settings get their defaults (no length was ever asked for)", g.settings, { difficulty: "standard", leveling: "xp", rolls: "ask", avoid: [], expectedPlayers: null, length: null });
eq("session zero's bookkeeping is empty", g.setupState, { seatName: "", asked: {}, answered: [] });
eq("party gold starts at nothing", g.partyGold, 0);
eq("the story memory is empty but whole, with the premise taken from the setting", g.story, {
  premise: OLD_GAME.setting, outline: [], beat: 0, secrets: [], clues: [], quests: [], facts: [], threats: [], summary: "", summaryTurn: 0, turn: 0, recentTurns: [], lastTurn: "", lastNarration: "", sessions: 0,
});
eq("the log and the map are kept", [g.log.map((e: Any) => e.id), g.locations.map((l: Any) => [l.name, l.visited, l.connections])], [
  ["logEntry01", "logEntry02"],
  [["Lake Varn shore", true, ["locNave001"]], ["The Flooded Nave", true, ["locShore01"]]],
]);
eq("the last roll is kept, with the new fields empty", g.lastRoll, { id: "rollOld001", who: "Elara", notation: "1d20+5", rolls: [17], modifier: 5, total: 22, label: "Arcana", ts: T0 - 30_000, adv: null, kept: null, natural: null, dc: null, outcome: null });
eq("when it was made is kept", g.createdAt, T0 - 86_400_000);

// ─── Heroes ──────────────────────────────────────────────────────────────────

eq("three heroes; the half-made card is gone", g.players.map((p: Any) => p.name), ["Borin", "Elara", "Zeph"]);
const hero = (name: string): Any => store.getGame(g.id).players.find((p: Any) => p.name === name);
const borin = hero("Borin");
const elara = hero("Elara");
const zeph = hero("Zeph");

const NEW_PLAYER_FIELDS = ["playerName", "tempHp", "conditionRounds", "exhaustion", "hitDie", "hitDiceUsed", "saveProficiencies", "skillProficiencies", "castingAbility", "slotsMax", "slotsUsed", "spells", "concentration", "inspiration", "deathSaves", "stable", "dead", "equipped", "resistances"];
for (const p of [borin, elara, zeph]) {
  eq(`${p.name}: every new field of a sheet is there`, NEW_PLAYER_FIELDS.filter((f) => !(f in p) || p[f] === undefined), []);
  eq(`${p.name}: the blank defaults`, [p.playerName, p.tempHp, p.conditionRounds, p.exhaustion, p.hitDiceUsed, p.concentration, p.inspiration, p.deathSaves, p.stable, p.dead], ["", 0, {}, 0, 0, null, false, { successes: 0, failures: 0 }, false, false]);
}
eq("what the old sheets held is kept", [borin.hp, borin.maxHp, borin.ac, borin.level, borin.xp, borin.gold, borin.stats.str, borin.background, borin.traits, elara.notes, elara.portrait], [18, 20, 18, 2, 300, 12, 16, "Soldier", ["Never leaves a friend behind"], "Owes the ferryman a favor.", { id: "imgElara01", status: "ready" }]);
eq("a fighter: d10 hit dice, Strength and Constitution saves, no spells", [borin.hitDie, borin.saveProficiencies, borin.skillProficiencies, borin.castingAbility, borin.slotsMax, borin.spells], [10, ["str", "con"], ["athletics", "intimidation"], null, [0, 0, 0, 0, 0, 0, 0, 0, 0], []]);
eq("a third-level wizard: d6 hit dice, Intelligence and Wisdom saves, four first-level and two second-level slots", [elara.hitDie, elara.saveProficiencies, elara.castingAbility, elara.slotsMax, elara.slotsUsed], [6, ["int", "wis"], "int", [4, 2, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]]);
check("the wizard knows her class's SRD spells", elara.spells.includes("fire bolt") && elara.spells.includes("magic missile"), elara.spells);
eq("a first-level warlock: d8 hit dice, Wisdom and Charisma saves, one pact slot", [zeph.hitDie, zeph.saveProficiencies, zeph.castingAbility, zeph.slotsMax[0], zeph.spells.includes("eldritch blast")], [8, ["wis", "cha"], "cha", 1, true]);
eq("species resistances: a dwarf and poison, a tiefling and fire, an elf none", [borin.resistances, zeph.resistances, elara.resistances], [["poison"], ["fire"], []]);
eq("conditions are kept, in lower case, without a timer", [elara.conditions, elara.conditionRounds], [["poisoned", "blessed"], {}]);
eq("what a hero carried is put on: sword, mail and shield", borin.equipped, { weapon: "itemSword1", armor: "itemMail01", shield: "itemShld01" });
eq("…and putting it on does not change the armor class the sheet had", borin.ac, 18);
eq("the wizard readies her staff; the warlock has nothing to ready", [elara.equipped, zeph.equipped], [{ weapon: "itemStaff1", armor: null, shield: null }, { weapon: null, armor: null, shield: null }]);

// ─── Items ───────────────────────────────────────────────────────────────────

const item = (id: string): Any => store.getGame(g.id).items.find((it: Any) => it.id === id);
eq("items get a quantity of one", g.items.map((it: Any) => it.quantity), [1, 1, 1, 1, 1, 1, 1]);
eq("items get a price from the SRD lists", [item("itemSword1").value, item("itemMail01").value, item("itemShld01").value, item("itemPotn01").value], [15, 75, 10, 50]);
check("every item has a price that is a number", g.items.every((it: Any) => Number.isFinite(it.value) && it.value >= 0));
eq("an item whose owner is gone becomes party loot", [item("itemRing01").ownerId, item("itemBell01").ownerId], [null, null]);
eq("inventories follow ownership", [borin.inventory, elara.inventory, zeph.inventory], [["itemSword1", "itemMail01", "itemShld01"], ["itemStaff1", "itemPotn01"], []]);

// ─── Characters and creatures ────────────────────────────────────────────────

const npc = (name: string): Any => store.getGame(g.id).npcs.find((n: Any) => n.name === name);
const goblin = npc("Goblin");
const mirela = npc("Mirela");
const skeleton = npc("Skeleton");
const NEW_NPC_FIELDS = ["kind", "creatureType", "hp", "maxHp", "tempHp", "ac", "speed", "stats", "attacks", "attacksPerTurn", "breath", "saves", "cr", "xp", "status", "conditions", "conditionRounds", "resistances", "vulnerabilities", "immunities", "regen", "regenBlocked", "statted"];
for (const n of [goblin, mirela, skeleton]) {
  eq(`${n.name}: every new field of a creature is there`, NEW_NPC_FIELDS.filter((f) => !(f in n) || n[f] === undefined), []);
  eq(`${n.name}: alive, unhurt, no conditions`, [n.status, n.hp === n.maxHp && n.hp > 0, n.tempHp, n.conditions, n.conditionRounds], ["alive", true, 0, [], {}]);
  check(`${n.name}: has an attack with a bonus and damage dice`, n.attacks.length >= 1 && Number.isFinite(n.attacks[0].toHit) && R.parseDice(n.attacks[0].damage) !== null, n.attacks);
}
eq("what the old characters were is kept", [goblin.role, goblin.description, goblin.attitude, mirela.role, mirela.attitude, skeleton.attitude], ["Bell thief", "A wiry goblin with a sack of stolen candles.", "hostile", "Innkeeper", "friendly", "unknown"]);
eq("a goblin gets the SRD goblin's stat block", [goblin.kind, goblin.maxHp, goblin.ac, goblin.cr, goblin.xp, goblin.attacks[0].name, goblin.attacks[0].toHit, goblin.attacks[0].damage, goblin.statted], ["goblin", 7, 15, 0.25, 50, "Scimitar", 4, "1d6+2", true]);
eq("a skeleton gets the SRD skeleton's, weak to bludgeoning and immune to poison", [skeleton.kind, skeleton.maxHp, skeleton.ac, skeleton.vulnerabilities, skeleton.immunities.includes("poison")], ["skeleton", 13, 13, ["bludgeoning"], true]);
eq("an innkeeper is nobody's monster: a commoner's numbers, marked as a default", [mirela.statted, mirela.cr, mirela.xp <= 10, mirela.maxHp <= 10, mirela.ac <= 12], [false, 0, true, true, true]);

// ─── Stable: saved in the new shape, it reads back the same ──────────────────

const strip = (x: Any) => JSON.stringify({ ...x, updatedAt: 0 });
eq("normalizing the loaded game again changes nothing", strip(store.normalizeGameDocument(JSON.parse(JSON.stringify(g)), { id: g.id, personaId: g.personaId, title: g.title })), strip(g));
await store.mutateGame(g.id, () => {});
eq("saved in the new shape and read back, it is the same game", strip(store.getGame(g.id)), strip(g));

// Other old documents.
const downed: Any = store.normalizeGameDocument({ phase: "playing", players: [{ id: "h1", name: "Sela", race: "Human", className: "Cleric", level: 1, hp: 0, maxHp: 9, ac: 16, stats: {}, conditions: [] }] });
eq("an old hero at 0 hit points is unconscious, not dead, with no death saves made yet", [downed.players[0].conditions, downed.players[0].dead, downed.players[0].stable, downed.players[0].deathSaves], [["unconscious"], false, false, { successes: 0, failures: 0 }]);
const setupOld: Any = store.normalizeGameDocument({ title: "Half made", phase: "setup", round: 0, activePlayerId: null, players: [], npcs: [], items: [], locations: [], log: [], lastRoll: null });
eq("an old game still in setup stays in setup, with nobody in the spotlight", [setupOld.phase, setupOld.mode, setupOld.spotlightId, setupOld.combat], ["setup", "explore", null, null]);
const empty: Any = store.normalizeGameDocument(null);
eq("an unreadable document becomes a whole new game", [empty.phase, empty.players, empty.story.turn, empty.settings.rolls, empty.pending.check], ["setup", [], 0, "ask", null]);
const noHolder: Any = store.normalizeGameDocument({ ...OLD_GAME, activePlayerId: null });
eq("an old game with nobody active gives the spotlight to the first hero", noHolder.spotlightId, "heroBorin1");

// ─── The board ───────────────────────────────────────────────────────────────

const v: Any = view.toView(g);
const CONTRACT = view.VIEW_CONTRACT as Record<string, readonly string[]>;
eq("the old game's view carries every top-level field of the board contract", CONTRACT.top!.filter((f) => !(f in v) || v[f] === undefined), []);
eq("…and every hero field", v.players.flatMap((p: Any) => CONTRACT.player!.filter((f) => !(f in p) || p[f] === undefined)), []);
eq("the board: spotlight on Elara, no fight, no round, the goblin shown by how hurt it looks", [v.turn, v.combat, v.round, v.npcs.find((n: Any) => n.name === "Goblin").health, v.npcs.find((n: Any) => n.name === "Mirela").health], [
  { kind: "spotlight", id: "heroElara1", name: "Elara", playerName: "", isHero: true }, null, 0, "healthy", null,
]);
eq("the board: the wizard's slots", v.players.find((p: Any) => p.name === "Elara").slots, [{ level: 1, max: 4, used: 0 }, { level: 2, max: 2, used: 0 }]);

// ─── The old game plays ──────────────────────────────────────────────────────

registerGameTools();
registerStoryTools();
integration.registerGameContext();

const persona = { id: PERSONA, name: "The Game Master", description: "You are the Game Master.", voicePrompt: "You are the Game Master.", voice: "NATM1", toolsets: ["game"], traits: {}, updatedAt: Date.now() };
type Result = { ok: boolean; say?: string; speak?: string; data?: Record<string, unknown> };
async function run(tool: string, utterance: string): Promise<string> {
  const t = getTool(tool);
  if (!t) throw new Error(`no tool ${tool}`);
  const r = (await t.run({}, { persona, recentTranscript: [], emit: () => {}, utterance, memory: {} as never, situation: "" })) as Result;
  if (process.env.SHOW) console.log(`\n   > ${tool}: "${utterance}"\n   < ${(r.speak ?? r.say ?? "").trim()}`);
  check(`${tool}: answers with a line to speak verbatim`, r.ok === true && typeof r.speak === "string", r);
  return (r.speak ?? "").trim();
}
const now = (): Any => store.getGame(g.id);
function rollsWillBe(...values: number[]): { used: (name: string) => void } {
  const rng = R.scriptedRng(values);
  kit.setGameRng(rng);
  return { used: (name: string) => eq(`${name}: every scripted die was rolled, and no other`, rng.left(), 0) };
}

kit.setGameRng(R.scriptedRng([]));
const loaded = await run("game_load", "Load the Sunken Bell");
eq("loading: the old game is on the table", [store.getActiveGame(PERSONA)?.id, now().phase], [g.id, "playing"]);
has("loading: a recap from what the game knows, ending with whose go it is", loaded, "Welcome back to The Sunken Bell.", "The Flooded Nave", "Elara, what do you do?");
check("loading: a recap of at most ninety words or so", words(loaded) <= 95, words(loaded));

const whose = await run("game_answer", "Whose turn is it?");
has("whose turn: the spotlight hero, from the state", whose, "Elara");
const sheet = await run("game_answer", "What's Borin's armor class?");
has("a sheet lookup on an old hero", sheet, "18");

// Initiative: Borin 15+1, Elara 12+2, Zeph 10+2, the goblin 3+2.
let d = rollsWillBe(15, 12, 10, 3);
const fightLine = await run("game_start_combat", "The goblin attacks!");
d.used("initiative");
let cur = now();
eq("a fight starts in the old game: order rolled in code, round 1", [cur.mode, cur.combat?.round, cur.combat?.order.map((c: Any) => [c.id, c.init])], ["combat", 1, [["heroBorin1", 16], ["heroElara1", 14], ["heroZeph01", 12], ["npcGoblin1", 5]]]);
eq("no second goblin was conjured: the one already there fights", cur.npcs.filter((n: Any) => n.kind === "goblin").length, 1);
has("the fight is announced with the order and who is up", fightLine, "The order is Borin, Elara, Zeph, then the goblin", "Borin, you're up.");

// Borin: d20 14 (+5 = 19 against armor class 15, a hit), d8 1 (+3 = 4 slashing): the goblin has 3 of 7 left.
d = rollsWillBe(14, 1);
const hit = await run("game_narrate", "Borin attacks the goblin with his longsword");
d.used("the attack");
cur = now();
has("an old hero's attack is rolled in code with the readied longsword", hit, "Borin attacks the goblin with the longsword: 14 plus 5 is 19 against armor class 15, a hit for 4 slashing damage.", "Elara, you're up.");
eq("the old goblin takes the damage; the turn passes to Elara", [cur.npcs.find((n: Any) => n.name === "Goblin").hp, cur.combat.order[cur.combat.index].id, cur.lastRoll.natural === null || typeof cur.lastRoll.natural === "number"], [3, "heroElara1", true]);
eq("the board shows the goblin bloodied and the fight's order", [view.toView(cur).npcs.find((n: Any) => n.name === "Goblin").health, view.toView(cur).combat.order.map((c: Any) => c.name), view.toView(cur).turn.name], ["bloodied", ["Borin", "Elara", "Zeph", "Goblin"], "Elara"]);
check("the attack never waited on the model to decide anything (only the narrator was asked)", modelCalls.every((s) => !/intake clerk/.test(s)), modelCalls);

kit.setGameRng(R.scriptedRng([]));
const undone = await run("game_undo", "Undo that");
cur = now();
eq("undo works on the old game: the goblin is unhurt and it is Borin's turn again", [cur.npcs.find((n: Any) => n.name === "Goblin").hp, cur.combat?.order[cur.combat.index].id], [7, "heroBorin1"]);
has("undo says what was taken back", undone, "Borin");

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}.`);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
