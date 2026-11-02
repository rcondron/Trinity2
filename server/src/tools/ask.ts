import { speakable } from "../agent/reply.js";
import { answer } from "../services/brain.js";
import { QUALITY_OPTIONS } from "../services/mordiem-router.js";
import type { MemoryDoc, Tool } from "../types.js";
import { registerTool } from "./registry.js";

/**
 * ask_brain: questions that need real knowledge or careful reasoning go to a Mordiem text
 * model (PersonaPlex is a small speech model) and the answer is spoken verbatim — grounded in
 * the situation and in what Trinity remembers about the user. Jev / the router pick the fast
 * JSON model for snappy asks and the brain model when the prompt needs careful reasoning.
 */
const ANSWER_MS = 12_000;
const MEMORY_MS = 1_500;

const STOP = new Set(
  "about after again also been before being caller callers could does doing from have just know like make many more most much only other over said should some such than that their them then there these they thing think this those user very want what when where which while will with would your yours".split(
    " ",
  ),
);
/** Content words as 4-letter stems, so "live" meets "lives" and "weight" meets "weighs". */
const keywords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map((w) => w.slice(0, 4)),
  );

/** Memories that share a real word with the question (search ranks by salience too, so it returns some regardless). */
async function relevantMemories(docs: Promise<MemoryDoc[]>, question: string): Promise<string[]> {
  const words = keywords(question);
  let found: MemoryDoc[] = [];
  try {
    found = await Promise.race([docs, new Promise<MemoryDoc[]>((resolve) => setTimeout(() => resolve([]), MEMORY_MS))]);
  } catch {
    /* answer without them */
  }
  return found
    .filter((d) => [...keywords(`${d.text} ${d.tags.join(" ")}`)].some((w) => words.has(w)))
    .slice(0, 4)
    .map((d) => d.text);
}

const askBrain: Tool = {
  name: "ask_brain",
  description:
    "Answer a question that needs real knowledge, math, or careful reasoning, spoken only (not small talk; not the news or anything to lay out on the board — that's show_card).",
  input: {
    quality: {
      type: "string",
      description: "which Mordiem text model should answer",
      options: QUALITY_OPTIONS,
    },
  },
  // The question is the user's whole sentence (ctx.utterance): fires when it ends.
  argMode: "raw",
  source: "builtin",
  async run(args, ctx) {
    const question = ctx.utterance.trim();
    if (!question) return { ok: false, say: "I didn't catch the question." };
    const memories = await relevantMemories(ctx.memory.search(question, { limit: 8 }), question);
    const text = await answer({
      persona: ctx.persona,
      transcript: ctx.recentTranscript,
      memories,
      question,
      situation: ctx.situation,
      timeoutMs: ANSWER_MS,
      quality: args.quality,
    });
    const said = text ? speakable(text) : "";
    if (!said) return { ok: false, say: "I couldn't work that out just now: the brain model didn't answer in time." };
    return { ok: true, say: said, speak: said };
  },
};

export function registerAskTools(): void {
  registerTool(askBrain);
}
