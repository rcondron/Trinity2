import type { WorkspaceTemplate } from "./bus.js";

/**
 * Live preview while the coding skill (build_ui) streams a page in. The workspace shows the
 * fragment as it is being written — layout and styles materialize in place — under a small
 * progress pill; when the build finishes, the real fragment replaces this (scripts run,
 * canvases draw). A thinking model's reasoning shows as "Thinking…" until its code starts.
 *
 * The partial markup goes in via innerHTML, so its scripts never run; inline event
 * handlers are stripped too (a half-written page must not run half-written code), and so
 * are <meta> tags (innerHTML still applies a meta refresh, which would navigate the frame)
 * and <link> tags (a preconnect hint reaches out to its host as soon as it's inserted).
 */
export interface BuildPreviewState {
  /** The fragment written so far. */
  html: string;
  title: string;
  /** Characters of code written so far. */
  chars: number;
  /** Who is writing it ("GLM", "Kimi"). */
  coder?: string;
  /** A thinking model's reasoning so far, in characters (shown until the code starts). */
  thinking?: number;
  /** Shown in place of the usual label — e.g. while the other coder takes over. */
  note?: string;
}

export const BUILD_PREVIEW_TEMPLATE: WorkspaceTemplate = {
  id: "build-preview@1",
  kind: "default",
  name: "Build preview",
  source: String.raw`<script>
(function () {
  var pill = document.createElement("tw-build-pill");
  pill.setAttribute("style", "all:initial;position:fixed;z-index:2147483647;left:50%;bottom:18px;transform:translateX(-50%)");
  var root = pill.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ".p{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 12px;border-radius:999px;" +
    "background:rgba(17,17,30,.86);border:1px solid rgba(167,139,250,.35);box-shadow:0 8px 30px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.2);" +
    "font:500 12.5px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e9e9f2;white-space:nowrap;" +
    "-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}" +
    ".d{width:8px;height:8px;border-radius:50%;background:#a78bfa;box-shadow:0 0 0 0 rgba(167,139,250,.6);animation:k 1.4s ease-out infinite}" +
    ".p.th{border-color:rgba(34,211,238,.35)}.p.th .d{background:#22d3ee;animation-duration:2.2s}" +
    ".p.nt{border-color:rgba(251,191,36,.4)}.p.nt .d{background:#fbbf24}" +
    ".n{color:#a5a5c6;font-variant-numeric:tabular-nums}.n:empty{display:none}" +
    "@keyframes k{0%{box-shadow:0 0 0 0 rgba(167,139,250,.55)}80%{box-shadow:0 0 0 9px rgba(167,139,250,0)}100%{box-shadow:0 0 0 0 rgba(167,139,250,0)}}" +
    "@media (prefers-reduced-motion:reduce){.d{animation:none}}" +
    "</style><div class=p><span class=d></span><span class=t></span><span class=n></span></div>";
  var box = root.querySelector(".p");
  var label = root.querySelector(".t");
  var count = root.querySelector(".n");
  document.documentElement.appendChild(pill);

  var shim = document.createElement("style");
  shim.textContent =
    "canvas:not([data-tw-drawn]){background-image:linear-gradient(110deg,rgba(255,255,255,.015) 30%,rgba(255,255,255,.06) 50%,rgba(255,255,255,.015) 70%);" +
    "background-size:220% 100%;animation:tw-shim 1.6s linear infinite}" +
    "@keyframes tw-shim{from{background-position:120% 0}to{background-position:-100% 0}}";
  document.head.appendChild(shim);

  // Scripts, <meta> and <link> tags (a refresh would navigate the frame away, a preconnect hint would
  // reach its host; a page's own <link-card> stays) and inline handlers go — again until nothing
  // changes, so the pieces around one stripped tag can't join into another.
  function clean(html) {
    var s = String(html || "");
    for (var last = null; s !== last; ) {
      last = s;
      s = s
        .replace(/<script\b[\s\S]*?(<\/script>|$)/gi, "")
        .replace(/<(meta|link)(?=[\s/>]|$)[^>]*(>|$)/gi, "")
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    }
    return s;
  }

  function size(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  }

  // Before the first markup arrives: a quiet skeleton, so the screen visibly starts working.
  var SKELETON =
    "<div style='box-sizing:border-box;height:100%;padding:28px;display:grid;grid-template-rows:auto 1fr;gap:18px'>" +
    "<div style='height:26px;width:38%;border-radius:8px;background:rgba(255,255,255,.06)'></div>" +
    "<canvas style='width:100%;height:100%;border-radius:14px;border:1px solid rgba(255,255,255,.05)'></canvas></div>";

  window.render = function (state, prev) {
    var title = String(state.title || "your build");
    if (/^(A|An|The) /.test(title)) title = title.charAt(0).toLowerCase() + title.slice(1); // "Building a clock…"
    var markup = clean(state.html);
    var hasCode = /<[a-z]/i.test(markup);
    var chars = Number(state.chars) || 0;
    var thinking = hasCode ? 0 : Number(state.thinking) || 0;
    var note = state.note ? String(state.note) : "";
    box.className = note ? "p nt" : thinking ? "p th" : "p";
    label.textContent = note || (thinking ? "Thinking about " + title + "…" : "Building " + title + "…");
    var bits = [];
    if (state.coder) bits.push(String(state.coder));
    if (thinking) bits.push(size(thinking) + " reasoning");
    else if (chars) bits.push(size(chars) + " chars");
    count.textContent = bits.join(" · ");
    if (prev && prev.html === state.html) return;
    document.body.innerHTML = hasCode ? markup : SKELETON;
  };
})();
</script>`,
};
