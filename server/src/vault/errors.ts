/**
 * Every failure the vault reports. The message is always a fixed sentence written here in code: it never holds
 * anything that was typed, decrypted or read from a file, so it is safe to speak, show, log and return. Errors that
 * are NOT a VaultError (a JSON parser quoting what it choked on, a crypto library, the file system) are never passed
 * on: the vault turns them into one of these first.
 */
export type VaultErrorCode =
  /** Auth is off, the engine isn't bound to this computer, or the vault file can't be trusted. */
  | "blocked"
  /** The passphrase is needed first. */
  | "locked"
  | "wrong-passphrase"
  /** Too many wrong passphrases: try again after `retryAfterMs`. */
  | "wait"
  | "not-found"
  /** What was typed doesn't make a valid item (`field` names which input). */
  | "invalid"
  /** A ciphertext, an IV, a tag or the data bound to them was changed. */
  | "tampered"
  /** The vault file can't be read (broken JSON, an unknown version). */
  | "damaged"
  /** This computer has no key store (DPAPI) and no passphrase is set. */
  | "no-key-store"
  /** A form or a one-time value that is no longer there. */
  | "gone"
  | "busy"
  | "full"
  /** A secret was about to leave the vault in a result or an error; stopped. */
  | "leak"
  | "failed";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  /** The form field at fault, for "invalid". */
  readonly field?: string;
  /** How long to wait, for "wait". */
  readonly retryAfterMs?: number;

  constructor(code: VaultErrorCode, message: string, extra: { field?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    if (extra.field !== undefined) this.field = extra.field;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export const isVaultError = (err: unknown): err is VaultError => err instanceof VaultError;

/** Any error as a VaultError: one of ours as it is, anything else as a plain "failed" that carries none of its text. */
export function asVaultError(err: unknown, fallback = "The vault couldn't do that."): VaultError {
  return isVaultError(err) ? err : new VaultError("failed", fallback);
}

/** The HTTP status each code answers with (routes/vault.ts). */
export function httpStatusOf(code: VaultErrorCode): number {
  switch (code) {
    case "blocked":
    case "wrong-passphrase":
      return 403;
    case "locked":
      return 423;
    case "wait":
      return 429;
    case "not-found":
    case "gone":
      return 404;
    case "invalid":
      return 422;
    case "busy":
    case "full":
    case "no-key-store":
      return 409;
    default:
      return 500;
  }
}
