import {
  ABILITIES,
  averageDice,
  crProficiency,
  encounterBudget,
  parseDice,
  rateEncounter,
  xpForCr,
  type EncounterDifficulty,
  type EncounterRating,
  type Rng,
} from "./rules.js";
import { isDamageType } from "./srd.js";
import type { AbilityKey, Attack, AttackRider, Breath, HealthBand, Npc, Stats } from "./types.js";

/**
 * The bestiary: compact stat blocks of creatures from the System Reference Document (attribution: srd.ts), the
 * bounds a model-made creature is clamped into for its challenge rating, and the encounter builder that spends an
 * XP budget on creatures that fit the party. No creature here is product identity.
 */

export interface Monster {
  key: string;
  name: string;
  /** "humanoid", "beast", "undead", "dragon", … */
  type: string;
  cr: number;
  xp: number;
  ac: number;
  hp: number;
  speed: number;
  stats: Stats;
  /** Melee attacks first, in the order a multiattack uses them (the last one repeats). */
  attacks: Attack[];
  attacksPerTurn: number;
  breath: Breath | null;
  saves: Partial<Record<AbilityKey, number>>;
  resistances: string[];
  vulnerabilities: string[];
  immunities: string[];
  regen: number;
  /** Where and with whom it turns up: the encounter builder matches these against the scene. */
  tags: string[];
}

/** The part of an Npc that is its stat block. */
export type StatBlock = Pick<
  Npc,
  | "kind" | "creatureType" | "hp" | "maxHp" | "tempHp" | "ac" | "speed" | "stats" | "attacks" | "attacksPerTurn" | "breath"
  | "saves" | "cr" | "xp" | "resistances" | "vulnerabilities" | "immunities" | "regen" | "regenBlocked" | "statted"
>;

const ability = (v: string): AbilityKey | null => ((ABILITIES as readonly string[]).includes(v) ? (v as AbilityKey) : null);

/**
 * One attack from a line: "Bite +5 1d8+3 piercing", with optional extra damage ("+ 2d6 fire"), "ranged 80", and after
 * a bar a save that rides on a hit: "| con 11: 2d8 poison half" (damage) or "| str 11: prone" / "| con 10: paralyzed 10"
 * (a condition, for that many rounds).
 */
export function parseAttack(spec: string): Attack | null {
  const [main = "", riderSpec] = spec.split("|").map((s) => s.trim());
  const m = /^(.+?) \+(\d+) (\d*d\d+(?:[+-]\d+)?|\d+) ([a-z]+)(?: \+ (\d*d\d+(?:[+-]\d+)?) ([a-z]+))?(?: (ranged|reach) (\d+))?$/.exec(main);
  if (!m) return null;
  let rider: AttackRider | null = null;
  if (riderSpec) {
    const r = /^([a-z]{3}) (\d+): (?:(\d*d\d+(?:[+-]\d+)?) ([a-z]+)( half)?|([a-z]+)(?: (\d+))?)$/.exec(riderSpec);
    const key = r ? ability(r[1]!) : null;
    if (r && key) {
      rider = {
        ability: key,
        dc: Number(r[2]),
        condition: r[6] ?? null,
        rounds: r[7] ? Number(r[7]) : null,
        damage: r[3] ?? null,
        damageType: r[4] ?? null,
        half: Boolean(r[5]),
      };
    }
  }
  return {
    name: m[1]!,
    toHit: Number(m[2]),
    damage: m[3]!,
    damageType: m[4]!,
    ranged: m[7] === "ranged",
    range: m[8] ? Number(m[8]) : 5,
    extraDamage: m[5] ?? null,
    extraType: m[6] ?? null,
    rider,
  };
}

interface Extra {
  n?: number;
  saves?: Partial<Record<AbilityKey, number>>;
  resist?: string;
  vuln?: string;
  immune?: string;
  regen?: number;
  /** "Fire Breath dex 13 7d6 fire" */
  breath?: string;
  tags?: string;
}

function mon(
  key: string,
  name: string,
  type: string,
  cr: number,
  ac: number,
  hp: number,
  speed: number,
  s: [number, number, number, number, number, number],
  attacks: string[],
  x: Extra = {},
): Monster {
  let breath: Breath | null = null;
  if (x.breath) {
    const b = /^(.+?) ([a-z]{3}) (\d+) (\S+) ([a-z]+)$/.exec(x.breath);
    const key2 = b ? ability(b[2]!) : null;
    if (b && key2) breath = { name: b[1]!, ability: key2, dc: Number(b[3]), damage: b[4]!, damageType: b[5]!, recharge: 5, ready: true, targets: 2 };
  }
  const words = (v?: string) => (v ? v.split(/[,\s]+/).filter(Boolean) : []);
  return {
    key,
    name,
    type,
    cr,
    xp: xpForCr(cr),
    ac,
    hp,
    speed,
    stats: { str: s[0], dex: s[1], con: s[2], int: s[3], wis: s[4], cha: s[5] },
    attacks: attacks.map(parseAttack).filter((a): a is Attack => a !== null),
    attacksPerTurn: x.n ?? 1,
    breath,
    saves: x.saves ?? {},
    resistances: words(x.resist),
    vulnerabilities: words(x.vuln),
    immunities: words(x.immune),
    regen: x.regen ?? 0,
    tags: [type, ...words(x.tags)],
  };
}

const MONSTERS: Monster[] = [
  // ── Challenge 0 – 1/8 ──
  mon("commoner", "Commoner", "humanoid", 0, 10, 4, 30, [10, 10, 10, 10, 10, 10], ["Club +2 1d4 bludgeoning"], { tags: "town village road" }),
  mon("bandit", "Bandit", "humanoid", 0.125, 12, 11, 30, [11, 12, 12, 10, 10, 10], ["Scimitar +3 1d6+1 slashing", "Light Crossbow +3 1d8+1 piercing ranged 80"], { tags: "road forest town ruins raider outlaw" }),
  mon("cultist", "Cultist", "humanoid", 0.125, 12, 9, 30, [11, 12, 10, 10, 11, 10], ["Scimitar +3 1d6+1 slashing"], { tags: "temple crypt town cult ritual dungeon" }),
  mon("guard", "Guard", "humanoid", 0.125, 16, 11, 30, [13, 12, 12, 10, 11, 10], ["Spear +3 1d6+1 piercing"], { tags: "town castle city gate" }),
  mon("kobold", "Kobold", "humanoid", 0.125, 12, 5, 30, [7, 15, 9, 8, 7, 8], ["Dagger +4 1d4+2 piercing", "Sling +4 1d4+2 bludgeoning ranged 30"], { tags: "cave mine dungeon underground hill" }),
  mon("giant rat", "Giant Rat", "beast", 0.125, 12, 7, 30, [7, 15, 11, 2, 10, 4], ["Bite +4 1d4+2 piercing"], { tags: "sewer cellar dungeon ruins town swamp" }),
  mon("stirge", "Stirge", "beast", 0.125, 14, 2, 40, [4, 16, 11, 2, 8, 6], ["Blood Drain +5 1d4+3 piercing"], { tags: "cave swamp forest ruins" }),
  // ── Challenge 1/4 ──
  mon("goblin", "Goblin", "humanoid", 0.25, 15, 7, 30, [8, 14, 10, 10, 8, 8], ["Scimitar +4 1d6+2 slashing", "Shortbow +4 1d6+2 piercing ranged 80"], { tags: "cave forest hill road ruins raider dungeon" }),
  mon("skeleton", "Skeleton", "undead", 0.25, 13, 13, 30, [10, 14, 15, 6, 8, 5], ["Shortsword +4 1d6+2 piercing", "Shortbow +4 1d6+2 piercing ranged 80"], { vuln: "bludgeoning", immune: "poison", tags: "crypt tomb graveyard ruins dungeon necromancer" }),
  mon("zombie", "Zombie", "undead", 0.25, 8, 22, 20, [13, 6, 16, 3, 6, 5], ["Slam +3 1d6+1 bludgeoning"], { saves: { wis: 0 }, immune: "poison", tags: "crypt tomb graveyard ruins plague necromancer" }),
  mon("wolf", "Wolf", "beast", 0.25, 13, 11, 40, [12, 15, 12, 3, 12, 6], ["Bite +4 2d4+2 piercing | str 11: prone"], { tags: "forest hill mountain road wilderness snow" }),
  mon("acolyte", "Acolyte", "humanoid", 0.25, 10, 9, 30, [10, 10, 10, 10, 14, 11], ["Club +2 1d4 bludgeoning"], { tags: "temple town cult" }),
  mon("giant wolf spider", "Giant Wolf Spider", "beast", 0.25, 13, 11, 40, [12, 16, 13, 3, 12, 4], ["Bite +3 1d6+1 piercing | con 11: 2d6 poison half"], { tags: "forest cave ruins web" }),
  mon("giant centipede", "Giant Centipede", "beast", 0.25, 13, 4, 30, [5, 14, 12, 1, 7, 3], ["Bite +4 1d4+2 piercing | con 11: 3d6 poison"], { tags: "cave dungeon sewer ruins" }),
  mon("giant poisonous snake", "Giant Poisonous Snake", "beast", 0.25, 14, 11, 30, [10, 18, 13, 2, 10, 3], ["Bite +6 1d4+4 piercing | con 11: 3d6 poison half"], { tags: "swamp jungle desert ruins" }),
  mon("panther", "Panther", "beast", 0.25, 12, 13, 50, [14, 15, 10, 3, 14, 7], ["Bite +4 1d6+2 piercing", "Claw +4 1d4+2 slashing"], { tags: "forest jungle hill" }),
  mon("boar", "Boar", "beast", 0.25, 11, 11, 40, [13, 11, 12, 2, 9, 5], ["Tusk +3 1d6+1 slashing"], { tags: "forest hill farm" }),
  mon("swarm of rats", "Swarm of Rats", "beast", 0.25, 10, 24, 30, [9, 11, 9, 2, 10, 3], ["Bites +2 2d6 piercing"], { resist: "bludgeoning piercing slashing", tags: "sewer cellar dungeon town ruins" }),
  // ── Challenge 1/2 ──
  mon("orc", "Orc", "humanoid", 0.5, 13, 15, 30, [16, 12, 16, 7, 11, 10], ["Greataxe +5 1d12+3 slashing", "Javelin +5 1d6+3 piercing ranged 30"], { tags: "hill mountain road cave raider warband" }),
  mon("hobgoblin", "Hobgoblin", "humanoid", 0.5, 18, 11, 30, [13, 12, 12, 10, 10, 9], ["Longsword +3 1d8+1 slashing", "Longbow +3 1d8+1 piercing ranged 150"], { tags: "hill road fort ruins raider warband" }),
  mon("gnoll", "Gnoll", "humanoid", 0.5, 15, 22, 30, [14, 12, 11, 6, 10, 7], ["Spear +4 1d6+2 piercing", "Bite +4 1d4+2 piercing", "Longbow +3 1d8+1 piercing ranged 150"], { tags: "desert hill plains road raider" }),
  mon("thug", "Thug", "humanoid", 0.5, 11, 32, 30, [15, 11, 14, 10, 10, 11], ["Mace +4 1d6+2 bludgeoning", "Heavy Crossbow +2 1d10 piercing ranged 100"], { n: 2, tags: "town city alley docks outlaw" }),
  mon("scout", "Scout", "humanoid", 0.5, 13, 16, 30, [11, 14, 12, 11, 13, 11], ["Shortsword +4 1d6+2 piercing", "Longbow +4 1d8+2 piercing ranged 150"], { n: 2, tags: "forest road hill wilderness" }),
  mon("worg", "Worg", "monstrosity", 0.5, 13, 26, 50, [16, 13, 13, 7, 11, 8], ["Bite +5 2d6+3 piercing | str 13: prone"], { tags: "forest hill road goblin raider" }),
  mon("shadow", "Shadow", "undead", 0.5, 12, 16, 40, [6, 14, 13, 6, 10, 8], ["Strength Drain +4 2d6+2 necrotic"], { vuln: "radiant", resist: "acid cold fire lightning thunder", immune: "necrotic poison", tags: "crypt tomb ruins dungeon dark" }),
  mon("crocodile", "Crocodile", "beast", 0.5, 12, 19, 20, [15, 10, 13, 2, 10, 5], ["Bite +4 1d10+2 piercing"], { tags: "swamp river coast sewer" }),
  mon("lizardfolk", "Lizardfolk", "humanoid", 0.5, 15, 22, 30, [15, 10, 13, 7, 12, 7], ["Bite +4 1d6+2 piercing", "Heavy Club +4 1d6+2 bludgeoning", "Javelin +4 1d6+2 piercing ranged 30"], { n: 2, tags: "swamp river coast jungle" }),
  mon("sahuagin", "Sahuagin", "humanoid", 0.5, 12, 22, 30, [13, 11, 12, 12, 13, 9], ["Bite +3 1d4+1 piercing", "Spear +3 1d6+1 piercing"], { n: 2, tags: "sea coast ship underwater" }),
  // ── Challenge 1 ──
  mon("bugbear", "Bugbear", "humanoid", 1, 16, 27, 30, [15, 14, 13, 8, 11, 9], ["Morningstar +4 2d8+2 piercing", "Javelin +4 1d6+2 piercing ranged 30"], { tags: "cave forest hill ruins goblin raider" }),
  mon("ghoul", "Ghoul", "undead", 1, 12, 22, 30, [13, 15, 10, 7, 10, 6], ["Claws +4 2d4+2 slashing | con 10: paralyzed 10", "Bite +2 2d6+2 piercing"], { immune: "poison", tags: "crypt tomb graveyard ruins dungeon" }),
  mon("giant spider", "Giant Spider", "beast", 1, 14, 26, 30, [14, 16, 12, 2, 11, 4], ["Bite +5 1d8+3 piercing | con 11: 2d8 poison half"], { tags: "forest cave ruins web dungeon" }),
  mon("dire wolf", "Dire Wolf", "beast", 1, 14, 37, 50, [17, 15, 15, 3, 12, 7], ["Bite +5 2d6+3 piercing | str 13: prone"], { tags: "forest hill mountain snow wilderness" }),
  mon("harpy", "Harpy", "monstrosity", 1, 11, 38, 20, [12, 13, 12, 7, 10, 13], ["Claws +3 2d4+1 slashing", "Club +3 1d4+1 bludgeoning"], { n: 2, tags: "mountain coast cliff ruins" }),
  mon("animated armor", "Animated Armor", "construct", 1, 18, 33, 25, [14, 11, 13, 1, 3, 1], ["Slam +4 1d6+2 bludgeoning"], { n: 2, immune: "poison psychic", tags: "castle tower dungeon wizard ruins" }),
  mon("specter", "Specter", "undead", 1, 12, 22, 50, [1, 14, 11, 10, 10, 11], ["Life Drain +4 3d6 necrotic"], { resist: "acid cold fire lightning thunder", immune: "necrotic poison", tags: "crypt tomb ruins haunted dungeon" }),
  mon("brown bear", "Brown Bear", "beast", 1, 11, 34, 40, [19, 10, 16, 2, 13, 7], ["Bite +5 1d8+4 piercing", "Claws +5 2d6+4 slashing"], { n: 2, tags: "forest hill mountain cave" }),
  mon("death dog", "Death Dog", "monstrosity", 1, 12, 39, 40, [15, 14, 14, 3, 13, 6], ["Bite +4 1d6+2 piercing"], { n: 2, tags: "desert plains ruins" }),
  mon("imp", "Imp", "fiend", 1, 13, 10, 40, [6, 17, 13, 11, 12, 14], ["Sting +5 1d4+3 piercing | con 11: 3d6 poison half"], { resist: "cold", immune: "fire poison", tags: "tower cult temple wizard" }),
  // ── Challenge 2 ──
  mon("ogre", "Ogre", "giant", 2, 11, 59, 40, [19, 8, 16, 5, 7, 7], ["Greatclub +6 2d8+4 bludgeoning", "Javelin +6 2d6+4 piercing ranged 30"], { tags: "hill mountain cave road swamp" }),
  mon("mimic", "Mimic", "monstrosity", 2, 12, 58, 15, [17, 12, 15, 5, 13, 8], ["Pseudopod +5 1d8+3 bludgeoning", "Bite +5 1d8+3 piercing + 1d8 acid"], { immune: "acid", tags: "dungeon treasure ruins tower cellar" }),
  mon("gelatinous cube", "Gelatinous Cube", "ooze", 2, 6, 84, 15, [14, 3, 20, 1, 6, 1], ["Pseudopod +4 3d6 acid"], { tags: "dungeon sewer ruins corridor" }),
  mon("ghast", "Ghast", "undead", 2, 13, 36, 30, [16, 17, 10, 11, 10, 8], ["Claws +5 2d6+3 slashing | con 10: paralyzed 10", "Bite +3 2d8+3 piercing"], { resist: "necrotic", immune: "poison", tags: "crypt tomb graveyard ruins dungeon" }),
  mon("gargoyle", "Gargoyle", "elemental", 2, 15, 52, 30, [15, 11, 16, 6, 11, 7], ["Bite +4 1d6+2 piercing", "Claws +4 1d6+2 slashing"], { n: 2, immune: "poison", tags: "castle tower ruins cathedral rooftop" }),
  mon("bandit captain", "Bandit Captain", "humanoid", 2, 15, 65, 30, [15, 16, 14, 14, 11, 14], ["Dagger +5 1d4+3 piercing", "Scimitar +5 1d6+3 slashing"], { n: 3, saves: { str: 4, dex: 5, wis: 2 }, tags: "road forest town ruins raider outlaw" }),
  mon("cult fanatic", "Cult Fanatic", "humanoid", 2, 13, 33, 30, [11, 14, 12, 10, 13, 14], ["Dagger +4 1d4+2 piercing"], { n: 2, tags: "temple crypt cult ritual dungeon" }),
  mon("berserker", "Berserker", "humanoid", 2, 13, 67, 30, [16, 12, 17, 9, 11, 9], ["Greataxe +5 1d12+3 slashing"], { tags: "hill mountain snow raider warband" }),
  mon("grick", "Grick", "monstrosity", 2, 14, 27, 30, [14, 14, 11, 3, 14, 5], ["Tentacles +4 2d6+2 slashing", "Beak +4 1d6+2 piercing"], { n: 2, tags: "cave dungeon underground ruins" }),
  mon("ettercap", "Ettercap", "monstrosity", 2, 13, 44, 30, [14, 15, 13, 7, 12, 8], ["Bite +4 1d8+2 piercing | con 11: poisoned 10", "Claws +4 2d4+2 slashing"], { n: 2, tags: "forest web cave" }),
  mon("ankheg", "Ankheg", "monstrosity", 2, 14, 39, 30, [17, 11, 13, 1, 13, 6], ["Bite +5 2d6+3 slashing + 1d6 acid"], { tags: "farm plains forest road" }),
  mon("white dragon wyrmling", "White Dragon Wyrmling", "dragon", 2, 16, 32, 30, [14, 10, 14, 5, 10, 11], ["Bite +4 1d10+2 piercing + 1d4 cold"], { saves: { dex: 2, con: 4, wis: 2, cha: 2 }, immune: "cold", breath: "Cold Breath con 12 5d8 cold", tags: "snow mountain cave ice" }),
  mon("black dragon wyrmling", "Black Dragon Wyrmling", "dragon", 2, 17, 33, 30, [15, 14, 13, 10, 11, 13], ["Bite +4 1d10+2 piercing + 1d4 acid"], { saves: { dex: 4, con: 3, wis: 2, cha: 3 }, immune: "acid", breath: "Acid Breath dex 11 5d8 acid", tags: "swamp ruins cave" }),
  mon("green dragon wyrmling", "Green Dragon Wyrmling", "dragon", 2, 17, 38, 30, [15, 12, 13, 14, 11, 13], ["Bite +4 1d10+2 piercing + 1d6 poison"], { saves: { dex: 3, con: 3, wis: 2, cha: 3 }, immune: "poison", breath: "Poison Breath con 11 6d6 poison", tags: "forest cave ruins" }),
  // ── Challenge 3 ──
  mon("owlbear", "Owlbear", "monstrosity", 3, 13, 59, 40, [20, 12, 17, 3, 12, 7], ["Beak +7 1d10+5 piercing", "Claws +7 2d8+5 slashing"], { n: 2, tags: "forest cave hill wilderness" }),
  mon("wight", "Wight", "undead", 3, 14, 45, 30, [15, 14, 16, 10, 13, 15], ["Longsword +4 1d8+2 slashing", "Life Drain +4 1d6+2 necrotic", "Longbow +4 1d8+2 piercing ranged 150"], { n: 2, resist: "necrotic", immune: "poison", tags: "crypt tomb barrow ruins dungeon" }),
  mon("minotaur", "Minotaur", "monstrosity", 3, 14, 76, 40, [18, 11, 16, 6, 16, 9], ["Greataxe +6 2d12+4 slashing", "Gore +6 2d8+4 piercing"], { tags: "maze dungeon ruins cave" }),
  mon("hell hound", "Hell Hound", "fiend", 3, 15, 45, 50, [17, 12, 14, 6, 13, 6], ["Bite +5 1d8+3 piercing + 2d6 fire"], { immune: "fire", breath: "Fire Breath dex 12 6d6 fire", tags: "volcano cult temple fire dungeon" }),
  mon("veteran", "Veteran", "humanoid", 3, 17, 58, 30, [16, 13, 14, 10, 11, 10], ["Shortsword +5 1d6+3 piercing", "Longsword +5 1d8+3 slashing", "Heavy Crossbow +3 1d10+1 piercing ranged 100"], { n: 3, tags: "road fort town castle mercenary" }),
  mon("knight", "Knight", "humanoid", 3, 18, 52, 30, [16, 11, 14, 11, 11, 15], ["Greatsword +5 2d6+3 slashing"], { n: 2, saves: { con: 4, wis: 2 }, tags: "castle road fort town" }),
  mon("giant scorpion", "Giant Scorpion", "beast", 3, 15, 52, 40, [15, 13, 15, 1, 9, 3], ["Sting +4 1d10+2 piercing | con 12: 4d10 poison half", "Claw +4 1d8+2 bludgeoning"], { n: 3, tags: "desert cave ruins" }),
  mon("manticore", "Manticore", "monstrosity", 3, 14, 68, 30, [17, 16, 17, 7, 12, 8], ["Bite +5 1d8+3 piercing", "Claw +5 1d6+3 slashing", "Tail Spike +5 1d8+3 piercing ranged 100"], { n: 3, tags: "mountain hill desert ruins" }),
  mon("mummy", "Mummy", "undead", 3, 11, 58, 20, [16, 8, 15, 6, 10, 12], ["Rotting Fist +5 2d6+3 bludgeoning + 3d6 necrotic"], { saves: { wis: 2 }, vuln: "fire", immune: "necrotic poison", tags: "tomb crypt desert pyramid ruins" }),
  mon("blue dragon wyrmling", "Blue Dragon Wyrmling", "dragon", 3, 17, 52, 30, [17, 10, 15, 12, 11, 15], ["Bite +5 1d10+3 piercing + 1d6 lightning"], { saves: { dex: 2, con: 4, wis: 2, cha: 4 }, immune: "lightning", breath: "Lightning Breath dex 12 4d10 lightning", tags: "desert coast cave storm" }),
  // ── Challenge 4 – 6 ──
  mon("ettin", "Ettin", "giant", 4, 12, 85, 40, [21, 8, 17, 6, 10, 8], ["Battleaxe +7 2d8+5 slashing", "Morningstar +7 2d8+5 piercing"], { n: 2, tags: "hill mountain cave ruins" }),
  mon("red dragon wyrmling", "Red Dragon Wyrmling", "dragon", 4, 17, 75, 30, [19, 10, 17, 12, 11, 15], ["Bite +6 1d10+4 piercing + 1d6 fire"], { saves: { dex: 2, con: 5, wis: 2, cha: 4 }, immune: "fire", breath: "Fire Breath dex 13 7d6 fire", tags: "mountain volcano cave hill" }),
  mon("troll", "Troll", "giant", 5, 15, 84, 30, [18, 13, 20, 7, 9, 7], ["Bite +7 1d6+4 piercing", "Claw +7 2d6+4 slashing"], { n: 3, regen: 10, tags: "swamp cave hill mountain forest bridge" }),
  mon("hill giant", "Hill Giant", "giant", 5, 13, 105, 40, [21, 8, 19, 5, 9, 6], ["Greatclub +8 3d8+5 bludgeoning", "Rock +8 3d10+5 bludgeoning ranged 60"], { n: 2, tags: "hill mountain road farm" }),
  mon("wraith", "Wraith", "undead", 5, 13, 67, 60, [6, 16, 16, 12, 14, 15], ["Life Drain +6 4d8+3 necrotic"], { resist: "acid cold fire lightning thunder", immune: "necrotic poison", tags: "crypt tomb barrow haunted ruins" }),
  mon("vampire spawn", "Vampire Spawn", "undead", 5, 15, 82, 30, [16, 16, 16, 11, 10, 12], ["Claws +6 2d4+3 slashing", "Bite +6 1d6+3 piercing + 2d6 necrotic"], { n: 2, saves: { dex: 6, wis: 3 }, resist: "necrotic", regen: 10, tags: "castle crypt town night haunted" }),
  mon("wyvern", "Wyvern", "dragon", 6, 13, 110, 20, [19, 10, 16, 5, 12, 6], ["Bite +7 2d6+4 piercing", "Stinger +7 2d6+4 piercing | con 15: 7d6 poison half"], { n: 2, tags: "mountain cliff hill sky" }),
  mon("chimera", "Chimera", "monstrosity", 6, 14, 114, 30, [19, 11, 19, 3, 14, 10], ["Bite +7 2d6+4 piercing", "Horns +7 1d12+4 bludgeoning", "Claws +7 2d6+4 slashing"], { n: 3, breath: "Fire Breath dex 15 7d8 fire", tags: "mountain hill ruins wilderness" }),
  mon("young white dragon", "Young White Dragon", "dragon", 6, 17, 133, 40, [18, 10, 18, 6, 11, 12], ["Bite +7 2d10+4 piercing + 1d8 cold", "Claw +7 2d6+4 slashing"], { n: 3, saves: { dex: 3, con: 7, wis: 3, cha: 4 }, immune: "cold", breath: "Cold Breath con 15 10d8 cold", tags: "snow mountain cave ice" }),
  // ── Challenge 8 – 10 ──
  mon("frost giant", "Frost Giant", "giant", 8, 15, 138, 40, [23, 9, 21, 9, 10, 12], ["Greataxe +9 3d12+6 slashing", "Rock +9 4d10+6 bludgeoning ranged 60"], { n: 2, saves: { con: 8, wis: 3, cha: 4 }, immune: "cold", tags: "snow mountain ice fort" }),
  mon("fire giant", "Fire Giant", "giant", 9, 18, 162, 30, [25, 9, 23, 10, 14, 13], ["Greatsword +11 6d6+7 slashing", "Rock +11 4d10+7 bludgeoning ranged 60"], { n: 2, saves: { dex: 3, con: 10, cha: 5 }, immune: "fire", tags: "volcano mountain forge fort" }),
  mon("young red dragon", "Young Red Dragon", "dragon", 10, 18, 178, 40, [23, 10, 21, 14, 11, 19], ["Bite +10 2d10+6 piercing + 1d6 fire", "Claw +10 2d6+6 slashing"], { n: 3, saves: { dex: 4, con: 9, wis: 4, cha: 8 }, immune: "fire", breath: "Fire Breath dex 17 16d6 fire", tags: "mountain volcano cave hill" }),
];

export const BESTIARY: Record<string, Monster> = Object.fromEntries(MONSTERS.map((m) => [m.key, m]));

/** Every creature, weakest first. */
export function listMonsters(): Monster[] {
  return [...MONSTERS].sort((a, b) => a.cr - b.cr || a.name.localeCompare(b.name));
}

const singular = (w: string) =>
  w.endsWith("wolves")
    ? `${w.slice(0, -3)}f`
    : w === "zombies"
      ? "zombie"
      : w.endsWith("ies")
        ? `${w.slice(0, -3)}y`
        : /(?:ch|sh|x|ss)es$/.test(w)
          ? w.slice(0, -2)
          : w.endsWith("s") && !w.endsWith("ss")
            ? w.slice(0, -1)
            : w;

const normWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular);

/** The creature named in some words ("three giant rats", "a goblin ambush"): the longest name wins. */
export function findMonster(text: string): Monster | null {
  const words = ` ${normWords(text).join(" ")} `;
  let best: Monster | null = null;
  for (const m of MONSTERS) {
    const name = ` ${normWords(m.name).join(" ")} `;
    if (words.includes(name) && (!best || m.name.length > best.name.length)) best = m;
  }
  return best;
}

/** A creature's stat block as the fields an Npc carries. */
export function statBlockOf(m: Monster): StatBlock {
  return {
    kind: m.key,
    creatureType: m.type,
    hp: m.hp,
    maxHp: m.hp,
    tempHp: 0,
    ac: m.ac,
    speed: m.speed,
    stats: { ...m.stats },
    attacks: m.attacks.map((a) => ({ ...a, rider: a.rider ? { ...a.rider } : null })),
    attacksPerTurn: m.attacksPerTurn,
    breath: m.breath ? { ...m.breath } : null,
    saves: { ...m.saves },
    cr: m.cr,
    xp: m.xp,
    resistances: [...m.resistances],
    vulnerabilities: [...m.vulnerabilities],
    immunities: [...m.immunities],
    regen: m.regen,
    regenBlocked: false,
    statted: true,
  };
}

// ─── Bounds for creatures a model makes up ───────────────────────────────────

const CR_STEPS = [0, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

/** The nearest real challenge rating ("1/4", 0.3, "3"). */
export function snapCr(v: unknown, fallback = 0.25): number {
  let n: number;
  if (typeof v === "string" && /^\s*\d+\s*\/\s*\d+\s*$/.test(v)) {
    const [a, b] = v.split("/").map(Number) as [number, number];
    n = b ? a / b : NaN;
  } else n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  let best = CR_STEPS[0]!;
  for (const step of CR_STEPS) if (Math.abs(step - n) < Math.abs(best - n)) best = step;
  return best;
}

export interface CrBounds {
  ac: [number, number];
  hp: [number, number];
  toHit: [number, number];
  /** Average damage of one attack. */
  damage: [number, number];
  dc: [number, number];
  attacksPerTurn: number;
  ability: number;
}

/**
 * What a creature of a challenge rating may have: an envelope drawn around the SRD creatures of that rating (the
 * toughest hit point pool, the hardest hit), so a generated monster can be odd but never out of its league.
 */
export function crBounds(cr: number): CrBounds {
  const prof = crProficiency(cr);
  const hp: [number, number] = cr >= 1 ? [8 * cr + 4, 30 * cr + 30] : cr >= 0.5 ? [8, 45] : cr >= 0.25 ? [4, 30] : cr >= 0.125 ? [2, 15] : [1, 10];
  const damage = cr >= 1 ? 6 + 5 * cr : cr >= 0.5 ? 11 : cr >= 0.25 ? 8 : cr >= 0.125 ? 6 : 3;
  return {
    ac: [5, Math.min(25, 18 + Math.floor(cr / 4))],
    hp,
    toHit: [0, prof + 5 + Math.floor(cr / 6)],
    damage: [1, damage],
    dc: [8, 12 + prof + Math.floor(cr / 4)],
    attacksPerTurn: cr >= 3 ? 3 : cr >= 0.5 ? 2 : 1,
    ability: cr < 1 ? 18 : Math.min(30, 18 + 2 * Math.ceil(cr / 2)),
  };
}

const clamp = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Scale dice down until their average fits `max` (keeps the die size, sheds dice, then the modifier). */
function fitDamage(dice: string, max: number): string {
  const d = parseDice(dice);
  if (!d || !d.terms.length) return `1d${max >= 5 ? 6 : 4}`;
  const term = { ...d.terms[0]! };
  let modifier = Math.max(0, d.modifier);
  const avg = () => (term.count * (term.sides + 1)) / 2 + modifier;
  while (avg() > max && term.count > 1) term.count--;
  while (avg() > max && modifier > 0) modifier--;
  while (avg() > max && term.sides > 4) term.sides -= 2;
  return `${term.count}d${term.sides}${modifier ? `+${modifier}` : ""}`;
}

/** A plain bruiser of a given challenge rating: what an unknown creature fights as when nothing better is known. */
export function genericStatBlock(cr: number): StatBlock {
  const c = snapCr(cr);
  const b = crBounds(c);
  const prof = crProficiency(c);
  const str = Math.min(b.ability, 12 + Math.round(c * 2));
  const mod = Math.floor((str - 10) / 2);
  const hp = Math.round((b.hp[0] + b.hp[1]) / 2.4);
  const dice = fitDamage(c >= 3 ? `2d8+${mod}` : c >= 1 ? `1d10+${mod}` : c >= 0.25 ? `1d6+${mod}` : "1d4", b.damage[1] * 0.75);
  return {
    kind: "",
    creatureType: "creature",
    hp,
    maxHp: hp,
    tempHp: 0,
    ac: Math.min(b.ac[1], 11 + Math.min(5, Math.ceil(c / 2)) + (c >= 0.25 ? 1 : 0)),
    speed: 30,
    stats: { str, dex: 12, con: Math.min(b.ability, 12 + Math.round(c)), int: 8, wis: 10, cha: 8 },
    attacks: [{ name: "Strike", toHit: Math.min(b.toHit[1], prof + mod), damage: dice, damageType: "bludgeoning", ranged: false, range: 5, extraDamage: null, extraType: null, rider: null }],
    attacksPerTurn: c >= 3 ? 2 : 1,
    breath: null,
    saves: {},
    cr: c,
    xp: xpForCr(c),
    resistances: [],
    vulnerabilities: [],
    immunities: [],
    regen: 0,
    regenBlocked: false,
    statted: true,
  };
}

/**
 * Turn a model's creature into a stat block that fits its challenge rating: every number is clamped into crBounds,
 * attacks that don't parse are dropped, XP is set from the rating, and anything missing comes from the generic block.
 */
export function validateStatBlock(raw: unknown, opts: { cr?: number; maxCr?: number } = {}): StatBlock {
  const r = isObj(raw) ? raw : {};
  let cr = snapCr(r.cr ?? r.challenge ?? r.challengeRating, opts.cr ?? 0.25);
  if (opts.maxCr !== undefined) cr = Math.min(cr, snapCr(opts.maxCr));
  const b = crBounds(cr);
  const base = genericStatBlock(cr);
  const st = isObj(r.stats) ? r.stats : {};
  const stats = Object.fromEntries(ABILITIES.map((k) => [k, clamp(st[k], 1, b.ability, base.stats[k])])) as unknown as Stats;
  const attacks: Attack[] = [];
  for (const a of Array.isArray(r.attacks) ? r.attacks.slice(0, 4) : []) {
    if (!isObj(a)) continue;
    const name = typeof a.name === "string" ? a.name.replace(/\s+/g, " ").trim().slice(0, 30) : "";
    const dice = typeof a.damage === "string" && parseDice(a.damage) ? a.damage.replace(/\s+/g, "") : "";
    if (!name || !dice) continue;
    const type = typeof a.damageType === "string" && isDamageType(a.damageType.toLowerCase()) ? a.damageType.toLowerCase() : "bludgeoning";
    attacks.push({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      toHit: clamp(a.toHit, b.toHit[0], b.toHit[1], base.attacks[0]!.toHit),
      damage: averageDice(dice) > b.damage[1] ? fitDamage(dice, b.damage[1]) : dice,
      damageType: type,
      ranged: a.ranged === true,
      range: clamp(a.range, 5, 600, a.ranged === true ? 60 : 5),
      extraDamage: null,
      extraType: null,
      rider: null,
    });
  }
  const types = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x).toLowerCase().trim())
      .filter(isDamageType)
      .slice(0, 4);
  const hp = clamp(r.hp ?? r.maxHp, b.hp[0], b.hp[1], base.hp);
  return {
    kind: "",
    creatureType: typeof r.type === "string" && r.type.trim() ? r.type.toLowerCase().trim().slice(0, 20) : "creature",
    hp,
    maxHp: hp,
    tempHp: 0,
    ac: clamp(r.ac, b.ac[0], b.ac[1], base.ac),
    speed: Math.round(clamp(r.speed, 0, 120, 30) / 5) * 5,
    stats,
    attacks: attacks.length ? attacks : base.attacks,
    attacksPerTurn: clamp(r.attacksPerTurn ?? r.multiattack, 1, b.attacksPerTurn, 1),
    breath: null,
    saves: {},
    cr,
    xp: xpForCr(cr),
    resistances: types(r.resistances),
    vulnerabilities: types(r.vulnerabilities),
    immunities: types(r.immunities),
    regen: 0,
    regenBlocked: false,
    statted: true,
  };
}

// ─── Health bands ────────────────────────────────────────────────────────────

/** How hurt a creature looks: bloodied at half its hit points or fewer, near death at a quarter. */
export function healthBand(hp: number, maxHp: number): HealthBand {
  if (hp <= 0) return "down";
  const share = maxHp > 0 ? hp / maxHp : 1;
  return share <= 0.25 ? "near death" : share <= 0.5 ? "bloodied" : "healthy";
}

// ─── Encounter builder ───────────────────────────────────────────────────────

export interface EncounterPick {
  monster: Monster;
  count: number;
}

export interface EncounterPlan {
  picks: EncounterPick[];
  totalXp: number;
  budget: number;
  rating: EncounterRating;
  /** Why these creatures: "moderate budget 225 XP for 3 heroes of level 1: 4 goblins (200 XP)". */
  why: string;
}

export interface EncounterOptions {
  /** Each hero's level. */
  levels: number[];
  difficulty: EncounterDifficulty;
  rng: Rng;
  /** Words about where the party is and what it faces (scene, setting): matched against creature tags and names. */
  theme?: string;
  /** Bestiary keys this adventure favors. */
  favor?: string[];
  maxFoes?: number;
}

/**
 * Spend the party's XP budget for the difficulty on creatures that fit the scene. The rules, in order: nothing with a
 * challenge rating above the party's average level (1 at least); the creature that matches the theme best leads
 * (ties: the die picks); as many of it as the budget buys, up to the cap; if only one fits, weaker creatures of the
 * same kind of place fill what is left. The total never exceeds the budget.
 */
export function buildEncounter(o: EncounterOptions): EncounterPlan {
  const levels = o.levels.length ? o.levels : [1];
  const budget = encounterBudget(levels, o.difficulty);
  const maxFoes = Math.max(1, o.maxFoes ?? Math.min(6, levels.length + 2));
  const avg = Math.max(1, Math.round(levels.reduce((a, b) => a + b, 0) / levels.length));
  const themeWords = new Set(normWords(o.theme ?? ""));
  const theme = ` ${[...themeWords].join(" ")} `;
  const favor = new Set(o.favor ?? []);
  const score = (m: Monster) =>
    (theme.includes(` ${normWords(m.name).join(" ")} `) ? 10 : 0) + (favor.has(m.key) ? 5 : 0) + m.tags.filter((t) => themeWords.has(t)).length * 3;

  const affordable = MONSTERS.filter((m) => m.xp <= budget && m.cr <= avg && m.key !== "commoner");
  if (!affordable.length) {
    const weakest = MONSTERS.find((m) => m.key === "giant rat")!;
    return plan([{ monster: weakest, count: 1 }], budget, levels, o.difficulty);
  }
  // Prefer creatures that can use most of the budget without crowding the table.
  const filling = affordable.filter((m) => m.xp * maxFoes >= budget * 0.6);
  const pool = filling.length ? filling : affordable;
  const top = Math.max(...pool.map(score));
  const leaders = pool.filter((m) => score(m) === top);
  const lead = leaders[o.rng(leaders.length) - 1]!;
  const count = Math.min(maxFoes, Math.max(1, Math.floor(budget / lead.xp)));
  const picks: EncounterPick[] = [{ monster: lead, count }];
  let left = budget - lead.xp * count;
  if (count < maxFoes && left > 0) {
    const minions = affordable
      .filter((m) => m.key !== lead.key && m.xp <= left && m.cr < lead.cr && m.tags.some((t) => lead.tags.includes(t)))
      .sort((a, b) => score(b) - score(a) || b.xp - a.xp || a.name.localeCompare(b.name));
    const minion = minions[0];
    if (minion) {
      const n = Math.min(maxFoes - count, Math.floor(left / minion.xp));
      if (n > 0) {
        picks.push({ monster: minion, count: n });
        left -= minion.xp * n;
      }
    }
  }
  return plan(picks, budget, levels, o.difficulty);
}

function plan(picks: EncounterPick[], budget: number, levels: number[], difficulty: EncounterDifficulty): EncounterPlan {
  const xps = picks.flatMap((p) => Array.from({ length: p.count }, () => p.monster.xp));
  const rated = rateEncounter(levels, xps);
  const what = picks.map((p) => `${p.count} ${p.monster.name.toLowerCase()}${p.count === 1 ? "" : "s"}`).join(" and ");
  const avg = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
  return {
    picks,
    totalXp: rated.total,
    budget,
    rating: rated.rating,
    why: `${difficulty} budget ${budget} XP for ${levels.length} hero${levels.length === 1 ? "" : "es"} of level ${avg}: ${what} (${rated.total} XP)`,
  };
}

/** Coins and the odd potion on defeated foes: the house's own treasure rule, scaled to what the fight was worth. */
export function treasureFor(rng: Rng, xpTotal: number): { gold: number; potion: boolean } {
  if (xpTotal <= 0) return { gold: 0, potion: false };
  const scale = Math.max(1, Math.round(xpTotal / 100));
  const gold = (rng(6) + rng(6)) * scale;
  return { gold, potion: rng(20) >= 17 };
}
