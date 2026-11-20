/**
 * Trinity's vault: website logins, payment cards, contact details and other secrets, encrypted at rest and never shown
 * to a model, a log, the transcript, the board or another window. This file is the facade the rest of the engine uses;
 * what stands behind it: store.ts (the file, its keys, locking), dpapi.ts (the device key), items.ts (what makes a
 * valid login or card), totp.ts (authenticator codes), forms.ts (secure forms), secret.ts (values that don't print).
 *
 * Every failure is a VaultError (errors.ts) with a `code` — "locked", "blocked", "not-found", "tampered", … — and a
 * fixed message that holds nothing typed or decrypted, so it can be spoken and logged as it is.
 *
 * Beside this file, for callers that need them: `spendingLimit()` in settings.ts (the amount above which a card fill
 * needs approval in a "confirm" form) and `VaultError` in errors.ts.
 */
import { VaultError } from "./errors.js";
import * as forms from "./forms.js";
import { vault } from "./instance.js";

export type VaultKind = "login" | "card" | "identity" | "secret";

/** What may be shown and spoken about an item: never a secret. */
export interface VaultItemMeta {
  id: string;
  kind: VaultKind;
  /** "Netflix", "Visa ending 4242", "Home address". */
  label: string;
  /** Hosts a login may be filled on: exact names, https only ("www.netflix.com"). */
  hosts: string[];
  /** A masked hint of the user name: "r…@gmail.com". */
  usernameHint?: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  hasTotp?: boolean;
  hasCvc?: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface LoginSecret {
  username: string;
  password: string;
  /** Base32 secret for one-time codes, when the site uses an authenticator app. */
  totpSecret?: string;
}
export interface CardSecret {
  number: string;
  holder: string;
  expMonth: number;
  expYear: number;
  /** Kept only if the user asked for it to be kept; otherwise asked for each time. */
  cvc?: string;
  postalCode?: string;
}
export interface IdentitySecret {
  fullName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  birthDate?: string;
}
export interface GenericSecret {
  value: string;
}
export type VaultSecret = LoginSecret | CardSecret | IdentitySecret | GenericSecret;

export interface VaultStatus {
  /** empty: nothing saved yet; locked: needs the device key or the passphrase; unlocked: ready. */
  state: "empty" | "locked" | "unlocked";
  lock: "device" | "passphrase";
  items: number;
  /** Why it can't be unlocked (auth is off, the engine isn't bound to loopback, no key store). */
  blocked?: string;
}

/**
 * Run something that needs the vault's key. When the vault is locked with a passphrase it fails with "locked" — and
 * the passphrase form is put up in the workspace, so that asking again afterwards works.
 */
async function withKey<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof VaultError && err.code === "locked") forms.requestUnlock();
    throw err;
  }
}

/**
 * `state` "locked" with `lock` "device" needs nothing from anyone: the vault unlocks by itself on its first use.
 * With `lock` "passphrase" it needs the passphrase form (openForm with purpose "unlock"; useSecret puts it up itself).
 */
export function vaultStatus(): VaultStatus {
  return vault().status();
}
export function listItems(kind?: VaultKind): VaultItemMeta[] {
  return vault().list(kind);
}
/** Logins saved for exactly this host. */
export function findLogins(host: string): VaultItemMeta[] {
  return vault().findLogins(host);
}
export function getMeta(id: string): VaultItemMeta | null {
  return vault().meta(id);
}
export async function removeItem(id: string): Promise<boolean> {
  return withKey(() => vault().remove(id));
}
/**
 * The ONLY way a secret leaves the store: `fn` gets it, uses it (hands it to the extension's encrypted fill) and returns
 * something that holds none of it. `purpose` is recorded ("fill on www.netflix.com"); the value never is.
 *
 * What `fn` gets prints, serializes and inspects as "[secret]", and is emptied when `fn` is done (a field read later
 * throws). A login that has an authenticator key also carries `totpCode`: the six-digit code for right now. If what
 * `fn` returns or throws holds the password, the card number or the like, useSecret throws a "leak" error instead.
 */
export async function useSecret<T>(id: string, purpose: string, fn: (secret: Readonly<VaultSecret>, meta: VaultItemMeta) => Promise<T>): Promise<T> {
  return withKey(() => vault().use(id, purpose, fn));
}
/** Let a login be filled on one more host (after the user approved it in a secure form). */
export async function addHost(id: string, host: string): Promise<void> {
  return withKey(() => vault().addHost(id, host));
}

// ── secure forms: what the workspace window draws for the user to type into, or to approve ──

export interface FormField {
  name: string;
  label: string;
  type: "text" | "password" | "email" | "tel" | "card-number" | "expiry" | "cvc" | "otp-secret" | "checkbox";
  required?: boolean;
  placeholder?: string;
  /** The HTML autocomplete token ("username", "cc-number", …). */
  autocomplete?: string;
  /** A prefilled value — only ever for fields that aren't secret (a site name, a label). */
  value?: string;
}

export interface FormRequest {
  /** An unguessable one-time ticket; the form is submitted to /api/vault/forms/<id>. */
  id: string;
  purpose: "save-login" | "save-card" | "save-identity" | "save-secret" | "one-time" | "confirm" | "unlock";
  title: string;
  /** One or two plain sentences: what this is for, and that Trinity can't see what is typed. */
  detail: string;
  host?: string;
  fields: FormField[];
  submitLabel: string;
  expiresAt: number;
  /** The placeholder card on the board that stands for this form, if one was added. */
  card?: number;
}

export type FormOutcome =
  /** Saved to the vault (itemId), or held for one use (see useOneTime). */
  | { status: "submitted"; itemId?: string }
  | { status: "approved" }
  | { status: "cancelled" | "expired" };

/**
 * Open a secure form in the workspace windows. `done` settles when it is submitted, approved, cancelled or lapses.
 *
 * The forms that save an item ("save-login", "save-card", "save-identity", "save-secret") and "unlock" always show the
 * vault's own fields: pass `fields: []`, or plain fields named "label" / "hosts" with a `value` to fill them in ahead.
 * With `host`, a login is saved for exactly that site. "one-time" shows the fields given; "confirm" has none.
 * Throws a VaultError ("blocked") when the vault may not be used at all.
 */
export function openForm(req: Omit<FormRequest, "id" | "expiresAt">, opts?: { ttlMs?: number }): { form: FormRequest; done: Promise<FormOutcome> } {
  return forms.openForm(req, opts);
}
/** The forms open right now (descriptors only), for a window that has just connected. */
export function openForms(): FormRequest[] {
  return forms.openForms();
}
/** Values typed into a "one-time" form (a card's security code that isn't kept): handed to `fn` once, then wiped. */
export async function useOneTime<T>(formId: string, fn: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
  return forms.useOneTime(formId, fn);
}
