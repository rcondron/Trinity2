// Vault: Trinity's encrypted store for website logins, payment cards, contact details and other secrets.
// This page shows how it is locked and what is in it (names and sites, never a secret), adds and removes items,
// sets the spending limit above which a card fill needs approval, and lists the browsers linked to the engine.
//
// What is typed here goes to the engine in a request body (POST /api/vault/items, PUT /api/vault/settings,
// POST /api/vault/unlock) and nowhere else; the inputs are blanked as soon as it has been sent. No answer from the
// engine ever holds a secret, so nothing on this page can show one.

import { api, ApiError, type LinkedBrowser, type VaultField, type VaultInfo, type VaultItem, type VaultKind } from "./api.js";
import {
  badge,
  button,
  confirmAction,
  emptyState,
  errorState,
  field,
  h,
  icon,
  plural,
  relTime,
  sectionHead,
  segmented,
  setChildren,
  skeletonLines,
  toast,
  withBusy,
  type IconName,
  type Section,
} from "./ui.js";

const KIND_LABEL: Record<VaultKind, string> = { login: "Login", card: "Card", identity: "Details", secret: "Other secret" };
const KIND_ICON: Record<VaultKind, IconName> = { login: "key", card: "tag", identity: "user", secret: "shield" };
const MIN_PASSPHRASE = 8;

// ─── Small pieces ────────────────────────────────────────────────────────────

/** Attributes that keep the browser's own password and card managers (and their extensions) out of an input. */
function keepManagersOut(input: HTMLInputElement, masked: boolean): void {
  input.setAttribute("autocomplete", masked ? "new-password" : "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-1p-ignore", "true");
  input.setAttribute("data-bwignore", "true");
  input.setAttribute("data-form-type", "other");
}

const MASK = "-webkit-text-security";

/**
 * Whether a plain text field can be drawn masked (as dots). A type=password field is the browser's password manager's
 * business — it may offer to save what is typed there, or to make a password up — so where a text field can be masked
 * instead, that is what a secret is typed into, and the manager never sees a password field on this page.
 */
function canMaskText(): boolean {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(MASK, "disc");
  } catch {
    return false;
  }
}

/** A masked input with a Show / Hide button. (Exported for scripts/test-vault.mts.) */
export function secretInput(o: { label: string; placeholder?: string; maxLength?: number; numeric?: boolean }): { el: HTMLElement; input: HTMLInputElement } {
  const maskText = canMaskText();
  const input = h("input", { class: "input", type: maskText ? "text" : "password", placeholder: o.placeholder, maxLength: o.maxLength ?? 1000, "aria-label": o.label });
  keepManagersOut(input, !maskText);
  if (maskText) input.style.setProperty(MASK, "disc");
  if (o.numeric) input.inputMode = "numeric";
  const toggle = button("Show", {
    size: "sm",
    title: `Show ${o.label}`,
    onclick: () => {
      const show = maskText ? input.style.getPropertyValue(MASK) !== "none" : input.type === "password";
      if (maskText) input.style.setProperty(MASK, show ? "none" : "disc");
      else input.type = show ? "text" : "password";
      const label = toggle.querySelector(".btn-label");
      if (label) label.textContent = show ? "Hide" : "Show";
      toggle.title = `${show ? "Hide" : "Show"} ${o.label}`;
      toggle.setAttribute("aria-pressed", String(show));
      input.focus();
    },
  });
  toggle.setAttribute("aria-pressed", "false");
  return { el: h("div", { class: "vault-secret" }, input, toggle), input };
}

/** The card's brand from its first digits (the engine decides for real when it saves). */
function brandOf(digits: string): string {
  const n = (len: number): number => Number(digits.slice(0, len));
  if (/^4/.test(digits)) return "Visa";
  if (digits.length >= 2 && ((n(2) >= 51 && n(2) <= 55) || (digits.length >= 4 && n(4) >= 2221 && n(4) <= 2720))) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (digits.length >= 4 && n(4) >= 3528 && n(4) <= 3589) return "JCB";
  if ((digits.length >= 3 && n(3) >= 300 && n(3) <= 305) || /^3[689]/.test(digits)) return "Diners Club";
  if (/^6011/.test(digits) || /^65/.test(digits) || (digits.length >= 3 && n(3) >= 644 && n(3) <= 649)) return "Discover";
  if (/^62/.test(digits)) return "UnionPay";
  if (/^(?:50|5[6-9]|6304|67)/.test(digits)) return "Maestro";
  return "";
}

/** "0827" → "08/27" as it is typed; "8/27" stays as it is. */
function tidyExpiry(typed: string): string {
  const split = /^\s*(\d{0,2})\s*[/\-. ]\s*(\d{0,4})/.exec(typed);
  if (split) return `${split[1]}/${split[2]}`;
  const d = typed.replace(/\D/g, "").slice(0, 6);
  return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

interface Control {
  field: VaultField;
  row: HTMLElement;
  input: HTMLInputElement;
}

/** One field of the "add" form, drawn from the engine's description of it. */
function controlFor(f: VaultField): Control {
  if (f.type === "checkbox") {
    const input = h("input", { type: "checkbox" });
    return { field: f, input, row: h("label", { class: "vault-check" }, input, h("span", null, f.label)) };
  }
  const masked = f.type === "password" || f.type === "cvc" || f.type === "otp-secret";
  if (masked) {
    const s = secretInput({ label: f.label, placeholder: f.placeholder, maxLength: f.type === "cvc" ? 4 : 1000, numeric: f.type === "cvc" });
    if (f.type === "cvc") {
      s.input.addEventListener("input", () => {
        const digits = s.input.value.replace(/\D/g, "").slice(0, 4);
        if (digits !== s.input.value) s.input.value = digits;
      });
    }
    return { field: f, input: s.input, row: field({ label: f.label, control: s.el, id: (s.input.id = `vault-${f.name}`) }).el };
  }
  const input = h("input", { class: "input", type: f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text", placeholder: f.placeholder, maxLength: f.type === "card-number" ? 23 : f.type === "expiry" ? 7 : 320, id: `vault-${f.name}` });
  keepManagersOut(input, false);
  let control: HTMLElement = input;
  if (f.type === "card-number") {
    input.inputMode = "numeric";
    const brand = h("span", { class: "vault-brand", "aria-live": "polite" });
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 19);
      const grouped = digits.replace(/(.{4})(?=.)/g, "$1 ");
      if (grouped !== input.value) input.value = grouped;
      brand.textContent = brandOf(digits);
    });
    control = h("div", { class: "vault-secret" }, input, brand);
  } else if (f.type === "expiry") {
    input.inputMode = "numeric";
    input.addEventListener("input", () => {
      const tidy = tidyExpiry(input.value);
      if (tidy !== input.value) input.value = tidy;
    });
  }
  return { field: f, input, row: field({ label: f.label, control, id: input.id }).el };
}

/** "Chrome on Windows" from a user-agent string (as much as can be told at a glance). */
function browserName(agent: string): string {
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}

function itemLine(m: VaultItem): string {
  if (m.kind === "login") return [m.hosts.join(", ") || "no site", m.usernameHint ? `user ${m.usernameHint}` : "", m.hasTotp ? "authenticator codes" : ""].filter(Boolean).join(" · ");
  if (m.kind === "card") {
    const exp = m.expMonth && m.expYear ? `expires ${String(m.expMonth).padStart(2, "0")}/${String(m.expYear).slice(-2)}` : "";
    return [`${m.brand ?? "Card"} ending ${m.last4 ?? "····"}`, exp, m.hasCvc ? "security code kept" : "security code asked for each time"].filter(Boolean).join(" · ");
  }
  return m.kind === "identity" ? "Name, email, phone, address" : "A secret";
}

// ─── The section ─────────────────────────────────────────────────────────────

export function createVaultSection(): Section {
  let info: VaultInfo | null = null;
  let browsers: LinkedBrowser[] | null = null;
  let failed: string | null = null;
  let addKind: VaultKind = "login";
  /** A lock mode picked but not yet applied (its passphrase fields are showing). */
  let pendingLock: "device" | "passphrase" | "change" | null = null;
  let addControls: Control[] = [];
  let addKey = "";
  let linkCode: { code: string; expiresAt: number } | null = null;

  const lockCard = h("div", { class: "card" });
  const itemsCard = h("div", { class: "card" });
  const addCard = h("div", { class: "card" });
  const limitCard = h("div", { class: "card" });
  const browsersCard = h("div", { class: "card" });
  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-vault" },
    sectionHead({
      id: "sec-vault",
      title: "Vault",
      lede: "Website logins, payment cards and your contact details, encrypted on this computer. Trinity fills them into the sites they were saved for — and neither she nor any model ever sees, hears or says them.",
      actions: button("Refresh", { icon: "refresh", size: "sm", variant: "ghost", onclick: () => void load() }),
    }),
    h("div", { class: "heartbeat-stack" }, lockCard, itemsCard, addCard, limitCard, browsersCard),
  );

  const head = (name: IconName, title: string, sub: string, side?: HTMLElement | null): HTMLElement =>
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon(name)),
      h("div", { class: "card-head-text" }, h("h2", { class: "card-title" }, title), h("p", { class: "card-sub" }, sub)),
      side ? h("div", { class: "card-head-side" }, side) : null,
    );

  const usable = (): boolean => Boolean(info) && !info!.status.blocked && !(info!.status.state === "locked" && info!.status.lock === "passphrase");
  const whyNot = (): string =>
    !info ? "" : info.status.blocked ? info.status.blocked : info.status.state === "locked" && info.status.lock === "passphrase" ? "The vault is locked. Unlock it above first." : "";

  /** Run a request; on success take its answer as the new state. Failures are toasted by the request helper. */
  async function act(btn: HTMLButtonElement, run: () => Promise<unknown>, done?: string): Promise<boolean> {
    try {
      await withBusy(btn, run);
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) void load();
      return false;
    }
    if (done) toast(done, "success");
    await load();
    return true;
  }

  // ── Lock ──

  function renderLock(): void {
    if (!info) {
      setChildren(lockCard, head("shield", "Lock", "How the vault is locked on this computer."), h("div", { class: "card-pad" }, failed ? errorState(failed, () => void load(), true) : skeletonLines(3)));
      return;
    }
    const s = info.status;
    const state = s.blocked ? badge("Blocked", "danger") : s.state === "unlocked" ? badge("Unlocked", "ok") : s.state === "locked" ? badge(s.lock === "passphrase" ? "Locked" : "Locked until first use", s.lock === "passphrase" ? "warn" : "default") : badge("Empty");
    const sub =
      s.lock === "device"
        ? "Locked by this computer: Windows keeps the vault's key for your account. It opens by itself when Trinity needs it."
        : "Locked by a passphrase: Trinity asks for it in a secure form, and locks again after 15 minutes without use and whenever the engine restarts.";
    const body = h("div", { class: "card-pad form-stack" });

    if (s.blocked) body.append(h("div", { class: "notice notice-warn" }, icon("alert"), h("span", null, s.blocked)));

    const choice = segmented({
      label: "How the vault is locked",
      look: "cards",
      value: pendingLock === "device" || pendingLock === "passphrase" ? pendingLock : s.lock,
      options: [
        { value: "device", label: "This computer", icon: "monitor", hint: info.keyStore ? "Opens by itself for your Windows account" : "Not available: no key store on this computer" },
        { value: "passphrase", label: "A passphrase", icon: "key", hint: "Typed by you; locks again when idle" },
      ],
      onchange: (value) => {
        pendingLock = value === s.lock ? null : (value as "device" | "passphrase");
        renderLock();
      },
    });
    if (!info.keyStore && s.lock !== "device") choice.el.querySelectorAll<HTMLInputElement>('input[value="device"]').forEach((i) => (i.disabled = true));
    body.append(choice.el);

    const cancel = button("Cancel", {
      variant: "ghost",
      onclick: () => {
        pendingLock = null;
        renderLock();
      },
    });
    const twice = (): { first: ReturnType<typeof secretInput>; second: ReturnType<typeof secretInput>; row: HTMLElement } => {
      const first = secretInput({ label: "New passphrase" });
      const second = secretInput({ label: "New passphrase, again" });
      return {
        first,
        second,
        row: h(
          "div",
          { class: "form-grid" },
          field({ label: "New passphrase", control: first.el, hint: `At least ${MIN_PASSPHRASE} characters. It can't be recovered: without it the vault stays shut.` }).el,
          field({ label: "New passphrase, again", control: second.el }).el,
        ),
      };
    };
    const checked = (first: HTMLInputElement, second: HTMLInputElement): string | null => {
      if (first.value.length < MIN_PASSPHRASE) return `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`;
      if (first.value !== second.value) return "The two passphrases aren't the same.";
      return null;
    };
    const blank = (...inputs: HTMLInputElement[]): void => {
      for (const i of inputs) i.value = "";
    };

    if (pendingLock === "passphrase" && s.lock === "device") {
      const t = twice();
      const save = button("Lock with this passphrase", { variant: "primary", icon: "key" });
      save.addEventListener("click", () => {
        const problem = checked(t.first.input, t.second.input);
        if (problem) return toast(problem, "warn");
        const passphrase = t.first.input.value;
        blank(t.first.input, t.second.input);
        void act(save, () => api.vault.settings({ lock: "passphrase", passphrase }), "The vault is now locked with your passphrase").then((ok) => {
          if (ok) pendingLock = null;
          renderLock();
        });
      });
      body.append(t.row, h("div", { class: "form-actions" }, cancel, save));
    } else if (pendingLock === "device" && s.lock === "passphrase") {
      const current = secretInput({ label: "Current passphrase" });
      const save = button("Use this computer's lock", { variant: "primary", icon: "monitor" });
      save.addEventListener("click", () => {
        const currentPassphrase = current.input.value;
        if (!currentPassphrase) return toast("Type the current passphrase first.", "warn");
        blank(current.input);
        void act(save, () => api.vault.settings({ lock: "device", currentPassphrase }), "The vault is now locked by this computer").then((ok) => {
          if (ok) pendingLock = null;
          renderLock();
        });
      });
      body.append(field({ label: "Current passphrase", control: current.el, hint: "To take the passphrase off, type it once more." }).el, h("div", { class: "form-actions" }, cancel, save));
    } else if (pendingLock === "change" && s.lock === "passphrase") {
      const current = secretInput({ label: "Current passphrase" });
      const t = twice();
      const save = button("Change the passphrase", { variant: "primary", icon: "key" });
      save.addEventListener("click", () => {
        const problem = !current.input.value ? "Type the current passphrase first." : checked(t.first.input, t.second.input);
        if (problem) return toast(problem, "warn");
        const patch = { lock: "passphrase" as const, passphrase: t.first.input.value, currentPassphrase: current.input.value };
        blank(current.input, t.first.input, t.second.input);
        void act(save, () => api.vault.settings(patch), "Passphrase changed").then((ok) => {
          if (ok) pendingLock = null;
          renderLock();
        });
      });
      body.append(field({ label: "Current passphrase", control: current.el }).el, t.row, h("div", { class: "form-actions" }, cancel, save));
    } else if (s.lock === "passphrase" && !s.blocked) {
      if (s.state === "locked") {
        const pass = secretInput({ label: "Vault passphrase" });
        const unlock = button("Unlock", { variant: "primary", icon: "key" });
        const go = (): void => {
          const passphrase = pass.input.value;
          if (!passphrase) return;
          blank(pass.input);
          void act(unlock, () => api.vault.unlock(passphrase), "Vault unlocked");
        };
        unlock.addEventListener("click", go);
        pass.input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") go();
        });
        const wait = info.retryAfterMs > 0 ? `Too many wrong passphrases: the next try is possible in ${Math.ceil(info.retryAfterMs / 1000)} seconds.` : "It is asked for here, or in the secure form Trinity opens in the workspace.";
        body.append(field({ label: "Vault passphrase", control: h("div", { class: "vault-row" }, pass.el, unlock), hint: wait }).el);
      } else {
        const lockNow = button("Lock now", { icon: "power" });
        lockNow.addEventListener("click", () => void act(lockNow, () => api.vault.lock(), "Vault locked"));
        const change = button("Change the passphrase…", {
          variant: "ghost",
          onclick: () => {
            pendingLock = "change";
            renderLock();
          },
        });
        body.append(h("div", { class: "form-actions vault-actions-start" }, lockNow, change));
      }
    }
    setChildren(lockCard, head("shield", "Lock", sub, state), body);
  }

  // ── What is kept ──

  function renderItems(): void {
    const count = info ? h("span", { class: "count" }, String(info.items.length)) : null;
    const top = head("key", "What's in the vault", "Names and sites only. The secrets themselves are never shown — not here, not anywhere.", count);
    if (!info) {
      setChildren(itemsCard, top, h("div", { class: "card-pad" }, failed ? null : skeletonLines(3)));
      return;
    }
    if (!info.items.length) {
      setChildren(itemsCard, top, emptyState({ icon: "shield", compact: true, title: "Nothing saved yet", body: "Add something below, or tell Trinity “save my Netflix password” — she opens a secure form for you to type it into." }));
      return;
    }
    const rows = info.items.map((m) => {
      const remove = button(null, { icon: "trash", size: "sm", variant: "ghost", title: `Remove ${m.label}` });
      remove.addEventListener("click", async () => {
        const ok = await confirmAction({
          title: `Remove “${m.label}” from the vault?`,
          message: "It is deleted from this computer for good. Trinity can't fill it in any more.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (ok) void act(remove, () => api.vault.removeItem(m.id), "Removed from the vault");
      });
      return h(
        "li",
        { class: "vault-item" },
        h("span", { class: "card-icon card-icon-muted" }, icon(KIND_ICON[m.kind])),
        h("div", { class: "vault-item-main" }, h("div", { class: "vault-item-name" }, m.label, " ", badge(KIND_LABEL[m.kind])), h("div", { class: "vault-item-meta" }, itemLine(m))),
        h("span", { class: "vault-item-used", title: m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleString() : "" }, m.lastUsedAt ? `used ${relTime(m.lastUsedAt)}` : "never used"),
        remove,
      );
    });
    setChildren(itemsCard, top, h("ul", { class: "vault-items" }, rows));
  }

  // ── Adding ──

  function renderAdd(force = false): void {
    const top = head("plus", "Add to the vault", "Typed here, it goes straight into the vault. You can also ask Trinity by voice: she opens the same form in the workspace.");
    if (!info) {
      setChildren(addCard, top, h("div", { class: "card-pad" }, failed ? null : skeletonLines(4)));
      addKey = "";
      return;
    }
    const key = `${addKind}|${usable()}|${whyNot()}`;
    if (key === addKey && !force) return; // what is being typed stays
    addKey = key;
    for (const c of addControls) c.input.value = "";
    const kinds = segmented({
      label: "What to add",
      value: addKind,
      options: (Object.keys(KIND_LABEL) as VaultKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], icon: KIND_ICON[k] })),
      onchange: (v) => {
        addKind = v as VaultKind;
        renderAdd();
      },
    });
    const body = h("div", { class: "card-pad form-stack" }, kinds.el);
    if (!usable()) {
      addControls = [];
      body.append(h("div", { class: "notice notice-info" }, icon("info"), h("span", null, whyNot())));
      setChildren(addCard, top, body);
      return;
    }
    addControls = (info.fields[addKind] ?? []).map(controlFor);
    const grid = h("div", { class: "vault-form" });
    for (const c of addControls) grid.append(c.row);
    // "Keep the security code" decides whether there is a security code to type.
    const keep = addControls.find((c) => c.field.type === "checkbox" && c.field.name === "keepCvc");
    const code = addControls.find((c) => c.field.type === "cvc");
    if (keep && code) {
      const sync = (): void => {
        code.row.hidden = !keep.input.checked;
        if (!keep.input.checked) code.input.value = "";
      };
      keep.input.addEventListener("change", sync);
      sync();
    }
    const save = button("Save in the vault", { variant: "primary", icon: "shield" });
    save.addEventListener("click", () => {
      const values: Record<string, string | boolean> = {};
      for (const c of addControls) {
        if (c.row.hidden) continue;
        const t = c.field.type;
        if (t === "checkbox") values[c.field.name] = c.input.checked;
        else if (t === "password" || t === "cvc" || t === "otp-secret") values[c.field.name] = c.input.value;
        else values[c.field.name] = t === "card-number" ? c.input.value.replace(/\D/g, "") : c.input.value.trim();
        if (c.field.required && !String(values[c.field.name]).trim()) {
          c.input.focus();
          return toast(`Fill in “${c.field.label}”.`, "warn");
        }
      }
      void (async () => {
        try {
          await withBusy(save, () => api.vault.addItem(addKind, values));
        } catch (err) {
          if (err instanceof ApiError && err.status === 423) void load();
          return; // what was typed stays, to be corrected
        } finally {
          for (const k of Object.keys(values)) values[k] = "";
        }
        toast("Saved in the vault", "success");
        renderAdd(true); // a fresh, empty form
        await load();
      })();
    });
    body.append(grid, h("div", { class: "form-actions" }, save));
    setChildren(addCard, top, body);
  }

  // ── Spending limit ──

  function renderLimit(): void {
    const top = head("target", "Spending limit", "A card is only ever filled in after you say yes. On a page whose total is above this limit — or can't be read — Trinity also asks in a secure form.");
    if (!info) {
      setChildren(limitCard, top, h("div", { class: "card-pad" }, failed ? null : skeletonLines(1)));
      return;
    }
    const input = h("input", { class: "input", type: "number", min: "0", max: "1000000", step: "1", value: String(info.settings.spendingLimit), id: "vault-limit" });
    const save = button("Save", { variant: "primary", disabled: !usable() });
    save.addEventListener("click", () => {
      const spendingLimit = Number(input.value);
      if (!Number.isFinite(spendingLimit) || spendingLimit < 0) return toast("The limit is an amount from 0 up.", "warn");
      void act(save, () => api.vault.settings({ spendingLimit }), "Spending limit saved");
    });
    setChildren(
      limitCard,
      top,
      h(
        "div",
        { class: "card-pad" },
        field({
          label: "Ask in a secure form above",
          id: "vault-limit",
          control: h("div", { class: "vault-row" }, h("div", { class: "input-unit vault-limit" }, input, h("span", { class: "unit" }, "amount")), save),
          hint: usable() ? "In the page's own currency. 0 means: always ask in the form." : whyNot(),
        }).el,
      ),
    );
  }

  // ── Linked browsers ──

  function renderBrowsers(): void {
    const linkBtn = button("Link another browser", { icon: "plus", size: "sm" });
    linkBtn.addEventListener("click", async () => {
      try {
        linkCode = await withBusy(linkBtn, () => api.linked.code());
        renderBrowsers();
      } catch {
        /* the request helper toasted */
      }
    });
    const top = head("monitor", "Linked browsers", "Only these browsers can talk to Trinity's engine — and so to the vault. The first one is linked by itself; every other needs a code.", linkBtn);
    const body = h("div", { class: "card-pad form-stack" });
    if (linkCode && linkCode.expiresAt > Date.now()) {
      body.append(
        h(
          "div",
          { class: "notice notice-info vault-code" },
          icon("key"),
          h(
            "span",
            null,
            "Open Trinity in the other browser and type this code: ",
            h("strong", { class: "vault-code-digits" }, `${linkCode.code.slice(0, 3)} ${linkCode.code.slice(3)}`),
            ` (good until ${new Date(linkCode.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}, for one browser).`,
          ),
        ),
      );
    }
    if (!browsers) {
      body.append(failed ? h("p", { class: "field-hint" }, "Couldn't load the list.") : skeletonLines(2));
    } else if (!browsers.length) {
      body.append(h("p", { class: "field-hint" }, "No browser is linked: the engine's sign-in checks are off, or this page is using the API key."));
    } else {
      const only = browsers.length === 1;
      body.append(
        h(
          "ul",
          { class: "vault-items vault-items-inset" },
          browsers.map((b) => {
            const unlink = button("Unlink", { size: "sm", variant: "ghost" });
            unlink.addEventListener("click", async () => {
              const ok = await confirmAction({
                title: `Unlink ${browserName(b.agent)}?`,
                message: only
                  ? "This is the only linked browser — very likely the one you are using. After this, the next browser to open Trinity is linked by itself."
                  : "It will need a link code to use Trinity again. If it is the browser you are using now, this page stops working until you enter one.",
                confirmLabel: "Unlink",
                danger: true,
              });
              if (!ok) return;
              try {
                await withBusy(unlink, () => api.linked.unlink(b.id));
                toast("Browser unlinked", "success");
              } catch {
                /* toasted */
              }
              void loadBrowsers();
            });
            return h(
              "li",
              { class: "vault-item" },
              h("span", { class: "card-icon card-icon-muted" }, icon("monitor")),
              h("div", { class: "vault-item-main" }, h("div", { class: "vault-item-name" }, browserName(b.agent)), h("div", { class: "vault-item-meta", title: b.agent }, `linked ${relTime(b.createdAt)} · last seen ${relTime(b.lastSeenAt)}`)),
              unlink,
            );
          }),
        ),
        h("p", { class: "field-hint" }, `${plural(browsers.length, "browser")} linked. “Last seen” is refreshed a few times a day.`),
      );
    }
    setChildren(browsersCard, top, body);
  }

  function render(): void {
    renderLock();
    renderItems();
    renderAdd();
    renderLimit();
    renderBrowsers();
  }

  async function loadBrowsers(): Promise<void> {
    try {
      browsers = (await api.linked.browsers({ quiet: true })).browsers;
    } catch {
      browsers = browsers ?? [];
    }
    renderBrowsers();
  }

  async function load(): Promise<void> {
    try {
      info = await api.vault.get({ quiet: true });
      failed = null;
    } catch (err) {
      failed = err instanceof ApiError && err.notAvailable ? "This engine has no vault yet: update and restart it." : err instanceof Error ? err.message : "The engine didn't answer.";
    }
    if (info && pendingLock && pendingLock !== "change" && pendingLock === info.status.lock) pendingLock = null;
    render();
    void loadBrowsers();
  }

  render();
  return {
    el,
    show() {
      void load();
    },
    hide() {
      // Nothing typed is left behind in a page that isn't on show.
      pendingLock = null;
      linkCode = null;
      for (const c of addControls) c.input.value = "";
      addKey = "";
      if (info) renderLock();
    },
    refresh() {
      void load();
    },
  };
}
