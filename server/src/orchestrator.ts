import { nanoid } from "nanoid";
import { live } from "./config.js";
import { getActivePersona } from "./db/sqlite.js";
import type { MemoryStore } from "./db/memory.js";
import { think, narrate } from "./services/brain.js";
import { route, selectMemories } from "./services/jev.js";
import { extractMemories, tokenOverlap } from "./services/curator.js";
import { build } from "./services/mordiem.js";
import { forgeSkill } from "./services/skill-forge.js";
import { personaplexTurn } from "./services/voice.js";
import { getTool, getTools } from "./tools/registry.js";
import type { MemoryDoc, Persona, RouteDecision, ServerEvent, ToolResult, TranscriptTurn } from "./types.js";

type Emit = (e: ServerEvent) => void;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("tool timed out")), ms)),
  ]);
}

function skillHtml(skill: { name: string; description: string; source: string }): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  return `<div style="font-family:system-ui;color:#e8e8ef;padding:20px">
    <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8ab0">drafted skill · pending approval</div>
    <h2 style="margin:.3em 0;font-size:20px">${esc(skill.name)}</h2>
    <p style="color:#b9b9d6">${esc(skill.description)}</p>
    <pre style="background:#0b0b12;border:1px solid #262636;border-radius:8px;padding:12px;overflow:auto;font-size:12px;color:#cdd4e6;line-height:1.45">${esc(skill.source)}</pre>
    <p style="color:#8a8ab0;font-size:12px">Approve it in Settings → Skills to make it usable.</p>
  </div>`;
}

/**
 * The orchestrator runs Trinity's core loop over TEXT turns (voice transport is
 * handled separately). One instance per server; it keeps a short rolling
 * transcript so routing and the brain have conversational context.
 */
export class Orchestrator {
  private transcript: TranscriptTurn[] = [];
  private lastWorkspaceHtml?: string;

  constructor(private memory: MemoryStore) {}

  /** Clear the rolling conversation + workspace — used when switching persona. */
  resetContext(): void {
    this.transcript = [];
    this.lastWorkspaceHtml = undefined;
  }

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

    // 1. Recall — keyword-prefilter, then let Jev pick what's actually relevant.
    const candidates = await this.memory.search(userText, { limit: 8 });
    const recalled = await selectMemories({ userText, transcript: this.transcript }, candidates);
    for (const doc of recalled) emit({ type: "memory", doc, op: "recall" });
    const memoryTexts = recalled.map((d) => d.text);

    // 2. Route — Jev decides what to do.
    const decision = await route({ userText, transcript: this.transcript, tools: getTools() });
    emit({ type: "route", decision });

    // 3. Act + 4. Speak back.
    const say = await this.runDecision(decision, { persona, memoryTexts, userText, generateSpeech: true }, emit);
    // In mock voice mode the browser speaks this turn's text via the Web Speech API.
    this.pushTurn("trinity", say, emit);

    // 5. Curate — extract durable memories from this exchange in the background.
    void this.curate(userText, say, emit);
  }

  /** Auto-curation: extract durable memories from the latest exchange (deduped). */
  private async curate(userText: string, trinityText: string, emit: Emit): Promise<void> {
    try {
      const extracted = await extractMemories(userText, trinityText);
      for (const m of extracted) {
        const near = await this.memory.search(m.text, { limit: 1 });
        if (near[0] && tokenOverlap(near[0].text, m.text) > 0.6) continue; // dedup
        const saved = await this.memory.put({ _id: nanoid(12), ts: Date.now(), ...m });
        emit({ type: "memory", doc: saved, op: "write" });
      }
    } catch (err) {
      console.warn("[curate] failed:", (err as Error).message);
    }
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
        let result: ToolResult;
        try {
          result = await withTimeout(
            tool.run(decision.args ?? {}, { persona, recentTranscript: this.transcript.slice(-6), emit }),
            10_000,
          );
        } catch (err) {
          result = { ok: false, error: (err as Error).message };
        }
        emit({ type: "tool_result", tool: tool.name, result });
        if (result.render) {
          this.lastWorkspaceHtml = result.render;
          emit({ type: "workspace", html: result.render, title: tool.name });
        }
        if (!generateSpeech) return "";
        // Let the active persona relay a successful result in their own voice,
        // instead of speaking the tool's flat output verbatim.
        if (result.ok && result.say)
          return narrate({ persona, transcript: this.transcript, userText, toolName: tool.name, result: result.say });
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
      case "forge": {
        const need = String(decision.args?.need ?? userText);
        emit({ type: "status", text: "Forging a new skill…" });
        const res = await forgeSkill(need);
        if (!res.ok) return generateSpeech ? `I couldn't safely build that tool: ${res.reason}.` : "";
        emit({ type: "skill_forged", name: res.skill.name, description: res.skill.description, source: res.skill.source });
        emit({ type: "workspace", html: skillHtml(res.skill), title: `skill: ${res.skill.name}` });
        return generateSpeech
          ? `I drafted a skill called ${res.skill.name.replace(/_/g, " ")}. Review it in Settings and approve it to make it available.`
          : "";
      }
      case "recall": {
        // When the brain is live, the background curator extracts clean memories;
        // only store the raw turn here as a mock-mode fallback.
        if (decision.args?.write && !live.brain) await this.writeMemory(userText, emit);
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
