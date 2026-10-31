import { nanoid } from "nanoid";
import { getActivePersona } from "./db/sqlite.js";
import type { MemoryStore } from "./db/memory.js";
import { think } from "./services/brain.js";
import { route } from "./services/jev.js";
import { build } from "./services/mordiem.js";
import { personaplexTurn } from "./services/voice.js";
import { getTool, getTools } from "./tools/registry.js";
import type { MemoryDoc, Persona, RouteDecision, ServerEvent, TranscriptTurn } from "./types.js";

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

    // 3. Act + 4. Speak back.
    const say = await this.runDecision(decision, { persona, memoryTexts, userText, generateSpeech: true }, emit);
    // In mock voice mode the browser speaks this turn's text via the Web Speech API.
    this.pushTurn("trinity", say, emit);
  }

  /**
   * Handle one spoken turn in LIVE voice mode: PersonaPlex produces Trinity's reply
   * audio + transcript, then Jev routes on that transcript to fire any tools/builds.
   * @param audioUrl the user's speech as a public URL or base64 data: URI.
   */
  async handleUserAudio(audioUrl: string, emit: Emit): Promise<void> {
    const persona = getActivePersona();
    this.pushTurn("user", "🎙 (spoken)", emit);

    emit({ type: "status", text: "Trinity is responding…" });
    const turn = await personaplexTurn(audioUrl, persona);
    emit({ type: "audio", chunk: turn.audioUrl }); // client plays the WAV URL
    this.pushTurn("trinity", turn.text, emit);

    // Jev listens to the PersonaPlex transcript and fires tools/builds if warranted.
    const recalled = await this.memory.search(turn.text, { limit: 3 });
    const decision = await route({ userText: turn.text, transcript: this.transcript, tools: getTools() });
    emit({ type: "route", decision });
    await this.runDecision(
      decision,
      { persona, memoryTexts: recalled.map((d) => d.text), userText: turn.text, generateSpeech: false },
      emit,
    );
  }

  /** Execute a routing decision. Returns spoken text when generateSpeech is true. */
  private async runDecision(
    decision: RouteDecision,
    ctx: { persona: Persona; memoryTexts: string[]; userText: string; generateSpeech: boolean },
    emit: Emit,
  ): Promise<string> {
    const { persona, memoryTexts, userText, generateSpeech } = ctx;
    const speak = async () =>
      generateSpeech ? think({ persona, transcript: this.transcript, memories: memoryTexts, userText }) : "";

    switch (decision.action) {
      case "tool": {
        const tool = decision.tool ? getTool(decision.tool) : undefined;
        if (!tool) return speak();
        emit({ type: "tool_start", tool: tool.name, args: decision.args ?? {} });
        const result = await tool.run(decision.args ?? {}, {
          persona,
          recentTranscript: this.transcript.slice(-6),
          emit,
        });
        emit({ type: "tool_result", tool: tool.name, result });
        if (result.render) {
          this.lastWorkspaceHtml = result.render;
          emit({ type: "workspace", html: result.render, title: tool.name });
        }
        return result.say ?? (result.ok ? "Done." : result.error ?? "That didn't work.");
      }
      case "build": {
        const instruction = String(decision.args?.instruction ?? userText);
        emit({ type: "status", text: "Building…" });
        const html = await build(instruction, this.lastWorkspaceHtml);
        this.lastWorkspaceHtml = html;
        emit({ type: "workspace", html, title: instruction.slice(0, 48) });
        return generateSpeech ? "There — take a look at what I put together." : "";
      }
      case "recall": {
        if (decision.args?.write) await this.writeMemory(userText, emit);
        return speak();
      }
      case "speak":
      case "none":
      default:
        return speak();
    }
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
