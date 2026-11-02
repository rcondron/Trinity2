import type { WorkspaceTemplate } from "./bus.js";

/**
 * The workspace cards for a picture, audio clip or video the caller asked for
 * (make_image, make_audio, make_video). All are app templates (contract v1,
 * window.render(state, prev)) rather than html, because a sandboxed frame can't
 * load the engine's http://localhost files itself: the host fetches an
 * `/api/images/…`, `/api/audio/…` or `/api/videos/…` url found in the state and
 * posts the bytes in, and the frame's runtime swaps the url for a blob: one
 * (an object with `url` and `status` shows as pending until the bytes arrive).
 * So each state is `{ status: "pending" | "ready" | "error", url, … }`.
 *
 * Plain ES5 in the scripts, no backticks and no "${": the sources are template-literal strings.
 */

export interface PictureState {
  status: "pending" | "ready" | "error";
  url: string | null;
  /** What the picture shows (the caption). */
  prompt: string;
  error?: string;
}

export interface AudioState {
  status: "pending" | "ready" | "error";
  url: string | null;
  /** The words being spoken (shown under the player). */
  text: string;
  error?: string;
}

export interface VideoState {
  status: "pending" | "ready" | "error";
  url: string | null;
  /** What the clip shows (the caption). */
  prompt: string;
  /** Model that was asked to render it (shown while pending). */
  model?: string;
  error?: string;
}

const CARD_CSS = String.raw`
:where(body){display:grid;place-items:center;min-height:100%;padding:18px}
.card{display:flex;flex-direction:column;align-items:center;gap:14px;max-width:min(96vw,900px);animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
.cap{margin:0;color:#a5a5c6;font-size:13.5px;line-height:1.5;text-align:center;max-width:640px}
.cap.err{color:#fca5a5}
.shim{border-radius:14px;background:linear-gradient(110deg,rgba(255,255,255,.03) 30%,rgba(255,255,255,.08) 50%,rgba(255,255,255,.03) 70%);background-size:220% 100%;animation:shim 1.6s linear infinite}
.shim.still{animation:none;background:rgba(255,255,255,.03);border:1px dashed rgba(252,165,165,.35)}
@keyframes shim{from{background-position:120% 0}to{background-position:-100% 0}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;

const ESC = String.raw`function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}`;

export const PICTURE_TEMPLATE: WorkspaceTemplate = {
  id: "picture@1",
  kind: "default",
  name: "Picture",
  source:
    `<style>${CARD_CSS}` +
    String.raw`
.pic{position:relative}
.pic img{display:block;max-width:min(96vw,900px);max-height:min(78vh,900px);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);opacity:0;transition:opacity .6s}
.pic img.is-loaded{opacity:1}
.pic .shim{width:min(70vw,560px);aspect-ratio:1}
</style>
<div id="root"></div>
<script>
(function () {
  var root = document.getElementById("root");
  ` +
    ESC +
    String.raw`
  window.render = function (state) {
    var s = state || {};
    var h = '<figure class="card pic">';
    if (s.status === "ready" && s.url) h += '<img src="' + esc(s.url) + '" alt="' + esc(s.prompt) + '" decoding="async" draggable="false">';
    else h += '<div class="shim' + (s.status === "error" ? " still" : "") + '"></div>';
    var cap = s.status === "error" ? "Couldn't make the picture: " + (s.error || "unknown error") : s.status === "ready" ? s.prompt : "Painting: " + s.prompt + "…";
    h += '<figcaption class="cap' + (s.status === "error" ? " err" : "") + '">' + esc(cap) + "</figcaption></figure>";
    root.innerHTML = h;
    var img = root.querySelector("img");
    if (img) {
      if (img.complete) img.classList.add("is-loaded");
      else img.addEventListener("load", function () { img.classList.add("is-loaded"); });
    }
  };
})();
</script>`,
};

export const AUDIO_TEMPLATE: WorkspaceTemplate = {
  id: "audio@1",
  kind: "default",
  name: "Audio clip",
  source:
    `<style>${CARD_CSS}` +
    String.raw`
.player{display:flex;align-items:center;gap:16px;width:min(92vw,560px);padding:16px 18px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}
.btn{flex:none;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#0c0c14;background:#a78bfa;box-shadow:0 0 24px -4px rgba(167,139,250,.8);display:grid;place-items:center}
.btn:disabled{cursor:default;background:#34344c;box-shadow:none;color:#8a8aa6}
.btn svg{width:22px;height:22px;fill:currentColor}
.bar{flex:1;display:flex;flex-direction:column;gap:8px;min-width:0}
.track{height:6px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.fill{height:100%;width:0;background:linear-gradient(90deg,#67e8f9,#a78bfa);transition:width .2s linear}
.time{font-size:12px;color:#a5a5c6;font-variant-numeric:tabular-nums;display:flex;justify-content:space-between}
.player .shim{height:6px;width:100%}
.words{margin:0;color:#c9c9dc;font-size:14px;line-height:1.55;max-width:560px;text-align:center;max-height:7.8em;overflow:hidden}
</style>
<div id="root"></div>
<script>
(function () {
  var root = document.getElementById("root");
  var audio = null;
  var src = null;
  var PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>';
  ` +
    ESC +
    String.raw`
  function fmt(t) { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ":" + (t % 60 < 10 ? "0" : "") + (t % 60); }
  function refresh() {
    var btn = root.querySelector(".btn"), fill = root.querySelector(".fill"), time = root.querySelector(".time");
    if (!btn || !audio) return;
    btn.innerHTML = audio.paused ? PLAY : PAUSE;
    btn.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    var d = isFinite(audio.duration) ? audio.duration : 0;
    if (fill) fill.style.width = d ? (100 * audio.currentTime / d) + "%" : "0";
    if (time) time.innerHTML = "<span>" + fmt(audio.currentTime) + "</span><span>" + fmt(d) + "</span>";
  }
  window.render = function (state) {
    var s = state || {};
    var ready = s.status === "ready" && !!s.url;
    var h = '<div class="card"><div class="player">';
    h += '<button class="btn" type="button"' + (ready ? "" : " disabled") + ' aria-label="Play">' + PLAY + "</button>";
    h += '<div class="bar">' + (ready ? '<div class="track"><div class="fill"></div></div><div class="time"><span>0:00</span><span>0:00</span></div>' : '<div class="shim' + (s.status === "error" ? " still" : "") + '"></div>') + "</div>";
    h += "</div>";
    var words = s.status === "error" ? "Couldn't make the audio: " + (s.error || "unknown error") : s.text;
    h += '<p class="' + (s.status === "error" ? "cap err" : "words") + '">' + esc(words) + "</p></div>";
    root.innerHTML = h;
    if (!ready) { if (audio) { audio.pause(); audio = null; src = null; } return; }
    if (src !== s.url) {
      if (audio) audio.pause();
      src = s.url;
      audio = new Audio(src);
      audio.addEventListener("timeupdate", refresh);
      audio.addEventListener("loadedmetadata", refresh);
      audio.addEventListener("play", refresh);
      audio.addEventListener("pause", refresh);
      audio.addEventListener("ended", function () { audio.currentTime = 0; refresh(); });
      // Plays on its own where the browser allows it; else the button is there.
      var p = audio.play(); if (p && p.catch) p.catch(function () { refresh(); });
    }
    root.querySelector(".btn").addEventListener("click", function () {
      if (!audio) return;
      if (audio.paused) { var q = audio.play(); if (q && q.catch) q.catch(function () {}); } else audio.pause();
    });
    root.querySelector(".track").addEventListener("click", function (e) {
      if (!audio || !isFinite(audio.duration)) return;
      var r = e.currentTarget.getBoundingClientRect();
      audio.currentTime = audio.duration * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    });
    refresh();
  };
})();
</script>`,
};

export const VIDEO_TEMPLATE: WorkspaceTemplate = {
  id: "video@1",
  kind: "default",
  name: "Video clip",
  source:
    `<style>${CARD_CSS}` +
    String.raw`
.vid{position:relative;width:min(96vw,900px)}
.vid video{display:block;width:100%;max-height:min(78vh,900px);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);background:#000;opacity:0;transition:opacity .5s}
.vid video.is-loaded{opacity:1}
.vid .shim{width:100%;aspect-ratio:16/9}
.model{margin:0;color:#7a7a9a;font-size:12px;text-align:center}
</style>
<div id="root"></div>
<script>
(function () {
  var root = document.getElementById("root");
  ` +
    ESC +
    String.raw`
  window.render = function (state) {
    var s = state || {};
    var h = '<figure class="card vid">';
    if (s.status === "ready" && s.url) h += '<video src="' + esc(s.url) + '" controls playsinline autoplay muted loop></video>';
    else h += '<div class="shim' + (s.status === "error" ? " still" : "") + '"></div>';
    var cap = s.status === "error" ? "Couldn't make the video: " + (s.error || "unknown error") : s.status === "ready" ? s.prompt : "Filming: " + s.prompt + "…";
    h += '<figcaption class="cap' + (s.status === "error" ? " err" : "") + '">' + esc(cap) + "</figcaption>";
    if (s.status !== "ready" && s.model) h += '<p class="model">' + esc(s.model) + "</p>";
    h += "</figure>";
    root.innerHTML = h;
    var v = root.querySelector("video");
    if (v) {
      if (v.readyState >= 2) v.classList.add("is-loaded");
      else v.addEventListener("loadeddata", function () { v.classList.add("is-loaded"); });
    }
  };
})();
</script>`,
};
