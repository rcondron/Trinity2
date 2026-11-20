import { pausedSolve } from "../services/agent-loop.js";
import { listForged } from "../services/skill-forge.js";

/*
 * The words that ask for the memory, reminder and skill tools — for the router's keyword fallback.
 *
 * With a routing model these tools are picked by their descriptions. Without one (no TypeSafe key) agent/router.ts
 * reads the words itself, and it knows nothing of them: voiceIntent() is the one call it needs. It names the tool
 * the user's latest words ask for, or null — only when they ask outright ("cancel my dentist reminder", "what
 * skills do you have", "forget that I'm vegetarian"), never for a word said in passing ("I always forget my keys",
 * "let's change the subject", "don't cancel it", "forget it").
 */

/** Words before a request that carry none of it. */
const OPENER = String.raw`(?:(?:please|okay|ok|yes|yeah|yep|sure|hey|so|and|oh|um+|uh+|well|actually|alright|right|now|then|also|trinity)\b[,\s]*)*`;
/** "Can you…", "I'd like to…", "let's…": asking, in other words. */
const ASKING = String.raw`(?:(?:can|could|would|will) you\s+(?:please\s+|just\s+)?|i(?:'d| would) like (?:you )?to\s+|i (?:want|need)(?: you)? to\s+|let'?s\s+|go ahead and\s+)?`;

/**
 * `verbs` said as a request: at the start of the sentence or of a clause, after "please", "can you", "I need to" —
 * not what someone does ("I always forget…", "we cancel…") and not its opposite ("don't cancel…").
 */
const asked = (verbs: string, rest = "") => new RegExp(String.raw`(?:^|[.,;:!?]\s*|\b(?:and|then|but)\s+)${OPENER}${ASKING}(?:${verbs})\b${rest}`);

/**
 * A few words between the verb and what it acts on ("cancel MY FIVE O'CLOCK reminder") — never across to another
 * thing ("clear the board AND set a reminder", "delete the note ABOUT my reminder").
 */
const BETWEEN = String.raw`(?:\s+(?!(?:and|then|but|about|for|with|on|in|from|to|into|onto|at)\b)[\w'’:-]+){0,6}?\s+`;
/** A page or a part of one ("a reminders app", "a skills section") is something to build, not these tools. */
const NOT_A_PAGE = String.raw`(?!\s+(?:app|page|tool|widget|list|board|section|system|dashboard|screen|feature|button|tracker|ui|view|card|panel|manager|form)s?\b)`;
const REMINDER = String.raw`\b(?:reminders?|alarms?)\b${NOT_A_PAGE}`;
const SKILL = String.raw`\bskills?\b${NOT_A_PAGE}`;

const CANCEL_VERBS = "cancel|delete|remove|drop|clear|scrap|kill|stop|turn off|switch off|get rid of|forget(?: about)?";
const CHANGE_VERBS = "change|move|push(?: back)?|reschedule|postpone|delay|shift|bring forward|update|edit";
const CANCEL_REMINDER = [asked(CANCEL_VERBS, `${BETWEEN}${REMINDER}`), asked("stop reminding me")];
const CHANGE_REMINDER = [asked(CHANGE_VERBS, `${BETWEEN}${REMINDER}`)];
const LIST_REMINDERS = [
  new RegExp(String.raw`\b(?:what(?:'s| is| are)?|which|list|show(?: me)?|tell me|read(?: me| out)?|do i have|have i got|are there)${BETWEEN}${REMINDER}`),
  /\bwhat(?:'s| is| do i have| have i got)(?: \w+){0,2} (?:coming up|scheduled|on my schedule)\b/,
  /\b(?:do i have|have i got|is there) anything (?:coming up|scheduled|on my schedule)\b/,
];

const FIX_VERBS = "fix|repair|debug|redo|rework|improve|update|correct";
const OFF_VERBS = "disable|deactivate|turn off|switch off|stop using|retire|shelve";
const ON_VERBS = "enable|re-?enable|reactivate|turn (?:back )?on|switch (?:back )?on|bring back|start using";
const FIX_SKILL = [
  asked(FIX_VERBS, `${BETWEEN}${SKILL}`),
  new RegExp(String.raw`\b(?:the|that|your|my) (?:\w+ ){0,4}skill\b[^.?!]{0,45}\b(?:is(?:n't| not)? (?:broken|wrong|working|right)|(?:doesn'?t|didn'?t|does not|did not|won'?t|stopped) work(?:ing)?|gave (?:me )?(?:the |a )?wrong|got (?:it|that) wrong|is off)\b`),
];
const DISABLE_SKILL = [asked(OFF_VERBS, `${BETWEEN}${SKILL}`), asked("turn|switch", String.raw`${BETWEEN}skills?\s+off\b`)];
const ENABLE_SKILL = [asked(ON_VERBS, `${BETWEEN}${SKILL}`), asked("turn|switch", String.raw`${BETWEEN}skills?\s+(?:back )?on\b`)];
const LIST_SKILLS = [
  new RegExp(String.raw`\b(?:what|which|list|show(?: me)?|tell me)\b[^.?!]{0,30}(?:\byour (?:\w+ ){0,2}skills\b|\bskills\b[^.?!]{0,12}\b(?:you|you've)\b)${NOT_A_PAGE}`),
  /\bwhat have you (?:learned|learnt|taught yourself) to do\b/,
];
/** The same verbs with a skill named instead of the word "skill": "fix the tip calculator", "turn off the currency converter". */
const NAMED: [tool: string, verbs: RegExp][] = [
  ["fix_skill", asked("fix|repair|debug|redo|rework")],
  ["disable_skill", asked(OFF_VERBS)],
  ["enable_skill", asked(ON_VERBS)],
];

/** Something saved, to be forgotten — with what ("that I…", "my address"): a bare "forget it" means "never mind". */
const FORGET = [
  asked("forget|stop remembering", String.raw`\s+(?:about\s+)?(?:that (?:i|i'm|i've|my|we|our)\b|my\b|our\b|what i (?:said|told you)\b|what you know\b|everything\b)`),
  asked("delete|erase|remove|wipe|clear", String.raw`[^.?!]{0,25}\b(?:what you know|what i (?:said|told you)|(?:from )?your memory|(?:that|the|this|my|those|your) memor(?:y|ies))\b`),
];
/** What was said before, asked about ("what did you say?" alone asks for the last line again). */
const SEARCH_CONVERSATIONS = [
  /\bwhat did (?:we|you) (?:\w+ )?(?:say|talk about|discuss|decide|agree)\b(?!\s*(?:$|[?.!]|again\b|just now\b|there\b|then\b|a (?:moment|second|minute) ago\b))/,
  /\bwhen did (?:i|we|you) (?:\w+ ){0,2}(?:mention|say|talk about|tell|discuss)\b/,
  /\bdid (?:we|i|you) (?:ever |already )?(?:talk about|discuss|mention)\b/,
  /\b(?:the )?last time (?:we|i|you) (?:talked|spoke|chatted|discussed)\b/,
  /\bwhat (?:were we|was i|were you) (?:talking|saying) about\b(?!\s*(?:$|[?.!]|again\b|just now\b))/,
  /\b(?:search|look (?:through|back (?:at|through|over))|check|go (?:back )?through) (?:our|my|the) (?:past |previous |earlier |old |last )?(?:conversations?|chats?|history|calls?|talks?)\b/,
];
/** The profile named outright. (A fact about the user said as "remember…" is the remember tool's.) */
const UPDATE_PROFILE = [asked("update|change|edit|correct|add to|fix", String.raw`\s+(?:my|the|your) profile\b(?!\s+(?:picture|photo|pic|image|page|card|settings)\b)`)];

/** In this order: the first tool whose words match, and that is on offer, is the one. */
const RULES: [tool: string, patterns: RegExp[]][] = [
  ["cancel_reminder", CANCEL_REMINDER],
  ["change_reminder", CHANGE_REMINDER],
  ["list_reminders", LIST_REMINDERS],
  ["fix_skill", FIX_SKILL],
  ["disable_skill", DISABLE_SKILL],
  ["enable_skill", ENABLE_SKILL],
  ["list_skills", LIST_SKILLS],
  ["forget", FORGET],
  ["search_conversations", SEARCH_CONVERSATIONS],
  ["update_profile", UPDATE_PROFILE],
];

/** Whether one of the skills Trinity made is named in full ("tip calculator" for tip_calculator). */
function namesSkill(t: string): boolean {
  const text = ` ${t.replace(/[^a-z0-9]+/g, " ").trim()} `;
  try {
    return listForged().some((s) => {
      const spoken = s.name.split("_").filter(Boolean).join(" ");
      return spoken.length >= 4 && text.includes(` ${spoken} `);
    });
  } catch {
    return false;
  }
}

/** A question is answered promptly or not at all: for this long after the solver asked, the next words are taken as the answer. */
const ANSWER_WINDOW_MS = 2 * 60_000;
/** Words that react and answer nothing. (Not "ok", "sure" or "great": to a yes-or-no question those are the answer.) */
const REACTION = /^(?:(?:oh|ah|aw|well)[,\s]+)*(?:thanks?|thank you|thanks a lot|thank you so much|lol|haha+|hehe+|hmm+|interesting)[\s.!,]*$/;

/**
 * The tool of this layer the words ask for, or null. `offered(name)` says whether a tool can be picked now (the
 * router's own test: registered, visible to the persona, available). Right after the problem solver asked the user
 * something, the next words are the answer, whatever they are (answer_followup hands words that turn out not to be
 * one on as a request of their own).
 */
export function voiceIntent(words: string, offered: (tool: string) => boolean): string | null {
  const t = String(words ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // (A bare reaction — "thanks", "haha" — answers nothing: it is talk, as ever.)
  if (offered("answer_followup") && !REACTION.test(t)) {
    const waiting = pausedSolve();
    if (waiting && Date.now() - waiting.at < ANSWER_WINDOW_MS) return "answer_followup";
  }
  for (const [tool, patterns] of RULES) if (patterns.some((p) => p.test(t)) && offered(tool)) return tool;
  for (const [tool, verbs] of NAMED) if (verbs.test(t) && offered(tool) && namesSkill(t)) return tool;
  return null;
}

/**
 * Words of these tools' names that are everyday words: said in passing they ask for nothing ("I always forget my
 * keys", "let's change the subject"). The router's last resort — a distinctive word of a tool's name said aloud —
 * must not take them for a request; voiceIntent() above is what reads a request for these tools.
 */
export const EVERYDAY_TOOL_WORDS = ["cancel", "change", "conversations", "disable", "enable", "followup", "forget", "profile", "reminder", "reminders", "skills", "update"];
