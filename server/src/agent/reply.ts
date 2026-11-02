import { getEndpoints, live } from "../settings.js";
import { VENICE_PARAMS } from "../services/json-chat.js";
import { GOES_ON_AFTER_CLOCK } from "../tools/schedule.js";
import type { Persona } from "../types.js";
import type { ReplyStyle } from "./context.js";

/**
 * The reply writer: after an action, a fast model writes what Trinity says about it —
 * streamed a few words at a time so speech can start before the sentence is finished
 * (reference: write_reply). In voice mode the words are injected into PersonaPlex; in
 * text mode they are joined into a transcript turn.
 */
export interface ReplyRequest {
  persona: Persona;
  /** The user's words. */
  asked: string;
  /** What was done, in words (tool outcome). */
  outcome: string;
  situation: string;
  style: ReplyStyle;
  /** The work was only started (a build streaming in, a skill being made) or queued — the reply must not claim it's done. */
  inProgress?: "started" | "queued";
}

export function speakable(text: string): string {
  return text
    .replace(/[*_#`~>|"“”]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function voiceOf(p: Persona): string {
  if (p.voicePrompt.trim()) return p.voicePrompt.trim();
  const first = p.description.split(/(?<=[.!?])\s/)[0] ?? "";
  return first || `You are ${p.name}.`;
}

function systemPrompt(req: ReplyRequest): string {
  const { maxWords, maxSentences, guidance } = req.style;
  const shape =
    maxSentences > 1
      ? `at most ${maxSentences} short sentences, under ${maxWords} words in total`
      : `ONE short, natural spoken sentence, under ${maxWords} words`;
  const task =
    req.inProgress === "queued"
      ? `A helper has lined up what the user asked: it starts as soon as the work ahead of it finishes. Reply in character with ${shape}: say you're on it and it's next. Never say it's done or ready.`
      : req.inProgress
        ? `A helper has just STARTED on what the user asked and it is still in progress. Reply in character with ${shape}: say you're on it and where it will show up (or that you'll say when it's ready). Never say it's done or ready.`
        : `A helper has just done what the user asked. Reply in character with ${shape}: confirm it in your own words with the concrete details of what was done (names, numbers), or give the one fact they asked for. Never answer with a bare "Done".`;
  return [
    voiceOf(req.persona),
    `You are on a live voice call. ${task}`,
    "The workspace is the screen beside the user where helpers show what they make: their 'screen', 'board' or 'window'.",
    guidance,
    "Don't read out everything on screen. Write numbers, money and dates as spoken words. No emojis, symbols, lists, quotes or markdown.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** After a word that ends in "a.m." or "p.m.", a word that starts the next sentence: not "Thursday", "November" or "Eastern". */
const STARTS_SENTENCE = new RegExp(String.raw`^(?!${GOES_ON_AFTER_CLOCK})["'“‘(]?[A-Z]`);

/** Fallback line when the model is unavailable: the outcome's first sentence, minus setup notes. */
export function fallbackReply(outcome: string): string {
  const main = outcome.split(/\bSetup next:/i)[0] ?? outcome;
  return speakable(main.split(/(?<=[.!?])\s/)[0] ?? main) || "Done.";
}

/**
 * Stream the reply. `onWords` receives speakable word chunks as they're written; the
 * full text is returned. Stops after `style.maxSentences` sentences (the first needs
 * ≥ 4 words — "Got it." alone isn't a reply, as in the reference), or at the end of the
 * sentence that runs past the word cap — words already spoken can't be taken back, so a
 * long sentence is finished rather than cut off mid-way ("…to take out the"). One that runs
 * past twice the cap (a long list) ends with the clause it's in, its comma made a full stop,
 * and in any case a dozen words later.
 */
export async function streamReply(
  req: ReplyRequest,
  onWords: (words: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const said: string[] = [];
  const emit = (chunk: string) => {
    const s = speakable(chunk);
    if (!s) return;
    said.push(s);
    onWords(s);
  };
  await writeStreamed(req, emit, signal);
  if (req.style.append) emit(req.style.append);
  return said.join(" ");
}

async function writeStreamed(req: ReplyRequest, emit: (chunk: string) => void, signal?: AbortSignal): Promise<void> {
  let emitted = 0;
  const out = (chunk: string) => {
    emitted++;
    emit(chunk);
  };
  if (!live.mordiem) {
    out(fallbackReply(req.outcome));
    return;
  }

  const { mordiemUrl, mordiemKey, replyModel } = getEndpoints();
  // With an appended question, the "Setup next" note is ours to say — keep the model off it.
  const outcome = req.style.append ? (req.outcome.split(/\bSetup next:/i)[0] ?? req.outcome).trim() : req.outcome;
  const softCap = req.style.maxWords + 6; // past this, stop where the sentence ends
  const hardCap = req.style.maxWords * 2 + 6; // past this, stop where the clause ends
  const lastCap = hardCap + 12; // never more than this
  const body = {
    model: replyModel,
    stream: true,
    max_tokens: Math.ceil(lastCap * 1.6) + 16, // room to finish a sentence that runs past the soft cap
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt(req) },
      {
        role: "user",
        content: `User said: "${req.asked.replace(/"/g, "'")}"\nWhat was done: ${outcome}\nSituation: ${req.situation}`,
      },
    ],
  };
  const timeout = AbortSignal.timeout(10_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const call = (extra: Record<string, unknown>) =>
    fetch(`${mordiemUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
      body: JSON.stringify({ ...body, ...extra }),
      signal: sig,
    });

  let pending = "";
  let words = 0;
  let sentences = 0;
  // A word that ends in "a.m." or "p.m." ends a sentence only if the next word starts one ("…at 6 a.m. Anything
  // else?"), not in "at 7 a.m. tomorrow", "at 3 p.m. Thursday" or "at 7:30 p.m. Eastern" (STARTS_SENTENCE).
  let afterClock = false;
  try {
    let res = await call({ venice_parameters: VENICE_PARAMS });
    if (res.status === 400) res = await call({});
    if (!res.ok || !res.body) throw new Error(`reply ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:") || t.endsWith("[DONE]")) continue;
        try {
          pending += JSON.parse(t.slice(5)).choices?.[0]?.delta?.content ?? "";
        } catch {
          continue;
        }
        const parts = pending.split(/\s+/);
        pending = parts.pop() ?? "";
        // Word by word: one streamed chunk can hold a sentence end mid-way ("story. What kind…"),
        // and the sentence cap must cut exactly there.
        let group: string[] = [];
        for (const w of parts) {
          if (!w) continue;
          if (afterClock) {
            afterClock = false;
            const next = STARTS_SENTENCE.test(w);
            if (next && words >= 4 && (++sentences >= req.style.maxSentences || words >= softCap)) {
              if (group.length) out(group.join(" "));
              pending = "";
              void reader.cancel().catch(() => {});
              return;
            }
            if (next && group.length) {
              out(group.join(" "));
              group = [];
            }
          }
          group.push(w);
          words++;
          // (Glued to its number too: "7a.m.", "10:30p.m.".)
          const clock = /^(?:\d{1,2}(?:[:.]\d{2})?)?[ap]\.m\.["'”’)\]]*$/i.test(w);
          if (clock) afterClock = true;
          const endsSentence = !clock && /[.!?]["'”’)\]]*$/.test(w);
          const endsClause = /[,;:]["'”’)\]]*$/.test(w);
          if (endsSentence && words >= 4) sentences++;
          if (sentences >= req.style.maxSentences || (endsSentence && words >= softCap) || ((endsSentence || endsClause) && words >= hardCap) || words >= lastCap) {
            // (A clause that ends the line ends it as a sentence.)
            if (endsClause && !endsSentence) group[group.length - 1] = w.replace(/[,;:](["'”’)\]]*)$/, ".$1");
            out(group.join(" "));
            pending = "";
            void reader.cancel().catch(() => {});
            return;
          }
          if (endsSentence) {
            out(group.join(" "));
            group = [];
          }
        }
        if (group.length) out(group.join(" "));
      }
    }
  } catch (err) {
    if (!emitted && !pending.trim()) {
      console.warn("[reply] writer failed, using fallback:", (err as Error).message);
      out(fallbackReply(req.outcome));
      return;
    }
  }
  if (pending.trim()) out(pending.trim());
  if (!emitted) out(fallbackReply(req.outcome));
}

/** Non-streaming convenience for the text path. */
export async function writeReply(req: ReplyRequest): Promise<string> {
  return streamReply(req, () => {});
}
