/*
 * The Game Master's rules engine, mechanic by mechanic, with every die scripted or seeded.
 *
 *   node_modules/.bin/tsx scripts/test-game-rules.mts
 *
 * Covers server/src/game/rules.ts (dice, d20 tests, attacks, damage, dying, conditions, exhaustion, concentration,
 * initiative, cover, rests, spell slots, inspiration, experience, encounter budgets), the SRD tables in srd.ts
 * (classes, weapons, armor, spells, rules answers) and bestiary.ts (stat blocks, bounds, the encounter builder).
 * Prints one line per check and ends with "ALL PASSED" or "N FAILED" (exit code 1).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = (p: string) => import(pathToFileURL(path.join(ROOT, "server/src/game", p)).href);

const R = await load("rules.ts");
const S = await load("srd.ts");
const B = await load("bestiary.ts");

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
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const dice = (...values: number[]) => R.scriptedRng(values);

// A hero for the mortal / rest tests.
function hero(over: Record<string, unknown> = {}) {
  return {
    name: "Thorin",
    level: 3,
    hp: 28,
    maxHp: 28,
    tempHp: 0,
    stats: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
    conditions: [] as string[],
    conditionRounds: {} as Record<string, number>,
    saveProficiencies: ["str", "con"],
    skillProficiencies: ["athletics"],
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    dead: false,
    hitDie: 10,
    hitDiceUsed: 0,
    exhaustion: 0,
    slotsMax: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    slotsUsed: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    inspiration: false,
    ...over,
  };
}

// ─── Random sources ──────────────────────────────────────────────────────────
{
  const a = R.seededRng(42);
  const b = R.seededRng(42);
  const seqA = Array.from({ length: 20 }, () => a(20));
  const seqB = Array.from({ length: 20 }, () => b(20));
  eq("seeded rng: the same seed gives the same dice", seqA, seqB);
  check("seeded rng: every roll is on the die", seqA.every((v: number) => v >= 1 && v <= 20));
  const c = R.seededRng(43);
  check("seeded rng: another seed gives other dice", JSON.stringify(Array.from({ length: 20 }, () => c(20))) !== JSON.stringify(seqA));
  const s = dice(3, 6);
  eq("scripted rng: values come in order", [s(6), s(6)], [3, 6]);
  check("scripted rng: running out throws", throws(() => s(6)));
  check("scripted rng: a value too big for the die throws", throws(() => dice(7)(6)));
  eq("scripted rng: falls back when told to", R.scriptedRng([], () => 2)(6), 2);
}

// ─── Dice expressions ────────────────────────────────────────────────────────
{
  eq("parse 2d6+3", R.parseDice("2d6+3"), { terms: [{ count: 2, sides: 6 }], modifier: 3 });
  eq("parse d20", R.parseDice("d20"), { terms: [{ count: 1, sides: 20 }], modifier: 0 });
  eq("parse 1d8 + 1d6 + 2", R.parseDice("1d8 + 1d6 + 2"), { terms: [{ count: 1, sides: 8 }, { count: 1, sides: 6 }], modifier: 2 });
  eq("parse 2d6-1", R.parseDice("2d6-1"), { terms: [{ count: 2, sides: 6 }], modifier: -1 });
  eq("parse a flat 4", R.parseDice("4"), { terms: [], modifier: 4 });
  eq("parse rejects words", R.parseDice("banana"), null);
  eq("parse rejects 2d6d4", R.parseDice("2d6d4"), null);
  eq("dice text round-trips", R.diceText(R.parseDice("2d6+3")), "2d6+3");
  eq("average of 2d6+3 is 10", R.averageDice("2d6+3"), 10);
  const r = R.rollDice("2d6+3", dice(4, 5));
  eq("2d6+3 with a 4 and a 5 is 12", [r.rolls, r.modifier, r.total], [[4, 5], 3, 12]);
  const crit = R.rollDice("1d8+3", dice(5, 6), { crit: true });
  eq("a critical hit doubles the dice, not the modifier", [crit.rolls, crit.total, crit.notation], [[5, 6], 14, "2d8+3"]);
  eq("a roll never totals below 0", R.rollDice("1d4-5", dice(1)).total, 0);
}

// ─── Advantage and disadvantage ──────────────────────────────────────────────
{
  const adv = R.rollD20(dice(5, 17), "adv");
  eq("advantage rolls two d20 and keeps the higher", [adv.rolls, adv.kept], [[5, 17], 17]);
  const dis = R.rollD20(dice(5, 17), "dis");
  eq("disadvantage keeps the lower", [dis.rolls, dis.kept], [[5, 17], 5]);
  eq("a plain roll is one die", R.rollD20(dice(9)).rolls, [9]);
  eq("advantage with disadvantage cancels", R.combineAdv("adv", "dis"), null);
  eq("two advantages and one disadvantage still cancel", R.combineAdv("adv", "adv", "dis"), null);
  eq("advantage never stacks", R.combineAdv("adv", "adv", "adv"), "adv");
  eq("two advantages still roll only two dice", R.rollD20(dice(3, 4), R.combineAdv("adv", "adv")).rolls.length, 2);
  eq("no sources: a straight roll", R.combineAdv(null, undefined), null);
  eq("a die rolled at the table is used as is", R.rollD20(dice(), null, 14).kept, 14);
}

// ─── Ability modifiers, proficiency, skills, saves ───────────────────────────
{
  eq("ability modifiers", [1, 8, 9, 10, 11, 15, 20, 30].map(R.abilityMod), [-5, -1, -1, 0, 0, 2, 5, 10]);
  eq("proficiency bonus by level", [1, 4, 5, 8, 9, 12, 13, 16, 17, 20].map(R.proficiencyBonus), [2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  eq("proficiency by challenge rating", [0.25, 1, 4, 5, 8, 9, 13].map(R.crProficiency), [2, 2, 2, 3, 3, 4, 5]);
  const sheet = { stats: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 8 }, level: 5, saveProficiencies: ["dex"], skillProficiencies: ["stealth"] };
  eq("a proficient skill adds the proficiency bonus", R.skillModifier(sheet, "stealth"), 6);
  eq("an untrained skill is the bare ability modifier", R.skillModifier(sheet, "acrobatics"), 3);
  eq("a proficient save adds the proficiency bonus", R.saveModifier(sheet, "dex"), 6);
  eq("a save without proficiency doesn't", R.saveModifier(sheet, "con"), 1);
  eq("there are eighteen skills", Object.keys(R.SKILLS).length, 18);
  eq("passive Perception is 10 plus the modifier", R.passiveScore(R.skillModifier(sheet, "perception")), 12);
  eq("passive score with advantage is 5 higher", R.passiveScore(2, "adv"), 17);
  eq("passive score with disadvantage is 5 lower", R.passiveScore(2, "dis"), 7);
}

// ─── The DC ladder ───────────────────────────────────────────────────────────
{
  eq("the ladder", [...R.DC_LADDER], [5, 10, 15, 20, 25, 30]);
  eq("13 snaps to 15", R.snapDc(13), 15);
  eq("12 snaps to 10", R.snapDc(12), 10);
  eq("a tie goes to the easier step", R.snapDc(12.5), 10);
  eq("99 snaps to 30", R.snapDc(99), 30);
  eq("0 snaps to 5", R.snapDc(0), 5);
  eq("nonsense falls back to 15", R.snapDc("soon"), 15);
  eq("DC words", [5, 10, 15, 20, 25, 30].map(R.dcWord), ["very easy", "easy", "moderate", "hard", "very hard", "nearly impossible"]);
}

// ─── Checks and saves ────────────────────────────────────────────────────────
{
  const meet = R.rollCheck(dice(10), { modifier: 5, dc: 15 });
  eq("meeting the DC succeeds", [meet.total, meet.success, meet.margin], [15, true, 0]);
  eq("one short fails", R.rollCheck(dice(9), { modifier: 5, dc: 15 }).success, false);
  eq("a natural 20 on a check is not automatic", R.rollCheck(dice(20), { modifier: -5, dc: 20 }).success, false);
  eq("a natural 1 on a check is not automatic", R.rollCheck(dice(1), { modifier: 20, dc: 15 }).success, true);
  const auto = R.rollCheck(dice(20), { modifier: 10, dc: 5, autoFail: true });
  eq("an automatic failure fails whatever the die", [auto.success, auto.autoFail], [false, true]);
  eq("exhaustion's penalty comes off the roll", R.rollCheck(dice(12), { modifier: 3, dc: 15, penalty: 4 }).total, 11);
  const table = R.rollCheck(dice(), { modifier: 3, dc: 15, fixed: 14 });
  eq("a table roll of 14 plus 3 is 17", [table.natural, table.total, table.success], [14, 17, true]);
  const total = R.rollCheck(dice(), { modifier: 3, dc: 15, fixedTotal: 13 });
  eq("an announced total is taken as the total", [total.total, total.natural, total.success], [13, 10, false]);
  const adv = R.rollCheck(dice(4, 16), { modifier: 2, dc: 15, adv: "adv" });
  eq("a check with advantage keeps the higher die", [adv.rolls, adv.kept, adv.total], [[4, 16], 16, 18]);
}

// ─── Contests ────────────────────────────────────────────────────────────────
{
  const c = R.rollContest(dice(12, 9), { modifier: 3 }, { modifier: 1 });
  eq("contest: the higher total wins", [c.a.total, c.b.total, c.winner], [15, 10, "a"]);
  eq("contest: a tie changes nothing", R.rollContest(dice(10, 12), { modifier: 4 }, { modifier: 2 }).winner, "tie");
  eq("contest: the other side can win", R.rollContest(dice(2, 15), { modifier: 5 }, { modifier: 0 }).winner, "b");
}

// ─── Attack rolls ────────────────────────────────────────────────────────────
{
  const hit = R.rollAttack(dice(10), { toHit: 5, ac: 15 });
  eq("an attack that meets the armor class hits", [hit.total, hit.hit, hit.crit], [15, true, false]);
  eq("one short misses", R.rollAttack(dice(9), { toHit: 5, ac: 15 }).hit, false);
  const nat20 = R.rollAttack(dice(20), { toHit: 0, ac: 30 });
  eq("a natural 20 hits anything and is a critical hit", [nat20.hit, nat20.crit], [true, true]);
  const nat1 = R.rollAttack(dice(1), { toHit: 20, ac: 5 });
  eq("a natural 1 misses anything", [nat1.hit, nat1.fumble, nat1.crit], [false, true, false]);
  const half = R.rollAttack(dice(11), { toHit: 5, ac: 15, cover: "half" });
  eq("half cover adds 2 to armor class", [half.ac, half.hit], [17, false]);
  const three = R.rollAttack(dice(14), { toHit: 5, ac: 15, cover: "three-quarters" });
  eq("three-quarters cover adds 5", [three.ac, three.hit], [20, false]);
  eq("cover bonuses", [R.coverBonus(null), R.coverBonus("half"), R.coverBonus("three-quarters")], [0, 2, 5]);
  eq("total cover can't be hit, even on a 20", R.rollAttack(dice(20), { toHit: 5, ac: 10, cover: "total" }).hit, false);
  const auto = R.rollAttack(dice(10), { toHit: 5, ac: 12, autoCrit: true });
  eq("a hit on a helpless target within reach is a critical hit", [auto.hit, auto.crit], [true, true]);
  eq("…but a miss is still a miss", R.rollAttack(dice(3), { toHit: 5, ac: 12, autoCrit: true }).crit, false);
  const advAtk = R.rollAttack(dice(3, 18), { toHit: 4, ac: 15, adv: "adv" });
  eq("an attack with advantage keeps the higher die", [advAtk.kept, advAtk.total, advAtk.hit], [18, 22, true]);
  const disCrit = R.rollAttack(dice(20, 2), { toHit: 4, ac: 15, adv: "dis" });
  eq("disadvantage can throw away a 20", [disCrit.kept, disCrit.crit], [2, false]);
}

// ─── Damage types ────────────────────────────────────────────────────────────
{
  const base = { conditions: [] as string[] };
  eq("resistance halves, rounded down", R.adjustDamage(7, "fire", { ...base, resistances: ["fire"] }), { amount: 3, how: "resistant" });
  eq("vulnerability doubles", R.adjustDamage(7, "fire", { ...base, vulnerabilities: ["fire"] }), { amount: 14, how: "vulnerable" });
  eq("immunity takes nothing", R.adjustDamage(7, "poison", { ...base, immunities: ["poison"] }), { amount: 0, how: "immune" });
  eq("resistance and vulnerability: halve, then double", R.adjustDamage(7, "cold", { ...base, resistances: ["cold"], vulnerabilities: ["cold"] }), { amount: 6, how: "resistant and vulnerable" });
  eq("another damage type is untouched", R.adjustDamage(7, "slashing", { ...base, resistances: ["fire"] }), { amount: 7, how: null });
  eq("a petrified creature resists everything", R.adjustDamage(9, "thunder", { conditions: ["petrified"] }).amount, 4);
  eq("1 damage resisted is 0", R.adjustDamage(1, "fire", { ...base, resistances: ["fire"] }).amount, 0);
}

// ─── Temporary hit points, damage, healing ───────────────────────────────────
{
  const t = hero({ hp: 10, tempHp: 5 });
  const d = R.applyDamage(t, 7, "slashing");
  eq("temporary hit points soak damage first", [d.absorbed, d.hpAfter, t.tempHp, t.hp], [5, 8, 0, 8]);
  const u = hero({ tempHp: 0 });
  R.grantTempHp(u, 5);
  R.grantTempHp(u, 3);
  eq("temporary hit points don't stack: the larger stays", u.tempHp, 5);
  eq("a larger amount replaces them", R.grantTempHp(u, 8), 8);
  const w = hero({ hp: 20, tempHp: 4 });
  R.applyHealing(w, 3);
  eq("healing doesn't touch temporary hit points", [w.hp, w.tempHp], [23, 4]);
  const full = hero({ hp: 26 });
  eq("healing stops at the maximum", [R.applyHealing(full, 10).healed, full.hp], [2, 28]);
  const res = hero({ hp: 20, resistances: ["fire"] });
  const burned = R.applyDamage(res, 9, "fire");
  eq("resisted damage: 9 fire is 4", [burned.amount, burned.how, res.hp], [4, "resistant", 16]);
  const none = R.applyDamage(hero({ immunities: ["poison"] }), 12, "poison");
  eq("immune: no damage, no concentration check", [none.amount, none.concentrationDc], [0, null]);
}

// ─── Dropping to 0, massive damage ───────────────────────────────────────────
{
  const t = hero({ hp: 5, maxHp: 20 });
  const d = R.applyDamage(t, 9, "piercing");
  eq("dropping to 0: unconscious, not dead", [t.hp, d.dropped, d.dead, t.conditions.includes("unconscious"), t.deathSaves], [0, true, false, true, { successes: 0, failures: 0 }]);
  const m = hero({ hp: 5, maxHp: 12 });
  const dm = R.applyDamage(m, 17, "bludgeoning");
  eq("massive damage: what is left over equals the maximum, so instant death", [dm.instantDeath, m.dead, m.hp], [true, true, 0]);
  const n = hero({ hp: 5, maxHp: 12 });
  eq("one point less than that only drops them", [R.applyDamage(n, 16, "bludgeoning").instantDeath, n.dead], [false, false]);
  const tmp = hero({ hp: 5, maxHp: 12, tempHp: 5 });
  eq("temporary hit points count against massive damage", [R.applyDamage(tmp, 21, "fire").instantDeath, tmp.hp], [false, 0]);
}

// ─── Damage at 0 hit points ──────────────────────────────────────────────────
{
  const t = hero({ hp: 0, conditions: ["unconscious"] });
  const d = R.applyDamage(t, 3, "slashing");
  eq("damage at 0 adds a death save failure", [d.failuresAdded, t.deathSaves.failures, t.dead], [1, 1, false]);
  R.applyDamage(t, 3, "slashing", { crit: true });
  eq("a critical hit at 0 adds two: three failures, dead", [t.deathSaves.failures, t.dead], [3, true]);
  const st = hero({ hp: 0, stable: true, conditions: ["unconscious"] });
  R.applyDamage(st, 2, "fire");
  eq("damage ends stability", [st.stable, st.deathSaves.failures], [false, 1]);
  const big = hero({ hp: 0, maxHp: 12, conditions: ["unconscious"] });
  eq("damage at 0 equal to the maximum kills outright", [R.applyDamage(big, 12, "fire").instantDeath, big.dead], [true, true]);
  const corpse = hero({ hp: 0, dead: true });
  eq("the dead take no more harm", R.applyDamage(corpse, 50, "fire").failuresAdded, 0);
}

// ─── One hit, two kinds of damage ────────────────────────────────────────────
{
  // A bite for 9 piercing with 4 fire on top, against a hero with 9 hit points who resists fire: each kind is
  // adjusted on its own (4 fire becomes 2), and the 11 lands as ONE amount.
  const t = hero({ hp: 9, maxHp: 30, resistances: ["fire"] });
  const parts = [R.adjustDamage(9, "piercing", t).amount, R.adjustDamage(4, "fire", t).amount];
  eq("each kind of damage meets its own resistance", parts, [9, 2]);
  const hit = R.applyDamage(t, parts[0]! + parts[1]!, "piercing", { adjusted: true });
  eq("the hit drops the hero once, and adds no death save failure of its own", [hit.amount, hit.dropped, hit.failuresAdded, t.hp, t.deathSaves.failures, t.dead], [11, true, 0, 0, 0, false]);
  eq("…with one concentration save for the whole of it", hit.concentrationDc, 10);
  const two = hero({ hp: 9, maxHp: 30 });
  R.applyDamage(two, 9, "piercing");
  eq("(applied as two separate hits, the second would count against a hero already down)", R.applyDamage(two, 2, "fire").failuresAdded, 1);
  const stone = hero({ hp: 20, conditions: ["petrified"] });
  eq("an amount already adjusted is not adjusted again", [R.applyDamage(stone, 8, "thunder", { adjusted: true }).amount, stone.hp], [8, 12]);
  const big = hero({ hp: 4, maxHp: 12 });
  eq("the whole hit counts toward being killed outright", R.applyDamage(big, 10 + 6, "piercing", { adjusted: true }).instantDeath, true);
}

// ─── Death saving throws ─────────────────────────────────────────────────────
{
  const a = hero({ hp: 0, conditions: ["unconscious"] });
  const r1 = R.rollDeathSave(dice(10), a);
  const r2 = R.rollDeathSave(dice(15), a);
  const r3 = R.rollDeathSave(dice(12), a);
  eq("10 or higher is a success", [r1.outcome, r1.successes], ["success", 1]);
  eq("three successes: stable, counters cleared", [r2.successes, r3.stable, a.stable, a.deathSaves, a.hp], [2, true, true, { successes: 0, failures: 0 }, 0]);
  const b = hero({ hp: 0, conditions: ["unconscious"] });
  R.rollDeathSave(dice(5), b);
  R.rollDeathSave(dice(9), b);
  const last = R.rollDeathSave(dice(2), b);
  eq("three failures: dead", [last.failures, last.dead, b.dead], [3, true, true]);
  const c = hero({ hp: 0, conditions: ["unconscious"] });
  const one = R.rollDeathSave(dice(1), c);
  eq("a natural 1 counts as two failures", [one.outcome, one.failures], ["two failures", 2]);
  eq("…and one more failure is death", R.rollDeathSave(dice(3), c).dead, true);
  const d = hero({ hp: 0, conditions: ["unconscious"], deathSaves: { successes: 1, failures: 2 } });
  const twenty = R.rollDeathSave(dice(20), d);
  eq("a natural 20: back on 1 hit point, awake, counters cleared", [twenty.outcome, d.hp, d.conditions, d.deathSaves], ["revived", 1, [], { successes: 0, failures: 0 }]);
  const e = hero({ hp: 0, conditions: ["unconscious"] });
  eq("a table roll counts", R.rollDeathSave(dice(), e, 11).outcome, "success");
  const mix = hero({ hp: 0, conditions: ["unconscious"] });
  R.rollDeathSave(dice(14), mix);
  R.rollDeathSave(dice(4), mix);
  eq("successes and failures count separately", mix.deathSaves, { successes: 1, failures: 1 });
}

// ─── Healing at 0, stabilizing ───────────────────────────────────────────────
{
  const t = hero({ hp: 0, conditions: ["unconscious", "poisoned"], deathSaves: { successes: 1, failures: 2 } });
  const h = R.applyHealing(t, 7);
  eq("healing at 0 wakes the hero and clears death saves", [h.revived, t.hp, t.conditions, t.deathSaves], [true, 7, ["poisoned"], { successes: 0, failures: 0 }]);
  const dead = hero({ hp: 0, dead: true });
  eq("healing does nothing for the dead", R.applyHealing(dead, 10).healed, 0);
  const s = hero({ hp: 0, conditions: ["unconscious"], deathSaves: { successes: 0, failures: 2 } });
  R.stabilize(s);
  eq("stabilized: stable at 0, failures cleared, still unconscious", [s.stable, s.hp, s.deathSaves.failures, s.conditions], [true, 0, 0, ["unconscious"]]);
  eq("first aid is DC 10", R.STABILIZE_DC, 10);
}

// ─── Conditions ──────────────────────────────────────────────────────────────
{
  const all = ["blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned", "unconscious"];
  eq("the fourteen conditions", [...R.CONDITIONS], all);
  check("every condition has its rule in words", all.every((c) => typeof R.CONDITION_RULES[c] === "string" && R.CONDITION_RULES[c].length > 30));
  const A = (att: string[], def: string[], melee = true) => R.attackModifiers(att, def, { melee });
  eq("blinded attacker: disadvantage", A(["blinded"], []).adv, "dis");
  eq("blinded target: advantage", A([], ["blinded"]).adv, "adv");
  eq("both blinded: they cancel", A(["blinded"], ["blinded"]).adv, null);
  eq("frightened attacker: disadvantage", A(["frightened"], []).adv, "dis");
  eq("poisoned attacker: disadvantage", A(["poisoned"], []).adv, "dis");
  eq("prone attacker: disadvantage", A(["prone"], []).adv, "dis");
  eq("restrained attacker: disadvantage", A(["restrained"], []).adv, "dis");
  eq("restrained target: advantage", A([], ["restrained"]).adv, "adv");
  eq("invisible attacker: advantage", A(["invisible"], []).adv, "adv");
  eq("invisible target: disadvantage", A([], ["invisible"]).adv, "dis");
  eq("stunned target: advantage", A([], ["stunned"]).adv, "adv");
  eq("petrified target: advantage", A([], ["petrified"]).adv, "adv");
  eq("prone target, attacker within five feet: advantage", A([], ["prone"], true).adv, "adv");
  eq("prone target, attacker farther away: disadvantage", A([], ["prone"], false).adv, "dis");
  eq("paralyzed target in melee: advantage and an automatic critical hit", [A([], ["paralyzed"]).adv, A([], ["paralyzed"]).autoCrit], ["adv", true]);
  eq("paralyzed target at range: advantage, no automatic critical", [A([], ["paralyzed"], false).adv, A([], ["paralyzed"], false).autoCrit], ["adv", false]);
  eq("unconscious target in melee: advantage and an automatic critical hit", [A([], ["unconscious"]).adv, A([], ["unconscious"]).autoCrit], ["adv", true]);
  eq("charmed, deafened and grappled don't change an attack roll", [A(["charmed"], []).adv, A(["deafened"], []).adv, A(["grappled"], []).adv], [null, null, null]);
  eq("a dodging target: disadvantage", A([], ["dodging"]).adv, "dis");
  eq("many sources still give one advantage", A(["invisible"], ["stunned", "restrained"]).adv, "adv");
  const T = R.testModifiers;
  eq("poisoned: disadvantage on ability checks", T(["poisoned"], "check", "dex").adv, "dis");
  eq("poisoned: saves are unaffected", T(["poisoned"], "save", "con").adv, null);
  eq("frightened: disadvantage on ability checks", T(["frightened"], "check", "str").adv, "dis");
  eq("paralyzed: Dexterity saves fail", T(["paralyzed"], "save", "dex").autoFail, true);
  eq("stunned: Strength saves fail", T(["stunned"], "save", "str").autoFail, true);
  eq("unconscious: Dexterity saves fail", T(["unconscious"], "save", "dex").autoFail, true);
  eq("petrified: Strength saves fail", T(["petrified"], "save", "str").autoFail, true);
  eq("paralyzed: Wisdom saves are rolled", T(["paralyzed"], "save", "wis").autoFail, false);
  eq("restrained: disadvantage on Dexterity saves", T(["restrained"], "save", "dex").adv, "dis");
  eq("blinded: a check that needs sight fails", T(["blinded"], "check", "wis", { sight: true }).autoFail, true);
  eq("deafened: a check that needs hearing fails", T(["deafened"], "check", "wis", { hearing: true }).autoFail, true);
  eq("blinded: other checks are rolled", T(["blinded"], "check", "str").autoFail, false);
  eq("who can't act", ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious", "poisoned", "prone"].map((c) => R.incapacitated([c])), [true, true, true, true, true, false, false]);
  eq("grappled and restrained: speed 0", [R.effectiveSpeed(30, ["grappled"]), R.effectiveSpeed(30, ["restrained"]), R.effectiveSpeed(30, [])], [0, 0, 30]);
}

// ─── Condition durations ─────────────────────────────────────────────────────
{
  const c = { conditions: [] as string[], conditionRounds: {} as Record<string, number> };
  R.addCondition(c, "poisoned", 2);
  R.addCondition(c, "prone");
  eq("a timed condition and a lasting one", [c.conditions, c.conditionRounds], [["poisoned", "prone"], { poisoned: 2 }]);
  eq("the first round passes", [R.tickConditions(c), c.conditionRounds.poisoned], [[], 1]);
  eq("the second round ends it", [R.tickConditions(c), c.conditions], [["poisoned"], ["prone"]]);
  eq("a lasting condition never runs out", [R.tickConditions(c), c.conditions], [[], ["prone"]]);
  R.addCondition(c, "frightened", 2);
  R.addCondition(c, "frightened", 5);
  eq("a longer duration replaces a shorter one", c.conditionRounds.frightened, 5);
  R.addCondition(c, "frightened", 1);
  eq("a shorter one doesn't", c.conditionRounds.frightened, 5);
  eq("removing a condition clears its timer", [R.removeCondition(c, "frightened"), c.conditions, c.conditionRounds], [true, ["prone"], {}]);
  eq("removing what isn't there does nothing", R.removeCondition(c, "stunned"), false);
}

// ─── Exhaustion ──────────────────────────────────────────────────────────────
{
  eq("exhaustion takes 2 per level off every d20", [0, 1, 3, 6].map(R.exhaustionPenalty), [0, 2, 6, 12]);
  eq("exhaustion takes 5 feet per level off speed", R.effectiveSpeed(30, [], 2), 20);
  const t = { exhaustion: 4 };
  eq("the fifth level isn't fatal", R.addExhaustion(t), { level: 5, dead: false });
  eq("the sixth is", R.addExhaustion(t), { level: 6, dead: true });
  eq("it can be removed", R.addExhaustion({ exhaustion: 2 }, -1).level, 1);
}

// ─── Concentration ───────────────────────────────────────────────────────────
{
  eq("concentration DC: 10, or half the damage if higher, 30 at most", [5, 20, 21, 22, 50, 80].map(R.concentrationDc), [10, 10, 10, 11, 25, 30]);
  const keep = R.rollConcentration(dice(8), 2, 9);
  eq("8 plus 2 against DC 10 holds the spell", [keep.dc, keep.total, keep.success], [10, 10, true]);
  eq("7 plus 2 loses it", R.rollConcentration(dice(7), 2, 9).success, false);
  eq("damage reports the DC to beat", R.applyDamage(hero(), 30, "fire").concentrationDc, 15);
}

// ─── Initiative and surprise ─────────────────────────────────────────────────
{
  const order = R.rollInitiative(dice(10, 15, 10, 4), [
    { id: "t", kind: "hero", name: "Thorin", dexMod: 1 },
    { id: "g", kind: "npc", name: "Goblin", dexMod: 2 },
    { id: "m", kind: "hero", name: "Mira", dexMod: 3 },
    { id: "w", kind: "npc", name: "Wolf", dexMod: 2 },
  ]);
  eq("initiative: highest total first", order.map((o: { id: string; total: number }) => [o.id, o.total]), [["g", 17], ["m", 13], ["t", 11], ["w", 6]]);
  const tie = R.rollInitiative(dice(10, 11, 12), [
    { id: "a", kind: "npc", name: "Orc", dexMod: 2 },
    { id: "b", kind: "hero", name: "Bree", dexMod: 1 },
    { id: "c", kind: "hero", name: "Cal", dexMod: 0 },
  ]);
  eq("a tie goes to the higher Dexterity modifier", tie.map((o: { id: string }) => o.id), ["a", "b", "c"]);
  const tie2 = R.rollInitiative(dice(10, 10), [
    { id: "n", kind: "npc", name: "Orc", dexMod: 1 },
    { id: "h", kind: "hero", name: "Zed", dexMod: 1 },
  ]);
  eq("then to a hero over a monster", tie2.map((o: { id: string }) => o.id), ["h", "n"]);
  const sur = R.rollInitiative(dice(18, 3), [{ id: "s", kind: "hero", name: "Sam", dexMod: 2, surprised: true }]);
  eq("surprised: disadvantage on initiative", [sur[0].rolls, sur[0].roll, sur[0].total, sur[0].surprised], [[18, 3], 3, 5, true]);
  const both = R.rollInitiative(dice(18), [{ id: "s", kind: "hero", name: "Sam", dexMod: 2, surprised: true, adv: "adv" }]);
  eq("surprise and advantage cancel: one die", both[0].rolls, [18]);
}

// ─── Reactions ───────────────────────────────────────────────────────────────
{
  eq("an opportunity attack needs an unused reaction", [R.canReact([], false), R.canReact([], true)], [true, false]);
  eq("…and a creature that can act", R.canReact(["stunned"], false), false);
}

// ─── Rests ───────────────────────────────────────────────────────────────────
{
  const t = hero({ hp: 5 });
  const s = R.shortRest(dice(4, 7), t, 2);
  eq("short rest: each hit die heals the roll plus Constitution", [s.spent, s.rolls, s.healed, t.hp, s.diceLeft, t.hitDiceUsed], [2, [4, 7], 15, 20, 1, 2]);
  const fullHp = hero();
  eq("no dice are spent at full hit points", R.shortRest(dice(), fullHp, 3).spent, 0);
  const frail = hero({ hp: 1, stats: { str: 10, dex: 10, con: 6, int: 10, wis: 10, cha: 10 } });
  eq("a hit die heals at least 1", [R.shortRest(dice(1), frail, 1).healed, frail.hp], [1, 2]);
  const spent = hero({ hp: 5, hitDiceUsed: 3 });
  eq("no hit dice left, nothing to spend", R.shortRest(dice(), spent, 2).spent, 0);
  const one = hero({ hp: 5, hitDiceUsed: 2 });
  eq("you can't spend more dice than you have", R.shortRest(dice(3, 3), one, 5).spent, 1);
  const tired = hero({ hp: 3, tempHp: 6, hitDiceUsed: 3, exhaustion: 2, slotsMax: [4, 2, 0, 0, 0, 0, 0, 0, 0], slotsUsed: [3, 2, 0, 0, 0, 0, 0, 0, 0] });
  const l = R.longRest(tired);
  eq("long rest: hit points, hit dice and spell slots all back", [l.healed, tired.hp, l.diceRestored, tired.hitDiceUsed, l.slotsRestored, tired.slotsUsed.slice(0, 2)], [25, 28, 3, 0, 5, [0, 0]]);
  eq("…one level of exhaustion less, temporary hit points gone", [tired.exhaustion, tired.tempHp], [1, 0]);
  const down = hero({ hp: 0, conditions: ["unconscious"], deathSaves: { successes: 0, failures: 2 } });
  R.longRest(down);
  eq("a long rest brings a downed hero back up", [down.hp, down.conditions, down.deathSaves.failures], [28, [], 0]);
  const dead = hero({ hp: 0, dead: true });
  eq("the dead don't rest", [R.longRest(dead).healed, dead.hp], [0, 0]);
}

// ─── Spell slots ─────────────────────────────────────────────────────────────
{
  eq("full caster, level 1", R.fullCasterSlots(1), [2, 0, 0, 0, 0, 0, 0, 0, 0]);
  eq("full caster, level 3", R.fullCasterSlots(3), [4, 2, 0, 0, 0, 0, 0, 0, 0]);
  eq("full caster, level 5", R.fullCasterSlots(5), [4, 3, 2, 0, 0, 0, 0, 0, 0]);
  eq("full caster, level 11", R.fullCasterSlots(11), [4, 3, 3, 3, 2, 1, 0, 0, 0]);
  eq("full caster, level 20", R.fullCasterSlots(20), [4, 3, 3, 3, 3, 2, 2, 1, 1]);
  eq("half caster, levels 1, 2 and 5", [R.halfCasterSlots(1), R.halfCasterSlots(2), R.halfCasterSlots(5)].map((s: number[]) => s.slice(0, 3)), [[0, 0, 0], [2, 0, 0], [4, 2, 0]]);
  eq("pact magic: level 1, 5 and 11", [R.pactSlots(1), R.pactSlots(5), R.pactSlots(11)].map((s: number[]) => s.slice(0, 5)), [[1, 0, 0, 0, 0], [0, 0, 2, 0, 0], [0, 0, 0, 0, 3]]);
  eq("no caster, no slots", R.slotsFor(null, 9), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const w = { slotsMax: R.fullCasterSlots(3), slotsUsed: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  eq("spending a level 1 slot", [R.spendSlot(w, 1), R.slotsLeft(w, 1)], [{ ok: true, level: 1 }, 3]);
  w.slotsUsed[0] = 4;
  eq("no level 1 slot left: the next level up is spent", [R.spendSlot(w, 1), R.slotsLeft(w, 2)], [{ ok: true, level: 2 }, 1]);
  w.slotsUsed[1] = 2;
  eq("nothing left: the spell fails to cast", R.spendSlot(w, 1).ok, false);
  eq("a slot too high for the caster", R.spendSlot({ slotsMax: R.fullCasterSlots(1), slotsUsed: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, 3).ok, false);
  eq("restoring returns every slot", [R.restoreSlots(w), w.slotsUsed], [6, [0, 0, 0, 0, 0, 0, 0, 0, 0]]);
}

// ─── Inspiration ─────────────────────────────────────────────────────────────
{
  const h = { inspiration: false };
  eq("inspiration is gained once", [R.grantInspiration(h), R.grantInspiration(h), h.inspiration], [true, false, true]);
  eq("spending it buys advantage, once", [R.spendInspiration(h), R.spendInspiration(h), h.inspiration], ["adv", null, false]);
}

// ─── Experience and levels ───────────────────────────────────────────────────
{
  eq("level by XP", [0, 299, 300, 899, 900, 2700, 6500, 355000].map(R.levelForXp), [1, 1, 2, 2, 3, 4, 5, 20]);
  eq("XP to the next level", [R.xpToNextLevel(1, 120), R.xpToNextLevel(2, 300), R.xpToNextLevel(20, 400000)], [180, 600, 0]);
  eq("XP by challenge rating", [0, 0.125, 0.25, 0.5, 1, 2, 3, 5, 10].map(R.xpForCr), [10, 25, 50, 100, 200, 450, 700, 1800, 5900]);
  eq("an award is shared evenly, rounded down", [R.splitXp(100, 3), R.splitXp(450, 4), R.splitXp(100, 0)], [33, 112, 0]);
  eq("hit points per level: the die's average plus Constitution", [R.hpPerLevel(10, 2), R.hpPerLevel(6, -3)], [8, 1]);
  eq("hit point maximum by level", [R.maxHpFor(10, 14, 1), R.maxHpFor(10, 14, 3), R.maxHpFor(6, 8, 2)], [12, 28, 8]);
}

// ─── Encounter budgets ───────────────────────────────────────────────────────
{
  eq("budget per character at level 1", R.XP_BUDGET[0], { low: 50, moderate: 75, high: 100 });
  eq("budget per character at level 5", R.XP_BUDGET[4], { low: 500, moderate: 750, high: 1100 });
  eq("budget per character at level 20", R.XP_BUDGET[19], { low: 6400, moderate: 13200, high: 22000 });
  eq("three level 1 heroes, moderate", R.encounterBudget([1, 1, 1], "moderate"), 225);
  eq("four level 3 heroes, high", R.encounterBudget([3, 3, 3, 3], "high"), 1600);
  eq("a mixed party adds each hero's own budget", R.encounterBudget([1, 2, 3], "low"), 300);
  const rate = (xp: number[]) => R.rateEncounter([1, 1, 1], xp).rating;
  eq("rating an encounter for three level 1 heroes", [rate([50]), rate([50, 50]), rate([50, 50, 50, 50]), rate([200, 100]), rate([200, 100, 25])], ["trivial", "low", "moderate", "high", "beyond high"]);
}

// ─── SRD tables: classes, weapons, armor, potions ────────────────────────────
{
  check("the attribution names SRD 5.2.1 and the license", /System Reference Document 5\.2\.1/.test(S.SRD_ATTRIBUTION) && /Creative Commons Attribution 4\.0 International License/.test(S.SRD_ATTRIBUTION));
  const f = S.classProfile("Fighter");
  eq("fighter: d10, Strength and Constitution saves, no spells", [f.hitDie, f.saves, f.caster], [10, ["str", "con"], null]);
  const w = S.classProfile("Elf Wizard");
  eq("wizard: d6, Intelligence casting, a full caster", [w.hitDie, w.ability, w.caster], [6, "int", "full"]);
  eq("a mage casts like a wizard", S.classProfile("Mage").caster, "full");
  eq("an engineer borrows the chassis but casts nothing", [S.classProfile("Engineer").hitDie, S.classProfile("Engineer").caster], [6, null]);
  eq("warlock: pact magic", S.classProfile("Warlock").caster, "pact");
  eq("paladin: a half caster", S.classProfile("Paladin").caster, "half");
  eq("an unknown class still gets a sheet", S.classProfile("Beekeeper").hitDie, 8);
  const item = (name: string, type = "weapon", properties: string[] = []) => ({ name, type, properties });
  eq("longsword: 1d8 slashing", [S.weaponStats(item("Longsword")).damage, S.weaponStats(item("Longsword")).damageType], ["1d8", "slashing"]);
  eq("a dwarven waraxe is a battleaxe", S.weaponStats(item("Dwarven Waraxe")).damage, "1d8");
  eq("a shortbow is ranged", S.weaponStats(item("Shortbow")).ranged, true);
  eq("a rapier is finesse", S.weaponStats(item("Rapier")).finesse, true);
  eq("greatsword: 2d6", S.weaponStats(item("Greatsword")).damage, "2d6");
  eq("a damage tag on the item wins", S.weaponStats(item("Ember Blade", "weapon", ["2d6 fire"])).damage, "2d6");
  eq("a +1 weapon carries its bonus", S.weaponStats(item("Longsword +1")).bonus, 1);
  eq("a lute is no weapon", S.weaponStats(item("Lute", "gear")), null);
  const st = { str: 16, dex: 14, con: 14, int: 8, wis: 12, cha: 10 };
  const armor = (name: string) => S.armorStats(item(name, "armor"));
  eq("chain mail: 16, no Dexterity", S.armorClass({ stats: st, className: "Fighter" }, armor("Chain mail"), null), 16);
  eq("chain mail and a shield: 18", S.armorClass({ stats: st, className: "Fighter" }, armor("Chain mail"), armor("Shield")), 18);
  eq("leather armor: 11 plus Dexterity", S.armorClass({ stats: st, className: "Rogue" }, armor("Leather armor"), null), 13);
  eq("scale mail: 14 plus Dexterity, 2 at most", S.armorClass({ stats: { ...st, dex: 18 }, className: "Cleric" }, armor("Scale mail"), null), 16);
  eq("unarmored: 10 plus Dexterity", S.armorClass({ stats: st, className: "Wizard" }, null, null), 12);
  eq("an unarmored barbarian adds Constitution", S.armorClass({ stats: st, className: "Barbarian" }, null, null), 14);
  eq("an unarmored monk adds Wisdom", S.armorClass({ stats: st, className: "Monk" }, null, null), 13);
  eq("a potion of healing heals 2d4+2", S.healingDice(item("Potion of Healing", "potion")), "2d4+2");
  eq("a greater one heals 4d4+4", S.healingDice(item("Potion of Greater Healing", "potion")), "4d4+4");
  eq("a heal tag on the item wins", S.healingDice(item("Moss Poultice", "gear", ["heals 1d6+1"])), "1d6+1");
  eq("a rope doesn't heal", S.healingDice(item("Rope", "gear")), null);
  eq("prices: a potion of healing is 50 gold, a longsword 15", [S.itemPrice({ name: "Potion of Healing", type: "potion", rarity: "common" }), S.itemPrice({ name: "Longsword", type: "weapon", rarity: "common" })], [50, 15]);
  eq("half plate isn't priced as plate", S.itemPrice({ name: "Half plate", type: "armor", rarity: "common" }), 750);
  const price = (name: string, type: string, rarity = "common") => S.itemPrice({ name, type, rarity });
  eq("a cheap listed item costs what the list says: a shield 10, a dagger 2, a quarterstaff 1", [price("Shield", "armor"), price("Dagger", "weapon"), price("Quarterstaff", "weapon")], [10, 2, 1]);
  eq("an unlisted item is priced by its kind", [price("Odd trinket", "gear"), price("Moon-silver circlet", "wondrous"), price("Foreman's key", "quest")], [2, 100, 0]);
  eq("rarity raises a price, and never lowers a listed one", [price("Longsword of the Dawn", "weapon", "rare"), price("Plate armor", "armor", "uncommon"), price("Amulet", "wondrous", "uncommon")], [500, 1500, 500]);
}

// ─── SRD tables: spells and rules answers ────────────────────────────────────
{
  eq("fire bolt: a cantrip attack, 1d10 fire", [S.SPELLS["fire bolt"].level, S.SPELLS["fire bolt"].kind, S.SPELLS["fire bolt"].damage], [0, "attack", "1d10"]);
  eq("a spell is found in a sentence", S.findSpell("I cast magic missile at the goblin")?.name, "Magic Missile");
  eq("a run-together name is found too", S.findSpell("firebolt the wolf")?.name, "Fire Bolt");
  eq("the longest name wins", S.findSpell("mass healing word on everyone")?.name, "Mass Healing Word");
  eq("no spell, no match", S.findSpell("I open the door"), null);
  eq("cantrips grow at levels 5, 11 and 17", [1, 5, 11, 17].map((l) => S.cantripDice("1d10", l)), ["1d10", "2d10", "3d10", "4d10"]);
  eq("magic missile in a level 2 slot: a fourth dart", S.upcastDice("3d4+3", "1d4+1", 1, 2), "4d4+4");
  eq("fireball in a level 5 slot", S.upcastDice("8d6", "1d6", 3, 5), "10d6");
  eq("a spell in its own slot is unchanged", S.upcastDice("3d6", "1d6", 1, 1), "3d6");
  eq("rules: grappling", S.rulesAnswer("how does grappling work")?.topic, "grapple");
  eq("rules: the grappled condition", S.rulesAnswer("what does being grappled do")?.topic, "grappled");
  eq("rules: death saves", S.rulesAnswer("how do death saves work")?.topic, "death saves");
  eq("rules: opportunity attacks", S.rulesAnswer("do I provoke an opportunity attack")?.topic, "opportunity attack");
  eq("rules: advantage", S.rulesAnswer("what is advantage")?.topic, "advantage");
  eq("rules: a long rest", S.rulesAnswer("what does a long rest give us")?.topic, "long rest");
  eq("rules: prone", S.rulesAnswer("what happens when I'm prone")?.topic, "prone");
  eq("rules: nothing to say about lunch", S.rulesAnswer("what's for lunch"), null);
  const answers: string[] = S.RULE_TOPIC_KEYS.map((k: string) => S.rulesAnswer(k)?.answer ?? "");
  check("every rules answer is short enough to say (60 words at most)", answers.every((a) => a.split(/\s+/).length <= 60), answers.find((a) => a.split(/\s+/).length > 60));
  check("no rules answer has digits a voice would stumble on", answers.every((a) => !/\d/.test(a)), answers.find((a) => /\d/.test(a)));
}

// ─── Bestiary ────────────────────────────────────────────────────────────────
{
  const all = B.listMonsters();
  check("at least thirty creatures", all.length >= 30, all.length);
  const wanted = ["goblin", "kobold", "skeleton", "zombie", "wolf", "bandit", "cultist", "giant rat", "giant spider", "orc", "hobgoblin", "bugbear", "gnoll", "ghoul", "ogre", "owlbear", "troll", "wight", "mimic", "gelatinous cube", "red dragon wyrmling", "white dragon wyrmling"];
  eq("the common ones are all there", wanted.filter((k) => !B.BESTIARY[k]), []);
  const banned = /beholder|mind flayer|illithid|displacer|githyanki|githzerai|umber hulk|yuan-ti|carrion crawler|strahd|slaad|kuo-toa/i;
  check("no product-identity creatures", all.every((m: { name: string }) => !banned.test(m.name)));
  check("every creature has an attack that parses", all.every((m: { attacks: unknown[] }) => m.attacks.length > 0), all.filter((m: { attacks: unknown[] }) => !m.attacks.length).map((m: { name: string }) => m.name));
  check("every creature's XP matches its challenge rating", all.every((m: { xp: number; cr: number }) => m.xp === R.xpForCr(m.cr)));
  check("every attack's damage is real dice", all.every((m: { attacks: { damage: string }[] }) => m.attacks.every((a) => R.parseDice(a.damage) !== null)));
  check("challenge ratings run from 0 to 10", all[0].cr === 0 && all[all.length - 1].cr === 10);
  const g = B.BESTIARY.goblin;
  eq("goblin: AC 15, 7 hit points, challenge 1/4, 50 XP", [g.ac, g.hp, g.cr, g.xp], [15, 7, 0.25, 50]);
  eq("goblin scimitar: +4, 1d6+2 slashing", [g.attacks[0].name, g.attacks[0].toHit, g.attacks[0].damage, g.attacks[0].damageType], ["Scimitar", 4, "1d6+2", "slashing"]);
  eq("a wolf's bite can knock prone", B.BESTIARY.wolf.attacks[0].rider, { ability: "str", dc: 11, condition: "prone", rounds: null, damage: null, damageType: null, half: false });
  eq("a giant spider's bite is poisonous", B.BESTIARY["giant spider"].attacks[0].rider, { ability: "con", dc: 11, condition: null, rounds: null, damage: "2d8", damageType: "poison", half: true });
  eq("a hell hound's bite burns", [B.BESTIARY["hell hound"].attacks[0].extraDamage, B.BESTIARY["hell hound"].attacks[0].extraType], ["2d6", "fire"]);
  eq("a red dragon wyrmling breathes fire", [B.BESTIARY["red dragon wyrmling"].breath.dc, B.BESTIARY["red dragon wyrmling"].breath.damage], [13, "7d6"]);
  eq("a troll regenerates and attacks three times", [B.BESTIARY.troll.regen, B.BESTIARY.troll.attacksPerTurn], [10, 3]);
  eq("a skeleton fears the hammer", B.BESTIARY.skeleton.vulnerabilities, ["bludgeoning"]);
  eq("found by name in a sentence", B.findMonster("three giant rats scurry out")?.key, "giant rat");
  eq("plurals are understood", [B.findMonster("a pack of wolves")?.key, B.findMonster("zombies everywhere")?.key, B.findMonster("two harpies")?.key], ["wolf", "zombie", "harpy"]);
  eq("the longest name wins", B.findMonster("a giant wolf spider drops down")?.key, "giant wolf spider");
  eq("nothing known, nothing found", B.findMonster("a strange glowing mist"), null);
  const block = B.statBlockOf(g);
  eq("a stat block is a fresh copy", [block.hp, block.maxHp, block.statted, block.attacks !== g.attacks], [7, 7, true, true]);
  eq("health bands", [B.healthBand(10, 10), B.healthBand(6, 10), B.healthBand(5, 10), B.healthBand(2, 10), B.healthBand(0, 10)], ["healthy", "healthy", "bloodied", "near death", "down"]);
}

// ─── Generated creatures are held to their challenge rating ──────────────────
{
  const wild = B.validateStatBlock({
    cr: 0.25,
    ac: 30,
    hp: 900,
    stats: { str: 40, dex: 3, con: 99, int: 0, wis: 10, cha: 10 },
    attacks: [{ name: "doom bite", toHit: 19, damage: "10d12+20", damageType: "necrotic" }, { name: "", damage: "1d4" }, { name: "x", damage: "lots" }],
    attacksPerTurn: 9,
    immunities: ["fire", "everything"],
  });
  const b = B.crBounds(0.25);
  check("armor class is clamped", wild.ac <= b.ac[1], wild.ac);
  check("hit points are clamped", wild.hp <= b.hp[1] && wild.hp === wild.maxHp, wild.hp);
  check("to-hit is clamped", wild.attacks[0].toHit <= b.toHit[1], wild.attacks[0].toHit);
  check("damage is cut down to size", R.averageDice(wild.attacks[0].damage) <= b.damage[1], wild.attacks[0].damage);
  eq("attacks that don't parse are dropped", wild.attacks.length, 1);
  eq("the number of attacks is clamped", wild.attacksPerTurn, 1);
  check("ability scores are clamped", wild.stats.str <= b.ability && wild.stats.int >= 1, wild.stats);
  eq("XP follows the challenge rating", wild.xp, 50);
  eq("only real damage types are kept", wild.immunities, ["fire"]);
  const empty = B.validateStatBlock({}, { cr: 2 });
  check("nothing given: a usable generic block of that rating", empty.cr === 2 && empty.attacks.length === 1 && empty.hp > 0 && empty.xp === 450, empty);
  eq("a rating above the cap is brought down", B.validateStatBlock({ cr: 12 }, { maxCr: 3 }).cr, 3);
  eq("challenge ratings snap to real ones", [B.snapCr("1/4"), B.snapCr(0.3), B.snapCr("7"), B.snapCr("huge")], [0.25, 0.25, 7, 0.25]);
  for (const cr of [0, 0.125, 0.5, 1, 3, 5, 10]) {
    const gen = B.genericStatBlock(cr);
    const bounds = B.crBounds(cr);
    check(`the generic challenge ${cr} block is inside its own bounds`, gen.hp >= bounds.hp[0] && gen.hp <= bounds.hp[1] && gen.ac <= bounds.ac[1] && gen.attacks[0].toHit <= bounds.toHit[1] && R.averageDice(gen.attacks[0].damage) <= bounds.damage[1], gen);
  }
  const inBounds = B.listMonsters().filter((m: { cr: number; hp: number; ac: number }) => {
    const bb = B.crBounds(m.cr);
    return m.hp > bb.hp[1] || m.ac > bb.ac[1];
  });
  eq("every SRD creature sits inside the envelope for its rating", inBounds.map((m: { name: string }) => m.name), []);
}

// ─── Encounter builder ───────────────────────────────────────────────────────
{
  const p = B.buildEncounter({ levels: [1, 1, 1], difficulty: "moderate", rng: R.seededRng(7), theme: "a goblin cave in the hills" });
  check("the encounter fits the budget", p.totalXp > 0 && p.totalXp <= p.budget && p.budget === 225, p.why);
  eq("the theme picks the creature", p.picks[0].monster.key, "goblin");
  eq("as many as the budget buys", p.picks[0].count, 4);
  eq("it is rated against the party", p.rating, "moderate");
  const again = B.buildEncounter({ levels: [1, 1, 1], difficulty: "moderate", rng: R.seededRng(7), theme: "a goblin cave in the hills" });
  eq("the same seed builds the same encounter", again.why, p.why);
  const low = B.buildEncounter({ levels: [1, 1, 1], difficulty: "low", rng: R.seededRng(7), theme: "a goblin cave in the hills" });
  const high = B.buildEncounter({ levels: [1, 1, 1], difficulty: "high", rng: R.seededRng(7), theme: "a goblin cave in the hills" });
  check("harder settings spend more", low.totalXp < p.totalXp && p.totalXp < high.totalXp, [low.totalXp, p.totalXp, high.totalXp]);
  const crypt = B.buildEncounter({ levels: [3, 3, 3, 3], difficulty: "moderate", rng: R.seededRng(11), theme: "an old crypt full of tombs" });
  check("a crypt gets the undead", crypt.picks[0].monster.type === "undead", crypt.why);
  check("nothing above the party's level", crypt.picks.every((x: { monster: { cr: number } }) => x.monster.cr <= 3));
  const cap = B.buildEncounter({ levels: [5, 5, 5, 5], difficulty: "high", rng: R.seededRng(3), theme: "sewer rats" });
  check("the table is never crowded", cap.picks.reduce((n: number, x: { count: number }) => n + x.count, 0) <= 6, cap.why);
  const fav = B.buildEncounter({ levels: [2, 2], difficulty: "moderate", rng: R.seededRng(5), favor: ["kobold"], maxFoes: 12 });
  eq("the adventure's own threats are favored", fav.picks[0].monster.key, "kobold");
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const levels of [[1], [1, 1, 1, 1], [4, 4, 4], [8, 8, 8, 8], [12, 12, 12]]) {
      const e = B.buildEncounter({ levels, difficulty: "high", rng: R.seededRng(seed) });
      if (e.totalXp > e.budget || e.totalXp <= 0) check(`budget holds for seed ${seed}, levels ${levels.join(",")}`, false, e.why);
    }
  }
  check("the budget holds for every seed and party tried", true);
  const t = B.treasureFor(dice(3, 4, 18), 200);
  eq("treasure: coins by what the fight was worth, sometimes a potion", t, { gold: 14, potion: true });
  eq("no fight, no treasure", B.treasureFor(dice(), 0), { gold: 0, potion: false });
}

// ─── How results are said ────────────────────────────────────────────────────
{
  const L = await load("lines.ts");
  eq("a sum is said with its parts", [L.sumWords(17, 22), L.sumWords(9, 8), L.sumWords(14, 14)], ["17 plus 5 is 22", "9 minus 1 is 8", "14"]);
  eq("advantage says both dice, then the one that counts", L.d20Words({ rolls: [18, 4], kept: 4, adv: "dis" }, 9), "18 and 4 with disadvantage, so 4 plus 5 is 9");
  eq("sentences are joined, each with its full stop", L.joinLines(["One", "", null, "Two!", " Three  spaced "]), "One. Two! Three spaced.");
  eq("only whole sentences that fit are kept", L.fitSentences("One two three. Four five six. Seven.", 6), "One two three. Four five six.");
  eq("a creature of a kind is 'the goblin', a numbered one 'goblin 2', a named one keeps its name", [L.npcRef({ name: "Goblin", kind: "goblin" }), L.npcRef({ name: "Goblin 2", kind: "goblin" }, true), L.npcRef({ name: "Mother Ilse", kind: "" })], ["the goblin", "Goblin 2", "Mother Ilse"]);

  // A short result is said exactly as built.
  const short = ["Mira attacks goblin 1 with the shortsword: 15 plus 5 is 20 against armor class 15, a hit for 7 piercing damage.", "Goblin 1 is defeated.", "Thorin, you're up."];
  eq("a result that fits is left alone", L.tighten(short), short);

  // A hero's action followed by five monsters' turns: well past what the voice says in one go.
  const long = [
    "Thorin attacks goblin 1 with the longsword: 4 plus 5 is 9 against armor class 15, a miss.",
    "Goblin 1 attacks Thorin: 6 against armor class 18, a miss.",
    "Goblin 2 attacks Thorin: a natural 1, a miss.",
    "Goblin 3 attacks Mira: 9 against armor class 14, a miss.",
    "The wolf attacks Mira: 17 against armor class 14, a hit for 7 piercing damage. Mira has 2 hit points left.",
    "Mira's Strength save: 2 minus 1 is 1 against DC 11, a failure: Mira is prone.",
    "The ogre attacks Lyra: 19 against armor class 12, a critical hit for 21 bludgeoning damage. Lyra drops to 0 hit points and falls unconscious.",
    "Goblin 4 attacks Thorin: 11 against armor class 18, a miss.",
    "Mira, you're up.",
  ];
  const words = (xs: string[]) => (xs.join(" ").match(/\S+/g) ?? []).length;
  const tight: string[] = L.tighten(long);
  check("a long run of monster turns is brought under the limit", words(long) > L.SPOKEN_LIMIT && words(tight) <= L.SPOKEN_LIMIT, { before: words(long), after: words(tight), tight });
  eq("the hero's own roll is said in full", tight[0], long[0]);
  eq("the last sentence still says who is up", tight[tight.length - 1], "Mira, you're up.");
  check("misses lose their arithmetic and are said together when they are at the same hero", tight.includes("Goblin 1 and Goblin 2 miss Thorin.") && tight.includes("Goblin 3 misses Mira.") && tight.includes("Goblin 4 misses Thorin."), tight);
  check("what a hit did is still said: the damage, and where it leaves the hero", tight.some((l) => l.includes("for 7 piercing damage. Mira has 2 hit points left.")) && tight.some((l) => l.includes("for 21 bludgeoning damage. Lyra drops to 0 hit points and falls unconscious.")), tight);
  const digits = (xs: string[]) => new Set(xs.join(" ").match(/\d+/g) ?? []);
  check("no number is changed, only left out", [...digits(tight)].every((n) => digits(long).has(n)), [...digits(tight)]);
  check("a forced save keeps its verdict and what it did", tight.includes("Mira fails a Strength save: Mira is prone."), tight);
  // One monster fewer and the same run fits sooner: the save is then said in full.
  const lessLong = long.filter((l) => !l.startsWith("Goblin 4"));
  const lessTight: string[] = L.tighten(lessLong);
  check("it is shortened only as far as needed: with room, the save keeps its numbers", words(lessTight) <= L.SPOKEN_LIMIT && lessTight.includes(long[5]), { words: words(lessTight), lessTight });
}

console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}.`);
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
