// A stand-in for the Trinity Browser Bridge extension, for tests in Node: a real WebSocket client that speaks the
// extension's side of pairing v2 and the handshake with the extension's OWN protocol code (extension/proto.js, on
// WebCrypto from node:crypto), and answers the engine's calls from a handler the test supplies.
import { webcrypto } from "node:crypto";
import WebSocket from "ws";
import { Link, generateKeys } from "../../../extension/proto.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

export const FAKE_ID = "abcdefghijklmnopabcdefghijklmnop";

export class FakeExtension {
  /**
   * @param {object} [o]
   * @param {string} [o.id]            the extension id (32 letters a–p); also its Origin
   * @param {(call: {id: string, method: string, params: any}, link: Link) => any} [o.onCall]
   * @param {() => object} [o.describe] what `auth` reports: {version, chrome, caps, tabs}
   */
  constructor(o = {}) {
    this.id = o.id ?? FAKE_ID;
    this.onCall = o.onCall ?? (() => ({ ok: true }));
    this.describe = o.describe ?? (() => ({ version: "0.2.0", chrome: "156", caps: { userScripts: false, pageCapture: true, fill: true }, tabs: [] }));
    this.keys = null;
    /** The pinned engine key (base64), once paired. */
    this.enginePub = null;
    this.ws = null;
    this.link = null;
    /** Every message this side sent / received on the current socket, as parsed objects. */
    this.sent = [];
    this.received = [];
    /** Every raw frame received, as text (for "is it on the wire?" checks). */
    this.frames = [];
    this.welcome = null;
    this.closed = null;
  }

  async init() {
    this.keys ??= await generateKeys();
    return this;
  }

  /**
   * Open a socket and pair (when `code` is given) or say hello. Resolves once the link is live, the socket closes, or
   * the extension's own logic refuses the engine: {state: "live"} | {state: "closed", code} | {state: "refused", reason}.
   */
  async connect(port, { code, origin } = {}) {
    await this.init();
    this.sent = [];
    this.received = [];
    this.frames = [];
    this.welcome = null;
    this.closed = null;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin: origin ?? `chrome-extension://${this.id}` });
    this.ws = ws;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const link = new Link({
        id: this.id,
        keys: this.keys,
        enginePub: this.enginePub,
        send: (msg) => {
          this.sent.push(msg);
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        pin: async (pub) => {
          this.enginePub = pub;
        },
        describe: async () => this.describe(),
        onCall: (call, l) => this.onCall(call, l),
        onLive: (welcome) => {
          this.welcome = welcome;
          done({ state: "live" });
        },
        onDead: (reason) => {
          if (reason !== "closed") {
            done({ state: "refused", reason });
            try {
              ws.close(1000, "refused");
            } catch {
              /* already closed */
            }
          }
        },
      });
      this.link = link;
      ws.on("open", () => void (code ? link.pair(code) : link.hello()));
      ws.on("message", (raw) => {
        const text = String(raw);
        this.frames.push(text);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        this.received.push(msg);
        void link.receive(msg);
      });
      ws.on("unexpected-response", (_req, res) => done({ state: "closed", code: res.statusCode }));
      ws.on("close", (closeCode, reason) => {
        this.closed = { code: closeCode, reason: String(reason) };
        link.close("closed");
        done({ state: "closed", code: closeCode });
      });
      ws.on("error", () => done({ state: "closed", code: -1 }));
    });
  }

  /** A message on the live link (tabs, share). */
  send(msg) {
    return this.link ? this.link.send(msg) : false;
  }

  close() {
    try {
      this.ws?.close(1000, "bye");
    } catch {
      /* already closed */
    }
  }
}

/** A bare socket to /ext with an extension's Origin: for the things a real extension would never send. */
export function rawSocket(port, id = FAKE_ID, origin) {
  const headers = origin === null ? {} : { origin: origin ?? `chrome-extension://${id}` };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, headers);
  const messages = [];
  const waiters = [];
  let closed = null;
  const opened = new Promise((resolve) => {
    ws.on("open", () => resolve({ open: true }));
    ws.on("unexpected-response", (_req, res) => resolve({ open: false, status: res.statusCode }));
    ws.on("error", () => resolve({ open: false, status: -1 }));
  });
  const closedP = new Promise((resolve) => {
    ws.on("close", (code) => {
      closed = code;
      resolve(code);
      for (const w of waiters.splice(0)) w(null);
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => resolve(-1));
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const w = waiters.shift();
    if (w) w(msg);
    else messages.push(msg);
  });
  return {
    ws,
    opened,
    closed: closedP,
    send: (msg) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
    /** The next message, or null when the socket closes first (or nothing comes within `ms`). */
    next: (ms = 2000) =>
      new Promise((resolve) => {
        if (messages.length) return resolve(messages.shift());
        if (closed !== null) return resolve(null);
        const timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, ms);
        const w = (m) => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push(w);
      }),
  };
}
