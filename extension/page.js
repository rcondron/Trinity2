// Trinity Browser Bridge — everything that runs inside a web page.
//
// `pageMain` is handed to chrome.scripting.executeScript as it is (ISOLATED world), so it is ONE self-contained
// function: it reads nothing from this module, only its argument and the page. What it can be asked (cmd.op):
//
//   snapshot       the page for reading and acting: text, headings, the things that can be clicked or typed into
//                  (each given a ref), pictures, structure. Never a field's value; password, one-time-code and card
//                  fields are not listed at all.
//   act            click / type / select / scroll / press / focus on a ref from the last snapshot — or `submitter`,
//                  which only says what a form's submit control is called.
//   probe          which kinds of fillable field the top document shows (user name, password, card number …).
//   fill           put values into those fields — top document only, the exact origin, a secure context, visible and
//                  enabled fields only, never a form that posts to another origin. Returns field kinds, never values.
//   total          the order total the page shows, if it shows one.
//   insertHtml / removeInjected   Trinity's own additions to the page.
//
// Rules kept in here whatever is asked: a control whose name says buy / pay / order / send / delete / confirm … is
// pressed (by a click or by Enter) only with the engine's approval of that exact name; secret fields are never read,
// listed or typed into; Trinity's fills never leave the top document.
//
// The named exports at the bottom call pageMain directly: they are for tests and fixtures, not for injection.

export function pageMain(cmd) {
  const win = window;
  const doc = document;
  const E = win.Element.prototype;
  // What this page's isolated world remembers between calls: the elements behind the refs.
  const store = (win.__trinityBridge = win.__trinityBridge || { refs: new Map() });

  // ── reading the DOM without being fooled ──
  // A page can name its elements so that they shadow built-ins on document and on forms (<img name="body">,
  // <input name="action">). Everything that matters is read through the prototypes.
  const clean = (s) => String(s === null || s === undefined ? "" : s).replace(/\s+/g, " ").trim();
  const attr = (el, name) => {
    try {
      const v = E.getAttribute.call(el, name);
      return v === null || v === undefined ? null : String(v);
    } catch {
      return null;
    }
  };
  const tagOf = (el) => String((el && el.tagName) || "").toLowerCase();
  const typeOf = (el) => (tagOf(el) === "input" ? (attr(el, "type") || "text").toLowerCase() : tagOf(el));
  const qsa = (root, sel) => {
    try {
      const proto = root.nodeType === 9 ? win.Document.prototype : root.nodeType === 11 ? win.DocumentFragment.prototype : E;
      return Array.from(proto.querySelectorAll.call(root, sel));
    } catch {
      return [];
    }
  };
  const docProp = (name) => {
    try {
      for (const p of [win.Document.prototype, win.Node.prototype]) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d && d.get) return d.get.call(doc);
      }
    } catch {
      /* fall through */
    }
    return doc[name];
  };
  const bodyEl = () => docProp("body") || null;
  const rootEl = () => docProp("documentElement") || null;
  const activeEl = () => {
    let a = docProp("activeElement") || null;
    for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 10; i++) a = a.shadowRoot.activeElement;
    return a;
  };
  const closest = (el, sel) => {
    try {
      return E.closest.call(el, sel);
    } catch {
      return null;
    }
  };
  const contains = (a, b) => {
    try {
      return win.Node.prototype.contains.call(a, b);
    } catch {
      return false;
    }
  };
  const parentOf = (el) => {
    if (el.parentElement) return el.parentElement;
    const r = el.getRootNode ? el.getRootNode() : null;
    return r && r.host ? r.host : null;
  };
  const baseUri = () => {
    try {
      const d = Object.getOwnPropertyDescriptor(win.Node.prototype, "baseURI");
      if (d && d.get) return String(d.get.call(doc));
    } catch {
      /* fall through */
    }
    return String(win.location.href);
  };
  /** Elements matching `sel`, open shadow roots included. */
  const deep = (root, sel, limit) => {
    const out = [];
    const max = limit || 4000;
    const walk = (r) => {
      for (const el of qsa(r, sel)) {
        if (out.length >= max) return;
        out.push(el);
      }
      for (const host of qsa(r, "*")) {
        if (out.length >= max) return;
        if (host.shadowRoot) walk(host.shadowRoot);
      }
    };
    walk(root);
    return out;
  };

  // ── what a person can actually see ──
  /** Sized, not hidden or transparent anywhere up the tree, not clipped away by a parent, not parked off the page. */
  const shown = (el, min) => {
    const m = min || 2;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (!r || r.width < m || r.height < m) return false;
    const own = win.getComputedStyle(el);
    if (!own || own.display === "none" || own.visibility === "hidden" || own.visibility === "collapse") return false;
    if (r.right + (win.scrollX || 0) <= 0 || r.bottom + (win.scrollY || 0) <= 0) return false;
    const body = bodyEl();
    const root = rootEl();
    let n = el;
    for (let hops = 0; n && hops < 80; hops++, n = parentOf(n)) {
      const cs = n === el ? own : win.getComputedStyle(n);
      if (!cs) continue;
      if (cs.display === "none") return false;
      if (parseFloat(cs.opacity) < 0.05) return false;
      if (n !== el && n !== body && n !== root && /hidden|clip/.test(`${cs.overflowX} ${cs.overflowY} ${cs.overflow}`)) {
        const a = n.getBoundingClientRect();
        if (Math.min(r.right, a.right) - Math.max(r.left, a.left) < m || Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top) < m) return false;
      }
    }
    return true;
  };
  /** true: a click at its centre lands on it; false: something else lies over it; null: it isn't in view. */
  const onTop = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= (win.innerWidth || 0) || y >= (win.innerHeight || 0)) return null;
    let hit = null;
    try {
      hit = win.Document.prototype.elementFromPoint.call(doc, x, y);
    } catch {
      return null;
    }
    for (let i = 0; hit && hit !== el && hit.shadowRoot && i < 10; i++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit) return false;
    if (hit === el || contains(el, hit)) return true;
    // A label lying over its own field (a floating label) still is that field.
    const label = closest(hit, "label");
    if (label) {
      try {
        if (contains(label, el) || (el.labels && Array.from(el.labels).includes(label))) return true;
      } catch {
        /* not its label */
      }
    }
    return false;
  };

  // ── names ──
  const labelOf = (el) => {
    let t = "";
    try {
      if (el.labels && el.labels.length) t = clean(el.labels[0].innerText || el.labels[0].textContent);
    } catch {
      /* no labels */
    }
    if (!t) {
      const ids = clean(attr(el, "aria-labelledby"));
      const root = el.getRootNode ? el.getRootNode() : doc;
      if (ids)
        t = clean(
          ids
            .split(" ")
            .map((id) => {
              const hit = qsa(root, "[id]").find((n) => attr(n, "id") === id);
              return hit ? hit.innerText || hit.textContent : "";
            })
            .join(" "),
        );
    }
    return t;
  };
  const roleOf = (el) => (attr(el, "role") || "").toLowerCase();
  const typedInto = (el) => {
    const tag = tagOf(el);
    return tag === "textarea" || tag === "select" || (tag === "input" && !/^(submit|button|reset|image)$/.test(typeOf(el))) || el.isContentEditable === true || /^(textbox|searchbox|combobox)$/.test(roleOf(el));
  };
  /** What a control is called — from its label, never from what was typed into it. */
  const nameOf = (el) => {
    const tag = tagOf(el);
    const type = typeOf(el);
    let n;
    if (tag === "input" && /^(submit|button|reset)$/.test(type)) n = attr(el, "value") || attr(el, "aria-label") || attr(el, "title") || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
    else if (tag === "input" && type === "image") n = attr(el, "alt") || attr(el, "aria-label") || attr(el, "title") || "";
    else if (typedInto(el)) n = attr(el, "aria-label") || labelOf(el) || attr(el, "placeholder") || attr(el, "aria-placeholder") || attr(el, "title") || attr(el, "name") || "";
    else {
      const img = qsa(el, "img[alt]")[0];
      n = el.innerText || attr(el, "aria-label") || attr(el, "title") || attr(el, "alt") || labelOf(el) || (img ? attr(img, "alt") : "") || "";
    }
    return clean(n).slice(0, 80);
  };

  // ── which field is which ──
  const AUTOCOMPLETE = {
    username: "username",
    email: "email",
    "current-password": "password",
    "new-password": "new-password",
    "one-time-code": "otp",
    "cc-number": "cc-number",
    "cc-exp": "cc-exp",
    "cc-exp-month": "cc-exp-month",
    "cc-exp-year": "cc-exp-year",
    "cc-csc": "cc-csc",
    "cc-name": "cc-name",
    name: "name",
    "given-name": "given-name",
    "family-name": "family-name",
    tel: "tel",
    "tel-national": "tel",
    "street-address": "street-address",
    "address-line1": "address-line1",
    "address-line2": "address-line2",
    "address-level2": "address-level2",
    "address-level1": "address-level1",
    "postal-code": "postal-code",
    country: "country",
    "country-name": "country",
    bday: "bday",
    organization: "organization",
  };
  // Tried in this order on name / id / placeholder / label, when autocomplete and type don't settle it.
  const HINTS = [
    ["cc-number", /\b(?:card|cc|credit|debit)[\s_-]*(?:number|num|no)\b|cardnumber|\bccnum(?:ber)?\b|\bpan\b/],
    ["cc-csc", /\bcvc2?\b|\bcvv2?\b|\bcsc\b|\bcid\b|security[\s_-]*code|card[\s_-]*(?:verification|security|code)|verification[\s_-]*(?:value|number)/],
    ["cc-exp", /mm\s*\/\s*yy|exp\w*[\s_-]*date|valid[\s_-]*(?:thru|through|until)/],
    ["cc-exp-month", /exp\w*[\s_-]*(?:month|mm)\b|(?:card|cc)[\s_-]*month|\bexpmonth\b|\bmonth\b/],
    ["cc-exp-year", /exp\w*[\s_-]*(?:year|yy(?:yy)?)\b|(?:card|cc)[\s_-]*year|\bexpyear\b|\byear\b/],
    ["cc-exp", /\bexp(?:iry|iration|ires)?\b/],
    ["cc-name", /name[\s_-]*on[\s_-]*(?:the[\s_-]*)?card|card[\s_-]*holder|cardholder|(?:cc|card)[\s_-]*name/],
    ["otp", /\botp\b|one[\s_-]*time|\b2fa\b|\bmfa\b|\btotp\b|two[\s_-]*(?:factor|step)|(?:verification|authenticat\w*|auth|sms|login|sign[\s_-]*in|access|6[\s_-]*digit|six[\s_-]*digit)[\s_-]*code|authenticator|passcode/],
    ["password", /pass(?:word|wd|phrase)\b|\bpwd\b/],
    ["username", /user[\s_-]*(?:name|id)\b|\buser\b|\blogin\b|\blog[\s_-]*in\b|\bsign[\s_-]*in\b|account[\s_-]*(?:name|id)\b|\bidentifier\b/],
    ["email", /e-?mail/],
    ["given-name", /first[\s_-]*name|given[\s_-]*name|\bfname\b|forename/],
    ["family-name", /last[\s_-]*name|family[\s_-]*name|sur[\s_-]*name|\blname\b/],
    ["organization", /\bcompany\b|organi[sz]ation/],
    ["name", /full[\s_-]*name|your[\s_-]*name|\bname\b/],
    ["tel", /phone|mobile|\btel\b|telephone|\bcell\b/],
    ["address-line2", /address[\s_-]*(?:line)?[\s_-]*2\b|\bapt\b|apartment|\bsuite\b|\bunit\b/],
    ["postal-code", /\bzip\b|post(?:al)?[\s_-]*code|postcode/],
    ["address-level2", /\bcity\b|\btown\b|locality/],
    ["address-level1", /\bstate\b|province|\bregion\b|\bcounty\b/],
    ["country", /country/],
    ["address-line1", /address[\s_-]*(?:line)?[\s_-]*1\b|street|\baddress\b/],
  ];
  const SECRET_KINDS = ["password", "new-password", "otp", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"];
  const SECRET_HINT =
    /pass(?:word|wd|code|phrase)?\b|\bpwd\b|\botp\b|one[\s_-]*time|\b2fa\b|\bmfa\b|\btotp\b|(?:verification|security|auth\w*)[\s_-]*code|\bcvv2?\b|\bcvc2?\b|\bcsc\b|card[\s_-]*(?:number|num|no)\b|cardnumber|\bcc[\s_-]*(?:num|number|exp|csc|cvc|cvv)|\bssn\b|social[\s_-]*security|\bsecret\b|\btoken\b|\bpin\b|routing[\s_-]*number|account[\s_-]*number|\biban\b/;
  const hintsOf = (el) =>
    clean([attr(el, "name"), attr(el, "id"), attr(el, "placeholder"), attr(el, "aria-label"), attr(el, "title"), labelOf(el)].filter(Boolean).join(" "))
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase();
  /** {kind, by} for a form control that could be filled; null for one that never is (buttons, checkboxes, hidden …). */
  const kindOf = (el) => {
    const tag = tagOf(el);
    if (tag !== "input" && tag !== "select" && tag !== "textarea") return null;
    const type = typeOf(el);
    if (/^(hidden|submit|button|reset|image|file|checkbox|radio|range|color|date|datetime-local|month|week|time|search)$/.test(type)) return null;
    const tokens = (attr(el, "autocomplete") || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t && !/^(?:section-.*|shipping|billing|home|work|mobile|fax|pager|webauthn)$/.test(t));
    const token = tokens[tokens.length - 1] || "";
    if (token && Object.prototype.hasOwnProperty.call(AUTOCOMPLETE, token)) return { kind: AUTOCOMPLETE[token], by: "autocomplete" };
    if (type === "password") return { kind: "password", by: "type" };
    const h = hintsOf(el);
    for (const [kind, re] of HINTS) if (re.test(h)) return { kind, by: "hint" };
    if (type === "email") return { kind: "email", by: "type" };
    if (type === "tel") return { kind: "tel", by: "type" };
    return { kind: null, by: "" };
  };
  /** A field whose autocomplete, type or name says password, one-time code, card or the like: never read or typed into. */
  const secretish = (el) => {
    const tag = tagOf(el);
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return false;
    if (typeOf(el) === "password") return true;
    const k = kindOf(el);
    if (k && k.kind && SECRET_KINDS.includes(k.kind)) return true;
    return SECRET_HINT.test(`${hintsOf(el)} ${(attr(el, "autocomplete") || "").toLowerCase()}`);
  };

  // ── forms ──
  const formOf = (el) => {
    try {
      return el.form || closest(el, "form") || null;
    } catch {
      return null;
    }
  };
  /** Where a form can send what is typed into it: its action, and any formaction on its buttons. */
  const leaves = (form) => {
    if (!form) return false;
    const targets = [attr(form, "action")];
    for (const b of qsa(form, "button, input")) targets.push(attr(b, "formaction"));
    const id = attr(form, "id");
    if (id) for (const b of deep(doc, "button, input", 3000)) if (attr(b, "form") === id) targets.push(attr(b, "formaction"));
    for (const t of targets) {
      if (t === null || clean(t) === "") continue;
      try {
        const u = new URL(t, baseUri());
        if (u.protocol === "javascript:") continue; // the page's own script takes it
        if (u.origin !== win.location.origin) return true;
      } catch {
        return true;
      }
    }
    return false;
  };
  const isSubmit = (b) => (tagOf(b) === "button" ? (attr(b, "type") || "submit").toLowerCase() === "submit" : tagOf(b) === "input" && /^(submit|image)$/.test(typeOf(b)));
  /** The control Enter would press: the form's first submit button that is there to press. */
  const submitterOf = (form) => qsa(form, "button, input").find((b) => isSubmit(b) && !b.disabled && shown(b, 2)) || null;
  const buttonLike = (el) => {
    const tag = tagOf(el);
    if (tag === "button" || (tag === "input" && /^(submit|button|image|reset)$/.test(typeOf(el))) || roleOf(el) === "button") return true;
    if (tag === "a") return /^\s*(#|javascript:|$)/i.test(attr(el, "href") || "");
    return tag !== "a" && roleOf(el) !== "link";
  };
  // The same words as the engine's guard (services/browser-words.ts): spending, sending, destroying, consenting.
  const GUARD =
    /\b(?:buy(?:s|ing)?|purchas(?:e|es|ed|ing)|pay(?:s|ing|ment|ments)?|(?:re)?order(?:s|ed|ing)?|checkout|check out|book(?:s|ed|ing)?|reserv(?:e|es|ed|ing|ation)|subscrib(?:e|es|ed|ing)|donat(?:e|es|ed|ing|ion)|bid(?:s|ding)?|transfer(?:s|red|ring)?|send(?:s|ing)?|post(?:s|ed|ing)?|publish(?:es|ed|ing)?|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|confirm(?:s|ed|ing)?|authori[sz](?:e|es|ed|ing)|allow(?:s|ed|ing)?|grant(?:s|ed|ing)?|accept(?:s|ed|ing)?|agree(?:s|d|ing)?|approv(?:e|es|ed|ing)|submit(?:s|ted|ting)?|unsubscrib(?:e|es|ed|ing)|sign out|log out|logout|apply|proceed|complete)\b/i;

  // ── values ──
  const valueProto = (el) => (tagOf(el) === "textarea" ? win.HTMLTextAreaElement.prototype : tagOf(el) === "select" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype);
  const nativeGet = (el) => {
    const d = Object.getOwnPropertyDescriptor(valueProto(el), "value");
    return String(d && d.get ? d.get.call(el) : el.value);
  };
  /** The prototype's own setter (a framework's wrapper on the element would swallow the change), then the events it listens for. */
  const nativeSet = (el, value) => {
    const d = Object.getOwnPropertyDescriptor(valueProto(el), "value");
    if (d && d.set) d.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
  };
  const focusOn = (el) => {
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* not focusable */
    }
  };
  const textField = (el) => {
    const tag = tagOf(el);
    return tag === "textarea" || (tag === "input" && /^(text|search|email|url|tel|number|password)$/.test(typeOf(el))) || el.isContentEditable === true;
  };
  /** Pick the option that means one of `wants` (by value or by its words). */
  const choose = (sel, wants) => {
    const norm = (s) => clean(s).toLowerCase();
    const opts = Array.from(sel.options || []);
    const w = wants.map(norm).filter(Boolean);
    let hit = null;
    for (const want of w) {
      hit = opts.find((o) => norm(o.value) === want || norm(o.text) === want);
      if (hit) break;
    }
    if (!hit)
      for (const want of w) {
        if (want.length < 3) continue;
        hit = opts.find((o) => norm(o.text).startsWith(want) || new RegExp(`(^|[^a-z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(norm(o.text)));
        if (hit) break;
      }
    if (!hit || hit.disabled) return false;
    nativeSet(sel, hit.value);
    return true;
  };

  // ── scroll ──
  const rootScroller = () => docProp("scrollingElement") || rootEl();
  /** The thing that actually scrolls around `start`: the nearest box with its own scroll bar, else the page. */
  const scrollerOf = (start) => {
    for (let n = start, i = 0; n && i < 80; n = parentOf(n), i++) {
      if (n === bodyEl() || n === rootEl()) break;
      const cs = win.getComputedStyle(n);
      if (cs && /auto|scroll|overlay/.test(`${cs.overflowY}`) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return rootScroller();
  };
  const scrollStart = (el) => {
    if (el) return el;
    const a = activeEl();
    if (a && a !== bodyEl()) return a;
    try {
      return win.Document.prototype.elementFromPoint.call(doc, (win.innerWidth || 0) / 2, (win.innerHeight || 0) / 2);
    } catch {
      return null;
    }
  };
  /** Scroll and say whether anything moved. */
  const scrollIt = (sc, dx, dy, to) => {
    const before = [sc.scrollLeft, sc.scrollTop];
    if (to === "top") sc.scrollTo({ top: 0, behavior: "instant" });
    else if (to === "bottom") sc.scrollTo({ top: sc.scrollHeight, behavior: "instant" });
    else sc.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return sc.scrollLeft !== before[0] || sc.scrollTop !== before[1];
  };
  const scrollPage = (el, dx, dy, to) => {
    const sc = scrollerOf(scrollStart(el));
    let moved = scrollIt(sc, dx, dy, to);
    const root = rootScroller();
    if (!moved && sc !== root) moved = scrollIt(root, dx, dy, to);
    return { moved, y: Math.round(root ? root.scrollTop : 0), max: Math.max(0, root ? root.scrollHeight - (win.innerHeight || 0) : 0) };
  };

  // ── refs ──
  const byRef = (ref) => {
    const el = store.refs.get(Number(ref));
    return el && el.isConnected !== false ? el : null;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // snapshot
  // ════════════════════════════════════════════════════════════════════════════
  const snapshot = (o) => {
    const top = win === win.top;
    const vw = win.innerWidth || 0;
    const vh = win.innerHeight || 0;
    // A frame only adds what can be pressed in it, and only when it is big enough to be part of the page.
    if (!top && (vw < 120 || vh < 60)) return null;
    const out = {
      title: clean(docProp("title")).slice(0, 300),
      url: String(win.location.href),
      text: "",
      outline: [],
      interactive: [],
      images: [],
      structure: { landmarks: "", ids: [], classes: [], bg: "", color: "", fontSize: "" },
      selection: "",
      scroll: { y: 0, max: 0 },
      more: 0,
    };
    const body = bodyEl();
    if (top && body) {
      const maxChars = (o && o.maxChars) || 6000;
      const main = qsa(doc, "main, [role=main], article")[0] || body;
      let text = clean(main.innerText || "");
      if (text.length < 200 && main !== body) text = clean(body.innerText || "");
      out.text = text.slice(0, maxChars);
      for (const h of qsa(doc, "h1, h2, h3")) {
        if (out.outline.length >= 40) break;
        if (!shown(h, 2)) continue;
        const t = clean(h.innerText);
        if (t) out.outline.push({ level: Number(h.tagName[1]), text: t.slice(0, 120) });
      }
      for (const img of qsa(doc, "img")) {
        if (out.images.length >= 20) break;
        const r = img.getBoundingClientRect();
        if (r.width < 48 || r.height < 48) continue;
        const src = String(img.currentSrc || img.src || "");
        if (!/^https?:\/\//i.test(src)) continue;
        out.images.push({ src: src.slice(0, 500), alt: clean(attr(img, "alt") || attr(img, "title") || "").slice(0, 100), w: Math.round(r.width), h: Math.round(r.height) });
      }
      const ids = [];
      for (const el of qsa(doc, "[id]")) {
        if (ids.length >= 40) break;
        const id = attr(el, "id") || "";
        if (/^[A-Za-z][\w-]{1,40}$/.test(id) && !ids.includes(id)) ids.push(id);
      }
      const classCount = new Map();
      let seen = 0;
      for (const el of qsa(doc, "[class]")) {
        if (++seen > 3000) break;
        for (const c of clean(attr(el, "class")).split(" ")) if (/^[A-Za-z][\w-]{1,40}$/.test(c)) classCount.set(c, (classCount.get(c) || 0) + 1);
      }
      const classes = [...classCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([c, n]) => `${c}(${n})`);
      const landmarks = ["header", "nav", "main", "aside", "footer", "article", "section", "form", "iframe", "video", "img", "table"].map((t) => `${t}:${qsa(doc, t).length}`).join(" ");
      const bs = win.getComputedStyle(body);
      const rs = rootEl() ? win.getComputedStyle(rootEl()) : null;
      out.structure = { landmarks, ids, classes, bg: String((bs && bs.backgroundColor) || ""), color: String((bs && bs.color) || ""), fontSize: String((rs && rs.fontSize) || "") };
      // What's selected in a text box is what was typed there: only a selection in the page itself counts.
      const a = activeEl();
      const inField = a && (tagOf(a) === "input" || tagOf(a) === "textarea");
      out.selection = inField ? "" : clean(String(win.getSelection ? win.getSelection() : "")).slice(0, 2000);
      const sc = rootScroller();
      out.scroll = { y: Math.round(sc ? sc.scrollTop : 0), max: Math.max(0, sc ? sc.scrollHeight - vh : 0) };
    }
    if (!o || o.interactive !== false) {
      store.refs = new Map();
      const cap = top ? 150 : 40;
      const SEL =
        "a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], [role=textbox], [role=searchbox], [role=combobox], [contenteditable=true], [contenteditable=''], summary";
      const found = [];
      for (const el of deep(doc, SEL, 2500)) {
        const tag = tagOf(el);
        const type = typeOf(el);
        if (tag === "input" && type === "hidden") continue;
        if (secretish(el)) continue; // never listed, never typed into
        if (!shown(el, 2)) continue;
        const name = nameOf(el);
        if (!name && tag !== "input" && tag !== "textarea" && tag !== "select") continue;
        const r = el.getBoundingClientRect();
        found.push({ el, tag, type, name, near: r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw, row: Math.round(r.top / 8), left: r.left, i: found.length });
      }
      // What's on screen first (as it reads: down, then across), then the rest of the page in its own order.
      found.sort((a, b) => (a.near !== b.near ? (a.near ? -1 : 1) : a.near ? a.row - b.row || a.left - b.left || a.i - b.i : a.i - b.i));
      out.more = Math.max(0, found.length - cap);
      let ref = 0;
      for (const f of found.slice(0, cap)) {
        ref++;
        store.refs.set(ref, f.el);
        const el = f.el;
        const item = { ref, tag: el.isContentEditable === true && f.tag !== "input" && f.tag !== "textarea" ? "contenteditable" : f.tag, name: f.name };
        const role = attr(el, "role");
        if (role) item.role = role;
        if (f.tag === "input" || f.tag === "button") {
          const t = attr(el, "type");
          if (t) item.type = t.toLowerCase();
        }
        if (f.tag === "a") item.href = String(el.href || attr(el, "href") || "").slice(0, 300);
        if (el.disabled === true) item.disabled = true;
        if (GUARD.test(f.name)) item.guarded = buttonLike(el) ? "button" : "link";
        out.interactive.push(item);
      }
    }
    return out;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // act
  // ════════════════════════════════════════════════════════════════════════════
  const pointerClick = (el) => {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: win, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const fire = (type, Ctor, extra) => {
      try {
        if (typeof Ctor === "function") el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra || {})));
      } catch {
        /* an event this page can't take */
      }
    };
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    fire("pointerover", win.PointerEvent, pointer);
    fire("mouseover", win.MouseEvent);
    fire("pointermove", win.PointerEvent, pointer);
    fire("mousemove", win.MouseEvent);
    fire("pointerdown", win.PointerEvent, Object.assign({ buttons: 1 }, pointer));
    fire("mousedown", win.MouseEvent, { buttons: 1 });
    focusOn(el);
    fire("pointerup", win.PointerEvent, pointer);
    fire("mouseup", win.MouseEvent);
    try {
      if (win.HTMLElement && el instanceof win.HTMLElement) win.HTMLElement.prototype.click.call(el);
      else fire("click", win.MouseEvent);
    } catch {
      fire("click", win.MouseEvent);
    }
  };
  /** A click on a control — held, and nothing touched, when its name is guarded and that exact name wasn't approved. */
  const clickOn = (el, approved) => {
    if (secretish(el)) return { ok: false, error: "secret field" };
    const name = nameOf(el);
    if (GUARD.test(name) && approved !== name) return { ok: true, held: true, name, button: buttonLike(el) };
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      /* not scrollable */
    }
    // A link that wants a new tab: the page can't open one on its own without a real click, so the extension does.
    const link = closest(el, "a[href]");
    if (link) {
      const base = qsa(doc, "base[target]")[0];
      const target = (attr(link, "target") || (base ? attr(base, "target") : "") || "").toLowerCase();
      const href = String(link.href || "");
      if (target === "_blank" && /^https?:\/\//i.test(href)) return { ok: true, open: href, name, detail: `opened ${name}` };
    }
    pointerClick(el);
    return { ok: true, name, detail: `clicked ${name}` };
  };
  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, " ": 32, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
  const keyEvent = (target, type, key, shift) => {
    const code = key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyCode = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    try {
      return target.dispatchEvent(new win.KeyboardEvent(type, { key, code, keyCode, which: keyCode, shiftKey: Boolean(shift), bubbles: true, cancelable: true, composed: true }));
    } catch {
      return true;
    }
  };
  /**
   * What Enter does from this element, were it pressed: {form, submitter, name}. A form with no submit button and more
   * than one text box doesn't submit on Enter (the browser's own rule).
   */
  const enterTarget = (target) => {
    const form = target ? formOf(target) : null;
    if (!form) return { form: null, submitter: null, name: "", submits: false };
    const submitter = submitterOf(form);
    const boxes = qsa(form, "input").filter((i) => /^(text|search|email|url|tel|number|password)$/.test(typeOf(i))).length;
    return { form, submitter, name: submitter ? nameOf(submitter) : "", submits: Boolean(submitter) || boxes <= 1 };
  };
  const submitForm = (t) => {
    try {
      if (t.submitter) win.HTMLFormElement.prototype.requestSubmit.call(t.form, t.submitter);
      else win.HTMLFormElement.prototype.requestSubmit.call(t.form);
      return true;
    } catch {
      return false;
    }
  };
  const editText = (target, fn) => {
    if (target.isContentEditable === true) return false;
    const v = nativeGet(target);
    let s = v.length;
    let e = v.length;
    try {
      if (typeof target.selectionStart === "number") {
        s = target.selectionStart;
        e = target.selectionEnd;
      }
    } catch {
      /* a type without a caret */
    }
    const [next, caret] = fn(v, s, e);
    if (next === v) return false;
    nativeSet(target, next);
    try {
      target.setSelectionRange(caret, caret);
    } catch {
      /* a type without a caret */
    }
    return true;
  };
  /** A key, with what a real key press would have done — or "none" when nothing on the page took it. */
  const pressKey = (el, key, approved, shift) => {
    const target = el || activeEl() || bodyEl();
    if (!target) return { ok: false, error: "nothing to press on" };
    const tag = tagOf(target);
    const pressable = tag === "button" || tag === "a" || tag === "summary" || (tag === "input" && /^(submit|button|image|reset|checkbox|radio)$/.test(typeOf(target))) || /^(button|link|menuitem|option|tab|checkbox|switch)$/.test(roleOf(target));
    const typing = textField(target) && !secretish(target);
    // What is guarded is settled before any event reaches the page.
    if (key === "Enter" || (key === " " && pressable)) {
      if (pressable) {
        const name = nameOf(target);
        if (GUARD.test(name) && approved !== name) return { ok: true, held: true, name, button: buttonLike(target) };
      } else if (key === "Enter" && tag === "input") {
        const t = enterTarget(target);
        if (t.form && t.submits && GUARD.test(t.name) && approved !== t.name) return { ok: true, held: true, name: t.name, button: true, form: true };
      }
    }
    let effect = "none";
    let name = "";
    const went = keyEvent(target, "keydown", key, shift);
    if (!went) effect = "page"; // the page took the key itself
    else {
      if (key.length === 1 || key === "Enter") keyEvent(target, "keypress", key, shift);
      if (key === "Enter") {
        if (pressable) {
          const r = clickOn(target, approved);
          if (r.open) return Object.assign(r, { key, effect: "click" });
          effect = r.ok && !r.held ? "click" : "none";
          name = r.name || "";
        } else if (tag === "input" && textField(target)) {
          const t = enterTarget(target);
          if (t.form && t.submits && submitForm(t)) {
            effect = "submit";
            name = t.name;
          }
        } else if (tag === "textarea" && typing) {
          if (editText(target, (v, s, e) => [`${v.slice(0, s)}\n${v.slice(e)}`, s + 1])) effect = "newline";
        } else if (target.isContentEditable === true) {
          try {
            if (win.Document.prototype.execCommand.call(doc, "insertParagraph")) effect = "newline";
          } catch {
            /* no editing commands here */
          }
        }
      } else if (key === " ") {
        if (pressable) {
          const r = clickOn(target, approved);
          effect = r.ok && !r.held ? "click" : "none";
          name = r.name || "";
        } else if (typing && tag !== "select") {
          if (target.isContentEditable === true ? win.Document.prototype.execCommand.call(doc, "insertText", false, " ") : editText(target, (v, s, e) => [`${v.slice(0, s)} ${v.slice(e)}`, s + 1])) effect = "edit";
        } else if (scrollPage(null, 0, Math.round((win.innerHeight || 600) * 0.85)).moved) effect = "scroll";
      } else if (key === "Tab") {
        const stops = deep(doc, "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=true]", 2500).filter(
          (n) => n.disabled !== true && attr(n, "tabindex") !== "-1" && typeOf(n) !== "hidden" && shown(n, 2),
        );
        if (stops.length) {
          const at = stops.indexOf(target);
          const next = at < 0 ? stops[shift ? stops.length - 1 : 0] : stops[(at + (shift ? stops.length - 1 : 1)) % stops.length];
          focusOn(next);
          if (next !== target && activeEl() === next) {
            effect = "focus";
            name = secretish(next) ? "a private field" : nameOf(next);
          }
        }
      } else if (key === "Escape") {
        const open = qsa(doc, "dialog[open]").filter((d) => {
          try {
            return d.matches(":modal");
          } catch {
            return false;
          }
        });
        const dialog = open[open.length - 1];
        let full = null;
        try {
          full = docProp("fullscreenElement");
        } catch {
          /* no fullscreen here */
        }
        if (dialog) {
          if (dialog.dispatchEvent(new win.Event("cancel", { cancelable: true }))) {
            try {
              dialog.close();
              effect = "dialog";
            } catch {
              /* stays open */
            }
          } else effect = "page";
        } else if (full) {
          try {
            win.Document.prototype.exitFullscreen.call(doc);
            effect = "fullscreen";
          } catch {
            /* stays full screen */
          }
        }
      } else if (key === "Backspace" || key === "Delete") {
        if (typing && target.isContentEditable === true) {
          try {
            if (win.Document.prototype.execCommand.call(doc, key === "Backspace" ? "delete" : "forwardDelete")) effect = "edit";
          } catch {
            /* no editing commands here */
          }
        } else if (typing && tag !== "select") {
          const back = key === "Backspace";
          if (editText(target, (v, s, e) => (s !== e ? [v.slice(0, s) + v.slice(e), s] : back ? [v.slice(0, Math.max(0, s - 1)) + v.slice(s), Math.max(0, s - 1)] : [v.slice(0, s) + v.slice(s + 1), s]))) effect = "edit";
        }
      } else if (/^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/.test(key)) {
        if (tag === "select" && /^Arrow(Up|Down)$/.test(key)) {
          const i = target.selectedIndex + (key === "ArrowDown" ? 1 : -1);
          if (i >= 0 && i < target.options.length) {
            nativeSet(target, target.options[i].value);
            effect = "select";
          }
        } else if (typing && tag !== "select" && target.isContentEditable !== true && /^(ArrowLeft|ArrowRight|Home|End)$/.test(key)) {
          try {
            const len = nativeGet(target).length;
            const at = typeof target.selectionStart === "number" ? target.selectionStart : len;
            const to = key === "Home" ? 0 : key === "End" ? len : Math.min(len, Math.max(0, at + (key === "ArrowRight" ? 1 : -1)));
            if (to !== at || target.selectionEnd !== to) {
              target.setSelectionRange(to, to);
              effect = "caret";
            }
          } catch {
            /* a type without a caret */
          }
        } else if (!typing) {
          const page = Math.round((win.innerHeight || 600) * 0.85);
          const moved =
            key === "Home"
              ? scrollPage(null, 0, 0, "top").moved
              : key === "End"
                ? scrollPage(null, 0, 0, "bottom").moved
                : scrollPage(null, key === "ArrowLeft" ? -40 : key === "ArrowRight" ? 40 : 0, key === "ArrowDown" ? 40 : key === "ArrowUp" ? -40 : key === "PageDown" ? page : key === "PageUp" ? -page : 0).moved;
          if (moved) effect = "scroll";
        }
      } else if (key.length === 1 && typing && tag !== "select") {
        if (target.isContentEditable === true ? win.Document.prototype.execCommand.call(doc, "insertText", false, key) : editText(target, (v, s, e) => [v.slice(0, s) + key + v.slice(e), s + 1])) effect = "edit";
      }
    }
    keyEvent(target, "keyup", key, shift);
    const res = { ok: true, key, effect };
    if (name) res.name = name;
    return res;
  };
  const act = (c) => {
    const hasRef = c.ref !== null && c.ref !== undefined;
    const el = hasRef ? byRef(c.ref) : c.selector ? qsa(doc, String(c.selector))[0] || null : null;
    if (hasRef && !el) return { ok: false, error: "no such element" };
    const approved = typeof c.approved === "string" ? c.approved : undefined;
    switch (c.action) {
      case "click":
        if (!el) return { ok: false, error: "no such element" };
        return clickOn(el, approved);
      case "type": {
        const target = el || activeEl();
        if (target && secretish(target)) return { ok: false, error: "secret field" };
        if (!target || target === bodyEl() || !textField(target)) return { ok: false, error: el ? "that isn't a text field" : "no field to type into" };
        // A guarded submit is settled first: nothing is typed for a submit that won't happen.
        const t = c.submit ? enterTarget(target) : null;
        if (t && t.form && t.submits && GUARD.test(t.name) && approved !== t.name) return { ok: true, held: true, name: t.name, button: true, form: true };
        try {
          target.scrollIntoView({ block: "center", inline: "nearest" });
        } catch {
          /* not scrollable */
        }
        focusOn(target);
        const text = String(c.text === undefined || c.text === null ? "" : c.text);
        if (target.isContentEditable === true) {
          if (c.clear !== false) {
            const range = win.Document.prototype.createRange.call(doc);
            range.selectNodeContents(target);
            const s = win.getSelection();
            s.removeAllRanges();
            s.addRange(range);
          }
          win.Document.prototype.execCommand.call(doc, "insertText", false, text);
        } else nativeSet(target, c.clear !== false ? text : nativeGet(target) + text);
        const res = { ok: true, name: nameOf(target), detail: `typed into ${nameOf(target)}` };
        if (c.submit) {
          const went = keyEvent(target, "keydown", "Enter");
          if (!went) res.effect = "page";
          else {
            keyEvent(target, "keypress", "Enter");
            res.effect = t && t.form && t.submits && submitForm(t) ? "submit" : "none";
          }
          keyEvent(target, "keyup", "Enter");
        }
        return res;
      }
      case "select": {
        if (!el || tagOf(el) !== "select") return { ok: false, error: "no dropdown there" };
        if (secretish(el)) return { ok: false, error: "secret field" };
        if (!choose(el, [c.text])) return { ok: false, error: `no option like ${clean(c.text).slice(0, 40)}` };
        const opt = el.options[el.selectedIndex];
        return { ok: true, detail: `picked ${clean(opt ? opt.text : c.text)}` };
      }
      case "scroll": {
        if (el) {
          el.scrollIntoView({ block: "center", inline: "nearest" });
          return Object.assign({ ok: true, moved: true }, scrollPage(null, 0, 0));
        }
        const amount = Number(c.amount) || Math.round((win.innerHeight || 600) * 0.85);
        const dir = String(c.direction || "down");
        const r = dir === "top" || dir === "bottom" ? scrollPage(null, 0, 0, dir) : scrollPage(null, 0, dir === "up" ? -amount : amount);
        return Object.assign({ ok: true }, r);
      }
      case "press":
        return pressKey(el, String(c.key || "Enter"), approved, c.shift === true);
      case "focus":
        if (!el) return { ok: false, error: "no such element" };
        focusOn(el);
        return { ok: true };
      case "submitter": {
        const t = enterTarget(el || activeEl());
        return { ok: true, form: Boolean(t.form), submits: t.submits, name: t.name, guarded: GUARD.test(t.name) };
      }
      default:
        return { ok: false, error: `unknown action ${clean(c.action).slice(0, 30)}` };
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // probe and fill
  // ════════════════════════════════════════════════════════════════════════════
  /** Every control that could be filled: {el, kind, by, also, ok} — ok means enabled and really visible. */
  const scan = () => {
    const list = [];
    for (const el of deep(doc, "input, select, textarea", 1500)) {
      const k = kindOf(el);
      if (!k) continue;
      // Usable: enabled, really visible, and — where it is on screen now — not lying under something else.
      const ok = el.disabled !== true && el.readOnly !== true && attr(el, "aria-hidden") !== "true" && shown(el, 8) && onTop(el) !== false;
      list.push({ el, kind: k.kind, by: k.by, also: null, ok });
    }
    const usable = list.filter((f) => f.ok);
    // "Security code" is a card's code only beside a card number; anywhere else it is a one-time code.
    const card = usable.some((f) => f.kind === "cc-number");
    for (const f of list) if (f.kind === "cc-csc" && f.by === "hint" && !card) f.kind = "otp";
    // "Month" and "year" are a card's only beside a card number, too.
    for (const f of list) if ((f.kind === "cc-exp-month" || f.kind === "cc-exp-year" || f.kind === "cc-exp") && f.by === "hint" && !card) f.kind = null;
    // Two password boxes in one form: a sign-up or a password change. Only one marked "current" is the saved one's.
    const groups = new Map();
    for (const f of usable) {
      if (f.kind !== "password") continue;
      const key = formOf(f.el) || doc;
      groups.set(key, (groups.get(key) || []).concat([f]));
    }
    for (const g of groups.values()) if (g.length >= 2) for (const f of g) if (f.by !== "autocomplete") f.kind = "new-password";
    // The user name is the text / email field before the password in the same form.
    const plain = (el) => tagOf(el) === "input" && /^(text|email|tel|url|number)$/.test(typeOf(el));
    for (const p of usable) {
      if (p.kind !== "password") continue;
      const form = formOf(p.el);
      const before = usable.slice(0, usable.indexOf(p)).filter((f) => formOf(f.el) === form && plain(f.el));
      if (before.some((f) => f.kind === "username")) continue;
      const pick = before.reverse().find((f) => f.kind === null || f.kind === "email" || f.kind === "tel" || f.kind === "name");
      if (pick) pick.also = "username";
    }
    // A sign-in that asks for the e-mail first, the password on the next page.
    if (!usable.some((f) => f.kind === "password" || f.kind === "new-password" || f.kind === "username" || f.also === "username")) {
      const mails = usable.filter((f) => f.kind === "email");
      const other = usable.some((f) => /^(name|given-name|family-name|street|address|postal|country|cc-|organization|bday|tel)/.test(String(f.kind)));
      if (mails.length === 1 && !other) mails[0].also = "username";
    }
    return list;
  };
  const crossFrames = () =>
    deep(doc, "iframe", 400).filter((f) => {
      if (!shown(f, 20)) return false;
      try {
        return new URL(attr(f, "src") || "", baseUri()).origin !== win.location.origin;
      } catch {
        return true;
      }
    }).length;
  const probe = () => {
    const list = scan();
    const usable = list.filter((f) => f.ok);
    const kinds = [];
    for (const f of usable) for (const k of [f.kind, f.also]) if (k && k !== "new-password" && !kinds.includes(k)) kinds.push(k);
    // The form that matters: the password's, else the user name's, the code's, the card's, the first field's — and of
    // those, one that keeps what is typed on this site wherever there is one: that is the form a fill uses (fill()
    // skips the others), so its button is the one pressed after it. A form that posts elsewhere leads only when no
    // other form has such a field (formLeaves then says so).
    const leavesBy = new Map();
    const staying = usable.filter((f) => {
      const form = formOf(f.el);
      if (!leavesBy.has(form)) leavesBy.set(form, leaves(form));
      return !leavesBy.get(form);
    });
    const first = (pred) => staying.find(pred) || usable.find(pred);
    const lead =
      first((f) => f.kind === "password") ||
      first((f) => f.kind === "username" || f.also === "username") ||
      first((f) => f.kind === "otp") ||
      first((f) => f.kind === "cc-number") ||
      first((f) => f.kind) ||
      null;
    const form = lead ? formOf(lead.el) : null;
    let submit = form ? submitterOf(form) : null;
    if (!submit && lead) {
      // No <form>: the first button after the field that reads like "sign in / next / continue".
      const after = deep(doc, "button, [role=button], input[type=submit], input[type=button]", 1500).filter((b) => {
        try {
          return Boolean(lead.el.compareDocumentPosition(b) & 4) && b.disabled !== true && shown(b, 2);
        } catch {
          return false;
        }
      });
      submit = after.find((b) => /^(sign in|sign on|log ?in|next|continue|submit|verify|go)\b/i.test(nameOf(b))) || null;
    }
    let submitRef = null;
    let submitName = "";
    if (submit) {
      submitRef = 9001;
      store.refs.set(submitRef, submit);
      submitName = nameOf(submit);
    }
    let formAction = null;
    if (form) {
      try {
        const u = new URL(attr(form, "action") || "", baseUri());
        formAction = u.protocol === "javascript:" ? win.location.origin : u.origin;
      } catch {
        formAction = "invalid";
      }
    }
    return {
      ok: true,
      origin: String(win.location.origin),
      secure: win.isSecureContext === true,
      top: win === win.top,
      kinds,
      submitRef,
      submitName,
      formAction,
      formLeaves: leaves(form),
      frames: crossFrames(),
      signup: usable.some((f) => f.kind === "new-password"),
    };
  };
  /**
   * Whether this fill set about typing anything at all. A fill that fails after that (a box that mangled what it was
   * given, something thrown half way) may have left a value in the page: the worker treats the tab as holding a fill
   * unless it is told `typed: false`.
   */
  let fillTyped = false;
  const fill = (spec) => {
    // Never in a frame, never on another origin, never over plain http.
    if (win !== win.top) return { ok: false, code: "origin-mismatch", typed: false };
    if (win.isSecureContext !== true) return { ok: false, code: "insecure", typed: false };
    if (String(win.location.origin) !== String(spec.origin)) return { ok: false, code: "origin-mismatch", typed: false };
    const given = spec.values && typeof spec.values === "object" ? spec.values : {};
    const v = {};
    for (const k of Object.keys(given)) if (typeof given[k] === "string" && given[k] !== "") v[k] = given[k];
    const list = scan();
    const fieldsFor = (kind) => list.filter((f) => f.ok && (f.kind === kind || f.also === kind));
    const has = (kind) => fieldsFor(kind).length > 0;
    // The page's own shape for the same facts: one expiry box or two, one name box or two, one street box or two.
    const month = v["cc-exp-month"];
    const year = v["cc-exp-year"];
    if (month && year && !has("cc-exp-month") && !has("cc-exp-year") && has("cc-exp")) {
      v["cc-exp"] = `${month}/${year}`;
      delete v["cc-exp-month"];
      delete v["cc-exp-year"];
    } else delete v["cc-exp"];
    if (v.name && !has("name") && (has("given-name") || has("family-name"))) {
      const parts = clean(v.name).split(" ");
      if (!v["given-name"]) v["given-name"] = parts.slice(0, Math.max(1, parts.length - 1)).join(" ");
      if (!v["family-name"] && parts.length > 1) v["family-name"] = parts[parts.length - 1];
      delete v.name;
    } else if (v.name) {
      delete v["given-name"];
      delete v["family-name"];
    }
    if (v["address-line1"] && !has("address-line1") && has("street-address")) {
      v["street-address"] = [v["address-line1"], v["address-line2"]].filter(Boolean).join(", ");
      delete v["address-line1"];
      delete v["address-line2"];
    } else delete v["street-address"];

    /** The first of these fields that is safe to type into: its form stays on this origin, and nothing lies over it. */
    let blocked = false;
    const reachable = (fields) => {
      const out = [];
      for (const f of fields) {
        if (leaves(formOf(f.el))) {
          blocked = true;
          continue;
        }
        let top = onTop(f.el);
        if (top === null) {
          try {
            f.el.scrollIntoView({ block: "center", inline: "nearest" });
          } catch {
            /* not scrollable */
          }
          top = onTop(f.el);
        }
        if (top === true) out.push(f);
      }
      return out;
    };
    const digits = (s) => String(s).replace(/\D/g, "");
    const put = (kind, fields, value) => {
      fillTyped = true;
      const first = fields[0].el;
      // A code or a card number split over several boxes.
      const split = fields.filter((f) => tagOf(f.el) === "input" && Number(attr(f.el, "maxlength")) > 0 && Number(attr(f.el, "maxlength")) <= 4);
      if ((kind === "otp" || kind === "cc-number") && split.length >= 2 && split.length === fields.length) {
        const size = Number(attr(split[0].el, "maxlength"));
        const text = kind === "cc-number" ? digits(value) : String(value);
        if (Math.ceil(text.length / size) !== split.length) return false;
        split.forEach((f, i) => {
          focusOn(f.el);
          nativeSet(f.el, text.slice(i * size, (i + 1) * size));
        });
        return split.every((f, i) => nativeGet(f.el) === text.slice(i * size, (i + 1) * size));
      }
      if (tagOf(first) === "select") {
        let wants = [value];
        if (kind === "cc-exp-month") {
          const m = Number(value);
          const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
          wants = [String(m).padStart(2, "0"), String(m), names[m - 1] || "", (names[m - 1] || "").slice(0, 3)];
        } else if (kind === "cc-exp-year") wants = [String(value), String(value).slice(-2)];
        else if (kind === "country") {
          const c = clean(value).toLowerCase();
          const same = [
            ["us", "usa", "united states", "united states of america"],
            ["gb", "uk", "united kingdom", "great britain"],
          ].find((g) => g.includes(c));
          wants = same ? [value].concat(same) : [value];
        }
        return choose(first, wants);
      }
      let text = String(value);
      if (kind === "cc-exp") {
        // MM/YY unless the box asks for four digits of year; its own separator if it shows one.
        const hint = `${attr(first, "placeholder") || ""} ${attr(first, "pattern") || ""}`.toLowerCase();
        const max = Number(attr(first, "maxlength")) || 0;
        const [mm, yyyy] = text.split("/");
        const longYear = /yyyy|\\d\{4\}|\d{2}\s*\/\s*\d{4}/.test(hint) || max >= 7;
        const sep = /\s\/\s/.test(attr(first, "placeholder") || "") && (max === 0 || max >= (longYear ? 9 : 7)) ? " / " : max === 4 || max === 6 ? "" : "/";
        text = `${String(mm).padStart(2, "0")}${sep}${longYear ? yyyy : String(yyyy).slice(-2)}`;
      } else if (kind === "cc-exp-month") text = String(Number(value)).padStart(2, "0");
      else if (kind === "cc-exp-year") text = Number(attr(first, "maxlength")) === 2 || /\byy\b/i.test(attr(first, "placeholder") || "") ? String(value).slice(-2) : String(value);
      focusOn(first);
      nativeSet(first, text);
      const now = nativeGet(first);
      // A box that reformats what it's given (spaces in a card number) still holds it; one that emptied itself doesn't.
      return kind === "cc-number" || kind === "tel" || kind === "cc-exp" ? digits(now) === digits(text) && now !== "" : now !== "";
    };

    const filled = [];
    const missing = [];
    const ORDER = ["username", "email", "password", "otp", "cc-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "name", "given-name", "family-name", "organization", "tel", "street-address", "address-line1", "address-line2", "address-level2", "address-level1", "postal-code", "country", "bday"];
    const used = new Set();
    for (const kind of ORDER) {
      if (v[kind] === undefined) continue;
      // One box takes one value: an e-mail box that is the user name on this page is filled as the user name.
      const fields = reachable(fieldsFor(kind).filter((f) => !used.has(f.el)));
      if (!fields.length) {
        missing.push(kind);
        continue;
      }
      let done = false;
      try {
        done = put(kind, fields, v[kind]);
      } catch {
        done = false;
      }
      if (done) {
        filled.push(kind);
        for (const f of fields) used.add(f.el);
      } else missing.push(kind);
    }
    if (!filled.length) return { ok: false, code: blocked ? "form-target" : "no-fields", typed: fillTyped };
    // next: the user name went in and this page has no password box yet (it comes after "Next"); otp: a one-time-code
    // box is waiting and nothing went into it.
    let step = "done";
    if (filled.includes("username") && !filled.includes("password") && !has("password")) step = "next";
    else if (has("otp") && !filled.includes("otp")) step = "otp";
    return { ok: true, filled, missing, step, frames: crossFrames() };
  };

  // ════════════════════════════════════════════════════════════════════════════
  // total, and Trinity's own additions
  // ════════════════════════════════════════════════════════════════════════════
  const total = () => {
    const AMOUNT =
      /(?:(?:US|CA|AU|NZ|HK|S)?\$|€|£|¥|₹|\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|INR)\b)\s?\d{1,3}(?:[ ,. ]?\d{3})*(?:[.,]\d{1,2})?|\d{1,3}(?:[ ,. ]?\d{3})*(?:[.,]\d{1,2})?\s?(?:€|£|kr\b|zł|\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|INR)\b)/;
    const STRONG = /\b(?:order|grand|payment|final|cart|basket)\s+total\b|\btotal\s+(?:due|to pay|price|amount|cost|charge|today|payment)\b|\bamount\s+(?:due|to pay|payable)\b|\byou(?:'ll)?\s+pay\b|\bbalance\s+due\b/i;
    const WEAK = /(?<!sub[\s-]?)\btotal\b/i;
    let best = null;
    let i = 0;
    for (const el of deep(doc, "*", 6000)) {
      i++;
      const raw = String(el.textContent || "");
      if (raw.length > 90 || raw.length < 4) continue;
      const strong = STRONG.test(raw);
      if (!strong && !WEAK.test(raw)) continue;
      if (/^(script|style|option|title)$/.test(tagOf(el)) || !shown(el, 2)) continue;
      const near = [raw, el.nextElementSibling ? String(el.nextElementSibling.textContent || "") : "", el.parentElement ? String(el.parentElement.textContent || "").slice(0, 200) : ""];
      let amount = null;
      for (const t of near) {
        // The amount that follows the word, not one before it ("Subtotal $40 Total $51").
        const at = t.search(strong ? STRONG : WEAK);
        const m = AMOUNT.exec(at >= 0 ? t.slice(at) : t);
        if (m) {
          amount = clean(m[0]);
          break;
        }
      }
      if (!amount) continue;
      const rank = strong ? 2 : 1;
      if (!best || rank > best.rank || (rank === best.rank && i > best.i)) best = { rank, i, amount, label: clean(raw.replace(AMOUNT, "")).slice(0, 40) };
    }
    return best ? { ok: true, total: best.amount.slice(0, 24), label: best.label } : { ok: true, total: null, label: "" };
  };
  /** A node's own property, read past anything the markup has named after it (a form's controls hide its built-ins). */
  const nodeProp = (node, name) => {
    try {
      for (const p of [E, win.Node.prototype]) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d && d.get) return d.get.call(node);
      }
    } catch {
      /* fall through */
    }
    return node[name];
  };
  /**
   * Static markup into the page, marked so it can be removed. Taken out first: whatever runs (scripts, handlers,
   * script: addresses — also ones that are animated in, or spelt with a tab inside), whatever brings another document
   * (frames, objects), whatever takes input (forms and their fields), and style sheets that fetch things (url(),
   * @import: a sheet like that can carry what it matches away).
   */
  const insertHtml = (spec) => {
    const DROP = /^(script|template|iframe|frame|frameset|object|embed|portal|fencedframe|link|meta|base|form|input|textarea|select|button|animate|set|animatetransform|animatemotion)$/;
    const ADDRESS = /^(href|src|action|formaction|xlink:href|data|poster|background|srcdoc|ping)$/i;
    const wrap = win.Document.prototype.createElement.call(doc, "div");
    E.setAttribute.call(wrap, "data-trinity", "html");
    wrap.innerHTML = String(spec.html || "");
    for (const n of qsa(wrap, "*")) {
      const tag = String(nodeProp(n, "localName") || "").toLowerCase();
      if (DROP.test(tag) || (tag === "style" && /url\s*\(|@import/i.test(String(nodeProp(n, "textContent") || "")))) {
        E.remove.call(n);
        continue;
      }
      for (const name of Array.from(E.getAttributeNames.call(n))) {
        // A scheme still works with tabs, line breaks and spaces inside or before it: they come out before it is read.
        const scheme = String(attr(n, name) || "").replace(/[\u0000- \u007f-\u009f]+/g, "");
        if (/^on/i.test(name) || (ADDRESS.test(name) && /^(javascript|data|vbscript):/i.test(scheme))) E.removeAttribute.call(n, name);
      }
    }
    const target = spec.selector ? qsa(doc, String(spec.selector))[0] : bodyEl();
    if (!target) return { ok: false, error: "no such element" };
    const N = win.Node.prototype;
    if (spec.position === "bottom") N.appendChild.call(target, wrap);
    else N.insertBefore.call(target, wrap, nodeProp(target, "firstChild") || null);
    return { ok: true };
  };
  const removeInjected = () => {
    const mine = qsa(doc, "[data-trinity]");
    for (const n of mine) E.remove.call(n);
    return { ok: true, removed: mine.length };
  };

  const op = cmd && cmd.op;
  if (op === "fill") {
    // Whatever goes wrong in a fill, its words stay here: only a code leaves.
    try {
      return fill(cmd);
    } catch {
      return { ok: false, code: "failed", typed: fillTyped };
    }
  }
  try {
    if (op === "snapshot") return snapshot(cmd);
    if (op === "act") return act(cmd);
    if (op === "probe") return probe();
    if (op === "total") return total();
    if (op === "insertHtml") return insertHtml(cmd);
    if (op === "removeInjected") return removeInjected();
    if (op === "guard") return { ok: true, guarded: GUARD.test(String(cmd.name || "")) };
    return { ok: false, error: "unknown op" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}

/** Runs in the page's MAIN world: the site's own rules apply (a strict CSP refuses eval). */
export function pageEval(code) {
  try {
    const v = (0, eval)(code);
    let s = "";
    if (v !== undefined && v !== null) {
      if (typeof v === "string") s = v;
      else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = String(v);
        }
      }
    }
    return { ok: true, result: String(s).slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 400) };
  }
}

// ─── For tests and the fixture pages (these call pageMain where they stand; they are never injected) ───
export const pageSnapshot = (opts) => pageMain(Object.assign({ op: "snapshot" }, opts || {}));
export const pageAct = (c) => pageMain(Object.assign({ op: "act" }, c || {}));
export const probeFields = () => pageMain({ op: "probe" });
export const fillFields = (spec) => pageMain(Object.assign({ op: "fill" }, spec || {}));
export const pageTotal = () => pageMain({ op: "total" });
