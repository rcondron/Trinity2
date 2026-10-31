import { nanoid } from "nanoid";
import { getActivePersona } from "./db/sqlite.js";
import type { MemoryStore } from "./db/memory.js";
import { think } from "./services/brain.js";
import { route } from "./services/jev.js";
import { build } from "./services/morph.js";
import { getTool, getTools } from "./tools/registry.js";
import type { MemoryDoc, ServerEvent, TranscriptTurn } from "./types.js";

type Emit = (e: ServerEvent) => void;

/**
 * The orchestrator runs Trinity's core loop over TEXT turns (voice transport is
 * handled separately). One instance per server; it keeps a short rolling
 * transcript so routing and the brain have conversational context.
 */
export class Orchestrator {
  private transcript: TranscriptTurn[] = [];
  private lastWorkspaceHtml?: string;

  constructor(private memory: MemoryStore) {}

  private pushTurn(speaker: TranscriptTurn["speaker"], text: string, emit: Emit): TranscriptTurn {
    const turn: TranscriptTurn = { id: nanoid(8), speaker, text, ts: Date.now() };
    this.transcript.push(turn);
    if (this.transcript.length > 40) this.transcript.shift();
    emit({ type: "transcript", turn });
    return turn;
  }

  /** Handle one user utterance (already transcribed to text). */
  async handleUserText(userText: string, emit: Emit): Promise<void> {
    const persona = getActivePersona();
    this.pushTurn("user", userText, emit);

    // 1. Recall — surface relevant memories into context.
    const recalled = await this.memory.search(userText, { limit: 4 });
    for (const doc of recalled) emit({ type: "memory", doc, op: "recall" });
    const memoryTexts = recalled.map((d) => d.text);

    // 2. Route — Jev decides what to do.
    const decision = await route({ userText, transcript: this.transcript, tools: getTools() });
    emit({ type: "route", decision });

    // 3. Act.
    let say = "";
    switch (decision.action) {
      case "tool": {
        const tool = decision.tool ? getTool(decision.tool) : undefined;
        if (!tool) {
          say = await think({ persona, transcript: this.transcript, memories: memoryTexts, userText });
          break;
        }
        emit({ type: "tool_start", tool: tool.name, args: decision.args ?? {} });
        const result = await tool.run(decision.args ?? {}, {
          persona,
          recentTranscript: this.transcript.slice(-6),
          emit,
        });
        emit({ type: "tool_result", tool: tool.name, result });
        say = result.say ?? (result.ok ? "Done." : result.error ?? "That didn't work.");
        if (result.render) {
          this.lastWorkspaceHtml = result.render;
          emit({ type: "workspace", html: result.render, title: tool.name });
        }
        break;
      }
      case "build": {
        const instruction = String(decision.args?.instruction ?? userText);
        emit({ type: "status", text: "Building…" });
        const html = await build(instruction, this.lastWorkspaceHtml);
        this.lastWorkspaceHtml = html;
        emit({ type: "workspace", html, title: instruction.slice(0, 48) });
        say = "There — take a look at what I put together.";
        break;
      }
      case "recall": {
        if (decision.args?.write) await this.writeMemory(userText, emit);
        say = await think({ persona, transcript: this.transcript, memories: memoryTexts, userText });
        break;
      }
      case "speak":
      case "none":
      default:
        say = await think({ persona, transcript: this.transcript, memories: memoryTexts, userText });
    }

    // 4. Speak back.
    const reply = this.pushTurn("trinity", say, emit);
    // In mock voice mode the browser speaks `reply.text` via the Web Speech API;
    // in live mode this is where PersonaPlex audio would already be streaming.
    void reply;
  }

  /** Run a due heartbeat task as a proactive, self-initiated turn. */
  async runHeartbeat(instruction: string, emit: Emit): Promise<void> {
    const persona = getActivePersona();
    const recalled = await this.memory.search(instruction, { limit: 3 });
    const say = await think({
      persona,
      transcript: this.transcript,
      memories: recalled.map((d) => d.text),
      userText: `[heartbeat] ${instruction}\n(Only speak if there's something genuinely worth saying; otherwise keep it very brief.)`,
    });
    this.pushTurn("trinity", say, emit);
  }

  private async writeMemory(text: string, emit: Emit): Promise<void> {
    const doc: MemoryDoc = {
      _id: nanoid(12),
      type: "preference",
      text,
      tags: ["user", "conversation"],
      salience: 0.7,
      ts: Date.now(),
    };
    const saved = await this.memory.put(doc);
    emit({ type: "memory", doc: saved, op: "write" });
  }
}
