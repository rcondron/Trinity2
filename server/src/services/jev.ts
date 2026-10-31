import { getEndpoints, live } from "../settings.js";
import type { MemoryDoc, RouteDecision, Tool, TranscriptTurn } from "../types.js";

/**
 * Jev (TypeSafe AI) is the decision layer. It is NOT a chat model — it's a custom
 * "System One" decision API: give it unstructured `state` plus typed `questions`,
 * get back typed probabilistic answers. We frame routing as a single `choice`
 * question over the available actions, so Jev picks what Trinity should do next.
 * Jev doesn't produce tool arguments, so we fill those ourselves.
 */
export async function route(input: {
  userText: string;
  transcript: TranscriptTurn[];
  tools: Tool[];
}): Promise<RouteDecision> {
  if (!live.jev) return mockRoute(input);

  const criteria: Record<string, string> = {
    converse: "Just talk or answer conversationally — no tool or UI build is needed.",
    build: "The user wants you to make, build, draw, design, or show a piece of UI.",
    remember: "The user shared a fact or preference about themselves worth remembering.",
    forge: "The user wants a NEW reusable tool/skill that does not exist in the tool list below.",
  };
  for (const t of input.tools) criteria[`tool:${t.name}`] = t.description;

  const state =
    input.transcript.slice(-6).map((t) => `${t.speaker}: ${t.text}`).join("\n") +
    `\nlatest user turn: ${input.userText}`;

  const ep = getEndpoints();
  try {
    const res = await fetch(`${ep.typesafeUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ep.typesafeKey}`,
      },
      body: JSON.stringify({
        model: ep.jevModel,
        state,
        questions: {
          action: {
            type: "choice",
            instructions: "Which single action should the assistant take next?",
            criteria,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as {
      answers?: { action?: { choice?: string; confidence?: number } };
    };
    const ans = data.answers?.action;
    if (!ans?.choice) throw new Error("Jev returned no choice");
    return mapChoice(ans.choice, input, ans.confidence ?? 0.6);
  } catch (err) {
    console.warn("[jev] live routing failed, using heuristic:", (err as Error).message);
    return mockRoute(input);
  }
}

/**
 * Jev-selected recall: given keyword-prefiltered candidate memories, ask Jev (one
 * `noul` question per candidate, batched) which are actually relevant to the current
 * turn. Falls back to the top keyword matches when Jev isn't available.
 */
export async function selectMemories(
  input: { userText: string; transcript: TranscriptTurn[] },
  candidates: MemoryDoc[],
): Promise<MemoryDoc[]> {
  if (candidates.length === 0) return [];
  if (!live.jev) return candidates.slice(0, 4);

  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  candidates.forEach((d, i) => {
    questions[`m${i}`] = {
      type: "noul",
      instructions: `This stored memory is relevant to the user's latest message and worth recalling now: "${d.text}"`,
    };
  });
  const state =
    input.transcript.slice(-4).map((t) => `${t.speaker}: ${t.text}`).join("\n") +
    `\nlatest user turn: ${input.userText}`;

  const ep = getEndpoints();
  try {
    const res = await fetch(`${ep.typesafeUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.typesafeKey}` },
      body: JSON.stringify({ model: ep.jevModel, state, questions }),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    const kept = candidates.filter((_, i) => (data.answers?.[`m${i}`]?.noul ?? 0) > 0.5);
    return kept.slice(0, 5);
  } catch (err) {
    console.warn("[jev] memory selection failed, using top matches:", (err as Error).message);
    return candidates.slice(0, 4);
  }
}

/** Map a Jev choice-label back to a typed RouteDecision, filling tool args ourselves. */
function mapChoice(
  choice: string,
  input: { userText: string; tools: Tool[] },
  confidence: number,
): RouteDecision {
  if (choice === "build")
    return { action: "build", args: { instruction: input.userText }, confidence, reason: "jev: build" };
  if (choice === "forge")
    return { action: "forge", args: { need: input.userText }, confidence, reason: "jev: forge" };
  if (choice === "remember")
    return { action: "recall", args: { write: true, query: input.userText }, confidence, reason: "jev: remember" };
  if (choice.startsWith("tool:")) {
    const name = choice.slice(5);
    const tool = input.tools.find((t) => t.name === name);
    return {
      action: "tool",
      tool: name,
      args: tool ? inferArgs(tool, input.userText) : { query: input.userText },
      confidence,
      reason: `jev: ${name}`,
    };
  }
  return { action: "speak", confidence, reason: "jev: converse" };
}

/** Keyword heuristic that mimics Jev's job well enough to drive the loop in mock/fallback mode. */
function mockRoute(input: { userText: string; tools: Tool[] }): RouteDecision {
  const t = input.userText.toLowerCase();
  const has = (name: string) => input.tools.some((x) => x.name === name);

  if (/\b(search|look up|google|find out|research|what('s| is) the latest)\b/.test(t) && has("web_search"))
    return { action: "tool", tool: "web_search", args: { query: input.userText }, confidence: 0.8, reason: "user asked to look something up" };

  if (/\b(make|create|write|build)\b.*\b(tool|skill|connector|calculator|converter|generator)\b/.test(t))
    return { action: "forge", args: { need: input.userText }, confidence: 0.7, reason: "user asked to create a tool" };

  if (/\b(build|make|show me|create|draw|design|mock ?up|dashboard|page|form|chart)\b/.test(t))
    return { action: "build", args: { instruction: input.userText }, confidence: 0.75, reason: "user asked to make something" };

  if (/\b(remember|note that|don't forget|my name is|i like|i prefer|i am|i'm)\b/.test(t))
    return { action: "recall", args: { write: true, query: input.userText }, confidence: 0.7, reason: "something worth remembering" };

  if (/\b(remind me|every day|each (morning|day|week)|recurring|schedule)\b/.test(t) && has("heartbeat_add"))
    return { action: "tool", tool: "heartbeat_add", args: { instruction: input.userText }, confidence: 0.7, reason: "recurring task" };

  // Generic tool match: does the utterance name a registered tool (incl. loaded skills)?
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  for (const tool of input.tools) {
    const nameTokens = tool.name.split(/[_\s]+/).filter((tok) => tok.length > 2);
    if (nameTokens.some((tok) => words.has(tok)))
      return {
        action: "tool",
        tool: tool.name,
        args: inferArgs(tool, input.userText),
        confidence: 0.6,
        reason: `utterance named tool ${tool.name}`,
      };
  }

  if (t.includes("?"))
    return { action: "recall", args: { query: input.userText }, confidence: 0.5, reason: "question — recall then answer" };

  return { action: "speak", confidence: 0.6, reason: "ordinary conversational turn" };
}

// ─── Streaming router (the real-time loop) ───────────────────────────────────

/** A single decision from the streaming router, mid-sentence or at sentence end. */
export interface StreamDecision {
  /** Tool name, or a pseudo-action: NONE | BUILD | FORGE | REMEMBER. */
  tool: string;
  confidence: number;
  /** Chosen argument when the tool enumerates options; null otherwise. */
  arg: string | null;
  argConfidence: number | null;
  ms: number;
  error?: string;
}

const STREAM_ACTIONS: Record<string, string> = {
  NONE: "Nothing to do: small talk, a question, or anything answerable by just talking.",
  BUILD: "The caller wants a piece of UI made, drawn, designed, or shown on screen.",
  FORGE: "The caller wants a NEW reusable tool/skill that is not in the tool list.",
  REMEMBER: "The caller shared a durable fact or preference about themselves worth saving.",
};

function streamQuestions(conversation: string, tools: Tool[], done: unknown[]) {
  const criteria: Record<string, string> = { ...STREAM_ACTIONS };
  for (const t of tools) criteria[t.name] = t.description;

  const questions: Record<string, unknown> = {
    tool: {
      type: "choice",
      criteria,
      instructions: {
        goal: "Decide whether the caller's latest words ask the agent to do one of these right now.",
        rules: [
          "Pick a tool only when the caller is asking for it, not when they merely mention the topic.",
          "Actions already done for these words are in recent_actions; do not repeat them.",
        ],
      },
    },
  };
  // A second question per tool that enumerates argument options, so Jev picks the arg too.
  for (const t of tools) {
    for (const [arg, spec] of Object.entries(t.input)) {
      if (!spec.options) continue;
      questions[`${t.name}__${arg}`] = {
        type: "choice",
        criteria: spec.options,
        instructions: { goal: `If the caller wants ${t.description.toLowerCase()} which ${arg}?` },
      };
    }
  }
  return {
    model: getEndpoints().jevModel,
    state: {
      page: { url: "voice://call", title: "Live voice call", text: conversation },
      elements: [],
      recent_actions: done.slice(-10),
    },
    questions,
  };
}

/**
 * Ask Jev whether the caller's words (possibly mid-sentence) call for a tool, and
 * — when the chosen tool enumerates options — which argument. Mirrors the text
 * `route`, but is shaped for the fast, repeated polling the live loop does.
 */
export async function routeStream(
  conversation: string,
  tools: Tool[],
  done: unknown[],
): Promise<StreamDecision> {
  const ep = getEndpoints();
  const started = Date.now();
  if (!ep.typesafeKey) return { tool: "NONE", confidence: 0, arg: null, argConfidence: null, ms: 0 };
  try {
    const res = await fetch(`${ep.typesafeUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.typesafeKey}` },
      body: JSON.stringify(streamQuestions(conversation, tools, done)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
    const answers = ((await res.json()) as { answers?: Record<string, { choice?: string; confidence?: number }> })
      .answers ?? {};
    const tool = answers.tool?.choice ?? "NONE";
    const head = answers[`${tool}__${argNameFor(tool, tools)}`];
    return {
      tool,
      confidence: answers.tool?.confidence ?? 0,
      arg: head?.choice ?? null,
      argConfidence: head?.confidence ?? null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { tool: "NONE", confidence: 0, arg: null, argConfidence: null, ms: Date.now() - started, error: (err as Error).message };
  }
}

/** The first argument name of a tool that enumerates options (for reading Jev's answer). */
function argNameFor(toolName: string, tools: Tool[]): string {
  const t = tools.find((x) => x.name === toolName);
  if (!t) return "";
  for (const [arg, spec] of Object.entries(t.input)) if (spec.options) return arg;
  return "";
}

/** Best-effort argument filler (Jev/heuristic don't produce free-text tool args). */
export function inferArgs(tool: Tool, text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let ni = 0;
  for (const [key, spec] of Object.entries(tool.input)) {
    if (spec.type === "number") {
      if (ni < numbers.length) args[key] = numbers[ni++];
    } else if (spec.type === "boolean") {
      args[key] = /\b(yes|true|on|enable|please)\b/i.test(text);
    } else if (/notation|dice/i.test(key)) {
      const m = text.toLowerCase().match(/\d*d\d+([+-]\d+)?/);
      args[key] = m ? m[0] : text;
    } else {
      args[key] = text;
    }
  }
  return args;
}
