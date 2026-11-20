// Browser extension: the state of the Trinity Browser Bridge in Chrome (paired? connected? which tabs?), pairing it
// with a one-time code, how to install it, and what Trinity can do with it.
//
// Pairing: this page asks the engine for a code and shows it; the user types it into the extension's popup. The code
// works once, for ten minutes, and nothing else on this page is secret — the engine never hands out a key or a token.

import { api, type BrowserInfo, type BrowserPairingCode } from "./api.js";
import { button, confirmAction, h, icon, sectionHead, setChildren, toast, type Section } from "./ui.js";

const POLL_MS = 3000;

const SAY: [string, string][] = [
  ["Open things", "“Open YouTube”, “go to amazon dot com”, “search for running shoes on Amazon”, “google the weather in Lisbon”, “new tab”"],
  ["Tabs and windows", "“Close this tab”, “close the other tabs”, “close the tab with the recipe”, “switch to the Gmail tab”, “pin this tab”, “mute the YouTube tab”, “move this tab to a new window”, “group the YouTube tabs”, “reopen the closed tab”, “new window”, “go back”, “zoom in”, “which tabs are open?”"],
  ["Read", "“Read this page”, “summarize this article”, “what does this page say about shipping?”, “read the selected text”"],
  ["Act", "“Click sign in”, “type blue shoes in the search box”, “search this page for muffins”, “scroll down”, “press enter”, “press tab”, “choose large”"],
  ["Sign in and fill", "“Sign in”, “log me in”, “use my saved password”, “fill in my card”, “fill in my details” — from the vault (Settings → Vault); what is filled is never spoken, shown or sent to a model"],
  ["Change the page", "“Make this page dark mode”, “hide the ads”, “reader mode”, “make the text bigger”, “add a banner at the top saying hello”, “undo the changes”"],
  ["Save", "“Save this page”, “save the article as a text file”, “download this image”, “save a screenshot”"],
  ["Put on the board", "“Put this page on the board”, “put the selected text on the board”, “put a screenshot of this on the board” — or right-click any page, selection, link or image → Put … on Trinity's board"],
];

/** "ABCD-EFGH": easier to read across to another window than eight letters in a row. */
const grouped = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const codeNote = (c: BrowserPairingCode): string => `Type it into the Trinity popup in Chrome. Good for ${clock(c.expiresAt - Date.now())}, for one pairing, ${c.tries} tries.`;

export function createBrowserSection(): Section {
  let info: BrowserInfo | null = null;
  let failed = false;
  let timer: number | null = null;
  let tick: number | null = null;
  /**
   * The code this page asked for, while it is still good. It lives here only: reloading the page forgets it.
   * `madeWith` is the pairing that stood when it was made (a different one since means the code was used);
   * `seenLive` is set once the engine has confirmed the code is waiting (so its vanishing means it was used up).
   */
  let pairing: (BrowserPairingCode & { madeWith: number | null; seenLive: boolean }) | null = null;
  /** What the pairing card was last drawn from: it is redrawn only when that changes (so a click is never lost to a redraw). */
  let pairDrawn = "";

  const statusCard = h("div", { class: "card" });
  const pairCard = h("div", { class: "card" });
  const sayCard = h("div", { class: "card" });
  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-browser" },
    sectionHead({
      id: "sec-browser",
      title: "Browser extension",
      lede: "Let Trinity control your Chrome — the whole browser: tabs and windows, reading pages, clicking and typing, signing in and filling forms from her vault, restyling a site, saving files — and bring pages, pictures and selections onto her workspace board. Everything stays on this computer.",
    }),
    h("div", { class: "heartbeat-stack" }, statusCard, pairCard, sayCard),
  );

  function head(name: Parameters<typeof icon>[0], title: string, sub: string, side?: HTMLElement | null): HTMLElement {
    return h(
      "div",
      { class: "card-head" },
      h("span", { class: "card-icon" }, icon(name)),
      h("div", { class: "card-head-text" }, h("h2", { class: "card-title" }, title), h("p", { class: "card-sub" }, sub)),
      side ?? null,
    );
  }

  function renderStatus(): void {
    const connected = Boolean(info?.connected);
    const paired = Boolean(info?.paired);
    const badge = h(
      "span",
      { class: ["badge", connected ? "badge-ok" : failed ? "badge-danger" : "badge-warn"] },
      h("span", { class: ["status-dot", connected ? "is-accent" : ""] }),
      connected ? "Connected" : failed ? "Engine unreachable" : paired ? "Paired, not connected" : "Not paired",
    );
    const sub = connected
      ? `Chrome ${info!.chrome || "?"} · extension v${info!.version || "?"} · ${info!.tabs.length} tab${info!.tabs.length === 1 ? "" : "s"} open · JavaScript on strict sites: ${info!.caps.userScripts ? "on" : "off (turn on “Allow User Scripts” in the extension's details)"}`
      : paired
        ? "The extension is paired but not connected right now. Is Chrome open? Click the Trinity icon there: it says why."
        : "Install the extension in Chrome and pair it with a code from the card below; this page updates on its own.";
    const body = connected
      ? h(
          "ul",
          { class: "browser-tabs" },
          info!.tabs.slice(0, 12).map((t) =>
            h(
              "li",
              { class: t.active ? "is-active" : "" },
              h("span", { class: "browser-tab-title" }, t.title || t.host || "untitled"),
              h("span", { class: "browser-tab-host" }, t.host),
              t.own ? h("span", { class: "badge" }, "Trinity's own") : null,
              t.active ? h("span", { class: "badge badge-accent" }, "active") : null,
            ),
          ),
          info!.tabs.length > 12 ? h("li", { class: "browser-tab-more" }, `and ${info!.tabs.length - 12} more`) : null,
        )
      : h(
          "ol",
          { class: "browser-steps" },
          h("li", null, "In Chrome, open ", h("code", null, "chrome://extensions"), " and turn on ", h("strong", null, "Developer mode"), " (top right)."),
          h("li", null, "Click ", h("strong", null, "Load unpacked"), " and choose the folder ", h("code", { class: "browser-path" }, info?.extensionDir ?? "…/Trinity2/extension"), ". (Already loaded? Press its reload arrow after an update.)"),
          h("li", null, "Press ", h("strong", null, "Show a pairing code"), " below, click the Trinity icon in Chrome's toolbar (pin it from the puzzle-piece menu), type the code and press ", h("strong", null, "Pair"), "."),
          h("li", null, "Optional: in the extension's ", h("strong", null, "Details"), " page turn on ", h("strong", null, "Allow User Scripts"), " so Trinity can run JavaScript on sites that block injected scripts. Styling changes work everywhere regardless."),
        );
    setChildren(statusCard, head("monitor", "Chrome", sub, badge), h("div", { class: "browser-body" }, body));
  }

  function stopTick(): void {
    if (tick !== null) window.clearInterval(tick);
    tick = null;
  }

  function renderPair(): void {
    // A code is gone once it has run out, once it was used (another pairing stands than when it was made), or once the
    // engine no longer holds it (five wrong tries).
    if (pairing && info) {
      if (info.codeExpiresAt !== null) pairing.seenLive = true;
      if (info.pairedAt !== pairing.madeWith) {
        pairing = null;
        if (info.paired) toast("The extension is paired", "success");
      } else if (pairing.seenLive && info.codeExpiresAt === null) {
        pairing = null;
        toast("That pairing code was used up. Make a new one.", "warn");
      }
    }
    if (pairing && Date.now() >= pairing.expiresAt) pairing = null;
    if (!pairing) stopTick();
    const paired = Boolean(info?.paired);
    const drawnFrom = JSON.stringify([paired, info?.extensionId ?? null, info?.pairedAt ?? null, pairing?.code ?? null]);
    if (drawnFrom === pairDrawn) return;
    pairDrawn = drawnFrom;
    const make = button(pairing ? "New code" : paired ? "Pair again" : "Show a pairing code", {
      icon: "key",
      size: "sm",
      variant: pairing || paired ? "default" : "primary",
      title: "A one-time code to type into the extension's popup. Any earlier code stops working.",
      onclick: async () => {
        try {
          const made = await api.browser.pairingCode();
          pairing = { ...made, madeWith: info?.pairedAt ?? null, seenLive: false };
          renderPair();
          stopTick();
          // The countdown: only its own words change each second.
          tick = window.setInterval(() => {
            const note = pairCard.querySelector(".browser-code-note");
            if (!pairing || Date.now() >= pairing.expiresAt) renderPair();
            else if (note) note.textContent = codeNote(pairing);
          }, 1000);
        } catch {
          /* the request helper toasted */
        }
      },
    });
    const forget = paired
      ? button("Forget this extension", {
          icon: "trash",
          size: "sm",
          variant: "ghost",
          title: "Disconnect the extension; it can't come back without a new code",
          onclick: async () => {
            const ok = await confirmAction({
              title: "Forget the paired extension?",
              message: "It is disconnected at once and can't use Trinity again until you pair it with a new code.",
              confirmLabel: "Forget it",
              danger: true,
            });
            if (!ok) return;
            try {
              await api.browser.unpair();
              pairing = null;
              pairDrawn = "";
              toast("The extension is forgotten", "success");
              void load();
            } catch {
              /* the request helper toasted */
            }
          },
        })
      : null;
    const codeBox = pairing
      ? h(
          "div",
          { class: "browser-code", role: "status", "aria-live": "polite" },
          h("span", { class: "browser-code-value", "aria-label": `Pairing code ${pairing.code.split("").join(" ")}` }, grouped(pairing.code)),
          h("span", { class: "browser-code-note" }, codeNote(pairing)),
        )
      : null;
    const state = paired
      ? `Paired${info?.pairedAt ? ` since ${new Date(info.pairedAt).toLocaleDateString()}` : ""} with extension ${info?.extensionId ? `${info.extensionId.slice(0, 8)}…` : ""}. Only that extension can connect, and each side proves the pairing key on every connection.`
      : "Not paired yet. Until it is, nothing can use Trinity's browser channel.";
    setChildren(
      pairCard,
      head("key", "Pairing", "The extension and Trinity are paired once, with a code you carry across by hand. After that each proves to the other that it holds the key — no token is stored or shown anywhere."),
      h(
        "div",
        { class: "browser-body" },
        codeBox,
        h("div", { class: "browser-token" }, make, forget),
        h("p", { class: "field-hint" }, state),
        h("p", { class: "field-hint" }, "The extension connects to the engine at ", h("code", null, "ws://127.0.0.1:8799"), " on this computer only. While it is connected, Trinity controls the whole browser, including the sites you are signed in to."),
      ),
    );
  }

  function renderSay(): void {
    setChildren(
      sayCard,
      head("mic", "What you can say", "Once connected, Trinity's browser tools are offered to Jev along with everything else."),
      h(
        "div",
        { class: "browser-body" },
        h(
          "dl",
          { class: "browser-say" },
          SAY.map(([k, v]) => [h("dt", null, k), h("dd", null, v)]),
        ),
        h(
          "p",
          { class: "field-hint" },
          "Kept safe whatever a page says: Trinity treats page text as data rather than instructions; never reads, lists or types into password, one-time-code or card fields (signing in and filling go through the vault, sealed for one tab and one site); presses a button that buys, pays, sends, deletes or confirms only when you said so yourself — and one that spends only after you answer “yes” to a question naming the site and the total; leaves her own tabs and Chrome's own pages alone.",
        ),
      ),
    );
  }

  function render(): void {
    renderStatus();
    renderPair();
    renderSay();
  }

  async function load(): Promise<void> {
    try {
      info = await api.browser.get({ quiet: true });
      failed = false;
    } catch {
      failed = true;
    }
    render();
  }

  render();
  return {
    el,
    show() {
      void load();
      if (timer === null) timer = window.setInterval(() => void load(), POLL_MS);
    },
    hide() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      stopTick();
    },
    refresh() {
      void load();
    },
  };
}
