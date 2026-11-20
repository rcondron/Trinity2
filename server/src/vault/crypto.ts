import crypto from "node:crypto";
import { VaultError } from "./errors.js";

/*
 * The vault's cryptography, all from node:crypto:
 *
 *   seal / open   AES-256-GCM, a fresh random 12-byte IV for every seal, a 16-byte tag, and associated data that
 *                 binds the ciphertext to what it belongs to (an item: "id|kind|version"). Anything changed — the
 *                 ciphertext, the IV, the tag, the associated data, the key — makes open() throw "tampered".
 *   hkdf          HKDF-SHA256 → 32 bytes (the key-encryption key; the key that authenticates the file).
 *   scryptKey     scrypt(passphrase, salt, N, r = 8, p = 1) → 32 bytes. N = 2^17 for a passphrase set now; a file
 *                 keeps the cost it was made with (2^15 at the least), within bounds a doctored file can't exceed.
 *   mac / macOk   HMAC-SHA256 over the canonical JSON of the vault file, compared in constant time.
 *
 * No error from here carries key material, plaintext or ciphertext. And no key that has been wiped (all zero bytes)
 * is ever used: seal() and open() refuse it.
 *
 * Bytes are plain Uint8Arrays throughout (this TypeScript's Buffer type isn't accepted where bytes are expected):
 * view() gives one over a Buffer's own memory — never a copy, so wiping one wipes the other.
 */

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** The scrypt cost for a passphrase set now (about 130 MB and a few hundred milliseconds a try). Files keep the cost they were made with. */
export const SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
/** The most memory a file's scrypt parameters may ask for (128 · N · r bytes). */
const SCRYPT_MAX_BYTES = 512 * 1024 * 1024;

export type Bytes = Uint8Array;

/** One sealed value as it is written to the file: all base64. */
export interface Sealed {
  iv: string;
  ct: string;
  tag: string;
}

/** The same memory as a plain Uint8Array (no copy). */
export const view = (b: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): Bytes => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const buf = (b: Bytes): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export const utf8 = (text: string): Bytes => view(Buffer.from(text, "utf8"));
export const fromUtf8 = (bytes: Bytes): string => buf(bytes).toString("utf8");

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const b64 = (bytes: Bytes): string => buf(bytes).toString("base64");

/** Strict base64 → bytes (an exact length when one is given); "damaged" for anything else. */
export function unb64(text: unknown, bytes?: number): Bytes {
  if (typeof text !== "string" || text.length % 4 !== 0 || !B64.test(text)) throw new VaultError("damaged", "The vault file is damaged.");
  const out = view(Buffer.from(text, "base64"));
  if (bytes !== undefined && out.byteLength !== bytes) throw new VaultError("damaged", "The vault file is damaged.");
  return out;
}

/** Overwrite key material or plaintext that is no longer needed. */
export function wipe(...all: (Bytes | null | undefined)[]): void {
  for (const b of all) if (b) b.fill(0);
}

export function randomBytes(n: number): Bytes {
  return view(crypto.randomBytes(n));
}

/** Random bytes as text that is safe in a URL path or a file name (base64url). */
export function randomId(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** True for a key that has been wiped: all zero bytes. (A random key is never that.) */
export function isZeroKey(key: Bytes): boolean {
  for (let i = 0; i < key.byteLength; i++) if (key[i] !== 0) return false;
  return true;
}

function assertKey(key: Bytes): void {
  if (key.byteLength !== KEY_BYTES) throw new VaultError("failed", "The vault's key has the wrong size.");
  // A wiped key must never encrypt, decrypt or authenticate anything: what it sealed could be opened by anyone.
  if (isZeroKey(key)) throw new VaultError("failed", "The vault's key is no longer in memory. Nothing was written.");
}

/** `key` itself — or an error when it has the wrong size or has been wiped. */
export function liveKey(key: Bytes): Bytes {
  assertKey(key);
  return key;
}

/** Encrypt `plaintext` under `key`, bound to `aad`. A new random IV every call. */
export function seal(key: Bytes, plaintext: Bytes, aad: string): Sealed {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(utf8(aad));
  const ct = concat(view(cipher.update(plaintext)), view(cipher.final()));
  return { iv: b64(iv), ct: b64(ct), tag: b64(view(cipher.getAuthTag())) };
}

/** Decrypt and verify. Throws "tampered" when the ciphertext, IV, tag, associated data or key is not what sealed it. */
export function open(key: Bytes, sealed: Sealed, aad: string): Bytes {
  assertKey(key);
  const iv = unb64(sealed.iv, IV_BYTES);
  const tag = unb64(sealed.tag, TAG_BYTES);
  const ct = unb64(sealed.ct);
  let head: Bytes | null = null;
  let tail: Bytes | null = null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(utf8(aad));
    decipher.setAuthTag(tag);
    head = view(decipher.update(ct));
    tail = view(decipher.final()); // throws unless the tag verifies: nothing unauthenticated is returned
    return concat(head, tail);
  } catch {
    throw new VaultError("tampered", "Part of the vault doesn't verify: it was changed outside Trinity, or the key is wrong.");
  } finally {
    wipe(head, tail);
  }
}

/** HKDF-SHA256 → 32 bytes. */
export function hkdf(ikm: Bytes, salt: Bytes, info: string): Bytes {
  return new Uint8Array(crypto.hkdfSync("sha256", ikm, salt, utf8(info), KEY_BYTES));
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Bounds for parameters read from a file, so a doctored file can ask neither for nothing nor for the machine:
 * N a power of two from 2^15 to 2^20, r from 8 to 16, p from 1 to 4, and at most 512 MB of memory (128 · N · r).
 */
export function scryptParamsOk(p: ScryptParams): boolean {
  return (
    Number.isInteger(p.N) && p.N >= 2 ** 15 && p.N <= 2 ** 20 && (p.N & (p.N - 1)) === 0 &&
    Number.isInteger(p.r) && p.r >= 8 && p.r <= 16 &&
    Number.isInteger(p.p) && p.p >= 1 && p.p <= 4 &&
    128 * p.N * p.r <= SCRYPT_MAX_BYTES
  );
}

/** scrypt(passphrase, salt) → 32 bytes, off the event loop. The passphrase is normalized (NFKC) first. */
export function scryptKey(passphrase: string, salt: Bytes, params: ScryptParams = SCRYPT): Promise<Bytes> {
  if (!scryptParamsOk(params)) return Promise.reject(new VaultError("damaged", "The vault file is damaged."));
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      passphrase.normalize("NFKC"),
      salt,
      KEY_BYTES,
      // (Node refuses anything over its 32 MB default unless told how much this may take: the 128 · N · r it needs, and a little.)
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r + 4 * 1024 * 1024 },
      (err, key) => (err ? reject(new VaultError("failed", "The passphrase couldn't be processed.")) : resolve(view(key))),
    );
  });
}

/** JSON with every object's keys in sorted order: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

export function mac(key: Bytes, text: string): string {
  return crypto.createHmac("sha256", key).update(text, "utf8").digest("base64");
}

/** Constant-time comparison of a stored MAC with the one `key` gives for `text`. */
export function macOk(key: Bytes, text: string, stored: unknown): boolean {
  if (typeof stored !== "string") return false;
  const want = view(crypto.createHmac("sha256", key).update(text, "utf8").digest());
  let got: Bytes;
  try {
    got = unb64(stored, want.byteLength);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(want, got);
}
