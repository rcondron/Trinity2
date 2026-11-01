import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { getEndpoints } from "../settings.js";
import { dueForVoice, getActivePersona, getProfileName } from "../db/sqlite.js";
import type { MemoryStore } from "../db/memory.js";
import { act, type Outcome } from "../agent/act.js";
import { contextFor } from "../agent/context.js";
import { fallbackReply, speakable, streamReply } from "../agent/reply.js";
import { decide, firing, confidentOptions, type Decision, type RecentAction } from "../agent/router.js";
import { bg, safeInterval } from "../util/bg.js";
import { wordsForNumbers } from "../tools/schedule.js";
import { curateExchange, curationAfter } from "./curator.js";
import { voicePromptFile as mapVoiceFile } from "./voices.js";
import type { Persona, TranscriptTurn } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORD = /\S+/g;
const FRAME_BYTES = 3840; // 80 ms of 16-bit mono PCM @ 24 kHz
const PING_MS = 20_000; // keeps the Runpod proxy from idling the PersonaPlex socket
const BROWSER_PING_MS = 10_000; // detects tabs that vanished without a close frame
const DG_KEEPALIVE_MS = 4_000; // Deepgram closes after ~10s without audio
const STANDBY_IDLE_MS = 15 * 60_000; // release the GPU session if nobody talks for 15 min
const MAX_VOICE_PROMPT = 200;
const PEND_HOLD_MAX_MS = 8_000; // a sentence-end action that never resolves can't mute the agent
const MAX_QUEUED_SPEECH_MS = 1_500; // keep at most this much forced speech queued at the pod
const OUTCOME_WAIT_MS = 35_000; // past an action's own limits (argument extraction ≤ 16s, then the tool's 15s)
const FIRST_WORDS_MS = 12_000; // the reply writer falls back on its own after 10s
const FINALIZE_WAIT_MS = 1_200; // mic off: how long Deepgram's Finalize result may take
const ECHO_COVER = 0.7; // share of the caller's words that must be one in-order piece of the agent's words
const READY_WAIT_MS = 15_000; // an announcement waits this long for a call that's still connecting

/** Words as spoken, apostrophes dropped so "let's" matches a transcribed "lets": "Let's begin!" → ["lets", "begin"]. */
const spokenWords = (s: string) => s.toLowerCase().replace(/['’]/g, "").match(/[a-z0-9]+/g) ?? [];

/**
 * The longest run of `text`'s words found contiguously, in order, in `tail`. An echo is a PIECE
 * of what the agent just said; a caller reusing a word or two of it ("no, let's begin" after
 * "…or say let's begin") or naming the same people ("Thorin attacks the goblin" over "…lunges
 * toward Thorin") only matches a short run.
 */
function echoRun(text: string, tail: string): { run: number; words: number } {
  const a = spokenWords(text);
  const b = spokenWords(tail);
  let run = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > run) run = k;
    }
  }
  return { run, words: a.length };
}

/**
 * Voice prompt filename for PersonaPlex: "NATF2" → "NATF2.pt", "custom:ava" → "ava.wav";
 * anything that isn't a real preset (e.g. "NATF9", which would fail the session) → the default voice.
 */
export function voicePromptFile(voice: string): string {
  return mapVoiceFile(voice, getEndpoints().personaplexVoice || "NATF2");
}

/**
 * The text that conditions PersonaPlex. Every token costs a model step at connect
 * (measured 42 chars → 4.5s, 520 chars → 9.4s), and an EMPTY prompt hangs the server,
 * so: the persona's short voice prompt, else its first sentence — never empty. When the
 * caller's name is known it rides along as one short sentence (≤ ~60 chars) so the voice
 * can use it.
 */
export function voicePromptText(p: Persona, override?: string, callerName: string | null = getProfileName()): string {
  const pick = (override ?? p.voicePrompt ?? "").trim() || (p.description.split(/(?<=[.!?])\s/)[0] ?? "").trim();
  const text = pick || `You are ${p.name}, a helpful voice assistant.`;
  const base = text.length > MAX_VOICE_PROMPT ? `${text.slice(0, MAX_VOICE_PROMPT - 1).replace(/\s+\S*$/, "")}.` : text;
  if (!callerName) return base;
  return `${base}${/[.!?]$/.test(base) ? "" : "."} The caller's name is ${callerName}.`;
}

/** Optional hook so the voices module can make sure a custom voice exists on the pod first. */
let voiceResolver: ((voice: string) => Promise<string>) | null = null;
export function setVoiceResolver(fn: (voice: string) => Promise<string>): void {
  voiceResolver = fn;
}

/** A protocol frame: a 1-byte kind followed by its body. */
function frame(kind: number, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind;
  out.set(body, 1);
  return out;
}
const SILENCE_FRAME = frame(1, new Uint8Array(FRAME_BYTES));

class BusyError extends Error {}

/** Async word queue with a timed get (TIMEOUT on expiry). */
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
      const onValue = (v: string | null) => {
        clearTimeout(t);
        resolve(v);
      };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(onValue);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(TIMEOUT);
      }, ms);
      this.waiters.push(onValue);
    });
  }
}

export interface CallOpts {
  voice?: string;
  prompt?: string;
  /** Open warm: connect PersonaPlex + Deepgram now, wait for the mic. */
  standby?: boolean;
  /** Opened for a "wake" (sent when no session exists): it never takes the voice from one that came up since. */
  wake?: boolean;
}

/** The engine owns at most one PersonaPlex session (the pod serves one per GPU). */
let activeCall: VoiceCall | null = null;

/** How an unprompted line went in the call: said in full; cut off by the caller; or not said (no call, or it went away). */
export type Spoken = "said" | "cut" | "unsaid";

/**
 * Say something unprompted in the live call — a due reminder, a finished background job
 * ("your new skill is ready"). It waits for a call that's still connecting, its turn behind
 * any reply, and until the caller stops talking. Resolves "said" once the whole line was said;
 * "cut" when the caller cut it off (talked over it, or ended the turn) — show it, but don't say
 * it again; "unsaid" when there's no call, or it closes or doesn't connect in time (deliver it
 * some other way).
 */
export function announce(text: string): Promise<Spoken> {
  return activeCall ? activeCall.announce(text) : Promise.resolve("unsaid");
}

/** Whether a voice call is up or connecting (an announcement can be said in it). */
export function hasVoiceCall(): boolean {
  return activeCall !== null;
}

/**
 * One real-time call (ported from the personaplex-toolcall reference): a persistent
 * PersonaPlex socket does the talking; Deepgram transcribes the caller live beside it;
 * the agent core (Jev router → act → reply writer) is polled on the in-progress
 * sentence. After an action the reply is streamed and PersonaPlex is MADE to say it
 * (0x03), held quiet (0x04) while the caller is still talking.
 */
export class VoiceCall {
  private pp?: WebSocket;
  private dg?: WebSocket;
  private persona: Persona;
  private ep = getEndpoints();

  private lines: string[] = []; // finished turns, oldest first
  private agentPending = ""; // what PersonaPlex has said since the caller last spoke
  private agentWords: string[] = []; // rolling tail of everything PersonaPlex said (echo gate)
  private finals = "";
  private interim = "";
  private utterance = 0;
  private fired = new Set<string>();
  private toolCurated = new Map<number, Promise<Outcome>[]>(); // the actions fired for each utterance (see curate)
  private done: RecentAction[] = [];
  private lastRouted = "";
  private routing = false;
  private agentLastWord = 0;
  private sayingUntil = 0;
  private lastCallerWordAt = 0;
  private lastCallerEndAt = 0;

  /** Why the agent is being held quiet: "pend:<utterance>" or "reply:<id>" → since. */
  private holds = new Map<string, number>();
  private holdSent = false;
  private replyChain: Promise<void> = Promise.resolve();
  private replyActive = 0;
  private bargedIn = false;

  private timers: ReturnType<typeof setInterval>[] = [];
  private lastAudioAt = 0;
  private lastActivityAt = Date.now(); // mic audio, typed turns, replies — the standby idle clock
  private micOn: boolean;
  /** Mic off: "waiting" for Deepgram's Finalize result, then "ended" (its late leftovers are dropped). */
  private micOff: "waiting" | "ended" | null = null;
  private micOffTimer?: ReturnType<typeof setTimeout>;
  private dgBuffer: Buffer[] = [];
  private dgRetries = 0;
  private browserAlive = true;
  /** The pod said hello: before that it's conditioning on the prompt, and words sent to it are lost. */
  private ready = false;
  private closed = false;
  private resolveStopped!: () => void;
  private stopped = new Promise<void>((r) => (this.resolveStopped = r));

  constructor(
    private browser: WebSocket,
    private memory: MemoryStore,
    private opts: CallOpts,
  ) {
    this.persona = getActivePersona();
    this.micOn = !opts.standby;
    // Before any await: a hang-up during the handshake must cancel it (and free the GPU).
    this.browser.on("message", (data, isBinary) => this.onBrowser(data, isBinary));
    this.browser.on("close", () => this.stop());
    this.browser.on("error", () => this.stop());
    this.browser.on("pong", () => (this.browserAlive = true));
  }

  private send(ev: Record<string, unknown>) {
    if (this.browser.readyState === WebSocket.OPEN) this.browser.send(JSON.stringify(ev));
  }

  private get current(): string {
    return `${this.finals} ${this.interim}`.trim();
  }

  private get isGameMaster(): boolean {
    return this.persona.toolsets.includes("game");
  }

  /** Reference format — what Jev reads as the page text. */
  private conversation(text: string, final: boolean): string {
    let recent = this.lines.slice(-8).join("\n");
    if (this.agentPending.trim()) recent += `\nAgent: ${this.agentPending.trim()}`;
    const state = final ? "finished speaking" : "may still be speaking";
    return `Conversation so far, oldest first:\n${recent || "(nothing yet)"}\n\nCaller's latest words (${state}): ${text}`;
  }

  private transcript(): TranscriptTurn[] {
    return this.lines.slice(-6).map((l, i) => ({
      id: `l${i}`,
      speaker: l.startsWith("Caller:") ? "user" : "trinity",
      text: l.replace(/^(Caller|Agent): /, ""),
      ts: Date.now(),
    }));
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.ep.personaplexWsUrl) {
      this.send({ type: "status", text: "No streaming PersonaPlex configured — set its URL in Settings.", error: true });
      this.stop();
      return;
    }
    // A session that came up since the "wake" (a tab on screen, another browser) keeps the voice.
    if (this.opts.wake && activeCall && activeCall !== this) {
      this.evict("Voice is open in another window.");
      return;
    }
    // One session per GPU: take over from any previous call (another tab, a reload, a persona switch).
    const previous = activeCall;
    activeCall = this;
    if (previous && previous !== this) {
      previous.evict("Voice moved to another window.");
      await Promise.race([previous.stopped, sleep(3000)]);
    }
    if (this.closed) return;
    this.send({ type: "status", text: "Connecting to the voice model…" });

    let dgReadyRef: Promise<WebSocket | undefined> | undefined;
    try {
      const started = Date.now();
      // Deepgram connects while the voice is resolved and PersonaPlex handshakes; a Deepgram
      // failure degrades to talk-only.
      const dgReady = this.connectDeepgram().catch((err: Error) => {
        this.send({ type: "status", text: `Transcription unavailable (${err.message}) — talk-only mode.` });
        return undefined;
      });
      dgReadyRef = dgReady;
      let voiceFile = voicePromptFile(this.opts.voice ?? this.persona.voice);
      if (voiceResolver) {
        // Built-ins resolve instantly; a custom sample may need checking/uploading on the pod
        // (the voices module bounds that at 15 s).
        try {
          voiceFile = await Promise.race([
            voiceResolver(this.opts.voice ?? this.persona.voice),
            sleep(16_000).then(() => {
              throw new Error("voice sync timed out");
            }),
          ]);
        } catch (err) {
          voiceFile = `${getEndpoints().personaplexVoice || "NATF2"}.pt`;
          this.send({ type: "status", text: `Custom voice unavailable (${(err as Error).message}) — using the default voice.` });
        }
      }
      // Hung up or replaced while the voice was checked: don't take the pod's one session.
      if (this.closed) throw new Error("call closed");
      const params = new URLSearchParams({
        voice_prompt: voiceFile,
        text_prompt: voicePromptText(this.persona, this.opts.prompt),
        pcm: "1",
        no_wait: "1",
      });
      const [pp, dg] = await Promise.all([
        this.connectPersonaplexWithRetry(`${this.ep.personaplexWsUrl}/api/chat?${params}`),
        dgReady,
      ]);
      if (this.closed) {
        pp.terminate();
        dg?.close();
        return;
      }
      this.pp = pp;
      // Deepgram dropped during the handshake (its close went unwatched until now): reconnect it.
      if (dg && dg.readyState !== WebSocket.OPEN) this.onDeepgramLost();
      else this.dg = dg;
      this.flushDgBuffer();
      this.ready = true;
      this.send({ type: "ready", handshake_ms: Date.now() - started, standby: !this.micOn, persona: this.persona.name });
    } catch (err) {
      this.send({ type: "status", text: `Could not connect: ${(err as Error).message}`, error: true, busy: err instanceof BusyError });
      // Deepgram may still be connecting (or connected) on its own — never leave it open.
      void dgReadyRef?.then((dg) => dg?.close()).catch(() => {});
      this.stop();
      return;
    }

    this.timers.push(safeInterval("router", () => this.routerTick(), this.ep.routeEveryMs));
    this.timers.push(safeInterval("pump", () => this.pumpTick(), 80));
    this.timers.push(
      safeInterval(
        "pp-ping",
        () => {
          if (this.pp?.readyState === WebSocket.OPEN) this.pp.ping();
        },
        PING_MS,
      ),
    );
    this.timers.push(
      safeInterval(
        "browser-ping",
        () => {
          if (!this.browserAlive) {
            this.browser.terminate();
            this.stop();
            return;
          }
          this.browserAlive = false;
          if (this.browser.readyState === WebSocket.OPEN) this.browser.ping();
        },
        BROWSER_PING_MS,
      ),
    );
    this.timers.push(safeInterval("housekeeping", () => this.housekeeping(), 1000));
  }

  /** Connect with ?no_wait=1; while the pod is still releasing a previous session it answers "busy" — retry. */
  private async connectPersonaplexWithRetry(url: string): Promise<WebSocket> {
    const delays = [500, 1000, 2000, 4000];
    for (let i = 0; ; i++) {
      try {
        return await this.connectPersonaplex(url);
      } catch (err) {
        if (!(err instanceof BusyError) || i >= delays.length || this.closed) {
          if (err instanceof BusyError)
            throw new BusyError("the voice model is busy with another session (another tab or device?)");
          throw err;
        }
        await sleep(delays[i]!);
      }
    }
  }

  private connectPersonaplex(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      // Stopped meanwhile (e.g. during a busy-retry sleep, when stop() had no socket to cancel):
      // a new socket would take the pod's one-session lock from the call that replaced this one.
      if (this.closed) return reject(new Error("call closed"));
      const ws = new WebSocket(url, { maxPayload: 0, perMessageDeflate: false });
      this.pp = ws; // tracked now so stop() cancels a queued/in-flight session
      let hello = false;
      const to = setTimeout(() => {
        ws.terminate();
        reject(new Error("the voice model didn't answer within 60s"));
      }, 60_000);
      ws.on("message", (data: RawData, isBinary: boolean) => {
        const buf = data as Buffer;
        if (!hello) {
          hello = true;
          clearTimeout(to);
          if (isBinary && buf[0] === 0x00) resolve(ws);
          else {
            ws.close();
            reject(new Error("the voice model refused the session"));
          }
          return;
        }
        this.onPersonaplex(buf, isBinary);
      });
      ws.on("error", (e) => {
        clearTimeout(to);
        if (!hello) reject(e);
      });
      ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(to);
        if (!hello) {
          const why = reason.toString() || `code ${code}`;
          reject(code === 1013 ? new BusyError(why) : new Error(`the voice model closed the connection (${why})`));
          return;
        }
        if (this.pp === ws) this.stop();
      });
    });
  }

  private connectDeepgram(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      if (!this.ep.deepgramKey) return reject(new Error("no Deepgram key"));
      const url = new URL(this.ep.deepgramUrl);
      // Character descriptions have long pauses; give the Game Master a longer endpoint.
      if (this.isGameMaster) url.searchParams.set("endpointing", "700");
      const ws = new WebSocket(url.toString(), {
        headers: { Authorization: `Token ${this.ep.deepgramKey}` },
        perMessageDeflate: false,
      });
      let opened = false;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const to = setTimeout(() => {
        ws.terminate();
        reject(new Error("Deepgram timed out"));
      }, 10_000);
      ws.on("open", () => {
        opened = true;
        clearTimeout(to);
        this.dgRetries = 0;
        // Deepgram closes a stream that gets nothing for ~10s. Audio only goes to the adopted
        // socket, so this one hears nothing while PersonaPlex is still handshaking — or with the mic off.
        let lastKeepAlive = 0;
        keepAlive = safeInterval(
          "dg-keepalive",
          () => {
            if (this.closed) return void ws.close(); // never keep a finished call's stream alive
            const now = Date.now();
            const audioFlowing = this.dg === ws && now - this.lastAudioAt <= DG_KEEPALIVE_MS - 1000;
            if (ws.readyState !== WebSocket.OPEN || audioFlowing || now - lastKeepAlive < DG_KEEPALIVE_MS) return;
            ws.send(JSON.stringify({ type: "KeepAlive" }));
            lastKeepAlive = now;
          },
          1000,
        );
        resolve(ws);
      });
      ws.on("message", (data: RawData) => this.onDeepgram(data as Buffer));
      ws.on("error", (e) => {
        clearTimeout(to);
        if (!opened) reject(e);
      });
      ws.on("close", () => {
        clearInterval(keepAlive);
        if (opened && this.dg === ws) this.onDeepgramLost();
      });
    });
  }

  /** Deepgram dropped mid-call: finish the utterance, free the agent, reconnect with backoff. */
  private onDeepgramLost() {
    this.dg = undefined;
    if (this.closed) return;
    if (this.current) this.endUtterance();
    this.releasePendingHolds();
    if (this.dgRetries >= 5) {
      this.send({ type: "status", text: "Transcription lost — tools are paused for this call." });
      return;
    }
    const delay = 1000 * 2 ** this.dgRetries++;
    this.send({ type: "status", text: "Transcription reconnecting…" });
    bg("deepgram-reconnect", async () => {
      await sleep(delay);
      if (this.closed) return;
      try {
        const dg = await this.connectDeepgram();
        if (this.closed) return void dg.close(); // hung up while it reconnected
        this.dg = dg;
        this.flushDgBuffer();
        this.send({ type: "status", text: "Transcription back." });
      } catch {
        this.onDeepgramLost();
      }
    });
  }

  private flushDgBuffer() {
    if (this.dg?.readyState !== WebSocket.OPEN) return;
    for (const b of this.dgBuffer) this.dg.send(b);
    this.dgBuffer = [];
  }

  /** Another window took the voice session. */
  evict(reason: string): void {
    this.send({ type: "status", text: reason, evicted: true });
    this.stop();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (activeCall === this) activeCall = null;
    for (const t of this.timers) clearInterval(t);
    try {
      if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      /* ignore */
    }
    this.dg?.close();
    const pp = this.pp;
    if (pp && pp.readyState !== WebSocket.CLOSED) {
      const done = () => this.resolveStopped();
      pp.once("close", done);
      setTimeout(done, 1500);
      pp.terminate();
    } else {
      this.resolveStopped();
    }
    if (this.browser.readyState === WebSocket.OPEN) this.browser.close();
  }

  // ── holds, silence pump, housekeeping ────────────────────────────────────────

  /** Hold the agent quiet while ANY reason is active; send 0x04 only on transitions. */
  private setHold(reason: string, on: boolean) {
    if (on) this.holds.set(reason, Date.now());
    else this.holds.delete(reason);
    const want = this.holds.size > 0;
    if (want !== this.holdSent && this.pp?.readyState === WebSocket.OPEN) {
      this.pp.send(new Uint8Array([4, want ? 1 : 0]));
      this.holdSent = want;
    }
  }

  private releasePendingHolds() {
    for (const r of [...this.holds.keys()]) if (r.startsWith("pend:")) this.setHold(r, false);
  }

  /** Drop the agent's queued forced words (pods with the 0x05 patch; ignored by others). */
  private flushSpeech() {
    if (this.pp?.readyState === WebSocket.OPEN) this.pp.send(new Uint8Array([5]));
    this.sayingUntil = Date.now();
  }

  /**
   * PersonaPlex only advances when input audio arrives. While the browser isn't
   * streaming (mic off / standby / typed turns) and the agent has something to say,
   * feed it silence so forced words are actually spoken; idle standby stays frozen.
   */
  private pumpTick() {
    if (this.pp?.readyState !== WebSocket.OPEN) return;
    const browserStreaming = this.micOn && Date.now() - this.lastAudioAt < 250;
    if (browserStreaming) return;
    const busy = this.replyActive > 0 || this.holds.size > 0 || Date.now() < this.sayingUntil + 600;
    if (busy) this.pp.send(SILENCE_FRAME);
  }

  private housekeeping() {
    const now = Date.now();
    for (const [r, since] of this.holds) {
      if (r.startsWith("pend:") && now - since > PEND_HOLD_MAX_MS) this.setHold(r, false);
    }
    // (Deepgram's KeepAlive runs per socket — see connectDeepgram.) Typed turns and replies count
    // as use too, and a reply in progress is never cut off.
    if (!this.micOn && this.replyActive === 0 && now - this.lastActivityAt > STANDBY_IDLE_MS) {
      // A reminder or task coming up keeps the voice warm, so it's said aloud rather than only shown.
      if (dueForVoice(now + STANDBY_IDLE_MS).length) return;
      this.send({ type: "status", text: "Voice session paused after 15 minutes idle.", idle: true });
      this.stop();
    }
  }

  // ── browser & audio plumbing ───────────────────────────────────────────────────

  private onBrowser(data: RawData, isBinary: boolean) {
    if (!isBinary) {
      let m: { type?: string; on?: boolean; text?: string };
      try {
        m = JSON.parse((data as Buffer).toString());
      } catch {
        return;
      }
      if (m.type === "stop") this.stop();
      else if (m.type === "mic") this.setMic(Boolean(m.on));
      else if ((m.type === "text" || m.type === "inject_utterance") && typeof m.text === "string" && m.text.trim()) {
        // Typed turn (or a test): behave exactly as if Deepgram had delivered this finished sentence.
        this.lastActivityAt = Date.now();
        if (this.current) this.endUtterance();
        this.finals = m.text.trim().slice(0, 2000);
        this.interim = "";
        const text = this.current;
        this.send({ type: "caller", final: true, text, typed: true });
        this.endUtterance(true);
      }
      return;
    }
    // 16-bit PCM @ 24 kHz from the mic → Deepgram as-is, PersonaPlex as kind 1.
    const buf = data as Buffer;
    this.lastAudioAt = this.lastActivityAt = Date.now();
    if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(buf);
    else if (this.dgBuffer.length < 25) this.dgBuffer.push(buf); // ≤ 2s until Deepgram opens
    if (this.pp?.readyState === WebSocket.OPEN) this.pp.send(frame(1, buf));
  }

  private setMic(on: boolean) {
    if (this.micOn === on) return;
    this.micOn = on;
    clearTimeout(this.micOffTimer);
    this.micOff = null;
    if (!on) {
      // Call ended: stop talking, let go of holds, and make Deepgram finish the last words.
      this.bargedIn = true;
      this.flushSpeech();
      this.releasePendingHolds();
      this.micOff = "waiting";
      if (this.dg?.readyState === WebSocket.OPEN) {
        this.dg.send(JSON.stringify({ type: "Finalize" }));
        // Its from_finalize result ends the utterance (onDeepgram); this is the fallback.
        this.micOffTimer = setTimeout(() => this.endMicOffUtterance(), FINALIZE_WAIT_MS);
      } else this.endMicOffUtterance();
    }
    this.send({ type: "mic", on });
  }

  /** The mic went off: end the caller's last words, once — whatever Deepgram sends after is dropped. */
  private endMicOffUtterance() {
    if (this.micOff !== "waiting" || this.closed) return;
    this.micOff = "ended";
    clearTimeout(this.micOffTimer);
    const text = this.current;
    this.endUtterance();
    if (text) this.send({ type: "caller", final: true, text });
  }

  private onPersonaplex(buf: Buffer, isBinary: boolean) {
    if (!isBinary || buf.length === 0) return;
    const kind = buf[0];
    const body = buf.subarray(1);
    if (kind === 1) {
      if (this.browser.readyState === WebSocket.OPEN) this.browser.send(body);
    } else if (kind === 2) {
      const word = body.toString("utf8");
      this.agentPending += word;
      this.agentLastWord = Date.now();
      for (const w of word.match(WORD) ?? []) this.agentWords.push(w);
      if (this.agentWords.length > 60) this.agentWords.splice(0, this.agentWords.length - 60);
      this.send({ type: "agent", text: word });
    }
  }

  /**
   * Speaker bleed: the agent's own voice transcribed as if the caller said it — most of the text
   * is one in-order run (≥ minRun words) of what the agent said in the last moments. Two words
   * are enough to hold off barge-in and mid-sentence routing; dropping a finished sentence takes
   * three, so a short real answer that repeats the agent ("let's begin") still gets through.
   */
  private isEcho(text: string, minRun = 2): boolean {
    const now = Date.now();
    const agentSpeaking = now - this.agentLastWord < 1500 || now < this.sayingUntil;
    if (!agentSpeaking) return false;
    const { run, words } = echoRun(text, this.agentWords.slice(-30).join(" "));
    return run >= minRun && run / Math.max(1, words) >= ECHO_COVER;
  }

  private onDeepgram(buf: Buffer) {
    let m: {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean;
      from_finalize?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m.type === "UtteranceEnd") {
      const text = this.current;
      this.endUtterance();
      if (text) this.send({ type: "caller", final: true, text });
    } else if (m.type === "Results") {
      // Mic off and its last words already ended (Finalize was slow): this is a late copy of them.
      if (this.micOff === "ended") return;
      const said = m.channel?.alternatives?.[0]?.transcript ?? "";
      if (said) this.lastCallerWordAt = Date.now();
      if (m.is_final) {
        this.finals = `${this.finals} ${said}`.trim();
        this.interim = "";
      } else {
        this.interim = said;
      }
      const text = this.current;
      // Barge-in: the caller talks over a reply we're injecting → drop the rest of it.
      if (Date.now() < this.sayingUntil && (text.match(WORD)?.length ?? 0) >= 2 && !this.isEcho(text)) {
        this.bargedIn = true;
        this.flushSpeech();
      }
      this.send({ type: "caller", text, final: false });
      if (m.from_finalize && this.micOff === "waiting") this.endMicOffUtterance();
      else if (m.speech_final) {
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
    if (this.isEcho(text)) return; // the agent's own voice — never act on it mid-sentence
    this.lastRouted = text;
    this.routing = true;
    try {
      await this.route(this.utterance, text, false);
    } finally {
      this.routing = false;
    }
  }

  private endUtterance(typed = false) {
    const text = this.current;
    const agentReply = this.agentPending.trim();
    this.finals = "";
    this.interim = "";
    this.lastRouted = "";
    if (!text) return;
    this.lastCallerEndAt = Date.now();
    if (!typed && this.isEcho(text, 3)) {
      this.send({ type: "status", text: "(ignored the agent's own voice picked up by the mic)" });
      this.releasePendingHolds();
      return;
    }
    if (agentReply) this.lines.push(`Agent: ${agentReply}`);
    this.agentPending = "";
    this.lines.push(`Caller: ${text}`);
    const utterance = this.utterance++;
    // One last look at the whole sentence — the words that matter often come last.
    const routed = this.route(utterance, text, true);
    bg("route-final", routed);
    if (contextFor(this.persona).curate) bg("curate", this.curate(utterance, routed, text, agentReply));
  }

  private async route(utterance: number, text: string, final: boolean) {
    if (!final && utterance !== this.utterance) return; // the sentence already ended
    let fired = false;
    try {
      const d = await decide({ persona: this.persona, conversation: this.conversation(text, final), done: this.done });
      if (this.closed || (!final && utterance !== this.utterance)) return; // stale mid-sentence answer
      this.send({
        type: "decision",
        ms: d.ms,
        text,
        final,
        tool: d.action,
        confidence: d.confidence,
        options: d.options,
        error: d.error,
      });
      const policy = firing(d, final, this.ep.minConfidence);
      if (policy === "fire") fired = this.fire(utterance, d, text);
      else if (policy === "hold" && !this.holds.has(`pend:${utterance}`)) {
        this.setHold(`pend:${utterance}`, true); // keep the agent quiet until the sentence ends
        this.send({ type: "pending", action: d.action, after_ms: d.ms });
      }
    } finally {
      // A held sentence-end action that the final pass didn't confirm must free the agent.
      if (final && !fired) this.setHold(`pend:${utterance}`, false);
    }
  }

  /** Start the action WITHOUT awaiting it, and reserve the reply slot now (replies stay in order). */
  private fire(utterance: number, d: Decision, text: string): boolean {
    const options = confidentOptions(d, this.ep.minConfidence);
    const key = `${utterance}:${d.action}:${JSON.stringify(options)}`;
    if (this.fired.has(key)) return true;
    this.fired.add(key);
    // Reference-format recent action, recorded at fire time so Jev won't repeat it.
    this.done.push({
      action: `${d.action}(${Object.values(options).join(",")})`,
      kind: "tool",
      text,
      page_changed: true,
    });
    const replyId = nanoid(6);
    this.setHold(`reply:${replyId}`, true);
    this.setHold(`pend:${utterance}`, false);
    const ctx = contextFor(this.persona);
    const outcome = act(d, text, {
      persona: this.persona,
      memory: this.memory,
      emit: (e) => this.send(e),
      recentTranscript: this.transcript(),
      situation: ctx.summary,
      minConfidence: this.ep.minConfidence,
    }).catch(
      (err: Error): Outcome => ({ ok: false, say: `That didn't work: ${err.message}`, action: d.action, args: {} }),
    );
    if (ctx.curate) this.toolCurated.set(utterance, [...(this.toolCurated.get(utterance) ?? []), outcome]); // (see curate)
    this.replyChain = this.replyChain.then(() => this.doRespond(text, outcome, replyId)).catch(() => {});
    return true;
  }

  // ── telling the caller ─────────────────────────────────────────────────────────

  /** See the module-level announce(). Digits become words ("9:22 PM" → "nine twenty-two PM"): the voice reads words. */
  async announce(text: string): Promise<Spoken> {
    const line = speakable(wordsForNumbers(text));
    if (!line) return "unsaid";
    // Still connecting: wait for the pod's hello (words sent before it are lost), but not for long.
    const until = Date.now() + READY_WAIT_MS;
    while (!this.ready && !this.closed && Date.now() < until) await sleep(100);
    if (!this.ready || this.closed || this.pp?.readyState !== WebSocket.OPEN) return "unsaid";
    this.send({ type: "announce", text: line });
    const spoken = this.replyChain.then(() => this.speakUnprompted(line)).catch((): Spoken => "unsaid");
    this.replyChain = spoken.then(() => {});
    return spoken;
  }

  /** How far the line got: "cut" when the caller cut it off (a barge-in, or the tap that ended the turn), "unsaid" when the call went away first. */
  private async speakUnprompted(line: string): Promise<Spoken> {
    this.replyActive++;
    this.lastActivityAt = Date.now();
    const holdId = `announce:${nanoid(6)}`;
    try {
      // Never cut the caller off: wait (up to 20 s) for a pause in their speech.
      const until = Date.now() + 20_000;
      while (!this.closed && Date.now() < until && (this.current || Date.now() - this.lastCallerWordAt < 1200)) await sleep(150);
      if (this.closed) return "unsaid";
      this.bargedIn = false;
      this.setHold(holdId, true);
      let sent = true;
      for (const s of line.split(/(?<=[.!?])\s+/)) if (s && sent) sent = !this.bargedIn && (await this.say(s));
      // (What PersonaPlex says comes back as its word echo, which the transcript already records.)
      while (!this.closed && !this.bargedIn && Date.now() < this.sayingUntil) await sleep(100);
      if (this.bargedIn) return "cut";
      return sent && !this.closed ? "said" : "unsaid";
    } finally {
      this.setHold(holdId, false);
      this.replyActive--;
      this.lastActivityAt = Date.now();
    }
  }

  private fillers() {
    return this.isGameMaster
      ? { mid: "Hmm, one moment.", wait: "Let me see.", slow: "Hmm, that's taking longer than it should." }
      : { mid: "One sec, let me check.", wait: "One sec.", slow: "Sorry, that's taking longer than it should." };
  }

  /** Make PersonaPlex say these words; false when they didn't go out (cut off, or the call is gone). */
  private async say(words: string): Promise<boolean> {
    if (this.pp?.readyState !== WebSocket.OPEN) return false;
    // Pace delivery so little is queued at the pod — a barge-in then loses almost nothing.
    while (this.sayingUntil - Date.now() > MAX_QUEUED_SPEECH_MS && !this.bargedIn && !this.closed) await sleep(80);
    if (this.bargedIn || this.closed) return false;
    this.pp.send(frame(3, Buffer.from(words, "utf8")));
    // Roughly the server's pace: ~0.6 frames of 80 ms per letter, plus end-pauses.
    const seconds = (words.match(WORD) ?? []).reduce((a, w) => {
      const pause = /[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0;
      return a + 0.08 * (w.length * 0.6 + 1 + pause);
    }, 0);
    this.sayingUntil = Math.max(this.sayingUntil, Date.now()) + seconds * 1000;
    return true;
  }

  private async doRespond(asked: string, outcomeP: Promise<Outcome>, replyId: string) {
    this.replyActive++;
    this.lastActivityAt = Date.now();
    this.bargedIn = false;
    const started = Date.now();
    const fill = this.fillers();
    let filler = false;
    const said: string[] = [];
    try {
      const now = Date.now();
      // PersonaPlex talking on its own (not words we gave it) → acknowledge first.
      if (now - this.agentLastWord < 500 && now > this.sayingUntil) {
        await this.say(fill.mid);
        filler = true;
      }
      // Don't talk over the caller — but only while words keep coming (≤ 3s).
      const waitUntil = Date.now() + 3000;
      while (this.current && Date.now() - this.lastCallerWordAt < 1200 && Date.now() < waitUntil) await sleep(50);

      const words = new WordQueue();
      // Reference behaviour: if nothing is ready ~0.5s after we could speak, say a short filler.
      let fillerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        fillerTimer = null;
        if (!filler && !said.length) {
          filler = true;
          void this.say(fill.wait);
        }
      }, this.ep.fillerAfterMs);

      // The action has its own limits (argument extraction, then the tool's timeout); this bound only
      // keeps a hung one from holding the agent quiet forever. The first-words wait starts after it.
      const outcome = await Promise.race([outcomeP, sleep(OUTCOME_WAIT_MS).then(() => undefined)]);
      void (async () => {
        if (!outcome) return words.put(fill.slow);
        if (outcome.speak) {
          // Grounded lines (narration/answers) are spoken as written, a sentence at a time.
          for (const s of speakable(wordsForNumbers(outcome.speak)).split(/(?<=[.!?])\s+/)) if (s) words.put(s);
          return;
        }
        // Read the situation AFTER the action: the reply must describe the world as it is now.
        const ctx = contextFor(this.persona);
        // The voice reads words: a writer's "9:35 PM" goes out as "nine thirty-five PM". A chunk that ends in a number, a
        // currency sign, "a.m." (also "7a.m."), a decade's "30s", a range's "-", "to" or "and", a scale ("$5 million"), or
        // a word the reader reads the next number by ("at 10:30:00" is a clock time, "between $5 and $10" a range, "on
        // 3/4" a date, "for 30s" seconds, "in 1453" a year) waits for the next one, which may hold its unit or the rest
        // ("$2.5" "million", "$" "40", "7 a.m." "tomorrow", "$40 -" "50", "$5 million" "dollars"), so the two are read
        // together. ("By" isn't one: "cut it by" "2/3" is a fraction, though "by 2/3" alone would read as a date.)
        let held = "";
        try {
          await streamReply(
            { persona: this.persona, asked, outcome: outcome.say, situation: ctx.summary, style: ctx.style, inProgress: outcome.inProgress },
            (chunk) => {
              held = held ? `${held} ${chunk}` : chunk;
              if (/(?:[\d°$€£¥₹₩฿]|\d0s|(?<![A-Za-z_])[ap]\.m\.|\d\s*(?:[-–—]|\bto|\band|(?:thousand|million|billion|trillion)\b)|\b(?:at|between|on|due|until|till|through|thru|since|starting|from|around|before|after|in|for|rest|hold|every|each|wait|within))$/i.test(held)) return;
              words.put(wordsForNumbers(held));
              held = "";
            },
          );
        } finally {
          if (held) words.put(wordsForNumbers(held));
        }
      })()
        .catch(() => words.put(wordsForNumbers(fallbackReply(outcome?.say ?? ""))))
        .finally(() => words.put(null));

      let chunk = await words.get(FIRST_WORDS_MS);
      let more = true;
      if (chunk === TIMEOUT && outcome) {
        // The writer is stuck even past its own fallback: say what happened plainly — and only that.
        chunk = wordsForNumbers(fallbackReply(outcome.say));
        more = false;
      }
      let firstMs: number | null = null;
      while (chunk !== null && chunk !== TIMEOUT && !this.bargedIn && !this.closed) {
        if (fillerTimer) {
          clearTimeout(fillerTimer);
          fillerTimer = null;
        }
        await this.say(chunk);
        firstMs ??= Date.now() - started;
        said.push(chunk);
        chunk = more ? await words.get(8000) : null;
      }
      if (fillerTimer) clearTimeout(fillerTimer);
      this.send({
        type: "reply",
        text: said.join(" "),
        filler,
        // first_ms: until the first reply words went to the voice; ms: until the last did.
        first_ms: firstMs,
        ms: Date.now() - started,
        action: outcome?.action,
        interrupted: this.bargedIn,
        ...(outcome ? {} : { error: "the action didn't finish in time" }),
      });
    } catch {
      this.send({ type: "reply", text: said.join(" "), error: "the reply took too long" });
    } finally {
      this.replyActive--;
      this.lastActivityAt = Date.now();
      this.setHold(`reply:${replyId}`, false);
    }
  }

  /**
   * Auto-curation of the caller's last words (deduped; picks up their name too) — once the sentence's
   * last routing pass is in and what it fired has finished, in the light of what that did (see
   * curationAfter: skipped after a remember that worked).
   */
  private async curate(utterance: number, routed: Promise<void>, callerText: string, agentReply: string) {
    await routed.catch(() => {});
    const outcomes = await Promise.all(this.toolCurated.get(utterance) ?? []);
    this.toolCurated.delete(utterance);
    const how = curationAfter(outcomes.map((o) => ({ action: o.action, ok: o.ok })));
    if (how === "skip") return;
    try {
      for (const doc of await curateExchange(this.memory, callerText, agentReply || "", { handled: how ?? undefined, agentFirst: true }))
        this.send({ type: "memory", doc, op: "write" });
    } catch {
      /* ignore */
    }
  }
}
