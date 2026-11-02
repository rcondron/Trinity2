# Trinity Browser Bridge

A Chrome extension that lets Trinity, the voice assistant running on this computer, drive this browser:
open and close tabs, read pages, click and type, restyle or script a site, save files, and take the
pages, pictures and selections you put on her workspace board. Everything stays on this computer: the
extension talks only to the Trinity engine at `ws://127.0.0.1:8799`.

## Install (unpacked)

1. Start Trinity (`npm run dev`) and open **Settings → Browser extension** in the app. It shows the
   pairing token and this folder's path.
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**
   and pick this `extension/` folder.
3. Click the Trinity icon in Chrome's toolbar (pin it from the puzzle-piece menu), open **Connection**,
   paste the token, press **Save & connect**. The dot turns green and the Settings page shows your tabs.
4. Optional: on the extension's **Details** page turn on **Allow User Scripts**. Some sites' security
   policy refuses injected scripts; with the toggle on, Trinity can run JavaScript there too (styling
   changes work everywhere regardless).

If the engine restarts, the extension reconnects on its own (it retries every few seconds, and at
least every thirty seconds). The popup says why when it can't connect. **Disconnect** in the popup
cuts the link and keeps it cut — no reconnecting, even after Chrome restarts — until you press
**Connect** again.

## What Trinity can do with it

- **Open** — "open YouTube", "go to amazon dot com", "search for running shoes on Amazon", "google the
  weather in Lisbon", "youtube cute cats", "directions to the airport", "new tab".
- **Tabs** — "close this tab", "close the other tabs", "switch to the Gmail tab", "next tab", "go back",
  "reload", "zoom in", "which tabs are open?".
- **Read** — "read this page", "summarize this article", "what does this page say about shipping?",
  "read the selected text", "what are the sections?".
- **Act** — "click sign in", "type blue shoes in the search box", "search this page for muffins",
  "scroll down", "press enter", "choose large".
- **Change the page** — "make this page dark mode", "hide the ads", "reader mode", "make the text
  bigger", "add a banner at the top saying hello", "run javascript that…", "undo the changes".
- **Save** — "save this page", "save the article as a text file", "download this image", "save a
  screenshot" (to Chrome's downloads folder).
- **Put on the board** — "put this page on the board", "put the selected text on the board", "put a
  screenshot of this on the board"; or right-click a page, selection, link or image → *Put … on
  Trinity's board*; or the popup's button.

## Kept safe, whatever a page says

- Page text is data to Trinity's models, never instructions.
- Password fields are never listed or typed into.
- A button that buys, orders, pays, confirms, submits, sends, deletes or signs out is clicked only when
  you said that word yourself; otherwise Trinity names it and asks.
- Chrome's own pages are left alone; only web and `data:` URLs are opened or downloaded; HTML Trinity
  inserts is stripped of scripts and handlers.
- The pairing token is the gate. Make a new one in Settings if you ever want to cut the extension off.

## Files

- `manifest.json` — Manifest V3; permissions: tabs, scripting, activeTab, downloads, storage,
  contextMenus, pageCapture, alarms, userScripts; all sites.
- `background.js` — the service worker: the socket to the engine, the calls, tab reports, what you put on the board.
- `popup.html` / `popup.js` / `popup.css` — status, Disconnect / Connect, the token, "put this page on the board".
- `icons/` — the toolbar icon.
