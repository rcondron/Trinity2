import os from "node:os";
import path from "node:path";
import { authOn } from "../auth.js";

/** Where the vault lives: outside the repository and outside data/ (TRINITY_VAULT_DIR, or <TRINITY_DATA_DIR>/vault in tests). */
export function vaultDir(): string {
  const explicit = process.env.TRINITY_VAULT_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const data = process.env.TRINITY_DATA_DIR?.trim();
  if (data) return path.join(path.resolve(data), "vault");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Trinity", "vault");
  }
  return path.join(os.homedir(), ".config", "trinity", "vault");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** A host name that only this computer can reach: localhost (and names under it), 127.x.x.x, ::1. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * An entry in TRINITY_ORIGINS (the extra pages allowed to use the engine — see auth.ts) over which what is typed into
 * the vault would cross a network in the clear: any that is neither on this computer nor https. Also any entry with no
 * origin of its own (file:, chrome-extension:, "box.lan:5173" read as a scheme): auth.ts then admits the origin "null",
 * which every sandboxed frame and local file has — wherever it came from.
 */
function plainRemoteOrigin(): string | null {
  for (const raw of (process.env.TRINITY_ORIGINS ?? "").split(",")) {
    const text = raw.trim();
    if (!text) continue;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      continue; // not an origin: auth.ts doesn't let it in either
    }
    if (url.origin === "null") return text;
    if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) return url.origin;
  }
  return null;
}

/**
 * Why the vault must stay shut whatever else is true — or undefined when it may be used. Read from the environment
 * on every call, so nothing that was unlocked earlier outlives a change:
 *  - sign-in checks are off (TRINITY_AUTH=off): any program or page on this computer could ask for a fill;
 *  - the engine isn't bound to this computer alone (HOST is set to something that isn't loopback);
 *  - the app is opened from another computer over plain http (TRINITY_ORIGINS names such an origin: the page reaches
 *    the engine through the web server's proxy, so HOST stays loopback while passwords, card numbers and the
 *    passphrase would cross the network unencrypted). Origins on this computer, and https ones, are fine.
 */
export function vaultBlocked(): string | undefined {
  if (!authOn()) return "Sign-in checks are switched off (TRINITY_AUTH=off), so the vault stays locked.";
  const host = (process.env.HOST ?? "").trim().toLowerCase();
  if (host && !LOOPBACK.has(host)) return "The engine is reachable from other computers (HOST is set), so the vault stays locked.";
  if (plainRemoteOrigin()) {
    return "The app is opened from other computers over plain http (TRINITY_ORIGINS), where anything typed could be read on the way. The vault stays locked.";
  }
  return undefined;
}
