import { config, live } from "../config.js";
import type { RouteDecision, Tool, TranscriptTurn } from "../types.js";
import { openrouterChat } from "./llm.js";

/**
 * Jev is the decision layer. It takes the unstructured conversation state and the
 * set of available tools and returns a typed decision: do nothing, call a tool,
 * recall memory, build UI, or just speak. It does not generate dialogue itself —
 * that's the brain's job.
 */
export async function route(input: {
  userText: string;
  transcript: TranscriptTurn[];
  tools: Tool[];
}): Promise<RouteDecision> {
  if (!live.jev) return mockRoute(input);

  const toolList = input.tools
    .map((t) => `- ${t.name}: ${t.description} | args: ${JSON.stringify(t.input)}`)
    .join("\n");
  const context = input.transcript.slice(-6).map((t) => `${t.speaker}: ${t.text}`).join("\n");

  const prompt =
    `You are a routing decision function. Given the conversation and tools, decide the single best next action.\n\n` +
    `TOOLS:\n${toolList || "(none)"}\n\n` +
    `CONVERSATION:\n${context}\n\nLATEST USER TURN: ${input.userText}\n\n` +
    `Respond with JSON only: {"action":"none|tool|recall|build|speak","tool":"<name or null>",` +
    `"args":{...},"confidence":0..1,"reason":"short"}.`;

  try {
    const raw = await openrouterChat(
      config.openrouter.jevModel,
      [{ role: "user", content: prompt }],
      { json: true, temperature: 0 },
    );
    const parsed = JSON.parse(raw) as Partial<RouteDecision>;
    return {
      action: parsed.action ?? "speak",
      tool: parsed.tool,
      args: parsed.args,
      confidence: parsed.confidence ?? 0.5,
      reason: parsed.reason ?? "",
    };
  } catch (err) {
    console.warn("[jev] live routing failed, using heuristic:", (err as Error).message);
    return mockRoute(input);
  }
}

/** Keyword heuristic that mimics Jev's job well enough to drive the whole loop in mock mode. */
function mockRoute(input: { userText: string; tools: Tool[] }): RouteDecision {
  const t = input.userText.toLowerCase();
  const has = (name: string) => input.tools.some((x) => x.name === name);

  if (/\b(search|look up|google|find out|research|what('s| is) the latest)\b/.test(t) && has("web_search"))
    return { action: "tool", tool: "web_search", args: { query: input.userText }, confidence: 0.8, reason: "user asked to look something up" };

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

/** Best-effort argument filler for the mock router. */
function inferArgs(tool: Tool, text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(tool.input)) {
    if (spec.type !== "string") continue;
    if (/notation|dice/i.test(key)) {
      const m = text.toLowerCase().match(/\d*d\d+([+-]\d+)?/);
      args[key] = m ? m[0] : text;
    } else {
      args[key] = text;
    }
  }
  return args;
}
