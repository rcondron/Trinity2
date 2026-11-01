import { getEndpoints, live } from "../settings.js";
import type { Persona, TranscriptTurn } from "../types.js";
import { mordiemChat, type ChatMessage } from "./llm.js";

/*
 * The "brain" (BRAIN_MODEL on Mordiem) — general knowledge & reasoning: questions routed to
 * ask_brain, turns no tool handles on the text channel, heartbeat check-ins, and relaying a
 * tool's result in the persona's voice.
 */

/** The last few turns as chat history (the question itself, if it's the last turn, is asked separately). */
function historyFor(transcript: TranscriptTurn[], n: number, latest?: string): ChatMessage[] {
  const turns = transcript.filter((t) => t.speaker !== "system" && t.text.trim()).slice(-n);
  const last = turns[turns.length - 1];
  if (latest && last?.speaker === "user" && last.text.trim() === latest.trim()) turns.pop();
  return turns.map((t) => ({ role: t.speaker === "trinity" ? "assistant" : "user", content: t.text }));
}

/**
 * ask_brain: answer a question that needs real knowledge, math, or careful reasoning — the
 * voice model is a small speech model, so the brain works it out and the answer is spoken
 * verbatim. At most three short, speakable sentences, grounded in the situation and in what
 * Trinity remembers about the caller. Returns null when the brain can't answer in time (the
 * caller hears that instead of a guess).
 */
export async function answer(input: {
  persona: Persona;
  transcript: TranscriptTurn[];
  memories: string[];
  question: string;
  situation?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!live.brain) return mockThink({ userText: input.question, memories: input.memories });
  const system: ChatMessage = {
    role: "system",
    content:
      `${input.persona.description}\n\n` +
      `Traits: ${JSON.stringify(input.persona.traits)}\n` +
      (input.situation ? `Current situation: ${input.situation}\n` : "") +
      (input.memories.length
        ? `What you know about the caller (use it only where it matters to the question):\n- ${input.memories.join("\n- ")}\n`
        : "") +
      "\nYou are on a live voice call, and your words are read aloud exactly as you write them. Answer the caller's " +
      "question correctly and directly in one to three short sentences: the answer first, then at most a line of why. " +
      "Work it out carefully (exactly, for math) but don't show your working. Write numbers, units, money and dates the " +
      "way they are spoken. No lists, markdown, symbols or emojis. If you aren't sure, say so briefly instead of guessing.",
  };
  try {
    const text = await mordiemChat(
      getEndpoints().brainModel,
      [system, ...historyFor(input.transcript, 6, input.question), { role: "user", content: input.question }],
      { temperature: 0.3, maxTokens: 300, timeoutMs: input.timeoutMs ?? 12_000 },
    );
    return text.trim() || null;
  } catch (err) {
    console.warn("[brain] answer failed:", (err as Error).message);
    return null;
  }
}

/**
 * What Trinity should say next, given the persona, recent conversation, and an optional set
 * of recalled memories (as text; voice is synthesized separately).
 */
export async function think(input: {
  persona: Persona;
  transcript: TranscriptTurn[];
  memories: string[];
  userText: string;
  /** Current situation (e.g. the active game: party, scene) so answers stay grounded. */
  situation?: string;
  /**
   * A failed brain call throws instead of falling back to a canned mock line — for scheduled runs,
   * which would say that line unprompted. (Mock mode, with no brain configured, still answers.)
   */
  strict?: boolean;
  /** Cancels the brain call once it aborts (treated as a failed call). */
  signal?: AbortSignal;
}): Promise<string> {
  if (!live.brain) return mockThink(input);

  const system: ChatMessage = {
    role: "system",
    content:
      `${input.persona.description}\n\n` +
      `Traits: ${JSON.stringify(input.persona.traits)}\n` +
      (input.situation ? `Current situation (ground your answer in this): ${input.situation}\n` : "") +
      (input.memories.length
        ? `Relevant memories:\n- ${input.memories.join("\n- ")}\n`
        : "") +
      `\nReply as spoken dialogue: concise, natural, 1-3 sentences unless asked for more.`,
  };
  const history: ChatMessage[] = input.transcript.slice(-8).map((t) => ({
    role: t.speaker === "trinity" ? "assistant" : "user",
    content: t.text,
  }));
  try {
    return await mordiemChat(getEndpoints().brainModel, [system, ...history, { role: "user", content: input.userText }], {
      signal: input.signal,
    });
  } catch (err) {
    if (input.strict) throw err;
    console.warn("[brain] live think failed, using mock:", (err as Error).message);
    return mockThink(input);
  }
}

/**
 * Relay a tool's result as natural, in-character spoken dialogue. Tools return
 * flat strings ("26.2 miles is equal to 42.16 kilometers") or raw lookup text;
 * this lets the active persona actually *say* the answer in their own voice.
 * In mock mode (or on error) it falls back to the tool's own phrasing.
 */
export async function narrate(input: {
  persona: Persona;
  transcript: TranscriptTurn[];
  userText: string;
  toolName: string;
  result: string;
}): Promise<string> {
  if (!live.brain) return input.result;

  const system: ChatMessage = {
    role: "system",
    content:
      `${input.persona.description}\n\n` +
      `Traits: ${JSON.stringify(input.persona.traits)}\n\n` +
      `You just used your "${input.toolName}" tool to help the user. Relay its result as ` +
      `natural spoken dialogue in your own voice — concise (1-2 sentences). Don't mention ` +
      `tools, APIs, or JSON; just tell them the answer as if you knew it.`,
  };
  const history: ChatMessage[] = input.transcript.slice(-6).map((t) => ({
    role: t.speaker === "trinity" ? "assistant" : "user",
    content: t.text,
  }));
  try {
    return await mordiemChat(getEndpoints().brainModel, [
      system,
      ...history,
      {
        role: "user",
        content: `The user said: "${input.userText}"\nThe ${input.toolName} result: ${input.result}\n\nTell them, in your own voice.`,
      },
    ]);
  } catch (err) {
    console.warn("[brain] narrate failed, using raw result:", (err as Error).message);
    return input.result;
  }
}

function mockThink(input: { userText: string; memories: string[] }): string {
  const t = input.userText.toLowerCase();
  if (/\b(hello|hi|hey|there)\b/.test(t)) return "Hey! I'm here. What are we making today?";
  if (t.includes("?"))
    return `Good question. Once you plug in a brain model (add a Mordiem key in .env), I'll actually answer that. For now I'm running in mock mode.`;
  if (input.memories.length)
    return `I remember: ${input.memories[0]}. Want to build on that?`;
  return "Got it. I'm in mock mode right now, but I heard you — add API keys in .env and I'll come fully alive.";
}
