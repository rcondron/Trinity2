import { customAlphabet } from "nanoid";
import { pageTitle } from "../services/mordiem.js";
import { workspace, type UndoMerge, type WorkspaceTemplate, type WorkspaceUndoEntry } from "./bus.js";
import { cardHeld } from "./card-jobs.js";
import { isDataKindName, kindSummary, normalizeKindData } from "./kinds/index.js";
import { KIND_CSS, KIND_RENDERERS } from "./kinds/render.js";
import { WIDGET_CSP, WIDGET_RUNTIME } from "./widget-runtime.js";

/**
 * The floating card board: one workspace app that holds many numbered cards
 * (image / audio / video / text / widget, and the kinds the engine draws itself from data: table / chart /
 * document / code / file). Cards are absolutely positioned so the
 * user can ask to move or remove "card 2". Media and build_ui add cards — they
 * never replace the whole screen (unless a game owns it).
 */

/**
 * "form" is the placeholder for a secure form (vault/forms.ts): a lock, the form's title and "Waiting for you in the
 * secure form". The form itself is drawn by the trusted window page, never on the board; the card holds nothing typed,
 * can't be read, edited or controlled, and goes — with no undo entry — when its form ends.
 *
 * "table", "chart", "document", "code" and "file" are drawn by the board template itself from the card's `data`
 * (workspace/kinds/*.ts): no model writes their markup, so they appear at once and can't hang or invent anything.
 */
export type CardKind = "image" | "audio" | "video" | "text" | "widget" | "form" | "table" | "chart" | "document" | "code" | "file";
export type CardStatus = "pending" | "ready" | "error";

/** The kinds the board draws from `data`. */
export const DATA_KINDS: readonly CardKind[] = ["table", "chart", "document", "code", "file"];
export const isDataKind = (kind: CardKind): boolean => DATA_KINDS.includes(kind);

/** What it takes to make a card again after it failed or was interrupted: the tool, and the words it was asked with. */
export interface CardRetry {
  tool: string;
  /** The user's own words (the whole request). */
  request: string;
  /** The tool's arguments, when it had any worth keeping (short strings and numbers only). */
  args?: Record<string, string | number | boolean>;
}

export interface BoardCard {
  /**
   * The card itself: a short random id given once and never changed or reused. Everything that works on a card over
   * time (a job painting into it, a queue, an undo) holds this, never the number.
   */
  id: string;
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
  /** For the kinds the board draws itself (table, chart, document, code, file): the data, already normalized. */
  data?: unknown;
  /** Bumped whenever `data` changes, so a window redraws that card's body only then. */
  dv?: number;
  /**
   * What a widget asked to keep (trinity.saveState): a small JSON object, replayed in every window and after a
   * restart — a check-off list's ticks, a counter, a choice. Never a secret (see cleanCardState).
   */
  state?: unknown;
  /** How to make this card again ("try again"), kept while that is still possible. */
  retry?: CardRetry;
  /** The page a card showed before an edit began streaming into it: what an interrupted or failed edit puts back. */
  stash?: string;
}

export interface BoardState {
  cards: BoardCard[];
  /** The highest card number handed out on this board so far (numbers are not given twice). */
  seq?: number;
}

export const BOARD_OWNER = "board";

const CARD_W: Record<CardKind, number> = { image: 34, audio: 32, video: 40, text: 28, widget: 38, form: 30, table: 46, chart: 42, document: 40, code: 44, file: 30 };
/** The height the data kinds start with (they scroll inside it); the others size to their content. */
const CARD_H: Partial<Record<CardKind, number>> = { table: 52, chart: 50, document: 60, code: 52 };
/** A guess at a content-sized card's height in % of the board, until a window has measured it. */
const GUESS_H: Record<CardKind, number> = { image: 44, audio: 22, video: 40, text: 22, widget: 48, form: 30, table: 52, chart: 50, document: 60, code: 52, file: 26 };

// ─── Limits ─────────────────────────────────────────────────────────────────

/** The most cards a board holds (a secure form's placeholder doesn't count), the most HTML one card holds, and the most a whole board does. */
export const BOARD_LIMITS = { cards: 40, cardHtml: 600_000, cardData: 1_500_000, cardState: 16_384, total: 8_000_000 };

/** A refusal to grow the board past its limits. The message is a plain sentence that can be said aloud. */
export class BoardLimitError extends Error {
  constructor(
    readonly limit: "cards" | "html" | "data" | "total",
    message: string,
  ) {
    super(message);
    this.name = "BoardLimitError";
  }
}

const kb = (chars: number) => `${Math.max(1, Math.round(chars / 1024))} KB`;

/** The sentence to say when the board refused something for its limits; null for any other error (which is thrown on). */
export function boardRefusal(err: unknown): string | null {
  return err instanceof BoardLimitError ? err.message : null;
}

/** addCard, with a full board answered in words instead of thrown: the card, or the sentence to say. */
export function tryAddCard(input: AddCardInput): BoardCard | string {
  try {
    return addCard(input);
  } catch (err) {
    const no = boardRefusal(err);
    if (no === null) throw err;
    return no;
  }
}
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
  // A field that may hold a secret is never read and never set from here: a password input, or any field whose
  // autocomplete, name, id, label or placeholder says password, one-time code, card, security code and the like
  // (or that is drawn masked). Secrets are typed into Trinity's secure form, never into a card.
  var SECRET_FIELD = /pass(?:word|code|phrase)|otp|one[- ]?time|cvv|cvc|card|ssn|secret|token|\bcsc\b|\bpin\b|security code|\bcc-/i;
  function secretField(el, ty) {
    if (ty === "password") return true;
    var hint = [el.getAttribute("autocomplete"), el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title")].join(" ");
    try { if (el.labels) for (var i = 0; i < el.labels.length; i++) hint += " " + (el.labels[i].innerText || el.labels[i].textContent || ""); } catch (e) {}
    if (SECRET_FIELD.test(hint)) return true;
    try { var mask = window.getComputedStyle(el).webkitTextSecurity; if (mask && mask !== "none") return true; } catch (e) {}
    return false;
  }
  function fields(root) {
    var q = root.querySelectorAll('input,textarea,select,[contenteditable="true"],[contenteditable=""]'), out = [];
    for (var i = 0; i < q.length; i++) {
      var el = q[i], ty = (el.getAttribute("type") || "").toLowerCase();
      if (/^(?:button|submit|reset|checkbox|radio|hidden|file|image|color)$/.test(ty) || secretField(el, ty) || !shown(el)) continue;
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
    var t = String(root.innerText || root.textContent || "");
    // What was typed into an editable region that is labelled as a secret is part of the page's text: it is taken out.
    var ed = root.querySelectorAll('[contenteditable="true"],[contenteditable=""]');
    for (var e = 0; e < ed.length; e++) {
      if (!secretField(ed[e], "")) continue;
      var typed = String(ed[e].innerText || ed[e].textContent || "").trim();
      if (typed) t = t.split(typed).join(" ");
    }
    t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

/**
 * The board's template. Its id is "board@N": bump N whenever the template changes. Any id of that shape is taken for
 * the board (BOARD_ID below), so a board saved under an earlier N is upgraded in place, cards kept.
 *
 * Inside it every card is keyed by its id. A widget card's page runs in a nested sandboxed frame whose document starts
 * with WIDGET_RUNTIME (workspace/widget-runtime.ts) and the card runtime above; the board passes on what a widget
 * says — a link, a script error, a saved state, an event — only when it comes from one of its own card frames, and
 * always marked with the card it came from.
 */
export const BOARD_TEMPLATE: WorkspaceTemplate = {
  id: "board@9",
  kind: "default",
  name: "Card board",
  source:
    String.raw`<style>
:where(body){margin:0;min-height:100%;background:
  radial-gradient(1200px 700px at 12% -10%,rgba(103,232,249,.08),transparent 55%),
  radial-gradient(900px 600px at 110% 10%,rgba(167,139,250,.08),transparent 50%),
  #0c0c14;color:#e8e8ef;font:13px/1.45 system-ui,sans-serif;overflow:hidden}
#board{position:relative;width:100%;height:100vh;min-height:100%}
#board.is-busy iframe{pointer-events:none}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:24px;text-align:center;color:#7a7a9a;font-size:14px;line-height:1.6;pointer-events:none}
.empty[hidden]{display:none}
.empty span{display:block;max-width:560px}
.card{position:absolute;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:16px;
  background:rgba(20,20,34,.92);border:1px solid rgba(255,255,255,.1);box-shadow:0 18px 50px rgba(0,0,0,.45);
  backdrop-filter:blur(10px);animation:rise .4s cubic-bezier(.2,.8,.2,1) both;overflow:hidden;touch-action:none;
  transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1),width .5s cubic-bezier(.2,.8,.2,1),height .5s cubic-bezier(.2,.8,.2,1)}
.card.widget:not(.has-h){min-height:220px}
.card.has-h{min-height:0}
.card.form{border-color:rgba(103,232,249,.38)}
.formcard{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1;min-height:120px;padding:18px 12px;text-align:center;color:#c9c9dc}
.formcard svg{width:34px;height:34px;color:#67e8f9;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.formcard p{margin:0;font-size:13px;line-height:1.45}
.card.has-h .body{min-height:0}
.card.has-h .body iframe{height:100%;min-height:0;max-height:none;flex:1}
.card.is-drag,.card.is-resize{z-index:10000!important;animation:none;transition:none;user-select:none}
.card.is-drag{cursor:grabbing}
.chrome{flex:none;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
.chrome:active{cursor:grabbing}
.badge{position:absolute;top:10px;left:10px;z-index:2;min-width:26px;height:26px;padding:0 8px;border-radius:999px;
  display:grid;place-items:center;font-size:12px;font-weight:700;color:#0c0c14;background:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.25);pointer-events:none}
.kind{position:absolute;top:12px;right:28px;z-index:2;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#a5a5c6;pointer-events:none}
.title{margin:28px 0 0;font-size:12.5px;font-weight:600;color:#c9c9dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{position:relative;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.03);min-height:120px;flex:1;display:flex;flex-direction:column}
.body img,.body video{display:block;width:100%;max-width:100%;max-height:42vh;object-fit:contain;background:#000;opacity:0;transition:opacity .45s}
.body img.is-on,.body video.is-on{opacity:1}
.body iframe{display:block;width:100%;height:min(42vh,360px);border:0;border-radius:12px;background:#0f0f18;flex:1}
.grip{position:absolute;right:4px;bottom:4px;z-index:4;width:18px;height:18px;cursor:nwse-resize;border-radius:4px;touch-action:none;
  background:linear-gradient(135deg,transparent 50%,rgba(167,139,250,.55) 50%);opacity:.7}
.grip:hover{opacity:1}
.shim{width:100%;aspect-ratio:1;border-radius:12px;background:linear-gradient(110deg,rgba(255,255,255,.03) 30%,rgba(255,255,255,.09) 50%,rgba(255,255,255,.03) 70%);background-size:220% 100%;animation:shim 1.6s linear infinite}
.shim.wide{aspect-ratio:16/9}
.shim.tall{aspect-ratio:4/3}
.shim.still{animation:none;background:rgba(255,255,255,.03);border:1px dashed rgba(252,165,165,.35);box-sizing:border-box}
.card.has-h .body>.shim{aspect-ratio:auto;flex:1;min-height:0}
.caps{flex:none;display:flex;flex-direction:column;gap:6px}
.caps:empty{display:none}
.cap{margin:0;color:#a5a5c6;font-size:12px;line-height:1.45;max-height:4.5em;overflow:hidden}
.cap.err{color:#fca5a5}
.cap.warn{color:#fcd34d}
.text-body{margin:0;padding:8px 2px;color:#e8e8ef;font-size:14px;line-height:1.55;white-space:pre-wrap;overflow:auto;max-height:36vh}
.card.has-h .text-body{max-height:none;flex:1;min-height:0}
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
${KIND_CSS}
</style>
<script>${CARD_RUNTIME}</script>
<script>${KIND_RENDERERS}</script>
<div id="board"><div class="empty" id="empty"><span>Ask Trinity for a picture, a note, a table, a chart, a document, a file or a widget. Drag a card by its header to move it, and by its corner to resize it.</span></div></div>
<script>
(function () {
  var board = document.getElementById("board");
  var emptyEl = document.getElementById("empty");
  var els = Object.create(null);      // card id -> its element
  var audioBy = Object.create(null);  // card id -> its Audio
  var local = Object.create(null);    // card id -> its box in this window (a drag under way is never snapped back)
  var busy = Object.create(null);     // card id -> "drag" | "resize"
  var zTop = 1;
  var cardsByN = Object.create(null); // commands name a card by its number
  var cardsById = Object.create(null);
  var waiting = Object.create(null);
  var heights = Object.create(null);  // card id -> the height last reported to the engine
  var noise = Object.create(null);    // card id -> when its widget last sent errors, events, states (so each can be capped)
  var kindView = Object.create(null); // card id -> what this window has done to an engine-drawn card (a table's sort)
  var kindCache = Object.create(null);
  var RT = window.__trinityCard;
  var KINDS = window.__trinityKinds || {};
  function kindFn(name){ return Object.prototype.hasOwnProperty.call(KINDS, name)&&typeof KINDS[name]==="function"?KINDS[name]:null; }
  var WIDGET_RT = ${JSON.stringify(`${WIDGET_RUNTIME}
${CARD_RUNTIME}
${CARD_LISTENER}`)};
  var WIDGET_CSP = ${JSON.stringify(WIDGET_CSP)};
  var PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>';
  var LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/></svg>';
  // (Built by concatenation: a script tag or an HTML comment written out whole would end THIS script early.)
  var OPEN = "<scr" + "ipt>", CLOSE = "<" + "/scr" + "ipt>";
  var HEAD_TAGS = new RegExp("<(?:link|meta|base)(?=[\\s/>]|$)", "i");
  var LINK_TAGS = new RegExp("<(?:link|base)(?=[\\s/>]|$)[^>]*(?:>|$)", "gi");
  var META_TAGS = new RegExp("<meta(?=[\\s/>]|$)[^>]*(?:>|$)", "gi");
  var KEPT_WHOLE = new RegExp("(<" + "!--[\\s\\S]*?--" + ">|<scr" + "ipt\\b[\\s\\S]*?(?:<\\/scr" + "ipt>|$))", "i");
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
  function fmt(t){t=Math.max(0,Math.floor(t||0));return Math.floor(t/60)+":"+(t%60<10?"0":"")+(t%60);}
  function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
  function r1(n){return Math.round(n*10)/10;}
  function emit(evt){ try{ if(window.trinity&&window.trinity.send) window.trinity.send(evt); }catch(e){} }
  // JSON that can sit inside a script tag: no "<" (so no closing tag and no comment), no line separators.
  function scriptJson(v){
    var s; try{ s=JSON.stringify(v===undefined?null:v); }catch(e){ s="null"; }
    return String(s||"null").replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
  }
  function stateJson(c){ try{ return JSON.stringify(c.state===undefined?null:c.state)||"null"; }catch(e){ return "null"; } }
  // A page without the tags that reach out of the sandbox or steer the frame: <link> and <base> wherever they are,
  // <meta> outside comments and scripts. (The engine takes them out when a card is written; this is for a board saved before it did.)
  function strip(html){
    var s=String(html||"");
    if(!HEAD_TAGS.test(s)) return s;
    s=s.replace(LINK_TAGS," ");
    var parts=s.split(KEPT_WHOLE);
    for(var i=0;i<parts.length;i+=2) parts[i]=parts[i].replace(META_TAGS," ");
    return parts.join("");
  }
  // A widget card's document: its own policy first, then the widget runtime (with what the card kept) and the card
  // runtime, then the page. Always a srcdoc under its own opaque origin: a card never loads a web page of its own.
  function widgetDoc(c, html){
    return '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="'+WIDGET_CSP+'"><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off">'+
      OPEN+"window.__trinityBoot="+scriptJson({state:c.state===undefined?null:c.state})+";"+CLOSE+
      OPEN+WIDGET_RT+CLOSE+
      "<style>html,body{margin:0;height:100%;background:#0f0f18;color:#e9e9f2;font:14px/1.45 system-ui,sans-serif}img,video{max-width:100%}</style></head><body>"+strip(html)+"</body></html>";
  }
  function allow(id, what, max, ms){
    var mine=noise[id]||(noise[id]=Object.create(null)), list=mine[what]||(mine[what]=[]), now=Date.now();
    while(list.length&&now-list[0]>ms) list.shift();
    if(list.length>=max) return false;
    list.push(now);
    return true;
  }
  function remember(c){
    if(busy[c.id]) return;
    local[c.id]={x:Number(c.x)||0,y:Number(c.y)||0,w:Number(c.w)||32,h:c.h!=null&&c.h!==""?Number(c.h):null,z:Number(c.z)||1};
    if(local[c.id].z>zTop) zTop=local[c.id].z;
  }
  function applyBox(el, L){
    el.style.left=clamp(L.x,0,90)+"%";
    el.style.top=clamp(L.y,0,90)+"%";
    el.style.width=clamp(L.w,12,98)+"%";
    if(L.h!=null&&isFinite(L.h)){ el.style.height=clamp(L.h,14,98)+"%"; el.classList.add("has-h"); }
    else { el.style.height=""; el.classList.remove("has-h"); }
    el.style.zIndex=String(L.z||1);
  }
  function persist(id){
    var L=local[id], c=cardsById[id]; if(!L||!c) return;
    emit({__trinity:"board",op:"layout",id:id,n:c.n,x:r1(L.x),y:r1(L.y),w:r1(L.w),h:L.h==null?null:r1(L.h),z:L.z});
  }
  function refreshAudio(id){
    var a=audioBy[id], root=els[id];
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
  // An engine-drawn card (a table, a chart, a document, code, a file): drawn here from its data by the kind's own
  // renderer, and drawn again only when the data or what this window did to it (a sort) changed.
  function kindBody(c){
    var view=kindView[c.id]||null, key=(c.dv||0)+"|"+(view?JSON.stringify(view):"");
    var hit=kindCache[c.id];
    if(hit&&hit.key===key) return hit.html;
    var html;
    try{ html=String(kindFn(c.kind)(c, view, esc)); }
    catch(e){ html='<p class="cap err">'+esc("This "+c.kind+" couldn't be drawn.")+"</p>"; }
    kindCache[c.id]={key:key,html:html};
    return html;
  }
  function bodyHtml(c){
    // A secure form's placeholder: only ever this, whatever else the card record may carry.
    if(c.kind==="form") return '<div class="formcard">'+LOCK+"<p>Waiting for you in the secure form</p></div>";
    // (What went wrong is said once, under the card.)
    if(c.status==="error") return '<div class="shim still'+(c.kind==="video"?" wide":c.kind==="image"?"":" tall")+'"></div>';
    if(c.html) return '<iframe sandbox="allow-scripts allow-forms" allow="autoplay"></iframe>';
    if(kindFn(c.kind)){
      if(c.data!=null&&c.status==="ready") return kindBody(c);
      return '<div class="shim tall"></div>';
    }
    if(c.kind==="widget") return '<div class="shim tall"></div>';
    if(c.kind==="text") return '<p class="text-body">'+esc(c.text||"")+"</p>";
    if(c.kind==="audio"){
      var ready=c.status==="ready"&&c.url;
      var h='<div class="player"><button class="btn" type="button" data-play="1"'+(ready?"":" disabled")+' aria-label="Play">'+PLAY+"</button>";
      h+='<div class="bar">'+(ready?'<div class="track" data-seek="1"><div class="fill"></div></div><div class="time"><span>0:00</span><span>0:00</span></div>':'<div class="shim" style="height:6px;aspect-ratio:auto"></div>')+"</div></div>";
      return h;
    }
    if(c.status==="ready"&&c.url){
      var mw=clamp(Number(c.mw)||100,10,100);
      var mh=c.mh!=null&&c.mh!==""?clamp(Number(c.mh),10,100):null;
      var st="width:"+mw+"%;"+(mh!=null?"height:"+mh+"%;":"height:auto;")+"max-width:100%;margin:0 auto;object-fit:contain;";
      if(c.kind==="video") return '<video src="'+esc(c.url)+'" controls playsinline autoplay muted loop style="'+st+'"></video>';
      return '<img src="'+esc(c.url)+'" alt="'+esc(c.text)+'" decoding="async" draggable="false" style="'+st+'">';
    }
    return '<div class="shim'+(c.kind==="video"?" wide":"")+'"></div>';
  }
  function capsHtml(c){
    if(c.kind==="form") return "";
    if(c.status==="error") return '<p class="cap err">'+esc("Couldn't make this: "+(c.error||"unknown error"))+"</p>";
    if(c.status==="pending") return '<p class="cap">'+esc(pendingLabel(c)+": "+(c.text||"\u2026"))+"</p>"+(c.model?'<p class="cap">'+esc(c.model)+"</p>":"");
    // A ready card whose page threw: the page stays, and the card says so.
    if(c.error){ var note=String(c.error); return '<p class="cap warn">'+esc(note.charAt(0).toUpperCase()+note.slice(1))+"</p>"; }
    if((c.kind==="image"||c.kind==="video"||c.kind==="audio")&&c.text) return '<p class="cap">'+esc(c.text)+"</p>";
    return "";
  }
  function postState(frame, c){
    try{ if(frame.contentWindow) frame.contentWindow.postMessage({__trinity:"state",state:c.state===undefined?null:c.state},"*"); }catch(e){}
  }
  function syncWidget(el, c){
    var frame=el._body.querySelector("iframe");
    el._frame=frame||null;
    if(!frame) return;
    frame.title=c.title||("Card "+c.n);
    var next=String(c.html||""), sj=stateJson(c), ready=c.status==="ready";
    if(frame._key===next&&(frame._ready||!ready)){
      // The same page: only what the card keeps (trinity.saveState) may have changed — in another window.
      if(sj===frame._state) frame._sent=[];
      else if(frame._sent.indexOf(sj)<0){ frame._state=sj; frame._sent=[]; if(frame._loaded) postState(frame, c); }
      return;
    }
    frame._key=next; frame._ready=ready; frame._state=sj; frame._boot=sj; frame._sent=[]; frame._loaded=false; frame._card=c.id;
    frame.onload=function(){
      frame._loaded=true;
      var now=cardsById[frame._card];
      if(now&&frame._state!==frame._boot) postState(frame, now); // it changed while the page was loading
    };
    frame.removeAttribute("src");
    frame.setAttribute("sandbox","allow-scripts allow-forms");
    frame.srcdoc=widgetDoc(c, next);
  }
  function setText(node, text){ if(node&&node.textContent!==text) node.textContent=text; }
  function ensureCard(c){
    remember(c);
    var id=c.id, L=local[id], el=els[id];
    if(!el){
      el=document.createElement("article");
      el.setAttribute("data-id", id);
      el.innerHTML='<div class="chrome" data-drag="1"><span class="badge"></span><span class="kind"></span><h3 class="title"></h3></div><div class="body"></div><div class="caps"></div><div class="grip" data-resize="1" title="Resize"></div>';
      el._badge=el.querySelector(".badge"); el._kind=el.querySelector(".kind"); el._title=el.querySelector(".title");
      el._body=el.querySelector(".body"); el._caps=el.querySelector(".caps");
      board.appendChild(el);
      els[id]=el;
      if(sizeWatch) sizeWatch.observe(el);
    }
    el.setAttribute("data-n", String(c.n));
    el.className="card k-"+String(c.kind).replace(/[^a-z]/g,"")+(c.kind==="widget"?" widget":"")+(c.kind==="form"?" form":"")+(busy[id]==="drag"?" is-drag":"")+(busy[id]==="resize"?" is-resize":"");
    applyBox(el, L);
    setText(el._badge, String(c.n)); setText(el._kind, String(c.kind)); setText(el._title, c.title||("Card "+c.n));
    // Each part is drawn again only when what it shows changed: a move or a new title keeps a playing video, a widget's page and a table's scroll.
    var body=bodyHtml(c), fresh=false;
    if(el._bodyHtml!==body){ el._body.innerHTML=body; el._bodyHtml=body; fresh=true; }
    var caps=capsHtml(c);
    if(el._capsHtml!==caps){ el._caps.innerHTML=caps; el._capsHtml=caps; }
    syncWidget(el, c);
    if(fresh){
      var img=el._body.querySelector("img"), vid=el._body.querySelector("video");
      if(img){ if(img.complete) img.classList.add("is-on"); else img.addEventListener("load",function(ev){ev.target.classList.add("is-on");}); }
      if(vid){ if(vid.readyState>=2) vid.classList.add("is-on"); else vid.addEventListener("loadeddata",function(ev){ev.target.classList.add("is-on");}); }
    }
    return el;
  }
  function forget(id){
    var el=els[id];
    if(el){ if(sizeWatch){ try{ sizeWatch.unobserve(el); }catch(e){} } el.remove(); }
    delete els[id];
    if(audioBy[id]){ try{ audioBy[id].pause(); }catch(e){} delete audioBy[id]; }
    delete local[id]; delete busy[id]; delete heights[id]; delete noise[id]; delete kindView[id]; delete kindCache[id];
  }

  // ── Heights: what each card really takes up, told to the engine (so "under" and "beside" don't overlap) ──
  var measureTimer=0;
  function measure(){
    measureTimer=0;
    var bh=board.getBoundingClientRect().height;
    if(!bh) return;
    var out=null;
    for(var id in els){
      if(busy[id]||!cardsById[id]) continue;
      var h=r1(els[id].getBoundingClientRect().height/bh*100);
      if(heights[id]===undefined||Math.abs(heights[id]-h)>=0.6){ heights[id]=h; (out=out||{})[id]=h; }
    }
    if(out) emit({__trinity:"board",op:"sizes",sizes:out});
  }
  function measureSoon(ms){ if(measureTimer) clearTimeout(measureTimer); measureTimer=setTimeout(measure, ms||600); }
  var sizeWatch=null;
  try{ sizeWatch=new ResizeObserver(function(){ measureSoon(300); }); }catch(e){ sizeWatch=null; }
  window.addEventListener("resize", function(){ measureSoon(300); });

  // ── Moving and sizing by hand ──
  // The handle captures the pointer, and the frames stop taking it for as long as the drag lasts: a drag never
  // stalls over a widget, and a release over one is still heard.
  function startPointer(mode, id, e){
    if(e.button!=null&&e.button!==0) return;
    var L=local[id], el=els[id];
    if(!L||!el||busy[id]) return;
    e.preventDefault();
    e.stopPropagation();
    var handle=e.target&&e.target.closest?e.target.closest(mode==="drag"?"[data-drag]":"[data-resize]"):null;
    var pid=e.pointerId, done=false;
    zTop+=1; L.z=zTop; busy[id]=mode;
    el.classList.add(mode==="drag"?"is-drag":"is-resize");
    board.classList.add("is-busy");
    el.style.zIndex=String(L.z);
    var br=board.getBoundingClientRect();
    var startX=e.clientX, startY=e.clientY, ox=L.x, oy=L.y, ow=L.w, oh=L.h!=null?L.h:Math.max(14,(el.getBoundingClientRect().height/br.height)*100);
    function move(ev){
      if(done||(pid!=null&&ev.pointerId!=null&&ev.pointerId!==pid)) return;
      var dx=((ev.clientX-startX)/br.width)*100, dy=((ev.clientY-startY)/br.height)*100;
      if(mode==="drag"){ L.x=clamp(ox+dx,0,90); L.y=clamp(oy+dy,0,90); }
      else { L.w=clamp(ow+dx,12,98); L.h=clamp(oh+dy,14,98); }
      applyBox(el, L);
    }
    function up(ev){
      if(done||(ev&&pid!=null&&ev.pointerId!=null&&ev.pointerId!==pid)) return;
      done=true;
      delete busy[id];
      el.classList.remove("is-drag","is-resize");
      var others=false; for(var k in busy){ others=true; break; }
      if(!others) board.classList.remove("is-busy");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      if(handle){
        handle.removeEventListener("lostpointercapture", up);
        try{ if(pid!=null&&handle.hasPointerCapture&&handle.hasPointerCapture(pid)) handle.releasePointerCapture(pid); }catch(x){}
      }
      persist(id);
      measureSoon(300);
    }
    try{ if(handle&&pid!=null) handle.setPointerCapture(pid); }catch(x){}
    // (With the pointer captured, its events go to the handle and bubble here, wherever the pointer is.)
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    if(handle) handle.addEventListener("lostpointercapture", up);
  }
  function cardIdOf(node){ var el=node&&node.closest?node.closest("[data-id]"):null; return el?el.getAttribute("data-id"):null; }
  board.addEventListener("pointerdown", function(e){
    var t=e.target; if(!t||!t.closest) return;
    if(t.closest(".btn")||t.closest("[data-seek]")||t.closest(".body")) return;
    var id=cardIdOf(t); if(!id||!els[id]) return;
    if(t.closest("[data-resize]")){ startPointer("resize", id, e); return; }
    if(t.closest("[data-drag]")){ startPointer("drag", id, e); return; }
  });
  board.addEventListener("click", function(e){
    var t=e.target; if(!t||!t.closest) return;
    var id=cardIdOf(t); if(!id) return;
    if(t.closest("[data-play]")){
      var aa=audioBy[id];
      if(!aa) return;
      if(aa.paused){ var q=aa.play(); if(q&&q.catch) q.catch(function(){}); } else aa.pause();
      return;
    }
    var seek=t.closest("[data-seek]");
    if(seek){
      var a2=audioBy[id];
      if(!a2||!isFinite(a2.duration)) return;
      var r=seek.getBoundingClientRect();
      a2.currentTime=a2.duration*Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
      return;
    }
    // A click inside an engine-drawn card (a table header to sort by, …): its kind says what it changes here.
    var c=cardsById[id];
    var onClick=c?kindFn(c.kind+"Click"):null;
    if(onClick){
      var next=null;
      try{ next=onClick(c, kindView[id]||null, t); }catch(x){ next=null; }
      if(next){ kindView[id]=next; ensureCard(c); }
    }
  });

  // ── What a widget says (only from one of this board's own card frames) ──
  function frameCard(win){
    for(var id in els){ var f=els[id]._frame; if(f&&f.contentWindow===win) return id; }
    return null;
  }
  function jsonOf(v, max){
    var j; try{ j=JSON.stringify(v===undefined?null:v); }catch(e){ return null; }
    return typeof j==="string"&&j.length<=max?j:null;
  }
  window.addEventListener("message", function(e){
    var d=e.data; if(!d||typeof d.__trinity!=="string") return;
    var id=frameCard(e.source); if(!id) return;
    var c=cardsById[id], el=els[id]; if(!c||!el) return;
    var what=d.__trinity, j;
    if(what==="link"){
      // A link clicked in the card: handed to the window, which asks before it opens anything.
      if(typeof d.href!=="string") return;
      var h=d.href.trim(), l=h.toLowerCase();
      if(l.indexOf("https://")===0||l.indexOf("http://")===0) window.open(h);
    } else if(what==="cmd_result"){
      // The answer to a command: only from the frame the command went to, only for a command still waiting.
      var w=waiting[d.id]; if(!w||w.win!==e.source) return;
      clearTimeout(w.timer); delete waiting[d.id];
      answer(d.id, w.n, d);
    } else if(what==="alert"){
      if(allow(id,"alert",3,10000)) emit({__trinity:"alert",text:String(d.text==null?"":d.text).slice(0,300)});
    } else if(what==="error"){
      // A script error in the card's page. A page that is still streaming in is not finished: its errors don't count.
      if(c.status!=="ready"||!allow(id,"error",3,60000)) return;
      emit({__trinity:"board",op:"card_error",id:id,n:c.n,message:String(d.message==null?"":d.message).slice(0,300)});
    } else if(what==="state"){
      // trinity.saveState: kept with the card by the engine, and shown by every other window.
      if(c.status!=="ready"||!(j=jsonOf(d.state,16384))||!allow(id,"state",60,60000)) return;
      var f=el._frame; f._state=j; f._sent.push(j); if(f._sent.length>20) f._sent.shift();
      emit({__trinity:"board",op:"card_state",id:id,n:c.n,state:JSON.parse(j)});
    } else if(what==="emit"){
      // trinity.emit: the user pressed something in the card that is meant for Trinity.
      if(c.status!=="ready"||!(j=jsonOf(d.event,2048))||!allow(id,"emit",4,10000)) return;
      emit({__trinity:"board",op:"card_event",id:id,n:c.n,event:JSON.parse(j)});
    }
  });

  // ── Commands from the engine (workspace/card-commands.ts): run on the card itself — its video or audio here, or
  // inside a widget's frame (the card runtime there answers) — and report what happened. ──
  function answer(id, n, r){
    r = r || {};
    emit({__trinity:"board", op:"cmd_result", id:id, n:n, ok:!!r.ok, via:r.via, label:r.label, already:r.already, reason:r.reason, detail:r.detail, controls:r.controls, text:r.text, media:r.media});
  }
  function onCommand(cmd){
    if(!cmd||typeof cmd!=="object") return;
    var id=String(cmd.id||""), n=Number(cmd.n), op=String(cmd.op||""), arg=cmd.arg;
    var c=cardsByN[n], el=c?els[c.id]:null;
    if(!el||!c) return answer(id,n,{ok:false,reason:"missing"});
    // A secure form's placeholder is never read, pressed or typed into from here.
    if(c.kind==="form") return answer(id,n,{ok:false,reason:"form"});
    if(c.status==="pending") return answer(id,n,{ok:false,reason:"pending"});
    if(!RT) return answer(id,n,{ok:false,reason:"error",detail:"no card runtime"});
    if(c.kind==="audio"&&!c.html){
      var a=audioBy[c.id];
      if(!a) return answer(id,n,{ok:false,reason:"no-media"});
      if(op==="read") return answer(id,n,{ok:true,via:"read",text:"audio "+RT.mediaText(a),media:RT.mediaState(a)});
      if(op==="controls") return answer(id,n,{ok:true,controls:["play","pause","restart","mute","louder","quieter","skip ahead","skip back","loop"]});
      return RT.mediaOp(a,op,arg).then(function(r){ refreshAudio(c.id); answer(id,n,r); });
    }
    var frame=el._body.querySelector("iframe");
    if(frame){
      var win=frame.contentWindow;
      if(!win) return answer(id,n,{ok:false,reason:"no-answer"});
      waiting[id]={win:win,n:n,timer:setTimeout(function(){ delete waiting[id]; answer(id,n,{ok:false,reason:"no-answer"}); },1800)};
      try{ win.postMessage({__trinity:"cmd",id:id,op:op,arg:arg},"*"); }
      catch(e){ clearTimeout(waiting[id].timer); delete waiting[id]; answer(id,n,{ok:false,reason:"error",detail:String(e)}); }
      return;
    }
    var vid=el._body.querySelector("video");
    if(vid){
      if(op==="read") return answer(id,n,{ok:true,via:"read",text:"video "+RT.mediaText(vid),media:RT.mediaState(vid)});
      if(op==="controls") return answer(id,n,{ok:true,controls:["play","pause","restart","mute","unmute","louder","quieter","skip ahead","skip back","loop","faster","slower"]});
      return RT.mediaOp(vid,op,arg).then(function(r){ answer(id,n,r); });
    }
    var body=el.querySelector(".text-body")||el._body||el;
    if(op==="read") return answer(id,n,{ok:true,via:"read",text:String(body.innerText||c.text||"").slice(0,4000)});
    if(op==="scroll_down"||op==="scroll_up"||op==="scroll_top") return answer(id,n,RT.scroll(el,op));
    if(op==="controls") return answer(id,n,{ok:true,controls:[]});
    return answer(id,n,{ok:false,reason:c.kind==="widget"?"no-control":"no-media"});
  }
  if(window.trinity) window.trinity.oncommand=onCommand;

  window.render=function(state){
    var raw=(state&&state.cards)||[], cards=[], keep=Object.create(null), i, c, id;
    cardsByN=Object.create(null);
    cardsById=Object.create(null);
    for(i=0;i<raw.length;i++){
      c=raw[i];
      if(!c||typeof c.n!=="number") continue;
      // (A card from before cards had ids: its id follows from its number, as the engine's does.)
      if(typeof c.id!=="string"||!c.id){ var copy={}; for(var k in c) copy[k]=c[k]; copy.id="n"+c.n; c=copy; }
      if(keep[c.id]) continue;
      keep[c.id]=true; cardsById[c.id]=c; cardsByN[c.n]=c; cards.push(c);
    }
    for(id in els){ if(!keep[id]) forget(id); }
    emptyEl.hidden=cards.length>0;
    for(i=0;i<cards.length;i++){
      c=cards[i];
      ensureCard(c);
      if(c.kind==="audio"&&c.status==="ready"&&c.url&&!c.html){
        var a=audioBy[c.id];
        if(!a||a._src!==c.url){
          if(a) try{a.pause();}catch(e){}
          a=new Audio(c.url); a._src=c.url; audioBy[c.id]=a;
          (function(cid, au){
            au.addEventListener("timeupdate",function(){refreshAudio(cid);});
            au.addEventListener("play",function(){refreshAudio(cid);});
            au.addEventListener("pause",function(){refreshAudio(cid);});
            au.addEventListener("ended",function(){au.currentTime=0;refreshAudio(cid);});
            var p=au.play(); if(p&&p.catch) p.catch(function(){refreshAudio(cid);});
          })(c.id, a);
        }
        refreshAudio(c.id);
      } else if(audioBy[c.id]){ try{audioBy[c.id].pause();}catch(e){} delete audioBy[c.id]; }
    }
    measureSoon(600);
  };
})();
</script>`,
};

function emptyState(): BoardState {
  return { cards: [] };
}

/**
 * Any id the engine's own board template has had ("board@1", "board@2", …). A saved board is recognised by the shape
 * of its id, not by a hand-kept list, so a later bump can never orphan the cards saved under an earlier one.
 */
const BOARD_ID = /^board@\d+$/;
const newCardId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

function isBoard(): boolean {
  return workspace.mode === "app" && workspace.owner === BOARD_OWNER && BOARD_ID.test(workspace.templateId ?? "");
}

/** The board on screen runs this build's template (its id and its source: a template edited without a new id still replaces the saved one). */
function templateCurrent(): boolean {
  const t = workspace.snapshot().template;
  return t?.id === BOARD_TEMPLATE.id && t.source === BOARD_TEMPLATE.source;
}

/**
 * The cards of a board state, each with its id. A card saved before cards had ids (or put there by hand) gets one that
 * follows from its number, so it is the same every time the state is read; the next write keeps it.
 */
function cardsIn(raw: unknown): BoardCard[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as BoardState).cards) ? (raw as BoardState).cards : [];
  const out: BoardCard[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (!c || typeof c !== "object" || typeof c.n !== "number") continue;
    let card = c;
    if (typeof card.id !== "string" || !card.id || seen.has(card.id)) {
      let id = `n${card.n}`;
      for (let k = 2; seen.has(id); k++) id = `n${card.n}-${k}`;
      card = { ...card, id };
    }
    seen.add(card.id);
    out.push(card);
  }
  return out;
}

function read(): BoardState {
  if (!isBoard()) return emptyState();
  const raw = workspace.state as BoardState | null;
  const seq = raw && typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0;
  return { cards: cardsIn(raw), seq };
}

/** Put the state on screen. Card objects are never changed after this: a change makes a new object (undo entries keep the old ones as they are). */
function write(state: BoardState, title = "Workspace"): boolean {
  let seq = state.seq ?? 0;
  for (const c of state.cards) if (c.n > seq) seq = c.n;
  const next: BoardState = { cards: state.cards, seq };
  // No board yet — or one saved under an older template: this one takes over, cards kept.
  if (!isBoard() || !templateCurrent()) {
    workspace.showApp(BOARD_TEMPLATE, next, title, BOARD_OWNER);
    return true;
  }
  return workspace.setState(next, BOARD_OWNER);
}

/**
 * The next card's number: one more than the highest ever handed out on this board — and than any card an undo could
 * still bring back (after a clear), so a number never means two cards.
 */
function nextNumber(state: BoardState): number {
  let max = state.seq ?? 0;
  for (const c of state.cards) if (c.n > max) max = c.n;
  for (const e of workspace.undoEntries()) {
    if (e.owner !== BOARD_OWNER) continue;
    const s = e.state as BoardState | null;
    if (s && typeof s.seq === "number" && s.seq > max) max = s.seq;
    for (const c of cardsIn(s)) if (c.n > max) max = c.n;
  }
  return max + 1;
}

// ─── Sizes and limits ───────────────────────────────────────────────────────

const jsonLength = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

const cardSizes = new WeakMap<BoardCard, number>();

/** Roughly what a card adds to the saved board, in characters (kept per card object: a card never changes in place). */
function cardBytes(c: BoardCard): number {
  let size = cardSizes.get(c);
  if (size === undefined) {
    size = 400 + String(c.title ?? "").length + String(c.text ?? "").length + (c.html?.length ?? 0) + (c.stash?.length ?? 0);
    if (c.data !== undefined) size += jsonLength(c.data);
    if (c.state !== undefined) size += jsonLength(c.state);
    cardSizes.set(c, size);
  }
  return size;
}

/** What the whole board holds, in characters. */
export function boardBytes(): number {
  return read().cards.reduce((sum, c) => sum + cardBytes(c), 0);
}

function checkTotal(cards: BoardCard[]): void {
  let total = 0;
  for (const c of cards) total += cardBytes(c);
  if (total > BOARD_LIMITS.total) throw new BoardLimitError("total", "The board is holding too much to take that as well. Remove a card or two first.");
}

/**
 * Card HTML without the tags that reach out of the sandbox or steer the frame: <link> (a preconnect or dns-prefetch
 * hint goes to its host the moment it is parsed, which no CSP covers), <base>, and <meta> (a refresh navigates the
 * frame). A skill's page and a build's half-streamed page come through here like everything else. Comments and scripts
 * are kept whole for <meta> (one written inside is inert or is the page's own code); links go wherever they are
 * written. A space takes each tag's place, and only the whole tag name counts ("<link-card>" is the page's own).
 * A page over the size a card may hold is refused.
 */
export function cleanCardHtml(html: string): string {
  let s = String(html);
  if (/<(?:link|meta|base)(?=[\s/>]|$)/i.test(s)) {
    s = s
      .replace(/<(?:link|base)(?=[\s/>]|$)[^>]*(?:>|$)/gi, " ")
      .split(/(<!--[\s\S]*?-->|<script\b[\s\S]*?(?:<\/script>|$))/i)
      .map((piece, i) => (i % 2 ? piece : piece.replace(/<meta(?=[\s/>]|$)[^>]*(?:>|$)/gi, " ")))
      .join("");
  }
  if (s.length > BOARD_LIMITS.cardHtml)
    throw new BoardLimitError("html", `That page is too big for one card: ${kb(s.length)}, and a card holds up to ${kb(BOARD_LIMITS.cardHtml)}.`);
  return s;
}

/** Push the current board template over an older one (any earlier id, or the same id with other code) without clearing cards. */
function upgradeBoardTemplate(): void {
  if (!isBoard() || templateCurrent()) return;
  const state = read();
  workspace.showApp(BOARD_TEMPLATE, { cards: state.cards, seq: state.seq }, workspace.snapshot().title || "Workspace", BOARD_OWNER);
}

export function boardActive(): boolean {
  upgradeBoardTemplate();
  return isBoard();
}

export function listCards(): BoardCard[] {
  upgradeBoardTemplate();
  return read().cards.slice().sort((a, b) => a.n - b.n);
}

/** The card with this number now. (Work that outlives the moment holds the card's id: see cardById.) */
export function getCard(n: number): BoardCard | null {
  return read().cards.find((c) => c.n === n) ?? null;
}

/** The card with this id, while it is on the board. */
export function cardById(id: string): BoardCard | null {
  return read().cards.find((c) => c.id === id) ?? null;
}

export function describeBoard(): string {
  const cards = listCards();
  if (!cards.length) return "The workspace board is empty.";
  const bits = cards.map((c) => {
    const status = c.status === "pending" ? "still loading" : c.status === "error" ? (c.retry ? "failed, can be tried again" : "failed") : c.error ? "ready, with a script error" : "ready";
    const size =
      c.kind === "image" || c.kind === "video"
        ? `, media ${Math.round(c.mw ?? 100)}% wide` + (c.mh != null ? ` × ${Math.round(c.mh)}% tall` : "")
        : "";
    const htmlBits = c.html ? `, editable HTML (${summarizeHtml(c.html)})` : "";
    const holds = isDataKindName(c.kind) && c.status === "ready" ? kindSummary(c) : null;
    const tags = (c.tags ?? []).length ? `, about: ${(c.tags ?? []).slice(0, 6).join(", ")}` : "";
    const cx = c.x + c.w / 2;
    const cy = c.y + (c.h ?? 40) / 2;
    const v = cy < 34 ? "top" : cy > 66 ? "bottom" : "";
    const h = cx < 34 ? "left" : cx > 66 ? "right" : "";
    const where = isMinimized(c) ? "minimized" : isMaximized(c) ? "full screen" : v && h ? `${v} ${h}` : v || h || "center";
    return `card ${c.n} (${c.kind}, ${status}, ${where}${size}${htmlBits}${holds ? `, ${holds}` : ""}${tags}): ${c.title}`;
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

// ─── Where cards are, and how tall ──────────────────────────────────────────

/** Heights the windows measured, in % of the board, by card id: what a content-sized card really takes up. Not saved. */
const measured = new Map<string, number>();
/** Cards still where the engine first put them (nobody has moved or sized them): the only ones it may nudge back onto the board. */
const autoPlaced = new Set<string>();

/** A card's height in % of the board: the one it was given, else the one a window measured, else a guess for its kind. */
export function cardHeight(c: BoardCard): number {
  return c.h ?? measured.get(c.id) ?? GUESS_H[c.kind] ?? 40;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where a new card of this size goes: the first of the board's usual spots that is free, else the first free place
 * found scanning left to right and top to bottom, else the place that covers the least of what is already there —
 * always wholly on the board (x + w and y + h stay under 100), and never exactly on another card's corner.
 */
function freeSpot(cards: BoardCard[], w: number, h: number): { x: number; y: number } {
  const maxX = round1(Math.max(0, 100 - w - 1));
  const maxY = round1(Math.max(0, 100 - h - 1));
  const taken: Box[] = cards.filter((c) => !isMaximized(c)).map((c) => ({ x: c.x, y: c.y, w: c.w, h: cardHeight(c) }));
  const spots = SLOT.map((s) => ({ x: Math.min(s.x, maxX), y: Math.min(s.y, maxY) }));
  const steps = (max: number): number[] => {
    const out: number[] = [];
    for (let v = 2; v < max; v += 6) out.push(v);
    out.push(max);
    return out;
  };
  for (const y of steps(maxY)) for (const x of steps(maxX)) spots.push({ x, y });
  let best = spots[0]!;
  let least = Infinity;
  for (const p of spots) {
    let cost = 0;
    for (const t of taken) cost += overlap({ x: p.x, y: p.y, w, h }, t);
    if (cost < least - 0.01) {
      best = p;
      least = cost;
      if (cost === 0) break;
    }
  }
  if (least > 0) {
    let { x, y } = best;
    for (let k = 0; k < 12 && taken.some((t) => Math.abs(t.x - x) < 2 && Math.abs(t.y - y) < 2); k++) {
      x = Math.min(maxX, x + 3);
      y = Math.min(maxY, y + 3);
    }
    best = { x: round1(x), y: round1(y) };
  }
  return best;
}

/**
 * Heights the board measured in a window ({card id: % of the board}). They are kept for placing cards next to each
 * other; and a card the engine placed itself that turns out to run off the bottom is moved up until it fits.
 */
export function noteCardHeights(sizes: Record<string, unknown>): void {
  if (!isBoard()) return;
  const state = read();
  let moved = false;
  for (const c of state.cards) {
    const h = Number(sizes[c.id]);
    if (!Number.isFinite(h) || h <= 0 || h > 400) continue;
    measured.set(c.id, round1(h));
  }
  const cards = state.cards.map((c) => {
    if (c.h != null || !autoPlaced.has(c.id) || isMinimized(c)) return c;
    const h = measured.get(c.id);
    if (h === undefined || c.y + h <= 100) return c;
    const y = round1(Math.max(0, 100 - h - 1));
    if (Math.abs(y - c.y) < 0.5) return c;
    moved = true;
    return { ...c, y };
  });
  const here = new Set(state.cards.map((c) => c.id));
  for (const id of measured.keys()) if (!here.has(id)) measured.delete(id);
  for (const id of autoPlaced) if (!here.has(id)) autoPlaced.delete(id);
  if (moved) write({ ...state, cards });
}

/** Persist a user drag/resize from the board UI (percentages of the board). Undo puts the card back. */
export function applyCardLayout(
  ref: number | string,
  layout: { x: number; y: number; w: number; h?: number | null; z?: number },
): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => (typeof ref === "string" ? c.id === ref : c.n === ref));
  if (i < 0) return null;
  const old = state.cards[i]!;
  const card = { ...old };
  card.x = Math.max(0, Math.min(X_MAX, Number(layout.x) || 0));
  card.y = Math.max(0, Math.min(X_MAX, Number(layout.y) || 0));
  card.w = Math.max(W_MIN, Math.min(W_MAX, Number(layout.w) || card.w));
  if (layout.h === null || layout.h === undefined) delete card.h;
  else card.h = Math.max(H_MIN, Math.min(H_MAX, Number(layout.h)));
  if (typeof layout.z === "number" && Number.isFinite(layout.z)) card.z = layout.z;
  // A drag or a resize by hand can be undone like one asked for by voice (a run of them on one card is one step);
  // a click that only brings the card to the front is not worth an undo step.
  const boxChanged = card.x !== old.x || card.y !== old.y || card.w !== old.w || card.h !== old.h;
  if (boxChanged) {
    const reason = `hand:${old.id}`;
    const entries = workspace.undoEntries();
    const top = entries[entries.length - 1];
    if (!(top && top.reason === reason && Date.now() - top.at < 8_000)) workspace.pushUndo(reason, 1);
    autoPlaced.delete(old.id);
  }
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
  /** For the kinds the board draws itself: the data, already normalized (workspace/kinds). */
  data?: unknown;
  /** How to make the card again if it fails or is interrupted. */
  retry?: CardRetry;
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
  let html: string;
  try {
    html = cleanCardHtml(s.html);
  } catch {
    return null; // too big to be a card: the next add starts a fresh board
  }
  const card: BoardCard = {
    id: newCardId(),
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
    html,
  };
  write({ cards: [card] }, "Workspace");
  return card;
}

let reviveNext: string | null = null;

/**
 * The next addCard (of the same kind) fills this card again instead of making a new one — same number, place and
 * size. For "try again" on a card that failed: set it, start the tool that made the card, and clear it (null) as soon
 * as that call returns, so only a card added in the tool's first step can take it.
 */
export function reviveWithNext(id: string | null): void {
  reviveNext = id;
}

/** Ensure the board is showing, add a numbered floating card, return it. Throws BoardLimitError when the board can't take it. */
export function addCard(input: AddCardInput): BoardCard {
  adoptLegacyHtml();
  const state = read();
  const html = input.html == null ? null : cleanCardHtml(input.html);
  if (input.data !== undefined && isDataKindName(input.kind)) {
    const data = normalizeKindData(input.kind, input.data);
    if (data === null) throw new Error(`there is nothing in that to show as a ${input.kind}`);
    input = { ...input, data };
  }
  if (input.data !== undefined && jsonLength(input.data) > BOARD_LIMITS.cardData)
    throw new BoardLimitError("data", `That's too much for one card: it holds up to ${kb(BOARD_LIMITS.cardData)} of data.`);
  const tags = (input.tags?.length ? input.tags : tagsFromText(input.title, input.text)).slice(0, 12);
  const content = {
    kind: input.kind,
    status: input.status ?? "pending",
    title: input.title.slice(0, 80),
    text: input.text.slice(0, 2000),
    tags,
    url: input.url ?? null,
    html,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.data !== undefined ? { data: input.data, dv: 1 } : {}),
    ...(input.retry ? { retry: input.retry } : {}),
  };

  // "Try again": the card that failed is filled again in place.
  const reviving = reviveNext ? state.cards.findIndex((c) => c.id === reviveNext && c.kind === input.kind) : -1;
  reviveNext = null;
  if (reviving >= 0) {
    const old = state.cards[reviving]!;
    const card: BoardCard = { id: old.id, n: old.n, x: old.x, y: old.y, w: old.w, z: old.z, ...content };
    if (old.h != null) card.h = old.h;
    if (old.prev) card.prev = old.prev;
    state.cards[reviving] = card;
    checkTotal(state.cards);
    write(state, "Workspace");
    touchCards([card.n], true);
    return card;
  }

  // A secure form's placeholder never counts: a form must be able to open on a full board.
  if (input.kind !== "form" && state.cards.filter((c) => c.kind !== "form").length >= BOARD_LIMITS.cards)
    throw new BoardLimitError("cards", `The board is full: it holds ${BOARD_LIMITS.cards} cards. Remove a few first.`);
  const n = nextNumber(state);
  const w = input.w ?? CARD_W[input.kind];
  const h = input.h ?? CARD_H[input.kind];
  const placed = input.x == null || input.y == null;
  const spot = placed ? freeSpot(state.cards, w, h ?? GUESS_H[input.kind]) : { x: 0, y: 0 };
  const card: BoardCard = {
    id: newCardId(),
    n,
    x: input.x ?? spot.x,
    y: input.y ?? spot.y,
    w,
    z: Math.max(n, topZ(state.cards) + 1),
    ...content,
  };
  if (h != null) card.h = h;
  state.cards.push(card);
  checkTotal(state.cards);
  state.seq = n;
  write(state, "Workspace");
  if (placed) autoPlaced.add(card.id);
  touchCards([n], true);
  return card;
}

export type CardPatch = Partial<Omit<BoardCard, "id" | "n" | "kind">>;

function patched(state: BoardState, i: number, patch: CardPatch): BoardCard | null {
  const old = state.cards[i]!;
  if (old.kind === "form") return null;
  const next: BoardCard = { ...old, ...patch, id: old.id, n: old.n, kind: old.kind };
  if (typeof patch.html === "string") next.html = cleanCardHtml(patch.html);
  if ("data" in patch && patch.data !== undefined && patch.data !== old.data && isDataKindName(old.kind)) {
    const data = normalizeKindData(old.kind, patch.data);
    if (data === null) throw new Error(`there is nothing in that to show as a ${old.kind}`);
    next.data = data;
  }
  if ("data" in patch && patch.data !== old.data) {
    if (patch.data !== undefined && jsonLength(patch.data) > BOARD_LIMITS.cardData)
      throw new BoardLimitError("data", `That's too much for one card: it holds up to ${kb(BOARD_LIMITS.cardData)} of data.`);
    next.dv = (old.dv ?? 0) + 1;
  }
  // "undefined" takes a field off (it would not be saved anyway).
  for (const key of Object.keys(next) as (keyof BoardCard)[]) if (next[key] === undefined) delete next[key];
  state.cards[i] = next;
  if (cardBytes(next) > cardBytes(old)) checkTotal(state.cards);
  if (!write(state)) return null;
  return next;
}

/** Patch the card with this number. Returns null if missing / board not active — or a secure form's placeholder, which nothing edits. */
export function updateCard(n: number, patch: CardPatch): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  return i < 0 ? null : patched(state, i, patch);
}

/**
 * Patch the card with this id — what every job that finishes later uses: it reaches the card it was started for or
 * nothing at all (null), never a newer card that happens to have the same number.
 */
export function patchCard(id: string, patch: CardPatch): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.id === id);
  return i < 0 ? null : patched(state, i, patch);
}

export function removeCard(n: number): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  if (i < 0) return null;
  workspace.pushUndo(`remove_card:${n}`, 1);
  const [removed] = state.cards.splice(i, 1);
  write(state);
  return removed ?? null;
}

/** Take a card off without an undo entry: a placeholder whose job gave up before there was anything to keep. */
export function dropCard(id: string): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.id === id && c.kind !== "form");
  if (i < 0) return null;
  const [removed] = state.cards.splice(i, 1);
  write(state);
  return removed ?? null;
}

// ─── Nothing loads forever ──────────────────────────────────────────────────

const INTERRUPTED = "it was interrupted before it finished — say “try again” and I'll make it again";

/**
 * Cards that say they are loading while no job is behind them (the engine restarted mid-build, or an undo brought an
 * old screen back) would load forever: each becomes a card that says it was interrupted and can be asked for again —
 * or, where an edit was streaming in, the page as it was before the edit. Returns how many it settled.
 */
export function settleBoard(): number {
  if (!isBoard()) return 0;
  const state = read();
  let settled = 0;
  const cards = state.cards.map((c): BoardCard => {
    if (c.kind === "form") return c;
    if (c.status !== "pending") {
      // (A stash left on a card that is not loading belongs to no job any more.)
      if (c.stash === undefined || cardHeld(c.id)) return c;
      settled++;
      const { stash: _stash, ...rest } = c;
      return rest;
    }
    if (cardHeld(c.id)) return c;
    settled++;
    const { stash, model: _model, ...rest } = c;
    if (stash !== undefined) return { ...rest, status: "ready", html: stash, error: undefined } as BoardCard;
    // What was streamed so far is half a page: it goes, the card stays to be tried again.
    return { ...rest, status: "error", error: INTERRUPTED, html: c.kind === "widget" ? null : (c.html ?? null) };
  });
  if (settled) write({ ...state, cards: cards.map(withoutUndefined) });
  return settled;
}

function withoutUndefined(c: BoardCard): BoardCard {
  let out: BoardCard | null = null;
  for (const key of Object.keys(c) as (keyof BoardCard)[]) {
    if (c[key] !== undefined) continue;
    out ??= { ...c };
    delete out[key];
  }
  return out ?? c;
}

// ─── Undo: take back one change, by card ─────────────────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Undo one change to the board. An undo entry holds the cards as they were before the change and as the change left
 * them; the difference is what the change did, and only that is taken back, card by card (by id):
 * a card it removed comes back, a card it added goes, a field it changed gets its old value. Everything else on the
 * board now stays — cards made since, pictures that finished painting since. A card that was still loading when it
 * was removed comes back only while its job is still running: undo never puts up a loader nothing will finish, and
 * never a secure form's placeholder.
 */
function mergeUndo(entry: WorkspaceUndoEntry, now: { mode: string; owner: string | null; state: unknown | null }): UndoMerge | "nothing" | null {
  if (entry.owner !== BOARD_OWNER || entry.mode !== "app") return null; // a page or a game: the whole screen comes back
  const nowIsBoard = now.mode === "app" && now.owner === BOARD_OWNER;
  if (!nowIsBoard && now.mode !== "empty") return null; // something else has the window: the old board comes back whole (then settled)
  if (!entry.after) return "nothing"; // nothing was written after the entry was made
  const before = cardsIn(entry.state);
  const after = entry.after.mode === "app" && entry.after.owner === BOARD_OWNER ? cardsIn(entry.after.state) : [];
  const current: (BoardCard | null)[] = nowIsBoard ? cardsIn(now.state) : [];
  const beforeIds = new Set(before.map((c) => c.id));
  const afterBy = new Map(after.map((c) => [c.id, c]));
  const at = new Map<string, number>();
  current.forEach((c, i) => at.set(c!.id, i));

  const gone: BoardCard[] = [];
  const changed: BoardCard[] = [];
  const back: BoardCard[] = [];
  // Cards the change added go.
  for (const a of after) {
    if (beforeIds.has(a.id)) continue;
    const i = at.get(a.id);
    if (i === undefined || !current[i]) continue;
    gone.push(current[i]!);
    current[i] = null;
  }
  // Fields the change set get their old values (on cards that are still there).
  for (const b of before) {
    const a = afterBy.get(b.id);
    if (!a || a === b) continue;
    const i = at.get(b.id);
    const live = i === undefined ? null : current[i];
    if (!live) continue;
    let next: Record<string, unknown> | null = null;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "id" || key === "n" || key === "kind") continue;
      const was = (b as unknown as Record<string, unknown>)[key];
      if (sameValue((a as unknown as Record<string, unknown>)[key], was) || sameValue((live as unknown as Record<string, unknown>)[key], was)) continue;
      next ??= { ...live };
      if (was === undefined) delete next[key];
      else next[key] = was;
    }
    if (next) {
      current[i!] = next as unknown as BoardCard;
      changed.push(current[i!]!);
    }
  }
  // Cards the change removed come back.
  for (const b of before) {
    if (afterBy.has(b.id) || at.has(b.id)) continue;
    if (b.kind === "form") continue;
    if (b.status === "pending" && !cardHeld(b.id)) continue;
    back.push(b);
  }
  if (!gone.length && !changed.length && !back.length) return "nothing";

  const cards = current.filter((c): c is BoardCard => c !== null);
  // (Numbers are not handed out twice while an undo could bring a card back; should two ever meet, the newer card moves on.)
  let top = Math.max(0, ...cards.map((c) => c.n), ...back.map((c) => c.n));
  for (const b of back) {
    const clash = cards.findIndex((c) => c.n === b.n);
    if (clash >= 0) cards[clash] = { ...cards[clash]!, n: ++top };
  }
  for (const c of [...back, ...changed]) autoPlaced.delete(c.id);
  const rawNow = nowIsBoard ? (now.state as BoardState | null) : null;
  const rawBefore = entry.state as BoardState | null;
  const seq = Math.max(top, Number(rawNow?.seq) || 0, Number(rawBefore?.seq) || 0);
  const parts: string[] = [];
  if (back.length) parts.push(back.length === 1 ? `brought back card ${back[0]!.n}` : `brought back ${back.length} cards`);
  if (gone.length) parts.push(gone.length === 1 ? `took card ${gone[0]!.n} off again` : `took ${gone.length} cards off again`);
  if (changed.length) parts.push(changed.length === 1 ? `put card ${changed[0]!.n} back the way it was` : `put ${changed.length} cards back the way they were`);
  const said = parts.join(", and ");
  return { template: BOARD_TEMPLATE, state: { cards: [...cards, ...back], seq } satisfies BoardState, title: "Workspace", say: `${said.charAt(0).toUpperCase()}${said.slice(1)}.` };
}

// ─── Secure-form placeholders ───────────────────────────────────────────────

export const isFormCard = (c: Pick<BoardCard, "kind">): boolean => c.kind === "form";

/** The placeholder card that stands for an open secure form (the form itself is drawn by the window's own page). */
export function addFormCard(title: string): BoardCard {
  return addCard({ kind: "form", status: "ready", title, text: "Waiting for you in the secure form.", tags: ["secure", "form"] });
}

/** Take a form's placeholder off the board when its form ends. No undo entry: there is nothing to bring back. */
export function removeFormCard(n: number): boolean {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n && c.kind === "form");
  if (i < 0) return false;
  state.cards.splice(i, 1);
  write(state);
  return true;
}

/**
 * Drop every form placeholder that stands for no open form — left by the last run (forms don't survive a restart), or
 * brought back by an undo. `live`: the card numbers of the forms open now. Returns the form cards that stayed.
 */
export function sweepFormCards(live: ReadonlySet<number> = new Set()): Set<number> {
  const kept = new Set<number>();
  if (!isBoard()) return kept;
  const state = read();
  const cards = state.cards.filter((c) => {
    if (c.kind !== "form") return true;
    if (live.has(c.n)) kept.add(c.n);
    return live.has(c.n);
  });
  if (cards.length !== state.cards.length) write({ ...state, cards });
  return kept;
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
  workspace.pushUndo(`move_card:${n}`, 1);
  autoPlaced.delete(state.cards[i]!.id);
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
    // A named place keeps the whole card on the board, whatever its size.
    const p = PLACES[place];
    card.x = round1(Math.max(0, Math.min(p.x, 100 - card.w - 1)));
    card.y = round1(Math.max(0, Math.min(p.y, 100 - cardHeight(card) - 1)));
  }
  state.cards[i] = card;
  if (!write(state)) return null;
  return card;
}

/**
 * Place card `n` relative to another card (under / above / beside / left-of / right-of), by the heights the cards
 * really have (given, or measured in a window): the two never overlap while there is room for both, and the moved
 * card stays wholly on the board — where there is no room on the side asked for, it goes as far as the edge allows.
 */
export function moveCardRelative(n: number, relative: RelativePlace, anchorN: number): BoardCard | null {
  const state = read();
  const i = state.cards.findIndex((c) => c.n === n);
  const anchor = state.cards.find((c) => c.n === anchorN);
  if (i < 0 || !anchor) return null;
  workspace.pushUndo(`move_card:${n}`, 1);
  autoPlaced.delete(state.cards[i]!.id);
  const card = { ...state.cards[i]! };
  const ah = cardHeight(anchor);
  const ch = cardHeight(card);
  const gap = 2;
  const maxX = Math.max(0, 100 - card.w);
  const maxY = Math.max(0, 100 - ch);
  if (relative === "under") {
    card.x = Math.min(anchor.x, maxX);
    card.y = Math.min(maxY, anchor.y + ah + gap);
  } else if (relative === "above") {
    card.x = Math.min(anchor.x, maxX);
    card.y = Math.max(0, anchor.y - ch - gap);
  } else if (relative === "left-of") {
    card.x = Math.max(0, anchor.x - card.w - gap);
    card.y = Math.min(anchor.y, maxY);
  } else {
    // beside / right-of
    card.x = Math.min(maxX, anchor.x + anchor.w + gap);
    card.y = Math.min(anchor.y, maxY);
  }
  card.x = round1(card.x);
  card.y = round1(card.y);
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
  if (place !== "forward" && place !== "backward" && !cards.some((c) => c.n === anchorN && c.n !== n)) return null;
  workspace.pushUndo(`layer_card:${n}`, 1);
  if (place === "forward" || place === "backward") {
    const j = place === "forward" ? at + 1 : at - 1;
    if (j >= 0 && j < order.length) [order[at], order[j]] = [order[j]!, order[at]!];
  } else {
    const anchor = cards.find((c) => c.n === anchorN);
    if (!anchor || anchor.n === n) return null;
    autoPlaced.delete(card.id);
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
  autoPlaced.delete(state.cards[i]!.id);
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

/** When a card was last made or acted on (0: never). */
export function lastTouchedAt(): number {
  return touched.at;
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
  workspace.pushUndo(`remove_cards:${gone.map((c) => c.n).join(",")}`, 1);
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
  workspace.sealUndo();
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
  workspace.pushUndo(`swap_cards:${a},${b}`, 1);
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
  workspace.pushUndo(`nudge_card:${n}`, 1);
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
  workspace.pushUndo(`line_up:${side}`, 1);
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
  if (!src || src.status !== "ready" || src.kind === "form") return null;
  const reason = `duplicate_card:${n}`;
  workspace.pushUndo(reason);
  let copy: BoardCard;
  try {
    copy = addCard({
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
      data: src.data,
      retry: src.retry,
    });
  } catch (err) {
    workspace.dropUndo(reason); // nothing was added: nothing to undo
    throw err;
  }
  const done = src.mw != null || src.mh != null || src.state !== undefined ? (updateCard(copy.n, { mw: src.mw, mh: src.mh, state: src.state }) ?? copy) : copy;
  workspace.sealUndo();
  return done;
}

/** A new title (and its words as tags, so the card can be named by it). */
export function renameCard(n: number, title: string): BoardCard | null {
  const card = read().cards.find((c) => c.n === n);
  if (!card || card.kind === "form") return null;
  workspace.pushUndo(`rename_card:${n}`, 1);
  const tags = [...new Set([...tagsFromText(title), ...(card.tags ?? [])])].slice(0, 12);
  return updateCard(n, { title: title.slice(0, 80), tags });
}

/** A note's new words (its title follows when it was the automatic "Note: …" one). */
export function setNoteText(n: number, text: string): BoardCard | null {
  const card = read().cards.find((c) => c.n === n);
  if (!card || card.kind !== "text") return null;
  workspace.pushUndo(`edit_note:${n}`, 1);
  const words = text.replace(/\s+/g, " ").trim();
  const caption = words.length > 60 ? `${words.slice(0, 59).replace(/\s+\S*$/, "")}…` : words || "empty";
  const tags = tagsFromText(text);
  return updateCard(n, { text: text.slice(0, 2000), tags: tags.length ? tags : card.tags, ...(/^Note:\s/.test(card.title) ? { title: `Note: ${caption}` } : {}) });
}

// ─── Arranging ──────────────────────────────────────────────────────────────

export type ArrangeLayout = "grid" | "stack" | "row" | "column" | "shuffle" | "scatter" | "by_kind" | "newest_first";

const KIND_RANK: Record<CardKind, number> = { image: 0, video: 1, widget: 2, chart: 3, table: 4, document: 5, code: 6, file: 7, text: 8, audio: 9, form: 10 };

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
  workspace.pushUndo("arrange_cards", 1);
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
  // (Never a secure form's placeholder: there is nothing in it to edit.)
  const cards = listCards().filter((c) => c.kind !== "form" && (c.status === "ready" || c.html || c.status === "pending"));
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
  if (card.kind === "form") return null;
  if (card.html) return card.html;
  // The title goes into an HTML comment: a title that came from a web page could otherwise end the comment and start markup of its own.
  const title = commentSafe(card.title);
  if ((card.kind === "image" || card.kind === "video") && card.url) {
    const mw = Math.max(10, Math.min(100, Math.round(card.mw ?? 100)));
    const mh = card.mh != null ? Math.max(10, Math.min(100, Math.round(card.mh))) : null;
    const size = `width:${mw}%;${mh != null ? `height:${mh}%;` : "height:auto;"}max-width:100%;display:block;margin:0 auto;object-fit:contain;`;
    const alt = (card.text || card.title || "").replace(/"/g, "&quot;");
    if (card.kind === "video") {
      return `<!-- title: ${title} -->\n<video src="${card.url}" controls playsinline style="${size}"></video>`;
    }
    return `<!-- title: ${title} -->\n<img src="${card.url}" alt="${alt}" style="${size}">`;
  }
  if (card.kind === "text" && card.text) {
    return `<!-- title: ${title} -->\n<p style="margin:0;padding:8px;color:#e8e8ef;font:14px/1.55 system-ui,sans-serif;white-space:pre-wrap">${escapeText(card.text)}</p>`;
  }
  return null;
}

/** Text that is safe inside an HTML comment: one line, no "--" (which could end the comment) and no angle brackets. */
export function commentSafe(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/-{2,}/g, "—")
    .replace(/[<>]/g, "")
    .trim();
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

// ─── The board and the bus ──────────────────────────────────────────────────

// Card objects are never changed in place, so an undo entry keeps the board's state as it is (no copy)…
workspace.freezeOwner(BOARD_OWNER);
// …and an undo takes back one change, card by card, instead of putting a whole old board up.
workspace.setUndoMerger(mergeUndo);
// A whole screen that did come back (the board, after a game or a page had the window) may hold loaders nothing will finish.
workspace.onUndo(() => {
  settleBoard();
});
// A page nobody owns (a skill's output, the test route) is one more card, not the whole window — unless a game has it.
workspace.setHtmlAdopter((html, title) => {
  if (boardBlocked()) return false;
  const name = (title || pageTitle(html) || "Page").trim();
  addCard({ kind: "widget", title: name.charAt(0).toUpperCase() + name.slice(1), text: name, status: "ready", html, w: 40, h: 60 });
  return true;
});
// The board as the last run left it: whatever was still loading then has no job behind it now.
settleBoard();
