// Shared types for the Trinity engine.
import type { MemoryStore } from "./db/memory.js";

export type Speaker = "user" | "trinity" | "system";

/** A persona is "who you are talking to and what they sound like". */
export interface Persona {
  id: string;
  name: string;
  /** The full personality prompt — character, role, tone — fed to the brain and reply writer. */
  description: string;
  /**
   * Short prompt (≤ ~160 chars) that conditions the PersonaPlex voice model. Kept separate
   * from `description` because every prompt token costs a model step at connect time
   * (measured: 42 chars → 4.5s handshake, 520 chars → 9.4s).
   */
  voicePrompt: string;
  /** Voice: a built-in PersonaPlex preset ("NATF2") or a custom sample ("custom:<slug>"). */
  voice: string;
  /** Extra tool groups this persona can use, e.g. ["game"] for the Game Master. */
  toolsets: string[];
  /** Free-form traits, surfaced into the system prompt and used by routing. */
  traits: Record<string, string>;
  updatedAt: number;
}

export interface TranscriptTurn {
  id: string;
  speaker: Speaker;
  text: string;
  /** True while PersonaPlex is still streaming this turn's text. */
  partial?: boolean;
  /** Said aloud, in full, in the live call (that tab shows it from the call's own transcript). */
  voiced?: boolean;
  /** Said unprompted: a due reminder, a scheduled task's result, a finished background job. */
  proactive?: boolean;
  /** The user cut it off while the live call was saying it (talked over it, or ended the turn): shown, never read out again. */
  cut?: boolean;
  ts: number;
}

/** A memory document — the free-form "page database" record. */
export interface MemoryDoc {
  _id: string;
  _rev?: string;
  type: "fact" | "event" | "preference" | "summary" | "note";
  text: string;
  tags: string[];
  /** 0..1 — how important this memory is; drives recall ranking. */
  salience: number;
  ts: number;
  meta?: Record<string, unknown>;
}

export interface HeartbeatTask {
  id: string;
  title: string;
  /** Natural-language instruction Trinity runs when this task is due. */
  instruction: string;
  intervalSec: number;
  nextRunAt: number;
  lastRunAt: number | null;
  enabled: boolean;
  /** A one-time reminder: it runs once (at nextRunAt), then stays as a finished item (enabled = false). */
  once?: boolean;
}

/**
 * A typed routing decision — the shape we expect back from Jev (or the mock).
 * Jev takes unstructured state (transcript + context) and returns this.
 */
export interface RouteDecision {
  action: "none" | "tool" | "recall" | "build" | "speak" | "forge";
  /** Tool name when action === "tool". */
  tool?: string;
  /** Arguments for the tool / build / recall. */
  args?: Record<string, unknown>;
  /** 0..1 confidence in this decision. */
  confidence: number;
  reason: string;
}

export interface ToolContext {
  persona: Persona;
  recentTranscript: TranscriptTurn[];
  emit: (event: ServerEvent) => void;
  /** The user's words that triggered the tool (the whole sentence when it fired at sentence end). */
  utterance: string;
  /** The memory store (remember / recall and any tool that personalizes). */
  memory: MemoryStore;
  /** Situation summary from the context providers (persona, active game, …). */
  situation: string;
  /** The user's own words when a planner (figure_out) runs the tool for them: what the safety checks read. */
  userWords?: string;
}

export interface ToolArgSpec {
  type: string;
  description: string;
  required?: boolean;
  /** value → label. Jev picks the argument from these (a second choice question, as in the reference). */
  options?: Record<string, string>;
}

export interface Tool {
  name: string;
  /** Doubles as the Jev choice label: one crisp sentence saying when to pick this tool. */
  description: string;
  /** JSON-schema-ish description of args, used to prompt Jev and for validation. */
  input: Record<string, ToolArgSpec>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /** Skills loaded from the library mark themselves so we can list provenance. */
  source?: "builtin" | "skill" | "forged";
  /** Only offered to personas whose `toolsets` include this (e.g. "game"). */
  toolset?: string;
  /** Tool names hidden while this tool is offered (e.g. game_roll supersedes roll_dice). */
  supersedes?: string[];
  /** Dynamic options for an argument (e.g. current player names); merged over static options. */
  options?: (arg: string, ctx: { persona: Persona }) => Record<string, string> | undefined;
  /**
   * Whether the tool makes sense right now (e.g. game tools gated by game phase). Hidden
   * tools are left out of Jev's choices entirely — fewer, sharper choices route better.
   */
  available?: (ctx: { persona: Persona }) => boolean;
  /**
   * How free-text (non-option) arguments are filled — this also decides WHEN the tool fires:
   *  - "llm"  (default): the fast model extracts them from the finished sentence → fires at sentence end.
   *  - "raw":  the tool reads ctx.utterance itself → fires at sentence end.
   *  - "none": no free-text arguments → fires mid-sentence as soon as Jev is confident (like the
   *            reference's CHANGE_COLOR / START_TIMER).
   */
  argMode?: "llm" | "raw" | "none";
}

export interface ToolResult {
  ok: boolean;
  /** What happened, in words — the reply writer turns it into one spoken line. */
  say?: string;
  /**
   * A line to speak VERBATIM instead of a reply-writer paraphrase — e.g. grounded
   * narration or an answer read from the game state.
   */
  speak?: string;
  /** HTML fragment to show in the workspace (freeform tools). */
  render?: string;
  data?: unknown;
  error?: string;
  /** The work continues in the background (a build streaming in, or queued behind one): the reply must not claim it's done. */
  inProgress?: "started" | "queued";
}

// ─── WebSocket protocol ──────────────────────────────────────────────────────

export type ClientEvent =
  | { type: "hello" }
  | { type: "audio"; chunk: string /* base64 PCM */ }
  | { type: "text"; text: string } // typed input (debug / accessibility)
  | { type: "barge_in" } // user started talking over Trinity
  | { type: "set_persona"; id: string }
  | { type: "stop" };

export type ServerEvent =
  | { type: "ready"; persona: Persona; services: ServiceStatus; profileName: string | null; speechRate?: number }
  | { type: "speech_rate"; rate: number }
  | { type: "audio"; chunk: string /* base64 PCM from PersonaPlex */ }
  | { type: "transcript"; turn: TranscriptTurn }
  | { type: "route"; decision: RouteDecision }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: ToolResult }
  | { type: "workspace"; html: string; title?: string }
  | { type: "memory"; doc: MemoryDoc; op: "write" | "recall" }
  | { type: "heartbeat"; task: HeartbeatTask; fired: boolean }
  | { type: "wake" } // a reminder or task is (about to be) due and no voice call is up anywhere: one app tab warms one
  | { type: "voice"; status: "free" | "taken" } // the session lent out for a voice sample came back free — or a call took it
  | { type: "skill_forged"; name: string; description: string; source: string }
  | { type: "status"; text: string }
  | { type: "error"; text: string };

export interface ServiceStatus {
  voice: "live" | "mock";
  /** Real-time streaming voice loop (patched PersonaPlex + Deepgram + Jev). */
  stream: "live" | "mock";
  jev: "live" | "mock";
  brain: "live" | "mock";
  mordiem: "live" | "mock";
  web: "live" | "mock";
  /** Live shopping, flight and hotel results (a SerpApi key). */
  travel: "live" | "mock";
  /** The Chrome extension is connected. */
  browser: "live" | "mock";
}
