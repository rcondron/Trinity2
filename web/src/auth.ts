// Linking this browser to the engine. The engine answers only a linked browser on one of the app's own pages (see
// server/src/auth.ts): the first browser to open the app is linked at once, every later one enters a six-digit code
// from the engine's terminal (or from Settings on a browser that's already linked). The session itself is an HttpOnly
// cookie, so nothing here ever sees it.

type Status = { auth: "on" | "off"; linked: boolean; needsCode: boolean };

let pending: Promise<boolean> | null = null;

/**
 * Make sure this browser is linked. Resolves true once it is (asking for the code if it has to), false when the engine
 * can't be reached right now — the caller keeps its own retry rhythm. Calls made while one is under way share it.
 */
export function ensureSession(): Promise<boolean> {
  pending ??= link().finally(() => {
    pending = null;
  });
  return pending;
}

async function status(): Promise<Status | null> {
  try {
    const res = await fetch("/api/auth/status", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as Status) : null;
  } catch {
    return null;
  }
}

async function enroll(code?: string): Promise<"ok" | "code" | "down"> {
  try {
    const res = await fetch("/api/auth/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(code ? { code } : {}),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return "ok";
    return res.status === 403 ? "code" : "down";
  } catch {
    return "down";
  }
}

async function link(): Promise<boolean> {
  const s = await status();
  if (!s) return false;
  if (s.auth === "off" || s.linked) return true;
  if (!s.needsCode) {
    const first = await enroll();
    if (first === "ok") return true;
    if (first === "down") return false;
  }
  await askForCode();
  return true;
}

/** The prompt for the pairing code: resolves once a code has been accepted. */
function askForCode(): Promise<void> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Link this browser to Trinity");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(8,8,14,.82);" +
      "font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#ece9f6";
    const card = document.createElement("form");
    card.style.cssText =
      "width:min(420px,calc(100vw - 40px));padding:26px 26px 22px;border-radius:16px;background:#17151f;" +
      "border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 80px rgba(0,0,0,.55);display:grid;gap:14px";
    const title = document.createElement("h2");
    title.textContent = "Link this browser to Trinity";
    title.style.cssText = "margin:0;font-size:19px;font-weight:650";
    const text = document.createElement("p");
    text.textContent =
      "Trinity only talks to browsers it knows. Enter the six-digit code from the terminal window where Trinity is running, or from Settings on a browser that is already linked.";
    text.style.cssText = "margin:0;opacity:.82";
    const input = document.createElement("input");
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.placeholder = "123 456";
    input.maxLength = 9;
    input.setAttribute("aria-label", "Pairing code");
    input.style.cssText =
      "font:600 24px/1 ui-monospace,Consolas,monospace;letter-spacing:.18em;text-align:center;padding:12px;border-radius:10px;" +
      "border:1px solid rgba(255,255,255,.2);background:#0f0e15;color:inherit;outline-offset:2px";
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.style.cssText = "margin:0;min-height:1.45em;color:#ff9aa8;font-size:13.5px";
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Link browser";
    button.style.cssText =
      "font:600 15px/1 inherit;padding:12px 16px;border-radius:10px;border:0;background:#8b7cf6;color:#fff;cursor:pointer";
    card.append(title, text, input, error, button);
    wrap.append(card);
    card.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = input.value.replace(/\D/g, "");
      if (code.length !== 6) {
        error.textContent = "The code has six digits.";
        return;
      }
      button.disabled = true;
      error.textContent = "";
      void enroll(code).then((out) => {
        button.disabled = false;
        if (out === "ok") {
          wrap.remove();
          resolve();
        } else if (out === "code") {
          error.textContent = "That code didn't work. Codes last ten minutes: check the terminal for the current one.";
          input.select();
        } else {
          error.textContent = "Trinity's engine isn't answering. Check that it's running, then try again.";
        }
      });
    });
    document.body.append(wrap);
    input.focus();
  });
}
