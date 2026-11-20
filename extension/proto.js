// Trinity Browser Bridge — the link to the engine: keys, the one-time pairing, the mutual handshake and
// sealed fills. Pure logic over WebCrypto: no chrome.* and no socket in here, so the service worker and
// the Node tests (scripts/test-browser-link.mts) run exactly the same code.
//
// Pairing (once, with the code Settings → Browser shows; the code itself never crosses the wire):
//   ext → {type:"pair", id, pub, mac: HMAC(code, "trinity-pair-v2|" + pub)}
//   eng → {type:"paired", pub, mac: HMAC(code, "trinity-paired-v2|" + enginePub + "|" + extPub)}
// Every connection (mutual proof of K; nothing secret is sent):
//   ext → {type:"hello", id, nonce: nE}
//   eng → {type:"challenge", nonce: nS, proof: HMAC(K, "engine|" + nE + "|" + nS)}
//   ext → {type:"auth", proof: HMAC(K, "ext|" + nS + "|" + nE), version, chrome, caps, tabs}
//   eng → {type:"welcome"}
// K  = HKDF-SHA256(ECDH P-256 shared secret, salt "trinity-ext-v2", info "link"), 32 bytes.
// Ks = HKDF-SHA256(K, salt = nE + nS (the base64 text as sent), info "session") — AES-256-GCM for fills.
//
// The rule this file exists to keep: no `call` is ever run for a peer that has not proved K.

export const PROTOCOL = 2;
export const HANDSHAKE_MS = 10_000;

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

// ─── Bytes ────────────────────────────────────────────────────────────────────

export function toB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Strict base64 → bytes; throws on anything else. */
export function fromB64(text) {
  if (typeof text !== "string" || text.length > 64_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("not base64");
  const bin = atob(text);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export function randomNonce() {
  return toB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

const isNonce = (v) => {
  try {
    return fromB64(v).length === 16;
  } catch {
    return false;
  }
};

/** What the user typed → the code as the engine issued it ("abcd-efgh" → "ABCDEFGH"). */
export function normalizeCode(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

/** The extension's own key pair: ECDH P-256, the private half non-extractable (it can live in IndexedDB as it is). */
export function generateKeys() {
  return subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/** The public half, raw (65 bytes), base64. */
export async function exportPublic(publicKey) {
  return toB64(new Uint8Array(await subtle().exportKey("raw", publicKey)));
}

function hmacKey(bytes) {
  return subtle().importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(key, text) {
  return toB64(new Uint8Array(await subtle().sign("HMAC", key, te.encode(text))));
}

/** Constant-time (WebCrypto's verify) check of a base64 MAC. */
async function verify(key, text, macB64) {
  let mac;
  try {
    mac = fromB64(macB64);
  } catch {
    return false;
  }
  if (mac.length !== 32) return false;
  return subtle().verify("HMAC", key, mac, te.encode(text));
}

/** K for this extension and that engine key: an HMAC key for the proofs and an HKDF key for session keys. */
export async function deriveLink(privateKey, enginePubB64) {
  const raw = fromB64(enginePubB64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("not a P-256 public key");
  const pub = await subtle().importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  shared.fill(0);
  const k = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: te.encode("trinity-ext-v2"), info: te.encode("link") }, ikm, 256));
  const mac = await hmacKey(k);
  const kdf = await subtle().importKey("raw", k, "HKDF", false, ["deriveKey"]);
  k.fill(0);
  return { mac, kdf };
}

/** Ks for one connection: decrypt only (the engine seals, the extension opens). */
export function deriveSession(kdf, nE, nS) {
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode(nE + nS), info: te.encode("session") }, kdf, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

/** What a fill envelope is bound to: this call, this method, this origin, this tab. */
export function fillAad(callId, origin, tabId) {
  return `${callId}|page.fill|${origin}|${tabId}`;
}

/** Open {iv, ct} (AES-256-GCM, base64; the tag rides at the end of ct). Throws when the key or the binding is wrong. */
export async function openSealed(sessionKey, sealed, aad) {
  const iv = fromB64(sealed && sealed.iv);
  const ct = fromB64(sealed && sealed.ct);
  if (iv.length !== 12 || ct.length < 17) throw new Error("sealed");
  const plain = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad), tagLength: 128 }, sessionKey, ct);
  return JSON.parse(td.decode(plain));
}

// ─── The link: one socket's state machine ─────────────────────────────────────

/*
 *   idle ──pair(code)──▶ pairing ──"paired" (MAC ok)──▶ greeting
 *   idle ──hello()─────────────────────────────────────▶ greeting
 *   greeting ──"challenge" (proof ok)──▶ proving ──"welcome"──▶ live
 *   anything else, in any state but live ──▶ dead (reason kept)
 * Only `live` runs calls. `dead` is final: a new socket gets a new Link.
 */
export class Link {
  /**
   * @param {object} o
   * @param {string} o.id                       this extension's id (chrome.runtime.id)
   * @param {(msg: object) => void} o.send      write one message on THIS link's socket
   * @param {CryptoKeyPair} o.keys              the extension's key pair
   * @param {string|null} o.enginePub           the pinned engine key (base64 raw), or null before pairing
   * @param {(pub: string) => Promise<void>} o.pin        keep the engine key after a verified pairing
   * @param {() => Promise<object>} o.describe  {version, chrome, caps, tabs} for `auth`
   * @param {(call: {id: string, method: string, params: object}, link: Link) => Promise<unknown>} o.onCall
   * @param {(welcome: object) => void} [o.onLive]
   * @param {(reason: string) => void} [o.onDead]  "engine-unproven" | "pair-refused" | "protocol" | "unpaired" | "error"
   */
  constructor(o) {
    this.o = o;
    this.state = "idle";
    this.reason = "";
    this.enginePub = o.enginePub || null;
    this.code = null;
    this.nE = "";
    this.keys = null; // {mac, kdf} once the challenge is being checked
    this.session = null; // Ks
    this.queue = Promise.resolve();
    this.calls = 0;
  }

  get live() {
    return this.state === "live";
  }

  /** Start pairing with the code the user typed. The code never leaves this object, and is dropped once used. */
  async pair(code) {
    if (this.state !== "idle") return this.#die("protocol");
    const clean = normalizeCode(code);
    if (clean.length < 6) return this.#die("pair-refused");
    this.code = clean;
    this.state = "pairing";
    const pub = await exportPublic(this.o.keys.publicKey);
    this.myPub = pub;
    const mac = await sign(await hmacKey(te.encode(clean)), `trinity-pair-v2|${pub}`);
    this.o.send({ type: "pair", id: this.o.id, pub, mac });
  }

  /** Start the handshake with the pinned engine. */
  async hello() {
    if (this.state !== "idle" && this.state !== "paired") return this.#die("protocol");
    if (!this.enginePub) return this.#die("unpaired");
    this.nE = randomNonce();
    this.state = "greeting";
    this.o.send({ type: "hello", id: this.o.id, nonce: this.nE });
  }

  /** One message from the socket. Handled strictly in order; a call's own work doesn't hold the next message up. */
  receive(msg) {
    this.queue = this.queue.then(() => this.#step(msg)).catch(() => this.#die("error"));
    return this.queue;
  }

  async #step(msg) {
    if (!msg || typeof msg !== "object" || this.state === "dead") return;
    const type = msg.type;
    switch (this.state) {
      case "pairing": {
        if (type !== "paired") return this.#die("protocol");
        const code = this.code;
        this.code = null;
        const ok =
          typeof msg.pub === "string" &&
          (await verify(await hmacKey(te.encode(code)), `trinity-paired-v2|${msg.pub}|${this.myPub}`, msg.mac)) &&
          (await this.#validKey(msg.pub));
        if (!ok) return this.#die("pair-refused");
        await this.o.pin(msg.pub);
        this.enginePub = msg.pub;
        this.keys = null;
        this.state = "paired";
        return this.hello();
      }
      case "greeting": {
        if (type !== "challenge") return this.#die("protocol");
        if (!isNonce(msg.nonce)) return this.#die("engine-unproven");
        let keys;
        try {
          keys = await deriveLink(this.o.keys.privateKey, this.enginePub);
        } catch {
          return this.#die("engine-unproven");
        }
        if (!(await verify(keys.mac, `engine|${this.nE}|${msg.nonce}`, msg.proof))) return this.#die("engine-unproven");
        this.keys = keys;
        this.session = await deriveSession(keys.kdf, this.nE, msg.nonce);
        const about = await this.o.describe();
        this.state = "proving";
        this.o.send({ type: "auth", proof: await sign(keys.mac, `ext|${msg.nonce}|${this.nE}`), ...about });
        return;
      }
      case "proving": {
        if (type !== "welcome") return this.#die("protocol");
        this.state = "live";
        if (this.o.onLive) this.o.onLive(msg);
        return;
      }
      case "live": {
        if (type === "ping") return void this.o.send({ type: "pong" });
        if (type === "call") return void this.#call(msg);
        return; // anything else from a proved engine is simply not understood
      }
      default:
        // idle / paired: the engine speaks only when spoken to.
        return this.#die("protocol");
    }
  }

  async #validKey(pubB64) {
    try {
      const raw = fromB64(pubB64);
      if (raw.length !== 65 || raw[0] !== 4) return false;
      await subtle().importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs one call — reachable only from the `live` state (see #step). */
  async #call(msg) {
    if (this.state !== "live") return;
    const id = String(msg.id || "");
    this.calls++;
    try {
      const result = await this.o.onCall({ id, method: String(msg.method || ""), params: msg.params && typeof msg.params === "object" ? msg.params : {} }, this);
      this.send({ type: "result", id, ok: true, result });
    } catch (err) {
      this.send({ type: "result", id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
  }

  /** Send on a live link only (results, tab reports, shares). */
  send(msg) {
    if (this.state !== "live") return false;
    this.o.send(msg);
    return true;
  }

  /**
   * The values of a sealed fill, for exactly this call, origin and tab — or an Error whose `code` is "sealed"
   * (wrong key or binding) or "expired". The values are returned to the caller and kept nowhere.
   */
  async openFill(callId, origin, tabId, sealed) {
    const fail = (code) => Object.assign(new Error(code), { code });
    if (this.state !== "live" || !this.session) throw fail("sealed");
    let body;
    try {
      body = await openSealed(this.session, sealed, fillAad(callId, origin, tabId));
    } catch {
      throw fail("sealed");
    }
    const now = Date.now();
    if (!body || typeof body !== "object" || typeof body.expires !== "number" || !body.values || typeof body.values !== "object") throw fail("sealed");
    if (now > body.expires || body.expires - now > 60_000) throw fail("expired");
    return body.values;
  }

  /** The socket closed, or the caller gave up on it. */
  close(reason = "closed") {
    this.#die(reason);
  }

  #die(reason) {
    if (this.state === "dead") return;
    this.state = "dead";
    this.reason = reason;
    this.code = null;
    this.session = null;
    this.keys = null;
    if (this.o.onDead) this.o.onDead(reason);
  }
}
