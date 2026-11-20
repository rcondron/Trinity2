/**
 * Sandbox runner — the child-process half of the skill sandbox (see host.ts). It runs ONE
 * operation on ONE skill Trinity created ("describe" reads its metadata, "run" calls it
 * with arguments) and prints one result line on stdout.
 *
 * The host starts it under Node's permission model (it may read only this file and the
 * skill file: no fs writes, child processes, workers, addons, WASI or inspector), with a
 * clean environment (no API keys), a 128 MB heap, no code from strings and a hard timeout.
 *
 * A skill shares this realm, so nothing here trusts a built-in the skill could replace:
 *  - the built-ins are frozen (--frozen-intrinsics): Array.prototype.some, RegExp.prototype.test,
 *    Function.prototype.call and the rest can't be reassigned at all. (Node's own stream and
 *    event code calls listeners through .call / .apply; a replaced one would be handed the
 *    stdio streams as `this`.) And what this file needs is taken ("primordials") before the
 *    skill loads and called without going through a prototype, so it holds without the flag too;
 *  - this process has NO network. Every socket connection is refused outright (there is no
 *    address check to talk round), and `fetch` is a message to the host, which makes the
 *    request in its own process: it resolves the name, refuses loopback, link-local, private
 *    and unique-local addresses on every hop, and caps size and time (services/safe-fetch.ts).
 *    Overriding Array.prototype.some, RegExp.prototype.test or Function.prototype.call in
 *    here changes nothing there;
 *  - `process` is gone from the skill's globals (with it: stdio streams and their raw
 *    handles, _getActiveHandles/_getActiveRequests, binding, kill, env), the console is a
 *    plain object, and the globals that hand out sockets, ports or the HTTP dispatcher
 *    (WebSocket, EventSource, MessageChannel, BroadcastChannel, undici's global dispatcher)
 *    are removed;
 *  - imports: a skill may import NOTHING — no node:* builtins, no packages, no data: URLs.
 *
 * Protocol. stdin: one JSON request line {op: "describe"} | {op: "run", args}, then one line
 * per answered fetch. stdout: RPC + {id, op: "fetch", …} for each request the skill makes,
 * and at the end MARK + {status: "ok", value} | {status: "error", stage, error, stack}. What
 * the skill logs goes to stderr. Plain JavaScript on purpose: the child runs without a
 * TypeScript loader.
 */
import dns from "node:dns";
import { registerHooks } from "node:module";
import net from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

// ── primordials: captured before any skill code exists, called without prototype lookups ──
const ReflectApply = Reflect.apply;
const uncurry =
  (fn) =>
  (self, ...args) =>
    ReflectApply(fn, self, args);
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectAssign = Object.assign;
const JSONStringify = JSON.stringify;
const JSONParse = JSON.parse;
const ErrorCtor = Error;
const TypeErrorCtor = TypeError;
const PromiseCtor = Promise;
const PromiseThen = uncurry(Promise.prototype.then);
const MapCtor = Map;
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const MapDelete = uncurry(Map.prototype.delete);
const MapForEach = uncurry(Map.prototype.forEach);
const WeakSetCtor = WeakSet;
const WeakSetHas = uncurry(WeakSet.prototype.has);
const WeakSetAdd = uncurry(WeakSet.prototype.add);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringSlice = uncurry(String.prototype.slice);
const StringSplit = uncurry(String.prototype.split);
const StringReplaceAll = uncurry(String.prototype.replaceAll);
const StringIncludes = uncurry(String.prototype.includes);
const StringTrim = uncurry(String.prototype.trim);
const ArrayPush = uncurry(Array.prototype.push);
const ArrayJoin = uncurry(Array.prototype.join);
const BufferFrom = Buffer.from;
const BufferToString = uncurry(Buffer.prototype.toString);
const setTimer = setTimeout;
const RequestCtor = Request; // (touching these loads Node's HTTP client, whose dispatcher is put out of reach below)
const ResponseCtor = Response;
const RequestArrayBuffer = uncurry(Request.prototype.arrayBuffer);
const HeadersForEach = uncurry(Headers.prototype.forEach);
const SignalAddListener = uncurry(EventTarget.prototype.addEventListener);
const SignalRemoveListener = uncurry(EventTarget.prototype.removeEventListener);
// (Bound functions keep their target: a later Function.prototype.call or .bind makes no difference to them.)
const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);
const exit = process.exit.bind(process);
const stdin = process.stdin;

const MARK = "\u0001trinity-sandbox ";
const RPC = "\u0001trinity-rpc ";
const MAX_REQUEST_BODY = 1024 * 1024;
const skillFile = process.argv[2] ?? "";
const skillUrl = pathToFileURL(skillFile).href;
let answered = false;

function denied(what) {
  return ObjectAssign(new ErrorCtor(`Skills can't use ${what} (sandbox)`), { code: "ERR_ACCESS_DENIED" });
}

// ── imports: only the skill module itself loads ──────────────────────────────────────────
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === skillUrl) return nextResolve(specifier, context);
    throw ObjectAssign(new ErrorCtor(`Skills can't import modules (sandbox): ${StringSlice(`${specifier}`, 0, 80)}`), { code: "ERR_ACCESS_DENIED" });
  },
});

// ── network: none in this process ────────────────────────────────────────────────────────
// Every connection attempt ends here, whatever its address: there is nothing to decide, so
// nothing a skill could make decide differently. Locked, so it can't be swapped or wrapped.
ObjectDefineProperty(net.Socket.prototype, "connect", {
  value: function connect() {
    throw denied("the network directly: use fetch");
  },
  writable: false,
  configurable: false,
  enumerable: false,
});
dns.lookup = function lookup() {
  throw denied("name lookups: use fetch");
};
// Node's HTTP client keeps its connection pools on well-known global symbols
// (undici.globalDispatcher.1 / .2); a pool is an event emitter that owns sockets. Each is
// replaced with something inert, for good.
const inert = ObjectFreeze({
  dispatch() {
    throw denied("the network directly: use fetch");
  },
  close() {},
  destroy() {},
});
const globalSymbols = [Symbol.for("undici.globalDispatcher.1"), Symbol.for("undici.globalDispatcher.2")];
for (const s of Object.getOwnPropertySymbols(globalThis)) {
  if (StringIndexOf(`${s.description}`, "undici.") === 0 && globalSymbols.indexOf(s) === -1) ArrayPush(globalSymbols, s);
}
for (const s of globalSymbols) {
  try {
    if (StringIndexOf(`${s.description}`, "undici.globalDispatcher") === 0 || (globalThis[s] !== null && typeof globalThis[s] === "object")) {
      globalThis[s] = inert;
      ObjectDefineProperty(globalThis, s, { value: inert, writable: false, configurable: false, enumerable: false });
    }
  } catch {
    /* not defined the way this Node defines it: connections are refused at the socket anyway */
  }
}

// ── fetch: a request to the host, which does the networking under its own rules ───────────
let nextId = 1;
let pendingCount = 0;
const pending = new MapCtor();

function send(prefix, payload) {
  writeOut(`${prefix}${JSONStringify(payload)}\n`);
}

function hostFetch(input, init) {
  return new PromiseCtor((resolve, reject) => {
    let request;
    try {
      request = new RequestCtor(input, init);
    } catch (err) {
      reject(err);
      return;
    }
    const signal = request.signal;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const headers = [];
    HeadersForEach(request.headers, (value, name) => {
      ArrayPush(headers, [name, value]);
    });
    PromiseThen(
      RequestArrayBuffer(request),
      (body) => {
        if (body.byteLength > MAX_REQUEST_BODY) {
          reject(new TypeErrorCtor("fetch failed: the request body is larger than 1 MB (sandbox)"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const id = nextId++;
        const onAbort = () => {
          if (!MapDelete(pending, id)) return;
          settled();
          send(RPC, { id, op: "cancel" });
          reject(signal.reason);
        };
        const settled = () => {
          SignalRemoveListener(signal, "abort", onAbort);
          if (--pendingCount === 0 && typeof stdin.unref === "function") stdin.unref();
        };
        MapSet(pending, id, { resolve, reject, settled });
        if (pendingCount++ === 0 && typeof stdin.ref === "function") stdin.ref();
        SignalAddListener(signal, "abort", onAbort, { once: true });
        send(RPC, {
          id,
          op: "fetch",
          url: request.url,
          method: request.method,
          headers,
          body: body.byteLength ? BufferToString(BufferFrom(body), "base64") : null,
          redirect: request.redirect,
        });
      },
      reject,
    );
  });
}

function onFetched(msg) {
  const entry = MapGet(pending, msg.id);
  if (!entry) return;
  MapDelete(pending, msg.id);
  entry.settled();
  if (msg.ok !== true) {
    const why = typeof msg.error === "string" ? msg.error : "the request failed";
    entry.reject(msg.code === "private" || msg.code === "scheme" ? denied(why) : new TypeErrorCtor(`fetch failed: ${why}`, { cause: new ErrorCtor(why) }));
    return;
  }
  try {
    const empty = msg.status === 204 || msg.status === 205 || msg.status === 304 || typeof msg.body !== "string";
    const res = new ResponseCtor(empty ? null : BufferFrom(msg.body, "base64"), {
      status: msg.status,
      statusText: typeof msg.statusText === "string" ? msg.statusText : "",
      headers: msg.headers,
    });
    ObjectDefineProperty(res, "url", { value: typeof msg.url === "string" ? msg.url : "", enumerable: true });
    ObjectDefineProperty(res, "redirected", { value: msg.redirected === true, enumerable: true });
    entry.resolve(res);
  } catch (err) {
    entry.reject(new TypeErrorCtor(`fetch failed: ${err?.message ?? err}`));
  }
}

// ── stdin: the request, then the host's answers to fetches ───────────────────────────────
let buffered = "";
let gotRequest = null;
const requestLine = new PromiseCtor((resolve) => (gotRequest = resolve));
function onLine(line) {
  if (!StringTrim(line)) return;
  if (gotRequest) {
    const resolve = gotRequest;
    gotRequest = null;
    resolve(line);
    // From here stdin only matters while a fetch is waiting: an idle skill may end by itself.
    if (pendingCount === 0 && typeof stdin.unref === "function") stdin.unref();
    return;
  }
  let msg;
  try {
    msg = JSONParse(line);
  } catch {
    return;
  }
  if (msg !== null && typeof msg === "object") onFetched(msg);
}
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const at = StringIndexOf(buffered, "\n");
    if (at === -1) break;
    const line = StringSlice(buffered, 0, at);
    buffered = StringSlice(buffered, at + 1);
    onLine(line);
  }
});
stdin.on("end", () => {
  if (buffered) onLine(buffered);
  buffered = "";
  if (gotRequest) {
    const resolve = gotRequest;
    gotRequest = null;
    resolve("");
  }
  // The host is gone: nothing will answer what's still waiting.
  MapForEach(pending, (entry) => {
    entry.settled();
    entry.reject(new TypeErrorCtor("fetch failed: the sandbox is closing"));
  });
});

// ── the skill's globals ──────────────────────────────────────────────────────────────────
// stdout is the result channel; what a skill logs goes to stderr through a console that holds
// no stream (Node's own console hands its streams out as console._stdout / ._stderr).
const log = (...args) => {
  try {
    writeErr(`${ReflectApply(format, undefined, args)}\n`);
  } catch {
    /* unprintable */
  }
};
const quiet = () => {};
globalThis.console = ObjectFreeze({
  log,
  info: log,
  warn: log,
  error: log,
  debug: log,
  trace: log,
  dir: log,
  table: log,
  assert: (ok, ...args) => {
    if (!ok) ReflectApply(log, undefined, ["Assertion failed:", ...args]);
  },
  group: log,
  groupCollapsed: log,
  groupEnd: quiet,
  time: quiet,
  timeEnd: quiet,
  timeLog: quiet,
  count: quiet,
  countReset: quiet,
  clear: quiet,
});
globalThis.fetch = hostFetch;
// Process internals, in case the object is ever reached: nothing that touches another process,
// a native binding or a raw handle.
for (const name of ["kill", "_kill", "_debugProcess", "_debugEnd", "execve", "binding", "_linkedBinding", "dlopen", "getBuiltinModule", "_getActiveHandles", "_getActiveRequests", "chdir", "abort"]) {
  if (typeof process[name] === "function")
    process[name] = () => {
      throw denied("process internals");
    };
}
try {
  ObjectDefineProperty(process, "report", { value: ObjectFreeze({}), configurable: false, writable: false });
} catch {
  /* not configurable on this Node: writeReport is still refused by the permission model */
}
// …and the object itself leaves the skill's globals, with the globals that create sockets or ports.
for (const name of ["process", "WebSocket", "EventSource", "MessageChannel", "MessagePort", "BroadcastChannel"]) {
  try {
    delete globalThis[name];
  } catch {
    /* left as it is */
  }
  if (name in globalThis) {
    try {
      ObjectDefineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    } catch {
      /* not configurable */
    }
  }
}

// ── the operation ────────────────────────────────────────────────────────────────────────

/** JSON.stringify replacer: BigInt → string; functions, symbols and cycles dropped. */
function jsonSafe() {
  const seen = new WeakSetCtor();
  return (_key, value) => {
    if (typeof value === "bigint") return `${value}`;
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value !== null && typeof value === "object") {
      if (WeakSetHas(seen, value)) return "[circular]";
      WeakSetAdd(seen, value);
    }
    return value;
  };
}

function answer(payload) {
  if (answered) return;
  answered = true;
  let line;
  try {
    line = JSONStringify(payload, jsonSafe());
  } catch (err) {
    line = JSONStringify({ status: "error", stage: "result", error: `the result isn't plain data: ${err?.message ?? err}` });
  }
  writeOut(`${MARK}${line}\n`, () => exit(0));
  setTimer(() => exit(0), 1000).unref();
}

/** The error in words, with the skill's own stack frames (file path shortened to "skill.mjs"). */
function failure(stage, err) {
  let message = "unknown error";
  const stack = [];
  try {
    const isErr = err instanceof ErrorCtor;
    message = isErr ? `${err.name}: ${err.message}` : `thrown value: ${err}`;
    const lines = isErr && typeof err.stack === "string" ? StringSplit(err.stack, "\n") : [];
    for (let i = 0; i < lines.length && stack.length < 6; i++) {
      if (StringIncludes(lines[i], skillUrl)) ArrayPush(stack, StringTrim(StringReplaceAll(lines[i], skillUrl, "skill.mjs")));
    }
  } catch {
    /* an error object that can't be read: reported as unknown */
  }
  return { status: "error", stage, error: StringSlice(message, 0, 2000), stack: ArrayJoin(stack, "\n") };
}

process.on("uncaughtException", (err) => answer(failure("run", err)));
process.on("unhandledRejection", (err) => answer(failure("run", err)));

let request;
try {
  request = JSONParse((await requestLine) || "{}");
} catch (err) {
  answer(failure("request", err));
}

if (request) {
  let skill;
  try {
    skill = (await import(skillUrl)).default;
    if (!skill || typeof skill !== "object") throw new ErrorCtor("the module has no `export default { … }` object");
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
      if (typeof skill.run !== "function") throw new ErrorCtor("the skill has no run(args) function");
      const value = await skill.run(request.args && typeof request.args === "object" ? request.args : {});
      answer({ status: "ok", value });
    } catch (err) {
      answer(failure("run", err));
    }
  } else if (skill) answer({ status: "error", stage: "request", error: `unknown op "${request.op}"`, stack: "" });
}
