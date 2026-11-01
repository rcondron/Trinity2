import { getEndpoints, live } from "../settings.js";
import { getTools } from "../tools/registry.js";
import type { Persona, Tool, ToolArgSpec } from "../types.js";
import { contextFor, type AgentContext } from "./context.js";

/**
 * The router: Jev (TypeSafe "System One") decides — from the conversation so far,
 * possibly mid-sentence — whether the caller's words call for one of the tools, and which
 * argument when the tool enumerates options. Request shape mirrors the reference
 * project (personaplex-toolcall/server.py `jev_body`): one `tool` choice question with
 * goal+rules instructions, plus one choice question per option argument, with
 * `state.page.text` = the conversation and `state.recent_actions` = what was already done.
 * Every action is a tool (build_ui, ask_brain, create_skill, remember, …); NONE means the
 * voice just keeps talking.
 */
export type PseudoAction = "NONE";

export const PSEUDO_LABELS: Record<PseudoAction, string> = {
  NONE: "Nothing to do: small talk, a greeting or reaction, a question about the assistant itself, or the caller is still thinking aloud.",
};

/** What was already done for the caller's words — sent to Jev so it doesn't repeat itself. */
export interface RecentAction {
  action: string;
  kind: "tool";
  text: string;
  page_changed: boolean;
}

export interface RouteInput {
  persona: Persona;
  /** Conversation text in the reference format ("Conversation so far…\n\nCaller's latest words (…): …"). */
  conversation: string;
  done: RecentAction[];
  /** Tools this decision may not pick, beyond the context's own (a scheduled run can't schedule or forge). */
  hidden?: ReadonlySet<string>;
}

/** The actions hidden from a decision: the context's (e.g. during a game), plus the input's own. */
const hiddenFor = (input: RouteInput, ctx: AgentContext): Set<string> =>
  input.hidden?.size ? new Set([...ctx.hiddenActions, ...input.hidden]) : ctx.hiddenActions;

export interface ChosenOption {
  value: string;
  confidence: number;
}

export interface Decision {
  /** "NONE" or a tool name. */
  action: string;
  confidence: number;
  tool: Tool | null;
  /** Option arguments Jev answered for the chosen tool (only args that had options offered). */
  options: Record<string, ChosenOption>;
  /** Arguments of the chosen tool that were offered as options (even if Jev answered weakly). */
  offered: string[];
  ms: number;
  error?: string;
}

// ─── Tool visibility & arguments ─────────────────────────────────────────────

/**
 * Tools this persona may use right now: toolset-scoped tools only for personas that
 * enable the set, minus tools that say they're unavailable (e.g. game phase), minus
 * superseded ones, minus tools a context provider hides.
 */
export function visibleTools(persona: Persona, hidden: Set<string> = new Set()): Tool[] {
  const sets = new Set(persona.toolsets ?? []);
  const tools = getTools().filter((t) => {
    if (t.toolset && !sets.has(t.toolset)) return false;
    if (hidden.has(t.name)) return false;
    try {
      return t.available ? t.available({ persona }) : true;
    } catch (err) {
      console.warn(`[router] available(${t.name}) failed:`, (err as Error).message);
      return false;
    }
  });
  const superseded = new Set(tools.flatMap((t) => t.supersedes ?? []));
  return tools.filter((t) => !superseded.has(t.name));
}

/** Static options merged with the tool's dynamic options (e.g. current player names). */
export function optionsFor(tool: Tool, arg: string, spec: ToolArgSpec, persona: Persona): Record<string, string> {
  let dynamic: Record<string, string> | undefined;
  try {
    dynamic = tool.options?.(arg, { persona });
  } catch (err) {
    console.warn(`[router] options(${tool.name}.${arg}) failed:`, (err as Error).message);
  }
  return { ...(spec.options ?? {}), ...(dynamic ?? {}) };
}

/** Whether an argument is an option argument (has a static set or a dynamic resolver). */
export function isOptionArg(tool: Tool, spec: ToolArgSpec): boolean {
  return Boolean(spec.options) || Boolean(tool.options);
}

/**
 * How free-text args are filled — and therefore when the tool may fire. Without an
 * explicit argMode, any argument lacking a static option set counts as free text
 * (conservative: wait for the whole sentence). Tools opt into mid-sentence firing
 * with argMode "none".
 */
export function argModeOf(tool: Tool): "llm" | "raw" | "none" {
  if (tool.argMode) return tool.argMode;
  const free = Object.values(tool.input).some((spec) => !spec.options);
  return free ? "llm" : "none";
}

/** Sentinel offered for optional option-arguments: lets Jev say "nobody in particular". */
export const NONE_OPTION = "none";
const NONE_LABEL = "No particular one / not mentioned / unclear";

interface OptionDomain {
  key: string;
  description: string;
  options: Record<string, string>;
}

interface Prepared {
  /** Tools that can actually be used now (required option sets are non-empty). */
  tools: Tool[];
  /** One Jev question per distinct option set, shared across tools. */
  domains: OptionDomain[];
  /** tool name → arg → domain key. */
  argDomain: Map<string, Map<string, string>>;
}

/**
 * Resolve every option argument once per decision: drop tools whose required options
 * are empty (no "update player" before anyone joined), add the "none" sentinel to
 * optional args, and share identical option sets across tools as a single question.
 */
function prepare(persona: Persona, tools: Tool[]): Prepared {
  const domains: OptionDomain[] = [];
  const byKey = new Map<string, OptionDomain>();
  const argDomain = new Map<string, Map<string, string>>();
  const usable: Tool[] = [];
  for (const t of tools) {
    const map = new Map<string, string>();
    let ok = true;
    for (const [arg, spec] of Object.entries(t.input)) {
      if (!isOptionArg(t, spec)) continue;
      const opts = optionsFor(t, arg, spec, persona);
      if (Object.keys(opts).length === 0) {
        if (spec.required) ok = false;
        continue;
      }
      const full = spec.required ? opts : { ...opts, [NONE_OPTION]: NONE_LABEL };
      const sig = `${arg}|${JSON.stringify(Object.entries(full).sort(([a], [b]) => a.localeCompare(b)))}`;
      let d = byKey.get(sig);
      if (!d) {
        d = { key: `opt_${domains.length + 1}`, description: spec.description || arg, options: full };
        byKey.set(sig, d);
        domains.push(d);
      }
      map.set(arg, d.key);
    }
    if (!ok) continue;
    usable.push(t);
    if (map.size) argDomain.set(t.name, map);
  }
  return { tools: usable, domains, argDomain };
}

// ─── Firing policy (reference parity) ────────────────────────────────────────

/**
 * - NONE / low confidence → skip.
 * - Required option args must be answered with confidence ≥ min, else skip (reference: arg gate).
 * - Tools without free-text args fire as soon as Jev is confident, even mid-sentence.
 * - Tools that need the whole sentence (argMode "llm" or "raw", e.g. build_ui) → hold until it ends.
 */
export function firing(d: Decision, final: boolean, min: number): "fire" | "hold" | "skip" {
  if (d.error || d.action === "NONE" || d.confidence < min) return "skip";
  const tool = d.tool;
  if (!tool) return "skip";
  for (const arg of d.offered) {
    const spec = tool.input[arg];
    if (spec?.required && !((d.options[arg]?.confidence ?? 0) >= min)) return "skip";
  }
  if (argModeOf(tool) === "none") return "fire";
  return final ? "fire" : "hold";
}

/** Option values Jev chose confidently (what a tool should receive). */
export function confidentOptions(d: Decision, min: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [arg, o] of Object.entries(d.options)) if (o.confidence >= min) out[arg] = o.value;
  return out;
}

// ─── Jev request ─────────────────────────────────────────────────────────────

/** Situation first, then the conversation — so the caller's latest words come last. */
function pageText(conversation: string, ctx: AgentContext): string {
  return `Situation: ${ctx.summary.slice(0, 700)}\n\n${conversation}`;
}

/** Tie-breakers for tools whose labels overlap — only when both are offered. */
function toolRules(tools: Tool[]): string[] {
  const has = (name: string) => tools.some((t) => t.name === name);
  const rules: string[] = [];
  if (has("build_ui") && has("create_skill"))
    rules.push(
      "Something to see or use on screen (a page, app, chart, game or form) is build_ui; a new ability the assistant should keep using later (a converter, a lookup, a connection to a web service) is create_skill.",
    );
  return rules;
}

export function buildJevBody(input: RouteInput, prepared: Prepared, ctx: AgentContext) {
  const criteria: Record<string, string> = {};
  for (const [k, label] of Object.entries(PSEUDO_LABELS)) if (!ctx.hiddenActions.has(k)) criteria[k] = label;
  for (const t of prepared.tools) criteria[t.name] = t.description;

  const rules = [
    "Pick an action only when the caller is asking for it, not when they merely mention the topic.",
    "Actions already done for these words are listed in recent_actions; do not repeat them.",
    "Choose NONE for small talk, greetings, reactions, questions about the assistant itself, or when the caller is still mid-thought.",
    ...toolRules(prepared.tools),
    ...ctx.rules,
  ];

  const questions: Record<string, unknown> = {
    tool: {
      type: "choice",
      criteria,
      instructions: {
        goal: "Decide whether the caller's latest words ask the assistant to do one of these things right now.",
        rules,
      },
    },
  };
  for (const d of prepared.domains) {
    questions[d.key] = {
      type: "choice",
      criteria: d.options,
      instructions: { goal: `If the caller's words call for one of the actions: which ${d.description.replace(/\.$/, "")}?` },
    };
  }

  return {
    model: getEndpoints().jevModel,
    state: {
      page: { url: "voice://call", title: "Live voice call", text: pageText(input.conversation, ctx) },
      elements: [],
      recent_actions: input.done.slice(-10),
    },
    questions,
  };
}

/** The tools, option questions and request body decide() would send Jev for this input — without sending it. */
export function jevRequest(input: RouteInput) {
  const ctx = contextFor(input.persona);
  const prepared = prepare(input.persona, visibleTools(input.persona, hiddenFor(input, ctx)));
  return { tools: prepared.tools.map((t) => t.name), body: buildJevBody(input, prepared, ctx) };
}

export async function decide(input: RouteInput): Promise<Decision> {
  const started = Date.now();
  const ctx = contextFor(input.persona);
  const prepared = prepare(input.persona, visibleTools(input.persona, hiddenFor(input, ctx)));
  if (!live.jev) return heuristic(input, prepared.tools, started);

  const ep = getEndpoints();
  try {
    const res = await fetch(`${ep.typesafeUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.typesafeKey}` },
      body: JSON.stringify(buildJevBody(input, prepared, ctx)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const answers =
      ((await res.json()) as { answers?: Record<string, { choice?: string; confidence?: number }> }).answers ?? {};
    const action = answers.tool?.choice ?? "NONE";
    const tool = prepared.tools.find((t) => t.name === action) ?? null;
    const known = tool !== null || (action in PSEUDO_LABELS && !ctx.hiddenActions.has(action));
    const options: Record<string, ChosenOption> = {};
    const offered: string[] = [];
    if (tool) {
      for (const [arg, domainKey] of prepared.argDomain.get(tool.name) ?? []) {
        offered.push(arg);
        const domain = prepared.domains.find((d) => d.key === domainKey);
        const a = answers[domainKey];
        // Only accept a choice that is still a real option ("none" = not specified).
        if (a?.choice && a.choice !== NONE_OPTION && domain && a.choice in domain.options)
          options[arg] = { value: a.choice, confidence: a.confidence ?? 0 };
      }
    }
    return {
      action: known ? action : "NONE",
      confidence: known ? (answers.tool?.confidence ?? 0) : 0,
      tool,
      options,
      offered,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { action: "NONE", confidence: 0, tool: null, options: {}, offered: [], ms: Date.now() - started, error: (err as Error).message };
  }
}

// ─── Heuristic fallback (no Jev key) ─────────────────────────────────────────

function latestWords(conversation: string): string {
  const m = /Caller's latest words \([^)]*\): ([\s\S]*)$/.exec(conversation);
  return (m?.[1] ?? conversation).trim();
}

const SKILL = /\b(make|create|write|build|add)\b.*\b(skill|tool|connector|integration)\b/;
const BUILD = /\b(build|make|show me|create|draw|design|mock ?up|dashboard|chart|graph|visuali[sz]e)\b/;
/** A build asked for with a verb ("can you build me…", "make me a chart", "show me"), not a page word said in passing ("I check my dashboard") or "make sure". */
const BUILD_VERB = String.raw`(build|create|draw|design|mock ?up|visuali[sz]e|show me|make (me|us|a|an|some|(it|this|that) (a|an|the|into)))\b`;
const BUILD_ASKED = new RegExp(String.raw`\b${BUILD_VERB}`);
const EVERY = String.raw`every (day|morning|evening|night|week|hour)\b`;

/** A time said after "remember to …": then it's a reminder to set ("remember to call mom at 5pm"), not a fact to keep. */
const WHEN =
  String.raw`(today|tonight|tomorrow|later|(this|next) (morning|afternoon|evening|week|weekend|month)|in the (morning|afternoon|evening)` +
  String.raw`|${EVERY}|(mon|tues|wednes|thurs|fri|satur|sun)day` +
  String.raw`|(at|by) (\d+(:\d\d)?( ?[ap]\.?m)?|noon|midnight|night|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)` +
  String.raw`|\d+(:\d\d)? ?[ap]\.?m|in (a few |half an |\w+ )(minutes?|hours?|days?|weeks?))`;

/** A page or a part of one: "create a reminder app" or "make a note taking app" is a build, "add a reminder button" an edit. */
const PAGE_PART = String.raw`(app|page|tool|widget|list|board|section|system|dashboard|screen|feature|button|option|field|tracker|timer|ui|view|card|panel|manager|calendar|form|pad|book|keeper)s?\b`;

/** "Remember to …" said to the assistant, not "I remember to …" or "I'll remember to …" (what the caller does). */
const REMEMBER_TO = String.raw`(?<!\b(i|we)('ll| will)? )(remember|don'?t forget) to`;

/**
 * A snooze asked for, as all the words say: "snooze", "okay, snooze it for ten minutes", "can you snooze that?", "snooze
 * it please" — not "I always snooze it", "don't snooze it", "should I snooze it?" or "snooze buttons are the worst".
 * (An opener reads one way only, before a comma or not, so a long run of them can't backtrack.)
 */
const SNOOZE =
  String.raw`^([a-z']+,\s*|(ok(ay)?|yes|yeah|yep|sure|please|alright|all right|hey|oh|um+|uh+|hmm+|ugh|and|so|then|just|well|actually)\b(?!,)\s+)*` +
  String.raw`((can|could|would|will) you )?(please )?snooze( (it|that|this|me|(the|that|my) reminder))?` +
  String.raw`( again| for( \w+){1,3}| (another )?\w+( more)? (minutes?|mins?|hours?)| \w+ more)?(,? (please|thanks|thank you|then|now))?(?=[\s.!?]*$)`;

/** A reminder or a recurring task asked for. ("Add a reminder" needs a time: "add reminders to the list" is an edit.) */
const SCHEDULE = new RegExp(
  String.raw`\b(remind me|${EVERY}|recurring|in \d+ (minutes?|hours?)|${SNOOZE}` +
    String.raw`|((set( up)?|create)( me)? (a |an )?reminders?|make( me)? an? reminder)\b(?! ${PAGE_PART})` +
    String.raw`|add( me)? (a |an )?reminders?\b(?! ${PAGE_PART})(?=.*\b${WHEN}\b)` +
    String.raw`|${REMEMBER_TO} \w+.*\b${WHEN})\b`,
);
/** Something to keep asked for: "remember…", "make a note that…" (not "make a note taking app"), "write this down". */
const REMEMBER = new RegExp(
  String.raw`\b(remember|don'?t forget|note that|keep in mind|(make|take) (a )?note\b(?!-| taking\b| ${PAGE_PART})|(write|jot) (it |this |that )?down)\b`,
);

/** Someone doing something ("I forget…", "we play…", "my wife says…"), not asking for it ("I want…", "I'd like…", "I will need…", "it would be…"). */
const SOMEONE_DOES = String.raw`(i|we|my|our|they|he|she|it)\b(?!'(d|ll)\b|\s+(want|wanna|need|would|will)\b)`;

/**
 * Openers that set the scene rather than ask for anything: "Every day I struggle to focus…" (or "I struggle
 * to focus every day…"), "What's my spending this month?" (or, unpunctuated as speech comes, up to the build
 * asked for), "I remember you made me…", "Remember when…". ("Every morning I want a chart of the weather" still asks.)
 */
const HABIT = new RegExp(String.raw`\b${EVERY}(?=,?\s+${SOMEONE_DOES})|(^|[,.?!]\s*)((so|and|but|well)\s+)?${SOMEONE_DOES}[^,.?!]*?\b${EVERY}`, "g");
const MY_QUESTION = new RegExp(String.raw`\bwhat('s| is| was| are) my\b[^?,.]*?(?=[?,.]|\s+(can you |could you |please )?${BUILD_VERB})`, "g");
const REMINISCING = /\b(i remember|remember when)\b/g;

/** A reminder asked for outright ("…so remind me every hour", "don't forget to…"): an opener that holds one still leads. */
const ASKS = new RegExp(String.raw`\b(remind me|${REMEMBER_TO}|set( up)?( me)? (a |an )?reminders?)\b`);

/** Explicit web words: while a game runs, the only way to a web search ("I search the chest" is a move in the story). */
const ONLINE = /\b(google|online|internet|search the web)\b/;

/** Keyword routing to the same tools Jev would see (already filtered for persona, phase and context). */
function heuristic(input: RouteInput, tools: Tool[], started: number): Decision {
  // Curly apostrophes (phone keyboards type "I’ll", "don’t") read as straight ones.
  const t = latestWords(input.conversation).toLowerCase().replace(/[‘’]/g, "'");
  const pick = (action: string, confidence = 0.75): Decision => ({
    action,
    confidence,
    tool: tools.find((x) => x.name === action) ?? null,
    options: {},
    offered: [],
    ms: Date.now() - started,
  });
  const has = (name: string) => tools.some((x) => x.name === name);
  // While a game runs (its tools are offered), the caller's words are about the story: a question about a
  // hero's sheet is game_answer and what "I" or "we" do is game_narrate.
  const inGame = has("game_narrate") || has("game_answer");
  if (has("game_new") && /\b(start|begin|run|set up|play)\b.*\b(game|campaign|adventure|one.?shot)\b/.test(t)) return pick("game_new");
  // ("What's my character's armor class?" asks about the sheet; "What's my character going to be? An elf…" makes one.)
  if (has("game_answer") && /\b(what('s| is| are)|how (much|many))\b/.test(t) && /\b(my character's|hp|hit points|armou?r|ac|gear|inventory|gold|stats?)\b/.test(t))
    return pick("game_answer");
  if (has("game_add_player") && /\b(my character|i('| a)m playing|i'll play|playing (a|an)|add (a )?(player|hero|character))\b/.test(t))
    return pick("game_add_player");
  if (has("game_roll") && /\broll\b/.test(t)) return pick("game_roll");
  if (has("game_begin") && /\b(let'?s (begin|start)|ready to (begin|play)|start the adventure)\b/.test(t)) return pick("game_begin");
  if (has("game_narrate") && !ONLINE.test(t) && /^((ok(ay)?|so|and|then|now|alright)\b[\s,]*)*(i|we)('(ll|m|re|ve|d))?\s+\w/.test(t))
    return pick("game_narrate");
  // Memory, reminders, search and builds share verbs ("remind me to look it up", "build a tracker
  // for every day"): route by the intent the caller leads with — the pattern that matches earliest
  // wins, so a reminder that mentions a chart is still a reminder, and a build that mentions "every
  // day" is still a build. A memory or reminder phrase where a build verb starts ("make a note…",
  // "create a reminder…") is the memory, and an opener that only sets the scene ("Every day I…",
  // "What's my …?", "I remember…") doesn't lead over a build or skill asked for after it.
  const at = (name: string, re: RegExp, s = t) => (has(name) && re.test(s) ? s.search(re) : Infinity);
  const skillAt = at("create_skill", SKILL);
  const buildAt = at("build_ui", BUILD);
  /**
   * The words without a scene-setting opener (blanked, positions kept) wherever a build or skill is asked for
   * after it with a verb ("…can you build me a timer", not "…I check my dashboard" or "make sure"). An opener
   * that holds a request itself ("I forget, so remind me every hour…") stays.
   */
  const withoutScene = (opener: RegExp) => {
    let s = t;
    for (const m of t.matchAll(opener)) {
      const end = m.index + m[0].length;
      if (ASKS.test(m[0])) continue;
      if (Math.min(at("create_skill", SKILL, t.slice(end)), at("build_ui", BUILD_ASKED, t.slice(end))) < Infinity)
        s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice(end);
    }
    return s;
  };
  const searchAt = at("web_search", inGame ? ONLINE : /\b(search|look up|google|research|what('s| is) the latest)\b/);
  const recallAt = at("recall", /\b(do you remember|what('s| is| was| are) my|what did i (tell|say)|remind me what)\b/, withoutScene(MY_QUESTION));
  const rememberAt = at("remember", REMEMBER, withoutScene(REMINISCING));
  const scheduleAt = at("schedule", SCHEDULE, withoutScene(HABIT));
  const memoryAt = Math.min(recallAt, rememberAt, scheduleAt);
  if (searchAt < Math.min(memoryAt, skillAt, buildAt)) return pick("web_search", 0.8);
  if (memoryAt < Infinity && memoryAt <= Math.min(skillAt, buildAt)) {
    if (memoryAt === recallAt) return pick("recall", 0.7);
    if (memoryAt === scheduleAt) return pick("schedule", 0.7); // "remember to call mom at 5" starts both
    return pick("remember", 0.7);
  }
  if (skillAt < Infinity) return pick("create_skill", 0.7);
  if (buildAt < Infinity) return pick("build_ui");
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  for (const tool of tools) {
    if (inGame && tool.name === "web_search") continue; // "search the chest": no web words, no web search
    if (tool.name.split(/[_\s]+/).some((tok) => tok.length > 3 && words.has(tok))) return pick(tool.name, 0.7);
  }
  return pick("NONE", 0.6);
}
