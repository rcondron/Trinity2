import { getEndpoints, live } from "../settings.js";
import { getTools } from "../tools/registry.js";
import type { Persona, Tool, ToolArgSpec } from "../types.js";
import { contextFor, type AgentContext } from "./context.js";

/**
 * The router: Jev (TypeSafe "System One") decides — from the conversation so far,
 * possibly mid-sentence — whether the user's words call for one of the tools, and which
 * argument when the tool enumerates options. Request shape mirrors the reference
 * project (personaplex-toolcall/server.py `jev_body`): one `tool` choice question with
 * goal+rules instructions, plus one choice question per option argument, with
 * `state.page.text` = the conversation and `state.recent_actions` = what was already done.
 * Every action is a tool (build_ui, ask_brain, create_skill, remember, …); NONE means the
 * voice just keeps talking.
 */
export type PseudoAction = "NONE";

export const PSEUDO_LABELS: Record<PseudoAction, string> = {
  NONE: "Nothing to do: small talk, a greeting or reaction, a question about the assistant itself, or the user is still thinking aloud.",
};

/** What was already done for the user's words — sent to Jev so it doesn't repeat itself. */
export interface RecentAction {
  action: string;
  kind: "tool";
  text: string;
  page_changed: boolean;
}

export interface RouteInput {
  persona: Persona;
  /** Conversation text in the reference format ("Conversation so far…\n\nUser's latest words (…): …"). */
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

/** Situation first, then the conversation — so the user's latest words come last. */
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
  if (has("build_ui") && has("make_image"))
    rules.push("A picture, image, photo, illustration, painting or artwork of something is make_image, even when the user says 'draw' or 'make'; a chart, diagram, page or app is build_ui.");
  if (has("build_ui") && has("clear_workspace"))
    rules.push("Clearing, closing, resetting or blanking the screen or workspace is clear_workspace; changing what's on it is build_ui.");
  if (has("undo_workspace"))
    rules.push(
      "Bringing back cards or a screen that was just cleared or removed (undo, put it back, restore, go back, oops) is undo_workspace — not clear_workspace and not building something new.",
    );
  if (has("edit_html") && has("build_ui"))
    rules.push(
      "Tweaking something already on the board (make a picture smaller/larger, change img/svg/canvas/widget HTML or styles) is edit_html; creating a new interactive widget or rebuilding one from scratch is build_ui.",
    );
  if (has("edit_html") && has("make_image"))
    rules.push(
      "Resizing or restyling an existing picture on the board is edit_html; generating a brand-new picture is make_image.",
    );
  if (has("remove_card") || has("move_card") || has("undo_workspace"))
    rules.push(
      "Floating cards on the board are numbered and tagged by content: removing one is remove_card, moving one is move_card (by number or by what it shows — 'the tiger', 'under the panda'), wiping every card / the whole screen is clear_workspace, and restoring a mistaken clear or remove is undo_workspace. A text sticky/note is make_text; asking for several pictures (a panda and a tiger) is still make_image (one card each).",
    );
  if (has("show_card")) {
    if (has("ask_brain"))
      rules.push(
        "A quick question with a short answer (a number, a date, yes/no, a calculation, a one-line fact) is ask_brain, spoken only; a request with substance to look at — a recipe, the news, who someone is, what a place or thing is like, how to do something, a comparison, a plan or a list — is show_card, which also speaks a summary.",
      );
    if (has("web_search"))
      rules.push(
        "'Search for / look up / google X' to hear what's out there is web_search; news, headlines, the weather, scores or any looked-up information the user wants laid out is show_card.",
      );
    if (has("build_ui"))
      rules.push("Information to read (a recipe, a profile, a guide, the news) is show_card; an interactive tool, app, game, chart or form to use is build_ui.");
    if (has("make_image")) rules.push("A picture alone is make_image; information about something is show_card (it adds its own picture).");
    if (has("make_text"))
      rules.push("A note in the user's own words is make_text; researched or written-up information — even 'put the muffin recipe on the board' — is show_card.");
    rules.push(
      "Something to buy or compare prices on, flights, hotels, or a trip plan is show_card too (its type option says which: shopping, flights, hotels, itinerary) — it runs a live search and lays the results out with prices; never web_search or ask_brain for those.",
    );
  }
  if (has("set_speech_rate"))
    rules.push("Asking Trinity to talk slower, faster, or at normal speed is set_speech_rate — not small talk.");
  if (["build_ui", "clear_workspace", "undo_workspace", "make_image", "make_audio", "make_video", "make_text", "edit_html", "show_card"].some(has))
    rules.push(
      "The workspace is the live page beside the user — what they call the screen, the board or the window. Asking to build, change, show something on, add a card, picture, clear it, or undo a clear is an action, never small talk.",
    );
  return rules;
}

export function buildJevBody(input: RouteInput, prepared: Prepared, ctx: AgentContext) {
  const criteria: Record<string, string> = {};
  for (const [k, label] of Object.entries(PSEUDO_LABELS)) if (!ctx.hiddenActions.has(k)) criteria[k] = label;
  for (const t of prepared.tools) criteria[t.name] = t.description;

  const rules = [
    "Pick an action only when the user is asking for it, not when they merely mention the topic.",
    "Actions already done for these words are listed in recent_actions; do not repeat them.",
    "Choose NONE for small talk, greetings, reactions, questions about the assistant itself, or when the user is still mid-thought.",
    ...toolRules(prepared.tools),
    ...ctx.rules,
  ];

  const questions: Record<string, unknown> = {
    tool: {
      type: "choice",
      criteria,
      instructions: {
        goal: "Decide whether the user's latest words ask the assistant to do one of these things right now.",
        rules,
      },
    },
  };
  for (const d of prepared.domains) {
    questions[d.key] = {
      type: "choice",
      criteria: d.options,
      instructions: { goal: `If the user's words call for one of the actions: which ${d.description.replace(/\.$/, "")}?` },
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

/** Screen ops the keyword heuristic may take when Jev abstains — clear/move/remove/undo are unambiguous. */
const HEURISTIC_OVERRIDE = /^(clear_workspace|undo_workspace|remove_card|move_card|describe_workspace|edit_html|set_speech_rate)$/;

export async function decide(input: RouteInput): Promise<Decision> {
  const started = Date.now();
  const ctx = contextFor(input.persona);
  const prepared = prepare(input.persona, visibleTools(input.persona, hiddenFor(input, ctx)));
  if (!live.jev) return heuristic(input, prepared.tools, started);

  const ep = getEndpoints();
  let jev: Decision;
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
    jev = {
      action: known ? action : "NONE",
      confidence: known ? (answers.tool?.confidence ?? 0) : 0,
      tool,
      options,
      offered,
      ms: Date.now() - started,
    };
  } catch (err) {
    jev = { action: "NONE", confidence: 0, tool: null, options: {}, offered: [], ms: Date.now() - started, error: (err as Error).message };
  }

  // Jev often answers NONE for "clear the workspace" / "clear it" while a page is up. When the
  // keyword heuristic is sure about a screen action, take that instead of letting the ask drop.
  // Also: don't let a confident build_ui steal "make the picture smaller" / HTML tweaks.
  // Never let board heuristics override a game_* pick — story verbs ("put the torch left",
  // "get rid of the goblin") look like move/remove cards.
  if (jev.action === "NONE" || jev.confidence < 0.5 || jev.error || jev.action === "build_ui") {
    const h = heuristic(input, prepared.tools, started);
    const jevIsGame = jev.action.startsWith("game_");
    if (!jevIsGame && h.action !== "NONE" && h.confidence >= 0.8 && HEURISTIC_OVERRIDE.test(h.action)) {
      if (jev.action === "build_ui" && h.action !== "edit_html") {
        /* keep build_ui unless the heuristic is specifically an HTML tweak */
      } else {
        return { ...h, ms: Date.now() - started, error: jev.error };
      }
    }
    // When Jev abstains or is unsure, promote a confident game-tool heuristic so setup and
    // play still fire (board tooling used to drown these out).
    if (
      !jevIsGame &&
      (jev.action === "NONE" || jev.confidence < 0.5 || jev.error) &&
      h.action.startsWith("game_") &&
      h.tool &&
      h.confidence >= 0.7
    ) {
      return { ...h, ms: Date.now() - started, error: jev.error };
    }
  }
  return jev;
}

// ─── Heuristic fallback (no Jev key) ─────────────────────────────────────────

function latestWords(conversation: string): string {
  const m = /User's latest words \([^)]*\): ([\s\S]*)$/.exec(conversation);
  return (m?.[1] ?? conversation).trim();
}

const SKILL = /\b(make|create|write|build|add)\b.*\b(skill|tool|connector|integration)\b/;
const BUILD = /\b(build|make|show me|create|draw|design|mock ?up|dashboard|chart|graph|visuali[sz]e)\b/;
/** A build asked for with a verb ("can you build me…", "make me a chart", "show me"), not a page word said in passing ("I check my dashboard") or "make sure". */
const BUILD_VERB = String.raw`(build|create|draw|design|mock ?up|visuali[sz]e|show me|make (me|us|a|an|some|(it|this|that) (a|an|the|into)))\b`;
const BUILD_ASKED = new RegExp(String.raw`\b${BUILD_VERB}`);
/**
 * A making verb a few words before a picture, clip or audio noun ("show me a picture of…", "I'd like a video of…") —
 * not a mention ("I took a picture yesterday", "I like this video") nor something to watch, find or send.
 */
const ASK_FOR = String.raw`(make|create|generate|draw|design|render|produce|give|show|whip up|i want|i'?d like|i need|can i (get|have)|how about)\b(?![^.?!]{0,40}\b(watch|see|find|look|search|play|open|download|send|upload|take|took)\b)[^.?!]{0,40}?\b`;
/** A picture asked for by name ("draw me a picture of…", "paint a sunset"), not a chart "drawn" ("draw a chart" is a build) nor one made bigger. */
const IMAGE = new RegExp(
  String.raw`\b(paint|sketch|illustrate)\b(?! (a |an |the |my )?(chart|graph|diagram|map|plan|ui|page|screen|wall|room|house|fence))` +
    String.raw`|\b${ASK_FOR}(picture|image|photo|photograph|portrait|painting|drawing|illustration|artwork|poster|wallpaper|logo|icon)s?\b(?! (bigger|smaller|larger|darker|brighter|wider|taller))`,
);
/** A video or animation asked for. */
const VIDEO = new RegExp(String.raw`\b(animate\b|${ASK_FOR}(video|clip|animation|movie|gif)s?\b)`);
/** Spoken audio asked for: a reading, a narration, a voice note, "audio of…"; music and sound effects route here too, to be declined honestly. */
const AUDIO = new RegExp(
  String.raw`\b(read (this|that|it|the following|me|the text) (aloud|out loud|back( to me)?)|read aloud|narrat(e|ion)|voice ?(over|note|memo)|text to speech|say (this|that) in (a|an|the|your) \w+ voice` +
    String.raw`|(record|${ASK_FOR.replace("|how about", "|record|how about")}(audio|recording|song|music|jingle|sound effects?))\b)`,
);
/**
 * The screen cleared: "clear the workspace", "clear workspace", "wipe the screen", "clear everything",
 * "clear all the cards", "clear it/that" (when they mean the board). The old pattern required a
 * determiner *or* no space before the noun, so "clear workspace" never matched.
 */
/**
 * Bring back what was just cleared or removed: "undo", "put it back", "restore the cards",
 * "bring them back", "go back", "oops, undo that".
 */
const UNDO =
  /\b(undo|undelete|restore|put (it|them|that|those|everything) back|bring (it|them|that|those|everything) back|go back|oops)\b(?:[^.?!]{0,40}\b(card|cards|board|workspace|screen|window|clear|remove|that|it|them)\b)?|\b(bring|put|get)\s+(back\s+)?(the\s+)?(cards?|board|workspace|screen)\b|\brestore\s+(the\s+)?(cards?|board|workspace|screen|last)\b/i;
const CLEAR =
  /\b(clear|close|reset|wipe|blank|empty|hide|erase|get rid of|take down|remove)(?:\s+(?:out|up|down|off))?(?:\s+(?:the|that|this|my|your))?(?:\s+everything(?:\s+(?:on|from)(?:\s+the)?)?)?(?:\s+the)?\s+(?:workspace|screen|board|window|display|canvas)\b|\b(?:clear|wipe|empty|reset|erase|delete|remove|dismiss)\s+(?:all\s+)?(?:(?:of\s+)?(?:the\s+)?)?(?:cards|notes|(?:card|note)(?!\s*(?:number\s*)?\d))\b|\b(?:clear|wipe|reset|blank|empty)\s+(?:it|that|this|everything)\b|\bstart (?:over|fresh|clean) (?:on|with) the (?:workspace|screen)\b/;
/**
 * One floating card removed: "remove card 2", "delete the tiger", "get rid of card 1".
 * Broad content forms are fine on the Trinity desk; the game-table heuristic skips these entirely
 * so story talk ("get rid of the goblin") never becomes remove_card.
 */
const REMOVE_CARD =
  /\b((remove|delete|dismiss|close|drop|trash|get rid of|take (down|away|off)|throw away) (card|note)s?\s*(number\s*)?\d+|(remove|delete|dismiss|drop) (card|note)s?\b|(remove|delete|get rid of) (the\s+)?\w+)/i;
/**
 * Move a card by number or content: "move card 2 left", "move the tiger under the panda".
 * Skipped entirely while Game Master tools are offered (story "put the torch on the left").
 */
const MOVE_CARD =
  /\b((move|put|place|shift|slide|drag|bring|send) (card|note)s?\s*(number\s*)?\d+|(move|put|place|bring|send) (the\s+)?\w+.*(top|bottom|left|right|center|middle|front|back|corner|under|below|above|beside|next to)|(move|put|place) (card|note)s?\b)/i;
/**
 * The user's Chrome (only while the extension is connected — the tools are hidden otherwise). Each pattern
 * names what makes it a browser request: a site, a tab, the page, something to click or type, a look change.
 */
const BROWSER_OPEN =
  /\b(?:(?:open|go to|goto|navigate to|take me to|pull up|bring up|visit|load|launch|head to|browse to)\s+(?:up\s+)?(?:the\s+|a\s+|my\s+)?(?:[a-z][\w' .-]*?\s+)?(?:youtube|gmail|google|maps|amazon|netflix|reddit|twitter|facebook|instagram|tiktok|github|wikipedia|outlook|spotify|twitch|linkedin|ebay|walmart|target|best buy|bbc|cnn|espn|weather|chatgpt|claude|apple|whatsapp|yahoo|bing|zillow|airbnb|expedia|imdb|discord|slack|notion|figma|canva|paypal|news|calendar|drive|docs|translate|\w+ dot (?:com|org|net|io|co)|\w+\.(?:com|org|net|io|co|edu|gov|ai|app|dev|tv))\b|\b(?:search|look|find|browse|shop)(?:\s+(?:up|for|me))*\s+.+?\s+(?:on|in|at)\s+(?:youtube|google|amazon|wikipedia|reddit|github|ebay|maps|netflix|spotify|imdb|walmart|target|best buy|etsy|linkedin|tiktok|pinterest|zillow|airbnb|bing|duckduckgo|twitter|images)\b|\b(?:google|youtube|wikipedia|bing)\s+(?!tab\b)\w+|\b(?:open|make|create)\s+(?:a\s+)?(?:new|blank)\s+tab\b|\bdirections to\b|\b(?:search|look up|look for|find)\s+.+?\s+(?:online|on the web|in the browser)\b)/;
const BROWSER_TABS =
  /\b(?:(?:close|shut|kill)\s+(?:this|that|the current|the|all|the other|all the other|my)?\s*(?:\w+\s+)?tabs?\b|\b(?:next|previous|last|other)\s+tab\b|\bswitch\s+(?:tabs?|to\s+(?:the\s+)?\w+(?:\s+\w+)?\s+tab)\b|\b(?:go\s+to|jump\s+to|show)\s+(?:the\s+)?\w+(?:\s+\w+)?\s+tab\b|\bgo\s+back(?:\s+a\s+page)?$|\bgo\s+back\s+(?:a|one)\s+page\b|\bgo\s+forward\b|\b(?:reload|refresh)\s+(?:the\s+|this\s+)?(?:page|tab|site|it)?\b|\bzoom\s+(?:in|out|to|back)\b|\breset\s+(?:the\s+)?zoom\b|\b(?:what|which)\s+tabs\b|\btabs?\s+(?:are|do i have)\s+open\b|\blist\s+(?:the\s+|my\s+)?tabs\b)/;
const BROWSER_READ =
  /\b(?:(?:read|summari[sz]e|skim|go over)\s+(?:me\s+)?(?:this|the|that)\s+(?:page|article|site|website|tab|post|story)\b|\bread\s+(?:the\s+)?(?:selected|highlighted|selection)\b|\bwhat(?:'s| is| does)?\s+(?:on\s+)?(?:this|the)\s+(?:page|article|site|website|tab)\s*(?:say|about|say about)?\b|\bwhat\s+does\s+(?:this|the)\s+(?:page|article|site)\s+say\b|\bwhat\s+are\s+the\s+(?:sections|headings|links)\b|\btl;?dr\b)/;
const BROWSER_ACT =
  /\b(?:(?:click|tap|press|hit|push)\s+(?:on\s+)?(?:the\s+)?(?!enter|escape|tab\b|space|backspace)[a-z][\w' -]{1,40}?(?:\s+(?:button|link|tab|icon|menu|option))?$|\bpress\s+(?:the\s+)?(?:enter|return|escape|esc|tab|space|backspace|delete|page (?:up|down))\b|\bscroll\s+(?:up|down|to)\b|\bpage\s+(?:up|down)\b|\b(?:type|enter|write|fill in|input)\s+.+?\s+(?:in|into)\s+(?:the\s+)?.+?(?:box|field|bar|form|input)\b|\bsearch\s+(?:this|the)\s+(?:page|site)\s+for\b|\bsearch\s+for\s+.+?\s+on\s+(?:this|the)\s+(?:page|site)\b|\b(?:select|choose|pick)\s+.+?\s+(?:from|in)\s+(?:the\s+)?.+?(?:dropdown|menu|list)\b)/;
const BROWSER_MODIFY =
  /\b(?:(?:make|turn|put|switch)\s+(?:this|the|that)?\s*(?:page|site|website|tab|screen)?\s*(?:to\s+|into\s+|in\s+)?(?:dark|night|light|reader|reading)\s*(?:mode|theme|view)?\b|\b(?:dark|night|reader|reading)\s+(?:mode|view)\b|\binvert(?:\s+the)?\s+colou?rs\b|\b(?:hide|remove|get rid of|block|kill|zap|nuke|strip|dismiss)\s+(?:the\s+|all\s+|those\s+|these\s+|that\s+)?(?:ads?|adverts?|advertisements?|side ?bars?|comments?|pop-?ups?|cookie\s+\w+|banners?|header|footer|navigation|nav bar|menus?|images?|pictures?|videos?|chat (?:widget|bubble|box)|paywall|overlay|modal|newsletter\s+\w+)\b|\b(?:make\s+(?:the\s+)?(?:text|font|words|letters)\s+(?:bigger|larger|smaller|huge)|(?:bigger|larger|smaller)\s+(?:text|font))\b|\b(?:inject|run|execute)\s+(?:some\s+|this\s+|a\s+)?(?:javascript|js|script|css|code)\b|\b(?:add|insert|put)\s+(?:a\s+)?(?:banner|note|box|message|heading|button|div)\s+(?:at the|to the|on the|up)?\s*(?:top|bottom)?\s*(?:of\s+(?:this|the)\s+page)?\b|\b(?:change|set|make)\s+(?:the\s+)?(?:background|font|colou?rs?|links?|text colou?r)\s+(?:of\s+(?:this|the)\s+page\s+)?(?:to|into)?\b|\bundo\s+(?:the|those|your|that)?\s*(?:changes?|edits?|tweaks?)\b|\bput\s+(?:the\s+page|it)\s+back\b)/;
const BROWSER_SAVE =
  /\b(?:(?:save|download|keep|grab)\s+(?:me\s+)?(?:a\s+copy\s+of\s+)?(?:this|the|that)\s+(?:page|article|site|website|tab|image|picture|photo|graphic|link|file|pdf|attachment|video)\b|\b(?:save|take|grab)\s+(?:me\s+)?(?:a\s+)?screenshot\b|\bscreenshot\s+(?:this|the)\s+(?:page|tab)\b|\bsave\s+(?:this|the|it)\s+(?:as|to)\s+(?:a\s+)?(?:text|markdown|md|txt|file)\b|\bdownload\s+(?:that|it)\b)/;
const BROWSER_SHARE =
  /\b(?:(?:put|add|send|share|bring|copy|pin)\s+(?:this|the|that)\s+(?:page|article|site|website|tab|selection|selected text|highlighted text|image|picture|photo|screenshot|link)\s+(?:on|onto|to|with|into)\s+(?:the\s+)?(?:board|workspace|screen)\b|\b(?:share|put)\s+(?:this|the)\s+(?:page|article|image|picture|screenshot)\s+with\s+(?:the\s+)?(?:workspace|board|trinity)\b|\bput\s+a\s+screenshot\s+(?:of\s+(?:this|the)\s+(?:page|tab|site)\s+)?(?:on|onto)\s+(?:the\s+)?(?:board|workspace)\b)/;
/** Talk slower / faster. */
const SPEECH_RATE =
  /\b((talk|speak|speaking)\s+(a\s+bit\s+|a\s+little\s+|much\s+|way\s+)?(slow(?:er)?|fast(?:er)?|quicker)|slow\s+down|speed\s+up|(slower|faster)\s+(please|please\b)?|(normal|default)\s+(speed|pace)|speak\s+at\s+normal)/i;
/** A text sticky / note on the board (not a full page build). */
const TEXT_CARD =
  /\b((add|put|pin|stick|place|show|write)\b[^.?!]{0,40}?\b(text|note|sticky|memo|message)\b[^.?!]{0,30}?\b(on|to|in)?\s*(the\s+)?(workspace|board|screen|window)?|(add|put|pin)\b[^.?!]{0,20}?\b(to|on)\s+(the\s+)?(workspace|board)\b(?![^.?!]{0,40}\b(picture|image|photo|video|audio|app|page|chart)\b))/i;
/**
 * Information to lay out as a card: a recipe, the news, who someone is, what something is, how to do
 * something, a comparison, a plan, a ranking… ("give me a blueberry muffin recipe", "what's in the news",
 * "who was Marie Curie", "compare the iPhone and the Pixel") — not a question about the assistant or the user.
 */
const CARD_INFO =
  /\b(recipes?|ingredients|the news|today'?s news|headlines?|what('s| is) (happening|going on)|who (is|was|were) (?!you\b|i\b|we\b|this\b|that\b|it\b|my\b|your\b)|tell me (about|more about) (?!it\b|that\b|yourself|you\b|my\b|your\b)|facts about|information (on|about)|what('s| is| are) (a|an|the) (?!workspace|screen|board|window|time|date)|what('s| is| are) (?!the\b|a\b|an\b|it\b|that\b|this\b|your\b|my\b|our\b|up\b|on\b|in\b|for\b|wrong\b|new\b|going\b|happening\b|next\b|left\b|\d)[a-z][a-z'-]+(?: [a-z'-]+){0,3}\s*\??$|what does \w+ mean|explain (?!that again|yourself)|how (do|to|can|should) (i|you|we|one) (make|cook|bake|build|fix|install|set up|get|grow|clean|write|change)|compare|versus|\bvs\.?|difference between|which is better|top (\d+|ten|five|three)|best \d+|itinerary|workout (plan|routine)|meal plan|the weather|weather (in|for|today|tomorrow|this week)|forecast|what('s| is) the score|standings|who won|flights? (to|from|for|between)|fly(ing)? (to|from|out of)|airfares?|plane tickets?|hotels? (in|near|for|around|at)|places? to stay|where (can|should) (i|we) stay|(cheapest|best|lowest) (price|prices|deal|deals|place to buy)|compare prices|price check|where can (i|we) (buy|get|find|order)|shop(ping)? for|deals? on|how much (does|do|would) \w+( \w+){0,6} cost|plan (a|my|our) (trip|vacation|holiday)|trip to (?=[a-z])|(\d+|two|three|four|five) days? in (?=[a-z])|what to do in)\b/;
/** The screen asked about: "what's on the screen?", "what does the workspace show right now?". */
const DESCRIBE = /\b(what('s| is|s)|what do(es)? (the|my) (workspace|screen|board|window) (show|have|display))\b[^.?!]{0,20}?\b(on|in) (the|my) (workspace|screen|board|window)\b|\bwhat do(es)? (the|my) (workspace|screen|board|window) (show|have|display)\b/;
/**
 * HTML / layout tweak of something already on the board: "make the picture smaller", "resize card 1",
 * "change the svg fill", "tweak the canvas", "make the timer font bigger".
 */
const EDIT_HTML =
  /\b(make|resize|scale|shrink|enlarge|tweak|adjust|edit|change|update)\b[^.?!]{0,50}\b(smaller|bigger|larger|tinier|wider|narrower|taller|shorter|half|percent|%|size)\b|\b(smaller|bigger|larger|tinier)\b[^.?!]{0,30}\b(picture|image|photo|card|timer|widget|video|svg|canvas)\b|\b(edit|tweak|adjust|change)\b[^.?!]{0,40}\b(html|svg|canvas|css|style|markup|element)s?\b|\b(make|set)\b[^.?!]{0,40}\b(img|image|picture|video|svg|canvas)\b[^.?!]{0,30}\b(width|height|size)\b/i;
const EVERY = String.raw`every (day|morning|evening|night|week|hour)\b`;

/** A time said after "remember to …": then it's a reminder to set ("remember to call mom at 5pm"), not a fact to keep. */
const WHEN =
  String.raw`(today|tonight|tomorrow|later|(this|next) (morning|afternoon|evening|week|weekend|month)|in the (morning|afternoon|evening)` +
  String.raw`|${EVERY}|(mon|tues|wednes|thurs|fri|satur|sun)day` +
  String.raw`|(at|by) (\d+(:\d\d)?( ?[ap]\.?m)?|noon|midnight|night|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)` +
  String.raw`|\d+(:\d\d)? ?[ap]\.?m|in (a few |half an |\w+ )(minutes?|hours?|days?|weeks?))`;

/** A page or a part of one: "create a reminder app" or "make a note taking app" is a build, "add a reminder button" an edit. */
const PAGE_PART = String.raw`(app|page|tool|widget|list|board|section|system|dashboard|screen|feature|button|option|field|tracker|timer|ui|view|card|panel|manager|calendar|form|pad|book|keeper)s?\b`;

/** "Remember to …" said to the assistant, not "I remember to …" or "I'll remember to …" (what the user does). */
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
  // While a game runs (its tools are offered), the user's words are about the story: a question about a
  // hero's sheet is game_answer and what "I" or "we" do is game_narrate.
  const inGame = has("game_narrate") || has("game_answer");
  // Any Game Master table tool in the offer set — board move/remove heuristics must not steal story verbs.
  const atGameTable =
    has("game_new") || has("game_begin") || has("game_add_player") || has("game_narrate") || has("game_configure");
  // Begin before new: "let's start the adventure" during setup is game_begin, not a fresh game_new.
  if (has("game_begin") && /\b(let'?s (begin|start)|ready to (begin|play)|start the adventure|that'?s everyone|we'?re ready)\b/.test(t))
    return pick("game_begin", 0.85);
  if (has("game_new") && /\b(start|begin|run|set up|play)\b.*\b(game|campaign|adventure|one.?shot)\b/.test(t)) return pick("game_new", 0.85);
  // ("What's my character's armor class?" asks about the sheet; "What's my character going to be? An elf…" makes one.)
  if (has("game_answer") && /\b(what('s| is| are)|how (much|many))\b/.test(t) && /\b(my character's|hp|hit points|armou?r|ac|gear|inventory|gold|stats?)\b/.test(t))
    return pick("game_answer", 0.85);
  if (has("game_add_player") && /\b(my character|i('| a)m playing|i'll play|playing (a|an)|add (a )?(player|hero|character))\b/.test(t))
    return pick("game_add_player", 0.85);
  if (has("game_configure") && /\b(genre|setting|tone|campaign|fantasy|sci-?fi|horror|pirate|space|cyberpunk)\b/.test(t))
    return pick("game_configure", 0.8);
  if (has("game_roll") && /\broll\b/.test(t)) return pick("game_roll", 0.85);
  if (has("game_narrate") && !ONLINE.test(t) && /^((ok(ay)?|so|and|then|now|alright)\b[\s,]*)*(i|we)('(ll|m|re|ve|d))?\s+\w/.test(t))
    return pick("game_narrate", 0.85);
  // Memory, reminders, search and builds share verbs ("remind me to look it up", "build a tracker
  // for every day"): route by the intent the user leads with — the pattern that matches earliest
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
  // A picture, clip or audio asked for by name beats the generic build verbs ("make me a picture of…"), and
  // clearing the screen is its own request. At the game table, skip card move/remove/edit heuristics so
  // story verbs never become board ops (those tools are also hidden while a game is active).
  // The user's Chrome, while the extension is connected (the tools are hidden otherwise, so these never fire
  // without it). A look change on the live site ("hide the ads") beats remove_card; a page share beats make_text.
  if (at("browser_share", BROWSER_SHARE) < Infinity) return pick("browser_share", 0.85);
  if (at("browser_modify", BROWSER_MODIFY) < Infinity && !IMAGE.test(t) && !VIDEO.test(t)) return pick("browser_modify", 0.82);
  if (at("browser_tabs", BROWSER_TABS) < Infinity) return pick("browser_tabs", 0.85);
  if (at("browser_save", BROWSER_SAVE) < Infinity && !IMAGE.test(t)) return pick("browser_save", 0.82);
  if (at("browser_read", BROWSER_READ) < Infinity) return pick("browser_read", 0.82);
  if (at("browser_open", BROWSER_OPEN) < Infinity && !IMAGE.test(t) && !VIDEO.test(t)) return pick("browser_open", 0.85);
  if (at("browser_act", BROWSER_ACT) < Infinity) return pick("browser_act", 0.8);
  // Undo before clear: "put the cards back" must not wipe the board again.
  if (at("undo_workspace", UNDO) < Infinity) return pick("undo_workspace", 0.9);
  if (at("clear_workspace", CLEAR) < Infinity) return pick("clear_workspace", 0.8);
  if (at("describe_workspace", DESCRIBE) < Infinity) return pick("describe_workspace", 0.8);
  if (at("set_speech_rate", SPEECH_RATE) < Infinity) return pick("set_speech_rate", 0.88);
  if (!atGameTable) {
    const removeAt = at("remove_card", REMOVE_CARD);
    const moveAt = at("move_card", MOVE_CARD);
    if (removeAt < Infinity && removeAt <= moveAt) return pick("remove_card", 0.85);
    if (moveAt < Infinity) return pick("move_card", 0.85);
    // Size / HTML tweaks of existing cards beat "make a picture" / "build a …" verbs.
    const editHtmlAt = at("edit_html", EDIT_HTML);
    if (editHtmlAt < Infinity) return pick("edit_html", 0.88);
  }
  // Information asked for by kind (a recipe, the news, who someone is…) is a content card — before the generic
  // "give me / show me / put … on the board" verbs that would read as a picture, a note, a search or a build.
  if (at("show_card", CARD_INFO) < Infinity && !IMAGE.test(t) && !VIDEO.test(t)) return pick("show_card", 0.82);
  const imageAt = at("make_image", IMAGE);
  const videoAt = at("make_video", VIDEO);
  const audioAt = at("make_audio", AUDIO);
  const textAt = at("make_text", TEXT_CARD);
  const mediaAt = Math.min(imageAt, videoAt, audioAt, textAt);
  const screenAt = Math.min(buildAt, mediaAt);
  if (searchAt < Math.min(memoryAt, skillAt, screenAt)) return pick("web_search", 0.8);
  if (memoryAt < Infinity && memoryAt <= Math.min(skillAt, screenAt)) {
    if (memoryAt === recallAt) return pick("recall", 0.7);
    if (memoryAt === scheduleAt) return pick("schedule", 0.7); // "remember to call mom at 5" starts both
    return pick("remember", 0.7);
  }
  if (skillAt < Infinity) return pick("create_skill", 0.7);
  if (mediaAt < Infinity) {
    if (mediaAt === imageAt) return pick("make_image");
    if (mediaAt === videoAt) return pick("make_video");
    if (mediaAt === audioAt) return pick("make_audio");
    return pick("make_text");
  }
  if (buildAt < Infinity) return pick("build_ui");
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  for (const tool of tools) {
    if (inGame && tool.name === "web_search") continue; // "search the chest": no web words, no web search
    if (/^(make_image|make_video|make_audio|make_text|show_card|clear_workspace|undo_workspace|describe_workspace|remove_card|move_card|edit_html|set_speech_rate)$/.test(tool.name))
      continue; // a video or picture mentioned isn't one asked for
    if (tool.name.split(/[_\s]+/).some((tok) => tok.length > 3 && words.has(tok))) return pick(tool.name, 0.7);
  }
  return pick("NONE", 0.6);
}
