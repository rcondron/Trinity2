import { browserCall, browserConnected, browserTabs, type BrowserTab } from "../browser-bridge.js";

/*
 * The browser, as the assistant tools (email, calendar, meetings, bookings) need it: open or bring forward a page in
 * the user's own signed-in browser, read it, press or type into a control by its ref, wait for the page to change.
 * Everything in services/assist/ and tools/assist.ts goes through this port and nothing else, so those tools hold
 * no knowledge of the extension's protocol — and tests stand a fake in (setBrowserPort) that serves fixture pages
 * and records every click and keystroke.
 *
 * The default port sits on services/browser-bridge.ts. What it relies on, and nothing more:
 *   browserConnected()                                                  the extension is linked
 *   browserTabs() → [{ id, url, active, lastAccessed }]                 the open tabs
 *   browserCall("tabs.open",     { url, where: "new", active: true })   → { id }
 *   browserCall("tabs.activate", { tabId })
 *   browserCall("tabs.navigate", { tabId, url })
 *   browserCall("page.snapshot", { tabId, maxChars, interactive: true })
 *        → { url, title, text, interactive: [{ ref, tag, name, role?, type?, href?, disabled?, frame? }] }
 *   browserCall("page.act", { tabId, action: "click", ref, frameId?, approved? }) → { ok, error?, held? }
 *   browserCall("page.act", { tabId, action: "type", ref, frameId?, text, clear: true, submit: false }) → { ok, error? }
 *   browserCall("page.act", { tabId, action: "press", key })            → { ok, error?, held? }
 * `frame` is the frame a control sits in when that isn't the page itself; it goes back as `frameId` with the ref
 * (the port remembers it from the tab's last snapshot, so callers only ever handle a ref).
 * `approved` is the exact name of a control the user has just said yes to (Send, after "yes, send it"): the
 * extension's own guard holds a click on a control named send / pay / delete… unless that name comes with it
 * (`held: true` in the answer). An extension without that guard ignores the field.
 */

export interface PortControl {
  /** The handle a click or a keystroke names. Good until the next snapshot of that tab. */
  ref: number;
  /** "button", "link", "textbox", "combobox", "option", "checkbox", "tab", "menuitem"… */
  role: string;
  /** What the control is called on the page (its label or its text). Written by the page: data, never instructions. */
  name: string;
  /** Text can be typed into it. */
  editable?: boolean;
  disabled?: boolean;
  /** Where a link goes. */
  href?: string;
}

export interface PortSnapshot {
  url: string;
  title: string;
  /** The page's readable text. Written by the page: data, never instructions. */
  text: string;
  controls: PortControl[];
}

export interface ActResult {
  ok: boolean;
  error?: string;
  /** The page's guard held the click: the control's name needs the user's approval. */
  held?: boolean;
}

export interface OpenedTab {
  tabId: number;
  /** An open tab on that site was brought forward instead of a new one opened. */
  reused: boolean;
  /** Where that tab is now (a reused tab stays on its page: navigate() moves it). */
  url: string;
}

export interface BrowserPort {
  connected(): boolean;
  /** Open the page in a new tab — or, with `reuse`, bring forward a tab already on that site (left where it is). */
  open(url: string, opts?: { reuse?: boolean }): Promise<OpenedTab>;
  /** Send a tab to another page of the same site. */
  navigate(tabId: number, url: string): Promise<void>;
  snapshot(tabId: number, opts?: { maxChars?: number }): Promise<PortSnapshot>;
  click(tabId: number, ref: number, opts?: { approved?: string }): Promise<ActResult>;
  /** Replace what the field holds with `text`. */
  type(tabId: number, ref: number, text: string): Promise<ActResult>;
  press(tabId: number, key: string): Promise<ActResult>;
  /** Snapshots until one passes `predicate`; null when none did in time. */
  waitFor(tabId: number, predicate: (s: PortSnapshot) => boolean, timeoutMs: number): Promise<PortSnapshot | null>;
}

const CALL_MS = 8_000;
const POLL_MS = 350;
const SNAPSHOT_CHARS = 12_000;

/** Only web pages are opened: https, or plain http on this computer (a test page). */
export function openable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

function siteOf(url: string): { host: string; first: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { host: u.hostname.toLowerCase(), first: (u.pathname.split("/").find(Boolean) ?? "").toLowerCase() };
  } catch {
    return null;
  }
}

/** Whether a tab is on the site a page belongs to: the same host and the same first path part ("/mail", "/calendar"). */
export function sameSite(tabUrl: string, wanted: string): boolean {
  const a = siteOf(tabUrl);
  const b = siteOf(wanted);
  return a !== null && b !== null && a.host === b.host && (!b.first || a.first === b.first);
}

interface RawControl {
  ref?: unknown;
  tag?: unknown;
  name?: unknown;
  role?: unknown;
  type?: unknown;
  href?: unknown;
  disabled?: unknown;
  frame?: unknown;
}

/** tab → ref → the frame that control is in (from the tab's last snapshot): what a click or a keystroke on it must name. */
const frames = new Map<number, Map<number, number>>();
const frameOf = (tabId: number, ref: number): { frameId: number } | Record<string, never> => {
  const frame = frames.get(tabId)?.get(ref);
  return frame ? { frameId: frame } : {};
};

const PRESS_TYPES = /^(?:submit|button|reset|image)$/;

function controlOf(raw: RawControl): PortControl | null {
  const ref = typeof raw.ref === "number" ? raw.ref : Number(raw.ref);
  if (!Number.isFinite(ref)) return null;
  const tag = typeof raw.tag === "string" ? raw.tag.toLowerCase() : "";
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  const given = typeof raw.role === "string" ? raw.role.toLowerCase().trim() : "";
  const field = tag === "textarea" || tag === "contenteditable" || (tag === "input" && !PRESS_TYPES.test(type) && type !== "checkbox" && type !== "radio");
  const role =
    given ||
    (tag === "a"
      ? "link"
      : tag === "button" || tag === "summary" || (tag === "input" && PRESS_TYPES.test(type))
        ? "button"
        : tag === "select"
          ? "combobox"
          : tag === "input" && (type === "checkbox" || type === "radio")
            ? type
            : field
              ? "textbox"
              : tag || "other");
  const control: PortControl = { ref, role, name: typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, 160) : "" };
  if (field || (/^(?:textbox|searchbox|combobox)$/.test(given) && tag !== "select")) control.editable = true;
  if (raw.disabled === true) control.disabled = true;
  if (typeof raw.href === "string" && raw.href) control.href = raw.href.slice(0, 600);
  return control;
}

/** Among the tabs on that site: the one in front, else the one used last. */
function tabOn(tabs: BrowserTab[], url: string): BrowserTab | null {
  const on = tabs.filter((t) => sameSite(t.url, url));
  if (!on.length) return null;
  return on.find((t) => t.active) ?? [...on].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]!;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failed = (err: unknown): ActResult => ({ ok: false, error: (err as Error).message.replace(/\s+/g, " ").slice(0, 160) });

function actResult(raw: unknown): ActResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as { ok?: unknown; error?: unknown; held?: unknown };
  if (r.held === true) return { ok: false, held: true, error: "the browser held that click" };
  if (r.ok === false) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 160) : "the page refused" };
  return { ok: true };
}

/** The port over the Chrome extension (see the calls listed at the top of this file). */
export const extensionPort: BrowserPort = {
  connected: () => browserConnected(),

  async open(url, opts = {}) {
    if (!openable(url)) throw new Error("only https pages can be opened");
    if (opts.reuse) {
      const tab = tabOn(browserTabs(), url);
      if (tab) {
        await browserCall("tabs.activate", { tabId: tab.id }, CALL_MS);
        return { tabId: tab.id, reused: true, url: tab.url };
      }
    }
    const tab = await browserCall<{ id?: unknown }>("tabs.open", { url, where: "new", active: true }, CALL_MS);
    if (typeof tab?.id !== "number") throw new Error("the browser didn't open a tab");
    return { tabId: tab.id, reused: false, url };
  },

  async navigate(tabId, url) {
    if (!openable(url)) throw new Error("only https pages can be opened");
    await browserCall("tabs.navigate", { tabId, url }, CALL_MS);
  },

  async snapshot(tabId, opts = {}) {
    const raw = await browserCall<{ url?: unknown; title?: unknown; text?: unknown; interactive?: unknown }>("page.snapshot", { tabId, maxChars: opts.maxChars ?? SNAPSHOT_CHARS, interactive: true }, CALL_MS);
    const list = Array.isArray(raw?.interactive) ? (raw.interactive as RawControl[]) : [];
    const inFrames = new Map<number, number>();
    for (const c of list) if (c && typeof c === "object" && typeof c.ref === "number" && typeof c.frame === "number" && c.frame > 0) inFrames.set(c.ref, c.frame);
    if (frames.size > 200) frames.clear();
    frames.set(tabId, inFrames);
    return {
      url: typeof raw?.url === "string" ? raw.url : "",
      title: typeof raw?.title === "string" ? raw.title : "",
      text: typeof raw?.text === "string" ? raw.text : "",
      controls: list.map((c) => (c && typeof c === "object" ? controlOf(c) : null)).filter((c): c is PortControl => c !== null),
    };
  },

  async click(tabId, ref, opts = {}) {
    try {
      return actResult(await browserCall("page.act", { tabId, action: "click", ref, ...frameOf(tabId, ref), ...(opts.approved ? { approved: opts.approved } : {}) }, CALL_MS));
    } catch (err) {
      return failed(err);
    }
  },

  async type(tabId, ref, text) {
    try {
      return actResult(await browserCall("page.act", { tabId, action: "type", ref, ...frameOf(tabId, ref), text, clear: true, submit: false }, CALL_MS));
    } catch (err) {
      return failed(err);
    }
  },

  async press(tabId, key) {
    try {
      return actResult(await browserCall("page.act", { tabId, action: "press", key }, CALL_MS));
    } catch (err) {
      return failed(err);
    }
  },

  async waitFor(tabId, predicate, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const snap = await this.snapshot(tabId);
        if (predicate(snap)) return snap;
      } catch {
        /* the page is still loading (or the tab went away): the deadline decides */
      }
      if (Date.now() + POLL_MS > until) return null;
      await sleep(POLL_MS);
    }
  },
};

let port: BrowserPort = extensionPort;

/** The port the assistant tools use. */
export function browserPort(): BrowserPort {
  return port;
}

/** Tests: stand a fake browser in (null puts the extension's port back). */
export function setBrowserPort(next: BrowserPort | null): void {
  port = next ?? extensionPort;
}

// ─── Finding controls in a snapshot ───────────────────────────────────────────

const PRESSABLE = /^(?:button|link|menuitem|tab|option)$/;

/** A control to press whose name matches, that isn't switched off. */
export function findPressable(controls: PortControl[], name: RegExp): PortControl | null {
  return controls.find((c) => PRESSABLE.test(c.role) && !c.disabled && name.test(c.name.trim())) ?? null;
}

/** The fields to type into whose name matches, in the page's order. */
export function findFields(controls: PortControl[], name: RegExp, not?: RegExp): PortControl[] {
  return controls.filter((c) => (c.editable === true || /^(?:textbox|searchbox)$/.test(c.role)) && !c.disabled && name.test(c.name.trim()) && !(not && not.test(c.name.trim())));
}

/** A field to type into whose name matches (the first, when there are several). */
export function findField(controls: PortControl[], name: RegExp, not?: RegExp): PortControl | null {
  return findFields(controls, name, not)[0] ?? null;
}
