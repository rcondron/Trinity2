import { getEndpoints, live } from "../settings.js";

/**
 * Venice-routed models on Mordiem (e.g. nemotron) accept these; disabling thinking
 * measured ~1.2s faster on streamed replies. Non-Venice models (glm, gpt-oss, llama)
 * reject them with HTTP 400 — users retry without.
 */
export const VENICE_PARAMS = {
  include_venice_system_prompt: false,
  disable_thinking: true,
  strip_thinking_response: true,
};

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface JsonChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Earlier turns, between the system prompt and this user message (the solver's loop). */
  history?: ChatTurn[];
}

/**
 * Ask a (fast) model for a JSON object. Sends `response_format: json_object` plus the
 * Venice no-thinking flags; on HTTP 400 retries once with neither. Returns the parsed
 * first `{…}` block, or null on any failure/timeout. Never throws.
 */
export async function jsonChat<T = Record<string, unknown>>(
  system: string,
  user: string,
  opts: JsonChatOptions = {},
): Promise<T | null> {
  if (!live.mordiem) return null;
  const { mordiemUrl, mordiemKey, fastModel } = getEndpoints();
  const base = {
    model: opts.model ?? fastModel,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 400,
    messages: [{ role: "system", content: system }, ...(opts.history ?? []), { role: "user", content: user }],
  };
  const call = async (extra: Record<string, unknown>) =>
    fetch(`${mordiemUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
      body: JSON.stringify({ ...base, ...extra }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
  try {
    let res = await call({ response_format: { type: "json_object" }, venice_parameters: VENICE_PARAMS });
    if (res.status === 400) res = await call({});
    if (!res.ok) {
      console.warn(`[json-chat] ${base.model} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return parseJsonObject<T>(data.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    console.warn(`[json-chat] ${base.model} failed: ${(err as Error).message}`);
    return null;
  }
}

/** Parse the first balanced `{…}` object in a model reply (tolerates prose and code fences). */
export function parseJsonObject<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}
