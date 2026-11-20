import crypto from "node:crypto";
import { VaultError } from "./errors.js";

/*
 * One-time codes for sites that use an authenticator app: RFC 4226 (HOTP) and RFC 6238 (TOTP), HMAC-SHA-1, a 30-second
 * step and six digits — what every such site issues. The seed is a base32 string kept in the vault; the code is
 * computed here, in the engine, and handed out only inside useSecret.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BAD_SEED = "That authenticator key doesn't look right. It is the row of letters and digits the site shows next to its QR code.";

/**
 * A typed authenticator key as clean base32 (upper case, no spaces, dashes or padding). Also takes a whole
 * "otpauth://totp/…?secret=…" link, as long as it asks for the standard six digits every thirty seconds with SHA-1.
 */
export function normalizeTotpSecret(input: string): string {
  let raw = input.trim();
  if (/^otpauth:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new VaultError("invalid", BAD_SEED, { field: "totpSecret" });
    }
    const q = url.searchParams;
    const standard =
      url.hostname.toLowerCase() === "totp" &&
      (q.get("algorithm") ?? "SHA1").toUpperCase().replace("-", "") === "SHA1" &&
      (q.get("digits") ?? "6") === "6" &&
      (q.get("period") ?? "30") === "30";
    if (!standard) {
      throw new VaultError("invalid", "Only the standard six-digit, thirty-second authenticator codes are supported.", { field: "totpSecret" });
    }
    raw = q.get("secret") ?? "";
  }
  const clean = raw.replace(/[\s-]+/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length < 16 || clean.length > 128 || !/^[A-Z2-7]+$/.test(clean)) throw new VaultError("invalid", BAD_SEED, { field: "totpSecret" });
  return clean;
}

/** Base32 (RFC 4648, no padding) → bytes. */
export function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new VaultError("invalid", BAD_SEED, { field: "totpSecret" });
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** RFC 4226: the code for one counter value. */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(Math.floor(counter)));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const at = h[h.length - 1]! & 0x0f;
  const bin = ((h[at]! & 0x7f) << 24) | (h[at + 1]! << 16) | (h[at + 2]! << 8) | h[at + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238: the code at `timeMs` for a base32 seed. */
export function totp(secretBase32: string, timeMs: number = Date.now(), opts: { digits?: number; stepSec?: number } = {}): string {
  const key = base32Decode(secretBase32);
  try {
    return hotp(key, Math.floor(timeMs / 1000 / (opts.stepSec ?? 30)), opts.digits ?? 6);
  } finally {
    key.fill(0);
  }
}
