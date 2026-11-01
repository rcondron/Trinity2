import "./styles.css";
import { Speech } from "./speech.js";
import { AudioIO } from "./audio.js";
import { LiveCall, type CallEvent, type CallState } from "./call.js";
import { mountWorkspace, type WorkspaceHandle } from "./workspace/view.js";
import type { TrinityBroadcast } from "./workspace/protocol.js";
import type { Persona, ServerEvent, ServiceStatus, TranscriptTurn } from "./protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const orb = $("orb");
const personaSelect = $<HTMLSelectElement>("personaSelect");
const statusChips = $("statusChips");
const feed = $("feed");
const micBtn = $<HTMLButtonElement>("micBtn");
const micLabel = $("micLabel");
const voiceState = $("voiceState");
const listening = $("listening");
const voiceHint = $("voiceHint");
const panes = $("panes");
const workspaceTitle = $("workspaceTitle");
const workspaceHost = $("workspaceHost");
const workspaceAway = $("workspaceAway");

const proto = location.protocol === "https:" ? "wss" : "ws";
const channel = "BroadcastChannel" in window ? new BroadcastChannel("trinity") : null;

let services: ServiceStatus | null = null;
let persona: Persona | null = null;
let personaDisplayName = "Trinity";
let ws: WebSocket | null = null;
let speech: Speech;
const audio = new AudioIO();
const liveCall = new LiveCall();
let callKey = ""; // what the voice session was warmed with (see personaKey)
let callName: string | null = null; // the caller's name it was warmed with (the voice hears it when it connects)
let profileName: string | null = null; // the caller's name as the engine has it now
let callActiveAt = 0; // the call's last sign of work: a tap, a typed turn, the caller's words, the voice, an action
let nameTimer: ReturnType<typeof setTimeout> | null = null; // a name re-warm waiting for the call to go quiet
let wantMic = false; // tapped while the voice was still warming up
let evicted = false;
let idlePaused = false; // the engine let an unused session go: wait for a tap or for the tab to come back
let rewarmFailures = 0;
let rewarmTimer: ReturnType<typeof setTimeout> | null = null;
const partialTurns = new Map<string, HTMLElement>();
let callCallerEl: HTMLElement | null = null;
let callAgentEl: HTMLElement | null = null;

type VoiceMode = "stream" | "fal" | "browser" | "none";
function voiceMode(): VoiceMode {
  if (services?.stream === "live" && liveCall.supported) return "stream";
  if (services?.voice === "live" && audio.supported) return "fal";
  if (speech?.recognitionSupported) return "browser";
  return "none";
}

// ─── Control channel (/ws) ─────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => send({ type: "hello" });
  ws.onclose = () => setTimeout(connect, 1200);
  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerEvent);
}
function send(obj: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/** A skill Trinity just created: usable now, or (approval "manual") waiting for the user. */
function skillLine(name: string, source: string | undefined): string {
  return source === "pending"
    ? `new skill "${name}" is waiting for your approval in Settings → Skills`
    : `new skill ready: ${name}`;
}

/** A tool's result in the feed: what it did, what it asks back when it declined ("When should I remind you…?"), or its error. */
function resultLine(r: { ok?: boolean; say?: string; error?: string }): string {
  return r.ok ? (r.say ?? "ok") : r.error ? `error: ${r.error}` : (r.say ?? "declined");
}

function handle(ev: ServerEvent) {
  switch (ev.type) {
    case "ready":
      applyStatus(ev.persona, ev.services, ev.profileName);
      break;
    case "audio":
      audio.play(ev.chunk);
      micLabel.textContent = "Tap to talk";
      break;
    case "transcript":
      // Said aloud in full in the live call this tab holds: the call's own transcript already shows it.
      if (ev.turn.voiced && liveCall.ready) break;
      renderTurn(ev.turn);
      // Browser-speech mode reads Trinity's turns aloud (an unprompted one, which every open tab gets,
      // in one tab only); live voice speaks for itself — and an unprompted line it didn't say (no
      // session in this tab) is read out by the browser instead.
      if (ev.turn.speaker === "trinity" && !ev.turn.partial && voiceMode() === "browser") {
        if (ev.turn.proactive) void sayAloudOnce(ev.turn);
        else speech?.speak(ev.turn.text, persona?.voice ?? "");
      } else if (ev.turn.proactive && !ev.turn.voiced && voiceMode() === "stream" && !liveCall.ready) void sayAloudOnce(ev.turn);
      break;
    case "route":
      if (ev.decision.action !== "speak")
        renderEvent("route", "jev", `${ev.decision.action}${ev.decision.tool ? ` → ${ev.decision.tool}` : ""} · ${ev.decision.reason}`);
      break;
    case "tool_start":
      renderEvent("tool", "tool", `${ev.tool}(${JSON.stringify(ev.args)})`);
      break;
    case "tool_result":
      renderEvent("tool", "result", resultLine(ev.result));
      break;
    case "memory":
      renderEvent("memory", ev.op === "write" ? "remember" : "recall", ev.doc.text);
      if (ev.op === "write") void refreshProfileName();
      break;
    case "heartbeat":
      renderEvent("heartbeat", "heartbeat", `${ev.task.title}`);
      break;
    case "wake":
      // A reminder or task is coming up and no voice session is up anywhere: warm one so it's said aloud.
      void answerWake();
      break;
    case "skill_forged":
      renderEvent("tool", "skill", skillLine(ev.name, ev.source));
      break;
    case "status":
      renderEvent("status", "…", ev.text);
      break;
    case "error":
      renderEvent("status", "error", ev.text);
      break;
    case "workspace":
      break; // the live workspace view (its own channel) renders this
  }
}

/**
 * The engine's call keeps the persona it was opened with (voice, prompts, tools), so switching
 * persona — or any edit to it, which bumps updatedAt — needs a fresh session.
 */
const personaKey = (p: Persona | null) => (p ? `${p.id}|${p.voice}|${p.voicePrompt}|${p.updatedAt}` : "");

/** New persona/services (and caller's name) from the engine: refresh the UI and (re)warm the voice session. */
function applyStatus(p: Persona, s: ServiceStatus, name?: string | null) {
  const streamChanged = services?.stream !== s.stream;
  persona = p;
  services = s;
  if (name !== undefined) profileName = name;
  personaDisplayName = p.name;
  if ([...personaSelect.options].some((o) => o.value === p.id)) personaSelect.value = p.id;
  renderStatus(s);
  updateVoiceHint();
  if (voiceMode() === "stream") {
    // "ready" is broadcast to every open tab (e.g. when another tab switches persona): a tab
    // whose voice moved elsewhere, or that isn't on screen, must not grab the one GPU session —
    // nor one whose session was let go for being unused.
    if (evicted || idlePaused || document.hidden) {
      /* stays put — "use it here", a tap, or coming back to the tab re-warms */
    } else if (!liveCall.ready && liveCall.state !== "connecting") warmUp();
    else if (callKey !== personaKey(p)) warmUp(); // another persona, or this one was edited
    else rewarmForName();
  } else if (streamChanged && liveCall.state !== "idle") {
    liveCall.close();
  }
  renderVoiceState();
}

/**
 * A standby call is re-warmed for a new name only after this long with no sign of work in it. Once
 * the mic goes off (or after a typed turn) the engine is still finishing the caller's last words,
 * acting on them and saying the reply, and a step of that can take ~16 s without a sign (Jev,
 * working out a tool's arguments, the tool itself) — a fresh session takes the GPU and cuts it all off.
 */
const CALL_QUIET_MS = 20_000;
/** Call events that show the engine at work for the caller (see CALL_QUIET_MS). */
const CALL_WORK = new Set(["caller", "agent", "decision", "pending", "tool", "tool_result", "reply", "memory", "announce"]);

/**
 * The caller's name changed since the session was warmed (the voice hears it when it connects):
 * warm a fresh one — never in the middle of a live call, and in standby once the call has gone quiet.
 */
function rewarmForName() {
  if (nameTimer) clearTimeout(nameTimer);
  nameTimer = null;
  if (callName === profileName || voiceMode() !== "stream" || evicted || idlePaused || document.hidden) return;
  if (liveCall.state === "closed") warmUp();
  else if (liveCall.state === "standby") {
    // (A live call checks again when it ends, a connecting one once it's ready.)
    const wait = callActiveAt + CALL_QUIET_MS - Date.now();
    if (wait <= 0) warmUp();
    else nameTimer = setTimeout(rewarmForName, wait);
  }
}

/** A memory was saved — perhaps the caller's name (the remember tool, curation): a new one re-warms the voice. */
async function refreshProfileName() {
  try {
    const { name } = (await fetch("/api/profile").then((r) => r.json())) as { name?: string | null };
    if (name === undefined || name === profileName) return;
    profileName = name;
    rewarmForName();
  } catch {
    /* engine unreachable — the next status refresh catches up */
  }
}

// ─── Live voice (warm standby) ───────────────────────────────────────────────────
function warmUp(wake = false) {
  // Only the tab you're looking at holds the (single) voice session; a background tab warms
  // up when it comes to the front (visibilitychange below) — or for a "wake" (answerWake), whose
  // session the engine turns away if another came up meanwhile.
  if (document.hidden && !wake) return;
  if (rewarmTimer) clearTimeout(rewarmTimer);
  rewarmTimer = null;
  evicted = false;
  idlePaused = false;
  callCallerEl = callAgentEl = null;
  callKey = personaKey(persona);
  callName = profileName;
  liveCall.connect(`${proto}://${location.host}/call?standby=1${wake ? "&wake=1" : ""}`, { onEvent: handleCallEvent, onState: onCallState });
}

const WAKE_LOCK = "trinity-wake"; // held by the one tab warming the voice for a "wake"

/**
 * "wake": the engine sends it only when no voice session exists anywhere, and turns the wake's
 * session away if one came up meanwhile (a tab brought on screen or tapped, another browser), so
 * answering takes the voice from no one. One tab answers: a tab on screen, else a background tab
 * that held the voice before (let go for being unused, or moved to a window that no longer has it)
 * and can play it — after a moment's wait, so a tab on screen wins. It holds the lock while its
 * session connects.
 */
async function answerWake() {
  const free = () => voiceMode() === "stream" && !liveCall.ready && liveCall.state !== "connecting";
  // (A background tab with no playback yet — no tap or typed turn through the call — would have the
  // line said into silence: it leaves it to the browser's voice.)
  if (!free() || (document.hidden && ((!idlePaused && !evicted) || !liveCall.canPlay))) return;
  if (!("locks" in navigator)) {
    // No Web Locks (e.g. an insecure origin): nothing picks one background tab, so only a tab on screen answers.
    if (!document.hidden) warmUp(true);
    return;
  }
  if (document.hidden) await sleep(1500);
  try {
    await navigator.locks.request(WAKE_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock || !free()) return;
      warmUp(true);
      await sleep(10_000);
    });
  } catch {
    if (!document.hidden && free()) warmUp(true);
  }
}

function onCallState(state: CallState) {
  if (state === "standby" || state === "live") rewarmFailures = 0;
  // The caller has the floor: the browser's voice stops here, and won't start in another tab (see sayAloudOnce).
  holdLiveLock(state === "live");
  if (state === "live") speech?.cancelSpeech();
  if (state === "standby" && wantMic) {
    wantMic = false;
    void startTalking();
  } else if (state === "standby") rewarmForName(); // e.g. a name learned during the call that just ended
  renderVoiceState();
}

async function startTalking() {
  try {
    await liveCall.startAudio();
  } catch (err) {
    renderEvent("status", "error", `microphone unavailable: ${(err as Error).message}`);
  }
  renderVoiceState();
}

function renderVoiceState() {
  const mode = voiceMode();
  micBtn.classList.remove("active", "warming");
  orb.classList.remove("listening", "warming");
  if (mode !== "stream") {
    voiceState.textContent = "";
    voiceState.className = "voice-state";
    if (!micBtn.classList.contains("recording")) micLabel.textContent = "Tap to talk";
    return;
  }
  const s = liveCall.state;
  if (s === "connecting") {
    micBtn.classList.add("warming");
    orb.classList.add("warming");
    micLabel.textContent = wantMic ? "Starting…" : "Tap to talk";
    voiceState.innerHTML = `<span class="dot warming"></span>Warming up the voice…`;
  } else if (s === "standby") {
    micLabel.textContent = "Tap to talk";
    voiceState.innerHTML = `<span class="dot ready"></span>Voice ready`;
  } else if (s === "live") {
    micBtn.classList.add("active");
    orb.classList.add("listening");
    micLabel.textContent = "Listening — tap to end";
    voiceState.innerHTML = `<span class="dot live"></span>Live with ${escapeText(personaDisplayName)}`;
  } else {
    micLabel.textContent = "Tap to talk";
    voiceState.innerHTML = evicted
      ? `<span class="dot off"></span>Voice is open in another window · <button class="linkish" id="takeOverBtn" type="button">use it here</button>`
      : `<span class="dot off"></span>Voice paused — tap to reconnect`;
    $("takeOverBtn")?.addEventListener("click", () => warmUp());
  }
  voiceState.className = "voice-state";
}

function scheduleRewarm() {
  if (rewarmTimer || evicted || idlePaused || document.hidden || voiceMode() !== "stream") return;
  const delay = Math.min(30_000, 1500 * 2 ** rewarmFailures++);
  rewarmTimer = setTimeout(() => {
    rewarmTimer = null;
    if (!liveCall.ready && liveCall.state !== "connecting") warmUp();
  }, delay);
}

function liveLine(speaker: "user" | "trinity", who: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `turn ${speaker}`;
  el.innerHTML = `<span class="who"></span><div class="bubble"></div>`;
  el.querySelector(".who")!.textContent = who;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}

function handleCallEvent(e: CallEvent) {
  const s = (k: string) => String(e[k] ?? "");
  const n = (k: string) => Number(e[k] ?? 0);
  if (CALL_WORK.has(e.type)) callActiveAt = Date.now();
  switch (e.type) {
    case "status":
      if (e.evicted) evicted = true;
      if (e.idle) idlePaused = true; // released for being unused — reconnecting now would just hold it again
      renderEvent("status", "voice", s("text"));
      if (e.error && !e.busy) scheduleRewarm();
      break;
    case "ready":
      renderEvent("route", "voice", `voice ready in ${(n("handshake_ms") / 1000).toFixed(1)}s — tap the mic and talk`);
      break;
    case "caller":
      if (e.final) {
        if (!s("text")) break;
        if (!callCallerEl) callCallerEl = liveLine("user", e.typed ? "you (typed)" : "you");
        callCallerEl.querySelector(".bubble")!.textContent = s("text");
        callCallerEl.classList.remove("partial");
        callCallerEl = callAgentEl = null;
      } else if (s("text")) {
        if (!callCallerEl) {
          callCallerEl = liveLine("user", "you");
          callAgentEl = null;
        }
        callCallerEl.querySelector(".bubble")!.textContent = s("text");
        callCallerEl.classList.add("partial");
        listening.textContent = s("text");
      }
      feed.scrollTop = feed.scrollHeight;
      if (e.final) listening.textContent = "";
      break;
    case "agent": {
      if (!callAgentEl) callAgentEl = liveLine("trinity", personaDisplayName);
      const b = callAgentEl.querySelector(".bubble")!;
      b.textContent = (b.textContent ?? "") + s("text");
      orb.classList.add("speaking");
      clearTimeout((handleCallEvent as unknown as { t?: number }).t);
      (handleCallEvent as unknown as { t?: number }).t = window.setTimeout(() => orb.classList.remove("speaking"), 700);
      feed.scrollTop = feed.scrollHeight;
      break;
    }
    case "decision":
      if (s("tool") && s("tool") !== "NONE")
        renderEvent(
          "route",
          "jev",
          `${s("tool")} ${Math.round(n("confidence") * 100)}% · ${n("ms")}ms${e.final ? "" : " · mid-sentence"}`,
        );
      else if (e.error) renderEvent("status", "jev", `error: ${s("error")}`);
      break;
    case "pending":
      renderEvent("status", "…", "waiting for you to finish…");
      break;
    case "tool":
      renderEvent("tool", "tool", `${s("tool")}(${JSON.stringify(e.args ?? {})})`);
      break;
    case "tool_result": {
      const r = (e.result ?? {}) as { ok?: boolean; say?: string; error?: string };
      renderEvent("tool", "result", resultLine(r));
      break;
    }
    case "reply":
      if (e.error) renderEvent("status", "reply", s("error"));
      break;
    case "memory":
      renderEvent("memory", e.op === "write" ? "remember" : "recall", ((e.doc ?? {}) as { text?: string }).text ?? "");
      if (e.op === "write") void refreshProfileName();
      break;
    case "transcript": {
      // A line the call couldn't say in full (e.g. a finished skill's news, cut off): shown as text.
      const turn = e.turn as TranscriptTurn | undefined;
      if (turn?.text) renderTurn(turn);
      break;
    }
    case "skill_forged":
      renderEvent("tool", "skill", skillLine(s("name"), s("source")));
      break;
    case "mic":
      renderVoiceState();
      break;
    case "_closed":
      callCallerEl = callAgentEl = null;
      renderVoiceState();
      scheduleRewarm();
      break;
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderStatus(s: Record<string, string>) {
  statusChips.innerHTML = "";
  for (const [k, v] of Object.entries(s)) {
    const chip = document.createElement("span");
    chip.className = `chip ${v}`;
    chip.textContent = `${k}:${v}`;
    statusChips.appendChild(chip);
  }
}

function updateVoiceHint() {
  const mode = voiceMode();
  voiceHint.textContent =
    mode === "stream"
      ? "Real-time voice: tap the mic to talk, tap again to end. Typing speaks through the same voice."
      : mode === "fal"
        ? "Turn-based voice: tap to record, tap to send. Add a PersonaPlex streaming URL in Settings for real-time."
        : mode === "browser"
          ? "Browser speech (mock voice). Configure the voice model in Settings to go live."
          : "This browser has no speech recognition — type to Trinity below.";
}

function renderTurn(turn: { id: string; speaker: string; text: string; partial?: boolean }) {
  let el = partialTurns.get(turn.id);
  if (!el) {
    el = document.createElement("div");
    el.className = `turn ${turn.speaker}`;
    const who = turn.speaker === "trinity" ? personaDisplayName : turn.speaker === "user" ? "you" : turn.speaker;
    el.innerHTML = `<span class="who"></span><div class="bubble"></div>`;
    el.querySelector(".who")!.textContent = who;
    feed.appendChild(el);
    if (turn.partial) partialTurns.set(turn.id, el);
  }
  el.classList.toggle("partial", Boolean(turn.partial));
  el.querySelector(".bubble")!.textContent = turn.text;
  if (!turn.partial) partialTurns.delete(turn.id);
  feed.scrollTop = feed.scrollHeight;
}

function renderEvent(cls: string, tag: string, text: string) {
  const el = document.createElement("div");
  el.className = `event ${cls}`;
  el.innerHTML = `<span class="tag"></span><span class="txt"></span>`;
  el.querySelector(".tag")!.textContent = tag;
  el.querySelector(".txt")!.textContent = text;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ─── The browser's voice, for unprompted lines the live voice didn't say ──────────
const SAID_KEY = "trinity.said:"; // + turn id → when a tab claimed it
const LIVE_LOCK = "trinity-call-live"; // held (shared) by the tab whose call is live: the caller may be talking
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let endLiveLock: (() => void) | null = null;

function holdLiveLock(live: boolean) {
  if (!("locks" in navigator)) return;
  if (live && !endLiveLock) {
    const ended = new Promise<void>((r) => (endLiveLock = r));
    void navigator.locks.request(LIVE_LOCK, { mode: "shared" }, () => ended).catch(() => {});
  } else if (!live && endLiveLock) {
    endLiveLock();
    endLiveLock = null;
  }
}

async function liveCallSomewhere(): Promise<boolean> {
  try {
    const { held = [] } = await navigator.locks.query();
    return held.some((l) => l.name === LIVE_LOCK);
  } catch {
    return false;
  }
}

/** True for the first tab to claim this turn (every open tab gets it); with no storage, the lock alone decides. */
function claimTurn(id: string): boolean {
  try {
    if (localStorage.getItem(SAID_KEY + id)) return false;
    localStorage.setItem(SAID_KEY + id, String(Date.now()));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(SAID_KEY) && Date.now() - Number(localStorage.getItem(k)) > 86_400_000) localStorage.removeItem(k);
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * A due reminder (or another unprompted line) the live voice didn't say — no session in this tab —
 * read out by the browser's voice instead, in one tab only: the first tab to get the turn's lock
 * claims it and holds the lock while it speaks, so a tab that gets the turn a moment late skips it.
 * Never a line the caller cut off in the call (talked over it, or ended the turn), and never over a
 * live call in another tab (that caller may be talking).
 */
async function sayAloudOnce(turn: TranscriptTurn) {
  if (!speech?.synthSupported || turn.cut) return;
  const say = async () => {
    if ((await liveCallSomewhere()) || !claimTurn(turn.id)) return;
    speech.speak(turn.text, persona?.voice ?? "");
    const until = Date.now() + 60_000;
    await sleep(250);
    while (Date.now() < until && (speechSynthesis.speaking || speechSynthesis.pending)) await sleep(250);
  };
  if (!("locks" in navigator)) return say();
  try {
    await navigator.locks.request(`trinity-say:${turn.id}`, { ifAvailable: true }, (lock) => (lock ? say() : undefined));
  } catch {
    await say(); // no Web Locks here (e.g. an insecure origin): storage alone decides
  }
}

// ─── Mic button & typing ───────────────────────────────────────────────────────
function initSpeech() {
  speech = new Speech();
  speech.onFinal = (text) => {
    listening.textContent = "";
    send({ type: "text", text });
  };
  speech.onInterim = (text) => {
    listening.textContent = text;
  };
  speech.onListeningChange = (on) => {
    micBtn.classList.toggle("active", on);
    micLabel.textContent = on ? "Listening…" : "Tap to talk";
    orb.classList.toggle("listening", on);
  };
  speech.onSpeakingChange = (on) => orb.classList.toggle("speaking", on);
  speech.onBargeIn = () => send({ type: "barge_in" });
}

micBtn.addEventListener("click", async () => {
  const mode = voiceMode();
  if (mode === "stream") {
    callActiveAt = Date.now(); // the caller is using the call: a name re-warm waits (see CALL_QUIET_MS)
    if (liveCall.state === "live") {
      liveCall.stopAudio();
      renderVoiceState();
      return;
    }
    if (liveCall.state === "standby") {
      await startTalking();
      return;
    }
    // Still warming up (or paused): remember the tap, and unlock audio inside this gesture.
    wantMic = true;
    if (liveCall.state !== "connecting") warmUp();
    try {
      await liveCall.ensurePlayback();
    } catch {
      /* resumed later */
    }
    renderVoiceState();
    return;
  }
  if (mode === "fal") {
    if (audio.recording) {
      micBtn.classList.remove("active", "recording");
      orb.classList.remove("listening");
      micLabel.textContent = "Thinking…";
      try {
        send({ type: "audio", chunk: await audio.stop() });
      } catch {
        micLabel.textContent = "Tap to talk";
      }
    } else {
      try {
        await audio.start();
        micBtn.classList.add("active", "recording");
        orb.classList.add("listening");
        micLabel.textContent = "Recording… tap to send";
      } catch {
        renderEvent("status", "error", "microphone permission denied");
      }
    }
    return;
  }
  if (mode === "browser") {
    if (speech.listening) speech.stopListening();
    else speech.startListening();
    return;
  }
  $("textInput").focus();
});

$<HTMLFormElement>("textForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("textInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  // With a live voice session, typed turns go through it: same history, spoken back in the voice.
  if (voiceMode() === "stream" && liveCall.ready) {
    callActiveAt = Date.now();
    void liveCall.sendText(text);
  } else {
    send({ type: "text", text });
    // Someone's here (e.g. after an idle pause): wake the voice so the next turn is spoken again.
    if (voiceMode() === "stream" && !evicted && liveCall.state !== "connecting") warmUp();
  }
});

$("collapseBtn").addEventListener("click", () => panes.classList.toggle("transcript-collapsed"));

// ─── Personas ──────────────────────────────────────────────────────────────────
async function populatePersonas() {
  const [personas, status] = await Promise.all([
    fetch("/api/personas").then((r) => r.json()),
    fetch("/api/status").then((r) => r.json()),
  ]);
  personaSelect.innerHTML = "";
  for (const p of personas as { id: string; name: string }[]) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    personaSelect.appendChild(o);
  }
  if (status?.persona && status?.services)
    applyStatus(status.persona as Persona, status.services as ServiceStatus, status.profileName as string | null | undefined);
}

personaSelect.addEventListener("change", () => {
  feed.innerHTML = "";
  partialTurns.clear();
  callCallerEl = callAgentEl = null;
  idlePaused = false; // someone's here: the "ready" that follows may warm up the voice again
  const name = personaSelect.options[personaSelect.selectedIndex]?.text ?? "";
  renderEvent("status", "persona", `now talking to ${name}`);
  send({ type: "set_persona", id: personaSelect.value }); // the engine answers with "ready" → re-warm
});

// ─── Workspace: embedded view, or "open in its own window" ─────────────────────────
let workspaceView: WorkspaceHandle | null = null;
let workspaceWin: Window | null = null;
let windowSeenAt = 0;

function mountEmbedded() {
  if (workspaceView) return;
  workspaceView = mountWorkspace(workspaceHost, {
    onTitle: (t) => (workspaceTitle.textContent = t || "Workspace"),
  });
}

function setAway(away: boolean) {
  workspaceAway.hidden = !away;
  workspaceHost.hidden = away;
  if (away) {
    // Destroy (not hide) the embedded view so it stops animating and decoding images.
    workspaceView?.destroy();
    workspaceView = null;
  } else {
    mountEmbedded();
  }
}

channel?.addEventListener("message", (m: MessageEvent<TrinityBroadcast>) => {
  const msg = m.data;
  if (msg?.type === "workspace-window") {
    windowSeenAt = msg.open ? Date.now() : 0;
    setAway(msg.open);
  } else if (msg?.type === "settings-changed") {
    void populatePersonas();
  }
});

// The workspace window also holds this Web Lock while it's open (workspace/window.ts). Its 2s
// heartbeat goes quiet for up to a minute when that window is hidden (browsers throttle background
// timers); the lock doesn't, and the browser drops it if the window crashes.
const WINDOW_LOCK = "trinity-workspace-window";
async function windowLockHeld(): Promise<boolean> {
  if (!("locks" in navigator)) return false; // no Web Locks: the heartbeat alone decides
  try {
    const { held = [] } = await navigator.locks.query();
    return held.some((l) => l.name === WINDOW_LOCK);
  } catch {
    return false;
  }
}
const heardFromWindow = () => windowSeenAt > 0 && Date.now() - windowSeenAt <= 6000;

// A window that stops announcing itself (crashed, closed abruptly) hands the workspace back.
setInterval(async () => {
  if (workspaceAway.hidden || heardFromWindow() || (await windowLockHeld())) return;
  if (!workspaceAway.hidden && !heardFromWindow()) {
    windowSeenAt = 0;
    setAway(false);
  }
}, 2000);
// Loaded while the window is already open (e.g. a reload): hand it the workspace now, not at its next heartbeat.
void windowLockHeld().then((open) => {
  if (open) setAway(true);
});

// The workspace lives in its own window by default (players watch it on a second screen);
// "Dock" keeps it in this page instead, and the choice is remembered.
const WINDOW_PREF = "trinity.workspace";
const prefersWindow = () => {
  try {
    return localStorage.getItem(WINDOW_PREF) !== "docked";
  } catch {
    return true;
  }
};
const rememberPlacement = (where: "window" | "docked") => {
  try {
    localStorage.setItem(WINDOW_PREF, where);
  } catch {
    /* private mode — just don't remember */
  }
};
const windowOpen = () => (workspaceWin !== null && !workspaceWin.closed) || !workspaceAway.hidden;

/** Must run inside a user gesture (pop-up rules). Opens beside this window when there's room. */
function openWorkspaceWindow(): boolean {
  const w = 1280;
  const h = 860;
  const right = window.screenX + window.outerWidth;
  const place = right + w <= screen.availWidth ? `,left=${right},top=${Math.max(0, window.screenY)}` : "";
  workspaceWin = window.open("/workspace.html", "trinity-workspace", `popup,width=${w},height=${h}${place}`);
  if (!workspaceWin) {
    renderEvent("status", "workspace", "Pop-up blocked — allow pop-ups for this site to open the workspace window.");
    return false;
  }
  workspaceWin.focus();
  return true;
}

// First tap to talk opens the workspace window (once per page load — closing it means "not now").
let autoOpened = false;
micBtn.addEventListener("click", () => {
  if (autoOpened || !prefersWindow() || windowOpen()) return;
  autoOpened = true;
  openWorkspaceWindow();
});

$("popoutBtn").addEventListener("click", () => {
  rememberPlacement("window");
  openWorkspaceWindow();
});

// Settings opens as a named tab that keeps this window as its opener, so "Back to Trinity"
// returns here instead of loading a second app (which would fight over the one voice session).
$("settingsBtn").addEventListener("click", (e) => {
  const tab = window.open("/settings.html", "trinity-settings");
  if (!tab) return; // blocked — let the plain link navigate
  e.preventDefault();
  tab.focus();
});
$("focusWindowBtn").addEventListener("click", () => {
  if (workspaceWin && !workspaceWin.closed) workspaceWin.focus();
  else channel?.postMessage({ type: "workspace-focus" } satisfies TrinityBroadcast);
});
$("dockBtn").addEventListener("click", () => {
  rememberPlacement("docked");
  channel?.postMessage({ type: "workspace-dock" } satisfies TrinityBroadcast);
  setAway(false);
});

// Coming back to the tab: warm a voice that's paused or never warmed (the tab opened in the
// background), and re-warm one set up with an older persona (switched or edited meanwhile, e.g. in
// Settings) or before the caller's name changed.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || voiceMode() !== "stream" || evicted) return;
  if (liveCall.state === "closed" || liveCall.state === "idle" || callKey !== personaKey(persona)) warmUp();
  else rewarmForName();
});

// The voice is only heard once the page has had a gesture: the first one anywhere (not just a mic
// tap) sets playback up, so a reminder the voice says before the first tap isn't said into silence.
const unlockPlayback = () => {
  if (voiceMode() === "stream" && !liveCall.canPlay) void liveCall.ensurePlayback().catch(() => {});
};
document.addEventListener("click", unlockPlayback, true);
document.addEventListener("keydown", unlockPlayback, true);

// ─── Go ───────────────────────────────────────────────────────────────────────
initSpeech();
mountEmbedded();
void populatePersonas();
connect();
// speechSynthesis voices load async in some browsers
if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = () => {};
