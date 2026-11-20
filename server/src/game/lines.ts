import type { D20Roll } from "./rules.js";
import type { Npc, Player } from "./types.js";

/**
 * How the Game Master says results. Every spoken number is written here from resolved facts: the dice first, in plain
 * words ("17 plus 5 is 22 against armor class 15"), short sentences, no lists. Digits are turned into words by the
 * voice layer; these lines only have to be true.
 */

export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length;

/** "17 plus 5 is 22", "9 minus 1 is 8", or just "14" when nothing is added. */
export function sumWords(die: number, total: number): string {
  const modifier = total - die;
  if (modifier === 0) return `${die}`;
  return `${die} ${modifier > 0 ? "plus" : "minus"} ${Math.abs(modifier)} is ${total}`;
}

/** The d20 as said: both dice when rolled with advantage or disadvantage, then the sum. */
export function d20Words(roll: D20Roll, total: number): string {
  if (roll.adv && roll.rolls.length === 2) {
    return `${roll.rolls[0]} and ${roll.rolls[1]} with ${roll.adv === "adv" ? "advantage" : "disadvantage"}, so ${sumWords(roll.kept, total)}`;
  }
  return sumWords(roll.kept, total);
}

/**
 * A creature as spoken: "the goblin" for one of a kind, "goblin 2" for a numbered one, the name itself for a
 * character with a proper name ("Mother Ilse").
 */
export function npcRef(n: Pick<Npc, "name" | "kind">, capital = false): string {
  const kindName = n.kind && n.name.toLowerCase().startsWith(n.kind.toLowerCase());
  let ref: string;
  if (kindName) ref = /\s\d+$/.test(n.name) ? n.name.toLowerCase() : `the ${n.name.toLowerCase()}`;
  else ref = /^(?:a|an|the)\s/i.test(n.name) ? n.name.charAt(0).toLowerCase() + n.name.slice(1) : n.name;
  return capital ? cap(ref) : ref;
}

export function hpLeft(p: Pick<Player, "name" | "hp">): string {
  return `${p.name} has ${p.hp} hit point${p.hp === 1 ? "" : "s"} left.`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Join sentences into one spoken line: single spaces, each ending in punctuation. */
export function joinLines(lines: (string | null | undefined | false)[]): string {
  return lines
    .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    .map((l) => {
      const t = l.replace(/\s+/g, " ").trim();
      return /[.!?…]["'”’)]?$/.test(t) ? t : `${t}.`;
    })
    .join(" ");
}

/**
 * The most words one spoken result should run to. The voice says a tool's line as written up to about ninety words
 * and holds the rest for "keep going" — which would hold back the very last sentence, the one that says who is up.
 */
export const SPOKEN_LIMIT = 85;

/**
 * Keep a long run of results (a hero's action and then several monsters' turns) sayable in one go. Only when the
 * sentences run past `maxWords`, and only as far as needed: monsters' misses lose their arithmetic ("Goblin 2 misses
 * Bea."), misses at the same hero are said together, monsters' hits lose theirs ("The wolf hits Aldo for 7 piercing
 * damage."), and last a save forced on a hero keeps only its verdict. Numbers are left out, never changed; a hero's
 * own roll is never shortened; the last sentence (who is up) always stays.
 */
export function tighten(lines: (string | null | undefined | false)[], maxWords = SPOKEN_LIMIT): string[] {
  let out = lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0).map((l) => l.replace(/\s+/g, " ").trim());
  const over = () => wordCount(out.join(" ")) > maxWords;
  if (!over()) return out;
  // A hero's attack names the weapon ("…the goblin with the longsword"): those lines are left as they are.
  const monsters = (target: string) => !/ with /.test(target);
  out = out.map((l) => l.replace(/^(.+?) attacks ([^:]+): (?:\d+ against armor class \d+|a natural 1), a miss\.$/, (all, who: string, target: string) => (monsters(target) ? `${who} misses ${target}.` : all)));
  if (!over()) return out;
  const merged: string[] = [];
  for (const l of out) {
    const miss = /^(.+?) misses ([^.]+)\.$/.exec(l);
    const before = merged.length ? /^(.+?) (?:misses|miss) ([^.]+)\.$/.exec(merged[merged.length - 1]!) : null;
    if (miss && before && before[2] === miss[2]) merged[merged.length - 1] = `${before[1]} and ${miss[1]!.replace(/^The /, "the ")} miss ${miss[2]}.`;
    else merged.push(l);
  }
  out = merged;
  if (!over()) return out;
  out = out.map((l) =>
    l.replace(/^(.+?) attacks ([^:]+): \d+ against armor class \d+, a (critical hit|hit) for /, (all, who: string, target: string, kind: string) =>
      monsters(target) ? `${who} ${kind === "hit" ? "hits" : "lands a critical hit on"} ${target} for ` : all,
    ),
  );
  if (!over()) return out;
  // Last, a save the Game Master rolled for a hero against a monster's bite or breath keeps its verdict and what it did.
  return out.map((l) => l.replace(/^(.+?)'s (\w+) save: .+? against DC \d+, a (failure|success)(: .+|\.)$/, (_all, who: string, ability: string, how: string, rest: string) => `${who} ${how === "failure" ? "fails" : "makes"} a ${ability} save${rest}`));
}

/** Whole sentences from the start of `text` that fit in `maxWords` (never a cut-off sentence). */
export function fitSentences(text: string, maxWords: number): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…]["'”’)]?)\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const n = wordCount(s);
    if (used + n > maxWords) break;
    out.push(s);
    used += n;
  }
  return out.join(" ");
}

/** The first sentence of some text. */
export function firstSentenceOf(text: string): string {
  const m = /^(.+?[.!?…])(?:\s|$)/.exec(text.replace(/\s+/g, " ").trim());
  return (m?.[1] ?? text).trim();
}
