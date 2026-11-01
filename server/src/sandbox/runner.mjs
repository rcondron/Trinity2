/**
 * Sandbox runner — the child-process half of the skill sandbox (see host.ts). It runs ONE
 * operation on ONE skill Trinity created ("describe" reads its metadata, "run" calls it
 * with arguments) and prints one result line on stdout.
 *
 * The host starts it under Node's permission model (it may read only this file and the
 * skill file: no fs writes, child processes, workers, addons, WASI or inspector), with a
 * clean environment (no API keys), a 128 MB heap and a hard timeout. Before the skill
 * loads, this file closes what the permission model leaves open (verified on Node 24):
 *  - imports: a skill may import NOTHING — no node:* builtins (node:sqlite writes files and
 *    node:os can reprioritize other processes even under --permission), no packages, no
 *    data: URLs. Everything a skill needs is a global (fetch, URL, Intl, crypto, Buffer…).
 *  - network: fetch/WebSocket stay open for public web APIs, but connections to this
 *    machine or the local network (the engine's own API, router pages, cloud metadata) and
 *    local sockets/pipes are refused, checked on the resolved address (no DNS rebinding).
 *  - process: no signals to other processes, no diagnostic reports.
 *
 * Protocol: stdin = one JSON request {op: "describe"} | {op: "run", args}; stdout = one line
 * MARK + {status: "ok", value} | {status: "error", stage, error, stack}. What the skill logs
 * goes to stderr. Plain JavaScript on purpose: the child runs without a TypeScript loader.
 */
import { Console } from "node:console";
import dns from "node:dns";
import { registerHooks } from "node:module";
import net from "node:net";
import { pathToFileURL } from "node:url";

const MARK = "\u0001trinity-sandbox ";
const skillFile = process.argv[2] ?? "";
const skillUrl = pathToFileURL(skillFile).href;
const writeOut = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
let answered = false;

function denied(what) {
  return Object.assign(new Error(`Skills can't use ${what} (sandbox)`), { code: "ERR_ACCESS_DENIED" });
}

// ── stdout is the result channel: the skill's console output goes to stderr ─────────────
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

// ── imports: only the skill module itself loads ──────────────────────────────────────────
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === skillUrl) return nextResolve(specifier, context);
    throw Object.assign(new Error(`Skills can't import modules (sandbox): ${String(specifier).slice(0, 80)}`), {
      code: "ERR_ACCESS_DENIED",
    });
  },
});
process.getBuiltinModule = () => {
  throw denied("Node modules");
};

// ── process: nothing that reaches another process or writes files ────────────────────────
for (const name of ["kill", "_kill", "_debugProcess", "_debugEnd", "execve"]) {
  if (typeof process[name] === "function")
    process[name] = () => {
      throw denied("signals or other processes");
    };
}
try {
  Object.defineProperty(process, "report", { value: Object.freeze({}), configurable: false, writable: false });
} catch {
  /* not configurable on this Node: writeReport is still refused by the permission model */
}

// ── network: public internet only ────────────────────────────────────────────────────────
const privateNets = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // "this network" (0.0.0.0 reaches localhost)
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback: the engine's own API lives here
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3], // multicast + reserved
])
  privateNets.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 127], // :: and ::1
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
])
  privateNets.addSubnet(address, prefix, "ipv6");

/** IPv4 inside an IPv6 address (::ffff:a.b.c.d, NAT64 64:ff9b::/96), else null. */
function embeddedV4(v6) {
  const h = new URL(`http://[${v6}]/`).hostname.slice(1, -1).toLowerCase(); // canonical form
  const m = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPrivate(address) {
  try {
    const family = net.isIP(address);
    if (family === 4) return privateNets.check(address, "ipv4");
    if (family === 6) {
      const v4 = embeddedV4(address);
      return v4 ? privateNets.check(v4, "ipv4") : privateNets.check(address, "ipv6");
    }
  } catch {
    /* unparseable (e.g. a zone id): refuse */
  }
  return true;
}

const realLookup = dns.lookup;
/** dns.lookup that refuses names resolving to a private address (checked on what connect will use). */
function guardedLookup(hostname, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : typeof options === "number" ? { family: options } : (options ?? {});
  realLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((a) => isPrivate(a.address)))
      return cb(denied(`the local network (${hostname} is a private address)`));
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

/** net.Socket#connect's argument forms, as [options, callback]. */
function connectArgs(args) {
  if (Array.isArray(args[0])) return [{ ...(args[0][0] ?? {}) }, args[0][1]]; // net.connect()'s pre-normalized form
  const [a, b, c] = args;
  if (a !== null && typeof a === "object") return [{ ...a }, typeof b === "function" ? b : undefined];
  if (typeof a === "string" && Number.isNaN(Number(a))) return [{ path: a }, typeof b === "function" ? b : undefined];
  const options = { port: a };
  if (typeof b === "string") options.host = b;
  return [options, [b, c].find((x) => typeof x === "function")];
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const [options, cb] = connectArgs(args);
  if (options.path !== undefined && options.path !== null) throw denied("local sockets or pipes");
  const host = String(options.host || "localhost").replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(host)) {
    if (isPrivate(host)) throw denied(`the local network (${host})`);
  } else if (/(^|\.)localhost\.?$/i.test(host)) throw denied(`this machine (${host})`);
  // Our lookup replaces any caller-supplied one, so a resolved address can't dodge the check.
  return realConnect.call(this, { ...options, host, lookup: guardedLookup }, cb);
};

// ── the operation ────────────────────────────────────────────────────────────────────────

/** JSON.stringify replacer: BigInt → string; functions, symbols and cycles dropped. */
function jsonSafe() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  };
}

function answer(payload) {
  if (answered) return;
  answered = true;
  let line;
  try {
    line = JSON.stringify(payload, jsonSafe());
  } catch (err) {
    line = JSON.stringify({ status: "error", stage: "result", error: `the result isn't plain data: ${err?.message ?? err}` });
  }
  writeOut(`${MARK}${line}\n`, () => exit(0));
  setTimeout(() => exit(0), 1000).unref();
}

/** The error in words, with the skill's own stack frames (file path shortened to "skill.mjs"). */
function failure(stage, err) {
  const isErr = err instanceof Error;
  const message = isErr ? `${err.name}: ${err.message}` : `thrown value: ${String(err)}`;
  const lines = isErr && typeof err.stack === "string" ? err.stack.split("\n") : [];
  const stack = lines
    .filter((l) => l.includes(skillUrl))
    .slice(0, 6)
    .map((l) => l.replaceAll(skillUrl, "skill.mjs").trim());
  // A syntax error's location comes first in its stack ("file:///…/x.skill.mjs:12").
  if (stack.length === 0 && lines[0]?.includes(skillUrl)) stack.push(lines[0].replaceAll(skillUrl, "skill.mjs"));
  return { status: "error", stage, error: message.slice(0, 2000), stack: stack.join("\n") };
}

process.on("uncaughtException", (err) => answer(failure("run", err)));
process.on("unhandledRejection", (err) => answer(failure("run", err)));

let request;
try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  request = JSON.parse(raw || "{}");
} catch (err) {
  answer(failure("request", err));
}

if (request) {
  let skill;
  try {
    skill = (await import(skillUrl)).default;
    if (!skill || typeof skill !== "object") throw new Error("the module has no `export default { … }` object");
  } catch (err) {
    answer(failure("load", err));
  }
  if (skill && request.op === "describe") {
    answer({
      status: "ok",
      value: {
        name: skill.name,
        description: skill.description,
        input: skill.input,
        examples: skill.examples,
        hasRun: typeof skill.run === "function",
      },
    });
  } else if (skill && request.op === "run") {
    try {
      if (typeof skill.run !== "function") throw new Error("the skill has no run(args) function");
      const value = await skill.run(request.args && typeof request.args === "object" ? request.args : {});
      answer({ status: "ok", value });
    } catch (err) {
      answer(failure("run", err));
    }
  } else if (skill) answer({ status: "error", stage: "request", error: `unknown op "${request.op}"`, stack: "" });
}
