/*
 * The secret Trinity's own web server adds to every request it passes to the engine (Vite's proxy, vite.config.ts; the
 * test harness's proxy). The engine accepts a browser's session cookie only with it (auth.ts): a page served by some
 * other program on the app's port — a different dev server on 5173 — is on an origin the engine trusts and gets the
 * cookie (cookies don't keep to a port), but it can't add this header, because it never goes through Trinity's proxy.
 *
 * It lives in the data folder, which Vite does not serve (vite.config.ts allows only web/). Leaf module: node built-ins
 * only, so the Vite config can load it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where the secret is kept. */
export function proxyKeyFile(dataDir: string): string {
  return path.join(dataDir, "proxy.key");
}

function readKey(file: string): string | null {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    return /^[A-Za-z0-9_-]{32,}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The secret, made the first time. Two processes starting together (the engine and Vite) end up with the same one: the
 * file appears whole or not at all (written aside, then linked into place, which fails if it is already there).
 */
export function readOrCreateProxyKey(dataDir: string): string {
  const file = proxyKeyFile(dataDir);
  const found = readKey(file);
  if (found) return found;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, crypto.randomBytes(32).toString("base64url"), { encoding: "utf8", mode: 0o600 });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Already there: the other process won (read below). Unreadable or damaged: replace it.
      if (code !== "EEXIST" || !readKey(file)) fs.copyFileSync(tmp, file);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
  const key = readKey(file);
  if (!key) throw new Error(`couldn't read ${file}`);
  return key;
}
