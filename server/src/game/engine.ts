import { findMonster, genericStatBlock, healthBand, snapCr, statBlockOf, treasureFor, type Monster } from "./bestiary.js";
import { cap, d20Words, hpLeft, npcRef, plural, sumWords } from "./lines.js";
import * as R from "./rules.js";
import type { Rng } from "./rules.js";
import {
  armorClass,
  armorStats,
  cantripDice,
  classProfile,
  healingDice,
  isConsumable,
  itemPrice,
  SPELLS,
  UNARMED,
  upcastDice,
  weaponStats,
  type SpellInfo,
  type WeaponStats,
} from "./srd.js";
import { addLog, autoEquip, emptySlot, isPlaceholderSlot, newId } from "./store.js";
import type { AbilityKey, Adv, Attack, Combatant, Game, Item, ItemType, Npc, PendingCheck, Player, Rarity, RollOutcome } from "./types.js";

/**
 * The game engine: what happens to a game when something is resolved. Every function takes the game document (a
 * draft inside one mutateGame call, so a turn is applied atomically), a die, and plain arguments; it changes the
 * document in place and returns the sentences the Game Master says about it. Nothing here asks a model anything,
 * reads the clock for a decision, or touches the store: the rules come from rules.ts and the numbers from the die.
 */

// ─── Who is at the table ─────────────────────────────────────────────────────

export const heroes = (g: Game): Player[] => g.players.filter((p) => !p.pending);
export const living = (g: Game): Player[] => heroes(g).filter((p) => !p.dead);
export const standing = (g: Game): Player[] => living(g).filter((p) => p.hp > 0);
/** Creatures that fight the party: alive and hostile. */
export const foes = (g: Game): Npc[] => g.npcs.filter((n) => n.status === "alive" && n.attitude === "hostile" && !isPlaceholderSlot(n.portrait));
export const heroById = (g: Game, id: string | null | undefined): Player | null => heroes(g).find((p) => p.id === id) ?? null;
export const npcById = (g: Game, id: string | null | undefined): Npc | null => g.npcs.find((n) => n.id === id) ?? null;
export const itemsOf = (g: Game, heroId: string): Item[] => g.items.filter((it) => it.ownerId === heroId);
export const partyLevels = (g: Game): number[] => living(g).map((p) => p.level);
export const partyLevel = (g: Game): number => {
  const ls = partyLevels(g);
  return ls.length ? Math.max(1, Math.round(ls.reduce((a, b) => a + b, 0) / ls.length)) : 1;
};
export const encounterDifficulty = (g: Game): R.EncounterDifficulty => (g.settings.difficulty === "easy" ? "low" : g.settings.difficulty === "hard" ? "high" : "moderate");

const combatantOf = (g: Game, id: string): Combatant | null => g.combat?.order.find((c) => c.id === id) ?? null;
/** Whoever is on turn; nobody while the place is vacant (its owner just left the order). */
export const currentCombatant = (g: Game): Combatant | null => (g.combat && !g.combat.vacant ? (g.combat.order[g.combat.index] ?? null) : null);
/** The hero whose turn it is in a fight, or null (no fight, or a monster's turn). */
export function turnHero(g: Game): Player | null {
  const c = currentCombatant(g);
  return c?.kind === "hero" ? heroById(g, c.id) : null;
}
/** The hero acting now: whose turn it is in a fight, the spotlight hero otherwise. */
export const actingHero = (g: Game): Player | null => (g.combat ? turnHero(g) : heroById(g, g.spotlightId));
const nameOf = (g: Game, c: Combatant): string => (c.kind === "hero" ? (heroById(g, c.id)?.name ?? "a hero") : npcRef(npcById(g, c.id) ?? { name: "a creature", kind: "" }));

// ─── Rolls on the board ──────────────────────────────────────────────────────

function recordD20(g: Game, who: string, label: string, roll: R.D20Roll, total: number, dc: number | null, outcome: RollOutcome | null): void {
  const modifier = total - roll.kept;
  g.lastRoll = {
    id: newId(),
    who,
    notation: `1d20${modifier ? R.signed(modifier) : ""}`,
    rolls: [...roll.rolls],
    modifier,
    total,
    label,
    ts: Date.now(),
    adv: roll.adv,
    kept: roll.kept,
    natural: roll.kept,
    dc,
    outcome,
  };
}

/** Put a plain dice roll (damage, healing, "roll 2d6") on the board. */
export function recordDice(g: Game, who: string | null, label: string | null, roll: R.DiceRoll): void {
  g.lastRoll = {
    id: newId(),
    who,
    notation: roll.notation,
    rolls: [...roll.rolls],
    modifier: roll.modifier,
    total: roll.total,
    label,
    ts: Date.now(),
    adv: null,
    kept: null,
    natural: null,
    dc: null,
    outcome: null,
  };
}

// ─── Equipment ───────────────────────────────────────────────────────────────

const ownedItem = (g: Game, p: Player, id: string | null): Item | null => (id ? (g.items.find((it) => it.id === id && it.ownerId === p.id) ?? null) : null);

/** Armor class from what the hero wears right now. */
export function heroArmorClass(g: Game, p: Player): number {
  const armor = ownedItem(g, p, p.equipped.armor);
  const shield = ownedItem(g, p, p.equipped.shield);
  return armorClass(p, armor ? armorStats(armor) : null, shield ? armorStats(shield) : null);
}

/** A new hero puts their gear on; armor class follows the armor when they have any. */
export function outfit(g: Game, p: Player): void {
  autoEquip(p, g.items);
  const worn = heroArmorClass(g, p);
  p.ac = p.equipped.armor || p.equipped.shield ? worn : Math.max(worn, Math.min(p.ac, worn + 2));
}

export interface AttackProfile {
  weapon: WeaponStats;
  itemId: string | null;
  ability: AbilityKey;
  toHit: number;
  /** Damage dice with the ability modifier and any magic bonus folded in. */
  damage: string;
  /** "the longsword", "an unarmed strike". */
  label: string;
}

/** What a hero attacks with: a weapon named in the words if they carry it, else the one in hand, else any weapon, else fists. */
export function heroAttackProfile(g: Game, p: Player, weaponWords?: string | null): AttackProfile {
  const mine = itemsOf(g, p.id).filter((it) => weaponStats(it) !== null);
  const named = weaponWords ? mine.find((it) => new RegExp(`\\b${escapeRe(lastWord(it.name))}\\b`, "i").test(weaponWords) || weaponWords.toLowerCase().includes(it.name.toLowerCase())) : null;
  const held = ownedItem(g, p, p.equipped.weapon);
  const item = named ?? (held && weaponStats(held) ? held : null) ?? mine.find((it) => it.type === "weapon") ?? null;
  const weapon = item ? weaponStats(item)! : UNARMED;
  const str = R.abilityMod(p.stats.str);
  const dex = R.abilityMod(p.stats.dex);
  const ability: AbilityKey = weapon.ranged ? "dex" : weapon.finesse && dex > str ? "dex" : "str";
  const mod = ability === "dex" ? dex : str;
  const dice = R.parseDice(weapon.damage) ?? { terms: [], modifier: 1 };
  const damage = R.diceText({ terms: dice.terms, modifier: dice.modifier + mod + weapon.bonus });
  return {
    weapon,
    itemId: item?.id ?? null,
    ability,
    toHit: mod + R.proficiencyBonus(p.level) + weapon.bonus,
    damage,
    label: item ? `the ${item.name.toLowerCase()}` : UNARMED.name,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lastWord = (s: string) => s.trim().split(/\s+/).pop() ?? s;

// ─── Damage and healing, with what is said about them ────────────────────────

/** "9 slashing damage", "9 fire damage, halved to 4", "no damage, being immune to poison", "5 damage" when no kind was given. */
export function damageWords(res: Pick<R.DamageResult, "how" | "type" | "raw" | "amount">): string {
  const kind = res.type ? `${res.type} ` : "";
  if (res.how === "immune") return res.type ? `no damage, being immune to ${res.type}` : "no damage";
  if (res.how === "resistant") return `${res.raw} ${kind}damage, halved to ${res.amount}`;
  if (res.how === "vulnerable") return `${res.raw} ${kind}damage, doubled to ${res.amount}`;
  return `${res.amount} ${kind}damage`;
}

/**
 * Take a creature out of the turn order. Places after it close up. If it was the one on turn, the turn is left
 * vacant (nobody is on turn) until play runs on with advanceTurn or settleFight.
 */
function removeFromOrder(g: Game, id: string): void {
  const c = g.combat;
  if (!c) return;
  const at = c.order.findIndex((x) => x.id === id);
  if (at < 0) return;
  c.order.splice(at, 1);
  if (at === c.index && !c.vacant) c.vacant = true;
  if (at <= c.index) c.index -= 1;
  for (const x of c.order) {
    x.engaged = x.engaged.filter((e) => e !== id);
    if (x.lastTargetId === id) x.lastTargetId = null;
    if (x.lastAttackerId === id) x.lastAttackerId = null;
  }
}

export interface NpcHurt {
  result: R.DamageResult;
  defeated: boolean;
  /** How the creature looks now, when that changed ("The goblin is bloodied."), else "". */
  state: string;
  /** XP handed out on the spot (a kill outside a fight). */
  after: string[];
}

/** Damage a creature. At 0 hit points it is defeated: out of the initiative order, marked on the board, its XP banked. */
export function hurtNpc(g: Game, n: Npc, amount: number, type: string, byHeroId: string | null): NpcHurt {
  const before = healthBand(n.hp, n.maxHp);
  const result = R.applyDamage(n, amount, type);
  if (n.regen > 0 && result.amount > 0 && (type === "fire" || type === "acid")) n.regenBlocked = true;
  const c = combatantOf(g, n.id);
  if (c && byHeroId && result.amount > 0) c.lastAttackerId = byHeroId;
  const after: string[] = [];
  let state = "";
  let defeated = false;
  if (n.hp <= 0) {
    defeated = true;
    n.hp = 0;
    n.status = "defeated";
    n.conditions = [];
    n.conditionRounds = {};
    state = `${npcRef(n, true)} is defeated.`;
    addLog(g, "combat", `${cap(npcRef(n))} is defeated.`);
    if (g.combat) {
      g.combat.xpEarned += n.xp;
      g.combat.overcome.push(n.name);
      removeFromOrder(g, n.id);
    } else after.push(...awardXp(g, n.xp));
  } else {
    const band = healthBand(n.hp, n.maxHp);
    if (band !== before) state = `${npcRef(n, true)} is ${band === "near death" ? "barely standing" : band}.`;
  }
  return { result, defeated, state, after };
}

export interface HeroHurt {
  /** The hit as one amount: every kind of damage it dealt, after resistances. */
  result: R.DamageResult;
  /** How the damage is said: "9 piercing damage", "9 piercing damage and 2 fire damage", "8 fire damage, halved to 4". */
  words: string;
  /** "Mira has 4 hit points left." / "Mira drops to 0 hit points and falls unconscious." */
  state: string;
  /** Concentration and the like. */
  after: string[];
}

/**
 * A hero stops concentrating. The lasting effect of the spell goes with it: the paralysis of a hold person leaves its
 * targets, a bless leaves the party. Returns the spell's name in lower case ("" when nothing was being held).
 */
export function endConcentration(g: Game, p: Player): string {
  const name = p.concentration;
  if (!name) return "";
  p.concentration = null;
  const spell = SPELLS[name.toLowerCase()];
  if (spell?.condition) {
    // Only what the spell put there: its effects are timed, a lasting condition from elsewhere is not.
    const held: R.Conditioned[] = spell.kind === "buff" ? heroes(g) : g.npcs;
    for (const t of held) if (t.conditionRounds[spell.condition] !== undefined) R.removeCondition(t, spell.condition);
  }
  return name.toLowerCase();
}

/** A hero has died: off the turn order, nothing left pending on them. (`dead` may already be set by the rules.) */
export function killHero(g: Game, p: Player): void {
  p.dead = true;
  p.hp = 0;
  p.stable = false;
  p.conditions = [];
  p.conditionRounds = {};
  endConcentration(g, p);
  removeFromOrder(g, p.id);
  if (g.pending.check?.heroId === p.id) g.pending.check = null;
  if (g.spotlightId === p.id && !g.combat) passSpotlight(g, p.id);
  addLog(g, "combat", `${p.name} has died.`);
}

/**
 * Damage a hero: temporary hit points, dropping to 0, death save failures, instant death, and the concentration
 * check. A hit that deals a second kind of damage (`also`: a hell hound's fire on top of its bite) is adjusted kind
 * by kind and lands as one amount: it drops the hero once and calls for one concentration save.
 */
export function hurtHero(g: Game, rng: Rng, p: Player, amount: number, type: string, opts: { crit?: boolean; also?: { amount: number; type: string } | null } = {}): HeroHurt {
  const parts = [{ amount, type }, ...(opts.also ? [opts.also] : [])].map((part) => ({ raw: Math.max(0, Math.floor(part.amount)), type: part.type, ...R.adjustDamage(part.amount, part.type, p) }));
  const words = parts.map(damageWords).join(" and ");
  const result = R.applyDamage(p, parts.reduce((n, part) => n + part.amount, 0), type, { crit: opts.crit, adjusted: true });
  result.raw = parts.reduce((n, part) => n + part.raw, 0);
  if (parts.length === 1) result.how = parts[0]!.how;
  const after: string[] = [];
  let state: string;
  if (result.amount <= 0) state = `${p.name} takes no damage.`;
  else if (result.instantDeath) state = `${p.name} is killed outright.`;
  else if (result.dropped) state = `${p.name} drops to 0 hit points and falls unconscious.`;
  else if (result.failuresAdded) {
    state = p.dead
      ? `${p.name}, already down, takes ${plural(result.failuresAdded, "more death save failure")} and dies.`
      : `${p.name}, already down, takes ${plural(result.failuresAdded, "death save failure")}: ${p.deathSaves.failures} of 3.`;
  } else state = hpLeft(p);

  if (p.concentration && !p.dead) {
    if (p.hp <= 0) after.push(`${p.name}'s ${endConcentration(g, p)} ends.`);
    else if (result.concentrationDc !== null) {
      const save = R.rollCheck(rng, { modifier: R.saveModifier(p, "con"), dc: result.concentrationDc, penalty: R.exhaustionPenalty(p.exhaustion) });
      if (save.success) after.push(`${p.name} keeps concentrating: ${sumWords(save.kept, save.total)} against DC ${save.dc}.`);
      else after.push(`${p.name} loses concentration, ${sumWords(save.kept, save.total)} against DC ${save.dc}: ${endConcentration(g, p)} ends.`);
    }
  }
  if (p.dead) killHero(g, p);
  return { result, words, state, after };
}

/** Heal a hero and say where that leaves them. */
export function healHero(g: Game, p: Player, amount: number): { result: R.HealResult; line: string } {
  const result = R.applyHealing(p, amount);
  let line: string;
  if (p.dead) line = `${p.name} is beyond healing.`;
  else if (result.healed <= 0) line = `${p.name} is already at full hit points.`;
  else if (result.revived) line = `${p.name} regains ${plural(result.healed, "hit point")} and is conscious again, at ${p.hp}.`;
  else line = `${p.name} regains ${plural(result.healed, "hit point")} and is at ${p.hp} of ${p.maxHp}.`;
  if (result.revived && g.pending.check?.heroId === p.id && g.pending.check.kind === "death") g.pending.check = null;
  return { result, line };
}

// ─── Checks and saves ────────────────────────────────────────────────────────

export interface CheckSpec {
  kind: "check" | "save";
  ability: AbilityKey;
  skill: R.SkillKey | null;
  dc: number;
  adv?: Adv;
  /** The die the player rolled at the table. */
  fixed?: number | null;
  /** …or the total they announced. */
  fixedTotal?: number | null;
}

export function checkLabel(spec: Pick<CheckSpec, "kind" | "ability" | "skill">): string {
  if (spec.kind === "save") return `${R.ABILITY_NAMES[spec.ability]} saving throw`;
  return spec.skill ? `${R.SKILLS[spec.skill].label} check` : `${R.ABILITY_NAMES[spec.ability]} check`;
}

export function heroCheckModifier(p: Player, spec: Pick<CheckSpec, "kind" | "ability" | "skill">): number {
  if (spec.kind === "save") return R.saveModifier(p, spec.ability);
  return spec.skill ? R.skillModifier(p, spec.skill) : R.abilityCheckModifier(p, spec.ability);
}

/** A hero's ability check or saving throw against a DC: conditions, exhaustion and a friend's help are applied here. */
export function resolveCheck(g: Game, rng: Rng, p: Player, spec: CheckSpec): { line: string; result: R.CheckResult } {
  const label = checkLabel(spec);
  const mods = R.testModifiers(p.conditions, spec.kind, spec.ability, { sight: spec.skill === "perception" || spec.skill === "investigation" });
  const helped = spec.kind === "check" && R.removeCondition(p, "helped");
  const result = R.rollCheck(rng, {
    modifier: heroCheckModifier(p, spec),
    dc: spec.dc,
    adv: R.combineAdv(spec.adv, mods.adv, helped ? "adv" : null),
    fixed: spec.fixed,
    fixedTotal: spec.fixedTotal,
    autoFail: mods.autoFail,
    penalty: R.exhaustionPenalty(p.exhaustion),
  });
  const rolled = typeof spec.fixedTotal === "number" ? `${result.total}` : d20Words(result, result.total);
  const verdict = result.autoFail ? `It fails: ${p.name} is ${mods.reasons[0] ?? "unable"}.` : result.success ? "Success." : "Failure.";
  const line = `${p.name}'s ${label}: ${rolled} against DC ${spec.dc}. ${verdict}`;
  recordD20(g, p.name, label, result, result.total, spec.dc, result.success ? "success" : "failure");
  addLog(g, "roll", `${p.name} — ${label}: ${result.total} vs DC ${spec.dc}, ${result.success ? "success" : "failure"}`);
  return { line, result };
}

/** A hero's saving throw forced by a monster or a hazard, rolled by the Game Master. */
function forcedSave(rng: Rng, p: Player, ability: AbilityKey, dc: number): R.CheckResult {
  const mods = R.testModifiers(p.conditions, "save", ability);
  return R.rollCheck(rng, { modifier: R.saveModifier(p, ability), dc, adv: mods.adv, autoFail: mods.autoFail, penalty: R.exhaustionPenalty(p.exhaustion) });
}

const npcSaveModifier = (n: Npc, ability: AbilityKey): number => n.saves[ability] ?? R.abilityMod(n.stats[ability]);

// ─── Dying ───────────────────────────────────────────────────────────────────

export function deathCheck(p: Player): PendingCheck {
  return {
    id: newId(),
    heroId: p.id,
    kind: "death",
    ability: null,
    skill: null,
    label: "Death saving throw",
    dc: 10,
    adv: null,
    reason: "cling to life",
    words: "",
    askedAt: Date.now(),
    reminders: 0,
    endsTurn: true,
  };
}

/** A death saving throw for a hero at 0 hit points. */
export function resolveDeathSave(g: Game, rng: Rng, p: Player, fixed?: number | null): { line: string; result: R.DeathSaveResult } {
  const result = R.rollDeathSave(rng, p, fixed);
  const roll = { rolls: [result.roll], kept: result.roll, adv: null as Adv };
  recordD20(g, p.name, "Death saving throw", roll, result.roll, 10, result.outcome === "success" || result.outcome === "revived" ? "success" : "failure");
  let line: string;
  if (result.outcome === "revived") line = `${p.name}'s death save: a natural 20! ${p.name} is back up with 1 hit point.`;
  else if (result.dead) {
    line = `${p.name}'s death save: ${result.roll === 1 ? "a natural 1, two failures" : `${result.roll}, a failure`}. That is the third: ${p.name} dies.`;
    killHero(g, p);
  } else if (result.stable) line = `${p.name}'s death save: ${result.roll}, the third success. ${p.name} is stable.`;
  else if (result.outcome === "two failures") line = `${p.name}'s death save: a natural 1, two failures. That is ${result.failures} of 3.`;
  else if (result.outcome === "success") line = `${p.name}'s death save: ${result.roll}, a success. That is ${plural(result.successes, "success", "successes")} and ${plural(result.failures, "failure")}.`;
  else line = `${p.name}'s death save: ${result.roll}, a failure. That is ${plural(result.successes, "success", "successes")} and ${plural(result.failures, "failure")}.`;
  addLog(g, "roll", line);
  return { line, result };
}

// ─── Experience and levels ───────────────────────────────────────────────────

/** Level a hero up once: hit points, hit dice, spell slots and (for casters) the spells of the new level. */
export function levelUp(p: Player): void {
  if (p.level >= 20) return;
  const gain = R.hpPerLevel(p.hitDie, R.abilityMod(p.stats.con));
  p.level += 1;
  p.maxHp += gain;
  if (!p.dead) p.hp = Math.min(p.maxHp, p.hp + gain);
  const profile = classProfile(p.className);
  if (profile.caster && p.castingAbility) {
    p.slotsMax = R.slotsFor(profile.caster, p.level);
    p.slotsUsed = p.slotsUsed.map((u, i) => Math.min(u, p.slotsMax[i] ?? 0));
    for (const s of spellsAtLevel(profile.key, p.level)) if (!p.spells.some((x) => x.toLowerCase() === s)) p.spells.push(s);
  }
}

function spellsAtLevel(key: string, level: number): string[] {
  const out: string[] = [];
  const arcane = key === "wizard" || key === "sorcerer";
  if (level >= 3) out.push(...(arcane ? ["scorching ray", "shatter"] : key === "bard" ? ["shatter", "hold person"] : key === "cleric" || key === "druid" ? ["hold person", "lesser restoration"] : []));
  if (level >= 5) out.push(...(arcane ? ["fireball", "lightning bolt"] : key === "cleric" ? ["revivify", "mass healing word"] : key === "bard" ? ["mass healing word"] : []));
  return out;
}

/** Share XP among the living heroes. With XP leveling, anyone who crosses a threshold levels up at once. */
export function awardXp(g: Game, total: number): string[] {
  const party = living(g);
  const each = R.splitXp(total, party.length);
  if (each <= 0) return [];
  const lines = [party.length === 1 ? `${party[0]!.name} earns ${each} experience points.` : `Each of you earns ${each} experience points.`];
  for (const p of party) {
    p.xp += each;
    if (g.settings.leveling !== "xp") continue;
    const before = p.level;
    while (p.level < 20 && R.levelForXp(p.xp) > p.level) levelUp(p);
    if (p.level > before) {
      lines.push(`${p.name} reaches level ${p.level}.`);
      addLog(g, "party", `${p.name} reaches level ${p.level}! (max HP ${p.maxHp})`);
    }
  }
  addLog(g, "party", `The party earns ${total} XP (${each} each).`);
  return lines;
}

// ─── Spotlight ───────────────────────────────────────────────────────────────

/** Outside a fight the spotlight moves round the table: to the next hero still standing after `afterId`. */
export function passSpotlight(g: Game, afterId: string | null): Player | null {
  const up = standing(g);
  if (!up.length) {
    g.spotlightId = null;
    return null;
  }
  const all = heroes(g);
  const from = all.findIndex((p) => p.id === afterId);
  for (let i = 1; i <= all.length; i++) {
    const next = all[(Math.max(from, -1) + i) % all.length]!;
    if (up.includes(next)) {
      g.spotlightId = next.id;
      return next;
    }
  }
  g.spotlightId = up[0]!.id;
  return up[0]!;
}

/** The line that hands the scene on, naming who it goes to. */
export function promptLine(g: Game): string {
  if (g.combat) {
    const p = turnHero(g);
    return p ? `${p.name}, you're up.` : "";
  }
  // A roll called for and not yet made is what the table owes first.
  const check = g.pending.check;
  const owes = check ? heroById(g, check.heroId) : null;
  if (check && owes) {
    const full = `${owes.name}, your ${check.kind === "death" ? "death saving throw" : check.label.toLowerCase()} is still waiting: tell me the roll, or say roll for me.`;
    // Said to close the last reply already: the short form now, so one sentence never closes two replies running.
    return g.story.lastNarration.endsWith(full) ? `${owes.name}'s roll is still waiting.` : full;
  }
  const p = heroById(g, g.spotlightId);
  return p && standing(g).length > 1 ? `${p.name}, what do you do?` : "What do you do?";
}

// ─── Fights: initiative, turns, monsters ─────────────────────────────────────

/** A hostile story character without a real stat block gets one that suits the party before it fights. */
function ensureStatBlock(g: Game, n: Npc, share: number): void {
  if (n.statted) return;
  const known = findMonster(`${n.name} ${n.role}`);
  let cr = 0;
  for (const step of [0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) if (R.xpForCr(step) <= share && step <= Math.max(1, partyLevel(g))) cr = step;
  Object.assign(n, known ? statBlockOf(known) : genericStatBlock(snapCr(cr, 0.125)));
}

function orderWords(g: Game): string {
  const names = (g.combat?.order ?? []).map((c) => nameOf(g, c));
  if (names.length <= 1) return names[0] ?? "nobody";
  return `${names.slice(0, -1).join(", ")}, then ${names[names.length - 1]}`;
}

/**
 * Start a fight: initiative (a Dexterity check) is rolled here for every living hero and every hostile creature, the
 * order is set, and play runs on until a hero has to act. `surprise` gives that side disadvantage on initiative.
 */
export function startCombat(g: Game, rng: Rng, opts: { surprise?: "heroes" | "foes" | null } = {}): { lines: string[]; started: boolean } {
  if (g.combat) return { lines: [`The fight is already on, round ${g.combat.round}. ${whoseTurn(g)}`], started: false };
  const party = living(g);
  const enemies = foes(g);
  if (!party.length) return { lines: ["There are no heroes to fight."], started: false };
  if (!enemies.length) return { lines: ["There is nobody here to fight."], started: false };
  const share = R.encounterBudget(partyLevels(g), encounterDifficulty(g)) / enemies.length;
  for (const n of enemies) ensureStatBlock(g, n, share);
  const rolled = R.rollInitiative(rng, [
    ...party.map((p) => ({ id: p.id, kind: "hero" as const, name: p.name, dexMod: R.abilityMod(p.stats.dex), surprised: opts.surprise === "heroes", penalty: R.exhaustionPenalty(p.exhaustion) })),
    ...enemies.map((n) => ({ id: n.id, kind: "npc" as const, name: n.name, dexMod: R.abilityMod(n.stats.dex), surprised: opts.surprise === "foes" })),
  ]);
  g.combat = {
    round: 1,
    index: 0,
    vacant: false,
    order: rolled.map((r) => ({ id: r.id, kind: r.kind, init: r.total, roll: r.roll, surprised: r.surprised, reactionUsed: false, engaged: [], lastTargetId: null, lastAttackerId: null })),
    bonusUsed: false,
    disengaged: false,
    xpEarned: 0,
    overcome: [],
  };
  g.mode = "combat";
  g.round = 1;
  g.pending.check = null;
  addLog(g, "combat", `Initiative: ${rolled.map((r) => `${r.name} ${r.total}`).join(", ")}.`);
  const lines = [`Roll for initiative. The order is ${orderWords(g)}.`];
  runUntilHero(g, rng, lines);
  return { lines, started: true };
}

/** On to the next place in the order (which also fills a vacant turn: the index rested just before the gap). */
function step(g: Game): void {
  const c = g.combat;
  if (!c || !c.order.length) return;
  c.vacant = false;
  c.index += 1;
  if (c.index >= c.order.length) {
    c.index = 0;
    c.round += 1;
    g.round = c.round;
  }
}

function startOfTurn(g: Game, c: Combatant): void {
  c.reactionUsed = false;
  if (g.combat) {
    g.combat.bonusUsed = false;
    g.combat.disengaged = false;
  }
  const who = c.kind === "hero" ? heroById(g, c.id) : npcById(g, c.id);
  if (who) for (const lasting of ["dodging", "shielded"]) R.removeCondition(who, lasting);
}

/** End of a creature's turn: its timed conditions lose a round. Says what wore off for a hero. */
function endOfTurn(g: Game, c: Combatant, lines: string[]): void {
  const who = c.kind === "hero" ? heroById(g, c.id) : npcById(g, c.id);
  if (!who) return;
  const ended = R.tickConditions(who).filter((x) => x !== "helped");
  if (ended.length && c.kind === "hero") lines.push(`${who.name} is no longer ${ended.join(" or ")}.`);
}

/** The fight is over when no foe is left in the order, or no hero in it is on their feet. Ends it and says so. */
function endIfOver(g: Game, rng: Rng, lines: string[]): boolean {
  const c = g.combat;
  if (!c) return true;
  const anyFoe = c.order.some((x) => x.kind === "npc");
  const anyHero = c.order.some((x) => x.kind === "hero" && (heroById(g, x.id)?.hp ?? 0) > 0);
  if (anyFoe && anyHero) return false;
  lines.push(...endCombat(g, rng, anyFoe ? "defeat" : "victory").lines);
  return true;
}

/**
 * Run the fight forward from the creature at the head of the turn until a hero has to do something: monsters take
 * their turns, a hero who can't act loses theirs, and a hero at 0 hit points makes a death save (called for when the
 * table rolls its own dice). Appends what happens and, at the end, who is up.
 */
function runUntilHero(g: Game, rng: Rng, lines: string[]): void {
  for (let guard = 0; guard < 80; guard++) {
    if (endIfOver(g, rng, lines)) return;
    const c = currentCombatant(g);
    if (!c) {
      step(g);
      continue;
    }
    startOfTurn(g, c);
    if (c.kind === "npc") {
      const n = npcById(g, c.id);
      if (n && n.status === "alive") monsterTurn(g, rng, n, c, lines);
      if (endIfOver(g, rng, lines)) return;
      if (currentCombatant(g) === c) endOfTurn(g, c, lines);
      step(g);
      continue;
    }
    const p = heroById(g, c.id);
    if (!p || p.dead) {
      removeFromOrder(g, c.id);
      step(g);
      continue;
    }
    if (p.hp <= 0) {
      if (!p.stable) {
        if (g.settings.rolls === "ask") {
          g.pending.check = deathCheck(p);
          lines.push(`${p.name}, you're down: give me a death saving throw. Tell me the roll, or say roll for me.`);
          return;
        }
        lines.push(resolveDeathSave(g, rng, p).line);
        if (p.hp > 0) {
          lines.push(`${p.name}, you're up.`);
          return;
        }
        if (p.dead) {
          step(g); // their place is gone: on to whoever followed
          continue;
        }
      }
      endOfTurn(g, c, []);
      step(g);
      continue;
    }
    if (R.incapacitated(p.conditions)) {
      const why = p.conditions.find((x) => ["paralyzed", "stunned", "petrified", "incapacitated"].includes(x)) ?? "unable to act";
      lines.push(`${p.name} is ${why} and loses the turn.`);
      endOfTurn(g, c, lines);
      step(g);
      continue;
    }
    lines.push(`${p.name}, you're up.`);
    return;
  }
}

/**
 * The current turn is done: its conditions tick, and the fight runs on to the next hero who must act. When the turn is
 * vacant (its owner died on it) nobody's turn is ended: play simply runs on from whoever followed.
 */
export function advanceTurn(g: Game, rng: Rng): string[] {
  const lines: string[] = [];
  if (!g.combat) return lines;
  const c = currentCombatant(g);
  if (c) endOfTurn(g, c, lines);
  step(g);
  runUntilHero(g, rng, lines);
  return lines;
}

/** Swap the hero on turn with whoever comes next ("I delay"). At the end of the round it is a plain pass. */
export function delayTurn(g: Game, rng: Rng): string[] {
  const c = g.combat;
  if (!c || c.order.length < 2 || c.index >= c.order.length - 1) return advanceTurn(g, rng);
  const lines: string[] = [];
  const me = c.order[c.index]!;
  c.order[c.index] = c.order[c.index + 1]!;
  c.order[c.index + 1] = me;
  runUntilHero(g, rng, lines);
  return lines;
}

function pickTarget(g: Game, rng: Rng, c: Combatant): Player | null {
  const up = standing(g).filter((p) => g.combat?.order.some((x) => x.id === p.id));
  const seen = up.filter((p) => !p.conditions.includes("hidden") && !p.conditions.includes("invisible"));
  const pool = seen.length ? seen : up;
  if (!pool.length) return null;
  const grudge = pool.find((p) => p.id === c.lastAttackerId);
  if (grudge) return grudge;
  const close = pool.find((p) => c.engaged.includes(p.id));
  if (close) return close;
  return pool.length === 1 ? pool[0]! : pool[rng(pool.length) - 1]!;
}

function engage(g: Game, a: string, b: string): void {
  const x = combatantOf(g, a);
  const y = combatantOf(g, b);
  if (x && !x.engaged.includes(b)) x.engaged.push(b);
  if (y && !y.engaged.includes(a)) y.engaged.push(a);
}

/** One monster attack against a hero, with its extra damage and any save that rides on the hit. */
function monsterAttack(g: Game, rng: Rng, n: Npc, c: Combatant, atk: Attack, target: Player, lines: string[]): void {
  const mods = R.attackModifiers(n.conditions, target.conditions, { melee: !atk.ranged });
  const ac = target.ac + (target.conditions.includes("shielded") ? 5 : 0);
  const roll = R.rollAttack(rng, { toHit: atk.toHit, ac, adv: mods.adv, autoCrit: mods.autoCrit });
  recordD20(g, n.name, `${atk.name} attack on ${target.name}`, roll, roll.total, roll.ac, roll.crit ? "crit" : roll.fumble ? "fumble" : roll.hit ? "hit" : "miss");
  c.lastTargetId = target.id;
  if (!atk.ranged) engage(g, n.id, target.id);
  const who = npcRef(n, true);
  if (!roll.hit) {
    lines.push(roll.fumble ? `${who} attacks ${target.name}: a natural 1, a miss.` : `${who} attacks ${target.name}: ${roll.total} against armor class ${roll.ac}, a miss.`);
    addLog(g, "combat", `${who} misses ${target.name} (${roll.total} vs AC ${roll.ac}).`);
    return;
  }
  // One hit, one amount: a bite and the fire that comes with it are rolled apart and land together.
  const dmg = R.rollDice(atk.damage, rng, { crit: roll.crit });
  const extra = atk.extraDamage && atk.extraType ? { amount: R.rollDice(atk.extraDamage, rng, { crit: roll.crit }).total, type: atk.extraType } : null;
  const hurt = hurtHero(g, rng, target, dmg.total, atk.damageType, { crit: roll.crit, also: extra });
  const how = roll.natural === 20 ? "a natural 20, a critical hit" : `${roll.total} against armor class ${roll.ac}, a ${roll.crit ? "critical hit" : "hit"}`;
  lines.push(`${who} attacks ${target.name}: ${how} for ${hurt.words}. ${hurt.state}`, ...hurt.after);
  addLog(g, "combat", `${who} hits ${target.name} with ${atk.name.toLowerCase()} for ${hurt.words} (${target.hp}/${target.maxHp} HP).`);
  if (atk.rider && target.hp > 0 && !target.dead) {
    const r = atk.rider;
    const save = forcedSave(rng, target, r.ability, r.dc);
    const failed = !save.success;
    const label = `${target.name}'s ${R.ABILITY_NAMES[r.ability]} save: ${save.autoFail ? "it fails" : `${sumWords(save.kept, save.total)} against DC ${r.dc}`}`;
    const bits: string[] = [];
    let trailing: string[] = [];
    if (r.damage && r.damageType && (failed || r.half)) {
      const rd = R.rollDice(r.damage, rng);
      const amount = failed ? rd.total : Math.floor(rd.total / 2);
      if (amount > 0) {
        const poison = hurtHero(g, rng, target, amount, r.damageType);
        bits.push(`${poison.words}. ${poison.state}`);
        trailing = poison.after;
      }
    }
    if (failed && r.condition && target.hp > 0 && !target.dead) {
      R.addCondition(target, r.condition, r.rounds);
      bits.push(`${target.name} is ${r.condition}.`);
    }
    lines.push(`${label}, ${failed ? "a failure" : "a success"}${bits.length ? `: ${bits.join(" ")}` : "."}`, ...trailing);
  }
}

function breathAttack(g: Game, rng: Rng, n: Npc, c: Combatant, targets: Player[], lines: string[]): void {
  const b = n.breath!;
  b.ready = false;
  const dmg = R.rollDice(b.damage, rng);
  lines.push(`${npcRef(n, true)} unleashes its ${b.name.toLowerCase()}: ${dmg.total} ${b.damageType} damage, ${R.ABILITY_NAMES[b.ability]} save DC ${b.dc} for half.`);
  for (const t of targets) {
    if (t.dead || t.hp <= 0) continue;
    const save = forcedSave(rng, t, b.ability, b.dc);
    const hurt = hurtHero(g, rng, t, save.success ? Math.floor(dmg.total / 2) : dmg.total, b.damageType);
    lines.push(`${t.name} rolls ${save.total}, ${save.success ? "saves" : "fails"}, and takes ${hurt.result.amount}. ${hurt.state}`, ...hurt.after);
    c.lastTargetId = t.id;
  }
  addLog(g, "combat", `${npcRef(n, true)} uses ${b.name.toLowerCase()} (${dmg.total} ${b.damageType}).`);
}

/**
 * A monster's turn, by simple rules anyone can follow: it regenerates if it can; it can't act while incapacitated; a
 * ready breath weapon is used when two or more heroes stand; otherwise it makes its attacks, melee first, at the hero
 * who last hurt it, else one it is already fighting, else one picked by the die, and never at a hero who is down.
 */
function monsterTurn(g: Game, rng: Rng, n: Npc, c: Combatant, lines: string[]): void {
  if (n.regen > 0 && n.hp > 0 && n.hp < n.maxHp && !n.regenBlocked) n.hp = Math.min(n.maxHp, n.hp + n.regen);
  n.regenBlocked = false;
  if (n.breath && !n.breath.ready && rng(6) >= n.breath.recharge) n.breath.ready = true;
  if (R.incapacitated(n.conditions)) {
    const why = n.conditions.find((x) => ["paralyzed", "stunned", "petrified", "incapacitated", "unconscious"].includes(x)) ?? "unable to act";
    lines.push(`${npcRef(n, true)} is ${why} and can't act.`);
    return;
  }
  const up = standing(g).filter((p) => g.combat?.order.some((x) => x.id === p.id));
  if (!up.length) return;
  if (n.breath?.ready && up.length >= 2) {
    const first = pickTarget(g, rng, c);
    const rest = up.filter((p) => p !== first);
    breathAttack(g, rng, n, c, [first, ...rest].filter((p): p is Player => !!p).slice(0, n.breath.targets), lines);
    return;
  }
  const melee = n.attacks.filter((a) => !a.ranged);
  const pool = melee.length ? melee : n.attacks;
  if (!pool.length) return;
  let target = pickTarget(g, rng, c);
  for (let i = 0; i < n.attacksPerTurn; i++) {
    if (!target || target.hp <= 0 || target.dead) target = pickTarget(g, rng, c);
    if (!target) break;
    monsterAttack(g, rng, n, c, pool[Math.min(i, pool.length - 1)]!, target, lines);
  }
}

/**
 * End a fight. Victory (or a fight called off with foes already beaten) shares out the XP of what was overcome, levels
 * heroes up under XP leveling, turns out the foes' pockets, and the party tends anyone still dying. Defeat leaves the
 * fallen stable where they lie.
 */
export function endCombat(g: Game, rng: Rng, outcome: "victory" | "defeat" | "stopped"): { lines: string[] } {
  const c = g.combat;
  const lines: string[] = [];
  if (!c) return { lines: ["There is no fight going on."] };
  const lastActor = currentCombatant(g);
  g.combat = null;
  g.mode = "explore";
  g.round = 0;
  if (g.pending.check?.kind === "death") g.pending.check = null;
  for (const p of heroes(g)) for (const tag of ["dodging", "shielded", "hidden", "helped"]) R.removeCondition(p, tag);
  if (outcome === "defeat") {
    lines.push("The last hero falls. The fight is lost.");
    for (const p of living(g)) if (p.hp <= 0) R.stabilize(p);
    addLog(g, "combat", "The party is defeated.");
    g.spotlightId = null;
    return { lines };
  }
  lines.push(outcome === "victory" ? "The fight is over." : "The fight breaks off.");
  if (c.xpEarned > 0) lines.push(...awardXp(g, c.xpEarned));
  const tended = living(g).filter((p) => p.hp <= 0 && !p.stable);
  for (const p of tended) R.stabilize(p);
  if (tended.length) lines.push(`${tended.map((p) => p.name).join(" and ")} ${tended.length === 1 ? "is" : "are"} tended and stable, but still out.`);
  // Only the fallen leave anything behind: a foe that fled or was talked down keeps its purse.
  const fallenXp = g.npcs.filter((n) => n.status === "defeated" && c.overcome.includes(n.name)).reduce((sum, n) => sum + n.xp, 0);
  if (outcome === "victory" && fallenXp > 0) {
    const loot = treasureFor(rng, fallenXp);
    if (loot.gold > 0) {
      g.partyGold += loot.gold;
      if (loot.potion) addItem(g, { name: "Potion of Healing", type: "potion", rarity: "common", description: "A red liquid that glimmers when shaken.", properties: ["heals 2d4+2"] }, null);
      lines.push(`Among their things: ${loot.gold} gold${loot.potion ? " and a potion of healing" : ""}, in the party's loot.`);
      addLog(g, "loot", `The party finds ${loot.gold} gold${loot.potion ? " and a Potion of Healing" : ""}.`);
    }
  }
  addLog(g, "combat", outcome === "victory" ? `Victory over ${c.overcome.join(", ") || "the enemy"}.` : "The fight breaks off.");
  // The scene goes on with the hero who would have acted next.
  let next: Player | null = null;
  for (let i = 1; i <= c.order.length && !next; i++) {
    const x = c.order[(c.index + i + c.order.length) % c.order.length];
    const h = x?.kind === "hero" ? heroById(g, x.id) : null;
    if (h && h.hp > 0 && !h.dead) next = h;
  }
  if (next) g.spotlightId = next.id;
  else passSpotlight(g, lastActor?.id ?? g.spotlightId);
  return { lines };
}

/**
 * After something changed the fight from outside a turn's normal run: end it if it is over (no foe left, or no hero
 * standing); and if whoever was on turn has left the order, run on to the next hero who must act. Returns what is said.
 */
export function settleFight(g: Game, rng: Rng): string[] {
  const lines: string[] = [];
  if (!g.combat) return lines;
  if (endIfOver(g, rng, lines)) return lines;
  if (g.combat.vacant) lines.push(...advanceTurn(g, rng));
  return lines;
}

/** "It's Mira's turn, round 2." / "Nobody is on turn: Thorin has the spotlight." */
export function whoseTurn(g: Game): string {
  if (g.phase === "paused") return "The game is paused.";
  if (g.combat) {
    const c = currentCombatant(g);
    if (!c) return `Round ${g.combat.round}.`;
    const who = nameOf(g, c);
    const p = c.kind === "hero" ? heroById(g, c.id) : null;
    const played = p?.playerName ? `, played by ${p.playerName}` : "";
    const after = g.combat.order[(g.combat.index + 1) % g.combat.order.length];
    const next = after && after !== c ? ` Then ${nameOf(g, after)}.` : "";
    if (g.pending.check && p && g.pending.check.heroId === p.id) return `It's ${who}'s turn${played}, round ${g.combat.round}: I'm waiting for a ${g.pending.check.label.toLowerCase()}.${next}`;
    return `It's ${who}'s turn${played}, round ${g.combat.round}.${next}`;
  }
  const p = heroById(g, g.spotlightId);
  if (g.pending.check) {
    const h = heroById(g, g.pending.check.heroId);
    if (h) return `I'm waiting for ${h.name}'s ${g.pending.check.label.toLowerCase()}.`;
  }
  return p ? `There's no fight, so no turn order: ${p.name} has the spotlight${p.playerName ? `, played by ${p.playerName}` : ""}.` : "There's no fight, so no turn order: anyone can act.";
}

/** A hero acting when it isn't their turn is told whose it is and how long they wait. Null when they may act. */
export function notYourTurn(g: Game, actor: Player): string | null {
  const c = g.combat;
  if (!c) return null;
  const cur = currentCombatant(g);
  if (!cur || cur.id === actor.id) return null;
  const mine = c.order.findIndex((x) => x.id === actor.id);
  if (mine < 0) return `${actor.name} isn't in this fight.`;
  const away = (mine - c.index + c.order.length) % c.order.length;
  const turnOf = nameOf(g, cur);
  if (away === 1) return `It's ${turnOf}'s turn. ${actor.name}, you're next.`;
  const before = c.order[(mine - 1 + c.order.length) % c.order.length]!;
  return `It's ${turnOf}'s turn. ${actor.name}, you're after ${nameOf(g, before)}.`;
}

// ─── A hero's attack ─────────────────────────────────────────────────────────

export interface AttackOutcome {
  lines: string[];
  hit: boolean;
  crit: boolean;
  defeated: boolean;
}

/** A hero attacks a creature with a weapon: attack roll against armor class, damage on a hit, dice doubled on a critical hit. */
export function heroAttack(
  g: Game,
  rng: Rng,
  p: Player,
  target: Npc,
  opts: { weaponWords?: string | null; adv?: Adv; fixed?: number | null } = {},
): AttackOutcome {
  const prof = heroAttackProfile(g, p, opts.weaponWords);
  const mods = R.attackModifiers(p.conditions, target.conditions, { melee: !prof.weapon.ranged });
  const helped = R.removeCondition(p, "helped");
  const roll = R.rollAttack(rng, {
    toHit: prof.toHit,
    ac: target.ac,
    adv: R.combineAdv(opts.adv, mods.adv, helped ? "adv" : null),
    fixed: opts.fixed,
    penalty: R.exhaustionPenalty(p.exhaustion),
    autoCrit: mods.autoCrit,
  });
  R.removeCondition(p, "hidden");
  recordD20(g, p.name, `Attack with ${prof.label.replace(/^(?:the|an?) /, "")}`, roll, roll.total, roll.ac, roll.crit ? "crit" : roll.fumble ? "fumble" : roll.hit ? "hit" : "miss");
  const me = combatantOf(g, p.id);
  if (me) me.lastTargetId = target.id;
  if (!prof.weapon.ranged) engage(g, p.id, target.id);
  const lead = `${p.name} attacks ${npcRef(target)} with ${prof.label}`;
  const both = roll.adv && roll.rolls.length === 2 ? `${roll.rolls[0]} and ${roll.rolls[1]} with ${roll.adv === "adv" ? "advantage" : "disadvantage"}: ` : "";
  if (!roll.hit) {
    const how = roll.fumble ? `${both}a natural 1, a miss` : `${d20Words(roll, roll.total)} against armor class ${roll.ac}, a miss`;
    addLog(g, "combat", `${p.name} misses ${npcRef(target)} (${roll.total} vs AC ${roll.ac}).`);
    return { lines: [`${lead}: ${how}.`], hit: false, crit: false, defeated: false };
  }
  const dmg = R.rollDice(prof.damage, rng, { crit: roll.crit });
  const hurt = hurtNpc(g, target, dmg.total, prof.weapon.damageType, p.id);
  const how = roll.natural === 20 ? `${both}a natural 20, a critical hit` : `${d20Words(roll, roll.total)} against armor class ${roll.ac}, a ${roll.crit ? "critical hit" : "hit"}`;
  addLog(g, "combat", `${p.name} hits ${npcRef(target)} for ${damageWords(hurt.result)}${roll.crit ? " (critical hit)" : ""}.`);
  return { lines: [`${lead}: ${how} for ${damageWords(hurt.result)}.`, hurt.state, ...hurt.after], hit: true, crit: roll.crit, defeated: hurt.defeated };
}

// ─── Spells ──────────────────────────────────────────────────────────────────

export interface SpellOutcome {
  lines: string[];
  /** The spell was cast (a slot is spent, the turn is used). */
  cast: boolean;
}

const spellAttackBonus = (p: Player): number => R.proficiencyBonus(p.level) + R.abilityMod(p.stats[p.castingAbility ?? "int"]);
const spellSaveDc = (p: Player): number => 8 + spellAttackBonus(p);

/**
 * Cast a spell from the table (srd.ts SPELLS). A leveled spell spends a slot of its level, or the next one up; with
 * none left it isn't cast. Attack spells roll against armor class, save spells make each target save (monsters'
 * saves are rolled here), healing adds the casting modifier.
 */
export function castSpell(g: Game, rng: Rng, p: Player, spell: SpellInfo, targets: { npcs: Npc[]; heroes: Player[] }, opts: { slotLevel?: number | null; fixed?: number | null } = {}): SpellOutcome {
  if (!p.castingAbility) return { lines: [`${p.name} can't cast spells.`], cast: false };
  const name = spell.name.toLowerCase();
  const max = spell.targets ?? 1;
  // A spell with nobody to aim at isn't cast: no slot is spent and nothing already being concentrated on is dropped.
  const harmful = spell.kind === "attack" || spell.kind === "save" || spell.kind === "auto";
  const victims = harmful ? targets.npcs.filter((n) => n.status === "alive").slice(0, max) : [];
  if (harmful && !victims.length) return { lines: [`There's no target for ${name}.`], cast: false };
  let slot = 0;
  if (spell.level > 0) {
    const spent = R.spendSlot(p, Math.max(spell.level, opts.slotLevel ?? spell.level));
    if (!spent.ok) return { lines: [`${p.name} has no spell slot left for ${name}.`], cast: false };
    slot = spent.level;
  }
  const withSlot = slot ? ` with a level ${slot} slot` : "";
  const lines: string[] = [];
  if (spell.concentration) {
    const dropped = endConcentration(g, p);
    if (dropped) lines.push(`${p.name} lets ${dropped} go.`);
    p.concentration = spell.name;
  }
  R.removeCondition(p, "hidden");

  if (harmful) {
    const dice = spell.damage ? (spell.level === 0 ? cantripDice(spell.damage, p.level) : upcastDice(spell.damage, spell.perLevel, spell.level, slot)) : null;
    const type = spell.damageType ?? "force";
    if (spell.kind === "attack") {
      // A spell of several rays (scorching ray) spreads them over the targets named, or sends them all at one.
      const rays = Array.from({ length: spell.targets ? max : 1 }, (_, i) => victims[Math.min(i, victims.length - 1)]!);
      for (const [i, aimed] of rays.entries()) {
        const n = aimed.status === "alive" ? aimed : victims.find((v) => v.status === "alive");
        if (!n) break;
        const mods = R.attackModifiers(p.conditions, n.conditions, { melee: spell.melee === true });
        const roll = R.rollAttack(rng, { toHit: spellAttackBonus(p), ac: n.ac, adv: mods.adv, fixed: i === 0 ? opts.fixed : null, penalty: R.exhaustionPenalty(p.exhaustion), autoCrit: mods.autoCrit });
        recordD20(g, p.name, `${spell.name} attack`, roll, roll.total, roll.ac, roll.crit ? "crit" : roll.fumble ? "fumble" : roll.hit ? "hit" : "miss");
        const lead = i === 0 ? `${p.name} casts ${name}${withSlot} at ${npcRef(n)}` : `The next ray, at ${npcRef(n)}`;
        if (!roll.hit) {
          lines.push(`${lead}: ${roll.fumble ? "a natural 1, a miss" : `${d20Words(roll, roll.total)} against armor class ${roll.ac}, a miss`}.`);
          continue;
        }
        const dmg = R.rollDice(dice ?? "1d6", rng, { crit: roll.crit });
        const hurt = hurtNpc(g, n, dmg.total, type, p.id);
        const how = roll.natural === 20 ? "a natural 20, a critical hit" : `${d20Words(roll, roll.total)} against armor class ${roll.ac}, a hit`;
        lines.push(`${lead}: ${how} for ${damageWords(hurt.result)}.`, hurt.state, ...hurt.after);
      }
    } else if (spell.kind === "auto") {
      const n = victims[0]!;
      const dmg = R.rollDice(dice ?? "1d4+1", rng);
      const hurt = hurtNpc(g, n, dmg.total, type, p.id);
      recordDice(g, p.name, spell.name, dmg);
      lines.push(`${p.name} casts ${name}${withSlot} at ${npcRef(n)}: it strikes unerringly for ${damageWords(hurt.result)}.`, hurt.state, ...hurt.after);
    } else {
      const dc = spellSaveDc(p);
      const ability = spell.save ?? "dex";
      const dmg = dice ? R.rollDice(dice, rng) : null;
      if (dmg) recordDice(g, p.name, spell.name, dmg);
      lines.push(`${p.name} casts ${name}${withSlot}: ${R.ABILITY_NAMES[ability]} save, DC ${dc}${dmg ? `, ${dmg.total} ${type} damage` : ""}.`);
      for (const n of victims) {
        const mods = R.testModifiers(n.conditions, "save", ability);
        const save = R.rollCheck(rng, { modifier: npcSaveModifier(n, ability), dc, adv: mods.adv, autoFail: mods.autoFail });
        const who = npcRef(n, true);
        const rolled = save.autoFail ? "can't resist" : `rolls ${save.total} and ${save.success ? "saves" : "fails"}`;
        if (dmg) {
          const amount = save.success ? (spell.half ? Math.floor(dmg.total / 2) : 0) : dmg.total;
          if (amount > 0) {
            const hurt = hurtNpc(g, n, amount, type, p.id);
            lines.push(`${who} ${rolled}, taking ${damageWords(hurt.result)}.`, hurt.state, ...hurt.after);
          } else lines.push(`${who} ${rolled}, taking nothing.`);
        }
        if (!save.success && spell.condition && n.status === "alive") {
          R.addCondition(n, spell.condition, spell.rounds ?? null);
          lines.push(dmg ? `${who} is ${spell.condition}.` : `${who} ${rolled}: ${spell.condition}.`);
        } else if (!dmg) lines.push(`${who} ${rolled}.`);
      }
      // Everyone shook it off: there is nothing left to concentrate on.
      if (spell.concentration && spell.condition && !victims.some((n) => n.conditions.includes(spell.condition!))) p.concentration = null;
    }
    addLog(g, "combat", lines.join(" "));
    return { lines: lines.filter(Boolean), cast: true };
  }

  if (spell.kind === "heal") {
    const who = (targets.heroes.length ? targets.heroes : [p]).filter((t) => !t.dead).slice(0, max);
    const dice = upcastDice(spell.heal ?? "1d8", spell.perLevel, spell.level, slot);
    const bonus = Math.max(0, R.abilityMod(p.stats[p.castingAbility]));
    for (const [i, t] of who.entries()) {
      const roll = R.rollDice(dice, rng);
      if (i === 0) recordDice(g, p.name, spell.name, { ...roll, modifier: bonus, total: roll.total + bonus });
      const healed = healHero(g, t, roll.total + bonus);
      lines.push(i === 0 ? `${p.name} casts ${name}${withSlot}${t === p ? "" : ` on ${t.name}`}: ${healed.line}` : healed.line);
    }
    addLog(g, "party", lines.join(" "));
    return { lines, cast: true };
  }

  if (spell.kind === "buff") {
    const who = (targets.heroes.length ? targets.heroes : [p]).filter((t) => !t.dead).slice(0, max);
    for (const t of who) R.addCondition(t, spell.condition ?? "blessed", spell.rounds ?? 10);
    lines.push(`${p.name} casts ${name}${withSlot} on ${who.map((t) => (t === p ? "themself" : t.name)).join(" and ")}.`);
    addLog(g, "party", lines.join(" "));
    return { lines, cast: true };
  }

  if (spell.kind === "react") {
    // Until the start of the caster's next turn (startOfTurn takes it off), whenever in the round it was cast.
    R.addCondition(p, "shielded", null);
    lines.push(`${p.name} casts ${name}${withSlot}: plus 5 to armor class until ${p.name}'s next turn.`);
    return { lines, cast: true };
  }

  // Utility spells with a rule of their own.
  const friend = targets.heroes[0] ?? null;
  if (spell.name === "Revivify") {
    const fallen = targets.heroes.find((t) => t.dead) ?? heroes(g).find((t) => t.dead);
    if (!fallen) {
      p.slotsUsed[slot - 1] = Math.max(0, (p.slotsUsed[slot - 1] ?? 1) - 1);
      return { lines: ["Nobody here needs reviving."], cast: false };
    }
    fallen.dead = false;
    fallen.hp = 1;
    fallen.deathSaves = { successes: 0, failures: 0 };
    fallen.stable = false;
    lines.push(`${p.name} casts ${name}${withSlot}: ${fallen.name} returns to life with 1 hit point.`);
  } else if (spell.name === "Lesser Restoration") {
    const t = friend ?? p;
    const cured = ["paralyzed", "poisoned", "blinded", "deafened"].find((c) => t.conditions.includes(c));
    if (cured) R.removeCondition(t, cured);
    lines.push(`${p.name} casts ${name}${withSlot} on ${t === p ? "themself" : t.name}${cured ? `: no longer ${cured}` : ", but there was nothing to cure"}.`);
  } else lines.push(`${p.name} casts ${name}${withSlot}.`);
  addLog(g, "party", lines.join(" "));
  return { lines, cast: true };
}

/** A spell the table has no rule for: it costs a slot of the level it claims (cantrips are free) and the story takes it from there. */
export function castUnlisted(g: Game, p: Player, spellName: string, level: number): SpellOutcome {
  if (!p.castingAbility) return { lines: [`${p.name} can't cast spells.`], cast: false };
  const name = spellName.toLowerCase();
  if (level > 0) {
    const spent = R.spendSlot(p, level);
    if (!spent.ok) return { lines: [`${p.name} has no spell slot left for ${name}.`], cast: false };
    addLog(g, "party", `${p.name} casts ${name} (level ${spent.level} slot).`);
    return { lines: [`${p.name} casts ${name} with a level ${spent.level} slot.`], cast: true };
  }
  addLog(g, "party", `${p.name} casts ${name}.`);
  return { lines: [`${p.name} casts ${name}.`], cast: true };
}

// ─── Actions other than attacking ────────────────────────────────────────────

export type Maneuver = "dodge" | "dash" | "disengage" | "hide" | "help" | "grapple" | "shove" | "stabilize";

/** The standard actions: Dodge, Dash, Disengage, Hide, Help, and the unarmed grapple and shove, plus first aid. */
export function heroManeuver(g: Game, rng: Rng, p: Player, what: Maneuver, target: { npc?: Npc | null; hero?: Player | null } = {}, fixed?: number | null): { lines: string[]; done: boolean } {
  switch (what) {
    case "dodge":
      R.addCondition(p, "dodging", null);
      return { lines: [`${p.name} dodges: attacks against ${p.name} have disadvantage until their next turn.`], done: true };
    case "dash":
      return { lines: [`${p.name} dashes, covering twice the ground this turn.`], done: true };
    case "disengage":
      if (g.combat) g.combat.disengaged = true;
      return { lines: [`${p.name} disengages and can move away without drawing an attack.`], done: true };
    case "hide": {
      const watchers = foes(g);
      const dc = watchers.length ? Math.max(...watchers.map((n) => R.passiveScore(R.abilityMod(n.stats.wis)))) : 10;
      const check = resolveCheck(g, rng, p, { kind: "check", ability: "dex", skill: "stealth", dc, fixed });
      if (check.result.success) R.addCondition(p, "hidden", null);
      return { lines: [check.line.replace(/ against DC \d+\./, ` against a passive Perception of ${dc}.`), check.result.success ? `${p.name} is hidden.` : `${p.name} is spotted.`], done: true };
    }
    case "help": {
      const friend = target.hero;
      if (!friend || friend === p) return { lines: ["Who are you helping?"], done: false };
      R.addCondition(friend, "helped", 2);
      return { lines: [`${p.name} helps ${friend.name}, who has advantage on their next attack or check.`], done: true };
    }
    case "stabilize": {
      const friend = target.hero;
      if (!friend || friend.dead || friend.hp > 0 || friend.stable) return { lines: [friend ? `${friend.name} doesn't need stabilizing.` : "Who are you stabilizing?"], done: false };
      const check = resolveCheck(g, rng, p, { kind: "check", ability: "wis", skill: "medicine", dc: R.STABILIZE_DC, fixed });
      if (check.result.success) {
        R.stabilize(friend);
        if (g.pending.check?.heroId === friend.id && g.pending.check.kind === "death") g.pending.check = null;
      }
      return { lines: [check.line, check.result.success ? `${friend.name} is stable.` : `${friend.name} is still dying.`], done: true };
    }
    case "grapple":
    case "shove": {
      const n = target.npc;
      if (!n || n.status !== "alive") return { lines: [`Who are you trying to ${what}?`], done: false };
      const dc = 8 + R.abilityMod(p.stats.str) + R.proficiencyBonus(p.level);
      const ability: AbilityKey = npcSaveModifier(n, "str") >= npcSaveModifier(n, "dex") ? "str" : "dex";
      const mods = R.testModifiers(n.conditions, "save", ability);
      const save = R.rollCheck(rng, { modifier: npcSaveModifier(n, ability), dc, adv: mods.adv, autoFail: mods.autoFail });
      engage(g, p.id, n.id);
      const effect = what === "grapple" ? "grappled" : "prone";
      if (!save.success) R.addCondition(n, effect, null);
      const lead = `${p.name} tries to ${what} ${npcRef(n)}, DC ${dc}: ${npcRef(n)} rolls ${save.total} on a ${R.ABILITY_NAMES[ability]} save`;
      return { lines: [save.success ? `${lead} and shrugs it off.` : `${lead} and fails. ${npcRef(n, true)} is ${effect}.`], done: true };
    }
  }
}

/** A hero who walks away from foes they are fighting, without disengaging, draws an opportunity attack from each that can react. */
export function provoke(g: Game, rng: Rng, p: Player): string[] {
  const c = g.combat;
  const me = combatantOf(g, p.id);
  if (!c || !me || c.disengaged) return [];
  const lines: string[] = [];
  for (const id of [...me.engaged]) {
    const n = npcById(g, id);
    const them = combatantOf(g, id);
    if (!n || !them || n.status !== "alive" || !R.canReact(n.conditions, them.reactionUsed)) continue;
    const atk = n.attacks.find((a) => !a.ranged);
    if (!atk || p.hp <= 0) continue;
    them.reactionUsed = true;
    lines.push(`${npcRef(n, true)} takes an opportunity attack.`);
    monsterAttack(g, rng, n, them, atk, p, lines);
  }
  me.engaged = [];
  for (const x of c.order) x.engaged = x.engaged.filter((e) => e !== p.id);
  return lines;
}

// ─── Rests ───────────────────────────────────────────────────────────────────

/**
 * A short rest for the party: each wounded hero spends hit dice until healed or out of them. A stable hero comes
 * round with 1 hit point first; a warlock's pact slots return.
 */
export function shortRestParty(g: Game, rng: Rng): string[] {
  if (g.combat) return ["You can't rest in the middle of a fight."];
  const lines: string[] = [];
  for (const p of living(g)) {
    if (p.hp <= 0 && p.stable) R.applyHealing(p, 1);
    if (p.hp <= 0) {
      lines.push(`${p.name} is dying and can't rest.`);
      continue;
    }
    if (classProfile(p.className).caster === "pact") R.restoreSlots(p);
    if (p.hp >= p.maxHp) continue;
    const r = R.shortRest(rng, p, R.hitDiceLeft(p));
    if (r.spent) lines.push(`${p.name} spends ${plural(r.spent, "hit die", "hit dice")}, regains ${r.healed}, and is at ${p.hp} of ${p.maxHp}.`);
    else lines.push(`${p.name} has no hit dice left and stays at ${p.hp}.`);
  }
  addLog(g, "party", `The party takes a short rest. ${lines.join(" ")}`.trim());
  return [lines.length ? "You take a short rest." : "You take a short rest. Everyone was already at full strength.", ...lines];
}

/** A long rest for the party: all hit points, hit dice and spell slots back, a level of exhaustion gone. */
export function longRestParty(g: Game): string[] {
  if (g.combat) return ["You can't rest in the middle of a fight."];
  for (const p of living(g)) {
    R.longRest(p);
    endConcentration(g, p);
    for (const c of [...p.conditions]) if (p.conditionRounds[c] !== undefined || ["dodging", "hidden", "helped", "shielded"].includes(c)) R.removeCondition(p, c);
  }
  addLog(g, "party", "The party takes a long rest: hit points, hit dice and spell slots are restored.");
  return ["You take a long rest. Everyone is back to full hit points, with all hit dice and spell slots restored."];
}

// ─── Items and gold ──────────────────────────────────────────────────────────

export interface ItemDraftLike {
  name: string;
  type: ItemType;
  rarity: Rarity;
  description?: string;
  properties?: string[];
  appearance?: string;
  value?: number;
  quantity?: number;
}

/** Add an item to a hero's pack (or the party's loot). Art is the caller's business. */
export function addItem(g: Game, d: ItemDraftLike, ownerId: string | null): Item {
  const it: Item = {
    id: newId(),
    name: d.name,
    type: d.type,
    rarity: d.rarity,
    description: d.description ?? "",
    properties: d.properties ?? [],
    ownerId,
    appearance: d.appearance ?? d.name,
    icon: emptySlot(),
    quantity: Math.max(1, d.quantity ?? 1),
    value: 0,
  };
  it.value = d.value ?? itemPrice(it);
  g.items.push(it);
  const owner = heroById(g, ownerId);
  if (owner) owner.inventory.push(it.id);
  return it;
}

/** Take one of an item away; the last one leaves the sheet (and the hand that held it). */
export function consumeItem(g: Game, it: Item): void {
  if (it.quantity > 1) {
    it.quantity -= 1;
    return;
  }
  removeItem(g, it);
}

export function removeItem(g: Game, it: Item): void {
  g.items = g.items.filter((x) => x.id !== it.id);
  for (const p of g.players) {
    p.inventory = p.inventory.filter((id) => id !== it.id);
    for (const k of ["weapon", "armor", "shield"] as const) if (p.equipped[k] === it.id) p.equipped[k] = null;
  }
}

function diceSaid(roll: R.DiceRoll): string {
  if (roll.rolls.length > 3 || !roll.rolls.length) return `${roll.total}`;
  const parts = [...roll.rolls.map(String), ...(roll.modifier ? [String(Math.abs(roll.modifier))] : [])];
  return parts.length > 1 && roll.modifier >= 0 ? `${parts.join(" plus ")} is ${roll.total}` : `${roll.total}`;
}

/** Use something a hero carries. A healing consumable heals through the rules (2d4+2 for a potion of healing) and is used up. */
export function useItem(g: Game, rng: Rng, user: Player, it: Item, target: Player | null): { lines: string[]; used: boolean } {
  const name = it.name.toLowerCase();
  const heal = healingDice(it);
  if (heal) {
    const who = target ?? user;
    if (who.dead) return { lines: [`${who.name} is beyond the help of the ${name}.`], used: false };
    const roll = R.rollDice(heal, rng);
    recordDice(g, user.name, it.name, roll);
    const healed = healHero(g, who, roll.total);
    consumeItem(g, it);
    addLog(g, "party", `${user.name} uses the ${it.name}${who === user ? "" : ` on ${who.name}`}: ${roll.total} (${who.hp}/${who.maxHp} HP).`);
    return { lines: [`${user.name} ${who === user ? "drinks" : `gives ${who.name}`} the ${name}: ${diceSaid(roll)}. ${healed.line}`], used: true };
  }
  if (isConsumable(it)) {
    consumeItem(g, it);
    addLog(g, "party", `${user.name} uses the ${it.name}.`);
    return { lines: [`${user.name} uses the ${name}. It's used up.`], used: true };
  }
  addLog(g, "party", `${user.name} uses the ${it.name}.`);
  return { lines: [`${user.name} uses the ${name}.`], used: true };
}

/** Hand an item to another hero, or into the party's loot (to = null). */
export function giveItem(g: Game, it: Item, to: Player | null): string[] {
  const from = heroById(g, it.ownerId);
  if (from) {
    from.inventory = from.inventory.filter((id) => id !== it.id);
    for (const k of ["weapon", "armor", "shield"] as const) {
      if (from.equipped[k] === it.id) {
        from.equipped[k] = null;
        if (k !== "weapon") from.ac = heroArmorClass(g, from);
      }
    }
  }
  it.ownerId = to?.id ?? null;
  if (to && !to.inventory.includes(it.id)) to.inventory.push(it.id);
  const name = it.name.toLowerCase();
  addLog(g, "loot", to ? `${to.name} receives the ${it.name}${from ? ` from ${from.name}` : ""}.` : `The ${it.name} goes into the party's loot.`);
  if (to) return [from ? `${from.name} hands the ${name} to ${to.name}.` : `${to.name} takes the ${name}.`];
  return [`${from ? `${from.name} puts` : "You put"} the ${name} with the party's loot.`];
}

export function dropItem(g: Game, p: Player, it: Item): string[] {
  const wasWorn = p.equipped.armor === it.id || p.equipped.shield === it.id;
  removeItem(g, it);
  if (wasWorn) p.ac = heroArmorClass(g, p);
  addLog(g, "loot", `${p.name} drops the ${it.name}.`);
  return [`${p.name} drops the ${it.name.toLowerCase()}${wasWorn ? `: armor class ${p.ac}` : ""}.`];
}

/** Hold a weapon, or put on armor or a shield: attacks and armor class follow. */
export function equipItem(g: Game, p: Player, it: Item): { lines: string[]; done: boolean } {
  const name = it.name.toLowerCase();
  const armor = armorStats(it);
  if (armor) {
    p.equipped[armor.kind === "shield" ? "shield" : "armor"] = it.id;
    p.ac = heroArmorClass(g, p);
    addLog(g, "party", `${p.name} puts on the ${it.name} (AC ${p.ac}).`);
    return { lines: [`${p.name} ${armor.kind === "shield" ? "straps on" : "puts on"} the ${name}: armor class ${p.ac}.`], done: true };
  }
  const weapon = weaponStats(it);
  if (weapon) {
    p.equipped.weapon = it.id;
    const prof = heroAttackProfile(g, p);
    addLog(g, "party", `${p.name} readies the ${it.name}.`);
    return { lines: [`${p.name} readies the ${name}: ${prof.toHit >= 0 ? "plus" : "minus"} ${Math.abs(prof.toHit)} to hit, ${weapon.damageType} damage.`], done: true };
  }
  return { lines: [`The ${name} isn't something to wield or wear.`], done: false };
}

export function unequipItem(g: Game, p: Player, it: Item): { lines: string[]; done: boolean } {
  const slot = (["weapon", "armor", "shield"] as const).find((k) => p.equipped[k] === it.id);
  if (!slot) return { lines: [`${p.name} isn't using the ${it.name.toLowerCase()}.`], done: false };
  p.equipped[slot] = null;
  if (slot === "weapon") return { lines: [`${p.name} puts the ${it.name.toLowerCase()} away.`], done: true };
  p.ac = heroArmorClass(g, p);
  addLog(g, "party", `${p.name} takes off the ${it.name} (AC ${p.ac}).`);
  return { lines: [`${p.name} takes off the ${it.name.toLowerCase()}: armor class ${p.ac}.`], done: true };
}

/** Buy something: the price comes off the buyer's gold, or the purchase doesn't happen. */
export function buyItem(g: Game, p: Player, d: ItemDraftLike, price: number): { lines: string[]; item: Item | null } {
  const cost = Math.max(0, Math.round(price));
  const name = d.name.toLowerCase();
  if (p.gold < cost) return { lines: [`${p.name} has ${p.gold} gold, and the ${name} costs ${cost}.`], item: null };
  p.gold -= cost;
  const item = addItem(g, { ...d, value: cost || undefined }, p.id);
  addLog(g, "loot", `${p.name} buys the ${d.name} for ${cost} gold (${p.gold} left).`);
  return { lines: [`${p.name} buys the ${name} for ${cost} gold and has ${p.gold} left.`], item };
}

/** Sell something for half its worth. */
export function sellItem(g: Game, p: Player, it: Item, price?: number | null): string[] {
  // Half its worth, a coin at least for anything worth something; a thing worth nothing finds no buyer.
  const got = Math.max(0, Math.round(price ?? (it.value > 0 ? Math.max(1, Math.floor(it.value / 2)) : 0)));
  if (got <= 0) return [`Nobody here will pay for the ${it.name.toLowerCase()}.`];
  const wasWorn = p.equipped.armor === it.id || p.equipped.shield === it.id;
  consumeItem(g, it);
  if (wasWorn) p.ac = heroArmorClass(g, p);
  p.gold += got;
  addLog(g, "loot", `${p.name} sells the ${it.name} for ${got} gold (now ${p.gold}).`);
  return [`${p.name} sells the ${it.name.toLowerCase()} for ${got} gold and now has ${p.gold}.`];
}

/** Move gold between a hero and another hero or the party's purse. Never more than is there. */
export function moveGold(g: Game, from: Player | null, to: Player | null, amount: number): string[] {
  const have = from ? from.gold : g.partyGold;
  const n = Math.min(have, Math.max(0, Math.round(amount)));
  if (n <= 0) return [from ? `${from.name} has no gold to give.` : "The party's purse is empty."];
  if (from) from.gold -= n;
  else g.partyGold -= n;
  if (to) to.gold += n;
  else g.partyGold += n;
  addLog(g, "loot", `${from ? from.name : "The party"} gives ${n} gold to ${to ? to.name : "the party's purse"}.`);
  return [`${from ? from.name : "The party"} gives ${n} gold to ${to ? to.name : "the party's purse"}. ${to ? `${to.name} now has ${to.gold}.` : `The purse holds ${g.partyGold}.`}`];
}

// ─── Creatures entering and leaving ──────────────────────────────────────────

/**
 * Put `count` creatures of a bestiary kind into the scene, hostile and with their stat blocks. One of a kind is "Goblin";
 * several are numbered ("Goblin 1", "Goblin 2"), and one already here takes a number too. Portraits are the caller's business.
 */
export function spawn(g: Game, m: Monster, count: number): Npc[] {
  const same = g.npcs.filter((n) => n.kind === m.key && n.status === "alive");
  const numbered = same.length + count > 1;
  if (numbered) for (const n of same) if (n.name === m.name) n.name = `${m.name} 1`;
  const taken = new Set(g.npcs.map((n) => n.name));
  const out: Npc[] = [];
  let next = 1;
  for (let i = 0; i < count; i++) {
    let name = m.name;
    if (numbered) {
      while (taken.has(`${m.name} ${next}`)) next++;
      name = `${m.name} ${next}`;
    }
    taken.add(name);
    const npc: Npc = {
      id: newId(),
      name,
      role: m.name.toLowerCase(),
      description: `${/^[aeiou]/i.test(m.name) ? "An" : "A"} ${m.name.toLowerCase()}, ready to fight.`,
      attitude: "hostile",
      appearance: `${m.name.toLowerCase()}, ${m.type}, menacing, full of character`,
      portrait: emptySlot(),
      ...statBlockOf(m),
      status: "alive",
      conditions: [],
      conditionRounds: {},
    };
    g.npcs.push(npc);
    out.push(npc);
  }
  return out;
}

/** A newcomer joins a fight already under way: it rolls initiative and slots into the order. */
export function joinCombat(g: Game, rng: Rng, n: Npc): void {
  const c = g.combat;
  if (!c || c.order.some((x) => x.id === n.id)) return;
  const [r] = R.rollInitiative(rng, [{ id: n.id, kind: "npc", name: n.name, dexMod: R.abilityMod(n.stats.dex) }]);
  if (!r) return;
  const current = c.order[c.index];
  const entry: Combatant = { id: n.id, kind: "npc", init: r.total, roll: r.roll, surprised: false, reactionUsed: false, engaged: [], lastTargetId: null, lastAttackerId: null };
  const at = c.order.findIndex((x) => x.init < r.total);
  c.order.splice(at < 0 ? c.order.length : at, 0, entry);
  if (current) c.index = c.order.indexOf(current);
}

/**
 * A creature stops being a foe: it flees or is defeated (overcome: its XP counts), is talked down ("calmed": it
 * stays in the scene, and counts too), or is simply gone from the story. In a fight it leaves the order, and the fight
 * ends if it was the last foe.
 */
export function dismissNpc(g: Game, rng: Rng, n: Npc, how: "fled" | "defeated" | "gone" | "calmed"): string[] {
  const lines: string[] = [];
  const inFight = g.combat?.order.some((x) => x.id === n.id) ?? false;
  if (how === "gone") g.npcs = g.npcs.filter((x) => x.id !== n.id);
  else if (how !== "calmed") {
    n.status = how;
    if (how === "defeated") n.hp = 0;
    n.conditions = [];
    n.conditionRounds = {};
  }
  if (g.combat && inFight) {
    if (how !== "gone") {
      g.combat.xpEarned += n.xp;
      g.combat.overcome.push(n.name);
    }
    const wasCurrent = currentCombatant(g)?.id === n.id;
    removeFromOrder(g, n.id);
    if (wasCurrent) {
      step(g);
      runUntilHero(g, rng, lines);
    } else endIfOver(g, rng, lines);
  }
  return lines;
}

/** A hero leaves a fight for good (removed from the party): the order closes up and play runs on. */
export function leaveCombat(g: Game, rng: Rng, heroId: string): string[] {
  const lines: string[] = [];
  if (!g.combat?.order.some((x) => x.id === heroId)) return lines;
  const wasCurrent = currentCombatant(g)?.id === heroId;
  removeFromOrder(g, heroId);
  if (wasCurrent) {
    step(g);
    runUntilHero(g, rng, lines);
  } else endIfOver(g, rng, lines);
  return lines;
}

/** A hero may react (an opportunity attack) once a round, while able to act. Marks the reaction used. */
export function useReaction(g: Game, p: Player): boolean {
  const c = combatantOf(g, p.id);
  if (!c || !R.canReact(p.conditions, c.reactionUsed) || p.hp <= 0) return false;
  c.reactionUsed = true;
  return true;
}

// ─── What a hero can do, in words ────────────────────────────────────────────

/** The choices on a hero's turn (or out of a fight), read off the sheet: weapon, spells with slots, potions, the standard actions. */
export function optionsFor(g: Game, p: Player): string {
  if (p.dead) return `${p.name} has died.`;
  if (p.hp <= 0) return p.stable ? `${p.name} is stable but unconscious, and can only wait for healing.` : `${p.name} is down and can only make death saving throws.`;
  const prof = heroAttackProfile(g, p);
  const parts = [`attack with ${prof.label}`];
  if (p.castingAbility && p.spells.length) {
    const left = p.slotsMax.reduce((n, m, i) => n + Math.max(0, m - (p.slotsUsed[i] ?? 0)), 0);
    const names = p.spells.slice(0, 3).map((s) => s.toLowerCase());
    parts.push(`cast a spell such as ${names.join(" or ")}${p.slotsMax.some((m) => m > 0) ? `, with ${plural(left, "spell slot")} left` : ""}`);
  }
  const potion = itemsOf(g, p.id).find((it) => healingDice(it));
  if (potion) parts.push(`drink your ${potion.name.toLowerCase()}`);
  if (g.combat) return `${p.name}, you can ${parts.join(", ")}, or dodge, dash, disengage, hide or help a friend.`;
  return `${p.name}, you can ${parts.join(", ")}, or look around, talk to someone, search, or move on.`;
}
