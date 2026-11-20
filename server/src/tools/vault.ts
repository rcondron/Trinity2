import { askYesNo } from "../agent/pending.js";
import { tell, tellEveryone } from "../agent/tell.js";
import { activeTabHost } from "../services/browser-bridge.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { VaultError } from "../vault/errors.js";
import { reconcileFormCards, setVaultAnnouncer } from "../vault/forms.js";
import { getMeta, listItems, openForm, removeItem, vaultStatus, type FormRequest, type VaultItemMeta, type VaultKind } from "../vault/index.js";
import { labelFromHost, normalizeHost, siteNameOf } from "../vault/items.js";
import { workspace } from "../workspace/bus.js";
import { registerTool } from "./registry.js";

/*
 * The vault's voice tools: save a login, a card or contact details (each opens a secure form in the workspace and
 * returns at once), say what is kept (names only), and forget an item (after a spoken yes).
 *
 * None of them takes, hears or says a secret: they have no arguments for one, they never ask for one by voice, and
 * every line they speak is put together here from a label ("Netflix"), a kind ("login") or a host. All are
 * `sensitive`: only the user's own words start them — never the solver, a scheduled run or a skill.
 */

const OPENED = "I've opened a secure form on the workspace. Type it there — I can't see or hear it.";
const OPENED_NO_WINDOW = "I've opened a secure form, but the workspace isn't open. Open the workspace and type it there — I can't see or hear it.";
const UNLOCK_FIRST = "The vault is locked. Type your passphrase in the secure form on the workspace first; the form for this opens right after.";

const said = (ok: boolean, line: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok, say: line, speak: line, ...extra });
const words = (ctx: ToolContext): string => (ctx.userWords ?? ctx.utterance ?? "").replace(/\s+/g, " ").trim();
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** An item as it is spoken: "your Netflix login", "your Visa ending 4242", "your details". Labels only. */
function spoken(m: Pick<VaultItemMeta, "kind" | "label">): string {
  const label = m.label.replace(/\s+/g, " ").trim().slice(0, 60);
  if (m.kind === "login") return /\b(?:login|log-in|account|password)\b/i.test(label) ? `your ${label}` : `your ${label} login`;
  if (m.kind === "card") return `your ${label}`;
  if (m.kind === "identity") return /^my details$/i.test(label) ? "your details" : `your details, ${label}`;
  return `your ${label}`;
}

/** Why the vault can't be used at all right now, as a spoken line — or null. */
function refusal(): ToolResult | null {
  const s = vaultStatus();
  return s.blocked ? said(false, `I can't use the vault right now. ${s.blocked}`) : null;
}

// ─── Which site the words mean ────────────────────────────────────────────────

const NOT_A_NAME = new Set(
  "a an the my our your this that these those it its new old current saved same other another first last website web site page account accounts login logins log sign in password passwords pass code passcode username user name email credentials details secure form vault here there one".split(" "),
);

function cleanLabel(raw: string): string | undefined {
  const kept = raw
    .replace(/["“”‘’'.,!?]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOT_A_NAME.has(w.toLowerCase()));
  const label = kept.join(" ").trim().slice(0, 40);
  if (!label || !/[A-Za-z0-9]/.test(label)) return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "save my Netflix password", "my login for github dot com" → the site's name and, when an address was said, its host. */
export function siteFromWords(utterance: string): { label?: string; host?: string } {
  const t = utterance.replace(/\s+dot\s+/gi, ".").replace(/\s+/g, " ").trim();
  let host: string | undefined;
  const address = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})\b/i.exec(t);
  if (address) {
    try {
      host = normalizeHost(address[1]!);
    } catch {
      host = undefined;
    }
  }
  if (host) return { host, label: labelFromHost(host) };
  const KIND = String.raw`(?:passwords?|pass ?codes?|log-?ins?|sign-?ins?|accounts?|credentials|user ?names?)`;
  const named =
    new RegExp(String.raw`\b(?:my|the|our)\s+(.{1,40}?)\s+${KIND}\b`, "i").exec(t)?.[1] ??
    new RegExp(String.raw`\b${KIND}\s+(?:for|to|on|at)\s+(?:my\s+|the\s+)?(.{1,40}?)(?:\s+(?:account|website|site))?\s*[.!?]*$`, "i").exec(t)?.[1];
  const label = named ? cleanLabel(named) : undefined;
  return label ? { label } : {};
}

/**
 * Is the page the user is on the site they named? Only when the name they said is the name that site is registered
 * under ("Netflix" and www.netflix.com; "Amazon Prime" and www.amazon.co.uk) — not when it merely appears somewhere in
 * the address (netflix.com.evil.io, evilnetflix.com). When it doesn't fit, the form asks for the address instead.
 */
export function hostFitsLabel(host: string, label: string): boolean {
  const site = siteNameOf(host)?.replace(/[^a-z0-9]/g, "");
  if (!site) return false;
  const said = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return said.join("") === site || said.some((w) => w.length >= 3 && w === site);
}

// ─── Opening a form ───────────────────────────────────────────────────────────

/** Open a form for the user and answer at once; say so (tell) when it has been submitted. */
function openFor(ctx: ToolContext, req: Omit<FormRequest, "id" | "expiresAt">, saved: (meta: VaultItemMeta | null) => string): ToolResult {
  const no = refusal();
  if (no) return no;
  const before = vaultStatus();
  const locked = before.state === "locked" && before.lock === "passphrase";
  let opened: ReturnType<typeof openForm>;
  try {
    opened = openForm(req);
  } catch (err) {
    return said(false, err instanceof VaultError ? `I couldn't open the secure form. ${err.message}` : "I couldn't open the secure form.");
  }
  void opened.done.then((outcome) => {
    if (outcome.status !== "submitted") return;
    tell(ctx, saved(outcome.itemId ? getMeta(outcome.itemId) : null), "vault");
  });
  const line = locked ? UNLOCK_FIRST : workspace.subscribers > 0 ? OPENED : OPENED_NO_WINDOW;
  return said(true, line, { inProgress: "started", data: { form: req.purpose, ...(req.host ? { host: req.host } : {}) } });
}

const saveLogin: Tool = {
  name: "vault_save_login",
  description:
    "Save a website login or password in the vault, or let the user give one: opens a secure form to type it into (“save my Netflix password”, “remember my login for github.com”, “I'll give you my login for Amazon”, “save this site's password”). The password is typed there, never spoken.",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    const site = siteFromWords(words(ctx));
    // The page the user is on fixes the site — when the words name no site ("this site's password") or name that very
    // one. An address that was only spoken may have been misheard: it is put into the form's Website field instead,
    // where it can be seen and corrected.
    const tab = site.host ? null : activeTabHost();
    const host = tab && (!site.label || hostFitsLabel(tab, site.label)) ? tab : undefined;
    const label = site.label ?? (host ? labelFromHost(host) : "");
    const filledIn: FormRequest["fields"] = [];
    if (label) filledIn.push({ name: "label", label: "Name", type: "text", value: label });
    if (!host && site.host) filledIn.push({ name: "hosts", label: "Website", type: "text", value: site.host });
    return openFor(
      ctx,
      {
        purpose: "save-login",
        title: label ? `${label} login` : "Website login",
        detail: `Your sign-in${label ? ` for ${label}` : ""}. It goes into the vault, and is only ever filled in on the site it is saved for.`,
        ...(host ? { host } : {}),
        fields: filledIn,
        submitLabel: "Save login",
      },
      (meta) => `Saved ${meta ? spoken(meta) : "your login"}.`,
    );
  },
};

const saveCard: Tool = {
  name: "vault_save_card",
  description:
    "Save a payment card in the vault: opens a secure form to type the card into (“save my credit card”, “add my Visa”, “remember this card for later”). The number is typed there, never spoken.",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    return openFor(
      ctx,
      {
        purpose: "save-card",
        title: "Payment card",
        detail: "A card to pay with. Trinity only fills it in after you say yes, and never presses Pay. The security code is asked for each time unless you choose to keep it.",
        fields: [],
        submitLabel: "Save card",
      },
      (meta) => `Saved ${meta ? spoken(meta) : "your card"}.`,
    );
  },
};

const saveDetails: Tool = {
  name: "vault_save_details",
  description:
    "Save the user's own contact details for filling in forms — name, email, phone, address: opens a secure form to type them into (“save my address”, “remember my contact details”, “save my shipping info”).",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    return openFor(
      ctx,
      {
        purpose: "save-identity",
        title: "Your details",
        detail: "Your name, email, phone and address, for filling in forms. Leave out anything you don't want kept.",
        fields: [],
        submitLabel: "Save details",
      },
      (meta) => `Saved ${meta ? spoken(meta) : "your details"}.`,
    );
  },
};

// ─── What is kept ─────────────────────────────────────────────────────────────

const KIND_WORDS: [VaultKind, RegExp][] = [
  ["card", /\b(?:cards?|credit cards?|debit cards?|visa|mastercard|amex|american express|payment)\b/i],
  ["login", /\b(?:log-?ins?|passwords?|accounts?|sign-?ins?|credentials|sites?|websites?)\b/i],
  ["identity", /\b(?:address(?:es)?|details|contact|identit(?:y|ies)|shipping|phone)\b/i],
];
const kindIn = (t: string): VaultKind | null => KIND_WORDS.find(([, re]) => re.test(t))?.[0] ?? null;

const NOUN: Record<VaultKind, [string, string]> = {
  login: ["login", "logins"],
  card: ["card", "cards"],
  identity: ["set of details", "sets of details"],
  secret: ["other secret", "other secrets"],
};

/** "2 logins, Netflix and GitHub" — names only, at most five. */
function group(kind: VaultKind, items: VaultItemMeta[]): string {
  const names = items.slice(0, 5).map((m) => m.label.replace(/\s+/g, " ").trim().slice(0, 40));
  if (items.length > names.length) names.push(`${items.length - names.length} more`);
  return `${items.length} ${NOUN[kind][items.length === 1 ? 0 : 1]}, ${list(names)}`;
}

const listVault: Tool = {
  name: "vault_list",
  description:
    "Say what is saved in the vault, by name only — never a password or a number (“what logins do you have?”, “which passwords are saved?”, “what cards do you have?”, “what's in the vault?”).",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  async run(_args, ctx): Promise<ToolResult> {
    const no = refusal();
    if (no) return no;
    const only = kindIn(words(ctx));
    const all = listItems();
    if (!all.length) return said(true, "The vault is empty. Say “save my login” or “save my card” and I'll open a secure form.");
    const kinds = (only ? [only] : (["login", "card", "identity", "secret"] as VaultKind[])).filter((k) => all.some((m) => m.kind === k));
    if (!kinds.length) return said(true, `No ${NOUN[only!][1]} are saved in the vault.`);
    const groups = kinds.map((k) => group(k, all.filter((m) => m.kind === k)));
    const line = groups.length === 1 ? `You have ${groups[0]}.` : `In the vault: ${groups.join("; ")}.`;
    return said(true, line, { data: { items: all.filter((m) => kinds.includes(m.kind)).map((m) => ({ kind: m.kind, label: m.label })) } });
  },
};

// ─── Forgetting ───────────────────────────────────────────────────────────────

/** The item the words mean: by its name, a site it is for, a card's last four digits or brand — else by kind when only one fits. */
export function pickItem(utterance: string, items: VaultItemMeta[]): { item?: VaultItemMeta; among: VaultItemMeta[] } {
  const t = ` ${utterance.toLowerCase().replace(/\s+dot\s+/g, ".")} `;
  const has = (w: string): boolean => w.length >= 2 && new RegExp(String.raw`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`).test(t);
  const scored = items
    .map((m) => {
      let score = 0;
      for (const w of m.label.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !NOT_A_NAME.has(w) && w !== "ending" && has(w)) score += 3;
      for (const h of m.hosts) {
        if (has(h)) score += 5;
        const name = labelFromHost(h).toLowerCase();
        if (name.length >= 3 && has(name)) score += 2;
      }
      if (m.last4 && has(m.last4)) score += 5;
      if (m.brand && m.brand !== "Card" && has(m.brand.toLowerCase())) score += 2;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score)) return { item: scored[0]!.m, among: [] };
  if (scored.length) return { among: scored.filter((x) => x.score === scored[0]!.score).map((x) => x.m) };
  const kind = kindIn(t);
  const pool = kind ? items.filter((m) => m.kind === kind) : items;
  return pool.length === 1 && kind ? { item: pool[0]!, among: [] } : { among: pool };
}

const forget: Tool = {
  name: "vault_forget",
  description:
    "Remove something from the vault — a saved login, card or details — after asking first (“forget my Netflix password”, “delete my saved card”, “remove the GitHub login from the vault”).",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: () => listItems().length > 0,
  async run(_args, ctx): Promise<ToolResult> {
    const no = refusal();
    if (no) return no;
    const items = listItems();
    if (!items.length) return said(true, "The vault is empty: there is nothing to remove.");
    const { item, among } = pickItem(words(ctx), items);
    if (!item) {
      const names = among.slice(0, 4).map((m) => spoken(m).replace(/^your /, ""));
      return said(false, names.length ? `Which one should I remove: ${names.join(", ").replace(/, ([^,]*)$/, " or $1")}?` : "I don't have that in the vault.");
    }
    const name = spoken(item);
    // Removing is for good, so a passing "okay" or "sure" is not enough: the yes has to say what it approves, and the
    // question says how. (A yes without it gets the question again, with the words to say — agent/pending.ts.)
    const question = `Remove ${name} from the vault for good?`;
    const asked = `${question} To confirm, say: yes, remove it.`;
    askYesNo({
      question,
      require: ["remove"],
      onAnswer: async (yes) => {
        if (!yes) return said(true, `Okay, I kept ${name}.`);
        try {
          const gone = await removeItem(item.id);
          return gone ? said(true, `Removed ${name} from the vault.`) : said(false, `${name.charAt(0).toUpperCase()}${name.slice(1)} was already gone.`);
        } catch (err) {
          if (err instanceof VaultError && err.code === "locked") return said(false, "The vault is locked. Type your passphrase in the secure form, then ask me again.");
          return said(false, err instanceof VaultError ? `I couldn't remove it. ${err.message}` : "I couldn't remove it.");
        }
      },
    });
    return said(true, asked, { data: { asked: "remove", kind: item.kind, label: item.label } });
  },
};

export function registerVaultTools(): void {
  [saveLogin, saveCard, saveDetails, listVault, forget].forEach(registerTool);
  // What the vault says when no tool is waiting on it (it was unlocked after something had asked for it).
  setVaultAnnouncer((line) => tellEveryone(line, "vault"));
  // Forms don't outlive the engine: a placeholder card left on the saved board stands for nothing now.
  reconcileFormCards();
}
