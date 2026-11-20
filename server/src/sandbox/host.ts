import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SafeFetchError, safeFetch, type SafeFetchOptions } from "../services/safe-fetch.js";

/**
 * The skill sandbox (host side). A skill Trinity created never runs inside the engine: each
 * operation (describe it, or run it once) gets its own short-lived child process running
 * runner.mjs, with
 *  - Node's permission model: it may read only the runner and that one skill file — no fs
 *    writes, child processes, workers, native addons, WASI or inspector (node:sqlite, which
 *    the permission model doesn't cover, is switched off), no code built from strings, and
 *    frozen built-ins (a skill can't replace Array.prototype.some or Function.prototype.call);
 *  - a clean environment: none of the engine's API keys, no PATH (on Windows, libuv adds a
 *    few system variables such as SystemRoot and USERPROFILE by itself);
 *  - a 128 MB heap, a hard timeout (the process is killed) and an output cap;
 *  - NO network of its own. The runner refuses every socket connection and takes `process`,
 *    the stdio streams and every socket-making global away from the skill (see runner.mjs).
 *    A skill's `fetch` arrives here as a message and THIS process makes the request, with the
 *    safe fetcher: http/https only, the name resolved here, loopback / link-local / private /
 *    unique-local addresses refused at connect time and on every redirect hop, size and time
 *    caps, a limit on how many requests one run may make. The rule that keeps a skill off this
 *    machine and the local network therefore runs outside the skill's realm: nothing a skill
 *    does to the built-ins in its own process changes it.
 * Verified on Node 24 / Windows.
 */
const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const MARK = "\u0001trinity-sandbox ";
const RPC = "\u0001trinity-rpc ";

/** A tool run answers inside the agent's 15 s tool limit; self-tests may take a little longer. */
export const RUN_TIMEOUT_MS = 12_000;
export const TEST_TIMEOUT_MS = 15_000;
const DESCRIBE_TIMEOUT_MS = 8_000;
const MAX_STDOUT = 8 * 1024 * 1024; // the result line (with any render HTML) and the fetch requests (bodies up to 1 MB each)
const MAX_STDERR = 256 * 1024; // past this the skill is just spamming its console: stopped
const KEEP_LOG = 4000; // the tail of the skill's console output we keep (for repairs and tests)
const LOG_GRACE_MS = 150; // after the result line, how long the last of the console output may take to arrive
const MAX_PARALLEL = 4;
/** What one run may ask of the network. */
const MAX_FETCHES = 40;
const MAX_FETCHES_AT_ONCE = 8;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BODY = 1024 * 1024;
const MAX_RESPONSE_BODY = 5 * 1024 * 1024;
/** …and in all: what one run may download (answers wait in this process until the skill reads them). */
const MAX_DOWNLOAD = 20 * 1024 * 1024;

/** What a skill module says about itself — straight from the module, not yet validated. */
export interface SkillMeta {
  name?: unknown;
  description?: unknown;
  input?: unknown;
  examples?: unknown;
  hasRun?: boolean;
}

export type SandboxFailure = "load" | "run" | "timeout" | "memory" | "output" | "crash";

export type SandboxResult<T> =
  | { ok: true; value: T; ms: number; log: string }
  /** `error` is in words, with the skill's own stack frames when it threw (for the repair round). */
  | { ok: false; kind: SandboxFailure; error: string; ms: number; log: string };

/** Test hooks for the host-side fetcher: a stand-in resolver, and an exception that lets a test reach its own local server. */
export type SandboxOptions = Pick<SafeFetchOptions, "lookup" | "allowAddress">;

/** Load the module in the sandbox and read its metadata (name, description, input, examples). */
export async function describeSkill(file: string, options: SandboxOptions = {}): Promise<SandboxResult<SkillMeta>> {
  const r = await sandboxed<SkillMeta>(file, { op: "describe" }, DESCRIBE_TIMEOUT_MS, options);
  if (!r.ok && r.kind === "load" && r.error.startsWith("SyntaxError")) {
    const detail = await syntaxDetail(path.resolve(file));
    if (detail) return { ...r, error: detail };
  }
  return r;
}

/**
 * A syntax error's line and caret, from `node --check` (under the same permission model and
 * clean env): an ESM SyntaxError caught in the runner carries only its message.
 */
function syntaxDetail(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${file}`, "--check", file], {
      env: cleanEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (err.length < 8000) err += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // "<file>:4", the code line, the caret, a blank line, then "SyntaxError: …".
      const lines = err.replaceAll(file, "skill.mjs").split(/\r?\n/);
      const start = lines.findIndex((l) => l.startsWith("skill.mjs:"));
      const end = lines.findIndex((l) => l.startsWith("SyntaxError"));
      resolve(start !== -1 && end > start ? lines.slice(start, end + 1).filter((l) => l.trim()).join("\n") : null);
    });
  });
}

/** Call the skill's run(args) once in the sandbox; resolves with whatever it returned. */
export function runSkill(file: string, args: Record<string, unknown>, timeoutMs = RUN_TIMEOUT_MS, options: SandboxOptions = {}): Promise<SandboxResult<unknown>> {
  return sandboxed<unknown>(file, { op: "run", args }, timeoutMs, options);
}

/** The node flags for one sandboxed run (exported for the verification scripts). */
export function sandboxArgs(file: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${RUNNER}`,
    `--allow-fs-read=${file}`,
    "--no-experimental-sqlite",
    "--disallow-code-generation-from-strings",
    "--frozen-intrinsics",
    "--max-old-space-size=128",
    "--disable-warning=ExperimentalWarning",
    RUNNER,
    file,
  ];
}

/** Only what Node itself needs — never the engine's keys, and no PATH (a skill starts no programs and makes no connections). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["SystemRoot", "TZ"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

let running = 0;
const waiting: (() => void)[] = [];

/** At most MAX_PARALLEL sandboxes at once; the rest wait their turn. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** A fetch a skill asked for, as it arrives from the runner (nothing in it is trusted). */
interface FetchAsk {
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: Buffer | null;
  redirect: "follow" | "manual" | "error";
}

function readAsk(msg: Record<string, unknown>): FetchAsk | string {
  if (typeof msg.url !== "string" || msg.url.length > 8192) return "the URL is missing or too long";
  const method = typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
  const headers: [string, string][] = [];
  if (Array.isArray(msg.headers)) {
    for (const pair of msg.headers.slice(0, 64)) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" && pair[0].length <= 128 && pair[1].length <= 8192) headers.push([pair[0], pair[1]]);
    }
  }
  let body: Buffer | null = null;
  if (typeof msg.body === "string" && msg.body) {
    if (msg.body.length > Math.ceil(MAX_REQUEST_BODY / 3) * 4 + 4) return "the request body is larger than 1 MB";
    body = Buffer.from(msg.body, "base64");
  }
  const redirect = msg.redirect === "manual" || msg.redirect === "error" ? msg.redirect : "follow";
  return { id: msg.id as number, url: msg.url, method, headers, body, redirect };
}

function sandboxed<T>(file: string, request: Record<string, unknown>, timeoutMs: number, options: SandboxOptions): Promise<SandboxResult<T>> {
  const absolute = path.resolve(file);
  return withSlot(
    () =>
      new Promise<SandboxResult<T>>((resolve) => {
        const started = Date.now();
        let pendingOut = "";
        let outBytes = 0;
        let errBytes = 0;
        let log = "";
        let stopped: "timeout" | "output" | null = null;
        let settled = false;
        let result: SandboxResult<T> | null = null;
        let fetches = 0;
        let downloaded = 0;
        const inFlight = new Map<number, AbortController>();

        const child = spawn(process.execPath, sandboxArgs(absolute), {
          cwd: path.dirname(absolute),
          env: cleanEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const stop = (why: "timeout" | "output") => {
          stopped ??= why;
          child.kill("SIGKILL");
        };
        const timer = setTimeout(() => stop("timeout"), timeoutMs);
        const cancelFetches = () => {
          for (const ac of inFlight.values()) ac.abort();
          inFlight.clear();
        };
        const finish = (r: SandboxResult<T>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelFetches();
          // The answer is in: whatever the skill left running (timers, requests) goes with it.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve(r);
        };
        const tell = (reply: Record<string, unknown>) => {
          if (settled || child.stdin.destroyed || !child.stdin.writable) return;
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        };

        /** One fetch for the skill, made here: the skill's process has no network. */
        const doFetch = async (msg: Record<string, unknown>) => {
          const id = msg.id;
          if (typeof id !== "number" || !Number.isFinite(id)) return;
          if (msg.op === "cancel") {
            inFlight.get(id)?.abort();
            inFlight.delete(id);
            return;
          }
          if (msg.op !== "fetch" || inFlight.has(id)) return;
          const ask = readAsk(msg);
          if (typeof ask === "string") return tell({ id, ok: false, code: "url", error: ask });
          if (++fetches > MAX_FETCHES) return tell({ id, ok: false, code: "network", error: `a skill may make at most ${MAX_FETCHES} requests in one run` });
          if (inFlight.size >= MAX_FETCHES_AT_ONCE) return tell({ id, ok: false, code: "network", error: `a skill may have at most ${MAX_FETCHES_AT_ONCE} requests open at once` });
          const tooMuch = `a skill may download at most ${MAX_DOWNLOAD / (1024 * 1024)} MB in one run`;
          if (downloaded >= MAX_DOWNLOAD) return tell({ id, ok: false, code: "too_large", error: tooMuch });
          const ac = new AbortController();
          inFlight.set(id, ac);
          try {
            const res = await safeFetch(ask.url, {
              method: ask.method,
              headers: ask.headers,
              body: ask.body,
              redirect: ask.redirect,
              timeoutMs: Math.max(1000, Math.min(FETCH_TIMEOUT_MS, timeoutMs - (Date.now() - started))),
              maxBytes: Math.min(MAX_RESPONSE_BODY, MAX_DOWNLOAD - downloaded),
              signal: ac.signal,
              ...(options.lookup ? { lookup: options.lookup } : {}),
              ...(options.allowAddress ? { allowAddress: options.allowAddress } : {}),
            });
            if (res.status < 200 || res.status > 599) throw new SafeFetchError("network", `the server answered with status ${res.status}`);
            // (Requests open side by side each started under the limit: counted again as each one lands.)
            if (downloaded + res.bytes.length > MAX_DOWNLOAD) throw new SafeFetchError("too_large", tooMuch);
            downloaded += res.bytes.length;
            tell({
              id,
              ok: true,
              status: res.status,
              statusText: res.statusText.replace(/[^\t\x20-\x7e]/g, "").slice(0, 120),
              headers: [...res.headers].filter(([k, v]) => !/[^\t\x20-\x7e\x80-\xff]/.test(v) && k.length <= 128 && v.length <= 8192),
              body: res.bytes.length ? res.bytes.toString("base64") : null,
              url: res.url,
              redirected: res.redirected,
            });
          } catch (err) {
            const code = err instanceof SafeFetchError ? err.code : "network";
            if (code !== "aborted") tell({ id, ok: false, code, error: String((err as Error)?.message ?? err).slice(0, 300) });
          } finally {
            inFlight.delete(id);
          }
        };

        const onLine = (line: string) => {
          if (line.startsWith(RPC)) {
            // (Once the answer is in, nothing more is fetched for this run.)
            if (result) return;
            let msg: unknown;
            try {
              msg = JSON.parse(line.slice(RPC.length));
            } catch {
              return;
            }
            if (msg !== null && typeof msg === "object") void doFetch(msg as Record<string, unknown>);
            return;
          }
          const at = line.indexOf(MARK);
          if (at === -1 || result) return;
          // The answer is in. The runner exits right after it: give what it logged a moment to arrive too.
          result = parseResult<T>(line.slice(at + MARK.length), Date.now() - started, "");
          clearTimeout(timer);
          cancelFetches();
          setTimeout(() => result && finish({ ...result, log }), LOG_GRACE_MS);
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          outBytes += Buffer.byteLength(chunk);
          if (outBytes > MAX_STDOUT) return stop("output");
          pendingOut += chunk;
          for (;;) {
            const end = pendingOut.indexOf("\n");
            if (end === -1) break;
            const line = pendingOut.slice(0, end);
            pendingOut = pendingOut.slice(end + 1);
            onLine(line);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          errBytes += chunk.length;
          if (errBytes > MAX_STDERR) return stop("output");
          log = (log + chunk).slice(-KEEP_LOG);
        });
        child.on("error", (err) =>
          finish({ ok: false, kind: "crash", error: `the sandbox could not start: ${err.message}`, ms: Date.now() - started, log }),
        );
        child.on("close", (code, signal) => {
          if (result) return finish({ ...result, log });
          const ms = Date.now() - started;
          const fail = (kind: SandboxFailure, error: string) => finish({ ok: false, kind, error, ms, log });
          if (stopped === "timeout") return fail("timeout", `it took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped`);
          if (stopped === "output") return fail("output", "it printed too much output and was stopped");
          if (/heap out of memory|Reached heap limit/i.test(log)) return fail("memory", "it ran out of memory (128 MB) and was stopped");
          if (code === 13) return fail("run", "it never finished: it waited on a promise that never settles");
          const tail = log.trim().split("\n").slice(-4).join("\n");
          fail("crash", `it exited without a result (exit ${code ?? signal})${tail ? `:\n${tail}` : ""}`);
        });

        child.stdin.on("error", () => {}); // it may exit before reading (e.g. a syntax error)
        // Kept open: the answers to the skill's fetches go down it.
        child.stdin.write(`${JSON.stringify(request)}\n`);
      }),
  );
}

function parseResult<T>(line: string, ms: number, log: string): SandboxResult<T> {
  let msg: { status?: string; value?: unknown; stage?: string; error?: string; stack?: string };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return { ok: false, kind: "crash", error: "it sent back an unreadable result", ms, log };
  }
  if (msg.status === "ok") return { ok: true, value: msg.value as T, ms, log };
  const error = [msg.error ?? "unknown error", msg.stack].filter(Boolean).join("\n");
  return { ok: false, kind: msg.stage === "load" ? "load" : "run", error, ms, log };
}
