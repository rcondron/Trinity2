// The toolbar popup: connection status, the pairing token, and "share this page".

const $ = (id) => document.getElementById(id);
const dot = $("dot");
const statusText = $("statusText");
const engineInput = $("engine");
const tokenInput = $("token");
const saveNote = $("saveNote");

function paint(res) {
  const s = (res && res.status) || { state: "off", detail: "" };
  dot.className = `dot ${s.state}`;
  statusText.textContent =
    s.state === "connected" ? "Connected to Trinity" : s.state === "connecting" ? "Connecting…" : s.state === "error" ? s.detail || "Something's wrong" : s.detail || "Not connected";
  if (res) {
    if (!engineInput.value) engineInput.value = res.engine || "";
    tokenInput.placeholder = res.tokenSet ? "•••••••• saved — paste to replace" : "Paste the token";
    $("scriptsHint").hidden = Boolean(res.userScripts);
    $("version").textContent = `v${res.version || ""}`;
    $("setup").open = !res.tokenSet || s.state === "error";
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

$("showToken").addEventListener("click", () => {
  const hidden = tokenInput.type === "password";
  tokenInput.type = hidden ? "text" : "password";
  $("showToken").textContent = hidden ? "Hide" : "Show";
});

$("shareBtn").addEventListener("click", async () => {
  const btn = $("shareBtn");
  btn.disabled = true;
  const res = await ask({ type: "share" });
  btn.textContent = res && res.ok ? "Shared — it's on Trinity's board" : "Not connected — check the token below";
  setTimeout(() => {
    btn.textContent = "Share this page with Trinity";
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
