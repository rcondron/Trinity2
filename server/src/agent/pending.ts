import type { ToolResult } from "../types.js";

/**
 * A question Trinity has asked that only a yes or a no can answer — "Remove your Netflix login?", "Place the order for
 * fifty-one dollars?" — kept until the user answers it or it lapses. One at a time: a new question takes the place of
 * the old one, which counts as answered "no".
 *
 * The answer must come from the user's own words (the answer tool is `sensitive`: never offered to the solver, to
 * scheduled runs or to skills), and a question can demand more than a bare "yes" (`require`: words the answer must
 * contain, e.g. "place" and "order") so that a stray "yeah" in conversation can't spend money.
 */
export interface PendingQuestion {
  id: string;
  /** What was asked, as it was spoken. */
  question: string;
  /** Lower-case words a "yes" must contain to count (all of them). Empty: any clear yes. */
  require: string[];
  expiresAt: number;
  onAnswer: (yes: boolean) => Promise<ToolResult> | ToolResult;
}

const DEFAULT_TTL_MS = 60_000;
let pending: PendingQuestion | null = null;
let seq = 0;

/** Ask it: returns the question's id. The caller speaks the question itself (as its tool result). */
export function askYesNo(q: {
  question: string;
  onAnswer: (yes: boolean) => Promise<ToolResult> | ToolResult;
  require?: string[];
  ttlMs?: number;
}): string {
  const old = pending;
  pending = {
    id: `q${++seq}`,
    question: q.question,
    require: (q.require ?? []).map((w) => w.toLowerCase()),
    expiresAt: Date.now() + (q.ttlMs ?? DEFAULT_TTL_MS),
    onAnswer: q.onAnswer,
  };
  if (old) void Promise.resolve().then(() => old.onAnswer(false)).catch(() => {});
  return pending.id;
}

/** The question waiting for an answer, if any (a lapsed one counts as "no" and is dropped). */
export function pendingQuestion(): PendingQuestion | null {
  if (pending && Date.now() > pending.expiresAt) {
    const old = pending;
    pending = null;
    void Promise.resolve().then(() => old.onAnswer(false)).catch(() => {});
  }
  return pending;
}

/** Withdraw a question without answering it (the thing it was about went away). */
export function dropPending(id?: string): void {
  if (pending && (!id || pending.id === id)) pending = null;
}

const YES_WORDS = String.raw`yes|yeah|yep|yup|sure|ok(?:ay)?|go ahead|do it|please do|confirm(?:ed)?|approve[d]?|correct|that'?s right|absolutely|affirmative`;
const NO_WORDS = String.raw`no|nope|nah|don'?t|do not|cancel|stop|never ?mind|wait|hold on|not now|negative`;
/** Sounds and names that may come first ("um, yes", "Trinity, no"). */
const LEAD = String.raw`^\W*(?:(?:um+|uh+|er+|hmm+|oh|ah|well|so|trinity)[\s,.!-]+)*`;
const YES = new RegExp(String.raw`${LEAD}(?:${YES_WORDS})\b`, "i");
const NO = new RegExp(String.raw`${LEAD}(?:${NO_WORDS})\b`, "i");
const NO_ANYWHERE = new RegExp(String.raw`\b(?:${NO_WORDS})\b`, "i");

/**
 * What the words say: yes, no, or neither (null). The answer leads what was said: "yes, go ahead", "no, wait", "um,
 * sure" — not a yes or a no somewhere in another sentence ("tell me something and wait for it"). A no after a yes
 * still wins ("yes— no, wait").
 */
export function yesOrNo(words: string): boolean | null {
  const t = words.trim();
  if (NO.test(t)) return false;
  if (!YES.test(t)) return null;
  return NO_ANYWHERE.test(t) ? false : true;
}

/**
 * Answer the pending question with the user's words. A "yes" that lacks the words the question demands is not a yes:
 * the question is asked again, naming what to say.
 */
export async function answerPending(words: string): Promise<ToolResult> {
  const q = pendingQuestion();
  if (!q) return { ok: false, say: "There's nothing waiting for a yes or a no right now." };
  const answer = yesOrNo(words);
  if (answer === null) return { ok: false, say: q.question, speak: q.question };
  if (answer && q.require.length) {
    const said = words.toLowerCase();
    if (!q.require.every((w) => said.includes(w))) {
      const again = `${q.question} To go ahead, say: yes, ${q.require.join(" ")}.`;
      return { ok: false, say: again, speak: again };
    }
  }
  pending = null;
  return q.onAnswer(answer);
}
