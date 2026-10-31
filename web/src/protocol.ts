// Client-side mirror of the engine's WebSocket protocol (server/src/types.ts).

export interface Persona {
  id: string;
  name: string;
  description: string;
  voice: string;
  traits: Record<string, string>;
  updatedAt: number;
}

export interface TranscriptTurn {
  id: string;
  speaker: "user" | "trinity" | "system";
  text: string;
  partial?: boolean;
  ts: number;
}

export interface RouteDecision {
  action: "none" | "tool" | "recall" | "build" | "speak";
  tool?: string;
  args?: Record<string, unknown>;
  confidence: number;
  reason: string;
}

export interface MemoryDoc {
  _id: string;
  type: string;
  text: string;
  tags: string[];
  salience: number;
  ts: number;
}

export interface HeartbeatTask {
  id: string;
  title: string;
  instruction: string;
  intervalSec: number;
  nextRunAt: number;
  lastRunAt: number | null;
  enabled: boolean;
}

export type ServiceStatus = Record<"voice" | "jev" | "brain" | "morph" | "web", "live" | "mock">;

export type ClientEvent =
  | { type: "hello" }
  | { type: "text"; text: string }
  | { type: "barge_in" }
  | { type: "set_persona"; id: string }
  | { type: "stop" };

export type ServerEvent =
  | { type: "ready"; persona: Persona; services: ServiceStatus }
  | { type: "audio"; chunk: string }
  | { type: "transcript"; turn: TranscriptTurn }
  | { type: "route"; decision: RouteDecision }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: { ok: boolean; say?: string; render?: string; error?: string } }
  | { type: "workspace"; html: string; title?: string }
  | { type: "memory"; doc: MemoryDoc; op: "write" | "recall" }
  | { type: "heartbeat"; task: HeartbeatTask; fired: boolean }
  | { type: "status"; text: string }
  | { type: "error"; text: string };
