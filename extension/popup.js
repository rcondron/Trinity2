// The toolbar popup: is this browser paired and connected, pairing by code, Disconnect / Connect, and "put this page
// on the board". It shows no key and no code: the code the user types goes to the service worker for one exchange and
// the box is emptied.

const $ = (id) => document.getElementById(id);
const dot = $("dot");
const statusText = $("statusText");
const connBtn = $("connBtn");
const pairPanel = $("pairPanel");
const pairNote = $("pairNote");
const codeInput = $("code");
let painted = false;
let pairing = false;
/** The user asked for the pairing box while paired ("Pair with a new code"). */
let wantPair = false;

const TITLES = {
  connected: "Connected — Trinity controls this browser",
  connecting: "Connecting…",
  pairing: "Pairing…",
  paused: "Disconnected — Trinity can't use this browser",
  unpaired: "Not paired",
  repair: "Pair again",
  replaced: "Stepped back",
};

function ask(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    } catch {
      resolve(null);
    }
  });
}

function paint(res) {
  const s = (res && res.status) || { state: "off", detail: "" };
  const state = pairing ? "pairing" : s.state;
  dot.className = `dot ${state}`;
  statusText.textContent = TITLES[state] || s.detail || "Not connected";
  statusText.title = s.detail || "";
  if (!res) return;
  const paired = Boolean(res.paired);
  const live = state === "connected" || state === "connecting";
  // Disconnect while a link is up or coming up; Connect once it's paused, dropped or stepped back. Nothing to press
  // before pairing, or when only a new pairing can help.
  connBtn.hidden = !paired || state === "repair" || state === "pairing";
  connBtn.textContent = live ? "Disconnect" : "Connect";
  connBtn.title = live ? "Close the link to Trinity until you press Connect" : "Connect to Trinity now";
  // The pairing box: when there is no pairing, when the engine no longer accepts it, or when asked for.
  const needsPair = !paired || state === "repair";
  pairPanel.hidden = !(needsPair || wantPair || pairing);
  $("pairTitle").textContent = state === "repair" ? "Pair again" : paired ? "Pair with a new code" : "Pair with Trinity";
  if (!pairing && !pairNote.dataset.kept) pairNote.textContent = needsPair && s.detail && state !== "unpaired" ? s.detail : "";
  $("actions").hidden = !paired;
  $("shareBtn").disabled = state !== "connected";
  $("whole").hidden = !paired;
  $("pairedLine").textContent = paired
    ? `Paired${res.pairedAt ? ` on ${new Date(res.pairedAt).toLocaleDateString()}` : ""}. Only that Trinity can use this browser: each side proves the pairing key on every connection.`
    : "Not paired with any Trinity yet.";
  $("repairBtn").hidden = !paired || needsPair;
  $("forgetBtn").hidden = !paired;
  $("scriptsHint").hidden = Boolean(res.userScripts);
  $("version").textContent = `v${res.version || ""}`;
  if (!$("engine").value && document.activeElement !== $("engine")) $("engine").value = res.engine || "";
  // First look: go straight to the code box when pairing is what's needed.
  if (!painted && needsPair) codeInput.focus();
  painted = true;
}

async function refresh() {
  if (!pairing) paint(await ask({ type: "status" }));
}

$("pairForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const code = codeInput.value.trim();
  if (code.replace(/[^A-Za-z0-9]/g, "").length < 8) {
    pairNote.textContent = "The code is eight letters and digits.";
    return;
  }
  pairing = true;
  codeInput.value = ""; // it's on its way to the service worker: not kept on screen
  $("pairBtn").disabled = true;
  $("pairBtn").textContent = "Pairing…";
  pairNote.textContent = "";
  delete pairNote.dataset.kept;
  paint(null);
  const res = await ask({ type: "pair", code });
  pairing = false;
  $("pairBtn").disabled = false;
  $("pairBtn").textContent = "Pair";
  const outcome = res && res.outcome;
  if (outcome === "live") {
    wantPair = false;
    pairNote.textContent = "";
  } else {
    pairNote.dataset.kept = "1";
    pairNote.textContent =
      outcome === "wrong-code"
        ? "That code didn't match, or it has run out. Get a fresh one in Trinity's Settings → Browser."
        : outcome === "unproven"
          ? "Whatever answered couldn't prove it knows the code, so this browser didn't pair with it."
          : outcome === "no-code"
            ? "Trinity is running, but no pairing code is waiting — it ran out, was used, or had too many wrong tries. Get a fresh one in Trinity's Settings → Browser."
            : "Couldn't reach Trinity to pair — is it running?";
    codeInput.focus();
  }
  paint(res);
});

connBtn.addEventListener("click", async () => {
  const disconnect = connBtn.textContent === "Disconnect";
  connBtn.disabled = true;
  connBtn.textContent = disconnect ? "Disconnecting…" : "Connecting…";
  paint(await ask({ type: disconnect ? "disconnect" : "connect" }));
  connBtn.disabled = false;
});

$("repairBtn").addEventListener("click", () => {
  wantPair = true;
  pairPanel.hidden = false;
  codeInput.focus();
});

$("forgetBtn").addEventListener("click", async () => {
  const btn = $("forgetBtn");
  if (btn.dataset.sure !== "1") {
    btn.dataset.sure = "1";
    btn.textContent = "Forget it — sure?";
    setTimeout(() => {
      delete btn.dataset.sure;
      btn.textContent = "Forget this pairing";
    }, 4000);
    return;
  }
  delete btn.dataset.sure;
  btn.textContent = "Forget this pairing";
  paint(await ask({ type: "forget" }));
});

$("saveBtn").addEventListener("click", async () => {
  const engine = $("engine").value.trim();
  if (engine) await chrome.storage.local.set({ engine });
  else await chrome.storage.local.remove("engine");
  setTimeout(() => void refresh(), 600);
});

$("shareBtn").addEventListener("click", async () => {
  const btn = $("shareBtn");
  btn.disabled = true;
  const res = await ask({ type: "share" });
  btn.textContent = res && res.ok ? "On the board." : "Not connected — press Connect";
  setTimeout(() => {
    btn.textContent = "Put this page on Trinity's board";
    void refresh();
  }, 2200);
});

$("detailsLink").addEventListener("click", (ev) => {
  ev.preventDefault();
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

void refresh();
setInterval(() => void refresh(), 2000);
