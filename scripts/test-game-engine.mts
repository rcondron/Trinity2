/*
 * The game engine on real game documents, with every die scripted: the parts of a fight and of an adventuring day
 * that the scripted session (test-game-session.mts) does not reach.
 *
 *   TRINITY_DATA_DIR=<fresh folder> DOTENV_CONFIG_PATH=<empty file> MORDIEM_API_KEY=test node_modules/.bin/tsx scripts/test-game-engine.mts
 *
 * Dying and death (three failures, a natural 1, a natural 20, the turn order closing up behind the dead), a party
 * wiped out, experience and levels, rests, equipment and armor class, buying and selling, potions, creatures that
 * flee or are talked down, opportunity attacks, breath weapons, bites that knock down or poison, resistances and
 * vulnerabilities, regeneration, whom a monster picks, surprise, conditions on both sides, spells (slots, saves,
 * upcasting, concentration and what ends with it), delaying, the spotlight, the encounter builder through its tool,
 * and the bounded undo history.
 *
 * Each scenario builds a game document, runs the engine's own functions (or the real tools) on it with a scripted
 * die, and checks the state and the spoken lines. A die script that is too short, too long, or holds a value the die
 * asked for cannot show fails the scenario: the code and the script must agree on every roll.
 *
 * Prints one line per check and ends with "ALL PASSED" or "N FAILED" (exit code 1).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_DATA_DIR) process.env.TRINITY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "trinity-game-engine-"));
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
const has = (name: string, text: string | string[], ...parts: string[]) => {
  const t = Array.isArray(text) ? text.join(" ") : text;
  const missing = parts.filter((p) => !t.includes(p));
  check(name, missing.length === 0, { missing, text: t });
};
const lacks = (name: string, text: string | string[], ...parts: string[]) => {
  const t = Array.isArray(text) ? text.join(" ") : text;
  const found = parts.filter((p) => t.includes(p));
  check(name, found.length === 0, { found, text: t });
};

// The model is never needed here; if something asks, it gets an empty answer and an image a pixel wide.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const modelCalls: string[] = [];
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/images/generations")) return jsonResponse({ data: [{ b64_json: TINY_PNG }] });
  if (!url.endsWith("/chat/completions")) return new Response("not stubbed", { status: 404 });
  const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
  modelCalls.push((body.messages?.find((m) => m.role === "system")?.content ?? "").slice(0, 60));
  return jsonResponse({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
}) as typeof fetch;

const R = await load("game/rules.ts");
const E = await load("game/engine.ts");
const B = await load("game/bestiary.ts");
const S = await load("game/srd.ts");
const store = await load("game/store.ts");
const kit = await load("game/kit.ts");
const view = await load("game/view.ts");
const { registerGameTools } = await load("game/tools.ts");
const { registerStoryTools } = await load("game/story-tools.ts");
const { getTool } = await load("tools/registry.ts");

type Any = Record<string, any>;
type Dice = ((sides: number) => number) & { left(): number };

// ─── Building a table ────────────────────────────────────────────────────────

const STATS = { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 };
/** A hero's saved sheet. By default a level 1 human fighter with a longsword in hand: +5 to hit, 1d8+3, AC 14, 12 hit points. */
function heroDoc(id: string, name: string, className = "Fighter", extra: Any = {}): Any {
  return { id, name, playerName: "", race: "Human", className, level: 1, hp: 12, maxHp: 12, ac: 14, speed: 30, stats: { ...STATS }, conditions: [], inventory: [`sw${id}`], equipped: { weapon: `sw${id}`, armor: null, shield: null }, ...extra };
}
const swordDoc = (heroId: string): Any => ({ id: `sw${heroId}`, name: "Longsword", type: "weapon", ownerId: heroId });
let tables = 0;
/** A game in play (dice rolled by the Game Master unless said otherwise), not stored anywhere: the engine works on the document. */
function table(heroDocs: Any[], extra: Any = {}): Any {
  const items = [...heroDocs.filter((h) => h.inventory?.includes(`sw${h.id}`)).map((h) => swordDoc(h.id)), ...(extra.items ?? [])];
  return store.normalizeGameDocument({ title: "Test table", phase: "playing", settings: { rolls: "auto" }, players: heroDocs, ...extra, items }, { id: `table${++tables}` });
}
const hero = (g: Any, name: string): Any => g.players.find((p: Any) => p.name === name);
const order = (g: Any): string[] => (g.combat?.order ?? []).map((c: Any) => (c.kind === "hero" ? g.players.find((p: Any) => p.id === c.id)?.name : g.npcs.find((n: Any) => n.id === c.id)?.name));
const onTurn = (g: Any): string | null => order(g)[g.combat?.index ?? -1] ?? null;
const monster = (key: string) => B.BESTIARY[key];

/** Run a step with scripted dice; afterwards they must all have been rolled, in that order. */
function roll<T>(name: string, values: number[], fn: (rng: Dice) => T): T {
  const rng = R.scriptedRng(values) as Dice;
  const out = fn(rng);
  eq(`${name}: every scripted die was rolled, and no other`, rng.left(), 0);
  return out;
}
const NO_DICE = (): Dice => R.scriptedRng([]) as Dice;

async function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    check(`${name}: runs to the end`, false, err instanceof Error ? `${err.message}\n${(err.stack ?? "").split("\n").slice(1, 4).join("\n")}` : String(err));
  }
}

// ═══ Dying ═══════════════════════════════════════════════════════════════════

await scenario("death saves rolled by the Game Master", () => {
  const g = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea")]);
  const [gob] = E.spawn(g, monster("goblin"), 1);
  // Initiative: Aldo 20+2, Bea 10+2, the goblin 5+2.
  const start = roll("initiative", [20, 10, 5], (rng) => E.startCombat(g, rng));
  eq("a fight starts: the order by initiative, round 1, Aldo up", [order(g), g.combat.order.map((c: Any) => c.init), g.combat.round, onTurn(g)], [["Aldo", "Bea", "Goblin"], [22, 12, 7], 1, "Aldo"]);
  has("…and it is said", start.lines, "The order is Aldo, Bea, then the goblin.", "Aldo, you're up.");

  const aldo = hero(g, "Aldo");
  const drop = E.hurtHero(g, NO_DICE(), aldo, 12, "slashing");
  eq("a hero taken to 0 falls unconscious and starts dying", [aldo.hp, aldo.conditions, aldo.deathSaves, aldo.dead, drop.result.dropped], [0, ["unconscious"], { successes: 0, failures: 0 }, false, true]);
  has("…and it is said", drop.state, "Aldo drops to 0 hit points and falls unconscious.");

  has("the turn passes to the next hero", roll("pass to Bea", [], (rng) => E.advanceTurn(g, rng)), "Bea, you're up.");

  // The goblin attacks Bea (2+4 = 6, a miss); a new round; Aldo's death save: 5, a failure.
  let lines = roll("round 2", [2, 5], (rng) => E.advanceTurn(g, rng));
  has("a monster never attacks a hero who is down: it goes for Bea", lines, "The goblin attacks Bea: 6 against armor class 14, a miss.");
  has("a death save below 10 fails", lines, "Aldo's death save: 5, a failure. That is 0 successes and 1 failure.", "Bea, you're up.");
  eq("…one failure marked, round 2, Bea up", [aldo.deathSaves, g.combat.round, onTurn(g)], [{ successes: 0, failures: 1 }, 2, "Bea"]);
  eq("the death save is the last roll on the board", [g.lastRoll.who, g.lastRoll.label, g.lastRoll.total, g.lastRoll.dc, g.lastRoll.outcome], ["Aldo", "Death saving throw", 5, 10, "failure"]);

  // The goblin misses again; Aldo rolls a natural 1: two failures, the third.
  lines = roll("round 3", [3, 1], (rng) => E.advanceTurn(g, rng));
  has("a natural 1 is two failures, and the third failure kills", lines, "Aldo's death save: a natural 1, two failures. That is the third: Aldo dies.", "Bea, you're up.");
  eq("the dead hero leaves the order, and the turn falls to whoever followed", [aldo.dead, aldo.conditions, order(g), onTurn(g), g.combat.round, g.combat.vacant], [true, [], ["Bea", "Goblin"], "Bea", 3, false]);

  // Bea: 15+5 = 20 against 15, a hit; 8+3 = 11 damage: the goblin had 7.
  const hit = roll("the killing blow", [15, 8], (rng) => E.heroAttack(g, rng, hero(g, "Bea"), gob, {}));
  has("an attack is said with its sum, the armor class and the damage", hit.lines, "Bea attacks the goblin with the longsword: 15 plus 5 is 20 against armor class 15, a hit for 11 slashing damage.", "The goblin is defeated.");
  // Treasure: 3 and 4 on two d6, and a 17 on the d20 for a potion.
  const end = roll("the end of the fight", [3, 4, 17], (rng) => E.settleFight(g, rng));
  has("the fight ends when the last foe falls: XP for the living, and what the foes carried", end, "The fight is over.", "Bea earns 50 experience points.", "Among their things: 7 gold and a potion of healing");
  eq("…the dead earn nothing; the loot is the party's", [g.combat, g.mode, hero(g, "Bea").xp, aldo.xp, g.partyGold, g.items.filter((it: Any) => it.name === "Potion of Healing" && it.ownerId === null).length, g.spotlightId], [null, "explore", 50, 0, 7, 1, "hB"]);
});

await scenario("damage to a hero who is already down", () => {
  const g = table([heroDoc("hA", "Aldo", "Fighter", { hp: 0, conditions: ["unconscious"] })]);
  const aldo = hero(g, "Aldo");
  const one = E.hurtHero(g, NO_DICE(), aldo, 3, "piercing");
  eq("damage at 0 hit points is a death save failure", [one.result.failuresAdded, aldo.deathSaves.failures, aldo.dead], [1, 1, false]);
  has("…said as such", one.state, "Aldo, already down, takes 1 death save failure: 1 of 3.");
  const two = E.hurtHero(g, NO_DICE(), aldo, 3, "piercing", { crit: true });
  eq("a critical hit on a downed hero is two failures: the third kills", [two.result.failuresAdded, aldo.deathSaves.failures, aldo.dead], [2, 3, true]);
  has("…said as such", two.state, "takes 2 more death save failures and dies");

  const h = table([heroDoc("hB", "Bea", "Fighter", { hp: 4 })]);
  const bea = hero(h, "Bea");
  const crushed = E.hurtHero(h, NO_DICE(), bea, 16, "bludgeoning");
  eq("damage that leaves a full hit point maximum over at 0 kills outright", [crushed.result.instantDeath, bea.dead, bea.hp], [true, true, 0]);
  has("…said as such", crushed.state, "Bea is killed outright.");
  const k = table([heroDoc("hC", "Cade", "Fighter", { hp: 4 })]);
  const cade = hero(k, "Cade");
  E.hurtHero(k, NO_DICE(), cade, 15, "bludgeoning");
  eq("one point less and the hero is only down", [cade.dead, cade.hp, cade.conditions], [false, 0, ["unconscious"]]);

  const t = table([heroDoc("hD", "Dara", "Fighter", { hp: 10, tempHp: 5 })]);
  const dara = hero(t, "Dara");
  const soaked = E.hurtHero(t, NO_DICE(), dara, 8, "fire");
  eq("temporary hit points are lost first", [soaked.result.absorbed, dara.tempHp, dara.hp], [5, 0, 7]);
  has("…and the hero's own hit points are what is said", soaked.state, "Dara has 7 hit points left.");
});

await scenario("the party is wiped out", () => {
  const g = table([heroDoc("hC", "Cade", "Fighter", { hp: 3 })]);
  E.spawn(g, monster("goblin"), 1);
  // Initiative: Cade 1+2, the goblin 20+2. The goblin goes first: 15+4 = 19, a hit, 4+2 = 6 damage.
  const start = roll("the goblin strikes first", [1, 20, 15, 4], (rng) => E.startCombat(g, rng));
  has("a monster that wins initiative acts at once", start.lines, "The goblin attacks Cade: 19 against armor class 14, a hit for 6 slashing damage. Cade drops to 0 hit points and falls unconscious.");
  has("when the last hero falls the fight is lost", start.lines, "The last hero falls. The fight is lost.");
  const cade = hero(g, "Cade");
  eq("…the fight is over, the fallen lie stable, nobody holds the spotlight", [g.combat, g.mode, cade.hp, cade.stable, cade.dead, g.spotlightId], [null, "explore", 0, true, false, null]);
});

// ═══ Experience and levels ═══════════════════════════════════════════════════

await scenario("experience and levels", () => {
  const g = table([
    heroDoc("hW", "Wren", "Wizard", { level: 2, xp: 850, hp: 10, maxHp: 10, stats: { ...STATS, con: 12, int: 16 }, inventory: [] , equipped: { weapon: null, armor: null, shield: null } }),
    heroDoc("hF", "Finn", "Fighter", { xp: 250, hp: 5 }),
  ]);
  const wren = hero(g, "Wren");
  const finn = hero(g, "Finn");
  eq("a second-level wizard has three first-level slots", wren.slotsMax.slice(0, 3), [3, 0, 0]);
  const lines = E.awardXp(g, 200);
  eq("XP is shared evenly", [wren.xp, finn.xp], [950, 350]);
  eq("a wizard reaching 900 XP is level 3: a d6's average plus Constitution more hit points, second-level slots, new spells", [wren.level, wren.maxHp, wren.hp, wren.slotsMax.slice(0, 3), wren.spells.includes("scorching ray")], [3, 15, 15, [4, 2, 0], true]);
  eq("a fighter reaching 300 XP is level 2: a d10's average plus Constitution more hit points", [finn.level, finn.maxHp, finn.hp], [2, 20, 13]);
  eq("…and it is said, once each", lines, ["Each of you earns 100 experience points.", "Wren reaches level 3.", "Finn reaches level 2."]);

  g.settings.leveling = "milestone";
  E.awardXp(g, 100000);
  eq("with milestone leveling XP never levels anyone", [wren.level, finn.level, wren.xp > 50000], [3, 2, true]);

  const solo = table([heroDoc("hS", "Sula")]);
  E.awardXp(solo, 6500);
  eq("a big award can carry a hero several levels: 6500 XP is level 5", [hero(solo, "Sula").level, hero(solo, "Sula").maxHp], [5, 12 + 4 * 8]);

  const mixed = table([heroDoc("hX", "Xan"), heroDoc("hY", "Yul", "Fighter", { dead: true, hp: 0 })]);
  eq("the dead take no share", [E.awardXp(mixed, 100), hero(mixed, "Xan").xp, hero(mixed, "Yul").xp], [["Xan earns 100 experience points."], 100, 0]);
});

// ═══ Rests ═══════════════════════════════════════════════════════════════════

await scenario("rests", () => {
  const g = table([
    heroDoc("hW", "Wren", "Wizard", {
      level: 3, hp: 3, maxHp: 15, tempHp: 4, exhaustion: 2, hitDiceUsed: 2, slotsMax: [4, 2, 0, 0, 0, 0, 0, 0, 0], slotsUsed: [2, 1, 0, 0, 0, 0, 0, 0, 0],
      conditions: ["poisoned", "blinded"], conditionRounds: { poisoned: 3 }, concentration: "Bless", inventory: [], equipped: { weapon: null, armor: null, shield: null },
    }),
  ]);
  const wren = hero(g, "Wren");
  const long = E.longRestParty(g);
  eq("a long rest: all hit points, slots and hit dice back, temporary hit points gone, one level of exhaustion less", [wren.hp, wren.tempHp, wren.slotsUsed.slice(0, 2), wren.hitDiceUsed, wren.exhaustion, wren.concentration], [15, 0, [0, 0], 0, 1, null]);
  eq("…a timed condition is over by morning, a lasting one is not", wren.conditions, ["blinded"]);
  has("…and it is said", long, "You take a long rest.");

  const camp = table([
    heroDoc("hF", "Finn", "Fighter", { level: 2, hp: 5, maxHp: 20 }),
    heroDoc("hK", "Kara", "Warlock", { hp: 9, maxHp: 9, slotsMax: [1, 0, 0, 0, 0, 0, 0, 0, 0], slotsUsed: [1, 0, 0, 0, 0, 0, 0, 0, 0], inventory: [], equipped: { weapon: null, armor: null, shield: null } }),
    heroDoc("hS", "Sela", "Cleric", { hp: 0, maxHp: 9, stable: true, conditions: ["unconscious"], inventory: [], equipped: { weapon: null, armor: null, shield: null } }),
    heroDoc("hD", "Dyne", "Fighter", { hp: 0, deathSaves: { successes: 1, failures: 1 }, conditions: ["unconscious"] }),
  ]);
  // Finn: two d10 hit dice, 3 and 6, each plus 2 for Constitution. Sela: one d8, a 4, plus 2.
  const short = roll("a short rest", [3, 6, 4], (rng) => E.shortRestParty(camp, rng));
  eq("a short rest: hit dice are spent, each healing its roll plus Constitution", [hero(camp, "Finn").hp, hero(camp, "Finn").hitDiceUsed], [18, 2]);
  has("…and it is said with the numbers", short, "You take a short rest.", "Finn spends 2 hit dice, regains 13, and is at 18 of 20.");
  eq("a warlock's pact slot comes back", hero(camp, "Kara").slotsUsed[0], 0);
  eq("a stable hero comes round with 1 hit point, then spends a hit die", [hero(camp, "Sela").hp, hero(camp, "Sela").conditions, hero(camp, "Sela").stable], [7, [], false]);
  has("…and it is said", short, "Sela spends 1 hit die, regains 6, and is at 7 of 9.");
  has("a hero who is dying cannot rest", short, "Dyne is dying and can't rest.");
  eq("…and is no better for it", [hero(camp, "Dyne").hp, hero(camp, "Dyne").deathSaves], [0, { successes: 1, failures: 1 }]);
  eq("a hero at full strength spends nothing", [hero(camp, "Kara").hp, hero(camp, "Kara").hitDiceUsed], [9, 0]);

  const busy = table([heroDoc("hA", "Aldo", "Fighter", { hp: 4 })]);
  E.spawn(busy, monster("goblin"), 1);
  roll("initiative", [20, 1], (rng) => E.startCombat(busy, rng));
  eq("no rest in the middle of a fight", [E.shortRestParty(busy, NO_DICE()), E.longRestParty(busy), hero(busy, "Aldo").hp], [["You can't rest in the middle of a fight."], ["You can't rest in the middle of a fight."], 4]);
});

// ═══ Equipment ═══════════════════════════════════════════════════════════════

await scenario("equipment", () => {
  const bare = { weapon: null, armor: null, shield: null };
  const g = table([heroDoc("hE", "Edda", "Fighter", { ac: 12, inventory: [], equipped: bare }), heroDoc("hO", "Odo", "Fighter", { inventory: [], equipped: bare })], {
    items: [
      { id: "itMail", name: "Chain mail", type: "armor", ownerId: "hE" },
      { id: "itShield", name: "Shield", type: "armor", ownerId: "hE" },
      { id: "itLeather", name: "Leather armor", type: "armor", ownerId: "hE" },
      { id: "itSword", name: "Longsword", type: "weapon", ownerId: "hE" },
      { id: "itDagger", name: "Dagger", type: "weapon", ownerId: "hE" },
      { id: "itRope", name: "Rope", type: "gear", ownerId: "hE" },
    ],
  });
  const edda = hero(g, "Edda");
  const odo = hero(g, "Odo");
  const item = (id: string): Any => g.items.find((it: Any) => it.id === id);
  eq("unarmored: 10 plus Dexterity", E.heroArmorClass(g, edda), 12);
  eq("putting on chain mail: armor class 16, said so", [E.equipItem(g, edda, item("itMail")).lines, edda.ac, edda.equipped.armor], [["Edda puts on the chain mail: armor class 16."], 16, "itMail"]);
  eq("strapping on a shield: 18", [E.equipItem(g, edda, item("itShield")).lines, edda.ac], [["Edda straps on the shield: armor class 18."], 18]);
  eq("taking the shield off: 16 again", [E.unequipItem(g, edda, item("itShield")).lines, edda.ac, edda.equipped.shield], [["Edda takes off the shield: armor class 16."], 16, null]);
  eq("changing into leather: 11 plus Dexterity", [E.equipItem(g, edda, item("itLeather")).done, edda.ac, edda.equipped.armor], [true, 13, "itLeather"]);
  eq("dropping the armor she wears: unarmored again, and the armor is gone from the game", [E.dropItem(g, edda, item("itLeather")), edda.ac, g.items.some((it: Any) => it.id === "itLeather"), edda.inventory.includes("itLeather"), edda.equipped.armor], [["Edda drops the leather armor: armor class 12."], 12, false, false, null]);
  eq("something that isn't in use can't be taken off", E.unequipItem(g, edda, item("itMail")).done, false);
  eq("a rope is nothing to wield or wear", E.equipItem(g, edda, item("itRope")), { lines: ["The rope isn't something to wield or wear."], done: false });

  eq("readying the longsword: the attack follows it", [E.equipItem(g, edda, item("itSword")).lines, E.heroAttackProfile(g, edda).label, E.heroAttackProfile(g, edda).toHit, E.heroAttackProfile(g, edda).damage], [["Edda readies the longsword: plus 5 to hit, slashing damage."], "the longsword", 5, "1d8+3"]);
  eq("a weapon named in the words is the one used", [E.heroAttackProfile(g, edda, "I stab it with my dagger").label, E.heroAttackProfile(g, edda, "I stab it with my dagger").damage], ["the dagger", "1d4+3"]);
  eq("handing the sword over empties the hand that held it", [E.giveItem(g, item("itSword"), odo), edda.equipped.weapon, item("itSword").ownerId, odo.inventory, edda.inventory.includes("itSword")], [["Edda hands the longsword to Odo."], null, "hO", ["itSword"], false]);
  eq("…and she falls back on the weapon she still carries", E.heroAttackProfile(g, edda).label, "the dagger");
  eq("the dagger goes to the party's loot", [E.giveItem(g, item("itDagger"), null), item("itDagger").ownerId], [["Edda puts the dagger with the party's loot."], null]);
  eq("…and with no weapon she fights with her fists", [E.heroAttackProfile(g, edda).label, E.heroAttackProfile(g, edda).damage, E.heroAttackProfile(g, edda).toHit], ["an unarmed strike", "4", 5]);
  eq("the board marks what is in use", view.toView(g).items.filter((it: Any) => it.equipped).map((it: Any) => it.name), []);
  E.equipItem(g, odo, item("itSword"));
  eq("…once it is", view.toView(g).items.filter((it: Any) => it.equipped).map((it: Any) => it.name), ["Longsword"]);
});

// ═══ Gold, trade, potions ════════════════════════════════════════════════════

await scenario("gold, trade and potions", () => {
  const g = table([heroDoc("hE", "Edda", "Fighter", { gold: 20, hp: 5 }), heroDoc("hO", "Odo", "Fighter", { gold: 0, hp: 0, conditions: ["unconscious"] })], {
    items: [
      { id: "itPot", name: "Potion of Healing", type: "potion", ownerId: "hE", quantity: 2, properties: ["heals 2d4+2"] },
      { id: "itKey", name: "Foreman's key", type: "quest", ownerId: "hE" },
    ],
  });
  const edda = hero(g, "Edda");
  const odo = hero(g, "Odo");
  eq("a thing worth nothing finds no buyer, and stays", [E.sellItem(g, edda, g.items.find((it: Any) => it.id === "itKey")), g.items.some((it: Any) => it.id === "itKey"), edda.gold], [["Nobody here will pay for the foreman's key."], true, 20]);
  const refused = E.buyItem(g, edda, { name: "Potion of Healing", type: "potion", rarity: "common" }, 50);
  eq("a purchase she can't afford doesn't happen", [refused.lines, refused.item, edda.gold], [["Edda has 20 gold, and the potion of healing costs 50."], null, 20]);
  const rope = E.buyItem(g, edda, { name: "Rope", type: "gear", rarity: "common" }, 1);
  eq("a purchase she can afford comes off her gold and into her pack", [rope.lines, edda.gold, rope.item?.ownerId, edda.inventory.includes(rope.item?.id)], [["Edda buys the rope for 1 gold and has 19 left."], 19, "hE", true]);
  const sword = g.items.find((it: Any) => it.id === "swhE");
  eq("selling brings half the price, and the sword leaves her hand and the game", [E.sellItem(g, edda, sword), edda.gold, g.items.some((it: Any) => it.id === "swhE"), edda.equipped.weapon], [["Edda sells the longsword for 7 gold and now has 26."], 26, false, null]);
  eq("gold into the party's purse", [E.moveGold(g, edda, null, 10), edda.gold, g.partyGold], [["Edda gives 10 gold to the party's purse. The purse holds 10."], 16, 10]);
  eq("gold out of the purse to a hero", [E.moveGold(g, null, odo, 4), odo.gold, g.partyGold], [["The party gives 4 gold to Odo. Odo now has 4."], 4, 6]);
  eq("never more gold than there is", [E.moveGold(g, edda, odo, 100), edda.gold, odo.gold], [["Edda gives 16 gold to Odo. Odo now has 20."], 0, 20]);
  eq("…and nothing from nothing", E.moveGold(g, edda, odo, 5), ["Edda has no gold to give."]);

  const potion = g.items.find((it: Any) => it.id === "itPot");
  // 2d4+2: a 2 and a 3.
  const drink = roll("drinking a potion", [2, 3], (rng) => E.useItem(g, rng, edda, potion, null));
  eq("a potion of healing heals 2d4+2 through the rules, up to the maximum", [drink.lines, edda.hp, potion.quantity], [["Edda drinks the potion of healing: 2 plus 3 plus 2 is 7. Edda regains 7 hit points and is at 12 of 12."], 12, 1]);
  const give = roll("giving the last potion to a friend who is down", [1, 1], (rng) => E.useItem(g, rng, edda, potion, odo));
  eq("healing wakes a hero at 0", [give.lines, odo.hp, odo.conditions], [["Edda gives Odo the potion of healing: 1 plus 1 plus 2 is 4. Odo regains 4 hit points and is conscious again, at 4."], 4, []]);
  eq("the last of a stack leaves the sheet and the board", [g.items.some((it: Any) => it.id === "itPot"), edda.inventory.includes("itPot"), view.toView(g).items.some((it: Any) => it.name === "Potion of Healing")], [false, false, false]);
});

// ═══ Creatures that leave a fight ════════════════════════════════════════════

await scenario("creatures that flee, are talked down, or vanish", () => {
  const g = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea")]);
  const [g1, g2] = E.spawn(g, monster("goblin"), 2);
  eq("several of a kind are numbered", [g1.name, g2.name], ["Goblin 1", "Goblin 2"]);
  roll("initiative", [20, 15, 5, 4], (rng) => E.startCombat(g, rng));
  eq("the order", order(g), ["Aldo", "Bea", "Goblin 1", "Goblin 2"]);
  eq("a creature that flees leaves the order and counts as overcome", [E.dismissNpc(g, NO_DICE(), g1, "fled"), g1.status, order(g), g.combat.xpEarned, g.combat.overcome, onTurn(g)], [[], "fled", ["Aldo", "Bea", "Goblin 2"], 50, ["Goblin 1"], "Aldo"]);
  // The last foe is talked down: the fight ends. Nobody fell, so there is nothing to find on them and no die is rolled.
  const calm = roll("the last foe is talked down", [], (rng) => E.dismissNpc(g, rng, g2, "calmed"));
  eq("talking the last foe down ends the fight, with XP for both", [calm, g.combat, g2.status, hero(g, "Aldo").xp, hero(g, "Bea").xp], [["The fight is over.", "Each of you earns 50 experience points."], null, "alive", 50, 50]);
  eq("…but only the fallen leave treasure: a foe that fled or was talked down keeps its purse", g.partyGold, 0);
  eq("the scene goes on with the hero who would have acted next", g.spotlightId, "hB");
  eq("the fled goblin is still on the board, marked", view.toView(g).npcs.map((n: Any) => [n.name, n.status]), [["Goblin 1", "fled"], ["Goblin 2", "alive"]]);

  const h = table([heroDoc("hA", "Aldo")]);
  const [wolf] = E.spawn(h, monster("wolf"), 1);
  roll("initiative", [20, 5], (rng) => E.startCombat(h, rng));
  eq("a creature simply taken out of the story is gone, and earns nothing", [E.dismissNpc(h, NO_DICE(), wolf, "gone"), h.npcs.length, h.combat, hero(h, "Aldo").xp, h.partyGold], [["The fight is over."], 0, null, 0, 0]);
});

// ═══ Opportunity attacks ═════════════════════════════════════════════════════

await scenario("opportunity attacks", () => {
  const g = table([heroDoc("hA", "Aldo")]);
  const [gob] = E.spawn(g, monster("goblin"), 1);
  roll("initiative", [20, 5], (rng) => E.startCombat(g, rng));
  const aldo = hero(g, "Aldo");
  eq("nobody is in reach before blows are traded: walking away draws nothing", E.provoke(g, NO_DICE(), aldo), []);
  roll("Aldo swings and misses", [2], (rng) => E.heroAttack(g, rng, aldo, gob, {}));
  // The goblin's reaction: 10+4 = 14 against 14 (meeting the armor class hits), 3+2 = 5 damage.
  const away = roll("Aldo walks away", [10, 3], (rng) => E.provoke(g, rng, aldo));
  eq("walking away from a foe draws an opportunity attack", away, ["The goblin takes an opportunity attack.", "The goblin attacks Aldo: 14 against armor class 14, a hit for 5 slashing damage. Aldo has 7 hit points left."]);
  eq("…which uses the goblin's reaction for the round", [aldo.hp, g.combat.order.find((c: Any) => c.id === gob.id).reactionUsed], [7, true]);
  roll("Aldo closes and misses again", [3], (rng) => E.heroAttack(g, rng, aldo, gob, {}));
  eq("one reaction a round: a second retreat is free", E.provoke(g, NO_DICE(), aldo), []);

  const h = table([heroDoc("hA", "Aldo")]);
  const [gob2] = E.spawn(h, monster("goblin"), 1);
  roll("initiative", [20, 5], (rng) => E.startCombat(h, rng));
  roll("a miss", [2], (rng) => E.heroAttack(h, rng, hero(h, "Aldo"), gob2, {}));
  E.heroManeuver(h, NO_DICE(), hero(h, "Aldo"), "disengage");
  eq("after disengaging, walking away draws nothing", [E.provoke(h, NO_DICE(), hero(h, "Aldo")), hero(h, "Aldo").hp], [[], 12]);
});

// ═══ Monsters ════════════════════════════════════════════════════════════════

await scenario("a breath weapon, and a bite that burns", () => {
  const big = { hp: 30, maxHp: 30 };
  const g = table([heroDoc("hA", "Aldo", "Fighter", big), heroDoc("hB", "Bea", "Fighter", big)]);
  const [drake] = E.spawn(g, monster("red dragon wyrmling"), 1);
  const bite = drake.attacks[0];
  // Initiative: Aldo 1+2, Bea 2+2, the wyrmling 20. It goes first: picks Aldo (1 on a d2), 7d6 of fire (all 3s = 21),
  // Aldo saves (15+2 against 13) and takes 10, Bea fails (3+2) and takes 21.
  const start = roll("the wyrmling breathes", [1, 2, 20, 1, 3, 3, 3, 3, 3, 3, 3, 15, 3], (rng) => E.startCombat(g, rng));
  has("with two heroes standing a ready breath weapon is used", start.lines, "The red dragon wyrmling unleashes its fire breath: 21 fire damage, Dexterity save DC 13 for half.");
  has("each hero saves for half", start.lines, "Aldo rolls 17, saves, and takes 10. Aldo has 20 hit points left.", "Bea rolls 5, fails, and takes 21. Bea has 9 hit points left.", "Bea, you're up.");
  eq("…hit points follow, and the breath is spent", [hero(g, "Aldo").hp, hero(g, "Bea").hp, drake.breath.ready, order(g)], [20, 9, false, ["Red Dragon Wyrmling", "Bea", "Aldo"]]);

  roll("Bea passes", [], (rng) => E.advanceTurn(g, rng));
  // Round 2: the breath does not recharge (2 on the d6); it picks Bea (2 on a d2); bite 14+6 = 20, a hit: 5+4 = 9
  // piercing and 2 fire: 11 against Bea's 9. Then Bea's death save: 11, a success.
  const lines = roll("the wyrmling bites", [2, 2, 14, 5, 2, 11], (rng) => E.advanceTurn(g, rng));
  has("a hit that deals two kinds of damage says both", lines, `The red dragon wyrmling attacks Bea: ${14 + bite.toHit} against armor class 14, a hit for 9 piercing damage and 2 fire damage. Bea drops to 0 hit points and falls unconscious.`);
  const bea = hero(g, "Bea");
  eq("…and lands as one blow: it drops her, and adds no death save failure of its own", [bea.hp, bea.dead], [0, false]);
  has("her death save comes on her turn", lines, "Bea's death save: 11, a success. That is 1 success and 0 failures.", "Aldo, you're up.");
  eq("…one success, no failures", bea.deathSaves, { successes: 1, failures: 0 });

  // Round 3: the breath recharges (5), but only one hero stands: it bites Aldo instead (3+6 = 9, a miss). Bea rolls a natural 20.
  const third = roll("round 3", [5, 3, 20], (rng) => E.advanceTurn(g, rng));
  eq("a recharged breath is kept for when two heroes stand", [drake.breath.ready, third.some((l: string) => l.includes("unleashes"))], [true, false]);
  has("a natural 20 on a death save puts the hero back up with 1 hit point, on her own turn", third, "Bea's death save: a natural 20! Bea is back up with 1 hit point.", "Bea, you're up.");
  eq("…awake, death saves cleared", [bea.hp, bea.conditions, bea.deathSaves, onTurn(g)], [1, [], { successes: 0, failures: 0 }, "Bea"]);
});

await scenario("bites that knock down and poison", () => {
  const g = table([heroDoc("hA", "Aldo", "Fighter", { hp: 30, maxHp: 30 })]);
  const [wolf] = E.spawn(g, monster("wolf"), 1);
  // Initiative: Aldo 1+2, the wolf 20+2. Bite: 12+4 = 16, a hit; 2d4+2 = 2+3+2 = 7. Strength save: 2+5 = 7 against 11.
  const start = roll("the wolf bites", [1, 20, 12, 2, 3, 2], (rng) => E.startCombat(g, rng));
  has("a hit can force a saving throw, rolled with the hero's own bonus", start.lines, "The wolf attacks Aldo: 16 against armor class 14, a hit for 7 piercing damage. Aldo has 23 hit points left.", "Aldo's Strength save: 2 plus 5 is 7 against DC 11, a failure: Aldo is prone.");
  const aldo = hero(g, "Aldo");
  eq("…and he is prone", [aldo.conditions, aldo.hp], [["prone"], 23]);
  // Prone: disadvantage on his attack. 18 and 4: the 4 counts.
  const swing = roll("attacking while prone", [18, 4], (rng) => E.heroAttack(g, rng, aldo, wolf, {}));
  has("a prone attacker rolls two d20s and keeps the lower", swing.lines, "18 and 4 with disadvantage, so 4 plus 5 is 9 against armor class 13, a miss.");
  eq("…both dice are on the board, the lower one kept", [g.lastRoll.rolls, g.lastRoll.kept, g.lastRoll.adv, g.lastRoll.natural, g.lastRoll.outcome], [[18, 4], 4, "dis", 4, "miss"]);

  const h = table([heroDoc("hA", "Aldo", "Fighter", { hp: 30, maxHp: 30 })]);
  E.spawn(h, monster("giant spider"), 1);
  // The spider: 10+5 = 15, a hit; 4+3 = 7 piercing. Constitution save: 15+4 = 19 against 11, a success: half of 3+5 = 8 poison.
  const bitten = roll("the spider bites", [1, 20, 10, 4, 15, 3, 5], (rng) => E.startCombat(h, rng));
  has("a save can halve the poison that rides on a bite", bitten.lines, "Aldo's Constitution save: 15 plus 4 is 19 against DC 11, a success: 4 poison damage. Aldo has 19 hit points left.");
  eq("…7 for the bite, 4 for the poison", hero(h, "Aldo").hp, 19);

  const d = table([heroDoc("hD", "Durn", "Fighter", { race: "Dwarf", hp: 30, maxHp: 30 })]);
  E.spawn(d, monster("giant spider"), 1);
  // The same bite on a dwarf who fails the save (2+4 = 6): 8 poison, halved to 4 by dwarven resistance.
  const dwarf = roll("the spider bites a dwarf", [1, 20, 10, 4, 2, 3, 5], (rng) => E.startCombat(d, rng));
  has("a hero's resistance halves the damage, and it is said", dwarf.lines, "a failure: 8 poison damage, halved to 4. Durn has 19 hit points left.");
});

await scenario("resistance, vulnerability, immunity", () => {
  const g = table([heroDoc("hA", "Aldo")]);
  const [bones] = E.spawn(g, monster("skeleton"), 1);
  const [shade] = E.spawn(g, monster("shadow"), 1);
  const crush = E.hurtNpc(g, bones, 5, "bludgeoning", "hA");
  eq("a skeleton takes double from bludgeoning", [crush.result.amount, bones.hp, E.damageWords(crush.result), crush.state], [10, 3, "5 bludgeoning damage, doubled to 10", "The skeleton is barely standing."]);
  const venom = E.hurtNpc(g, bones, 9, "poison", "hA");
  eq("…and nothing from poison", [venom.result.amount, bones.hp, E.damageWords(venom.result), venom.state], [0, 3, "no damage, being immune to poison", ""]);
  const flame = E.hurtNpc(g, shade, 9, "fire", "hA");
  eq("a shadow takes half from fire, rounded down", [flame.result.amount, shade.hp, E.damageWords(flame.result)], [4, 12, "9 fire damage, halved to 4"]);
  eq("…and double from radiant", [E.hurtNpc(g, shade, 3, "radiant", "hA").result.amount, shade.hp], [6, 6]);
  const kill = E.hurtNpc(g, bones, 3, "slashing", "hA");
  eq("a kill outside a fight pays its XP at once", [kill.defeated, bones.status, kill.after, hero(g, "Aldo").xp], [true, "defeated", ["Aldo earns 50 experience points."], 50]);
  eq("the board never shows the numbers: a band while it stands, a mark when it falls", view.toView(g).npcs.map((n: Any) => [n.name, n.status, n.health]), [["Skeleton", "defeated", "down"], ["Shadow", "alive", "bloodied"]]);
  eq("damage with no kind given is still said plainly", E.damageWords({ how: null, type: "", raw: 5, amount: 5 }), "5 damage");
});

await scenario("regeneration, and three attacks a turn", () => {
  const g = table([heroDoc("hA", "Aldo", "Fighter", { hp: 60, maxHp: 60 })]);
  const [troll] = E.spawn(g, monster("troll"), 1);
  roll("initiative", [20, 1], (rng) => E.startCombat(g, rng));
  E.hurtNpc(g, troll, 30, "slashing", "hA");
  eq("the troll is wounded", troll.hp, 54);
  // Its turn: it regenerates 10, then bite, claw, claw: 2, 3 and 4 on the d20, all misses against 14.
  let lines = roll("the troll's turn", [2, 3, 4], (rng) => E.advanceTurn(g, rng));
  eq("a troll regenerates at the start of its turn and attacks three times", [troll.hp, lines.filter((l: string) => l.includes("a miss")).length, g.combat.round, onTurn(g)], [64, 3, 2, "Aldo"]);
  E.hurtNpc(g, troll, 10, "fire", "hA");
  lines = roll("the troll's next turn", [2, 3, 4], (rng) => E.advanceTurn(g, rng));
  eq("fire stops the regeneration for a turn", [troll.hp, troll.regenBlocked], [54, false]);
  roll("and the one after", [2, 3, 4], (rng) => E.advanceTurn(g, rng));
  eq("…and only for a turn", troll.hp, 64);
});

await scenario("whom a monster attacks", () => {
  const g = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea")]);
  const [gob] = E.spawn(g, monster("goblin"), 1);
  roll("initiative", [20, 19, 1], (rng) => E.startCombat(g, rng));
  roll("Aldo passes", [], (rng) => E.advanceTurn(g, rng));
  // Bea: 15+5, a hit; 1+3 = 4 damage: the goblin has 3 of 7 left.
  const hit = roll("Bea wounds the goblin", [15, 1], (rng) => E.heroAttack(g, rng, hero(g, "Bea"), gob, {}));
  has("a wounded creature's state is said as how it looks, never as a number", hit.lines, "a hit for 4 slashing damage.", "The goblin is bloodied.");
  lacks("…its hit points are not said", hit.lines, "3 hit points", "of 7");
  // The goblin goes for whoever hurt it: no die to choose, just the attack (a 2).
  let lines = roll("the goblin's turn", [2], (rng) => E.advanceTurn(g, rng));
  has("a monster goes for the hero who last hurt it", lines, "The goblin attacks Bea:");

  E.hurtHero(g, NO_DICE(), hero(g, "Bea"), 12, "slashing");
  // Aldo passes; Bea, down, makes her death save (15); the goblin now goes for Aldo (a 3).
  lines = roll("with Bea down", [15, 3], (rng) => E.advanceTurn(g, rng));
  has("…but never one who is down", lines, "The goblin attacks Aldo:");
  lacks("…so Bea is left alone", lines, "attacks Bea");

  const h = table([heroDoc("hA", "Aldo")]);
  const [held] = E.spawn(h, monster("goblin"), 1);
  roll("initiative", [20, 1], (rng) => E.startCombat(h, rng));
  R.addCondition(held, "paralyzed", 1);
  lines = roll("a paralyzed goblin's turn", [], (rng) => E.advanceTurn(h, rng));
  has("a creature that can't act loses its turn", lines, "The goblin is paralyzed and can't act.", "Aldo, you're up.");
  eq("…and a timed condition runs down at the end of its turn", held.conditions, []);
});

await scenario("surprise", () => {
  const g = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea")]);
  E.spawn(g, monster("goblin"), 2);
  // The heroes roll once each; each surprised goblin rolls twice and keeps the lower.
  roll("an ambush", [10, 9, 18, 3, 20, 6], (rng) => E.startCombat(g, rng, { surprise: "foes" }));
  eq("the surprised side rolls initiative with disadvantage", [order(g), g.combat.order.map((c: Any) => [c.init, c.surprised])], [["Aldo", "Bea", "Goblin 2", "Goblin 1"], [[12, false], [11, false], [8, true], [5, true]]]);

  const h = table([heroDoc("hA", "Aldo")]);
  E.spawn(h, monster("giant rat"), 1);
  // Aldo, surprised: 19 and 2, the 2 counts (+2 = 4). The rat: 1+2 = 3. Aldo still goes first.
  roll("the heroes are surprised", [19, 2, 1], (rng) => E.startCombat(h, rng, { surprise: "heroes" }));
  eq("…whichever side it is", h.combat.order.map((c: Any) => [c.init, c.surprised]), [[4, true], [3, false]]);
});

// ═══ Conditions ══════════════════════════════════════════════════════════════

await scenario("conditions in a fight", () => {
  const g = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea")]);
  const [gob] = E.spawn(g, monster("goblin"), 1);
  roll("initiative", [20, 19, 1], (rng) => E.startCombat(g, rng));
  const aldo = hero(g, "Aldo");
  const bea = hero(g, "Bea");
  R.addCondition(bea, "paralyzed", 1);
  // Bea loses her turn; the goblin picks Aldo (1 on a d2) and misses (2).
  let lines = roll("a paralyzed hero's turn", [1, 2], (rng) => E.advanceTurn(g, rng));
  has("a paralyzed hero loses the turn, and the condition runs out at its end", lines, "Bea is paralyzed and loses the turn.", "Bea is no longer paralyzed.", "Aldo, you're up.");
  eq("…she is free again", bea.conditions, []);

  // Help: Bea's help gives Aldo advantage on his next attack, once.
  eq("helping a friend", E.heroManeuver(g, NO_DICE(), bea, "help", { hero: aldo }), { lines: ["Bea helps Aldo, who has advantage on their next attack or check."], done: true });
  const helped = roll("Aldo attacks with help", [3, 9], (rng) => E.heroAttack(g, rng, aldo, gob, {}));
  has("help is advantage: two d20s, the higher counts", helped.lines, "3 and 9 with advantage, so 9 plus 5 is 14 against armor class 15, a miss.");
  eq("…and it is used up", aldo.conditions.includes("helped"), false);
  const plain = roll("Aldo attacks again", [9], (rng) => E.heroAttack(g, rng, aldo, gob, {}));
  has("the next attack is a single d20", plain.lines, "9 plus 5 is 14 against armor class 15, a miss.");

  // Hide: Stealth against the goblin's passive Perception (10 − 1 = 9). A 10 plus Dexterity 2.
  const hide = roll("Aldo hides", [10], (rng) => E.heroManeuver(g, rng, aldo, "hide"));
  eq("hiding is Stealth against the watchers' passive Perception", hide.lines, ["Aldo's Stealth check: 10 plus 2 is 12 against a passive Perception of 9. Success.", "Aldo is hidden."]);
  const ambush = roll("Aldo strikes from hiding", [5, 16, 2], (rng) => E.heroAttack(g, rng, aldo, gob, {}));
  has("an unseen attacker has advantage", ambush.lines, "5 and 16 with advantage, so 16 plus 5 is 21 against armor class 15, a hit for 5 slashing damage.");
  eq("…and attacking gives the hiding place away", aldo.conditions.includes("hidden"), false);

  // Dodge: attacks against Aldo have disadvantage until his next turn.
  E.heroManeuver(g, NO_DICE(), aldo, "dodge");
  roll("Aldo's turn ends", [], (rng) => E.advanceTurn(g, rng));
  // The goblin goes for Aldo, who hurt it: 18 and 2, the 2 counts.
  lines = roll("the goblin attacks a dodging hero", [18, 2], (rng) => E.advanceTurn(g, rng));
  has("attacks against a dodging hero keep the lower die", lines, "The goblin attacks Aldo: 6 against armor class 14, a miss.");
  eq("…both dice on the board", [g.lastRoll.rolls, g.lastRoll.adv, g.lastRoll.kept], [[18, 2], "dis", 2]);
  eq("the dodge ends when his turn comes round", [onTurn(g), aldo.conditions.includes("dodging")], ["Aldo", false]);

  // A paralyzed foe: advantage, and a hit from within reach is a critical hit (dice doubled).
  R.addCondition(gob, "paralyzed", 3);
  gob.hp = 7;
  const crit = roll("striking a paralyzed foe", [3, 12, 4, 5], (rng) => E.heroAttack(g, rng, aldo, gob, {}));
  has("a hit on a paralyzed creature from within reach is a critical hit: the damage dice are doubled", crit.lines, "3 and 12 with advantage, so 12 plus 5 is 17 against armor class 15, a critical hit for 12 slashing damage.", "The goblin is defeated.");
  eq("…and it is recorded as one", [crit.crit, g.lastRoll.outcome], [true, "crit"]);

  // Exhaustion: two levels take 4 off every d20 test.
  const t = table([heroDoc("hT", "Tam", "Fighter", { exhaustion: 2 })]);
  const [rat] = E.spawn(t, monster("giant rat"), 1);
  const tired = roll("an exhausted hero attacks", [10], (rng) => E.heroAttack(t, rng, hero(t, "Tam"), rat, {}));
  eq("exhaustion takes twice its level off the roll: 10 + 5 − 4 = 11, a miss against 12", [t.lastRoll.total, tired.hit], [11, false]);
});

// ═══ Spells ══════════════════════════════════════════════════════════════════

await scenario("spells", () => {
  const bare = { weapon: null, armor: null, shield: null };
  const wizard = (extra: Any = {}) => heroDoc("hW", "Wren", "Wizard", { level: 3, hp: 14, maxHp: 14, ac: 12, stats: { ...STATS, int: 16 }, inventory: [], equipped: bare, ...extra });
  const spell = (name: string) => S.SPELLS[name];

  const g = table([wizard(), heroDoc("hA", "Aldo")]);
  const wren = hero(g, "Wren");
  eq("a third-level wizard: four first-level slots, two second-level", wren.slotsMax.slice(0, 3), [4, 2, 0]);
  eq("a fighter cannot cast", E.castSpell(g, NO_DICE(), hero(g, "Aldo"), spell("magic missile"), { npcs: [], heroes: [] }), { lines: ["Aldo can't cast spells."], cast: false });
  eq("a spell with nobody to aim at isn't cast, and costs nothing", [E.castSpell(g, NO_DICE(), wren, spell("magic missile"), { npcs: [], heroes: [] }), wren.slotsUsed[0]], [{ lines: ["There's no target for magic missile."], cast: false }, 0]);

  const [gob] = E.spawn(g, monster("goblin"), 1);
  // Magic missile: 3d4+3 = 1+2+3+3 = 9, no attack roll.
  const missile = roll("magic missile", [1, 2, 3], (rng) => E.castSpell(g, rng, wren, spell("magic missile"), { npcs: [gob], heroes: [] }));
  has("magic missile strikes without a roll and spends a first-level slot", missile.lines, "Wren casts magic missile with a level 1 slot at the goblin: it strikes unerringly for 9 force damage.", "The goblin is defeated.");
  eq("…a slot is used", [wren.slotsUsed.slice(0, 2), missile.cast], [[1, 0], true]);

  const [ogre] = E.spawn(g, monster("ogre"), 1);
  // Upcast with a second-level slot: a fourth dart, 4d4+4.
  const upcast = roll("magic missile in a second-level slot", [1, 1, 1, 1], (rng) => E.castSpell(g, rng, wren, spell("magic missile"), { npcs: [ogre], heroes: [] }, { slotLevel: 2 }));
  has("a higher slot makes the spell stronger", upcast.lines, "with a level 2 slot at the ogre: it strikes unerringly for 8 force damage.");
  eq("…and is the slot spent", [wren.slotsUsed.slice(0, 2), ogre.hp], [[1, 1], 51]);

  // Fire bolt, a cantrip: 10+5 = 15 against the ogre's 11, a hit, 1d10 = 7. No slot.
  const bolt = roll("fire bolt", [10, 7], (rng) => E.castSpell(g, rng, wren, spell("fire bolt"), { npcs: [ogre], heroes: [] }));
  has("a cantrip is an attack roll with the spell bonus, and costs no slot", bolt.lines, "Wren casts fire bolt at the ogre: 10 plus 5 is 15 against armor class 11, a hit for 7 fire damage.");
  eq("…no slot spent", wren.slotsUsed.slice(0, 2), [1, 1]);

  // Scorching ray: three rays. A hit (10; 1+2), a natural 1, a natural 20 (four dice: 1,1,1,1).
  const rays = roll("scorching ray", [10, 1, 2, 1, 20, 1, 1, 1, 1], (rng) => E.castSpell(g, rng, wren, spell("scorching ray"), { npcs: [ogre], heroes: [] }));
  has("each ray is its own attack", rays.lines, "Wren casts scorching ray with a level 2 slot at the ogre: 10 plus 5 is 15 against armor class 11, a hit for 3 fire damage.", "The next ray, at the ogre: a natural 1, a miss.", "The next ray, at the ogre: a natural 20, a critical hit for 4 fire damage.");
  eq("…the last second-level slot is gone", [wren.slotsUsed.slice(0, 2), ogre.hp], [[1, 2], 51 - 7 - 3 - 4]);
  eq("with no slot of that level or higher left, the spell isn't cast", E.castSpell(g, NO_DICE(), wren, spell("scorching ray"), { npcs: [ogre], heroes: [] }), { lines: ["Wren has no spell slot left for scorching ray."], cast: false });

  // Burning hands on two goblins: 3d6 = 12. Goblin 1 saves (18+2) and takes 6; goblin 2 fails (2+2) and takes 12.
  const [g1, g2] = E.spawn(g, monster("goblin"), 2);
  const hands = roll("burning hands", [4, 4, 4, 18, 2], (rng) => E.castSpell(g, rng, wren, spell("burning hands"), { npcs: [g1, g2], heroes: [] }));
  has("a save spell: one damage roll, each creature saves for half", hands.lines, "Wren casts burning hands with a level 1 slot: Dexterity save, DC 13, 12 fire damage.", "Goblin 1 rolls 20 and saves, taking 6 fire damage.", "Goblin 1 is barely standing.", "Goblin 2 rolls 4 and fails, taking 12 fire damage.", "Goblin 2 is defeated.");
  eq("…hit points follow", [g1.hp, g2.status], [1, "defeated"]);

  // A fifth-level wizard's fire bolt: two d10.
  const t5 = table([wizard({ level: 5 })]);
  const [o5] = E.spawn(t5, monster("ogre"), 1);
  const big = roll("fire bolt at level 5", [10, 3, 4], (rng) => E.castSpell(t5, rng, hero(t5, "Wren"), spell("fire bolt"), { npcs: [o5], heroes: [] }));
  has("a cantrip grows with the caster: two dice at level 5, and a bigger proficiency bonus", big.lines, "10 plus 6 is 16 against armor class 11, a hit for 7 fire damage.");
});

await scenario("concentration", () => {
  const bare = { weapon: null, armor: null, shield: null };
  const g = table([
    heroDoc("hW", "Wren", "Wizard", { level: 3, hp: 14, maxHp: 14, ac: 12, stats: { ...STATS, int: 16 }, inventory: [], equipped: bare }),
    heroDoc("hC", "Cora", "Cleric", { hp: 30, maxHp: 30, stats: { ...STATS, wis: 16 }, inventory: [], equipped: bare }),
    heroDoc("hA", "Aldo", "Fighter", { hp: 2 }),
  ]);
  const wren = hero(g, "Wren");
  const cora = hero(g, "Cora");
  const aldo = hero(g, "Aldo");
  const spell = (name: string) => S.SPELLS[name];
  const [bandit] = E.spawn(g, monster("bandit"), 1);

  // Hold person: the bandit's Wisdom save, a 5 against DC 13.
  const hold = roll("hold person", [5], (rng) => E.castSpell(g, rng, wren, spell("hold person"), { npcs: [bandit], heroes: [] }));
  has("a failed save puts the condition on, for the spell's duration", hold.lines, "Wren casts hold person with a level 2 slot: Wisdom save, DC 13.", "The bandit rolls 5 and fails: paralyzed.");
  eq("…the caster concentrates on it", [bandit.conditions, bandit.conditionRounds.paralyzed, wren.concentration], [["paralyzed"], 10, "Hold Person"]);
  // 8 damage: DC 10 (half the damage is less). Constitution save: 3+2 = 5.
  const broken = roll("Wren is hit", [3], (rng) => E.hurtHero(g, rng, wren, 8, "piercing"));
  has("damage calls for a Constitution save against 10 or half the damage", broken.after, "Wren loses concentration, 3 plus 2 is 5 against DC 10: hold person ends.");
  eq("…and what the spell was doing ends with it", [wren.concentration, bandit.conditions], [null, []]);

  // Cure wounds: 2d8 = 3+4, plus Wisdom 3: 10, but Aldo only lacks 10.
  const cure = roll("cure wounds", [3, 4], (rng) => E.castSpell(g, rng, cora, spell("cure wounds"), { npcs: [], heroes: [aldo] }));
  eq("healing adds the casting modifier and stops at the maximum", [cure.lines, aldo.hp, cora.slotsUsed[0]], [["Cora casts cure wounds with a level 1 slot on Aldo: Aldo regains 10 hit points and is at 12 of 12."], 12, 1]);

  const bless = E.castSpell(g, NO_DICE(), cora, spell("bless"), { npcs: [], heroes: [aldo, wren] });
  eq("bless: on the heroes named, for ten rounds, held by concentration", [bless.lines, aldo.conditionRounds.blessed, wren.conditionRounds.blessed, cora.concentration, cora.slotsUsed[0]], [["Cora casts bless with a level 1 slot on Aldo and Wren."], 10, 10, "Bless", 2]);
  eq("the board shows the condition with its rounds", view.toView(g).players.find((p: Any) => p.name === "Aldo").conditionInfo, [{ name: "blessed", rounds: 10 }]);
  eq("a first-level cleric's two slots are spent: no third spell", E.castSpell(g, NO_DICE(), cora, spell("cure wounds"), { npcs: [], heroes: [aldo] }).lines, ["Cora has no spell slot left for cure wounds."]);
  // 24 damage: DC 12. Constitution save: 15+2 = 17, kept.
  const kept = roll("Cora is hit hard", [15], (rng) => E.hurtHero(g, rng, cora, 24, "bludgeoning"));
  has("a big hit raises the DC to half the damage, and a good roll keeps the spell", kept.after, "Cora keeps concentrating: 15 plus 2 is 17 against DC 12.");
  eq("…bless holds", [cora.concentration, aldo.conditions.includes("blessed")], ["Bless", true]);
  const down = E.hurtHero(g, NO_DICE(), cora, 6, "bludgeoning");
  eq("dropping to 0 ends concentration with no save, and the blessing with it", [cora.hp, down.after, cora.concentration, aldo.conditions.includes("blessed"), wren.conditions.includes("blessed")], [0, ["Cora's bless ends."], null, false, false]);

  eq("the DC is never above 30", [R.concentrationDc(8), R.concentrationDc(24), R.concentrationDc(100)], [10, 12, 30]);

  // Shield: +5 to armor class until the caster's next turn.
  const t = table([heroDoc("hW", "Wren", "Wizard", { level: 3, hp: 14, maxHp: 14, ac: 12, stats: { ...STATS, int: 16 }, inventory: [], equipped: bare })]);
  const [gob] = E.spawn(t, monster("goblin"), 1);
  roll("initiative", [20, 1], (rng) => E.startCombat(t, rng));
  eq("shield", E.castSpell(t, NO_DICE(), hero(t, "Wren"), spell("shield"), { npcs: [], heroes: [] }).lines, ["Wren casts shield with a level 1 slot: plus 5 to armor class until Wren's next turn."]);
  // The goblin: 12+4 = 16: a hit against 12, a miss against 17.
  const lines = roll("the goblin attacks the shielded wizard", [12], (rng) => E.advanceTurn(t, rng));
  has("the shield counts against the attack", lines, "The goblin attacks Wren: 16 against armor class 17, a miss.");
  eq("…and is gone when her turn comes", [hero(t, "Wren").conditions.includes("shielded"), gob.hp], [false, 7]);
});

// ═══ Turn order ══════════════════════════════════════════════════════════════

await scenario("delaying, and the spotlight", () => {
  const g = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea")]);
  E.spawn(g, monster("goblin"), 1);
  roll("initiative", [20, 19, 1], (rng) => E.startCombat(g, rng));
  const lines = roll("Aldo delays", [], (rng) => E.delayTurn(g, rng));
  eq("delaying swaps places with whoever comes next", [order(g), onTurn(g), lines], [["Bea", "Aldo", "Goblin"], "Bea", ["Bea, you're up."]]);
  eq("the board's strip follows", view.toView(g).combat.order.map((c: Any) => [c.name, c.current]), [["Bea", true], ["Aldo", false], ["Goblin", false]]);
  eq("out of turn, a hero is told whose turn it is and when theirs comes", [E.notYourTurn(g, hero(g, "Aldo")), E.notYourTurn(g, hero(g, "Bea"))], ["It's Bea's turn. Aldo, you're next.", null]);
  eq("whose turn, from the state", E.whoseTurn(g), "It's Bea's turn, round 1. Then Aldo.");

  const t = table([heroDoc("hA", "Aldo"), heroDoc("hB", "Bea", "Fighter", { hp: 0, conditions: ["unconscious"] }), heroDoc("hC", "Cade")]);
  eq("outside a fight the spotlight passes round the table, over anyone who is down", [E.passSpotlight(t, "hA")?.name, t.spotlightId, E.passSpotlight(t, "hC")?.name], ["Cade", "hC", "Aldo"]);
  eq("the prompt names who it goes to", E.promptLine(t), "Aldo, what do you do?");
  eq("what a hero can do is read off the sheet", E.optionsFor(t, hero(t, "Aldo")), "Aldo, you can attack with the longsword, or look around, talk to someone, search, or move on.");
  eq("…and a downed hero is told the truth", E.optionsFor(t, hero(t, "Bea")), "Bea is down and can only make death saving throws.");
  for (const p of t.players) p.hp = 0;
  eq("with nobody standing, nobody holds it", [E.passSpotlight(t, "hA"), t.spotlightId], [null, null]);
});

// ═══ Through the real tools ══════════════════════════════════════════════════

registerGameTools();
registerStoryTools();
const PERSONA = "game-master";
const persona = { id: PERSONA, name: "The Game Master", description: "You are the Game Master.", voicePrompt: "You are the Game Master.", voice: "NATM1", toolsets: ["game"], traits: {}, updatedAt: Date.now() };
async function run(tool: string, utterance: string): Promise<string> {
  const t = getTool(tool);
  if (!t) throw new Error(`no tool ${tool}`);
  const r = (await t.run({}, { persona, recentTranscript: [], emit: () => {}, utterance, memory: {} as never, situation: "" })) as { ok: boolean; speak?: string; say?: string };
  if (process.env.SHOW) console.log(`\n   > ${tool}: "${utterance}"\n   < ${(r.speak ?? r.say ?? "").trim()}`);
  check(`${tool} ("${utterance}"): answers with a line to speak verbatim`, r.ok === true && typeof r.speak === "string", r);
  return (r.speak ?? "").trim();
}
/** Store a game document and put it on the table. */
function seat(doc: Any, title: string): Any {
  const g = store.importGame(PERSONA, doc, title);
  store.setActiveGame(PERSONA, g.id);
  return g;
}
const goblinDoc = (id: string, extra: Any = {}): Any => ({ id, name: "Goblin", role: "goblin", description: "A goblin.", attitude: "hostile", ...B.statBlockOf(monster("goblin")), ...extra });
const deathCheck = (heroId: string): Any => ({ id: "dchk1", heroId, kind: "death", ability: null, skill: null, label: "Death saving throw", dc: 10, adv: null, reason: "cling to life", words: "", askedAt: Date.now(), reminders: 0, endsTurn: true });
const dying = (extra: Any = {}) => heroDoc("hA", "Aldo", "Fighter", { hp: 0, conditions: ["unconscious"], ...extra });
const place = (id: string, kind: "hero" | "npc", init: number): Any => ({ id, kind, init, roll: init - 2 });

await scenario("a death save rolled at the table: the third failure", async () => {
  // Round 2, Aldo's turn, two failures already; the goblin went before him and is frightened for two more rounds.
  const g = seat(
    {
      title: "Last Breath", phase: "playing", settings: { rolls: "ask" },
      players: [dying({ deathSaves: { successes: 0, failures: 2 } }), heroDoc("hB", "Bea")], items: [swordDoc("hA"), swordDoc("hB")],
      npcs: [goblinDoc("npcG", { conditions: ["frightened"], conditionRounds: { frightened: 2 } })],
      combat: { round: 2, index: 1, order: [place("npcG", "npc", 20), place("hA", "hero", 15), place("hB", "hero", 10)] },
      pending: { check: deathCheck("hA") },
    },
    "Last Breath",
  );
  eq("the board asks for the roll", view.toView(g).pendingCheck?.text, "Aldo: Death save, DC 10");
  kit.setGameRng(R.scriptedRng([]));
  const line = await run("game_roll", "I rolled a four");
  const now = store.getGame(g.id);
  eq("the die the player names is the die that counts: a third failure, and Aldo dies", [line, hero(now, "Aldo").dead, now.pending.check], ["Aldo's death save: 4, a failure. That is the third: Aldo dies. Bea, you're up.", true, null]);
  eq("the order closes up and play runs on to whoever followed him", [order(now), onTurn(now), now.combat.round, now.combat.vacant], [["Goblin", "Bea"], "Bea", 2, false]);
  eq("nobody else's turn was ended for it: the goblin's fear has not lost a round", now.npcs[0].conditionRounds.frightened, 2);
  eq("the board: Bea's turn, no roll pending, the dead hero marked", [view.toView(now).turn?.name, view.toView(now).pendingCheck, view.toView(now).players.find((p: Any) => p.name === "Aldo").dead], ["Bea", null, true]);
  const undone = await run("game_undo", "undo that");
  const back = store.getGame(g.id);
  eq("undo brings him back to the moment before the roll", [hero(back, "Aldo").dead, hero(back, "Aldo").deathSaves.failures, onTurn(back), back.pending.check?.kind], [false, 2, "Aldo", "death"]);
  has("…and says what was undone", undone, "Aldo");
});

await scenario("a death save rolled at the table: a natural 20, and 'roll for me'", async () => {
  const doc = (title: string): Any => ({
    title, phase: "playing", settings: { rolls: "ask" },
    players: [dying(), heroDoc("hB", "Bea")], items: [swordDoc("hA"), swordDoc("hB")], npcs: [goblinDoc("npcG")],
    combat: { round: 1, index: 0, order: [place("hA", "hero", 20), place("npcG", "npc", 15), place("hB", "hero", 10)] },
    pending: { check: deathCheck("hA") },
  });
  let g = seat(doc("Second Wind"), "Second Wind");
  kit.setGameRng(R.scriptedRng([]));
  let line = await run("game_roll", "I rolled a twenty");
  let now = store.getGame(g.id);
  eq("a natural 20: back up with 1 hit point, and it is still his turn", [line, hero(now, "Aldo").hp, hero(now, "Aldo").conditions, onTurn(now), now.pending.check], ["Aldo's death save: a natural 20! Aldo is back up with 1 hit point. Aldo, you're up.", 1, [], "Aldo", null]);

  g = seat(doc("Hanging On"), "Hanging On");
  // The Game Master rolls it: 12, a success. Then the goblin's turn: Bea is the only one standing; a 2, a miss.
  const rng = R.scriptedRng([12, 2]);
  kit.setGameRng(rng);
  line = await run("game_roll", "roll for me");
  now = store.getGame(g.id);
  eq("'roll for me': the Game Master rolls, the save is his turn, and play runs on", [line, hero(now, "Aldo").deathSaves, onTurn(now), rng.left()], ["Aldo's death save: 12, a success. That is 1 success and 0 failures. The goblin attacks Bea: 6 against armor class 14, a miss. Bea, you're up.", { successes: 1, failures: 0 }, "Bea", 0]);
});

await scenario("the Game Master's word can kill the hero on turn", async () => {
  const g = seat(
    {
      title: "Rockfall", phase: "playing", settings: { rolls: "auto" },
      players: [heroDoc("hA", "Aldo", "Fighter", { hp: 2 }), heroDoc("hB", "Bea")], items: [swordDoc("hA"), swordDoc("hB")], npcs: [goblinDoc("npcG")],
      combat: { round: 1, index: 0, order: [place("hA", "hero", 20), place("hB", "hero", 15), place("npcG", "npc", 10)] },
    },
    "Rockfall",
  );
  kit.setGameRng(R.scriptedRng([]));
  const line = await run("game_update_player", "Aldo takes 40 damage from the rockfall");
  const now = store.getGame(g.id);
  has("massive damage kills outright, and the fight runs on to the next hero", line, "Aldo takes 40 damage from the rockfall. Aldo is killed outright.", "Bea, you're up.");
  eq("…the order closes up with Bea on turn", [hero(now, "Aldo").dead, order(now), onTurn(now), now.combat.vacant], [true, ["Bea", "Goblin"], "Bea", false]);
});

await scenario("the encounter builder, through its tool", async () => {
  const g = seat(
    {
      title: "Goblin Warren", phase: "playing", settings: { rolls: "auto", difficulty: "standard" }, setting: "A goblin warren under the old mill.",
      scene: { title: "The Warren Mouth", description: "A cave where goblins have been raiding from." },
      players: [heroDoc("hA", "Aldo"), heroDoc("hB", "Bea"), heroDoc("hC", "Cade")], items: [swordDoc("hA"), swordDoc("hB"), swordDoc("hC")],
    },
    "Goblin Warren",
  );
  kit.setGameRng(R.seededRng(7));
  const line = await run("game_start_combat", "Something attacks us, bring on the monsters");
  const now = store.getGame(g.id);
  const enemies: Any[] = now.npcs.filter((n: Any) => n.attitude === "hostile");
  const budget = R.encounterBudget([1, 1, 1], "moderate");
  const total = enemies.reduce((n: number, e: Any) => n + e.xp, 0);
  check("an encounter is built when the words ask for one and nobody hostile is here", enemies.length >= 1 && enemies.length <= 5, enemies.map((e) => e.name));
  check("…from the bestiary, with real stat blocks", enemies.every((e) => e.statted && B.BESTIARY[e.kind] && e.maxHp === B.BESTIARY[e.kind].hp && e.attacks.length > 0), enemies.map((e) => [e.name, e.kind, e.statted]));
  check(`…within the party's budget (${budget} XP for three level 1 heroes at standard difficulty), and worth a fight`, total <= budget && total >= budget * 0.5, { total, budget });
  check("…fitting the scene: goblins in a goblin warren", enemies.some((e) => e.kind === "goblin"), enemies.map((e) => e.kind));
  eq("…rated no harder than asked", ["low", "moderate"].includes(R.rateEncounter([1, 1, 1], enemies.map((e) => e.xp)).rating), true);
  check("the fight starts with everyone in the order", !!now.combat && enemies.filter((e) => e.status === "alive").every((e) => now.combat.order.some((c: Any) => c.id === e.id)) && now.combat.order.filter((c: Any) => c.kind === "hero").length === 3, now.combat?.order);
  has("what attacks and the order are said, ending with who is up", line, "attack", "The order is", "you're up.");
  check("the reason for the encounter is in the log", now.log.some((e: Any) => /^Encounter: moderate budget 225 XP for 3 heroes of level 1/.test(e.text)), now.log.map((e: Any) => e.text).slice(-4));
  check("no model was asked for any of this", modelCalls.length === 0, modelCalls);
});

await scenario("the other tools, each with a plain sentence", async () => {
  const bare = { weapon: null, armor: null, shield: null };
  const g = seat(
    {
      title: "Market Day", phase: "playing", settings: { rolls: "auto" }, setting: "A market town on the river.",
      scene: { title: "The Market Square", description: "Stalls crowd the square under striped awnings." },
      players: [heroDoc("hA", "Aldo", "Fighter", { gold: 20, hp: 9 }), heroDoc("hB", "Bea", "Fighter", { gold: 5, ac: 12, inventory: [], equipped: bare })],
      items: [swordDoc("hA"), { id: "itMail", name: "Chain mail", type: "armor", ownerId: "hB" }],
    },
    "Market Day",
  );
  const now = (): Any => store.getGame(g.id);
  const names = (list: Any[]) => list.map((x) => x.name);
  kit.setGameRng(R.scriptedRng([]));

  let line = await run("game_trade", "Aldo buys a rope for one gold");
  eq("buying: the gold is spent and the rope is his", [hero(now(), "Aldo").gold, names(now().items.filter((it: Any) => it.ownerId === "hA")).sort()], [19, ["Longsword", "Rope"]]);
  has("…said with what is left", line, "Aldo buys the rope for 1 gold and has 19 left.");
  line = await run("game_use_item", "Aldo gives the rope to Bea");
  eq("giving: the rope changes hands", [line, now().items.find((it: Any) => it.name === "Rope").ownerId], ["Aldo hands the rope to Bea.", "hB"]);
  line = await run("game_use_item", "Bea puts on the chain mail");
  eq("equipping through the tool: armor class follows", [line, hero(now(), "Bea").ac, hero(now(), "Bea").equipped.armor], ["Bea puts on the chain mail: armor class 16.", 16, "itMail"]);
  line = await run("game_use_item", "Aldo gives five gold to Bea");
  eq("gold changes hands", [line, hero(now(), "Aldo").gold, hero(now(), "Bea").gold], ["Aldo gives 5 gold to Bea. Bea now has 10.", 14, 10]);
  line = await run("game_trade", "Bea sells the rope");
  eq("selling: half the price (a coin at least), and the rope leaves the game", [line, hero(now(), "Bea").gold, now().items.some((it: Any) => it.name === "Rope")], ["Bea sells the rope for 1 gold and now has 11.", 11, false]);
  line = await run("game_answer", "How much gold does Aldo have?");
  has("a question about gold is answered from the sheet", line, "14");
  line = await run("game_update_npc", "Take the chain mail off the board");
  eq("an item taken out of the game leaves the hero who wore it unarmored", [now().items.some((it: Any) => it.id === "itMail"), hero(now(), "Bea").ac, hero(now(), "Bea").equipped.armor], [false, 12, null]);

  line = await run("game_add_npc", "We meet Mirela, the innkeeper");
  const mirela = now().npcs.find((n: Any) => /mirela/i.test(n.name));
  check("a new character enters with a name, and a stat block of her own", !!mirela && mirela.attitude !== "hostile" && mirela.maxHp > 0 && mirela.attacks.length > 0 && /mirela/i.test(line), { line, npcs: now().npcs.map((n: Any) => [n.name, n.attitude, n.maxHp]) });

  line = await run("game_set_scene", "We walk down to the old mill by the river");
  eq("a new scene is set and added to the map (the place named in the words, not half a phrase)", [now().scene?.title, names(now().locations).includes("The Old Mill")], ["The Old Mill", true]);
  check("…and handed to a hero by name", /^You arrive at The Old Mill\./.test(line) && /, what do you do\?$/.test(line), line);

  // A wolf jumps out: initiative Aldo 20+2, Bea 19+2, the wolf 1+2.
  let rng = R.scriptedRng([20, 19, 1]);
  kit.setGameRng(rng);
  line = await run("game_add_npc", "A wolf jumps out of the reeds");
  eq("a creature that jumps out starts the fight, with its stat block from the bestiary", [order(now()), now().npcs.find((n: Any) => n.name === "Wolf")?.maxHp, rng.left()], [["Aldo", "Bea", "Wolf"], 11, 0]);
  has("…said, with the order and who is up", line, "A wolf appears.", "The order is Aldo, Bea, then the wolf.", "Aldo, you're up.");
  line = await run("game_next_turn", "I pass");
  eq("passing the turn", [line, onTurn(now())], ["Aldo passes. Bea, you're up.", "Bea"]);
  line = await run("game_update_player", "Everyone takes 3 damage from the falling timbers");
  eq("a change to everyone at once", [hero(now(), "Aldo").hp, hero(now(), "Bea").hp], [6, 9]);
  has("…said for each", line, "Aldo takes 3 damage from the falling timbers. Aldo has 6 hit points left.", "Bea takes 3 damage from the falling timbers. Bea has 9 hit points left.");
  line = await run("game_update_npc", "The wolf takes 4 fire damage");
  eq("damage said outright lands on the creature", [now().npcs.find((n: Any) => n.name === "Wolf").hp, line], [7, "The wolf takes 4 fire damage."]);
  line = await run("game_update_npc", "The wolf runs away");
  eq("the last foe fleeing ends the fight: XP, no treasure", [now().combat, now().npcs.find((n: Any) => n.name === "Wolf").status, hero(now(), "Aldo").xp, now().partyGold], [null, "fled", 25, 0]);
  has("…said, and the scene is handed on", line, "The wolf flees.", "The fight is over.", "Each of you earns 25 experience points.", "what do you do?");

  // Two goblins: initiative Aldo, Bea, then the goblins. Then the fight is called off.
  rng = R.scriptedRng([20, 19, 2, 1]);
  kit.setGameRng(rng);
  line = await run("game_start_combat", "Two goblins attack us");
  eq("named creatures arrive in the number said", [order(now()), rng.left()], [["Aldo", "Bea", "Goblin 1", "Goblin 2"], 0]);
  line = await run("game_end_combat", "We back off, the fight is over");
  eq("a fight can be called off: no XP for foes still standing", [now().combat, now().mode, hero(now(), "Aldo").xp], [null, "explore", 25]);
  has("…said", line, "The fight breaks off.");

  kit.setGameRng(R.scriptedRng([]));
  line = await run("game_rest", "We make camp and take a long rest");
  eq("a long rest through its tool", [hero(now(), "Aldo").hp, hero(now(), "Bea").hp], [12, 12]);
  has("…said", line, "You take a long rest.");

  line = await run("game_pause", "Pause the game for a minute");
  eq("pausing", [now().phase, now().mode], ["paused", "paused"]);
  line = await run("game_narrate", "Aldo opens the door");
  has("while paused nothing happens in the story", line, "The game is paused.");
  line = await run("game_pause", "Okay, we're back, resume");
  eq("resuming", [now().phase, now().mode], ["playing", "explore"]);
});

await scenario("the undo history is bounded", async () => {
  const g = seat({ title: "Long Night", phase: "playing", players: [heroDoc("hA", "Aldo")], items: [swordDoc("hA")] }, "Long Night");
  for (let i = 0; i < 25; i++) {
    await store.mutateGame(g.id, (d: Any) => {
      d.partyGold = i;
    });
    store.checkpointGame(g.id, `step ${i}`);
  }
  eq(`only the last ${store.MAX_HISTORY} steps can be undone`, store.historyDepth(g.id), store.MAX_HISTORY);
  const undone = await store.undoGame(g.id);
  eq("undo goes back one step and names it", [undone?.label, undone?.game.partyGold, store.historyDepth(g.id)], ["step 24", 24, store.MAX_HISTORY - 1]);
});

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}.`);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
