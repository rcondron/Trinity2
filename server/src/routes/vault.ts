import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { asVaultError, httpStatusOf, VaultError } from "../vault/errors.js";
import { cancelForm, itemFields, readValues, submitForm } from "../vault/forms.js";
import { listItems, vaultStatus, type VaultKind } from "../vault/index.js";
import { vault } from "../vault/instance.js";
import { buildItem } from "../vault/items.js";
import { Secret } from "../vault/secret.js";

/*
 * The vault over HTTP — for the secure form the workspace window draws, and for Settings → Vault. Mounted ahead of
 * the engine's general JSON parser and behind authentication (http.ts).
 *
 *   GET    /api/vault              the status, the items' metadata, the settings, the fields each kind of item has
 *   POST   /api/vault/items        add an item: {kind, values} — the body holds the secret, the answer never does
 *   DELETE /api/vault/items/:id    remove one
 *   POST   /api/vault/forms/:id    what was typed into a secure form: {values}
 *   DELETE /api/vault/forms/:id    cancel a secure form
 *   POST   /api/vault/lock         lock now
 *   POST   /api/vault/unlock       {passphrase} — for Settings; the workspace unlocks through a secure form
 *   PUT    /api/vault/settings     {lock, passphrase, currentPassphrase, spendingLimit}
 *   anything else under /api/vault…  a fixed 404, its body never read
 *
 * Rules that hold for every route here:
 *  - No route returns a secret, ever: answers are metadata, a status, or {ok: true}.
 *  - Bodies are write-only. They are parsed here (JSON only, 16 kB at most) and nowhere else, and nothing of them is
 *    echoed or logged — not in a validation message, not when the JSON doesn't parse. Every error text is a fixed
 *    sentence from vault/errors.ts or from this file.
 */

const KINDS: readonly VaultKind[] = ["login", "card", "identity", "secret"];
const FORM_ID = /^[A-Za-z0-9_-]{20,100}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{8,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

function overview() {
  const v = vault();
  // While the vault may not be used at all (sign-in checks off, the engine open to other computers, a file that can't
  // be trusted) it says nothing about what is in it either: no item, and no count of them.
  const refused = v.refusal() !== undefined;
  const status = vaultStatus();
  return {
    status: refused ? { ...status, items: 0 } : status,
    items: refused ? [] : listItems(),
    settings: v.settings(),
    /** Whether this computer can lock the vault by itself (Windows DPAPI). */
    keyStore: v.deviceAvailable(),
    /** After too many wrong passphrases: how long until the next try. */
    retryAfterMs: v.retryAfterMs(),
  };
}

function send(res: Response, status: number, body: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

/** An error as its answer: the vault's own fixed sentence and code — or, for anything else, nothing of it at all. */
function fail(res: Response, err: unknown): void {
  if (!(err instanceof VaultError)) console.warn("[vault] a request failed inside the engine (details withheld)");
  const e = asVaultError(err);
  send(res, httpStatusOf(e.code), {
    error: e.message,
    code: e.code,
    ...(e.field ? { field: e.field } : {}),
    ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
  });
}

const BAD_REQUEST = { error: "That request couldn't be read.", code: "bad-request" };

/** The JSON body as an object with only the keys named — or null (the answer is then a plain 400). */
function bodyOf(req: Request, allowed: readonly string[]): Record<string, unknown> | null {
  if (!req.is("application/json")) return null;
  const b: unknown = req.body;
  return isObj(b) && onlyKeys(b, allowed) ? b : null;
}

type Handler = (req: Request, res: Response) => Promise<void> | void;
const route =
  (fn: Handler) =>
  (req: Request, res: Response): void => {
    void Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => fail(res, err));
  };

export function vaultRouter(): Router {
  const r = express.Router();
  const json = express.json({ limit: "16kb", strict: true, type: "application/json" });

  r.get(
    "/vault",
    route((_req, res) => {
      send(res, 200, {
        ...overview(),
        // What Settings → Vault draws its "add" form from: the same fields the secure form shows.
        fields: { login: itemFields("login"), card: itemFields("card"), identity: itemFields("identity"), secret: itemFields("secret") },
      });
    }),
  );

  r.post(
    "/vault/items",
    json,
    route(async (req, res) => {
      const body = bodyOf(req, ["kind", "values"]);
      const kind = body && KINDS.includes(body.kind as VaultKind) ? (body.kind as VaultKind) : null;
      if (!body || !kind) return send(res, 400, BAD_REQUEST);
      const item = buildItem(kind, readValues(itemFields(kind), body.values));
      const meta = await vault().add(item);
      send(res, 200, { ok: true, item: meta });
    }),
  );

  r.delete(
    "/vault/items/:id",
    route(async (req, res) => {
      const id = String(req.params.id ?? "");
      if (!ITEM_ID.test(id) || !(await vault().remove(id))) return send(res, 404, { error: "That item isn't in the vault.", code: "not-found" });
      send(res, 200, { ok: true });
    }),
  );

  r.post(
    "/vault/forms/:id",
    json,
    route(async (req, res) => {
      const id = String(req.params.id ?? "");
      const body = bodyOf(req, ["values"]);
      if (!body) return send(res, 400, BAD_REQUEST);
      if (!FORM_ID.test(id)) return send(res, 404, { error: "That form is no longer open.", code: "gone" });
      const status = await submitForm(id, body.values);
      send(res, 200, { ok: true, status });
    }),
  );

  r.delete(
    "/vault/forms/:id",
    route((req, res) => {
      const id = String(req.params.id ?? "");
      if (!FORM_ID.test(id) || !cancelForm(id)) return send(res, 404, { error: "That form is no longer open.", code: "gone" });
      send(res, 200, { ok: true });
    }),
  );

  r.post(
    "/vault/lock",
    route(async (_req, res) => {
      // (It takes its turn after whatever the vault is in the middle of: a lock never lands inside another change.)
      await vault().lock();
      send(res, 200, { ok: true, status: vaultStatus() });
    }),
  );

  r.post(
    "/vault/unlock",
    json,
    route(async (req, res) => {
      const body = bodyOf(req, ["passphrase"]);
      if (!body || (body.passphrase !== undefined && typeof body.passphrase !== "string")) return send(res, 400, BAD_REQUEST);
      await vault().unlock(typeof body.passphrase === "string" ? new Secret(body.passphrase) : undefined);
      send(res, 200, { ok: true, status: vaultStatus() });
    }),
  );

  r.put(
    "/vault/settings",
    json,
    route(async (req, res) => {
      const body = bodyOf(req, ["lock", "passphrase", "currentPassphrase", "spendingLimit"]);
      const text = (v: unknown): v is string | undefined => v === undefined || (typeof v === "string" && v.length <= 1000);
      if (
        !body ||
        (body.lock !== undefined && body.lock !== "device" && body.lock !== "passphrase") ||
        !text(body.passphrase) ||
        !text(body.currentPassphrase) ||
        (body.spendingLimit !== undefined && typeof body.spendingLimit !== "number")
      ) {
        return send(res, 400, BAD_REQUEST);
      }
      if (body.lock !== undefined) {
        await vault().setLock(body.lock, {
          ...(body.passphrase ? { passphrase: new Secret(body.passphrase) } : {}),
          ...(body.currentPassphrase ? { current: new Secret(body.currentPassphrase) } : {}),
        });
      }
      if (body.spendingLimit !== undefined) await vault().setSettings({ spendingLimit: body.spendingLimit });
      send(res, 200, { ok: true, ...overview() });
    }),
  );

  // Anything else addressed to the vault ends HERE, with a fixed answer and its body unread: a path or a method no
  // route above takes must not fall through to the engine's general JSON parser, whose error can quote what it read.
  const VAULT_PATH = /^\/vault/i;
  r.use((req: Request, res: Response, next: NextFunction) => {
    if (!VAULT_PATH.test(req.path)) return next();
    send(res, 404, { error: "The vault has no such address.", code: "not-found" });
  });

  // A body that is too large or isn't JSON ends here too: the parser's own message can quote the body, so it is dropped.
  r.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!VAULT_PATH.test(req.path)) return next(err);
    const tooLarge = isObj(err) && (err.type === "entity.too.large" || err.status === 413);
    send(res, tooLarge ? 413 : 400, tooLarge ? { error: "That request is too large.", code: "too-large" } : BAD_REQUEST);
  });

  return r;
}
