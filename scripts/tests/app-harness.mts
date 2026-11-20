// The real app in a real browser against stand-ins, with nothing real behind it: a routing model that reports itself
// down so the engine's keyword rules route (8892), a model gateway with a few canned replies (8893), a transcriber that
// hears nothing (8894), a PersonaPlex that "speaks" the words it is given — it echoes them as its own text, as the pod
// does, and sends a steady 220 Hz tone as the audio (8895) — the engine itself in-process (8897, its own data folder,
// no keys), and dist/web on 8898 with /api, /healthz and the sockets passed through. Typed turns work; the microphone
// is heard by nobody. Build dist/web first.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through its launcher (npm test -- --only <name>, or npm run harness for the app harness): it gives the engine a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const DIST = path.normalize(`${REPO}/dist/web`);
const ENGINE = 8897;
const WEB = 8898;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ── stand-in Jev: "down", so the engine's own keyword rules route (as when the routing model can't be reached) ──
const jev = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the stand-in routing model leaves routing to the keyword rules" }));
  });
});
await new Promise<void>((r) => jev.listen(8892, "127.0.0.1", r));

// ── fake model gateway ──
function scripted(system: string, user: string): string {
  if (!/live voice call/.test(system)) return "{}";
  const u = user.toLowerCase();
  if (u.includes("how are you")) return "I'm doing great, thanks for asking.";
  if (u.includes("sky blue")) return "Air scatters blue light the most. That is called Rayleigh scattering. Sunsets are red for the same reason.";
  if (u === "okay." || u === "hmm.") return "SILENT";
  return "Sure. That sounds good to me.";
}
const gateway = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ["brain-x", "fast-x", "reply-x", "plan-x", "backup-x", "deepseek-v4-1-flash-1017-ultrafast", "kimi-k3"].map((id) => ({ id })) }));
    return;
  }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as { model: string; stream?: boolean; messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages[body.messages.length - 1]?.content ?? "";
    const text = scripted(system, user);
    log(`gw: ${body.model}${body.stream ? " (stream)" : ""} ← ${JSON.stringify(user.slice(0, 60))} → ${JSON.stringify(text.slice(0, 60))}`);
    if (!body.stream) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      }, 150);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tokens = text.split(/(?<=\s)/);
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (i >= tokens.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i++] } }] })}\n\n`);
      timer = setTimeout(next, 25);
    };
    timer = setTimeout(next, 350);
    res.on("close", () => clearTimeout(timer));
  });
});
await new Promise<void>((r) => gateway.listen(8893, "127.0.0.1", r));

// ── fake PersonaPlex: forced words come back as its own text, with a 220 Hz tone as the voice ──
type Sock = { send: (d: unknown) => void; on: (e: string, f: (...a: unknown[]) => void) => void; readyState: number };
const RATE = 24000;
const FRAME = 1920; // 80 ms
const TONE_HZ = Number(process.env.TONE_HZ ?? 220);
const ppServer = new WebSocketServer({ port: 8895, host: "127.0.0.1" });
ppServer.on("connection", (ws: Sock) => {
  log("pp: session opened");
  ws.send(Buffer.from([0x00]));
  let phase = 0;
  let toneFrames = 0; // frames of tone still to send
  let queue: string[] = []; // words still to "say"
  let held = false;
  const frame = (tone: boolean) => {
    const pcm = Buffer.alloc(1 + FRAME * 2);
    pcm[0] = 1;
    if (tone)
      for (let i = 0; i < FRAME; i++) {
        pcm.writeInt16LE(Math.round(Math.sin(phase) * 0.3 * 32767), 1 + i * 2);
        phase += (2 * Math.PI * TONE_HZ) / RATE;
      }
    return pcm;
  };
  // One frame out every 80 ms, like the pod: tone while it has words to say, silence otherwise.
  let tick = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    tick++;
    if (queue.length && tick % 4 === 0) ws.send(Buffer.concat([Buffer.from([2]), Buffer.from(queue.shift()!, "utf8")])); // ~3 words a second
    ws.send(frame(toneFrames > 0));
    if (toneFrames > 0) toneFrames--;
  }, 80);
  ws.on("message", (data: unknown, isBinary: unknown) => {
    if (!isBinary) return;
    const b = data as Buffer;
    if (b[0] === 3) {
      const text = b.subarray(1).toString("utf8");
      log("pp: SAYS", JSON.stringify(text));
      const words = (text.match(/\S+/g) ?? []).map((w) => ` ${w}`); // the pod's text pieces start with a space
      queue.push(...words);
      toneFrames += words.length * 4;
    } else if (b[0] === 4) {
      held = b[1] === 1;
      log("pp: hold", held ? "on" : "off");
    } else if (b[0] === 5) {
      log("pp: FLUSH (", queue.length, "words dropped )");
      queue = [];
      toneFrames = 0;
    }
  });
  ws.on("close", () => {
    clearInterval(timer);
    log("pp: session closed");
  });
});
// ── fake Deepgram ──
const dgServer = new WebSocketServer({ port: 8894, host: "127.0.0.1" });
dgServer.on("connection", (ws: Sock) => ws.on("message", () => {}));

// ── the engine, in-process ──
process.env.PORT = String(ENGINE);
process.env.HOST = "127.0.0.1";
await import(pathToFileURL(`${REPO}/server/src/index.ts`).href);

// ── dist/web, with the engine's routes passed through — adding the secret Trinity's own web server adds (auth.ts) ──
const { proxyKey } = await import(pathToFileURL(`${REPO}/server/src/auth.ts`).href);
const PROXY_KEY: string = proxyKey();
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};
const web = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/api") || url.pathname === "/healthz") {
    const up = http.request({ host: "127.0.0.1", port: ENGINE, method: req.method, path: req.url, headers: { ...req.headers, "x-trinity-proxy": PROXY_KEY } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
    return;
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});
web.on("upgrade", (req, socket, head) => {
  const up = net.connect(ENGINE, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i]!.toLowerCase() !== "x-trinity-proxy") lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push(`x-trinity-proxy: ${PROXY_KEY}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
web.listen(WEB, "127.0.0.1", () => log(`harness: app on http://127.0.0.1:${WEB}/ (engine ${ENGINE}, data ${process.env.TRINITY_DATA_DIR})`));
