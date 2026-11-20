import { domainToASCII } from "node:url";
import { VaultError } from "./errors.js";
import type { CardSecret, GenericSecret, IdentitySecret, LoginSecret, VaultKind } from "./index.js";
import { normalizeTotpSecret } from "./totp.js";

/*
 * From what was typed (a secure form, or the form on Settings → Vault) to an item the store can seal: hosts, the
 * masked user-name hint, card checks (the Luhn digit, the brand from the prefix, the expiry) and the plain metadata
 * that may be shown and spoken. Every message here names a field, never what was typed into it.
 */

/** What was typed, by field name. */
export type Typed = Readonly<Record<string, string | boolean>>;

/** A validated item, ready to seal: the plain metadata on one side, the secret on the other. */
export type NewItem =
  | { kind: "login"; label: string; hosts: string[]; usernameHint?: string; hasTotp: boolean; secret: LoginSecret }
  | { kind: "card"; label: string; brand: string; last4: string; expMonth: number; expYear: number; hasCvc: boolean; secret: CardSecret }
  | { kind: "identity"; label: string; secret: IdentitySecret }
  | { kind: "secret"; label: string; secret: GenericSecret };

const invalid = (field: string, message: string): VaultError => new VaultError("invalid", message, { field });

const text = (v: unknown): string => (typeof v === "string" ? v : "");
/** One line of ordinary text: control characters out, spaces collapsed, cut to `max`. */
const line = (v: unknown, max: number): string =>
  text(v)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// ─── Hosts ────────────────────────────────────────────────────────────────────

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BAD_HOST = "Type the site's address as it appears in the browser, like www.example.com.";

/**
 * One exact, lower-case host name from what was typed or read: "https://WWW.Netflix.com/login" and
 * "www.netflix.com:443" both give "www.netflix.com". No wildcards and no guessing: a login is filled on exactly the
 * hosts it was saved for.
 */
export function normalizeHost(input: string, field = "hosts"): string {
  let raw = input.trim().toLowerCase();
  if (!raw || raw.length > 300) throw invalid(field, BAD_HOST);
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // a scheme
  raw = raw.replace(/^[^/@]*@/, ""); // user info
  raw = raw.split(/[/?#]/)[0] ?? "";
  raw = raw.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  const ascii = raw && /^[^\s:\\[\]]+$/.test(raw) ? domainToASCII(raw) : "";
  if (!ascii || !HOST_RE.test(ascii)) throw invalid(field, BAD_HOST);
  return ascii;
}

/** "www.netflix.com, netflix.com" → the hosts typed (at most eight, each exact). */
export function parseHosts(input: string, field = "hosts"): string[] {
  const out: string[] = [];
  for (const part of input.split(/[\s,;]+/)) {
    if (!part) continue;
    const host = normalizeHost(part, field);
    if (!out.includes(host)) out.push(host);
  }
  if (!out.length) throw invalid(field, BAD_HOST);
  if (out.length > MAX_HOSTS) throw invalid(field, "That's too many sites for one login: eight at most.");
  return out;
}

export const MAX_HOSTS = 8;

const TWO_PART_SUFFIX = /\.(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;

/** "www.netflix.com" → "Netflix": a first guess at a name for a login, which the user can change in the form. */
export function labelFromHost(host: string): string {
  const parts = host.split(".");
  const keep = TWO_PART_SUFFIX.test(host) ? 3 : 2;
  const name = parts.length >= keep ? parts[parts.length - keep]! : parts[0]!;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Endings under which a site registers a third name ("bbc" in bbc.co.uk). A short, fixed list on purpose: an ending
 * that isn't on it is read as a site's own name, which only ever errs towards asking the user for the address.
 */
const TWO_PART_ENDINGS = new Set(
  (
    "co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk com.au net.au org.au edu.au gov.au id.au co.nz net.nz org.nz govt.nz ac.nz " +
    "co.jp ne.jp or.jp ac.jp go.jp com.br net.br org.br gov.br com.mx co.in net.in org.in ac.in gov.in co.za org.za gov.za ac.za " +
    "com.cn net.cn org.cn gov.cn edu.cn com.hk com.tw com.sg com.my co.kr or.kr go.kr co.il com.tr com.ar com.co com.pl com.ua " +
    "co.id co.th com.vn com.ph com.eg com.sa com.ng co.ke"
  ).split(" "),
);

/**
 * The name a site is registered under, without its ending: "netflix" for www.netflix.com, "bbc" for www.bbc.co.uk —
 * and "evil" for netflix.com.evil.io. Null for an address that isn't a name (an IP address).
 */
export function siteNameOf(host: string): string | null {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2 || parts.every((p) => /^\d+$/.test(p))) return null;
  const take = parts.length >= 3 && TWO_PART_ENDINGS.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts[parts.length - take] ?? null;
}

/** The user name, masked: its first character, "…", and the "@domain" when it is an email ("r…@gmail.com"). */
export function usernameHint(username: string): string | undefined {
  const u = username.trim();
  const first = [...u][0];
  if (!first) return undefined;
  const at = u.lastIndexOf("@");
  const domain = at > 0 && at < u.length - 1 ? u.slice(at).toLowerCase().slice(0, 80) : "";
  return `${first}…${domain}`;
}

// ─── Cards ────────────────────────────────────────────────────────────────────

/** The Luhn check every card number passes. */
export function luhnOk(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The card's brand from its first digits ("Visa", "Mastercard", …; "Card" when the prefix is none we know). */
export function cardBrand(digits: string): string {
  const n = (len: number): number => Number(digits.slice(0, len));
  if (/^4/.test(digits)) return "Visa";
  if ((n(2) >= 51 && n(2) <= 55) || (n(4) >= 2221 && n(4) <= 2720)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (n(4) >= 3528 && n(4) <= 3589) return "JCB";
  if ((n(3) >= 300 && n(3) <= 305) || n(4) === 3095 || /^3[689]/.test(digits)) return "Diners Club";
  if (/^6011/.test(digits) || /^65/.test(digits) || (n(3) >= 644 && n(3) <= 649)) return "Discover";
  if (/^62/.test(digits)) return "UnionPay";
  if (/^(?:50|5[6-9]|6304|67)/.test(digits)) return "Maestro";
  return "Card";
}

/** "08/27", "8/2027", "0827" → the month and the four-digit year; refused when it isn't a date or has passed. */
export function parseExpiry(input: string, now = new Date()): { month: number; year: number } {
  const bad = invalid("expiry", "Type the card's expiry as month and year, like 08/27.");
  const t = input.trim();
  const m = /^(\d{1,2})\s*[/\-. ]\s*(\d{2}|\d{4})$/.exec(t) ?? /^(\d{2})(\d{2}|\d{4})$/.exec(t);
  if (!m) throw bad;
  const month = Number(m[1]);
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2099) throw bad;
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  if (year < thisYear || (year === thisYear && month < thisMonth)) throw invalid("expiry", "That card has expired.");
  if (year > thisYear + 30) throw bad;
  return { month, year };
}

// ─── Building items ───────────────────────────────────────────────────────────

const LABEL_MAX = 80;

/**
 * The name of an item is shown and spoken, so it must not be the secret itself (a password pasted into the wrong
 * box). Checked against each secret value of four characters or more, ignoring spaces and dashes — except a value
 * that is already part of the site's own address (a password "netflix" for www.netflix.com: the name "Netflix" is
 * no slip there, and gives nothing away).
 */
function nameIsNotSecret(label: string, secrets: (string | undefined)[], hosts: string[] = []): void {
  const flat = (s: string): string => s.replace(/[\s-]+/g, "").toLowerCase();
  const name = flat(label);
  for (const s of secrets) {
    if (!s) continue;
    const value = flat(s);
    if (value.length < 4 || !name.includes(value) || hosts.some((h) => flat(h).includes(value))) continue;
    throw invalid("label", "The name is shown and read out, so it can't hold the secret itself. Give it a plain name.");
  }
}

function buildLogin(v: Typed, host?: string): NewItem {
  const hosts = host ? [normalizeHost(host)] : parseHosts(text(v.hosts));
  const username = text(v.username).trim().slice(0, 320);
  const password = text(v.password);
  if (!password) throw invalid("password", "Type the password.");
  if (password.length > 1000) throw invalid("password", "That password is too long to keep.");
  const typedSeed = text(v.totpSecret).trim();
  const totpSecret = typedSeed ? normalizeTotpSecret(typedSeed) : undefined;
  const label = line(v.label, LABEL_MAX) || labelFromHost(hosts[0]!);
  nameIsNotSecret(label, [password, totpSecret], hosts);
  const hint = usernameHint(username);
  return {
    kind: "login",
    label,
    hosts,
    ...(hint ? { usernameHint: hint } : {}),
    hasTotp: Boolean(totpSecret),
    secret: { username, password, ...(totpSecret ? { totpSecret } : {}) },
  };
}

function buildCard(v: Typed): NewItem {
  const number = text(v.number).replace(/[\s-]+/g, "");
  if (!luhnOk(number)) throw invalid("number", "That card number doesn't look right. Check the digits.");
  const { month, year } = parseExpiry(text(v.expiry));
  const keep = v.keepCvc === true;
  const cvc = text(v.cvc).trim();
  if (keep && !/^\d{3,4}$/.test(cvc)) throw invalid("cvc", "The security code is the three or four digits on the card.");
  const brand = cardBrand(number);
  const last4 = number.slice(-4);
  const holder = line(v.holder, 120);
  const postalCode = line(v.postalCode, 20);
  const label = line(v.label, LABEL_MAX) || `${brand} ending ${last4}`;
  nameIsNotSecret(label, [number]);
  return {
    kind: "card",
    label,
    brand,
    last4,
    expMonth: month,
    expYear: year,
    hasCvc: keep,
    // The security code is kept only when the user ticked "Keep the security code"; otherwise it is asked for each time.
    secret: { number, holder, expMonth: month, expYear: year, ...(keep ? { cvc } : {}), ...(postalCode ? { postalCode } : {}) },
  };
}

const IDENTITY_FIELDS: readonly (keyof IdentitySecret)[] = ["fullName", "email", "phone", "address1", "address2", "city", "region", "postalCode", "country", "birthDate"];

function buildIdentity(v: Typed): NewItem {
  const secret: IdentitySecret = {};
  for (const key of IDENTITY_FIELDS) {
    const value = line(v[key], 200);
    if (value) secret[key] = value;
  }
  if (!Object.keys(secret).length) throw invalid("fullName", "Fill in at least one of these.");
  if (secret.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(secret.email)) throw invalid("email", "That email address doesn't look right.");
  return { kind: "identity", label: line(v.label, LABEL_MAX) || "My details", secret };
}

function buildSecret(v: Typed): NewItem {
  const label = line(v.label, LABEL_MAX);
  if (!label) throw invalid("label", "Give it a name.");
  const value = text(v.value);
  if (!value) throw invalid("value", "Type the secret.");
  if (value.length > 4000) throw invalid("value", "That is too long to keep.");
  nameIsNotSecret(label, [value]);
  return { kind: "secret", label, secret: { value } };
}

/** Validate what was typed for an item of `kind`. `host` fixes the site a login is for (the form was opened for it). */
export function buildItem(kind: VaultKind, typed: Typed, host?: string): NewItem {
  switch (kind) {
    case "login":
      return buildLogin(typed, host);
    case "card":
      return buildCard(typed);
    case "identity":
      return buildIdentity(typed);
    case "secret":
      return buildSecret(typed);
  }
}
