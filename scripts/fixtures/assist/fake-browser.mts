// A stand-in for the user's browser, for scripts/test-assist.mts: it implements the assistant tools' BrowserPort over
// the fixture pages in this folder. An address leads to a page (routes), a click on a named control leads to the page
// that follows (clicks), and every open, navigation, click and keystroke is written down (log) — so a test can say
// exactly what was pressed and typed, and that nothing else was.
//
// It also keeps the extension's own guard (extension/page.js): a control whose name carries a word like send, pay,
// delete or confirm is not pressed unless the click names it as approved — the click comes back `held`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActResult, BrowserPort, OpenedTab, PortControl, PortSnapshot } from "../../../server/src/services/assist/browser-port.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function fixturePage(name: string): PortSnapshot {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, `${name}.json`), "utf8")) as PortSnapshot;
  return { url: raw.url, title: raw.title, text: raw.text, controls: raw.controls.map((c) => ({ ...c })) };
}

/** The guard words of extension/page.js. */
export const GUARD =
  /\b(?:buy(?:s|ing)?|purchas(?:e|es|ed|ing)|pay(?:s|ing|ment|ments)?|(?:re)?order(?:s|ed|ing)?|checkout|check out|book(?:s|ed|ing)?|reserv(?:e|es|ed|ing|ation)|subscrib(?:e|es|ed|ing)|donat(?:e|es|ed|ing|ion)|bid(?:s|ding)?|transfer(?:s|red|ring)?|send(?:s|ing)?|post(?:s|ed|ing)?|publish(?:es|ed|ing)?|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|confirm(?:s|ed|ing)?|authori[sz](?:e|es|ed|ing)|allow(?:s|ed|ing)?|grant(?:s|ed|ing)?|accept(?:s|ed|ing)?|agree(?:s|d|ing)?|approv(?:e|es|ed|ing)|submit(?:s|ted|ting)?|unsubscrib(?:e|es|ed|ing)|sign out|log out|logout|apply|proceed|complete)\b/i;

export interface Action {
  kind: "open" | "navigate" | "click" | "type" | "press";
  tab: number;
  /** The page the tab was on (click, type, press) or landed on (open, navigate). */
  page: string;
  url?: string;
  /** open: an open tab was brought forward instead. */
  reused?: boolean;
  /** click, type: the control, by its name on the page. */
  name?: string;
  role?: string;
  /** type: what was typed. */
  text?: string;
  /** click: the name that came with it as approved. */
  approved?: string;
  /** click: the guard held it (nothing was pressed). */
  held?: boolean;
  key?: string;
}

const site = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.hostname}/${u.pathname.split("/").find(Boolean) ?? ""}`;
  } catch {
    return url;
  }
};

export class FakeBrowser implements BrowserPort {
  isConnected = true;
  log: Action[] = [];
  /** A page that stands in for another this run ("gmail-unread" → "gmail-unread-empty"). */
  swap = new Map<string, string>();
  /** Where an address leads: the first rule that matches. An address no rule knows is a blank page at that address. */
  routes: [RegExp, string][] = [
    [/^https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox$/, "gmail-inbox"],
    [/^https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/is%3Aunread\+in%3Ainbox$/, "gmail-unread"],
    [/#inbox\/FMfcgzQXKWgkRoadmapQ1$/, "gmail-message-roadmap"],
    [/#inbox\/FMfcgzQXKWgkVerifyNow$/, "gmail-message-phish"],
    [/#inbox\/FMfcgzQXKWgkInvoice1042$/, "gmail-message-invoice"],
    [/^https:\/\/outlook\.live\.com\/mail\/0\/?$/, "outlook-inbox"],
    [/^https:\/\/outlook\.live\.com\/mail\/0\/inbox\/id\//, "outlook-message-roadmap"],
    [/^https:\/\/calendar\.google\.com\/calendar\/u\/0\/r\/day\/2026\/11\/11$/, "gcal-day"],
    [/^https:\/\/calendar\.google\.com\/calendar\/(?:u\/\d+\/)?render\?action=TEMPLATE/, "gcal-eventedit"],
    [/^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose\?/, "outlook-event"],
  ];
  /** What a click leads to: [the page it is on, the control's name, the page that follows]. Anything else stays put. */
  clicks: [RegExp, RegExp, string][] = [
    [/^gmail-(?:inbox|unread)$/, /^Roadmap for Q1\b/, "gmail-message-roadmap"],
    [/^gmail-(?:inbox|unread)$/, /^Verify your account now\b/, "gmail-message-phish"],
    [/^gmail-(?:inbox|unread)$/, /^Re: Invoice 1042\b/, "gmail-message-invoice"],
    [/^gmail-(?:inbox|unread|sent)$/, /^Compose$/, "gmail-compose"],
    [/^gmail-message-roadmap$/, /^Reply$/, "gmail-reply"],
    [/^gmail-(?:compose|reply)$/, /^Send$/, "gmail-sent"],
    [/^outlook-inbox$/, /Sam Lee Roadmap for Q1/, "outlook-message-roadmap"],
    [/^outlook-(?:inbox|message-roadmap)$/, /^New mail$/, "outlook-compose"],
    [/^outlook-compose$/, /^Send$/, "outlook-inbox"],
    [/^gcal-eventedit$/, /^Save$/, "gcal-saved"],
    [/^gcal-invite-dialog$/, /^(?:Send|Don't send)$/, "gcal-saved"],
    [/^outlook-event$/, /^Send$/, "outlook-inbox"],
  ];
  private tabs = new Map<number, { page: string; url: string | null }>();
  private nextTab = 1;
  private pages = new Map<string, PortSnapshot>();

  private load(name: string): PortSnapshot {
    let p = this.pages.get(name);
    if (!p) {
      p = fixturePage(name);
      this.pages.set(name, p);
    }
    return p;
  }

  private pageFor(url: string): { page: string; url: string | null } {
    const rule = this.routes.find(([re]) => re.test(url));
    if (!rule) return { page: "blank", url };
    const name = this.swap.get(rule[1]) ?? rule[1];
    // A form opened from a link keeps that link as its address.
    return { page: name, url: /^(?:gcal-eventedit|outlook-event)$/.test(name) ? url : null };
  }

  private shot(tabId: number): PortSnapshot {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("that tab is gone");
    if (tab.page === "blank") return { url: tab.url ?? "about:blank", title: "", text: "", controls: [] };
    const p = this.load(tab.page);
    return { url: tab.url ?? p.url, title: p.title, text: p.text, controls: p.controls.map((c) => ({ ...c })) };
  }

  /** The page a tab is on (a fixture's name). */
  pageOf(tabId: number): string {
    return this.tabs.get(tabId)?.page ?? "";
  }
  /** Put a tab on a page by hand (the user did something in their browser). */
  setPage(tabId: number, page: string): void {
    if (!this.tabs.has(tabId)) throw new Error(`no tab ${tabId} to put on ${page}`);
    this.tabs.set(tabId, { page, url: null });
  }
  /** Close every tab and forget the log: the next tab opened is tab 1 again. */
  reset(): void {
    this.tabs.clear();
    this.nextTab = 1;
    this.log = [];
    this.swap.clear();
    this.isConnected = true;
  }
  /** What was done since `from` (an index into the log), of the given kinds. */
  since(from: number, ...kinds: Action["kind"][]): Action[] {
    return this.log.slice(from).filter((a) => !kinds.length || kinds.includes(a.kind));
  }

  connected(): boolean {
    return this.isConnected;
  }

  async open(url: string, opts: { reuse?: boolean } = {}): Promise<OpenedTab> {
    if (!this.isConnected) throw new Error("the browser extension isn't connected");
    if (opts.reuse) {
      for (const [id] of this.tabs) {
        const at = this.shot(id).url;
        if (site(at) === site(url)) {
          this.log.push({ kind: "open", tab: id, page: this.pageOf(id), url, reused: true });
          return { tabId: id, reused: true, url: at };
        }
      }
    }
    const id = this.nextTab++;
    this.tabs.set(id, this.pageFor(url));
    this.log.push({ kind: "open", tab: id, page: this.pageOf(id), url, reused: false });
    return { tabId: id, reused: false, url };
  }

  async navigate(tabId: number, url: string): Promise<void> {
    if (!this.tabs.has(tabId)) throw new Error("that tab is gone");
    this.tabs.set(tabId, this.pageFor(url));
    this.log.push({ kind: "navigate", tab: tabId, page: this.pageOf(tabId), url });
  }

  async snapshot(tabId: number): Promise<PortSnapshot> {
    return this.shot(tabId);
  }

  private control(tabId: number, ref: number): PortControl | null {
    return this.shot(tabId).controls.find((c) => c.ref === ref) ?? null;
  }

  async click(tabId: number, ref: number, opts: { approved?: string } = {}): Promise<ActResult> {
    const page = this.pageOf(tabId);
    const c = this.control(tabId, ref);
    if (!c) return { ok: false, error: "no such element" };
    const entry: Action = { kind: "click", tab: tabId, page, name: c.name, role: c.role, ...(opts.approved !== undefined ? { approved: opts.approved } : {}) };
    this.log.push(entry);
    if (GUARD.test(c.name) && opts.approved !== c.name) {
      entry.held = true;
      return { ok: false, held: true, error: "the browser held that click" };
    }
    const rule = this.clicks.find(([on, name]) => on.test(page) && name.test(c.name));
    if (rule) this.tabs.set(tabId, { page: this.swap.get(rule[2]) ?? rule[2], url: null });
    return { ok: true };
  }

  async type(tabId: number, ref: number, text: string): Promise<ActResult> {
    const page = this.pageOf(tabId);
    const c = this.control(tabId, ref);
    if (!c) return { ok: false, error: "no such element" };
    if (!c.editable) return { ok: false, error: "that isn't a text field" };
    this.log.push({ kind: "type", tab: tabId, page, name: c.name, role: c.role, text });
    return { ok: true };
  }

  async press(tabId: number, key: string): Promise<ActResult> {
    this.log.push({ kind: "press", tab: tabId, page: this.pageOf(tabId), key });
    return { ok: true };
  }

  async waitFor(tabId: number, predicate: (s: PortSnapshot) => boolean): Promise<PortSnapshot | null> {
    // The fixture pages don't load slowly: what is there now is what there will be.
    try {
      const s = this.shot(tabId);
      return predicate(s) ? s : null;
    } catch {
      return null;
    }
  }
}
