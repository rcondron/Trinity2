import { nanoid } from "nanoid";
import { getEndpoints } from "./settings.js";
import { getActivePersona, getProfileName } from "./db/sqlite.js";
import type { MemoryStore } from "./db/memory.js";
import { act, recentAction, type Outcome } from "./agent/act.js";
import { contextFor } from "./agent/context.js";
import { writeReply } from "./agent/reply.js";
import { confidentOptions, decide, firing, type Decision, type RecentAction } from "./agent/router.js";
import { think } from "./services/brain.js";
import { profileForPrompt } from "./services/profile.js";
import { converse, talkCaps, type TalkResult } from "./services/talk.js";
import { selectMemories } from "./services/jev.js";
import { curateExchange, curationAfter, statesOwnName, type Handled } from "./services/curator.js";
import { logTurn, recentTurns, startSession } from "./db/conversations.js";
import { announce, type Spoken } from "./services/voice-call.js";
import { personaplexTurn } from "./services/voice.js";
import { getTool, getTools } from "./tools/registry.js";
import { isReminder, reminderLine } from "./tools/schedule.js";
import { workspace } from "./workspace/bus.js";
import type { HeartbeatTask, MemoryDoc, RouteDecision, ServerEvent, TranscriptTurn } from "./types.js";

type Emit = (e: ServerEvent) => void;

/** Text-channel view of a router decision (the transcript shows these). */
function toRouteDecision(d: Decision): RouteDecision {
  const action: RouteDecision["action"] =
    d.action === "NONE"
      ? "speak"
      : d.action === "build_ui"
        ? "build"
        : d.action === "create_skill"
          ? "forge"
          : d.action === "remember" || d.action === "recall"
            ? "recall"
            : "tool";
  return {
    action,
    tool: d.action === "NONE" ? undefined : d.action,
    // Only the options the tool actually receives (Jev's answers below the confidence gate aren't used).
    args: confidentOptions(d, getEndpoints().minConfidence),
    confidence: d.confidence,
    reason: d.error ? `jev error: ${d.error}` : `jev ${d.ms}ms`,
  };
}

/**
 * Tools a scheduled run never picks: scheduling from a schedule would loop, and saving
 * memories or creating skills needs the user there. (Game tools are left out too — a
 * scheduled task must never move a story on.)
 */
const NOT_PROACTIVE = new Set(["schedule", "cancel_reminder", "change_reminder", "remember", "update_profile", "forget", "create_skill", "fix_skill", "disable_skill", "enable_skill", "answer_followup"]);

/** What Jev reads for a scheduled task: the user's own request, due now. */
function scheduledConversation(task: HeartbeatTask): string {
  return (
    `Conversation so far, oldest first:\n(The user set up a scheduled task earlier: "${task.title}". It is due now.)\n\n` +
    `User's latest words (finished speaking): ${task.instruction}`
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);

/**
 * The text channel's loop (typed turns, the legacy fal voice turns, and heartbeat).
 * It uses the same agent core as the real-time voice loop — Jev decides, actions run
 * through the same tools, and the reply writer speaks in the persona's voice — so a
 * typed request behaves exactly like a spoken one.
 */
export class Orchestrator {
  private transcript: TranscriptTurn[] = [];
  private done: RecentAction[] = [];
  /** The text channel in the conversation log (db/conversations.ts): one session per engine run, begun at the first turn. */
  private session = "";

  constructor(private memory: MemoryStore) {
    // What was said in the last half hour carries over an engine restart.
    this.transcript = recentTurns(12, { withinMs: 30 * 60_000 });
  }

  /**
   * Agent-core events → text-channel ServerEvents. A transcript line a tool sends on its own
   * (e.g. "I made a new skill…" once a background job is done) also joins this conversation,
   * so the next decision, answer or build knows about it.
   */
  private channelEmit(emit: Emit) {
    return (e: Record<string, unknown>) => {
      if (e.type === "tool") {
        emit({ type: "tool_start", tool: String(e.tool), args: (e.args as Record<string, unknown>) ?? {} });
        return;
      }
      if (e.type === "transcript" && e.turn && typeof e.turn === "object") {
        this.transcript.push(e.turn as TranscriptTurn);
        if (this.transcript.length > 40) this.transcript.shift();
      }
      emit(e as unknown as ServerEvent);
    };
  }

  /** Clear the rolling conversation — used when switching persona. */
  resetContext(): void {
    this.transcript = [];
    this.done = [];
  }

  private pushTurn(
    speaker: TranscriptTurn["speaker"],
    text: string,
    emit: Emit,
    flags: Pick<TranscriptTurn, "voiced" | "proactive" | "cut" | "owed"> = {},
    id = nanoid(8),
  ): TranscriptTurn {
    const turn: TranscriptTurn = { id, speaker, text, ts: Date.now(), ...flags };
    this.transcript.push(turn);
    // (A line the live call said in full is in the call's own record.)
    if (speaker !== "system" && !flags.voiced) {
      this.session ||= startSession("text", getActivePersona().name);
      logTurn(this.session, { speaker, text });
    }
    if (this.transcript.length > 40) this.transcript.shift();
    emit({ type: "transcript", turn });
    return turn;
  }

  /** Something that happened that the user didn't say (a press in a card): a system line in the transcript. */
  noteSystem(text: string, emit: Emit): void {
    this.pushTurn("system", text, emit);
  }

  /** Reference-format conversation text for Jev (history BEFORE the latest words). */
  private conversation(latest: string): string {
    const recent = this.transcript
      .slice(-8)
      .map((t) => `${t.speaker === "user" ? "User" : t.speaker === "system" ? "System" : "Agent"}: ${t.text}`)
      .join("\n");
    return `Conversation so far, oldest first:\n${recent || "(nothing yet)"}\n\nUser's latest words (finished speaking): ${latest}`;
  }

  /** Memories Jev picks as relevant to the turn (started beside the routing decision). */
  private async recall(userText: string): Promise<MemoryDoc[]> {
    const candidates = await this.memory.search(userText, { limit: 8 });
    return selectMemories({ userText, transcript: this.transcript }, candidates);
  }

  /** Handle one typed (or transcribed) turn. */
  async handleUserText(userText: string, emit: Emit): Promise<void> {
    const persona = getActivePersona();
    const ep = getEndpoints();
    const conversation = this.conversation(userText);
    this.pushTurn("user", userText, emit);

    const recallP = this.recall(userText).catch(() => [] as MemoryDoc[]);
    const d = await decide({ persona, conversation, done: this.done });
    emit({ type: "route", decision: toRouteDecision(d) });
    workspace.agent("decision", {
      tool: d.action,
      text: userText,
      confidence: d.confidence,
    });

    const ctx = contextFor(persona);
    let outcome: Outcome | null = null;
    let say = "";
    // What fires: the router's pick — or, when the talking brain reads the words as a request no tool took (ACT), the
    // solver. A typed request gets tried, not declined, just as on a call.
    let fired: Decision | null = firing(d, true, ep.minConfidence) === "fire" ? d : null;
    if (!fired) {
      const recalled = await recallP;
      for (const doc of recalled) emit({ type: "memory", doc, op: "recall" });
      const memories = recalled.map((m) => m.text);
      // The same talking brain as the live call (services/talk.ts): the persona, the profile, the time and the board
      // in view, and a brief answer.
      const talkInput = {
        persona,
        transcript: this.transcript,
        userText,
        situation: ctx.summary,
        memories,
        profile: profileForPrompt(1200),
        userName: getProfileName(),
        guidance: ctx.talk.guidance,
        caps: ctx.talk.caps ? talkCaps(userText, ctx.talk.caps) : undefined,
      };
      const failed = (): TalkResult => ({ how: "failed", text: "", firstMs: null, model: null });
      let talk = await converse({ ...talkInput, markers: true }, () => {}).catch(failed);
      const solver = talk.how === "act" ? getTool("figure_out") : undefined;
      if (solver && !ctx.hiddenActions.has(solver.name) && (!solver.toolset || persona.toolsets.includes(solver.toolset))) {
        fired = { action: solver.name, confidence: 1, tool: solver, options: {}, offered: [], ms: 0 };
        emit({ type: "route", decision: toRouteDecision(fired) });
        workspace.agent("decision", { tool: fired.action, text: userText, confidence: 1 });
      } else if (talk.how === "silent" && ctx.talk.silence) {
        // Not for her (chatter between players at the table): no reply, as on a call.
        return;
      } else {
        // A request nothing here can take, or a nod that still deserves an answer: the talking brain in words (as the
        // call does) — it never claims that something was done.
        if (talk.how === "act" || talk.how === "silent") talk = await converse({ ...talkInput, markers: false }, () => {}).catch(failed);
        // No model answered at all: the plain brain path, which says so honestly if it fails too.
        say = talk.how === "said" && talk.text.trim() ? talk.text.trim() : await think({ persona, transcript: this.transcript, memories: withName(memories), userText, situation: ctx.summary });
      }
    }
    if (fired) {
      outcome = await act(fired, userText, {
        persona,
        memory: this.memory,
        emit: this.channelEmit(emit),
        recentTranscript: this.transcript.slice(-6),
        situation: ctx.summary,
        minConfidence: ep.minConfidence,
      });
      this.done.push(recentAction(outcome, userText));
      // (What a tool did is part of the conversation's record: reflection reads which skills failed.)
      if (this.session) logTurn(this.session, { speaker: "system", text: outcome.say, tool: outcome.action, ok: outcome.ok });
      // Words that weren't for Trinity (talk between players at a game table): no reply, and none shown.
      if (outcome.silent) return;
      if (outcome.speak) say = outcome.speak; // grounded narration/answers, as written
      else {
        const after = contextFor(persona); // the world as the action left it
        say = await writeReply({
          persona,
          asked: userText,
          outcome: outcome.say,
          situation: after.summary,
          style: after.style,
          inProgress: outcome.inProgress,
          failed: !outcome.ok,
        });
      }
    }
    workspace.agent("reply", { tool: fired ? fired.action : undefined, text: say, ok: true });
    this.pushTurn("trinity", say, emit);
    // In the light of what the action did (see curationAfter); a recall answer is never saved back.
    const how = curationAfter(outcome ? [{ action: outcome.action, ok: outcome.ok }] : []);
    if (ctx.curate && how !== "skip") void this.curate(userText, how === "recall" ? "" : say, emit, how ?? undefined);
  }

  /** Auto-curation: extract durable memories from the latest exchange (deduped). */
  private async curate(userText: string, trinityText: string, emit: Emit, handled?: Handled): Promise<void> {
    try {
      for (const doc of await curateExchange(this.memory, userText, trinityText, { handled, sessionId: this.session || undefined })) emit({ type: "memory", doc, op: "write" });
    } catch (err) {
      console.warn("[curate] failed:", (err as Error).message);
    }
  }

  /**
   * Legacy turn-based voice (fal.ai): PersonaPlex answers the clip, then the agent
   * core listens to the transcript and fires actions (PersonaPlex already spoke).
   */
  async handleUserAudio(audioUrl: string, emit: Emit): Promise<void> {
    const persona = getActivePersona();
    const ep = getEndpoints();
    this.pushTurn("user", "🎙 (spoken)", emit);
    emit({ type: "status", text: "Trinity is responding…" });
    const turn = await personaplexTurn(audioUrl, persona);
    emit({ type: "audio", chunk: turn.audioUrl });
    const conversation = this.conversation(turn.text);
    this.pushTurn("trinity", turn.text, emit);

    // These are PersonaPlex's words about the clip, not the user's own: nothing sensitive (the vault, sign-in,
    // payment, sending, the answer to a yes/no question) is offered to the router here, and act() refuses one too.
    const hidden = new Set(getTools().filter((t) => t.sensitive).map((t) => t.name));
    const d = await decide({ persona, conversation, done: this.done, hidden });
    emit({ type: "route", decision: toRouteDecision(d) });
    workspace.agent("decision", { tool: d.action, text: turn.text, confidence: d.confidence });
    if (firing(d, true, ep.minConfidence) === "fire" && !d.tool?.sensitive) {
      const ctx = contextFor(persona);
      const outcome = await act(d, turn.text, {
        persona,
        memory: this.memory,
        emit: this.channelEmit(emit),
        recentTranscript: this.transcript.slice(-6),
        situation: ctx.summary,
        minConfidence: ep.minConfidence,
        origin: "planner",
      });
      this.done.push(recentAction(outcome, turn.text));
    }
  }

  /**
   * Say something unprompted — a due reminder, a scheduled task's result: spoken into the
   * live call if there is one, shown at once as a workspace toast, and shown to text clients
   * (transcript) once the call is done with it (see showUnprompted). With no call that can be
   * heard, it's shown at once and the next one says it (owed). Returns whether it was said in full.
   */
  async proactive(text: string, emit: Emit, title?: string): Promise<boolean> {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return false;
    workspace.toast(title ? `${clip(title, 60)}: ${clip(line, 220)}` : clip(line, 260), "info");
    const id = nanoid(8); // the turn it's shown as: a call that says it later drops that text in its tab
    const spoken = await announce(line, id);
    this.showUnprompted(line, emit, spoken, id);
    return spoken === "said";
  }

  /**
   * An unprompted line as Trinity's turn, after the call had its go at it (also a finished
   * skill's news — see forge.ts): marked voiced only if it was said in full, cut if the user cut
   * it off there (it's shown, never read out again), and owed when no call that could be heard
   * was up — the live voice says it once one is, and that tab drops this text then. Only in
   * browser-speech mode (no live voice set up) does the app read a line with the browser's voice.
   */
  showUnprompted(text: string, emit: Emit, spoken: Spoken, id?: string): void {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return;
    const flags = { proactive: true, voiced: spoken === "said", ...(spoken === "cut" ? { cut: true } : {}), ...(spoken === "owed" ? { owed: true } : {}) };
    this.pushTurn("trinity", line, emit, flags, id);
  }

  /**
   * Run a due heartbeat task as a proactive, self-initiated turn. A plain reminder ("Remind me
   * to stretch.") is said as it is, with no model calls. Anything else goes through the agent
   * core like a request the user just made: Jev decides, the tool runs and the reply writer
   * phrases the result; with no tool to run, the brain answers it (with memories) — and if the
   * brain fails, this throws rather than saying a stand-in line. Once `signal` aborts (the run's
   * time limit) it throws too, and says nothing. Returns what was said (null: a recurring task
   * with nothing worth saying).
   */
  async runHeartbeat(task: HeartbeatTask, emit: Emit, signal?: AbortSignal): Promise<string | null> {
    const name = getProfileName();
    if (isReminder(task.instruction)) {
      const line = reminderLine(task, name);
      await this.proactive(line, emit, task.title);
      return line;
    }
    const persona = getActivePersona();
    const ep = getEndpoints();
    const ctx = contextFor(persona);
    // (Hidden from the decision itself, so "Every morning, search the news…" can still search — the game's
    // tools too: offered, they'd make the router read the task as a move in the story.)
    // Nor anything sensitive (the vault, sign-in, payment, sending): those start on the user's own words only.
    const hidden = new Set([...NOT_PROACTIVE, ...getTools().filter((t) => t.toolset || t.sensitive).map((t) => t.name)]);
    const d = await decide({ persona, conversation: scheduledConversation(task), done: [], hidden });
    emit({ type: "route", decision: toRouteDecision(d) });
    workspace.agent("decision", { tool: d.action, text: task.instruction, confidence: d.confidence });

    let say: string | null;
    const usable = d.tool && !d.tool.toolset && !d.tool.sensitive && !NOT_PROACTIVE.has(d.tool.name);
    if (usable && firing(d, true, ep.minConfidence) === "fire") {
      const outcome = await act(d, task.instruction, {
        persona,
        memory: this.memory,
        emit: this.channelEmit(emit),
        recentTranscript: [],
        situation: ctx.summary,
        minConfidence: ep.minConfidence,
        origin: "scheduled",
      });
      if (outcome.speak) say = outcome.speak;
      else {
        const after = contextFor(persona);
        say = await writeReply({
          persona,
          asked: task.instruction,
          outcome: outcome.say,
          situation: after.summary,
          // Room for a short briefing; never a persona's appended setup question, nor the guidance written
          // around it ("React in ONE short sentence… the next setup question is added after your sentence").
          style: {
            ...after.style,
            maxWords: Math.max(after.style.maxWords, 45),
            maxSentences: Math.max(after.style.maxSentences, 3),
            append: undefined,
            guidance: after.style.append ? "" : after.style.guidance,
          },
          inProgress: outcome.inProgress,
        });
      }
    } else {
      const recalled = await this.memory.search(task.instruction, { limit: 4 });
      const now = new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
      const out = await think({
        persona,
        transcript: this.transcript,
        memories: withName(recalled.map((m) => m.text)),
        userText:
          `[Scheduled ${task.once ? "item" : "task"} "${task.title}", due now — it's ${now}] ${task.instruction}\n` +
          `(The user set this up earlier and may not be talking right now: say it unprompted, in one to three short spoken sentences.` +
          `${task.once ? "" : " If there's genuinely nothing worth saying, reply with just SKIP."})`,
        situation: ctx.summary,
        strict: true,
        signal,
      });
      // A one-time item doesn't come round again: no answer is a failure, not silence.
      if (task.once && !out.trim()) throw new Error("the model gave no answer");
      // "SKIP", "skip." or "SKIP — nothing new to report.": nothing worth saying. ("Skip the umbrella
      // today, it's sunny." is an answer: only the prompt's capitalized token may carry a note.)
      const t = out.trim();
      say = !task.once && (/^\W*SKIP\b/.test(t) || /^\W*skip\W*$/i.test(t)) ? null : out;
    }
    signal?.throwIfAborted(); // past the run's limit: say nothing (the heartbeat reports it)
    if (say) {
      workspace.agent("reply", { tool: d.action === "NONE" ? undefined : d.action, text: say, ok: true });
      await this.proactive(say, emit, task.title);
    }
    return say;
  }
}

/** The user's name as one more memory line, so the brain can use it ("The user's son is named Ryan Jr." doesn't say it). */
function withName(memories: string[]): string[] {
  const name = getProfileName();
  return name && !memories.some((m) => statesOwnName(m, name)) ? [`The user's name is ${name}.`, ...memories] : memories;
}
