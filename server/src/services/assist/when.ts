import { addDays, daysInMonth, weekdayOf, type Ymd } from "./time.js";

/*
 * Days, clock times and lengths as people say them — "tomorrow at three for half an hour", "Friday at noon", "from 2
 * to 3:30 pm", "on the 12th", "November 20th at 10:30 a.m.", "half past two" — found in a sentence, each with where
 * it was said (start / end offsets), so the caller can take the time words out and keep the rest. Everything works on
 * the lower-cased sentence (prep()), in the user's own calendar: nothing here knows about time zones.
 *
 * tools/schedule.ts reads times too, but for reminders: its date sums are private and run on the process's local
 * time, and its reader keeps the reminder's words. Only its conventions are shared (a bare hour reads by business
 * hours; "next Friday" is the coming one, a week away when said on a Friday).
 */

export interface Span {
  start: number;
  end: number;
}

export type PartOfDay = "morning" | "afternoon" | "evening" | "night";

export interface SaidClock extends Span {
  /** 0–23 when `fixed`; otherwise the hour as said, 1–12. */
  h: number;
  mi: number;
  /** am/pm was said (or it is noon, midnight or a 24-hour time): `h` is the hour of the day. */
  fixed: boolean;
}

export interface SaidRange extends Span {
  from: SaidClock;
  to: SaidClock;
}

export interface SaidDay extends Span {
  day: Ymd;
  /** A weekday name with no date ("Friday"): the caller may move it a week on when its time has already passed. */
  weekday: boolean;
  /** "today", "tonight", "this morning": said as today. */
  today: boolean;
}

export interface SaidDuration extends Span {
  minutes: number;
}

/** The sentence as the readers want it: lower case, straight apostrophes, same length as the original. */
export function prep(text: string): string {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return t.length === text.length ? t : text.replace(/[‘’]/g, "'").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// ─── Numbers in words ─────────────────────────────────────────────────────────

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "3", "three", "forty-five", "forty five", "oh five", "a" / "an" (1) → the number; anything else → null. */
export function wordNumber(said: string): number | null {
  const t = said.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (t === "a" || t === "an") return 1;
  const parts = t.split(/[\s-]+/);
  if (parts.length === 1) {
    const u = UNITS.indexOf(t);
    if (u >= 0) return u;
    return TENS[t] ?? null;
  }
  if (parts.length === 2) {
    const u = UNITS.indexOf(parts[1]!);
    if (parts[0] === "oh" && u >= 1 && u <= 9) return u;
    const tens = TENS[parts[0]!];
    if (tens !== undefined && u >= 1 && u <= 9) return tens + u;
  }
  return null;
}

const ONE_9 = "one|two|three|four|five|six|seven|eight|nine";
const TEENS = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const HOUR_WORD = `${ONE_9}|ten|eleven|twelve`;
/** Minutes said in words: "thirty", "forty five", "fifteen", "oh five". */
const MINUTE_WORDS = `oh[ -](?:${ONE_9})|(?:twenty|thirty|forty|fifty)(?:[ -](?:${ONE_9}))?|${TEENS}`;
const AMPM = String.raw`a\.?\s?m\b\.?|p\.?\s?m\b\.?`;
/** A count for a length: "2", "1.5", "an", "two", "forty-five", "ninety". */
const COUNT = `\\d+(?:\\.\\d+)?|an?|${ONE_9}|${TEENS}|(?:twenty|thirty|forty|fifty|sixty|ninety)(?:[ -](?:${ONE_9}))?`;
const LENGTH_UNIT = String.raw`minutes?|mins?|hours?|hrs?`;
/** After a number, what makes it part of a word ("12th") or a count of something rather than a clock time. */
const NOT_A_CLOCK = String.raw`(?![a-z\d]|\s*(?:${LENGTH_UNIT}|days?|weeks?|months?|years?|people|persons?|guests?|seats?|percent|%|dollars?|bucks|times|things|of\b)|[:.,/]?\d)`;

// ─── Clock times ──────────────────────────────────────────────────────────────

/** One clock time, its groups prefixed so two can sit in one pattern: 3 | 3:30 | 3.30 | three | three thirty | five o'clock, then am / pm. */
const clockSrc = (p: string): string =>
  `(?:(?<${p}h>\\d{1,2})[:.](?<${p}m>[0-5]\\d)(?!\\d)|(?<${p}hw>\\d{1,2}|${HOUR_WORD})(?:[ -](?<${p}mw>${MINUTE_WORDS}|o'?clock))?)(?:\\s*(?<${p}ap>${AMPM}))?`;

function clockFrom(g: Record<string, string | undefined>, p: string, start: number, end: number): SaidClock | null {
  let h: number | null;
  let mi = 0;
  let colon = false;
  if (g[`${p}h`] !== undefined) {
    h = Number(g[`${p}h`]);
    mi = Number(g[`${p}m`]);
    colon = true;
  } else {
    h = wordNumber(g[`${p}hw`] ?? "");
    const mw = g[`${p}mw`];
    if (mw && !/clock/.test(mw)) mi = wordNumber(mw) ?? 0;
  }
  if (h === null || !Number.isInteger(h) || h < 0 || h > 23 || mi > 59) return null;
  const ap = g[`${p}ap`]?.replace(/[.\s]/g, "");
  if (ap) {
    if (h < 1 || h > 12) return null;
    return { h: (h % 12) + (ap.startsWith("p") ? 12 : 0), mi, fixed: true, start, end };
  }
  // 13:00–23:59 and 0:30 can only be read one way.
  if (h > 12 || (h === 0 && colon)) return { h, mi, fixed: true, start, end };
  if (h === 0) return null;
  return { h, mi, fixed: false, start, end };
}

const RANGE_RE = new RegExp(String.raw`\b(?<lead>from\s+|between\s+)?${clockSrc("a")}\s*(?<join>to|until|till|through|and|-|–|—)\s*${clockSrc("b")}${NOT_A_CLOCK}`, "g");

/** "from 3 to 4", "between two and three thirty", "3 to 4:30 pm", "9:30-10:30": a start and an end. */
export function findRange(text: string): SaidRange | null {
  for (const m of text.matchAll(RANGE_RE)) {
    const g = m.groups ?? {};
    const lead = (g.lead ?? "").trim();
    if (g.join === "and" && lead !== "between") continue;
    // Only a pair that says it is one: led by "from" / "between", or with am / pm or a colon on either side.
    const marked = Boolean(lead) || g.aap !== undefined || g.bap !== undefined || g.ah !== undefined || g.bh !== undefined;
    if (!marked) continue;
    const start = m.index;
    const end = start + m[0].length;
    const from = clockFrom(g, "a", start, end);
    const to = clockFrom(g, "b", start, end);
    if (!from || !to) continue;
    // "3 to 4 pm": the am / pm said once is for both — unless that would run backwards ("11 to 1 pm" starts in the morning).
    if (to.fixed && !from.fixed) {
      const same = (from.h % 12) + (to.h >= 12 ? 12 : 0);
      const fromH = same * 60 + from.mi <= to.h * 60 + to.mi ? same : from.h % 12;
      return { from: { ...from, h: fromH, fixed: true }, to, start, end };
    }
    return { from, to, start, end };
  }
  return null;
}

// With am / pm, or written with a colon: a clock time wherever it stands.
const CLOCK_ANYWHERE = new RegExp(String.raw`(?<![\d:.$/])\b${clockSrc("c")}${NOT_A_CLOCK}`, "g");
// Led by "at", "around", "by"…: "at 3", "at three thirty", "at five o'clock".
const CLOCK_LED = new RegExp(String.raw`\b(?:at|around|about|by|starting(?: at)?|beginning at|@)\s+${clockSrc("c")}${NOT_A_CLOCK}`, "g");
const CLOCK_WORD = /\b(?:at\s+|around\s+|by\s+)?(noon|midday|midnight)\b/g;
// "half past two", "a quarter to five", "ten past nine", "twenty to three".
const CLOCK_PAST = new RegExp(
  String.raw`\b(?:at\s+)?(half|(?:a )?quarter|twenty[ -]five|five|ten|twenty|5|10|20|25)(?: minutes)? (past|after|to|of|till) (\d{1,2}|${HOUR_WORD})(?:\s*(${AMPM}))?${NOT_A_CLOCK}`,
  "g",
);

/** The first clock time said: "at three", "3:30 pm", "noon", "half past two", "quarter to five", "ten thirty a.m.". */
export function findClock(text: string): SaidClock | null {
  let best: SaidClock | null = null;
  const take = (c: SaidClock | null) => {
    if (c && (!best || c.start < best.start || (c.start === best.start && c.end > best.end))) best = c;
  };
  for (const m of text.matchAll(CLOCK_WORD)) take({ h: m[1] === "midnight" ? 0 : 12, mi: 0, fixed: true, start: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(CLOCK_PAST)) {
    const hour = wordNumber(m[3]!);
    if (hour === null || hour < 1 || hour > 12) continue;
    const part = m[1]!.replace(/^a /, "");
    const minutes = part === "half" ? 30 : part === "quarter" ? 15 : (wordNumber(part) ?? 0);
    const back = /^(?:to|of|till)$/.test(m[2]!);
    if (back && part === "half") continue;
    const mi = back ? 60 - minutes : minutes;
    const h12 = back ? ((hour + 10) % 12) + 1 : hour;
    const ap = m[4]?.replace(/[.\s]/g, "");
    const start = m.index;
    const end = start + m[0].length;
    take(ap ? { h: (h12 % 12) + (ap.startsWith("p") ? 12 : 0), mi, fixed: true, start, end } : { h: h12, mi, fixed: false, start, end });
  }
  for (const [re, led] of [[CLOCK_ANYWHERE, false], [CLOCK_LED, true]] as const) {
    for (const m of text.matchAll(re)) {
      const g = m.groups ?? {};
      // Without a lead word, a bare number is no clock time: it needs am / pm, a colon or "o'clock".
      if (!led && g.cap === undefined && g.ch === undefined && !/clock/.test(g.cmw ?? "")) continue;
      take(clockFrom(g, "c", m.index, m.index + m[0].length));
    }
  }
  return best;
}

const PART_RE = /\b(?:(?:this|tomorrow|in the|at|(?:sun|mon|tues|wednes|thurs|fri|satur)day)\s+)?(morning|afternoon|evening|night)\b|\b(tonight)\b/;

/** "tomorrow morning", "this afternoon", "tonight", "Friday evening": the part of the day, where it was said. */
export function findPartOfDay(text: string): (Span & { part: PartOfDay }) | null {
  const m = PART_RE.exec(text);
  if (!m) return null;
  // Only the part's own word is the span: the day beside it ("tomorrow", "friday") is the day reader's.
  const word = m[1] ?? m[2]!;
  const start = m.index + m[0].lastIndexOf(word);
  return { part: m[2] ? "night" : (m[1] as PartOfDay), start, end: start + word.length };
}

/**
 * The hour of the day for an hour said without am / pm. A part of the day or the kind of thing settles it ("at seven
 * tonight", "dinner at seven", "breakfast at eight"); otherwise business hours: 8–11 in the morning, 12 and 1–7 after noon.
 */
export function hourOfDay(h12: number, hint: { part?: PartOfDay | null; meal?: "breakfast" | "lunch" | "dinner" | null } = {}): number {
  const h = h12 % 12;
  if (hint.part === "morning") return h12 === 12 ? 12 : h;
  if (hint.part === "afternoon" || hint.part === "evening") return h + 12;
  if (hint.part === "night") return h12 === 12 ? 0 : h >= 5 ? h + 12 : h;
  if (hint.meal === "breakfast") return h12 === 12 ? 12 : h;
  if (hint.meal === "dinner") return h + 12;
  if (hint.meal === "lunch") return h12 === 11 ? 11 : h + 12;
  return h12 >= 8 && h12 <= 11 ? h12 : h + 12;
}

/** The usual hour for a part of the day said with no clock time ("Monday morning"). */
export const PART_HOUR: Record<PartOfDay, number> = { morning: 9, afternoon: 14, evening: 18, night: 19 };

// ─── Days ─────────────────────────────────────────────────────────────────────

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_INDEX = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
const ORDINAL_WORD = `${ORDINALS.join("|")}|twenty[ -](?:${ORDINALS.slice(0, 9).join("|")})|thirtieth|thirty[ -]first`;
const DAY_NUM = `\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_WORD}`;

function dayNumber(said: string): number | null {
  const t = said.trim();
  const digits = /^(\d{1,2})/.exec(t);
  if (digits) return Number(digits[1]);
  if (t === "thirtieth") return 30;
  if (/^thirty[ -]first$/.test(t)) return 31;
  const twenty = /^twenty[ -](\w+)$/.exec(t);
  if (twenty) {
    const u = ORDINALS.indexOf(twenty[1]!);
    return u >= 0 && u < 9 ? 21 + u : null;
  }
  const i = ORDINALS.indexOf(t);
  return i >= 0 ? i + 1 : null;
}

const validDay = (y: number, mo: number, d: number): boolean => mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
const before = (a: Ymd, b: Ymd): boolean => a.y * 10_000 + a.mo * 100 + a.d < b.y * 10_000 + b.mo * 100 + b.d;

/** A month and a day with no year: this year's, or next year's once this year's has passed. */
function comingDate(mo: number, d: number, year: number | null, today: Ymd): Ymd | null {
  if (year !== null) return validDay(year, mo, d) ? { y: year, mo, d } : null;
  for (const y of [today.y, today.y + 1]) {
    const day = { y, mo, d };
    if (validDay(y, mo, d) && !before(day, today)) return day;
  }
  return null;
}

const YEAR = String.raw`(?:,?\s+(20\d\d))?`;
const DATE_PATTERNS: { re: RegExp; read: (m: RegExpExecArray, today: Ymd) => Ymd | null }[] = [
  {
    // "november 12th", "nov. 12", "november the twelfth, 2027"
    re: new RegExp(String.raw`\b(?:on\s+)?(${MONTH})\.?\s+(?:the\s+)?(${DAY_NUM})\b(?![:.]\d)${YEAR}`),
    read: (m, today) => {
      const d = dayNumber(m[2]!);
      return d === null ? null : comingDate(MONTH_INDEX.indexOf(m[1]!.slice(0, 3)) + 1, d, m[3] ? Number(m[3]) : null, today);
    },
  },
  {
    // "the 12th of november", "12 november"
    re: new RegExp(String.raw`\b(?:on\s+)?(?:the\s+)?(${DAY_NUM})\s+(?:of\s+)?(${MONTH})\b\.?${YEAR}`),
    read: (m, today) => {
      const d = dayNumber(m[1]!);
      return d === null ? null : comingDate(MONTH_INDEX.indexOf(m[2]!.slice(0, 3)) + 1, d, m[3] ? Number(m[3]) : null, today);
    },
  },
  {
    // "11/20", "11/20/2026" (month first) — not "1/2 hour"
    re: /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b(?!\/|\s*(?:an?\s+)?(?:hours?|hrs?|cups?|of\b))/,
    read: (m, today) => comingDate(Number(m[1]), Number(m[2]), m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null, today),
  },
  {
    // "on the 12th", "for the twelfth": this month's, or next month's once it has passed
    re: new RegExp(String.raw`\b(?:on|for|by)\s+the\s+(\d{1,2}(?:st|nd|rd|th)|${ORDINAL_WORD})\b(?!\s+(?:one|of|floor|time|try|attempt|week|day|month|quarter|half|round|item|option|choice)\b)`),
    read: (m, today) => {
      const d = dayNumber(m[1]!);
      if (d === null) return null;
      for (let i = 0; i < 3; i++) {
        const t = new Date(Date.UTC(today.y, today.mo - 1 + i, 1));
        const day = { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d };
        if (validDay(day.y, day.mo, d) && !before(day, today)) return day;
      }
      return null;
    },
  },
];

const WEEKDAY_RE = new RegExp(String.raw`\b(?:(next|this coming|this|on|coming)\s+)?(${WEEKDAY_NAMES.join("|")})s?\b|\b(next|this|on)\s+(sun|mon|tues?|weds?|thurs?|thu|fri|sat)\b\.?`);

/**
 * The day said: a date ("november 12th", "the 12th of november", "11/20", "on the 12th"), "the day after tomorrow",
 * "tomorrow", a weekday ("friday", "next friday": the coming one, a week away when said on a Friday), "in three
 * days", "today" / "tonight" / "this afternoon". Null when no day was said.
 */
export function findDay(text: string, today: Ymd): SaidDay | null {
  for (const p of DATE_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const day = p.read(m, today);
    if (day) return { day, weekday: false, today: false, start: m.index, end: m.index + m[0].length };
  }
  let m = /\b(?:the\s+)?day after tomorrow\b/.exec(text);
  if (m) return { day: addDays(today, 2), weekday: false, today: false, start: m.index, end: m.index + m[0].length };
  m = /\ba week from (today|tomorrow)\b/.exec(text);
  if (m) return { day: addDays(today, m[1] === "today" ? 7 : 8), weekday: false, today: false, start: m.index, end: m.index + m[0].length };
  m = /\btomorrow\b/.exec(text);
  if (m) return { day: addDays(today, 1), weekday: false, today: false, start: m.index, end: m.index + m[0].length };
  m = WEEKDAY_RE.exec(text);
  if (m) {
    const lead = m[1] ?? m[3] ?? "";
    const wd = m[2] ? WEEKDAY_NAMES.indexOf(m[2]) : (WEEKDAY_SHORT[m[4]!] ?? -1);
    if (wd >= 0) {
      const ahead = (wd - weekdayOf(today) + 7) % 7;
      const n = lead === "next" && ahead === 0 ? 7 : ahead;
      return { day: addDays(today, n), weekday: true, today: false, start: m.index, end: m.index + m[0].length };
    }
  }
  m = new RegExp(String.raw`\bin (${COUNT}) (days?|weeks?)\b`).exec(text);
  if (m) {
    const n = wordNumber(m[1]!);
    if (n !== null && Number.isInteger(n) && n > 0 && n < 400) return { day: addDays(today, n * (m[2]!.startsWith("week") ? 7 : 1)), weekday: false, today: false, start: m.index, end: m.index + m[0].length };
  }
  m = /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/.exec(text);
  if (m) {
    // "tonight" and "this morning" also say the part of the day: only "today" / "this" is the day's span.
    const word = /^today/.test(m[0]) ? m[0] : m[0].startsWith("this ") ? "this" : "";
    return { day: today, weekday: false, today: true, start: m.index, end: m.index + word.length };
  }
  return null;
}

// ─── Lengths ──────────────────────────────────────────────────────────────────

const minutesOf = (n: number, unit: string): number => (/^h/.test(unit) ? n * 60 : n);

const DURATION_PATTERNS: { re: RegExp; read: (m: RegExpExecArray) => number | null }[] = [
  { re: /\b(?:for\s+)?(?:an|one|1) hour and a half\b/, read: () => 90 },
  {
    re: new RegExp(String.raw`\b(?:for\s+)?(${COUNT}) and a half[ -]hours?\b`),
    read: (m) => {
      const n = wordNumber(m[1]!);
      return n === null ? null : n * 60 + 30;
    },
  },
  { re: /\b(?:for\s+)?(?:a\s+|an\s+)?half(?:\s+an|\s+a|-an)?[ -]hour\b/, read: () => 30 },
  { re: /\b(?:for\s+)?(?:a\s+)?quarter of an hour\b/, read: () => 15 },
  {
    // "for 45 minutes", "two hours", "a 15 minute", "one-hour", "1 hour 30 minutes", "an hour and 15 minutes"
    re: new RegExp(String.raw`\b(?:for\s+)?(?:an?\s+)?(${COUNT})[ -](${LENGTH_UNIT})\b(?:[ -]long\b)?(?:\s+(?:and\s+)?(${COUNT})[ -]?(minutes?|mins?)\b)?`),
    read: (m) => {
      const n = wordNumber(m[1]!);
      if (n === null) return null;
      const more = m[3] ? wordNumber(m[3]) : 0;
      return minutesOf(n, m[2]!) + (more ?? 0);
    },
  },
  { re: /\b(?:an?\s+)?hour[ -]long\b/, read: () => 60 },
];

/** A start said as a delay: "in an hour", "in 20 minutes", "in half an hour". */
const DELAY_RE = new RegExp(String.raw`\bin (?:(half an hour)|(${COUNT}) (${LENGTH_UNIT}))\b`);

export function findDelay(text: string): (Span & { minutes: number }) | null {
  const m = DELAY_RE.exec(text);
  if (!m) return null;
  const n = m[1] ? 30 : wordNumber(m[2]!);
  if (n === null) return null;
  const minutes = m[1] ? 30 : minutesOf(n, m[3]!);
  return minutes > 0 && minutes <= 24 * 60 ? { minutes: Math.round(minutes), start: m.index, end: m.index + m[0].length } : null;
}

/** How long: "for half an hour", "for 45 minutes", "two hours", "a 15 minute", "an hour and a half" — never a delay ("in an hour"). */
export function findDuration(text: string): SaidDuration | null {
  const delay = findDelay(text);
  let best: SaidDuration | null = null;
  for (const p of DURATION_PATTERNS) {
    const re = new RegExp(p.re.source, "g");
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (delay && start < delay.end && end > delay.start) continue;
      const minutes = p.read(m as RegExpExecArray);
      if (minutes === null || !(minutes >= 5) || minutes > 24 * 60) continue;
      const found = { minutes: Math.round(minutes), start, end };
      if (!best || found.start < best.start || (found.start === best.start && found.end > best.end)) best = found;
    }
  }
  return best;
}

/** `text` with the given stretches blanked (spaces, so offsets elsewhere still hold). */
export function blank(text: string, spans: (Span | null | undefined)[]): string {
  let out = text;
  for (const s of spans) {
    if (!s || s.end <= s.start) continue;
    out = out.slice(0, s.start) + " ".repeat(s.end - s.start) + out.slice(s.end);
  }
  return out;
}
