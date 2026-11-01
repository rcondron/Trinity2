import { getEndpoints } from "../settings.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Chat completion via Mordiem (OpenAI-compatible gateway to the Morpheus network).
 * Used for the brain, the coding skill, and the reply writer — just different model ids.
 * Base URL and key come from the runtime settings (env defaults + overrides).
 */
export async function mordiemChat(
  model: string,
  messages: ChatMessage[],
  /** `signal` cancels the call (it rejects with the signal's reason), on top of the `timeoutMs` limit. */
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 90_000);
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
    signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
  });
  if (!res.ok) throw new Error(`Mordiem ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

/** Not chat or image models (speech, music, video, embeddings): left out of the Settings pickers. */
const NOT_A_PICK = /(tts|music|sound|voice-changer|scribe|whisper|embedding|video|ace-step|-edit$|image-to|text-to-video)/i;
/** Image generators (the gateway lists every model with type "model", so go by name). */
const IMAGE_ID = /(flux|krea|chroma|imagine|image|sdxl|seedream|dall|recraft|ideogram|illustrious|hidream|qwen-image|nano-banana)/i;
let catalog: { at: number; text: string[]; image: string[] } | null = null;

/**
 * The model ids the gateway offers, split into text and image models, for the Settings model
 * pickers. Cached 10 minutes; the last good list (or empty lists) when Mordiem can't be reached.
 */
export async function mordiemModels(): Promise<{ text: string[]; image: string[] }> {
  if (catalog && Date.now() - catalog.at < 10 * 60_000) return catalog;
  const { mordiemUrl, mordiemKey } = getEndpoints();
  try {
    const res = await fetch(`${mordiemUrl}/models`, {
      headers: mordiemKey ? { Authorization: `Bearer ${mordiemKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Mordiem ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = [...new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"))];
    const picks = ids.filter((id) => !NOT_A_PICK.test(id)).sort();
    catalog = { at: Date.now(), text: picks.filter((id) => !IMAGE_ID.test(id)), image: picks.filter((id) => IMAGE_ID.test(id)) };
    return catalog;
  } catch {
    return catalog ?? { text: [], image: [] };
  }
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  idleMs?: number;
  /** Merged into the request body (e.g. venice_parameters). */
  extra?: Record<string, unknown>;
  /**
   * A thinking model's reasoning, as it streams (`delta.reasoning_content`): called with the
   * reasoning size so far, in characters — so a caller can show "Thinking…" instead of a stuck screen.
   */
  onReasoning?: (chars: number) => void;
  /** Cancels the call; it rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Streamed chat completion: `onText` receives the accumulated text as it grows (so a
 * caller can show work in progress); resolves with the full text. Aborts when the whole
 * call exceeds `timeoutMs` or the stream goes quiet for `idleMs` — reasoning deltas count
 * as activity, so a thinking model working through its plan isn't taken for a stall.
 * Rejects when the reply didn't finish: an error sent inside the stream, a stop at the token
 * limit or a content filter, or a stream that ends with neither a finish_reason nor [DONE] —
 * a cut-off reply must never pass for a whole one.
 */
export async function mordiemStream(
  model: string,
  messages: ChatMessage[],
  onText: (full: string) => void,
  opts: StreamOptions = {},
): Promise<string> {
  const { mordiemUrl, mordiemKey } = getEndpoints();
  const ctrl = new AbortController();
  const total = setTimeout(() => ctrl.abort(new Error("timed out")), opts.timeoutMs ?? 150_000);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error("stream stalled")), opts.idleMs ?? 30_000);
  };
  const cancel = () => ctrl.abort(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("cancelled"));
  if (opts.signal?.aborted) cancel();
  else opts.signal?.addEventListener("abort", cancel, { once: true });
  try {
    touch();
    const res = await fetch(`${mordiemUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mordiemKey}` },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: opts.temperature ?? 0.4,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...opts.extra,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new StreamHttpError(res.status, (await res.text().catch(() => "")).slice(0, 300));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = 0;
    let grew = false;
    let thought = false;
    let failure = ""; // an error the gateway sent inside the stream
    let finish = ""; // the last finish_reason (it can ride on a chunk that also carries content)
    let done = false; // `data: [DONE]` arrived
    const take = (line: string) => {
      const t = line.trim();
      if (!t.startsWith("data:")) return; // SSE comments (": processing"), other fields, blank lines
      const data = t.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        return;
      }
      let msg: { choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[]; error?: unknown };
      try {
        msg = JSON.parse(data);
      } catch {
        return; // keep-alive or partial line
      }
      if (!msg || typeof msg !== "object") return; // "data: null" and the like carry nothing
      if (msg.error) failure = streamError(msg.error);
      const choice = msg.choices?.[0]; // the closing usage chunk has none
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason;
      const content = choice?.delta?.content;
      if (typeof content === "string" && content) {
        text += content;
        grew = true;
      }
      const r = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (typeof r === "string" && r) {
        reasoning += r.length;
        thought = true;
      }
    };
    const report = () => {
      if (thought) opts.onReasoning?.(reasoning);
      if (grew) onText(text);
      grew = thought = false;
    };
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      touch();
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) take(line);
      report();
    }
    take(buffer + dec.decode()); // a last line the server didn't end with a newline
    report();
    if (failure) throw new Error(`Mordiem stream error: ${failure}`);
    if (finish === "length") throw new Error("the reply was cut off at the token limit");
    if (finish === "content_filter") throw new Error("the reply was cut off by a content filter");
    if (finish === "error") throw new Error("the model stopped with an error partway through the reply");
    if (!finish && !done) throw new Error("the stream ended before the reply was finished");
    return text;
  } catch (err) {
    // Surface the abort reason ("timed out" / "stream stalled") rather than a bare AbortError.
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
    throw err;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/** What an error sent inside a stream says: `{"error": {"message": "…"}}` or `{"error": "…"}`. */
function streamError(e: unknown): string {
  const message = typeof e === "string" ? e : (e as { message?: unknown }).message;
  return (typeof message === "string" && message.trim() ? message : JSON.stringify(e)).slice(0, 300);
}

export class StreamHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Mordiem ${status}: ${body}`);
  }
}
