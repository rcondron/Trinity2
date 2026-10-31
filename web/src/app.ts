import "./styles.css";
import { Speech } from "./speech.js";
import type { HeartbeatTask, Persona, ServerEvent } from "./protocol.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const orb = $("orb");
const personaName = $("personaName");
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
let voicePreset = "";
let ws: WebSocket | null = null;
const partialTurns = new Map<string, HTMLElement>();

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
      personaName.textContent = ev.persona.name;
      voicePreset = ev.persona.voice;
      renderStatus(ev.services);
      voiceHint.textContent = ev.services.voice === "live"
        ? "Live voice: PersonaPlex"
        : speech?.recognitionSupported
          ? "Mock voice (browser speech). Add FAL_KEY for PersonaPlex."
          : "This browser has no speech recognition — type to Trinity below.";
      break;
    case "transcript":
      renderTurn(ev.turn);
      if (ev.turn.speaker === "trinity" && !ev.turn.partial) speech?.speak(ev.turn.text, voicePreset);
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
    case "workspace":
      workspace.srcdoc = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0f0f18">${ev.html}</body>`;
      workspaceTitle.textContent = ev.title || "Workspace";
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
    el.innerHTML = `<span class="who">${turn.speaker}</span><div class="bubble"></div>`;
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

  micBtn.addEventListener("click", () => {
    if (!speech.recognitionSupported) {
      $("textInput").focus();
      return;
    }
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
  personaName.textContent = saved.name;
  voicePreset = saved.voice;
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
connect();
// speechSynthesis voices load async in some browsers
if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = () => {};
