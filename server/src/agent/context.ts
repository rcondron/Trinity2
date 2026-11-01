import type { Persona } from "../types.js";

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
}

const DEFAULT_STYLE: ReplyStyle = { maxWords: 14, maxSentences: 1, guidance: "" };

export function contextFor(persona: Persona): AgentContext {
  const parts: string[] = [];
  const rules: string[] = [];
  const hidden = new Set<string>();
  let style: ReplyStyle = { ...DEFAULT_STYLE };
  let styled = false;
  let curate = true;
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
  };
}
