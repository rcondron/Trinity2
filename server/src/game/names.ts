import type { Game, Item, Npc, Player } from "./types.js";

/**
 * Who and what the players mean. Several people share one microphone and speech-to-text garbles names ("Thoren",
 * "Meera"), so heroes, players, monsters and items are matched by whole words first and then, for names only,
 * by a near miss: one letter off, or the same consonants in a capitalized word.
 */

export const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
/** "goblin two" → "goblin 2": numbered creatures are said with words. */
const numbered = (text: string): string => text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (w) => NUMBER_WORDS[w.toLowerCase()] ?? w);

export function sameName(a: string, b: string): boolean {
  const x = norm(a).replace(/^the /, "");
  const y = norm(b).replace(/^the /, "");
  return x.length > 0 && x === y;
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Everyday words that must never be taken for a garbled name. */
const COMMON = new Set(
  (
    "the then than that this there their them they these those thing things think thank thanks more most much many make made take took turn turns time times " +
    "what when where which while who whom whose will with would could should about above after again against also another around away back been before being " +
    "below between both came come comes does doing done down each even every first from give goes going gone good great have having here into just keep know " +
    "last left like little long look looks mine must near need never next once only open other over right same some such sure tell told through under until " +
    "upon very want wants well went were your yours myself door doors room rooms sword swords fire water hand hands head attack attacks check checks roll rolls " +
    "move moves moving run runs walk walks talk talks say says said try tries tried cast casts spell spells heal heals hide hides help helps rest rests wait " +
    "waits stop start game hero heroes player players party monster monsters enemy enemies everyone nobody someone anyone mirror mire mare more mayor tour torn " +
    "thorn horn born worn corn north south east west gold silver dark light night day morning evening"
  ).split(/\s+/),
);

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** First letter plus the consonants, doubled letters squeezed: "Mira" and "Meera" both give "mr". */
const skeleton = (w: string) => (w.charAt(0) + w.slice(1).replace(/[aeiouyh]/g, "")).replace(/(.)\1+/g, "$1");

interface Token {
  word: string;
  /** Capitalized in the transcript, and not just because it starts a sentence. */
  proper: boolean;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let sentenceStart = true;
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’]*|[.!?]/gu)) {
    const raw = m[0];
    if (/^[.!?]$/.test(raw)) {
      sentenceStart = true;
      continue;
    }
    const word = norm(raw);
    if (!word) continue;
    for (const w of word.split(" ")) out.push({ word: w, proper: /^\p{Lu}/u.test(raw) && !sentenceStart });
    sentenceStart = false;
  }
  return out;
}

export interface Named<T> {
  item: T;
  /** Names it answers to: full names and single words, most specific first. */
  names: string[];
}

export interface Found<T> {
  item: T;
  /** Position (in words) of the mention. */
  at: number;
  exact: boolean;
}

/** Every candidate mentioned in the text, earliest first (a longer name wins a tie). */
export function findAllNamed<T>(text: string, candidates: Named<T>[], opts: { fuzzy?: boolean } = {}): Found<T>[] {
  const toks = tokenize(text);
  const words = toks.map((t) => t.word);
  const hits: (Found<T> & { len: number })[] = [];
  for (const c of candidates) {
    let best: (Found<T> & { len: number }) | null = null;
    for (const name of c.names) {
      const parts = norm(name).split(" ").filter(Boolean);
      if (!parts.length || (parts.length === 1 && parts[0]!.length < 2)) continue;
      for (let i = 0; i + parts.length <= words.length; i++) {
        if (parts.every((p, k) => words[i + k] === p)) {
          if (!best || i < best.at || (i === best.at && parts.length > best.len)) best = { item: c.item, at: i, exact: true, len: parts.length };
          break;
        }
      }
    }
    if (best) hits.push(best);
  }
  if (!hits.length && opts.fuzzy !== false) {
    for (const c of candidates) {
      let best: (Found<T> & { len: number }) | null = null;
      for (const name of c.names) {
        const n = norm(name);
        if (n.includes(" ") || n.length < 4 || /\d/.test(n)) continue;
        toks.forEach((t, i) => {
          if (t.word.length < 4 || COMMON.has(t.word) || t.word === n) return;
          const limit = Math.min(n.length, t.word.length) >= 7 ? 2 : 1;
          const near = editDistance(t.word, n, limit) <= limit;
          const sounds = t.proper && t.word.charAt(0) === n.charAt(0) && Math.abs(t.word.length - n.length) <= 2 && skeleton(t.word) === skeleton(n);
          if ((near || sounds) && (!best || i < best.at)) best = { item: c.item, at: i, exact: false, len: 1 };
        });
      }
      if (best) hits.push(best);
    }
  }
  return hits.sort((a, b) => a.at - b.at || b.len - a.len).map(({ item, at, exact }) => ({ item, at, exact }));
}

export function findNamed<T>(text: string, candidates: Named<T>[], opts: { fuzzy?: boolean } = {}): Found<T> | null {
  return findAllNamed(text, candidates, opts)[0] ?? null;
}

const firstWord = (s: string) => norm(s).split(" ")[0] ?? "";

const realHeroes = (g: Game) => g.players.filter((p) => !p.pending);

function heroCandidates(g: Game): Named<Player>[] {
  return realHeroes(g).map((p) => ({
    item: p,
    names: [p.name, firstWord(p.name), ...(p.playerName ? [p.playerName, firstWord(p.playerName)] : [])].filter(Boolean),
  }));
}

/** A hero named in the text, by character name or by the name of the person who plays them (earliest mention wins). */
export function findHero(g: Game, text: string): Player | null {
  return findNamed(text, heroCandidates(g))?.item ?? null;
}

/** All the heroes named in the text, in the order they are mentioned. */
export function findHeroes(g: Game, text: string): Found<Player>[] {
  return findAllNamed(text, heroCandidates(g));
}

/** The kind word of a creature's name: "Goblin 2" → "goblin". */
const kindWord = (name: string) => norm(name).replace(/\s+\d+$/, "");

/**
 * A creature or character named in the text: its full name ("goblin 2", "Mother Ilse"), its kind ("the goblin" is
 * the first goblin still in the list given), a word of its name, or its role ("the innkeeper"). Pass the list in the
 * order of preference (living foes first).
 */
export function findNpc(npcs: Npc[], said: string): Npc | null {
  const text = numbered(said);
  const full = findNamed(text, npcs.map((n) => ({ item: n, names: [n.name] })), { fuzzy: false });
  if (full) return full.item;
  // A number that names nobody here ("goblin 3" with two goblins) names nobody: it must not fall back to the kind.
  const wrongNumber = npcs.some((n) => new RegExp(`\\b${kindWord(n.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+\\b`).test(norm(text)));
  if (wrongNumber) return null;
  const loose = findNamed(
    text,
    npcs.map((n) => {
      const words = norm(n.name)
        .split(" ")
        .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !COMMON.has(w) && w !== "the");
      return { item: n, names: [kindWord(n.name), ...words, ...(n.role ? [n.role] : [])].filter(Boolean) };
    }),
  );
  return loose?.item ?? null;
}

/** An item named in the text: its whole name, else its last word ("potion of healing", "my shield", "the rope"). */
export function findItem(items: Item[], text: string): Item | null {
  const full = findNamed(text, items.map((it) => ({ item: it, names: [it.name] })), { fuzzy: false });
  if (full) return full.item;
  const loose = findNamed(
    text,
    items.map((it) => {
      const words = norm(it.name)
        .split(" ")
        .filter((w) => w.length >= 3 && !["the", "and", "with", "for"].includes(w));
      // "potion of healing": the head noun and the last word both identify it.
      return { item: it, names: [...new Set([words[0] ?? "", words[words.length - 1] ?? "", words[0]?.endsWith("s") ? words[0].slice(0, -1) : ""])].filter(Boolean) };
    }),
    { fuzzy: false },
  );
  return loose?.item ?? null;
}

const FIRST_PERSON = /^(?:(?:ok(?:ay)?|so|and|then|now|alright|all right|um+|uh+|well|yeah|yes|hey)[\s,]+)*(?:i|i'm|i’m|im|i'll|i’ll|i'd|i’d|i've|i’ve|my|let me|can i|could i|may i|we|we're|we’re|we'll|we’ll|let's|let’s|can we)\b/i;
const SELF_INTRO = /\b(?:i'm|i’m|i am|this is|as)\s+([\p{L}][\p{L}'’-]+)/giu;
/** Words that may come before the name of whoever is acting ("okay, so Thorin attacks"). */
const LEAD_INS = new Set(["ok", "okay", "so", "and", "then", "now", "well", "alright", "all", "right", "um", "uh", "yeah", "yes", "hey", "next", "meanwhile", "but"]);

/** The sentence is said in the first person ("I open the door", "we head north"). */
export function isFirstPerson(text: string): boolean {
  return FIRST_PERSON.test(text.trim());
}

/**
 * Who the sentence says is acting, when it says: "Thorin attacks…" (the sentence leads with a name), "I'm Thorin, I
 * check the door", "as Mira, I…". In "I heal Thorin" the name is the target, so nobody is named as the actor.
 */
export function namedActor(g: Game, text: string): Player | null {
  const cands = heroCandidates(g);
  for (const m of text.matchAll(SELF_INTRO)) {
    const who = findNamed(m[1] ?? "", cands);
    if (who) return who.item;
  }
  if (isFirstPerson(text)) return null;
  const first = findNamed(text, cands);
  if (!first) return null;
  // Only a name that leads the sentence is its subject: in "heal Thorin" or "attack the goblin next to Mira" the
  // name is who it is done to.
  const before = tokenize(text).slice(0, first.at);
  return before.every((t) => LEAD_INS.has(t.word)) ? first.item : null;
}
