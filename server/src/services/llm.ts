import { config } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Chat completion via Mordiem (OpenAI-compatible gateway to the Morpheus network).
 * Used for both the brain and UI codegen — just different model ids.
 */
export async function mordiemChat(
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await fetch(`${config.mordiem.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.mordiem.key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.4,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Mordiem ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}
