/**
 * How the board draws the kinds it renders itself (table, chart, document, code, file): a script the board template
 * loads before its own, defining window.__trinityKinds = { table(card, view, esc), tableClick(card, view, target), … }.
 * Each renderer returns the card body's HTML from the card's data and escapes every value with the board's esc():
 * the data was normalized by the engine (kinds/data.ts), and is still treated as text, never as markup. A "view" is
 * what this window did to the card (a table sorted by a column); a click handler returns the next view, or null.
 *
 * Charts are inline SVG drawn here — no library, no network: eight hues in a fixed order (validated for colour-blind
 * separation and 3:1 contrast on the card's dark surface), text in ink colours, thin marks, rounded data ends anchored
 * to the baseline, a 2px surface gap between fills, a hover title on every mark, and a legend for two or more series.
 * A document is Markdown drawn as a safe subset — headings, lists, tables, code, quotes, rules, and links that only
 * ever go through the window's link notice; no raw HTML. A file's Open and Download ask the window, which builds the
 * file's address itself (web/src/workspace/view.ts): the board's frame can't download.
 *
 * Plain ES5 with no backticks, no "${" and no closing script tag: it sits in a script tag inside a string.
 */

export const KIND_CSS = String.raw`
.kt,.kc,.kd,.kch,.kf{color:#c3c2b7;font-size:12.5px}
.kt{display:flex;flex-direction:column;flex:1;min-height:0}
.kt-scroll{overflow:auto;max-height:44vh;min-height:0;flex:1;border-radius:10px}
.card.has-h .kt-scroll,.card.has-h .kc-scroll,.card.has-h .kd{max-height:none}
.kt table{border-collapse:separate;border-spacing:0;width:100%;font-variant-numeric:tabular-nums}
.kt th{position:sticky;top:0;z-index:1;background:#20202f;color:#f0efec;font-weight:600;text-align:left;padding:0;border-bottom:1px solid #3a3a4c;white-space:nowrap}
.kt th button{all:unset;box-sizing:border-box;display:flex;gap:4px;align-items:center;width:100%;padding:7px 10px;cursor:pointer}
.kt th.num button{justify-content:flex-end}
.kt th button:focus-visible{outline:2px solid #8b5cf6;outline-offset:-2px}
.kt-arrow{font-size:9px;color:#a78bfa;min-width:9px}
.kt td{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top;max-width:24em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kt td.num,.kt th.num{text-align:right}
.kt tbody tr:hover td{background:rgba(255,255,255,.035);color:#f0efec}
.kt-foot{margin:6px 2px 0;color:#8f8e9e;font-size:11px}
.kch{margin:0;display:flex;flex-direction:column;gap:6px;min-height:0;flex:1}
.kch svg{display:block;width:100%;height:auto;max-height:46vh;min-height:0;flex:1}
.card.has-h .kch svg{max-height:none;height:100%}
.kch svg.kch-round{max-width:260px;margin:0 auto}
.kch text{font:12px system-ui,sans-serif;fill:#8f8e9e;font-variant-numeric:tabular-nums}
.kch text.kch-axis{fill:#c3c2b7}
.kch text.kch-total{font-size:26px;font-weight:600;fill:#f0efec}
.kch-hit:hover{fill:rgba(255,255,255,.05)}
.kch-units,.kch-note{margin:0;color:#8f8e9e;font-size:11px}
.kch-legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px;color:#c3c2b7;font-size:12px}
.kch-legend li{display:flex;align-items:center;gap:6px;min-width:0}
.kch-legend i{width:10px;height:10px;border-radius:3px;flex:none}
.kch-legend b{color:#f0efec;font-weight:600}
.kch-empty{margin:0;padding:24px 8px;text-align:center;color:#8f8e9e}
.kd{overflow:auto;max-height:52vh;padding:4px 6px 8px;font-size:13.5px;line-height:1.6;color:#d8d7e2;flex:1;min-height:0}
.kd h1,.kd h2,.kd h3,.kd h4,.kd h5,.kd h6{color:#f0efec;line-height:1.3;margin:14px 0 6px}
.kd h1{font-size:20px}.kd h2{font-size:17px}.kd h3{font-size:15px}.kd h4,.kd h5,.kd h6{font-size:13.5px}
.kd>:first-child{margin-top:2px}
.kd p{margin:0 0 10px}
.kd ul,.kd ol{margin:0 0 10px;padding-left:22px}
.kd li{margin:2px 0}
.kd li>ul,.kd li>ol{margin:2px 0 0}
.kd a{color:#a78bfa}
.kd code{font:12.5px ui-monospace,Consolas,monospace;background:rgba(255,255,255,.07);padding:1px 4px;border-radius:4px}
.kd pre{background:#10101c;border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:10px;overflow:auto;margin:0 0 10px}
.kd pre code{background:none;padding:0}
.kd blockquote{margin:0 0 10px;padding:2px 12px;border-left:3px solid #4b4b66;color:#b5b4c4}
.kd hr{border:0;border-top:1px solid #34344a;margin:14px 0}
.kd table{border-collapse:collapse;margin:0 0 10px;font-size:12.5px}
.kd th,.kd td{border:1px solid #33334a;padding:4px 8px;text-align:left}
.kd th{color:#f0efec;background:#1d1d2c}
.kd-check{color:#a78bfa}
.kc{display:flex;flex-direction:column;flex:1;min-height:0}
.kc-head{display:flex;justify-content:space-between;gap:8px;padding:2px 2px 6px;color:#8f8e9e;font-size:11px}
.kc-lang{color:#c3c2b7;font-weight:600;letter-spacing:.05em;text-transform:uppercase;font-size:10.5px}
.kc-scroll{overflow:auto;max-height:46vh;background:#10101c;border:1px solid rgba(255,255,255,.06);border-radius:10px;flex:1;min-height:0}
.kc-pre{margin:0;padding:8px 12px 8px 0;font:12.5px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace;color:#e4e3ee;counter-reset:ln;tab-size:2;width:max-content;min-width:100%;box-sizing:border-box}
.kc-l{display:block;min-height:1.5em;white-space:pre}
.kc-l::before{counter-increment:ln;content:counter(ln);display:inline-block;width:3.2em;padding-right:10px;margin-right:12px;text-align:right;color:#5d5d72;border-right:1px solid rgba(255,255,255,.06);user-select:none;-webkit-user-select:none}
.kf{display:flex;flex-direction:column;gap:10px;padding:6px 4px}
.kf-top{display:flex;gap:12px;align-items:center;min-width:0}
.kf-icon{flex:none;width:44px;height:54px;border-radius:8px 14px 8px 8px;display:grid;place-items:center;font-size:10.5px;font-weight:700;letter-spacing:.04em;color:#0c0c14;background:#9085e9}
.kf-icon.pdf{background:#e66767}.kf-icon.sheet{background:#199e70}.kf-icon.doc{background:#3987e5}.kf-icon.text{background:#c3c2b7}.kf-icon.image{background:#d55181}
.kf-meta{display:flex;flex-direction:column;gap:2px;min-width:0}
.kf-name{color:#f0efec;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kf-type{color:#8f8e9e;font-size:12px}
.kf-desc{margin:0;color:#c3c2b7;font-size:12.5px;line-height:1.45}
.kf-preview{margin:0;max-height:9.5em;overflow:hidden;padding:8px 10px;border-radius:8px;background:#10101c;border:1px solid rgba(255,255,255,.06);font:11.5px/1.45 ui-monospace,Consolas,monospace;color:#c3c2b7;white-space:pre-wrap;word-break:break-word}
.kf-actions{display:flex;gap:8px;flex-wrap:wrap}
.kf-btn{font:600 12.5px system-ui,sans-serif;padding:7px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#e8e8ef;cursor:pointer}
.kf-btn.kf-main{background:#a78bfa;border-color:#a78bfa;color:#0c0c14}
.kf-btn:hover{filter:brightness(1.12)}
.kf-btn:focus-visible{outline:2px solid #8b5cf6;outline-offset:2px}
`;

export const KIND_RENDERERS = String.raw`(function () {
  if (window.__trinityKinds) return;
  var TICK = String.fromCharCode(96);
  // The categorical order (fixed, never cycled: a chart holds at most eight series), stepped for the dark card.
  var PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  var GRID = "#2b2b3c", AXIS = "#4a4a5c", SURFACE = "#18182a";
  var EMPTY = '<p class="kch-empty">Nothing to draw.</p>';
  function arr(v) { return Object.prototype.toString.call(v) === "[object Array]" ? v : []; }
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v !== "string") return null;
    var s = v.replace(/[$€£¥,%\s]/g, "");
    if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function r1(n) { return Math.round(n * 10) / 10; }
  function full(n) {
    try { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }); } catch (e) { return String(n); }
  }
  function compact(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return r1(n / 1e9) + "B";
    if (a >= 1e6) return r1(n / 1e6) + "M";
    if (a >= 1e4) return r1(n / 1e3) + "k";
    return full(Math.round(n * 100) / 100);
  }
  function clip(s, max) { s = String(s == null ? "" : s); return s.length > max ? s.slice(0, max - 1) + "…" : s; }
  function sizeText(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + (b === 1 ? " byte" : " bytes");
    if (b < 1048576) return Math.round(b / 1024) + " KB";
    return r1(b / 1048576) + " MB";
  }

  // ── table ──
  function table(c, view, esc) {
    var d = c.data || {}, cols = arr(d.columns), rows = arr(d.rows), numc = arr(d.numeric), i, j;
    var order = [];
    for (i = 0; i < rows.length; i++) order.push(i);
    var col = view && typeof view.col === "number" && view.col < cols.length ? view.col : -1, dir = view && view.dir === "desc" ? -1 : 1;
    if (col >= 0) {
      var isNum = !!numc[col];
      order.sort(function (a, b) {
        var x = arr(rows[a])[col], y = arr(rows[b])[col];
        var ex = x === null || x === undefined || x === "", ey = y === null || y === undefined || y === "";
        if (ex || ey) return ex === ey ? a - b : ex ? 1 : -1; // empty cells last, either way
        var r;
        if (isNum) { var nx = num(x), ny = num(y); r = (nx === null ? 0 : nx) - (ny === null ? 0 : ny); }
        else r = String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
        return r ? r * dir : a - b;
      });
    }
    var h = '<div class="kt"><div class="kt-scroll" tabindex="0"><table><thead><tr>';
    for (i = 0; i < cols.length; i++) {
      var sorted = i === col;
      h += '<th scope="col" class="' + (numc[i] ? "num" : "") + (sorted ? " sorted" : "") + '" aria-sort="' + (sorted ? (dir > 0 ? "ascending" : "descending") : "none") + '">' +
        '<button type="button" data-col="' + i + '" title="Sort by ' + esc(cols[i]) + '">' + esc(cols[i]) + '<span class="kt-arrow">' + (sorted ? (dir > 0 ? "▲" : "▼") : "") + "</span></button></th>";
    }
    h += "</tr></thead><tbody>";
    for (j = 0; j < order.length; j++) {
      var row = arr(rows[order[j]]);
      h += "<tr>";
      for (i = 0; i < cols.length; i++) {
        var v = row[i];
        h += "<td" + (numc[i] ? ' class="num"' : "") + ">" + (v === null || v === undefined ? "" : esc(typeof v === "number" ? full(v) : v)) + "</td>";
      }
      h += "</tr>";
    }
    var total = Number(d.total) || rows.length;
    var foot = rows.length + (rows.length === 1 ? " row" : " rows") + " · " + cols.length + (cols.length === 1 ? " column" : " columns") +
      (total > rows.length ? " · the first " + rows.length + " of " + total : "") + (col >= 0 ? " · sorted by " + cols[col] : " · click a heading to sort");
    return h + '</tbody></table></div><p class="kt-foot">' + esc(foot) + "</p></div>";
  }
  function tableClick(c, view, t) {
    var b = t && t.closest ? t.closest("[data-col]") : null;
    if (!b) return null;
    var col = Number(b.getAttribute("data-col"));
    if (!(col >= 0)) return null;
    return { col: col, dir: view && view.col === col && view.dir !== "desc" ? "desc" : "asc" };
  }

  // ── chart ──
  function nice(lo, hi, count) {
    if (!(hi > lo)) { var pad = Math.abs(hi) || 1; lo -= pad; hi += pad; }
    var raw = (hi - lo) / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / mag;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ticks = [];
    for (var k = 0; k <= 40; k++) {
      var v = Number((a + k * step).toFixed(10));
      if (v > b + step * 1e-6) break;
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { lo: a, hi: b, ticks: ticks };
  }
  function barPath(x, y0, w, y) {
    var h = Math.abs(y0 - y), r = Math.min(4, w / 2, h);
    x = r1(x); w = r1(w); y0 = r1(y0); y = r1(y);
    if (h < 0.5) return "";
    var e = y < y0 ? y + r : y - r;
    return "M" + x + " " + y0 + "V" + r1(e) + "Q" + x + " " + y + " " + r1(x + r) + " " + y + "H" + r1(x + w - r) + "Q" + r1(x + w) + " " + y + " " + r1(x + w) + " " + r1(e) + "V" + y0 + "Z";
  }
  function svgOpen(w, h, label, esc, cls) {
    return '<svg viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + esc(label) + '" preserveAspectRatio="xMidYMid meet"' + (cls ? ' class="' + cls + '"' : "") + ">";
  }
  function legend(names, esc, extra) {
    var h = '<ul class="kch-legend">';
    for (var i = 0; i < names.length; i++) h += '<li><i style="background:' + PALETTE[i % 8] + '"></i>' + esc(names[i]) + (extra ? " <b>" + esc(extra[i]) + "</b>" : "") + "</li>";
    return h + "</ul>";
  }
  function xy(d, type, labels, series, esc) {
    var W = 420, H = 260, n = labels.length, m = series.length, i, j, v, units = d.units ? " " + d.units : "";
    var lo = Infinity, hi = -Infinity;
    for (j = 0; j < m; j++) for (i = 0; i < n; i++) { v = num(arr(series[j].values)[i]); if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (lo === Infinity) return EMPTY;
    if (type !== "line") { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    var sc = nice(lo, hi, 5), widest = 1;
    for (i = 0; i < sc.ticks.length; i++) widest = Math.max(widest, compact(sc.ticks[i]).length);
    var L = Math.max(34, 12 + widest * 7), R = 14, T = 12, B = d.x ? 46 : 30, pw = W - L - R, ph = H - T - B;
    function Y(val) { return T + ph - ((val - sc.lo) / (sc.hi - sc.lo)) * ph; }
    var slot = pw / Math.max(1, n);
    function X(k) { return type === "bar" ? L + slot * k + slot / 2 : n <= 1 ? L + pw / 2 : L + (k * pw) / (n - 1); }
    var g = "";
    for (i = 0; i < sc.ticks.length; i++) {
      var ty = r1(Y(sc.ticks[i]));
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '" stroke="' + (sc.ticks[i] === 0 ? AXIS : GRID) + '" stroke-width="1"/>';
      g += '<text x="' + (L - 8) + '" y="' + r1(ty + 4) + '" text-anchor="end">' + esc(compact(sc.ticks[i])) + "</text>";
    }
    var every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 52))));
    for (i = 0; i < n; i += every) g += '<text x="' + r1(X(i)) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + esc(clip(labels[i], 9)) + "<title>" + esc(labels[i]) + "</title></text>";
    if (d.x) g += '<text class="kch-axis" x="' + r1(L + pw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d.x) + "</text>";
    function tip(k) {
      var t = String(labels[k]);
      for (var s = 0; s < m; s++) { var val = num(arr(series[s].values)[k]); t += "\n" + (series[s].name || "Value") + ": " + (val === null ? "–" : full(val) + units); }
      return t;
    }
    if (type === "bar") {
      var inner = slot * (m > 1 ? 0.8 : 0.66), bw = Math.max(1, (inner - (m - 1) * 2) / m), y0 = Y(Math.max(sc.lo, Math.min(0, sc.hi)));
      for (i = 0; i < n; i++) {
        var x0 = L + slot * i + (slot - inner) / 2;
        for (j = 0; j < m; j++) {
          v = num(arr(series[j].values)[i]);
          if (v === null) continue;
          var p = barPath(x0 + j * (bw + 2), y0, bw, Y(v));
          if (p) g += '<path d="' + p + '" fill="' + PALETTE[j % 8] + '"/>';
        }
        g += '<rect class="kch-hit" x="' + r1(L + slot * i) + '" y="' + T + '" width="' + r1(slot) + '" height="' + r1(ph) + '" fill="transparent"><title>' + esc(tip(i)) + "</title></rect>";
      }
    } else {
      var base = Y(Math.max(sc.lo, Math.min(0, sc.hi)));
      for (j = 0; j < m; j++) {
        var color = PALETTE[j % 8], line = "", runs = [], run = [], dots = "";
        for (i = 0; i < n; i++) {
          v = num(arr(series[j].values)[i]);
          if (v === null) { if (run.length) runs.push(run); run = []; continue; }
          run.push([r1(X(i)), r1(Y(v))]);
        }
        if (run.length) runs.push(run);
        for (var q = 0; q < runs.length; q++) {
          var pts = runs[q], seg = "";
          for (var z = 0; z < pts.length; z++) seg += (z ? "L" : "M") + pts[z][0] + " " + pts[z][1];
          line += seg;
          if (type === "area" && pts.length > 1) g += '<path d="' + seg + "L" + pts[pts.length - 1][0] + " " + r1(base) + "L" + pts[0][0] + " " + r1(base) + 'Z" fill="' + color + '" fill-opacity="' + (m > 1 ? 0.14 : 0.2) + '"/>';
          if (n <= 40 || pts.length === 1) for (z = 0; z < pts.length; z++) dots += '<circle cx="' + pts[z][0] + '" cy="' + pts[z][1] + '" r="4" fill="' + color + '" stroke="' + SURFACE + '" stroke-width="2"/>';
        }
        g += '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + dots;
      }
      var half = n <= 1 ? pw / 2 : pw / (n - 1) / 2;
      for (i = 0; i < n; i++) g += '<rect class="kch-hit" x="' + r1(X(i) - half) + '" y="' + T + '" width="' + r1(half * 2) + '" height="' + r1(ph) + '" fill="transparent"><title>' + esc(tip(i)) + "</title></rect>";
    }
    return svgOpen(W, H, (type === "bar" ? "Bar chart" : type === "area" ? "Area chart" : "Line chart") + " of " + n + " points", esc) + g + "</svg>";
  }
  function arc(cx, cy, R, r0, a0, a1) {
    var big = a1 - a0 > Math.PI ? 1 : 0;
    function pt(r, a) { return r1(cx + r * Math.cos(a)) + " " + r1(cy + r * Math.sin(a)); }
    if (r0 > 0) return "M" + pt(R, a0) + "A" + R + " " + R + " 0 " + big + " 1 " + pt(R, a1) + "L" + pt(r0, a1) + "A" + r0 + " " + r0 + " 0 " + big + " 0 " + pt(r0, a0) + "Z";
    return "M" + cx + " " + cy + "L" + pt(R, a0) + "A" + R + " " + R + " 0 " + big + " 1 " + pt(R, a1) + "Z";
  }
  function pie(d, labels, series, esc) {
    var S = 240, cx = S / 2, cy = S / 2, R = S / 2 - 6, donut = d.type === "donut", r0 = donut ? R * 0.6 : 0;
    var vals = arr((series[0] || {}).values), total = 0, i, v, units = d.units ? " " + d.units : "";
    for (i = 0; i < labels.length; i++) { v = num(vals[i]); if (v !== null && v > 0) total += v; }
    if (!(total > 0)) return { svg: EMPTY, legend: "" };
    var g = "", a = -Math.PI / 2, shares = [], names = [];
    for (i = 0; i < labels.length; i++) {
      v = num(vals[i]);
      if (v === null || v <= 0) continue;
      var share = v / total, b = a + share * Math.PI * 2, pct = share * 100;
      var pctText = (pct >= 10 || pct === 0 ? Math.round(pct) : r1(pct)) + "%";
      var title = "<title>" + esc(labels[i] + ": " + full(v) + units + " (" + pctText + ")") + "</title>";
      if (share >= 0.9999) {
        g += donut ? '<path d="M' + (cx - R) + " " + cy + "a" + R + " " + R + " 0 1 0 " + 2 * R + " 0a" + R + " " + R + " 0 1 0 " + -2 * R + " 0ZM" + (cx - r0) + " " + cy + "a" + r0 + " " + r0 + " 0 1 1 " + 2 * r0 + " 0a" + r0 + " " + r0 + " 0 1 1 " + -2 * r0 + ' 0Z" fill-rule="evenodd" fill="' + PALETTE[0] + '">' + title + "</path>"
          : '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + PALETTE[0] + '">' + title + "</circle>";
      } else g += '<path d="' + arc(cx, cy, R, r0, a, b) + '" fill="' + PALETTE[names.length % 8] + '" stroke="' + SURFACE + '" stroke-width="2" stroke-linejoin="round">' + title + "</path>";
      a = b;
      names.push(String(labels[i]));
      shares.push(pctText);
    }
    if (donut) g += '<text class="kch-total" x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle">' + esc(compact(total)) + '</text><text x="' + cx + '" y="' + (cy + 26) + '" text-anchor="middle">' + esc(d.units || "total") + "</text>";
    return { svg: svgOpen(S, S, (donut ? "Donut" : "Pie") + " chart of " + names.length + " slices", esc, "kch-round") + g + "</svg>", legend: legend(names, esc, shares) };
  }
  function scatter(d, series, esc) {
    var W = 420, H = 260, m = series.length, i, j, p, xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
    for (j = 0; j < m; j++) {
      var ps = arr(series[j].points);
      for (i = 0; i < ps.length; i++) {
        var x = num(arr(ps[i])[0]), y = num(arr(ps[i])[1]);
        if (x === null || y === null) continue;
        if (x < xl) xl = x; if (x > xh) xh = x; if (y < yl) yl = y; if (y > yh) yh = y;
      }
    }
    if (xl === Infinity) return EMPTY;
    var sx = nice(xl, xh, 6), sy = nice(yl, yh, 5), widest = 1;
    for (i = 0; i < sy.ticks.length; i++) widest = Math.max(widest, compact(sy.ticks[i]).length);
    var L = Math.max(34, 12 + widest * 7) + (d.y ? 16 : 0), R = 14, T = 12, B = d.x ? 46 : 30, pw = W - L - R, ph = H - T - B;
    function X(v) { return L + ((v - sx.lo) / (sx.hi - sx.lo)) * pw; }
    function Y(v) { return T + ph - ((v - sy.lo) / (sy.hi - sy.lo)) * ph; }
    var g = "";
    for (i = 0; i < sy.ticks.length; i++) {
      var ty = r1(Y(sy.ticks[i]));
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '" stroke="' + GRID + '"/><text x="' + (L - 8) + '" y="' + r1(ty + 4) + '" text-anchor="end">' + esc(compact(sy.ticks[i])) + "</text>";
    }
    for (i = 0; i < sx.ticks.length; i++) {
      var tx = r1(X(sx.ticks[i]));
      g += '<line x1="' + tx + '" x2="' + tx + '" y1="' + T + '" y2="' + (T + ph) + '" stroke="' + GRID + '"/><text x="' + tx + '" y="' + (H - B + 18) + '" text-anchor="middle">' + esc(compact(sx.ticks[i])) + "</text>";
    }
    g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + r1(T + ph) + '" y2="' + r1(T + ph) + '" stroke="' + AXIS + '"/>';
    if (d.x) g += '<text class="kch-axis" x="' + r1(L + pw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d.x) + "</text>";
    if (d.y) g += '<text class="kch-axis" transform="rotate(-90)" x="' + r1(-(T + ph / 2)) + '" y="14" text-anchor="middle">' + esc(d.y) + "</text>";
    for (j = 0; j < m; j++) {
      var pts = arr(series[j].points), color = PALETTE[j % 8];
      for (i = 0; i < pts.length; i++) {
        p = arr(pts[i]);
        var px = num(p[0]), py = num(p[1]);
        if (px === null || py === null) continue;
        var cxp = r1(X(px)), cyp = r1(Y(py));
        g += '<circle cx="' + cxp + '" cy="' + cyp + '" r="4" fill="' + color + '" stroke="' + SURFACE + '" stroke-width="2"/>' +
          '<circle class="kch-hit" cx="' + cxp + '" cy="' + cyp + '" r="9" fill="transparent"><title>' + esc((series[j].name ? series[j].name + ": " : "") + "(" + full(px) + ", " + full(py) + ")") + "</title></circle>";
      }
    }
    return svgOpen(W, H, "Scatter plot", esc) + g + "</svg>";
  }
  function chart(c, view, esc) {
    var d = c.data || {}, type = String(d.type || "bar"), labels = arr(d.labels), series = arr(d.series), body, key = "";
    if (type === "pie" || type === "donut") {
      var p = pie(d, labels, series, esc);
      body = p.svg;
      key = p.legend;
    } else {
      body = type === "scatter" ? scatter(d, series, esc) : xy(d, type, labels, series, esc);
      if (series.length > 1) {
        var names = [];
        for (var i = 0; i < series.length; i++) names.push(series[i].name || "Series " + (i + 1));
        key = legend(names, esc);
      }
    }
    var note = d.dropped ? '<p class="kch-note">' + esc("Showing " + series.length + " of " + (series.length + Number(d.dropped)) + " series.") + "</p>" : "";
    return '<figure class="kch">' + (d.units && type !== "pie" && type !== "donut" ? '<figcaption class="kch-units">' + esc(d.units) + "</figcaption>" : "") + body + key + note + "</figure>";
  }

  // ── document: Markdown, drawn as a safe subset ──
  var CODE_SPAN = new RegExp(TICK + "+([^" + TICK + "]+?)" + TICK + "+", "g");
  var FENCE = new RegExp("^\\s*(" + TICK + "{3,}|~{3,})\\s*([\\w+#.-]*)");
  function inline(s, esc) {
    var kept = [];
    function keep(html) { kept.push(html); return "\u0001" + (kept.length - 1) + "\u0002"; }
    var t = String(s).replace(CODE_SPAN, function (m, code) { return keep("<code>" + esc(code) + "</code>"); });
    t = esc(t);
    // Links go only to the web, and only through the window's link notice (the board hands every click on one to it).
    t = t.replace(/\[([^\]\u0001]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, text, url) { return keep('<a href="' + url + '" rel="noreferrer">' + text + "</a>"); });
    t = t.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, function (m, url) { return keep('<a href="' + url + '" rel="noreferrer">' + url + "</a>"); });
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<\u0001]+[^\s<\u0001.,;:!?)\]'])/g, function (m, lead, url) { return lead + keep('<a href="' + url + '" rel="noreferrer">' + url + "</a>"); });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1<strong>$2</strong>");
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return t.replace(/\u0001(\d+)\u0002/g, function (m, k) { return kept[Number(k)] || ""; });
  }
  function cellsOf(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|");
  }
  function md(src, esc, depth) {
    var lines = String(src || "").split("\n"), out = [], para = [], stack = [], i = 0, m;
    function flush() { if (para.length) { out.push("<p>" + inline(para.join(" "), esc) + "</p>"); para = []; } }
    function closeTo(indent) { while (stack.length && stack[stack.length - 1].indent > indent) out.push("</li></" + stack.pop().type + ">"); }
    function indentOf(s) { var n = 0; for (var k = 0; k < s.length; k++) { var ch = s.charAt(k); if (ch === " ") n++; else if (ch === "\t") n += 4; else break; } return n; }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { flush(); closeTo(-1); i++; continue; }
      if ((m = FENCE.exec(line))) {
        flush(); closeTo(-1);
        var fence = m[1], body = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) body.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(body.join("\n")) + "</code></pre>");
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); closeTo(-1); out.push("<hr>"); i++; continue; }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        flush(); closeTo(-1);
        out.push("<h" + m[1].length + ">" + inline(m[2], esc) + "</h" + m[1].length + ">");
        i++;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        flush(); closeTo(-1);
        var quote = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
        out.push("<blockquote>" + ((depth || 0) < 4 ? md(quote.join("\n"), esc, (depth || 0) + 1) : "<p>" + inline(quote.join(" "), esc) + "</p>") + "</blockquote>");
        continue;
      }
      if (line.indexOf("|") >= 0 && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0) {
        flush(); closeTo(-1);
        var head = cellsOf(line), aligns = cellsOf(lines[i + 1]), k, t = "<table><thead><tr>";
        for (k = 0; k < aligns.length; k++) { var a = aligns[k].trim(); aligns[k] = /^:-+:$/.test(a) ? "center" : /-:$/.test(a) ? "right" : ""; }
        for (k = 0; k < head.length; k++) t += "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(head[k].trim(), esc) + "</th>";
        t += "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && lines[i].indexOf("|") >= 0 && !/^\s*$/.test(lines[i])) {
          var cells = cellsOf(lines[i++]);
          t += "<tr>";
          for (k = 0; k < head.length; k++) t += "<td" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline((cells[k] || "").trim(), esc) + "</td>";
          t += "</tr>";
        }
        out.push(t + "</tbody></table>");
        continue;
      }
      if ((m = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line))) {
        flush();
        var indent = indentOf(m[1]), type = m[3] ? "ol" : "ul", text = m[4], check = /^\[([ xX])\]\s+(.*)$/.exec(text);
        var content = check ? '<span class="kd-check">' + (check[1] === " " ? "☐" : "☑") + "</span> " + inline(check[2], esc) : inline(text, esc);
        closeTo(indent);
        var top = stack[stack.length - 1];
        if (top && top.indent === indent) {
          if (top.type === type) { out.push("</li><li>" + content); i++; continue; }
          out.push("</li></" + stack.pop().type + ">");
        }
        var start = m[3] ? Number(m[3]) : 1;
        out.push("<" + type + (type === "ol" && start !== 1 ? ' start="' + start + '"' : "") + "><li>" + content);
        stack.push({ indent: indent, type: type });
        i++;
        continue;
      }
      if (stack.length && /^\s+\S/.test(line)) { out.push(" " + inline(line.trim(), esc)); i++; continue; }
      closeTo(-1);
      para.push(line.trim());
      i++;
    }
    flush();
    closeTo(-1);
    return out.join("");
  }
  function documentKind(c, view, esc) {
    var d = c.data || {};
    return '<article class="kd" tabindex="0">' + md(d.markdown, esc, 0) + "</article>";
  }

  // ── code ──
  function code(c, view, esc) {
    var d = c.data || {}, lines = String(d.code || "").split("\n"), total = Number(d.total) || lines.length;
    var h = '<div class="kc"><div class="kc-head"><span class="kc-lang">' + esc(d.language || "Text") + "</span><span>" +
      esc(total > lines.length ? "the first " + lines.length + " of " + total + " lines" : lines.length + (lines.length === 1 ? " line" : " lines")) +
      '</span></div><div class="kc-scroll" tabindex="0"><pre class="kc-pre"><code>';
    for (var i = 0; i < lines.length; i++) h += '<span class="kc-l">' + esc(lines[i]) + "</span>";
    return h + "</code></pre></div></div>";
  }

  // ── file ──
  function fileKind(c, view, esc) {
    var d = c.data || {}, ext = String(d.ext || "").toLowerCase();
    var family = ext === "pdf" ? "pdf" : /^(xlsx|xls|csv)$/.test(ext) ? "sheet" : /^(docx|doc)$/.test(ext) ? "doc" : /^(txt|md|json|html?)$/.test(ext) ? "text" : /^(png|jpe?g|gif|webp)$/.test(ext) ? "image" : "";
    var h = '<div class="kf"><div class="kf-top"><span class="kf-icon ' + family + '" aria-hidden="true">' + esc((ext || "file").toUpperCase().slice(0, 5)) + "</span>" +
      '<div class="kf-meta"><b class="kf-name" title="' + esc(d.name) + '">' + esc(d.name) + '</b><span class="kf-type">' + esc((d.type || "File") + " · " + sizeText(d.size)) + "</span></div></div>";
    if (d.description) h += '<p class="kf-desc">' + esc(d.description) + "</p>";
    if (d.preview) h += '<pre class="kf-preview">' + esc(d.preview) + "</pre>";
    h += '<div class="kf-actions">' + (d.opens ? '<button type="button" class="kf-btn kf-main" data-file="open">Open</button>' : "") +
      '<button type="button" class="kf-btn' + (d.opens ? "" : " kf-main") + '" data-file="download">Download</button></div></div>';
    return h;
  }
  function fileClick(c, view, t) {
    var b = t && t.closest ? t.closest("[data-file]") : null;
    if (!b) return null;
    var action = b.getAttribute("data-file");
    if (action !== "open" && action !== "download") return null;
    // The window opens it: it looks the card up in what the engine sent and builds the file's address itself.
    try { if (window.trinity && window.trinity.send) window.trinity.send({ __trinity: "file", card: String(c.id), action: action }); } catch (e) { /* ignore */ }
    return null;
  }

  window.__trinityKinds = { table: table, tableClick: tableClick, chart: chart, document: documentKind, code: code, file: fileKind, fileClick: fileClick };
})();`;
