import type { BrowserPort, PortControl, PortSnapshot } from "./browser-port.js";
import { calendarProvider } from "./calendar.js";
import type { CardContent } from "./cards.js";
import { tidy } from "./mail-words.js";
import { addDays, assistNow, clockText, durationText, fmtClock, fmtSpan, longDay, onDay, relDay, utcOf, ymdOf, type Ymd } from "./time.js";
import { emailsIn, plain } from "./untrusted.js";
import { PART_HOUR, blank, findClock, findDay, findDelay, findDuration, findPartOfDay, findRange, hourOfDay, prep, type SaidClock, type Span } from "./when.js";

/*
 * A new event on the user's calendar: read what they asked for ("schedule a meeting with Sam tomorrow at three for
 * half an hour about the roadmap", "put lunch with Dana on Friday at noon", "block two hours for writing on Monday
 * morning"), open the calendar's own new-event form filled in — Google Calendar's event-template link, Outlook on the
 * web's compose link — and, only after the user's yes, press that form's Save.
 *
 * The request is read by rule, not by a model: a title, a day, a start, a length (30 minutes unless said; an hour
 * for a meal), the people it is with. A time that has passed is refused and a time that isn't there is asked for —
 * nothing is guessed except the usual hour of "Monday morning", which is said back before anything is saved.
 */

export interface MeetingAsk {
  title: string;
  start: number;
  end: number;
  /** The people it is with, as said ("Sam", "Dana Park"): each needs an address to be invited. */
  guestNames: string[];
  /** Addresses said outright in the request. */
  guestAddresses: string[];
  note: string;
  /** A repeat was asked for ("every Monday"): the form is filled in for the first time only, and that is said. */
  repeats: boolean;
}

export type MeetingParse = ({ ok: true } & MeetingAsk) | { ok: false; ask: string; why: "no-time" | "past" };

const MEAL = /\b(breakfast|brunch|lunch|dinner|supper)\b/;
/** Kinds that say nothing about what it is: the subject, when one was given, names the event instead. */
const GENERIC_KIND = /^(?:meeting|meet|event|time|something|session|appointment|slot|a slot|thing)?$/;
const NOT_A_GUEST = /^(?:me|us|him|her|them|you|it|everyone|everybody|people|folks|friends|family|clients?|customers?|(?:the|my|our|a|an|some)\s+.+)$/i;

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const nameCase = (s: string): string =>
  s
    .split(/\s+/)
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** A clock time said without am / pm, as the hour of the day. */
function hourFor(c: SaidClock, hint: Parameters<typeof hourOfDay>[1]): number {
  return c.fixed ? c.h : hourOfDay(c.h, hint);
}

/**
 * Only the time words of a sentence, in the order said ("uh, put it tomorrow at three I think" → "tomorrow at
 * three"; a bare "three thirty" in answer to "what time?" → "at three thirty") — "" when there are none.
 */
export function whenWords(words: string, today: Ymd): string {
  const t = prep(tidy(words)).replace(/[?!.]+$/, "");
  const range = findRange(t);
  const found: { at: number; said: string }[] = [];
  const add = (s: Span | null) => {
    if (s && s.end > s.start) found.push({ at: s.start, said: t.slice(s.start, s.end) });
  };
  add(range);
  const clock = range ? null : findClock(t);
  add(clock);
  if (!range && !clock) {
    // An answer that starts with the time and nothing before it: "three", "three thirty", "9".
    const led = findClock(`at ${t}`);
    if (led && led.start === 0) found.push({ at: 0, said: `at ${t}`.slice(0, led.end) });
  }
  add(findDay(t, today));
  add(findPartOfDay(t));
  add(findDuration(t));
  if (!range && !clock) add(findDelay(t));
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.said.trim())
    .join(" ");
}

/**
 * Read a request for a new event. `now` and `zone` place "tomorrow" and "at three" on the user's own clock.
 * Not ok: the question to ask instead ("What time tomorrow?", "That time has already passed — when should it be?").
 */
export function parseMeeting(words: string, now: number, zone: string): MeetingParse {
  const said = tidy(words).replace(/[?!]+$/, "");
  const lower = prep(said);
  let t = lower;
  const today = ymdOf(now, zone);
  // The readers work on the lower-case sentence; what is kept as words (a title, a name) is cut from the sentence
  // as it was said — the two are the same text letter for letter, and blanking never changes a length.
  const asSaid = (start: number, end: number): string => (said.length === lower.length ? said : lower).slice(start, end);
  /** A pattern's last group, as it was said (every pattern here ends with the group it keeps). */
  const kept = (m: RegExpExecArray): string => asSaid(m.index + m[0].length - m[1]!.length, m.index + m[0].length);

  // Said outright, to the end of the sentence: a note, then a title. Taken out first, so their words aren't read as times.
  let note = "";
  // "…with a note to bring the slides", "…and add a note saying the dial-in follows", "…note: bring slides".
  const noteAt = /(?:,\s*)?\b(?:(?:and|with)\s+)?(?:(?:add|put)\s+)?(?:(?:a|the)\s+)?(?:note|description)\s*(?:that says|saying|to|that|:)\s+(.+)$/.exec(t);
  if (noteAt) {
    note = kept(noteAt).trim();
    t = blank(t, [{ start: noteAt.index, end: t.length }]);
  }
  let called = "";
  const calledAt = /\b(?:called|titled|named|labell?ed)\s+(.+?)(?=$|[,.;]|\s+(?:on|at|for|with|from|tomorrow|today|tonight|next|this|in)\b)/.exec(t);
  if (calledAt) {
    called = kept(calledAt).trim();
    t = blank(t, [{ start: calledAt.index, end: calledAt.index + calledAt[0].length }]);
  }
  // Addresses said outright are guests; they come out before anything reads their dots as the end of a phrase.
  const guestAddresses = [...new Set(emailsIn(t).map((a) => a.toLowerCase()))];
  for (const address of guestAddresses) {
    const at = t.indexOf(address);
    if (at < 0) continue;
    const lead = /(?:\bwith\s+|\band\s+|,\s*)$/.exec(t.slice(0, at));
    t = blank(t, [{ start: lead ? lead.index : at, end: at + address.length }]);
  }

  // When, and for how long.
  const range = findRange(t);
  const clock = range ? null : findClock(t);
  const day = findDay(t, today);
  const part = findPartOfDay(t);
  const length = findDuration(t);
  const delay = !range && !clock ? findDelay(t) : null;
  const meal = MEAL.exec(t)?.[1];
  const hint = { part: part?.part ?? null, meal: meal === "breakfast" ? ("breakfast" as const) : meal === "dinner" || meal === "supper" ? ("dinner" as const) : meal ? ("lunch" as const) : null };
  const spans: (Span | null)[] = [range, clock, day, part, length, delay];
  const rest = blank(t, spans);

  let startDay: Ymd | null = day?.day ?? null;
  let h: number | null = null;
  let mi = 0;
  let start: number | null = null;
  let minutes = length?.minutes ?? (meal ? 60 : 30);
  if (range) {
    h = hourFor(range.from, hint);
    mi = range.from.mi;
    const from = h * 60 + mi;
    // The end as said, or — with no am / pm — the first time after the start it can mean.
    const ends = range.to.fixed ? [range.to.h * 60 + range.to.mi] : [(range.to.h % 12) * 60 + range.to.mi, (range.to.h % 12) * 60 + range.to.mi + 720];
    const to = ends.find((m) => m > from);
    if (to !== undefined) minutes = to - from;
  } else if (clock) {
    h = hourFor(clock, hint);
    mi = clock.mi;
  } else if (delay) {
    // "In an hour": from now, on the next five minutes.
    start = Math.ceil((now + delay.minutes * 60_000) / 300_000) * 300_000;
  } else if (part && (day || part.part === "night" || /\bthis (?:morning|afternoon|evening)\b/.test(t))) {
    h = PART_HOUR[part.part];
  }

  if (start === null) {
    if (h === null) {
      const allDay = /\b(?:all day|the whole day|all-day)\b/.test(t);
      return { ok: false, why: "no-time", ask: allDay ? "I can't fill in an all-day event yet — what time should it start?" : startDay ? `What time ${onDay(startDay, today)}?` : "When should it be?" };
    }
    startDay ??= today;
    start = utcOf({ ...startDay, h, mi, s: 0 }, zone);
    // A weekday named on that very day, once its time has gone by, is next week's.
    if (start <= now && day?.weekday) {
      startDay = addDays(startDay, 7);
      start = utcOf({ ...startDay, h, mi, s: 0 }, zone);
    }
    if (start <= now) {
      const when = `${clockText(h, mi)} ${relDay(startDay, today)}`;
      return { ok: false, why: "past", ask: day ? `${cap(when)} has already passed — when should it be?` : `${cap(when)} has already passed — which day should it be?` };
    }
  }
  if (!(minutes >= 5) || minutes > 24 * 60) minutes = meal ? 60 : 30;

  // What it is about, who it is with, and what kind of thing it is — from what is left once the time words are gone.
  // (The blanked stretches are runs of spaces: a phrase ends at one.)
  let left = rest;
  let topic = "";
  const topicAt = /\b(?:about|regarding|re:|to (?:discuss|talk about|talk through|go over|go through|review|plan|chat about|catch up on|brainstorm))\s+(.+?)(?=$|[,.;]|\s{2,}|\s+with\s)/.exec(left);
  if (topicAt) {
    topic = kept(topicAt).trim().replace(/\s+(?:for|on|at|in|from|by|and)$/i, "");
    left = blank(left, [{ start: topicAt.index, end: topicAt.index + topicAt[0].length }]);
  }
  const guestNames: string[] = [];
  let withSaid = "";
  const withAt = /\bwith\s+(.+?)(?=$|[.;]|\s{2,}|\s+(?:about|regarding|on my|in my|to my|on the calendar|to (?:discuss|talk|go over|go through|review|plan|chat|catch up|brainstorm|work on))\b)/.exec(left);
  if (withAt) {
    const people = kept(withAt)
      // (A word left dangling where the day was taken out — "with Priya for [tomorrow]" — is not part of a name.)
      .replace(/(?:\s+(?:for|on|at|in|from|by|and))+$/i, "")
      .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
      .map((p) => p.trim().replace(/[,.]+$/, ""))
      .filter(Boolean);
    const named: string[] = [];
    for (const p of people) {
      if (NOT_A_GUEST.test(p) || p.split(/\s+/).length > 3) named.push(p);
      else {
        guestNames.push(nameCase(p));
        named.push(nameCase(p));
      }
    }
    withSaid = list(named);
    left = blank(left, [{ start: withAt.index, end: withAt.index + withAt[0].length }]);
  }
  let kind = left
    .replace(/\b(?:on|in|to|into) (?:my|the|our) (?:calendar|schedule|diary)\b/g, " ")
    .replace(/\b(?:for me|please)\b/g, " ")
    .replace(/[,.;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:let'?s|i'd like to|i want to|i need to|we need to|we should|can we|could we|go ahead and)\s+)+/, "")
    .replace(/^(?:schedule|set up|setup|book|put|add|create|make|arrange|plan|organi[sz]e|block(?: out| off)?|pencil in|slot in|i have|i've got|there's|new)\b\s*/, "")
    .replace(/^(?:me |us )?(?:an? |the |some |my |our )?(?:new )?/, "")
    .replace(/\b(?:every|each)\b\s*/g, "")
    .replace(/\b(?:weekly|daily|recurring|repeating)\b\s*/g, "");
  // Words left dangling where a time or a name was taken out ("check-in for", "for writing", "to work on the deck").
  for (let i = 0; i < 3; i++)
    kind = kind
      .replace(/(?:^|\s+)(?:for|on|at|in|from|to|with|and|of)$/, "")
      .replace(/^(?:time |a slot |some time )?(?:for|to)\s+/, "")
      .trim();
  if (!withSaid && guestAddresses.length) withSaid = list(guestAddresses.map((a) => nameCase(a.split("@")[0]!.replace(/[._-]+/g, " "))));
  // (The kind, with the capitals it was said with — "iOS review" — where it stands in the sentence as one piece.)
  const kindAt = kind ? lower.indexOf(kind) : -1;
  if (kindAt >= 0) kind = asSaid(kindAt, kindAt + kind.length);

  const subject = topic.replace(/^(?:the|our|my|a|an)\s+/i, "");
  let title: string;
  if (called) title = cap(called);
  else if (subject && GENERIC_KIND.test(kind)) title = `${cap(subject)}${withSaid ? ` with ${withSaid}` : ""}`;
  else {
    title = `${cap(kind || "Meeting")}${withSaid ? ` with ${withSaid}` : ""}`;
    if (subject && !note) note = `About ${subject}.`;
  }
  return {
    ok: true,
    title: plain(title, 12, 80) || "Meeting",
    start,
    end: start + minutes * 60_000,
    guestNames,
    guestAddresses,
    note: note ? plain(/[.!?]$/.test(note) ? cap(note) : `${cap(note)}.`, 40, 300) : "",
    repeats: /\b(?:every|each|weekly|daily|recurring|repeating)\b/.test(rest),
  };
}

// ─── The calendar's own new-event form ────────────────────────────────────────

export interface MeetingDraft {
  title: string;
  start: number;
  end: number;
  guests: { name: string; email: string }[];
  note: string;
}

const enc = encodeURIComponent;

/** Google Calendar's event-template link: the form opens with the title, the time, the details and the guests filled in. */
export function googleEventUrl(m: MeetingDraft, calendarUrl: string, zone: string): string {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  // (A second or third signed-in account has its own path; the first is the plain link.)
  const account = /\/calendar\/u\/(\d+)(?:\/|$)/.exec(calendarUrl)?.[1];
  const root = account && account !== "0" ? `https://calendar.google.com/calendar/u/${account}/render` : "https://calendar.google.com/calendar/render";
  const parts = [
    "action=TEMPLATE",
    `text=${enc(m.title)}`,
    `dates=${stamp(m.start)}/${stamp(m.end)}`,
    m.note ? `details=${enc(m.note)}` : "",
    m.guests.length ? `add=${m.guests.map((g) => enc(g.email)).join(",")}` : "",
    `ctz=${enc(zone)}`,
  ];
  return `${root}?${parts.filter(Boolean).join("&")}`;
}

/** Outlook on the web's compose link for a new event. */
export function outlookEventUrl(m: MeetingDraft, calendarUrl: string): string {
  const u = new URL(calendarUrl);
  const account = /^\/calendar\/(\d+)\b/.exec(u.pathname)?.[1] ?? "0";
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const parts = [
    `path=${enc("/calendar/action/compose")}`,
    "rru=addevent",
    `subject=${enc(m.title)}`,
    `startdt=${enc(stamp(m.start))}`,
    `enddt=${enc(stamp(m.end))}`,
    m.note ? `body=${enc(m.note)}` : "",
    m.guests.length ? `to=${m.guests.map((g) => enc(g.email)).join(",")}` : "",
  ];
  return `${u.origin}/calendar/${account}/deeplink/compose?${parts.filter(Boolean).join("&")}`;
}

/** The link that opens the user's calendar with this event filled in — null for a calendar that has no such link. */
export function eventFormUrl(m: MeetingDraft, calendarUrl: string, zone: string): string | null {
  const provider = calendarProvider(calendarUrl);
  if (provider === "google") return googleEventUrl(m, calendarUrl, zone);
  if (provider === "outlook") return outlookEventUrl(m, calendarUrl);
  return null;
}

export type Fail = { ok: false; say: string };
const fail = (say: string): Fail => ({ ok: false, say });

export const meetingTiming = { loadMs: 7_000, stepMs: 5_000 };
const FORM_FRESH_MS = 20 * 60_000;

interface OpenForm {
  tabId: number;
  url: string;
  meeting: MeetingDraft;
  at: number;
}

let form: OpenForm | null = null;

/** The event form Trinity filled in that hasn't been saved (within the last twenty minutes). */
export function openEventForm(): OpenForm | null {
  return form && assistNow() - form.at <= FORM_FRESH_MS ? form : null;
}
export function resetMeeting(): void {
  form = null;
}

const SAVE = /^save(?:\s*(?:&|and)\s*close)?$/i;
const SEND = /^send$/i;
const DONT_SEND = /^don[’']?t send$/i;
const button = (controls: PortControl[], name: RegExp): PortControl | null => controls.find((c) => c.role === "button" && !c.disabled && name.test(c.name.trim())) ?? null;

/**
 * The control that saves the form: "Save" — or, when the event has guests and the form offers no Save, "Send"
 * (Outlook's name for saving an event that invites people).
 */
export function saveControl(controls: PortControl[], hasGuests: boolean): { control: PortControl; sendsInvitations: boolean } | null {
  const save = button(controls, SAVE);
  if (save) return { control: save, sendsInvitations: false };
  const send = hasGuests ? button(controls, SEND) : null;
  return send ? { control: send, sendsInvitations: true } : null;
}

const isForm = (url: string): boolean => /\/eventedit\b|[?&]action=TEMPLATE\b|\/deeplink\/compose\b|\/action\/compose\b/i.test(url);

function signInWall(s: PortSnapshot): boolean {
  try {
    if (/^(?:accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com)$/.test(new URL(s.url).hostname.toLowerCase())) return true;
  } catch {
    /* not a URL */
  }
  return /^sign in\b/i.test(s.title.trim()) && s.text.length < 1500;
}

/** Open the calendar's new-event form with the event filled in (a new tab). `ready`: the form and its Save were seen. */
export async function openEventFormFor(port: BrowserPort, m: MeetingDraft, calendarUrl: string, zone: string): Promise<{ ok: true; ready: boolean } | Fail> {
  const url = eventFormUrl(m, calendarUrl, zone);
  if (!url) return fail("I can fill in a new event on Google Calendar or Outlook on the web, and your calendar page is neither. You can change it in Settings.");
  let tabId: number;
  try {
    tabId = (await port.open(url, { reuse: false })).tabId;
  } catch (err) {
    return fail(`I couldn't open your calendar: ${(err as Error).message.replace(/\s+/g, " ").slice(0, 120)}.`);
  }
  const seen = await port.waitFor(tabId, (s) => signInWall(s) || saveControl(s.controls, m.guests.length > 0) !== null, meetingTiming.loadMs);
  if (seen && signInWall(seen)) return fail("Your calendar is asking you to sign in. Sign in there, then ask me again.");
  form = { tabId, url, meeting: m, at: assistNow() };
  return { ok: true, ready: seen !== null };
}

/** Whether the form is still open with something to press, and whether pressing it sends invitations. */
export async function eventFormOnPage(port: BrowserPort): Promise<{ ok: true; meeting: MeetingDraft; sendsInvitations: boolean } | Fail> {
  const open = openEventForm();
  if (!open) return fail("There's no new event of mine waiting to be saved. Tell me what to schedule.");
  try {
    const found = saveControl((await port.snapshot(open.tabId)).controls, open.meeting.guests.length > 0);
    if (found) return { ok: true, meeting: open.meeting, sendsInvitations: found.sendsInvitations };
  } catch {
    /* the tab is gone */
  }
  form = null;
  return fail("The new-event form isn't open any more, so there's nothing for me to save.");
}

export type SaveOutcome =
  /** The page said so ("Event saved"). */
  | { saved: "confirmed" }
  /** Save was pressed and the form closed, with no confirmation shown. */
  | { saved: "closed" }
  /** Save was pressed and the form is still there. */
  | { saved: "unclear" }
  /** The calendar asks whether to email invitations to the guests: nothing more is pressed without another yes. */
  | { saved: "asks-invitations" };

const SAVED = /\bevent (?:saved|created|added)\b|\bsaved to (?:your )?calendar\b|\binvitations? sent\b/i;

function saveSign(s: PortSnapshot, hasGuests: boolean): SaveOutcome["saved"] | "none" {
  if (button(s.controls, DONT_SEND) && button(s.controls, SEND)) return "asks-invitations";
  if (SAVED.test(s.text) || s.controls.some((c) => SAVED.test(c.name))) return "confirmed";
  return !saveControl(s.controls, hasGuests) && !isForm(s.url) ? "closed" : "none";
}

/** Press the form's Save — once — and say what the page showed afterwards. Only ever called from the user's "yes, save". */
export async function pressSave(port: BrowserPort): Promise<{ ok: true; outcome: SaveOutcome; meeting: MeetingDraft } | Fail> {
  const open = openEventForm();
  if (!open) return fail("There's no new event of mine waiting to be saved.");
  const hasGuests = open.meeting.guests.length > 0;
  let snap: PortSnapshot;
  try {
    snap = await port.snapshot(open.tabId);
  } catch {
    form = null;
    return fail("Your calendar tab isn't there any more, so nothing was saved.");
  }
  const found = saveControl(snap.controls, hasGuests);
  if (!found) {
    form = null;
    return fail("I don't see a Save button any more — the form may have been closed. Nothing was saved.");
  }
  const clicked = await port.click(open.tabId, found.control.ref, { approved: found.control.name });
  if (clicked.held) return fail("The browser held the click on Save, so it isn't saved. Press Save in your calendar tab yourself.");
  if (!clicked.ok) {
    form = null;
    return fail("I couldn't press Save, and I can't tell whether it was saved. Check your calendar before trying again.");
  }
  const after = await port.waitFor(open.tabId, (s) => saveSign(s, hasGuests) !== "none", meetingTiming.stepMs);
  const sign = after ? saveSign(after, hasGuests) : "none";
  // The form is done with unless the calendar is waiting on the invitation question.
  if (sign !== "asks-invitations") form = null;
  return { ok: true, outcome: { saved: sign === "none" ? "unclear" : sign }, meeting: open.meeting };
}

/** Answer the calendar's "send invitation emails to the guests?" with the user's yes or no. */
export async function answerInvitations(port: BrowserPort, send: boolean): Promise<{ ok: true; outcome: SaveOutcome; meeting: MeetingDraft } | Fail> {
  const open = openEventForm();
  if (!open) return fail("That event isn't waiting on me any more.");
  form = null;
  let snap: PortSnapshot;
  try {
    snap = await port.snapshot(open.tabId);
  } catch {
    return fail("Your calendar tab isn't there any more. Check your calendar to see whether the event was saved.");
  }
  const control = button(snap.controls, send ? SEND : DONT_SEND);
  if (!control) return fail("The calendar isn't asking about invitations any more. Check your calendar to see whether the event was saved.");
  const clicked = await port.click(open.tabId, control.ref, { approved: control.name });
  if (!clicked.ok) return fail("I couldn't press that, so the calendar is still waiting on its question. Answer it in your calendar tab.");
  const after = await port.waitFor(open.tabId, (s) => saveSign(s, false) === "confirmed" || saveSign(s, false) === "closed", meetingTiming.stepMs);
  const sign = after ? saveSign(after, false) : "none";
  return { ok: true, outcome: { saved: sign === "confirmed" ? "confirmed" : sign === "closed" ? "closed" : "unclear" }, meeting: open.meeting };
}

// ─── What is said ─────────────────────────────────────────────────────────────

/** "tomorrow 3 to 3:30 PM", "Friday 12 to 1 PM", "Monday, November 16 9 to 11 AM". */
export function meetingWhen(m: Pick<MeetingDraft, "start" | "end">, now: number, zone: string): string {
  return `${relDay(ymdOf(m.start, zone), ymdOf(now, zone))} ${fmtSpan(m.start, m.end, zone)}`;
}

/** The meeting card: what the form holds — and that it isn't saved. */
export function meetingCard(m: MeetingDraft, left: string[], now: number, zone: string, saved = false): CardContent {
  const day = ymdOf(m.start, zone);
  const blocks: CardContent["blocks"] = [];
  if (m.note) blocks.push({ kind: "text", paragraphs: [m.note] });
  if (left.length) blocks.push({ kind: "note", tone: "warning", text: `Not invited — I don't have an address for ${list(left)}.` });
  blocks.push({ kind: "note", tone: "info", text: saved ? "Saved from the form in your calendar tab." : "It's filled in on your calendar's new-event form, not saved. Say “save it” to put it on your calendar." });
  return {
    title: m.title,
    subtitle: saved ? "On your calendar" : "Not saved yet",
    summary: `${m.title}, ${meetingWhen(m, now, zone)}. ${saved ? "Saved." : "Not saved yet."}`,
    meta: [
      { label: "When", value: `${longDay(day)} · ${fmtSpan(m.start, m.end, zone)}` },
      { label: "Length", value: durationText(Math.round((m.end - m.start) / 60_000)) },
      ...(m.guests.length ? [{ label: "Guests", value: m.guests.map((g) => g.email).join(", ") }] : []),
    ],
    blocks,
  };
}

/** What is said once Save was pressed — as much as the page showed, and no more. */
export function savedLine(outcome: SaveOutcome, m: MeetingDraft, now: number, zone: string): string {
  const what = `${m.title}, ${relDay(ymdOf(m.start, zone), ymdOf(now, zone))} at ${fmtClock(m.start, zone)}`;
  if (outcome.saved === "confirmed") return `Saved — your calendar says ${what} is on it.`;
  if (outcome.saved === "closed") return `I pressed Save and the form closed, so ${what} should be on your calendar — the page didn't show a confirmation.`;
  return `I pressed Save, but the form is still showing, so it may not be saved. Have a look at your calendar tab.`;
}
