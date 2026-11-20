import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { getEndpoints, live } from "../settings.js";
import { dueForVoice, getActivePersona, getProfileName } from "../db/sqlite.js";
import { endSession, logTurn, recentTurns, startSession } from "../db/conversations.js";
import { profileForPrompt } from "./profile.js";
import { getSpeechRate, onSpeechRateChange } from "./speech-rate.js";
import { converse, talkCaps, type TalkInput, type TalkResult } from "./talk.js";
import { relevantMemories } from "../tools/ask.js";
import { getTool } from "../tools/registry.js";
import type { MemoryStore } from "../db/memory.js";
import { act, type Outcome } from "../agent/act.js";
import { contextFor } from "../agent/context.js";
import { fallbackReply, speakable, streamReply } from "../agent/reply.js";
import { pendingQuestion, yesOrNo } from "../agent/pending.js";
import { decide, firing, confidentOptions, type Decision, type RecentAction } from "../agent/router.js";
import { bg, safeInterval } from "../util/bg.js";
import { readAfter, wordsForNumbers } from "../tools/schedule.js";
import { curateExchange, curationAfter } from "./curator.js";
import { voicePromptFile as mapVoiceFile } from "./voices.js";
import { soundsLikeAsk } from "../agent/arbiter.js";
import { workspace } from "../workspace/bus.js";
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
/** After a reply or an announcement the agent stays quiet until the user speaks again — no made-up follow-ups… */
const QUIET_HOLD = "quiet:after-reply";
const QUIET_AFTER_MS = 5_000; // …or until a few seconds past the end of her words, whichever comes first
const MAX_QUEUED_SPEECH_MS = 1_500; // keep at most this much forced speech queued at the pod
const OUTCOME_WAIT_MS = 35_000; // past an action's own limits (argument extraction ≤ 16s, then the tool's 15s)
const FIRST_WORDS_MS = 12_000; // the reply writer falls back on its own after 10s
const FINALIZE_WAIT_MS = 1_200; // mic off: how long Deepgram's Finalize result may take
const ECHO_COVER = 0.7; // share of the user's words that must be one in-order piece of the agent's words
const READY_WAIT_MS = 15_000; // an announcement waits this long for a call that's still connecting
/** An unprompted line no voice could say (owed) is said by the next call that can be heard — if one comes this soon. */
const OWED_MAX_AGE_MS = 10 * 60_000;
const OWED_MAX = 5; // at most this many wait; with more, the oldest stays as the text it was shown as
/** The polished talk style: the voice never improvises. Held for the whole call, it speaks only the words it is given. */
const TALK_HOLD = "talk:polished";
/** A reply to half a thought ("I want to…") waits this long for the rest before it is said. */
const UNFINISHED_WAIT_MS = 700;
/** The talking brain's first sentence has to be there by then (its model calls have their own, shorter limits). */
const TALK_FIRST_MS = 10_000; // (the talking brain's own worst case is 1.2 s to the backup + 8 s: it gives up first)
/** Once the reply's first sentence is written, Jev gets until this long after the user stopped to claim the turn for a tool. */
const JEV_PATIENCE_MS = 1_500;
/** Memories for the talking brain are looked up for at most this long: talk never waits on the store. */
const TALK_MEMORY_MS = 250;
/** A new call picks up the conversation of the last half hour (a reload, a re-warm, an engine restart), not a blank. */
const CARRY_OVER_MS = 30 * 60_000;
/** A line spoken verbatim (a tool's `speak`) runs to about this many words; the rest waits for "keep going". */
const SPEAK_BUDGET_WORDS = 90;
const MORE_TO_SAY = "There's more. Say keep going to hear the rest.";
/** The pod answers every audio frame with one of its own: fed and silent for this long, the link is dead. */
const POD_SILENT_MS = 8_000;

/** One clear word is enough to cut a reply off. */
const STOP_WORD = /^(?:(?:okay|ok|hey|please|trinity)[, ]+)*(?:stop|wait|hold on|quiet|enough|never ?mind|cancel|shush|shh+)(?: (?:it|that|please|talking))?[.!?]*$/i;
const KEEP_GOING = /^(?:(?:okay|ok|yes|yeah|please|and)[, ]+)*(?:keep going|go on|continue|carry on|read (?:me )?(?:the )?(?:rest|more)|more|what(?:'s| is) next|the rest)(?: please)?[.!?]*$/i;

/** Half a thought: the words trail off on one that expects more ("I want to", "and then the"), a comma or an ellipsis. */
const TRAILS_OFF =
  /(?:\b(?:and|but|or|because|if|when|while|the|a|an|my|your|our|their|um|uh|er)|\b(?:want|need|going|have|like|trying|able|how) to|,|…|\.\.\.)[.!?]?$/i;
export function looksUnfinished(text: string): boolean {
  return TRAILS_OFF.test(text.trim());
}

/** The first part of a long line to say now (whole sentences, about `budget` words) and what's left for "keep going". */
export function splitForSpeech(text: string, budget = SPEAK_BUDGET_WORDS): { now: string; rest: string } {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let words = 0;
  let i = 0;
  for (; i < sentences.length; i++) {
    const n = (sentences[i]!.match(/\S+/g) ?? []).length;
    if (i > 0 && words + n > budget) break;
    words += n;
  }
  return { now: sentences.slice(0, i).join(" "), rest: sentences.slice(i).join(" ") };
}

/** How a finished sentence's routing ended: a tool took it, the talking brain answers it, or Jev asked the brain to. */
type RouteEnd = "fired" | "talk" | "brain";
const RECENT_USE_MS = 10_000; // a standby that heard, was typed or said something this recently isn't lent out: the user may go on
const LOAN_GRACE_MS = 2_500; // a returned loan is kept this long for a batch's next sample before the voice is freed

/** Words as spoken, apostrophes dropped so "let's" matches a transcribed "lets": "Let's begin!" → ["lets", "begin"]. */
const spokenWords = (s: string) => s.toLowerCase().replace(/['’]/g, "").match(/[a-z0-9]+/g) ?? [];

/**
 * The longest run of `text`'s words found contiguously, in order, in `tail`. An echo is a PIECE
 * of what the agent just said; a user reusing a word or two of it ("no, let's begin" after
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
 * so: the persona's short voice prompt, else its first sentence — never empty.
 *
 * Do NOT put the user's name (Settings → Memory "Your name") in this prompt.
 * PersonaPlex treats text_prompt as its own identity; any other proper name made it
 * open with "Hello, this is <user>". The brain/memory still know the user's name
 * for conversation — only the voice handshake stays name-free.
 */
export function voicePromptText(p: Persona, override?: string): string {
  const who = (p.name || "Trinity").split(/[—\-–|:/]/)[0]!.trim() || "Trinity";
  const pick = (override ?? p.voicePrompt ?? "").trim() || (p.description.split(/(?<=[.!?])\s/)[0] ?? "").trim();
  let text = pick || `You are ${who}, a helpful voice assistant.`;
  // Make the agent name unmistakable when a custom prompt forgot to lead with it.
  if (!new RegExp(String.raw`\byou are\b[^.]{0,40}\b${who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "i").test(text)) {
    text = `You are ${who}. ${text}`;
  }
  return text.length > MAX_VOICE_PROMPT ? `${text.slice(0, MAX_VOICE_PROMPT - 1).replace(/\s+\S*$/, "")}.` : text;
}

/** Optional hook so the voices module can make sure a custom voice exists on the pod first. */
let voiceResolver: ((voice: string) => Promise<string>) | null = null;
export function setVoiceResolver(fn: (voice: string) => Promise<string>): void {
  voiceResolver = fn;
}

/** A protocol frame: a 1-byte kind followed by its body. */
export function frame(kind: number, body: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = kind;
  out.set(body, 1);
  return out;
}
export const SILENCE_FRAME = frame(1, new Uint8Array(FRAME_BYTES));

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

/**
 * Who has that session: nobody; a warm standby; a live call ("call": someone is talking or being
 * answered, or was in the last 10 s); one still connecting; or a voice sample (see lendVoice).
 */
export type VoiceUse = "nobody" | "standby" | "call" | "warming" | "sample";

export function voiceUse(): VoiceUse {
  if (loan) return "sample";
  return activeCall ? activeCall.use() : "nobody";
}

/** The session, lent out for a voice sample. A call that starts cuts it short (`aborted` says why). */
export interface VoiceLoan {
  /** Settles when the borrower has given the voice back (returnVoice). */
  readonly done: Promise<void>;
  readonly aborted: string | null;
  onAbort(cb: (why: string) => void): void;
}

class Loan implements VoiceLoan {
  aborted: string | null = null;
  borrows = 0;
  /** Runs out when nobody borrowed the voice again after it was returned: then it's free. */
  grace?: ReturnType<typeof setTimeout>;
  private settled = Promise.resolve();
  private settle = () => {};
  private abortWatchers: ((why: string) => void)[] = [];

  get done(): Promise<void> {
    return this.settled;
  }
  borrow(): void {
    clearTimeout(this.grace);
    if (this.borrows++ === 0) this.settled = new Promise((r) => (this.settle = r));
  }
  release(): void {
    if (this.borrows > 0 && --this.borrows === 0) this.settle();
  }
  onAbort(cb: (why: string) => void): void {
    if (this.aborted !== null) cb(this.aborted);
    else this.abortWatchers.push(cb);
  }
  abort(why: string): void {
    if (this.aborted !== null) return;
    this.aborted = why;
    clearTimeout(this.grace);
    for (const cb of this.abortWatchers.splice(0)) cb(why);
  }
}

/** The loan out right now, or resting in its grace period (null: nothing lent). */
let loan: Loan | null = null;

/** Tells the app tabs that the voice is free again after a loan, or went to a call instead (index.ts broadcasts it). */
let voiceNotifier: ((status: "free" | "taken") => void) | null = null;
export function setVoiceNotifier(fn: (status: "free" | "taken") => void): void {
  voiceNotifier = fn;
}

/**
 * Borrow the session for something that isn't a call — a voice sample. Null while it's in use (a
 * live call, or one still connecting — see voiceUse). A warm standby is let go first: its tab is
 * told, and re-warms when the voice is free again. A loan already out, or in its grace period, is
 * shared. The borrower always gives it back with returnVoice, however the borrowing went.
 */
export async function lendVoice(what: string): Promise<VoiceLoan | null> {
  if (loan) {
    if (loan.aborted !== null) return null; // a call is taking the voice back right now
    loan.borrow();
    return loan;
  }
  const use = voiceUse();
  if (use === "call" || use === "warming") return null;
  const ln = new Loan();
  ln.borrow();
  loan = ln; // before the standby is let go: a call starting meanwhile aborts the loan instead of racing it
  await activeCall?.lendOut(what);
  return ln;
}

/**
 * Give a loan back. The voice is kept for a moment (a batch's next sample arrives within it and
 * reuses the loan); then it's free, and the tabs are told so the one that lent it re-warms.
 */
export function returnVoice(borrowed: VoiceLoan): void {
  if (!(borrowed instanceof Loan)) return;
  borrowed.release();
  if (borrowed !== loan || borrowed.borrows > 0 || borrowed.aborted !== null) return;
  clearTimeout(borrowed.grace);
  borrowed.grace = setTimeout(() => {
    if (loan !== borrowed || borrowed.borrows > 0) return;
    loan = null;
    voiceNotifier?.("free");
  }, LOAN_GRACE_MS);
}

/**
 * How an unprompted line went: said in full in the call; cut off by the user; owed — no call that
 * can be heard was up, so the next one says it (see owe); or unsaid (nothing in it to say, no turn
 * to show it as, or no live voice set up).
 */
export type Spoken = "said" | "cut" | "owed" | "unsaid";

/**
 * Say something unprompted in the live voice — a due reminder, a finished background job ("your
 * new skill is ready"). It waits for a call that's still connecting, its turn behind any reply,
 * and until the user stops talking. Resolves "said" once the whole line was said; "cut" when the
 * user cut it off (talked over it, or ended the turn) — show it, but don't say it again; "owed"
 * when no call that can be heard was up (none, its tab has had no tap or key press yet, or it went
 * away mid-line): show it now, and the next call that's up and can be heard says it. No other voice
 * ever reads it. `turnId` is the turn the line is shown as (that call's tab drops the text once it's
 * said); without one, a line no call could say is "unsaid".
 */
export async function announce(text: string, turnId?: string): Promise<Spoken> {
  const spoken = activeCall ? await activeCall.announce(text, turnId) : "unsaid";
  return spoken === "unsaid" && turnId && owe(text, turnId) ? "owed" : spoken;
}

/**
 * A line no voice could say when it came, kept for the next call that's up and can be heard
 * (VoiceCall.drainOwed): oldest first, at most OWED_MAX, and only while it's under OWED_MAX_AGE_MS
 * old — an older one stays the text it was shown as.
 */
interface OwedLine {
  text: string;
  turnId: string;
  at: number;
}
const owed: OwedLine[] = [];

/** The owed lines still worth saying, oldest first (stale ones are dropped). */
function freshOwed(now = Date.now()): OwedLine[] {
  while (owed.length && now - owed[0]!.at > OWED_MAX_AGE_MS) owed.shift();
  return owed;
}

/**
 * Keep a line for the next voice that can be heard: a call that's up but can't be heard yet asks its
 * tab for a tap; with no call anywhere, the tabs are asked to warm one (a "wake"). False when no live
 * voice is set up (browser-speech mode reads it instead) or there's nothing in it to say.
 */
function owe(text: string, turnId: string): boolean {
  if (!live.stream || !speakable(wordsForNumbers(text))) return false;
  freshOwed().push({ text, turnId, at: Date.now() });
  if (owed.length > OWED_MAX) owed.splice(0, owed.length - OWED_MAX);
  if (activeCall) activeCall.askForTap();
  else wakeNotifier?.();
  return true;
}

/** How many lines wait for a voice that can be heard (see owe). */
export function owedLines(): number {
  return freshOwed().length;
}

/** Asks the app tabs to warm a voice (index.ts broadcasts a "wake"): a line is owed and no call is up anywhere. */
let wakeNotifier: (() => void) | null = null;
export function setWakeNotifier(fn: () => void): void {
  wakeNotifier = fn;
}

/** A line for the live call's record (what was pressed in a card): Jev and the talking brain read it. */
export function noteInCall(text: string): void {
  activeCall?.noteLine(text);
}

/** Whether a voice call is up or connecting (an announcement can be said in it). A sample's loan isn't one: nobody to tell. */
export function hasVoiceCall(): boolean {
  return activeCall !== null;
}

/**
 * One real-time call (ported from the personaplex-toolcall reference): a persistent
 * PersonaPlex socket does the talking; Deepgram transcribes the user live beside it;
 * the agent core (Jev router → act → reply writer) is polled on the in-progress
 * sentence. After an action the reply is streamed and PersonaPlex is MADE to say it
 * (0x03), held quiet (0x04) while the user is still talking.
 */
export class VoiceCall {
  private pp?: WebSocket;
  private dg?: WebSocket;
  private persona: Persona;
  private ep = getEndpoints();

  private lines: string[] = []; // finished turns, oldest first
  private agentPending = ""; // what PersonaPlex has said since the user last spoke
  private agentWords: string[] = []; // rolling tail of everything PersonaPlex said (echo gate)
  private finals = "";
  private interim = "";
  private utterance = 0;
  private fired = new Set<string>();
  /** Utterances a tool fired for (mid-sentence or at the end). */
  private firedFor = new Set<number>();
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
  private quietUntil = 0; // when QUIET_HOLD lapses on its own (see goQuiet)
  private replyChain: Promise<void> = Promise.resolve();
  private replyActive = 0;
  private bargedIn = false;
  /** Its tab can play what the voice says (it reported playback set up, or opened the mic): only then is a line announced here. */
  private audible: boolean;
  private drainingOwed = false;
  private askedForTap = false; // its tab was asked for a tap to hear an owed line (see askForTap)
  /** Polished talk (Settings: talk style, and a text model to write it): the voice only speaks words it is given. */
  private polished = false;
  /** The talking brain's reply to the latest sentence, while it is being written or said. */
  private talking: { utterance: number; stop: AbortController; spoke: boolean } | null = null;
  private talkFailures = 0;
  /** What was left of a long line read out: "keep going" says the next part. */
  private remainder = "";
  /** Counts the times the user cut in: a reply queued before one doesn't speak after it. */
  private interruptions = 0;
  /** While a filler ("One moment.") is being said: talking over it doesn't cancel the reply behind it. */
  private fillerUntil = 0;
  private fillerTurn = 0;
  private lastPodFrameAt = 0;
  /** This call in the conversation log (db/conversations.ts). */
  private session = "";

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
  private unsubSpeechRate: (() => void) | null = null;
  private resolveStopped!: () => void;
  private stopped = new Promise<void>((r) => (this.resolveStopped = r));

  constructor(
    private browser: WebSocket,
    private memory: MemoryStore,
    private opts: CallOpts,
  ) {
    this.persona = getActivePersona();
    this.micOn = !opts.standby;
    this.audible = this.micOn; // a call opened with the mic on came from a tap, which set playback up
    // What was said in the last half hour carries over (Jev and the talking brain read these lines).
    this.lines = recentTurns(8, { withinMs: CARRY_OVER_MS }).map((t) => `${t.speaker === "user" ? "User" : "Agent"}: ${t.text}`);
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
    // (A finished sentence is already the last line: Jev gets it once, as the latest words.)
    const lines = final && this.lines[this.lines.length - 1] === `User: ${text}` ? this.lines.slice(0, -1) : this.lines;
    let recent = lines.slice(-8).join("\n");
    if (this.agentPending.trim()) recent += `\nAgent: ${this.agentPending.trim()}`;
    const state = final ? "finished speaking" : "may still be speaking";
    return `Conversation so far, oldest first:\n${recent || "(nothing yet)"}\n\nUser's latest words (${state}): ${text}`;
  }

  private transcript(n = 6): TranscriptTurn[] {
    return this.lines.slice(-n).map((l, i) => ({
      id: `l${i}`,
      speaker: l.startsWith("User:") ? "user" : l.startsWith("System:") ? "system" : "trinity",
      text: l.replace(/^(User|Agent|System): /, ""),
      ts: Date.now(),
    }));
  }

  /** Something that happened that the user didn't say (a press in a card): a line of the conversation's record. */
  noteLine(text: string): void {
    if (this.closed) return;
    this.lines.push(`System: ${text}`);
    if (this.lines.length > 60) this.lines.splice(0, this.lines.length - 60);
    logTurn(this.session, { speaker: "system", text });
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
    // A voice sample has the session on loan: take it back (a wake too — a due reminder beats a sample).
    const borrowed = loan;
    if (borrowed) {
      borrowed.abort("a call started");
      await Promise.race([borrowed.done, sleep(3000)]);
      if (loan === borrowed) loan = null;
      voiceNotifier?.("taken");
      if (this.closed) return; // hung up while the sample let go
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
      // …or never came up at all. Without it no tool hears the user, so one failure isn't final: keep trying.
      if (dg && dg.readyState === WebSocket.OPEN) this.dg = dg;
      else if (this.ep.deepgramKey) this.onDeepgramLost();
      this.flushDgBuffer();
      this.ready = true;
      this.lastPodFrameAt = Date.now();
      this.session = startSession("call", this.persona.name);
      // Polished talk: the voice is held for the whole call and says only what it is given (see talk()).
      this.polished = this.ep.talkStyle !== "free" && live.mordiem;
      if (this.polished) this.setHold(TALK_HOLD, true);
      this.send({
        type: "ready",
        handshake_ms: Date.now() - started,
        standby: !this.micOn,
        persona: this.persona.name,
        speechRate: getSpeechRate(),
        // The context's own pace on top of the user's setting (a narrator may be slower); the tab multiplies the two.
        pace: contextFor(this.persona).voice.pace ?? 1,
        talk: this.polished ? "polished" : "free",
      });
      this.unsubSpeechRate = onSpeechRateChange((rate) => {
        if (!this.closed) this.send({ type: "speech_rate", rate });
      });
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
    // Lines owed from when no voice could say them: said now if this tab can hear them, else it's asked for a tap.
    this.drainOwed();
    this.askForTap();
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
      // A context can ask for more patience (a table of players thinking aloud) and name the words to expect.
      const tuning = contextFor(this.persona).voice;
      const endpointing = tuning.endpointingMs ? Math.round(tuning.endpointingMs) : this.isGameMaster ? 700 : 0;
      if (endpointing) {
        url.searchParams.set("endpointing", String(endpointing));
        // (The utterance-end fallback mustn't undercut the endpoint.)
        const fallback = Number(url.searchParams.get("utterance_end_ms")) || 1000;
        if (fallback < endpointing + 300) url.searchParams.set("utterance_end_ms", String(endpointing + 300));
      }
      for (const term of (tuning.keyterms ?? []).slice(0, 50)) if (term.trim()) url.searchParams.append("keyterm", term.trim().slice(0, 50));
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

  /** A voice sample borrows the session: the tab is told (it re-warms on the "voice: free" broadcast) and this one lets go. */
  async lendOut(what: string): Promise<void> {
    this.send({ type: "status", text: `Lent the voice out for ${what} — back in a moment.`, lent: true });
    this.stop();
    await Promise.race([this.stopped, sleep(3000)]);
  }

  /** In use (someone is talking or being answered, or a turn was heard or typed in the last 10 s), still connecting, or a free standby. */
  use(): VoiceUse {
    const now = Date.now();
    const busy =
      this.micOn ||
      this.replyActive > 0 ||
      this.turnHolds() > 0 ||
      now < this.sayingUntil ||
      // A typed turn makes no audio, and nothing marks the call busy until the router has decided (Jev
      // takes up to ~8 s): the finished turn counts too, or a sample would take the session from under its answer.
      now - Math.max(this.lastAudioAt, this.lastCallerEndAt, this.agentLastWord) < RECENT_USE_MS;
    return busy ? "call" : this.ready ? "standby" : "warming";
  }

  /** Holds that belong to a turn (not the standing hold of the polished talk style). */
  private turnHolds(): number {
    let n = 0;
    for (const k of this.holds.keys()) if (k !== TALK_HOLD) n++;
    return n;
  }

  /** How fast the tab plays the voice: the user's setting times the context's. The pitch doesn't change. */
  private pace(): number {
    // As the tab plays it (call.ts playbackRate: the user's rate times the persona's pace, within 0.5–2).
    const rate = getSpeechRate() * (contextFor(this.persona).voice.pace ?? 1);
    return Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1;
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.talking?.stop.abort();
    // The log gets her last words too, and the session ends (which queues it for reflection).
    if (this.agentPending.trim()) logTurn(this.session, { speaker: "trinity", text: this.agentPending.trim() });
    endSession(this.session);
    this.unsubSpeechRate?.();
    this.unsubSpeechRate = null;
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
    for (const r of [...this.holds.keys()]) if (r.startsWith("pend:") || r.startsWith("early:")) this.setHold(r, false);
  }

  /**
   * After a reply or an announcement: quiet until the user speaks, or until a few seconds past the end of her words,
   * whichever comes first — so she doesn't tack on an answer of her own. Not when the user has already cut in or is
   * mid-sentence: they're owed a reply to that.
   */
  private goQuiet() {
    if (this.polished || this.bargedIn || this.current) return; // (polished talk is quiet by default)
    this.quietUntil = Math.max(Date.now(), this.sayingUntil) + QUIET_AFTER_MS;
    this.setHold(QUIET_HOLD, true);
  }

  /** Drop the agent's queued forced words (pods with the 0x05 patch; ignored by others). */
  private flushSpeech() {
    if (this.pp?.readyState === WebSocket.OPEN) this.pp.send(new Uint8Array([5]));
    this.sayingUntil = Date.now();
    this.fillerUntil = 0;
    this.send({ type: "flush" }); // the tab drops what its speaker still has queued, too
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
    // (The quiet-after-reply hold has nothing to say, so it doesn't keep the pump running.)
    const busy =
      this.replyActive > 0 || [...this.holds.keys()].some((k) => k !== QUIET_HOLD && k !== TALK_HOLD) || Date.now() < this.sayingUntil + 600;
    if (busy) this.pp.send(SILENCE_FRAME);
  }

  private housekeeping() {
    const now = Date.now();
    // A half-open socket to the pod never says it's gone: audio going in and nothing coming back is how it shows.
    // End the call cleanly — the tab warms a new one — rather than leave the user talking to silence.
    if (this.ready && this.micOn && now - this.lastAudioAt < 500 && now - this.lastPodFrameAt > POD_SILENT_MS) {
      this.send({ type: "status", text: "The voice stopped answering — reconnecting.", error: true });
      this.stop();
      return;
    }
    for (const [r, since] of this.holds) {
      if ((r.startsWith("pend:") || r.startsWith("early:")) && now - since > PEND_HOLD_MAX_MS) this.setHold(r, false);
      if (r === QUIET_HOLD && now > this.quietUntil) this.setHold(r, false);
    }
    // (Deepgram's KeepAlive runs per socket — see connectDeepgram.) Typed turns and replies count
    // as use too, and a reply in progress is never cut off.
    if (!this.micOn && this.replyActive === 0 && now - this.lastActivityAt > STANDBY_IDLE_MS) {
      // A reminder or task coming up keeps the voice warm, so it's said aloud rather than only shown —
      // and so does a line still owed (it's said once this tab can hear it).
      if (dueForVoice(now + STANDBY_IDLE_MS).length || freshOwed().length) return;
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
      else if (m.type === "playback" && m.on) this.setAudible(); // a tap or key press there set playback up (call.ts)
      else if ((m.type === "text" || m.type === "inject_utterance") && typeof m.text === "string" && m.text.trim()) {
        // Typed turn (or a test): behave exactly as if Deepgram had delivered this finished sentence.
        this.lastActivityAt = Date.now();
        // (The spoken words before it end once — Deepgram's late copy of them is then dropped.)
        if (this.micOff === "waiting") this.endMicOffUtterance();
        else if (this.current) this.endUtterance();
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
    // Audio again after a pause: the pod has had nothing to answer, so its silence so far says nothing about it.
    if (Date.now() - this.lastAudioAt > 1000) this.lastPodFrameAt = Date.now();
    this.lastAudioAt = this.lastActivityAt = Date.now();
    if (this.dg?.readyState === WebSocket.OPEN) this.dg.send(buf);
    else if (this.dgBuffer.length < 25) this.dgBuffer.push(buf); // ≤ 2s until Deepgram opens
    if (this.pp?.readyState === WebSocket.OPEN) this.pp.send(frame(1, buf));
  }

  private setMic(on: boolean) {
    if (on) this.setAudible(); // the mic tap set playback up too (call.ts openMic)
    if (this.micOn === on) return;
    this.micOn = on;
    clearTimeout(this.micOffTimer);
    this.micOff = null;
    if (!on) {
      // The turn ended: let go of holds, and make Deepgram finish the last words. The tap cuts off what she is
      // saying right then — an answer still on its way is still owed (tap to talk, tap again, then listen).
      if (Date.now() < this.sayingUntil) {
        this.bargedIn = true;
        this.interruptions++;
        this.talking?.stop.abort();
      }
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

  /** The mic went off: end the user's last words, once — whatever Deepgram sends after is dropped. */
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
    this.lastPodFrameAt = Date.now();
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
   * Speaker bleed: the agent's own voice transcribed as if the user said it — most of the text
   * is one in-order run (≥ minRun words) of what the agent said in the last moments. Two words
   * are enough to hold off barge-in and mid-sentence routing; dropping a finished sentence takes
   * three, so a short real answer that repeats the agent ("let's begin") still gets through.
   */
  private isEcho(text: string, minRun = 2): boolean {
    const now = Date.now();
    const agentSpeaking = now - this.agentLastWord < 1500 || now < this.sayingUntil;
    if (!agentSpeaking) return false;
    const { run, words } = echoRun(text, this.agentWords.slice(-30).join(" "));
    // Too short for the run rule ("Sure.", "Wait"): her own only when every word is among her last few, in order.
    if (words > 0 && words < minRun) return run === words && echoRun(text, this.agentWords.slice(-8).join(" ")).run === words;
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
      const earlyKey = `early:${this.utterance}`;
      if (said) {
        this.lastCallerWordAt = Date.now();
        // The user is talking again (not the agent's own tail in the mic): the agent may answer.
        if (this.holds.has(QUIET_HOLD) && !this.isEcho(said)) this.setHold(QUIET_HOLD, false);
        // A reply still being written for their last words, and they're talking again: the rest of the thought gets the answer.
        if (this.talking && !this.talking.spoke && !this.isEcho(said)) this.talking.stop.abort();
      }
      if (m.is_final) {
        this.finals = `${this.finals} ${said}`.trim();
        this.interim = "";
      } else {
        this.interim = said;
      }
      const text = this.current;
      // A request or a question waits for the decision from its first words: Deepgram marks the end of speech ~300 ms
      // after the words stop, and mid-sentence routing runs only every routeEveryMs, so a voice that isn't held by then
      // answers on its own — "I can't…" — and the tool's reply has to take it back. Released at the sentence end when
      // nothing fires (route), or after PEND_HOLD_MAX_MS of no new words (housekeeping). It follows the words: "can you
      // hear" waits, "can you hear me" (just talk) doesn't.
      if (said && !this.isEcho(text)) this.setHold(earlyKey, soundsLikeAsk(text));
      // Barge-in: the user talks over a reply we're injecting → drop the rest of it, at the pod and in the tab's
      // speaker. Two words, or one that plainly means stop. Over a filler only the filler goes: the reply behind it
      // is still owed, and is said once they've finished.
      const cutIn = (text.match(WORD)?.length ?? 0) >= 2 || STOP_WORD.test(text.trim());
      if (Date.now() < this.sayingUntil && cutIn && !this.isEcho(text)) {
        if (Date.now() >= this.fillerUntil) {
          this.bargedIn = true;
          this.interruptions++;
          this.talking?.stop.abort();
        }
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
    // A yes or a no while she waits for one, ending a moment after her own last word: her own "Sure." or "Okay."
    // through the speakers, misheard enough to slip past the echo check. A real answer comes after she has finished.
    if (!typed && pendingQuestion() && yesOrNo(text) !== null && (text.match(WORD)?.length ?? 0) <= 3 && Date.now() - this.agentLastWord < 900) {
      this.send({ type: "status", text: "(a yes or no heard while she was still finishing was not taken as the answer)" });
      this.releasePendingHolds();
      return;
    }
    // "Stop" between two of her sentences stops her too (a cut-in is only seen while words are being said).
    if (STOP_WORD.test(text.trim()) && (this.replyActive > 0 || this.talking !== null || Date.now() < this.sayingUntil + 1000)) {
      this.bargedIn = true;
      this.interruptions++;
      this.talking?.stop.abort();
      this.flushSpeech();
    }
    if (agentReply) {
      this.lines.push(`Agent: ${agentReply}`);
      logTurn(this.session, { speaker: "trinity", text: agentReply });
    }
    this.agentPending = "";
    this.lines.push(`User: ${text}`);
    logTurn(this.session, { speaker: "user", text });
    this.setHold(QUIET_HOLD, false); // the user has spoken: the agent may answer this
    const utterance = this.utterance++;
    // One last look at the whole sentence — the words that matter often come last.
    const routed = this.route(utterance, text, true);
    bg("route-final", routed);
    // Polished talk: the talking brain starts on its reply now, beside Jev's last look; a tool that fires takes the turn.
    if (this.polished) this.talk(utterance, text, routed);
    if (contextFor(this.persona).curate) bg("curate", this.curate(utterance, routed, text, agentReply));
  }

  private async route(utterance: number, text: string, final: boolean): Promise<RouteEnd> {
    if (!final && utterance !== this.utterance) return "talk"; // the sentence already ended
    let fired = false;
    let brain = false;
    // A finished sentence: the agent waits for the decision (released below when nothing fires), so it never
    // starts an answer of its own that a tool is about to contradict.
    if (final) this.setHold(`pend:${utterance}`, true);
    try {
      const d = await decide({ persona: this.persona, conversation: this.conversation(text, final), done: this.done });
      if (this.closed || (!final && utterance !== this.utterance)) return "talk"; // stale mid-sentence answer
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
      // Mirror Jev into the workspace: every non-NONE pick, and every finished sentence.
      if (d.action !== "NONE" || final) {
        workspace.agent("decision", {
          tool: d.action,
          text: final ? text : `${text}…`,
          confidence: d.confidence,
        });
      }
      const policy = firing(d, final, this.ep.minConfidence);
      // Polished talk answers a knowledge question itself, streamed (ask_brain makes the whole answer wait).
      if (policy === "fire" && this.polished && final && d.action === "ask_brain") brain = true;
      else if (policy === "fire") {
        fired = this.fire(utterance, d, text);
        // A tool that fires on a late decision takes the turn from a reply already written for the same words.
        if (fired && final && this.talking?.utterance === utterance) this.talking.stop.abort();
      }
      else if (policy === "hold" && !this.holds.has(`pend:${utterance}`)) {
        this.setHold(`pend:${utterance}`, true); // keep the agent quiet until the sentence ends
        this.send({ type: "pending", action: d.action, after_ms: d.ms });
      }
    } finally {
      // A held sentence-end action that the final pass didn't confirm must free the agent.
      if (final && !fired) this.setHold(`pend:${utterance}`, false);
      // The decision is in: the early hold has done its job (a tool that fired holds the voice for its reply now).
      if (final) this.setHold(`early:${utterance}`, false);
    }
    // Something fired for these words earlier in the sentence: the sentence is answered by that (Jev, told it was done,
    // says NONE at the end — the talking brain must not answer as well).
    if (final && !fired && this.firedFor.has(utterance)) fired = true;
    return fired ? "fired" : brain ? "brain" : "talk";
  }

  /** Start the action WITHOUT awaiting it, and reserve the reply slot now (replies stay in order). */
  private fire(utterance: number, d: Decision, text: string): boolean {
    const options = confidentOptions(d, this.ep.minConfidence);
    // One tool once per sentence: mid-sentence and final passes may read its options differently ({layout: "grid"}
    // and {}), and running it twice says its reply twice.
    const key = `${utterance}:${d.action}`;
    if (this.fired.has(key)) {
      // Already under way (it fired mid-sentence): nothing more to wait for, so the sentence's hold goes now.
      this.setHold(`pend:${utterance}`, false);
      return true;
    }
    this.fired.add(key);
    this.firedFor.add(utterance);
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
    const heard = this.interruptions;
    this.replyChain = this.replyChain.then(() => this.doRespond(text, outcome, replyId, heard)).catch(() => {});
    return true;
  }

  // ── telling the user ─────────────────────────────────────────────────────────

  /**
   * See the module-level announce(). Digits become words ("9:22 PM" → "nine twenty-two PM"): the
   * voice reads words. "unsaid" when the call isn't up in time, or its tab can't hear it yet (no tap
   * or key press there so far — said then, it would be lost): the line is owed instead. Its tab is
   * told when the line starts ("announce") and how it went ("announced", with the turn it's shown as).
   */
  async announce(text: string, turnId?: string): Promise<Spoken> {
    const line = speakable(wordsForNumbers(text));
    if (!line) return "unsaid";
    // Still connecting: wait for the pod's hello (words sent before it are lost), but not for long.
    const until = Date.now() + READY_WAIT_MS;
    while (!this.ready && !this.closed && Date.now() < until) await sleep(100);
    if (!this.ready || this.closed || this.pp?.readyState !== WebSocket.OPEN || !this.audible) return "unsaid";
    const spoken = this.replyChain.then(() => this.speakUnprompted(line, turnId)).catch((): Spoken => "unsaid");
    this.replyChain = spoken.then(() => {});
    const result = await spoken;
    if (turnId) this.send({ type: "announced", turnId, spoken: result });
    return result;
  }

  /** Say the lines owed from when no voice could (see owe), oldest first, once this call is up and its tab can hear them. */
  private drainOwed(): void {
    if (this.drainingOwed || !this.ready || this.closed || !this.audible || !freshOwed().length) return;
    this.drainingOwed = true;
    bg("owed-lines", async () => {
      try {
        while (!this.closed) {
          const line = freshOwed().shift();
          if (!line) break;
          if ((await this.announce(line.text, line.turnId)) === "unsaid") {
            owed.unshift(line); // the call went away first: the next one says it
            break;
          }
        }
      } finally {
        this.drainingOwed = false;
      }
    });
  }

  /** A line is owed and this call is up but can't be heard (no tap or key press in its tab yet): the tab asks for one, once. */
  askForTap(): void {
    if (this.askedForTap || !this.ready || this.closed || this.audible || !freshOwed().length) return;
    this.askedForTap = true;
    this.send({ type: "owed" });
  }

  /** Its tab can play what the voice says now (playback set up, or the mic opened): what's owed is said. */
  private setAudible(): void {
    if (this.audible) return;
    this.audible = true;
    this.drainOwed();
  }

  /** How far the line got: "cut" when the user cut it off (a barge-in, or the tap that ended the turn), "unsaid" when the call went away first. */
  private async speakUnprompted(line: string, turnId?: string): Promise<Spoken> {
    this.replyActive++;
    this.lastActivityAt = Date.now();
    const holdId = `announce:${nanoid(6)}`;
    try {
      // Never cut the user off: wait (up to 20 s) for a pause in their speech.
      const until = Date.now() + 20_000;
      while (!this.closed && Date.now() < until && (this.current || Date.now() - this.lastCallerWordAt < 1200)) await sleep(150);
      if (this.closed) return "unsaid";
      // It starts now: its own line in the tab's transcript, not the end of the last reply.
      this.send({ type: "announce", text: line, ...(turnId ? { turnId } : {}) });
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
      this.goQuiet();
      this.replyActive--;
      this.lastActivityAt = Date.now();
    }
  }

  // ── polished talk ────────────────────────────────────────────────────────────

  /**
   * What Trinity says when no tool takes the sentence. The talking brain (services/talk.ts) starts writing at once,
   * beside Jev's last look at the sentence, so its first words are ready about when that decision is; a tool that fires
   * takes the turn instead. The reply is said through the reply chain (one voice at a time), and dropped unsaid when
   * the user goes on talking before it starts: the rest of their thought gets the answer.
   */
  private talk(utterance: number, text: string, routed: Promise<RouteEnd>): void {
    // An older reply still being written: they've said more since, so it goes. One already being spoken stays — a
    // "yeah" or "mm-hm" from the listener isn't a cut-in (a real one flushed it in onDeepgram).
    if (this.talking && !this.talking.spoke) this.talking.stop.abort();
    if (STOP_WORD.test(text.trim())) return; // "stop": cutting her off was the whole request
    const mine = { utterance, stop: new AbortController(), spoke: false };
    this.talking = mine;
    const startedAt = Date.now();
    const sentences = new WordQueue();

    // "Keep going": the next part of a long line that was read out — no model in between.
    if (this.remainder && KEEP_GOING.test(text.trim())) {
      const { now, rest } = splitForSpeech(this.remainder);
      this.remainder = rest;
      for (const s of now.split(/(?<=[.!?])\s+/)) if (s) sentences.put(s);
      if (rest) sentences.put(MORE_TO_SAY);
      sentences.put(null);
      const read: TalkResult = { how: "said", text: now, firstMs: 0, model: null };
      this.replyChain = this.replyChain.then(() => this.doTalk(mine, text, sentences, Promise.resolve(read), startedAt)).catch(() => {});
      return;
    }

    const ctx = contextFor(this.persona);
    let firstWritten: () => void = () => {};
    const written = new Promise<void>((resolve) => (firstWritten = resolve));
    const input = async (): Promise<TalkInput> => ({
      persona: this.persona,
      transcript: this.transcript(10),
      userText: text,
      situation: ctx.summary,
      memories: await this.memoriesFor(text),
      profile: profileForPrompt(1200),
      userName: getProfileName(),
      guidance: ctx.talk.guidance,
      caps: ctx.talk.caps ? talkCaps(text, ctx.talk.caps) : undefined,
      signal: mine.stop.signal,
    });
    const result = input()
      .then((i) =>
        converse({ ...i, markers: true }, (sentence) => {
          firstWritten();
          sentences.put(sentence);
        }),
      )
      .catch((): TalkResult => ({ how: "failed", text: "", firstMs: null, model: null }))
      .finally(() => sentences.put(null));
    // In words after all (the reply was ACT and this persona has no solver to hand it to).
    const inWords = async (): Promise<string[]> => {
      const lines: string[] = [];
      await converse({ ...(await input()), markers: false }, (sentence) => lines.push(sentence)).catch(() => null);
      return lines;
    };
    bg("talk", async () => {
      // Jev normally answers first. A reply that's already written doesn't wait on a slow Jev for long: it is talk, and
      // a request would have come back as ACT, not as words.
      const patience = written.then(() => sleep(Math.max(0, JEV_PATIENCE_MS - (Date.now() - startedAt)))).then((): RouteEnd => "talk");
      const end = await Promise.race([routed.catch((): RouteEnd => "talk"), patience]);
      if (end === "fired" || this.closed) {
        mine.stop.abort();
        if (this.talking === mine) this.talking = null;
        return;
      }
      this.replyChain = this.replyChain.then(() => this.doTalk(mine, text, sentences, result, startedAt, inWords)).catch(() => {});
    });
  }

  /** Say the talking brain's reply, a sentence at a time as it is written. */
  private async doTalk(
    mine: { utterance: number; stop: AbortController; spoke: boolean },
    asked: string,
    sentences: WordQueue,
    result: Promise<TalkResult>,
    startedAt: number,
    inWords?: () => Promise<string[]>,
  ) {
    if (this.closed || mine.stop.signal.aborted) {
      if (this.talking === mine) this.talking = null;
      return;
    }
    this.replyActive++;
    this.lastActivityAt = Date.now();
    this.bargedIn = false;
    const said: string[] = [];
    let heard = "";
    let firstMs: number | null = null;
    let outcome: TalkResult = { how: "failed", text: "", firstMs: null, model: null };
    const sayNext = async (sentence: string) => {
      if (!(await this.say(readAfter(heard, sentence)))) return; // cut off, or the call is gone: not said
      mine.spoke = true;
      firstMs ??= Date.now() - startedAt;
      said.push(sentence);
      heard = `${heard} ${sentence}`.slice(-200);
    };
    try {
      // Half a thought may go on: give it a moment (the reply is being written meanwhile).
      if (looksUnfinished(asked)) {
        const until = Date.now() + UNFINISHED_WAIT_MS;
        while (Date.now() < until && !this.current && !mine.stop.signal.aborted && !this.closed) await sleep(50);
      }
      let chunk = await sentences.get(TALK_FIRST_MS);
      const timedOut = chunk === TIMEOUT;
      if (timedOut) mine.stop.abort();
      while (chunk !== null && chunk !== TIMEOUT && !this.bargedIn && !this.closed && !mine.stop.signal.aborted) {
        // They're talking again before a word was said: this reply is dropped (see onDeepgram too).
        if (!said.length && this.current && !this.isEcho(this.current)) {
          mine.stop.abort();
          break;
        }
        await sayNext(chunk);
        chunk = await sentences.get(8000);
      }
      if (this.bargedIn) mine.stop.abort();
      outcome = await result;
      // (A reply that never came is a failure like any other, though it was this wait that gave up on it.)
      const live = (!mine.stop.signal.aborted || timedOut) && !this.bargedIn && !this.closed;
      if (timedOut) outcome = { how: "failed", text: "", firstMs: null, model: outcome.model };
      if (outcome.how === "act" && live) {
        // The words ask for something to be done and Jev had no tool for them: the solver takes it — or, for a persona
        // without one, an answer in words.
        if (!this.handOff(mine.utterance, asked) && inWords) {
          for (const sentence of await inWords()) {
            if (this.bargedIn || this.closed || mine.stop.signal.aborted) break;
            await sayNext(sentence);
          }
        }
      } else if (outcome.how === "failed" && !said.length && live) {
        // No model answered. Once: say so. Twice running: the talking brain is down, so the voice goes back to
        // improvising for the rest of this call rather than leave the user with silence.
        if (++this.talkFailures >= 2) {
          this.polished = false;
          this.setHold(TALK_HOLD, false);
          this.send({ type: "status", text: "The talking brain isn't answering — the voice is on its own for now." });
        } else if (!this.current) await sayNext("Sorry, I lost my thread for a second. Could you say that again?");
      } else if (said.length) this.talkFailures = 0;
      const replyText = said.join(" ");
      this.send({
        type: "reply",
        text: replyText,
        talk: outcome.how,
        model: outcome.model,
        // first_ms: from the end of the user's words until the first sentence went to the voice.
        first_ms: firstMs,
        ms: Date.now() - startedAt,
        interrupted: this.bargedIn,
      });
      if (replyText) workspace.agent("reply", { tool: "talk", text: replyText, ok: !this.bargedIn });
    } catch {
      this.send({ type: "reply", text: said.join(" "), talk: "failed", error: "the reply took too long" });
    } finally {
      this.replyActive--;
      this.lastActivityAt = Date.now();
      if (this.talking === mine) this.talking = null;
    }
  }

  /** The words ask for something to be done: hand them to the solver, when this persona has it. */
  private handOff(utterance: number, text: string): boolean {
    const tool = getTool("figure_out");
    const ctx = contextFor(this.persona);
    if (!tool || ctx.hiddenActions.has(tool.name) || (tool.toolset && !this.persona.toolsets.includes(tool.toolset))) return false;
    const d: Decision = { action: tool.name, confidence: 1, tool, options: {}, offered: [], ms: 0 };
    this.send({ type: "decision", ms: 0, text, final: true, tool: d.action, confidence: 1, options: {}, via: "talk" });
    workspace.agent("decision", { tool: d.action, text, confidence: 1 });
    return this.fire(utterance, d, text);
  }

  /** What Trinity knows about the user that bears on these words — looked up briefly; talk never waits on the store. */
  private async memoriesFor(text: string): Promise<string[]> {
    try {
      return await Promise.race([
        relevantMemories(this.memory.search(text, { limit: 8 }), text),
        sleep(TALK_MEMORY_MS).then((): string[] => []),
      ]);
    } catch {
      return [];
    }
  }

  private fillers() {
    const tuned = (contextFor(this.persona).voice.fillers ?? []).filter((f) => f.trim());
    if (tuned.length) {
      const line = tuned[this.fillerTurn++ % tuned.length]!;
      return { mid: line, wait: line, slow: "Sorry, that's taking longer than it should." };
    }
    return this.isGameMaster
      ? { mid: "Hmm, one moment.", wait: "Let me see.", slow: "Hmm, that's taking longer than it should." }
      : { mid: "One moment.", wait: "One moment.", slow: "Sorry, that's taking longer than it should." };
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
    // (At a slower pace the tab takes longer to play what the pod says in real time; a faster one can't outrun it.)
    this.sayingUntil = Math.max(this.sayingUntil, Date.now()) + (seconds * 1000) / Math.min(1, this.pace());
    return true;
  }

  /** A filler line. While it's being said, the user talking over it stops only the filler (see onDeepgram). */
  private async sayFiller(words: string): Promise<boolean> {
    const ok = await this.say(words);
    if (ok) this.fillerUntil = this.sayingUntil;
    return ok;
  }

  private async doRespond(asked: string, outcomeP: Promise<Outcome>, replyId: string, heard = this.interruptions) {
    this.replyActive++;
    this.lastActivityAt = Date.now();
    const started = Date.now();
    const fill = this.fillers();
    const tuning = contextFor(this.persona).voice;
    let filler = false;
    const said: string[] = [];
    try {
      // The user cut in after this was queued: what it did is done and on the board, but she doesn't talk over the
      // turn they started (they'll say what they want next).
      if (heard !== this.interruptions) {
        const outcome = await Promise.race([outcomeP, sleep(OUTCOME_WAIT_MS).then(() => undefined)]);
        this.send({ type: "reply", text: "", skipped: true, action: outcome?.action, interrupted: true, ms: Date.now() - started });
        return;
      }
      this.bargedIn = false;
      const now = Date.now();
      // PersonaPlex talking on its own (not words we gave it) → acknowledge first.
      if (!this.polished && now - this.agentLastWord < 500 && now > this.sayingUntil) {
        await this.sayFiller(fill.mid);
        filler = true;
      }
      // Don't talk over the user — but only while words keep coming (≤ 3s).
      const waitUntil = Date.now() + 3000;
      while (this.current && Date.now() - this.lastCallerWordAt < 1200 && Date.now() < waitUntil) await sleep(50);

      const words = new WordQueue();
      // Reference behaviour: if nothing is ready ~0.5s after we could speak, say a short filler.
      let fillerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        fillerTimer = null;
        // (Not while the user is still talking: a filler over their words helps nobody.)
        if (!filler && !said.length && !this.current) {
          filler = true;
          void this.sayFiller(fill.wait);
        }
      }, tuning.fillerAfterMs ?? this.ep.fillerAfterMs);

      // The action has its own limits (argument extraction, then the tool's timeout); this bound only
      // keeps a hung one from holding the agent quiet forever. The first-words wait starts after it.
      const outcome = await Promise.race([outcomeP, sleep(OUTCOME_WAIT_MS).then(() => undefined)]);
      // (What a tool did is part of the conversation's record; its words hold labels, never anything from the vault.)
      if (outcome) logTurn(this.session, { speaker: "system", text: outcome.say, tool: outcome.action, ok: outcome.ok });
      void (async () => {
        if (!outcome) return words.put(fill.slow);
        if (outcome.silent) return; // words that weren't for her: no reply at all
        if (outcome.speak) {
          // Grounded lines (narration/answers) are spoken as written, a sentence at a time — up to a length a listener
          // can take in; the rest waits for "keep going".
          const { now: first, rest } = splitForSpeech(speakable(wordsForNumbers(outcome.speak)));
          this.remainder = rest;
          for (const s of first.split(/(?<=[.!?])\s+/)) if (s) words.put(s);
          if (rest) words.put(MORE_TO_SAY);
          return;
        }
        // Read the situation AFTER the action: the reply must describe the world as it is now.
        const ctx = contextFor(this.persona);
        // The voice reads words: a writer's "9:35 PM" goes out as "nine thirty-five PM". A chunk that ends in a number, a
        // currency sign, "a.m." (also "7a.m."), a decade's "30s", a range's "-", "to" or "and", a scale ("$5 million"), or
        // a word the reader reads the next number by ("at 10:30:00" is a clock time, "between $5 and $10" a range, "on
        // 3/4" a date, "for 30s" seconds, "in 1453" a year) waits for the next one, which may hold its unit or the rest
        // ("$2.5" "million", "$" "40", "7 a.m." "tomorrow", "$40 -" "50", "$5 million" "dollars"), so the two are read
        // together. Each chunk is read after the words already said (readAfter), so a rule that looks back a few words
        // ("cut the recipe" "by 2/3", "in their" "20-30s") sees them whatever the split. A decade token and a dotted
        // time wait for the next two words too, for the rules that look ahead ("30s on", "10.15 UK time").
        let held = "";
        let said = "";
        const flush = () => {
          words.put(readAfter(said, held));
          said = `${said} ${held}`.slice(-200);
          held = "";
        };
        try {
          await streamReply(
            { persona: this.persona, asked, outcome: outcome.say, situation: ctx.summary, style: ctx.style, inProgress: outcome.inProgress, failed: !outcome.ok },
            (chunk) => {
              held = held ? `${held} ${chunk}` : chunk;
              if (
                /(?:[\d°$€£¥₹₩฿]|\d0s(?:\s+\S+){0,2}|\d{1,2}\.[0-5]\d\s+(?:this|in(?:\s+the)?|UK|local|London|Paris|Berlin)|(?<![A-Za-z_])[ap]\.m\.|\d\s*(?:[-–—]|\bto|\band|(?:thousand|million|billion|trillion)\b)|\b(?:at|between|on|due|until|till|through|thru|since|starting|from|around|before|after|in|for|rest|hold|every|each|wait|within))$/i.test(
                  held,
                )
              )
                return;
              flush();
            },
          );
        } finally {
          if (held) flush();
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
        if (!said.length) {
          // The user talked through the wait (or the filler): they finish first, then the answer.
          const until = Date.now() + 3000;
          while (this.current && Date.now() - this.lastCallerWordAt < 1200 && Date.now() < until && !this.closed) await sleep(50);
          this.fillerUntil = 0;
          if (this.bargedIn || this.closed) break;
        }
        await this.say(chunk);
        firstMs ??= Date.now() - started;
        said.push(chunk);
        chunk = more ? await words.get(8000) : null;
      }
      if (fillerTimer) clearTimeout(fillerTimer);
      const replyText = said.join(" ");
      this.send({
        type: "reply",
        text: replyText,
        filler,
        // first_ms: until the first reply words went to the voice; ms: until the last did.
        first_ms: firstMs,
        ms: Date.now() - started,
        action: outcome?.action,
        interrupted: this.bargedIn,
        ...(outcome ? {} : { error: "the action didn't finish in time" }),
      });
      if (replyText) workspace.agent("reply", { tool: outcome?.action, text: replyText, ok: !this.bargedIn });
    } catch {
      this.send({ type: "reply", text: said.join(" "), error: "the reply took too long" });
    } finally {
      this.replyActive--;
      this.lastActivityAt = Date.now();
      this.setHold(`reply:${replyId}`, false);
      this.goQuiet();
    }
  }

  /**
   * Auto-curation of the user's last words (deduped; picks up their name too) — once the sentence's
   * last routing pass is in and what it fired has finished, in the light of what that did (see
   * curationAfter: skipped after a remember that worked).
   */
  private async curate(utterance: number, routed: Promise<unknown>, callerText: string, agentReply: string) {
    await routed.catch(() => {});
    const outcomes = await Promise.all(this.toolCurated.get(utterance) ?? []);
    this.toolCurated.delete(utterance);
    const how = curationAfter(outcomes.map((o) => ({ action: o.action, ok: o.ok })));
    if (how === "skip") return;
    try {
      for (const doc of await curateExchange(this.memory, callerText, agentReply || "", { handled: how ?? undefined, agentFirst: true, sessionId: this.session || undefined }))
        this.send({ type: "memory", doc, op: "write" });
    } catch {
      /* ignore */
    }
  }
}
