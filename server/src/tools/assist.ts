import { registerContextProvider } from "../agent/context.js";
import { askYesNo, dropPending } from "../agent/pending.js";
import { tell } from "../agent/tell.js";
import { getProfileName } from "../db/sqlite.js";
import { bookingLine, bookingLink, latestResults, pickItem } from "../services/assist/booking.js";
import { browserPort } from "../services/assist/browser-port.js";
import { calendarCard, calendarEvents, calendarLine, clashesWith, parseCalendarAsk, titleSaid } from "../services/assist/calendar.js";
import { assistCardNumber, showAssistCard } from "../services/assist/cards.js";
import {
  addressFor,
  draftCard,
  draftSubject,
  filterRows,
  inboxCard,
  inboxLine,
  messageCard,
  messageLine,
  nameSaid,
  parseEmailAsk,
  parseMailAsk,
  parsePick,
  pickRow,
  reviseEmail,
  sentLine,
  tidy,
  wantsReadOut,
  who,
  writeEmail,
  type EmailAsk,
} from "../services/assist/mail-words.js";
import {
  answerInvitations,
  eventFormOnPage,
  meetingCard,
  meetingWhen,
  openEventForm,
  openEventFormFor,
  parseMeeting,
  pressSave,
  savedLine,
  whenWords,
  type MeetingDraft,
} from "../services/assist/meeting.js";
import { ASSIST_TOOL_LIST, setAssistRouteState, type AssistRouteState } from "../services/assist/routes.js";
import { assistNow, assistZone, fmtClock, relDay, ymdOf } from "../services/assist/time.js";
import { plain } from "../services/assist/untrusted.js";
import {
  draftOnPage,
  lastInbox,
  lastMessage,
  openDraft,
  openRow,
  pressSend,
  readInbox,
  readShownMessage,
  retypeBody,
  writeDraft,
  type MailDraft,
  type MailRow,
  type OpenMessage,
} from "../services/assist/webmail.js";
import { getEndpoints } from "../settings.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { workspace } from "../workspace/bus.js";
import { registerTool } from "./registry.js";

/*
 * Everyday assistant tools, worked through the user's own signed-in browser (the Chrome extension, through
 * services/assist/browser-port.ts) — no mail or calendar account is set up in the engine:
 *
 *   check_email      list the inbox: "check my email", "did Sam write back", "anything from the bank this week"
 *   read_email       open one message and say what it says: "read the one from Sam", "open the second one"
 *   draft_email      write an email or a reply into the mail page's own form, or change that draft — never sends
 *   send_email       press Send on that draft, after a spoken "yes, send it"
 *   check_calendar   "what's on my calendar tomorrow", "am I free at three", "when is my next meeting"
 *   schedule_meeting open the calendar's new-event form filled in — never saves
 *   save_meeting     press Save on that form, after a spoken "yes, save it"
 *   open_booking     open the page of a flight, hotel or product from the results on the board — buys nothing
 *
 * Reading (check_email, read_email, check_calendar) is open to scheduled runs: "every morning tell me if I have new
 * mail". Everything that writes, sends, saves or opens a page to buy from is `sensitive`: only the user's own words
 * start it (ctx.userWords ?? ctx.utterance is what is read), and the two that can't be taken back — Send and Save —
 * wait for a yes that says the word.
 *
 * What a page says is data all the way through: see services/assist/untrusted.ts. A tool's spoken line is put
 * together here and in services/assist/ from names and titles that were checked against the page; the one
 * model-written line that is spoken is a message's two-sentence summary, and it is cut, scrubbed and checked too.
 */

/** How long a tool keeps the user waiting before it says the answer is on its way (act.ts gives a tool 15 s). */
export const assistTiming = { speakWaitMs: 10_000 };

const said = (line: string, data?: Record<string, unknown>): ToolResult => ({ ok: true, say: line, speak: line, ...(data ? { data } : {}) });
/** A plain answer that something can't be done: spoken as it is written (act.ts speaks a failed tool's own words). */
const cant = (line: string): ToolResult => ({ ok: false, say: line });
const needsBrowser = (what: string): ToolResult => cant(`I need the browser extension connected to ${what} — it's in Settings, under Browser.`);
/** The user's own words: what a sensitive tool reads, whoever ran it. */
const own = (ctx: ToolContext): string => (ctx.userWords ?? ctx.utterance ?? "").replace(/\s+/g, " ").trim();
/**
 * Whether the user asked for this themselves, just now: not a planner working through a job (it carries the user's
 * words apart from its own), nor a scheduled run (the heartbeat shows a "heartbeat:<id>" chip while one runs, and
 * such a run has no conversation behind it).
 */
const askedByUser = (ctx: ToolContext): boolean =>
  // act() says who is asking; the rest is for a tool run some other way.
  ctx.origin
    ? ctx.origin === "user"
    : ctx.userWords === undefined && !(ctx.recentTranscript.length === 0 && workspace.snapshot().activities.some((a) => a.id.startsWith("heartbeat:")));

/**
 * Run the work, and answer with it when it is quick; when it isn't, say it is on its way and tell the answer when
 * it lands (as tools/content.ts does for a card). The work never throws out of here.
 */
async function answer(ctx: ToolContext, label: string, busy: string, later: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  const id = `assist:${label}`;
  workspace.activity(id, busy);
  const running = work()
    .catch((err: unknown): ToolResult => {
      console.warn(`[${label}] ${(err as Error).message}`);
      return cant("Something went wrong on my side, so that didn't get done.");
    })
    .finally(() => workspace.activity(id, null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([running, new Promise<"later">((r) => (timer = setTimeout(() => r("later"), assistTiming.speakWaitMs)))]);
  clearTimeout(timer);
  if (first !== "later") return first;
  void running.then((r) => tell(ctx, r.speak ?? r.say ?? "", label));
  return { ok: true, say: later, inProgress: "started" };
}

// ─── What the tools remember between sentences ────────────────────────────────

const ASKED_FRESH_MS = 2 * 60_000;

/** The rows on the inbox card, in the card's order ("open the second one" counts these). */
let shownRows: MailRow[] = [];
/** The row last opened, by its place on the card ("the next one"). */
let lastRead: number | null = null;
/** Trinity asked whose address an email should go to: the answer joins the request. */
let awaitingAddress: { words: string; ask: EmailAsk; at: number } | null = null;
/** Trinity asked what an email should say: the answer joins the request. */
let awaitingMessage: { words: string; ask: EmailAsk; at: number } | null = null;
/** Trinity asked when an event should be: the answer joins the request. */
let awaitingTime: { words: string; at: number } | null = null;
/** The send question that is waiting, and the draft it was asked about. */
let sendQuestion: { id: string; draft: MailDraft } | null = null;
/** The save question that is waiting (a new event form withdraws it). */
let saveQuestion: string | null = null;

const fresh = <T extends { at: number }>(x: T | null): T | null => (x && assistNow() - x.at <= ASKED_FRESH_MS && assistNow() >= x.at ? x : null);
/** Said in answer to one of Trinity's own questions: the thing it was asked about is dropped. */
const NEVER_MIND = /^(?:(?:oh|uh|um|no|actually)[\s,]+)*(?:never ?mind|forget (?:it|that)|cancel(?: (?:it|that))?|skip (?:it|that)|don'?t bother)\b/i;
const sameDraft = (a: MailDraft, b: MailDraft | null): boolean => b !== null && a.tabId === b.tabId && a.to === b.to && a.subject === b.subject && a.body === b.body && a.reply === b.reply;

/** What the assistant tools are in the middle of — for routing ("send it" only means something while a draft is open). */
export function assistState(): AssistRouteState {
  return {
    inboxListed: lastInbox() !== null && shownRows.length > 0,
    messageOpen: lastMessage() !== null,
    draftOpen: openDraft() !== null,
    eventFormOpen: openEventForm() !== null,
    awaitingEmailAnswer: fresh(awaitingAddress) !== null || fresh(awaitingMessage) !== null,
    awaitingTime: fresh(awaitingTime) !== null,
  };
}

/** Tests: forget what the tools remember between sentences (the page state is reset in services/assist/). */
export function resetAssist(): void {
  shownRows = [];
  lastRead = null;
  awaitingAddress = null;
  awaitingMessage = null;
  awaitingTime = null;
  sendQuestion = null;
  saveQuestion = null;
}

const clockNow = (): string => fmtClock(assistNow(), assistZone());

// ─── check_email ──────────────────────────────────────────────────────────────

const checkEmail: Tool = {
  name: "check_email",
  description:
    "Look at the user's email inbox and say what is there, without opening anything: 'check my email', 'any new mail?', 'do I have unread email', 'did Sam write back?', 'anything from the bank this week?'.",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("read your email");
    const today = ymdOf(assistNow(), assistZone());
    const filter = parseMailAsk(ctx.utterance, today);
    return answer(ctx, "check_email", "Reading your inbox…", "I'm reading your inbox — I'll tell you what's there in a moment.", async () => {
      // Unread mail alone has a view of its own on Gmail; a question about a sender or a subject reads the whole list.
      const read = await readInbox(port, { unreadOnly: filter.unread && !filter.sender && !filter.topic });
      if (!read.ok) return cant(read.say);
      const shown = filterRows(read.view.rows, filter, today);
      shownRows = shown;
      lastRead = null;
      // The card's number goes into the line, so a new card goes up first and is written again once the line is known.
      let card = assistCardNumber("inbox");
      if (card === null && shown.length) card = showAssistCard("inbox", inboxCard(filter, read.view, shown, "", clockNow()));
      const line = inboxLine(filter, read.view, shown, read.knownEmpty, shown.length ? card : null, today);
      if (card !== null) card = showAssistCard("inbox", inboxCard(filter, read.view, shown, line, clockNow()));
      return said(line, { card, shown: shown.length, listed: read.view.rows.length, unreadOnly: read.view.unreadOnly });
    });
  },
};

// ─── read_email ───────────────────────────────────────────────────────────────

function spokenMessage(message: OpenMessage, readOut: boolean): ToolResult {
  const line = messageLine(message, readOut);
  const card = showAssistCard("message", messageCard(message, messageLine(message, false)));
  return said(line, { card, readOut, ignored: message.ignored, asks: Object.entries(message.asks).filter(([, v]) => v).map(([k]) => k) });
}

const readEmail: Tool = {
  name: "read_email",
  description:
    "Open one email and say what it says — a short summary, or the message read out: 'read the one from Sam', 'open the second one', 'what does it say?', 'read it out'. Links and attachments in it are never opened.",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("read your email");
    const words = ctx.utterance;
    const pick = parsePick(words);
    const readOut = wantsReadOut(words);
    // (A row whose name the browser's guard holds is opened only on the user's own asking: see openRow.)
    const byUser = askedByUser(ctx);
    return answer(ctx, "read_email", "Opening that message…", "I'm opening that message — I'll tell you what it says in a moment.", async () => {
      // "What does it say", "read it out": the message that is open — else the one row the words can only mean.
      if (pick.by === "it" || pick.by === "none") {
        const view = lastInbox();
        const only = !lastMessage() && view ? pickRow({ by: "it" }, shownRows, lastRead) : null;
        if (only && view) {
          const opened = await openRow(port, view, only.row, byUser);
          if (!opened.ok) return cant(opened.say);
          lastRead = only.index;
          return spokenMessage(opened.message, readOut);
        }
        const shown = await readShownMessage(port);
        if (!shown.ok) return cant(view && shownRows.length > 1 ? "Which one? Say its number on the card, or who it's from." : shown.say);
        return spokenMessage(shown.message, readOut);
      }
      let view = lastInbox();
      let found = view ? pickRow(pick, shownRows, lastRead) : null;
      const byWords = pick.by === "sender" || pick.by === "topic";
      // Not on the card: the rest of the list that was read, then a fresh look at the whole inbox.
      let onCard = found !== null;
      if (!found && view && byWords) found = pickRow(pick, view.rows, null);
      if (!found && byWords && (!view || view.unreadOnly)) {
        const read = await readInbox(port, { unreadOnly: false });
        if (!read.ok) return cant(read.say);
        view = read.view;
        found = pickRow(pick, view.rows, null);
        onCard = false;
      }
      if (!view) return cant("I haven't looked at your inbox yet. Say check my email, then tell me which one to open.");
      if (!found) {
        if (pick.by === "sender") return cant(`I don't see a message from ${plain(pick.said, 4, 40)} in your inbox list.`);
        if (pick.by === "topic") return cant(`I don't see a message about ${plain(pick.said, 5, 40)} in your inbox list.`);
        return cant(shownRows.length ? `There ${shownRows.length === 1 ? "is only 1 message" : `are only ${shownRows.length} messages`} on the card.` : "There's nothing on the inbox card to open. Say check my email first.");
      }
      const opened = await openRow(port, view, found.row, byUser);
      if (!opened.ok) return cant(opened.say);
      lastRead = onCard ? found.index : null;
      return spokenMessage(opened.message, readOut);
    });
  },
};

// ─── draft_email ──────────────────────────────────────────────────────────────

const SAYS_EMAIL = /\b(?:e-?mail|reply|respond|write (?:back|to|an?|him|her|them)|message|send|shoot|draft|answer (?:him|her|them|it|that|back)|get back to|tell (?:him|her|them)|let (?:him|her|them) know|drop (?:\S+ )?(?:an? )?(?:note|line))\b/i;

const userName = (): string | null => {
  try {
    return getProfileName();
  } catch {
    return null;
  }
};

/** A new draft (or a changed one) means the send question that was waiting is about something else now. */
function dropSendQuestion(): void {
  if (sendQuestion) dropPending(sendQuestion.id);
  sendQuestion = null;
}

const draftEmail: Tool = {
  name: "draft_email",
  description:
    "Write an email or a reply for the user as a draft in their mail tab, or change the draft that is open: 'email Sam that I'll be ten minutes late', 'reply that Friday works', 'write back and ask for the invoice', 'make it shorter', 'add that I'm sorry'. It never sends.",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("write an email");
    let words = own(ctx);
    let ask = parseEmailAsk(words, openDraft() !== null);
    // An answer to Trinity's own question joins the request it answers: an address after "What's Sam's email
    // address?", what to say after "What should it say?".
    const askedAddress = fresh(awaitingAddress);
    const askedMessage = fresh(awaitingMessage);
    if ((askedAddress || askedMessage) && NEVER_MIND.test(tidy(words))) {
      awaitingAddress = null;
      awaitingMessage = null;
      return said("Okay, I've dropped that email.", { dropped: true });
    }
    const answered = askedMessage && ask.kind !== "revise" && !ask.address && !(ask.kind === "new" && ask.name) ? tidy(words).replace(/^(?:(?:just )?(?:say|tell (?:him|her|them)|write)(?: that)?|saying(?: that)?|that|it should say(?: that)?)\s+/i, "") : "";
    if (askedAddress && ask.address && ask.kind === "new" && !ask.name && !SAYS_EMAIL.test(tidy(words).replace(ask.address, ""))) {
      ask = { ...askedAddress.ask, address: ask.address };
      words = askedAddress.words;
    } else if (askedMessage && answered) {
      ask = { ...askedMessage.ask, message: answered };
      words = `${askedMessage.words} ${answered}`;
    } else if (ask.kind !== "revise" && !SAYS_EMAIL.test(words)) {
      return cant("I only write an email when you ask me to yourself. Tell me who it's for and what to say.");
    }
    awaitingAddress = null;
    awaitingMessage = null;

    return answer(ctx, "draft_email", "Writing that email…", "I'm writing that email — I'll tell you when the draft is ready.", async () => {
      if (ask.kind === "revise") {
        const current = openDraft();
        if (!current) return cant("There's no draft of mine open to change. Tell me who to email and what to say.");
        const body = await reviseEmail(words, current);
        if (!body) return cant("I couldn't work out that change. Tell me what the email should say instead.");
        const retyped = await retypeBody(port, body);
        if (!retyped.ok) return cant(retyped.say);
        dropSendQuestion();
        const card = showAssistCard("draft", draftCard(retyped.draft));
        return said("I've changed it — say send it, or tell me what else to change.", { card, revised: true });
      }

      if (ask.kind === "reply") {
        let message = lastMessage();
        if (!message) {
          const shown = await readShownMessage(port);
          if (!shown.ok) return cant("Which email should I reply to? Say check my email, then open one.");
          message = shown.message;
        }
        const to = message.address ?? who(message.from);
        if (!ask.message) {
          awaitingMessage = { words, ask, at: assistNow() };
          return said(`What should the reply to ${who(message.from)} say?`, { asked: "message" });
        }
        const text = await writeEmail(words, ask, { toName: who(message.from), toAddress: null, userName: userName(), replyingTo: { from: message.from, subject: message.subject } });
        const written = await writeDraft(port, { to, subject: "", body: text.body, reply: true });
        if (!written.ok) return cant(written.say);
        dropSendQuestion();
        const card = showAssistCard("draft", draftCard(written.draft));
        return said(`Your reply to ${to} is drafted — say send it, or tell me what to change.`, { card, reply: true });
      }

      // A new message: the address said, or one Trinity already knows for the name — otherwise it is asked for.
      let address = ask.address;
      const toName = ask.name ? nameSaid(ask.name) : "";
      if (!address) {
        if (!ask.name) return said("Who should it go to?", { asked: "recipient" });
        address = await addressFor(ctx.memory, ask.name);
        if (!address) {
          awaitingAddress = { words, ask, at: assistNow() };
          return said(`What's ${toName}${/s$/i.test(toName) ? "'" : "'s"} email address?`, { asked: "address" });
        }
      }
      if (!ask.message) {
        // "Email Dana instead": the form's recipient field can't be emptied from here (what is in it stays, and a
        // second address typed in would make two), so the open draft is not readdressed.
        const current = openDraft();
        if (current && !current.reply && current.to !== address) return cant(`I can't change who a draft goes to once it's in the form. Change the recipient in your mail tab — or close the draft to ${current.to} and ask me again.`);
        awaitingMessage = { words, ask: { ...ask, address }, at: assistNow() };
        return said(`What should the email to ${toName || address} say?`, { asked: "message" });
      }
      const text = await writeEmail(words, ask, { toName, toAddress: address, userName: userName() });
      const written = await writeDraft(port, { to: address, subject: text.subject, body: text.body, reply: false });
      if (!written.ok) return cant(written.say);
      dropSendQuestion();
      const card = showAssistCard("draft", draftCard(written.draft));
      return said(`It's drafted to ${address} — say send it, or tell me what to change.`, { card, reply: false });
    });
  },
};

// ─── send_email ───────────────────────────────────────────────────────────────

const sendEmail: Tool = {
  name: "send_email",
  description: "Send the email draft Trinity just wrote, after asking first: 'send it', 'send the email', 'go ahead and send that' (only while that draft is open).",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: () => openDraft() !== null,
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("send email");
    if (!/\bsend\b/i.test(own(ctx))) return cant("I only send an email when you tell me to yourself. Say send it.");
    const there = await draftOnPage(port);
    if (!there.ok) return cant(there.say);
    const draft = there.draft;
    const subject = draftSubject(draft, lastMessage());
    const question = draft.reply ? `Send this reply to ${draft.to}: “${subject}”?` : `Send this to ${draft.to}: “${subject}”?`;
    const id: string = askYesNo({
      question,
      // A bare "yeah" in conversation doesn't send mail: the yes has to say so.
      require: ["send"],
      onAnswer: async (yes): Promise<ToolResult> => {
        const asked = sendQuestion?.id === id ? sendQuestion.draft : null;
        if (sendQuestion?.id === id) sendQuestion = null;
        if (!yes) return said("Okay, I haven't sent it. The draft is still in your mail tab.", { sent: false });
        // The yes is for the draft that was asked about: one changed or replaced since needs asking again.
        if (!asked || !sameDraft(asked, openDraft())) return cant("That draft has changed since I asked, so I haven't sent it. Say send it again.");
        // (The yes comes in through answer_question, which has a tool's fifteen seconds like any other.)
        return answer(ctx, "send_email", "Sending that email…", "I'm pressing Send — I'll tell you how it went.", async () => {
          const now = browserPort();
          if (!now.connected()) return needsBrowser("send email");
          const pressed = await pressSend(now);
          if (!pressed.ok) return cant(pressed.say);
          return said(sentLine(pressed.outcome, pressed.draft), { sent: pressed.outcome.sent });
        });
      },
    });
    sendQuestion = { id, draft };
    return said(`${question} Say yes, send it — or no.`, { asked: "send" });
  },
};

// ─── check_calendar ───────────────────────────────────────────────────────────

const checkCalendar: Tool = {
  name: "check_calendar",
  description:
    "Say what is on the user's own calendar, or whether they are free: 'what's on my calendar today / tomorrow / Friday / this week', 'am I free at three?', 'do I have anything tomorrow afternoon?', 'when is my next meeting?'.",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    const now = assistNow();
    const zone = assistZone();
    const ask = parseCalendarAsk(ctx.utterance, ymdOf(now, zone));
    return answer(ctx, "check_calendar", "Reading your calendar…", "I'm reading your calendar — I'll tell you what's on it in a moment.", async () => {
      // A saved calendar feed needs no browser; the calendar page does (calendarEvents says so when it is missing).
      const found = await calendarEvents(browserPort(), ask, now, zone);
      if (!found.ok) return cant(found.say);
      let card = assistCardNumber("calendar");
      if (card === null && found.events.length) card = showAssistCard("calendar", calendarCard(ask, found, "", now, zone));
      const line = calendarLine(ask, found, now, zone, found.events.length ? card : null);
      if (card !== null) card = showAssistCard("calendar", calendarCard(ask, found, line, now, zone));
      return said(line, { card, events: found.events.length, source: found.source });
    });
  },
};

// ─── schedule_meeting ─────────────────────────────────────────────────────────

const SAYS_SCHEDULE = /\b(?:schedule|set up|book|put|add|create|make|arrange|plan|organi[sz]e|block|pencil|slot|calendar|meeting|appointment|invite)\b/i;
/** Words that start a request of their own (rather than answer "what time?"). */
const STARTS_EVENT = /\b(?:schedule|set up|book|block|create|arrange|organi[sz]e|pencil in)\b[^.?!]*\b(?:meeting|call|lunch|dinner|breakfast|coffee|appointment|time|hours?|minutes?|session|with)\b/i;
const and = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const scheduleMeeting: Tool = {
  name: "schedule_meeting",
  description:
    "Put something new on the user's calendar by filling in the calendar's own new-event form: 'schedule a meeting with Sam tomorrow at three for half an hour about the roadmap', 'put lunch with Dana on Friday at noon', 'block two hours for writing on Monday morning'. It never saves by itself.",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("fill in a calendar event");
    const words = own(ctx);
    const now = assistNow();
    const zone = assistZone();
    // A day or a time given in answer to "What time tomorrow?" joins the request it answers — its time words only.
    const waiting = fresh(awaitingTime);
    let request = words;
    if (waiting && NEVER_MIND.test(tidy(words))) {
      awaitingTime = null;
      return said("Okay, I've dropped that event.", { dropped: true });
    }
    if (waiting && !STARTS_EVENT.test(words)) {
      const when = whenWords(words, ymdOf(now, zone));
      if (!when) return said("I didn't catch a time in that. When should it be?", { asked: "no-time" });
      request = `${waiting.words} ${when}`;
    } else if (!SAYS_SCHEDULE.test(words)) {
      return cant("I only put something on your calendar when you ask me to yourself. Tell me what to schedule, and when.");
    }
    const parsed = parseMeeting(request, now, zone);
    if (!parsed.ok) {
      awaitingTime = { words: request, at: now };
      return said(parsed.ask, { asked: parsed.why });
    }
    awaitingTime = null;

    return answer(ctx, "schedule_meeting", "Filling in the event…", "I'm filling in that event — I'll tell you when the form is ready.", async () => {
      // Guests need an address: one said outright, or one Trinity already knows for the name. Anyone else is left off, and said.
      const guests: MeetingDraft["guests"] = parsed.guestAddresses.map((email) => ({ name: email, email }));
      const leftOff: string[] = [];
      for (const name of parsed.guestNames) {
        const email = await addressFor(ctx.memory, name);
        if (email && !guests.some((g) => g.email === email)) guests.push({ name, email });
        else if (!email) leftOff.push(name);
      }
      const meeting: MeetingDraft = { title: parsed.title, start: parsed.start, end: parsed.end, guests, note: parsed.note };
      const clash = await clashesWith(meeting.start, meeting.end, zone);
      const opened = await openEventFormFor(port, meeting, getEndpoints().calendarUrl, zone);
      if (!opened.ok) return cant(opened.say);
      // A save question that was waiting was about the form before this one.
      if (saveQuestion) dropPending(saveQuestion);
      saveQuestion = null;
      const card = showAssistCard("meeting", meetingCard(meeting, leftOff, now, zone));
      const caveats = [
        parsed.repeats ? "It's for that one time — set the repeat on the form before you save." : "",
        leftOff.length ? `I don't have an address for ${and(leftOff)}, so they're not invited.` : "",
        clash?.length ? `Heads up: it overlaps ${titleSaid(clash[0]!.title)} at ${fmtClock(clash[0]!.start, zone)}.` : "",
      ].filter(Boolean);
      const line = [
        `${opened.ready ? "It's filled in" : "I've opened the form with it filled in"}: ${meeting.title}, ${meetingWhen(meeting, now, zone)}.`,
        ...caveats,
        opened.ready ? "Say save it to put it on your calendar." : "It was still loading when I looked — say save it once you see it.",
      ].join(" ");
      return said(line, { card, guests: guests.length, leftOff: leftOff.length, clash: clash?.length ?? null });
    });
  },
};

// ─── save_meeting ─────────────────────────────────────────────────────────────

const saveMeeting: Tool = {
  name: "save_meeting",
  description: "Save the calendar event Trinity just filled in, after asking first: 'save it', 'save the meeting', 'put it on my calendar' (only while that form is open).",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: () => openEventForm() !== null,
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("save the event");
    if (!/\b(?:save|put it|add it)\b/i.test(own(ctx))) return cant("I only save an event when you tell me to yourself. Say save it.");
    const there = await eventFormOnPage(port);
    if (!there.ok) return cant(there.say);
    const meeting = there.meeting;
    const zone = assistZone();
    const when = `${relDay(ymdOf(meeting.start, zone), ymdOf(assistNow(), zone))} at ${fmtClock(meeting.start, zone)}`;
    const guests = and(meeting.guests.map((g) => g.email));
    // Saving an event with guests can email them: the question says so.
    const invites = !meeting.guests.length ? "" : there.sendsInvitations ? `, and send the invitation to ${guests}` : `, with ${guests} invited`;
    const question = `Save “${meeting.title}”, ${when}${invites}?`;
    const id: string = askYesNo({
      question,
      require: ["save"],
      onAnswer: async (yes): Promise<ToolResult> => {
        if (saveQuestion === id) saveQuestion = null;
        if (!yes) return said("Okay, it isn't saved. The form is still open in your calendar tab.", { saved: false });
        // The yes is for the event that was asked about.
        if (openEventForm()?.meeting !== meeting) return cant("That event has changed since I asked, so I haven't saved it. Say save it again.");
        // (The yes comes in through answer_question, which has a tool's fifteen seconds like any other.)
        return answer(ctx, "save_meeting", "Saving that event…", "I'm pressing Save — I'll tell you how it went.", async () => {
          const now = browserPort();
          if (!now.connected()) return needsBrowser("save the event");
          const pressed = await pressSave(now);
          if (!pressed.ok) return cant(pressed.say);
          if (pressed.outcome.saved === "asks-invitations") {
            // The calendar asks whether to email the guests. That is its own question: only a yes that says "send" sends them.
            const ask = `Your calendar asks whether to email invitations to ${guests}. Send them?`;
            askYesNo({
              question: ask,
              require: ["send"],
              onAnswer: async (send): Promise<ToolResult> => {
                // (A no — or no answer at all — presses nothing: the calendar's own question stays up for the user.)
                if (!send) return said("Okay — I haven't answered it. Your calendar is still asking; choose there to finish saving.", { saved: false });
                return answer(ctx, "save_meeting", "Answering the calendar…", "I'm answering the calendar — I'll tell you how it went.", async () => {
                  const again = browserPort();
                  if (!again.connected()) return needsBrowser("answer the calendar");
                  const done = await answerInvitations(again, true);
                  if (!done.ok) return cant(done.say);
                  if (done.outcome.saved !== "unclear") showAssistCard("meeting", meetingCard(meeting, [], assistNow(), zone, true));
                  return said(`${savedLine(done.outcome, meeting, assistNow(), zone)}${done.outcome.saved === "unclear" ? "" : " I pressed Send on the invitations."}`, { saved: done.outcome.saved });
                });
              },
            });
            return said(`${ask} Say yes, send them — or no.`, { asked: "invitations" });
          }
          if (pressed.outcome.saved !== "unclear") showAssistCard("meeting", meetingCard(meeting, [], assistNow(), zone, true));
          return said(savedLine(pressed.outcome, meeting, assistNow(), zone), { saved: pressed.outcome.saved });
        });
      },
    });
    saveQuestion = id;
    return said(`${question} Say yes, save it — or no.`, { asked: "save" });
  },
};

// ─── open_booking ─────────────────────────────────────────────────────────────

const SAYS_BOOK = /\b(?:book|booking|reserve|buy|order|purchase|get|open)\b/i;

const openBooking: Tool = {
  name: "open_booking",
  description:
    "Open the booking page of a flight, hotel or product from the results on the board: 'book the second flight', 'book that hotel', 'open the first one to book', 'buy the cheapest one'. It opens the page and buys nothing.",
  // No arguments: the link is only ever the result's own.
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    const port = browserPort();
    if (!port.connected()) return needsBrowser("open a booking page");
    const words = own(ctx);
    if (!SAYS_BOOK.test(words)) return cant("I only open a booking page when you ask me to yourself. Tell me which result to book.");
    const results = latestResults();
    if (!results) return cant("I don't see flight, hotel or shopping results on the board to book from. Ask me to find some first.");
    const pick = pickItem(words, results);
    if (!pick.ok) return said(pick.say, { asked: "which" });
    const link = bookingLink(pick.item);
    if (!link.ok) return cant(link.say);
    try {
      await port.open(link.url, { reuse: false });
    } catch (err) {
      return cant(`I couldn't open that page: ${(err as Error).message.replace(/\s+/g, " ").slice(0, 120)}.`);
    }
    return said(bookingLine(pick.item, link.url), { card: results.card, kind: results.kind, index: pick.index + 1 });
  },
};

// ─── Registration ─────────────────────────────────────────────────────────────

/** The eight tools' names (kept in services/assist/routes.ts, which the router can import without a cycle). */
export const ASSIST_TOOL_NAMES = ASSIST_TOOL_LIST;

const ASSIST_RULES = [
  "Email: looking at the inbox — 'check my email', 'any new mail', 'did Sam write back', 'anything from the bank' — is check_email. Opening or hearing ONE message — 'read the one from Sam', 'open the second one' after the inbox was listed, 'what does it say', 'read it out' — is read_email, not read_card or browser_read. 'Open Gmail' alone is browser_open.",
  "Writing email — 'email Sam that…', 'reply that…', 'write back and ask…' — is draft_email, which only drafts. A note for the board is make_text and a fact to keep is remember: only 'email / reply / write to someone' is draft_email.",
  "The user's own calendar — 'what's on my calendar tomorrow', 'am I free at three', 'when is my next meeting' — is check_calendar; get_time only says the time or today's date. Putting something ON the calendar — a meeting, a call, lunch with someone, a block of time — is schedule_meeting; 'remind me…' and anything Trinity should say or do later is schedule.",
  "'Book the second flight', 'book that hotel', 'open the first one to book', 'buy the cheapest one' about results already on the board is open_booking; looking for flights, hotels or things to buy is show_card.",
];

function stateRules(): string[] {
  const s = assistState();
  const rules: string[] = [];
  if (s.draftOpen) rules.push("An email draft Trinity wrote is open: 'send it' / 'send that' is send_email (not browser_act); a change to it — 'make it shorter', 'add that I'm sorry', 'more formal' — is draft_email.");
  if (s.eventFormOpen) rules.push("A calendar event Trinity filled in is open, not saved: 'save it' / 'put it on my calendar' is save_meeting (not browser_save or remember).");
  if (s.awaitingEmailAnswer) rules.push("Trinity just asked for someone's email address, or what an email should say: the user's answer is draft_email.");
  if (s.awaitingTime) rules.push("Trinity just asked when a calendar event should be: the user's answer — a day or a time — is schedule_meeting.");
  return rules;
}

/** The situation, in sentences written here (never a page's words: this line is in every routing prompt). */
function situation(): string | null {
  const s = assistState();
  const parts = [
    s.inboxListed ? "Trinity listed the user's inbox on the board, numbered." : "",
    s.messageOpen ? "An email is open in the user's mail tab." : "",
    s.draftOpen ? "An email draft Trinity wrote is open in the user's mail tab, not sent." : "",
    s.eventFormOpen ? "A new calendar event Trinity filled in is open in the browser, not saved." : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

export function registerAssistTools(): void {
  [checkEmail, readEmail, draftEmail, sendEmail, checkCalendar, scheduleMeeting, saveMeeting, openBooking].forEach(registerTool);
  // Jev gets the distinctions as rules; the keyword fallback reads the same state through services/assist/routes.ts.
  registerContextProvider({ describe: () => situation(), rules: () => [...ASSIST_RULES, ...stateRules()] });
  setAssistRouteState(() => assistState());
}
