import { pageTitle } from "../services/mordiem.js";
import { workspace, type WorkspaceTemplate } from "./bus.js";

/**
 * The floating card board: one workspace app that holds many numbered cards
 * (image / audio / video / text / widget). Cards are absolutely positioned so the
 * user can ask to move or remove "card 2". Media and build_ui add cards — they
 * never replace the whole screen (unless a game owns it).
 */

export type CardKind = "image" | "audio" | "video" | "text" | "widget";
export type CardStatus = "pending" | "ready" | "error";

export interface BoardCard {
  /** Stable number spoken by the user ("remove card 3"). Never renumbered. */
  n: number;
  kind: CardKind;
  status: CardStatus;
  /** Absolute position in % of the board (0–100). */
  x: number;
  y: number;
  /** Width hint in % of the board. */
  w: number;
  /** Optional height in % of the board; omit for content-sized height. */
  h?: number;
  /** Stacking order (higher sits on top). */
  z: number;
  title: string;
  /** Caption / prompt / spoken text / build request. */
  text: string;
  /**
   * Content tags so the user can say "the tiger" / "the panda" instead of only "card 3".
   * Derived from the prompt/title when the card is created; kept on edits.
   */
  tags?: string[];
  /** Media URL once ready (`/api/images/…`, `/api/audio/…`, `/api/videos/…`). */
  url: string | null;
  /** Interactive HTML fragment for widget cards (timers, charts, apps) — or a media card opened for HTML edits. */
  html?: string | null;
  /** Display width of the media (img/video) inside the card, as % of the card body (default 100). */
  mw?: number;
  /** Display height of the media as % of the card body; omit for auto. */
  mh?: number;
  model?: string;
  error?: string;
  /** The layout before a maximize / minimize, so "restore" can put the card back. */
  prev?: { x: number; y: number; w: number; h?: number; z: number };
}

export interface BoardState {
  cards: BoardCard[];
}

export const BOARD_OWNER = "board";

const CARD_W: Record<CardKind, number> = { image: 34, audio: 32, video: 40, text: 28, widget: 38 };
const SLOT: Array<{ x: number; y: number }> = [
  { x: 4, y: 6 },
  { x: 42, y: 8 },
  { x: 8, y: 44 },
  { x: 46, y: 46 },
  { x: 22, y: 24 },
  { x: 58, y: 22 },
  { x: 12, y: 64 },
  { x: 50, y: 66 },
];

/**
 * The runtime that operates a card from inside it — the board's own video and audio, and every widget's document:
 * its controls by label, its fields, its media, its scrolling, and the window.trinityControls hooks a widget may
 * define. Plain ES5 with no backticks, no "${" and no closing tags, so it can sit in a script tag and inside a string.
 */
const CARD_RUNTIME = String.raw`(function () {
  if (window.__trinityCard) return;
  var SYN = {
    play: ["start", "play", "resume", "go", "begin", "run", "unpause", "continue", "\u25b6", "\u25ba", "\u23f5"],
    pause: ["pause", "stop", "halt", "hold", "freeze", "\u23f8", "\u23f9", "\u25a0", "\u275a\u275a"],
    restart: ["restart", "replay", "start over", "play again", "again", "new game", "\u21bb", "\u27f3"],
    reset: ["reset", "clear", "zero", "\u21ba", "\u27f2", "\ud83d\udd04"],
    next: ["next", "forward", "skip", "\u203a", "\u00bb", "\u2192", "\u23ed"],
    previous: ["previous", "prev", "back", "\u2039", "\u00ab", "\u2190", "\u23ee"],
    mute: ["mute", "sound off", "\ud83d\udd07"],
    unmute: ["unmute", "sound on", "\ud83d\udd0a", "\ud83d\udd08"]
  };
  var AVOID = { play: SYN.restart.concat(SYN.reset, SYN.previous), next: SYN.previous, previous: SYN.next };
  var ALIAS = { play: ["play", "start", "resume"], pause: ["pause", "stop"], restart: ["restart"], reset: ["reset", "clear"], next: ["next"], previous: ["previous", "prev", "back"], set: ["set"], read: ["read", "status"], mute: ["mute"], unmute: ["unmute"], press: ["press"] };
  var MEDIA = { play: 1, pause: 1, restart: 1, reset: 1, mute: 1, unmute: 1, louder: 1, quieter: 1, forward: 1, back: 1, loop: 1, no_loop: 1, faster: 1, slower: 1, normal_speed: 1 };
  var CONTROL = 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"],a[href],[onclick],[data-action]';
  function canon(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-").replace(/\u2212/g, "-")
      .replace(/\b(?:minutes?|mins?)\b/g, "min").replace(/\b(?:seconds?|secs?)\b/g, "sec").replace(/\b(?:hours?|hrs?)\b/g, "hr")
      .replace(/\bone\b/g, "1").replace(/\btwo\b/g, "2").replace(/\bfive\b/g, "5").replace(/\bten\b/g, "10")
      .replace(/([+\-\u00d7\u00f7])/g, " $1 ").replace(/(\d)([a-z])/g, "$1 $2")
      .replace(/\s+/g, " ").trim();
  }
  function nameOf(el) {
    var l = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (!l) l = el.tagName === "INPUT" ? el.value : (el.innerText || el.textContent || "");
    return String(l).replace(/\s+/g, " ").trim().slice(0, 60);
  }
  function labelOf(el) { return canon(nameOf(el)).slice(0, 60); }
  function shown(el) {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }
  function controls(root) {
    var q = root.querySelectorAll(CONTROL), out = [];
    for (var i = 0; i < q.length; i++) {
      var el = q[i];
      if (!shown(el)) continue;
      var outer = el.parentElement && el.parentElement.closest ? el.parentElement.closest(CONTROL) : null;
      if (outer && root.contains(outer)) continue;
      var l = labelOf(el);
      if (l) out.push({ el: el, label: l, name: nameOf(el) });
    }
    return out;
  }
  function labels(root) {
    var cs = controls(root), out = [];
    for (var i = 0; i < cs.length && out.length < 30; i++) if (out.indexOf(cs[i].name) < 0) out.push(cs[i].name);
    return out;
  }
  function score(label, words) {
    var best = 0;
    for (var i = 0; i < words.length; i++) {
      var w = canon(words[i]);
      if (!w) continue;
      if (label === w) return 3;
      var symbol = !/[a-z0-9]/.test(w);
      if (symbol ? label.indexOf(w) >= 0 : (" " + label + " ").indexOf(" " + w + " ") >= 0) best = 2;
    }
    return best;
  }
  function find(root, words, avoid) {
    var cs = controls(root), best = null, bs = 0;
    for (var i = 0; i < cs.length; i++) {
      var s = score(cs[i].label, words);
      if (!s) continue;
      if (avoid && s < 3 && score(cs[i].label, avoid) >= 2) continue;
      if (s > bs) { bs = s; best = cs[i]; }
    }
    return best;
  }
  function press(root, arg) {
    var want = canon(arg).replace(/\b(?:the|a|an|button|control|key)\b/g, " ").replace(/\s+/g, " ").trim();
    if (!want) return { ok: false, reason: "no-control", controls: labels(root) };
    var cs = controls(root), toks = want.split(" "), best = null, bs = 0;
    for (var i = 0; i < cs.length; i++) {
      var l = cs[i].label, s = 0;
      if (l === want) s = 100;
      else if ((" " + l + " ").indexOf(" " + want + " ") >= 0) s = 60;
      else {
        for (var k = 0; k < toks.length; k++) if (toks[k] && (" " + l + " ").indexOf(" " + toks[k] + " ") >= 0) s += 20;
        if (s && l.split(" ").length > toks.length + 2) s -= 5;
      }
      if (s > bs) { bs = s; best = cs[i]; }
    }
    if (!best) return { ok: false, reason: "no-control", controls: labels(root) };
    best.el.click();
    return { ok: true, via: "click", label: best.name };
  }
  function fields(root) {
    var q = root.querySelectorAll('input,textarea,select,[contenteditable="true"],[contenteditable=""]'), out = [];
    for (var i = 0; i < q.length; i++) {
      var el = q[i], ty = (el.getAttribute("type") || "").toLowerCase();
      if (/^(?:button|submit|reset|checkbox|radio|hidden|file|image|color)$/.test(ty) || !shown(el)) continue;
      out.push(el);
    }
    return out;
  }
  function fieldName(el) {
    var lab = "";
    try { if (el.labels && el.labels.length) lab = el.labels[0].innerText || ""; } catch (e) {}
    return String(lab || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }
  function fieldLabel(el) {
    var l = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
    try { if (el.labels && el.labels.length) l = (el.labels[0].innerText || "") + " " + l; } catch (e) {}
    return canon(l).slice(0, 60);
  }
  function clock(value) {
    var v = canon(value), m = /(\d+)\s*:\s*(\d{1,2})/.exec(v);
    if (m) return m[1] + ":" + ("0" + m[2]).slice(-2);
    var mins = /(\d+(?:\.\d+)?)\s*min/.exec(v), secs = /(\d+)\s*sec/.exec(v), hrs = /(\d+)\s*hr/.exec(v);
    if (!mins && !secs && !hrs) return /^\d+$/.test(v) ? v + ":00" : null;
    var total = (hrs ? Number(hrs[1]) * 3600 : 0) + (mins ? Number(mins[1]) * 60 : 0) + (secs ? Number(secs[1]) : 0);
    return Math.floor(total / 60) + ":" + ("0" + Math.round(total % 60)).slice(-2);
  }
  function setValue(root, arg) {
    var value = arg && typeof arg === "object" ? String(arg.value == null ? "" : arg.value) : String(arg == null ? "" : arg);
    var want = canon(arg && typeof arg === "object" && arg.field ? arg.field : "");
    if (!want) { var unit = /\b(min|sec|hr)\b/.exec(canon(value)); if (unit) want = unit[1]; }
    var fs = fields(root);
    if (!fs.length) return { ok: false, reason: "no-field", controls: labels(root) };
    var el = fs.length === 1 ? fs[0] : null;
    if (!el && want) {
      var bs = 0, tw = want.split(" ");
      for (var i = 0; i < fs.length; i++) {
        var fl = fieldLabel(fs[i]), s = 0;
        for (var k = 0; k < tw.length; k++) if (tw[k] && fl.indexOf(tw[k]) >= 0) s++;
        if (s > bs) { bs = s; el = fs[i]; }
      }
    }
    if (!el) el = fs[0];
    var ty = (el.getAttribute("type") || "").toLowerCase(), v = value, hint = String(el.value || "") + " " + (el.getAttribute("placeholder") || "");
    if (ty === "number" || ty === "range") {
      var num = /-?\d+(?:\.\d+)?/.exec(canon(value));
      if (!num) return { ok: false, reason: "error", detail: "not a number: " + value };
      v = num[0];
    } else if (/\d+\s*:\s*\d\d/.test(hint) || /mm\s*:\s*ss/i.test(hint)) {
      v = clock(value) || value;
    }
    if (el.tagName === "SELECT") {
      var o = el.options, at = -1, cv = canon(value);
      for (var j = 0; j < o.length; j++) { var ot = canon(o[j].text); if (ot === cv || ot.indexOf(cv) >= 0) { at = j; break; } }
      if (at < 0) return { ok: false, reason: "error", detail: "no option like " + value };
      el.selectedIndex = at;
      v = o[at].text;
    } else if (el.isContentEditable) el.textContent = v;
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    var confirm = find(root, ["set", "apply", "ok", "save", "update", "done"]);
    if (confirm && confirm.el !== el) confirm.el.click();
    else {
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      } catch (e) {}
    }
    return { ok: true, via: "input", label: fieldName(el) || el.tagName.toLowerCase(), detail: String(v) };
  }
  function scroller(root) {
    var doc = root.ownerDocument || document, best = null, area = 0, all = root.querySelectorAll("*");
    for (var i = 0; i < all.length && i < 3000; i++) {
      var el = all[i];
      if (el.scrollHeight > el.clientHeight + 8) {
        var oy = window.getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll") { var a = el.clientWidth * el.clientHeight; if (a > area) { area = a; best = el; } }
      }
    }
    if (!best && root === doc.body) best = doc.scrollingElement || doc.documentElement;
    return best;
  }
  function scroll(root, op) {
    var el = scroller(root);
    if (!el) return { ok: false, reason: "at-end", detail: "nothing to scroll" };
    var before = el.scrollTop, h = el.clientHeight || 300;
    if (op === "scroll_top") el.scrollTop = 0;
    else el.scrollTop = before + (op === "scroll_down" ? 0.8 : -0.8) * h;
    return Math.abs(el.scrollTop - before) > 1 ? { ok: true, via: "scroll" } : { ok: false, reason: op === "scroll_down" ? "at-end" : "at-top" };
  }
  function fmt(t) { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ":" + (t % 60 < 10 ? "0" : "") + (t % 60); }
  function mediaState(m) {
    return { paused: !!m.paused, t: Math.round((m.currentTime || 0) * 10) / 10, dur: isFinite(m.duration) ? Math.round(m.duration * 10) / 10 : 0, muted: !!m.muted, volume: Math.round((m.volume || 0) * 100) / 100, rate: m.playbackRate || 1, loop: !!m.loop };
  }
  function mediaText(m) {
    return (m.paused ? "paused" : "playing") + " at " + fmt(m.currentTime) + (isFinite(m.duration) ? " of " + fmt(m.duration) : "") + (m.muted ? ", muted" : "") + (m.loop ? ", looping" : "") + (m.playbackRate && m.playbackRate !== 1 ? ", " + m.playbackRate + "x speed" : "");
  }
  function readText(root) {
    var t = String(root.innerText || root.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    var extra = [], fs = fields(root);
    for (var i = 0; i < fs.length && i < 10; i++) {
      var el = fs[i], v = el.tagName === "SELECT" ? ((el.options[el.selectedIndex] || {}).text || "") : el.isContentEditable ? "" : String(el.value || "");
      if (v) extra.push((fieldName(el) || "field") + ": " + v);
    }
    var ms = root.querySelectorAll("video,audio");
    for (var j = 0; j < ms.length && j < 3; j++) extra.push((ms[j].tagName === "VIDEO" ? "video " : "audio ") + mediaText(ms[j]));
    return (t + (extra.length ? "\n" + extra.join("\n") : "")).slice(0, 4000);
  }
  function settle(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function mediaOp(m, op, arg) {
    var sec = Number(arg), playing = !m.paused;
    if (!isFinite(sec) || sec <= 0) sec = 10;
    if (op === "play" && playing) return Promise.resolve({ ok: true, via: "media", already: "playing", media: mediaState(m) });
    try {
      if (op === "pause") m.pause();
      else if (op === "reset") { m.pause(); m.currentTime = 0; }
      else if (op === "restart") m.currentTime = 0;
      else if (op === "mute") m.muted = true;
      else if (op === "unmute") { m.muted = false; if (!m.volume) m.volume = 0.7; }
      else if (op === "louder") { m.muted = false; m.volume = Math.min(1, Math.round(((m.volume || 0) + 0.2) * 100) / 100); }
      else if (op === "quieter") m.volume = Math.max(0, Math.round(((m.volume || 0) - 0.2) * 100) / 100);
      else if (op === "forward") m.currentTime = Math.min(isFinite(m.duration) ? m.duration : 1e9, (m.currentTime || 0) + sec);
      else if (op === "back") m.currentTime = Math.max(0, (m.currentTime || 0) - sec);
      else if (op === "loop") m.loop = true;
      else if (op === "no_loop") m.loop = false;
      else if (op === "faster") m.playbackRate = Math.min(3, (m.playbackRate || 1) + 0.25);
      else if (op === "slower") m.playbackRate = Math.max(0.25, (m.playbackRate || 1) - 0.25);
      else if (op === "normal_speed") m.playbackRate = 1;
    } catch (err) {
      return Promise.resolve({ ok: false, reason: "error", detail: String((err && err.message) || err).slice(0, 160) });
    }
    if (op === "play" || op === "restart") {
      var p;
      try { p = m.play(); } catch (err) { p = Promise.reject(err); }
      return Promise.resolve(p).then(function () { return { ok: true, via: "media", media: mediaState(m) }; }, function (err) {
        return { ok: false, reason: err && err.name === "NotAllowedError" ? "blocked" : "error", detail: String((err && err.message) || err).slice(0, 160), media: mediaState(m) };
      });
    }
    if ((op === "unmute" || op === "louder") && playing) {
      // A browser that won't play sound without a click pauses the media instead: say so, and keep it playing muted.
      return settle(250).then(function () {
        if (m.paused) { m.muted = true; try { m.play(); } catch (e) {} return { ok: false, reason: "blocked", media: mediaState(m) }; }
        return { ok: true, via: "media", media: mediaState(m) };
      });
    }
    return Promise.resolve({ ok: true, via: "media", media: mediaState(m) });
  }
  function byVerb(root, op) {
    var hit = find(root, SYN[op], AVOID[op]);
    if (hit) { hit.el.click(); return { ok: true, via: "click", label: hit.name }; }
    if (op === "restart") {
      var r = find(root, SYN.reset);
      if (r) {
        r.el.click();
        var s = find(root, SYN.play, AVOID.play);
        if (s) setTimeout(function () { var again = find(root, SYN.play, AVOID.play); if (again) again.el.click(); }, 80);
        return { ok: true, via: "click", label: r.name + (s ? " + " + s.name : "") };
      }
    }
    if (op === "play") { var running = find(root, SYN.pause); if (running) return { ok: true, already: "running", label: running.name }; }
    if (op === "pause") { var idle = find(root, SYN.play, AVOID.play); if (idle) return { ok: true, already: "paused", label: idle.name }; }
    return { ok: false, reason: "no-control", controls: labels(root) };
  }
  function hook(op) {
    var h = window.trinityControls;
    if (!h || typeof h !== "object") return null;
    var names = ALIAS[op] || [op];
    for (var i = 0; i < names.length; i++) if (typeof h[names[i]] === "function") return h[names[i]];
    return null;
  }
  function run(root, op, arg) {
    try {
      if (op === "read") {
        var reader = hook("read"), extra = "";
        if (reader) { try { extra = String(reader() || ""); } catch (e) {} }
        return Promise.resolve({ ok: true, via: "read", text: ((extra ? extra + "\n" : "") + readText(root)).slice(0, 4000) });
      }
      if (op === "controls") return Promise.resolve({ ok: true, via: "read", controls: labels(root) });
      var h = hook(op);
      if (!h && op === "restart" && hook("reset") && hook("play")) {
        var doReset = hook("reset"), doPlay = hook("play");
        return Promise.resolve().then(function () { return doReset(); }).then(function () { return doPlay(); }).then(function () { return { ok: true, via: "hook", label: "restart" }; });
      }
      if (h) return Promise.resolve().then(function () { return h(arg && typeof arg === "object" ? arg.value : arg); }).then(function () { return { ok: true, via: "hook", label: op }; });
      var media = root.querySelector("video,audio");
      if (media && MEDIA[op]) return mediaOp(media, op, arg);
      if (op === "press") return Promise.resolve(press(root, arg));
      if (op === "set") return Promise.resolve(setValue(root, arg));
      if (op === "scroll_down" || op === "scroll_up" || op === "scroll_top") return Promise.resolve(scroll(root, op));
      if (SYN[op]) return Promise.resolve(byVerb(root, op));
      return Promise.resolve({ ok: false, reason: "no-control", controls: labels(root) });
    } catch (err) {
      return Promise.resolve({ ok: false, reason: "error", detail: String((err && err.message) || err).slice(0, 160) });
    }
  }
  window.__trinityCard = { run: run, mediaOp: mediaOp, mediaText: mediaText, mediaState: mediaState, readText: readText, scroll: scroll, labels: labels };
})();`;

/** In a widget's document: run what the board sends (from the board only) and answer it. */
const CARD_LISTENER = String.raw`(function () {
  if (window.__trinityCardListening) return;
  window.__trinityCardListening = true;
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.__trinity !== "cmd" || !window.__trinityCard) return;
    var id = d.id;
    var reply = function (r) {
      var out = {};
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k];
      out.__trinity = "cmd_result";
      out.id = id;
      try { window.parent.postMessage(out, "*"); } catch (x) {}
    };
    window.__trinityCard.run(document.body || document.documentElement, String(d.op || ""), d.arg).then(reply, function (err) {
      reply({ ok: false, reason: "error", detail: String((err && err.message) || err).slice(0, 160) });
    });
  });
})();`;

export const BOARD_TEMPLATE: WorkspaceTemplate = {
  id: "board@7",
  kind: "default",
  name: "Card board",
  source:
    String.raw`<style>
:where(body){margin:0;min-height:100%;background:
  radial-gradient(1200px 700px at 12% -10%,rgba(103,232,249,.08),transparent 55%),
  radial-gradient(900px 600px at 110% 10%,rgba(167,139,250,.08),transparent 50%),
  #0c0c14;color:#e8e8ef;font:13px/1.45 system-ui,sans-serif;overflow:hidden}
#board{position:relative;width:100%;height:100vh;min-height:100%}
.empty{position:absolute;inset:0;display:grid;place-items:center;color:#7a7a9a;font-size:14px;pointer-events:none}
.card{position:absolute;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:16px;
  background:rgba(20,20,34,.92);border:1px solid rgba(255,255,255,.1);box-shadow:0 18px 50px rgba(0,0,0,.45);
  backdrop-filter:blur(10px);animation:rise .4s cubic-bezier(.2,.8,.2,1) both;overflow:hidden;touch-action:none;
  transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1),width .5s cubic-bezier(.2,.8,.2,1),height .5s cubic-bezier(.2,.8,.2,1)}
.card.widget,.card.has-h{min-height:220px}
.card.has-h .body{min-height:0}
.card.has-h .body iframe{height:100%;min-height:0;max-height:none;flex:1}
.card.is-drag,.card.is-resize{z-index:10000!important;animation:none;transition:none;user-select:none}
.card.is-drag{cursor:grabbing}
.chrome{cursor:grab;user-select:none;-webkit-user-select:none}
.chrome:active{cursor:grabbing}
.badge{position:absolute;top:10px;left:10px;z-index:2;min-width:26px;height:26px;padding:0 8px;border-radius:999px;
  display:grid;place-items:center;font-size:12px;font-weight:700;color:#0c0c14;background:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.25);pointer-events:none}
.kind{position:absolute;top:12px;right:28px;z-index:2;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#a5a5c6;pointer-events:none}
.title{margin:28px 0 0;font-size:12.5px;font-weight:600;color:#c9c9dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{position:relative;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.03);min-height:120px;flex:1;display:flex;flex-direction:column}
.body img,.body video{display:block;width:100%;max-width:100%;max-height:42vh;object-fit:contain;background:#000;opacity:0;transition:opacity .45s}
.body img.is-on,.body video.is-on{opacity:1}
.body iframe{display:block;width:100%;height:min(42vh,360px);border:0;border-radius:12px;background:#0f0f18;flex:1}
.grip{position:absolute;right:4px;bottom:4px;z-index:4;width:18px;height:18px;cursor:nwse-resize;border-radius:4px;
  background:linear-gradient(135deg,transparent 50%,rgba(167,139,250,.55) 50%);opacity:.7}
.grip:hover{opacity:1}
.shim{width:100%;aspect-ratio:1;border-radius:12px;background:linear-gradient(110deg,rgba(255,255,255,.03) 30%,rgba(255,255,255,.09) 50%,rgba(255,255,255,.03) 70%);background-size:220% 100%;animation:shim 1.6s linear infinite}
.shim.wide{aspect-ratio:16/9}
.shim.tall{aspect-ratio:4/3}
.shim.still{animation:none;background:rgba(255,255,255,.03);border:1px dashed rgba(252,165,165,.35)}
.cap{margin:0;color:#a5a5c6;font-size:12px;line-height:1.45;max-height:4.5em;overflow:hidden}
.cap.err{color:#fca5a5}
.text-body{margin:0;padding:8px 2px;color:#e8e8ef;font-size:14px;line-height:1.55;white-space:pre-wrap;overflow:auto;max-height:36vh}
.player{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}
.btn{flex:none;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;color:#0c0c14;background:#a78bfa;display:grid;place-items:center}
.btn:disabled{background:#34344c;color:#8a8aa6;cursor:default}
.btn svg{width:18px;height:18px;fill:currentColor}
.bar{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.track{height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.fill{height:100%;width:0;background:linear-gradient(90deg,#67e8f9,#a78bfa)}
.time{font-size:11px;color:#a5a5c6;font-variant-numeric:tabular-nums;display:flex;justify-content:space-between}
@keyframes shim{from{background-position:120% 0}to{background-position:-100% 0}}
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<script>${CARD_RUNTIME}</script>
<div id="board"></div>
<script>
(function () {
  var board = document.getElementById("board");
  var audioBy = Object.create(null);
  var widgetHtml = Object.create(null);
  var local = Object.create(null);
  var busy = Object.create(null);
  var zTop = 1;
  var cardsBy = Object.create(null);
  var waiting = Object.create(null);
  var RT = window.__trinityCard;
  var CARD_RT = ${JSON.stringify(`${CARD_RUNTIME}
${CARD_LISTENER}`)};
  var PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>';
  var BROWSE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
  // Each widget document is hardened like the board's own frame (web/src/workspace/frame.ts): no WebRTC side
  // channel, no frames of its own, and a link goes to the host through the board instead of navigating the card.
  // (Built by concatenation: a script tag or an HTML comment written out whole would end THIS script early.)
  var GUARD = "<scr" + "ipt>(function(){" +
    '["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceCandidate","RTCSessionDescription"].forEach(function(n){try{Object.defineProperty(window,n,{configurable:false,writable:false,value:undefined})}catch(e){}});' +
    'function isFrame(n){var m=n.nodeName.toUpperCase();return m==="IFRAME"||m==="FRAME"||m==="OBJECT"||m==="EMBED"}' +
    'try{new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){var a=rs[i].addedNodes;for(var j=0;j<a.length;j++){var n=a[j];if(!n||n.nodeType!==1)continue;if(isFrame(n)){if(n.parentNode)n.parentNode.removeChild(n);continue}if(n.querySelectorAll){var q=n.querySelectorAll("iframe,frame,object,embed");for(var k=0;k<q.length;k++)if(q[k].parentNode)q[k].parentNode.removeChild(q[k])}}}}).observe(document,{childList:true,subtree:true})}catch(e){}' +
    'document.addEventListener("click",function(e){var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=(a.getAttribute("href")||"").trim();var l=h.toLowerCase();if(l.indexOf("https://")===0||l.indexOf("http://")===0){e.preventDefault();try{parent.postMessage({__trinity:"link",href:h},"*")}catch(x){}}else if(l.charAt(0)!=="#"){e.preventDefault()}},true);' +
    "})()<" + "/script><scr" + "ipt>" + CARD_RT + "<" + "/script>";
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
  function fmt(t){t=Math.max(0,Math.floor(t||0));return Math.floor(t/60)+":"+(t%60<10?"0":"")+(t%60);}
  function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
  function emit(evt){ try{ if(window.trinity&&window.trinity.send) window.trinity.send(evt); }catch(e){} }
  function externalSrc(html){
    // Avoid a literal HTML comment opener in this script — parsers treat that as a script escape and truncate us.
    var s=String(html||"").replace(/^\s+/, "");
    while(s.charCodeAt(0)===60 && s.charCodeAt(1)===33){ // "<!"
      var end=s.indexOf(">");
      if(end<0) break;
      s=s.slice(end+1).replace(/^\s+/, "");
    }
    var m=/^<iframe\b([^>]*)>/i.exec(s);
    if(!m) return null;
    var src=/\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/i.exec(m[1]||"");
    return src?src[1]:null;
  }
  function layoutOf(c){
    var L=local[c.n];
    if(!L) return c;
    return {n:c.n,kind:c.kind,status:c.status,x:L.x,y:L.y,w:L.w,h:L.h,z:L.z,title:c.title,text:c.text,url:c.url,html:c.html,mw:c.mw,mh:c.mh,model:c.model,error:c.error};
  }
  function remember(c){
    if(busy[c.n]) return;
    local[c.n]={x:Number(c.x)||0,y:Number(c.y)||0,w:Number(c.w)||32,h:c.h!=null&&c.h!==""?Number(c.h):null,z:Number(c.z)||1};
    if(local[c.n].z>zTop) zTop=local[c.n].z;
  }
  function applyBox(el, L){
    el.style.left=clamp(L.x,0,90)+"%";
    el.style.top=clamp(L.y,0,90)+"%";
    el.style.width=clamp(L.w,12,98)+"%";
    if(L.h!=null&&isFinite(L.h)){ el.style.height=clamp(L.h,14,98)+"%"; el.classList.add("has-h"); }
    else { el.style.height=""; el.classList.remove("has-h"); }
    el.style.zIndex=String(L.z||1);
  }
  function persist(n){
    var L=local[n]; if(!L) return;
    emit({__trinity:"board",op:"layout",n:n,x:Math.round(L.x*10)/10,y:Math.round(L.y*10)/10,w:Math.round(L.w*10)/10,h:L.h==null?null:Math.round(L.h*10)/10,z:L.z});
  }
  function refreshAudio(n){
    var a=audioBy[n], root=board.querySelector('[data-n="'+n+'"]');
    if(!a||!root) return;
    var btn=root.querySelector(".btn"), fill=root.querySelector(".fill"), time=root.querySelector(".time");
    if(btn){btn.innerHTML=a.paused?PLAY:PAUSE;btn.setAttribute("aria-label",a.paused?"Play":"Pause");}
    var d=isFinite(a.duration)?a.duration:0;
    if(fill) fill.style.width=d?(100*a.currentTime/d)+"%":"0";
    if(time) time.innerHTML="<span>"+fmt(a.currentTime)+"</span><span>"+fmt(d)+"</span>";
  }
  function pendingLabel(c){
    if(c.kind==="image") return "Painting";
    if(c.kind==="audio") return "Recording";
    if(c.kind==="video") return "Filming";
    if(c.kind==="widget") return "Building";
    return "Writing";
  }
  function mediaBody(c){
    if(c.html){
      if(c.status==="error") return '<p class="cap err">'+esc(c.error||"Couldn't edit that")+"</p>";
      return '<iframe sandbox="allow-scripts" allow="autoplay" title="'+esc(c.title||("Card "+c.n))+'"></iframe>';
    }
    if(c.kind==="widget"){
      if(c.status==="error") return '<p class="cap err">'+esc(c.error||"Couldn't build that")+"</p>";
      return '<div class="shim tall'+(c.status==="error"?" still":"")+'"></div>';
    }
    if(c.kind==="text"){
      if(c.status==="error") return '<p class="cap err">'+esc(c.error||"Couldn't add that text")+"</p>";
      return '<p class="text-body">'+esc(c.text||"")+"</p>";
    }
    if(c.kind==="audio"){
      var ready=c.status==="ready"&&c.url;
      var h='<div class="player"><button class="btn" type="button" data-play="'+c.n+'"'+(ready?"":" disabled")+' aria-label="Play">'+PLAY+"</button>";
      h+='<div class="bar">'+(ready?'<div class="track" data-seek="'+c.n+'"><div class="fill"></div></div><div class="time"><span>0:00</span><span>0:00</span></div>':'<div class="shim'+(c.status==="error"?" still":"")+'" style="height:6px;aspect-ratio:auto"></div>')+"</div></div>";
      return h;
    }
    if(c.status==="ready"&&c.url){
      var mw=clamp(Number(c.mw)||100,10,100);
      var mh=c.mh!=null&&c.mh!==""?clamp(Number(c.mh),10,100):null;
      var st="width:"+mw+"%;"+(mh!=null?"height:"+mh+"%;":"height:auto;")+"max-width:100%;margin:0 auto;object-fit:contain;";
      if(c.kind==="video") return '<video src="'+esc(c.url)+'" controls playsinline autoplay muted loop style="'+st+'"></video>';
      return '<img src="'+esc(c.url)+'" alt="'+esc(c.text)+'" decoding="async" draggable="false" style="'+st+'">';
    }
    return '<div class="shim'+(c.kind==="video"?" wide":"")+(c.status==="error"?" still":"")+'"></div>';
  }
  function syncWidget(el, c){
    var frame=el.querySelector(".body iframe");
    if(!frame){ delete widgetHtml[c.n]; return; }
    var next=String(c.html||"");
    if(widgetHtml[c.n]===next) return;
    widgetHtml[c.n]=next;
    var ext=externalSrc(next);
    if(ext){
      frame.removeAttribute("srcdoc");
      frame.setAttribute("sandbox", BROWSE_SANDBOX);
      if(frame.getAttribute("src")!==ext) frame.src=ext;
      return;
    }
    frame.removeAttribute("src");
    frame.setAttribute("sandbox","allow-scripts");
    frame.srcdoc='<!DOCTYPE html><html><head><meta charset="utf-8">'+GUARD+'<style>html,body{margin:0;height:100%;background:#0f0f18;color:#e9e9f2;font:14px/1.45 system-ui,sans-serif}img,video,iframe{max-width:100%}iframe{width:100%;height:100%;min-height:240px;border:0;border-radius:8px;background:#fff}</style></head><body>'+next+"</body></html>";
  }
  function ensureCard(c){
    remember(c);
    var L=local[c.n];
    var el=board.querySelector('[data-n="'+c.n+'"]');
    if(!el){
      el=document.createElement("article");
      el.className="card";
      el.setAttribute("data-n", String(c.n));
      board.appendChild(el);
    }
    el.className="card"+(c.kind==="widget"?" widget":"")+(busy[c.n]==="drag"?" is-drag":"")+(busy[c.n]==="resize"?" is-resize":"");
    applyBox(el, L);
    var view=layoutOf(c);
    var cap=c.status==="error"?("Couldn't make this: "+(c.error||"unknown error")):c.status==="pending"?(pendingLabel(c)+": "+(c.text||"…")):(c.kind==="widget"||externalSrc(c.html||"")?"":(c.text||""));
    var body=mediaBody(c);
    var html='<div class="chrome" data-drag="'+c.n+'"><span class="badge">'+c.n+'</span><span class="kind">'+esc(c.kind)+"</span>";
    html+='<h3 class="title">'+esc(c.title||("Card "+c.n))+"</h3></div>";
    html+='<div class="body">'+body+"</div>";
    if(cap) html+='<p class="cap'+(c.status==="error"?" err":"")+'">'+esc(cap)+"</p>";
    if(c.status==="pending"&&c.model) html+='<p class="cap">'+esc(c.model)+"</p>";
    html+='<div class="grip" data-resize="'+c.n+'" title="Resize"></div>';
    var keepFrame=!!c.html&&el.querySelector(".body iframe")&&widgetHtml[c.n]===String(c.html||"");
    // Rebuilt only when what it shows changed: a move or a resize keeps a playing video, its sound and its place.
    if(!keepFrame){ if(el._html!==html){ el.innerHTML=html; el._html=html; } }
    else {
      var title=el.querySelector(".title"); if(title) title.textContent=c.title||("Card "+c.n);
      var kind=el.querySelector(".kind"); if(kind) kind.textContent=c.kind;
      if(!el.querySelector(".grip")) el.insertAdjacentHTML("beforeend",'<div class="grip" data-resize="'+c.n+'" title="Resize"></div>');
      if(!el.querySelector(".chrome")){
        var chrome=document.createElement("div");
        chrome.className="chrome"; chrome.setAttribute("data-drag", String(c.n));
        var badge=el.querySelector(".badge"), kindEl=el.querySelector(".kind"), titleEl=el.querySelector(".title");
        if(badge) chrome.appendChild(badge);
        if(kindEl) chrome.appendChild(kindEl);
        if(titleEl) chrome.appendChild(titleEl);
        el.insertBefore(chrome, el.firstChild);
      }
    }
    syncWidget(el, c);
    return el;
  }
  function startPointer(mode, n, e){
    if(e.button!=null&&e.button!==0) return;
    e.preventDefault();
    e.stopPropagation();
    var L=local[n]; if(!L) return;
    var el=board.querySelector('[data-n="'+n+'"]'); if(!el) return;
    zTop+=1; L.z=zTop; busy[n]=mode;
    el.classList.add(mode==="drag"?"is-drag":"is-resize");
    el.style.zIndex=String(L.z);
    var br=board.getBoundingClientRect();
    var startX=e.clientX, startY=e.clientY, ox=L.x, oy=L.y, ow=L.w, oh=L.h!=null?L.h:Math.max(16,(el.getBoundingClientRect().height/br.height)*100);
    function move(ev){
      var dx=((ev.clientX-startX)/br.width)*100, dy=((ev.clientY-startY)/br.height)*100;
      if(mode==="drag"){ L.x=clamp(ox+dx,0,90); L.y=clamp(oy+dy,0,90); }
      else { L.w=clamp(ow+dx,12,98); L.h=clamp(oh+dy,14,98); }
      applyBox(el, L);
    }
    function up(){
      busy[n]=null;
      el.classList.remove("is-drag","is-resize");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      persist(n);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  board.addEventListener("pointerdown", function(e){
    var t=e.target; if(!t||!t.closest) return;
    if(t.closest(".btn")||t.closest("[data-seek]")||t.closest(".body")) return;
    var grip=t.closest("[data-resize]");
    if(grip){ startPointer("resize", Number(grip.getAttribute("data-resize")), e); return; }
    var drag=t.closest("[data-drag]");
    if(drag){ startPointer("drag", Number(drag.getAttribute("data-drag")), e); return; }
  });
  // A link clicked inside a widget card: its guard sends it here; the board's runtime hands it to the host to open.
  window.addEventListener("message", function(e){
    var d=e.data; if(!d||d.__trinity!=="link"||typeof d.href!=="string") return;
    var frames=board.querySelectorAll("iframe"), own=false;
    for(var i=0;i<frames.length;i++) if(frames[i].contentWindow===e.source) own=true;
    if(!own) return;
    var h=d.href.trim(), l=h.toLowerCase();
    if(l.indexOf("https://")===0||l.indexOf("http://")===0) window.open(h);
  });
  // Commands from the engine (workspace/card-commands.ts): run on the card itself — its video or audio here, or inside
  // a widget's frame (the card runtime there answers) — and report what happened.
  function answer(id, n, r){
    r = r || {};
    emit({__trinity:"board", op:"cmd_result", id:id, n:n, ok:!!r.ok, via:r.via, label:r.label, already:r.already, reason:r.reason, detail:r.detail, controls:r.controls, text:r.text, media:r.media});
  }
  function onCommand(cmd){
    if(!cmd||typeof cmd!=="object") return;
    var id=String(cmd.id||""), n=Number(cmd.n), op=String(cmd.op||""), arg=cmd.arg;
    var el=board.querySelector('[data-n="'+n+'"]'), c=cardsBy[n];
    if(!el||!c) return answer(id,n,{ok:false,reason:"missing"});
    if(c.status==="pending") return answer(id,n,{ok:false,reason:"pending"});
    if(!RT) return answer(id,n,{ok:false,reason:"error",detail:"no card runtime"});
    if(c.kind==="audio"&&!c.html){
      var a=audioBy[n];
      if(!a) return answer(id,n,{ok:false,reason:"no-media"});
      if(op==="read") return answer(id,n,{ok:true,via:"read",text:"audio "+RT.mediaText(a),media:RT.mediaState(a)});
      if(op==="controls") return answer(id,n,{ok:true,controls:["play","pause","restart","mute","louder","quieter","skip ahead","skip back","loop"]});
      return RT.mediaOp(a,op,arg).then(function(r){ refreshAudio(n); answer(id,n,r); });
    }
    var frame=el.querySelector(".body iframe");
    if(frame){
      if(frame.hasAttribute("src")) return answer(id,n,{ok:false,reason:"external"});
      var win=frame.contentWindow;
      if(!win) return answer(id,n,{ok:false,reason:"no-answer"});
      waiting[id]={win:win,n:n,timer:setTimeout(function(){ delete waiting[id]; answer(id,n,{ok:false,reason:"no-answer"}); },1800)};
      try{ win.postMessage({__trinity:"cmd",id:id,op:op,arg:arg},"*"); }
      catch(e){ clearTimeout(waiting[id].timer); delete waiting[id]; answer(id,n,{ok:false,reason:"error",detail:String(e)}); }
      return;
    }
    var vid=el.querySelector(".body video");
    if(vid){
      if(op==="read") return answer(id,n,{ok:true,via:"read",text:"video "+RT.mediaText(vid),media:RT.mediaState(vid)});
      if(op==="controls") return answer(id,n,{ok:true,controls:["play","pause","restart","mute","unmute","louder","quieter","skip ahead","skip back","loop","faster","slower"]});
      return RT.mediaOp(vid,op,arg).then(function(r){ answer(id,n,r); });
    }
    var body=el.querySelector(".text-body")||el.querySelector(".body")||el;
    if(op==="read") return answer(id,n,{ok:true,via:"read",text:String(body.innerText||c.text||"").slice(0,4000)});
    if(op==="scroll_down"||op==="scroll_up"||op==="scroll_top") return answer(id,n,RT.scroll(el,op));
    if(op==="controls") return answer(id,n,{ok:true,controls:[]});
    return answer(id,n,{ok:false,reason:c.kind==="image"||c.kind==="text"?"no-media":"no-control"});
  }
  if(window.trinity) window.trinity.oncommand=onCommand;
  // A widget frame's answer: only from the frame the command went to, only for a command still waiting.
  window.addEventListener("message", function(e){
    var d=e.data; if(!d||d.__trinity!=="cmd_result") return;
    var w=waiting[d.id]; if(!w||w.win!==e.source) return;
    clearTimeout(w.timer); delete waiting[d.id];
    answer(d.id,w.n,d);
  });
  window.render=function(state){
    var cards=(state&&state.cards)||[];
    cardsBy=Object.create(null);
    for(var ci=0;ci<cards.length;ci++) cardsBy[cards[ci].n]=cards[ci];
    var keep=Object.create(null);
    for(var i=0;i<cards.length;i++) keep[cards[i].n]=true;
    for(var k in audioBy){ if(!keep[k]){ try{audioBy[k].pause();}catch(e){} delete audioBy[k]; } }
    for(k in widgetHtml){ if(!keep[k]) delete widgetHtml[k]; }
    for(k in local){ if(!keep[k]) delete local[k]; }
    var empty=board.querySelector(".empty");
    if(!cards.length){
      board.innerHTML='<div class="empty">Ask Trinity to add a picture, audio, video, note, or widget — drag the header to move, corner to resize</div>';
      return;
    }
    if(empty) empty.remove();
    for(i=0;i<board.children.length;i++){
      var child=board.children[i];
      var n=Number(child.getAttribute("data-n"));
      if(!keep[n]){ child.remove(); i--; }
    }
    for(i=0;i<cards.length;i++){
      var c=cards[i];
      var el=ensureCard(c);
      var img=el.querySelector("img"), vid=el.querySelector("video");
      if(img){ if(img.complete) img.classList.add("is-on"); else img.addEventListener("load",function(ev){ev.target.classList.add("is-on");}); }
      if(vid){ if(vid.readyState>=2) vid.classList.add("is-on"); else vid.addEventListener("loadeddata",function(ev){ev.target.classList.add("is-on");}); }
      if(c.kind==="audio"&&c.status==="ready"&&c.url){
        var a=audioBy[c.n];
        if(!a||a._src!==c.url){
          if(a) try{a.pause();}catch(e){}
          a=new Audio(c.url); a._src=c.url; audioBy[c.n]=a;
          a.addEventListener("timeupdate",function(nn){return function(){refreshAudio(nn);};}(c.n));
          a.addEventListener("play",function(nn){return function(){refreshAudio(nn);};}(c.n));
          a.addEventListener("pause",function(nn){return function(){refreshAudio(nn);};}(c.n));
          a.addEventListener("ended",function(nn){return function(){audioBy[nn].currentTime=0;refreshAudio(nn);};}(c.n));
          var p=a.play(); if(p&&p.catch) p.catch(function(){refreshAudio(c.n);});
        }
        refreshAudio(c.n);
      }
    }
    board.onclick=function(e){
      var t=e.target; if(!t||!t.closest) return;
      var play=t.closest("[data-play]");
      if(play){
        var pn=play.getAttribute("data-play"), aa=audioBy[pn];
        if(!aa) return;
        if(aa.paused){ var q=aa.play(); if(q&&q.catch) q.catch(function(){}); } else aa.pause();
        return;
      }
      var seek=t.closest("[data-seek]");
      if(seek){
        var a2=audioBy[seek.getAttribute("data-seek")];
        if(!a2||!isFinite(a2.duration)) return;
        var r=seek.getBoundingClientRect();
        a2.currentTime=a2.duration*Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
      }
    };
  };
})();
</script>`,
};

function emptyState(): BoardState {
  return { cards: [] };
}

const LEGACY_BOARD_IDS = new Set(["board@1", "board@2", "board@3", "board@4", "board@5", "board@6", BOARD_TEMPLATE.id]);

function isBoard(): boolean {
  const s = workspace.snapshot();
  return s.mode === "app" && s.owner === BOARD_OWNER && Boolean(s.template?.id && LEGACY_BOARD_IDS.has(s.template.id));
}

function read(): BoardState {
  if (!isBoard()) return emptyState();
  const raw = workspace.state as BoardState | null;
  if (!raw || !Array.isArray(raw.cards)) return emptyState();
  return { cards: raw.cards.filter((c) => c && typeof c.n === "number") };
}

function write(state: BoardState, title = "Workspace"): boolean {
  if (!isBoard()) {
    workspace.showApp(BOARD_TEMPLATE, state, title, BOARD_OWNER);
    return true;
  }
  // Hot-upgrade an older board template (drag/resize, widget frames, hardened widget documents) without clearing cards.
  if (workspace.snapshot().template?.id !== BOARD_TEMPLATE.id) {
    workspace.showApp(BOARD_TEMPLATE, state, title, BOARD_OWNER);
    return true;
  }
  return workspace.setState(state, BOARD_OWNER);
}

function nextNumber(cards: BoardCard[]): number {
  let max = 0;
  for (const c of cards) if (c.n > max) max = c.n;
  return max + 1;
}

function slotFor(index: number): { x: number; y: number } {
  const base = SLOT[index % SLOT.length]!;
  const ring = Math.floor(index / SLOT.length);
  return { x: Math.min(72, base.x + ring * 3), y: Math.min(70, base.y + ring * 3) };
}

/** Push the current board template over an older board template id without clearing cards. */
function upgradeBoardTemplate(): void {
  const s = workspace.snapshot();
  if (s.mode !== "app" || s.owner !== BOARD_OWNER) return;
  if (!s.template?.id || !LEGACY_BOARD_IDS.has(s.template.id)) return;
  if (s.template.id === BOARD_TEMPLATE.id) return;
  const raw = s.state as BoardState | null;
  const cards = raw && Array.isArray(raw.cards) ? raw.cards.filter((c) => c && typeof c.n === "number") : [];
  workspace.showApp(BOARD_TEMPLATE, { cards }, s.title || "Workspace", BOARD_OWNER);
}

export function boardActive(): boolean {
  upgradeBoardTemplate();
  return isBoard();
}

export function listCards(): BoardCard[] {
  upgradeBoardTemplate();
  return read().cards.slice().sort((a, b) => a.n - b.n);
}

export function getCard(n: number): BoardCard | null {
  return read().cards.find((c) => c.n === n) ?? null;
}

export function describeBoard(): string {
  const cards = listCards();
  if (!cards.length) return "The workspace board is empty.";
  const bits = cards.map((c) => {
    const status = c.status === "pending" ? "still loading" : c.status === "error" ? "failed" : "ready";
    const size =
      c.kind === "image" || c.kind === "video"
        ? `, media ${Math.round(c.mw ?? 100)}% wide` + (c.mh != null ? ` × ${Math.round(c.mh)}% tall` : "")
        : "";
    const htmlBits = c.html ? `, editable HTML (${summarizeHtml(c.html)})` : "";
    const tags = (c.tags ?? []).length ? `, about: ${(c.tags ?? []).slice(0, 6).join(", ")}` : "";
    const cx = c.x + c.w / 2;
    const cy = c.y + (c.h ?? 40) / 2;
    const v = cy < 34 ? "top" : cy > 66 ? "bottom" : "";
    const h = cx < 34 ? "left" : cx > 66 ? "right" : "";
    const where = isMinimized(c) ? "minimized" : isMaximized(c) ? "full screen" : v && h ? `${v} ${h}` : v || h || "center";
    return `card ${c.n} (${c.kind}, ${status}, ${where}${size}${htmlBits}${tags}): ${c.title}`;
  });
  return `The workspace board has ${cards.length} card${cards.length === 1 ? "" : "s"}: ${bits.join("; ")}.`;
}

const TAG_STOP = new Set(
  (
    "a an the of in on at to for from with without into onto over under about as by and or nor " +
    "picture image photo photograph illustration painting drawing artwork art poster logo icon " +
    "video clip animation movie gif audio recording note text card widget app page chart graph " +
    "make create generate draw paint show add please me us some someones something"
  ).split(/\s+/),
);

/** Content tags from a prompt/title so "the tiger" can resolve to the right card. */
export function tagsFromText(...parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const w of String(part || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (w.length < 3 || TAG_STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/** Short inventory of tags inside a fragment so the agent knows what's editable. */
export function summarizeHtml(html: string): string {
  const tags = new Set<string>();
  for (const m of html.matchAll(/<\/?([a-z][\w-]*)\b/gi)) {
    const t = m[1]!.toLowerCase();
    if (!["html", "head", "body", "meta", "link", "title", "style", "script"].includes(t)) tags.add(t);
  }
  const interesting = [...tags].filter((t) =>
    /^(img|svg|canvas|video|audio|iframe|button|input|select|textarea|form|table|h[1-6]|p|div|span|ul|ol|li|a|path|circle|rect|line|text|g)$/.test(
      t,
    ),
  );
  return interesting.length ? interesting.slice(0, 12).join(", ") : "markup";
}

/** Persist a user drag/resize from the board UI (percentages of the board). */
export function applyCardLayout(
  n: number,
  layout: { x: number; y: number; w: number; h?: number | null; z?: number },
): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  const card = { ...state.cards[i]! };
  card.x = Math.max(0, Math.min(X_MAX, Number(layout.x) || 0));
  card.y = Math.max(0, Math.min(X_MAX, Number(layout.y) || 0));
  card.w = Math.max(W_MIN, Math.min(W_MAX, Number(layout.w) || card.w));
  if (layout.h === null || layout.h === undefined) delete card.h;
  else card.h = Math.max(H_MIN, Math.min(H_MAX, Number(layout.h)));
  if (typeof layout.z === "number" && Number.isFinite(layout.z)) card.z = layout.z;
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

export interface AddCardInput {
  kind: CardKind;
  title: string;
  text: string;
  status?: CardStatus;
  url?: string | null;
  html?: string | null;
  tags?: string[];
  model?: string;
  error?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/**
 * If a legacy full-page HTML build is on screen, fold it into card 1 on a fresh board
 * so the next add keeps it. No-op when the board is already showing or the screen is empty.
 */
export function adoptLegacyHtml(): BoardCard | null {
  if (isBoard() || boardBlocked()) return null;
  const s = workspace.snapshot();
  if (s.mode !== "html" || !s.html) return null;
  const title = s.title || pageTitle(s.html) || "Page";
  const card: BoardCard = {
    n: 1,
    kind: "widget",
    status: "ready",
    x: SLOT[0]!.x,
    y: SLOT[0]!.y,
    w: CARD_W.widget,
    z: 1,
    title: title.slice(0, 80),
    text: title,
    url: null,
    html: s.html,
  };
  write({ cards: [card] }, "Workspace");
  return card;
}

/** Ensure the board is showing, add a numbered floating card, return it. */
export function addCard(input: AddCardInput): BoardCard {
  adoptLegacyHtml();
  const state = read();
  const n = nextNumber(state.cards);
  const pos = slotFor(state.cards.length);
  const tags = (input.tags?.length ? input.tags : tagsFromText(input.title, input.text)).slice(0, 12);
  const card: BoardCard = {
    n,
    kind: input.kind,
    status: input.status ?? "pending",
    x: input.x ?? pos.x,
    y: input.y ?? pos.y,
    w: input.w ?? CARD_W[input.kind],
    h: input.h,
    z: n,
    title: input.title.slice(0, 80),
    text: input.text.slice(0, 2000),
    tags,
    url: input.url ?? null,
    html: input.html ?? null,
    model: input.model,
    error: input.error,
  };
  state.cards.push(card);
  write(state, "Workspace");
  touchCards([n], true);
  return card;
}

/** Patch a card by number. Returns null if missing / board not active. */
export function updateCard(n: number, patch: Partial<Omit<BoardCard, "n" | "kind">>): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  const next = { ...state.cards[i]!, ...patch, n, kind: state.cards[i]!.kind };
  state.cards[i] = next;
  if (!write(state)) return null;
  return next;
}

export function removeCard(n: number): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  workspace.pushUndo(`remove_card:${n}`);
  const [removed] = state.cards.splice(i, 1);
  write(state);
  return removed ?? null;
}

export type MovePlace =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right"
  | "front"
  | "back";

export type RelativePlace = "under" | "above" | "left-of" | "right-of" | "beside";
/** Layering: one step up or down the stack, or right in front of / behind another card (overlapping it). */
export type LayerPlace = "forward" | "backward" | "in-front-of" | "behind" | "on-top-of";

/** The board's limits for a card's box, in % (the renderer clamps to the same). A card can fill the board. */
const X_MAX = 90;
const W_MIN = 12;
const W_MAX = 98;
const H_MIN = 14;
const H_MAX = 98;

const PLACES: Record<Exclude<MovePlace, "front" | "back">, { x: number; y: number }> = {
  "top-left": { x: 4, y: 4 },
  top: { x: 34, y: 4 },
  "top-right": { x: 64, y: 4 },
  left: { x: 4, y: 34 },
  center: { x: 34, y: 30 },
  right: { x: 64, y: 34 },
  "bottom-left": { x: 4, y: 62 },
  bottom: { x: 34, y: 62 },
  "bottom-right": { x: 64, y: 62 },
};

export function parsePlace(raw: unknown): MovePlace | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (!s) return null;
  if (s === "front" || s === "forward" || s === "on-top" || s === "topmost") return "front";
  if (s === "back" || s === "behind" || s === "bottommost") return "back";
  if (s in PLACES) return s as MovePlace;
  if (s === "middle") return "center";
  if (s === "upper-left" || s === "up-left") return "top-left";
  if (s === "upper-right" || s === "up-right") return "top-right";
  if (s === "lower-left" || s === "down-left") return "bottom-left";
  if (s === "lower-right" || s === "down-right") return "bottom-right";
  return null;
}

export function parseRelativePlace(raw: string): RelativePlace | null {
  const s = raw.toLowerCase().trim();
  if (/\b(under|below|beneath)\b/.test(s)) return "under";
  if (/\b(above|over)\b/.test(s)) return "above";
  if (/\bleft\s+of\b/.test(s)) return "left-of";
  if (/\bright\s+of\b/.test(s)) return "right-of";
  if (/\b(beside|next\s+to|by)\b/.test(s)) return "beside";
  return null;
}

/**
 * Resolve which card the user means: "card 3", "the tiger", "panda picture", etc.
 * Scores tags, title, and text — so "move the tiger under the panda" can find both.
 */
export function resolveCard(hint: string, utterance = ""): BoardCard | null {
  const cards = listCards();
  if (!cards.length) return null;
  const blob = `${hint} ${utterance}`.trim();
  const num = /\bcard\s*(?:number\s*)?(\d+)\b/i.exec(blob) || /\b(?:number|#)\s*(\d+)\b/i.exec(blob);
  if (num) return cards.find((c) => c.n === Number(num[1])) ?? null;

  const words = blob
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !TAG_STOP.has(w) && !/^(card|move|put|place|remove|delete|under|above|below|beside|left|right|next|front|back)$/.test(w));
  if (!words.length) return null;

  let best: BoardCard | null = null;
  let bestScore = 0;
  for (const c of cards) {
    const hay = `${(c.tags ?? []).join(" ")} ${c.title} ${c.text}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if ((c.tags ?? []).includes(w)) score += 4;
      else if (new RegExp(String.raw`\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`).test(hay)) score += 2;
      else if (hay.includes(w)) score += 1;
    }
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Pick the moving card and optional anchor from "move the tiger under the panda". */
export function resolveMoveTargets(utterance: string): { moving: BoardCard | null; anchor: BoardCard | null; relative: RelativePlace | null } {
  const relative = parseRelativePlace(utterance);
  const under = /\b(?:under|below|beneath|above|over|beside|next\s+to|left\s+of|right\s+of)\s+(?:the\s+)?(.+?)(?:\s*[.!?]|$)/i.exec(utterance);
  const move = /\b(?:move|put|place|shift|slide|bring|send)\s+(?:the\s+)?(.+?)(?:\s+(?:under|below|beneath|above|over|beside|next\s+to|to\s+the|left\s+of|right\s+of|front|back|top|bottom|left|right|center)|\s*[.!?]|$)/i.exec(
    utterance,
  );
  const movingHint = (move?.[1] ?? "").trim();
  const anchorHint = (under?.[1] ?? "").trim();
  const moving = resolveCard(movingHint || utterance, utterance);
  let anchor: BoardCard | null = null;
  if (relative && anchorHint) {
    anchor = resolveCard(anchorHint, anchorHint);
    if (anchor && moving && anchor.n === moving.n) anchor = null;
  }
  return { moving, anchor, relative };
}

export function moveCard(n: number, place: MovePlace): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  const card = { ...state.cards[i]! };
  if (place === "front") {
    const maxZ = state.cards.reduce((m, c) => Math.max(m, c.z), 0);
    card.z = maxZ + 1;
    // "Bring card 2 to the front" while it's a tile on the bottom row: it comes back to its size too.
    if (isMinimized(card)) {
      const was = card.prev;
      card.w = was?.w ?? CARD_W[card.kind];
      if (was?.h == null) delete card.h;
      else card.h = was.h;
      card.x = was?.x ?? card.x;
      card.y = was?.y ?? 30;
      delete card.prev;
    }
  } else if (place === "back") {
    const minZ = state.cards.reduce((m, c) => Math.min(m, c.z), card.z);
    card.z = minZ - 1;
  } else {
    const p = PLACES[place];
    card.x = p.x;
    card.y = p.y;
  }
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

/** Place card `n` relative to another card (under / above / beside / left-of / right-of). */
export function moveCardRelative(n: number, relative: RelativePlace, anchorN: number): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  const anchor = state.cards.find((c) => c.n === anchorN);
  if (i < 0 || !anchor) return null;
  const card = { ...state.cards[i]! };
  const ah = anchor.h ?? 28;
  const gap = 2;
  if (relative === "under") {
    card.x = anchor.x;
    card.y = Math.min(86, anchor.y + ah + gap);
  } else if (relative === "above") {
    card.x = anchor.x;
    card.y = Math.max(0, anchor.y - (card.h ?? 28) - gap);
  } else if (relative === "left-of") {
    card.x = Math.max(0, anchor.x - card.w - gap);
    card.y = anchor.y;
  } else {
    // beside / right-of
    card.x = Math.min(86, anchor.x + anchor.w + gap);
    card.y = anchor.y;
  }
  card.z = Math.max(card.z, anchor.z + 1);
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

// ─── Layering ───────────────────────────────────────────────────────────────

export function parseLayerPlace(raw: string): LayerPlace | null {
  const s = raw.toLowerCase();
  if (/\bon top of\b/.test(s)) return "on-top-of";
  if (/\bin front of\b/.test(s)) return "in-front-of";
  if (/\bbehind\b/.test(s)) return "behind";
  if (/\b(?:forwards?|up (?:a|one) layer|up one)\b/.test(s)) return "forward";
  if (/\b(?:backwards?|back (?:a|one) layer|down (?:a|one) layer|down one)\b/.test(s)) return "backward";
  return null;
}

const topZ = (cards: BoardCard[]) => cards.reduce((m, c) => Math.max(m, c.z), 0);

/**
 * Re-layer card `n`: one step forward or back, or just in front of / behind another card — moved to overlap it a
 * little, so the layering shows. The stack is renumbered 1…n in its new order.
 */
export function layerCard(n: number, place: LayerPlace, anchorN?: number): BoardCard | null {
  const state = read();
  if (!state.cards.some((c) => c.n === n)) return null;
  const cards = state.cards.map((c) => ({ ...c }));
  const card = cards.find((c) => c.n === n)!;
  const order = cards.slice().sort((a, b) => a.z - b.z);
  const at = order.indexOf(card);
  if (place === "forward" || place === "backward") {
    const j = place === "forward" ? at + 1 : at - 1;
    if (j >= 0 && j < order.length) [order[at], order[j]] = [order[j]!, order[at]!];
  } else {
    const anchor = cards.find((c) => c.n === anchorN);
    if (!anchor || anchor.n === n) return null;
    order.splice(at, 1);
    const ai = order.indexOf(anchor);
    order.splice(place === "behind" ? ai : ai + 1, 0, card);
    const d = place === "behind" ? -3 : 3;
    card.x = Math.max(0, Math.min(X_MAX, anchor.x + d));
    card.y = Math.max(0, Math.min(X_MAX, anchor.y + d));
  }
  order.forEach((c, k) => {
    c.z = k + 1;
  });
  state.cards = cards;
  if (!write(state)) return null;
  return card;
}

// ─── Sizing ─────────────────────────────────────────────────────────────────

export type ResizeHow = "maximize" | "minimize" | "restore" | "bigger" | "smaller" | "wider" | "narrower" | "taller" | "shorter";
export type ResizeAmount = "bit" | "normal" | "lot";

/** A minimized card: a small tile on the bottom row. */
const MINI = { w: 16, h: 16, y: 82 };
export const isMinimized = (c: BoardCard): boolean => c.w <= MINI.w && (c.h ?? 99) <= MINI.h;
export const isMaximized = (c: BoardCard): boolean => c.w >= 90 && (c.h ?? 0) >= 90;

/**
 * Change a card's size: fill the board, shrink to a tile on the bottom row, go back to how it was (or its usual
 * size), or scale by a step — a bit, the usual step, or a lot ("twice", "half"). Stays on the board.
 */
export function resizeCard(n: number, how: ResizeHow, amount: ResizeAmount = "normal"): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  const card = { ...state.cards[i]! };
  const keep = () => {
    if (!card.prev && !isMaximized(card) && !isMinimized(card)) card.prev = { x: card.x, y: card.y, w: card.w, h: card.h, z: card.z };
  };
  const fit = () => {
    card.w = Math.max(W_MIN, Math.min(W_MAX, Math.round(card.w * 10) / 10));
    if (card.h != null) card.h = Math.max(H_MIN, Math.min(H_MAX, Math.round(card.h * 10) / 10));
    card.x = Math.max(0, Math.min(X_MAX, Math.min(card.x, 100 - card.w)));
    card.y = Math.max(0, Math.min(X_MAX, card.h != null ? Math.min(card.y, 100 - card.h) : card.y));
  };
  const grow = amount === "bit" ? 1.15 : amount === "lot" ? 1.7 : 1.35;
  const shrink = amount === "bit" ? 0.87 : amount === "lot" ? 0.55 : 0.75;
  switch (how) {
    case "maximize":
      keep();
      card.x = 1;
      card.y = 1;
      card.w = W_MAX;
      card.h = 97;
      card.z = topZ(state.cards) + 1;
      break;
    case "minimize": {
      keep();
      // Tiles fill the bottom row five across, then the row above it.
      const slot = state.cards.filter((c) => c.n !== n && isMinimized(c)).length % 15;
      card.w = MINI.w;
      card.h = MINI.h;
      card.x = 2 + (slot % 5) * 18;
      card.y = MINI.y - Math.floor(slot / 5) * 18;
      card.z = topZ(state.cards) + 1;
      break;
    }
    case "restore":
      if (card.prev) {
        card.x = card.prev.x;
        card.y = card.prev.y;
        card.w = card.prev.w;
        if (card.prev.h == null) delete card.h;
        else card.h = card.prev.h;
        card.z = topZ(state.cards) + 1;
        delete card.prev;
      } else {
        card.w = CARD_W[card.kind];
        delete card.h;
      }
      fit();
      break;
    case "bigger":
    case "smaller": {
      const f = how === "bigger" ? grow : shrink;
      card.w *= f;
      if (card.h != null) card.h *= f;
      fit();
      break;
    }
    case "wider":
      card.w *= 1.3;
      fit();
      break;
    case "narrower":
      card.w *= 0.77;
      fit();
      break;
    case "taller":
      card.h = (card.h ?? 50) * 1.3;
      fit();
      break;
    case "shorter":
      card.h = (card.h ?? 50) * 0.77;
      fit();
      break;
  }
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

// ─── What was just touched ──────────────────────────────────────────────────

let touched: { ns: number[]; at: number; adding: boolean } = { ns: [], at: 0, adding: false };

/** Remember the cards just made or acted on, so "it", "them" and "both" mean them (cards made together stay together). */
export function touchCards(ns: number[], adding = false): void {
  const now = Date.now();
  if (adding && touched.adding && now - touched.at < 6_000) touched = { ns: [...touched.ns, ...ns].slice(-12), at: now, adding };
  else touched = { ns: [...ns].slice(-12), at: now, adding };
}

/** The cards last made or acted on that are still on the board (within the last quarter hour), oldest first. */
export function lastTouched(): number[] {
  if (Date.now() - touched.at > 15 * 60_000) return [];
  const have = new Set(read().cards.map((c) => c.n));
  return touched.ns.filter((n) => have.has(n));
}

// ─── Several cards at once ───────────────────────────────────────────────────

/** Remove several cards in one step — one undo brings them all back. */
export function removeCards(ns: number[]): BoardCard[] {
  const state = read();
  const gone = state.cards.filter((c) => ns.includes(c.n));
  if (!gone.length) return [];
  workspace.pushUndo(`remove_cards:${gone.map((c) => c.n).join(",")}`);
  state.cards = state.cards.filter((c) => !ns.includes(c.n));
  write(state);
  return gone;
}

/** Resize several cards in one step (one undo). */
export function resizeCards(ns: number[], how: ResizeHow, amount: ResizeAmount = "normal"): BoardCard[] {
  workspace.pushUndo(`resize_cards:${how}`);
  const out: BoardCard[] = [];
  for (const n of ns) {
    const c = resizeCard(n, how, amount);
    if (c) out.push(c);
  }
  return out;
}

const withBox = (c: BoardCard, b: { x: number; y: number; w: number; h?: number; z: number }): BoardCard => {
  const next: BoardCard = { ...c, x: b.x, y: b.y, w: b.w, z: b.z };
  if (b.h == null) delete next.h;
  else next.h = b.h;
  return next;
};

/** Two cards trade places and sizes. */
export function swapCards(a: number, b: number): [BoardCard, BoardCard] | null {
  const state = read();
  const A = state.cards.find((c) => c.n === a);
  const B = state.cards.find((c) => c.n === b);
  if (!A || !B || a === b) return null;
  workspace.pushUndo(`swap_cards:${a},${b}`);
  const boxA = { x: A.x, y: A.y, w: A.w, h: A.h, z: A.z };
  const boxB = { x: B.x, y: B.y, w: B.w, h: B.h, z: B.z };
  const nextA = withBox(A, boxB);
  const nextB = withBox(B, boxA);
  state.cards = state.cards.map((c) => (c.n === a ? nextA : c.n === b ? nextB : c));
  if (!write(state)) return null;
  return [nextA, nextB];
}

/** Move a card a step without sending it to a corner ("a bit to the left", "up a little"). */
export function nudgeCard(n: number, dx: number, dy: number): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  workspace.pushUndo(`nudge_card:${n}`);
  const card = { ...state.cards[i]! };
  card.x = Math.round(Math.max(0, Math.min(Math.min(X_MAX, 100 - card.w), card.x + dx)) * 10) / 10;
  card.y = Math.round(Math.max(0, Math.min(X_MAX, card.y + dy)) * 10) / 10;
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

/** Line some cards up along one edge of the board ("put the pictures on the left"), in number order; the rest stay. */
export function lineUpCards(ns: number[], side: "left" | "right" | "top" | "bottom"): BoardCard[] {
  const state = read();
  const picked = state.cards.filter((c) => ns.includes(c.n)).sort((a, b) => a.n - b.n);
  if (!picked.length) return [];
  workspace.pushUndo(`line_up:${side}`);
  const k = picked.length;
  const gap = 2;
  const vertical = side === "left" || side === "right";
  const len = Math.round(Math.min(vertical ? 46 : 44, (96 - (k - 1) * gap) / k) * 10) / 10;
  let z = topZ(state.cards);
  const moved = picked.map((c, i) => {
    z += 1;
    const box = vertical
      ? { x: side === "left" ? 2 : 72, y: Math.round((2 + i * (len + gap)) * 10) / 10, w: 26, h: len, z }
      : { x: Math.round((2 + i * (len + gap)) * 10) / 10, y: side === "top" ? 2 : 68, w: len, h: 30, z };
    return withBox(c, box);
  });
  state.cards = state.cards.map((c) => moved.find((m) => m.n === c.n) ?? c);
  write(state);
  return moved;
}

/** A copy of a ready card (same picture, note, clip or widget), a little down and to the right; next number. */
export function duplicateCard(n: number): BoardCard | null {
  const src = read().cards.find((c) => c.n === n);
  if (!src || src.status !== "ready") return null;
  workspace.pushUndo(`duplicate_card:${n}`);
  const copy = addCard({
    kind: src.kind,
    title: `${src.title} (copy)`.slice(0, 80),
    text: src.text,
    tags: src.tags,
    status: "ready",
    url: src.url,
    html: src.html ?? null,
    model: src.model,
    x: Math.min(X_MAX, src.x + 4),
    y: Math.min(X_MAX, src.y + 4),
    w: src.w,
    h: src.h,
  });
  if (src.mw != null || src.mh != null) return updateCard(copy.n, { mw: src.mw, mh: src.mh }) ?? copy;
  return copy;
}

/** A new title (and its words as tags, so the card can be named by it). */
export function renameCard(n: number, title: string): BoardCard | null {
  const card = read().cards.find((c) => c.n === n);
  if (!card) return null;
  workspace.pushUndo(`rename_card:${n}`);
  const tags = [...new Set([...tagsFromText(title), ...(card.tags ?? [])])].slice(0, 12);
  return updateCard(n, { title: title.slice(0, 80), tags });
}

/** A note's new words (its title follows when it was the automatic "Note: …" one). */
export function setNoteText(n: number, text: string): BoardCard | null {
  const card = read().cards.find((c) => c.n === n);
  if (!card || card.kind !== "text") return null;
  workspace.pushUndo(`edit_note:${n}`);
  const words = text.replace(/\s+/g, " ").trim();
  const caption = words.length > 60 ? `${words.slice(0, 59).replace(/\s+\S*$/, "")}…` : words || "empty";
  const tags = tagsFromText(text);
  return updateCard(n, { text: text.slice(0, 2000), tags: tags.length ? tags : card.tags, ...(/^Note:\s/.test(card.title) ? { title: `Note: ${caption}` } : {}) });
}

// ─── Arranging ──────────────────────────────────────────────────────────────

export type ArrangeLayout = "grid" | "stack" | "row" | "column" | "shuffle" | "scatter" | "by_kind" | "newest_first";

const KIND_RANK: Record<CardKind, number> = { image: 0, video: 1, widget: 2, text: 3, audio: 4 };

function shuffled<T>(xs: T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  // A shuffle that changed nothing isn't one.
  if (out.length > 1 && out.every((x, i) => x === xs[i])) [out[0], out[1]] = [out[1]!, out[0]!];
  return out;
}

export interface CardGrid {
  cols: number;
  rows: number;
  /** Cell size in % of the board. */
  w: number;
  h: number;
  /** Top-left of the grid in % of the board (the grid is centered). */
  x0: number;
  y0: number;
  gap: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The grid "organize the cards" lays out: as square as the count allows (1–2 across, then 2, 3, 4, 5, 6 columns),
 * uniform cells no wider than 44% or taller than 60% of the board, a 2% gap, centered. Beyond about thirty cards
 * the rows run off the bottom and the renderer clamps them.
 */
export function gridFor(count: number): CardGrid {
  const n = Math.max(1, count);
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 25 ? 5 : 6;
  const rows = Math.ceil(n / cols);
  const margin = 2;
  const gap = 2;
  const w = Math.max(14, Math.min(44, (100 - 2 * margin - (cols - 1) * gap) / cols));
  const h = Math.max(16, Math.min(60, (100 - 2 * margin - (rows - 1) * gap) / rows));
  const x0 = Math.max(0, (100 - (cols * w + (cols - 1) * gap)) / 2);
  const y0 = Math.max(0, (100 - (rows * h + (rows - 1) * gap)) / 2);
  return { cols, rows, w: round1(w), h: round1(h), x0: round1(x0), y0: round1(y0), gap };
}

/**
 * Lay every card out in numerical order, row by row, on the grid above — each card the same size, stacked in
 * number order. The layout before it goes on the undo stack. Null when the board has no cards.
 */
export function arrangeCards(layout: ArrangeLayout = "grid"): { count: number; cols: number; rows: number; layout: ArrangeLayout } | null {
  const state = read();
  if (!state.cards.length) return null;
  workspace.pushUndo("arrange_cards");
  let cards = state.cards.slice().sort((a, b) => a.n - b.n);
  const n = cards.length;
  if (layout === "scatter") {
    // Strewn like a desk: random places and sizes, a random stacking order.
    const order = shuffled(cards.map((c) => c.n));
    state.cards = cards.map((c) => {
      const w = round1(24 + Math.random() * 14);
      const h = round1(30 + Math.random() * 18);
      return { ...c, w, h, x: round1(2 + Math.random() * (96 - w)), y: round1(2 + Math.random() * (96 - h)), z: order.indexOf(c.n) + 1 };
    });
    return write(state) ? { count: n, cols: 0, rows: 0, layout } : null;
  }
  if (layout === "shuffle") cards = shuffled(cards);
  else if (layout === "by_kind") cards.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.n - b.n);
  else if (layout === "newest_first") cards.reverse();
  // A row or a column only while the cards stay a readable size; more than that is a grid.
  const used: ArrangeLayout = (layout === "row" && n > 6) || (layout === "column" && n > 5) ? "grid" : layout;
  if (used === "stack") {
    // A cascade: each card a little down and right of the one before, number order front to back.
    state.cards = cards.map((c, i) => ({ ...c, x: Math.min(X_MAX, 4 + i * 3), y: Math.min(X_MAX, 4 + i * 3), w: 48, h: 64, z: i + 1 }));
    return write(state) ? { count: n, cols: 1, rows: 1, layout: used } : null;
  }
  let g: CardGrid;
  if (used === "row") {
    const w = round1(Math.min(44, (96 - (n - 1) * 2) / n));
    g = { cols: n, rows: 1, w, h: 60, x0: round1((100 - (n * w + (n - 1) * 2)) / 2), y0: 20, gap: 2 };
  } else if (used === "column") {
    const h = round1(Math.min(60, (96 - (n - 1) * 2) / n));
    g = { cols: 1, rows: n, w: 44, h, x0: 28, y0: round1((100 - (n * h + (n - 1) * 2)) / 2), gap: 2 };
  } else g = gridFor(n); // the grid, and the shuffled / grouped / newest-first orders laid out on it
  state.cards = cards.map((c, i) => ({
    ...c,
    x: round1(g.x0 + (i % g.cols) * (g.w + g.gap)),
    y: round1(Math.min(X_MAX, g.y0 + Math.floor(i / g.cols) * (g.h + g.gap))),
    w: g.w,
    h: g.h,
    z: i + 1,
  }));
  if (!write(state)) return null;
  return { count: n, cols: g.cols, rows: g.rows, layout: used };
}

/** True when a game owns the screen — media / widget cards must not steal it. */
export function boardBlocked(): boolean {
  return Boolean(workspace.snapshot().owner?.startsWith("game:"));
}

/** Pick a widget card to edit: "card 2", a title match, else the latest widget. */
export function findWidgetToEdit(request: string): BoardCard | null {
  // Don't steal size/layout tweaks aimed at a picture / video / note.
  if (
    /\b(picture|image|photo|photograph|painting|illustration|artwork|video|clip|audio|note|sticky)\b/i.test(request) &&
    !/\b(widget|timer|chart|graph|dashboard|app|page|form|game)\b/i.test(request)
  ) {
    return null;
  }
  const widgets = listCards().filter((c) => c.kind === "widget" && (c.html || c.status === "pending"));
  if (!widgets.length) return null;
  const num = /\bcard\s*(?:number\s*)?(\d+)\b/i.exec(request);
  if (num) {
    const n = Number(num[1]);
    return widgets.find((c) => c.n === n) ?? null;
  }
  const words = request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  let best: BoardCard | null = null;
  let bestScore = 0;
  for (const c of widgets) {
    const title = c.title.toLowerCase();
    const score = words.reduce((a, w) => a + (title.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : widgets[widgets.length - 1]!;
}

/**
 * Pick any card to tweak (HTML / size / svg / canvas): by number, kind word ("picture", "timer"),
 * title match, else the latest ready card.
 */
export function findCardToEdit(request: string): BoardCard | null {
  const cards = listCards().filter((c) => c.status === "ready" || c.html || c.status === "pending");
  if (!cards.length) return null;
  const byMeta = resolveCard(request, request);
  if (byMeta && cards.some((c) => c.n === byMeta.n)) return byMeta;
  const num = /\bcard\s*(?:number\s*)?(\d+)\b/i.exec(request);
  if (num) {
    const n = Number(num[1]);
    return cards.find((c) => c.n === n) ?? null;
  }
  const kindOf = (re: RegExp, kind: CardKind) =>
    re.test(request) ? cards.filter((c) => c.kind === kind) : [];
  for (const pool of [
    kindOf(/\b(picture|image|photo|photograph|painting|illustration|artwork|poster)\b/i, "image"),
    kindOf(/\b(video|clip|animation|movie|gif)\b/i, "video"),
    kindOf(/\b(audio|recording|voice\s*note|narration)\b/i, "audio"),
    kindOf(/\b(note|sticky|memo|text\s*card)\b/i, "text"),
    kindOf(/\b(widget|timer|chart|graph|dashboard|app|form|game|svg|canvas)\b/i, "widget"),
  ]) {
    if (pool.length) return pool[pool.length - 1]!;
  }
  const words = request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  let best: BoardCard | null = null;
  let bestScore = 0;
  for (const c of cards) {
    const title = c.title.toLowerCase();
    const score = words.reduce((a, w) => a + (title.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  if (bestScore > 0 && best) return best;
  return cards[cards.length - 1]!;
}

/** HTML the HTML skill can edit for this card (materializes a simple img/video wrapper when needed). */
export function cardEditableHtml(card: BoardCard): string | null {
  if (card.html) return card.html;
  if ((card.kind === "image" || card.kind === "video") && card.url) {
    const mw = Math.max(10, Math.min(100, Math.round(card.mw ?? 100)));
    const mh = card.mh != null ? Math.max(10, Math.min(100, Math.round(card.mh))) : null;
    const size = `width:${mw}%;${mh != null ? `height:${mh}%;` : "height:auto;"}max-width:100%;display:block;margin:0 auto;object-fit:contain;`;
    const alt = (card.text || card.title || "").replace(/"/g, "&quot;");
    if (card.kind === "video") {
      return `<!-- title: ${card.title} -->\n<video src="${card.url}" controls playsinline style="${size}"></video>`;
    }
    return `<!-- title: ${card.title} -->\n<img src="${card.url}" alt="${alt}" style="${size}">`;
  }
  if (card.kind === "text" && card.text) {
    return `<!-- title: ${card.title} -->\n<p style="margin:0;padding:8px;color:#e8e8ef;font:14px/1.55 system-ui,sans-serif;white-space:pre-wrap">${escapeText(card.text)}</p>`;
  }
  return null;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Clamp and apply a media display size (% of card body). Also nudges card width for big steps. */
export function setMediaSize(
  n: number,
  opts: { mw?: number; mh?: number | null; cardW?: number },
): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  const card = { ...state.cards[i]! };
  if (opts.mw != null) card.mw = Math.max(10, Math.min(100, Math.round(opts.mw)));
  if (opts.mh === null) delete card.mh;
  else if (opts.mh != null) card.mh = Math.max(10, Math.min(100, Math.round(opts.mh)));
  if (opts.cardW != null) card.w = Math.max(14, Math.min(70, Math.round(opts.cardW)));
  if (card.html && (opts.mw != null || opts.mh !== undefined)) {
    const mw = card.mw ?? 100;
    const mh = card.mh ?? null;
    card.html = rewriteMediaPercent(card.html, mw, mh);
  }
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

/** Rewrite width/height % on the first img, video, svg, or canvas in a fragment. */
export function rewriteMediaPercent(html: string, mw: number, mh: number | null): string {
  let done = false;
  return html.replace(/<(img|video|svg|canvas)(\s[^>]*)?(\/?)>/gi, (full, tag: string, attrs = "", slash = "") => {
    if (done) return full;
    done = true;
    let next = attrs || "";
    const size = `width:${mw}%;${mh != null ? `height:${mh}%;` : "height:auto;"}max-width:100%;`;
    if (/\bstyle\s*=/i.test(next)) {
      next = next.replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_m: string, q: string, style: string) => {
        let s = String(style)
          .replace(/\bwidth\s*:\s*[^;]+;?/gi, "")
          .replace(/\bheight\s*:\s*[^;]+;?/gi, "")
          .trim();
        if (s && !s.endsWith(";")) s += ";";
        return `style=${q}${s}${size}${q}`;
      });
    } else {
      next += ` style="${size}"`;
    }
    next = next.replace(/\bwidth\s*=\s*(["']?)\d+%?\1/gi, "").replace(/\bheight\s*=\s*(["']?)\d+%?\1/gi, "");
    return `<${tag}${next}${slash ? " /" : ""}>`;
  });
}
