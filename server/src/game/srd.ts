/*
 * This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC,
 * available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0
 * International License.
 *
 * (The line above covers the rules tables here, the rules summaries, rules.ts and the stat blocks in bestiary.ts.)
 */
import { abilityMod, CONDITION_RULES, parseDice, type CasterKind, type ConditionKey, type SkillKey } from "./rules.js";
import type { AbilityKey, Item, ItemType, Rarity, Stats } from "./types.js";

/** Shown in the game's "about" data (the board, the saved-games API). */
export const SRD_ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License.';

export const RULES_NAME = "Fifth-edition rules from the System Reference Document";

// ─── Classes ─────────────────────────────────────────────────────────────────

export type ClassKey =
  | "barbarian" | "bard" | "cleric" | "druid" | "fighter" | "monk" | "paladin" | "ranger" | "rogue" | "sorcerer"
  | "warlock" | "wizard";

export interface ClassProfile {
  key: ClassKey;
  hitDie: number;
  saves: [AbilityKey, AbilityKey];
  /** The skills a ready-made hero of this class is proficient in. */
  skills: SkillKey[];
  caster: CasterKind;
  ability: AbilityKey | null;
  /** Spells a hero of this class starts out knowing (see SPELLS). */
  spells: string[];
}

const CLASSES: Record<ClassKey, ClassProfile> = {
  barbarian: { key: "barbarian", hitDie: 12, saves: ["str", "con"], skills: ["athletics", "perception"], caster: null, ability: null, spells: [] },
  bard: { key: "bard", hitDie: 8, saves: ["dex", "cha"], skills: ["performance", "persuasion", "deception"], caster: "full", ability: "cha", spells: ["vicious mockery", "healing word", "cure wounds", "thunderwave"] },
  cleric: { key: "cleric", hitDie: 8, saves: ["wis", "cha"], skills: ["medicine", "religion"], caster: "full", ability: "wis", spells: ["sacred flame", "cure wounds", "healing word", "guiding bolt", "bless"] },
  druid: { key: "druid", hitDie: 8, saves: ["int", "wis"], skills: ["nature", "survival"], caster: "full", ability: "wis", spells: ["produce flame", "cure wounds", "healing word", "entangle", "thunderwave"] },
  fighter: { key: "fighter", hitDie: 10, saves: ["str", "con"], skills: ["athletics", "intimidation"], caster: null, ability: null, spells: [] },
  monk: { key: "monk", hitDie: 8, saves: ["str", "dex"], skills: ["acrobatics", "stealth"], caster: null, ability: null, spells: [] },
  paladin: { key: "paladin", hitDie: 10, saves: ["wis", "cha"], skills: ["athletics", "persuasion"], caster: "half", ability: "cha", spells: ["cure wounds", "bless"] },
  ranger: { key: "ranger", hitDie: 10, saves: ["str", "dex"], skills: ["survival", "perception", "stealth"], caster: "half", ability: "wis", spells: ["cure wounds"] },
  rogue: { key: "rogue", hitDie: 8, saves: ["dex", "int"], skills: ["stealth", "sleight of hand", "perception", "deception"], caster: null, ability: null, spells: [] },
  sorcerer: { key: "sorcerer", hitDie: 6, saves: ["con", "cha"], skills: ["arcana", "persuasion"], caster: "full", ability: "cha", spells: ["fire bolt", "ray of frost", "magic missile", "burning hands", "shield"] },
  warlock: { key: "warlock", hitDie: 8, saves: ["wis", "cha"], skills: ["arcana", "intimidation"], caster: "pact", ability: "cha", spells: ["eldritch blast", "burning hands"] },
  wizard: { key: "wizard", hitDie: 6, saves: ["int", "wis"], skills: ["arcana", "investigation"], caster: "full", ability: "int", spells: ["fire bolt", "ray of frost", "magic missile", "burning hands", "shield"] },
};

/**
 * Class words at the table → the class whose chassis they use. `magic` says the word itself names a spellcaster: a
 * "mage" casts like a wizard, an "engineer" only borrows the wizard's hit die, saves and skills.
 */
const CLASS_WORDS: [RegExp, ClassKey, boolean][] = [
  [/barbarian|berserker|brute|brawler|bruiser/, "barbarian", false],
  [/bard|minstrel|performer|singer/, "bard", true],
  [/cleric|priest|templar|chaplain/, "cleric", true],
  [/preacher|healer|medic|doctor|nurse|surgeon/, "cleric", false],
  [/druid|shaman/, "druid", true],
  [/paladin|crusader/, "paladin", true],
  [/ranger/, "ranger", true],
  [/hunter|archer|tracker|scout|sniper|gunslinger|outlaw|bounty hunter|cowboy|gunfighter/, "ranger", false],
  [/sorcer|psion|telepath/, "sorcerer", true],
  [/warlock|witch|occultist|hexblade/, "warlock", true],
  [/wizard|mage|necromancer|magician/, "wizard", true],
  [/artificer|inventor|scientist|professor|scholar|researcher|engineer|mechanic|techie|gadgeteer|tinker|hacker|netrunner|decker/, "wizard", false],
  [/monk|martial artist|speedster/, "monk", false],
  [/rogue|thief|assassin|burglar|grifter|ninja|cutpurse|spy|smuggler|fixer|gambler|scavenger|pilot|aeronaut|navigator|detective|investigator|reporter|journalist/, "rogue", false],
  [/fighter|warrior|knight|samurai|swordsman|duelist|swashbuckler|gladiator|soldier|marine|mercenary|gunner|raider|trooper|captain|sheriff|guard/, "fighter", false],
];

/** The rules chassis for a class name as spoken ("Dwarf Fighter", "Netrunner", "Street Samurai"). Unknown names fight like a fighter with d8 hit dice. */
export function classProfile(className: string): ClassProfile {
  const c = className.toLowerCase();
  for (const [re, key, magic] of CLASS_WORDS) {
    if (!re.test(c)) continue;
    const base = CLASSES[key];
    const exact = c.includes(key);
    return magic || exact ? base : { ...base, caster: null, ability: null, spells: [] };
  }
  return { key: "fighter", hitDie: 8, saves: ["str", "con"], skills: ["athletics", "perception"], caster: null, ability: null, spells: [] };
}

/** Damage a species shrugs off (dwarves and poison, tieflings and fire). */
export function speciesResistances(race: string): string[] {
  const r = race.toLowerCase();
  if (/dwarf/.test(r)) return ["poison"];
  if (/tiefling/.test(r)) return ["fire"];
  return [];
}

/** The ready-made heroes offered at session zero: classes and species from the SRD. */
export const READY_MADE: { race: string; className: string }[] = [
  { race: "Human", className: "Fighter" },
  { race: "Elf", className: "Wizard" },
  { race: "Dwarf", className: "Cleric" },
  { race: "Halfling", className: "Rogue" },
  { race: "Half-Orc", className: "Barbarian" },
  { race: "Half-Elf", className: "Bard" },
];

// ─── Weapons ─────────────────────────────────────────────────────────────────

export interface WeaponStats {
  name: string;
  damage: string;
  damageType: string;
  finesse: boolean;
  ranged: boolean;
  /** Reach or normal range in feet. */
  range: number;
  /** A magic bonus to hit and damage ("+1"). */
  bonus: number;
}

type WeaponRow = [names: string, damage: string, type: string, flags?: string, range?: number];

/** Longer names first within a family so "hand crossbow" wins over "crossbow". f = finesse, r = ranged. */
const WEAPON_ROWS: WeaponRow[] = [
  ["hand crossbow", "1d6", "piercing", "r", 30],
  ["heavy crossbow", "1d10", "piercing", "r", 100],
  ["light crossbow|crossbow", "1d8", "piercing", "r", 80],
  ["longbow", "1d8", "piercing", "r", 150],
  ["shortbow|bow", "1d6", "piercing", "r", 80],
  ["sling", "1d4", "bludgeoning", "r", 30],
  ["darts?", "1d4", "piercing", "fr", 20],
  ["blowgun", "1", "piercing", "r", 25],
  ["musket|rifle|carbine|shotgun", "1d12", "piercing", "r", 40],
  ["pistol|revolver|blaster|sidearm", "1d10", "piercing", "r", 30],
  ["greatsword", "2d6", "slashing"],
  ["greataxe", "1d12", "slashing"],
  ["greatclub", "1d8", "bludgeoning"],
  ["maul", "2d6", "bludgeoning"],
  ["halberd|glaive", "1d10", "slashing", "", 10],
  ["pike", "1d10", "piercing", "", 10],
  ["lance", "1d10", "piercing", "", 10],
  ["longsword|katana|sword", "1d8", "slashing"],
  ["handaxe|hand axe|hatchet", "1d6", "slashing"],
  ["battleaxe|waraxe|war axe|axe", "1d8", "slashing"],
  ["light hammer", "1d4", "bludgeoning"],
  ["warhammer|war hammer|hammer", "1d8", "bludgeoning"],
  ["morningstar", "1d8", "piercing"],
  ["war pick", "1d8", "piercing"],
  ["flail", "1d8", "bludgeoning"],
  ["trident", "1d8", "piercing"],
  ["rapier", "1d8", "piercing", "f"],
  ["scimitar|cutlass|saber|sabre", "1d6", "slashing", "f"],
  ["shortswords?|blade", "1d6", "piercing", "f"],
  ["javelins?", "1d6", "piercing"],
  ["spear", "1d6", "piercing"],
  ["mace", "1d6", "bludgeoning"],
  ["quarterstaff|staff", "1d6", "bludgeoning"],
  ["sickle", "1d4", "slashing"],
  ["whip", "1d4", "slashing", "f", 10],
  ["dagger|knife|vibroknife|stiletto", "1d4", "piercing", "f"],
  ["club|baton|cudgel", "1d4", "bludgeoning"],
];

const WEAPONS: { re: RegExp; damage: string; damageType: string; finesse: boolean; ranged: boolean; range: number }[] = WEAPON_ROWS.map(
  ([names, damage, type, flags = "", range]) => ({
    re: new RegExp(`\\b(?:${names})\\b`, "i"),
    damage,
    damageType: type,
    finesse: flags.includes("f"),
    ranged: flags.includes("r"),
    range: range ?? 5,
  }),
);

const DAMAGE_TYPES = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
] as const;

export function isDamageType(v: unknown): v is (typeof DAMAGE_TYPES)[number] {
  return typeof v === "string" && (DAMAGE_TYPES as readonly string[]).includes(v);
}

/** The first damage type named in some words ("5 fire damage"), or null. */
export function damageTypeIn(text: string): string | null {
  const t = text.toLowerCase();
  return DAMAGE_TYPES.find((d) => new RegExp(`\\b${d}\\b`).test(t)) ?? null;
}

function magicBonus(item: Pick<Item, "name" | "properties">): number {
  const m = /(?:^|[^\w])\+([1-3])(?!\d)/.exec(`${item.name} ${item.properties.join(" ")}`);
  return m ? Number(m[1]) : 0;
}

export const UNARMED: WeaponStats = { name: "an unarmed strike", damage: "1", damageType: "bludgeoning", finesse: false, ranged: false, range: 5, bonus: 0 };

/**
 * What an item does as a weapon: a damage tag among its properties ("1d8 slashing") wins, else the weapons table by
 * name ("Dwarven Waraxe" is a battleaxe). Null when it isn't a weapon.
 */
export function weaponStats(item: Pick<Item, "name" | "type" | "properties">): WeaponStats | null {
  const row = WEAPONS.find((w) => w.re.test(item.name));
  let tagged: { damage: string; damageType: string } | null = null;
  for (const p of item.properties) {
    const m = /\b(\d*d\d+(?:\s*[+-]\s*\d+)?)\s+([a-z]+)\b/i.exec(p);
    if (m && parseDice(m[1]!) && isDamageType(m[2]!.toLowerCase())) {
      tagged = { damage: m[1]!.replace(/\s+/g, ""), damageType: m[2]!.toLowerCase() };
      break;
    }
  }
  if (!row && !tagged && item.type !== "weapon") return null;
  return {
    name: item.name,
    damage: tagged?.damage ?? row?.damage ?? "1d6",
    damageType: tagged?.damageType ?? row?.damageType ?? "bludgeoning",
    finesse: row?.finesse ?? false,
    ranged: row?.ranged ?? false,
    range: row?.range ?? 5,
    bonus: magicBonus(item),
  };
}

// ─── Armor ───────────────────────────────────────────────────────────────────

export interface ArmorStats {
  kind: "armor" | "shield";
  /** Base armor class (a shield: its bonus). */
  base: number;
  /** How much Dexterity counts: null = all of it, 0 = none. */
  dexCap: number | null;
  bonus: number;
}

const ARMOR_ROWS: [RegExp, number, number | null][] = [
  [/\bstudded leather\b/i, 12, null],
  [/\b(?:padded|quilted)\b/i, 11, null],
  [/\bleathers?(?: armou?r)?\b/i, 11, null],
  [/\bhide\b/i, 12, 2],
  [/\bchain shirt\b/i, 13, 2],
  [/\bscale(?: mail)?\b/i, 14, 2],
  [/\bbreastplate\b/i, 14, 2],
  [/\bhalf[- ]plate\b/i, 15, 2],
  [/\bring mail\b/i, 14, 0],
  [/\bchain ?mail\b/i, 16, 0],
  [/\bsplint\b/i, 17, 0],
  [/\b(?:full )?plate(?: mail| armou?r)?\b/i, 18, 0],
  [/\b(?:flak|armou?red vest|combat armou?r|brigandine)\b/i, 13, 2],
  [/\b(?:exosuit|power armou?r)\b/i, 16, 0],
];

/** What an item does as armor or a shield, or null. */
export function armorStats(item: Pick<Item, "name" | "type" | "properties">): ArmorStats | null {
  if (/\bshield\b/i.test(item.name)) return { kind: "shield", base: 2, dexCap: null, bonus: magicBonus(item) };
  const row = ARMOR_ROWS.find(([re]) => re.test(item.name));
  if (!row) return item.type === "armor" && /\barmou?r\b/i.test(item.name) ? { kind: "armor", base: 12, dexCap: 2, bonus: magicBonus(item) } : null;
  return { kind: "armor", base: row[1], dexCap: row[2], bonus: magicBonus(item) };
}

/**
 * Armor class from what is worn: the armor's base plus Dexterity (capped for medium armor, none for heavy), a shield's
 * +2, or 10 + Dexterity unarmored (a barbarian adds Constitution, a monk without a shield adds Wisdom).
 */
export function armorClass(hero: { stats: Stats; className: string }, armor: ArmorStats | null, shield: ArmorStats | null): number {
  const dex = abilityMod(hero.stats.dex);
  let ac: number;
  if (armor) ac = armor.base + (armor.dexCap === null ? dex : Math.min(dex, armor.dexCap)) + armor.bonus;
  else {
    const key = classProfile(hero.className).key;
    ac = 10 + dex;
    if (key === "barbarian") ac += Math.max(0, abilityMod(hero.stats.con));
    else if (key === "monk" && !shield) ac += Math.max(0, abilityMod(hero.stats.wis));
  }
  if (shield) ac += shield.base + shield.bonus;
  return Math.min(30, Math.max(5, ac));
}

// ─── Consumables and prices ──────────────────────────────────────────────────

/** The dice a healing consumable restores ("Potion of Healing": 2d4+2), or null when the item doesn't heal. */
export function healingDice(item: Pick<Item, "name" | "type" | "properties">): string | null {
  for (const p of item.properties) {
    const m = /\bheals?\s+(\d*d\d+(?:\s*[+-]\s*\d+)?)/i.exec(p);
    if (m && parseDice(m[1]!)) return m[1]!.replace(/\s+/g, "");
  }
  const n = item.name.toLowerCase();
  if (!/\b(heal\w*|health|vitality|cure|curative|medkit|med kit|stim\w*|first aid|bandages?|salve|restorative)\b/.test(n)) return null;
  if (/\bsupreme\b/.test(n)) return "10d4+20";
  if (/\bsuperior\b/.test(n)) return "8d4+8";
  if (/\bgreater\b/.test(n)) return "4d4+4";
  return "2d4+2";
}

/** Something used up when it is used. */
export function isConsumable(item: Pick<Item, "name" | "type">): boolean {
  return item.type === "potion" || item.type === "scroll" || /\b(ration|torch|arrow|bolt|bandage|medkit|stim|grenade|flask|vial)s?\b/i.test(item.name);
}

const PRICES: [RegExp, number][] = [
  [/\bpotion of (?:supreme) healing\b/i, 5000],
  [/\bpotion of (?:superior) healing\b/i, 1000],
  [/\bpotion of (?:greater) healing\b/i, 200],
  [/\b(?:potion of healing|healing potion|healing draught)\b/i, 50],
  [/\bhalf[- ]plate\b/i, 750],
  [/\bbreastplate\b/i, 400],
  [/\bplate\b/i, 1500],
  [/\bsplint\b/i, 200],
  [/\bchain ?mail\b/i, 75],
  [/\b(?:chain shirt|scale mail)\b/i, 50],
  [/\bstudded leather\b/i, 45],
  [/\bring mail\b/i, 30],
  [/\b(?:leather|hide)\b/i, 10],
  [/\bshield\b/i, 10],
  [/\bhand crossbow\b/i, 75],
  [/\b(?:greatsword|longbow|heavy crossbow)\b/i, 50],
  [/\bgreataxe\b/i, 30],
  [/\b(?:rapier|scimitar|shortbow|light crossbow|crossbow)\b/i, 25],
  [/\b(?:longsword|warhammer|morningstar)\b/i, 15],
  [/\b(?:shortsword|battleaxe|maul|flail)\b/i, 10],
  [/\b(?:handaxe|mace)\b/i, 5],
  [/\bdagger\b/i, 2],
  [/\b(?:thieves' tools|thieves tools)\b/i, 25],
  [/\b(?:healer's kit|herbalism kit|lantern)\b/i, 5],
  [/\b(?:rope|torch|rations?|bedroll|waterskin|quarterstaff|spear|javelins?|club|sling|arrows?|bolts?)\b/i, 1],
];
const TYPE_PRICE: Record<ItemType, number> = { weapon: 10, armor: 25, potion: 50, scroll: 50, wondrous: 100, gear: 2, treasure: 25, quest: 0 };
const RARITY_FACTOR: Record<Rarity, number> = { common: 1, uncommon: 5, rare: 50, "very rare": 500, legendary: 5000, artifact: 50000 };

/** What an item costs to buy, in gold (it sells for half). */
export function itemPrice(item: Pick<Item, "name" | "type" | "rarity">): number {
  const listed = PRICES.find(([re]) => re.test(item.name))?.[1];
  const byKind = TYPE_PRICE[item.type] * RARITY_FACTOR[item.rarity];
  // An ordinary listed item costs what the list says (a shield is 10, a dagger 2); a rarer one at least what its rarity commands.
  return listed === undefined ? byKind : item.rarity === "common" ? listed : Math.max(listed, byKind);
}

// ─── Spells ──────────────────────────────────────────────────────────────────

export interface SpellInfo {
  name: string;
  /** 0 = a cantrip. */
  level: number;
  /** attack: a spell attack roll · save: the target saves · auto: it just hits · heal · buff · react · utility. */
  kind: "attack" | "save" | "auto" | "heal" | "buff" | "react" | "utility";
  damage?: string;
  damageType?: string;
  /** More dice for each slot level above the spell's own. */
  perLevel?: string;
  save?: AbilityKey;
  /** Half damage on a successful save. */
  half?: boolean;
  /** A condition on a failed save, for this many rounds. */
  condition?: string;
  rounds?: number;
  heal?: string;
  melee?: boolean;
  /** Catches up to this many foes at once (1 when absent). */
  targets?: number;
  concentration?: boolean;
  bonusAction?: boolean;
}

const spell = (name: string, level: number, kind: SpellInfo["kind"], rest: Partial<SpellInfo> = {}): SpellInfo => ({ name, level, kind, ...rest });

/** A working set of SRD spells with what they do at the table. Anything else a hero casts is narrated, at the cost of a slot. */
export const SPELLS: Record<string, SpellInfo> = Object.fromEntries(
  [
    spell("Fire Bolt", 0, "attack", { damage: "1d10", damageType: "fire" }),
    spell("Ray of Frost", 0, "attack", { damage: "1d8", damageType: "cold" }),
    spell("Shocking Grasp", 0, "attack", { damage: "1d8", damageType: "lightning", melee: true }),
    spell("Eldritch Blast", 0, "attack", { damage: "1d10", damageType: "force" }),
    spell("Produce Flame", 0, "attack", { damage: "1d8", damageType: "fire" }),
    spell("Sacred Flame", 0, "save", { damage: "1d8", damageType: "radiant", save: "dex" }),
    spell("Acid Splash", 0, "save", { damage: "1d6", damageType: "acid", save: "dex", targets: 2 }),
    spell("Vicious Mockery", 0, "save", { damage: "1d6", damageType: "psychic", save: "wis" }),
    spell("Magic Missile", 1, "auto", { damage: "3d4+3", damageType: "force", perLevel: "1d4+1" }),
    spell("Guiding Bolt", 1, "attack", { damage: "4d6", damageType: "radiant", perLevel: "1d6" }),
    spell("Burning Hands", 1, "save", { damage: "3d6", damageType: "fire", save: "dex", half: true, perLevel: "1d6", targets: 2 }),
    spell("Thunderwave", 1, "save", { damage: "2d8", damageType: "thunder", save: "con", half: true, perLevel: "1d8", targets: 2 }),
    spell("Entangle", 1, "save", { save: "str", condition: "restrained", rounds: 10, concentration: true, targets: 2 }),
    spell("Cure Wounds", 1, "heal", { heal: "2d8", perLevel: "2d8" }),
    spell("Healing Word", 1, "heal", { heal: "2d4", perLevel: "2d4", bonusAction: true }),
    spell("Bless", 1, "buff", { condition: "blessed", rounds: 10, concentration: true, targets: 3 }),
    spell("Shield", 1, "react"),
    spell("Scorching Ray", 2, "attack", { damage: "2d6", damageType: "fire", targets: 3 }),
    spell("Shatter", 2, "save", { damage: "3d8", damageType: "thunder", save: "con", half: true, perLevel: "1d8", targets: 2 }),
    spell("Hold Person", 2, "save", { save: "wis", condition: "paralyzed", rounds: 10, concentration: true }),
    spell("Lesser Restoration", 2, "utility"),
    spell("Fireball", 3, "save", { damage: "8d6", damageType: "fire", save: "dex", half: true, perLevel: "1d6", targets: 4 }),
    spell("Lightning Bolt", 3, "save", { damage: "8d6", damageType: "lightning", save: "dex", half: true, perLevel: "1d6", targets: 3 }),
    spell("Mass Healing Word", 3, "heal", { heal: "2d4", perLevel: "1d4", bonusAction: true, targets: 6 }),
    spell("Revivify", 3, "utility"),
  ].map((s) => [s.name.toLowerCase(), s]),
);

/** A spell named in some words ("I cast fire bolt at the goblin"), longest name first. */
export function findSpell(text: string): SpellInfo | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `;
  let best: SpellInfo | null = null;
  for (const [key, s] of Object.entries(SPELLS)) {
    if ((t.includes(` ${key} `) || t.includes(` ${key.replace(/ /g, "")} `)) && (!best || key.length > best.name.length)) best = s;
  }
  return best;
}

/** A cantrip's damage grows with the caster: twice the dice at level 5, three times at 11, four at 17. */
export function cantripDice(dice: string, casterLevel: number): string {
  const d = parseDice(dice);
  if (!d) return dice;
  const times = casterLevel >= 17 ? 4 : casterLevel >= 11 ? 3 : casterLevel >= 5 ? 2 : 1;
  return d.terms.map((t) => `${t.count * times}d${t.sides}`).join("+") + (d.modifier ? `+${d.modifier}` : "");
}

/** A leveled spell cast with a higher slot: `perLevel` more dice for each level above its own. */
export function upcastDice(base: string, perLevel: string | undefined, spellLevel: number, slotLevel: number): string {
  const extra = Math.max(0, slotLevel - spellLevel);
  if (!perLevel || !extra) return base;
  const b = parseDice(base);
  const p = parseDice(perLevel);
  if (!b || !p) return base;
  const terms = [...b.terms.map((t) => ({ ...t }))];
  for (const t of p.terms) {
    const same = terms.find((x) => x.sides === t.sides);
    if (same) same.count += t.count * extra;
    else terms.push({ count: t.count * extra, sides: t.sides });
  }
  const modifier = b.modifier + p.modifier * extra;
  return terms.map((t) => `${t.count}d${t.sides}`).join("+") + (modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : "");
}

// ─── Rules reference (for "how does grappling work?") ────────────────────────

interface RuleTopic {
  key: string;
  match: RegExp;
  answer: string;
}

const CONDITION_TOPICS: RuleTopic[] = (Object.keys(CONDITION_RULES) as ConditionKey[]).map((c) => ({
  key: c,
  match: new RegExp(`\\b${c}\\b|\\b${c.replace(/ed$/, "")}(?:ed|ing)?\\b`, "i"),
  answer: CONDITION_RULES[c],
}));

/** Short, spoken rules summaries. The first topic whose pattern matches the question answers it. */
const RULE_TOPICS: RuleTopic[] = [
  { key: "grapple", match: /\bgrappl\w*|\bgrab(?:bing)? (?:someone|him|her|it|them|a|the)\b|\bwrestl\w*/i, answer: "To grapple, use your attack to grab a creature no more than one size larger. It makes a Strength or Dexterity save against eight plus your Strength modifier and proficiency bonus. If it fails, it is grappled: its speed is zero until it breaks free or you let go." },
  { key: "shove", match: /\bshov\w*|\bpush(?:ing)? (?:someone|him|her|it|them|a|the)\b|\bknock\w* (?:\w+ )?prone\b/i, answer: "To shove, use your attack on a creature no more than one size larger. It makes a Strength or Dexterity save against eight plus your Strength modifier and proficiency bonus. If it fails, you push it five feet or knock it prone." },
  { key: "opportunity attack", match: /\bopportunity attack|\battacks? of opportunity|\bprovok\w*/i, answer: "When a creature you can see leaves your reach, you can use your reaction to make one melee attack against it. Taking the Disengage action lets you move away without provoking one." },
  { key: "death saves", match: /\bdeath sav\w*|\bdying\b|\bzero hit points\b|\b0 hit points\b|\bdrops? to (?:zero|0)\b/i, answer: "At zero hit points you fall unconscious and roll a death save at the start of each turn: ten or higher succeeds. Three successes and you are stable; three failures and you die. A natural one counts as two failures, and a natural twenty puts you back on one hit point." },
  { key: "stabilize", match: /\bstabili[sz]\w*|\bfirst aid\b/i, answer: "To stabilize a dying creature, use your action for a Wisdom Medicine check against DC ten. A stable creature stays unconscious at zero hit points but stops making death saves. Any healing wakes it." },
  { key: "advantage", match: /\b(?:dis)?advantage\b/i, answer: "With advantage you roll two d twenties and keep the higher; with disadvantage you keep the lower. Several sources don't stack, and if you have both, they cancel out and you roll one die." },
  { key: "critical hit", match: /\bcrit\w*|\bnatural (?:twenty|20)\b|\bnat (?:twenty|20)\b/i, answer: "A natural twenty on an attack roll always hits and is a critical hit: roll all of the attack's damage dice twice, then add modifiers once. A natural one on an attack always misses." },
  { key: "cover", match: /\bcover\b/i, answer: "Half cover gives plus two to armor class and Dexterity saves; three-quarters cover gives plus five. A target with total cover can't be targeted directly." },
  { key: "short rest", match: /\bshort rest\b/i, answer: "A short rest is about an hour of downtime. You can spend hit dice: for each one, roll it, add your Constitution modifier, and regain that many hit points." },
  { key: "long rest", match: /\blong rest\b|\bsleep(?:ing)? for the night\b|\bmake camp\b/i, answer: "A long rest is at least eight hours. You regain all your hit points, all your hit dice and all your spell slots, and you lose one level of exhaustion." },
  { key: "rest", match: /\brest(?:s|ing)?\b/i, answer: "A short rest takes an hour and lets you spend hit dice to heal. A long rest takes eight hours and restores all hit points, hit dice and spell slots." },
  { key: "concentration", match: /\bconcentrat\w*/i, answer: "Some spells need concentration, and you can concentrate on only one at a time. When you take damage, make a Constitution save against ten or half the damage, whichever is higher. Fail, or become incapacitated, and the spell ends." },
  { key: "exhaustion", match: /\bexhaust\w*/i, answer: "Each level of exhaustion takes two off every d twenty roll you make and five feet off your speed. A long rest removes one level. At six levels, you die." },
  { key: "surprise", match: /\bsurpris\w*|\bambush\w*/i, answer: "A creature caught by surprise when a fight starts rolls initiative with disadvantage." },
  { key: "initiative", match: /\binitiative\b|\bturn order\b/i, answer: "When a fight starts, everyone rolls initiative, a Dexterity check. Turns go from the highest total to the lowest, and the order stays the same each round." },
  { key: "hide", match: /\bhid(?:e|ing|den)\b|\bsneak\w*|\bstealth\b/i, answer: "To hide, take the Hide action and roll a Dexterity Stealth check against the passive Perception of anyone who might notice. While hidden you attack with advantage, and attacking gives you away." },
  { key: "dodge", match: /\bdodg\w*/i, answer: "If you take the Dodge action, attacks against you have disadvantage until your next turn, as long as you can see the attacker, and you have advantage on Dexterity saves." },
  { key: "dash", match: /\bdash\w*/i, answer: "The Dash action gives you extra movement equal to your speed for the turn." },
  { key: "disengage", match: /\bdisengag\w*|\bretreat\w*/i, answer: "If you take the Disengage action, your movement doesn't provoke opportunity attacks for the rest of the turn." },
  { key: "help", match: /\bhelp action\b|\bhelp(?:ing)? (?:an? |my |another )?(?:ally|friend|someone)\b/i, answer: "With the Help action you give an ally advantage on their next ability check, or on their next attack against a creature within five feet of you." },
  { key: "ready", match: /\bready(?:ing)? an? action\b|\bready action\b/i, answer: "To ready an action, name a trigger and what you'll do; when the trigger happens you use your reaction to do it." },
  { key: "bonus action", match: /\bbonus action\b/i, answer: "You get one bonus action on your turn, and only when a feature, spell or item says it uses one: drinking a potion is a bonus action." },
  { key: "reaction", match: /\breactions?\b/i, answer: "You get one reaction each round, used in response to a trigger, such as an opportunity attack. You regain it at the start of your turn." },
  { key: "action", match: /\bwhat (?:can|could) (?:i|we|you) do\b|\bactions? in combat\b|\bon my turn\b/i, answer: "On your turn you can move up to your speed and take one action: attack, cast a spell, dash, disengage, dodge, help, hide, ready, search or use an object. You may also have a bonus action." },
  { key: "spell slots", match: /\bspell slots?\b|\bslots?\b/i, answer: "Casting a spell of first level or higher uses up a spell slot of that level or higher. Cantrips cost nothing. A long rest restores all your slots." },
  { key: "inspiration", match: /\binspiration\b/i, answer: "If you have inspiration, you can spend it to roll one attack, save or ability check with advantage. You either have it or you don't: it can't be banked twice." },
  { key: "temporary hit points", match: /\btemp(?:orary)? (?:hit points|hp)\b/i, answer: "Temporary hit points are a buffer: damage comes off them first. They don't add together, you keep the larger amount, and healing can't restore them." },
  { key: "resistance", match: /\bresistan\w*|\bvulnerab\w*|\bimmun\w*/i, answer: "Resistance halves damage of that type, rounded down. Vulnerability doubles it. Immunity means the damage does nothing." },
  { key: "falling", match: /\bfall(?:ing|s)?\b|\bfell\b/i, answer: "A fall deals one d six bludgeoning damage for every ten feet fallen, up to twenty d six, and you land prone unless you avoid the damage." },
  { key: "difficult terrain", match: /\bdifficult terrain\b/i, answer: "Every foot of movement in difficult terrain costs one extra foot." },
  { key: "passive perception", match: /\bpassive\b/i, answer: "Passive Perception is ten plus your Wisdom Perception modifier. It's what you notice without looking; it's five higher with advantage and five lower with disadvantage." },
  { key: "saving throw", match: /\bsaving throws?\b|\bsaves?\b/i, answer: "A saving throw is a d twenty plus the ability modifier, plus your proficiency bonus if you're proficient in that save. Meet or beat the DC and you resist the effect." },
  { key: "ability check", match: /\bability checks?\b|\bskill checks?\b|\bproficien\w*/i, answer: "An ability check is a d twenty plus the ability modifier, plus your proficiency bonus when a skill you're proficient in applies. Meet or beat the DC and you succeed." },
  { key: "attack roll", match: /\battack rolls?\b|\bto hit\b|\barmor class\b|\bac\b/i, answer: "To attack, roll a d twenty and add your ability modifier and proficiency bonus. If the total equals or beats the target's armor class, you hit and roll damage." },
  { key: "ranged attacks", match: /\branged\b|\brange\b|\bshoot\w*/i, answer: "A ranged attack has disadvantage when a hostile creature that can see you is within five feet, and when the target is beyond the weapon's normal range." },
  { key: "unarmed", match: /\bunarmed\b|\bpunch\w*|\bkick\w*/i, answer: "An unarmed strike is a melee attack that deals one plus your Strength modifier in bludgeoning damage. You can also use it to grapple or shove." },
  { key: "level up", match: /\blevel(?:ing)? up\b|\bexperience\b|\bxp\b|\bmilestones?\b/i, answer: "You gain a level when your experience points reach the next threshold: three hundred for level two, nine hundred for level three. With milestone leveling, the party levels up at big moments in the story instead." },
  { key: "potion", match: /\bpotions?\b/i, answer: "Drinking a potion, or giving one to someone else, is a bonus action. A potion of healing restores two d four plus two hit points." },
  ...CONDITION_TOPICS,
];

/** A short answer to a rules question, read from the SRD-based summaries, or null when no topic matches. */
export function rulesAnswer(question: string): { topic: string; answer: string } | null {
  const q = question.toLowerCase();
  // A named condition is the most specific thing someone can ask about.
  for (const t of CONDITION_TOPICS) if (new RegExp(`\\b${t.key}\\b`).test(q)) return { topic: t.key, answer: t.answer };
  for (const t of RULE_TOPICS) if (t.match.test(q)) return { topic: t.key, answer: t.answer };
  return null;
}

export const RULE_TOPIC_KEYS: string[] = RULE_TOPICS.map((t) => t.key);
