import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The skill sandbox (host side). A skill Trinity created never runs inside the engine: each
 * operation (describe it, or run it once) gets its own short-lived child process running
 * runner.mjs, with
 *  - Node's permission model: it may read only the runner and that one skill file — no fs
 *    writes, child processes, workers, native addons, WASI or inspector (node:sqlite, which
 *    the permission model doesn't cover, is switched off);
 *  - a clean environment: none of the engine's API keys (on Windows, libuv adds a few
 *    system variables such as SystemRoot and USERPROFILE by itself);
 *  - a 128 MB heap, a hard timeout (the process is killed) and an output cap;
 *  - the runner's own guards: no imports at all, nothing on this machine or the local
 *    network, no signals to other processes (see runner.mjs).
 * The network stays open so skills can call public web APIs. Verified on Node 24 / Windows.
 */
const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const MARK = "\u0001trinity-sandbox ";

/** A tool run answers inside the agent's 15 s tool limit; self-tests may take a little longer. */
export const RUN_TIMEOUT_MS = 12_000;
export const TEST_TIMEOUT_MS = 15_000;
const DESCRIBE_TIMEOUT_MS = 8_000;
const MAX_STDOUT = 512 * 1024; // the result line (with any render HTML)
const MAX_STDERR = 256 * 1024; // past this the skill is just spamming its console: stopped
const KEEP_LOG = 4000; // the tail of the skill's console output we keep (for repairs and tests)
const MAX_PARALLEL = 4;

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

/** Load the module in the sandbox and read its metadata (name, description, input, examples). */
export async function describeSkill(file: string): Promise<SandboxResult<SkillMeta>> {
  const r = await sandboxed<SkillMeta>(file, { op: "describe" }, DESCRIBE_TIMEOUT_MS);
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
export function runSkill(file: string, args: Record<string, unknown>, timeoutMs = RUN_TIMEOUT_MS): Promise<SandboxResult<unknown>> {
  return sandboxed<unknown>(file, { op: "run", args }, timeoutMs);
}

/** The node flags for one sandboxed run (exported for the verification scripts). */
export function sandboxArgs(file: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${RUNNER}`,
    `--allow-fs-read=${file}`,
    "--no-experimental-sqlite",
    "--max-old-space-size=128",
    "--disable-warning=ExperimentalWarning",
    RUNNER,
    file,
  ];
}

/** Only what Node itself needs (and the time zone / CA settings) — never the engine's keys. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["SystemRoot", "PATH", "TZ", "NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS"]) {
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

function sandboxed<T>(file: string, request: Record<string, unknown>, timeoutMs: number): Promise<SandboxResult<T>> {
  const absolute = path.resolve(file);
  return withSlot(
    () =>
      new Promise<SandboxResult<T>>((resolve) => {
        const started = Date.now();
        let stdout = "";
        let outBytes = 0;
        let errBytes = 0;
        let log = "";
        let stopped: "timeout" | "output" | null = null;
        let settled = false;

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
        const finish = (r: SandboxResult<T>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // The answer is in: whatever the skill left running (timers, sockets) goes with it.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve(r);
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          outBytes += Buffer.byteLength(chunk);
          if (outBytes > MAX_STDOUT) return stop("output");
          stdout += chunk;
          const at = stdout.indexOf(MARK);
          const end = at === -1 ? -1 : stdout.indexOf("\n", at);
          if (end !== -1) finish(parseResult<T>(stdout.slice(at + MARK.length, end), Date.now() - started, log));
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
        child.stdin.end(JSON.stringify(request));
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
