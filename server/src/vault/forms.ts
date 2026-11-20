import { addFormCard, boardActive, boardBlocked, removeFormCard, sweepFormCards } from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import { randomId } from "./crypto.js";
import { VaultError } from "./errors.js";
import type { FormField, FormOutcome, FormRequest, VaultKind } from "./index.js";
import { onVaultLock, vault } from "./instance.js";
import { buildItem, normalizeHost } from "./items.js";
import { guard, holds, needlesOf, Secret } from "./secret.js";

/*
 * Secure forms: how a secret gets from the user's keyboard into the vault without passing anything that could keep,
 * speak or forward it.
 *
 * openForm() makes a ticket — 32 random bytes — and tells every workspace window to draw the form (a descriptor: its
 * title, its fields, never a value). The window draws it in its own trusted page, over the board, and posts what was
 * typed straight to POST /api/vault/forms/<ticket>. That request lands in submitForm() below: the values are
 * validated and sealed into the vault (or kept for one use, or they unlock it), and the ticket is gone. A ticket also
 * ends when it is cancelled, when its card is removed from the board, or when it lapses (ten minutes).
 *
 * Tickets and typed values live in this module's memory only: not in the workspace snapshot, not in workspace.json,
 * not in any event. What the rest of the engine learns is the outcome — "submitted" and the id of the saved item.
 */

/** Lifetimes (the tests shorten them). */
export const formTiming = { defaultTtlMs: 10 * 60_000, maxTtlMs: 30 * 60_000, oneTimeMs: 2 * 60_000 };

const MAX_OPEN = 8;
const MAX_FIELDS = 12;
const MAX_VALUE = 4000;
const PURPOSES: readonly FormRequest["purpose"][] = ["save-login", "save-card", "save-identity", "save-secret", "one-time", "confirm", "unlock"];
const FIELD_TYPES: readonly FormField["type"][] = ["text", "password", "email", "tel", "card-number", "expiry", "cvc", "otp-secret", "checkbox"];
/** Field types that may arrive with a value already in them (a site's name) — never the secret ones. */
const PLAIN_TYPES: readonly FormField["type"][] = ["text", "email", "tel"];
const KIND_OF: Partial<Record<FormRequest["purpose"], VaultKind>> = { "save-login": "login", "save-card": "card", "save-identity": "identity", "save-secret": "secret" };

interface Ticket {
  form: FormRequest;
  done: Promise<FormOutcome>;
  settle: (o: FormOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** A submission is being processed. */
  busy: boolean;
  /** Not shown yet: the vault has to be unlocked first. */
  held: boolean;
}

const tickets = new Map<string, Ticket>();
const oneTime = new Map<string, { values: Record<string, Secret>; timer: ReturnType<typeof setTimeout> }>();
let announce: ((line: string) => void) | null = null;

/** How the vault says something when no tool is waiting on it ("The vault is unlocked."); tools/vault.ts sets it. */
export function setVaultAnnouncer(fn: (line: string) => void): void {
  announce = fn;
}

// A locked vault keeps nothing typed in memory either.
onVaultLock(() => {
  for (const id of [...oneTime.keys()]) dropOneTime(id);
});

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const line = (v: unknown, max: number): string =>
  (typeof v === "string" ? v : "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// ─── The fields each kind of item is typed into ───────────────────────────────

/** The form for an item of `kind` (the secure form and Settings → Vault draw the same one). `host`: the login is for that site only. */
export function itemFields(kind: VaultKind, host?: string): FormField[] {
  switch (kind) {
    case "login":
      return [
        { name: "label", label: "Name", type: "text", placeholder: "Netflix" },
        ...(host ? [] : [{ name: "hosts", label: "Website", type: "text", required: true, placeholder: "www.netflix.com" } satisfies FormField]),
        { name: "username", label: "User name or email", type: "text", autocomplete: "username" },
        { name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" },
        { name: "totpSecret", label: "Authenticator key (optional)", type: "otp-secret", placeholder: "Only if the site asks for codes from an app", autocomplete: "one-time-code" },
      ];
    case "card":
      return [
        { name: "number", label: "Card number", type: "card-number", required: true, placeholder: "1234 5678 9012 3456", autocomplete: "cc-number" },
        { name: "expiry", label: "Expires", type: "expiry", required: true, placeholder: "MM/YY", autocomplete: "cc-exp" },
        { name: "holder", label: "Name on the card", type: "text", autocomplete: "cc-name" },
        { name: "postalCode", label: "Billing postal code (optional)", type: "text", autocomplete: "postal-code" },
        { name: "keepCvc", label: "Keep the security code", type: "checkbox" },
        { name: "cvc", label: "Security code", type: "cvc", placeholder: "3 or 4 digits", autocomplete: "cc-csc" },
        { name: "label", label: "Name for this card (optional)", type: "text", placeholder: "Visa ending 4242" },
      ];
    case "identity":
      return [
        { name: "label", label: "Name for these details", type: "text", placeholder: "My details" },
        { name: "fullName", label: "Full name", type: "text", autocomplete: "name" },
        { name: "email", label: "Email", type: "email", autocomplete: "email" },
        { name: "phone", label: "Phone", type: "tel", autocomplete: "tel" },
        { name: "address1", label: "Address", type: "text", autocomplete: "address-line1" },
        { name: "address2", label: "Address, second line", type: "text", autocomplete: "address-line2" },
        { name: "city", label: "City", type: "text", autocomplete: "address-level2" },
        { name: "region", label: "State or region", type: "text", autocomplete: "address-level1" },
        { name: "postalCode", label: "Postal code", type: "text", autocomplete: "postal-code" },
        { name: "country", label: "Country", type: "text", autocomplete: "country-name" },
        { name: "birthDate", label: "Date of birth (optional)", type: "text", placeholder: "YYYY-MM-DD", autocomplete: "bday" },
      ];
    case "secret":
      return [
        { name: "label", label: "Name", type: "text", required: true, placeholder: "Wi-Fi password" },
        { name: "value", label: "Secret", type: "password", required: true },
      ];
  }
}

const UNLOCK_FIELDS: FormField[] = [{ name: "passphrase", label: "Vault passphrase", type: "password", required: true, autocomplete: "current-password" }];

/** A field as the caller described it, kept to what a window may draw; null when it isn't one. */
function cleanField(raw: unknown): FormField | null {
  if (!isObj(raw)) return null;
  const name = typeof raw.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(raw.name) ? raw.name : "";
  const type = FIELD_TYPES.includes(raw.type as FormField["type"]) ? (raw.type as FormField["type"]) : null;
  const label = line(raw.label, 80);
  if (!name || !type || !label) return null;
  const placeholder = line(raw.placeholder, 80);
  const autocomplete = typeof raw.autocomplete === "string" && /^[a-z0-9-]{1,40}$/.test(raw.autocomplete) ? raw.autocomplete : "";
  // A value may only be put into a field that isn't secret.
  const value = PLAIN_TYPES.includes(type) ? line(raw.value, 200) : type === "checkbox" && raw.value === "true" ? "true" : "";
  return {
    name,
    label,
    type,
    ...(raw.required === true ? { required: true } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(autocomplete ? { autocomplete } : {}),
    ...(value ? { value } : {}),
  };
}

/**
 * The fields a form of this purpose shows. Saving an item and unlocking always use the vault's own fields (so what is
 * typed lands where the vault expects it, whoever opened the form) — a caller's same-named plain fields only supply
 * what is already filled in (a site's name). One-time forms show the caller's fields; a confirmation has none.
 */
function fieldsFor(purpose: FormRequest["purpose"], given: unknown, host?: string): FormField[] {
  const asked = (Array.isArray(given) ? given : []).map(cleanField).filter((f): f is FormField => f !== null);
  if (purpose === "confirm") return [];
  if (purpose === "unlock") return UNLOCK_FIELDS.map((f) => ({ ...f }));
  const kind = KIND_OF[purpose];
  if (!kind) {
    const seen = new Set<string>();
    const out = asked.filter((f) => !seen.has(f.name) && Boolean(seen.add(f.name))).slice(0, MAX_FIELDS);
    if (!out.length) throw new VaultError("invalid", "A one-time form needs at least one field.");
    return out;
  }
  return itemFields(kind, host).map((f) => {
    const prefill = PLAIN_TYPES.includes(f.type) ? asked.find((a) => a.name === f.name && PLAIN_TYPES.includes(a.type))?.value : undefined;
    return prefill ? { ...f, value: prefill } : f;
  });
}

const DEFAULT_TITLE: Record<FormRequest["purpose"], string> = {
  "save-login": "Website login",
  "save-card": "Payment card",
  "save-identity": "Your details",
  "save-secret": "A secret",
  "one-time": "One-time entry",
  confirm: "Approve this",
  unlock: "Unlock the vault",
};
const DEFAULT_SUBMIT: Record<FormRequest["purpose"], string> = {
  "save-login": "Save",
  "save-card": "Save",
  "save-identity": "Save",
  "save-secret": "Save",
  "one-time": "Use once",
  confirm: "Approve",
  unlock: "Unlock",
};

const cardTitle = (title: string): string => (/^secure form\b/i.test(title) ? title : `Secure form: ${title}`).slice(0, 80);

// ─── Opening and ending ───────────────────────────────────────────────────────

/** Show a held or new form: its placeholder card on the board (when the board is up), and the event to every window. */
function reveal(t: Ticket): void {
  t.held = false;
  try {
    if (!boardBlocked() && (boardActive() || workspace.mode === "empty")) t.form.card = addFormCard(cardTitle(t.form.title)).n;
  } catch {
    /* no card: the form itself is what matters */
  }
  workspace.openForm(structuredClone(t.form));
}

function finish(id: string, outcome: FormOutcome): boolean {
  const t = tickets.get(id);
  if (!t) return false;
  tickets.delete(id);
  clearTimeout(t.timer);
  if (t.form.card !== undefined) {
    try {
      removeFormCard(t.form.card);
    } catch {
      /* the board moved on */
    }
  }
  if (!t.held) workspace.closeForm(id, outcome.status);
  t.settle(outcome);
  return true;
}

const unlockTicket = (): Ticket | undefined => [...tickets.values()].find((t) => t.form.purpose === "unlock");
const needsPassphrase = (): boolean => {
  const s = vault().status();
  return s.state === "locked" && s.lock === "passphrase";
};

/** The facade's openForm (see index.ts). */
export function openForm(req: Omit<FormRequest, "id" | "expiresAt">, opts: { ttlMs?: number } = {}): { form: FormRequest; done: Promise<FormOutcome> } {
  const refusal = vault().refusal();
  if (refusal) throw new VaultError("blocked", refusal);
  if (!isObj(req) || !PURPOSES.includes(req.purpose)) throw new VaultError("invalid", "That isn't a form the vault knows.");
  const purpose = req.purpose;
  const host = req.host ? normalizeHost(String(req.host), "host") : undefined;
  const ttl = Math.max(1, Math.min(formTiming.maxTtlMs, Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : formTiming.defaultTtlMs));
  const form: FormRequest = {
    id: randomId(32),
    purpose,
    title: line(req.title, 100) || DEFAULT_TITLE[purpose],
    detail: line(req.detail, 400) || (purpose === "unlock" ? UNLOCK_DETAIL : ""),
    ...(host ? { host } : {}),
    fields: fieldsFor(purpose, req.fields, host),
    submitLabel: line(req.submitLabel, 40) || DEFAULT_SUBMIT[purpose],
    expiresAt: Date.now() + ttl,
  };

  if (purpose === "unlock") {
    // One unlock form at a time; and none at all when there is nothing to type.
    const open = unlockTicket();
    if (open) return { form: structuredClone(open.form), done: open.done };
    if (!needsPassphrase()) {
      // Locked by the device key alone: it unlocks by itself. Anything else is not locked.
      const done: Promise<FormOutcome> =
        vault().status().state === "locked"
          ? vault()
              .unlock()
              .then(
                (): FormOutcome => ({ status: "submitted" }),
                (): FormOutcome => ({ status: "cancelled" }),
              )
          : Promise.resolve<FormOutcome>({ status: "submitted" });
      return { form, done };
    }
  } else if (KIND_OF[purpose] && vault().status().blocked) {
    // (No key store and no passphrase yet: nothing could be saved.)
    throw new VaultError("blocked", vault().status().blocked!);
  }
  if (tickets.size >= MAX_OPEN) throw new VaultError("busy", "Too many secure forms are open. Finish or cancel one first.");

  let settle!: (o: FormOutcome) => void;
  const done = new Promise<FormOutcome>((resolve) => (settle = resolve));
  const timer = setTimeout(() => finish(form.id, { status: "expired" }), ttl);
  timer.unref?.();
  const ticket: Ticket = { form, done, settle, timer, busy: false, held: false };
  tickets.set(form.id, ticket);

  if (KIND_OF[purpose] && needsPassphrase()) {
    // Saving needs the vault's key: the passphrase form comes first, and this one shows once it is unlocked.
    ticket.held = true;
    let unlock: Ticket | undefined;
    try {
      unlock = unlockTicket() ?? tickets.get(openForm({ purpose: "unlock", title: "", detail: "", fields: [], submitLabel: "" }).form.id);
    } catch (err) {
      finish(form.id, { status: "cancelled" }); // the passphrase form couldn't be put up: this one has nothing to wait for
      throw err;
    }
    void (unlock?.done ?? Promise.resolve<FormOutcome>({ status: "cancelled" })).then((o) => {
      if (!tickets.has(form.id)) return;
      if (o.status === "submitted") reveal(ticket);
      else finish(form.id, { status: o.status === "expired" ? "expired" : "cancelled" });
    });
  } else {
    reveal(ticket);
  }
  // A copy: the ticket's own descriptor can't be changed from outside.
  return { form: structuredClone(form), done };
}

const UNLOCK_DETAIL = "Type the vault's passphrase to unlock it. Trinity can't see or hear what you type here.";

/**
 * The vault was needed while it is locked with a passphrase: put the passphrase form up (once), and say so when it has
 * been unlocked. Whatever needed the vault has already failed with "locked"; the user asks again afterwards.
 */
export function requestUnlock(): void {
  try {
    if (!needsPassphrase() || unlockTicket()) return;
    const { done } = openForm({ purpose: "unlock", title: "", detail: "", fields: [], submitLabel: "" });
    void done.then((o) => {
      if (o.status === "submitted") announce?.("The vault is unlocked. Ask me again.");
    });
  } catch {
    /* the vault may not be used at all right now */
  }
}

/** The forms on show right now (descriptors only), for a window that has just connected. */
export function openForms(): FormRequest[] {
  return [...tickets.values()].filter((t) => !t.held).map((t) => structuredClone(t.form));
}

export function cancelForm(id: string): boolean {
  return finish(id, { status: "cancelled" });
}

/** The card numbers that stand for open forms. */
export function liveFormCards(): Set<number> {
  const out = new Set<number>();
  for (const t of tickets.values()) if (t.form.card !== undefined) out.add(t.form.card);
  return out;
}

/** Card `n` was taken off the board: its form is cancelled. False when no open form stands behind that card. */
export function cancelFormCard(n: number): boolean {
  for (const t of tickets.values()) if (t.form.card === n) return finish(t.form.id, { status: "cancelled" });
  return false;
}

/** The board is being cleared: every form that has a card on it is cancelled. Returns how many. */
export function cancelCardForms(): number {
  let count = 0;
  for (const t of [...tickets.values()]) if (t.form.card !== undefined && finish(t.form.id, { status: "cancelled" })) count++;
  return count;
}

/**
 * Bring the board's form placeholders back in line with the forms that are open: after a restart (none are), and after
 * an undo (an old board may hold a placeholder whose form is long over, or lack one for a form still open).
 */
export function reconcileFormCards(): void {
  try {
    const kept = sweepFormCards(liveFormCards());
    for (const t of tickets.values()) if (t.form.card !== undefined && !kept.has(t.form.card)) delete t.form.card;
  } catch {
    /* no board to tidy */
  }
}

// ─── Submitting ───────────────────────────────────────────────────────────────

const NOT_THIS_FORM = "That isn't what this form asks for.";

/** What was posted, checked against the form's own fields: exactly its names, strings (a boolean for a checkbox), bounded. */
export function readValues(fields: readonly FormField[], raw: unknown): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new VaultError("invalid", NOT_THIS_FORM);
  const names = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(raw)) if (!names.has(k)) throw new VaultError("invalid", NOT_THIS_FORM);
  for (const f of fields) {
    const v = Object.hasOwn(raw, f.name) ? raw[f.name] : undefined;
    if (f.type === "checkbox") {
      if (v !== undefined && typeof v !== "boolean") throw new VaultError("invalid", NOT_THIS_FORM, { field: f.name });
      out[f.name] = v === true;
      continue;
    }
    if (v !== undefined && typeof v !== "string") throw new VaultError("invalid", NOT_THIS_FORM, { field: f.name });
    const s = v ?? "";
    if (s.length > MAX_VALUE) throw new VaultError("invalid", "That is too long to keep.", { field: f.name });
    if (f.required && !s.trim()) throw new VaultError("invalid", "Fill in every field that isn't marked optional.", { field: f.name });
    out[f.name] = s;
  }
  return out;
}

function dropOneTime(id: string): void {
  const kept = oneTime.get(id);
  if (!kept) return;
  clearTimeout(kept.timer);
  oneTime.delete(id);
}

/**
 * POST /api/vault/forms/<id>: what the user typed into the form. Saves the item, keeps one-time values for one use,
 * unlocks the vault, or records an approval — and ends the form. A value that doesn't pass (a card number with a wrong
 * digit, the wrong passphrase) throws and leaves the form open to try again.
 */
export async function submitForm(id: string, raw: unknown): Promise<"submitted" | "approved"> {
  const gone = new VaultError("gone", "That form is no longer open.");
  const t = tickets.get(id);
  if (!t || t.held) throw gone;
  const refusal = vault().refusal();
  if (refusal) throw new VaultError("blocked", refusal);
  if (Date.now() > t.form.expiresAt) {
    finish(id, { status: "expired" });
    throw gone;
  }
  if (t.busy) throw new VaultError("busy", "That form is already being sent.");
  t.busy = true;
  try {
    const values = readValues(t.form.fields, raw);
    const purpose = t.form.purpose;
    if (purpose === "confirm") {
      finish(id, { status: "approved" });
      return "approved";
    }
    if (purpose === "one-time") {
      const kept: Record<string, Secret> = {};
      for (const [k, v] of Object.entries(values)) kept[k] = new Secret(typeof v === "string" ? v : v ? "true" : "false");
      const timer = setTimeout(() => dropOneTime(id), formTiming.oneTimeMs);
      timer.unref?.();
      oneTime.set(id, { values: kept, timer });
      finish(id, { status: "submitted" });
      return "submitted";
    }
    if (purpose === "unlock") {
      await vault().unlock(new Secret(String(values.passphrase ?? "")));
      finish(id, { status: "submitted" });
      return "submitted";
    }
    const item = buildItem(KIND_OF[purpose]!, values, t.form.host);
    let meta;
    try {
      meta = await vault().add(item);
    } catch (err) {
      if (err instanceof VaultError && err.code === "locked") requestUnlock();
      throw err;
    }
    finish(id, { status: "submitted", itemId: meta.id });
    return "submitted";
  } finally {
    t.busy = false;
  }
}

/** The facade's useOneTime (see index.ts): the values of a submitted one-time form, once, within two minutes. */
export async function useOneTime<T>(formId: string, fn: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
  const kept = oneTime.get(formId);
  dropOneTime(formId); // taken out before it is used: there is no second time
  if (!kept) throw new VaultError("gone", "That one-time entry is gone: it was used already, or two minutes went by.");
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(kept.values)) plain[k] = v.expose();
  const needles = needlesOf(Object.values(plain));
  const handed = guard(plain);
  const takeBack = (): void => {
    handed.revoke();
    for (const k of Object.keys(plain)) plain[k] = "";
    for (const k of Object.keys(kept.values)) delete kept.values[k];
  };
  let result: T;
  try {
    result = await fn(handed.view);
  } catch (err) {
    takeBack();
    if (holds(err, needles)) throw new VaultError("leak", "A one-time value was about to leave in an error message. Stopped.");
    throw err;
  }
  takeBack();
  if (holds(result, needles)) throw new VaultError("leak", "A one-time value was about to leave in a result. Stopped.");
  return result;
}

/** For the tests: how many one-time entries are still held. */
export function heldOneTimeCount(): number {
  return oneTime.size;
}
