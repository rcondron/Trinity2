import { getEndpoints, live } from "../settings.js";
import { getTools } from "../tools/registry.js";
import type { Persona, Tool, ToolArgSpec } from "../types.js";
import { looksLikeAsk, secondOpinion } from "./arbiter.js";
import { EVERYDAY_TOOL_WORDS, voiceIntent } from "../tools/intents.js";
import { ASSIST_TOOLS, assistRoute } from "../services/assist/routes.js";
import { yesOrNo } from "./pending.js";
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
  // (A game's digest runs to about 1,500 characters, the most important first; the board's summary is shorter.)
  return `Situation: ${ctx.summary.slice(0, 1600)}\n\n${conversation}`;
}

/** Tie-breakers for tools whose labels overlap — only when both are offered. */
function toolRules(tools: Tool[]): string[] {
  const has = (name: string) => tools.some((t) => t.name === name);
  const rules: string[] = [];
  if (has("figure_out"))
    rules.push(
      "Something the user asks for that no listed tool does directly — several steps in a row, a site or service with no tool yet, 'figure out how to…', 'find a way to…' — is figure_out, not NONE; a direct match to another tool is still that tool.",
    );
  if (has("build_ui") && has("create_skill"))
    rules.push(
      "Something to see or use on screen (a page, app, chart, game or form) is build_ui; a new ability the assistant should keep using later (a converter, a lookup, a connection to a web service) is create_skill.",
    );
  if (has("build_ui") && has("make_image"))
    rules.push(
      has("show_chart")
        ? "A picture, image, photo, illustration, painting or artwork of something is make_image, even when the user says 'draw' or 'make'; a diagram, page or app is build_ui."
        : "A picture, image, photo, illustration, painting or artwork of something is make_image, even when the user says 'draw' or 'make'; a chart, diagram, page or app is build_ui.",
    );
  if (has("show_chart") && has("build_ui"))
    rules.push(
      "Numbers to see as a chart or graph (given by the user, just found, in a table card or a file) are show_chart, and rows and columns to see are show_table; an interactive chart app, dashboard or tool to use is build_ui.",
    );
  if (has("retry_card"))
    rules.push("'Try again', 'retry', 'have another go' about a card that failed or was interrupted is retry_card.");
  if (has("build_ui") && has("clear_workspace"))
    rules.push("Clearing, closing, resetting or blanking the screen or workspace is clear_workspace; changing what's on it is build_ui.");
  if (has("undo_workspace"))
    rules.push(
      "Bringing back cards or a screen that was just cleared or removed (undo, put it back, restore, go back, oops) is undo_workspace — not clear_workspace and not building something new.",
    );
  if (has("edit_html") && has("build_ui"))
    rules.push(
      "Tweaking what's inside a card already on the board (a picture's width percentage, img/svg/canvas/widget HTML or styles) is edit_html; creating a new interactive widget or rebuilding one from scratch is build_ui.",
    );
  if (has("edit_html") && has("make_image"))
    rules.push(
      "Restyling an existing picture's markup on the board is edit_html; generating a brand-new picture is make_image.",
    );
  if (has("control_card"))
    rules.push(
      "Playing, pausing, stopping, starting, resuming, restarting, resetting, muting, turning up or down, skipping, looping, or pressing a button on something ALREADY on the board — a timer, stopwatch, video, audio clip, slideshow or game card — is control_card ('start the timer', 'pause the video', 'restart it', 'mute card 5', 'press lap', 'set the timer to ten minutes', 'stop everything'), never build_ui, make_video, make_audio or edit_html. Asking for a NEW timer or clip ('start a five minute timer', 'make a video of…') is still build_ui / make_video.",
    );
  if (has("read_card"))
    rules.push(
      "Asking what a card on the board says or shows right now — 'read card 2', 'what does the note say', 'how much time is left on the timer', 'what's the score', 'what are the ingredients on the recipe card', 'is the video playing' — is read_card, not show_card, ask_brain, web_search or describe_workspace (which lists the whole board).",
    );
  if (has("edit_note"))
    rules.push(
      "Changing the words of a note already on the board — 'add eggs to the shopping list', 'cross off milk', 'change the note to say…', 'clear the to-do list' — is edit_note, not make_text (a new note), clear_workspace or edit_html.",
    );
  if (has("rename_card") || has("duplicate_card"))
    rules.push("Giving a card a new name or title is rename_card; copying or duplicating a card is duplicate_card.");
  if (has("figure_out") && has("remove_card"))
    rules.push(
      "Two or more DIFFERENT board actions in one request ('close the pictures and start the timer', 'minimize everything except the video and play it') is figure_out; one action on several cards ('close cards 2 and 3') is that action's tool.",
    );
  if (has("resize_card"))
    rules.push(
      "A card's own size — bigger, smaller, maximize / full screen, minimize, wider, taller, restore / back to normal — is resize_card, for one card or several ('make the tiger bigger', 'minimize all the cards', 'minimize everything except the timer', 'restore them'); 'restore card 2' while card 2 is still on the board is resize_card, and undo_workspace is only for bringing back what was removed or cleared; only a picture's width percentage or its markup is edit_html.",
    );
  if (has("remove_card") || has("move_card") || has("undo_workspace") || has("arrange_cards"))
    rules.push(
      "Floating cards on the board are numbered and tagged by content: removing one or several is remove_card ('cards 2 and 3', 'all the pictures', 'the last two', and anything with except / but / keep — 'close everything except the timer'), moving one is move_card (by number or by what it shows — 'the tiger', 'under the panda', a step — 'a bit to the left', 'move it up', swapping two, or lining a group up along one side — 'put the pictures on the left'), organizing / tidying / sorting / lining up / stacking / shuffling / scattering / grouping all the cards (a grid, a stack, a row, a column, a shuffle, by kind) is arrange_cards, layering one card in front of / behind / on top of another, or one layer forward or backward, is move_card ('put the cards back' / 'bring them back' after a clear or remove is undo_workspace, not a move), wiping every card / the whole screen is clear_workspace, and restoring a mistaken clear or remove is undo_workspace. A text sticky/note is make_text; asking for several pictures (a panda and a tiger) is still make_image (one card each).",
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
      rules.push(
        has("show_chart")
          ? "Information to read (a recipe, a profile, a guide, the news) is show_card; an interactive tool, app, game or form to use is build_ui."
          : "Information to read (a recipe, a profile, a guide, the news) is show_card; an interactive tool, app, game, chart or form to use is build_ui.",
      );
    if (has("make_image")) rules.push("A picture alone is make_image; information about something is show_card (it adds its own picture).");
    if (has("make_text"))
      rules.push("A note in the user's own words is make_text; researched or written-up information — even 'put the muffin recipe on the board' — is show_card.");
    rules.push(
      "Something to buy or compare prices on, flights, hotels, or a trip plan is show_card too (its type option says which: shopping, flights, hotels, itinerary) — it runs a live search and lays the results out with prices; never web_search or ask_brain for those.",
    );
  }
  if (has("set_speech_rate"))
    rules.push(
      `Asking Trinity to talk slower, faster, or at normal speed is set_speech_rate — not small talk.${has("control_card") ? " Playing a video or audio card faster or slower ('play it faster', 'speed up the video', 'slow the song down') is control_card: set_speech_rate is only how Trinity herself talks." : ""}`,
    );
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
const HEURISTIC_OVERRIDE = /^(answer_question|answer_followup|send_email|save_meeting|browser_sign_in|browser_fill_card|browser_fill_details|vault_save_login|vault_save_card|vault_save_details|vault_list|vault_forget|get_time|clear_workspace|undo_workspace|remove_card|move_card|arrange_cards|resize_card|control_card|read_card|edit_note|rename_card|duplicate_card|describe_workspace|edit_html|set_speech_rate)$/;

export async function decide(input: RouteInput): Promise<Decision> {
  const started = Date.now();
  const ctx = contextFor(input.persona);
  const prepared = prepare(input.persona, visibleTools(input.persona, hiddenFor(input, ctx)));
  const first = await firstDecision(input, ctx, prepared, started);
  // A finished sentence the first pass was unsure about (a real tool under the gate) or waved off although it asks
  // for something: the fast model takes a second look at the same tools (agent/arbiter.ts). Never mid-sentence.
  const min = getEndpoints().minConfidence;
  const finished = /\(finished speaking\)/.test(input.conversation);
  const unsure = first.action !== "NONE" && first.tool !== null && first.confidence < min && first.confidence >= 0.3;
  const waved = first.action === "NONE" && looksLikeAsk(latestWords(input.conversation));
  if (finished && (unsure || waved)) {
    const second = await secondOpinion(input, prepared.tools, first, min);
    // (Its pick stands on its own: carrying Jev's error along would make firing() skip it — the fallback would be mute.)
    if (second) return { ...second, ms: Date.now() - started };
  }
  return first;
}

/** Jev's pick reconciled with the keyword heuristic — or the heuristic alone without a TypeSafe key. */
async function firstDecision(input: RouteInput, ctx: AgentContext, prepared: Prepared, started: number): Promise<Decision> {
  if (!live.jev) return heuristic(input, prepared.tools, started);

  const ep = getEndpoints();
  let jev: Decision;
  try {
    const res = await fetch(`${ep.typesafeUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.typesafeKey}` },
      body: JSON.stringify(buildJevBody(input, prepared, ctx)),
      // Jev answers in a fraction of a second; one that hasn't in a few is treated as down, and the fallbacks decide.
      signal: AbortSignal.timeout(3500),
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
    console.warn("[router] Jev failed; the keyword rules decide:", (err as Error).message);
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
        return { ...h, ms: Date.now() - started };
      }
    }
    // Jev itself failed (not: answered "no tool"): the keyword rules stand in for it, game tools included, so setup
    // and play still move. When Jev answered NONE it has judged the words — table talk ("I'll be right back", "pause
    // the game") must not be turned into a game action by a keyword.
    if (jev.error && h.action !== "NONE" && h.tool && h.confidence >= 0.7) return { ...h, ms: Date.now() - started };
  }
  // A password or a card is the vault's, whatever else the words sound like: "remember my Netflix password" must
  // never become a memory. (Only while the vault's tools are on offer; the rule finds nothing otherwise.)
  if (jev.action === "remember") {
    const h = heuristic(input, prepared.tools, started);
    if (h.tool && /^vault_save_(login|card)$/.test(h.action)) return { ...h, ms: Date.now() - started };
  }
  return jev;
}

// ─── Heuristic fallback (no Jev key) ─────────────────────────────────────────

/** The request is negated: "don't clear the screen", "never mind closing them", "do not remove it". */
const NOT_THAT = /\b(?:don'?t|do not|never|not|no need to|stop)\b[^.?!]{0,24}\b(?:clear|wipe|erase|empty|blank|reset|delet|remov|clos)/;
/** The clock or the calendar asked for: "what time is it", "what's the date today", "what day is it". */
const CLOCK = /\bwhat(?:'s| is)? (?:the )?(?:time|date|day)\b|\bwhat time\b|\b(?:today'?s|the current) (?:date|time)\b|\bwhat day (?:is|of)\b/;
/** Tool names whose words are everyday ones: a mention is not a request. */
const EVERYDAY = new Set(
  "about after again answer arrange audio back begin board brain browser build call card cards clear close content control create date describe duplicate edit figure file find from game give good have help home image know last like list long look make media memory modify more most move music name need never next note notes open other page play player print question rate read recall remember remove rename resize roll save schedule screen search send share show skill some speech start state stop story table tabs take tell text that their there these thing think this those time turn undo video voice want week what when where which while with work workspace would write year your document documents spreadsheet spreadsheets files".split(
    " ",
  ),
);

// (The memory, reminder and skill tools are named with everyday words; tools/intents.ts reads a request for them.)
for (const word of EVERYDAY_TOOL_WORDS) EVERYDAY.add(word);

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
/**
 * Lay every card out in a neat grid: "organize the cards", "tidy up the board", "put the cards in a grid", "sort the
 * cards", "line them up". Checked before undo, whose "put the cards …" would otherwise take "put the cards in order".
 */
const ARRANGE =
  /\b(?:(?:shuffle|scatter|jumble|randomi[sz]e|mix up)\b(?:\s+(?:up\s+)?(?:all\s+)?(?:the\s+|my\s+)?(?:cards|board|them|everything))?|group\s+(?:the\s+)?(?:cards|them|everything)\s+by\b|(?:organi[sz]e|tidy(?: up)?|arrange|re-?arrange|line up|straighten(?: up)?|clean up|neaten(?: up)?|sort|align|order)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+|these\s+|those\s+)?(?:cards?|board|workspace|screen|notes?|pictures?|images?|everything|them)\b|\b(?:stack|cascade|pile up|pile)\s+(?:up\s+)?(?:all\s+)?(?:of\s+)?(?:the\s+|these\s+|those\s+|my\s+)?(?:cards|everything|them)\b|\b(?:put|lay|set|get|line)\s+(?:all\s+)?(?:of\s+)?(?:the\s+|these\s+|those\s+|my\s+)?(?:cards|everything|them)\s+(?:up\s+)?(?:in|into|on)\s+(?:a\s+|an\s+|one\s+)?(?:neat\s+|tidy\s+|nice\s+|single\s+)?(?:grid|order|rows?|line|place|stack|cascade|column)\b|\b(?:grid|numerical order)\b[^.?!]{0,30}\bcards?\b|\bcards?\b[^.?!]{0,30}\b(?:in a grid|in numerical order|in order|lined up|tidied up|organi[sz]ed|arranged)\b|\btidy up\b|\bstraighten up\b)/;
const UNDO =
  /\b(undo|undelete|restore|put (it|them|that|those|everything) back|bring (it|them|that|those|everything) back|go back|oops)\b(?:[^.?!]{0,40}\b(card|cards|board|workspace|screen|window|clear|remove|that|it|them)\b)?|\b(bring|put|get)\s+back\s+(the\s+)?(cards?|board|workspace|screen)\b|\b(bring|put|get)\s+(the\s+)?(cards?|board|workspace|screen)\s+back\b|\brestore\s+(the\s+)?(cards?|board|workspace|screen|last)\b/i;
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
  /\b((move|put|place|shift|slide|drag|bring|send|layer) (card|note)s?\s*(number\s*)?\d+|(move|put|place|bring|send|layer) (the\s+)?\w+.*(top|bottom|left|right|center|middle|front|back|forward|backward|behind|corner|under|below|above|beside|next to|up|down|higher|lower)|(move|put|place) (card|note)s?\b|\bswap\b|\bswitch\s+(?:card\s*\d+|the\s+\w+)\s+(?:and|with)\s+|\bnudge\b)/i;
/**
 * A card's own size: "maximize card 2", "make the tiger bigger", "minimize the timer", "restore it", "a little
 * smaller", "wider". Not a picture's width percentage or anything inside the card (edit_html keeps those).
 */
const RESIZE_CARD =
  /\b(?:maximi[sz]e|minimi[sz]e|full ?screen|fullscreen|fill (?:up )?the (?:whole |entire )?(?:screen|board|workspace|window)|as big as (?:it (?:can|will) go|possible)|un-?maximi[sz]e|un-?minimi[sz]e|normal size|regular size|usual size|default size|back to (?:normal|its (?:old |usual |normal )?size|the way it was)|(?:restore|expand|collapse)\s+(?:the\s+)?(?:card\s*(?:number\s*)?\d+|it|that|this|that card|this card|\w+ card)\b|(?:make|resize|scale|shrink|enlarge|grow|blow up|zoom)\b[^.?!]{0,40}\b(?:bigger|larger|smaller|tinier|huge|tiny|double|half|twice|wider|narrower|taller|shorter|in on|into)\b|\b(?:bigger|larger|smaller|tinier|wider|narrower|taller|shorter)\b|\b(?:enlarge|shrink)\b)/i;
/**
 * Operating something on the board: "start the timer", "pause the video", "restart it", "mute card 5", "press lap on
 * the stopwatch", "set the timer to ten minutes", "stop everything". Not "start a timer for five minutes" (a new one).
 */
const CONTROL_CARD = new RegExp(
  String.raw`\b(?:(?:start|stop|pause|resume|restart|reset|unpause|play|replay|mute|unmute|rewind|loop)\s+(?:it|that|this|everything|all(?:\s+(?:of\s+)?the\s+\w+)?|(?:the|my|that|this|both)\s+(?:\w+\s+)?(?:timers?|stopwatch(?:es)?|countdown|clock|videos?|clips?|movies?|audio|songs?|music|recordings?|sounds?|slideshow|game|animation)|card\s*\d+)(?:\s+(?:over|again))?\b)` +
    String.raw`|\b(?:turn (?:it|that|the (?:video|audio|sound|volume|music)) (?:up|down)|skip (?:ahead|forward|back)|fast[- ]?forward|next slide|previous slide|play (?:it|that) (?:again|faster|slower)|(?:press|hit|click|tap)\s+(?:the\s+)?[\w+ -]{1,24}?\s+(?:button\s+)?on\s+(?:the\s+|card\s*\d)|set the (?:timer|countdown|clock) (?:to|for)\b(?!\s+(?:a|an)\s))`,
);
/** "read card 2", "what does the note say", "how much time is left on the timer", "what's the score". */
const READ_CARD =
  /\b(?:read (?:me |out |aloud )?(?:card\s*\d+|the (?:note|card|list|recipe|timer|score|\w+ (?:card|note|list))|it|that|what (?:it|card \d+) says)|what(?:'s| is| does) (?:on )?card\s*\d+(?: say| show)?|what does (?:the )?(?:note|card\s*\d+|timer|list|\w+ (?:card|note|list)) say|how much time (?:is |'s )?left|how long (?:is )?left on|what(?:'s| is) the (?:score|time on the timer)|is the (?:video|audio|music|timer) (?:playing|running|paused))\b/;
/** Changing a note's words: "add eggs to the shopping list", "cross off milk", "change the note to say…", "clear the note". */
const EDIT_NOTE =
  /\b(?:(?:add|put|append|jot down)\s+.+?\s+(?:to|on|onto)\s+(?:the|my)\s+(?:[\w-]+\s+)?(?:note|list|sticky)|(?:cross|check|tick|mark) off\b|remove .+? from (?:the|my) (?:[\w-]+ )?(?:note|list)|change the (?:[\w-]+ )?note\b|clear (?:the|my) (?:[\w-]+ )?(?:note|list))\b/;
const RENAME_CARD = /\b(?:rename|retitle|relabel)\b|\b(?:call|name|title)\s+(?:card\s*\d+|it|this|that)\s+\w+/;
const DUPLICATE_CARD = /\b(?:duplicate|clone)\b|\b(?:make|add)\s+(?:a\s+|another\s+)?cop(?:y|ies)\s+of\b|\bcopy\s+(?:card\s*\d+|the\s+\w+|it|that)\b/;
/** Several cards at once, or all but some: "close cards 2 and 3", "delete all the pictures", "close everything except the timer". */
const REMOVE_SOME =
  /\b(?:close|remove|delete|dismiss|get rid of|trash|clear)\s+(?:(?:all|both)\s+)?(?:of\s+)?(?:the\s+)?(?:cards?\s+\d+(?:\s*(?:,|and|through|to)\s*\d+)+|(?:pictures|images|photos|videos|clips|notes|widgets|recordings|other cards|others|rest)\b|everything\s+(?:except|but)\b|all(?:\s+the\s+cards)?\s+(?:except|but)\b|the\s+(?:last|first|newest|oldest)\s+(?:\d+\s+)?cards?\b)|\bkeep\s+.+?\s+and\s+(?:close|remove|delete|get rid of)\s+(?:the rest|everything else|the others)\b/;

/** What keeps a size request with edit_html: a percentage, or something inside the card. */
const INSIDE_CARD = /\b(?:\d{1,3}\s*(?:%|percent)|inside|within|html|svg|css|style|markup|element|background|font|colou?r|border)\b/i;
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
  /\b(make|resize|scale|shrink|enlarge|tweak|adjust|edit|change|update)\b[^.?!]{0,50}\b(smaller|bigger|larger|tinier|wider|narrower|taller|shorter|half|percent|%|size)\b|\b(smaller|bigger|larger|tinier)\b[^.?!]{0,30}\b(picture|image|photo|card|timer|widget|video|svg|canvas)\b|\b(edit|tweak|adjust|change)\b[^.?!]{0,40}\b(html|svg|canvas|css|style|markup|element|background|colou?r|font|border)s?\b|\b(make|set)\b[^.?!]{0,40}\b(img|image|picture|video|svg|canvas)\b[^.?!]{0,30}\b(width|height|size)\b/i;
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
// The vault (tools/vault.ts), in the words people use. A board card is also a "card": the payment kind is named as one
// ("credit card", "my Visa", "card number") or by "the vault".
const VAULT_KEEP = String.raw`(save|store|remember|keep|add|hold on to|take down|put)\s+(down\s+)?(my|the|this|that|our|a|an|another|his|her|their)\b`;
/** …not a field of a page being built ("add a password field", "a credit card form"). */
const NOT_A_FIELD = String.raw`(?!\s+(field|input|box|form|prompt|page|screen|button|widget|generator|checker|strength|manager|reset|policy|rules?|validation)\b)`;
const VAULT_LOGIN = new RegExp(
  String.raw`\b${VAULT_KEEP}[^.?!]{0,30}\b(log-?ins?|passwords?|pass ?codes?|credentials|sign-?in details)\b${NOT_A_FIELD}|\bi'?ll give you (my|the|a) (log-?in|password|credentials)\b`,
);
const PAY_CARD = String.raw`((credit|debit|bank|payment) cards?|card (number|details|info(rmation)?)|(visa|mastercard|amex|american express|discover)( card)?)`;
const VAULT_CARD = new RegExp(String.raw`\b${VAULT_KEEP}[^.?!]{0,30}\b${PAY_CARD}\b${NOT_A_FIELD}`);
const VAULT_DETAILS = new RegExp(
  String.raw`\b(save|store|add|keep)\b[^.?!]{0,30}\bmy ((home|shipping|billing|mailing|delivery|street) )?(address|contact (details|info(rmation)?)|(shipping|billing|personal) (details|info(rmation)?)|phone number)\b${NOT_A_FIELD}`,
);
const VAULT_LIST = new RegExp(
  String.raw`\b(what|which|list|show( me)?)\b[^.?!]{0,30}\b(log-?ins?|passwords?|credentials|${PAY_CARD})\b[^.?!]{0,30}\b(do you have|have you got|are saved|saved|stored|on file)\b|\bwhat('s| is| do you have) in (the|your|my) vault\b|\b(what|which)\b[^.?!]{0,40}\bin (the|your|my) vault\b`,
);
const VAULT_FORGET = new RegExp(
  String.raw`\b(forget|delete|remove|erase|get rid of)\b[^.?!]{0,40}\b(log-?ins?|passwords?|credentials|saved (card|details)|${PAY_CARD})\b${NOT_A_FIELD}|\b(forget|delete|remove|erase)\b[^.?!]{0,50}\bfrom (the|your|my) vault\b`,
);

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUMBER_WORD = Object.keys(NUMBER_WORDS).join("|");
/** "card two", "cards two and three" as "card 2", "cards 2 and 3": the rules below match digits. */
function cardDigits(text: string): string {
  let s = text.replace(new RegExp(String.raw`\b((?:cards?|notes?|number)\s+)(${NUMBER_WORD})\b`, "g"), (_m, lead: string, w: string) => `${lead}${NUMBER_WORDS[w]}`);
  const more = new RegExp(String.raw`(\d\s*(?:,|and|through|to)\s*)(${NUMBER_WORD})\b`);
  for (let i = 0; i < 12 && more.test(s); i++) s = s.replace(more, (_m, lead: string, w: string) => `${lead}${NUMBER_WORDS[w]}`);
  return s;
}

// Signing in and filling from the vault (tools/browser-fill.ts), while the extension is connected. "Click the sign in
// button" is a click; "sign me in" is this.
const LEAD = String.raw`^(?:(?:ok(?:ay)?|hey|so|now|and|then|please|trinity|can you|could you|would you|go ahead and)[,.!]?\s+)*`;
const BROWSER_SIGN_IN = new RegExp(
  String.raw`\b(?:sign|log)\s+me\s+(?:in|into|on)\b|${LEAD}(?:sign|log)\s+(?:in|into)\b|\buse\s+my\s+saved\s+(?:password|log-?in|credentials)\b|\b(?:fill|put|type)\s+in\s+my\s+(?:password|log-?in|credentials|user ?name)\b`,
);
const BROWSER_FILL_CARD = new RegExp(
  String.raw`\b(?:fill\s+(?:in|out)|enter|put\s+in|type\s+in|use)\s+my\s+(?:(?:credit|debit|payment|bank)\s+)?card\b|\bpay\s+with\s+my\s+(?:card|visa|mastercard|amex|american express|(?:credit|debit)\s+card)\b|\bfill\s+(?:in|out)\s+(?:the\s+)?(?:card|payment)\s+(?:details|info(?:rmation)?|form|fields?)\b`,
);
const BROWSER_FILL_DETAILS = new RegExp(
  String.raw`\bfill\s+(?:in|out)\s+my\s+(?:details|address|info(?:rmation)?|name|contact\s+(?:details|info(?:rmation)?)|shipping\s+\w+|billing\s+\w+)\b|\bfill\s+(?:in|out)\s+(?:this|the)\s+form\b[^.?!]{0,20}\bmy\s+(?:details|info(?:rmation)?|address)\b|\b(?:enter|put\s+in|type\s+in|use)\s+my\s+(?:(?:shipping|billing|home|mailing)\s+)?(?:address|details|contact\s+(?:details|info(?:rmation)?))\b`,
);
/** Tab and window commands beyond BROWSER_TABS: pin, mute, duplicate, move, group, reopen; a new, closed or minimized window. */
const BROWSER_TABS_MORE =
  /\b(?:pin|unpin|mute|unmute|duplicate)\s+(?:this|that|the|the current|my)?\s*(?:\w+\s+)?tabs?\b|\bmove\s+(?:this|that|the)\s+(?:\w+\s+)?tab\b|\b(?:group|ungroup)\s+(?:these|those|the|my|all|all the)?\s*(?:\w+\s+)?tabs\b|\breopen\s+(?:the\s+|that\s+|my\s+)?(?:last\s+|closed\s+)*tabs?\b|\b(?:open|start|make)\s+(?:a\s+|another\s+)(?:new\s+)?(?:\w+\s+)?window\b|\bnew\s+(?:browser\s+|incognito\s+|private\s+)?window\b|\b(?:close|minimi[sz]e|maximi[sz]e|restore)\s+(?:this|that|the)\s+(?:browser\s+)?window\b/;

// The Game Master's table commands (game/play-tools.ts), for when Jev is down or there is no key.
const GAME_PAUSE =
  /\b(?:pause|unpause|resume)\s+(?:the\s+|our\s+)?(?:game|session|play|adventure)\b|\b(?:let'?s\s+)?take\s+(?:a\s+)?(?:short\s+|quick\s+|little\s+)?break\b|\bwe'?re\s+back\b|^(?:ok(?:ay)?[,\s]+)?(?:resume|unpause|pause)[.!]?$/;
const GAME_UNDO = /\b(?:undo\s+(?:that|it|the\s+last\s+(?:turn|move|roll))|take\s+(?:that|it)\s+back|scratch\s+that|that\s+was\s+a\s+mistake)\b|^(?:ok(?:ay)?[,\s]+)?undo[.!]?$/;
const GAME_NEXT_TURN =
  /\b(?:that'?s\s+(?:it\s+for\s+)?my\s+turn|end\s+(?:my|the|our)\s+turn|i'?m\s+done(?:\s+with\s+my\s+turn)?|i\s+pass|skip\s+my\s+turn|i\s+(?:delay|hold\s+my\s+action)|next\s+(?:turn|player|person|one))\b|^(?:ok(?:ay)?[,\s]+)?next[.!]?$/;
const GAME_START_COMBAT = /\broll\s+(?:for\s+)?initiative\b|\b(?:start|begin)\s+(?:the\s+|a\s+)?(?:combat|fight|battle|encounter)\b|\bwe\s+(?:attack|charge|ambush)\s+(?:them|the)\b/;
const GAME_END_COMBAT = /\b(?:end|stop|finish)\s+(?:the\s+)?(?:combat|fight|battle|encounter)\b|\b(?:combat|the\s+fight|the\s+battle)\s+is\s+over\b|\bthey\s+(?:surrender|flee|run\s+away)\b/;
const GAME_REST = /\b(?:take|have|make|do)\s+(?:a\s+)?(?:short|long)\s+rest\b|\b(?:short|long)\s+rest\b|\bwe\s+(?:make\s+camp|camp\s+for\s+the\s+night|rest\s+for\s+(?:an\s+hour|the\s+night))\b/;
const GAME_END_SESSION =
  /\b(?:end|wrap\s+up|finish)\s+(?:the\s+|this\s+|our\s+|tonight'?s\s+)?session\b|\blet'?s\s+(?:stop|call\s+it|wrap\s+(?:it\s+)?up)\s+(?:here|there|for\s+(?:tonight|today|now))\b|\bthat'?s\s+(?:it|all)\s+for\s+(?:tonight|today)\b/;
/** A roll is a game roll with dice words near it ("I rolled a 14", "roll for perception", "roll a d20"). */
const GAME_ROLL =
  /\b(?:i\s+rolled|roll\s+for\s+me)\b|\b(?:roll(?:ed|ing|s)?|throw)\b[^.?!]{0,30}?\b(?:d\d+|dice|die|\d+|a\s+(?:natural|nat)\b|for\b|initiative|check|save|saving\s+throw|attack|damage|perception|stealth|athletics|acrobatics|investigation|insight|persuasion|deception|intimidation|arcana|history|nature|religion|medicine|survival|sleight|animal|performance|strength|dexterity|constitution|intelligence|wisdom|charisma)\b/;
/** "I…" that is talk around the table, not something a hero does. */
const TABLE_TALK =
  /\b(?:right\s+back|brb|bathroom|restroom|snacks?|pizza|my\s+phone|gotta\s+go|have\s+to\s+go|need\s+to\s+go|be\s+back|heading\s+out|log\s+off|my\s+(?:mom|dad|wife|husband|boss|kids?)\s+(?:is|are)\s+calling)\b/;

// Saved files (tools/files.ts): each rule needs a file word, so notes, cards, pages and the vault keep their own.
/** A saved file's noun ("file", "document", "PDF", "spreadsheet"…) — never "file card" (a card on the board). */
const FILE_NOUN = String.raw`(?:files?|documents?|docs?|pdfs?|spread\s?sheets?|workbooks?|csvs?|(?:word|excel)\s+(?:docs?|documents?|files?|sheets?))\b(?!\s+cards?\b)`;
/** A name with an extension, typed or heard ("shopping.txt", "shopping dot t x t"). */
const FILE_NAME = String.raw`\b[\w'-]+(?:\.|\s+dot\s+)(?:txt|t x t|md|markdown|json|csv|html|pdf|p d f|docx|xlsx)\b`;
/** Up to a few words between the article and the noun ("the old report file", "my shopping list file"). */
const SOME = String.raw`(?:[\w'-]+\s+){0,4}?`;

const FILE_LIST = new RegExp(
  String.raw`\b(?:what|which)\s+(?:saved\s+)?(?:files|documents|docs|pdfs|spread\s?sheets)\s+(?:do|did|have)\b|\blist\s+(?:all\s+)?(?:of\s+)?(?:my|the)\s+(?:saved\s+)?(?:files|documents|docs|pdfs|spread\s?sheets)\b|\b(?:show|tell)\s+me\s+(?:all\s+)?(?:of\s+)?my\s+(?:saved\s+)?(?:files|documents)\b|\bdo\s+i\s+have\s+any\s+(?:saved\s+)?(?:files|documents|pdfs|spread\s?sheets)\b|\bis\s+there\s+a\s+(?:file|document)\s+(?:about|on|for|called|named)\b`,
);
const FILE_DELETE = new RegExp(String.raw`\b(?:delete|remove|erase|trash|get\s+rid\s+of|throw\s+away)\s+(?:all\s+)?(?:of\s+)?(?:the|that|this|those|these|my)\s+${SOME}${FILE_NOUN}|\b(?:delete|remove|trash)\s+${FILE_NAME}`);
const FILE_RENAME = new RegExp(
  String.raw`\b(?:rename|retitle)\s+(?:the|that|this|my)\s+${SOME}${FILE_NOUN}|\brename\s+${FILE_NAME}|\b(?:call|name)\s+(?:the|that|this)\s+(?:[\w'-]+\s+)?(?:file|document|pdf|spread\s?sheet)\s+\w|\bchange\s+the\s+name\s+of\s+(?:the|that|my)\s+${SOME}${FILE_NOUN}`,
);
const FILE_READ = new RegExp(
  String.raw`\bread\s+(?:me\s+|out\s+|aloud\s+)?(?:the|my|that|this)\s+${SOME}(?:file|document|doc|pdf)\b(?!s|\s+cards?\b)|\bread\s+(?:me\s+)?(?:the\s+)?file\s+(?:called|named)\b|\bread\s+(?:me\s+)?${FILE_NAME}|\bwhat(?:'s|\s+is|\s+does)\s+(?:in\s+)?(?:the|my|that)\s+${SOME}(?:file|document)\b(?!s)`,
);
const FILE_OPEN = new RegExp(
  String.raw`\b(?:open|bring\s+up|pull\s+up|show\s+me)\s+(?:up\s+)?(?:the|my|that|this)\s+${SOME}${FILE_NOUN}|\bopen\s+${FILE_NAME}|\bwhere(?:'s|\s+is)\s+(?:the|my|that)\s+${SOME}(?:file|document|pdf|spread\s?sheet)\b`,
);
const FILE_SAVE = new RegExp(
  String.raw`\bsave\s+(?:that|this|it|(?:the|that|this|my)\s+(?:[\w'-]+\s+){0,3}?(?:note|card|list|answer|text)|card\s*\d+)\s+(?:as|to|in|into)\b(?!\s+(?:soon|well|is|usual)\b)|\bsave\s+.{1,60}?\s+as\s+${FILE_NAME.slice(2)}|\b(?:make|create|start)\s+an?\s+(?:new\s+)?(?:text\s+|txt\s+)?file\s+(?:called|named)\b`,
);
const FILE_SHEET = new RegExp(
  String.raw`\b(?:in|into|as|to)\s+(?:an?\s+)?(?:excel(?:\s+(?:file|sheet|workbook|spreadsheet))?|spread\s?sheet|csv)\b(?!\s+(?:app|widget|tool|page)\b)|\b(?:make|create|build|start|give\s+me|export|put\s+together)\s+(?:me\s+)?(?:an?\s+)?(?:[\w'-]+\s+){0,3}?(?:spread\s?sheet|excel\s+(?:file|sheet|workbook)|workbook|csv)\b(?!\s+(?:app|widget|tool|page)\b)`,
);
/** A web page, site or tab: the browser tools' words, kept away from the file rules ("save this page as a PDF"). */
const PAGE_WORDS = /\b(?:this|that|the)\s+(?:web\s*)?(?:page|site|website|tab|article)\b/;
const FILE_DOC = new RegExp(
  String.raw`\b(?:write|draft|make|create|prepare|put\s+together|type\s+up|write\s+up)\s+(?:me\s+|us\s+)?(?:an?\s+|the\s+|my\s+)?(?:[\w'-]+\s+){0,4}?(?:letter|resume|cv|cover\s+letter|report|invoice|essay|memo|contract|proposal|agreement|document|pdf|word\s+doc(?:ument)?)\b|\b(?:as|into|to|in)\s+(?:an?\s+)?(?:pdf|word\s+(?:doc|document|file)|docx|(?:editable\s+)?document)\b`,
);

// The engine-drawn card kinds (tools/display.ts) and rebuilding a failed card (retry_card).
const SHOW_TABLE = /\b(?:in(?:to)?|as) a table\b|\b(?:make|show|give) (?:me )?a table of\b/;
const SHOW_CHART = /\b(?:chart|graph|plot) (?:that|those|this|these|the|it|them)\b|\ba (?:bar|line|area|pie|donut|scatter) (?:chart|graph|plot)\b|\bas a (?:\w+ )?(?:chart|graph)\b/;
const SHOW_DOCUMENT = /\bas a document\b/;
const SHOW_CODE = /\b(?:show|let me see) (?:me )?(?:the )?(?:source )?code (?:for|of|behind)\b/;
const RETRY_CARD = /^(?:(?:ok(?:ay)?|please|trinity)[\s,]+)*(?:try (?:that |it )?again|retry\b|have another go|rebuild (?:it|card \d+))/;

function heuristic(input: RouteInput, tools: Tool[], started: number): Decision {
  // Curly apostrophes (phone keyboards type "I’ll", "don’t") read as straight ones; a card's number as a digit.
  const t = cardDigits(latestWords(input.conversation).toLowerCase().replace(/[‘’]/g, "'"));
  const pick = (action: string, confidence = 0.75): Decision => ({
    action,
    confidence,
    tool: tools.find((x) => x.name === action) ?? null,
    options: {},
    offered: [],
    ms: Date.now() - started,
  });
  const has = (name: string) => tools.some((x) => x.name === name);
  // A yes or a no while Trinity is waiting for one (the tool is only offered then): decided here, whatever Jev makes of it.
  if (has("answer_question") && yesOrNo(t) !== null && t.split(/\s+/).length <= 10) return pick("answer_question", 0.95);
  // Filling from the vault on the page in front (offered only while the extension is connected): before the vault's
  // own "save" words and before a click.
  if (has("browser_fill_card") && BROWSER_FILL_CARD.test(t)) return pick("browser_fill_card", 0.9);
  if (has("browser_fill_details") && BROWSER_FILL_DETAILS.test(t)) return pick("browser_fill_details", 0.9);
  if (has("browser_sign_in") && BROWSER_SIGN_IN.test(t) && !/\b(?:click|tap|press|hit|push)\b/.test(t)) return pick("browser_sign_in", 0.9);
  // The vault, while its tools are on offer. Before memory and the board: "remember my Netflix password" opens the
  // secure form (it is never kept as a memory), and "delete my saved card" is not a board card.
  if (has("vault_forget") && VAULT_FORGET.test(t)) return pick("vault_forget", 0.9);
  if (has("vault_list") && VAULT_LIST.test(t)) return pick("vault_list", 0.9);
  if (has("vault_save_card") && VAULT_CARD.test(t)) return pick("vault_save_card", 0.9);
  if (has("vault_save_login") && VAULT_LOGIN.test(t)) return pick("vault_save_login", 0.9);
  if (has("vault_save_details") && VAULT_DETAILS.test(t)) return pick("vault_save_details", 0.9);
  // The memory, reminder and skill tools asked for outright, and the answer to a question the problem solver just
  // asked (tools/intents.ts).
  const learned = voiceIntent(t, has);
  if (learned) return pick(learned, learned === "answer_followup" ? 0.9 : 0.85);
  // While a game runs (its tools are offered), the user's words are about the story: a question about a
  // hero's sheet is game_answer and what "I" or "we" do is game_narrate.
  const inGame = has("game_narrate") || has("game_answer");
  // Any Game Master table tool in the offer set — board move/remove heuristics must not steal story verbs.
  const atGameTable =
    has("game_new") || has("game_begin") || has("game_add_player") || has("game_narrate") || has("game_configure");
  // Begin before new: "let's start the adventure" during setup is game_begin, not a fresh game_new.
  if (
    has("game_begin") &&
    /\b(let'?s (begin|start)|ready to (begin|play)|start the adventure|that'?s everyone|we'?re ready|(start|begin) (the|our|this) (game|adventure|campaign|session))\b/.test(t)
  )
    return pick("game_begin", 0.85);
  // A NEW game is asked for as one ("start a new game", "let's play a one-shot") — not "pause the game" or "start the game".
  if (has("game_new") && /\b(start|begin|run|set up|play)\b[^.?!]*\b(a|an|another|new)\b[^.?!]*\b(game|campaign|adventure|one.?shot)\b/.test(t))
    return pick("game_new", 0.85);
  // ("What's my character's armor class?" asks about the sheet; "What's my character going to be? An elf…" makes one.)
  if (has("game_answer") && /\b(what('s| is| are)|how (much|many))\b/.test(t) && /\b(my character's|hp|hit points|armou?r|ac|gear|inventory|gold|stats?)\b/.test(t))
    return pick("game_answer", 0.85);
  if (has("game_add_player") && /\b(my character|i('| a)m playing|i'll play|playing (a|an)|add (a )?(player|hero|character))\b/.test(t))
    return pick("game_add_player", 0.85);
  if (has("game_configure") && /\b(genre|setting|tone|campaign|fantasy|sci-?fi|horror|pirate|space|cyberpunk)\b/.test(t))
    return pick("game_configure", 0.8);
  // The table's own commands (each offered only when it applies: a fight to end only in a fight, and so on).
  if (has("game_end_session") && GAME_END_SESSION.test(t)) return pick("game_end_session", 0.85);
  if (has("game_pause") && GAME_PAUSE.test(t)) return pick("game_pause", 0.85);
  if (has("game_undo") && GAME_UNDO.test(t)) return pick("game_undo", 0.85);
  if (has("game_start_combat") && GAME_START_COMBAT.test(t)) return pick("game_start_combat", 0.85);
  if (has("game_end_combat") && GAME_END_COMBAT.test(t)) return pick("game_end_combat", 0.85);
  if (has("game_next_turn") && GAME_NEXT_TURN.test(t)) return pick("game_next_turn", 0.85);
  if (has("game_rest") && GAME_REST.test(t)) return pick("game_rest", 0.85);
  // A yes or a no to the Game Master's own question — after the named commands ("okay, we're back" resumes).
  if (has("game_confirm") && yesOrNo(t) !== null && t.split(/\s+/).length <= 10) return pick("game_confirm", 0.95);
  if (has("game_roll") && GAME_ROLL.test(t)) return pick("game_roll", 0.85);
  if (has("game_narrate") && !ONLINE.test(t) && !TABLE_TALK.test(t) && /^((ok(ay)?|so|and|then|now|alright)\b[\s,]*)*(i|we)('(ll|m|re|ve|d))?\s+\w/.test(t))
    return pick("game_narrate", 0.85);
  // Email, the calendar, meetings and booking (services/assist/routes.ts): each rule knows what is open right now
  // ("send it" only while Trinity's draft is open, "save it" only while her event form is).
  const assist = assistRoute(t, has);
  if (assist) return pick(assist, 0.85);
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
  if (at("browser_tabs", BROWSER_TABS) < Infinity || at("browser_tabs", BROWSER_TABS_MORE) < Infinity) return pick("browser_tabs", 0.85);
  if (at("browser_save", BROWSER_SAVE) < Infinity && !IMAGE.test(t)) return pick("browser_save", 0.82);
  if (at("browser_read", BROWSER_READ) < Infinity) return pick("browser_read", 0.82);
  if (at("browser_open", BROWSER_OPEN) < Infinity && !IMAGE.test(t) && !VIDEO.test(t)) return pick("browser_open", 0.85);
  if (at("browser_act", BROWSER_ACT) < Infinity) return pick("browser_act", 0.8);
  // Engine-drawn cards and a retry, before the build verbs: "make a bar chart of these numbers" is drawn, not built.
  if (!atGameTable) {
    if (at("retry_card", RETRY_CARD) < Infinity) return pick("retry_card", 0.85);
    if (at("show_chart", SHOW_CHART) < Infinity) return pick("show_chart", 0.85);
    if (at("show_table", SHOW_TABLE) < Infinity) return pick("show_table", 0.85);
    if (at("show_code", SHOW_CODE) < Infinity) return pick("show_code", 0.85);
    if (at("show_document", SHOW_DOCUMENT) < Infinity && !PAGE_WORDS.test(t)) return pick("show_document", 0.85);
  }
  // Saved files, before the card rules: "read the shopping list file" is not a card, "delete the old report file" not
  // a board card. A request naming a file to read, open, delete or rename comes before one that makes a file.
  if (!atGameTable) {
    if (at("list_files", FILE_LIST) < Infinity) return pick("list_files", 0.85);
    if (at("delete_file", FILE_DELETE) < Infinity) return pick("delete_file", 0.85);
    if (at("rename_file", FILE_RENAME) < Infinity) return pick("rename_file", 0.85);
    if (at("read_file", FILE_READ) < Infinity) return pick("read_file", 0.85);
    if (at("open_file", FILE_OPEN) < Infinity) return pick("open_file", 0.85);
    if (at("save_file", FILE_SAVE) < Infinity) return pick("save_file", 0.85);
    if (!SKILL.test(t) && !PAGE_WORDS.test(t)) {
      if (at("make_spreadsheet", FILE_SHEET) < Infinity) return pick("make_spreadsheet", 0.82);
      if (at("make_document", FILE_DOC) < Infinity) return pick("make_document", 0.82);
    }
  }
  // Arranging before undo: "put the cards in a grid" is a layout, not "put the cards back".
  if (at("arrange_cards", ARRANGE) < Infinity) return pick("arrange_cards", 0.9);
  // A card's size before undo too: "restore card 2" / "put card 2 back to normal" is a resize, not an undo.
  if (!atGameTable && at("resize_card", RESIZE_CARD) < Infinity && !INSIDE_CARD.test(t)) return pick("resize_card", 0.88);
  // Card skills before undo and clear: "clear the note" is a note edit, "close everything except the timer" isn't a wipe,
  // "reset the timer" isn't an undo.
  if (!atGameTable) {
    if (at("remove_card", REMOVE_SOME) < Infinity) return pick("remove_card", 0.88);
    if (at("edit_note", EDIT_NOTE) < Infinity) return pick("edit_note", 0.86);
    if (at("read_card", READ_CARD) < Infinity) return pick("read_card", 0.86);
    if (at("control_card", CONTROL_CARD) < Infinity) return pick("control_card", 0.86);
    if (at("rename_card", RENAME_CARD) < Infinity) return pick("rename_card", 0.85);
    if (at("duplicate_card", DUPLICATE_CARD) < Infinity) return pick("duplicate_card", 0.85);
  }
  // Undo before clear: "put the cards back" must not wipe the board again.
  if (at("undo_workspace", UNDO) < Infinity) return pick("undo_workspace", 0.9);
  // ("Don't clear the screen" asks for the opposite.)
  if (at("clear_workspace", CLEAR) < Infinity && !NOT_THAT.test(t)) return pick("clear_workspace", 0.8);
  if (at("get_time", CLOCK) < Infinity) return pick("get_time", 0.88);
  if (at("describe_workspace", DESCRIBE) < Infinity) return pick("describe_workspace", 0.8);
  if (at("set_speech_rate", SPEECH_RATE) < Infinity) return pick("set_speech_rate", 0.88);
  if (!atGameTable) {
    // A card's own size first: "make card 2 bigger" has no move / remove words, "restore card 2" isn't an undo.
    if (at("resize_card", RESIZE_CARD) < Infinity && !INSIDE_CARD.test(t)) return pick("resize_card", 0.88);
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
  // Last resort, for tools the rules above don't know (a skill Trinity made): a distinctive word of the tool's name
  // said aloud ("run the tip calculator"). Never an everyday word ("I had a great time" is not get_time, "the game was
  // fun" is not game_new), never a game tool (table talk is full of their words), never one that touches the vault.
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  for (const tool of tools) {
    if (tool.sensitive || tool.name.startsWith("game_") || ASSIST_TOOLS.has(tool.name)) continue;
    if (tool.name.split(/[_\s]+/).some((tok) => tok.length > 3 && !EVERYDAY.has(tok) && words.has(tok))) return pick(tool.name, 0.7);
  }
  return pick("NONE", 0.6);
}
