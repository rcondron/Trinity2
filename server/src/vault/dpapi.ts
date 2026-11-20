import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { b64, concat, KEY_BYTES, randomBytes, unb64, view, wipe, type Bytes } from "./crypto.js";
import { VaultError } from "./errors.js";

/*
 * The device secret: 32 random bytes that only this Windows user on this computer can read back. It is protected by
 * Windows DPAPI (CurrentUser scope) and kept, protected, in <vault dir>/device.key; the vault's key-encryption key is
 * derived from it (see store.ts). Nothing else is ever written: where DPAPI isn't there (not Windows, PowerShell
 * missing), there is no device secret at all and the vault can only be locked with a passphrase.
 *
 * DPAPI is reached through Windows PowerShell, started by its full path:
 *   %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <script>
 * The script (constant, below) holds no data. The bytes go in on stdin and come back on stdout, as base64 — never in
 * the arguments, the environment or a file, so they can't show up in a process list, a script-block log or a temp
 * folder. One PowerShell start per engine run: the unprotected secret is cached in memory afterwards.
 *
 * Limits, stated plainly: DPAPI stops other users and other computers, not another program running as this user (that
 * is what the passphrase lock is for).
 */

/** Where the vault gets its device secret from (the store takes one; tests hand it a stand-in or none). */
export interface DeviceKeySource {
  /** Whether this computer has a key store at all. Cheap and synchronous. */
  available(): boolean;
  /**
   * The device secret (32 bytes; the caller must not change or wipe it). With `create`, one is made and protected
   * the first time; without, a missing one is an error.
   */
  secret(create: boolean): Promise<Bytes>;
}

const TIMEOUT_MS = 30_000;
/** Binds the protected blob to this use, so a blob protected for something else doesn't unprotect as ours. */
const ENTROPY = "trinity-vault-device-key-v1";

const script = (op: "Protect" | "Unprotect"): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "$raw = [Console]::In.ReadToEnd()",
    "$bytes = [Convert]::FromBase64String($raw.Trim())",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("\n");

/** Windows PowerShell by its full path (never looked up on PATH). */
export function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function dpapiAvailable(): boolean {
  return process.platform === "win32" && fs.existsSync(powershellPath());
}

const NO_STORE = "The Windows key store (DPAPI) didn't answer, so the vault's key can't be read.";

/** One DPAPI call. Rejects with a fixed message: PowerShell's own output is never passed on. */
function dpapi(op: "Protect" | "Unprotect", input: Bytes): Promise<Bytes> {
  return new Promise((resolve, reject) => {
    const fail = (why: string): void => {
      // The reason is one of the fixed words below — never PowerShell's text.
      console.warn(`[vault] DPAPI ${op.toLowerCase()} failed (${why})`);
      reject(new VaultError("no-key-store", NO_STORE));
    };
    let child: ReturnType<typeof spawn>;
    try {
      const encoded = Buffer.from(script(op), "utf16le").toString("base64");
      child = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return fail("could not start PowerShell");
    }
    const chunks: Bytes[] = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      fail("timed out");
    }, TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= 64 * 1024) chunks.push(view(d));
    });
    child.stderr?.resume(); // drained and dropped: it could describe the input
    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fail("could not start PowerShell");
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = concat(...chunks);
      wipe(...chunks);
      const text = new TextDecoder("latin1").decode(out).trim();
      wipe(out);
      if (code !== 0 || size > 64 * 1024 || !text) return fail(`exit ${code ?? "?"}`);
      try {
        resolve(unb64(text));
      } catch {
        fail("unreadable answer");
      }
    });
    child.stdin?.on("error", () => {
      /* PowerShell went away before reading: the close handler reports it */
    });
    child.stdin?.end(b64(input));
  });
}

interface DeviceKeyFile {
  format: "trinity-device-key";
  version: 1;
  protection: "dpapi-user";
  blob: string;
}

/** The device secret of a vault folder, protected by DPAPI. */
export class DpapiDeviceKey implements DeviceKeySource {
  private cached: Bytes | null = null;
  private pending: Promise<Bytes> | null = null;
  private readonly file: string;
  /** PowerShell starts so far (the tests check it stays at one). */
  starts = 0;
  /** DPAPI is there but wouldn't protect a new key (PowerShell is locked down): for this run, there is no key store. */
  private unusable = false;

  constructor(dir: string) {
    this.file = path.join(dir, "device.key");
  }

  available(): boolean {
    return dpapiAvailable() && !this.unusable;
  }

  secret(create: boolean): Promise<Bytes> {
    if (this.cached) return Promise.resolve(this.cached);
    this.pending ??= this.load(create).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(create: boolean): Promise<Bytes> {
    if (!this.available()) throw new VaultError("no-key-store", "This computer has no key store for the vault.");
    let stored: DeviceKeyFile | null = null;
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      raw = null; // not made yet
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<DeviceKeyFile>;
        if (parsed.format === "trinity-device-key" && parsed.version === 1 && parsed.protection === "dpapi-user" && typeof parsed.blob === "string") {
          stored = parsed as DeviceKeyFile;
        }
      } catch {
        stored = null;
      }
      // A key file that is there but unreadable is never replaced: the vault it opens would be lost for good.
      if (!stored) throw new VaultError("damaged", "The vault's device key file is damaged.");
    }
    if (stored) {
      let blob: Bytes;
      try {
        blob = unb64(stored.blob);
      } catch {
        throw new VaultError("damaged", "The vault's device key file is damaged.");
      }
      this.starts++;
      const secret = await dpapi("Unprotect", blob);
      if (secret.byteLength !== KEY_BYTES) {
        wipe(secret);
        throw new VaultError("damaged", "The vault's device key file is damaged.");
      }
      this.cached = secret;
      return secret;
    }
    if (!create) throw new VaultError("no-key-store", "The vault's device key is missing from this computer.");
    const secret = randomBytes(KEY_BYTES);
    this.starts++;
    let blob: Bytes;
    try {
      blob = await dpapi("Protect", secret);
    } catch (err) {
      // No key could be protected here: the vault falls back to what a computer without a key store gets — a passphrase.
      this.unusable = true;
      wipe(secret);
      throw err;
    }
    const body: DeviceKeyFile = { format: "trinity-device-key", version: 1, protection: "dpapi-user", blob: b64(blob) };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // Never over a key file that appeared meanwhile (another engine starting at the same moment).
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body), { encoding: "utf8", mode: 0o600, flag: "w" });
      if (fs.existsSync(this.file)) {
        fs.rmSync(tmp, { force: true });
        wipe(secret);
        throw new VaultError("busy", "The vault's device key was made by another Trinity at the same moment. Try again.");
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      wipe(secret);
      if (err instanceof VaultError) throw err;
      throw new VaultError("failed", "The vault's device key couldn't be saved.");
    }
    this.cached = secret;
    return secret;
  }
}
