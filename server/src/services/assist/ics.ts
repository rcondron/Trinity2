import { DAY_MS, addDays, daysBetween, daysInMonth, dayStartOf, sameDay, utcOf, validZone, wallOf, weekdayOf, type Wall, type Ymd } from "./time.js";

/*
 * A reader for iCalendar feeds (RFC 5545), enough for "what's on my calendar": VEVENTs with their times in UTC
 * ("…Z"), in a named zone (TZID — IANA names, the Windows names Outlook writes, "/…/Tzfile/America/New_York"), floating
 * (no zone: the viewer's own) or all-day (DATE); DTEND or DURATION; long lines unfolded; text unescaped; cancelled
 * events left out; and repeats: RRULE with FREQ DAILY / WEEKLY (BYDAY) / MONTHLY (by month-day, or "the second
 * Tuesday") / YEARLY, with INTERVAL, COUNT, UNTIL, BYMONTH and WKST, minus EXDATE, with single occurrences moved or
 * cancelled by a RECURRENCE-ID event. A repeat is worked out on the event's own wall clock, so a 9 o'clock stand-up
 * stays at 9 across a daylight-saving change.
 *
 * What it doesn't read: VTIMEZONE definitions (the zone's name is looked up instead), RDATE, and rules with BYSETPOS,
 * BYWEEKNO, BYYEARDAY or a FREQ under a day — such an event keeps its first time only and is counted in `unread`.
 * Nothing in a feed is trusted beyond being shown: titles and places are text.
 */

export type IcsTime = { kind: "utc"; ms: number } | { kind: "local"; wall: Wall; tzid: string | null } | { kind: "date"; day: Ymd };

export interface IcsRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: IcsTime | null;
  /** 0 = Sunday … 6 = Saturday; nth ≠ 0 is "the second Tuesday" (2) or "the last Friday" (−1) of a month. */
  byDay: { wd: number; nth: number }[];
  byMonthDay: number[];
  byMonth: number[];
  /** The day a week starts on (0–6): where an every-other-week rule counts its weeks from. */
  wkst: number;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  location: string;
  cancelled: boolean;
  /** Marked free (TRANSP:TRANSPARENT): shown, but not something that makes the user busy. */
  free: boolean;
  start: IcsTime;
  end: IcsTime | null;
  durationMs: number | null;
  rule: IcsRule | null;
  exdates: IcsTime[];
  /** This event stands in for one occurrence of the series with the same uid (moved, edited or cancelled). */
  recurrenceId: IcsTime | null;
}

export interface IcsCalendar {
  events: IcsEvent[];
  /** The zone the feed names for itself (X-WR-TIMEZONE), when it is one Intl knows. */
  zone: string | null;
  /** Events whose repeat rule this reader doesn't know: only their first time is used. */
  unread: number;
}

export interface Occurrence {
  uid: string;
  title: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  /** Marked free in the feed. */
  free: boolean;
}

const MAX_EVENTS = 20_000;
const MAX_STEPS = 60_000;

// ─── Lines ────────────────────────────────────────────────────────────────────

/** Long lines are folded: a line that starts with a space or a tab goes on the one before. */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line.trim()) out.push(line);
  }
  return out;
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** NAME;PARAM=value;PARAM="quoted:value":VALUE */
function parseLine(line: string): Line | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head: string[] = [];
  let part = "";
  quoted = false;
  for (const c of line.slice(0, colon)) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      head.push(part);
      part = "";
    } else part += c;
  }
  head.push(part);
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  // (A group prefix, "item1.DTSTART", names the same property.)
  return { name: head[0]!.trim().toUpperCase().replace(/^[A-Z0-9-]+\./, ""), params, value: line.slice(colon + 1) };
}

const unescapeText = (v: string): string =>
  v
    .replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? " " : c))
    .replace(/\s+/g, " ")
    .trim();

// ─── Zones and times ──────────────────────────────────────────────────────────

/** The names Windows (and so Outlook) gives the common zones. */
const WINDOWS_ZONES: Record<string, string> = {
  utc: "UTC",
  "coordinated universal time": "UTC",
  "greenwich standard time": "Atlantic/Reykjavik",
  "gmt standard time": "Europe/London",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "romance standard time": "Europe/Paris",
  "gtb standard time": "Europe/Bucharest",
  "fle standard time": "Europe/Helsinki",
  "e. europe standard time": "Europe/Chisinau",
  "turkey standard time": "Europe/Istanbul",
  "russian standard time": "Europe/Moscow",
  "israel standard time": "Asia/Jerusalem",
  "south africa standard time": "Africa/Johannesburg",
  "arabian standard time": "Asia/Dubai",
  "arab standard time": "Asia/Riyadh",
  "pakistan standard time": "Asia/Karachi",
  "india standard time": "Asia/Kolkata",
  "se asia standard time": "Asia/Bangkok",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "taipei standard time": "Asia/Taipei",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "w. australia standard time": "Australia/Perth",
  "cen. australia standard time": "Australia/Adelaide",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "new zealand standard time": "Pacific/Auckland",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "canada central standard time": "America/Regina",
  "central standard time (mexico)": "America/Mexico_City",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "sa pacific standard time": "America/Bogota",
  "sa eastern standard time": "America/Cayenne",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
};

/** A TZID as a zone Intl knows, or null (the time is then read as floating: in the viewer's zone). */
export function zoneOfTzid(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim().replace(/^"|"$/g, "");
  if (!t) return null;
  if (validZone(t)) return t;
  // "/freeassociation.sourceforge.net/Tzfile/America/New_York", "/mozilla.org/20050126_1/Europe/Berlin"
  const parts = t.split("/").filter(Boolean);
  for (const n of [3, 2, 1]) {
    const tail = parts.slice(-n).join("/");
    if (parts.length >= n && /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tail) && tail.includes("/") && validZone(tail)) return tail;
  }
  const windows = WINDOWS_ZONES[t.toLowerCase()];
  if (windows && validZone(windows)) return windows;
  // "(UTC-06:00) Central Time (US & Canada)": a whole-hour offset as a fixed zone.
  const offset = /\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\b/i.exec(t);
  if (offset && (!offset[3] || offset[3] === "00")) {
    const hours = Number(offset[2]);
    const fixed = hours === 0 ? "UTC" : `Etc/GMT${offset[1] === "-" ? "+" : "-"}${hours}`;
    if (validZone(fixed)) return fixed;
  }
  return null;
}

function parseTime(value: string, params: Record<string, string>): IcsTime | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) {
    const day = { y: Number(date[1]), mo: Number(date[2]), d: Number(date[3]) };
    return day.mo >= 1 && day.mo <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.mo) ? { kind: "date", day } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const wall: Wall = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) };
  if (wall.mo < 1 || wall.mo > 12 || wall.d < 1 || wall.d > daysInMonth(wall.y, wall.mo) || wall.h > 23 || wall.mi > 59 || wall.s > 60) return null;
  if (m[7]) return { kind: "utc", ms: Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s) };
  return { kind: "local", wall, tzid: zoneOfTzid(params.TZID) };
}

/** PT1H30M, P1D, P2W… in ms. */
function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m || m[1] === "-") return null;
  const ms = Number(m[2] ?? 0) * 7 * DAY_MS + Number(m[3] ?? 0) * DAY_MS + Number(m[4] ?? 0) * 3_600_000 + Number(m[5] ?? 0) * 60_000 + Number(m[6] ?? 0) * 1000;
  return ms > 0 ? ms : null;
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** An RRULE this reader can work out, or null (then the event keeps only its first time). */
function parseRule(value: string): IcsRule | null {
  const part: Record<string, string> = {};
  for (const kv of value.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) part[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim().toUpperCase();
  }
  const freq = part.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  if (part.BYSETPOS || part.BYWEEKNO || part.BYYEARDAY || part.BYHOUR || part.BYMINUTE || part.BYSECOND) return null;
  const interval = part.INTERVAL ? Number(part.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return null;
  let count: number | null = null;
  if (part.COUNT) {
    count = Number(part.COUNT);
    if (!Number.isInteger(count) || count < 1) return null;
  }
  let until: IcsTime | null = null;
  if (part.UNTIL) {
    until = parseTime(part.UNTIL, {});
    if (!until) return null;
  }
  const byDay: IcsRule["byDay"] = [];
  for (const d of (part.BYDAY ?? "").split(",").filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d.trim());
    if (!m) return null;
    const nth = m[1] ? Number(m[1]) : 0;
    if (nth !== 0 && freq !== "MONTHLY" && freq !== "YEARLY") return null;
    if (nth < -5 || nth > 5) return null;
    byDay.push({ wd: DAY_CODES.indexOf(m[2]!), nth });
  }
  const ints = (v: string | undefined, min: number, max: number): number[] | null => {
    const out: number[] = [];
    for (const s of (v ?? "").split(",").filter(Boolean)) {
      const n = Number(s);
      if (!Number.isInteger(n) || n === 0 || n < min || n > max) return null;
      out.push(n);
    }
    return out;
  };
  const byMonthDay = ints(part.BYMONTHDAY, -31, 31);
  const byMonth = ints(part.BYMONTH, 1, 12);
  if (!byMonthDay || !byMonth) return null;
  if (freq === "WEEKLY" && byMonthDay.length) return null;
  const wkst = part.WKST ? DAY_CODES.indexOf(part.WKST) : 1;
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, wkst: wkst < 0 ? 1 : wkst };
}

// ─── The calendar ─────────────────────────────────────────────────────────────

/** Read a feed. Events that can't be placed in time (no DTSTART) are dropped. */
export function parseIcs(text: string): IcsCalendar {
  const cal: IcsCalendar = { events: [], zone: null, unread: 0 };
  let depth = 0; // inside VEVENT: 1; inside something within it (VALARM): more
  let inEvent = false;
  let cur: Partial<IcsEvent> & { exdates: IcsTime[]; ruleUnread?: boolean } = { exdates: [] };
  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN") {
      const what = line.value.trim().toUpperCase();
      if (!inEvent && what === "VEVENT") {
        inEvent = true;
        depth = 1;
        cur = { exdates: [] };
      } else if (inEvent) depth++;
      continue;
    }
    if (line.name === "END") {
      if (!inEvent) continue;
      depth--;
      if (depth > 0) continue;
      inEvent = false;
      if (cur.start && cal.events.length < MAX_EVENTS) {
        if (cur.ruleUnread) cal.unread++;
        cal.events.push({
          uid: cur.uid ?? `event-${cal.events.length + 1}`,
          summary: cur.summary ?? "",
          location: cur.location ?? "",
          cancelled: cur.cancelled === true,
          free: cur.free === true,
          start: cur.start,
          end: cur.end ?? null,
          durationMs: cur.durationMs ?? null,
          rule: cur.rule ?? null,
          exdates: cur.exdates,
          recurrenceId: cur.recurrenceId ?? null,
        });
      }
      continue;
    }
    if (!inEvent) {
      if (line.name === "X-WR-TIMEZONE") cal.zone = zoneOfTzid(line.value);
      continue;
    }
    if (depth !== 1) continue; // an alarm's own lines
    switch (line.name) {
      case "UID":
        cur.uid = line.value.trim().slice(0, 300);
        break;
      case "SUMMARY":
        cur.summary = unescapeText(line.value).slice(0, 300);
        break;
      case "LOCATION":
        cur.location = unescapeText(line.value).slice(0, 300);
        break;
      case "STATUS":
        cur.cancelled = /^cancell?ed$/i.test(line.value.trim());
        break;
      case "TRANSP":
        cur.free = /^transparent$/i.test(line.value.trim());
        break;
      case "DTSTART":
        cur.start = parseTime(line.value, line.params) ?? undefined;
        break;
      case "DTEND":
        cur.end = parseTime(line.value, line.params);
        break;
      case "DURATION":
        cur.durationMs = parseDuration(line.value);
        break;
      case "RRULE":
        cur.rule = parseRule(line.value);
        if (!cur.rule) cur.ruleUnread = true;
        break;
      case "EXDATE":
        for (const v of line.value.split(",")) {
          const t = parseTime(v, line.params);
          if (t) cur.exdates.push(t);
        }
        break;
      case "RECURRENCE-ID":
        cur.recurrenceId = parseTime(line.value, line.params);
        break;
      default:
        break;
    }
  }
  return cal;
}

// ─── Occurrences ──────────────────────────────────────────────────────────────

/** A time in the feed as an instant: floating times and dates are read in `zone`. */
export function instantOf(t: IcsTime, zone: string): number {
  if (t.kind === "utc") return t.ms;
  if (t.kind === "date") return dayStartOf(t.day, zone);
  return utcOf(t.wall, t.tzid ?? zone);
}

const cmp = (a: Ymd, b: Ymd): number => a.y * 10_000 + a.mo * 100 + a.d - (b.y * 10_000 + b.mo * 100 + b.d);

/** The days of one month a monthly (or yearly) rule names, in order. */
function monthDays(rule: IcsRule, y: number, mo: number, startDay: number): number[] {
  const dim = daysInMonth(y, mo);
  const byNumber = (list: number[]): number[] => list.map((n) => (n > 0 ? n : dim + 1 + n)).filter((d) => d >= 1 && d <= dim);
  let days: number[];
  if (rule.byDay.length) {
    days = [];
    for (const { wd, nth } of rule.byDay) {
      const all: number[] = [];
      for (let d = 1; d <= dim; d++) if (weekdayOf({ y, mo, d }) === wd) all.push(d);
      if (nth === 0) days.push(...all);
      else {
        const pick = nth > 0 ? all[nth - 1] : all[all.length + nth];
        if (pick !== undefined) days.push(pick);
      }
    }
    if (rule.byMonthDay.length) {
      const allowed = new Set(byNumber(rule.byMonthDay));
      days = days.filter((d) => allowed.has(d));
    }
  } else days = byNumber(rule.byMonthDay.length ? rule.byMonthDay : [startDay]);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * The days a rule lands on, in order, from the event's first day on — without end: the caller stops. `skipTo` lets a
 * rule with no COUNT start near the days asked about instead of walking there from years back.
 */
function* ruleDays(rule: IcsRule, first: Ymd, skipTo: Ymd | null): Generator<Ymd> {
  const months = new Set(rule.byMonth);
  const inMonth = (d: Ymd) => !months.size || months.has(d.mo);
  // A rule that never lands anywhere ("every 7 days, on Mondays" from a Tuesday) must still come to an end.
  let turns = 0;
  const spent = () => ++turns > MAX_STEPS;
  if (rule.freq === "DAILY") {
    const wds = new Set(rule.byDay.map((b) => b.wd));
    let k = skipTo ? Math.max(0, Math.floor(daysBetween(first, skipTo) / rule.interval) - 1) : 0;
    for (; !spent(); k++) {
      const day = addDays(first, k * rule.interval);
      if (!inMonth(day)) continue;
      if (wds.size && !wds.has(weekdayOf(day))) continue;
      if (rule.byMonthDay.length) {
        const dim = daysInMonth(day.y, day.mo);
        if (!rule.byMonthDay.some((n) => (n > 0 ? n : dim + 1 + n) === day.d)) continue;
      }
      yield day;
    }
    return;
  }
  if (rule.freq === "WEEKLY") {
    const weekStart = addDays(first, -((weekdayOf(first) - rule.wkst + 7) % 7));
    const offsets = (rule.byDay.length ? rule.byDay.map((b) => b.wd) : [weekdayOf(first)]).map((wd) => (wd - rule.wkst + 7) % 7);
    const inWeek = [...new Set(offsets)].sort((a, b) => a - b);
    let k = skipTo ? Math.max(0, Math.floor(daysBetween(weekStart, skipTo) / (7 * rule.interval)) - 1) : 0;
    for (; !spent(); k++) {
      const base = addDays(weekStart, k * 7 * rule.interval);
      for (const off of inWeek) {
        const day = addDays(base, off);
        if (cmp(day, first) < 0 || !inMonth(day)) continue;
        yield day;
      }
    }
    return;
  }
  if (rule.freq === "MONTHLY") {
    let k = skipTo ? Math.max(0, Math.floor(((skipTo.y - first.y) * 12 + (skipTo.mo - first.mo)) / rule.interval) - 1) : 0;
    for (; !spent(); k++) {
      const t = new Date(Date.UTC(first.y, first.mo - 1 + k * rule.interval, 1));
      const y = t.getUTCFullYear();
      const mo = t.getUTCMonth() + 1;
      if (months.size && !months.has(mo)) continue;
      for (const d of monthDays(rule, y, mo, first.d)) {
        const day = { y, mo, d };
        if (cmp(day, first) >= 0) yield day;
      }
    }
    return;
  }
  // YEARLY: the event's own month and day — or the months and days the rule names.
  let k = skipTo ? Math.max(0, Math.floor((skipTo.y - first.y) / rule.interval) - 1) : 0;
  for (; !spent(); k++) {
    const y = first.y + k * rule.interval;
    for (const mo of rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [first.mo]) {
      for (const d of monthDays(rule, y, mo, first.d)) {
        const day = { y, mo, d };
        if (cmp(day, first) >= 0) yield day;
      }
    }
  }
}

/**
 * Every time an event takes place between `from` and `to` (it counts when any part of it is in there), with
 * all-day events and floating times placed in `zone`, soonest first. Cancelled events and excluded dates are left out.
 */
export function occurrences(cal: IcsCalendar, from: number, to: number, zone: string): Occurrence[] {
  // The occurrences that a RECURRENCE-ID event stands in for, by series.
  const replaced = new Map<string, IcsTime[]>();
  for (const ev of cal.events) {
    if (!ev.recurrenceId) continue;
    const list = replaced.get(ev.uid) ?? [];
    list.push(ev.recurrenceId);
    replaced.set(ev.uid, list);
  }
  const out: Occurrence[] = [];
  const push = (ev: IcsEvent, start: number, end: number, allDay: boolean) => {
    const inside = end > start ? start < to && end > from : start >= from && start < to;
    if (inside) out.push({ uid: ev.uid, title: ev.summary, location: ev.location, start, end, allDay, free: ev.free });
  };

  for (const ev of cal.events) {
    if (ev.cancelled) continue;
    const allDay = ev.start.kind === "date";
    // The event's own clock: where its wall time is read, and where a repeat keeps it.
    const evZone = ev.start.kind === "utc" ? "UTC" : ev.start.kind === "local" ? (ev.start.tzid ?? zone) : zone;
    const firstMs = instantOf(ev.start, zone);
    const wall = ev.start.kind === "date" ? { ...ev.start.day, h: 0, mi: 0, s: 0 } : ev.start.kind === "utc" ? wallOf(ev.start.ms, "UTC") : ev.start.wall;
    const first: Ymd = { y: wall.y, mo: wall.mo, d: wall.d };
    // How long it runs: whole days for an all-day event (one, when the feed gives no end).
    let days = 1;
    let lengthMs = 0;
    if (ev.start.kind === "date") {
      if (ev.end?.kind === "date") days = Math.max(1, daysBetween(ev.start.day, ev.end.day));
      else if (ev.durationMs) days = Math.max(1, Math.round(ev.durationMs / DAY_MS));
    } else if (ev.end) lengthMs = Math.max(0, instantOf(ev.end, zone) - firstMs);
    else if (ev.durationMs) lengthMs = ev.durationMs;
    const startOf = (day: Ymd): number => (allDay ? dayStartOf(day, zone) : utcOf({ ...day, h: wall.h, mi: wall.mi, s: wall.s }, evZone));
    const endOf = (day: Ymd, start: number): number => (allDay ? dayStartOf(addDays(day, days), zone) : start + lengthMs);

    if (!ev.rule || ev.recurrenceId) {
      push(ev, firstMs, endOf(first, firstMs), allDay);
      continue;
    }
    const rule = ev.rule;
    const untilMs = rule.until ? (rule.until.kind === "date" ? dayStartOf(addDays(rule.until.day, 1), evZone) - 1 : instantOf(rule.until, evZone)) : Infinity;
    const excluded = (start: number, day: Ymd): boolean =>
      ev.exdates.some((x) => (x.kind === "date" ? sameDay(x.day, day) : instantOf(x, evZone) === start)) ||
      (replaced.get(ev.uid) ?? []).some((x) => (x.kind === "date" ? sameDay(x.day, day) : instantOf(x, evZone) === start));
    // With no COUNT, start near the window (a few days early: the event may span midnight or several days).
    const windowDay = wallOf(from - (allDay ? days * DAY_MS : lengthMs) - 2 * DAY_MS, evZone);
    const skipTo = rule.count === null && cmp(windowDay, first) > 0 ? { y: windowDay.y, mo: windowDay.mo, d: windowDay.d } : null;
    let made = 0;
    let steps = 0;
    for (const day of ruleDays(rule, first, skipTo)) {
      if (++steps > MAX_STEPS) break;
      const start = startOf(day);
      if (start > untilMs) break;
      if (rule.count !== null && ++made > rule.count) break;
      if (start >= to) break;
      if (excluded(start, day)) continue;
      push(ev, start, endOf(day, start), allDay);
    }
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}
