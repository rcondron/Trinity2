/*
 * Keyless routing for the assistant tools: which of them a sentence asks for, by its words alone — what the router's
 * keyword fallback (agent/router.ts, used when there is no Jev key or Jev is down) needs to know about email,
 * calendar and bookings. With Jev, the same distinctions go in as rules (tools/assist.ts registers them).
 *
 * This file imports nothing from the engine, so the router can import it without a cycle; tools/assist.ts hands in
 * what the tools are in the middle of (setAssistRouteState), because "send it", "save it", "make it shorter" and
 * "open the second one" only mean these tools while a draft, a form or the inbox list is there.
 *
 * The patterns read the user's latest words in lower case with straight apostrophes, as the router's own do.
 */

export interface AssistRouteState {
  /** The inbox was listed on the board lately ("open the second one" means a row of it). */
  inboxListed: boolean;
  /** An email is open in the mail tab ("what does it say", "read it out"). */
  messageOpen: boolean;
  /** A draft Trinity wrote is open, not sent ("send it", "make it shorter"). */
  draftOpen: boolean;
  /** An event form Trinity filled in is open, not saved ("save it"). */
  eventFormOpen: boolean;
  /** Trinity just asked for an address, or what an email should say. */
  awaitingEmailAnswer: boolean;
  /** Trinity just asked when an event should be. */
  awaitingTime: boolean;
}

/** The assistant tools, by name (tools/assist.ts registers them; the router's last-resort name match should skip them). */
export const ASSIST_TOOL_LIST = ["check_email", "read_email", "draft_email", "send_email", "check_calendar", "schedule_meeting", "save_meeting", "open_booking"] as const;
export const ASSIST_TOOLS: ReadonlySet<string> = new Set(ASSIST_TOOL_LIST);

const NOTHING: AssistRouteState = { inboxListed: false, messageOpen: false, draftOpen: false, eventFormOpen: false, awaitingEmailAnswer: false, awaitingTime: false };
let stateOf: () => AssistRouteState = () => NOTHING;

/** tools/assist.ts: where the routing reads what the tools are in the middle of. */
export function setAssistRouteState(get: (() => AssistRouteState) | null): void {
  stateOf = get ?? (() => NOTHING);
}

const DAY = String.raw`(?:today|tonight|tomorrow|this (?:week|weekend|morning|afternoon|evening)|next week|(?:on |next |this )?(?:mon|tues|wednes|thurs|fri|satur|sun)day)`;
const ORDINAL = String.raw`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|top|latest|newest)`;
const EVENT = String.raw`(?:meeting|call|appointment|lunch|dinner|breakfast|brunch|coffee|drinks|sync|stand-?up|catch[- ]?up|check[- ]?in|one[- ]on[- ]one|1[- ]on[- ]1|interview|review|event|session|workout|gym|haircut)`;

export const ASSIST_ROUTES = {
  /** send_email — only offered while a draft is open. ("Send this page to…" is something else.) */
  SEND_EMAIL: /\bsend (?:(?:it|that|this)(?=$|[.!?,]| (?:please|now|off|e-?mail|message|draft|reply|one)\b)|the (?:e-?mail|message|draft|reply)\b)|^(?:(?:ok(?:ay)?|yes|yeah|alright|now|please)[\s,]+)*send(?: it)?(?: now| off)?[.!]?$/,
  /** save_meeting — only offered while the event form is open. ("Save this page" is something else.) */
  SAVE_MEETING:
    /\bsave (?:(?:it|that|this)(?=$|[.!?,]| (?:please|now|event|meeting|appointment|one|to my calendar)\b)|the (?:event|meeting|appointment|invite)\b)|\b(?:put|add) (?:it|that|this) (?:on|to|in) my calendar\b|^(?:(?:ok(?:ay)?|yes|yeah|alright|now|please)[\s,]+)*save(?: it)?[.!]?$/,
  /** open_booking: a result on the board, by its place or by "that". */
  OPEN_BOOKING: new RegExp(
    String.raw`\b(?:book|reserve|buy|order|purchase)\b[^.?!]{0,10}\b(?:the|that|this)\b[^.?!]{0,30}\b(?:one|flight|hotel|room|option|result|ticket|item|product|deal)\b|\b(?:book|reserve|buy|order) (?:it|that|this)\b|\bopen\b[^.?!]{0,30}\b(?:to|and) (?:book|buy|order|reserve)\b`,
  ),
  /**
   * draft_email: "email Sam that…", "send an email to…", "reply that…", "write back and ask…", "tell him…" — asked of
   * Trinity, not asked about someone ("did Sam write back?", "has Dana replied?" are check_email).
   */
  DRAFT_EMAIL: new RegExp(
    String.raw`^(?:(?:please|can you|could you|hey|ok(?:ay)?|trinity|actually|and|also)[\s,]+)*(?:e-?mail|message) (?!me\b|us\b|app\b|address\b)[a-z0-9@]` +
      String.raw`|\b(?:send|write|draft|shoot|drop)\b[^.?!]{0,25}\b(?:e-?mail|note|line|message)\b[^.?!]{0,25}\b(?:to|saying|that|about)\b` +
      String.raw`|(?<!\b(?:did|didn't|has|hasn't|have|haven't|does|will|would|might)\b[^.?!]{0,30})\b(?:write (?:back\b|to [a-z])|(?:reply|respond)\b(?! (?:all|button)))` +
      String.raw`|\b(?:tell|let) (?:him|her|them) (?:know|that|i|we)\b`,
  ),
  /** draft_email, only while a draft is open: a change to it — not to a card, a tab or the page ("make card 2 shorter"). */
  DRAFT_REVISE:
    /^(?!.*\b(?:card \d+|cards|timer|window|tabs?|page|picture|image|photo|video|chart|board|screen)\b).*?\b(?:shorter|longer|(?:make|sound) (?:it|that|the (?:e-?mail|message|draft|reply))(?: sound)? (?:a (?:bit|little) )?(?:more|less|friendlier|warmer|nicer|kinder|clearer|simpler|briefer|punchier|firmer|softer|formal|casual|polite)|more (?:formal|friendly|polite|casual|direct|professional)|less (?:formal|wordy)|add that|take out|leave out|rewrite|rephrase|reword|change (?:it|the (?:subject|wording|greeting|tone))|sign it)\b/,
  /** draft_email, only while a draft is open and nothing else here took the words: "say Thursday instead". */
  DRAFT_INSTEAD: /\binstead\b/,
  /** draft_email, only while Trinity waits for an address or for what to say: the answer. */
  EMAIL_ANSWER: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[a-z0-9]+ at [a-z0-9-]+ dot [a-z]+\b|^(?:(?:just |it should )?say|saying|that|tell (?:him|her|them))\b/,
  /** read_email: one message, named by who it is from or what it is about. */
  READ_EMAIL: new RegExp(
    String.raw`\b(?:read|open|show me|pull up|play)\b[^.?!]{0,25}\b(?:e-?mail|message|one)\b[^.?!]{0,12}\b(?:from|about)\b` +
      String.raw`|\b(?:read|open)\b[^.?!]{0,14}\b(?:e-?mail|message)\b|\b(?:read|open) [a-z]+'s (?:e-?mail|message|reply)\b` +
      String.raw`|\bwhat (?:did|does) (?!it\b|that\b|this\b|the\b|my\b|your\b|you\b|i\b|we\b)[a-z]+(?: [a-z]+)? (?:say|write|want)\b`,
  ),
  /** read_email, only while the inbox is listed or a message is open: by its place, or "it". */
  READ_EMAIL_HERE: new RegExp(String.raw`\b(?:open|read|show me|play)\b[^.?!]{0,12}\b(?:the )?${ORDINAL} (?:one|e-?mail|message)\b|\b(?:open|read) (?:number|#) ?[a-z0-9]+\b|\bwhat (?:does|did) (?:it|that|he|she|they|the e-?mail|the message) say\b|\bread (?:it|that)\b`),
  /** check_email: the inbox as a whole, or mail from someone. */
  CHECK_EMAIL: new RegExp(
    String.raw`\b(?:check|look at|go through|what'?s in|anything in|what'?s new in)\b[^.?!]{0,20}\b(?:e-?mails?|inbox|mail)\b` +
      String.raw`|\b(?:any|do i have|have i got|is there|are there|did i get)\b[^.?!]{0,20}\b(?:e-?mails?|mail|unread messages?|new messages?)\b(?! (?:app|client|address|server))` +
      String.raw`|\b(?:did|didn't|has|hasn't|have|haven't)\b[^.?!]{1,30}\b(?:(?:write|wrote|written|e-?mail(?:ed)?|g[eo]t(?:ten)?) (?:me |us )?back|repl(?:y|ied)|respond(?:ed)?|answer(?:ed)?|e-?mail(?:ed)? (?:me|us)|written)\b` +
      String.raw`|\bheard (?:back )?from\b|\b(?:anything|something|e-?mails?|mail) from\b`,
  ),
  /** schedule_meeting: something to put on the calendar. */
  SCHEDULE_MEETING: new RegExp(
    String.raw`\b(?:schedule|set up|book|arrange|organi[sz]e|create|add|put|pencil in|plan)\b[^.?!]{0,40}\b${EVENT}\b(?![^.?!]{0,30}\b(?:reminder|remind me)\b)` +
      String.raw`|\b(?:put|add)\b[^.?!]{1,60}\b(?:on|in|to) my (?:calendar|schedule|diary)\b` +
      String.raw`|\bblock (?:out |off )?(?:[a-z0-9]+ ){0,3}(?:hours?|minutes?|time|the (?:morning|afternoon|day))\b`,
  ),
  /** schedule_meeting, only while Trinity waits to hear when: a day or a time. */
  TIME_ANSWER: new RegExp(String.raw`\b${DAY}\b|\b(?:at|around) (?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)|\b\d{1,2}(?::\d{2})?\s?(?:a\.?m|p\.?m)\b|\b(?:noon|midnight|o'?clock)\b|^(?:(?:um|uh|maybe|say|let'?s say|how about)[\s,]+)*(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b`),
  /** check_calendar: what is on the user's own calendar, whether they are free, what is next. */
  CHECK_CALENDAR: new RegExp(
    String.raw`\b(?:on|in|for|check|show(?: me)?|read|look at|what'?s) my (?:calendar|schedule|agenda|diary)\b|\bmy (?:calendar|schedule|agenda) (?:for|on|today|tomorrow|this|next|look)\b` +
      String.raw`|\bwhat(?:'s| is| do i have| have i got) on (?:${DAY}|for)\b|\bwhat do i have (?:${DAY}|going on|scheduled|planned|coming up)\b` +
      String.raw`|\b(?:am i|are we|will i be)\b[^.?!]{0,10}\b(?:free|busy|available|booked)\b|\bdo i have (?:anything|something|a meeting|any meetings|plans|time)\b[^.?!]{0,30}\b(?:${DAY}|at|on|this|next)\b` +
      String.raw`|\b(?:when(?:'s| is)|what(?:'s| is)) my next (?:meeting|appointment|call|event)\b|\bwhat(?:'s| is) next on my (?:calendar|schedule)\b`,
  ),
} as const;

/*
 * A reminder, or a run on a timetable, is the schedule tool's — it runs these tools later, at the time: "remind me to
 * email Sam", "every morning check my mail", "set up a reminder for the meeting", "check my email every morning".
 */
const REMIND = String.raw`remind me|reminders?`;
const REPEAT = String.raw`every (?:day|morning|afternoon|evening|night|week|weekday|weekend|hour|(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d+ (?:minutes|hours))|each (?:day|morning|evening|night)|daily|hourly|recurring`;
const LATER_IN = String.raw`in (?:\d+|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty-five|half an?) (?:minutes?|hours?)`;
const LATER = new RegExp(String.raw`\b(?:${REMIND}|${REPEAT}|${LATER_IN})\b`);
const TIMETABLE = new RegExp(String.raw`\b(?:${REPEAT})\b`);
const AFTER_A_WHILE = new RegExp(String.raw`\b(?:${LATER_IN})\b`);

/**
 * The assistant tool the words ask for, or null. `offered(name)` says whether a tool is on offer right now (the
 * router's own `has`): send_email and save_meeting are only offered while their draft or form is open.
 *
 * Order: a waiting send or save first; then an answer to Trinity's own question; then a booking; then writing,
 * opening and listing mail; then the calendar — putting something on it before asking what is on it ("put lunch on my
 * calendar" is not a question). A reminder or a repeat said before (or inside) the words that name a tool leaves them
 * to the schedule tool; for the reading tools, which take no words of their own, a repeat anywhere does.
 */
export function assistRoute(words: string, offered: (tool: string) => boolean): string | null {
  const t = words.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const s = stateOf();
  const R = ASSIST_ROUTES;
  const laterAt = t.search(LATER);
  const asks = (re: RegExp): boolean => {
    const m = re.exec(t);
    return m !== null && (laterAt < 0 || laterAt >= m.index + m[0].length);
  };
  const on = (tool: string, re: RegExp): boolean => offered(tool) && asks(re);
  const now = (tool: string, re: RegExp): boolean => on(tool, re) && !TIMETABLE.test(t) && (tool === "check_calendar" || !AFTER_A_WHILE.test(t));
  // (An answer to Trinity's own question is taken as it is: "that I'll remind him tomorrow" is what the email says.)
  const answer = (tool: string, re: RegExp): boolean => offered(tool) && re.test(t);
  if (on("send_email", R.SEND_EMAIL)) return "send_email";
  if (on("save_meeting", R.SAVE_MEETING)) return "save_meeting";
  if (s.awaitingEmailAnswer && answer("draft_email", R.EMAIL_ANSWER)) return "draft_email";
  if (s.awaitingTime && !R.SCHEDULE_MEETING.test(t) && answer("schedule_meeting", R.TIME_ANSWER)) return "schedule_meeting";
  if (on("open_booking", R.OPEN_BOOKING)) return "open_booking";
  if (on("draft_email", R.DRAFT_EMAIL) || (s.draftOpen && on("draft_email", R.DRAFT_REVISE))) return "draft_email";
  if (now("read_email", R.READ_EMAIL) || ((s.inboxListed || s.messageOpen) && now("read_email", R.READ_EMAIL_HERE))) return "read_email";
  if (now("check_email", R.CHECK_EMAIL)) return "check_email";
  if (on("schedule_meeting", R.SCHEDULE_MEETING)) return "schedule_meeting";
  if (now("check_calendar", R.CHECK_CALENDAR)) return "check_calendar";
  if (s.draftOpen && on("draft_email", R.DRAFT_INSTEAD)) return "draft_email";
  return null;
}
