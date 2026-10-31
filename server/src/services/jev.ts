import { config, live } from "../config.js";
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

  try {
    const res = await fetch(`${config.typesafe.base}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.typesafe.key}`,
      },
      body: JSON.stringify({
        model: config.typesafe.model,
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

  try {
    const res = await fetch(`${config.typesafe.base}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.typesafe.key}` },
      body: JSON.stringify({ model: config.typesafe.model, state, questions }),
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

/** Best-effort argument filler (Jev/heuristic don't produce tool args). */
function inferArgs(tool: Tool, text: string): Record<string, unknown> {
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
