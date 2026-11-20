import { speakable } from "../../agent/reply.js";
import { getEndpoints, live } from "../../settings.js";
import { jsonChat } from "../json-chat.js";
import { findField, findFields, findPressable, type BrowserPort, type PortControl, type PortSnapshot } from "./browser-port.js";
import { assistNow } from "./time.js";
import { appears, capSentences, emailsIn, fence, injectionLike, isEmail, norm, plain, requestsIn, scrubSpoken, sentences, withoutInjection, type MessageAsks } from "./untrusted.js";

/*
 * The user's webmail, worked through their own signed-in browser tab (Gmail by default, Outlook on the web too): list
 * the inbox, open a message and read it, put a draft into the page's own compose form, press its Send. No mail
 * account is set up in the engine and nothing here talks to a mail server.
 *
 * How a page is read: the port's snapshot gives the page's text and its controls. A model turns the text into rows
 * (or picks out the open message) — the text goes to it fenced as data (untrusted.ts), and whatever it reports is
 * kept only if it is on the page. A message is opened by clicking the control that carries its subject; fields are
 * found by what they are called ("To", "Subject", "Message Body", "Send"). Nothing a page says is ever followed: no
 * link in a message is opened, no address in one is written to, and text written as orders to an assistant is taken
 * out before a model or the user hears it.
 *
 * What each mail site is assumed to look like is in docs/ARCHITECTURE.md ("Email, calendar and bookings").
 */

export type MailProvider = "gmail" | "outlook" | "other";

export interface MailRow {
  from: string;
  subject: string;
  snippet: string;
  /** The time or date the list shows for it, as shown. */
  when: string;
  /** Whether it is unread — null when the page doesn't say. */
  unread: boolean | null;
  /** A few words on what it is about, taken from its subject (for the spoken line); "" when there are none to trust. */
  topic: string;
}

export interface InboxView {
  tabId: number;
  /** The list page the rows were read from: a row is opened from there. */
  url: string;
  provider: MailProvider;
  rows: MailRow[];
  /** The list holds unread mail only (Gmail's unread search). */
  unreadOnly: boolean;
  at: number;
}

export interface OpenMessage {
  tabId: number;
  url: string;
  from: string;
  /** The sender's address, when the page shows it. */
  address: string | null;
  subject: string;
  when: string;
  /** The message's own text, without sentences written as orders to an assistant. */
  body: string;
  /** Two sentences on what it says. */
  summary: string;
  /** What it asks of its reader, by kind (links, payments, private details). */
  asks: MessageAsks;
  /** An everyday request in it ("to send the invoice by Friday"), in the model's few words; "" when none. */
  asksFor: string;
  /** Sentences left out because they were written as orders to an assistant. */
  ignored: number;
  at: number;
}

export interface MailDraft {
  tabId: number;
  /** The recipient: an address — or, for a reply, the name of the person being answered. */
  to: string;
  subject: string;
  body: string;
  reply: boolean;
  at: number;
}

export type Fail = { ok: false; say: string };
const fail = (say: string): Fail => ({ ok: false, say });

/** How long each step may take (tests shorten these). */
export const mailTiming = { loadMs: 7_000, stepMs: 5_000, settleMs: 450, modelMs: 8_000 };

const LIST_FRESH_MS = 15 * 60_000;
const DRAFT_FRESH_MS = 20 * 60_000;
const LIST_CHARS = 7_000;
const MESSAGE_CHARS = 9_000;

let inbox: InboxView | null = null;
let openMessage: OpenMessage | null = null;
let draft: MailDraft | null = null;

/** The inbox as it was last read (within the last quarter of an hour). */
export function lastInbox(): InboxView | null {
  return inbox && assistNow() - inbox.at <= LIST_FRESH_MS ? inbox : null;
}
/** The message that was last opened (within the last quarter of an hour). */
export function lastMessage(): OpenMessage | null {
  return openMessage && assistNow() - openMessage.at <= LIST_FRESH_MS ? openMessage : null;
}
/** The draft Trinity typed that hasn't been sent (within the last twenty minutes). */
export function openDraft(): MailDraft | null {
  return draft && assistNow() - draft.at <= DRAFT_FRESH_MS ? draft : null;
}
/** Tests: forget everything. */
export function resetMail(): void {
  inbox = null;
  openMessage = null;
  draft = null;
}

const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const reason = (err: unknown): string => (err as Error).message.replace(/\s+/g, " ").slice(0, 120);

// ─── Which mail site, and which of its pages ──────────────────────────────────

export function mailProvider(url: string): MailProvider {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "mail.google.com") return "gmail";
    if (/^outlook\.(?:live|office|office365)\.com$/.test(host) || host === "outlook.cloud.microsoft") return "outlook";
  } catch {
    /* not a URL */
  }
  return "other";
}

/** The page that lists the mail: the inbox — or, on Gmail, its unread search (a view of the page, nothing of the user's in it). */
export function listUrl(base: string, unreadOnly: boolean): string {
  if (mailProvider(base) !== "gmail") return base;
  const u = new URL(base);
  u.hash = unreadOnly ? "#search/is%3Aunread+in%3Ainbox" : "#inbox";
  return u.href;
}

/** The part after "#", as a mail page may rewrite it: decoded, lower case, a "+" and a space the same. */
const hashOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).hash.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return "";
  }
};

/** Gmail keeps an open New Message window in the address ("#inbox?compose=…"): the list is the part before it. */
const COMPOSE_OPEN = /\?compose=[^#]*$/;

/** Whether a tab is on the list wanted (and not on an opened message, another folder or a search). */
function onList(provider: MailProvider, url: string, wanted: string): boolean {
  if (provider === "gmail") return hashOf(url).replace(COMPOSE_OPEN, "") === hashOf(wanted).replace(COMPOSE_OPEN, "");
  try {
    return !/\/id\/|\/deeplink\/|\/compose\b/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

const LOADING = /\bloading (?:gmail|standard view|outlook|your (?:mail|inbox|messages))\b|^\s*loading\b/i;
const loaded = (s: PortSnapshot): boolean => (s.text.trim().length >= 40 || s.controls.length >= 6) && !LOADING.test(s.text.slice(0, 300));

function signInWall(s: PortSnapshot): boolean {
  try {
    if (/^(?:accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com)$/.test(new URL(s.url).hostname.toLowerCase())) return true;
  } catch {
    /* not a URL */
  }
  return /^sign in\b/i.test(s.title.trim()) && s.text.length < 1500;
}

/** The user's mail tab, brought forward (or opened), once its page has something to read. */
async function mailTab(port: BrowserPort): Promise<{ ok: true; tabId: number; snap: PortSnapshot; base: string } | Fail> {
  const base = getEndpoints().mailUrl;
  let opened;
  try {
    opened = await port.open(base, { reuse: true });
  } catch (err) {
    return fail(`I couldn't open your mail page: ${reason(err)}.`);
  }
  const snap = await port.waitFor(opened.tabId, loaded, opened.reused ? mailTiming.stepMs : mailTiming.loadMs);
  if (!snap) return fail("Your mail page didn't load in time. Try again in a moment.");
  if (signInWall(snap)) return fail("Your mail page is asking you to sign in. Sign in there, then ask me again.");
  return { ok: true, tabId: opened.tabId, snap, base };
}

/** The list page in that tab: where it is already, or after sending the tab there. */
async function showList(port: BrowserPort, tabId: number, snap: PortSnapshot, wanted: string): Promise<{ ok: true; snap: PortSnapshot } | Fail> {
  const provider = mailProvider(wanted);
  if (onList(provider, snap.url, wanted)) return { ok: true, snap };
  try {
    // (A New Message window that is open on Gmail stays open: its part of the address goes along.)
    const compose = provider === "gmail" ? (COMPOSE_OPEN.exec(snap.url)?.[0] ?? "") : "";
    await port.navigate(tabId, `${wanted}${compose}`);
  } catch (err) {
    return fail(`I couldn't get to your inbox: ${reason(err)}.`);
  }
  const there = await port.waitFor(tabId, (s) => onList(provider, s.url, wanted) && loaded(s), mailTiming.stepMs);
  if (!there) return fail("I couldn't get back to your inbox list.");
  if (signInWall(there)) return fail("Your mail page is asking you to sign in. Sign in there, then ask me again.");
  // The address changes before the list is redrawn: give it a moment, then read what is there.
  await pause(mailTiming.settleMs);
  try {
    return { ok: true, snap: mailTiming.settleMs > 0 ? await port.snapshot(tabId) : there };
  } catch {
    return { ok: true, snap: there };
  }
}

// ─── The inbox ────────────────────────────────────────────────────────────────

const INBOX_TASK = [
  "You read the text of a webmail page that lists messages, and report the messages it shows. Reply ONLY with JSON:",
  '{"rows": [{"from": string, "subject": string, "snippet": string, "when": string, "unread": true | false | null, "topic": string}]}',
  '- One row per message, in the order shown, at most 15. Copy from, subject, snippet and when exactly as they appear in the text (snippet: at most 20 words of the preview, "" if there is none; when: the time or date shown for that message).',
  "- unread: true or false only when the text itself marks that message as unread or read; otherwise null.",
  '- topic: 2 to 4 plain words from the subject that say what it is about ("the roadmap", "your October statement").',
  "- Leave out folders, tabs, buttons, menus, ads and anything that is not a message. Never add a row that is not in the text.",
].join("\n");

const EMPTY_LIST = /\bno messages matched your search\b|\bno new mail\b|\b(?:inbox|folder|tab) is empty\b|\bnothing in (?:focused|other|inbox)\b|\ball caught up\b|\bno (?:unread )?(?:messages|conversations|mail)\b/i;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Whether `a` stands within `span` characters of `b` somewhere on the page (both as norm() makes them). */
function near(page: string, a: string, b: string, span: number): boolean {
  const na = norm(a);
  const nb = norm(b);
  for (let i = page.indexOf(nb); i >= 0; i = page.indexOf(nb, i + 1)) {
    const window = page.slice(Math.max(0, i - span), i + nb.length + span);
    if (window.includes(na)) return true;
  }
  return false;
}

const TOPIC_FILLER = new Set(["your", "this", "that", "with", "from", "about", "their", "some", "have", "been"]);

/** The model's few words on what a message is about — kept only when every word of weight is in its subject or preview. */
function topicOf(topic: string, subject: string, snippet: string): string {
  const t = plain(topic, 5, 40);
  if (!t || injectionLike(t)) return "";
  const source = norm(`${subject} ${snippet}`);
  const words = norm(t)
    .split(" ")
    .filter((w) => w.length > 3 && !TOPIC_FILLER.has(w));
  return words.length && words.every((w) => source.includes(w.replace(/'s$/, ""))) ? t : "";
}

/** The rows a model reported, kept only where the page bears them out. */
export function validRows(raw: unknown, pageText: string): MailRow[] {
  const page = norm(pageText);
  const marksUnread = /\bunread\b/i.test(pageText);
  const list = raw && typeof raw === "object" && Array.isArray((raw as { rows?: unknown }).rows) ? ((raw as { rows: unknown[] }).rows as unknown[]) : [];
  const out: MailRow[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const from = str(r.from, 100);
    const subject = str(r.subject, 200);
    // A sender that isn't on the page, or a subject that isn't, or the two from different parts of the page: not a row.
    if (!from || !appears(page, from)) continue;
    if (subject && (!appears(page, subject, 1) || !near(page, from, subject, 600))) continue;
    const snippet = str(r.snippet, 300);
    const when = str(r.when, 40);
    const row: MailRow = {
      from,
      subject,
      snippet: snippet && appears(page, snippet) ? snippet : "",
      when: when && appears(page, when, 1) ? when : "",
      unread: marksUnread && typeof r.unread === "boolean" ? r.unread : null,
      topic: topicOf(str(r.topic, 60), subject, snippet),
    };
    const key = norm(`${row.from}|${row.subject}|${row.when}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 15) break;
  }
  return out;
}

async function rowsOn(snap: PortSnapshot): Promise<{ ok: true; rows: MailRow[] } | Fail> {
  if (!live.mordiem) return fail("Reading your inbox needs a text model — add a Mordiem key in Settings, under Models.");
  const data = fence(`Page title: ${snap.title}\n${snap.text}`, LIST_CHARS);
  const raw = await jsonChat<{ rows?: unknown }>(`${INBOX_TASK}\n${data.rule}`, data.block, { model: getEndpoints().fastModel, temperature: 0, maxTokens: 1300, timeoutMs: mailTiming.modelMs });
  if (!raw) return fail("I couldn't read your inbox just now. Try again in a moment.");
  return { ok: true, rows: validRows(raw, snap.text) };
}

/**
 * Read the list of mail. `unreadOnly` asks for unread mail alone: Gmail has a view for that (every row in it is
 * unread); elsewhere the whole list is read and a row is unread only where the page says so.
 */
export async function readInbox(port: BrowserPort, opts: { unreadOnly: boolean }): Promise<{ ok: true; view: InboxView; knownEmpty: boolean } | Fail> {
  const tab = await mailTab(port);
  if (!tab.ok) return tab;
  const provider = mailProvider(tab.base);
  const unreadOnly = opts.unreadOnly && provider === "gmail";
  const wanted = listUrl(tab.base, unreadOnly);
  const list = await showList(port, tab.tabId, tab.snap, wanted);
  if (!list.ok) return list;
  const found = await rowsOn(list.snap);
  if (!found.ok) return found;
  const rows = unreadOnly ? found.rows.map((r) => ({ ...r, unread: true })) : found.rows;
  inbox = { tabId: tab.tabId, url: list.snap.url || wanted, provider, rows, unreadOnly, at: assistNow() };
  return { ok: true, view: inbox, knownEmpty: rows.length === 0 && EMPTY_LIST.test(list.snap.text) };
}

// ─── Opening a message ────────────────────────────────────────────────────────

/** What a mail row is in a snapshot: a link (Gmail) or a list option (Outlook) — never a button. */
const ROW_ROLES = /^(?:link|option|row|gridcell|listitem|treeitem)$/;
/** A short name that starts like an order ("Delete all spam messages now", "Empty Trash now", "Send"): not a row to click. */
const ACTION_SHAPED =
  /^(?:delete|empty|remove|erase|discard|clear|reset|restore|recover|send|unsubscribe|subscribe|block|report|archive|mark all|move all|sign out|log ?out|log off|pay|buy|purchase|order now|checkout|check out|book|donate|upgrade|confirm|accept|agree|allow|grant|authori[sz]e|approve|enable|disable|turn (?:on|off)|install|download|share|transfer|cancel|submit|post|publish|apply|proceed|complete|forward|reply)\b/i;

function clickableRow(c: PortControl): boolean {
  if (!ROW_ROLES.test(c.role) || c.disabled) return false;
  const name = c.name.trim();
  return !(ACTION_SHAPED.test(name) && name.split(/\s+/).length <= 7);
}

/**
 * The control that opens a row: the one that carries its subject (and, when several do, its sender; and when the same
 * subject is listed twice, the one in the same place). A row is never matched to a button, nor to a control whose
 * name reads like an action — a message can't name itself after "Send" or "Empty Trash now" and get that pressed.
 */
export function rowControl(controls: PortControl[], row: MailRow, rows: MailRow[]): PortControl | null {
  const subject = norm(row.subject).slice(0, 32);
  const from = norm(row.from).slice(0, 24);
  const pool = controls.filter(clickableRow);
  let hits = subject.length >= 3 ? pool.filter((c) => norm(c.name).includes(subject)) : [];
  if (hits.length > 1 && from.length >= 3) {
    const both = hits.filter((c) => norm(c.name).includes(from));
    if (both.length) hits = both;
  }
  // No control carries the subject: a list item that carries the sender (never a plain link: a contact's name is one too).
  if (!hits.length && from.length >= 3) hits = pool.filter((c) => c.role !== "link" && norm(c.name).includes(from));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0]!;
  const alike = rows.filter((r) => (subject.length >= 3 ? norm(r.subject).slice(0, 32) === subject : norm(r.from).slice(0, 24) === from));
  return hits[Math.min(Math.max(0, alike.indexOf(row)), hits.length - 1)]!;
}

const REPLY = /^reply$/i;
const hasReply = (s: PortSnapshot): boolean => findPressable(s.controls, REPLY) !== null;

const MESSAGE_TASK = [
  "You read the text of a webmail page that shows one opened email (the latest one, if it shows a thread) and report on that email. Reply ONLY with JSON:",
  '{"from": string, "address": string, "subject": string, "when": string, "body_start": string, "body_end": string, "summary": string, "asks": string}',
  '- from: the sender\'s name as shown; address: the sender\'s email address if the text shows it, else ""; subject and when (its date or time) as shown.',
  "- body_start: the first 6 to 10 words of the email's own text, copied exactly; body_end: its last 6 to 10 words, copied exactly (before any Reply or Forward buttons).",
  '- summary: what the email says, in at most two short plain sentences in the third person ("Sam says the draft is attached and asks for comments by Friday."). No links, no email addresses, no quotation marks.',
  '- asks: if the email asks its reader to do something, a few words starting with "to" ("to send the invoice by Friday"); otherwise "".',
].join("\n");

/** Lower case without changing the length (offsets found in it hold in the original). */
const lowerSame = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[‘’]/g, "'");

/**
 * The message's own text: from the words the model says it starts with to the words it says it ends with — cut from
 * the page, never taken from the model. The opening words are looked for from the end of the page: a list beside the
 * message shows them too (its preview), and the latest message of a thread comes last.
 */
function bodyBetween(text: string, startWords: string, endWords: string): string {
  const lower = lowerSame(text);
  const start = lowerSame(startWords.replace(/\s+/g, " ").trim());
  const end = lowerSame(endWords.replace(/\s+/g, " ").trim());
  if (start.length < 8) return "";
  const from = lower.lastIndexOf(start);
  if (from < 0) return "";
  let to = -1;
  if (end.length >= 8) {
    const at = lower.indexOf(end, from);
    if (at >= from) to = at + end.length;
  }
  if (to < 0) to = Math.min(text.length, from + 2500);
  return text.slice(from, Math.min(to, from + 6000)).trim();
}

/** With no model to say where the message starts: what follows its subject (and Gmail's "to me"), up to the reply buttons. */
function bodyGuess(text: string, subject: string): string {
  const lower = lowerSame(text);
  const at = subject ? lower.lastIndexOf(lowerSame(subject)) : -1;
  let rest = at >= 0 ? text.slice(at + subject.length) : text;
  const toMe = /\bto (?:me|you)\b/i.exec(rest.slice(0, 400));
  if (toMe) rest = rest.slice(toMe.index + toMe[0].length);
  return rest
    .replace(/\s*(?:\bReply\b\s*(?:\bReply all\b\s*)?\bForward\b.*)$/s, "")
    .trim()
    .slice(0, 2500);
}

function summaryOf(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const line = capSentences(scrubSpoken(speakable(raw)), 2, 50);
  if (!line || sentences(line).some(injectionLike) || injectionLike(line)) return "";
  return /[.!?…]$/.test(line) ? line : `${line}.`;
}

function asksOf(raw: unknown): string {
  const said = plain(raw, 14, 90).replace(/[.!?]+$/, "");
  if (!/^to\s+\S/i.test(said) || injectionLike(said) || /\b(?:https?|www)\b/i.test(said)) return "";
  return `to ${said.slice(3).trim()}`;
}

/** Read the message a page shows. `hint` is the row that was clicked (what the list said about it). */
async function readMessage(tabId: number, snap: PortSnapshot, hint: { from: string; subject: string; when: string } | null): Promise<OpenMessage> {
  // Sentences written as orders to an assistant never reach the model, the card or the user's ears.
  const clean = withoutInjection(snap.text);
  const page = norm(clean.text);
  let raw: Record<string, unknown> | null = null;
  if (live.mordiem && clean.text.trim()) {
    const data = fence(clean.text, MESSAGE_CHARS);
    raw = await jsonChat<Record<string, unknown>>(`${MESSAGE_TASK}\n${data.rule}`, data.block, { model: getEndpoints().fastModel, temperature: 0, maxTokens: 500, timeoutMs: mailTiming.modelMs });
  }
  const onPage = (v: unknown, max: number): string => {
    const s = str(v, max);
    return s && appears(page, s) ? s : "";
  };
  const from = onPage(raw?.from, 100) || hint?.from || "";
  const subject = onPage(raw?.subject, 200) || hint?.subject || "";
  const when = onPage(raw?.when, 60) || hint?.when || "";
  const address = str(raw?.address, 254).toLowerCase();
  let body = raw ? bodyBetween(clean.text, str(raw.body_start, 200), str(raw.body_end, 200)) : "";
  if (!body) body = bodyGuess(clean.text, subject);
  const first = body.split(/\s+/).slice(0, 28).join(" ");
  const summary = summaryOf(raw?.summary) || (first ? `It starts: ${scrubSpoken(first)}${/[.!?…]$/.test(first) ? "" : "…"}` : "I couldn't make out what it says.");
  return {
    tabId,
    url: snap.url,
    from,
    // An address counts as the sender's only where the page shows it right by the sender's name (its header line).
    address: address && isEmail(address) && emailsIn(page).includes(address) && from && near(page, from, address, 120) ? address : null,
    subject,
    when,
    body,
    summary,
    asks: requestsIn(body),
    asksFor: raw ? asksOf(raw.asks) : "",
    ignored: clean.removed,
    at: assistNow(),
  };
}

/**
 * Open a row of the inbox that was read, and read the message. Only that one row is clicked; nothing in the message is.
 *
 * `byUser`: the user asked for this message themselves. The extension's guard holds a click on any control whose name
 * carries a word like "order", "payment" or "confirm" — which a message's subject often does. For the user's own
 * request the row's name goes with the click as approved (it is a list row, never a button, never named like an
 * action: see rowControl); for a planner's step or a scheduled run it does not, and such a row stays unopened.
 */
export async function openRow(port: BrowserPort, view: InboxView, row: MailRow, byUser: boolean): Promise<{ ok: true; message: OpenMessage } | Fail> {
  let snap: PortSnapshot;
  try {
    snap = await port.snapshot(view.tabId);
  } catch {
    return fail("Your mail tab isn't there any more. Say check my email and I'll open it again.");
  }
  const list = await showList(port, view.tabId, snap, view.url);
  if (!list.ok) return list;
  snap = list.snap;
  const control = rowControl(snap.controls, row, view.rows);
  if (!control) return fail(`I can see the message from ${plain(row.from, 4, 40) || "that sender"} in the list, but I couldn't find it on the page to open it.`);
  const clicked = await port.click(view.tabId, control.ref, byUser ? { approved: control.name } : {});
  if (!clicked.ok)
    return fail(
      clicked.held
        ? byUser
          ? "The browser held that click, so the message isn't open. Open it in your mail tab and ask me what it says."
          : "That message's subject has a word the browser won't let me press on my own. Ask me for it yourself and I'll open it."
        : `The page wouldn't open that message: ${clicked.error ?? "the click didn't go through"}.`,
    );
  const subject = norm(row.subject).slice(0, 32);
  const before = snap;
  const moved = (s: PortSnapshot): boolean => s.url !== before.url || (hasReply(s) && !hasReply(before));
  let opened = await port.waitFor(view.tabId, (s) => moved(s) && (subject.length < 3 || norm(s.text).includes(subject)), mailTiming.stepMs);
  if (!opened) {
    // The page moved on but its text doesn't show the subject as the list wrote it: read what is there.
    try {
      const now = await port.snapshot(view.tabId);
      if (moved(now)) opened = now;
    } catch {
      /* the tab went away */
    }
  }
  if (!opened) return fail("I clicked that message but it didn't open in time. Try again in a moment.");
  if (mailTiming.settleMs > 0) {
    // The subject shows before the rest is drawn: give the message a moment, then read what is there.
    await pause(mailTiming.settleMs);
    try {
      const settled = await port.snapshot(view.tabId);
      if (moved(settled)) opened = settled;
    } catch {
      /* keep the one we have */
    }
  }
  const message = await readMessage(view.tabId, opened, row);
  openMessage = message;
  return { ok: true, message };
}

/** Read the message the mail tab is showing right now (the user opened one, or it is still open from before). */
export async function readShownMessage(port: BrowserPort): Promise<{ ok: true; message: OpenMessage } | Fail> {
  const known = lastMessage();
  const tabId = known?.tabId ?? lastInbox()?.tabId;
  let snap: PortSnapshot;
  if (tabId === undefined) {
    const tab = await mailTab(port);
    if (!tab.ok) return tab;
    snap = tab.snap;
    if (!hasReply(snap)) return fail("There's no message open in your mail tab. Say check my email, then tell me which one to open.");
    const message = await readMessage(tab.tabId, snap, null);
    openMessage = message;
    return { ok: true, message };
  }
  try {
    snap = await port.snapshot(tabId);
  } catch {
    return fail("Your mail tab isn't there any more. Say check my email and I'll open it again.");
  }
  if (known && snap.url === known.url) return { ok: true, message: known };
  if (!hasReply(snap)) return fail("There's no message open in your mail tab. Tell me which one to open.");
  const message = await readMessage(tabId, snap, null);
  openMessage = message;
  return { ok: true, message };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

const COMPOSE = /^(?:compose|new mail|new message|new email)$/i;
const TO_FIELD = /^to\b|\brecipients?\b/i;
const NOT_TO = /\b(?:cc|bcc)\b/i;
const SUBJECT_FIELD = /\bsubject\b/i;
const BODY_FIELD = /\bmessage body\b|^body\b|^message$|\b(?:write|type|compose) (?:a |an |your )?(?:message|reply|e-?mail)\b/i;
/** "Send" — or "Send (Ctrl-Enter)", as Gmail names it with its shortcut, wrapped in direction marks — not "Send feedback", "Send later", "Send and archive". */
const SEND = new RegExp(`^send(?:\\s*[(${String.fromCharCode(0x202a, 0x200e)}].*)?$`, "i");

export interface MailForm {
  to: PortControl | null;
  subject: PortControl | null;
  body: PortControl | null;
  send: PortControl | null;
  /** More than one message is being written on the page (two bodies, or two Sends): which is which can't be told. */
  several: boolean;
}

/** The compose (or reply) form on a page, by what its fields are called. */
export function mailForm(controls: PortControl[]): MailForm {
  const bodies = findFields(controls, BODY_FIELD);
  const sends = controls.filter((c) => c.role === "button" && !c.disabled && SEND.test(c.name.trim()));
  return {
    to: findField(controls, TO_FIELD, NOT_TO),
    subject: findField(controls, SUBJECT_FIELD),
    body: bodies[0] ?? null,
    send: sends[0] ?? null,
    several: bodies.length > 1 || sends.length > 1,
  };
}

export interface DraftText {
  /** An address for a new message; for a reply, who is being answered (the page fills the address in itself). */
  to: string;
  subject: string;
  body: string;
  reply: boolean;
}

const OTHER_DRAFT = "There's already a message being written in your mail tab. Finish or close it, then ask me again.";
const SEVERAL_DRAFTS = "There's more than one message being written in your mail tab, so I can't tell which one is mine. Close the others, then ask me again.";
const SEVERAL_TO_SEND = "There's more than one message being written in your mail tab, so I can't tell which Send is the draft's. Press Send on the right one yourself — I haven't sent anything.";

/**
 * Put a draft into the mail page's own form: a new message (Compose, then To, Subject and the body are typed into
 * their fields) or a reply to the message that is open (Reply, then the body). Everything is typed through the port —
 * nothing of the draft ever goes into an address. Never presses Send.
 *
 * A form someone else is writing in is left alone, and so is the page when it shows more than one. Trinity's own open
 * draft is written over only when the new one goes to the same person: its recipient field is then left as it is — a
 * field that already holds a recipient keeps it, and a second one typed in would make two.
 */
export async function writeDraft(port: BrowserPort, text: DraftText): Promise<{ ok: true; draft: MailDraft; typed: string[] } | Fail> {
  const tab = await mailTab(port);
  if (!tab.ok) return tab;
  const tabId = tab.tabId;
  let snap = tab.snap;
  let form = mailForm(snap.controls);
  if (form.several) return fail(SEVERAL_DRAFTS);
  const mine = openDraft();
  let sameRecipient = false;
  if (form.body) {
    if (!mine || mine.tabId !== tabId) return fail(OTHER_DRAFT);
    if (mine.reply !== text.reply || (!text.reply && mine.to !== text.to)) return fail(`Your draft ${mine.reply ? "reply" : `to ${mine.to}`} is still open in the mail tab. Send it or close it, then ask me again.`);
    sameRecipient = true;
  } else if (text.reply) {
    const message = lastMessage();
    if (!message) return fail("Which email should I reply to? Say check my email, then open one.");
    let reply = findPressable(snap.controls, REPLY);
    if (!reply && message.url && message.url !== snap.url) {
      // The message was closed since: its own address opens it again.
      try {
        await port.navigate(tabId, message.url);
      } catch (err) {
        return fail(`I couldn't get back to that message: ${reason(err)}.`);
      }
      const back = await port.waitFor(tabId, hasReply, mailTiming.stepMs);
      if (back) {
        snap = back;
        reply = findPressable(snap.controls, REPLY);
      }
    }
    if (!reply) return fail("I don't see a Reply button on your mail page. Open the message again and ask me.");
    const clicked = await port.click(tabId, reply.ref);
    if (!clicked.ok) return fail(`The page wouldn't start a reply: ${clicked.error ?? "the click didn't go through"}.`);
    const ready = await port.waitFor(tabId, (s) => mailForm(s.controls).body !== null, mailTiming.stepMs);
    if (!ready) return fail("I pressed Reply but the reply box didn't open in time.");
    snap = ready;
    form = mailForm(snap.controls);
  } else {
    const compose = findPressable(snap.controls, COMPOSE);
    if (!compose) return fail("I don't see a Compose button on your mail page.");
    const clicked = await port.click(tabId, compose.ref);
    if (!clicked.ok) return fail(`The page wouldn't start a new message: ${clicked.error ?? "the click didn't go through"}.`);
    const ready = await port.waitFor(
      tabId,
      (s) => {
        const f = mailForm(s.controls);
        return f.to !== null && f.body !== null;
      },
      mailTiming.stepMs,
    );
    if (!ready) return fail("I pressed Compose but the new message didn't open in time.");
    snap = ready;
    form = mailForm(snap.controls);
  }
  if (form.several) return fail(SEVERAL_DRAFTS);

  const typed: string[] = [];
  const put = async (field: PortControl | null, value: string, what: string): Promise<Fail | null> => {
    if (!field) return fail(`I couldn't find the ${what} field in the message form, so the draft isn't complete.`);
    const r = await port.type(tabId, field.ref, value);
    if (!r.ok) return fail(`The page wouldn't take the ${what}: ${r.error ?? "typing didn't go through"}.`);
    typed.push(what);
    return null;
  };
  if (!text.reply) {
    const problem = (sameRecipient ? null : await put(form.to, text.to, "recipient")) ?? (await put(form.subject, text.subject, "subject"));
    if (problem) return problem;
  }
  const problem = await put(form.body, text.body, "message");
  if (problem) return problem;
  draft = { tabId, to: text.to, subject: text.subject, body: text.body, reply: text.reply, at: assistNow() };
  return { ok: true, draft, typed };
}

/** Type a new body over the open draft's ("make it shorter"). */
export async function retypeBody(port: BrowserPort, body: string): Promise<{ ok: true; draft: MailDraft } | Fail> {
  const mine = openDraft();
  if (!mine) return fail("There's no draft of mine open to change.");
  let snap: PortSnapshot;
  try {
    snap = await port.snapshot(mine.tabId);
  } catch {
    draft = null;
    return fail("Your mail tab isn't there any more, so the draft is gone.");
  }
  const form = mailForm(snap.controls);
  if (form.several) return fail(SEVERAL_DRAFTS);
  const field = form.body;
  if (!field) {
    draft = null;
    return fail("The draft isn't open in your mail tab any more.");
  }
  const r = await port.type(mine.tabId, field.ref, body);
  if (!r.ok) return fail(`The page wouldn't take the new text: ${r.error ?? "typing didn't go through"}.`);
  draft = { ...mine, body, at: assistNow() };
  return { ok: true, draft };
}

/** Whether the open draft's form (and its Send) is still on the page. */
export async function draftOnPage(port: BrowserPort): Promise<{ ok: true; draft: MailDraft } | Fail> {
  const mine = openDraft();
  if (!mine) return fail("There's no draft of mine open to send. Tell me who to email and what to say.");
  let form: MailForm;
  try {
    form = mailForm((await port.snapshot(mine.tabId)).controls);
  } catch {
    draft = null;
    return fail("Your mail tab isn't there any more, so there's nothing for me to send.");
  }
  if (form.several) return fail(SEVERAL_TO_SEND);
  if (form.send && form.body) return { ok: true, draft: mine };
  draft = null;
  return fail("The draft isn't open in your mail tab any more, so there's nothing for me to send.");
}

const SENT = /\b(?:message sent|your message (?:has been|was) sent|e-?mail sent|sent successfully)\b/i;
const SEND_ERROR = /\b(?:not sent|couldn'?t (?:be )?sen[dt]|could not be sent|failed to send|specify at least one recipient|address .{0,40}(?:not recogni[sz]ed|invalid)|error sending)\b/i;

function sentSign(s: PortSnapshot): "confirmed" | "closed" | "none" {
  if (SENT.test(s.text) || s.controls.some((c) => SENT.test(c.name) || /^(?:view message|undo send)$/i.test(c.name.trim()))) return "confirmed";
  const form = mailForm(s.controls);
  return !form.send && !form.body ? "closed" : "none";
}

export type SendOutcome =
  /** The page said so ("Message sent"). */
  | { sent: "confirmed" }
  /** Send was pressed and the form closed, but the page showed no confirmation. */
  | { sent: "closed" }
  /** Send was pressed and the form is still there (with an error, when the page shows one). */
  | { sent: "unclear"; error: boolean };

/**
 * Press the page's Send on the open draft — once — and say what the page showed afterwards. Only ever called from
 * the user's "yes, send".
 */
export async function pressSend(port: BrowserPort): Promise<{ ok: true; outcome: SendOutcome; draft: MailDraft } | Fail> {
  const mine = openDraft();
  if (!mine) return fail("There's no draft of mine open to send.");
  let snap: PortSnapshot;
  try {
    snap = await port.snapshot(mine.tabId);
  } catch {
    draft = null;
    return fail("Your mail tab isn't there any more, so nothing was sent.");
  }
  const form = mailForm(snap.controls);
  // Two messages open: the Send of the one Trinity wrote can't be told from the other's. Nothing is pressed.
  if (form.several) return fail(SEVERAL_TO_SEND);
  const send = form.send;
  if (!send) {
    draft = null;
    return fail("I don't see a Send button any more — the draft may have been closed. Nothing was sent.");
  }
  const clicked = await port.click(mine.tabId, send.ref, { approved: send.name });
  // The browser's own guard held it: nothing was pressed, and the draft stands.
  if (clicked.held) return fail("The browser held the click on Send, so it hasn't gone. Press Send in your mail tab yourself.");
  // Whatever happens next, this draft is not sent a second time.
  draft = null;
  if (!clicked.ok) return fail("I couldn't press Send, and I can't tell whether it went. Check your mail tab before trying again.");
  const after = await port.waitFor(mine.tabId, (s) => sentSign(s) !== "none", mailTiming.stepMs);
  if (after) return { ok: true, outcome: { sent: sentSign(after) === "confirmed" ? "confirmed" : "closed" }, draft: mine };
  let error = false;
  try {
    error = SEND_ERROR.test((await port.snapshot(mine.tabId)).text);
  } catch {
    /* the tab went away after the click */
  }
  return { ok: true, outcome: { sent: "unclear", error }, draft: mine };
}
