/*
 * The board contract: what the engine sends a game screen (toView) against what the default screen reads and draws.
 *
 *   TRINITY_DATA_DIR=<fresh folder> DOTENV_CONFIG_PATH=<empty file> MORDIEM_API_KEY=test node_modules/.bin/tsx scripts/test-game-board.mts
 *
 * 1. The default template declares the view fields it reads (CONTRACT, strict JSON between two markers). That
 *    declaration must be a subset of the engine's list (view.ts VIEW_CONTRACT), and it must be honest: the template's
 *    normalizers are scanned and must read exactly the declared fields.
 * 2. toView(game) of a game in the middle of a fight must carry every field of VIEW_CONTRACT, and nothing unlisted;
 *    a creature's view must carry no numbers at all (its health is a band).
 * 3. The template's own script is run in a bare sandbox (no browser) and asked for the board's markup: the pending
 *    check banner, the initiative strip, turn and round labels, death-save and spell-slot pips, conditions with
 *    rounds, health bands, the quest log, and the natural-20 ribbon with advantage must all be there.
 * 4. A generated screen that leaves required parts out is refused, so the default is shown instead.
 *
 * Prints one line per check and ends with "ALL PASSED" or "N FAILED" (exit code 1).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

if (!process.env.TRINITY_DATA_DIR) process.env.TRINITY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "trinity-game-board-"));
if (!process.env.DOTENV_CONFIG_PATH) {
  const empty = path.join(process.env.TRINITY_DATA_DIR, "empty.env");
  writeFileSync(empty, "");
  process.env.DOTENV_CONFIG_PATH = empty;
}
process.env.MORDIEM_API_KEY ||= "test";
// Nothing here may reach a model or an image service.
globalThis.fetch = (async () => new Response("not stubbed", { status: 404 })) as typeof fetch;

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
  check(name, missing.length === 0, { missing });
};
const lacks = (name: string, text: string, ...parts: string[]) => {
  const found = parts.filter((p) => text.includes(p));
  check(name, found.length === 0, { found });
};
const sorted = (xs: Iterable<string>) => [...xs].sort();
const count = (text: string, part: string) => text.split(part).length - 1;

const store = await load("game/store.ts");
const view = await load("game/view.ts");
const present = await load("game/present.ts");
const templateGen = await load("game/template-gen.ts");

type Any = Record<string, any>;
const CONTRACT = view.VIEW_CONTRACT as Record<string, readonly string[]>;

// ─── The default template and its declaration ────────────────────────────────

const TEMPLATE_PATH = path.join(ROOT, "server/src/game/templates/default-game.html");
const template = readFileSync(TEMPLATE_PATH, "utf8");

const declaredText = /\/\*CONTRACT\*\/([\s\S]*?)\/\*END CONTRACT\*\//.exec(template)?.[1] ?? "";
let declared: Record<string, string[]> = {};
try {
  declared = JSON.parse(declaredText) as Record<string, string[]>;
  check("the default screen declares the fields it reads, as strict JSON", Object.keys(declared).length > 0);
} catch (err) {
  check("the default screen declares the fields it reads, as strict JSON", false, String(err));
}

eq("the declaration has the same parts as the engine's contract", sorted(Object.keys(declared)), sorted(Object.keys(CONTRACT)));
for (const part of Object.keys(declared)) {
  const unknown = (declared[part] ?? []).filter((f) => !(CONTRACT[part] ?? []).includes(f));
  check(`every ${part} field the screen reads is in the engine's contract`, unknown.length === 0, { unknown });
  eq(`the ${part} declaration lists no field twice`, declared[part]!.length, new Set(declared[part]).size);
}

/** The body of a top-level function of the template's script (two-space indent), up to the next one. */
function fnBody(name: string): string {
  const start = template.indexOf(`\n  function ${name}(`);
  if (start < 0) return "";
  const rest = template.slice(start + 1);
  const end = rest.slice(1).search(/\n  (?:function |var |\/\/ ──)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
/** The fields `variable.<field>` a function reads. */
function reads(fn: string, variable: string): string[] {
  const body = fnBody(fn);
  const out = new Set<string>();
  for (const m of body.matchAll(new RegExp(`(?<![\\w.$])${variable}\\.([A-Za-z_]\\w*)`, "g"))) out.add(m[1]!);
  return sorted(out);
}

// Which normalizer reads which part, and through which variable.
const NORMALIZERS: [part: string, fn: string, variable: string][] = [
  ["top", "norm", "s"],
  ["player", "normPlayer", "p"],
  ["npc", "normNpc", "n"],
  ["item", "normItem", "it"],
  ["location", "normLoc", "l"],
  ["log", "normLog", "e"],
  ["roll", "normRoll", "r"],
  ["combat", "normCombat", "c"],
  ["combatant", "normCombatant", "x"],
  ["turn", "normTurn", "t"],
  ["pendingCheck", "normPending", "pc"],
  ["quest", "normQuest", "q"],
  ["setup", "normSetup", "su"],
  ["scene", "normScene", "sc"],
];
eq("every part of the declaration has a normalizer that is checked", sorted(NORMALIZERS.map((n) => n[0])), sorted(Object.keys(declared)));
for (const [part, fn, variable] of NORMALIZERS) {
  check(`the screen has a ${fn}() normalizer`, fnBody(fn).length > 0);
  eq(`the screen's ${fn}() reads exactly the ${part} fields it declares`, reads(fn, variable), sorted(declared[part] ?? []));
}
// The builders draw from the normalized state only: nothing reads the raw view behind the normalizers' back.
const scriptCode = template.slice(template.indexOf("<script>")).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const rawReads = [...scriptCode.matchAll(/\b(?:state|raw|lastRaw)\.[A-Za-z_]\w*/g)].map((m) => m[0]);
eq("nothing but the normalizers reads the raw state", rawReads, []);

// ─── A game in the middle of a fight ─────────────────────────────────────────

const now = Date.now();
const attack = { name: "Scimitar", toHit: 4, damage: "1d6+2", damageType: "slashing" };
const fightDoc = {
  title: "The Hollow Lantern",
  genre: "dark fantasy",
  tone: "grim and hopeful",
  setting: "The lamps of Deepvein mine have gone out one by one.",
  phase: "playing",
  spotlightId: "heroMira",
  partyGold: 30,
  scene: { title: "The Lower Gallery", description: "A long gallery where the timbers drip and every lamp bracket hangs empty." },
  players: [
    {
      id: "heroThorin", name: "Thorin", playerName: "Ryan", race: "Dwarf", className: "Fighter", level: 2, hp: 0, maxHp: 20, ac: 18, speed: 25,
      stats: { str: 16, dex: 12, con: 16, int: 8, wis: 10, cha: 10 }, deathSaves: { successes: 1, failures: 2 }, gold: 15, xp: 120,
      inventory: ["itSword", "itMail", "itShield"], equipped: { weapon: "itSword", armor: "itMail", shield: "itShield" },
    },
    {
      id: "heroMira", name: "Mira", playerName: "Sam", race: "Halfling", className: "Rogue", level: 2, hp: 9, maxHp: 14, tempHp: 5, ac: 14, speed: 25,
      stats: { str: 8, dex: 17, con: 12, int: 13, wis: 10, cha: 14 }, inspiration: true, conditions: ["poisoned"], conditionRounds: { poisoned: 3 },
      inventory: ["itPotion"], equipped: { weapon: null, armor: null, shield: null }, gold: 4, xp: 120,
    },
    {
      id: "heroLyra", name: "Lyra", playerName: "Alex", race: "Elf", className: "Wizard", level: 3, hp: 12, maxHp: 14, ac: 12,
      stats: { str: 8, dex: 14, con: 12, int: 17, wis: 12, cha: 10 }, slotsMax: [4, 2, 0, 0, 0, 0, 0, 0, 0], slotsUsed: [1, 2, 0, 0, 0, 0, 0, 0, 0],
      concentration: "bless", exhaustion: 1, inventory: [], equipped: { weapon: null, armor: null, shield: null }, xp: 900,
    },
  ],
  items: [
    { id: "itSword", name: "Longsword", type: "weapon", ownerId: "heroThorin" },
    { id: "itMail", name: "Chain mail", type: "armor", ownerId: "heroThorin" },
    { id: "itShield", name: "Shield", type: "armor", ownerId: "heroThorin" },
    { id: "itPotion", name: "Potion of Healing", type: "potion", ownerId: "heroMira", quantity: 2 },
    { id: "itLens", name: "Cracked lamp lens", type: "treasure", ownerId: null },
  ],
  npcs: [
    { id: "npcGob1", name: "Goblin 1", role: "Goblin raider", attitude: "hostile", kind: "goblin", maxHp: 7, hp: 3, ac: 15, attacks: [attack], cr: 0.25, conditions: ["prone"], conditionRounds: { prone: 2 } },
    { id: "npcGob2", name: "Goblin 2", role: "Goblin raider", attitude: "hostile", kind: "goblin", maxHp: 7, hp: 0, ac: 15, attacks: [attack], cr: 0.25, status: "defeated" },
    { id: "npcWolf", name: "Grey Wolf", role: "Wolf", attitude: "hostile", kind: "wolf", maxHp: 11, hp: 4, ac: 13, attacks: [{ name: "Bite", toHit: 4, damage: "2d4+2", damageType: "piercing" }], cr: 0.25, status: "fled" },
    { id: "npcBram", name: "Old Bram", role: "Lamplighter", attitude: "friendly", description: "A stooped man who counts the lamps under his breath." },
  ],
  combat: {
    round: 2,
    index: 0,
    order: [
      { id: "heroMira", kind: "hero", init: 18, roll: 15 },
      { id: "npcGob1", kind: "npc", init: 15, roll: 13 },
      { id: "heroLyra", kind: "hero", init: 12, roll: 10 },
      { id: "heroThorin", kind: "hero", init: 5, roll: 4 },
      { id: "npcGob2", kind: "npc", init: 3, roll: 1 },
    ],
  },
  pending: {
    check: { id: "chk1", heroId: "heroMira", kind: "save", ability: "dex", skill: null, label: "Dexterity saving throw", dc: 13, adv: "dis", reason: "the floor gives way", words: "", askedAt: now, reminders: 0, endsTurn: false },
  },
  story: {
    premise: "Something in Deepvein drinks the light.",
    quests: [
      { id: "q1", title: "Relight the lamps of Deepvein", detail: "Find out why the mine went dark and bring the miners home.", status: "open" },
      { id: "q2", title: "Open the mine gate", detail: "", status: "done" },
    ],
    turn: 7,
  },
  locations: [
    { id: "loc1", name: "Deepvein Gate", x: 0.2, y: 0.5, connections: ["loc2"], visited: true },
    { id: "loc2", name: "Lower Gallery", x: 0.7, y: 0.4, connections: [], visited: true },
  ],
  currentLocationId: "loc2",
  log: [
    { id: "log1", ts: now - 60_000, kind: "narration", text: "The gate groans open." },
    { id: "log2", ts: now - 5_000, kind: "roll", text: "Mira attacks goblin 1: 20 + 5 = 25." },
  ],
  lastRoll: { id: "roll1", who: "Mira", notation: "1d20+5", rolls: [20, 7], modifier: 5, total: 25, label: "Attack with the shortsword", ts: now, adv: "adv", kept: 20, natural: 20, dc: 15, outcome: "crit" },
};

const fight: Any = store.normalizeGameDocument(fightDoc, { id: "fight", title: "The Hollow Lantern" });
const fv: Any = view.toView(fight, ["Painting the scene…"]);

eq("the fixture is a fight in round 2 on Mira's turn", [fight.phase, fight.mode, fight.combat?.round, fight.combat?.order[fight.combat.index]?.id], ["playing", "combat", 2, "heroMira"]);
eq("a defeated creature has left the turn order", fight.combat.order.map((c: Any) => c.id), ["heroMira", "npcGob1", "heroLyra", "heroThorin"]);
eq("a pending check keeps the DC it was asked at (13 is not on the easy-to-hard ladder)", fight.pending.check?.dc, 13);

// ─── toView carries the whole contract ───────────────────────────────────────

function carries(what: string, obj: Any | null | undefined, part: string, exact = false): void {
  if (!obj) return check(`the view has ${what}`, false);
  const keys = Object.keys(obj);
  const missing = CONTRACT[part]!.filter((f) => !keys.includes(f) || obj[f] === undefined);
  check(`${what} carries every ${part} field of the contract`, missing.length === 0, { missing });
  if (exact) {
    const extra = keys.filter((k) => !CONTRACT[part]!.includes(k));
    check(`${what} carries nothing outside the contract`, extra.length === 0, { extra });
  }
}
function carriesAll(v: Any, label: string): void {
  carries(`${label}: the view`, v, "top", true);
  v.players.forEach((p: Any) => carries(`${label}: hero ${p.name}`, p, "player"));
  v.npcs.forEach((n: Any) => carries(`${label}: ${n.name}`, n, "npc", true));
  v.items.forEach((it: Any) => carries(`${label}: item ${it.name}`, it, "item"));
  v.locations.forEach((l: Any) => carries(`${label}: place ${l.name}`, l, "location"));
  v.log.forEach((e: Any, i: number) => carries(`${label}: log line ${i + 1}`, e, "log", true));
  if (v.lastRoll) carries(`${label}: the last roll`, v.lastRoll, "roll", true);
  if (v.combat) {
    carries(`${label}: the fight`, v.combat, "combat", true);
    v.combat.order.forEach((c: Any) => carries(`${label}: ${c.name} in the order`, c, "combatant", true));
  }
  if (v.turn) carries(`${label}: the turn`, v.turn, "turn", true);
  if (v.pendingCheck) carries(`${label}: the pending check`, v.pendingCheck, "pendingCheck", true);
  v.quests.forEach((q: Any) => carries(`${label}: quest "${q.title}"`, q, "quest", true));
  carries(`${label}: setup`, v.setup, "setup");
  if (v.scene) carries(`${label}: the scene`, v.scene, "scene", true);
}
carriesAll(fv, "fight");
check("the fight view has every optional part filled (so each was really checked)", !!(fv.lastRoll && fv.combat && fv.turn && fv.pendingCheck && fv.scene && fv.quests.length && fv.items.length && fv.locations.length && fv.log.length));

for (const part of view.VIEW_REQUIRED_PARTS as string[]) check(`required part "${part}" is a field of the view`, CONTRACT.top!.includes(part) && part in fv);

// What the view says about the fight.
eq("the view names whose turn it is", fv.turn, { kind: "turn", id: "heroMira", name: "Mira", playerName: "Sam", isHero: true });
eq("the initiative strip is in order, with the current turn marked", fv.combat.order.map((c: Any) => [c.name, c.init, c.current, c.down]), [
  ["Mira", 18, true, false],
  ["Goblin 1", 15, false, false],
  ["Lyra", 12, false, false],
  ["Thorin", 5, false, true],
]);
eq("round and mode", [fv.round, fv.mode, fv.combat.round], [2, "combat", 2]);
eq("exactly one hero is marked as acting", fv.players.filter((p: Any) => p.isTurn).map((p: Any) => p.name), ["Mira"]);
eq("the pending check reads as the table would say it", fv.pendingCheck.text, "Mira: Dexterity save, DC 13");
eq("the pending check carries who, what, the DC and disadvantage", [fv.pendingCheck.heroId, fv.pendingCheck.label, fv.pendingCheck.dc, fv.pendingCheck.adv], ["heroMira", "Dexterity save", 13, "dis"]);
eq("conditions come with the rounds they have left", fv.players.find((p: Any) => p.name === "Mira").conditionInfo, [{ name: "poisoned", rounds: 3 }]);
eq("spell slots come as level, max and used", fv.players.find((p: Any) => p.name === "Lyra").slots, [
  { level: 1, max: 4, used: 1 },
  { level: 2, max: 2, used: 2 },
]);
eq("death saves are on the sheet of a hero at 0", fv.players.find((p: Any) => p.name === "Thorin").deathSaves, { successes: 1, failures: 2 });
eq("items say whether they are in use", fv.items.filter((it: Any) => it.equipped).map((it: Any) => it.name), ["Longsword", "Chain mail", "Shield"]);
eq("quests", fv.quests.map((q: Any) => [q.title, q.status]), [
  ["Relight the lamps of Deepvein", "open"],
  ["Open the mine gate", "done"],
]);
eq("the SRD attribution is in the view's about data", [fv.about.rules.length > 0, /System Reference Document 5\.2\.1/.test(fv.about.attribution), /Creative Commons Attribution 4\.0/.test(fv.about.attribution)], [true, true, true]);

// A creature's numbers never reach the board.
const gob: Any = fv.npcs.find((n: Any) => n.name === "Goblin 1");
eq("a hurt creature shows a health band", [gob.health, gob.status, gob.inCombat, gob.isTurn], ["bloodied", "alive", true, false]);
eq("a creature's conditions come with rounds too", gob.conditionInfo, [{ name: "prone", rounds: 2 }]);
eq("a defeated creature is marked, with no health left to read", [fv.npcs.find((n: Any) => n.name === "Goblin 2").status, fv.npcs.find((n: Any) => n.name === "Goblin 2").health], ["defeated", "down"]);
eq("a fled creature is marked", fv.npcs.find((n: Any) => n.name === "Grey Wolf").status, "fled");
eq("a peaceful stranger shows no health band", fv.npcs.find((n: Any) => n.name === "Old Bram").health, null);
const numbersIn = (v: unknown, pathTo: string): string[] =>
  typeof v === "number" ? [pathTo] : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => (k === "rounds" ? [] : numbersIn(x, `${pathTo}.${k}`))) : [];
eq("no creature's view holds a number (hit points, armor class, challenge…)", fv.npcs.flatMap((n: Any) => numbersIn(n, n.name)), []);
lacks("no creature's view names a stat-block field", JSON.stringify(fv.npcs), '"hp"', '"maxHp"', '"ac"', '"cr"', '"xp"', '"attacks"', '"stats"');

// The bands.
const bestiary = await load("game/bestiary.ts");
eq("health bands: healthy above half, bloodied at half, near death at a quarter, down at 0", [bestiary.healthBand(7, 7), bestiary.healthBand(4, 7), bestiary.healthBand(3, 6), bestiary.healthBand(2, 8), bestiary.healthBand(0, 7)], ["healthy", "healthy", "bloodied", "near death", "down"]);

// Other moments of a game.
const exploringDoc = { ...fightDoc, combat: null, pending: {}, lastRoll: null };
const exploring: Any = view.toView(store.normalizeGameDocument(exploringDoc, { id: "explore" }));
carriesAll(exploring, "exploring");
eq("outside a fight the turn is the spotlight, there is no round and no order", [exploring.turn?.kind, exploring.turn?.name, exploring.round, exploring.combat, exploring.mode], ["spotlight", "Mira", 0, null, "explore"]);
eq("outside a fight the spotlight hero is the one marked", exploring.players.filter((p: Any) => p.isTurn).map((p: Any) => p.name), ["Mira"]);

const setupGame: Any = view.toView(store.normalizeGameDocument({}, { id: "setup" }));
carriesAll(setupGame, "setup");
eq("a new game is in setup with a question to ask and nobody's turn", [setupGame.phase, setupGame.turn, setupGame.combat, setupGame.pendingCheck, typeof setupGame.setup.next], ["setup", null, null, null, "string"]);

const pausedView: Any = view.toView(store.normalizeGameDocument({ ...fightDoc, phase: "paused" }, { id: "paused" }));
eq("a paused fight keeps its order and says it is paused", [pausedView.phase, pausedView.mode, pausedView.combat?.order.length], ["paused", "paused", 4]);
const confirmView: Any = view.toView(
  store.normalizeGameDocument({ ...exploringDoc, pending: { confirm: { id: "c1", kind: "remove_player", targetId: "heroLyra", words: "remove Lyra", question: "Remove Lyra from the party?", askedAt: now } } }, { id: "confirm" }),
);
eq("a question the Game Master is waiting on reaches the board", confirmView.pendingQuestion, "Remove Lyra from the party?");

// ─── The default screen, drawn without a browser ─────────────────────────────

const script = /<script>([\s\S]*?)<\/script>/.exec(template)?.[1] ?? "";
const stubEl = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], appendChild() {}, getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }) });
/** What the screen complains about while drawing (a panel that failed says why here). */
const warnings: string[] = [];
// The least a page offers: enough for the script to load. Nothing is laid out or painted — only the markup is read.
const sandbox: Any = {
  console: { warn: (...a: unknown[]) => warnings.push(a.map(String).join(" ")), log() {}, error() {} },
  setTimeout: () => 0,
  clearTimeout() {},
  document: { getElementById: stubEl, documentElement: stubEl(), createElement: () => ({ innerHTML: "", content: {} }), addEventListener() {} },
  addEventListener() {},
  matchMedia: () => ({ matches: false }),
  innerWidth: 1400,
  innerHeight: 900,
};
sandbox.window = sandbox;
let screen: Any = null;
try {
  vm.runInContext(script, vm.createContext(sandbox), { filename: "default-game.html" });
  screen = sandbox.__gameScreen;
} catch (err) {
  check("the default screen's script loads in a bare sandbox", false, String(err));
}
check("the default screen exposes its contract, its normalizer and its markup builder", !!screen && typeof screen.html === "function" && typeof screen.norm === "function" && typeof sandbox.render === "function");
eq("the contract the running screen exposes is the one it declares", screen?.contract, declared);

const WIDE = { L: "wide", free: false, tiny: false, h: 900 };
const NARROW = { L: "narrow", free: false, tiny: true, h: 800 };
const draw = (v: unknown, layout: Any = WIDE): string => {
  try {
    return String(screen.html(v, layout));
  } catch (err) {
    return `THREW ${String(err)}`;
  }
};
/**
 * The markup of one keyed element. A panel ("roll", "strip", "hdr"…) runs to the next panel; an entity ("p:<id>",
 * "n:<id>"…) runs to the next entity of its kind, or to the end of the panel that holds it.
 */
const piece = (html: string, key: string): string => {
  const at = html.indexOf(`data-k="${key}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  const rest = html.slice(at + 1);
  const ends: number[] = [];
  if (key.includes(":")) {
    const prefix = key.slice(0, key.indexOf(":") + 1);
    ends.push(rest.search(new RegExp(`<(?:article|li|span)[^>]*data-k="${prefix}`)), rest.indexOf("</section>"), rest.indexOf('<div class="pend'));
  } else {
    ends.push(rest.search(/<(?:section|header|main|div class="(?:strip|col)[^"]*")[^>]*data-k="/));
  }
  const end = Math.min(...ends.filter((n) => n >= 0), rest.length);
  return html.slice(start, at + 1 + end);
};
const noFailure = (name: string, html: string) => check(name, html.length > 500 && !html.includes("could not be drawn") && !html.startsWith("THREW") && !/\bundefined\b|\bNaN\b|\[object Object\]/.test(html), html.startsWith("THREW") ? html : { warnings });

const board = draw(fv);
noFailure("the fight draws: every panel, no undefined, no NaN", board);
const PIECES = ["hdr", "strip", "party", "p:heroThorin", "p:heroMira", "p:heroLyra", "scene", "quests", "log", "roll", "npcs", "n:npcGob1", "n:npcGob2", "n:npcBram", "items"];
eq("every part looked at below is on the board", PIECES.filter((k) => !piece(board, k)), []);
check("a hero's card ends where the next begins", !piece(board, "p:heroThorin").includes("Mira") && !piece(board, "p:heroMira").includes("Lyra") && !piece(board, "p:heroLyra").includes("Lower Gallery"));
// SHOW=1 prints the markup of each part, to read what the table would see.
if (process.env.SHOW) for (const k of PIECES) console.log(`\n── ${k} ──\n${piece(board, k)}`);

// The turn strip.
const strip = piece(board, "strip");
has("the pending check banner reads “Mira: Dexterity save, DC 13”", strip, 'class="pend"', "Mira: Dexterity save, DC 13", "Disadvantage");
has("the strip shows the round", strip, "<small>Round</small><b>2</b>");
eq("the initiative strip lists who acts, in order", [...strip.matchAll(/class="ini-n">([^<]*)</g)].map((m) => m[1]), ["Mira", "Goblin 1", "Lyra", "Thorin"]);
eq("initiative numbers are on the strip", [...strip.matchAll(/class="ini-v">(-?\d+)</g)].map((m) => Number(m[1])), [18, 15, 12, 5]);
eq("exactly the current turn is highlighted on the strip", [...strip.matchAll(/class="ini-c([^"]*)"[^>]*><b[^>]*>\d+<\/b><span class="ini-n">([^<]*)</g)].filter((m) => m[1]!.includes("is-cur")).map((m) => m[2]), ["Mira"]);
has("a hero at 0 is struck out on the strip, a creature is marked as one", strip, "is-down", "is-npc");

// The header: the phase, and no round outside the strip.
const header = piece(board, "hdr");
has("the header says a fight is on", header, "ph-fight", "Combat");
lacks("the header no longer shows a round of its own", header, "Round");
has("the header credits the rules (SRD, CC BY 4.0) in its tooltip", header, "chip rules", "System Reference Document 5.2.1");

// Hero cards.
const mira = piece(board, "p:heroMira");
const thorin = piece(board, "p:heroThorin");
const lyra = piece(board, "p:heroLyra");
has("the hero whose turn it is is highlighted, and asked for the roll", mira, "is-active", "is-asked", '<span class="turn ask">Roll</span>');
lacks("only that hero is highlighted", thorin + lyra, "is-active", "is-asked", 'class="turn');
has("a hero's hit points are numbers with a bar, temporary ones beside them", mira, 'class="hp"', "9<small> / 14</small>", "<em>+5</em>");
has("conditions show the rounds they have left", mira, "poisoned<small>3 rds</small>");
has("inspiration and who plays the hero are on the card", mira, "Inspired", "Sam");
has("a stack of potions shows its count", mira, "Potion of Healing ×2");
has("a hero at 0 shows death saves", thorin, "is-down", "Death saves", "0<small> / 20</small>");
eq("death-save pips: one success, two failures, of three each", [count(thorin, "pip ds-ok on"), count(thorin, "pip ds-ok"), count(thorin, "pip ds-bad sq on"), count(thorin, "pip ds-bad sq")], [1, 3, 2, 3]);
lacks("a standing hero shows no death saves", mira + lyra, "Death saves");
has("a caster shows spell slots", lyra, "Spell slots");
eq("spell-slot pips: three of four first-level slots left, none of two second-level", [count(lyra, "pip slot on"), count(lyra, "pip slot")], [3, 6]);
has("concentration and exhaustion are on the card", lyra, "Concentrating: bless", "Exhaustion<small>1</small>");
has("what a hero holds ready is marked", thorin, 'eq"><i></i><span>Longsword', 'eq"><i></i><span>Chain mail', 'eq"><i></i><span>Shield');

// The last roll.
const roll = piece(board, "roll");
has("a natural 20 with advantage gets its ribbon", roll, 'class="roll crit"', '<span class="ribbon">Natural 20!</span>');
has("both d20s are shown: the one that counts ringed, the other struck out", roll, 'class="rb max kept">20<', 'class="rb drop">7<', "Advantage");
has("the roll shows its total, modifier, who rolled and how it went", roll, ">25</span>", "+ 5", "<b>Mira</b>", "Attack with the shortsword", "Critical hit · AC 15");

const rollOf = (lastRoll: Any) => piece(draw({ ...fv, lastRoll: { id: "x", who: "Mira", label: "Roll", ts: now, adv: null, kept: null, natural: null, dc: null, outcome: null, ...lastRoll } }), "roll");
const disTwenty = rollOf({ notation: "1d20+5", rolls: [20, 7], modifier: 5, total: 12, adv: "dis", kept: 7, natural: 7, dc: 15, outcome: "miss" });
lacks("a 20 that did not count (disadvantage) gets no ribbon", disTwenty, "ribbon", 'class="roll crit"');
has("…and shows the 20 struck out, the 7 kept", disTwenty, 'class="rb max drop">20<', 'class="rb kept">7<', "Disadvantage", "Miss · AC 15");
const disOne = rollOf({ notation: "1d20+2", rolls: [1, 14], modifier: 2, total: 3, adv: "dis", kept: 1, natural: 1, dc: 10, outcome: "failure" });
has("a natural 1 with disadvantage gets its ribbon", disOne, 'class="roll fumble"', "Natural 1", "Failure · DC 10");
const plainTwenty = rollOf({ notation: "1d20+3", rolls: [20], modifier: 3, total: 23, kept: 20, natural: 20, dc: 15, outcome: "success" });
has("a plain natural 20 gets its ribbon", plainTwenty, "Natural 20!", "Success · DC 15");
lacks("…with no advantage label", plainTwenty, "Advantage", "Disadvantage");
const damage = rollOf({ notation: "2d6+3", rolls: [1, 6], modifier: 3, total: 10, label: "Longsword damage" });
lacks("damage dice get no natural-1 or natural-20 ribbon", damage, "ribbon", "fumble", "crit");
const twoTwenties = rollOf({ notation: "2d20", rolls: [20, 20], modifier: 0, total: 40 });
lacks("two d20s rolled as plain dice are not a critical", twoTwenties, "ribbon");
const oldRoll = piece(draw({ ...fv, lastRoll: { id: "old", who: "Mira", notation: "1d20", rolls: [20], modifier: 0, total: 20, label: null, ts: now } }), "roll");
has("a roll saved before `natural` existed still gets its ribbon from a lone d20", oldRoll, "Natural 20!");

// Creatures.
const npcs = piece(board, "npcs");
const gobRow = piece(board, "n:npcGob1");
has("a creature's health is a band with a bar", gobRow, "band b-bloodied", "Bloodied", 'style="width:50%"', "prone<small>2 rds</small>");
lacks("a creature's hit points and armor class are nowhere in its row", gobRow, "3 / 7", "3/7", ">7<", ">15<", "AC", "HP");
has("the fallen and the fled are marked", npcs, "is-out", "Defeated", "Fled");
check("whoever is in the fight is listed first, the fallen and fled last", npcs.indexOf("Goblin 1") < npcs.indexOf("Old Bram") && npcs.indexOf("Old Bram") < npcs.indexOf("Goblin 2") && npcs.indexOf("Old Bram") < npcs.indexOf("Grey Wolf"));
has("a stranger keeps their description and attitude", piece(board, "n:npcBram"), "counts the lamps", "Friendly");
const gobTurn = draw({ ...fv, combat: { ...fv.combat, order: fv.combat.order.map((c: Any) => ({ ...c, current: c.id === "npcGob1" })) }, turn: { kind: "turn", id: "npcGob1", name: "Goblin 1", playerName: "", isHero: false }, players: fv.players.map((p: Any) => ({ ...p, isTurn: false })), npcs: fv.npcs.map((n: Any) => ({ ...n, isTurn: n.id === "npcGob1" })), pendingCheck: null });
has("on a creature's turn its row is highlighted", piece(gobTurn, "n:npcGob1"), "is-turn", '<span class="att">Turn</span>');
check("…and no hero is", piece(gobTurn, "party").includes("Thorin") && !/is-active|class="turn/.test(piece(gobTurn, "party")));

// Quests, scene, items, log.
const quests = piece(board, "quests");
has("the quest log lists open and finished quests", quests, "Quests", "Relight the lamps of Deepvein", "Find out why the mine went dark", "quest q-done", "Open the mine gate");
has("the current scene is on the board", piece(board, "scene"), "The Lower Gallery", "every lamp bracket hangs empty");
has("items show counts, who holds them, what is in use, and the shared gold", piece(board, "items"), 'Potion of Healing<small class="qty">×2</small>', "Longsword", "in use", "Party loot: 30 gp", "Cracked lamp lens");
has("the log is on the board, newest first", piece(board, "log"), "Mira attacks goblin 1", "The gate groans open.");

// Turn and spotlight labels.
const noAsk = draw({ ...fv, pendingCheck: null });
has("in a fight the acting hero's badge says Turn", piece(noAsk, "p:heroMira"), '<span class="turn">Turn</span>');
lacks("with no roll pending there is no banner", piece(noAsk, "strip"), 'class="pend"');
const exploringBoard = draw(exploring);
noFailure("exploring draws", exploringBoard);
has("outside a fight the badge says Spotlight", piece(exploringBoard, "p:heroMira"), '<span class="turn spot">Spotlight</span>');
lacks("outside a fight there is no strip, no round and no Turn badge", exploringBoard, 'data-k="strip"', "Round", '<span class="turn">Turn</span>');
has("outside a fight the header says Playing", piece(exploringBoard, "hdr"), "ph-play", "Playing");
const askBoard = draw(confirmView);
has("a question the Game Master is waiting on is shown", piece(askBoard, "strip"), "pend ask", "Remove Lyra from the party?");

// Other phases and layouts.
const setupBoard = draw(setupGame);
noFailure("a new game draws", setupBoard);
has("setup shows its steps and the next question", setupBoard, "ph-setup", "Setting up your adventure", esc(setupGame.setup.next));
lacks("setup has no turn strip", setupBoard, 'data-k="strip"');
has("a paused game says so and keeps the order", draw(pausedView), "ph-paused", "Paused", 'class="init"');
has("an ended game says so", draw({ ...exploring, phase: "ended" }), "ph-ended", "The end");
const narrow = draw(fv, NARROW);
noFailure("the narrow layout draws", narrow);
has("the narrow layout keeps the banner, the order, the quests and the party", narrow, "Mira: Dexterity save, DC 13", 'class="init"', "Relight the lamps of Deepvein", 'data-k="p:heroThorin"', 'data-k="board-n"');

// Whatever arrives, the screen draws.
for (const [name, state] of [
  ["nothing", undefined],
  ["null", null],
  ["an empty object", {}],
  ["garbage", { players: [null, 5, {}, { id: 7, slots: "x", deathSaves: 3, conditionInfo: [null, { name: 4 }] }], npcs: "x", items: [{}], combat: { order: [{}, null, { id: "a" }] }, lastRoll: { rolls: "a", natural: "20" }, pendingCheck: {}, quests: [null, {}], turn: 5, scene: "x", setup: 3, about: 1, phase: "nope" }],
  ["a state from before the turn model", { title: "Old", phase: "playing", round: 3, activePlayerId: "p1", players: [{ id: "p1", name: "Aria", hp: 5, maxHp: 10, conditions: ["blessed"] }], npcs: [{ id: "n1", name: "Guard", attitude: "neutral" }], lastRoll: { notation: "1d20+2", rolls: [1], modifier: 2, total: 3 } }],
] as [string, unknown][]) {
  noFailure(`the screen draws ${name}`, draw(state));
}
const oldBoard = draw({ title: "Old", phase: "playing", round: 3, activePlayerId: "p1", players: [{ id: "p1", name: "Aria", hp: 5, maxHp: 10, conditions: ["blessed"] }], npcs: [{ id: "n1", name: "Guard", attitude: "neutral" }], lastRoll: { notation: "1d20+2", rolls: [1], modifier: 2, total: 3 } });
has("an old state still marks its active hero, shows its conditions and its natural 1", oldBoard, "is-active", "Spotlight", "blessed", "Natural 1");
lacks("an old state claims no round (it has no fight)", oldBoard, "Round");

// Text from the game is escaped.
const hostile = draw({ ...fv, title: '<img src=x onerror="alert(1)">', players: [{ ...fv.players[0], name: "<script>alert(2)</script>" }], pendingCheck: { ...fv.pendingCheck, text: "<b>x</b>" }, quests: [{ id: "q", title: "<i>q</i>", detail: "", status: "open" }] });
lacks("state text is escaped everywhere", hostile, "<img src=x", "<script>alert(2)", "<b>x</b>", "<i>q</i>");

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

// ─── One self-contained file ─────────────────────────────────────────────────

const EXTERNAL: [RegExp, string][] = [
  [/<script\b[^>]*\bsrc\s*=/i, "<script src>"],
  [/<link\b/i, "<link>"],
  [/@import\b/i, "CSS @import"],
  [/@font-face/i, "a web font"],
  [/\bfetch\s*\(/, "fetch()"],
  [/XMLHttpRequest|WebSocket|EventSource|sendBeacon/, "network APIs"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/url\(\s*['"]?\s*(?:https?:)?\/\//i, "external url()"],
  [/\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i, "external src/href"],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, "storage"],
];
eq("the default screen is one self-contained file: no external resources, no network, no storage", EXTERNAL.filter(([re]) => re.test(template)).map(([, what]) => what), []);
eq("the default screen has one script and one render entry point", [count(template, "<script"), count(template, "window.render =")], [1, 1]);

// ─── Which screen gets used ──────────────────────────────────────────────────

eq("the default screen draws every required part", view.missingViewParts(template), []);
check("the default screen on disk is the one presented", present.defaultTemplateSource().builtin === false && present.defaultTemplateSource().source === template);
eq("the built-in fallback screen draws every required part too", view.missingViewParts(present.FALLBACK_TEMPLATE), []);
// …and really draws them: its script is run the same way and handed the fight.
const fallbackApp: Any = { innerHTML: "" };
const fallbackBox: Any = { document: { getElementById: () => fallbackApp, documentElement: { style: { setProperty() {} } } } };
fallbackBox.window = fallbackBox;
let fallbackHtml = "";
try {
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(present.FALLBACK_TEMPLATE)?.[1] ?? "", vm.createContext(fallbackBox), { filename: "fallback-template.js" });
  for (const state of [undefined, {}, setupGame, exploring, pausedView, fv]) fallbackBox.render(state);
  fallbackHtml = String(fallbackApp.innerHTML);
} catch (err) {
  fallbackHtml = `THREW ${String(err)}`;
}
has("the fallback screen shows the fight: the roll waited for, the order and round, the turn, death saves, slots, a health band, the quests", fallbackHtml, "Mira: Dexterity save, DC 13", "Initiative", "Round 2", '<span class="chip">Turn</span>', "death saves", "Slots", "bloodied", "Relight the lamps of Deepvein");
lacks("…without throwing, and with nothing undefined on it", fallbackHtml, "THREW", "undefined", "NaN");
lacks("…and without a creature's numbers", fallbackHtml, "3/7", "AC 15");

// A screen generated before the turn model: it draws the party, the scene, the log and the last roll, and nothing else.
const OLD_SCREEN = `<style>
body{margin:0;background:#111;color:#eee;font:15px/1.5 Georgia,serif}
#app{padding:18px;display:grid;gap:12px;grid-template-columns:minmax(220px,1fr) minmax(300px,2fr)}
.card{border:1px solid #333;border-radius:12px;padding:12px;min-width:0;background:#191919}
h1{margin:0;font-size:26px;line-height:1.2}
h2{margin:0 0 8px;font-size:18px;color:#d9a441}
p{margin:6px 0 0;color:#bbb}
</style>
<div id="app"></div>
<script>
(function(){
var esc=(window.trinity&&window.trinity.esc)||function(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});};
function A(v){return Array.isArray(v)?v:[];}
window.render=function(state){
var s=state||{},h='<div class="card"><h1>'+esc(s.title)+'</h1><p>Round '+esc(s.round||1)+'</p></div>';
h+='<div class="card">'+A(s.players).map(function(p){return'<div'+(p.id===s.activePlayerId?' style="outline:1px solid gold"':'')+'><b>'+esc(p.name)+'</b> HP '+esc(p.hp)+'/'+esc(p.maxHp)+' AC '+esc(p.ac)+' '+A(p.conditions).map(esc).join(", ")+'</div>';}).join("")+'</div>';
h+='<div class="card">'+A(s.npcs).map(function(n){return'<div><b>'+esc(n.name)+'</b> '+esc(n.role)+' '+esc(n.attitude)+'</div>';}).join("")+'</div>';
h+='<div class="card">'+(s.scene?'<h2>'+esc(s.scene.title)+'</h2><p>'+esc(s.scene.description)+'</p>':'')+'</div>';
h+='<div class="card">'+A(s.log).slice(-30).map(function(e){return'<div>'+esc(e.text)+'</div>';}).join("")+'</div>';
h+='<div class="card">'+(s.lastRoll?esc(s.lastRoll.total)+' '+esc(s.lastRoll.notation):'')+'</div>';
h+='<div class="card">'+A(s.items).map(function(it){return'<div>'+esc(it.name)+'</div>';}).join("")+'</div>';
document.getElementById("app").innerHTML=h;
};
})();
</script>`;
eq("a screen from before the turn model is missing the fight, the turn, the pending roll and the quests", view.missingViewParts(OLD_SCREEN), ["combat", "turn", "pendingCheck", "quests"]);
eq("…so it is not used: the default screen is shown instead", present.customTemplateUsable(OLD_SCREEN), false);
const oldCheck = templateGen.validateTemplate(OLD_SCREEN) as { ok: boolean; reason?: string };
check("…and a newly generated screen like it is refused", oldCheck.ok === false && /state\.combat/.test(oldCheck.reason ?? ""), oldCheck);
const NEW_SCREEN = OLD_SCREEN.replace(
  `document.getElementById("app")`,
  `h+='<div class="card">'+(s.combat?'Round '+esc(s.combat.round)+': '+A(s.combat.order).map(function(c){return esc(c.name);}).join(", "):'')+(s.turn?' '+esc(s.turn.name):'')+(s.pendingCheck?' '+esc(s.pendingCheck.text):'')+A(s.quests).map(function(q){return esc(q.title);}).join(", ")+'</div>';\ndocument.getElementById("app")`,
);
eq("a screen that draws every required part is usable", [view.missingViewParts(NEW_SCREEN), present.customTemplateUsable(NEW_SCREEN), templateGen.validateTemplate(NEW_SCREEN).ok], [[], true, true]);

// The brief a screen is generated from asks for every required part, and its example state carries them.
const prompt = templateGen.templatePrompt(fight) as { system: string; user: string };
const briefMissing = (view.VIEW_REQUIRED_PARTS as string[]).filter((part) => !prompt.user.includes(part));
check("the design brief for generated screens names every required part", briefMissing.length === 0, { briefMissing });

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}.`);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
