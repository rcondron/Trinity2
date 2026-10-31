import { createServer } from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config, live, serviceStatus } from "./config.js";
import { createMemoryStore } from "./db/memory.js";
import { getActivePersona, setActivePersona, getPersona } from "./db/sqlite.js";
import { seed } from "./db/seed.js";
import { createApi } from "./http.js";
import { startHeartbeat } from "./heartbeat.js";
import { Orchestrator } from "./orchestrator.js";
import { registerBuiltins } from "./tools/builtins.js";
import { loadSkills } from "./tools/registry.js";
import type { ClientEvent, ServerEvent } from "./types.js";

async function main() {
  const memory = await createMemoryStore();
  await seed(memory);

  registerBuiltins();
  const skills = await loadSkills();
  console.log(`[tools] builtins + ${skills.length} skill(s): ${skills.join(", ") || "none"}`);

  const orchestrator = new Orchestrator(memory);

  const app = express();
  app.use("/api", createApi(memory));
  app.get("/healthz", (_req, res) => res.json({ ok: true, services: serviceStatus() }));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();
  const broadcast = (e: ServerEvent) => {
    const msg = JSON.stringify(e);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };

  wss.on("connection", (ws) => {
    clients.add(ws);
    const emit = (e: ServerEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };
    emit({ type: "ready", persona: getActivePersona(), services: serviceStatus() });

    ws.on("message", async (raw) => {
      let ev: ClientEvent;
      try {
        ev = JSON.parse(raw.toString()) as ClientEvent;
      } catch {
        return emit({ type: "error", text: "bad message" });
      }
      try {
        switch (ev.type) {
          case "hello":
            emit({ type: "ready", persona: getActivePersona(), services: serviceStatus() });
            break;
          case "text":
            await orchestrator.handleUserText(ev.text, emit);
            break;
          case "set_persona":
            if (getPersona(ev.id)) {
              setActivePersona(ev.id);
              emit({ type: "ready", persona: getActivePersona(), services: serviceStatus() });
            }
            break;
          case "audio":
            // Live voice: the browser sends the user's recorded speech (a data: URI
            // or raw base64). PersonaPlex returns Trinity's reply audio + transcript.
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

    ws.on("close", () => clients.delete(ws));
  });

  startHeartbeat(orchestrator, broadcast);

  server.listen(config.port, () => {
    const s = serviceStatus();
    console.log(`\n  Trinity engine on http://localhost:${config.port}`);
    console.log(`  services: ${Object.entries(s).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    console.log(`  (mock services are fully functional; add keys in .env to go live)\n`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
