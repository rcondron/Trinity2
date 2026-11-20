/*
 * The clock and the time zone the assistant tools (email, calendar, meetings) work in. The engine runs on the user's
 * own computer, so both default to the system's; tests pin them with setAssistClock(). Every date sum goes through an
 * IANA zone name (Intl) — never the process's local time — so an iCalendar TZID and the user's zone are handled by
 * the same code, and a test gives the same answer on any machine.
 */

export interface Ymd {
  y: number;
  /** 1–12 */
  mo: number;
  d: number;
}

export interface Wall extends Ymd {
  h: number;
  mi: number;
  s: number;
}

export const DAY_MS = 86_400_000;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

let nowFn: () => number = () => Date.now();
let zoneFixed: string | null = null;

/** Now, in epoch milliseconds. */
export function assistNow(): number {
  return nowFn();
}

/** The user's time zone (IANA name): the system's, unless a test pinned one. */
export function assistZone(): string {
  if (zoneFixed) return zoneFixed;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && validZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** Tests: pin the clock and/or the zone (null puts the system's back). */
export function setAssistClock(opts: { now?: number | (() => number) | null; zone?: string | null } = {}): void {
  if (opts.now !== undefined) {
    const now = opts.now;
    nowFn = now === null ? () => Date.now() : typeof now === "function" ? now : () => now;
  }
  if (opts.zone !== undefined) zoneFixed = opts.zone && validZone(opts.zone) ? opts.zone : null;
}

// ─── Zone arithmetic ──────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      f = null;
    }
    formatters.set(zone, f);
  }
  return f;
}

/** Whether Intl knows this zone name ("America/Chicago", "UTC"). */
export function validZone(zone: string): boolean {
  return typeof zone === "string" && zone.length > 0 && zone.length < 80 && formatter(zone) !== null;
}

/** The wall-clock date and time of an instant in a zone. */
export function wallOf(ms: number, zone: string): Wall {
  const f = formatter(zone) ?? formatter("UTC")!;
  const part: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") part[p.type] = Number(p.value);
  return { y: part.year ?? 1970, mo: part.month ?? 1, d: part.day ?? 1, h: (part.hour ?? 0) % 24, mi: part.minute ?? 0, s: part.second ?? 0 };
}

const asUtc = (w: Wall): number => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** The zone's offset from UTC at an instant, in ms (local − UTC). */
function offsetAt(ms: number, zone: string): number {
  return asUtc(wallOf(ms, zone)) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in a zone. A time the clocks skip (spring forward) lands an hour later; one
 * they repeat (fall back) is one of the two.
 */
export function utcOf(w: Wall, zone: string): number {
  const guess = asUtc(w);
  const first = guess - offsetAt(guess, zone);
  const second = guess - offsetAt(first, zone);
  if (second === first) return first;
  // The two offsets differ: the time is near a change. A candidate that reads back as the wall time asked for is
  // right; when neither does (a skipped hour), the later one.
  const reads = (ms: number) => asUtc(wallOf(ms, zone)) === guess;
  if (reads(first) && reads(second)) return Math.min(first, second);
  if (reads(first)) return first;
  if (reads(second)) return second;
  return Math.max(first, second);
}

/** Midnight (the start of the day) of a date in a zone. */
export function dayStartOf(day: Ymd, zone: string): number {
  return utcOf({ ...day, h: 0, mi: 0, s: 0 }, zone);
}

export function ymdOf(ms: number, zone: string): Ymd {
  const w = wallOf(ms, zone);
  return { y: w.y, mo: w.mo, d: w.d };
}

export function addDays(day: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(day.y, day.mo - 1, day.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: Ymd, b: Ymd): number {
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: Ymd): number {
  return new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay();
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export const sameDay = (a: Ymd, b: Ymd): boolean => a.y === b.y && a.mo === b.mo && a.d === b.d;
export const isoDay = (day: Ymd): string => `${String(day.y).padStart(4, "0")}-${String(day.mo).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;

// ─── Words for times and days (digits are read as words downstream, so "3:30 PM" is written as it is) ──

/** "3 PM", "3:30 PM", "12 PM". */
export function clockText(h: number, mi: number): string {
  const hour = h % 12 || 12;
  return `${hour}${mi ? `:${String(mi).padStart(2, "0")}` : ""} ${h % 24 < 12 ? "AM" : "PM"}`;
}

export function fmtClock(ms: number, zone: string): string {
  const w = wallOf(ms, zone);
  return clockText(w.h, w.mi);
}

/** "3 to 3:30 PM", "11:30 AM to 12:30 PM". */
export function fmtSpan(start: number, end: number, zone: string): string {
  const a = wallOf(start, zone);
  const b = wallOf(end, zone);
  const sameHalf = a.h < 12 === b.h < 12;
  const from = sameHalf ? clockText(a.h, a.mi).replace(/ [AP]M$/, "") : clockText(a.h, a.mi);
  return `${from} to ${clockText(b.h, b.mi)}`;
}

/** "Wednesday, November 11". */
export function longDay(day: Ymd): string {
  return `${WEEKDAYS[weekdayOf(day)]}, ${MONTHS[day.mo - 1]} ${day.d}`;
}

/**
 * A day as it is said, relative to today: "today", "tomorrow", "yesterday", "Friday" (within the next six days),
 * otherwise "Friday, November 20".
 */
export function relDay(day: Ymd, today: Ymd): string {
  const n = daysBetween(today, day);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n > 1 && n < 7) return WEEKDAYS[weekdayOf(day)]!;
  return longDay(day);
}

/** "today", "tomorrow", "on Friday", "on Friday, November 20": a day inside a sentence. */
export function onDay(day: Ymd, today: Ymd): string {
  const said = relDay(day, today);
  return /^(today|tomorrow|yesterday)$/.test(said) ? said : `on ${said}`;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes", "2 hours". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ") || "0 minutes";
}
