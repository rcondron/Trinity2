import { createServer } from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { getEndpoints, live, serviceStatus } from "./settings.js";
import { createMemoryStore, rewordCallerMemories } from "./db/memory.js";
import { getActivePersona, setActivePersona, getPersona, getProfileName } from "./db/sqlite.js";
import { getSpeechRate, onSpeechRateChange } from "./services/speech-rate.js";
import { seed } from "./db/seed.js";
import { emitPersonaActivated } from "./events.js";
import { createApi } from "./http.js";
import { startHeartbeat } from "./heartbeat.js";
import { Orchestrator } from "./orchestrator.js";
import { VoiceCall, hasVoiceCall, setVoiceNotifier, setVoiceResolver, setWakeNotifier } from "./services/voice-call.js";
import { ensureVoiceOnPod } from "./services/voices.js";
import { registerGameContext, sweepGamesOnBoot } from "./game/integration.js";
import { registerStoryTools } from "./game/story-tools.js";
import { registerGameTools } from "./game/tools.js";
import { registerAskTools } from "./tools/ask.js";
import { registerBuiltins } from "./tools/builtins.js";
import { registerCodingTools } from "./tools/coding.js";
import { setTellFallback } from "./agent/tell.js";
import { handleBrowserUpgrade } from "./services/browser-bridge.js";
import { registerBrowserTools } from "./tools/browser.js";
import { loadForgedSkills, registerForgeTools } from "./tools/forge.js";
import { registerMemoryTools } from "./tools/memory.js";
import { loadSkills } from "./tools/registry.js";
import { registerScheduleTools } from "./tools/schedule.js";
import { bg, isAllowedHost, isAllowedOrigin, safeInterval } from "./util/bg.js";
import { workspace, type WorkspaceClientEvent } from "./workspace/bus.js";
import type { ClientEvent, ServerEvent } from "./types.js";

// A voice app must not die on one stray rejection (Node 24 exits on unhandled ones).
process.on("unhandledRejection", (reason) => {
  console.error("[engine] unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[engine] uncaught exception:", err.stack ?? err.message);
});

const HOST = process.env.HOST || "127.0.0.1";
const STARTED_AT = Date.now();
const VOICE_RE = /^((NAT|VAR)[FM]\d|custom:[a-z0-9][a-z0-9_-]{0,63})$/;
/** /ws and /ws/workspace peers are pinged this often; one that hasn't answered the last ping is dropped. */
const PEER_PING_MS = 30_000;

/**
 * Drop peers that vanished without a close (a phone that left the network, a laptop that slept):
 * they'd still count as someone to tell (canDeliver), and a due reminder would go to a dead socket.
 * Browsers answer pings on their own.
 */
function dropSilentPeers(wss: WebSocketServer): void {
  const answered = new WeakSet<WebSocket>();
  wss.on("connection", (ws: WebSocket) => {
    answered.add(ws);
    ws.on("pong", () => answered.add(ws));
  });
  safeInterval(
    "ws-ping",
    () => {
      for (const ws of wss.clients) {
        if (!answered.delete(ws)) ws.terminate();
        else if (ws.readyState === ws.OPEN) ws.ping();
      }
    },
    PEER_PING_MS,
  );
}

async function main() {
  const memory = await createMemoryStore();
  const reworded = await rewordCallerMemories(memory);
  if (reworded) console.log(`[memory] reworded ${reworded} saved memor${reworded === 1 ? "y" : "ies"} from "the caller" to "the user"`);
  await seed(memory);

  // The tools Jev routes to: built-ins, the coding skill, memory, scheduling, skill forging,
  // and the Game Master's toolset (only for personas that enable it).
  registerBuiltins();
  registerCodingTools();
  registerAskTools();
  registerMemoryTools();
  registerScheduleTools();
  registerForgeTools();
  registerGameTools();
  registerStoryTools();
  registerGameContext();
  workspace.setOverlays(getEndpoints().workspaceOverlays); // Settings → Workspace window: what windows draw over the board
  registerBrowserTools();
  // Custom voices are uploaded to the pod (if missing) before a call connects with them.
  setVoiceResolver(ensureVoiceOnPod);
  const skills = await loadSkills();
  const forged = await loadForgedSkills();
  console.log(
    `[tools] ${skills.length} skill(s): ${skills.join(", ") || "none"}; ${forged.length} created by Trinity: ${forged.join(", ") || "none"}`,
  );
  // Settle art/players left mid-generation by the last run and re-show the game on screen.
  await sweepGamesOnBoot();

  const orchestrator = new Orchestrator(memory);

  const app = express();
  app.disable("x-powered-by");
  // First: only requests addressed to this machine (see isAllowedHost — DNS rebinding).
  app.use((req, res, next) => (isAllowedHost(req.headers.host) ? next() : res.status(403).json({ error: "forbidden host" })));
  app.use("/api", createApi(memory, { onPersonaActivated: () => orchestrator.resetContext() }));
  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, services: serviceStatus(), bootId: workspace.snapshot().epoch, startedAt: STARTED_AT }),
  );

  const server = createServer(app);
  // WebSocket endpoints share the HTTP server: /ws = JSON control + text turns,
  // /call = the real-time binary audio loop, /ws/workspace = live workspace windows.
  const wss = new WebSocketServer({ noServer: true });
  const callWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const workspaceWss = new WebSocketServer({ noServer: true });
  dropSilentPeers(wss);
  dropSilentPeers(workspaceWss);
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // /ext = the Chrome extension (its origin is chrome-extension://…; the pairing token is the gate).
    const origin = req.headers.origin;
    const extensionOrigin = origin === undefined || origin.startsWith("chrome-extension://") || isAllowedOrigin(origin);
    if (pathname === "/ext") {
      if (!isAllowedHost(req.headers.host) || !extensionOrigin) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
      }
      return handleBrowserUpgrade(req, socket, head);
    }
    if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else if (pathname === "/call") callWss.handleUpgrade(req, socket, head, (ws) => callWss.emit("connection", ws, req));
    else if (pathname === "/ws/workspace")
      workspaceWss.handleUpgrade(req, socket, head, (ws) => workspaceWss.emit("connection", ws, req));
    else socket.destroy();
  });

  // Live workspace: every window (standalone or the main app's pane) subscribes here.
  workspaceWss.on("connection", (ws) => {
    const unsubscribe = workspace.subscribe((e) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    });
    ws.on("message", (raw) => {
      try {
        workspace.handleClient(JSON.parse(raw.toString()) as WorkspaceClientEvent);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  });

  // Real-time voice. The engine owns the single PersonaPlex session (see VoiceCall).
  callWss.on("connection", (ws, req) => {
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const voice = q.get("voice") ?? undefined;
    const prompt = q.get("prompt") ?? undefined;
    const call = new VoiceCall(ws, memory, {
      voice: voice && VOICE_RE.test(voice) ? voice : undefined,
      prompt: prompt ? prompt.slice(0, 200) : undefined,
      standby: q.get("standby") === "1",
      wake: q.get("wake") === "1",
    });
    bg("voice-call", call.start());
  });

  const clients = new Set<WebSocket>();
  const broadcast = (e: ServerEvent) => {
    const msg = JSON.stringify(e);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  // News from work that finished later (a forged skill, a content card) that no call said in full goes to every open app, like a heartbeat line.
  setTellFallback((text, spoken, id) => orchestrator.showUnprompted(text, broadcast, spoken, id));
  // The voice came back from a sample ("free": the tab that lent it re-warms) — or a call took it ("taken").
  setVoiceNotifier((status) => broadcast({ type: "voice", status }));
  // A line no voice could say is owed, and no call is up anywhere: one tab warms one, so the live voice says it.
  setWakeNotifier(() => broadcast({ type: "wake" }));
  // The user's name rides along: the voice hears it at connect, so the app re-warms a session set up before it changed.
  const readyEvent = (): ServerEvent => ({
    type: "ready",
    persona: getActivePersona(),
    services: serviceStatus(),
    profileName: getProfileName(),
    speechRate: getSpeechRate(),
  });
  onSpeechRateChange((rate) => broadcast({ type: "speech_rate", rate }));

  wss.on("connection", (ws) => {
    clients.add(ws);
    const emit = (e: ServerEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };
    emit(readyEvent());

    ws.on("message", (raw) => {
      let ev: ClientEvent;
      try {
        ev = JSON.parse(raw.toString()) as ClientEvent;
      } catch {
        return emit({ type: "error", text: "bad message" });
      }
      bg("ws", async () => {
        try {
          switch (ev.type) {
            case "hello":
              emit(readyEvent());
              break;
            case "text":
              await orchestrator.handleUserText(String(ev.text ?? "").slice(0, 4000), emit);
              break;
            case "set_persona":
              if (getPersona(ev.id)) {
                setActivePersona(ev.id);
                orchestrator.resetContext();
                const persona = getActivePersona();
                emitPersonaActivated(persona);
                broadcast(readyEvent());
                emit({ type: "status", text: `Switched to ${persona.name}` });
              }
              break;
            case "audio":
              // Legacy turn-based voice (fal): the browser sends one recorded clip.
              if (live.voice) {
                const audioUrl = ev.chunk.startsWith("data:") ? ev.chunk : `data:audio/webm;base64,${ev.chunk}`;
                await orchestrator.handleUserAudio(audioUrl, emit);
              }
              break;
            case "barge_in":
            case "stop":
              break;
          }
        } catch (err) {
          emit({ type: "error", text: (err as Error).message });
        }
      });
    });

    ws.on("close", () => clients.delete(ws));
  });

  startHeartbeat(orchestrator, broadcast, {
    // Someone can get a due item: an open app (it shows it, and the live voice says it once it can be heard), a
    // workspace window (it shows the toast) or a voice call.
    canDeliver: () => [...clients].some((c) => c.readyState === c.OPEN) || workspace.subscribers > 0 || hasVoiceCall(),
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n  Port ${config.port} is already in use — another Trinity engine is probably still running.\n` +
          `  Run \`node scripts/free-ports.mjs\` (or \`npm run dev\`, which does it for you) and start again.\n`,
      );
      process.exit(1);
    }
    console.error("[engine] server error:", err.message);
  });

  server.listen(config.port, HOST, () => {
    const s = serviceStatus();
    console.log(`\n  Trinity engine on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${config.port}`);
    console.log(`  services: ${Object.entries(s).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    console.log(`  (mock services are fully functional; add keys in .env to go live)\n`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
