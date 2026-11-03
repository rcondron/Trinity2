/*
 * Which cards the words mean — the one selection every board tool shares: numbers and ranges ("cards 2, 3 and 5",
 * "1 through 4"), everything ("all", "every card"), a kind ("the pictures"), what the cards show ("the tiger and
 * the panda"), a place ("the card on the left", "the one in front"), recency ("the last two", "the newest"), a
 * state ("the minimized ones", "the broken cards"), exclusions ("everything except the timer", "keep card 2 and
 * close the rest", "the others"), and pronouns ("it", "them", "both"), which mean the cards just made or acted on.
 */
import { isMaximized, isMinimized, lastTouched, listCards, type BoardCard, type CardKind } from "./board.js";

export type SelectHow = "numbers" | "all" | "except" | "kind" | "content" | "position" | "recent" | "state" | "pronoun" | "hint" | "implied" | "none";

export interface Selection {
  cards: BoardCard[];
  how: SelectHow;
  /** The words asked for more than one card ("all", "them", a plural kind, a list). */
  plural: boolean;
  /** Cards an "except" / "but" / "keep" took out. */
  except: BoardCard[];
  /** Numbers said that no card has. */
  missing: number[];
}

export interface SelectOptions {
  /** Jev's pick for the tool's card argument — used when the words name no card themselves. */
  hint?: unknown;
  /** With no card named: "implied" takes the card just made or acted on (else the one in front); "none" takes nothing. */
  fallback?: "implied" | "none";
  /** Only these cards can be meant (notes for edit_note); the words still choose among them. */
  among?: (c: BoardCard) => boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** Lowercase, fillers and sentence punctuation out (commas kept: they separate a list), number words as digits. */
export function normalizeWords(utterance: string): string {
  let t = ` ${utterance.toLowerCase().replace(/[‘’]/g, "'")} `;
  t = t.replace(/\b(?:all right|alright)\b[,.!]?/g, " "); // a filler, not "all"
  t = t.replace(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, (w) => String(NUMBER_WORDS[w]));
  t = t.replace(/\b(cards?|numbers?|notes?)\s+one\b/g, "$1 1").replace(/\b(?:the\s+)?first one\b/g, "the first card");
  t = t.replace(/\ba couple(?: of)?\b/g, "2").replace(/\bto[\s-]do\b/g, "todo");
  t = t.replace(/\s*,\s*/g, " , ").replace(/[.!?;:]+(?=\s|$)/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

// ─── Numbers ──────────────────────────────────────────────────────────────────

const RANGE = String.raw`\s*(?:through|thru|to|-|–)\s*`;
const ITEM = String.raw`\d{1,3}(?:${RANGE}(?:cards?\s+)?\d{1,3})?`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+(?:and|&|or|plus)\s+)`;
const LIST = String.raw`${ITEM}(?:${SEP}(?:cards?\s+|numbers?\s+|#\s*)?${ITEM})*`;
const BY_WORD = new RegExp(String.raw`(?:\b(cards?|notes?|numbers?|nos?)|#)\s*(?:number\s*)?(${LIST})`, "g");
/** "close 2 and 3", "minimize 1 through 4": a bare list right after a verb that takes cards. */
const AFTER_VERB = new RegExp(
  String.raw`\b(?:close|remove|delete|dismiss|hide|trash|drop|minimi[sz]e|maximi[sz]e|restore|duplicate|clone|swap)\s+(?:the\s+)?(${LIST})\b`,
  "g",
);
const UNIT = /^\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|percent|%|times|x\b|o'?clock|am\b|pm\b|px\b)/;

function numbersIn(list: string, allowTo: boolean): number[] {
  const out: number[] = [];
  for (const raw of list.split(/\s*,\s*(?:and\s+)?|\s+(?:and|&|or|plus)\s+/)) {
    const m = /^(?:cards?\s+|numbers?\s+|#\s*)?(\d{1,3})(?:\s*(through|thru|to|-|–)\s*(?:cards?\s+)?(\d{1,3}))?$/.exec(raw.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[3] ? Number(m[3]) : null;
    if (b !== null && b > a && b - a <= 40 && (allowTo || m[2] !== "to")) for (let k = a; k <= b; k++) out.push(k);
    else {
      out.push(a);
      if (b !== null && m[2] !== "to") out.push(b);
    }
  }
  return out;
}

/** Card numbers the words name ("card 2", "cards 2, 3 and 5", "cards 1 through 4", "close 2 and 3"). */
export function cardNumbers(t: string): number[] {
  const found: number[] = [];
  for (const re of [BY_WORD, AFTER_VERB]) {
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const list = re === BY_WORD ? m[2]! : m[1]!;
      const after = t.slice((m.index ?? 0) + m[0].length);
      const plural = re === AFTER_VERB || /s$/.test(m[1] ?? "");
      let ns = numbersIn(list, plural);
      if (UNIT.test(after) && ns.length) ns = ns.slice(0, -1); // "card 3 for 5 minutes": the 5 is a duration
      for (const n of ns) if (!found.includes(n)) found.push(n);
    }
  }
  return found;
}

// ─── Kinds, states, places, recency ──────────────────────────────────────────

const KINDS: { kind: CardKind; one: RegExp; many: RegExp }[] = [
  {
    kind: "image",
    one: /\b(?:picture|image|photo|photograph|drawing|painting|illustration|artwork|pic)\b/,
    many: /\b(?:pictures|images|photos|photographs|drawings|paintings|illustrations|artworks|pics)\b/,
  },
  { kind: "video", one: /\b(?:video|clip|movie|animation)\b/, many: /\b(?:videos|clips|movies|animations)\b/ },
  { kind: "audio", one: /\b(?:audio|recording|sound clip|song|voice note|track)\b/, many: /\b(?:audios|recordings|sound clips|songs|voice notes|tracks)\b/ },
  { kind: "text", one: /\b(?:note|sticky|sticky note|text card|memo)\b/, many: /\b(?:notes|stickies|sticky notes|text cards|memos)\b/ },
  { kind: "widget", one: /\b(?:widget|app)\b/, many: /\b(?:widgets|apps)\b/ },
];

function kindIn(t: string): { kind: CardKind; plural: boolean } | null {
  for (const k of KINDS) if (k.many.test(t)) return { kind: k.kind, plural: true };
  for (const k of KINDS) if (k.one.test(t)) return { kind: k.kind, plural: false };
  return null;
}

const area = (c: BoardCard) => c.w * (c.h ?? 40);

function stateIn(t: string): ((c: BoardCard) => boolean) | null {
  if (/\b(?:minimi[sz]ed|collapsed|tucked away|docked)\b/.test(t)) return isMinimized;
  if (/\b(?:maximi[sz]ed|full ?screen(?:ed)?)\s+(?:cards?|ones?|pictures?|videos?|notes?|widgets?)\b|\bthe (?:maximi[sz]ed|full ?screen) one\b/.test(t)) return isMaximized;
  if (/\b(?:broken|failed|errored|error|bad)\s+(?:cards?|ones?|pictures?|videos?|widgets?)\b/.test(t)) return (c) => c.status === "error";
  if (/\b(?:loading|pending|unfinished|stuck)\s+(?:cards?|ones?|pictures?|videos?|widgets?)\b/.test(t)) return (c) => c.status === "pending";
  return null;
}

type Place = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "front" | "back" | "biggest" | "smallest";

const NOUN = String.raw`(?:card|one|picture|image|photo|note|video|widget|timer|clip)`;
const PLACE_WORD = String.raw`(top[\s-]?left|top[\s-]?right|bottom[\s-]?left|bottom[\s-]?right|upper[\s-]left|upper[\s-]right|lower[\s-]left|lower[\s-]right|top|bottom|left|right|middle|center|centre)`;

function placeIn(t: string): Place | null {
  if (/\b(?:on top|in front|at the front|frontmost)\b(?!\s+of)/.test(t)) return "front";
  if (/\b(?:at the back|in the back|behind (?:everything|the others|all))\b/.test(t)) return "back";
  if (new RegExp(String.raw`\b(?:biggest|largest)\s+${NOUN}|\bthe big one\b`).test(t)) return "biggest";
  if (new RegExp(String.raw`\b(?:smallest|tiniest)\s+${NOUN}|\bthe (?:small|little) one\b`).test(t)) return "smallest";
  // "the card on the left", "the one in the top right" — never "to the left" (that's where to put it).
  let m = new RegExp(String.raw`\b${NOUN}s?\s+(?:on|at|in|over on|up in|down in)\s+the\s+${PLACE_WORD}\b`).exec(t);
  // "the left card", "the top-right one", "the leftmost picture"
  if (!m) m = new RegExp(String.raw`\bthe\s+${PLACE_WORD}(?:most)?\s+${NOUN}\b`).exec(t);
  if (!m) m = /\bthe\s+(leftmost|rightmost|topmost|bottommost)\b/.exec(t);
  if (!m) return null;
  const w = m[1]!.replace(/\s+/g, "-").replace(/^upper-/, "top-").replace(/^lower-/, "bottom-").replace(/most$/, "");
  return (w === "middle" || w === "centre" ? "center" : w) as Place;
}

function byPlace(cards: BoardCard[], place: Place): BoardCard | null {
  if (!cards.length) return null;
  const cx = (c: BoardCard) => c.x + c.w / 2;
  const cy = (c: BoardCard) => c.y + (c.h ?? 40) / 2;
  const key: Record<Place, (c: BoardCard) => number> = {
    left: (c) => cx(c),
    right: (c) => -cx(c),
    top: (c) => cy(c),
    bottom: (c) => -cy(c),
    "top-left": (c) => cx(c) + cy(c),
    "top-right": (c) => cy(c) - cx(c),
    "bottom-left": (c) => cx(c) - cy(c),
    "bottom-right": (c) => -(cx(c) + cy(c)),
    center: (c) => Math.hypot(cx(c) - 50, cy(c) - 50),
    front: (c) => -c.z,
    back: (c) => c.z,
    biggest: (c) => -area(c),
    smallest: (c) => area(c),
  };
  return cards.slice().sort((a, b) => key[place](a) - key[place](b) || b.n - a.n)[0] ?? null;
}

function recencyIn(t: string): { newest: boolean; count: number } | null {
  const kindNoun = String.raw`(?:cards?|ones?|pictures?|images?|photos?|notes?|videos?|clips?|widgets?|apps?|recordings?)`;
  const m = new RegExp(String.raw`\bthe\s+(last|latest|newest|most recent|first|oldest|earliest)(?:\s+(\d{1,2}))?\s+${kindNoun}\b`).exec(t);
  if (m) return { newest: !/^(?:first|oldest|earliest)$/.test(m[1]!), count: Math.max(1, Number(m[2] ?? 1)) };
  const bare = /\bthe\s+(newest|latest|most recent|oldest)\b(?!\s+\w+\s+(?:of|on)\b)/.exec(t);
  if (bare) return { newest: bare[1] !== "oldest", count: 1 };
  return null;
}

// ─── Content ─────────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    "the a an my your our this that these those it its it's them they both all every everything each card cards one ones number numbers " +
    "on in at to of for from with and or but except other others rest else please can could would will you me us i we let's lets just now then " +
    "also too again some any very really little bit lot more less much way here there what whats how why when where which who is are was be does do " +
    "did has have had say says said show shows tell tells left right top bottom middle center centre side corner front back behind above below under " +
    "beside over off up down out into onto about like make made close remove delete dismiss hide trash drop get rid take away throw minimize minimise " +
    "maximize maximise restore bigger smaller larger tiny huge wider narrower taller shorter shrink enlarge grow resize scale full screen fullscreen fill " +
    "move put place shift slide drag bring send swap switch trade nudge scoot push bump layer stack arrange organize organise tidy sort line shuffle " +
    "scatter group order start stop pause play resume restart reset replay mute unmute turn louder quieter volume skip ahead forward rewind loop repeat " +
    "faster slower speed normal press click tap hit set type enter read edit change rename call name title copy duplicate clone add cross check tick " +
    "first last newest latest oldest previous next seconds minutes second minute whole entire same new old big small okay ok so well um uh hey trinity " +
    "picture pictures image images photo photos video videos clip clips audio note notes widget widgets app apps sticky board workspace screen window"
  ).split(/\s+/),
);

const stem = (w: string) => w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");

function contentWords(t: string): string[] {
  const out: string[] = [];
  for (const w of t.split(/[^a-z0-9']+/)) {
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

/** Words too generic to name a card on their own ("the list" could be any note): they only break ties. */
const WEAK = new Set(["list", "lists", "item", "items", "thing", "things", "stuff", "page", "sheet", "one", "ones"]);

function wordScore(c: BoardCard, w: string, weakCounts = false): number {
  const s = stem(w);
  const tags = (c.tags ?? []).map(stem);
  const wordsOf = (x: string) =>
    x
      .toLowerCase()
      .replace(/\bto[\s-]do\b/g, "todo")
      .split(/[^a-z0-9]+/)
      .map(stem);
  const base = tags.includes(s) ? 4 : wordsOf(c.title).includes(s) ? 3 : wordsOf(c.text).includes(s) ? 2 : 0;
  return WEAK.has(w) && !weakCounts ? Math.min(base, 1) : base;
}

/**
 * The cards the words name by what they show. Each "and" / comma part of the words is one noun phrase naming one card
 * — the best total over its words, ties to the newest — with a kind word in that part ("the panda picture") narrowing
 * it; `every` keeps every card a part names ("all the tiger cards").
 */
function byContent(t: string, pool: BoardCard[], every: boolean): BoardCard[] {
  const parts = t.split(/\s*(?:,|\band\b|&|\bor\b|\bplus\b)\s*/).filter(Boolean);
  const picked: BoardCard[] = [];
  for (const part of parts) {
    const words = contentWords(part);
    if (!words.length) continue;
    const kind = kindIn(part);
    const kinded = kind ? pool.filter((c) => c.kind === kind.kind) : [];
    const from = kinded.length ? kinded : pool;
    const onlyWeak = words.every((w) => WEAK.has(w));
    const min = onlyWeak ? 1 : 2;
    const totals = from.map((c) => ({ c, s: words.reduce((a, w) => a + wordScore(c, w, onlyWeak), 0) })).filter((x) => x.s >= min);
    if (!totals.length) continue;
    if (every) {
      for (const x of totals) if (!picked.includes(x.c)) picked.push(x.c);
      continue;
    }
    totals.sort((a, b) => b.s - a.s || b.c.n - a.c.n);
    if (!picked.includes(totals[0]!.c)) picked.push(totals[0]!.c);
  }
  return picked;
}

// ─── Exclusions, pronouns ─────────────────────────────────────────────────────

const ALL = /\b(?:all|every|everything|everyone|each)\b(?!\s+(?:the\s+)?way\b)(?!\s+(?:at\s+)?once\b)/;
const EXCEPT_WORD = String.raw`(?:except(?:\s+for)?|but(?:\s+not)?|other than|besides|apart from|aside from|excluding|save for|not including|leaving|leave)`;
const PLURAL_PRONOUN = /\b(?:them|these|those|both|the two|these cards|those cards|all of them|them all)\b/;
const SINGULAR_PRONOUN = /\b(?:it|this|that|this one|that one|this card|that card|the card)\b/;

function splitExcept(t: string): { base: string; except: string | null } | null {
  let m = new RegExp(String.raw`^(.*\b(?:all|every(?:thing|one)?|each|the (?:cards|rest|others|other cards)|cards|everything else)\b.*?)\s*,?\s*\b${EXCEPT_WORD}\b(.+)$`).exec(t);
  if (m) return { base: m[1]!, except: m[2]! };
  m = /\bkeep(?:ing)?\s+(.+?)\s*,?\s*(?:and|but|then)?\s*(?:close|remove|delete|minimi[sz]e|hide|get rid of|clear|drop|dismiss|trash|pause|stop|mute)\b.*\b(?:the rest|everything else|the others|all the others|the other cards|all else|everything)\b/.exec(t);
  if (m) return { base: "", except: m[1]! };
  if (/\b(?:the (?:other|others|rest)(?: of the cards)?|everything else|all the others|all the other cards|the other cards|all else)\b/.test(t)) return { base: "", except: null };
  return null;
}

/** The card meant by "it": the last one made or acted on, else the one in front. */
export function impliedCard(pool: BoardCard[] = listCards()): BoardCard | null {
  if (!pool.length) return null;
  const recent = lastTouched();
  for (let i = recent.length - 1; i >= 0; i--) {
    const hit = pool.find((c) => c.n === recent[i]);
    if (hit) return hit;
  }
  return pool.reduce((top, c) => (c.z > top.z ? c : top), pool[0]!);
}

// ─── Selection ────────────────────────────────────────────────────────────────

const none = (missing: number[] = []): Selection => ({ cards: [], how: "none", plural: false, except: [], missing });
const sel = (cards: BoardCard[], how: SelectHow, plural: boolean, except: BoardCard[] = [], missing: number[] = []): Selection => ({
  cards: cards.slice().sort((a, b) => a.n - b.n),
  how,
  plural,
  except,
  missing,
});

/** What the words alone name, among `pool` — null when they name nothing. */
function pick(t: string, pool: BoardCard[]): Selection | null {
  const nums = cardNumbers(t);
  if (nums.length) {
    const cards = pool.filter((c) => nums.includes(c.n));
    return sel(cards, "numbers", nums.length > 1, [], nums.filter((n) => !pool.some((c) => c.n === n)));
  }
  const kind = kindIn(t);
  const state = stateIn(t);
  let narrowed = pool;
  if (kind) narrowed = narrowed.filter((c) => c.kind === kind.kind);
  if (state) narrowed = narrowed.filter(state);
  const all = ALL.test(t);
  if (all) {
    const matched = byContent(t, narrowed, true);
    return sel(matched.length ? matched : narrowed, "all", true);
  }
  const recent = recencyIn(t);
  if (recent) {
    const ordered = narrowed.slice().sort((a, b) => (recent.newest ? b.n - a.n : a.n - b.n));
    return sel(ordered.slice(0, recent.count), "recent", recent.count > 1);
  }
  const content = byContent(t, state ? pool.filter(state) : pool, false); // a kind word narrows only its own part
  const place = placeIn(t);
  if (place) {
    const hit = byPlace(content.length ? content : narrowed, place);
    return hit ? sel([hit], "position", false) : null;
  }
  if (content.length) return sel(content, "content", content.length > 1 || Boolean(kind?.plural));
  if (state) return sel(narrowed, "state", narrowed.length > 1);
  if (kind) {
    if (kind.plural) return sel(narrowed, "kind", true);
    const one = impliedCard(narrowed);
    return one ? sel([one], "kind", false) : sel([], "kind", false);
  }
  return null;
}

/**
 * The cards the words mean. Explicit words win (numbers, all, a kind, content, a place, recency, a state, an
 * exclusion); then a pronoun; then Jev's pick; then, with fallback "implied", the card just made or acted on.
 */
export function selectCards(utterance: string, opts: SelectOptions = {}): Selection {
  const pool = listCards().filter(opts.among ?? (() => true));
  if (!pool.length) return none();
  const t = normalizeWords(utterance);

  const ex = splitExcept(t);
  if (ex) {
    const base = ex.base ? pick(ex.base, pool) : null;
    const from = base && base.cards.length && base.how !== "numbers" ? base.cards : pool;
    const kept = ex.except ? (pick(ex.except, pool) ?? pronoun(ex.except, pool)) : null;
    const keep = kept?.cards.length ? kept.cards : [impliedCard(pool)].filter((c): c is BoardCard => Boolean(c));
    const ns = new Set(keep.map((c) => c.n));
    return sel(
      from.filter((c) => !ns.has(c.n)),
      "except",
      true,
      keep,
    );
  }

  const named = pick(t, pool);
  if (named && (named.cards.length || named.missing.length)) return named;
  const pr = pronoun(t, pool);
  if (pr) return pr;
  const hinted = Number(String(opts.hint ?? "").trim());
  if (Number.isInteger(hinted) && hinted > 0) {
    const hit = pool.find((c) => c.n === hinted);
    if (hit) return sel([hit], "hint", false);
  }
  if (opts.fallback === "implied") {
    const one = impliedCard(pool);
    if (one) return sel([one], "implied", false);
  }
  return named ?? none();
}

/** "it" → the card just made or acted on; "them" / "both" → the cards just made or acted on (or both cards). */
function pronoun(t: string, pool: BoardCard[]): Selection | null {
  if (PLURAL_PRONOUN.test(t)) {
    const recent = lastTouched()
      .map((n) => pool.find((c) => c.n === n))
      .filter((c): c is BoardCard => Boolean(c));
    if (recent.length >= 2) return sel(recent, "pronoun", true);
    if (/\bboth\b|\bthe two\b/.test(t) && pool.length === 2) return sel(pool, "pronoun", true);
    if (/\b(?:all of them|them all)\b/.test(t)) return sel(pool, "pronoun", true);
  }
  if (SINGULAR_PRONOUN.test(t)) {
    const one = impliedCard(pool);
    if (one) return sel([one], "pronoun", false);
  }
  return null;
}

/** Live card numbers as Jev option ids ("1", "2", …), described by kind, title and tags (optionally only some cards). */
export function cardOptions(only?: (c: BoardCard) => boolean): Record<string, string> | undefined {
  const cards = listCards().filter(only ?? (() => true));
  if (!cards.length) return undefined;
  return Object.fromEntries(
    cards.map((c) => {
      const about = (c.tags ?? []).slice(0, 4).join(", ");
      return [String(c.n), `card ${c.n} — ${c.kind}: ${c.title}${about ? ` (${about})` : ""}`];
    }),
  );
}

// ─── Saying it ───────────────────────────────────────────────────────────────

/** "card 2", "cards 2 and 3", "cards 1, 4 and 6", "7 cards". */
export function cardsLabel(cards: { n: number }[]): string {
  const ns = cards.map((c) => c.n).sort((a, b) => a - b);
  if (!ns.length) return "no cards";
  if (ns.length === 1) return `card ${ns[0]}`;
  if (ns.length <= 6) return `cards ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
  return `${ns.length} cards`;
}

/** "card 4 (Pomodoro timer)". */
export function cardName(c: BoardCard): string {
  const title = c.title.replace(/^(?:Note|Recipe|News|Card):\s*/i, "").trim();
  return title ? `card ${c.n} (${title.length > 40 ? `${title.slice(0, 39).replace(/\s+\S*$/, "")}…` : title})` : `card ${c.n}`;
}

/** "the timer (card 4) or the video (card 5)" — for "which card?" questions. */
export function choiceList(cards: BoardCard[]): string {
  const names = cards.slice(0, 5).map(cardName);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
