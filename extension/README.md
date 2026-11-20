# Trinity Browser Bridge

A Chrome extension that lets Trinity, the voice assistant running on this computer, control this
whole browser: tabs and windows, reading pages, clicking and typing, signing in and filling forms
from her vault, restyling or scripting a site, saving files, and taking the pages, pictures and
selections you put on her workspace board. Everything stays on this computer: the extension talks
only to the Trinity engine at `ws://127.0.0.1:8799`.

## Install and pair

1. Start Trinity (`npm run dev`) and open **Settings → Browser extension** in the app.
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load
   unpacked** and pick this `extension/` folder. (Already loaded? Press its reload arrow after an
   update.)
3. In Settings press **Show a pairing code**. Click the Trinity icon in Chrome's toolbar (pin it
   from the puzzle-piece menu), type the code and press **Pair**. The dot turns green and the
   Settings page shows your tabs.
4. Optional: on the extension's **Details** page turn on **Allow User Scripts**. Some sites'
   security policy refuses injected scripts; with the toggle on, Trinity can run JavaScript there
   too (styling changes work everywhere regardless).

The code works once, for ten minutes, and is never sent anywhere: both sides only prove they know
it. Pairing gives the extension and the engine each other's public key. From then on every
connection starts with both proving the shared key, and the extension runs nothing for anything
that can't — another program on the engine's port gets a hello and nothing more.

If the engine restarts, the extension reconnects on its own (it retries every few seconds, and at
least every thirty seconds). The popup says why when it can't connect:

- **Not paired** — type a code from Settings.
- **Pair again** — the engine no longer knows this browser (its data was reset, another extension
  was paired, or you pressed *Forget this extension* in Settings). It stops trying until you pair.
- **Stepped back** — another copy of this extension took the link. Press **Connect** to take it back.
- **Disconnected** — you pressed **Disconnect**. Nothing reconnects, even after Chrome restarts,
  until you press **Connect**.

## What Trinity can do with it

- **Open** — "open YouTube", "go to amazon dot com", "search for running shoes on Amazon", "google
  the weather in Lisbon", "youtube cute cats", "directions to the airport", "new tab".
- **Tabs and windows** — "close this tab", "close the other tabs", "close the tab with the recipe",
  "switch to the Gmail tab", "next tab", "pin this tab", "mute the YouTube tab", "duplicate this
  tab", "move this tab to a new window", "group the YouTube tabs", "reopen the closed tab", "new
  window", "close this window", "go back", "reload", "zoom in", "which tabs are open?".
- **Read** — "read this page", "summarize this article", "what does this page say about shipping?",
  "read the selected text", "what are the sections?".
- **Act** — "click sign in", "type blue shoes in the search box", "search this page for muffins",
  "scroll down", "press enter", "press tab", "choose large".
- **Sign in and fill** — "sign in", "log me in", "use my saved password", "fill in my card", "fill
  in my details": from Trinity's vault (Settings → Vault). You type secrets into the vault's secure
  form once; after that they go from the vault into the page field and nowhere else.
- **Change the page** — "make this page dark mode", "hide the ads", "reader mode", "make the text
  bigger", "add a banner at the top saying hello", "run javascript that…", "undo the changes".
- **Save** — "save this page", "save the article as a text file", "download this image", "save a
  screenshot" (to Chrome's downloads folder).
- **Put on the board** — "put this page on the board", "put the selected text on the board", "put a
  screenshot of this on the board"; or right-click a page, selection, link or image → *Put … on
  Trinity's board*; or the popup's button.

## Kept safe, whatever a page says — and whatever the engine asks

- Page text is data to Trinity's models, never instructions.
- No call is run for a peer that hasn't proved the pairing key.
- Trinity's own tabs are never read, changed, navigated, captured or closed.
- Password, one-time-code and card fields are never listed, read or typed into. A snapshot of a
  page never carries what is in a field.
- A fill happens only in the top document of an https tab whose address has exactly the origin the
  fill was sealed for, into fields a person can see, and never into a form that posts to another
  site. The extension answers with which kinds of field it filled — never a value.
- A tab that holds a filled login or card runs no injected script and gives no screenshot or
  saved copy until it leaves that site — and again if the filled page itself comes back out of
  the tab's history. A fill that failed part-way counts as one.
- The other way round too: a page Trinity ran a script in, or gave a style sheet that fetches
  things, is not filled. Reload it first.
- A button that buys, pays, orders, sends, deletes, confirms or signs out — pressed by a click, by
  Enter or by "type … and submit" — is held unless the engine approves that exact button. Trinity
  approves it only when you said so yourself, and for one that spends, only after you answer a
  question that names the site and the total.
- Chrome's own pages are left alone; only web and `data:` URLs are opened or downloaded; HTML
  Trinity inserts is stripped of scripts, handlers, `javascript:` addresses, frames, form fields
  and style sheets that fetch things.

## Files

- `manifest.json` — Manifest V3; permissions: tabs, scripting, downloads, storage, contextMenus,
  pageCapture, alarms, userScripts, sessions, tabGroups, webNavigation; all sites.
- `background.js` — the service worker: the socket to the engine, the calls, tab reports, what
  you put on the board, what a tab that holds a fill refuses.
- `proto.js` — pairing, the mutual handshake and sealed fills (WebCrypto only; the engine's tests
  run this same file).
- `page.js` — everything that runs inside a page: reading it, acting on it, finding and filling
  fields. One self-contained function, injected into the page's isolated world.
- `store.js` — the key pair (non-extractable) and the engine's pinned key, in IndexedDB.
- `popup.html` / `popup.js` / `popup.css` — status, pairing by code, Disconnect / Connect, "put
  this page on the board".
- `icons/` — the toolbar icon.

The fixture pages for checking `page.js` in a real browser are in `scripts/fixtures/browser/`
(`node scripts/serve-fixtures.mjs`, then `window.trinityTest` on each page).
