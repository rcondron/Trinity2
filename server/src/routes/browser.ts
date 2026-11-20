import path from "node:path";
import express, { type Router } from "express";
import { ROOT } from "../config.js";
import { browserState, hostOf, isOwnTab, newPairingCode, pairingInfo, unpairBrowser } from "../services/browser-bridge.js";

/**
 * The Chrome extension, for Settings → Browser: is it connected and paired, its tabs (a host and a title each — never a
 * full address, which can carry a session in its query), and pairing. Behind the engine's auth (http.ts), like every
 * route. Nothing here returns a key: the pairing code is shown once, to the linked browser that asked for it, and is
 * useless after ten minutes, five tries or one pairing.
 */
export function browserRouter(): Router {
  const r = express.Router();
  r.get("/browser", (_req, res) => {
    const s = browserState();
    const p = pairingInfo();
    res.json({
      connected: s.connected,
      since: s.since,
      version: s.version,
      chrome: s.chrome,
      caps: s.caps,
      tabs: s.tabs.map((t) => ({ id: t.id, title: t.title, host: hostOf(t.url), active: t.active, own: isOwnTab(t) })),
      paired: p.paired,
      extensionId: p.extensionId,
      pairedAt: p.pairedAt,
      codeExpiresAt: p.codeExpiresAt,
      extensionDir: path.join(ROOT, "extension"),
    });
  });
  // A fresh one-time code for the extension's popup (the previous one stops working).
  r.post("/browser/pairing-code", (_req, res) => res.json(newPairingCode()));
  // Forget the paired extension: it is disconnected and can't come back without a new code.
  r.delete("/browser/pairing", (_req, res) => res.json({ ok: true, wasPaired: unpairBrowser() }));
  return r;
}
