// Browser extension: the state of the Trinity Browser Bridge in Chrome (connected? which tabs?), the
// pairing token it needs, how to install it, and what Trinity can do with it.

import { api, type BrowserInfo } from "./api.js";
import { button, confirmAction, h, icon, sectionHead, setChildren, toast, type Section } from "./ui.js";

const POLL_MS = 3000;

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") ? u.hostname.replace(/^www\./, "") : u.protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

const SAY: [string, string][] = [
  ["Open things", "“Open YouTube”, “go to amazon dot com”, “search for running shoes on Amazon”, “google the weather in Lisbon”, “new tab”"],
  ["Tabs", "“Close this tab”, “close the other tabs”, “switch to the Gmail tab”, “next tab”, “go back”, “reload”, “zoom in”, “which tabs are open?”"],
  ["Read", "“Read this page”, “summarize this article”, “what does this page say about shipping?”, “read the selected text”"],
  ["Act", "“Click sign in”, “type blue shoes in the search box”, “search this page for muffins”, “scroll down”, “press enter”, “choose large”"],
  ["Change the page", "“Make this page dark mode”, “hide the ads”, “reader mode”, “make the text bigger”, “add a banner at the top saying hello”, “undo the changes”"],
  ["Save", "“Save this page”, “save the article as a text file”, “download this image”, “save a screenshot”"],
  ["Put on the board", "“Put this page on the board”, “put the selected text on the board”, “put a screenshot of this on the board” — or right-click any page, selection, link or image → Put … on Trinity's board"],
];

export function createBrowserSection(): Section {
  let info: BrowserInfo | null = null;
  let failed = false;
  let timer: number | null = null;
  let showToken = false;

  const statusCard = h("div", { class: "card" });
  const pairCard = h("div", { class: "card" });
  const sayCard = h("div", { class: "card" });
  const el = h(
    "section",
    { class: "section", "aria-labelledby": "sec-browser" },
    sectionHead({
      id: "sec-browser",
      title: "Browser extension",
      lede: "Let Trinity drive your Chrome: open and close tabs, read pages, click and type, restyle or script a site, save files — and bring pages, pictures and selections onto her workspace board. Everything stays on this computer.",
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
    const badge = h(
      "span",
      { class: ["badge", connected ? "badge-ok" : failed ? "badge-danger" : "badge-warn"] },
      h("span", { class: ["status-dot", connected ? "is-accent" : ""] }),
      connected ? "Connected" : failed ? "Engine unreachable" : "Not connected",
    );
    const sub = connected
      ? `Chrome ${info!.chrome || "?"} · extension v${info!.version || "?"} · ${info!.tabs.length} tab${info!.tabs.length === 1 ? "" : "s"} open · JavaScript on strict sites: ${info!.caps.userScripts ? "on" : "off (turn on “Allow User Scripts” in the extension's details)"}`
      : "Install the extension in Chrome and pair it with the token below; this page updates on its own.";
    const body = connected
      ? h(
          "ul",
          { class: "browser-tabs" },
          info!.tabs.slice(0, 12).map((t) =>
            h(
              "li",
              { class: t.active ? "is-active" : "" },
              h("span", { class: "browser-tab-title" }, t.title || hostOf(t.url) || "untitled"),
              h("span", { class: "browser-tab-host" }, hostOf(t.url)),
              t.active ? h("span", { class: "badge badge-accent" }, "active") : null,
            ),
          ),
          info!.tabs.length > 12 ? h("li", { class: "browser-tab-more" }, `and ${info!.tabs.length - 12} more`) : null,
        )
      : h(
          "ol",
          { class: "browser-steps" },
          h("li", null, "In Chrome, open ", h("code", null, "chrome://extensions"), " and turn on ", h("strong", null, "Developer mode"), " (top right)."),
          h("li", null, "Click ", h("strong", null, "Load unpacked"), " and choose the folder ", h("code", { class: "browser-path" }, info?.extensionDir ?? "…/Trinity2/extension"), "."),
          h("li", null, "Click the Trinity icon in Chrome's toolbar (pin it from the puzzle-piece menu), open ", h("strong", null, "Connection"), ", paste the token below and press ", h("strong", null, "Save & connect"), "."),
          h("li", null, "Optional: in the extension's ", h("strong", null, "Details"), " page turn on ", h("strong", null, "Allow User Scripts"), " so Trinity can run JavaScript on sites that block injected scripts. Styling changes work everywhere regardless."),
        );
    setChildren(statusCard, head("monitor", "Chrome", sub, badge), h("div", { class: "browser-body" }, body));
  }

  function renderPair(): void {
    const token = info?.token ?? "";
    const input = h("input", { class: "input browser-token-input", type: showToken ? "text" : "password", value: token, readOnly: true, "aria-label": "Pairing token", spellcheck: false }) as HTMLInputElement;
    const show = button(showToken ? "Hide" : "Show", {
      size: "sm",
      onclick: () => {
        showToken = !showToken;
        renderPair();
      },
    });
    const copy = button("Copy", {
      icon: "copy",
      size: "sm",
      disabled: !token,
      onclick: () => {
        void navigator.clipboard?.writeText(token).then(
          () => toast("Token copied — paste it into the extension's popup", "success"),
          () => toast("Couldn't copy — show the token and select it instead", "warn"),
        );
      },
    });
    const rotate = button("New token", {
      icon: "refresh",
      size: "sm",
      variant: "ghost",
      title: "Make a new token; the connected extension is dropped until it gets the new one",
      onclick: async () => {
        const ok = await confirmAction({
          title: "Make a new pairing token?",
          message: "The extension in Chrome will disconnect until you paste the new token into its popup.",
          confirmLabel: "New token",
          danger: true,
        });
        if (!ok) return;
        try {
          const r = await api.browser.rotateToken();
          if (info) info.token = r.token;
          showToken = true;
          renderPair();
          toast("New token made — paste it into the extension", "success");
        } catch {
          /* the request helper toasted */
        }
      },
    });
    setChildren(
      pairCard,
      head("key", "Pairing", "The extension proves it's yours with this token; nothing else can talk to Trinity's browser channel."),
      h(
        "div",
        { class: "browser-body" },
        h("div", { class: "browser-token" }, input, show, copy, rotate),
        h("p", { class: "field-hint" }, "The extension keeps the token in Chrome's own storage. It connects to the engine at ", h("code", null, "ws://127.0.0.1:8799"), " on this computer only."),
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
        h("p", { class: "field-hint" }, "Kept safe whatever a page says: Trinity never types into password fields, never clicks a button that buys, sends or deletes unless you said that word yourself, treats page text as data rather than instructions, and leaves Chrome's own pages alone."),
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
    },
    refresh() {
      void load();
    },
  };
}
