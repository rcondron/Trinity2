import { READY_MADE } from "./srd.js";
import { MAX_PLAYERS, NEW_GAME_TITLE } from "./store.js";
import type { AdventureLength, Game, Player, SetupStep, SetupView, TableDifficulty } from "./types.js";

/**
 * Session zero: the Game Master walks the table through setup one question at a time: what kind of adventure, how
 * many players, each player's name and their hero (a ready-made one or one built from a description), the tone and
 * anything to leave out, how hard the fights should be, and how heroes level up. `setupQuestion` says which question
 * is on the table; `askNext` words it, in full the first time, briefly the second, and not at all after that, so no
 * reply ever ends with the same sentence as the one before. The board shows the full question throughout.
 */

/** The adventure frame exists once the title was generated or a premise is set. */
export function isFramed(game: Game): boolean {
  return game.title.trim() !== NEW_GAME_TITLE || game.setting.trim() !== "";
}

export function realPlayers(game: Game): Player[] {
  return game.players.filter((p) => !p.pending);
}

export type SetupQuestion = "adventure" | "players" | "seat-name" | "seat-hero" | "who-plays" | "more" | "tone" | "difficulty" | "leveling" | "begin";

const ORDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

const answered = (g: Game, key: string) => g.setupState.answered.includes(key);

/** A hero who joined without anyone saying who plays them (asked about once, right after they join). */
function unclaimedHero(g: Game): Player | null {
  const last = realPlayers(g).at(-1);
  return last && !last.playerName && !answered(g, `who-${last.id}`.slice(0, 20).toLowerCase()) ? last : null;
}

/** Which setup question is on the table right now, or null once the game is under way. */
export function setupQuestion(g: Game): SetupQuestion | null {
  if (g.phase !== "setup") return null;
  if (!isFramed(g)) return "adventure";
  const party = realPlayers(g).length;
  const expected = g.settings.expectedPlayers;
  if (expected === null && party === 0 && !answered(g, "players")) return "players";
  if (party < MAX_PLAYERS && (expected !== null ? party < expected : party === 0 || !answered(g, "party"))) {
    if (g.setupState.seatName) return "seat-hero";
    if (unclaimedHero(g) && (expected ?? 2) > 1) return "who-plays";
    return expected === null && party > 0 ? "more" : "seat-name";
  }
  if (unclaimedHero(g) && (expected ?? 2) > 1) return "who-plays";
  if (!answered(g, "tone")) return "tone";
  if (!answered(g, "difficulty")) return "difficulty";
  if (!answered(g, "leveling")) return "leveling";
  return "begin";
}

/** The ready-made heroes still on offer (one of each class at a table). */
export function readyMadeOptions(g: Game): { race: string; className: string }[] {
  const taken = new Set(realPlayers(g).map((p) => p.className.toLowerCase()));
  return READY_MADE.filter((o) => !taken.has(o.className.toLowerCase()));
}

function offerWords(g: Game): string {
  const opts = readyMadeOptions(g)
    .slice(0, 4)
    .map((o) => `the ${o.race.toLowerCase()} ${o.className.toLowerCase()}`);
  if (!opts.length) return "";
  return opts.length === 1 ? opts[0]! : `${opts.slice(0, -1).join(", ")} or ${opts[opts.length - 1]}`;
}

/** The question as asked: in full, or the short reminder used the second time. */
export function questionText(g: Game, q: SetupQuestion, short = false): string {
  const seat = realPlayers(g).length + 1;
  const name = g.setupState.seatName;
  switch (q) {
    case "adventure":
      return short ? "What kind of adventure would you like?" : "What kind of adventure shall we play? Give me a genre, a mood, or a place to begin.";
    case "players":
      return short ? "How many of you are playing?" : "How many players are at the table?";
    case "seat-name":
      return short ? "Who's next? Tell me your name." : `Player ${ORDINALS[seat - 1] ?? seat}, what's your name?`;
    case "seat-hero": {
      const offer = offerWords(g);
      if (short) return `${name}, who is your hero?`;
      return `Describe your hero, ${name}: a name, a species and a class.${offer ? ` Or pick a ready-made one: ${offer}.` : ""}`;
    }
    case "who-plays":
      return `Who is playing ${unclaimedHero(g)?.name ?? "that hero"}?`;
    case "more":
      return short ? "Anyone else?" : "Is anyone else joining? Tell me your name, or say that's everyone.";
    case "tone":
      // The mood was given with the adventure ("a spooky pirate story"): only the lines are left to ask about.
      if (answered(g, "mood")) return short ? "Anything to leave out?" : "Is there anything I should leave out of the story?";
      return short ? "Any tone you'd like, or anything to leave out?" : "What tone do you want, and is there anything I should leave out of the story?";
    case "difficulty":
      return short ? "Easy, standard or hard fights?" : "How tough should the fights be: easy, standard or hard?";
    case "leveling":
      return short ? "Experience points, or milestones?" : "Should heroes level up by experience points, or at story milestones?";
    case "begin":
      return short ? "Say let's begin when you're ready." : "We're all set. Say let's begin when you're ready.";
  }
}

const askedKey = (g: Game, q: SetupQuestion) => (q === "seat-name" || q === "seat-hero" ? `${q}-${realPlayers(g).length + 1}` : q === "who-plays" ? `who-${realPlayers(g).length}` : q);

/**
 * The next setup question to say after a reply, counted so it isn't repeated at every turn: in full the first time,
 * the short form the second, nothing after that (the board keeps showing it). Call inside a mutation: it updates the count.
 */
export function askNext(g: Game): string {
  const q = setupQuestion(g);
  if (!q) return "";
  const key = askedKey(g, q);
  const times = g.setupState.asked[key] ?? 0;
  g.setupState.asked[key] = times + 1;
  return times === 0 ? questionText(g, q) : times === 1 ? questionText(g, q, true) : "";
}

/**
 * What stands between the table and the story, said when someone acts in the story before anyone has a hero (with a
 * hero, nothing is missing: the story simply begins). The full form, then a short one, alternating, so it is never the
 * same sentence twice running. Call inside a mutation: it keeps the count.
 */
export function missingLine(g: Game): string {
  const times = g.setupState.asked["missing"] ?? 0;
  g.setupState.asked["missing"] = times + 1;
  if (times % 2 === 1) return "First, a hero: who are you playing?";
  const offer = offerWords(g);
  return `The story starts once someone has a hero. Describe yours: a name, a species and a class${offer ? `, or pick a ready-made one: ${offer}` : ""}.`;
}

/** Mark a table question as settled (answered or skipped). */
export function settle(g: Game, key: string): void {
  const k = key.slice(0, 20).toLowerCase();
  if (!g.setupState.answered.includes(k)) g.setupState.answered.push(k);
}

export function settleWhoPlays(g: Game, heroId: string): void {
  settle(g, `who-${heroId}`);
}

export function setupView(game: Game): SetupView {
  const framed = isFramed(game);
  const party = realPlayers(game).length;
  const playing = game.phase !== "setup";
  const partyWord = (game.theme.labels.party || "Party").toLowerCase();
  const expected = game.settings.expectedPlayers;
  const partyDone = party > 0 && (expected !== null ? party >= expected : answered(game, "party"));
  const tableDone = ["tone", "difficulty", "leveling"].every((k) => answered(game, k));
  const steps: SetupStep[] = [
    { key: "adventure", label: "Choose the adventure", done: framed },
    { key: "players", label: "Count the players", done: playing || expected !== null || party > 0 || answered(game, "players") },
    { key: "party", label: `Assemble the ${partyWord}${expected ? ` (${Math.min(party, expected)} of ${expected})` : ""}`, done: playing || partyDone },
    { key: "table", label: "Set the table rules", done: playing || tableDone },
    { key: "begin", label: "Begin the adventure", done: playing },
  ];
  const q = setupQuestion(game);
  return { steps, next: q ? questionText(game, q) : null, question: q };
}

// ─── Reading the table's answers ─────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/** "three of us", "just me", "4 players": how many are playing (1–8), or null. */
export function parseCount(text: string): number | null {
  const t = text.toLowerCase();
  if (/\b(just me|only me|by myself|solo|on my own|i'm alone|just one)\b/.test(t)) return 1;
  if (/\b(both of us|the two of us|a couple of us|me and (?:my|one))\b/.test(t)) return 2;
  const digit = /\b([1-8])\b/.exec(t);
  if (digit) return Number(digit[1]);
  for (const [word, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  return null;
}

const NOT_A_NAME = new Set(
  (
    "yes yeah yep no nope okay ok sure hello hi hey thanks please skip none nothing whatever everyone nobody me myself us we you i the a an and or " +
    "easy standard hard normal medium tough experience milestones milestone points fighter wizard cleric rogue barbarian bard druid monk paladin ranger sorcerer warlock " +
    "human elf dwarf halfling gnome tiefling dragonborn orc player hero ready done begin start let's lets that's thats one two three four five six seven eight " +
    // What follows "I'm…" when it isn't a name: "I'm playing Thorin", "I'm going to be the wizard", "I'm back", "I'm in".
    "playing gonna going here there back in out on up off all also too just so really still not new good fine great happy glad excited sorry " +
    "afraid thinking wondering trying choosing picking taking making rolling being using getting starting joining looking coming staying " +
    "with for from at as by to of his her their my our your its this that it game games character characters adventure"
  ).split(/\s+/),
);

/**
 * Could this word be someone's name? Not a common word, and not a verb: a lower-case word ending in -ing or -ed after
 * "I'm" is what the speaker is doing ("I'm playing", "I'm excited"), never who they are.
 */
export function isNameWord(word: string): boolean {
  const w = word.trim();
  if (w.length < 2 || NOT_A_NAME.has(w.toLowerCase())) return false;
  return !(w === w.toLowerCase() && /(?:ing|ed)$/.test(w));
}

/** "I'm Ryan", "my name is Ana", "Sam": the name of the person at the table, or null. Never a verb ("I'm playing…"). */
export function parsePlayerName(text: string): string | null {
  const said = /\b(?:i'm|i’m|i am|my name is|my name's|name's|this is|it's|it’s|call me|you can call me)\s+([\p{L}][\p{L}'’-]{1,20})/iu.exec(text);
  const tidy = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (said?.[1] && isNameWord(said[1])) return tidy(said[1]);
  const bare = /^[\s"']*([\p{L}][\p{L}'’-]{1,20})[\s.!,"']*$/u.exec(text.trim());
  if (bare?.[1] && isNameWord(bare[1])) return tidy(bare[1]);
  return null;
}

const COUNTED = String.raw`(\d|one|two|three|four|five|six|seven|eight)`;

/**
 * How many are playing, when the words say it of players ("for two players", "there are three of us", "just me"):
 * stricter than `parseCount`, for a sentence that is about something else (asking for a new game). Null when unsaid.
 */
export function playerCountIn(text: string): number | null {
  const t = text.toLowerCase();
  if (/\b(just me|only me|by myself|solo|on my own|single[- ]player|one player)\b/.test(t)) return 1;
  if (/\b(both of us|the two of us|a couple of us|me and (?:my|one) \w+|my (?:friend|partner|wife|husband|brother|sister|son|daughter|kid) and (?:i|me))\b/.test(t)) return 2;
  const m = new RegExp(String.raw`\b${COUNTED}\s+(?:players?|people|persons?|of us|heroes|adventurers|friends)\b|\bwe(?:'re| are)\s+${COUNTED}\b|\bfor\s+${COUNTED}\b(?!\s*(?:hours?|minutes?|sessions?|nights?|days?|weeks?|rounds?|gold|xp))`).exec(t);
  const n = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!n) return null;
  return /^\d$/.test(n) ? Math.min(MAX_PLAYERS, Math.max(1, Number(n))) : (NUMBER_WORDS[n] ?? null);
}

/** "a short adventure", "a one-shot", "a long campaign": how long the table wants to play, or null when unsaid. */
export function lengthIn(text: string): AdventureLength | null {
  const t = text.toLowerCase();
  if (/\b(one[- ]?shot|single session|one session|one evening|one night|just tonight|tonight only|quick (?:game|adventure|one))\b/.test(t)) return "one-shot";
  if (/\b(short|brief|mini)\b(?!\s+rest)|\bsmall (?:adventure|game|story|quest)\b/.test(t)) return "short";
  if (/\blong(?:er)? (?:adventure|campaign|game|story|quest|one)\b|\b(ongoing|multi[- ]?session|several sessions|many sessions|long[- ]running|campaign)\b/.test(t)) return "campaign";
  return null;
}

export function parseDifficulty(text: string): TableDifficulty | null {
  const t = text.toLowerCase();
  if (/\b(easy|easier|gentle|forgiving|casual|relaxed|beginner|go easy)\b/.test(t)) return "easy";
  if (/\b(hard|harder|tough|deadly|brutal|challenging|difficult|punishing)\b/.test(t)) return "hard";
  if (/\b(standard|normal|medium|regular|balanced|default|moderate|in between|middle)\b/.test(t)) return "standard";
  return null;
}

export function parseLeveling(text: string): "xp" | "milestone" | null {
  const t = text.toLowerCase();
  if (/\bmilestones?\b|\bstory (?:beats?|moments?)\b/.test(t)) return "milestone";
  if (/\b(xp|experience|points)\b/.test(t)) return "xp";
  return null;
}

/** "we'll roll our own dice" → ask; "you roll for us" → auto. */
export function parseRolls(text: string): "ask" | "auto" | null {
  const t = text.toLowerCase();
  if (/\b(roll (?:everything |all (?:of )?(?:it|them) |the dice )?for us|you roll|roll for us from now on|we (?:don't|do not) have dice|no dice|auto ?roll)\b/.test(t)) return "auto";
  if (/\b(we(?:'ll| will)? roll (?:our own|ourselves|the dice)|our own dice|we have dice|real dice|let us roll)\b/.test(t)) return "ask";
  return null;
}

const TONE_WORDS =
  /\b(light(?:hearted)?|funny|silly|goofy|comedic|dark|grim|gritty|serious|spooky|scary|creepy|heroic|epic|kid[- ]friendly|family[- ]friendly|gentle|whimsical|tense|mysterious|dramatic|swashbuckling|cozy|gory|bloody|pulpy|noir)\b/gi;

/** What the table wants of the story: a tone ("lighthearted and silly") and things to leave out ("spiders", "gore"). */
export function parseToneAndLines(text: string): { tone: string | null; avoid: string[] } {
  const avoid: string[] = [];
  const t = text.replace(/[“”"]/g, "");
  const re = /\b(?:no|without|leave out|avoid|skip|nothing with|nothing about|don't include|do not include|not too much|not a lot of|keep out|please no)\s+((?:the |any |too much )?[a-z][a-z' -]{1,40}?)(?=\s*(?:,|\.|;|!|\band\b|\bor\b|\bbut\b|\bplease\b|$))/gi;
  for (const m of t.matchAll(re)) {
    const what = (m[1] ?? "").replace(/^(?:the|any|too much)\s+/i, "").trim();
    if (what && !/^(?:limits?|preference|problem|thanks|idea|one|worries)$/i.test(what) && !avoid.includes(what.toLowerCase())) avoid.push(what.toLowerCase());
  }
  // "no spiders or gore": the second item rides on the first "no".
  for (const m of t.matchAll(/\b(?:no|without|avoid)\s+[a-z' -]+?\s+(?:or|and)\s+([a-z][a-z' -]{1,30}?)(?=\s*(?:,|\.|;|!|\bplease\b|$))/gi)) {
    const what = (m[1] ?? "").trim().toLowerCase();
    if (what && !avoid.includes(what) && !/^(?:keep|make|it|we|i)\b/.test(what)) avoid.push(what);
  }
  const outside = t.replace(re, " ");
  const tones = [...new Set((outside.match(TONE_WORDS) ?? []).map((w) => w.toLowerCase()))];
  return { tone: tones.length ? tones.slice(0, 3).join(" and ") : null, avoid: avoid.slice(0, 6) };
}

/** "skip", "whatever", "you decide", "nothing": the table has no preference. */
export function isSkip(text: string): boolean {
  return /\b(skip|whatever|default|defaults|don't care|doesn't matter|you (?:pick|choose|decide)|up to you|surprise (?:me|us)|no preference|nothing(?: in particular)?|anything goes|no limits|not really|i'm good|we're good|none)\b/i.test(text);
}

/** "that's everyone", "nobody else", "just us". */
export function isEveryone(text: string): boolean {
  return /\b(that'?s (?:everyone|everybody|all|it|us)|no ?(?:body|one) else|just us|we'?re all here|that is everyone|no more players|everyone'?s here|nope|no)\b/i.test(text);
}

/** Picking a ready-made hero: by its words ("the elf wizard", "the cleric"), by position ("the second one"), or left to the Game Master. */
export function parseReadyMade(text: string, options: { race: string; className: string }[]): { race: string; className: string } | null {
  if (!options.length) return null;
  const t = text.toLowerCase();
  const both = options.find((o) => t.includes(`${o.race.toLowerCase()} ${o.className.toLowerCase()}`));
  if (both) return both;
  const wantsReady = /\b(ready[- ]?made|pre[- ]?made|pre[- ]?gen\w*|one of (?:yours|those|them|the ready)|pick (?:one )?for me|you (?:pick|choose)|surprise me|any of them|whichever)\b/.test(t);
  const pos = /\b(first|second|third|fourth|last)\b/.exec(t);
  if (pos && /\b(one|option|hero|choice)\b/.test(t)) {
    const i = { first: 0, second: 1, third: 2, fourth: 3, last: Math.min(3, options.length - 1) }[pos[1] as "first"] ?? 0;
    return options[Math.min(i, options.length - 1)] ?? null;
  }
  const byClass = options.find((o) => new RegExp(`\\bthe ${o.className.toLowerCase()}\\b`).test(t));
  if (byClass && (wantsReady || /\b(take|pick|choose|i'll have|i will have|give me|i want|i'll be|go with)\b/.test(t))) return byClass;
  if (wantsReady) return options.find((o) => t.includes(o.className.toLowerCase())) ?? options[0] ?? null;
  return null;
}
