import type { MemoryStore } from "../../db/memory.js";
import { getEndpoints, live } from "../../settings.js";
import type { Block } from "../content-spec.js";
import { jsonChat } from "../json-chat.js";
import { paragraphs, type CardContent } from "./cards.js";
import { MONTHS, WEEKDAYS, addDays, daysBetween, daysInMonth, weekdayOf, type Ymd } from "./time.js";
import { asksLine, emailsIn, fence, hasLink, injectionLike, isEmail, norm, plain, scrubSpoken } from "./untrusted.js";
import type { InboxView, MailDraft, MailRow, OpenMessage, SendOutcome } from "./webmail.js";

/*
 * The words around email: what the user asked ("did Sam write back", "open the second one", "email Sam that I'll be
 * ten minutes late", "make it shorter"), what Trinity says back — one or two short sentences put together here from
 * rows and names that were checked against the page — and what goes on the cards. The only text a model writes for
 * speech is a message's two-sentence summary (webmail.ts), and the only text one writes for sending is the draft,
 * from the user's own words.
 */

/** The user's sentence without the chatter around it ("hey Trinity, can you … please"). */
export function tidy(words: string): string {
  return words
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:hey|hi|ok(?:ay)?|so|um+|uh+|well|and|also|now|then|please|trinity|alright|all right|yeah|yes|actually)\b[\s,.!]*)+/i, "")
    .replace(/^(?:(?:can|could|would|will) you|i need you to|i'd like you to|i want you to|go ahead and|just)\s+/i, "")
    .replace(/^please\s+/i, "")
    // "…, please." and "…, thanks!" are manners; "drop Lee a line to say thanks" is the message.
    .replace(/[\s,]*\b(?:please|for me)[.!?]*$/i, "")
    .replace(/[,.!?]\s*(?:thanks|thank you)[.!?]*$/i, "")
    .replace(/[\s,]*\bplease[.!?]*$/i, "")
    .trim();
}

const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);
const sentence = (s: string): string => {
  const t = s.trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?…]$/.test(t) ? "" : "."}` : "";
};

// ─── What was asked of the inbox ──────────────────────────────────────────────

export interface MailFilter {
  /** Only unread mail ("any new mail", and a plain "check my email"). */
  unread: boolean;
  /** Who it should be from, as said ("sam", "the bank"). */
  sender: string | null;
  /** What it should be about, as said. */
  topic: string | null;
  /** Only mail from these days. */
  since: { from: Ymd; to: Ymd; label: string } | null;
  /** Asked as "did … write back": the answer starts with yes or not yet. */
  writeBack: boolean;
}

const SENDER_END = String.raw`(?=$|[?.!,]|\s+(?:wr[io]te|written|repl(?:y|ied)|respond(?:ed)?|e-?mail(?:ed)?|get back|got back|sen[dt]|sa(?:y|id)|about|regarding|today|yesterday|this (?:week|morning|afternoon|month)|in (?:my|the)|yet|back|lately|recently|since|or)\b)`;
const SENDER_PATTERNS = [
  // "did Sam write back", "has the bank replied", "did Dana email me" — not "do I have any new email".
  new RegExp(
    String.raw`\b(?:did|has|have)\s+(?!(?:i|we|you|anyone|anybody|someone|any|a|an|some|new|more|unread|my)\b)(.{2,40}?)\s+(?:wr[io]te|written|repl(?:y|ied)|respond(?:ed)?|e-?mailed|e-?mail (?:me|us|back)|g[eo]t(?:ten)? back|sen[dt] (?:me|us|anything|something|an?|the|it)|answer(?:ed)?)\b`,
    "i",
  ),
  new RegExp(String.raw`\b(?:anything|something|any ?mail|any e-?mails?|any messages?|e-?mails?|mail|messages?|heard(?: back)?|hear(?: back)?|word|a reply|a response|news)\s+(?:new\s+)?from\s+(.{2,40}?)${SENDER_END}`, "i"),
];
const NOT_A_SENDER = /^(?:it|that|this|them|him|her|me|us|anyone|anybody|someone|somebody|everyone|people|today|yesterday)$/i;

/** What "check my email" / "did Sam write back" / "anything from the bank this week" asks for. */
export function parseMailAsk(words: string, today: Ymd): MailFilter {
  const said = tidy(words);
  const t = said.toLowerCase();
  let sender: string | null = null;
  for (const re of SENDER_PATTERNS) {
    // (Read from the words as they were said, so a name keeps its capital.)
    const who = re.exec(said)?.[1]?.replace(/^(?:the|my|our|a|an)\s+/i, "").replace(/['’]s$/, "").trim();
    if (who && !NOT_A_SENDER.test(who) && who.split(" ").length <= 4) {
      sender = who;
      break;
    }
  }
  const about = /\b(?:about|regarding|mentioning|to do with)\s+(?:the\s+|my\s+|our\s+)?(.{2,40}?)(?=$|[?.!,]|\s+(?:today|yesterday|this (?:week|morning|afternoon|month)|from|in (?:my|the))\b)/i.exec(said);
  const topic = about?.[1]?.trim() || null;
  let since: MailFilter["since"] = null;
  if (/\b(?:today|this morning|this afternoon|tonight)\b/.test(t)) since = { from: today, to: today, label: "today" };
  else if (/\byesterday\b/.test(t)) since = { from: addDays(today, -1), to: addDays(today, -1), label: "yesterday" };
  else if (/\b(?:this|the past|the last) week\b|\bpast (?:few|couple of) days\b/.test(t)) since = { from: addDays(today, -6), to: today, label: "this week" };
  const unreadSaid = /\bunread\b|\bnew (?:e-?mails?|mail|messages?)\b|\bany(?:thing)? new\b/.test(t);
  return { unread: unreadSaid || (!sender && !topic), sender, topic, since, writeBack: /\b(?:write|wrote|written|get|got|gotten|e-?mail(?:ed)?|repl(?:y|ied)|respond(?:ed)?|answer(?:ed)?)\b[^.?!]{0,12}\bback\b|\b(?:repl(?:y|ied)|respond(?:ed)?|answered|heard back)\b/.test(t) && sender !== null };
}

const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A date with no year in a mail list: this year's, or last year's when that would be in the future. */
function pastDate(mo: number, d: number, year: number | null, today: Ymd): Ymd | null {
  if (mo < 1 || mo > 12 || d < 1) return null;
  const y = year ?? (mo > today.mo || (mo === today.mo && d > today.d) ? today.y - 1 : today.y);
  return d <= daysInMonth(y, mo) ? { y, mo, d } : null;
}

/** The day a list's time stamp names ("9:42 AM" is today, "Yesterday", "Mon", "Nov 8", "11/7", "8 Nov 2025"), or null. */
export function whenDay(when: string, today: Ymd): Ymd | null {
  const t = when.trim().toLowerCase();
  if (!t) return null;
  if (/^(?:today\b|just now|\d+\s*(?:m|min|mins|minutes?|h|hr|hrs|hours?)\b)/.test(t) || /^\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?$/.test(t)) return today;
  if (/^yesterday\b/.test(t)) return addDays(today, -1);
  let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/.exec(t);
  if (m) return pastDate(MONTH_SHORT.indexOf(m[1]!) + 1, Number(m[2]), m[3] ? Number(m[3]) : null, today);
  m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/.exec(t);
  if (m) return pastDate(MONTH_SHORT.indexOf(m[2]!) + 1, Number(m[1]), m[3] ? Number(m[3]) : null, today);
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(t);
  if (m) return pastDate(Number(m[1]), Number(m[2]), m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null, today);
  m = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(t);
  if (m) {
    const back = (weekdayOf(today) - DAY_SHORT.indexOf(m[1]!) + 7) % 7 || 7;
    return addDays(today, -back);
  }
  return null;
}

const wordsOf = (said: string): string[] =>
  norm(said)
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 2 && !/^(?:the|my|our|an|and|of|from|about|one|e-?mail|message)$/.test(w));

/** The rows a filter keeps, in the order the page listed them. */
export function filterRows(rows: MailRow[], f: MailFilter, today: Ymd): MailRow[] {
  const senderWords = f.sender ? wordsOf(f.sender) : [];
  const topicWords = f.topic ? wordsOf(f.topic) : [];
  const anyKnown = rows.some((r) => r.unread !== null);
  return rows.filter((r) => {
    if (senderWords.length && !senderWords.every((w) => norm(r.from).includes(w))) return false;
    if (topicWords.length && !topicWords.every((w) => norm(`${r.subject} ${r.snippet}`).includes(w))) return false;
    if (f.since) {
      const day = whenDay(r.when, today);
      if (!day || daysBetween(f.since.from, day) < 0 || daysBetween(day, f.since.to) < 0) return false;
    }
    // "Unread" narrows the list only where the page says which are; otherwise the newest stand in (and the line says so).
    if (f.unread && anyKnown && r.unread !== true) return false;
    return true;
  });
}

// ─── What is said about the inbox ─────────────────────────────────────────────

/** A sender as said: their name as the page gives it, a few plain words. */
export function who(from: string): string {
  const name = plain(from, 4, 40);
  return name && !injectionLike(name) ? name : "someone";
}

/** A subject as said: plain words, no "Re:", and never a subject that reads like orders. */
export function subjectSaid(subject: string, maxWords = 7): string {
  const s = plain(subject.replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, ""), maxWords, 60);
  if (!s) return "";
  return injectionLike(subject) || injectionLike(s) ? "" : s;
}

function about(row: MailRow): string {
  if (row.topic) return `about ${row.topic}`;
  const s = subjectSaid(row.subject);
  if (s) return `about “${s}”`;
  return row.subject.trim() ? "with a subject that reads like instructions" : "with no subject";
}

/** When a row came, as said: "at 9:42 AM", "yesterday", "last Friday", "on October 30" — "" when the list doesn't say. */
export function whenSaid(when: string, today: Ymd): string {
  const day = whenDay(when, today);
  if (!day) return "";
  const n = daysBetween(day, today);
  if (n === 0) {
    const time = /(\d{1,2}:\d{2})\s*([ap])\.?m\.?/i.exec(when);
    return time ? `at ${time[1]} ${time[2]!.toUpperCase()}M` : "today";
  }
  if (n === 1) return "yesterday";
  if (n > 1 && n < 7) return `last ${WEEKDAYS[weekdayOf(day)]}`;
  return `on ${MONTHS[day.mo - 1]} ${day.d}`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * One or two sentences on what the inbox holds. `shown` are the rows the filter kept (they go on the card, numbered,
 * in this order); `card` is that card's number, when there is one.
 */
export function inboxLine(f: MailFilter, view: InboxView, shown: MailRow[], knownEmpty: boolean, card: number | null, today: Ymd): string {
  const onCard = card !== null && shown.length ? ` ${shown.length === 1 ? "It's" : "They're"} on card ${card}.` : "";
  const scope = f.since ? ` ${f.since.label}` : view.rows.length ? ` in the ${count(view.rows.length, "message", "newest messages")} I can see` : "";
  if (!view.rows.length && !knownEmpty) return "I didn't find any messages on your mail page — it may still be loading. Ask me again in a moment.";
  if (f.sender) {
    const said = plain(f.sender, 4, 40);
    if (!shown.length) return `${f.writeBack ? "Not yet — nothing" : "Nothing"} from ${said}${scope}.`;
    if (shown.length === 1) {
      const r = shown[0]!;
      const when = whenSaid(r.when, today);
      return `${f.writeBack ? "Yes — " : ""}${who(r.from)} wrote ${when ? `${when} ` : ""}${about(r)}.${onCard}`;
    }
    const each = shown.slice(0, 3).map((r) => [about(r), whenSaid(r.when, today)].filter(Boolean).join(" "));
    return `${f.writeBack ? "Yes — there" : "There"} are ${shown.length} from ${who(shown[0]!.from)}: ${list(each)}.${onCard}`;
  }
  if (f.topic) {
    const said = plain(f.topic, 5, 40);
    if (!shown.length) return `Nothing about ${said}${scope}.`;
    const from = shown.slice(0, 3).map((r) => [who(r.from), whenSaid(r.when, today)].filter(Boolean).join(" "));
    return `${count(shown.length, "message", "messages")} about ${said}, from ${list(from)}.${onCard}`;
  }
  const top = shown.slice(0, 3).map((r) => `${who(r.from)} ${about(r)}`);
  const unreadKnown = view.unreadOnly || view.rows.some((r) => r.unread !== null);
  if (unreadKnown) {
    if (!shown.length) return f.since ? `No unread mail ${f.since.label}.` : "No unread mail.";
    const n = `${shown.length}${shown.length >= 15 ? " or more" : ""}`;
    return shown.length <= 3 ? `You have ${n} unread${f.since ? ` ${f.since.label}` : ""}: ${list(top)}.${onCard}` : `You have ${n} unread${f.since ? ` ${f.since.label}` : ""}. The newest are ${list(top)}.${onCard}`;
  }
  // The page doesn't show which are unread: the newest, said as that.
  if (!shown.length) return f.since ? `No mail ${f.since.label}.` : "Your inbox is empty.";
  return `Your newest mail${f.since ? ` ${f.since.label}` : ""}: ${list(top)}.${onCard}`;
}

/** The inbox card: the rows, numbered as "open the second one" counts them. */
export function inboxCard(f: MailFilter, view: InboxView, shown: MailRow[], line: string, clock: string): CardContent {
  const what = f.sender ? `From ${plain(f.sender, 4, 40)}` : f.topic ? `About ${plain(f.topic, 5, 40)}` : view.unreadOnly || view.rows.some((r) => r.unread !== null) ? "Unread" : "Newest";
  const items = shown.map((r) => {
    const subject = plain(r.subject, 14, 90) || "(no subject)";
    return `${plain(r.from, 5, 50)} — ${subject}${r.when ? ` · ${plain(r.when, 4, 24)}` : ""}`;
  });
  const blocks: Block[] = items.length
    ? [
        { kind: "list", style: "number", items },
        { kind: "note", tone: "info", text: "Say “open the second one” or “read the one from …” to hear a message." },
      ]
    : [{ kind: "note", tone: "info", text: "Nothing to show." }];
  return {
    title: "Inbox",
    subtitle: `${what}${f.since ? ` · ${f.since.label}` : ""}`,
    summary: scrubSpoken(line),
    meta: [
      { label: "Showing", value: `${shown.length} of ${view.rows.length}` },
      { label: "As of", value: clock },
    ],
    blocks,
  };
}

// ─── Which message ────────────────────────────────────────────────────────────

export type RowPick =
  | { by: "index"; index: number }
  | { by: "last" }
  | { by: "next" }
  | { by: "sender"; said: string }
  | { by: "topic"; said: string }
  /** "it", "that one", "the email": whatever is open, or the one just talked about. */
  | { by: "it" }
  | { by: "none" };

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const CARDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Whether the message should be read out rather than summed up. */
export function wantsReadOut(words: string): boolean {
  return /\bread\b[^.?!]{0,30}\b(?:out|aloud|to me|in full|word for word)\b|\bread (?:me )?the (?:whole|entire|full)\b|\bthe whole (?:thing|e-?mail|message)\b/i.test(words);
}

/**
 * Which message "read the one from Sam" / "open the second one" / "what does it say" means. A place on the card comes
 * first ("the second one"), then who it is from or what it is about ("the latest one from the bank" is the bank's),
 * then "the top one" / "the next one", then "it".
 */
export function parsePick(words: string): RowPick {
  const said = tidy(words);
  const t = said.toLowerCase();
  let m = new RegExp(String.raw`\b(${ORDINALS.join("|")})\b(?!\s+(?:time|thing|of all))`).exec(t);
  if (m) return { by: "index", index: ORDINALS.indexOf(m[1]!) };
  m = new RegExp(String.raw`\b(?:number|#|e-?mail|message|item|row)\s*#?\s*(\d{1,2}|${CARDINALS.join("|")})\b`).exec(t) ?? /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (m) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : CARDINALS.indexOf(m[1]!) + 1;
    if (n >= 1 && n <= 30) return { by: "index", index: n - 1 };
  }
  // (Names are read from the words as they were said, so they keep their capitals.)
  m =
    /\bfrom (?:the |my |our )?(.{2,40}?)(?=$|[?.!,]|\s+(?:about|regarding|out|aloud|to me|please|say|says)\b)/i.exec(said) ??
    // "open Sam's email", "read Dana Park's message"
    /(?:^|\s)(?:(?:open|read|show|play|get|check|pull up)\s+)?(?:me\s+)?(?:the\s+)?([a-z][\w-]+(?: [A-Z][\w-]+)?)'s (?:e-?mail|message|one|reply|note)\b/i.exec(said) ??
    // "what did Sam say", "what does the bank want"
    /\bwhat (?:did|does|has) (?:the |my |our )?(?!(?:it|that|this|he|she|they|the e-?mail|the message|one)\b)(.{2,30}?) (?:say|said|want|wanted|write|wrote|written|send|sent)\b/i.exec(said);
  if (m && !/^(?:it|that|this|them|him|her)$/i.test(m[1]!.trim())) return { by: "sender", said: m[1]!.trim() };
  m = /\babout (?:the |my |our )?(.{2,40}?)(?=$|[?.!,]|\s+(?:out|aloud|to me|please)\b)/i.exec(said) ?? /\bthe (?!one\b|e-?mail\b|message\b|whole\b|last\b|next\b|top\b|latest\b|newest\b|most\b|bottom\b)(.{2,30}?) (?:one|e-?mail|message)\b/i.exec(said);
  if (m) return { by: "topic", said: m[1]!.trim() };
  if (/\b(?:last|bottom) (?:one|e-?mail|message)\b/.test(t)) return { by: "last" };
  if (/\b(?:top|latest|newest|most recent)(?: one| e-?mail| message)?\b/.test(t)) return { by: "index", index: 0 };
  if (/\bnext(?: one| e-?mail| message)?\b/.test(t)) return { by: "next" };
  if (/\b(?:it|that|this|that one|this one|the e-?mail|the message)\b/.test(t)) return { by: "it" };
  return { by: "none" };
}

/** The row a pick names among the rows last shown (card order) — or the rows it could be, when the words don't settle it. */
export function pickRow(pick: RowPick, shown: MailRow[], lastIndex: number | null): { row: MailRow; index: number } | null {
  const at = (i: number) => (i >= 0 && i < shown.length ? { row: shown[i]!, index: i } : null);
  switch (pick.by) {
    case "index":
      return at(pick.index);
    case "last":
      return at(shown.length - 1);
    case "next":
      return at(lastIndex === null ? 0 : lastIndex + 1);
    case "sender": {
      const want = wordsOf(pick.said);
      const i = want.length ? shown.findIndex((r) => want.every((w) => norm(r.from).includes(w))) : -1;
      return at(i);
    }
    case "topic": {
      const want = wordsOf(pick.said);
      const i = want.length ? shown.findIndex((r) => want.every((w) => norm(`${r.from} ${r.subject} ${r.snippet}`).includes(w))) : -1;
      return at(i);
    }
    case "it":
      return shown.length === 1 ? at(0) : lastIndex !== null ? at(lastIndex) : null;
    default:
      return null;
  }
}

// ─── What is said about a message ─────────────────────────────────────────────

const READ_OUT_WORDS = 600;

/** A message as spoken: two sentences on what it says, then what it asks of the reader — or its text, read out. */
export function messageLine(m: OpenMessage, readOut: boolean): string {
  const warning = asksLine(m.asks, m.ignored);
  if (readOut) {
    const body = scrubSpoken(m.body).split(/\s+/);
    const text = body.slice(0, READ_OUT_WORDS).join(" ");
    if (!text) return "I couldn't make out the text of that message.";
    const lead = `${who(m.from)} writes: `;
    return `${lead}${text}${body.length > READ_OUT_WORDS ? "… That's as far as I'll read; the rest is in your mail tab." : ""}${/[.!?…]$/.test(text) ? "" : "."}${m.ignored ? ` I left out ${m.ignored === 1 ? "a line" : "lines"} written as instructions to an assistant.` : ""}`;
  }
  const everyday = !warning && m.asksFor && !/\bask/i.test(m.summary) ? ` It asks you ${m.asksFor}.` : "";
  return `${m.summary}${warning ? ` ${warning}` : everyday}`;
}

/** The message card: who, when, its text (as text), and a note on anything it asks for. */
export function messageCard(m: OpenMessage, line: string): CardContent {
  const warning = asksLine(m.asks, m.ignored);
  const blocks: Block[] = [];
  const text = paragraphs(m.body.slice(0, 5000));
  if (text.length) blocks.push({ kind: "text", paragraphs: text });
  else blocks.push({ kind: "note", tone: "info", text: "I couldn't make out the text of this message — it's open in your mail tab." });
  if (warning) blocks.push({ kind: "note", tone: "warning", text: `${warning} Links and attachments in a message are never opened for you.` });
  return {
    title: plain(m.subject, 14, 90) || "Message",
    subtitle: [m.from ? `From ${plain(m.from, 5, 50)}` : "", m.when ? plain(m.when, 6, 40) : ""].filter(Boolean).join(" · "),
    summary: scrubSpoken(line).slice(0, 300),
    blocks,
  };
}

// ─── Writing an email ─────────────────────────────────────────────────────────

export interface EmailAsk {
  kind: "new" | "reply" | "revise";
  /** An address said in the words ("sam@example.com", "sam at example dot com"). */
  address: string | null;
  /** Who it is for, as said ("Sam", "Sam Lee", "my boss"), when no address was said. */
  name: string | null;
  /** What to say, as the user put it ("I'll be ten minutes late", "ask for the invoice") — the whole ask when it can't be cut out. */
  message: string;
}

const SPOKEN_ADDRESS = /\b([a-z0-9]+(?:\s+(?:dot|underscore|dash|hyphen)\s+[a-z0-9]+)*)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/i;

/** An address said aloud: "sam at example dot com", "sam dot lee at example dot co dot uk". */
function spokenAddress(text: string): string | null {
  const m = SPOKEN_ADDRESS.exec(text);
  if (!m) return null;
  const glue = (s: string) =>
    s
      .replace(/\s+dot\s+/gi, ".")
      .replace(/\s+underscore\s+/gi, "_")
      .replace(/\s+(?:dash|hyphen)\s+/gi, "-");
  const address = `${glue(m[1]!)}@${glue(m[2]!)}`.toLowerCase();
  return isEmail(address) ? address : null;
}

/** The address in the user's own words, typed or said. */
export function addressIn(words: string): string | null {
  const typed = emailsIn(words)[0];
  return typed ? typed.toLowerCase().replace(/[.,;:!?]+$/, "") : spokenAddress(words);
}

const REPLY_SAID = /\b(?:reply|respond|write back|answer (?:him|her|them|it|that|back)|get back to (?:him|her|them)|tell (?:him|her|them)|let (?:him|her|them) know)\b/i;
const NEW_SAID = /\b(?:e-?mail|message|write to|write (?:an?|a new) (?:e-?mail|message|note)|send (?:an? |a new )?(?:e-?mail|message|note)|drop (?:an? )?(?:e-?mail|note|line)|draft (?:an? )?(?:e-?mail|message|note|reply))\b/i;
const REVISE_SAID =
  /\b(?:make (?:it|that|this|the (?:e-?mail|draft|message|tone))|change (?:it|that|the)|add (?:that|a|an|the|in)\b|remove|take out|leave out|drop the|cut the|shorten|shorter|longer|briefer|more (?:formal|friendly|polite|casual|direct|professional|concise)|less (?:formal|wordy|stiff)|rewrite|rephrase|reword|instead|fix the|sign it|sign off|start (?:it )?with|end (?:it )?with|open with|mention|also say|sound(?:s)?|tone it|say (?:sorry|thanks|thank you|please))\b/i;
const NAME_STOP = /^(?:that|saying|to|and|about|asking|regarding|if|whether|a|an|the|him|her|them|me|us|it|back|i|i'll|i'm|we|we'll|we're|my|our|this|please|now|today|tomorrow|quickly|instead|too|again|e-?mail|note|line|message)$/i;

/** What "email Sam that…", "reply that…", "write back and ask…", "make it shorter" asks for. `draftOpen`: one of Trinity's drafts is waiting. */
export function parseEmailAsk(words: string, draftOpen: boolean): EmailAsk {
  const t = tidy(words);
  const address = addressIn(t);
  const reply = REPLY_SAID.test(t);
  const fresh = NEW_SAID.test(t);
  if (draftOpen && REVISE_SAID.test(t) && !fresh && !reply && !address) return { kind: "revise", address: null, name: null, message: t };
  if (reply && !address && !/\b(?:e-?mail|message|write to)\s+[A-Za-z]/.test(t.replace(REPLY_SAID, ""))) {
    const said = /\b(?:that|saying(?: that)?|to say(?: that)?|with|and (?:say|tell (?:him|her|them)|let (?:him|her|them) know)(?: that)?|:)\s+(.+)$/i.exec(t)?.[1] ?? /\b(?:and |to )?(ask(?:ing)? .+)$/i.exec(t)?.[1] ?? t.replace(/^.*?\b(?:reply|respond|write back|answer (?:him|her|them|it|that|back)|get back to (?:him|her|them)|tell (?:him|her|them)|let (?:him|her|them) know)\b[\s,:]*/i, "");
    // ("Reply." alone says nothing to say: the caller asks.)
    return { kind: "reply", address: null, name: null, message: said.replace(/^(?:to (?:him|her|them|it|that)\b)?[\s.!?,:]*$/i, "").trim() };
  }
  // Who it is for: the words after the verb, up to where the message starts ("my boss" keeps its "my").
  const nameAt = (after: string): string | null => {
    const words = after.split(/\s+/);
    const mine = /^my$/i.test(words[0] ?? "");
    const said: string[] = [];
    for (const w of mine ? words.slice(1) : words) {
      const bare = w.replace(/[,.:;!?]+$/, "");
      if (!bare || NAME_STOP.test(bare) || said.length >= (mine ? 2 : 3) || /@/.test(bare)) break;
      said.push(bare);
      if (/[,.:;!?]$/.test(w)) break;
    }
    return said.length ? `${mine ? "my " : ""}${mine ? said.join(" ").toLowerCase() : said.join(" ")}` : null;
  };
  let name: string | null = null;
  // (With an address said, the address is who it is for: it comes out of the words before the rest is read.)
  const bare = address
    ? t
        .replace(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ")
        .replace(SPOKEN_ADDRESS, " ")
        .replace(/\s+/g, " ")
    : t;
  let rest = bare;
  const lead = /\b(?:send (?:an? |a new )?(?:e-?mail|message|note) to|drop (?:an? )?(?:e-?mail|note|line) to|write (?:an? |a new )?(?:e-?mail|message|note) to|draft (?:an? )?(?:e-?mail|message|note) (?:to|for)|write to|e-?mail|message)\s+/i.exec(bare);
  // "shoot Sam a note that…", "send Dana a quick email saying…": the name sits between the verb and the noun.
  const between = /\b(?:send|shoot|drop|write)\s+(.{2,30}?)\s+(?:an?\s+)?(?:quick\s+)?(?:e-?mail|note|line|message)\b/i.exec(bare);
  if (between && !/^(?:an?|the|this|that|it|me|us)\b/i.test(between[1]!) && nameAt(between[1]!) !== null && (!lead || between.index <= lead.index)) {
    name = nameAt(between[1]!);
    rest = bare.slice(between.index + between[0].length);
  } else if (lead) {
    const after = bare.slice(lead.index + lead[0].length);
    name = nameAt(after);
    rest = after.slice(name ? after.toLowerCase().indexOf(name.toLowerCase()) + name.length : 0);
  } else if (address) {
    // "send sam@example.com an email about the offsite": what follows the noun.
    rest = bare.replace(/^.*?\b(?:e-?mail|note|line|message)\b/i, "");
  }
  const message =
    /^[\s,:]*(?:that|saying(?: that)?|to say(?: that)?|to tell (?:him|her|them)(?: that)?|to let (?:him|her|them) know(?: that)?|and (?:say|tell (?:him|her|them)|let (?:him|her|them) know)(?: that)?|:)\s+(.+)$/i.exec(rest)?.[1] ??
    /^[\s,:]*(?:and |to )?(ask(?:ing)? .+)$/i.exec(rest)?.[1] ??
    /^[\s,:]*(about .+)$/i.exec(rest)?.[1] ??
    rest.replace(/^[\s,:.!?]+/, "").replace(/^(?:instead|too|again)\b[\s,.!?]*/i, "");
  // (Nothing after the name — "email Sam." — is no message: the caller asks what it should say.)
  return { kind: "new", address, name: address ? null : name, message: message.replace(/^[\s.!?]+$/, "").trim() };
}

/** "Sam" → "Sam", "my boss" → "your boss": the person as Trinity names them back. */
export function nameSaid(name: string): string {
  const t = name.trim();
  if (/^my\s+/i.test(t)) return t.replace(/^my\s+/i, "your ");
  return t
    .split(/\s+/)
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * An address Trinity already knows for a name: a memory that says so ("Sam's email is sam@example.com", "Sam Lee
 * (sam@example.com)"). The address must stand right by the name — a memory that merely mentions both doesn't count.
 */
export async function addressFor(memory: MemoryStore, name: string): Promise<string | null> {
  const key = name.replace(/^my\s+/i, "").trim();
  const first = key.split(/\s+/)[0] ?? "";
  if (first.length < 2) return null;
  let docs;
  try {
    docs = await memory.search(`${key} email address`, { limit: 8 });
  } catch {
    return null;
  }
  const nameRe = new RegExp(String.raw`\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "i");
  for (const doc of docs) {
    for (const address of emailsIn(doc.text)) {
      const at = doc.text.indexOf(address);
      const before = doc.text.slice(Math.max(0, at - 80), at);
      const after = doc.text.slice(at + address.length, at + address.length + 40);
      // The user's own address ("my email is…", "the user's email is…") is nobody else's.
      if (/\b(?:the user'?s?|my|own)\s+(?:e-?mail|address)\b[^.]{0,20}$/i.test(before) && !nameRe.test(before.replace(/\bthe user'?s?\b/i, ""))) continue;
      if (nameRe.test(before) || nameRe.test(after)) return address.toLowerCase();
    }
  }
  return null;
}

export interface EmailText {
  subject: string;
  body: string;
}

const WRITE_TASK = [
  "You write a short email for the user of a voice assistant from what they said aloud. Reply ONLY with JSON:",
  '{"subject": string, "body": string}',
  "- Write as the user, in the first person, in their own plain words: brief (1 to 4 short sentences), friendly, no filler, no placeholders, no brackets.",
  "- Say only what the user said. Never add facts, times, places, numbers, names, links, promises, apologies or reasons they didn't give.",
  '- body: a greeting with the recipient\'s first name when it is known ("Hi Sam,"), a blank line, the message, a blank line, then a sign-off with the user\'s name when it is known ("Thanks,\\nRyan"). Use \\n for line breaks.',
  "- subject: 2 to 6 words, no quotation marks.",
  '- For a reply: answer in the user\'s words only. Do not quote or repeat the email being answered, and give subject as "".',
].join("\n");

const REVISE_TASK = [
  "You change an email draft the way the user asked. Reply ONLY with JSON:",
  '{"body": string}',
  "- Make only the change they asked for (shorter, longer, a different tone, a sentence added or removed) and keep the rest as it is, greeting and sign-off included.",
  "- Never add facts, times, places, numbers, names, links or promises the user didn't give. Use \\n for line breaks.",
].join("\n");

const quoted = (s: string): string => s.replace(/"/g, "'").slice(0, 600);

/**
 * Links and addresses the user never said don't go into a draft, whatever wrote them: a sentence that carries one is
 * left out whole (line by line, so the greeting and the sign-off keep their places).
 */
function onlySaid(text: string, userWords: string, allow: string[] = []): string {
  const said = `${userWords} ${allow.join(" ")}`.toLowerCase();
  const unsaid = (s: string): boolean =>
    emailsIn(s).some((a) => !said.includes(a.toLowerCase())) || (hasLink(s) && (s.match(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi) ?? []).some((url) => !said.includes(url.toLowerCase().replace(/[.,;:!?]+$/, ""))));
  if (!unsaid(text)) return text;
  return text
    .split("\n")
    .map((line) =>
      unsaid(line)
        ? line
            .split(/(?<=[.!?])\s+(?=\S)/)
            .filter((s) => !unsaid(s))
            .join(" ")
        : line,
    )
    .join("\n");
}

const tidyBody = (s: string): string =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 2500);

/** What the user said to say, as a sentence of theirs — for when no model is there to write it. */
function plainMessage(message: string): string {
  const m = message.trim().replace(/[.!?]+$/, "");
  let x = /^ask(?:ing)?\s+(?:him|her|them)?\s*for\s+(.+)$/i.exec(m);
  if (x) return `Could you send me ${x[1]}?`;
  x = /^ask(?:ing)?\s+(?:him|her|them)?\s*(?:if|whether)\s+(.+)$/i.exec(m);
  if (x) return `Could you let me know if ${x[1]}?`;
  x = /^ask(?:ing)?\s+(?:him|her|them)?\s*to\s+(.+)$/i.exec(m);
  if (x) return `Could you ${x[1]}?`;
  x = /^about\s+(.+)$/i.exec(m);
  if (x) return `I wanted to get in touch about ${x[1]}.`;
  x = /^thank(?:ing)?\s+(?:him|her|them)(?:\s+for\s+(.+))?$/i.exec(m);
  if (x) return x[1] ? `Thank you for ${x[1]}.` : "Thank you.";
  return sentence(m);
}

function fallbackEmail(ask: EmailAsk, firstName: string, userName: string | null): EmailText {
  const said = plainMessage(ask.message);
  const body = `${firstName ? `Hi ${firstName},` : "Hi,"}\n\n${said}\n\n${userName ? `Thanks,\n${userName}` : "Thanks,"}`;
  const subject = said
    .replace(/[.!?]+$/, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
  return { subject: ask.kind === "reply" ? "" : subject, body };
}

/**
 * The draft's subject and body, written from the user's own words. A reply is told who is being answered and the
 * subject (as data) — never the message's text: what the user dictated is all it may say.
 */
export async function writeEmail(
  words: string,
  ask: EmailAsk,
  opts: { toName: string; toAddress: string | null; userName: string | null; replyingTo?: { from: string; subject: string } | null },
): Promise<EmailText> {
  const first = opts.toName && !/^your\s/i.test(opts.toName) && !/@/.test(opts.toName) ? opts.toName.split(/\s+/)[0]! : "";
  const fallback = fallbackEmail(ask, first, opts.userName);
  if (!live.mordiem) return fallback;
  const context = opts.replyingTo ? fence(`from: ${plain(opts.replyingTo.from, 5, 60)}; subject: ${plain(opts.replyingTo.subject, 12, 100)}`, 300) : null;
  const user = [
    `The user said: "${quoted(tidy(words))}"`,
    `Kind: ${ask.kind === "reply" ? "a reply" : "a new email"}`,
    `Recipient: ${first || "unknown"}${opts.toAddress ? ` <${opts.toAddress}>` : ""}`,
    `The user's name: ${opts.userName ?? "unknown"}`,
    context ? `The email being answered (for the greeting only):\n${context.block}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await jsonChat<{ subject?: unknown; body?: unknown }>(`${WRITE_TASK}${context ? `\n${context.rule}` : ""}`, user, { model: getEndpoints().fastModel, temperature: 0.3, maxTokens: 500, timeoutMs: 7_000 });
  const allow = [opts.toAddress ?? ""];
  const body = typeof raw?.body === "string" ? tidyBody(onlySaid(raw.body, words, allow)) : "";
  if (!body) return fallback;
  const subject = typeof raw?.subject === "string" ? plain(onlySaid(raw.subject, words, allow), 10, 90) : "";
  return { subject: ask.kind === "reply" ? "" : subject || fallback.subject, body };
}

/** The open draft's body, changed the way the user asked ("make it shorter", "add that I'm sorry"). Null when it couldn't be. */
export async function reviseEmail(words: string, draft: MailDraft): Promise<string | null> {
  if (!live.mordiem) return null;
  const raw = await jsonChat<{ body?: unknown }>(REVISE_TASK, `The draft:\n"""\n${draft.body.replace(/"""/g, '"')}\n"""\n\nThe user said: "${quoted(tidy(words))}"`, {
    model: getEndpoints().fastModel,
    temperature: 0.3,
    maxTokens: 600,
    timeoutMs: 7_000,
  });
  const body = typeof raw?.body === "string" ? tidyBody(onlySaid(raw.body, `${words} ${draft.body}`, [draft.to])) : "";
  return body && body !== draft.body ? body : null;
}

/** The draft card: who it is for, the subject, the words — and that it hasn't gone. */
export function draftCard(d: MailDraft): CardContent {
  const subject = d.subject || "(the page keeps the subject)";
  return {
    title: d.reply ? `Reply to ${plain(d.to, 5, 50)}` : `Draft to ${d.to}`,
    subtitle: "Not sent",
    summary: `An email draft ${d.reply ? "replying to" : "to"} ${d.to}${d.subject ? `, subject ${d.subject}` : ""}. Not sent.`,
    meta: [
      { label: "To", value: d.to },
      { label: "Subject", value: subject },
    ],
    blocks: [
      { kind: "text", paragraphs: d.body.split(/\n{2,}/).map((p) => p.replace(/\n/g, " · ").trim()).filter(Boolean) },
      { kind: "note", tone: "info", text: "It's in your mail tab, not sent. Say “send it”, or tell me what to change." },
    ],
  };
}

/** The subject a draft is named by when Trinity asks about sending it: the new message's own, or "Re: …" for a reply. */
export function draftSubject(d: MailDraft, replyingTo: OpenMessage | null): string {
  if (!d.reply) return plain(d.subject, 10, 80) || "no subject";
  const original = replyingTo ? subjectSaid(replyingTo.subject, 8) : "";
  return original ? `Re: ${original}` : "your reply";
}

/** What is said once Send was pressed — as much as the page showed, and no more. */
export function sentLine(outcome: SendOutcome, d: MailDraft): string {
  if (outcome.sent === "confirmed") return `Sent — your mail page says the message to ${d.to} has gone.`;
  if (outcome.sent === "closed") return `I pressed Send and the draft closed, so it looks sent — but the page didn't show a confirmation. Check your Sent folder to be sure.`;
  return `I pressed Send, but the draft is still showing${outcome.error ? " and the page shows an error" : ""}, so it may not have gone. Have a look at your mail tab.`;
}
