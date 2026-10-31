import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { getEndpoints } from "../settings.js";
import { getActivePersona } from "../db/sqlite.js";
import type { MemoryStore } from "../db/memory.js";
import { getTool, getTools } from "../tools/registry.js";
import { routeStream, inferArgs } from "./jev.js";
import { extractMemories, tokenOverlap } from "./curator.js";
import { forgeSkill } from "./skill-forge.js";
import { build } from "./mordiem.js";
import type { Persona, Tool, ToolResult } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORD = /\S+/g;
const VOICE_ENUM = /^(NAT|VAR)[FM]\d$/;

/** Voice prompt the patched server wants: a bare enum becomes "<enum>.pt", an
 *  explicit .pt/.wav is used as-is, and anything else (e.g. a legacy "NAT-01")
 *  falls back to the default so an unknown voice never fails the session. */
function resolveVoice(v: string): string {
  if (VOICE_ENUM.test(v)) return `${v}.pt`;
  if (/\.(pt|wav)$/i.test(v)) return v;
  return `${getEndpoints().personaplexVoice || "NATF2"}.pt`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("tool timed out")), ms))]);
}

/** Minimal async queue with a timed get; a timeout resolves to the TIMEOUT symbol. */
const TIMEOUT = Symbol("timeout");
class WordQueue {
  private items: (string | null)[] = [];
  private waiters: ((v: string | null) => void)[] = [];
  put(v: string | null) {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  get(ms: number): Promise<string | null | typeof TIMEOUT> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(onValue);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(TIMEOUT);
      }, ms);
      const onValue = (v: string | null) => {
        clearTimeout(t);
        resolve(v);
      };
      this.waiters.push(onValue);
    });
  }
}

function speakable(s: string): string {
  return s.replace(/[*"“”]/g, "");
}

/** A protocol frame: a 1-byte kind followed by its body. */
function frame(kind: number, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind;
  out.set(body, 1);
  return out;
}

export interface CallOpts {
  voice?: string;
  prompt?: string;
}

/**
 * One browser tab's real-time call. Ported from the personaplex-toolcall bench
 * (Python) to Trinity2: a persistent PersonaPlex WebSocket does the talking,
 * Deepgram transcribes the caller live beside it, and Jev is polled on the
 * in-progress sentence to fire Trinity's real tools. After a tool runs, the fast
 * reply model writes one sentence and PersonaPlex is MADE to say it (0x03), held
 * quiet (0x04) while the caller is still talking.
 *
 * Needs a PATCHED, self-hosted PersonaPlex server (PERSONAPLEX_WS_URL) — fal's
 * hosted endpoint can't accept the say/hold protocol.
 */
export class VoiceCall {
  private pp?: WebSocket;
  private dg?: WebSocket;
  private persona: Persona;
  private ep = getEndpoints();

  private lines: string[] = []; // finished turns, oldest first
  private agentPending = ""; // what PersonaPlex has said since the caller last spoke
  private finals = "";
  private interim = "";
  private utterance = 0;
  private fired = new Set<string>();
  private done: Record<string, unknown>[] = [];
  private pending = new Set<number>(); // utterances with a sentence-end action held
  private lastRouted = "";
  private routing = false;
  private agentLastWord = 0;
  private sayingUntil = 0;
  private replyChain: Promise<void> = Promise.resolve();
  private routerTimer?: ReturnType<typeof setInterval>;
  private lastHtml?: string;
  private closed = false;

  constructor(
    private browser: WebSocket,
    private memory: MemoryStore,
    opts: CallOpts,
  ) {
    this.persona = getActivePersona();
    this.opts = opts;
  }
  private opts: CallOpts;

  private send(ev: Record<string, unknown>) {
    if (this.browser.readyState === WebSocket.OPEN) this.browser.send(JSON.stringify(ev));
  }

  private get current(): string {
    return `${this.finals} ${this.interim}`.trim();
  }

  private conversation(text: string, final: boolean): string {
    let recent = this.lines.slice(-8).join("\n");
    if (this.agentPending.trim()) recent += `\nAgent: ${this.agentPending.trim()}`;
    const state = final ? "finished speaking" : "may still be speaking";
    return `Conversation so far, oldest first:\n${recent || "(nothing yet)"}\n\nCaller's latest words (${state}): ${text}`;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.ep.personaplexWsUrl) {
      this.send({ type: "status", text: "No streaming PersonaPlex configured — set PERSONAPLEX_WS_URL in Settings.", error: true });
      this.browser.close();
      return;
    }
    this.send({ type: "status", text: "Waking PersonaPlex (up to a minute if it was asleep)…" });

    const voice = resolveVoice(this.opts.voice || this.persona.voice);
    const prompt =
      this.opts.prompt ||
      this.persona.description +
        (Object.keys(this.persona.traits).length ? `\nTraits: ${JSON.stringify(this.persona.traits)}` : "");
    const params = new URLSearchParams({ voice_prompt: voice, text_prompt: prompt, pcm: "1" });

    try {
      const started = Date.now();
      this.pp = await this.connectPersonaplex(`${this.ep.personaplexWsUrl}/api/chat?${params}`);
      this.dg = this.connectDeepgram();
      this.send({ type: "ready", handshake_ms: Date.now() - started });
    } catch (err) {
      this.send({ type: "status", text: `Could not connect: ${(err as Error).message}`, error: true });
      this.stop();
      return;
    }

    this.routerTimer = setInterval(() => void this.routerTick(), this.ep.routeEveryMs);
    this.browser.on("message", (data, isBinary) => this.onBrowser(data, isBinary));
    this.browser.on("close", () => this.stop());
    this.browser.on("error", () => this.stop());
  }

  private connectPersonaplex(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: 0 });
      // Track it immediately so stop() can cancel an in-flight / queued connection
      // if the caller hangs up before PersonaPlex (one session per GPU) is ready.
      this.pp = ws;
      let hello = false;
      const to = setTimeout(() => {
        ws.close();
        reject(new Error("PersonaPlex handshake timed out"));
      }, 60_000);
      ws.on("message", (data: RawData, isBinary: boolean) => {
        const buf = data as Buffer;
        if (!hello) {
          hello = true;
          clearTimeout(to);
          if (isBinary && buf[0] === 0x00) resolve(ws);
          else {
            ws.close();
            reject(new Error("PersonaPlex refused the session"));
          }
          return;
        }
        this.onPersonaplex(buf, isBinary);
      });
      ws.on("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
      ws.on("close", () => this.stop());
    });
  }

  private connectDeepgram(): WebSocket {
    const ws = new WebSocket(this.ep.deepgramUrl, { headers: { Authorization: `Token ${this.ep.deepgramKey}` } });
    ws.on("message", (data: RawData) => this.onDeepgram(data as Buffer));
    ws.on("error", () => {});
    return ws;
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.routerTimer) clearInterval(this.routerTimer);
    try {
      if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      /* ignore */
    }
    this.dg?.close();
    this.pp?.close();
    if (this.browser.readyState === WebSocket.OPEN) this.browser.close();
  }

  // ── audio plumbing ───────────────────────────────────────────────────────────

  private onBrowser(data: RawData, isBinary: boolean) {
    if (!isBinary) {
      try {
        const m = JSON.parse((data as Buffer).toString()) as { type?: string };
        if (m.type === "stop") this.stop();
      } catch {
        /* ignore non-JSON control frames */
      }
      return;
    }
    // 16-bit PCM @ 24 kHz from the mic. Deepgram takes it as-is; PersonaPlex as kind 1.
    const buf = data as Buffer;
    if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(buf);
    if (this.pp?.readyState === WebSocket.OPEN) this.pp.send(frame(1, buf));
  }

  private onPersonaplex(buf: Buffer, isBinary: boolean) {
    if (!isBinary || buf.length === 0) return;
    const kind = buf[0];
    const body = buf.subarray(1);
    if (kind === 1) {
      // Trinity's voice, as raw PCM (pcm=1 mode) → straight to the browser.
      if (this.browser.readyState === WebSocket.OPEN) this.browser.send(body);
    } else if (kind === 2) {
      const word = body.toString("utf8");
      this.agentPending += word;
      this.agentLastWord = Date.now();
      this.send({ type: "agent", text: word });
    }
  }

  private onDeepgram(buf: Buffer) {
    let m: {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m.type === "UtteranceEnd") {
      this.endUtterance();
      this.send({ type: "caller", final: true, text: "" });
    } else if (m.type === "Results") {
      const said = m.channel?.alternatives?.[0]?.transcript ?? "";
      if (m.is_final) {
        this.finals = `${this.finals} ${said}`.trim();
        this.interim = "";
      } else {
        this.interim = said;
      }
      this.send({ type: "caller", text: this.current, final: false });
      if (m.speech_final) {
        const text = this.current;
        this.endUtterance();
        if (text) this.send({ type: "caller", final: true, text });
      }
    }
  }

  // ── deciding ─────────────────────────────────────────────────────────────────

  private async routerTick() {
    if (this.closed) return;
    const text = this.current;
    if (this.routing || text === this.lastRouted || (text.match(WORD)?.length ?? 0) < 2) return;
    this.lastRouted = text;
    this.routing = true;
    try {
      await this.route(this.utterance, text, false);
    } finally {
      this.routing = false;
    }
  }

  private endUtterance() {
    const text = this.current;
    const agentReply = this.agentPending.trim();
    this.finals = "";
    this.interim = "";
    this.lastRouted = "";
    if (!text) return;
    if (agentReply) this.lines.push(`Agent: ${agentReply}`);
    this.agentPending = "";
    this.lines.push(`Caller: ${text}`);
    const utterance = this.utterance++;
    // One last look at the whole sentence — the words that matter often come last.
    void this.route(utterance, text, true);
    void this.curate(text, agentReply);
  }

  private async route(utterance: number, text: string, final: boolean) {
    const tools = getTools();
    const d = await routeStream(this.conversation(text, final), tools, this.done);
    this.send({
      type: "decision",
      ms: d.ms,
      text,
      final,
      tool: d.tool,
      confidence: d.confidence,
      arg: d.arg,
      arg_confidence: d.argConfidence,
      error: d.error,
    });
    if (d.error) return;
    const min = this.ep.minConfidence;
    if (d.tool === "NONE" || d.confidence < min) return;

    if (d.tool === "BUILD") return this.fireBuild(utterance, text, d.ms);
    if (d.tool === "FORGE") return this.whenFinal(utterance, final, d.ms, () => this.fireForge(utterance, text, d.ms));
    if (d.tool === "REMEMBER") return this.whenFinal(utterance, final, d.ms, () => this.fireRemember(utterance, text));

    const tool = getTool(d.tool);
    if (!tool) return;
    const optionArg = Object.values(tool.input).some((s) => s.options);
    if (optionArg) {
      if ((d.argConfidence ?? 0) < min) return;
      await this.fireTool(utterance, tool, this.argsFromChoice(tool, d.arg, text), d.ms, text);
    } else {
      // Free-text args read best from the whole sentence, so wait for the end.
      await this.whenFinal(utterance, final, d.ms, () =>
        this.fireTool(utterance, tool, inferArgs(tool, text), d.ms, text),
      );
    }
  }

  /** Run `act` now if the sentence is finished; otherwise hold the agent quiet until it is. */
  private async whenFinal(utterance: number, final: boolean, ms: number, act: () => void | Promise<void>) {
    if (final) {
      await act();
    } else if (!this.pending.has(utterance)) {
      this.pending.add(utterance);
      await this.hold(true);
      this.send({ type: "pending", after_ms: ms });
    }
  }

  private argsFromChoice(tool: Tool, arg: string | null, text: string): Record<string, unknown> {
    const args = inferArgs(tool, text);
    if (arg != null) for (const [k, spec] of Object.entries(tool.input)) if (spec.options) args[k] = arg;
    return args;
  }

  // ── acting ───────────────────────────────────────────────────────────────────

  private firedOnce(key: string): boolean {
    if (this.fired.has(key)) return true;
    this.fired.add(key);
    return false;
  }

  private async fireTool(utterance: number, tool: Tool, args: Record<string, unknown>, ms: number, asked: string) {
    if (this.firedOnce(`${utterance}:${tool.name}:${JSON.stringify(args)}`)) return;
    this.done.push({ action: `${tool.name}(${JSON.stringify(args)})`, text: asked, page_changed: true });
    this.send({ type: "tool", tool: tool.name, args, decided_ms: ms });
    let result: ToolResult;
    try {
      result = await withTimeout(tool.run(args, { persona: this.persona, recentTranscript: [], emit: (e) => this.send(e as unknown as Record<string, unknown>) }), 10_000);
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    this.send({ type: "tool_result", tool: tool.name, result });
    if (result.render) {
      this.lastHtml = result.render;
      this.send({ type: "workspace", html: result.render, title: tool.name });
    }
    const outcome = result.ok ? result.say ?? "Done." : `That didn't work: ${result.error ?? "unknown error"}`;
    this.respond(asked, outcome);
  }

  private async fireBuild(utterance: number, instruction: string, ms: number) {
    if (this.firedOnce(`${utterance}:BUILD`)) return;
    this.done.push({ action: "BUILD", text: instruction, page_changed: true });
    this.send({ type: "status", text: "Building…" });
    const html = await build(instruction, this.lastHtml);
    this.lastHtml = html;
    this.send({ type: "workspace", html, title: instruction.slice(0, 48) });
    this.respond(instruction, "I put a new screen together and it's on display.");
  }

  private async fireForge(utterance: number, need: string, _ms: number) {
    if (this.firedOnce(`${utterance}:FORGE`)) return;
    this.done.push({ action: "FORGE", text: need, page_changed: true });
    this.send({ type: "status", text: "Forging a new skill…" });
    const res = await forgeSkill(need);
    if (!res.ok) {
      this.respond(need, `I couldn't safely build that tool: ${res.reason}.`);
      return;
    }
    this.send({ type: "skill_forged", name: res.skill.name, description: res.skill.description, source: res.skill.source });
    this.respond(need, `I drafted a skill called ${res.skill.name.replace(/_/g, " ")}. Approve it in settings to use it.`);
  }

  private async fireRemember(utterance: number, text: string) {
    if (this.firedOnce(`${utterance}:REMEMBER`)) return;
    try {
      const saved = await this.memory.put({
        _id: nanoid(12),
        type: "preference",
        text,
        tags: ["user", "voice"],
        salience: 0.7,
        ts: Date.now(),
      });
      this.send({ type: "memory", doc: saved, op: "write" });
    } catch {
      /* ignore */
    }
    this.respond(text, "Got it — I'll remember that.");
  }

  // ── telling the caller ─────────────────────────────────────────────────────────

  private async say(words: string) {
    if (this.pp?.readyState !== WebSocket.OPEN) return;
    this.pp.send(frame(3, Buffer.from(words, "utf8")));
    // Roughly the server's pace: ~0.6 frames of 80 ms per letter, plus end-pauses.
    const seconds = (words.match(WORD) ?? []).reduce((a, w) => {
      const pause = /[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0;
      return a + 0.08 * (w.length * 0.6 + 1 + pause);
    }, 0);
    this.sayingUntil = Math.max(this.sayingUntil, Date.now()) + seconds * 1000;
  }

  private async hold(on: boolean) {
    if (this.pp?.readyState !== WebSocket.OPEN) return;
    this.pp.send(new Uint8Array([4, on ? 1 : 0]));
  }

  /** Queue a reply so replies are spoken one at a time, in the order tools ran. */
  private respond(asked: string, result: string) {
    this.replyChain = this.replyChain.then(() => this.doRespond(asked, result)).catch(() => {});
  }

  private async doRespond(asked: string, result: string) {
    const started = Date.now();
    const now = Date.now();
    const midSentence = now - this.agentLastWord < 500 && now > this.sayingUntil;
    await this.hold(true);
    let filler = false;
    if (midSentence) {
      await this.say("One sec, let me check.");
      filler = true;
    }
    const words = new WordQueue();
    void this.writeReply(asked, result, words);
    const said: string[] = [];
    try {
      // Wait for the caller to finish before talking over them (≤20 s).
      for (let i = 0; i < 400 && this.current; i++) await sleep(50);
      let chunk = await words.get(this.ep.fillerAfterMs);
      if (chunk === TIMEOUT) {
        if (!filler) {
          await this.say("One sec.");
          filler = true;
        }
        chunk = await words.get(8000);
      }
      while (chunk !== null && chunk !== TIMEOUT) {
        await this.say(chunk);
        said.push(chunk);
        chunk = await words.get(8000);
      }
      this.send({ type: "reply", text: said.join(" "), filler, ms: Date.now() - started });
    } catch {
      this.send({ type: "reply", text: said.join(" "), error: "the reply took too long" });
    } finally {
      await this.hold(false);
    }
  }

  /** One short, in-persona sentence about what was done — streamed word by word. */
  private async writeReply(asked: string, result: string, words: WordQueue) {
    const system =
      `${this.persona.description}\n\n` +
      `You are on a live voice call. A helper has just done what the caller asked. Reply with ONE short, natural ` +
      `spoken sentence (under 14 words): say it's done, or give the one fact they asked for. Write numbers, money ` +
      `and dates as spoken words. No emojis, symbols, lists, quotes or markdown.`;
    let pending = "";
    let count = 0;
    try {
      const res = await fetch(`${this.ep.mordiemUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.ep.mordiemKey}` },
        body: JSON.stringify({
          model: this.ep.replyModel,
          stream: true,
          max_tokens: 60,
          temperature: 0.3,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Caller said: "${asked}"\nWhat was done: ${result}` },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok || !res.body) throw new Error(`reply ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:") || t.endsWith("[DONE]")) continue;
          try {
            pending += JSON.parse(t.slice(5)).choices?.[0]?.delta?.content ?? "";
          } catch {
            continue;
          }
          const parts = pending.split(" ");
          pending = parts.pop() ?? "";
          const ready = parts.filter(Boolean).join(" ");
          if (ready) {
            words.put(speakable(ready));
            count += ready.split(" ").length;
            // One sentence is enough; "Got it." alone is not one.
            if (/[.!?]$/.test(ready) && count >= 4) {
              pending = "";
              words.put(null);
              return;
            }
          }
        }
      }
    } catch {
      // the raw result below is said instead
      if (!pending && !count) pending = result;
    } finally {
      if (pending.trim()) words.put(speakable(pending.trim()));
      words.put(null);
    }
  }

  private async curate(callerText: string, agentReply: string) {
    try {
      const extracted = await extractMemories(callerText, agentReply || "");
      for (const m of extracted) {
        const near = await this.memory.search(m.text, { limit: 1 });
        if (near[0] && tokenOverlap(near[0].text, m.text) > 0.6) continue;
        const saved = await this.memory.put({ _id: nanoid(12), ts: Date.now(), ...m });
        this.send({ type: "memory", doc: saved, op: "write" });
      }
    } catch {
      /* ignore */
    }
  }
}
