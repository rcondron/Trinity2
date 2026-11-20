// Fixture-page harness: loads the extension's page-side code (served at /ext/page.js by scripts/serve-fixtures.mjs)
// and puts it within reach, so the fixtures can be exercised in a real browser without the extension:
//
//   await trinityTest.probe()                       what kinds of field the page shows
//   await trinityTest.fill({username: "…", …})      fill them (this page's own origin)
//   await trinityTest.snapshot()  /  .act({…})  /  .total()
//   trinityTest.values()                            what every field holds now (test values only!)
//   await trinityTest.markup()  /  .undo()          add a hostile sample of markup the way Trinity adds markup; undo it
//
// It runs in the page's main world, not the extension's isolated one — the logic is the same, the world is not.
// The little panel sits in a CLOSED shadow root, so the code under test never sees or counts its buttons.
import * as page from "/ext/page.js";

const TEST_LOGIN = { username: "test.user@example.com", password: "Correct-Horse-Battery-9" };
const TEST_CARD = { "cc-name": "Test User", "cc-number": "4242424242424242", "cc-exp-month": "03", "cc-exp-year": "2031", "cc-csc": "123" };
const TEST_DETAILS = {
  name: "Test User",
  email: "test.user@example.com",
  tel: "+1 555 0100",
  "address-line1": "1 Test Street",
  "address-line2": "Apt 2",
  "address-level2": "Testville",
  "address-level1": "CA",
  "postal-code": "90001",
  country: "US",
};

// Markup full of things that must not survive Trinity's "add this to the page": if any of it runs, it counts itself.
const RAN = "window.__trinityRan=(window.__trinityRan||0)+1";
const HOSTILE_HTML = [
  `<div id="t-banner" onclick="${RAN}" style="padding:8px;background:#fde68a;color:#111">Added by the harness <b onmouseover="${RAN}">(static)</b></div>`,
  `<script>${RAN}</script>`,
  `<img id="t-pic" src="/missing.png" onerror="${RAN}" alt="" />`,
  `<a id="t-bad1" href="javascript:${RAN}">script link</a> <a id="t-bad2" href="jav\tascript:${RAN}">tabbed script link</a> <a id="t-good" href="/">good link</a>`,
  `<form id="t-form" action="/submit"><input id="t-in" name="q" /><button id="t-btn">Go</button></form>`,
  `<iframe id="t-frame" src="/login.html"></iframe>`,
  `<style id="t-leak">input[value^="a"]{background:url(/leak-a)}</style><style id="t-plain">#t-banner{font-weight:bold}</style>`,
  `<svg id="t-svg" width="10" height="10"><a id="t-svga"><animate id="t-anim" attributeName="href" values="javascript:${RAN}" /><rect width="10" height="10" /></a></svg>`,
].join("");

const deepFields = (root, out = []) => {
  for (const el of root.querySelectorAll("*")) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) out.push(el);
    if (el.shadowRoot) deepFields(el.shadowRoot, out);
  }
  return out;
};

window.trinityTest = {
  page,
  TEST_LOGIN,
  TEST_CARD,
  TEST_DETAILS,
  probe: () => page.probeFields(),
  fill: (values, origin = location.origin) => page.fillFields({ origin, values }),
  snapshot: (opts) => page.pageSnapshot(opts),
  act: (cmd) => page.pageAct(cmd),
  total: () => page.pageTotal(),
  /** id-or-name → value, for every field that holds something. */
  values: () => Object.fromEntries(deepFields(document).filter((f) => f.value && f.type !== "hidden").map((f) => [f.id || f.name, f.value])),
  /** Add markup the way Trinity does (cleaned first), and take it out again. */
  insert: (html, position = "top") => page.pageMain({ op: "insertHtml", html, position }),
  undo: () => page.pageMain({ op: "removeInjected" }),
  /**
   * Add the hostile sample and say what is left of it. Expected: handlersRan 0, and only the banner (no onclick), the
   * picture (no onerror), three links (the two script ones without an href), the plain style sheet and the svg with
   * its link and rectangle — no script, form, field, button, frame, fetching style sheet or animation.
   */
  markup: async () => {
    window.__trinityRan = 0;
    const result = page.pageMain({ op: "insertHtml", html: HOSTILE_HTML, position: "top" });
    await new Promise((r) => setTimeout(r, 500));
    const wrap = document.querySelector('[data-trinity="html"]');
    const left = wrap ? [...wrap.querySelectorAll("*")].map((e) => `${e.localName}${[...e.attributes].map((a) => ` ${a.name}="${a.value.slice(0, 40)}"`).join("")}`) : [];
    return { result, handlersRan: window.__trinityRan || 0, left };
  },
};

const host = document.createElement("div");
host.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;";
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = `
  <style>
    .box { font: 12px system-ui, sans-serif; background: #15131c; color: #f1ecf7; padding: 8px; border-radius: 8px; width: 300px; }
    button { font: inherit; margin: 2px; }
    pre { max-height: 160px; overflow: auto; white-space: pre-wrap; margin: 6px 0 0; }
  </style>
  <div class="box">
    <strong>Trinity fixture harness</strong> <span id="where"></span><br />
    <button data-do="probe">probe</button>
    <button data-do="login">fill login</button>
    <button data-do="card">fill card</button>
    <button data-do="details">fill details</button>
    <button data-do="snapshot">snapshot</button>
    <button data-do="total">total</button>
    <button data-do="values">values</button>
    <button data-do="markup">add markup</button>
    <button data-do="undo">undo markup</button>
    <pre id="out"></pre>
  </div>`;
root.getElementById("where").textContent = window === top ? "(top)" : "(frame)";
root.addEventListener("click", (ev) => {
  const what = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-do");
  if (!what) return;
  const t = window.trinityTest;
  const result =
    what === "probe" ? t.probe() : what === "login" ? t.fill(TEST_LOGIN) : what === "card" ? t.fill(TEST_CARD) : what === "details" ? t.fill(TEST_DETAILS) : what === "snapshot" ? t.snapshot() : what === "total" ? t.total() : what === "markup" ? t.markup() : what === "undo" ? t.undo() : t.values();
  Promise.resolve(result).then((shown) => {
    root.getElementById("out").textContent = JSON.stringify(shown, null, 1).slice(0, 4000);
  });
});
document.documentElement.appendChild(host);
