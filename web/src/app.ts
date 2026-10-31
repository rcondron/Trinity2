import "./styles.css";
import { Speech } from "./speech.js";
import { AudioIO } from "./audio.js";
import { LiveCall, type CallEvent } from "./call.js";
import type { HeartbeatTask, Persona, ServerEvent } from "./protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const orb = $("orb");
const personaSelect = $<HTMLSelectElement>("personaSelect");
const statusChips = $("statusChips");
const feed = $("feed");
const micBtn = $("micBtn");
const micLabel = $("micLabel");
const listening = $("listening");
const voiceHint = $("voiceHint");
const workspace = $<HTMLIFrameElement>("workspace");
const workspaceTitle = $("workspaceTitle");
const panes = $("panes");

let speech: Speech;
const audio = new AudioIO();
const liveCall = new LiveCall();
let voiceLive = false;
let streamLive = false;
let voicePreset = "";
let personaDisplayName = "Trinity";
let ws: WebSocket | null = null;
const partialTurns = new Map<string, HTMLElement>();
// Current live-call transcript elements (caller still talking / agent speaking).
let callCallerEl: HTMLElement | null = null;
let callAgentEl: HTMLElement | null = null;

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => send({ type: "hello" });
  ws.onclose = () => setTimeout(connect, 1200);
  ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerEvent);
}
function send(obj: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handle(ev: ServerEvent) {
  switch (ev.type) {
    case "ready":
      if (personaSelect.options.length) personaSelect.value = ev.persona.id;
      personaDisplayName = ev.persona.name;
      voicePreset = ev.persona.voice;
      voiceLive = ev.services.voice === "live";
      streamLive = ev.services.stream === "live";
      renderStatus(ev.services);
      voiceHint.textContent = streamLive
        ? "Real-time voice: tap to open a live call with Trinity."
        : voiceLive
          ? "Live voice: PersonaPlex (tap to record a turn). Set PERSONAPLEX_WS_URL for real-time."
          : speech?.recognitionSupported
            ? "Mock voice (browser speech). Configure endpoints in Settings to go live."
            : "This browser has no speech recognition — type to Trinity below.";
      break;
    case "audio":
      audio.play(ev.chunk);
      micLabel.textContent = "Tap to talk";
      break;
    case "transcript":
      renderTurn(ev.turn);
      // Mock voice: browser speaks Trinity's turns. Live voice: PersonaPlex audio plays instead.
      if (ev.turn.speaker === "trinity" && !ev.turn.partial && !voiceLive) speech?.speak(ev.turn.text, voicePreset);
      break;
    case "route":
      renderEvent("route", "route", `${ev.decision.action}${ev.decision.tool ? ` → ${ev.decision.tool}` : ""} · ${ev.decision.reason}`);
      break;
    case "tool_start":
      renderEvent("tool", "tool", `${ev.tool}(${JSON.stringify(ev.args)})`);
      break;
    case "tool_result":
      renderEvent("tool", "result", ev.result.ok ? (ev.result.say ?? "ok") : `error: ${ev.result.error}`);
      break;
    case "memory":
      renderEvent("memory", ev.op === "write" ? "remember" : "recall", ev.doc.text);
      break;
    case "heartbeat":
      renderEvent("heartbeat", "heartbeat", `${ev.task.title}`);
      break;
    case "skill_forged":
      renderEvent("tool", "skill", `drafted "${ev.name}" — review & approve in Settings`);
      break;
    case "workspace":
      setWorkspace(ev.html, ev.title);
      break;
    case "status":
      renderEvent("status", "…", ev.text);
      break;
    case "error":
      renderEvent("status", "error", ev.text);
      break;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderStatus(services: Record<string, string>) {
  statusChips.innerHTML = "";
  for (const [k, v] of Object.entries(services)) {
    const chip = document.createElement("span");
    chip.className = `chip ${v}`;
    chip.textContent = `${k}:${v}`;
    statusChips.appendChild(chip);
  }
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

function setWorkspace(html: string, title?: string) {
  workspace.srcdoc = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0f0f18">${html}</body>`;
  workspaceTitle.textContent = title || "Workspace";
}

// ─── Live call (real-time streaming voice) ────────────────────────────────────
function liveLine(speaker: "user" | "trinity", who: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `turn ${speaker}`;
  el.innerHTML = `<span class="who"></span><div class="bubble"></div>`;
  el.querySelector(".who")!.textContent = who;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}

function endCallUI() {
  micBtn.classList.remove("active");
  orb.classList.remove("listening", "speaking");
  micLabel.textContent = "Tap to talk";
  callCallerEl = callAgentEl = null;
}

function handleCallEvent(e: CallEvent) {
  const s = (k: string) => String(e[k] ?? "");
  const n = (k: string) => Number(e[k] ?? 0);
  switch (e.type) {
    case "status":
      renderEvent("status", "…", s("text"));
      break;
    case "ready":
      renderEvent("route", "voice", `live call connected (${(n("handshake_ms") / 1000).toFixed(1)}s) — talk!`);
      micLabel.textContent = "End call";
      orb.classList.add("listening");
      break;
    case "caller":
      if (e.final) {
        if (!s("text")) break;
        if (!callCallerEl) callCallerEl = liveLine("user", "you");
        callCallerEl.querySelector(".bubble")!.textContent = s("text");
        callCallerEl.classList.remove("partial");
        callCallerEl = callAgentEl = null;
      } else if (s("text")) {
        if (!callCallerEl) { callCallerEl = liveLine("user", "you"); callAgentEl = null; }
        callCallerEl.querySelector(".bubble")!.textContent = s("text");
        callCallerEl.classList.add("partial");
      }
      feed.scrollTop = feed.scrollHeight;
      break;
    case "agent": {
      if (!callAgentEl) callAgentEl = liveLine("trinity", personaDisplayName);
      const b = callAgentEl.querySelector(".bubble")!;
      b.textContent = (b.textContent ?? "") + s("text");
      orb.classList.add("speaking");
      feed.scrollTop = feed.scrollHeight;
      break;
    }
    case "decision":
      if (s("tool") && s("tool") !== "NONE")
        renderEvent("route", "jev", `${s("tool")}${e.arg ? `(${s("arg")})` : ""} ${Math.round(n("confidence") * 100)}% · ${n("ms")}ms${e.final ? " · end" : ""}`);
      else if (e.error) renderEvent("status", "jev", `error: ${s("error")}`);
      break;
    case "pending":
      renderEvent("status", "…", "holding while you finish…");
      break;
    case "tool":
      renderEvent("tool", "tool", `${s("tool")}(${JSON.stringify(e.args ?? {})})`);
      break;
    case "tool_result": {
      const r = (e.result ?? {}) as { ok?: boolean; say?: string; error?: string };
      renderEvent("tool", "result", r.ok ? r.say ?? "ok" : `error: ${r.error ?? ""}`);
      break;
    }
    case "reply":
      renderEvent("route", "said", e.error ? `reply error: ${s("error")}` : `➤ ${s("text")}${e.filler ? " (after “one sec”)" : ""}`);
      orb.classList.remove("speaking");
      break;
    case "workspace":
      setWorkspace(s("html"), s("title"));
      break;
    case "memory":
      renderEvent("memory", (e.op === "write" ? "remember" : "recall"), ((e.doc ?? {}) as { text?: string }).text ?? "");
      break;
    case "skill_forged":
      renderEvent("tool", "skill", `drafted "${s("name")}" — approve in Settings`);
      break;
    case "error":
      renderEvent("status", "error", s("text"));
      break;
    case "_closed":
      renderEvent("status", "voice", "call ended");
      endCallUI();
      break;
  }
}

// ─── Speech + mic ─────────────────────────────────────────────────────────────
function initSpeech() {
  speech = new Speech();
  speech.onFinal = (text) => { listening.textContent = ""; send({ type: "text", text }); };
  speech.onInterim = (text) => { listening.textContent = text; };
  speech.onListeningChange = (on) => {
    micBtn.classList.toggle("active", on);
    micLabel.textContent = on ? "Listening…" : "Tap to talk";
    orb.classList.toggle("listening", on);
  };
  speech.onSpeakingChange = (on) => orb.classList.toggle("speaking", on);
  speech.onBargeIn = () => send({ type: "barge_in" });

  micBtn.addEventListener("click", async () => {
    // Real-time streaming voice: a continuous call (patched PersonaPlex + Deepgram).
    if (streamLive) {
      if (liveCall.active) { liveCall.stop(); endCallUI(); return; }
      if (!liveCall.supported) { $("textInput").focus(); return; }
      micBtn.classList.add("active");
      micLabel.textContent = "Connecting…";
      try {
        await liveCall.start(`ws://${location.host}/call`, { onEvent: handleCallEvent });
      } catch (err) {
        renderEvent("status", "error", "mic/call failed: " + (err as Error).message);
        endCallUI();
      }
      return;
    }
    // Live voice: push-to-talk recording → PersonaPlex.
    if (voiceLive) {
      if (!audio.supported) { $("textInput").focus(); return; }
      if (audio.recording) {
        micBtn.classList.remove("active");
        orb.classList.remove("listening");
        micLabel.textContent = "Thinking…";
        try {
          const clip = await audio.stop();
          send({ type: "audio", chunk: clip });
        } catch {
          micLabel.textContent = "Tap to talk";
        }
      } else {
        try {
          await audio.start();
          micBtn.classList.add("active");
          orb.classList.add("listening");
          micLabel.textContent = "Recording… tap to send";
        } catch {
          renderEvent("status", "error", "microphone permission denied");
        }
      }
      return;
    }
    // Mock voice: Web Speech API.
    if (!speech.recognitionSupported) { $("textInput").focus(); return; }
    if (speech.listening) speech.stopListening();
    else speech.startListening();
  });
}

$<HTMLFormElement>("textForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("textInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "text", text });
  input.value = "";
});

$("collapseBtn").addEventListener("click", () => panes.classList.toggle("transcript-collapsed"));

// ─── Settings: persona + heartbeat ──────────────────────────────────────────
const dialog = $<HTMLDialogElement>("settings");
$("settingsBtn").addEventListener("click", async () => { await loadSettings(); dialog.showModal(); });

async function loadSettings() {
  const status = await fetch("/api/status").then((r) => r.json());
  const p: Persona = status.persona;
  $<HTMLInputElement>("pName").value = p.name;
  $<HTMLTextAreaElement>("pDesc").value = p.description;
  $<HTMLInputElement>("pVoice").value = p.voice;
  $<HTMLButtonElement>("savePersona").dataset.id = p.id;
  await renderTasks();
  await renderSkills();
  await loadEndpoints();
}

// ─── Settings: endpoints & models ─────────────────────────────────────────────
const EP_FIELDS: Record<string, string> = {
  epPpUrl: "personaplexWsUrl",
  epDgUrl: "deepgramUrl",
  epJevUrl: "typesafeUrl",
  epJevModel: "jevModel",
  epMordiemUrl: "mordiemUrl",
  epBrainModel: "brainModel",
  epGenModel: "genModel",
  epReplyModel: "replyModel",
  epRouteEvery: "routeEveryMs",
  epMinConf: "minConfidence",
  epFiller: "fillerAfterMs",
};

async function loadEndpoints() {
  const voices: string[] = await fetch("/api/voices").then((r) => r.json());
  const sel = $<HTMLSelectElement>("epVoice");
  const ep = await fetch("/api/settings/endpoints").then((r) => r.json());
  sel.innerHTML = "";
  for (const v of voices) sel.add(new Option(v, v, false, v === ep.personaplexVoice));
  for (const [id, key] of Object.entries(EP_FIELDS)) {
    $<HTMLInputElement>(id).value = ep[key] != null ? String(ep[key]) : "";
  }
  for (const [spanId, flag] of [
    ["epDgKeySet", "deepgramKeySet"],
    ["epJevKeySet", "typesafeKeySet"],
    ["epMordiemKeySet", "mordiemKeySet"],
  ] as const) {
    $(spanId).textContent = ep[flag] ? "✓ set" : "— not set";
    $(spanId).className = "key-state " + (ep[flag] ? "ok" : "off");
  }
  // keys are write-only — never prefilled
  for (const id of ["epDgKey", "epJevKey", "epMordiemKey"]) $<HTMLInputElement>(id).value = "";
}

$("saveEndpoints").addEventListener("click", async () => {
  const body: Record<string, unknown> = { personaplexVoice: $<HTMLSelectElement>("epVoice").value };
  for (const [id, key] of Object.entries(EP_FIELDS)) {
    const raw = $<HTMLInputElement>(id).value.trim();
    body[key] = key.endsWith("Ms") || key === "minConfidence" ? (raw === "" ? "" : Number(raw)) : raw;
  }
  // Only send keys the user actually typed (blank keeps the stored/.env value).
  const dg = $<HTMLInputElement>("epDgKey").value.trim();
  const jev = $<HTMLInputElement>("epJevKey").value.trim();
  const mordiem = $<HTMLInputElement>("epMordiemKey").value.trim();
  if (dg) body.deepgramKey = dg;
  if (jev) body.typesafeKey = jev;
  if (mordiem) body.mordiemKey = mordiem;
  await fetch("/api/settings/endpoints", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  await loadEndpoints();
  // Refresh service chips (liveness may have changed) via a fresh hello.
  send({ type: "hello" });
  renderEvent("status", "settings", "endpoints saved");
});

async function renderSkills() {
  const [active, pending] = await Promise.all([
    fetch("/api/skills").then((r) => r.json()),
    fetch("/api/skills/pending").then((r) => r.json()),
  ]);
  const list = $("skillList");
  list.innerHTML = "";
  for (const s of pending as { name: string; description: string }[]) {
    const el = document.createElement("div");
    el.className = "task skill-pending";
    el.innerHTML = `<span class="t-title"></span><span class="t-meta"></span>
      <button class="primary small" type="button">Approve</button>
      <button class="ghost small" type="button">✕</button>`;
    el.querySelector(".t-title")!.textContent = s.name;
    el.querySelector(".t-meta")!.textContent = s.description || "pending approval";
    const [approve, discard] = el.querySelectorAll("button");
    approve!.addEventListener("click", async () => { await fetch(`/api/skills/${s.name}/approve`, { method: "POST" }); renderSkills(); });
    discard!.addEventListener("click", async () => { await fetch(`/api/skills/${s.name}/discard`, { method: "POST" }); renderSkills(); });
    list.appendChild(el);
  }
  for (const s of active as { name: string; source: string }[]) {
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = `<span class="t-title"></span><span class="skill-badge"></span>`;
    el.querySelector(".t-title")!.textContent = s.name;
    el.querySelector(".skill-badge")!.textContent = s.source;
    list.appendChild(el);
  }
}

$("savePersona").addEventListener("click", async () => {
  const id = $<HTMLButtonElement>("savePersona").dataset.id;
  const body = {
    id,
    name: $<HTMLInputElement>("pName").value,
    description: $<HTMLTextAreaElement>("pDesc").value,
    voice: $<HTMLInputElement>("pVoice").value,
  };
  const saved = await fetch("/api/personas", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());
  send({ type: "set_persona", id: saved.id });
  await populatePersonas();
  personaSelect.value = saved.id;
  voicePreset = saved.voice;
});

// ─── Persona library ──────────────────────────────────────────────────────────
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
  personaSelect.value = status.persona.id;
}

personaSelect.addEventListener("change", () => {
  if (liveCall.active) { liveCall.stop(); endCallUI(); } // persona is fixed per call; reconnect to switch
  feed.innerHTML = "";
  partialTurns.clear();
  const name = personaSelect.options[personaSelect.selectedIndex]?.text ?? "";
  renderEvent("status", "persona", `now talking to ${name}`);
  send({ type: "set_persona", id: personaSelect.value });
});

async function renderTasks() {
  const tasks: HeartbeatTask[] = await fetch("/api/heartbeat").then((r) => r.json());
  const list = $("taskList");
  list.innerHTML = tasks.length ? "" : `<p class="hint">No recurring tasks yet.</p>`;
  for (const t of tasks) {
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = `
      <input type="checkbox" class="switch" ${t.enabled ? "checked" : ""} />
      <span class="t-title"></span>
      <span class="t-meta"></span>
      <button class="ghost small">✕</button>`;
    el.querySelector(".t-title")!.textContent = t.title;
    el.querySelector(".t-meta")!.textContent = `every ${t.intervalSec}s`;
    el.querySelector<HTMLInputElement>(".switch")!.addEventListener("change", (e) => {
      fetch(`/api/heartbeat/${t.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: (e.target as HTMLInputElement).checked }),
      });
    });
    el.querySelector("button")!.addEventListener("click", async () => {
      await fetch(`/api/heartbeat/${t.id}`, { method: "DELETE" });
      renderTasks();
    });
    list.appendChild(el);
  }
}

$("addTask").addEventListener("click", async () => {
  const body = {
    title: $<HTMLInputElement>("tTitle").value || "Recurring task",
    instruction: $<HTMLInputElement>("tInstruction").value,
    intervalSec: Number($<HTMLInputElement>("tInterval").value) || 1800,
    enabled: true,
  };
  await fetch("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  $<HTMLInputElement>("tTitle").value = "";
  $<HTMLInputElement>("tInstruction").value = "";
  renderTasks();
});

// ─── Go ───────────────────────────────────────────────────────────────────────
initSpeech();
void populatePersonas();
connect();
// speechSynthesis voices load async in some browsers
if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = () => {};
