import { getEndpoints } from "../settings.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Chat completion via Mordiem (OpenAI-compatible gateway to the Morpheus network).
 * Used for the brain, UI codegen, and the reply writer — just different model ids.
 * Base URL and key come from the runtime settings (env defaults + overrides).
 */
export async function mordiemChat(
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  const res = await fetch(`${mordiemUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mordiemKey}`,
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
