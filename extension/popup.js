// The toolbar popup: connection status, Disconnect / Connect, the pairing token, and "put this page on the board".

const $ = (id) => document.getElementById(id);
const dot = $("dot");
const statusText = $("statusText");
const engineInput = $("engine");
const tokenInput = $("token");
const saveNote = $("saveNote");
const connBtn = $("connBtn");
let painted = false;
let lastState = "";

function paint(res) {
  const s = (res && res.status) || { state: "off", detail: "" };
  dot.className = `dot ${s.state}`;
  statusText.textContent =
    s.state === "connected"
      ? "Connected — Trinity drives this browser"
      : s.state === "connecting"
        ? "Connecting…"
        : s.state === "paused"
          ? "Disconnected — Trinity can't use this browser"
          : s.state === "error"
            ? s.detail || "Something's wrong"
            : s.detail || "Not connected";
  if (res) {
    if (!engineInput.value) engineInput.value = res.engine || "";
    tokenInput.placeholder = res.tokenSet ? "•••••••• saved — paste to replace" : "Paste the token";
    $("scriptsHint").hidden = Boolean(res.userScripts);
    $("version").textContent = `v${res.version || ""}`;
    // Disconnect while a link is up or coming up; Connect once it's paused, dropped or refused.
    const live = s.state === "connected" || s.state === "connecting";
    connBtn.hidden = !res.tokenSet;
    connBtn.textContent = live ? "Disconnect" : "Connect";
    connBtn.title = live ? "Close the link to Trinity until you press Connect" : "Connect to the Trinity engine now";
    // The Connection panel opens itself only when it needs you — no token yet, or an error that just
    // appeared. Opening or closing it yourself sticks: the status repaints every two seconds.
    if (!painted) $("setup").open = !res.tokenSet || s.state === "error";
    else if (s.state === "error" && lastState !== "error") $("setup").open = true;
    painted = true;
    lastState = s.state;
  }
}

function ask(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    } catch {
      resolve(null);
    }
  });
}

async function refresh() {
  paint(await ask({ type: "status" }));
}

$("saveBtn").addEventListener("click", async () => {
  const engine = engineInput.value.trim();
  const token = tokenInput.value.trim();
  const patch = {};
  if (engine) patch.engine = engine;
  if (token) patch.token = token;
  saveNote.textContent = "Saving…";
  await chrome.storage.local.set(patch);
  tokenInput.value = "";
  const res = await ask({ type: "connect" });
  paint(res);
  saveNote.textContent = res && res.status && res.status.state === "connected" ? "Connected." : "Saved.";
  setTimeout(() => (saveNote.textContent = ""), 2500);
});

connBtn.addEventListener("click", async () => {
  const disconnect = connBtn.textContent === "Disconnect";
  connBtn.disabled = true;
  connBtn.textContent = disconnect ? "Disconnecting…" : "Connecting…";
  paint(await ask({ type: disconnect ? "disconnect" : "connect" }));
  connBtn.disabled = false;
});

$("showToken").addEventListener("click", () => {
  const hidden = tokenInput.type === "password";
  tokenInput.type = hidden ? "text" : "password";
  $("showToken").textContent = hidden ? "Hide" : "Show";
});

$("shareBtn").addEventListener("click", async () => {
  const btn = $("shareBtn");
  btn.disabled = true;
  const res = await ask({ type: "share" });
  btn.textContent = res && res.ok ? "On the board." : "Not connected — press Connect, or check the token below";
  setTimeout(() => {
    btn.textContent = "Put this page on Trinity's board";
    btn.disabled = false;
  }, 2200);
  if (!(res && res.ok)) $("setup").open = true;
});

$("detailsLink").addEventListener("click", (ev) => {
  ev.preventDefault();
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

void refresh();
setInterval(() => void refresh(), 2000);
