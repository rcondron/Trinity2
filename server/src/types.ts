// Shared types for the Trinity engine.

export type Speaker = "user" | "trinity" | "system";

/** A persona is "who you are talking to and what they sound like". */
export interface Persona {
  id: string;
  name: string;
  /** The prompt describing character, role, tone — fed to PersonaPlex + brain. */
  description: string;
  /** Reference to a voice prompt (fal.ai voice id or a path to a reference clip). */
  voice: string;
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
}

export interface Tool {
  name: string;
  description: string;
  /** JSON-schema-ish description of args, used to prompt Jev and for validation. */
  input: Record<string, { type: string; description: string; required?: boolean }>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /** Skills loaded from the library mark themselves so we can list provenance. */
  source?: "builtin" | "skill";
}

export interface ToolResult {
  ok: boolean;
  /** Spoken summary Trinity can say aloud. */
  say?: string;
  /** HTML/markup to render into the workspace pane. */
  render?: string;
  data?: unknown;
  error?: string;
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
  | { type: "ready"; persona: Persona; services: ServiceStatus }
  | { type: "audio"; chunk: string /* base64 PCM from PersonaPlex */ }
  | { type: "transcript"; turn: TranscriptTurn }
  | { type: "route"; decision: RouteDecision }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: ToolResult }
  | { type: "workspace"; html: string; title?: string }
  | { type: "memory"; doc: MemoryDoc; op: "write" | "recall" }
  | { type: "heartbeat"; task: HeartbeatTask; fired: boolean }
  | { type: "skill_forged"; name: string; description: string; source: string }
  | { type: "status"; text: string }
  | { type: "error"; text: string };

export interface ServiceStatus {
  voice: "live" | "mock";
  jev: "live" | "mock";
  brain: "live" | "mock";
  mordiem: "live" | "mock";
  web: "live" | "mock";
}
