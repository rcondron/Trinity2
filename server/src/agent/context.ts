import type { Persona } from "../types.js";
import type { SpokenCaps } from "./reply.js";

/**
 * Situational context for the agent core, contributed by feature modules (e.g. the
 * game module describes the active game) so the router and reply writer stay
 * decoupled from feature internals.
 */
export interface ReplyStyle {
  /** Upper bound on the spoken reply. */
  maxWords: number;
  /** Sentences the reply may span (e.g. 2 = confirm, then ask the next setup question). */
  maxSentences: number;
  /** Extra instruction for the reply writer. */
  guidance: string;
  /** Spoken verbatim after the written reply — e.g. the Game Master's next setup question, so it's never skipped. */
  append?: string;
}

/** How the talking brain should speak while a context applies (services/talk.ts) — e.g. a Game Master's table manner. */
export interface TalkStyle {
  /** Extra rules for what is said when no tool takes the sentence. */
  guidance?: string;
  /** Reply length caps that replace the defaults (a narrator may run longer than small talk). */
  caps?: Partial<SpokenCaps>;
  /**
   * Words the talking brain marks SILENT get no reply on the text channel too (a game table, where chatter between
   * players is not for the Game Master). Elsewhere a typed turn always gets words.
   */
  silence?: boolean;
}

/** How the live voice should behave while a context applies (services/voice-call.ts). */
export interface VoiceTuning {
  /** Silence that ends the user's turn, in ms (a table of players thinking aloud needs more than a quick chat). */
  endpointingMs?: number;
  /** Names and terms the transcriber should expect (heroes, places, monsters): at most 50, a few words each. */
  keyterms?: string[];
  /** Lines to say while a tool is slow, used in turn (default: "One moment."). */
  fillers?: string[];
  /** How long a tool may take before a filler is said, in ms. */
  fillerAfterMs?: number;
  /** Speech pace (1 = normal, 0.9 = a little slower); the pitch never changes. */
  pace?: number;
}

export interface AgentContextProvider {
  /** A compact paragraph of situation for Jev's page text and the reply writer. */
  describe?(persona: Persona): string | null;
  /** Extra routing rules for Jev's instructions while this context applies. */
  rules?(persona: Persona): string[];
  /** Tool names to hide from Jev (e.g. build_ui while a game screen owns the workspace). */
  hiddenActions?(persona: Persona): string[];
  /** Reply-style override (first provider that returns one wins). */
  replyStyle?(persona: Persona): Partial<ReplyStyle> | null;
  /** True to skip auto-curating memories (e.g. in-character game talk isn't a fact about the user). */
  suppressCuration?(persona: Persona): boolean;
  /** How the talking brain should speak (first provider that returns one wins). */
  talk?(persona: Persona): TalkStyle | null;
  /** Live-voice tuning (first provider that returns one wins). */
  voice?(persona: Persona): VoiceTuning | null;
}

const providers: AgentContextProvider[] = [];

export function registerContextProvider(p: AgentContextProvider): void {
  providers.push(p);
}

export interface AgentContext {
  summary: string;
  rules: string[];
  hiddenActions: Set<string>;
  style: ReplyStyle;
  /** Whether to auto-curate memories from this exchange. */
  curate: boolean;
  /** The talking brain's style here (empty: the defaults). */
  talk: TalkStyle;
  /** Live-voice tuning here (empty: the defaults). */
  voice: VoiceTuning;
}

const DEFAULT_STYLE: ReplyStyle = { maxWords: 14, maxSentences: 1, guidance: "" };

export function contextFor(persona: Persona): AgentContext {
  const parts: string[] = [];
  const rules: string[] = [];
  const hidden = new Set<string>();
  let style: ReplyStyle = { ...DEFAULT_STYLE };
  let styled = false;
  let curate = true;
  let talk: TalkStyle | null = null;
  let voice: VoiceTuning | null = null;
  for (const p of providers) {
    try {
      const d = p.describe?.(persona);
      if (d) parts.push(d);
      if (p.suppressCuration?.(persona)) curate = false;
      rules.push(...(p.rules?.(persona) ?? []));
      for (const a of p.hiddenActions?.(persona) ?? []) hidden.add(a);
      if (!styled) {
        const s = p.replyStyle?.(persona);
        if (s) {
          style = { ...style, ...s };
          styled = true;
        }
      }
      talk ??= p.talk?.(persona) ?? null;
      voice ??= p.voice?.(persona) ?? null;
    } catch (err) {
      console.warn("[agent] context provider failed:", (err as Error).message);
    }
  }
  const role = persona.traits.role ? ` (${persona.traits.role})` : "";
  return {
    summary: [`Assistant persona: ${persona.name}${role}.`, ...parts].join(" "),
    rules,
    hiddenActions: hidden,
    style,
    curate,
    talk: talk ?? {},
    voice: voice ?? {},
  };
}
