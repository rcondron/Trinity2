// Client-side mirror of the engine's WebSocket protocol (server/src/types.ts).

export interface Persona {
  id: string;
  name: string;
  description: string;
  voicePrompt: string;
  voice: string;
  toolsets: string[];
  traits: Record<string, string>;
  updatedAt: number;
}

export interface TranscriptTurn {
  id: string;
  speaker: "user" | "trinity" | "system";
  text: string;
  partial?: boolean;
  /** Said aloud, in full, in the live call (that tab shows it from the call's own transcript). */
  voiced?: boolean;
  /** Said unprompted: a due reminder, a scheduled task's result, a finished background job. */
  proactive?: boolean;
  /** The caller cut it off while the live call was saying it (talked over it, or ended the turn): shown, never read out again. */
  cut?: boolean;
  ts: number;
}

export interface RouteDecision {
  action: "none" | "tool" | "recall" | "build" | "speak" | "forge";
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
  /** A one-time reminder (runs once at nextRunAt, then stays as a finished item). */
  once?: boolean;
}

export type ServiceStatus = Record<"voice" | "stream" | "jev" | "brain" | "mordiem" | "web", "live" | "mock">;

export type ClientEvent =
  | { type: "hello" }
  | { type: "text"; text: string }
  | { type: "barge_in" }
  | { type: "set_persona"; id: string }
  | { type: "stop" };

export type ServerEvent =
  | { type: "ready"; persona: Persona; services: ServiceStatus; profileName?: string | null; speechRate?: number }
  | { type: "speech_rate"; rate: number }
  | { type: "audio"; chunk: string }
  | { type: "transcript"; turn: TranscriptTurn }
  | { type: "route"; decision: RouteDecision }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: { ok: boolean; say?: string; render?: string; error?: string } }
  | { type: "workspace"; html: string; title?: string }
  | { type: "memory"; doc: MemoryDoc; op: "write" | "recall" }
  | { type: "heartbeat"; task: HeartbeatTask; fired: boolean }
  | { type: "wake" } // a reminder or task is (about to be) due and no voice call is up anywhere: one tab warms one
  | { type: "voice"; status: "free" | "taken" } // the pod's one session, lent out for a voice sample, is free again — or a call took it
  | { type: "skill_forged"; name: string; description: string; source: string }
  | { type: "status"; text: string }
  | { type: "error"; text: string };
