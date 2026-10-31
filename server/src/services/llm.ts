import { config } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal OpenRouter chat call. Used by brain + jev when keys are present. */
export async function openrouterChat(
  model: string,
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number } = {},
): Promise<string> {
  const res = await fetch(`${config.openrouter.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouter.key}`,
      "HTTP-Referer": "http://localhost",
      "X-Title": "Trinity",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.4,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

/** Morph is OpenAI-compatible; this calls its fast-apply / chat endpoint. */
export async function morphChat(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${config.morph.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.morph.key}`,
    },
    body: JSON.stringify({ model: config.morph.model, messages }),
  });
  if (!res.ok) throw new Error(`Morph ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}
