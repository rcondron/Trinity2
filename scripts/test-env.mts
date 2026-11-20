// Shared set-up for the scripts/test-*.mts suites: a throwaway data folder, no real keys, one line per check.
// Call testEnv() BEFORE importing anything from server/src (the engine reads its environment at import time).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Import an engine module by its path under server/src (after testEnv()). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const imp = (p: string): Promise<any> => import(pathToFileURL(path.join(REPO, "server", "src", p)).href);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The folder `npm test` made for this suite (TRINITY_TEST=1 and a TRINITY_DATA_DIR holding nothing but its empty .env), else null. */
function folderFromRunner(): string | null {
  const given = process.env.TRINITY_TEST ? process.env.TRINITY_DATA_DIR?.trim() : "";
  if (!given) return null;
  const dir = path.resolve(given);
  // Never the checkout's own data folder, and never a folder something has already been written to.
  if (dir === path.join(REPO, "data")) return null;
  try {
    return fs.readdirSync(dir).every((f) => f === "empty.env") ? dir : null;
  } catch {
    return null;
  }
}

/**
 * A fresh data folder and an empty .env for this run. Under `npm test` it is the folder the runner made (and clears
 * afterwards); else the folder goes under TRINITY_TEST_RUN_DIR when set, else a `run` folder beside a scratch
 * checkout named `wt`, else the system temp folder. Returns the folder.
 */
export function testEnv(name: string): string {
  const beside = path.resolve(REPO, "..", "run");
  const base = process.env.TRINITY_TEST_RUN_DIR || (path.basename(REPO) === "wt" && fs.existsSync(beside) ? beside : path.join(os.tmpdir(), "trinity-tests"));
  const dir = folderFromRunner() ?? path.join(base, `${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  const env = path.join(dir, "empty.env");
  fs.writeFileSync(env, "");
  process.env.TRINITY_DATA_DIR = dir;
  process.env.DOTENV_CONFIG_PATH = env;
  process.env.MORDIEM_API_KEY = "test";
  // No other service is live: nothing here may reach a real one. (And the fetcher's test switch is off unless a suite sets it.)
  for (const k of ["MORPH_API_KEY", "TYPESAFE_API_KEY", "DEEPGRAM_API_KEY", "PERSONAPLEX_WS_URL", "FAL_KEY", "SERPAPI_KEY", "SERPAPI_API_KEY", "TAVILY_API_KEY", "WEB_SEARCH_API_KEY", "TRINITY_FETCH_ALLOW"]) process.env[k] = "";
  return dir;
}

let fails = 0;
let checks = 0;

/** One line per check. */
export function check(name: string, ok: boolean, detail = ""): boolean {
  checks++;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
  return ok;
}

/** The summary line and the exit code. */
export function finish(): never {
  console.log(fails ? `\n${fails} FAILED (of ${checks})` : `\nALL PASSED (${checks} checks)`);
  process.exit(fails ? 1 : 0);
}

export interface Api {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  close(): void;
}

/**
 * One of the engine's routers mounted under /api on a local port, as the Settings pages reach it. Calls go
 * through node:http, so a suite's stubbed global fetch (the gateway) is left alone.
 */
export async function serveApi(router: unknown): Promise<Api> {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.json());
  app.use("/api", router as Parameters<typeof app.use>[1]);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    call: (method, route, body) =>
      new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({ host: "127.0.0.1", port, path: `/api${route}`, method, headers: data ? { "content-type": "application/json", "content-length": String(data.length) } : {} }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => {
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* not JSON: the text itself */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        });
        req.on("error", reject);
        req.end(data ?? undefined);
      }),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** A fake gateway reply for a stubbed fetch: {choices: [{message: {content}}]}. */
export function chatReply(content: unknown, status = 200): Response {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status, headers: { "content-type": "application/json" } });
}

/** A fake streamed gateway reply (the coders stream): the text in a few SSE chunks, then [DONE]. */
export function streamReply(text: string): Response {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 400) parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 400) } }] })}\n\n`);
  parts.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n");
  return new Response(parts.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}
