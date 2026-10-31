import { config, live } from "../config.js";
import type { Persona, TranscriptTurn } from "../types.js";
import { openrouterChat, type ChatMessage } from "./llm.js";

/**
 * The "brain" — general knowledge & reasoning for PersonaPlex lookups. Given the
 * persona, recent conversation, and an optional set of recalled memories, it
 * produces what Trinity should say next (as text; voice is synthesized separately).
 */
export async function think(input: {
  persona: Persona;
  transcript: TranscriptTurn[];
  memories: string[];
  userText: string;
}): Promise<string> {
  if (!live.brain) return mockThink(input);

  const system: ChatMessage = {
    role: "system",
    content:
      `${input.persona.description}\n\n` +
      `Traits: ${JSON.stringify(input.persona.traits)}\n` +
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
    return await openrouterChat(config.openrouter.brainModel, [
      system,
      ...history,
      { role: "user", content: input.userText },
    ]);
  } catch (err) {
    console.warn("[brain] live think failed, using mock:", (err as Error).message);
    return mockThink(input);
  }
}

function mockThink(input: { userText: string; memories: string[] }): string {
  const t = input.userText.toLowerCase();
  if (/\b(hello|hi|hey|there)\b/.test(t)) return "Hey! I'm here. What are we making today?";
  if (t.includes("?"))
    return `Good question. Once you plug in a brain model (OpenRouter key), I'll actually answer that. For now I'm running in mock mode.`;
  if (input.memories.length)
    return `I remember: ${input.memories[0]}. Want to build on that?`;
  return "Got it. I'm in mock mode right now, but I heard you — add API keys in .env and I'll come fully alive.";
}
