import { registerContextProvider } from "../agent/context.js";
import { askYesNo } from "../agent/pending.js";
import { tell } from "../agent/tell.js";
import { browserCall, browserConnected, browserSecretCall, currentBrowserTab, FILL_KINDS, type BrowserTab, type FillCode, type FillKind, type FillResult } from "../services/browser-bridge.js";
import { guardOf, parseAmount, saidSo } from "../services/browser-words.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { bg } from "../util/bg.js";
import { VaultError, type VaultErrorCode } from "../vault/errors.js";
import * as vaultFacade from "../vault/index.js";
import type { CardSecret, FormOutcome, FormRequest, IdentitySecret, LoginSecret, VaultItemMeta, VaultKind, VaultSecret, VaultStatus } from "../vault/index.js";
import { spendingLimit } from "../vault/settings.js";
import { workspace } from "../workspace/bus.js";
import { asker, NOT_CONNECTED } from "./browser.js";
import { getTool, registerTool } from "./registry.js";

/*
 * Signing in and filling forms in the user's Chrome from the vault: browser_sign_in, browser_fill_card,
 * browser_fill_details.
 *
 * What these tools hold of a secret: nothing. They know an item by its id and its label; the secret itself exists only
 * inside the vault's useSecret callback, for the moment it takes to hand it to browserSecretCall, which seals it for
 * one tab and one origin (services/browser-bridge.ts). What comes back — and all that is ever spoken, returned or
 * logged — is which KINDS of field were filled, on which host: "Filled your Netflix login on www.netflix.com."
 *
 * The checks, in order: only the user's own words start any of this (never a planner's step or a scheduled run); the
 * page is an https page that isn't Trinity's own; for a login, the page's exact host is one the login was saved for —
 * checked here before anything is sent, and again by the extension against the tab itself; a card is filled only after
 * a yes that named the card and the site — an Approve button in the secure form when the page's total is above the
 * spending limit or can't be read — and it is never followed by a press of Pay.
 */

// ─── The vault these tools use (the real one; a stand-in with the same functions in tests) ───────────────────────────

export interface FillVault {
  vaultStatus(): VaultStatus;
  listItems(kind?: VaultKind): VaultItemMeta[];
  findLogins(host: string): VaultItemMeta[];
  getMeta(id: string): VaultItemMeta | null;
  useSecret<T>(id: string, purpose: string, fn: (secret: Readonly<VaultSecret>, meta: VaultItemMeta) => Promise<T>): Promise<T>;
  openForm(req: Omit<FormRequest, "id" | "expiresAt">, opts?: { ttlMs?: number }): { form: FormRequest; done: Promise<FormOutcome> };
  openForms(): FormRequest[];
  useOneTime<T>(formId: string, fn: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  /**
   * Above this page total (in the page's own currency) a card fill needs the Approve button, not a spoken yes.
   * 0 — also what comes back when the setting can't be read — means: always the button.
   */
  spendingLimit(): number;
}

const realVault: FillVault = {
  vaultStatus: vaultFacade.vaultStatus,
  listItems: vaultFacade.listItems,
  findLogins: vaultFacade.findLogins,
  getMeta: vaultFacade.getMeta,
  useSecret: vaultFacade.useSecret,
  openForm: vaultFacade.openForm,
  openForms: vaultFacade.openForms,
  useOneTime: vaultFacade.useOneTime,
  spendingLimit,
};
let v: FillVault = realVault;

/** For tests: use this vault instead of the engine's (null: the engine's again). */
export function useFillVault(stand: FillVault | null): void {
  v = stand ?? realVault;
}

// ─── Small things ─────────────────────────────────────────────────────────────

const said = (ok: boolean, line: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok, say: line, speak: line, ...extra });
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const clean = (s: string, max = 60) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** "Netflix" from "www.netflix.com": a name to put in the save form, which the user can change. */
function labelFromHost(host: string): string {
  const parts = host.split(".").filter((p) => p && p !== "www");
  const name = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? host);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** An item as it is spoken — its label, never anything in it: "your Netflix login", "your Visa ending 4242". */
function spoken(m: Pick<VaultItemMeta, "kind" | "label">): string {
  const label = clean(m.label);
  if (m.kind === "login") return /\b(?:login|log-in|account|password)\b/i.test(label) ? `your ${label}` : `your ${label} login`;
  if (m.kind === "identity") return /^my details$/i.test(label) ? "your details" : `your details, ${label}`;
  return `your ${label}`;
}

/** What a kind of field is called aloud. Several kinds share a name, so a list of them reads short. */
const KIND_WORDS: Record<FillKind, string> = {
  username: "the user name",
  password: "the password",
  otp: "the one-time code",
  email: "your email",
  name: "your name",
  "given-name": "your name",
  "family-name": "your name",
  tel: "your phone number",
  "street-address": "your address",
  "address-line1": "your address",
  "address-line2": "your address",
  "address-level2": "your address",
  "address-level1": "your address",
  "postal-code": "your address",
  country: "your address",
  bday: "your date of birth",
  organization: "your company",
  "cc-number": "the card number",
  "cc-exp": "the expiry date",
  "cc-exp-month": "the expiry date",
  "cc-exp-year": "the expiry date",
  "cc-csc": "the security code",
  "cc-name": "the name on the card",
};
/** In the order a person would say them: who, how to reach them, where they live. */
const SAY_ORDER: readonly FillKind[] = ["username", "password", "otp", "cc-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "name", "given-name", "family-name", "organization", "email", "tel", "street-address", "address-line1", "address-line2", "address-level2", "address-level1", "postal-code", "country", "bday"];
const kindsAloud = (kinds: readonly FillKind[]): string => list([...new Set([...kinds].sort((a, b) => SAY_ORDER.indexOf(a) - SAY_ORDER.indexOf(b)).map((k) => KIND_WORDS[k]))]);

const VAULT_BLOCKED = "I can't use the vault right now. Settings, under Vault, says why.";
const VAULT_LOCKED = "The vault is locked. Type your passphrase in the secure form on the workspace, then ask me again.";
/** What each kind of vault failure is called aloud: sentences written here, one per code. */
const VAULT_LINES: Record<VaultErrorCode, string> = {
  blocked: VAULT_BLOCKED,
  locked: VAULT_LOCKED,
  "wrong-passphrase": "That wasn't the vault's passphrase.",
  wait: "The vault is taking a pause after too many wrong passphrases. Try again in a little while.",
  "not-found": "That isn't in the vault any more.",
  invalid: "The vault couldn't take that as it was typed.",
  tampered: "The vault's file doesn't check out, so I left it alone. Settings, under Vault, has more.",
  damaged: "The vault's file can't be read, so I left it alone. Settings, under Vault, has more.",
  "no-key-store": "The vault has no key on this computer yet. Set a passphrase for it in Settings, under Vault.",
  gone: "That ran out before it was used. Ask me again.",
  busy: "Too many secure forms are open. Finish or cancel one, then ask me again.",
  full: "The vault is full.",
  leak: "Something was about to carry a secret out of the vault, so I stopped.",
  failed: "The vault couldn't do that.",
};

/** The code of a vault failure — never its message: what is said about it is written here (VAULT_LINES). */
function vaultCode(err: unknown): VaultErrorCode | null {
  const e = err as { name?: unknown; code?: unknown } | null;
  const code = err instanceof VaultError ? err.code : e && e.name === "VaultError" && typeof e.code === "string" ? e.code : null;
  return code !== null && Object.hasOwn(VAULT_LINES, code) ? (code as VaultErrorCode) : code !== null ? "failed" : null;
}

/** A failure as a line to say. Whatever the error's own words are, they are not repeated. */
function vaultLine(err: unknown): string {
  const code = vaultCode(err);
  return code ? VAULT_LINES[code] : "Something went wrong before anything was filled in.";
}

/**
 * The vault is locked with a passphrase: put its passphrase form up in the workspace (the same one the vault's own
 * tools use; there is only ever one), and say so once it has been unlocked — unless that form was already up, in which
 * case whoever put it there says it.
 */
function askToUnlock(ctx: ToolContext): void {
  try {
    if (v.openForms().some((f) => f.purpose === "unlock")) return;
    const { done } = v.openForm({ purpose: "unlock", title: "Unlock the vault", detail: "Type the vault's passphrase to unlock it. Trinity can't see or hear what you type here.", fields: [], submitLabel: "Unlock" });
    bg(
      "browser-fill",
      done.then((outcome) => {
        if (outcome.status === "submitted") tell(ctx, "The vault is unlocked. Ask me again.", "browser-fill");
      }),
    );
  } catch {
    /* the vault may not be used at all right now: the line that is spoken says what to do */
  }
}

/** A vault failure in the middle of a fill, as a result: its fixed line — and, when the vault locked itself, its passphrase form. */
function vaultFailed(ctx: ToolContext, err: unknown): ToolResult {
  if (vaultCode(err) === "locked") askToUnlock(ctx);
  return said(false, vaultLine(err));
}

function fillLine(code: FillCode, host: string): string {
  switch (code) {
    case "origin-mismatch":
      return "The page moved to another site before I could fill it in, so I stopped.";
    case "no-fields":
      return `I couldn't find the right fields on ${host}.`;
    case "gone":
      return "The page changed before I could fill it in. Ask me again once it has settled.";
    case "insecure":
      return `${host} isn't a secure page, so I won't fill anything in there.`;
    case "form-target":
      return "That form sends what is typed to another site, so I didn't fill it in.";
    case "expired":
      return "That took too long, so nothing was filled in. Ask me again.";
    case "scripted":
      return "I ran a script on this page earlier, so I won't put anything from the vault into it. Reload the page and ask me again.";
    case "not-connected":
      return NOT_CONNECTED;
    case "timeout":
      return "The browser didn't answer in time, so nothing was filled in.";
    default:
      return "I couldn't fill that in.";
  }
}

// ─── The page ─────────────────────────────────────────────────────────────────

interface Probe {
  documentId: string;
  /** The page's exact origin ("https://www.netflix.com") and its host. */
  origin: string;
  host: string;
  kinds: FillKind[];
  submitRef: number | null;
  submitName: string;
  /** The form that button belongs to sends what is typed to another site: it is never pressed. */
  formLeaves: boolean;
  frames: number;
  /** New-password boxes: a sign-up or a password change, not a sign-in. */
  signup: boolean;
}

const KIND_SET: ReadonlySet<string> = new Set(FILL_KINDS);

/** Which fillable fields the tab's top document shows — or the code for why it can't be asked. */
async function probe(tabId: number): Promise<Probe | { code: FillCode }> {
  let r: Record<string, unknown> | null;
  try {
    r = await browserCall<Record<string, unknown> | null>("page.fillProbe", { tabId }, 8_000);
  } catch {
    return { code: browserConnected() ? "failed" : "not-connected" };
  }
  if (!r || r.ok !== true) return { code: r && (r.code === "insecure" || r.code === "scripted") ? r.code : "gone" };
  let url: URL;
  try {
    url = new URL(String(r.origin));
  } catch {
    return { code: "gone" };
  }
  if (url.protocol !== "https:" || url.origin !== r.origin || typeof r.documentId !== "string" || !r.documentId) return { code: url.protocol === "https:" ? "gone" : "insecure" };
  return {
    documentId: r.documentId,
    origin: url.origin,
    host: url.hostname.toLowerCase(),
    kinds: (Array.isArray(r.kinds) ? r.kinds : []).filter((k): k is FillKind => typeof k === "string" && KIND_SET.has(k)),
    submitRef: typeof r.submitRef === "number" ? r.submitRef : null,
    submitName: typeof r.submitName === "string" ? clean(r.submitName, 80) : "",
    formLeaves: r.formLeaves !== false,
    frames: typeof r.frames === "number" && r.frames > 0 ? r.frames : 0,
    signup: r.signup === true,
  };
}

/** What every one of these tools needs before it starts: the user asking, the extension, the vault, an https page. */
function ready(ctx: ToolContext): { tab: BrowserTab; host: string } | ToolResult {
  if (asker(ctx) !== "user") return said(false, "Signing in and filling forms from the vault only happens when you ask me for it yourself.");
  if (!browserConnected()) return said(false, NOT_CONNECTED);
  let status: VaultStatus;
  try {
    status = v.vaultStatus();
  } catch (err) {
    return vaultFailed(ctx, err);
  }
  if (status.blocked) return said(false, VAULT_BLOCKED);
  // Locked with a passphrase (always after a restart, and after fifteen idle minutes): its form goes up, and it is said.
  // (Locked by the device key alone needs nothing: it unlocks by itself on first use.)
  if (status.state === "locked" && status.lock === "passphrase") {
    askToUnlock(ctx);
    return said(false, VAULT_LOCKED, { data: { vault: "locked" } });
  }
  const tab = currentBrowserTab();
  if (!tab) return said(false, "There's no web page open in Chrome to fill in.");
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return said(false, "The tab in front isn't a web page I can fill in.");
  }
  if (url.protocol !== "https:") return said(false, url.protocol === "http:" ? `${url.hostname} isn't a secure page, so I won't fill anything in there.` : "The tab in front isn't a web page I can fill in.");
  return { tab, host: url.hostname.toLowerCase() };
}

/** Words that mean "keep this", not "use this": the vault's own tool takes those. */
const SAVE_ASK = /\b(?:save|store|remember|keep|add)\b/i;
const USE_ASK = /\b(?:fill|use|pay|enter|put|type|sign|log)\b/i;
async function handOver(tool: string, words: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (!SAVE_ASK.test(words) || USE_ASK.test(words)) return null;
  const other = getTool(tool);
  return other ? other.run(args, ctx) : null;
}

/** The item the words name, among several: by its id (a choice Jev made), else by a word of its label — or null. */
function pick(items: VaultItemMeta[], chosen: unknown, words: string): VaultItemMeta | null {
  if (items.length === 1) return items[0]!;
  const byId = typeof chosen === "string" ? items.find((m) => m.id === chosen) : undefined;
  if (byId) return byId;
  const w = words.toLowerCase();
  const hits = items.filter((m) =>
    [m.label, m.brand ?? "", m.last4 ?? ""]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((tok) => tok.length >= 3 && !/^(?:ending|card|login|account|details|the|and)$/.test(tok) && new RegExp(String.raw`\b${tok}\b`).test(w)),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Work that may outlast a tool's time (page loads between the steps of a sign-in): its line when it comes in time;
 * otherwise "it's under way" now, and the line is told when it lands.
 */
async function patient(ctx: ToolContext, started: string, work: Promise<ToolResult>): Promise<ToolResult> {
  const running = work.catch((err: unknown): ToolResult => vaultFailed(ctx, err));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([running, new Promise<null>((r) => (timer = setTimeout(() => r(null), 9_000)))]);
  clearTimeout(timer);
  if (first) return first;
  bg(
    "browser-fill",
    running.then((r) => tell(ctx, r.speak ?? r.say ?? "", "browser-fill")),
  );
  return said(true, started, { inProgress: "started" });
}

// ─── browser_sign_in ──────────────────────────────────────────────────────────

const LOGIN_KINDS: readonly FillKind[] = ["username", "password", "otp"];

/**
 * Press the form's own button — only one whose name carries no guard word, unless the user's words said that word, and
 * never one whose form sends what is typed to another site.
 */
async function pressSubmit(tabId: number, p: Probe, words: string): Promise<boolean> {
  if (p.submitRef === null || p.formLeaves) return false;
  const guard = guardOf(p.submitName);
  if (guard && (guard.kind === "money" || !saidSo(guard, words))) return false;
  try {
    const r = await browserCall<{ ok?: boolean; held?: boolean }>("page.act", { tabId, action: "click", ref: p.submitRef, ...(guard ? { approved: p.submitName } : {}) }, 8_000);
    return Boolean(r && r.ok !== false && !r.held);
  } catch {
    return false;
  }
}

async function waitFor(tabId: number, what: "load" | "password" | "otp", timeoutMs: number): Promise<boolean> {
  try {
    const r = await browserCall<{ found?: boolean }>("page.wait", { tabId, for: what, timeoutMs }, timeoutMs + 4_000);
    return Boolean(r?.found);
  } catch {
    return false;
  }
}

/**
 * Fill a saved login into the page, step by step: user name and password where the page shows them; "Next" and the
 * password on the page after it, for sign-ins in steps; the one-time code when the vault can make one. At most three
 * rounds. The form's own button is pressed at the end only when the user's words asked to sign in — and once.
 */
async function signInFlow(ctx: ToolContext, tab: BrowserTab, meta: VaultItemMeta, first: Probe, words: string, wantsSubmit: boolean): Promise<ToolResult> {
  const item = spoken(meta);
  const filled = new Set<FillKind>();
  let p = first;
  let pressed = false;
  let asksCode = false;
  let stopped = "";
  for (let round = 1; round <= 3; round++) {
    // Belt and braces: the page's exact host must be one this login was saved for, before anything is sent.
    if (!meta.hosts.includes(p.host)) {
      stopped = `The sign-in moved to ${p.host}, which ${item} isn't saved for, so I stopped there.`;
      break;
    }
    const want = p.kinds.filter((k) => LOGIN_KINDS.includes(k) && !(k === "password" && filled.has("password")));
    if (!want.length) break;
    let noCode = false;
    const at = p;
    let r: FillResult | null;
    try {
      r = await v.useSecret(meta.id, `fill on ${at.host}`, async (secret) => {
        const s = secret as Readonly<LoginSecret & { totpCode?: string }>;
        const values: Record<string, string> = {};
        if (want.includes("username") && s.username) values.username = s.username;
        if (want.includes("password") && s.password) values.password = s.password;
        if (want.includes("otp")) {
          if (s.totpCode) values.otp = s.totpCode;
          else noCode = true;
        }
        if (!Object.keys(values).length) return null;
        return browserSecretCall("page.fill", { tabId: tab.id, documentId: at.documentId, origin: at.origin, values });
      });
    } catch (err) {
      return vaultFailed(ctx, err);
    }
    if (r === null) {
      asksCode = noCode;
      break;
    }
    if (!r.ok) {
      if (filled.size) {
        stopped = fillLine(r.code, at.host);
        break;
      }
      return said(false, fillLine(r.code, at.host), { data: { code: r.code, host: at.host } });
    }
    for (const k of r.filled) filled.add(k);
    if (r.step === "otp" || noCode) asksCode = !filled.has("otp");
    if (r.step === "next") {
      // The user name is in and the password comes on the next page: "Next", then look again.
      if (!(await pressSubmit(tab.id, at, words))) {
        stopped = "I filled in the user name, but couldn't find the button to go on.";
        break;
      }
      await waitFor(tab.id, "password", 8_000);
      const next = await probe(tab.id);
      if ("code" in next) {
        stopped = "I filled in the user name and went on, but the next page didn't settle.";
        break;
      }
      p = next;
      continue;
    }
    if (filled.has("password") && wantsSubmit && !pressed && !asksCode) {
      pressed = await pressSubmit(tab.id, at, words);
      // The page after may ask for a code the vault can make.
      if (pressed && meta.hasTotp && !filled.has("otp") && round < 3 && (await waitFor(tab.id, "otp", 5_000))) {
        const next = await probe(tab.id);
        if (!("code" in next)) {
          p = next;
          continue;
        }
      }
    }
    break;
  }
  const host = first.host;
  if (!filled.size) return said(false, stopped || (asksCode ? `${host} is asking for a one-time code, and I don't have a code generator saved for ${item}. That part is yours.` : `I couldn't find a sign-in form on ${host}.`), { data: { host } });
  const parts = [`Filled ${item} on ${host}${filled.has("otp") ? ", with the one-time code" : ""}${pressed ? ", and pressed the button" : ""}.`];
  if (stopped) parts.push(stopped);
  else if (asksCode) parts.push(meta.hasTotp ? "It's asking for a one-time code now." : "It's asking for a one-time code now, which I don't have — that part is yours.");
  else if (wantsSubmit && !pressed && filled.has("password")) parts.push("I left the button for you to press.");
  return said(true, parts.join(" "), { data: { host, filled: [...filled], pressed, item: meta.id } });
}

const signIn: Tool = {
  name: "browser_sign_in",
  description:
    "Sign in to the website open in the user's Chrome with a login saved in the vault — it fills the user name and password itself, never spoken or shown: 'sign in', 'log me in', 'log in to Netflix', 'use my saved password', 'fill in my password', 'enter the code from my authenticator'.",
  input: {
    login: { type: "string", description: "which saved login to use, when several are saved for this site" },
  },
  options: (arg) => {
    if (arg !== "login") return undefined;
    const tab = currentBrowserTab();
    let host = "";
    try {
      host = tab ? new URL(tab.url).hostname.toLowerCase() : "";
    } catch {
      host = "";
    }
    const logins = host ? v.findLogins(host) : [];
    return logins.length > 1 ? Object.fromEntries(logins.map((m) => [m.id, clean(m.label)])) : {};
  },
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: ({ persona }) => browserConnected() && !(persona.toolsets ?? []).includes("game"),
  async run(args, ctx): Promise<ToolResult> {
    const words = ctx.utterance;
    const handed = await handOver("vault_save_login", words, args, ctx);
    if (handed) return handed;
    const pre = ready(ctx);
    if ("ok" in pre) return pre;
    const { tab, host } = pre;
    const first = await probe(tab.id);
    if ("code" in first) return said(false, fillLine(first.code, host), { data: { code: first.code, host } });
    if (!first.kinds.some((k) => LOGIN_KINDS.includes(k)))
      return said(false, first.signup ? `That looks like a form for a new password, not a sign-in, so I'm not putting your saved password there.` : `I couldn't find a sign-in form on ${first.host}.`, { data: { host: first.host } });
    const wantsSubmit = /\b(?:sign|log)\s*(?:me\s+|us\s+)?(?:in|on|into)\b|\blog-?in\b|\bsign-?in\b/i.test(words);
    let logins: VaultItemMeta[];
    try {
      logins = v.findLogins(first.host);
    } catch (err) {
      return vaultFailed(ctx, err);
    }
    if (!logins.length) {
      // Nothing saved for this site: the secure form to save it, and the sign-in goes on once it is in.
      let opened: ReturnType<FillVault["openForm"]>;
      const label = labelFromHost(first.host);
      try {
        opened = v.openForm({
          purpose: "save-login",
          title: `${label} login`,
          detail: `Your sign-in for ${first.host}. It goes into the vault, is filled in on ${first.host} only, and Trinity never sees or hears it.`,
          host: first.host,
          fields: [{ name: "label", label: "Name", type: "text", value: label }],
          submitLabel: "Save and sign in",
        });
      } catch (err) {
        if (vaultCode(err) === "locked") askToUnlock(ctx);
        return said(false, `I don't have a login saved for ${first.host}, and I couldn't open the secure form. ${vaultLine(err)}`);
      }
      bg(
        "browser-fill",
        opened.done.then(async (outcome) => {
          if (outcome.status !== "submitted" || !outcome.itemId) {
            if (outcome.status === "cancelled") tell(ctx, "Okay — nothing was saved, and I've left the sign-in alone.", "browser-fill");
            return;
          }
          const meta = v.getMeta(outcome.itemId);
          if (!meta) return;
          // The page may have moved on while the form was open: it is looked at afresh.
          const now = await probe(tab.id);
          if ("code" in now || now.host !== first.host) {
            tell(ctx, `Saved ${spoken(meta)}. The page has changed since, so ask me to sign in when you're back on ${first.host}.`, "browser-fill");
            return;
          }
          const r = await signInFlow(ctx, tab, meta, now, words, wantsSubmit);
          tell(ctx, `Saved ${spoken(meta)}. ${r.say ?? ""}`, "browser-fill");
        }),
      );
      const where = workspace.subscribers > 0 ? "I've opened a secure form on the workspace" : "I've opened a secure form — open the workspace to see it";
      return said(true, `I don't have a login saved for ${first.host}. ${where}: type it there and I'll sign you in. I can't see or hear what you type.`, { inProgress: "started", data: { form: "save-login", host: first.host } });
    }
    const meta = pick(logins, args.login, words);
    if (!meta) {
      const labels = logins.map((m) => clean(m.label));
      return said(true, `I have ${logins.length} logins saved for ${first.host}: ${list(labels)}. Which one? Say, for example, sign in with ${labels[0]}.`, { data: { host: first.host, choices: logins.length, held: true } });
    }
    return patient(ctx, `I'm signing you in on ${first.host} with ${spoken(meta)}.`, signInFlow(ctx, tab, meta, first, words, wantsSubmit));
  },
};

// ─── browser_fill_card ────────────────────────────────────────────────────────

const CARD_KINDS: readonly FillKind[] = ["cc-number", "cc-name", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc"];

/** The total the page shows, when it shows one that reads as an amount. */
async function pageTotal(tabId: number): Promise<{ amount: number; text: string } | null> {
  try {
    const r = await browserCall<{ total?: string | null }>("page.total", { tabId }, 5_000);
    return typeof r?.total === "string" ? parseAmount(r.total) : null;
  } catch {
    return null;
  }
}

/** The fill itself (after the yes): the page is looked at afresh, and must still be the site the yes was for. */
async function cardFill(ctx: ToolContext, tab: BrowserTab, host: string, card: VaultItemMeta, oneTimeForm?: string): Promise<ToolResult> {
  const item = spoken(card);
  const p = await probe(tab.id);
  if ("code" in p) return said(false, fillLine(p.code, host), { data: { code: p.code, host } });
  if (p.host !== host) return said(false, `The page moved on from ${host}, so I didn't fill the card in.`, { data: { host } });
  const kinds = p.kinds.filter((k) => CARD_KINDS.includes(k));
  const expiry = kinds.some((k) => k.startsWith("cc-exp"));
  const send = (code?: string): Promise<FillResult> =>
    v.useSecret(card.id, `fill on ${host}`, async (secret) => {
      const s = secret as Readonly<CardSecret>;
      const values: Record<string, string> = {};
      if (kinds.includes("cc-number")) values["cc-number"] = String(s.number);
      if (kinds.includes("cc-name") && s.holder) values["cc-name"] = s.holder;
      if (expiry) {
        values["cc-exp-month"] = String(s.expMonth).padStart(2, "0");
        values["cc-exp-year"] = String(Number(s.expYear) < 100 ? 2000 + Number(s.expYear) : s.expYear);
      }
      const csc = code ?? s.cvc;
      if (kinds.includes("cc-csc") && csc) values["cc-csc"] = csc;
      return browserSecretCall("page.fill", { tabId: tab.id, documentId: p.documentId, origin: p.origin, values });
    });
  let r: FillResult;
  try {
    // A security code that isn't kept was typed into a one-time form: it is used here, once, and is gone.
    r = oneTimeForm ? await v.useOneTime(oneTimeForm, (typed) => send(typed.cvc)) : await send();
  } catch (err) {
    return vaultFailed(ctx, err);
  }
  if (!r.ok) return said(false, r.code === "no-fields" ? `I couldn't find card fields I can fill on ${host}.` : fillLine(r.code, host), { data: { code: r.code, host } });
  const got = r.filled;
  const hasExpiry = got.some((k) => k.startsWith("cc-exp"));
  // What didn't go in: a box the page showed but that wouldn't take it — and, where the page hands the card to a
  // payment provider's frame, the parts that live in that frame (never filled: it is another site's document).
  const missing = r.missing.filter((k) => CARD_KINDS.includes(k) && !(k.startsWith("cc-exp") && hasExpiry));
  const framed: FillKind[] = [];
  if (p.frames > 0) {
    if (!got.includes("cc-number") && !missing.includes("cc-number")) framed.push("cc-number");
    if (!hasExpiry && !missing.some((k) => k.startsWith("cc-exp"))) framed.push("cc-exp");
    if (!got.includes("cc-csc") && !missing.includes("cc-csc")) framed.push("cc-csc");
  }
  const parts = [`Filled ${item} on ${host}.`];
  if (framed.length) parts.push(`I couldn't reach ${kindsAloud(framed)} — that is inside the payment provider's own frame, so it's yours to type.`);
  if (missing.length) parts.push(`I couldn't find a box for ${kindsAloud(missing)}.`);
  if (!framed.length && !missing.length) parts.push("I haven't pressed anything: paying is yours to do.");
  return said(true, parts.join(" "), { data: { host, filled: got, missing: [...missing, ...framed], item: card.id } });
}

/** After the yes: fill at once — or, when the page wants a security code the vault doesn't keep, ask for it first. */
async function cardFillApproved(ctx: ToolContext, tab: BrowserTab, host: string, card: VaultItemMeta, wantsCode: boolean): Promise<ToolResult> {
  if (!wantsCode || card.hasCvc) return cardFill(ctx, tab, host, card);
  let opened: ReturnType<FillVault["openForm"]>;
  try {
    opened = v.openForm({
      purpose: "one-time",
      title: `Security code for ${clean(card.label)}`,
      detail: `The three or four digits on the card. It is used once, for ${host}, and then forgotten. Trinity can't see or hear it.`,
      host,
      fields: [{ name: "cvc", label: "Security code", type: "cvc", required: true, autocomplete: "off" }],
      submitLabel: "Use once",
    });
  } catch (err) {
    if (vaultCode(err) === "locked") askToUnlock(ctx);
    return said(false, `I couldn't open the secure form for the security code. ${vaultLine(err)}`);
  }
  bg(
    "browser-fill",
    opened.done.then(async (outcome) => {
      if (outcome.status !== "submitted") {
        if (outcome.status === "cancelled") tell(ctx, "Okay — I've left the card out.", "browser-fill");
        return;
      }
      const r = await cardFill(ctx, tab, host, card, opened.form.id);
      tell(ctx, r.say ?? "", "browser-fill");
    }),
  );
  return said(true, `${spoken(card).replace(/^y/, "Y")} needs its security code, which I don't keep. I've opened a secure form on the workspace — type it there and I'll fill the card in.`, { inProgress: "started", data: { form: "one-time", host } });
}

const fillCard: Tool = {
  name: "browser_fill_card",
  description:
    "Fill a payment card saved in the vault into the checkout page open in the user's Chrome — after asking first, and without ever pressing Pay: 'fill in my card', 'pay with my card', 'use my Visa', 'put my card details in'. The card number is never spoken or shown.",
  input: {
    card: { type: "string", description: "which saved card to use, when several are saved" },
  },
  options: (arg) => {
    if (arg !== "card") return undefined;
    let cards: VaultItemMeta[] = [];
    try {
      cards = v.listItems("card");
    } catch {
      cards = [];
    }
    return cards.length > 1 ? Object.fromEntries(cards.map((m) => [m.id, clean(m.label)])) : {};
  },
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: ({ persona }) => browserConnected() && !(persona.toolsets ?? []).includes("game"),
  async run(args, ctx): Promise<ToolResult> {
    const words = ctx.utterance;
    const handed = await handOver("vault_save_card", words, args, ctx);
    if (handed) return handed;
    const pre = ready(ctx);
    if ("ok" in pre) return pre;
    const { tab } = pre;
    let cards: VaultItemMeta[];
    try {
      cards = v.listItems("card");
    } catch (err) {
      return vaultFailed(ctx, err);
    }
    if (!cards.length) return said(false, "You don't have a card saved yet. Say “save my card”, type it into the secure form, and ask me again.");
    const card = pick(cards, args.card, words);
    if (!card) return said(true, `You have ${cards.length} cards saved: ${list(cards.map((m) => clean(m.label)))}. Which one? Say, for example, fill in my ${clean(cards[0]!.brand ?? cards[0]!.label)}.`, { data: { choices: cards.length, held: true } });
    const p = await probe(tab.id);
    if ("code" in p) return said(false, fillLine(p.code, pre.host), { data: { code: p.code, host: pre.host } });
    const host = p.host;
    const kinds = p.kinds.filter((k) => CARD_KINDS.includes(k));
    if (!kinds.length)
      return said(false, p.frames > 0 ? `The card fields on ${host} are inside the payment provider's own frame, which I can't fill. That part is yours.` : `I couldn't find card fields on ${host}.`, { data: { host, frames: p.frames } });
    const item = spoken(card);
    const wantsCode = kinds.includes("cc-csc");
    const total = await pageTotal(tab.id);
    const limit = v.spendingLimit();
    if (total && limit > 0 && total.amount <= limit) {
      // A spoken yes to a question that names the card and the site — and a yes that says "fill": a stray "sure" in
      // conversation (or Trinity's own "okay" heard back through the microphone) fills nothing. A yes without the word
      // gets the question again, with the words to say (agent/pending.ts).
      const question = `Fill ${item} on ${host}? The total there shows ${total.text}.`;
      askYesNo({
        question,
        require: ["fill"],
        onAnswer: (yes) => (yes ? cardFillApproved(ctx, tab, host, card, wantsCode) : said(true, "Okay — I've left the card out.", { data: { host, filled: [] } })),
      });
      return said(true, `${question} To go ahead, say: yes, fill it in.`, { data: { host, held: true, item: card.id } });
    }
    // Above the limit — or no total to read, which counts the same: an Approve button in the secure form.
    const why = !total ? "I couldn't read a total on that page." : limit > 0 ? `The total on the page is ${total.text}, above your limit of ${limit}.` : `The total on the page is ${total.text}, and card fills are set to always need approval.`;
    let opened: ReturnType<FillVault["openForm"]>;
    try {
      opened = v.openForm({
        purpose: "confirm",
        title: `Fill ${clean(card.label)} on ${host}?`,
        detail: `${why} Approve to have the card filled in on ${host}. Nothing is paid until you press the site's own button.`,
        host,
        fields: [],
        submitLabel: "Approve",
      });
    } catch (err) {
      if (vaultCode(err) === "locked") askToUnlock(ctx);
      return said(false, `I couldn't open the secure form to approve that. ${vaultLine(err)}`);
    }
    bg(
      "browser-fill",
      opened.done.then(async (outcome) => {
        if (outcome.status !== "approved") {
          if (outcome.status === "cancelled") tell(ctx, "Okay — I've left the card out.", "browser-fill");
          return;
        }
        const r = await cardFillApproved(ctx, tab, host, card, wantsCode);
        tell(ctx, r.say ?? "", "browser-fill");
      }),
    );
    return said(true, `${why} So instead of a spoken yes, there's an Approve button on the workspace for filling ${item} on ${host}.`, { inProgress: "started", data: { form: "confirm", host, item: card.id } });
  },
};

// ─── browser_fill_details ─────────────────────────────────────────────────────

const DETAIL_KINDS: readonly FillKind[] = ["name", "given-name", "family-name", "email", "tel", "street-address", "address-line1", "address-line2", "address-level2", "address-level1", "postal-code", "country", "bday"];

const fillDetails: Tool = {
  name: "browser_fill_details",
  description:
    "Fill the user's own details saved in the vault — name, email, phone, address — into the form open in the user's Chrome: 'fill in my details', 'fill in my address', 'put my name and email in', 'fill out this form with my details'.",
  input: {
    details: { type: "string", description: "which saved set of details to use, when several are saved" },
  },
  options: (arg) => {
    if (arg !== "details") return undefined;
    let sets: VaultItemMeta[] = [];
    try {
      sets = v.listItems("identity");
    } catch {
      sets = [];
    }
    return sets.length > 1 ? Object.fromEntries(sets.map((m) => [m.id, clean(m.label)])) : {};
  },
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: ({ persona }) => browserConnected() && !(persona.toolsets ?? []).includes("game"),
  async run(args, ctx): Promise<ToolResult> {
    const words = ctx.utterance;
    const handed = await handOver("vault_save_details", words, args, ctx);
    if (handed) return handed;
    const pre = ready(ctx);
    if ("ok" in pre) return pre;
    const { tab } = pre;
    let sets: VaultItemMeta[];
    try {
      sets = v.listItems("identity");
    } catch (err) {
      return vaultFailed(ctx, err);
    }
    if (!sets.length) return said(false, "You haven't saved your details yet. Say “save my details”, type them into the secure form, and ask me again.");
    const meta = pick(sets, args.details, words);
    if (!meta) return said(true, `You have ${sets.length} sets of details saved: ${list(sets.map((m) => clean(m.label)))}. Which one? Say, for example, fill in my ${clean(sets[0]!.label)} details.`, { data: { choices: sets.length, held: true } });
    const p = await probe(tab.id);
    if ("code" in p) return said(false, fillLine(p.code, pre.host), { data: { code: p.code, host: pre.host } });
    const host = p.host;
    const kinds = p.kinds.filter((k) => DETAIL_KINDS.includes(k));
    if (!kinds.length) return said(false, `I couldn't find name, email, phone or address fields on ${host}.`, { data: { host } });
    let r: FillResult;
    try {
      r = await v.useSecret(meta.id, `fill on ${host}`, async (secret) => {
        const s = secret as Readonly<IdentitySecret>;
        const name = (s.fullName ?? "").replace(/\s+/g, " ").trim();
        const parts = name.split(" ");
        // Only what the page has a box for is sent.
        const all: Partial<Record<FillKind, string | undefined>> = {
          name,
          "given-name": parts.slice(0, Math.max(1, parts.length - 1)).join(" "),
          "family-name": parts.length > 1 ? parts[parts.length - 1] : "",
          email: s.email,
          tel: s.phone,
          "street-address": [s.address1, s.address2].filter(Boolean).join(", "),
          "address-line1": s.address1,
          "address-line2": s.address2,
          "address-level2": s.city,
          "address-level1": s.region,
          "postal-code": s.postalCode,
          country: s.country,
          bday: s.birthDate,
        };
        const values: Record<string, string> = {};
        for (const k of kinds) if (all[k]) values[k] = String(all[k]);
        if (!Object.keys(values).length) return { ok: false, code: "no-fields" } satisfies FillResult;
        return browserSecretCall("page.fill", { tabId: tab.id, documentId: p.documentId, origin: p.origin, values });
      });
    } catch (err) {
      return vaultFailed(ctx, err);
    }
    if (!r.ok) return said(false, r.code === "no-fields" ? `Nothing in ${spoken(meta)} fits the fields on ${host}.` : fillLine(r.code, host), { data: { code: r.code, host } });
    return said(true, `Filled ${kindsAloud(r.filled)} on ${host}.`, { data: { host, filled: r.filled, item: meta.id } });
  },
};

// ─── Registration ─────────────────────────────────────────────────────────────

const FILL_RULES = [
  "'Sign in', 'log me in', 'log in to <site>', 'use my saved password', 'fill in my password' on the page in Chrome are browser_sign_in — not browser_act, and never typing a password. 'Fill in my card', 'pay with my card', 'use my Visa' are browser_fill_card (it asks first, fills, and never pays). 'Fill in my details / name / address / this form' are browser_fill_details. Saving a login, a card or details for later ('save my …', 'remember my … password') is vault_save_login / vault_save_card / vault_save_details instead.",
];

export function registerBrowserFillTools(): void {
  registerTool(signIn);
  registerTool(fillCard);
  registerTool(fillDetails);
  registerContextProvider({
    rules: (persona) => (browserConnected() && !(persona.toolsets ?? []).includes("game") ? FILL_RULES : []),
  });
}
