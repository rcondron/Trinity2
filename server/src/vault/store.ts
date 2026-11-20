import fs from "node:fs";
import path from "node:path";
import {
  b64,
  canonicalJson,
  concat,
  fromUtf8,
  hkdf,
  isZeroKey,
  IV_BYTES,
  KEY_BYTES,
  liveKey,
  mac,
  macOk,
  open,
  randomBytes,
  randomId,
  SCRYPT,
  scryptKey,
  scryptParamsOk,
  seal,
  TAG_BYTES,
  unb64,
  utf8,
  wipe,
  type Bytes,
  type ScryptParams,
  type Sealed,
} from "./crypto.js";
import type { DeviceKeySource } from "./dpapi.js";
import { VaultError } from "./errors.js";
import type { VaultItemMeta, VaultKind, VaultSecret, VaultStatus } from "./index.js";
import { MAX_HOSTS, normalizeHost, type NewItem } from "./items.js";
import { vaultBlocked } from "./policy.js";
import { guard, holds, needlesOf, type Secret } from "./secret.js";
import { totp } from "./totp.js";

/*
 * The vault file and its keys.
 *
 * Files (all in the vault folder, written temp-then-rename):
 *   vault.json     {format, version, lock, device, kdf, key, settings, items[], mac}
 *   device.key     the device secret, protected by Windows DPAPI (dpapi.ts)
 *   attempts.json  wrong-passphrase count and the time the next try is allowed
 *   access.log     one JSON line per use of a secret: {ts, id, purpose, ok} — never a value
 *
 * Keys:
 *   data key   32 random bytes. Seals each item's secret JSON with AES-256-GCM: a fresh 12-byte IV per write and the
 *              associated data "id|kind|version" (version counts the writes of that item), so a ciphertext can't be
 *              moved to another item, another kind or an older record.
 *              Replaced by a new random key whenever the lock is changed (every item is re-sealed in the same write),
 *              so a copy of the file made under an earlier lock opens nothing that was saved or re-locked since.
 *   KEK        wraps the data key (AES-256-GCM). HKDF-SHA256(ikm, salt = kdf.salt, info = "trinity-vault/kek/v1/…"):
 *                lock "device":      ikm = device secret
 *                lock "passphrase":  ikm = device secret || scrypt(passphrase, kdf.scrypt.salt, N, r = 8, p = 1)
 *                                    (just the scrypt output on a computer with no key store: `device` is false).
 *                                    N is 2^17 for a passphrase set now; a file made with 2^15 still opens.
 *   MAC key    HKDF-SHA256(data key, info = "trinity-vault/mac/v1"). `mac` is HMAC-SHA256 over the canonical JSON of
 *              everything else in the file, checked at every unlock: the plain metadata (the hosts a login may be
 *              filled on, the spending limit, the lock mode) can't be edited behind the vault's back either.
 *
 * Fail closed: an unknown format or version, JSON that doesn't parse, a field of the wrong shape, a MAC or tag that
 * doesn't verify — the vault reports itself blocked, hands out nothing and never writes over the file.
 *
 * One thing at a time: unlocking, LOCKING, changing the lock and every write go through one queue, and each takes its
 * own copy of the data key. A lock asked for in the middle of another change waits for it; it can never zero a key
 * that is being used, and nothing is ever sealed, authenticated or written under a wiped (all-zero) key.
 */

const FILE = "vault.json";
const ATTEMPTS = "attempts.json";
const LOG = "access.log";
const FORMAT = "trinity-vault";
const VERSION = 1;
const MAX_ITEMS = 500;
const MAX_LOG_BYTES = 1024 * 1024;

/** The vault re-locks after this long without use. */
export const IDLE_LOCK_MS = 15 * 60_000;
/** Wrong passphrases allowed before each further one costs a wait. */
export const FREE_TRIES = 5;
export const DEFAULT_SPENDING_LIMIT = 200;
export const MIN_PASSPHRASE = 8;

export interface VaultSettings {
  /** A card fill on a page whose total is above this (in the page's currency) needs approval in a secure form. */
  spendingLimit: number;
}

interface StoredItem extends Sealed {
  meta: VaultItemMeta;
  /** Counts the writes of this item's secret; part of what its ciphertext is bound to. */
  v: number;
}

interface VaultFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  lock: "device" | "passphrase";
  /** Whether the device secret is part of the key-encryption key. */
  device: boolean;
  kdf: { salt: string; scrypt?: ScryptParams & { salt: string } };
  /** The data key, wrapped. */
  key: Sealed;
  settings: VaultSettings;
  items: StoredItem[];
  mac: string;
}

export interface StoreOptions {
  dir: string;
  /** Where the device secret comes from; null on a computer with no key store (passphrase lock only). */
  device: DeviceKeySource | null;
  idleMs?: number;
  now?: () => number;
}

const DAMAGED = "The vault file is damaged or was changed outside Trinity, so nothing in it can be used.";
const NEWER = "The vault file was written by a newer version of Trinity than this one.";
const LOCKED = "The vault is locked.";

const damaged = (): VaultError => new VaultError("damaged", DAMAGED);
const clone = <T>(v: T): T => structuredClone(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long the next try must wait after `fails` wrong passphrases in a row: 30 s, then doubling, at most 15 minutes. */
export function retryDelayMs(fails: number): number {
  if (fails < FREE_TRIES) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(fails - FREE_TRIES, 10));
}

// ─── Reading the file ─────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const optStr = (v: unknown, max: number): boolean => v === undefined || isStr(v, max);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const KINDS: readonly VaultKind[] = ["login", "card", "identity", "secret"];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HOST_SHAPE = /^[a-z0-9.-]{1,253}$/;

function sealedOk(v: Record<string, unknown>): boolean {
  try {
    unb64(v.iv, IV_BYTES);
    unb64(v.tag, TAG_BYTES);
    unb64(v.ct);
    return true;
  } catch {
    return false;
  }
}

function metaOk(m: unknown): m is VaultItemMeta {
  if (!isObj(m)) return false;
  const allowed = new Set(["id", "kind", "label", "hosts", "usernameHint", "brand", "last4", "expMonth", "expYear", "hasTotp", "hasCvc", "createdAt", "updatedAt", "lastUsedAt"]);
  for (const k of Object.keys(m)) if (!allowed.has(k)) return false;
  return (
    typeof m.id === "string" && ID_RE.test(m.id) &&
    KINDS.includes(m.kind as VaultKind) &&
    isStr(m.label, 200) &&
    Array.isArray(m.hosts) && m.hosts.length <= MAX_HOSTS && m.hosts.every((h) => typeof h === "string" && HOST_SHAPE.test(h)) &&
    optStr(m.usernameHint, 200) && optStr(m.brand, 40) &&
    (m.last4 === undefined || (typeof m.last4 === "string" && /^\d{4}$/.test(m.last4))) &&
    (m.expMonth === undefined || (Number.isInteger(m.expMonth) && (m.expMonth as number) >= 1 && (m.expMonth as number) <= 12)) &&
    (m.expYear === undefined || (Number.isInteger(m.expYear) && (m.expYear as number) >= 2000 && (m.expYear as number) <= 2200)) &&
    (m.hasTotp === undefined || typeof m.hasTotp === "boolean") &&
    (m.hasCvc === undefined || typeof m.hasCvc === "boolean") &&
    isTime(m.createdAt) && isTime(m.updatedAt) && (m.lastUsedAt === null || isTime(m.lastUsedAt))
  );
}

/** The vault file from its text — every field checked — or a "damaged" error. Never a partial result. */
function parseFile(text: string): VaultFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw damaged(); // (the parser's own message can quote the file: it is dropped)
  }
  if (!isObj(raw) || raw.format !== FORMAT) throw damaged();
  if (raw.version !== VERSION) throw new VaultError("damaged", typeof raw.version === "number" && raw.version > VERSION ? NEWER : DAMAGED);
  const allowed = new Set(["format", "version", "lock", "device", "kdf", "key", "settings", "items", "mac"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw damaged();
  if (raw.lock !== "device" && raw.lock !== "passphrase") throw damaged();
  if (typeof raw.device !== "boolean" || (raw.lock === "device" && !raw.device)) throw damaged();
  const kdf = raw.kdf;
  if (!isObj(kdf)) throw damaged();
  try {
    unb64(kdf.salt, 32);
  } catch {
    throw damaged();
  }
  const sc = kdf.scrypt;
  if (raw.lock === "passphrase") {
    if (!isObj(sc) || !scryptParamsOk(sc as unknown as ScryptParams)) throw damaged();
    try {
      unb64(sc.salt, 16);
    } catch {
      throw damaged();
    }
  } else if (sc !== undefined) throw damaged();
  if (!isObj(raw.key) || !sealedOk(raw.key)) throw damaged();
  const settings = raw.settings;
  if (!isObj(settings) || typeof settings.spendingLimit !== "number" || !Number.isFinite(settings.spendingLimit) || settings.spendingLimit < 0) throw damaged();
  if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS) throw damaged();
  const ids = new Set<string>();
  for (const it of raw.items as unknown[]) {
    if (!isObj(it) || !metaOk(it.meta) || !Number.isInteger(it.v) || (it.v as number) < 1 || !sealedOk(it)) throw damaged();
    for (const k of Object.keys(it)) if (!["meta", "v", "iv", "ct", "tag"].includes(k)) throw damaged();
    if (ids.has(it.meta.id)) throw damaged();
    ids.add(it.meta.id);
  }
  if (!isStr(raw.mac, 100)) throw damaged();
  return raw as unknown as VaultFile;
}

/** What the MAC covers: the whole file but the MAC itself. */
function macText(file: VaultFile): string {
  const { mac: _mac, ...rest } = file;
  return canonicalJson(rest);
}

const macKey = (dataKey: Bytes): Bytes => hkdf(dataKey, new Uint8Array(0), "trinity-vault/mac/v1");
const itemAad = (meta: Pick<VaultItemMeta, "id" | "kind">, v: number): string => `${meta.id}|${meta.kind}|${v}`;
const wrapAad = (lock: string, device: boolean): string => `${FORMAT}|${VERSION}|data-key|${lock}|${device ? "device" : "no-device"}`;

function deriveKek(lock: string, device: boolean, deviceSecret: Bytes | null, passKey: Bytes | null, salt: Bytes): Bytes {
  const ikm = concat(deviceSecret ?? new Uint8Array(0), passKey ?? new Uint8Array(0));
  if (ikm.byteLength < KEY_BYTES) throw new VaultError("failed", "The vault has no key to lock with.");
  try {
    return hkdf(ikm, salt, `trinity-vault/kek/v1/${lock}/${device ? "device" : "no-device"}`);
  } finally {
    wipe(ikm);
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomId(4)}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const fh = await fs.promises.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let i = 0; ; i++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (i >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw err;
        await sleep(25 * (i + 1)); // Windows: a scanner had the file open for a moment
      }
    }
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw new VaultError("failed", "The vault file couldn't be written.");
  }
}

/** The strings in a decrypted secret that must never leave (see secret.ts: needlesOf). */
function secretValues(kind: VaultKind, s: Record<string, unknown>): unknown[] {
  if (kind === "login") return [s.password, s.totpSecret];
  if (kind === "card") return [s.number, s.cvc];
  if (kind === "secret") return [s.value];
  return [];
}

/** Words a fill's result is made of (field kinds, steps, outcomes): a password that IS one of them can't be told from them. */
const RESULT_WORDS = [
  "username", "password", "otp", "one-time-code", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-name", "name", "email",
  "tel", "address-line1", "address-line2", "address-level1", "address-level2", "postal-code", "country", "country-name", "bday", "done",
  "next", "origin", "documentId", "origin-mismatch", "no-fields", "insecure", "form-target", "expired", "not-connected", "timeout", "failed",
  "filled", "missing", "kinds", "submitRef", "formAction",
];

/**
 * What to look for in a result or an error before it leaves useSecret: the secret values — except one that already
 * sits inside what is public about the item (a password "netflix" for www.netflix.com) or inside a word every result
 * is made of (a password "password"). Such a value would be "found" in every honest result; it gives nothing away there.
 */
function leakNeedles(meta: VaultItemMeta, secret: Record<string, unknown>): string[] {
  const open = [meta.label, meta.usernameHint ?? "", ...meta.hosts, ...meta.hosts.map((h) => `https://${h}`), ...RESULT_WORDS];
  return needlesOf(secretValues(meta.kind, secret)).filter((n) => !open.some((p) => p.includes(n)));
}

export class VaultStore {
  private readonly dir: string;
  private readonly device: DeviceKeySource | null;
  private readonly idleMs: number;
  private readonly now: () => number;

  private loaded = false;
  /** mtime:size of the file this state was read from (or written as), so a change made elsewhere is noticed. */
  private sig = "";
  private file: VaultFile | null = null;
  private broken: string | null = null;
  /**
   * The vault's own copy of the data key while it is unlocked. It is assigned and wiped only from inside the queue
   * below (or while nothing is running in it), and no operation ever works on this buffer across an await: each takes
   * a copy of its own (takeKey) and wipes that when it is done. So wiping this one can never zero a key in use.
   */
  private dataKey: Bytes | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** An operation is running in the queue. */
  private running = 0;
  private attempts: { fails: number; nextTryAt: number } | null = null;
  /** Secrets handed out and not yet taken back (emptied if the vault locks under them). */
  private readonly active = new Set<() => void>();
  private readonly lockListeners = new Set<() => void>();

  constructor(opts: StoreOptions) {
    this.dir = opts.dir;
    this.device = opts.device;
    this.idleMs = opts.idleMs ?? IDLE_LOCK_MS;
    this.now = opts.now ?? Date.now;
  }

  // ── What may be seen without a key ──────────────────────────────────────────

  status(): VaultStatus {
    this.refresh();
    const policy = vaultBlocked();
    // (Queued like any lock. Until it runs the key opens nothing: every operation refuses while the vault is blocked.)
    if (policy && this.dataKey) void this.lock();
    const unlocked = !policy && this.dataKey !== null;
    const lock = this.file?.lock ?? (this.deviceAvailable() ? "device" : "passphrase");
    const items = this.file?.items.length ?? 0;
    const noStore =
      !this.file && !this.deviceAvailable()
        ? "This computer has no key store for the vault. Set a vault passphrase in Settings, under Vault, to start using it."
        : undefined;
    const blocked = policy ?? this.broken ?? noStore;
    const state: VaultStatus["state"] = items === 0 && (!this.file || this.file.lock === "device" || unlocked) ? "empty" : unlocked ? "unlocked" : "locked";
    return blocked ? { state, lock, items, blocked } : { state, lock, items };
  }

  /** Why nothing may be done at all (auth off, not loopback, a file that can't be trusted) — else undefined. */
  refusal(): string | undefined {
    this.refresh();
    return vaultBlocked() ?? this.broken ?? undefined;
  }

  /** True on a computer that has a key store (so the "device" lock can be chosen). */
  deviceAvailable(): boolean {
    return this.device !== null && this.device.available();
  }

  list(kind?: VaultKind): VaultItemMeta[] {
    this.refresh();
    return (this.file?.items ?? []).filter((i) => !kind || i.meta.kind === kind).map((i) => clone(i.meta));
  }

  findLogins(host: string): VaultItemMeta[] {
    const h = host.trim().toLowerCase();
    return this.list("login").filter((m) => m.hosts.includes(h));
  }

  meta(id: string): VaultItemMeta | null {
    this.refresh();
    const hit = this.file?.items.find((i) => i.meta.id === id);
    return hit ? clone(hit.meta) : null;
  }

  settings(): VaultSettings {
    this.refresh();
    return { spendingLimit: this.file?.settings.spendingLimit ?? DEFAULT_SPENDING_LIMIT };
  }

  /** How long until a passphrase may be tried again (0: now). */
  retryAfterMs(): number {
    return Math.max(0, this.readAttempts().nextTryAt - this.now());
  }

  onLock(fn: () => void): () => void {
    this.lockListeners.add(fn);
    return () => this.lockListeners.delete(fn);
  }

  // ── Locking ────────────────────────────────────────────────────────────────

  /**
   * Forget the data key (and empty any secret still handed out). The next use unlocks again — or needs the passphrase.
   * It waits its turn in the queue like every other change: a lock asked for while the lock mode is being changed, or
   * while something is being saved, takes effect when that is done — never in the middle of it.
   */
  lock(): Promise<void> {
    return this.exclusive(async () => this.dropKey());
  }

  /** Unlock with the passphrase (lock "passphrase"), or by the device key alone (lock "device": no passphrase needed). */
  unlock(passphrase?: Secret): Promise<void> {
    return this.exclusive(async () => {
      this.assertUsable();
      if (!this.file) throw new VaultError("not-found", "Nothing is saved in the vault yet.");
      if (this.file.lock === "device") {
        await this.ensureKey(false);
        return;
      }
      if (!passphrase || passphrase.length === 0) throw new VaultError("invalid", "Type the vault's passphrase.", { field: "passphrase" });
      await this.tryPassphrase(passphrase);
    });
  }

  /**
   * Change how the vault is locked. To "passphrase": `passphrase` is the new one. From "passphrase" (to "device", or to
   * a new passphrase): `current` must be the present one — being unlocked is not enough.
   *
   * The data key is replaced as well: a new random key, every item opened with the old one and sealed again with the
   * new, all in one atomic write. A copy of vault.json taken under the old lock therefore opens nothing saved or
   * re-locked afterwards.
   */
  setLock(mode: "device" | "passphrase", opts: { passphrase?: Secret; current?: Secret } = {}): Promise<void> {
    return this.exclusive(async () => {
      this.assertUsable();
      if (mode === "device" && !this.deviceAvailable()) {
        throw new VaultError("no-key-store", "This computer has no key store, so the vault can only be locked with a passphrase.");
      }
      if (mode === "passphrase") {
        const p = opts.passphrase;
        if (!p || p.length < MIN_PASSPHRASE) throw new VaultError("invalid", `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`, { field: "passphrase" });
        if (p.length > 256) throw new VaultError("invalid", "That passphrase is too long.", { field: "passphrase" });
      }
      let old: Bytes | null = null; // this operation's own copy of the present key
      const fresh = randomBytes(KEY_BYTES); // the key from now on
      let installed = false;
      try {
        let base: VaultFile;
        if (this.file) {
          if (this.file.lock === "passphrase") {
            if (!opts.current || opts.current.length === 0) {
              throw new VaultError("invalid", "Type the current passphrase to change how the vault is locked.", { field: "currentPassphrase" });
            }
            await this.tryPassphrase(opts.current);
          }
          old = await this.takeKey(false);
          base = this.resealed(this.file, old, fresh);
        } else {
          base = this.blank();
        }
        const next = await this.wrapped(base, fresh, mode, opts.passphrase);
        await this.write(next, fresh);
        this.holdKey(fresh);
        installed = true;
      } finally {
        wipe(old);
        if (!installed) wipe(fresh);
      }
    });
  }

  setSettings(patch: Partial<VaultSettings>): Promise<VaultSettings> {
    const limit = patch.spendingLimit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0 || limit > 1_000_000)) {
      return Promise.reject(new VaultError("invalid", "The spending limit is an amount from 0 to 1,000,000.", { field: "spendingLimit" }));
    }
    return this.withKey(true, async (key) => {
      if (limit !== undefined) {
        const next = clone(this.file!);
        next.settings.spendingLimit = Math.round(limit * 100) / 100;
        await this.write(next, key);
      }
      return { spendingLimit: this.file?.settings.spendingLimit ?? DEFAULT_SPENDING_LIMIT };
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────────

  add(item: NewItem): Promise<VaultItemMeta> {
    return this.withKey(true, async (key) => {
      const next = clone(this.file!);
      if (next.items.length >= MAX_ITEMS) throw new VaultError("full", "The vault is full.");
      const now = this.now();
      // The plain part of the record, field by named field: nothing else of what was handed in is ever written in the clear.
      const meta: VaultItemMeta = { id: randomId(12), kind: item.kind, label: item.label, hosts: item.kind === "login" ? [...item.hosts] : [], createdAt: now, updatedAt: now, lastUsedAt: null };
      if (item.kind === "login") {
        if (item.usernameHint) meta.usernameHint = item.usernameHint;
        meta.hasTotp = item.hasTotp;
      } else if (item.kind === "card") {
        meta.brand = item.brand;
        meta.last4 = item.last4;
        meta.expMonth = item.expMonth;
        meta.expYear = item.expYear;
        meta.hasCvc = item.hasCvc;
      }
      const text = utf8(JSON.stringify(item.secret));
      try {
        next.items.push({ meta, v: 1, ...seal(key, text, itemAad(meta, 1)) });
      } finally {
        wipe(text);
      }
      await this.write(next, key);
      return clone(meta);
    });
  }

  remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertUsable();
      if (!this.file?.items.some((i) => i.meta.id === id)) return false;
      const key = await this.takeKey(false);
      try {
        const next = clone(this.file);
        next.items = next.items.filter((i) => i.meta.id !== id);
        await this.write(next, key);
        return true;
      } finally {
        wipe(key);
      }
    });
  }

  /** Let a login be filled on one more host. */
  addHost(id: string, host: string): Promise<void> {
    let exact: string;
    try {
      exact = normalizeHost(host, "host");
    } catch (err) {
      return Promise.reject(err);
    }
    return this.withKey(false, async (key) => {
      const next = clone(this.file!);
      const item = next.items.find((i) => i.meta.id === id);
      if (!item) throw new VaultError("not-found", "That item isn't in the vault.");
      if (item.meta.kind !== "login") throw new VaultError("invalid", "Only a login is tied to websites.");
      if (item.meta.hosts.includes(exact)) return;
      if (item.meta.hosts.length >= MAX_HOSTS) throw new VaultError("full", "That login is already used on as many sites as it can be.");
      item.meta.hosts.push(exact);
      item.meta.updatedAt = this.now();
      await this.write(next, key);
    });
  }

  /**
   * Decrypt one item and hand it to `fn` — the only way a secret leaves the store. `fn` gets a view that prints as
   * "[secret]" and is emptied the moment `fn` is done; what `fn` returns (or throws) is checked for the secret before
   * it is passed on. The use is logged by id and purpose; the value never is.
   */
  async use<T>(id: string, purpose: string, fn: (secret: Readonly<VaultSecret>, meta: VaultItemMeta) => Promise<T>): Promise<T> {
    const { plain, meta } = await this.withKey(false, async (key) => {
      const item = this.file?.items.find((i) => i.meta.id === id);
      if (!item) throw new VaultError("not-found", "That item isn't in the vault.");
      return { plain: open(key, item, itemAad(item.meta, item.v)), meta: clone(item.meta) };
    });
    let secret: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(fromUtf8(plain));
      if (!isObj(parsed)) throw new Error("shape");
      secret = parsed;
    } catch {
      throw damaged(); // (never the parser's message: it can quote the plaintext)
    } finally {
      wipe(plain);
    }
    if (meta.kind === "login" && typeof secret.totpSecret === "string" && secret.totpSecret) {
      try {
        // The current code for sites that use an authenticator app: computed here, handed out only here.
        secret.totpCode = totp(secret.totpSecret, this.now());
      } catch {
        /* a seed that no longer decodes: the fill goes on without a code */
      }
    }
    const needles = leakNeedles(meta, secret);
    const why = this.cleanPurpose(purpose, needles);
    const handed = guard(secret as unknown as VaultSecret);
    this.active.add(handed.revoke);
    const takeBack = (): void => {
      handed.revoke();
      this.active.delete(handed.revoke);
      for (const k of Object.keys(secret)) secret[k] = "";
    };
    let result: T;
    try {
      result = await fn(handed.view, meta);
    } catch (err) {
      takeBack();
      await this.afterUse(id, why, false);
      if (holds(err, needles)) throw new VaultError("leak", "A vault secret was about to leave in an error message. Stopped.");
      throw err;
    }
    takeBack();
    if (holds(result, needles)) {
      await this.afterUse(id, why, false);
      throw new VaultError("leak", "A vault secret was about to leave the vault in a result. Stopped.");
    }
    await this.afterUse(id, why, true);
    return result;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private p(name: string): string {
    return path.join(this.dir, name);
  }

  /** One vault operation at a time (unlocking, locking, writing): the next starts when this one has settled. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const turn = async (): Promise<T> => {
      this.running++;
      try {
        return await fn();
      } finally {
        this.running--;
      }
    };
    const run = this.queue.then(turn, turn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** An operation that needs the data key: it gets a copy of its own, wiped when it is done. */
  private withKey<T>(create: boolean, fn: (key: Bytes) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const key = await this.takeKey(create);
      try {
        return await fn(key);
      } finally {
        wipe(key);
      }
    });
  }

  /** A copy of the data key for the operation that asks (inside the queue). The caller wipes it. */
  private async takeKey(create: boolean): Promise<Bytes> {
    await this.ensureKey(create);
    if (!this.dataKey) throw new VaultError("locked", LOCKED);
    return liveKey(this.dataKey.slice());
  }

  /** Drop the key now. Only from inside the queue, or while nothing runs in it (see `dataKey`). */
  private dropKey(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const had = this.dataKey !== null;
    wipe(this.dataKey);
    this.dataKey = null;
    for (const revoke of [...this.active]) revoke();
    this.active.clear();
    if (!had) return;
    for (const fn of this.lockListeners) {
      try {
        fn();
      } catch {
        /* a listener's trouble is not the vault's */
      }
    }
  }

  private statSig(): string {
    try {
      const s = fs.statSync(this.p(FILE));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "none";
    }
  }

  /**
   * Bring the in-memory state in line with the file, when the file was changed since it was read or written here.
   * A reader outside the queue leaves it alone while an operation is at work (`inside` is that operation asking).
   */
  private refresh(inside = false): void {
    if (this.running && !inside) return;
    const sig = this.statSig();
    if (this.loaded && sig === this.sig) return;
    this.loaded = true;
    this.sig = sig;
    if (sig === "none") {
      this.file = null;
      this.broken = null;
      this.dropKey();
      return;
    }
    try {
      const parsed = parseFile(fs.readFileSync(this.p(FILE), "utf8"));
      // A key held from before must still be this file's key; otherwise it is dropped and the next use unlocks afresh.
      if (this.dataKey && !this.verifies(parsed, this.dataKey)) this.dropKey();
      this.file = parsed;
      this.broken = null;
    } catch (err) {
      this.file = null;
      this.dropKey();
      this.broken = err instanceof VaultError ? err.message : DAMAGED;
    }
  }

  private verifies(file: VaultFile, dataKey: Bytes): boolean {
    const k = macKey(dataKey);
    try {
      return macOk(k, macText(file), file.mac);
    } finally {
      wipe(k);
    }
  }

  /** At the start of an operation (inside the queue): the file as it is now, and nothing at all while the vault may not be used. */
  private assertUsable(): void {
    this.refresh(true);
    const policy = vaultBlocked();
    if (policy) {
      this.dropKey();
      throw new VaultError("blocked", policy);
    }
    if (this.broken) throw new VaultError("blocked", this.broken);
  }

  private blank(): VaultFile {
    return {
      format: FORMAT,
      version: VERSION,
      lock: "device",
      device: true,
      kdf: { salt: "" },
      key: { iv: "", ct: "", tag: "" },
      settings: { spendingLimit: DEFAULT_SPENDING_LIMIT },
      items: [],
      mac: "",
    };
  }

  /** Make `key` the vault's own copy (inside the queue). The one held before is wiped. */
  private holdKey(key: Bytes): void {
    liveKey(key);
    if (this.dataKey && this.dataKey !== key) wipe(this.dataKey);
    this.dataKey = key;
    this.touch();
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.lock(), this.idleMs);
    this.idle.unref?.();
  }

  /** Make sure the vault is unlocked (inside the queue): by the device key, or — with `create` — by making it on first use. */
  private async ensureKey(create: boolean): Promise<void> {
    this.assertUsable();
    if (this.dataKey) {
      this.touch();
      return;
    }
    if (!this.file) {
      if (!create) throw new VaultError("not-found", "Nothing is saved in the vault yet.");
      if (!this.deviceAvailable()) {
        throw new VaultError("no-key-store", "This computer has no key store for the vault. Set a vault passphrase in Settings, under Vault, first.");
      }
      const key = randomBytes(KEY_BYTES);
      try {
        await this.write(await this.wrapped(this.blank(), key, "device"), key);
      } catch (err) {
        wipe(key);
        throw err;
      }
      this.holdKey(key);
      return;
    }
    if (this.file.lock === "passphrase") throw new VaultError("locked", LOCKED);
    await this.unwrap(null);
  }

  /** Every item of `file` opened with one key and sealed again with another (its version moves on). Nothing is written here. */
  private resealed(file: VaultFile, from: Bytes, to: Bytes): VaultFile {
    const next = clone(file);
    next.items = next.items.map((item) => {
      const plain = open(from, item, itemAad(item.meta, item.v)); // an item that doesn't open stops the change: "tampered"
      try {
        const v = item.v + 1;
        return { meta: item.meta, v, ...seal(to, plain, itemAad(item.meta, v)) };
      } finally {
        wipe(plain);
      }
    });
    return next;
  }

  /** `file` with a new header: the data key wrapped for `mode` under fresh salts. */
  private async wrapped(file: VaultFile, key: Bytes, mode: "device" | "passphrase", passphrase?: Secret): Promise<VaultFile> {
    const device = mode === "device" ? true : this.deviceAvailable();
    const deviceSecret = device ? await this.device!.secret(true) : null;
    const salt = randomBytes(32);
    let passKey: Bytes | null = null;
    let scrypt: (ScryptParams & { salt: string }) | undefined;
    if (mode === "passphrase") {
      const scryptSalt = randomBytes(16);
      passKey = await scryptKey(passphrase!.expose(), scryptSalt, SCRYPT);
      scrypt = { salt: b64(scryptSalt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
    }
    const kek = deriveKek(mode, device, deviceSecret, passKey, salt);
    try {
      return { ...clone(file), lock: mode, device, kdf: scrypt ? { salt: b64(salt), scrypt } : { salt: b64(salt) }, key: seal(kek, liveKey(key), wrapAad(mode, device)) };
    } finally {
      wipe(kek, passKey);
    }
  }

  /** Unwrap the data key with the device key (and the passphrase, for that lock), then check the file's MAC with it. */
  private async unwrap(passphrase: Secret | null): Promise<void> {
    const f = this.file!;
    const deviceSecret = f.device ? await this.deviceSecretFor() : null;
    let passKey: Bytes | null = null;
    if (f.lock === "passphrase") {
      if (!passphrase) throw new VaultError("locked", LOCKED);
      passKey = await scryptKey(passphrase.expose(), unb64(f.kdf.scrypt!.salt, 16), f.kdf.scrypt!);
    }
    const kek = deriveKek(f.lock, f.device, deviceSecret, passKey, unb64(f.kdf.salt, 32));
    let key: Bytes;
    try {
      key = open(kek, f.key, wrapAad(f.lock, f.device));
    } catch {
      if (f.lock === "passphrase") throw new VaultError("wrong-passphrase", "That isn't the vault's passphrase.");
      this.broken = DAMAGED;
      throw new VaultError("tampered", DAMAGED);
    } finally {
      wipe(kek, passKey);
    }
    if (key.byteLength !== KEY_BYTES || isZeroKey(key) || !this.verifies(f, key)) {
      wipe(key);
      this.broken = DAMAGED;
      throw new VaultError("tampered", DAMAGED);
    }
    this.holdKey(key);
  }

  private async deviceSecretFor(): Promise<Bytes> {
    if (!this.device || !this.device.available()) {
      throw new VaultError("no-key-store", "This vault is tied to a key store that this computer doesn't have.");
    }
    return this.device.secret(false);
  }

  /** One passphrase try, counted: after five wrong ones each further try has to wait, longer every time. */
  private async tryPassphrase(passphrase: Secret): Promise<void> {
    const a = this.readAttempts();
    const now = this.now();
    if (now < a.nextTryAt) {
      throw new VaultError("wait", "Too many wrong passphrases. Wait a little, then try again.", { retryAfterMs: a.nextTryAt - now });
    }
    try {
      await this.unwrap(passphrase);
    } catch (err) {
      if (err instanceof VaultError && err.code === "wrong-passphrase") {
        a.fails += 1;
        a.nextTryAt = a.fails >= FREE_TRIES ? this.now() + retryDelayMs(a.fails) : 0;
        this.saveAttempts(a);
      }
      throw err;
    }
    if (a.fails || a.nextTryAt) this.saveAttempts({ fails: 0, nextTryAt: 0 });
  }

  private readAttempts(): { fails: number; nextTryAt: number } {
    if (this.attempts) return this.attempts;
    let a = { fails: 0, nextTryAt: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(this.p(ATTEMPTS), "utf8")) as { fails?: unknown; nextTryAt?: unknown };
      if (Number.isInteger(raw.fails) && (raw.fails as number) >= 0 && isTime(raw.nextTryAt)) a = { fails: raw.fails as number, nextTryAt: raw.nextTryAt };
    } catch {
      /* none yet */
    }
    this.attempts = a;
    return a;
  }

  private saveAttempts(a: { fails: number; nextTryAt: number }): void {
    this.attempts = a;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.p(ATTEMPTS)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(a), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.p(ATTEMPTS));
    } catch {
      console.warn("[vault] couldn't record the passphrase attempts");
    }
  }

  /** Authenticate and write the whole file (inside the queue), then make it the state in memory. Never under a dead key. */
  private async write(next: VaultFile, key: Bytes): Promise<void> {
    liveKey(key);
    // The file on disk must still be the one this change was made from.
    if (this.loaded && this.statSig() !== this.sig) {
      this.refresh(true);
      throw new VaultError("busy", "The vault was changed by another Trinity just now. Try again.");
    }
    const k = macKey(key);
    try {
      next.mac = mac(k, macText(next));
    } finally {
      wipe(k);
    }
    await writeAtomic(this.p(FILE), `${JSON.stringify(next, null, 1)}\n`);
    this.file = next;
    this.broken = null;
    this.loaded = true;
    this.sig = this.statSig();
  }

  /** The purpose as it is logged: one short line, and never anything that holds the secret itself. */
  private cleanPurpose(purpose: string, needles: readonly string[]): string {
    const one = String(purpose ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 160);
    return holds(one, needles) ? "[withheld: it held the secret]" : one;
  }

  private async afterUse(id: string, purpose: string, ok: boolean): Promise<void> {
    try {
      const file = this.p(LOG);
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no log yet */
      }
      await fs.promises.appendFile(file, `${JSON.stringify({ ts: this.now(), id, purpose, ok })}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      console.warn("[vault] couldn't write the access log");
    }
    if (!ok) return;
    try {
      await this.exclusive(async () => {
        this.refresh(true);
        if (!this.dataKey || !this.file) return; // locked meanwhile: the log line stands
        const key = liveKey(this.dataKey.slice());
        try {
          const next = clone(this.file);
          const item = next.items.find((i) => i.meta.id === id);
          if (!item) return;
          item.meta.lastUsedAt = this.now();
          await this.write(next, key);
        } finally {
          wipe(key);
        }
      });
    } catch {
      /* "last used" is a convenience; the use itself went through */
    }
  }
}
