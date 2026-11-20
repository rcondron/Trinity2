import crypto from "node:crypto";
import type { AbilityKey, Adv, DeathSaves, Stats } from "./types.js";

/**
 * The rules engine: every number the Game Master speaks comes from here. Pure functions over plain
 * data with an injectable random source, so a test can script every die. No I/O, no game store, no
 * model: the language model never decides a hit, a save or a number.
 *
 * Rules follow the System Reference Document (see srd.ts for the attribution): d20 tests against a DC
 * or an armor class, advantage and disadvantage (2d20, keep high or low, never stacking), natural 20 and
 * natural 1 on attacks, damage types with resistance / vulnerability / immunity, temporary hit points,
 * dropping to 0, death saving throws, the conditions, exhaustion, concentration, initiative, cover,
 * rests, spell slots, experience and encounter budgets.
 */

// ─── Random source ───────────────────────────────────────────────────────────

/** A die: returns a whole number from 1 to `sides`. */
export type Rng = (sides: number) => number;

export const cryptoRng: Rng = (sides) => crypto.randomInt(1, Math.max(1, Math.floor(sides)) + 1);

/** A repeatable die (mulberry32) for tests and replays. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return (sides) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return 1 + Math.floor(r * Math.max(1, Math.floor(sides)));
  };
}

export interface ScriptedRng extends Rng {
  /** Scripted values not yet used. */
  left(): number;
}

/**
 * A die that returns the scripted values in order (a test's "the d20 shows 17, the d8 shows 4"). A value that
 * doesn't fit the die asked for is a script out of step with the code: it throws rather than rolling on. Once the
 * script runs out, `then` rolls (default: throw).
 */
export function scriptedRng(script: number[], then?: Rng): ScriptedRng {
  const queue = [...script];
  const rng = ((sides: number) => {
    if (!queue.length) {
      if (then) return then(sides);
      throw new Error(`scripted dice ran out (a d${sides} was rolled)`);
    }
    const v = queue.shift()!;
    if (!Number.isInteger(v) || v < 1 || v > sides) throw new Error(`scripted die ${v} doesn't fit a d${sides}`);
    return v;
  }) as ScriptedRng;
  rng.left = () => queue.length;
  return rng;
}

// ─── Dice expressions ────────────────────────────────────────────────────────

export interface DiceTerm {
  count: number;
  sides: number;
}

/** "2d6+3", "1d8+1d6+2", "d20", "4" (a flat amount). */
export interface Dice {
  terms: DiceTerm[];
  modifier: number;
}

export interface DiceRoll {
  notation: string;
  /** Every die, in the order rolled. */
  rolls: number[];
  modifier: number;
  total: number;
}

const MAX_DICE = 100;
const MAX_SIDES = 1000;

/** Parse NdM+K (several dice terms and flat numbers, joined by + or −). Null when it isn't dice. */
export function parseDice(text: string): Dice | null {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, "");
  if (!t || !/^[+-]?(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/.test(t)) return null;
  const terms: DiceTerm[] = [];
  let modifier = 0;
  for (const m of t.matchAll(/([+-]?)(?:(\d*)d(\d+)|(\d+))/g)) {
    const sign = m[1] === "-" ? -1 : 1;
    if (m[3] !== undefined) {
      const count = Math.min(MAX_DICE, Math.max(1, m[2] ? Number(m[2]) : 1));
      const sides = Math.min(MAX_SIDES, Math.max(2, Number(m[3])));
      if (sign < 0) return null; // subtracting dice isn't a thing at this table
      terms.push({ count, sides });
    } else modifier += sign * Number(m[4]);
  }
  return { terms, modifier };
}

export function diceText(d: Dice): string {
  const dice = d.terms.map((t) => `${t.count}d${t.sides}`).join("+");
  const mod = d.modifier ? (d.modifier > 0 ? `+${d.modifier}` : `${d.modifier}`) : "";
  return dice ? `${dice}${mod}` : String(d.modifier);
}

/** The average result (3.5 per d6), for sizing up a stat block. */
export function averageDice(d: Dice | string): number {
  const dice = typeof d === "string" ? parseDice(d) : d;
  if (!dice) return 0;
  return dice.terms.reduce((s, t) => s + (t.count * (t.sides + 1)) / 2, 0) + dice.modifier;
}

/**
 * Roll a dice expression. A critical hit doubles the DICE, never the modifier. The total is never below 0.
 */
export function rollDice(dice: Dice | string, rng: Rng, opts: { crit?: boolean } = {}): DiceRoll {
  const d = typeof dice === "string" ? parseDice(dice) : dice;
  if (!d) return { notation: String(dice), rolls: [], modifier: 0, total: 0 };
  const rolls: number[] = [];
  const times = opts.crit ? 2 : 1;
  for (const term of d.terms) for (let i = 0; i < term.count * times; i++) rolls.push(rng(term.sides));
  const shown: Dice = opts.crit ? { terms: d.terms.map((t) => ({ count: t.count * 2, sides: t.sides })), modifier: d.modifier } : d;
  return {
    notation: diceText(shown),
    rolls,
    modifier: d.modifier,
    total: Math.max(0, rolls.reduce((a, b) => a + b, 0) + d.modifier),
  };
}

// ─── The d20 ─────────────────────────────────────────────────────────────────

/** Any number of sources of each: one of each (or ten of one and one of the other) cancels out. */
export function combineAdv(...sources: (Adv | undefined)[]): Adv {
  const adv = sources.includes("adv");
  const dis = sources.includes("dis");
  return adv && dis ? null : adv ? "adv" : dis ? "dis" : null;
}

export interface D20Roll {
  /** One d20, or two with advantage / disadvantage. */
  rolls: number[];
  /** The one that counts. */
  kept: number;
  adv: Adv;
}

/** `fixed` is a die the player rolled at the table: it is taken as the die that counts. */
export function rollD20(rng: Rng, adv: Adv = null, fixed?: number | null): D20Roll {
  if (typeof fixed === "number" && Number.isFinite(fixed)) {
    const v = Math.min(20, Math.max(1, Math.round(fixed)));
    return { rolls: [v], kept: v, adv };
  }
  if (!adv) {
    const v = rng(20);
    return { rolls: [v], kept: v, adv: null };
  }
  const a = rng(20);
  const b = rng(20);
  return { rolls: [a, b], kept: adv === "adv" ? Math.max(a, b) : Math.min(a, b), adv };
}

// ─── Abilities, proficiency, skills ──────────────────────────────────────────

export const ABILITIES: readonly AbilityKey[] = ["str", "dex", "con", "int", "wis", "cha"];
export const ABILITY_NAMES: Record<AbilityKey, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

/** +2 at levels 1–4, +3 at 5–8, +4 at 9–12, +5 at 13–16, +6 at 17–20. */
export function proficiencyBonus(level: number): number {
  const l = Math.min(20, Math.max(1, Math.round(level) || 1));
  return 2 + Math.floor((l - 1) / 4);
}

/** A creature's proficiency bonus by challenge rating (+2 up to CR 4, then +1 per four). */
export function crProficiency(cr: number): number {
  return 2 + Math.floor((Math.max(1, Math.ceil(cr)) - 1) / 4);
}

export type SkillKey =
  | "acrobatics" | "animal handling" | "arcana" | "athletics" | "deception" | "history" | "insight" | "intimidation"
  | "investigation" | "medicine" | "nature" | "perception" | "performance" | "persuasion" | "religion"
  | "sleight of hand" | "stealth" | "survival";

export const SKILLS: Record<SkillKey, { ability: AbilityKey; label: string }> = {
  acrobatics: { ability: "dex", label: "Acrobatics" },
  "animal handling": { ability: "wis", label: "Animal Handling" },
  arcana: { ability: "int", label: "Arcana" },
  athletics: { ability: "str", label: "Athletics" },
  deception: { ability: "cha", label: "Deception" },
  history: { ability: "int", label: "History" },
  insight: { ability: "wis", label: "Insight" },
  intimidation: { ability: "cha", label: "Intimidation" },
  investigation: { ability: "int", label: "Investigation" },
  medicine: { ability: "wis", label: "Medicine" },
  nature: { ability: "int", label: "Nature" },
  perception: { ability: "wis", label: "Perception" },
  performance: { ability: "cha", label: "Performance" },
  persuasion: { ability: "cha", label: "Persuasion" },
  religion: { ability: "int", label: "Religion" },
  "sleight of hand": { ability: "dex", label: "Sleight of Hand" },
  stealth: { ability: "dex", label: "Stealth" },
  survival: { ability: "wis", label: "Survival" },
};

export function isSkill(v: unknown): v is SkillKey {
  return typeof v === "string" && Object.hasOwn(SKILLS, v);
}

/** What a d20 test needs from a character sheet. */
export interface Sheet {
  stats: Stats;
  level: number;
  saveProficiencies: AbilityKey[];
  skillProficiencies: string[];
}

export function abilityCheckModifier(s: Pick<Sheet, "stats">, ability: AbilityKey): number {
  return abilityMod(s.stats[ability]);
}

/** Ability modifier, plus the proficiency bonus when proficient in the skill. */
export function skillModifier(s: Sheet, skill: SkillKey): number {
  const base = abilityMod(s.stats[SKILLS[skill].ability]);
  return base + (s.skillProficiencies.includes(skill) ? proficiencyBonus(s.level) : 0);
}

export function saveModifier(s: Sheet, ability: AbilityKey): number {
  return abilityMod(s.stats[ability]) + (s.saveProficiencies.includes(ability) ? proficiencyBonus(s.level) : 0);
}

/** Passive score: 10 + the modifier (+5 with advantage, −5 with disadvantage). */
export function passiveScore(modifier: number, adv: Adv = null): number {
  return 10 + modifier + (adv === "adv" ? 5 : adv === "dis" ? -5 : 0);
}

// ─── Difficulty classes ──────────────────────────────────────────────────────

export const DC_LADDER = [5, 10, 15, 20, 25, 30] as const;
const DC_WORDS: Record<number, string> = { 5: "very easy", 10: "easy", 15: "moderate", 20: "hard", 25: "very hard", 30: "nearly impossible" };

/** The nearest step of the ladder (ties go to the easier one); anything unreadable is `fallback`. */
export function snapDc(n: unknown, fallback = 15): number {
  const v = typeof n === "number" ? n : typeof n === "string" && n.trim() ? Number(n) : NaN;
  if (!Number.isFinite(v)) return fallback;
  let best: number = DC_LADDER[0];
  for (const step of DC_LADDER) if (Math.abs(step - v) < Math.abs(best - v)) best = step;
  return best;
}

export function dcWord(dc: number): string {
  return DC_WORDS[snapDc(dc)] ?? "moderate";
}

// ─── Checks, saves, contests ─────────────────────────────────────────────────

export interface CheckOptions {
  modifier: number;
  dc: number;
  adv?: Adv;
  /** The die the player rolled at the table. */
  fixed?: number | null;
  /** The total the player announced (modifier already in it). */
  fixedTotal?: number | null;
  /** A condition makes it fail whatever the die says (a paralyzed creature's Dexterity save). */
  autoFail?: boolean;
  /** Subtracted from the roll (exhaustion: 2 per level). */
  penalty?: number;
}

export interface CheckResult extends D20Roll {
  natural: number;
  modifier: number;
  penalty: number;
  total: number;
  dc: number;
  success: boolean;
  /** Total minus DC. */
  margin: number;
  autoFail: boolean;
}

/** An ability check or a saving throw: d20 + modifier against a DC. Meeting the DC succeeds. A natural 20 or 1 is not automatic. */
export function rollCheck(rng: Rng, o: CheckOptions): CheckResult {
  const penalty = Math.max(0, o.penalty ?? 0);
  let d: D20Roll;
  let total: number;
  if (typeof o.fixedTotal === "number" && Number.isFinite(o.fixedTotal)) {
    total = Math.round(o.fixedTotal);
    const die = Math.min(20, Math.max(1, total - o.modifier + penalty));
    d = { rolls: [die], kept: die, adv: o.adv ?? null };
  } else {
    d = rollD20(rng, o.adv ?? null, o.fixed);
    total = d.kept + o.modifier - penalty;
  }
  const autoFail = o.autoFail === true;
  const success = !autoFail && total >= o.dc;
  return { ...d, natural: d.kept, modifier: o.modifier, penalty, total, dc: o.dc, success, margin: total - o.dc, autoFail };
}

export interface ContestResult {
  a: CheckResult;
  b: CheckResult;
  /** A tie leaves things as they were. */
  winner: "a" | "b" | "tie";
}

/** Two creatures roll against each other; the higher total wins. */
export function rollContest(rng: Rng, a: { modifier: number; adv?: Adv }, b: { modifier: number; adv?: Adv }): ContestResult {
  const ra = rollCheck(rng, { modifier: a.modifier, dc: 0, adv: a.adv });
  const rb = rollCheck(rng, { modifier: b.modifier, dc: 0, adv: b.adv });
  return { a: ra, b: rb, winner: ra.total > rb.total ? "a" : rb.total > ra.total ? "b" : "tie" };
}

// ─── Attacks ─────────────────────────────────────────────────────────────────

export type Cover = "half" | "three-quarters" | "total" | null;

/** Half cover +2, three-quarters cover +5 to AC (and Dexterity saves). Total cover can't be targeted at all. */
export function coverBonus(cover: Cover): number {
  return cover === "half" ? 2 : cover === "three-quarters" ? 5 : 0;
}

export interface AttackOptions {
  toHit: number;
  ac: number;
  adv?: Adv;
  cover?: Cover;
  fixed?: number | null;
  penalty?: number;
  /** A hit is a critical hit whatever the die shows (a paralyzed or unconscious target within 5 feet). */
  autoCrit?: boolean;
}

export interface AttackRoll extends D20Roll {
  natural: number;
  toHit: number;
  penalty: number;
  total: number;
  /** The armor class it had to meet (cover included). */
  ac: number;
  hit: boolean;
  crit: boolean;
  fumble: boolean;
}

/** d20 + bonus against AC. A natural 20 always hits and is a critical hit; a natural 1 always misses. */
export function rollAttack(rng: Rng, o: AttackOptions): AttackRoll {
  const d = rollD20(rng, o.adv ?? null, o.fixed);
  const penalty = Math.max(0, o.penalty ?? 0);
  const ac = o.ac + coverBonus(o.cover ?? null);
  const total = d.kept + o.toHit - penalty;
  const fumble = d.kept === 1;
  const nat20 = d.kept === 20;
  const hit = o.cover === "total" ? false : nat20 || (!fumble && total >= ac);
  return { ...d, natural: d.kept, toHit: o.toHit, penalty, total, ac, hit, crit: hit && (nat20 || o.autoCrit === true), fumble };
}

// ─── Damage, healing, temporary hit points ───────────────────────────────────

export interface Damageable {
  hp: number;
  maxHp: number;
  tempHp: number;
  conditions: string[];
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
}

/** A creature that makes death saving throws at 0 hit points (a hero). */
export interface Mortal extends Damageable {
  deathSaves: DeathSaves;
  stable: boolean;
  dead: boolean;
}

export type DamageHow = "immune" | "resistant" | "vulnerable" | "resistant and vulnerable" | null;

const has = (list: string[] | undefined, type: string) => (list ?? []).some((x) => x.toLowerCase() === type.toLowerCase());

/** Immunity: none. Resistance: half, rounded down. Vulnerability: double. Both: halved, then doubled. A petrified creature resists everything. */
export function adjustDamage(amount: number, type: string, t: Pick<Damageable, "resistances" | "vulnerabilities" | "immunities" | "conditions">): { amount: number; how: DamageHow } {
  const raw = Math.max(0, Math.floor(amount));
  if (has(t.immunities, type)) return { amount: 0, how: "immune" };
  const resistant = has(t.resistances, type) || t.conditions.includes("petrified");
  const vulnerable = has(t.vulnerabilities, type);
  let n = raw;
  if (resistant) n = Math.floor(n / 2);
  if (vulnerable) n *= 2;
  return { amount: n, how: resistant && vulnerable ? "resistant and vulnerable" : resistant ? "resistant" : vulnerable ? "vulnerable" : null };
}

export interface DamageResult {
  /** Rolled, before resistance and the like. */
  raw: number;
  type: string;
  how: DamageHow;
  /** After resistance / vulnerability / immunity. */
  amount: number;
  /** Soaked by temporary hit points. */
  absorbed: number;
  hpBefore: number;
  hpAfter: number;
  tempAfter: number;
  /** This damage took it from above 0 to 0. */
  dropped: boolean;
  /** Death save failures added (damage taken while already at 0). */
  failuresAdded: number;
  /** Killed outright: the damage left over at 0 was at least its hit point maximum. */
  instantDeath: boolean;
  dead: boolean;
  /** The Constitution save DC to keep concentrating, when any damage got through. */
  concentrationDc: number | null;
}

const isMortal = (t: Damageable): t is Mortal => typeof (t as Mortal).deathSaves === "object" && (t as Mortal).deathSaves !== null;

/**
 * Apply damage in place: temporary hit points first, then hit points. A mortal (a hero) who drops to 0 falls
 * unconscious and starts dying; damage at 0 adds a death save failure (two from a critical hit); damage left over at
 * 0 that equals the hit point maximum kills outright.
 *
 * `adjusted` means the amount has already been through resistance, vulnerability and immunity: a hit that deals two
 * kinds of damage (a bite and its fire) is adjusted kind by kind and then lands as ONE amount, so it drops a creature
 * once, counts once against concentration, and never adds a death save failure to the hit that caused the fall.
 */
export function applyDamage(t: Damageable, amount: number, type: string, opts: { crit?: boolean; adjusted?: boolean } = {}): DamageResult {
  const adj = opts.adjusted ? { amount: Math.max(0, Math.floor(amount)), how: null as DamageHow } : adjustDamage(amount, type, t);
  const hpBefore = t.hp;
  const mortal = isMortal(t);
  const out: DamageResult = {
    raw: Math.max(0, Math.floor(amount)),
    type,
    how: adj.how,
    amount: adj.amount,
    absorbed: 0,
    hpBefore,
    hpAfter: hpBefore,
    tempAfter: t.tempHp,
    dropped: false,
    failuresAdded: 0,
    instantDeath: false,
    dead: mortal ? t.dead : false,
    concentrationDc: null,
  };
  if (adj.amount <= 0 || (mortal && t.dead)) return out;
  out.concentrationDc = concentrationDc(adj.amount);

  let left = adj.amount;
  if (t.tempHp > 0) {
    out.absorbed = Math.min(t.tempHp, left);
    t.tempHp -= out.absorbed;
    left -= out.absorbed;
  }
  out.tempAfter = t.tempHp;

  if (hpBefore <= 0) {
    // Already down: a mortal slips toward death, anything else stays down.
    if (mortal && left > 0) {
      if (left >= t.maxHp) {
        out.instantDeath = true;
        t.dead = true;
      } else {
        out.failuresAdded = opts.crit ? 2 : 1;
        t.deathSaves.failures = Math.min(3, t.deathSaves.failures + out.failuresAdded);
        t.stable = false;
        if (t.deathSaves.failures >= 3) t.dead = true;
      }
      out.dead = t.dead;
    }
    return out;
  }

  const overflow = Math.max(0, left - hpBefore);
  t.hp = Math.max(0, hpBefore - left);
  out.hpAfter = t.hp;
  if (t.hp === 0) {
    out.dropped = true;
    if (mortal) {
      if (overflow >= t.maxHp) {
        out.instantDeath = true;
        t.dead = true;
      } else {
        t.deathSaves = { successes: 0, failures: 0 };
        t.stable = false;
        if (!t.conditions.includes("unconscious")) t.conditions.push("unconscious");
      }
      out.dead = t.dead;
    }
  }
  return out;
}

export interface HealResult {
  healed: number;
  hpBefore: number;
  hpAfter: number;
  /** It was at 0 and is up again: no longer unconscious, death saves cleared. */
  revived: boolean;
}

/** Healing never exceeds the maximum and does nothing for the dead. Any healing at 0 hit points wakes the creature. */
export function applyHealing(t: Damageable, amount: number): HealResult {
  const hpBefore = t.hp;
  const none: HealResult = { healed: 0, hpBefore, hpAfter: hpBefore, revived: false };
  if (isMortal(t) && t.dead) return none;
  const n = Math.max(0, Math.floor(amount));
  if (n <= 0) return none;
  t.hp = Math.min(t.maxHp, hpBefore + n);
  const revived = hpBefore <= 0 && t.hp > 0;
  if (revived) {
    t.conditions = t.conditions.filter((c) => c !== "unconscious");
    if (isMortal(t)) {
      t.deathSaves = { successes: 0, failures: 0 };
      t.stable = false;
    }
  }
  return { healed: t.hp - hpBefore, hpBefore, hpAfter: t.hp, revived };
}

/** Temporary hit points don't add up: the larger amount stays. Returns what the creature has now. */
export function grantTempHp(t: Pick<Damageable, "tempHp">, amount: number): number {
  t.tempHp = Math.max(t.tempHp, Math.max(0, Math.floor(amount)));
  return t.tempHp;
}

// ─── Dying ───────────────────────────────────────────────────────────────────

export type DeathSaveOutcome = "success" | "failure" | "two failures" | "revived";

export interface DeathSaveResult {
  roll: number;
  outcome: DeathSaveOutcome;
  successes: number;
  failures: number;
  /** Three successes: stable at 0 hit points. */
  stable: boolean;
  dead: boolean;
}

/**
 * A death saving throw: 10 or higher succeeds. Three successes: stable. Three failures: dead. A natural 1 counts as
 * two failures; a natural 20 puts the creature back on 1 hit point, awake.
 */
export function rollDeathSave(rng: Rng, t: Mortal, fixed?: number | null): DeathSaveResult {
  const roll = rollD20(rng, null, fixed).kept;
  let outcome: DeathSaveOutcome;
  if (roll === 20) {
    outcome = "revived";
    t.hp = 1;
    t.deathSaves = { successes: 0, failures: 0 };
    t.stable = false;
    t.conditions = t.conditions.filter((c) => c !== "unconscious");
  } else if (roll === 1) {
    outcome = "two failures";
    t.deathSaves.failures = Math.min(3, t.deathSaves.failures + 2);
  } else if (roll >= 10) {
    outcome = "success";
    t.deathSaves.successes = Math.min(3, t.deathSaves.successes + 1);
  } else {
    outcome = "failure";
    t.deathSaves.failures = Math.min(3, t.deathSaves.failures + 1);
  }
  const result: DeathSaveResult = {
    roll,
    outcome,
    successes: t.deathSaves.successes,
    failures: t.deathSaves.failures,
    stable: false,
    dead: false,
  };
  if (t.deathSaves.failures >= 3) {
    t.dead = true;
    result.dead = true;
  } else if (t.deathSaves.successes >= 3) {
    stabilize(t);
    result.stable = true;
  }
  return result;
}

/** Stable: still at 0 hit points and unconscious, but no more death saves (first aid is a DC 10 Wisdom (Medicine) check). */
export function stabilize(t: Mortal): void {
  if (t.dead || t.hp > 0) return;
  t.stable = true;
  t.deathSaves = { successes: 0, failures: 0 };
}

export const STABILIZE_DC = 10;

// ─── Conditions ──────────────────────────────────────────────────────────────

export const CONDITIONS = [
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "invisible", "paralyzed", "petrified",
  "poisoned", "prone", "restrained", "stunned", "unconscious",
] as const;
export type ConditionKey = (typeof CONDITIONS)[number];

/** What each condition does, in a sentence or two (also read out for a rules question). */
export const CONDITION_RULES: Record<ConditionKey, string> = {
  blinded: "A blinded creature can't see and fails any check that needs sight. Attacks against it have advantage, and its own attacks have disadvantage.",
  charmed: "A charmed creature can't attack the one who charmed it, and that one has advantage on social checks with it.",
  deafened: "A deafened creature can't hear and fails any check that needs hearing.",
  frightened: "A frightened creature has disadvantage on ability checks and attacks while it can see what it fears, and it can't move closer to it.",
  grappled: "A grappled creature's speed is zero. It ends if the grappler is incapacitated or the two are pulled apart.",
  incapacitated: "An incapacitated creature can't take actions or reactions, and its concentration is broken.",
  invisible: "An invisible creature can't be seen without magic. Attacks against it have disadvantage, and its own attacks have advantage.",
  paralyzed: "A paralyzed creature is incapacitated and can't move or speak. It fails Strength and Dexterity saves, attacks against it have advantage, and a hit from within five feet is a critical hit.",
  petrified: "A petrified creature is turned to stone: incapacitated, failing Strength and Dexterity saves, with attacks against it at advantage and resistance to all damage.",
  poisoned: "A poisoned creature has disadvantage on attack rolls and ability checks.",
  prone: "A prone creature can only crawl and has disadvantage on attacks. Attacks from within five feet have advantage against it; attacks from farther away have disadvantage. Standing up costs half its movement.",
  restrained: "A restrained creature's speed is zero. Attacks against it have advantage, its own attacks have disadvantage, and it has disadvantage on Dexterity saves.",
  stunned: "A stunned creature is incapacitated, can't move, and fails Strength and Dexterity saves. Attacks against it have advantage.",
  unconscious: "An unconscious creature is incapacitated and prone, drops what it holds, and fails Strength and Dexterity saves. Attacks against it have advantage, and a hit from within five feet is a critical hit.",
};

export interface Conditioned {
  conditions: string[];
  conditionRounds: Record<string, number>;
}

const INCAPACITATING = new Set(["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"]);

/** No actions or reactions. */
export function incapacitated(conditions: string[]): boolean {
  return conditions.some((c) => INCAPACITATING.has(c));
}

export interface AttackModifiers {
  adv: Adv;
  /** A hit is a critical hit (paralyzed or unconscious target, attacker within five feet). */
  autoCrit: boolean;
  reasons: string[];
}

/**
 * Advantage and disadvantage on an attack roll from both creatures' conditions. `melee` means the attacker is within
 * five feet (it matters for a prone, paralyzed or unconscious target). "dodging" and "hidden" are the Dodge and Hide
 * actions' effects.
 */
export function attackModifiers(attacker: string[], defender: string[], opts: { melee: boolean }): AttackModifiers {
  const sources: Adv[] = [];
  const reasons: string[] = [];
  const add = (adv: Adv, why: string) => {
    sources.push(adv);
    reasons.push(why);
  };
  for (const c of ["blinded", "frightened", "poisoned", "prone", "restrained"]) if (attacker.includes(c)) add("dis", `attacker ${c}`);
  for (const c of ["invisible", "hidden"]) if (attacker.includes(c)) add("adv", `attacker ${c}`);
  for (const c of ["blinded", "paralyzed", "petrified", "restrained", "stunned", "unconscious"]) if (defender.includes(c)) add("adv", `target ${c}`);
  for (const c of ["invisible", "dodging"]) if (defender.includes(c)) add("dis", `target ${c}`);
  // Unconscious includes lying prone: its advantage is already counted above.
  if (defender.includes("prone") && !defender.includes("unconscious")) add(opts.melee ? "adv" : "dis", "target prone");
  const autoCrit = opts.melee && (defender.includes("paralyzed") || defender.includes("unconscious"));
  return { adv: combineAdv(...sources), autoCrit, reasons };
}

export interface TestModifiers {
  adv: Adv;
  autoFail: boolean;
  reasons: string[];
}

/** Advantage, disadvantage and automatic failure on a creature's own ability check or saving throw. */
export function testModifiers(
  conditions: string[],
  kind: "check" | "save",
  ability: AbilityKey | null,
  opts: { sight?: boolean; hearing?: boolean } = {},
): TestModifiers {
  const sources: Adv[] = [];
  const reasons: string[] = [];
  let autoFail = false;
  if (kind === "check") {
    for (const c of ["poisoned", "frightened"]) {
      if (conditions.includes(c)) {
        sources.push("dis");
        reasons.push(c);
      }
    }
    if ((opts.sight && conditions.includes("blinded")) || (opts.hearing && conditions.includes("deafened"))) {
      autoFail = true;
      reasons.push(opts.sight && conditions.includes("blinded") ? "blinded" : "deafened");
    }
  } else if (ability === "str" || ability === "dex") {
    for (const c of ["paralyzed", "petrified", "stunned", "unconscious"]) {
      if (conditions.includes(c)) {
        autoFail = true;
        reasons.push(c);
      }
    }
    if (ability === "dex" && conditions.includes("restrained")) {
      sources.push("dis");
      reasons.push("restrained");
    }
    if (ability === "dex" && conditions.includes("dodging")) {
      sources.push("adv");
      reasons.push("dodging");
    }
  }
  return { adv: combineAdv(...sources), autoFail, reasons };
}

/** Speed after conditions and exhaustion (5 feet less per exhaustion level). */
export function effectiveSpeed(base: number, conditions: string[], exhaustion = 0): number {
  if (conditions.some((c) => ["grappled", "restrained", "paralyzed", "petrified", "stunned", "unconscious"].includes(c))) return 0;
  return Math.max(0, base - 5 * Math.max(0, exhaustion));
}

/** Add a condition, optionally for a number of rounds. A longer duration replaces a shorter one; null means until removed. */
export function addCondition(c: Conditioned, name: string, rounds: number | null = null): boolean {
  const key = name.toLowerCase().trim();
  if (!key) return false;
  const fresh = !c.conditions.includes(key);
  if (fresh) c.conditions.push(key);
  if (rounds === null) delete c.conditionRounds[key];
  else if (fresh || (c.conditionRounds[key] !== undefined && rounds > c.conditionRounds[key]!)) c.conditionRounds[key] = Math.max(1, Math.round(rounds));
  return fresh;
}

export function removeCondition(c: Conditioned, name: string): boolean {
  const key = name.toLowerCase().trim();
  if (!c.conditions.includes(key)) return false;
  c.conditions = c.conditions.filter((x) => x !== key);
  delete c.conditionRounds[key];
  return true;
}

/** The end of the creature's turn: timed conditions lose a round, and the ones that run out end. Returns what ended. */
export function tickConditions(c: Conditioned): string[] {
  const ended: string[] = [];
  for (const [name, left] of Object.entries(c.conditionRounds)) {
    if (!c.conditions.includes(name)) {
      delete c.conditionRounds[name];
      continue;
    }
    if (left <= 1) {
      removeCondition(c, name);
      ended.push(name);
    } else c.conditionRounds[name] = left - 1;
  }
  return ended;
}

// ─── Exhaustion, concentration ───────────────────────────────────────────────

export const MAX_EXHAUSTION = 6;

/** Every d20 test is reduced by twice the exhaustion level. */
export function exhaustionPenalty(level: number): number {
  return 2 * Math.min(MAX_EXHAUSTION, Math.max(0, Math.round(level) || 0));
}

/** One more level of exhaustion (or `by`); the sixth kills. */
export function addExhaustion(t: { exhaustion: number }, by = 1): { level: number; dead: boolean } {
  t.exhaustion = Math.min(MAX_EXHAUSTION, Math.max(0, t.exhaustion + by));
  return { level: t.exhaustion, dead: t.exhaustion >= MAX_EXHAUSTION };
}

/** Damage while concentrating: a Constitution save against 10 or half the damage, whichever is higher, 30 at most. */
export function concentrationDc(damage: number): number {
  return Math.min(30, Math.max(10, Math.floor(Math.max(0, damage) / 2)));
}

export function rollConcentration(rng: Rng, conSaveModifier: number, damage: number, adv: Adv = null): CheckResult {
  return rollCheck(rng, { modifier: conSaveModifier, dc: concentrationDc(damage), adv });
}

// ─── Initiative, reactions ───────────────────────────────────────────────────

export interface InitiativeEntry {
  id: string;
  kind: "hero" | "npc";
  name: string;
  dexMod: number;
  /** Caught off guard as the fight starts: disadvantage on the roll. */
  surprised?: boolean;
  adv?: Adv;
  penalty?: number;
}

export interface InitiativeResult {
  id: string;
  kind: "hero" | "npc";
  name: string;
  rolls: number[];
  roll: number;
  total: number;
  surprised: boolean;
}

/**
 * Initiative is a Dexterity check, rolled once for each creature. Highest goes first; ties go to the higher Dexterity
 * modifier, then to a hero over a monster, then by name (so the order is the same every time).
 */
export function rollInitiative(rng: Rng, entries: InitiativeEntry[]): InitiativeResult[] {
  const rolled = entries.map((e) => {
    const d = rollD20(rng, combineAdv(e.adv, e.surprised ? "dis" : null));
    return { e, r: { id: e.id, kind: e.kind, name: e.name, rolls: d.rolls, roll: d.kept, total: d.kept + e.dexMod - Math.max(0, e.penalty ?? 0), surprised: e.surprised === true } };
  });
  rolled.sort(
    (x, y) =>
      y.r.total - x.r.total ||
      y.e.dexMod - x.e.dexMod ||
      (x.e.kind === y.e.kind ? 0 : x.e.kind === "hero" ? -1 : 1) ||
      x.e.name.localeCompare(y.e.name),
  );
  return rolled.map((x) => x.r);
}

/** A reaction (an opportunity attack: one melee attack when a foe leaves reach) needs one unused and a creature able to act. */
export function canReact(conditions: string[], reactionUsed: boolean): boolean {
  return !reactionUsed && !incapacitated(conditions);
}

// ─── Spell slots ─────────────────────────────────────────────────────────────

export type CasterKind = "full" | "half" | "pact" | null;

const FULL_SLOTS: number[][] = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];
const HALF_SLOTS: number[][] = [
  [], [2], [3], [3], [4, 2], [4, 2], [4, 3], [4, 3], [4, 3, 2], [4, 3, 2], [4, 3, 3], [4, 3, 3], [4, 3, 3, 1],
  [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2],
];

const nine = (xs: number[]): number[] => Array.from({ length: 9 }, (_, i) => xs[i] ?? 0);
const lvl = (level: number) => Math.min(20, Math.max(1, Math.round(level) || 1));

/** Slots per spell level (index 0 = level 1) for a bard, cleric, druid, sorcerer or wizard. */
export function fullCasterSlots(level: number): number[] {
  return nine(FULL_SLOTS[lvl(level) - 1] ?? []);
}

/** A paladin's or ranger's slots (none at level 1). */
export function halfCasterSlots(level: number): number[] {
  return nine(HALF_SLOTS[lvl(level) - 1] ?? []);
}

/** A warlock's pact magic: a few slots, all of one level, back after a short rest. */
export function pactSlots(level: number): number[] {
  const l = lvl(level);
  const count = l >= 17 ? 4 : l >= 11 ? 3 : l >= 2 ? 2 : 1;
  const slotLevel = Math.min(5, Math.ceil(l / 2));
  return nine(Array.from({ length: slotLevel }, (_, i) => (i === slotLevel - 1 ? count : 0)));
}

export function slotsFor(kind: CasterKind, level: number): number[] {
  return kind === "full" ? fullCasterSlots(level) : kind === "half" ? halfCasterSlots(level) : kind === "pact" ? pactSlots(level) : nine([]);
}

export interface Slotted {
  slotsMax: number[];
  slotsUsed: number[];
}

export function slotsLeft(h: Slotted, spellLevel: number): number {
  const i = spellLevel - 1;
  return Math.max(0, (h.slotsMax[i] ?? 0) - (h.slotsUsed[i] ?? 0));
}

/** Spend a slot of at least `spellLevel`: that level if one is left, else the lowest higher one. */
export function spendSlot(h: Slotted, spellLevel: number): { ok: boolean; level: number } {
  for (let l = Math.max(1, spellLevel); l <= 9; l++) {
    if (slotsLeft(h, l) > 0) {
      h.slotsUsed = nine(h.slotsUsed);
      h.slotsUsed[l - 1] = (h.slotsUsed[l - 1] ?? 0) + 1;
      return { ok: true, level: l };
    }
  }
  return { ok: false, level: spellLevel };
}

/** All slots back. Returns how many were restored. */
export function restoreSlots(h: Slotted): number {
  const n = h.slotsUsed.reduce((a, b) => a + b, 0);
  h.slotsUsed = nine([]);
  return n;
}

// ─── Rests ───────────────────────────────────────────────────────────────────

export interface Restable extends Mortal, Slotted {
  level: number;
  stats: Stats;
  hitDie: number;
  hitDiceUsed: number;
  exhaustion: number;
}

export function hitDiceLeft(h: Pick<Restable, "level" | "hitDiceUsed">): number {
  return Math.max(0, h.level - h.hitDiceUsed);
}

export interface ShortRestResult {
  spent: number;
  rolls: number[];
  healed: number;
  hpAfter: number;
  diceLeft: number;
}

/**
 * A short rest: spend up to `spend` hit dice, each healing the roll plus the Constitution modifier (at least 1).
 * Dice aren't spent once the hero is at full hit points. The dead and the dying (0 hit points, not stable) don't rest.
 */
export function shortRest(rng: Rng, h: Restable, spend: number): ShortRestResult {
  const out: ShortRestResult = { spent: 0, rolls: [], healed: 0, hpAfter: h.hp, diceLeft: hitDiceLeft(h) };
  if (h.dead) return out;
  const con = abilityMod(h.stats.con);
  const before = h.hp;
  for (let i = 0; i < Math.max(0, Math.floor(spend)) && hitDiceLeft(h) > 0 && h.hp < h.maxHp; i++) {
    const roll = rng(h.hitDie);
    out.rolls.push(roll);
    h.hitDiceUsed++;
    out.spent++;
    applyHealing(h, Math.max(1, roll + con));
  }
  out.healed = h.hp - before;
  out.hpAfter = h.hp;
  out.diceLeft = hitDiceLeft(h);
  return out;
}

export interface LongRestResult {
  healed: number;
  diceRestored: number;
  slotsRestored: number;
  exhaustion: number;
}

/** A long rest: all hit points, all hit dice and all spell slots back, temporary hit points gone, one level of exhaustion less. */
export function longRest(h: Restable): LongRestResult {
  if (h.dead) return { healed: 0, diceRestored: 0, slotsRestored: 0, exhaustion: h.exhaustion };
  const healed = h.maxHp - h.hp;
  h.hp = h.maxHp;
  h.tempHp = 0;
  h.conditions = h.conditions.filter((c) => c !== "unconscious");
  h.deathSaves = { successes: 0, failures: 0 };
  h.stable = false;
  const diceRestored = h.hitDiceUsed;
  h.hitDiceUsed = 0;
  const slotsRestored = restoreSlots(h);
  h.exhaustion = Math.max(0, h.exhaustion - 1);
  return { healed, diceRestored, slotsRestored, exhaustion: h.exhaustion };
}

// ─── Experience, levels, encounter budgets ───────────────────────────────────

/** XP needed to BE each level: index 0 = level 1. */
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000,
  265000, 305000, 355000,
] as const;

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) if (xp >= XP_THRESHOLDS[i]!) level = i + 1;
  return level;
}

/** XP still needed for the next level (0 at level 20). */
export function xpToNextLevel(level: number, xp: number): number {
  const next = XP_THRESHOLDS[lvl(level)];
  return next === undefined ? 0 : Math.max(0, next - xp);
}

const CR_XP: [number, number][] = [
  [0, 10], [0.125, 25], [0.25, 50], [0.5, 100], [1, 200], [2, 450], [3, 700], [4, 1100], [5, 1800], [6, 2300], [7, 2900],
  [8, 3900], [9, 5000], [10, 5900], [11, 7200], [12, 8400], [13, 10000], [14, 11500], [15, 13000], [16, 15000], [17, 18000],
  [18, 20000], [19, 22000], [20, 25000], [21, 33000], [22, 41000], [23, 50000], [24, 62000], [25, 75000], [26, 90000],
  [27, 105000], [28, 120000], [29, 135000], [30, 155000],
];

/** What a creature of this challenge rating is worth (the nearest listed rating at or below it). */
export function xpForCr(cr: number): number {
  let xp = 10;
  for (const [rating, worth] of CR_XP) if (cr >= rating) xp = worth;
  return xp;
}

/** An award shared out evenly, rounded down. */
export function splitXp(total: number, heroes: number): number {
  return heroes > 0 ? Math.floor(Math.max(0, total) / heroes) : 0;
}

/** Hit points gained at a new level: the average of the hit die plus the Constitution modifier (at least 1). */
export function hpPerLevel(hitDie: number, conMod: number): number {
  return Math.max(1, Math.floor(hitDie / 2) + 1 + conMod);
}

/** Hit point maximum: the whole hit die plus Constitution at level 1, then the average each level. */
export function maxHpFor(hitDie: number, con: number, level: number): number {
  const m = abilityMod(con);
  return Math.max(1, hitDie + m) + (lvl(level) - 1) * hpPerLevel(hitDie, m);
}

export type EncounterDifficulty = "low" | "moderate" | "high";

/** XP budget per character, by character level: index 0 = level 1. */
export const XP_BUDGET: Record<EncounterDifficulty, number>[] = [
  { low: 50, moderate: 75, high: 100 },
  { low: 100, moderate: 150, high: 200 },
  { low: 150, moderate: 225, high: 400 },
  { low: 250, moderate: 375, high: 500 },
  { low: 500, moderate: 750, high: 1100 },
  { low: 600, moderate: 1000, high: 1400 },
  { low: 750, moderate: 1300, high: 1700 },
  { low: 1000, moderate: 1700, high: 2100 },
  { low: 1300, moderate: 2000, high: 2600 },
  { low: 1600, moderate: 2300, high: 3100 },
  { low: 1900, moderate: 2900, high: 4100 },
  { low: 2200, moderate: 3700, high: 4700 },
  { low: 2600, moderate: 4200, high: 5400 },
  { low: 2900, moderate: 4900, high: 6200 },
  { low: 3300, moderate: 5400, high: 7800 },
  { low: 3800, moderate: 6100, high: 9800 },
  { low: 4500, moderate: 7200, high: 11700 },
  { low: 5000, moderate: 8700, high: 14200 },
  { low: 5500, moderate: 10700, high: 17200 },
  { low: 6400, moderate: 13200, high: 22000 },
];

/** The XP to spend on an encounter for this party: each character's budget for the difficulty, added up. */
export function encounterBudget(levels: number[], difficulty: EncounterDifficulty): number {
  return levels.reduce((sum, l) => sum + XP_BUDGET[lvl(l) - 1]![difficulty], 0);
}

export type EncounterRating = "trivial" | EncounterDifficulty | "beyond high";

/** How a set of creatures (by their XP) rates for this party. */
export function rateEncounter(levels: number[], creatureXp: number[]): { total: number; rating: EncounterRating; budget: Record<EncounterDifficulty, number> } {
  const total = creatureXp.reduce((a, b) => a + b, 0);
  const budget = {
    low: encounterBudget(levels, "low"),
    moderate: encounterBudget(levels, "moderate"),
    high: encounterBudget(levels, "high"),
  };
  const rating: EncounterRating =
    total > budget.high ? "beyond high" : total > budget.moderate ? "high" : total > budget.low ? "moderate" : total * 2 > budget.low ? "low" : "trivial";
  return { total, rating, budget };
}

// ─── Inspiration ─────────────────────────────────────────────────────────────

/** A hero either has inspiration or doesn't: a second award is not banked. Returns whether it was newly gained. */
export function grantInspiration(h: { inspiration: boolean }): boolean {
  const fresh = !h.inspiration;
  h.inspiration = true;
  return fresh;
}

/** Spend inspiration for advantage on one d20 test. Returns the advantage it buys (null when there was none to spend). */
export function spendInspiration(h: { inspiration: boolean }): Adv {
  if (!h.inspiration) return null;
  h.inspiration = false;
  return "adv";
}

// ─── Small helpers shared by the engine ──────────────────────────────────────

/** "+3", "-1", "+0". */
export const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
