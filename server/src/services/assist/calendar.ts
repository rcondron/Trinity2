import { getEndpoints, live } from "../../settings.js";
import type { Block } from "../content-spec.js";
import { jsonChat } from "../json-chat.js";
import type { BrowserPort, PortSnapshot } from "./browser-port.js";
import type { CardContent } from "./cards.js";
import { occurrences, parseIcs, type IcsCalendar } from "./ics.js";
import { tidy } from "./mail-words.js";
import { DAY_MS, addDays, assistNow, daysBetween, daysInMonth, dayStartOf, fmtClock, fmtSpan, isoDay, longDay, onDay, relDay, utcOf, weekdayOf, ymdOf, type Ymd } from "./time.js";
import { appears, fence, injectionLike, norm, plain } from "./untrusted.js";
import { findClock, findDay, findPartOfDay, hourOfDay, prep } from "./when.js";

/*
 * The user's own calendar, read from one of two places:
 *
 *  (a) an iCalendar feed, when the user has saved one in the vault as a secret called "Calendar feed" (the private
 *      .ics address a calendar gives out). It is fetched over https only, read by ics.ts, and its address never
 *      leaves the vault call that hands it over — it is not logged, shown, spoken or kept.
 *  (b) otherwise the web calendar page in the user's browser (Google Calendar's day or agenda view, Outlook's day or
 *      week view): the page's text goes to a model fenced as data, and an event it reports is kept only if its
 *      title is on the page.
 *
 * Either way the answer is put together here: "You have two things tomorrow: stand-up at 9 AM, and lunch with Dana
 * at 12:30 PM." An event's title is written by whoever sent the invitation — it is said as a title, cut to a few
 * plain words, and never as anything to do.
 */

export interface CalEvent {
  title: string;
  where: string;
  start: number;
  end: number;
  allDay: boolean;
  /** Marked free in the feed (a birthday, a note): it doesn't make the user busy. */
  free: boolean;
}

export type Fail = { ok: false; say: string };
const fail = (say: string): Fail => ({ ok: false, say });

export const calendarTiming = { loadMs: 7_000, stepMs: 5_000, settleMs: 600, modelMs: 8_000, feedMs: 6_000 };
const FEED_MAX_BYTES = 5_000_000;
const FEED_KEEP_MS = 60_000;
const PAGE_CHARS = 8_000;

// ─── (a) The feed ─────────────────────────────────────────────────────────────

/** Hands the feed's address to `use` and returns what `use` made of it; null when no feed is saved (or the vault isn't there). */
export type FeedUrlSource = <T>(use: (url: string) => Promise<T>) => Promise<T | null>;

/**
 * The vault's "Calendar feed" secret. Only listItems() and useSecret() are used; a vault that is missing, locked or
 * shut — or that refuses to hand the value out — is the same as no feed.
 */
const vaultFeed: FeedUrlSource = async (use) => {
  try {
    const vault = await import("../../vault/index.js");
    const item = vault.listItems("secret").find((m) => m.label.trim().toLowerCase() === "calendar feed");
    if (!item) return null;
    return await vault.useSecret(item.id, "read the calendar feed", async (secret) => use("value" in secret && typeof secret.value === "string" ? secret.value : ""));
  } catch {
    return null;
  }
};

let feedSource: FeedUrlSource = vaultFeed;
let kept: { at: number; calendar: IcsCalendar } | null = null;

/** Tests: where the feed's address comes from (null puts the vault back). Clears what was fetched. */
export function setCalendarFeedSource(source: FeedUrlSource | null): void {
  feedSource = source ?? vaultFeed;
  kept = null;
}

export type FeedProblem = "not-https" | "unreachable" | "http" | "too-large" | "not-a-calendar";
export type Feed = { kind: "none" } | { kind: "failed"; why: FeedProblem } | { kind: "ok"; calendar: IcsCalendar };

/**
 * Fetch the feed: https only — a "webcal:" address is the same feed over https — with redirects followed by hand so
 * that none leads off https, a time limit and a size limit. What comes back holds events, never the address.
 */
async function fetchFeed(address: string): Promise<Feed> {
  let current = address.trim().replace(/^webcals?:\/\//i, "https://");
  for (let hop = 0; hop < 4; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return { kind: "failed", why: "unreachable" };
    }
    if (url.protocol !== "https:") return { kind: "failed", why: "not-https" };
    let res: Response;
    try {
      res = await fetch(url.href, { redirect: "manual", headers: { accept: "text/calendar, text/plain;q=0.8" }, signal: AbortSignal.timeout(calendarTiming.feedMs) });
    } catch {
      return { kind: "failed", why: "unreachable" };
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { kind: "failed", why: "unreachable" };
      try {
        current = new URL(next, url).href;
      } catch {
        return { kind: "failed", why: "unreachable" };
      }
      continue;
    }
    if (!res.ok) return { kind: "failed", why: "http" };
    if (Number(res.headers.get("content-length") ?? 0) > FEED_MAX_BYTES) return { kind: "failed", why: "too-large" };
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { kind: "failed", why: "unreachable" };
    }
    if (text.length > FEED_MAX_BYTES) return { kind: "failed", why: "too-large" };
    if (!/^\s*BEGIN:VCALENDAR/i.test(text)) return { kind: "failed", why: "not-a-calendar" };
    return { kind: "ok", calendar: parseIcs(text) };
  }
  return { kind: "failed", why: "unreachable" };
}

/** The saved feed, read (and kept for a minute, so a question and its follow-up don't fetch twice). */
export async function loadFeed(): Promise<Feed> {
  if (kept && assistNow() - kept.at < FEED_KEEP_MS && assistNow() >= kept.at) return { kind: "ok", calendar: kept.calendar };
  const feed = await feedSource((url) => fetchFeed(url));
  if (!feed) return { kind: "none" };
  if (feed.kind === "ok") kept = { at: assistNow(), calendar: feed.calendar };
  else console.warn(`[calendar] the calendar feed couldn't be read (${feed.kind === "failed" ? feed.why : "none"})`);
  return feed;
}

function feedEvents(calendar: IcsCalendar, from: number, to: number, zone: string): CalEvent[] {
  return occurrences(calendar, from, to, zone).map((o) => ({ title: o.title, where: o.location, start: o.start, end: o.end, allDay: o.allDay, free: o.free }));
}

/** Events on the user's calendar that overlap a time, when a feed is there to ask (null when there is none). */
export async function clashesWith(start: number, end: number, zone: string): Promise<CalEvent[] | null> {
  const feed = await loadFeed();
  if (feed.kind !== "ok") return null;
  return feedEvents(feed.calendar, start, end, zone).filter((e) => !e.allDay && !e.free && e.start < end && e.end > start);
}

// ─── (b) The calendar page ────────────────────────────────────────────────────

export type CalendarProvider = "google" | "outlook" | "other";

export function calendarProvider(url: string): CalendarProvider {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "calendar.google.com") return "google";
    if (/^outlook\.(?:live|office|office365)\.com$/.test(host) || host === "outlook.cloud.microsoft") return "outlook";
  } catch {
    /* not a URL */
  }
  return "other";
}

/**
 * The calendar page that shows a day ("day") or the days from one on ("agenda" on Google, the week on Outlook).
 * Outlook's address can't name a date: it shows today's day or week.
 */
export function calendarViewUrl(base: string, day: Ymd, view: "day" | "span"): string {
  const provider = calendarProvider(base);
  if (provider === "google") {
    const root = /^(https:\/\/calendar\.google\.com\/calendar(?:\/u\/\d+)?)(?:\/|$)/.exec(base)?.[1] ?? "https://calendar.google.com/calendar";
    return `${root}/r/${view === "day" ? "day" : "agenda"}/${day.y}/${day.mo}/${day.d}`;
  }
  if (provider === "outlook") {
    const u = new URL(base);
    const account = /^\/calendar\/(\d+)\b/.exec(u.pathname)?.[1] ?? "0";
    return `${u.origin}/calendar/${account}/view/${view === "day" ? "day" : "week"}`;
  }
  return base;
}

const calendarTask = (shown: string, defaultDay: string): string =>
  [
    "You read the text of a web calendar page and report the events it shows. Reply ONLY with JSON:",
    '{"events": [{"title": string, "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM", "all_day": boolean, "where": string}]}',
    `- The page shows ${shown}. date: the day the event is on; when the text doesn't say which day, use ${defaultDay}.`,
    '- start and end on a 24-hour clock ("09:00", "13:30"); end is "" when the text gives none. all_day: true for an event with no time (then start and end are "").',
    '- Copy title and where exactly as they appear in the text (where: "" when there is none). At most 40 events, in the order shown.',
    "- Leave out hour labels, the small month calendar, buttons, menus and anything that is not an event. Never add an event that is not in the text.",
  ].join("\n");

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function clockOf(v: unknown): { h: number; mi: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v, 8));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}

function dayOf(v: unknown): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v, 12));
  if (!m) return null;
  const day = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  return day.mo >= 1 && day.mo <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.mo) ? day : null;
}

/** The events a model reported from a calendar page, kept only where the page bears them out and the day was asked about. */
export function validEvents(raw: unknown, pageText: string, from: Ymd, to: Ymd, zone: string): CalEvent[] {
  const page = norm(pageText);
  const list = raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events) ? ((raw as { events: unknown[] }).events as unknown[]) : [];
  const out: CalEvent[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 60)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const title = str(r.title, 200);
    if (!title || !appears(page, title)) continue;
    const day = dayOf(r.date) ?? (daysBetween(from, to) === 0 ? from : null);
    if (!day || daysBetween(from, day) < 0 || daysBetween(day, to) < 0) continue;
    const where = str(r.where, 200);
    const start = clockOf(r.start);
    let event: CalEvent;
    if (r.all_day === true || !start) {
      if (r.all_day !== true) continue; // neither a time nor "all day": not something to place
      event = { title, where: where && appears(page, where) ? where : "", start: dayStartOf(day, zone), end: dayStartOf(addDays(day, 1), zone), allDay: true, free: true };
    } else {
      const begins = utcOf({ ...day, h: start.h, mi: start.mi, s: 0 }, zone);
      const end = clockOf(r.end);
      let ends = end ? utcOf({ ...day, h: end.h, mi: end.mi, s: 0 }, zone) : begins;
      if (ends < begins) ends = end && end.h < start.h ? ends + DAY_MS : begins;
      event = { title, where: where && appears(page, where) ? where : "", start: begins, end: ends, allDay: false, free: false };
    }
    const key = `${norm(title)}|${event.start}|${event.allDay}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
    if (out.length >= 40) break;
  }
  return out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
}

const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const loaded = (s: PortSnapshot): boolean => s.text.trim().length >= 40 || s.controls.length >= 6;

/** Whether a tab is showing the calendar view wanted: on Google the same view and date (whichever account path it sits under), elsewhere the same site. */
function samePage(url: string, wanted: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(wanted);
    if (a.hostname !== b.hostname) return false;
    if (calendarProvider(wanted) !== "google") return true;
    const view = (u: URL) => u.pathname.replace(/^\/calendar(?:\/u\/\d+)?/, "").replace(/\/+$/, "");
    return view(a) === view(b);
  } catch {
    return false;
  }
}

function signInWall(s: PortSnapshot): boolean {
  try {
    if (/^(?:accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com)$/.test(new URL(s.url).hostname.toLowerCase())) return true;
  } catch {
    /* not a URL */
  }
  return /^sign in\b/i.test(s.title.trim()) && s.text.length < 1500;
}

/** Read the days from `from` to `to` off the calendar page in the user's browser. */
async function pageEvents(port: BrowserPort, from: Ymd, to: Ymd, today: Ymd, zone: string): Promise<{ ok: true; events: CalEvent[] } | Fail> {
  if (!live.mordiem) return fail("Reading your calendar page needs a text model — add a Mordiem key in Settings, under Models.");
  const base = getEndpoints().calendarUrl;
  const provider = calendarProvider(base);
  const oneDay = daysBetween(from, to) === 0;
  // Outlook's page shows today's day or this week, whatever is asked: a day it can't be showing isn't guessed at.
  if (provider === "outlook" && (daysBetween(today, from) < -6 || daysBetween(today, to) > 6)) return fail("I can only read the week your Outlook calendar page is showing. Open that day there and ask me again.");
  const wanted = calendarViewUrl(base, from, oneDay && (provider !== "outlook" || daysBetween(today, from) === 0) ? "day" : "span");
  let tabId: number;
  let snap: PortSnapshot | null;
  try {
    const opened = await port.open(wanted, { reuse: true });
    tabId = opened.tabId;
    const path = (u: string) => u.replace(/[?#].*$/, "").replace(/\/+$/, "");
    if (opened.reused && path(opened.url) !== path(wanted)) await port.navigate(tabId, wanted);
    snap = await port.waitFor(tabId, (s) => loaded(s) && (provider === "other" || samePage(s.url, wanted) || signInWall(s)), opened.reused ? calendarTiming.stepMs : calendarTiming.loadMs);
  } catch (err) {
    return fail(`I couldn't open your calendar page: ${(err as Error).message.replace(/\s+/g, " ").slice(0, 120)}.`);
  }
  if (!snap) return fail("Your calendar page didn't load in time. Try again in a moment.");
  if (signInWall(snap)) return fail("Your calendar page is asking you to sign in. Sign in there, then ask me again.");
  if (calendarTiming.settleMs > 0) {
    // The address changes before the day is drawn: give it a moment, then read what is there.
    await pause(calendarTiming.settleMs);
    try {
      snap = await port.snapshot(tabId);
    } catch {
      /* keep the one we have */
    }
  }
  const shown = oneDay ? `${longDay(from)}, ${from.y}` : `the days from ${longDay(from)} to ${longDay(to)}, ${to.y}`;
  const data = fence(`Page title: ${snap.title}\n${snap.text}`, PAGE_CHARS);
  const raw = await jsonChat<{ events?: unknown }>(`${calendarTask(shown, isoDay(from))}\n${data.rule}`, data.block, { model: getEndpoints().fastModel, temperature: 0, maxTokens: 1300, timeoutMs: calendarTiming.modelMs });
  if (!raw) return fail("I couldn't read your calendar page just now. Try again in a moment.");
  return { ok: true, events: validEvents(raw, snap.text, from, to, zone) };
}

// ─── What was asked ───────────────────────────────────────────────────────────

export type CalendarAsk =
  | { kind: "day"; day: Ymd }
  | { kind: "range"; from: Ymd; to: Ymd; label: string }
  /** "Am I free at three (tomorrow)?" */
  | { kind: "free"; day: Ymd; h: number; mi: number }
  /** "When is my next meeting?" */
  | { kind: "next" };

/** What "what's on my calendar tomorrow", "this week", "am I free at three", "when's my next meeting" ask for. */
export function parseCalendarAsk(words: string, today: Ymd): CalendarAsk {
  const t = prep(tidy(words));
  if (/\b(?:next|upcoming) (?:meeting|event|appointment|call|thing|one)\b|\bwhat(?:'s| is| do i have| have i got) (?:coming )?(?:up )?next\b/.test(t)) return { kind: "next" };
  const wd = weekdayOf(today);
  if (/\bnext week\b/.test(t)) {
    const monday = addDays(today, ((8 - wd) % 7) || 7);
    return { kind: "range", from: monday, to: addDays(monday, 6), label: "next week" };
  }
  if (/\b(?:this|the|rest of (?:the|this)) week\b(?!end)/.test(t)) return { kind: "range", from: today, to: addDays(today, (7 - wd) % 7), label: "this week" };
  if (/\b(?:this|the|over the|next) weekend\b/.test(t)) {
    const saturday = wd === 0 ? today : addDays(today, 6 - wd);
    return { kind: "range", from: saturday, to: wd === 0 ? today : addDays(saturday, 1), label: "this weekend" };
  }
  const day = findDay(t, today)?.day ?? today;
  const asksFree = /\b(?:am i|are we|will i be|i'm|is my (?:calendar|schedule|day))\s+(?:free|busy|available|open|booked|clear)\b|\bdo i have (?:anything|something|a meeting|time|plans)\b|\b(?:free|busy|anything|available) (?:at|around)\b/.test(t);
  const clock = asksFree ? findClock(t) : null;
  if (clock) return { kind: "free", day, h: clock.fixed ? clock.h : hourOfDay(clock.h, { part: findPartOfDay(t)?.part ?? null }), mi: clock.mi };
  return { kind: "day", day };
}

/** The stretch of time an ask covers. */
function windowOf(ask: CalendarAsk, now: number, zone: string): { from: Ymd; to: Ymd; start: number; end: number } {
  const today = ymdOf(now, zone);
  if (ask.kind === "next") return { from: today, to: addDays(today, 13), start: now, end: dayStartOf(addDays(today, 14), zone) };
  const from = ask.kind === "range" ? ask.from : ask.day;
  const to = ask.kind === "range" ? ask.to : ask.day;
  return { from, to, start: dayStartOf(from, zone), end: dayStartOf(addDays(to, 1), zone) };
}

export interface CalendarAnswer {
  events: CalEvent[];
  source: "feed" | "page";
  /** Repeating events in the feed whose rule couldn't be read (only their first date counts). */
  unread: number;
}

/**
 * The events an ask is about: from the feed when one is saved and can be read, otherwise from the calendar page —
 * which needs the browser extension.
 */
export async function calendarEvents(port: BrowserPort, ask: CalendarAsk, now: number, zone: string): Promise<({ ok: true } & CalendarAnswer) | Fail> {
  const w = windowOf(ask, now, zone);
  const feed = await loadFeed();
  if (feed.kind === "ok") return { ok: true, events: feedEvents(feed.calendar, w.start, w.end, zone), source: "feed", unread: feed.calendar.unread };
  if (!port.connected()) {
    return fail(
      feed.kind === "failed"
        ? "I couldn't read your calendar feed, and the browser extension isn't connected to read the calendar page instead — it's in Settings, under Browser."
        : "I need the browser extension connected to read your calendar — it's in Settings, under Browser.",
    );
  }
  const today = ymdOf(now, zone);
  // From the page, "next" looks at today and tomorrow: one page load, not two weeks of them.
  const to = ask.kind === "next" ? addDays(today, 1) : w.to;
  const page = await pageEvents(port, w.from, to, today, zone);
  if (!page.ok) return page;
  return { ok: true, events: page.events.filter((e) => e.end > w.start || e.start >= w.start), source: "page", unread: 0 };
}

// ─── What is said ─────────────────────────────────────────────────────────────

const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);

/** An event's title as said: a few plain words — and never one that reads like orders. */
export function titleSaid(title: string): string {
  const t = plain(title, 8, 60);
  if (!t) return "an untitled event";
  return injectionLike(title) || injectionLike(t) ? "an event whose title reads like instructions" : t;
}

const timed = (e: CalEvent, zone: string): string => (e.allDay ? `${titleSaid(e.title)} all day` : `${titleSaid(e.title)} at ${fmtClock(e.start, zone)}`);
const things = (n: number): string => `${n} thing${n === 1 ? "" : "s"}`;

/** One or two sentences answering the ask from the events found. */
export function calendarLine(ask: CalendarAsk, answer: CalendarAnswer, now: number, zone: string, card: number | null): string {
  const today = ymdOf(now, zone);
  const events = answer.events;
  const onCard = card !== null && events.length ? ` ${events.length === 1 ? "It's" : "They're"} on card ${card}.` : "";
  if (ask.kind === "next") {
    const next = events.find((e) => !e.allDay && e.start > now);
    if (!next) return answer.source === "feed" ? "Nothing coming up on your calendar in the next two weeks." : "Nothing else on your calendar today or tomorrow that I can see.";
    const day = ymdOf(next.start, zone);
    return `Your next one is ${titleSaid(next.title)}, ${relDay(day, today)} at ${fmtClock(next.start, zone)}.`;
  }
  if (ask.kind === "free") {
    const at = utcOf({ ...ask.day, h: ask.h, mi: ask.mi, s: 0 }, zone);
    const when = `${fmtClock(at, zone)} ${onDay(ask.day, today)}`;
    const busy = events.filter((e) => !e.allDay && !e.free && (e.end > e.start ? e.start <= at && e.end > at : e.start === at));
    if (busy.length) {
      const first = busy[0]!;
      const span = first.end > first.start ? `from ${fmtSpan(first.start, first.end, zone)}` : `at ${fmtClock(first.start, zone)}`;
      return `No — you have ${titleSaid(first.title)} ${span}${busy.length > 1 ? `, and ${busy.length - 1} more then` : ""}.`;
    }
    const later = events.find((e) => !e.allDay && e.start > at);
    return `Yes, you're free at ${when}${later ? ` — your next thing is ${titleSaid(later.title)} at ${fmtClock(later.start, zone)}` : " — nothing after that on that day"}.`;
  }
  if (ask.kind === "range") {
    if (!events.length) return `Nothing on your calendar ${ask.label}.`;
    const next = events.find((e) => e.end > now) ?? events[0]!;
    const day = ymdOf(next.start, zone);
    return `You have ${things(events.length)} ${ask.label}. ${next.start > now || next.allDay ? "Next up" : "Right now"}: ${titleSaid(next.title)}, ${relDay(day, today)}${next.allDay ? ", all day" : ` at ${fmtClock(next.start, zone)}`}.${onCard}`;
  }
  const when = onDay(ask.day, today);
  if (!events.length) return `Nothing on your calendar ${when}.`;
  if (events.length <= 3) return `You have ${things(events.length)} ${when}: ${list(events.map((e) => timed(e, zone)))}.${onCard}`;
  return `You have ${things(events.length)} ${when}, starting with ${timed(events[0]!, zone)} and ending with ${timed(events[events.length - 1]!, zone)}.${onCard}`;
}

/** The calendar card: the events of the day (or of each day asked about), with their times. */
export function calendarCard(ask: CalendarAsk, answer: CalendarAnswer, line: string, now: number, zone: string): CardContent {
  const today = ymdOf(now, zone);
  const row = (e: CalEvent) => ({
    when: e.allDay ? "All day" : e.end > e.start ? fmtSpan(e.start, e.end, zone) : fmtClock(e.start, zone),
    title: plain(e.title, 14, 90) || "(untitled)",
    ...(e.where ? { detail: plain(e.where, 12, 80) } : {}),
  });
  const byDay = new Map<string, { day: Ymd; events: CalEvent[] }>();
  for (const e of answer.events) {
    const day = ymdOf(e.start, zone);
    const key = isoDay(day);
    const group = byDay.get(key) ?? { day, events: [] };
    group.events.push(e);
    byDay.set(key, group);
  }
  const blocks: Block[] = [...byDay.values()].slice(0, 8).map((g) => ({ kind: "schedule" as const, title: `${relDay(g.day, today).replace(/^./, (c) => c.toUpperCase())} · ${longDay(g.day)}`, items: g.events.slice(0, 20).map(row) }));
  if (!blocks.length) blocks.push({ kind: "note", tone: "info", text: "Nothing on the calendar for this." });
  if (answer.unread) blocks.push({ kind: "note", tone: "info", text: `${answer.unread} repeating event${answer.unread === 1 ? " uses" : "s use"} a rule I can't read, so only ${answer.unread === 1 ? "its" : "their"} first date is counted.` });
  const title = ask.kind === "range" ? ask.label.replace(/^./, (c) => c.toUpperCase()) : ask.kind === "next" ? "Coming up" : relDay(ask.day, today).replace(/^./, (c) => c.toUpperCase());
  return {
    title: `Calendar · ${title}`,
    subtitle: ask.kind === "day" || ask.kind === "free" ? longDay(ask.day) : ask.kind === "range" ? `${longDay(ask.from)} to ${longDay(ask.to)}` : "The next two weeks",
    summary: line,
    meta: [
      { label: "Events", value: String(answer.events.length) },
      { label: "From", value: answer.source === "feed" ? "your calendar feed" : "your calendar page" },
    ],
    blocks,
  };
}
