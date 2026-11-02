import { CONTENT_TYPES, type Block, type ContentSpec, type ContentType, type Mood } from "../services/content-spec.js";

/*
 * Renders a ContentSpec (services/content-spec.ts) as the HTML fragment of a widget card: the engine's
 * own design system for information cards. Six moods (palette + type pairing) × an accent colour the
 * card designer picks, a hero (the generated picture, a shimmer while it's painted, or a typographic
 * masthead), meta chips, and one styled layout per block kind. Every string is escaped; links are
 * http(s) only and open through the board (the widget frame can't navigate anywhere itself).
 */

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const href = (url: string | undefined): string | null => (url && /^https?:\/\/[^\s"'<>]+$/i.test(url) ? esc(url) : null);
/** A picture source: an engine image (the host inlines it) or an http(s) URL. */
const src = (url: string | undefined): string | null => (url && (/^\/api\/images\/[A-Za-z0-9_.-]+$/.test(url) || /^https?:\/\/[^\s"'<>]+$/i.test(url)) ? esc(url) : null);
const fmtCount = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
/** "★ 4.7 (5.3k)" or nothing. */
const rating = (r?: number, n?: number): string => (r === undefined ? "" : `<span class="star">★</span> ${esc(r.toFixed(1))}${n ? ` (${esc(fmtCount(n))})` : ""}`);

const domain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
};

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  surface: string;
  line: string;
  display: string;
  body: string;
  radius: string;
  heroDark: boolean;
}

const SERIF = `Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", "Times New Roman", serif`;
const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

const PALETTES: Record<Mood, Palette> = {
  warm: { bg: "#fbf5ec", fg: "#2b2118", muted: "#7b6a5a", surface: "#fffaf2", line: "rgba(70,45,20,.13)", display: SERIF, body: SANS, radius: "12px", heroDark: false },
  editorial: { bg: "#ffffff", fg: "#15161c", muted: "#5f6370", surface: "#f5f5f7", line: "rgba(0,0,0,.1)", display: SERIF, body: SANS, radius: "6px", heroDark: false },
  cool: { bg: "#121622", fg: "#e8ecf7", muted: "#9aa3b8", surface: "rgba(255,255,255,.055)", line: "rgba(255,255,255,.11)", display: SANS, body: SANS, radius: "12px", heroDark: true },
  playful: { bg: "#fdf8ff", fg: "#241a35", muted: "#6f6584", surface: "#ffffff", line: "rgba(90,50,130,.14)", display: SANS, body: SANS, radius: "18px", heroDark: false },
  elegant: { bg: "#15131c", fg: "#f1ecf7", muted: "#a89fb8", surface: "rgba(255,255,255,.055)", line: "rgba(255,255,255,.11)", display: SERIF, body: SANS, radius: "8px", heroDark: true },
  calm: { bg: "#f2f8f8", fg: "#16303a", muted: "#5b7a82", surface: "#ffffff", line: "rgba(20,60,70,.13)", display: SANS, body: SANS, radius: "14px", heroDark: false },
};

/** #rrggbb → "r,g,b" for rgba() tints. */
function rgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "167,139,250";
  return `${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)}`;
}

/** Readable text on the accent: white on a dark accent, near-black on a light one. */
function onAccent(hex: string): string {
  const [r, g, b] = rgb(hex).split(",").map(Number) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 165 ? "#17141c" : "#ffffff";
}

function css(p: Palette, accent: string): string {
  return `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:${p.bg}}
body{color:${p.fg};font:13.5px/1.5 ${p.body};-webkit-font-smoothing:antialiased;overflow-x:hidden}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(${rgb(accent)},.45);border-radius:8px}
.cc{--accent:${accent};--on-accent:${onAccent(accent)};--tint:rgba(${rgb(accent)},.12);--tint2:rgba(${rgb(accent)},.24);--surface:${p.surface};--line:${p.line};--muted:${p.muted};--radius:${p.radius};min-height:100vh;display:flex;flex-direction:column}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.hero{position:relative;aspect-ratio:16/9;max-height:270px;min-height:150px;overflow:hidden;background:linear-gradient(135deg,var(--tint2),rgba(${rgb(accent)},.55)),${p.bg}}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;animation:fade .7s ease both}
.hero .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 28%,rgba(0,0,0,.42) 62%,rgba(0,0,0,.78) 100%)}
.hero .shim{position:absolute;inset:0;background:linear-gradient(110deg,rgba(255,255,255,0) 30%,rgba(255,255,255,.14) 50%,rgba(255,255,255,0) 70%),linear-gradient(135deg,var(--tint2),rgba(${rgb(accent)},.5));background-size:220% 100%,100% 100%;animation:shim 1.7s linear infinite}
.hero .text{position:absolute;left:0;right:0;bottom:0;padding:14px 18px 15px;color:#fff}
.hero h1{margin:4px 0 0;font:600 24px/1.12 ${p.display};letter-spacing:-.01em;text-shadow:0 1px 2px rgba(0,0,0,.35)}
.hero .sub{margin:5px 0 0;font-size:13px;line-height:1.4;color:rgba(255,255,255,.86);text-shadow:0 1px 2px rgba(0,0,0,.35)}
.kicker{display:inline-block;padding:3px 9px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:700 10.5px/1.2 ${p.body};letter-spacing:.09em;text-transform:uppercase}
.mast{padding:20px 18px 12px;border-bottom:1px solid var(--line)}
.mast h1{margin:8px 0 0;font:600 26px/1.1 ${p.display};letter-spacing:-.012em}
.mast .sub{margin:6px 0 0;color:var(--muted);font-size:13.5px;line-height:1.4}
.mast .bar{width:44px;height:3px;border-radius:3px;background:var(--accent);margin-top:12px}
.body{padding:14px 18px 18px;display:flex;flex-direction:column;gap:16px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 0}
.chip{display:inline-flex;gap:5px;align-items:baseline;padding:5px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:11.5px;line-height:1.2}
.chip b{font-weight:650}.chip span{color:var(--muted)}
.block>h2{margin:0 0 8px;font:700 10.5px/1.2 ${p.body};letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
.block p{margin:0 0 8px;line-height:1.55}.block p:last-child{margin-bottom:0}
ul.list,ol.list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
ul.list li{position:relative;padding-left:18px;line-height:1.45}
ul.list.bullet li::before{content:"";position:absolute;left:2px;top:.6em;width:7px;height:7px;border-radius:50%;background:var(--accent)}
ul.list.check li{padding-left:26px}
ul.list.check li::before{content:"";position:absolute;left:0;top:.18em;width:15px;height:15px;border-radius:4px;border:1.5px solid var(--accent);background:var(--tint)}
ul.list.check li::after{content:"";position:absolute;left:5px;top:.36em;width:4px;height:7px;border:solid var(--accent);border-width:0 2px 2px 0;transform:rotate(45deg);opacity:.9}
ol.list{counter-reset:n}
ol.list li{position:relative;padding-left:30px;line-height:1.45;counter-increment:n}
ol.list li::before{content:counter(n);position:absolute;left:0;top:.05em;width:21px;height:21px;border-radius:50%;background:var(--accent);color:var(--on-accent);font:700 11px/21px ${p.body};text-align:center}
ol.steps{margin:0;padding:0;list-style:none;counter-reset:s;display:flex;flex-direction:column;gap:10px}
ol.steps li{position:relative;padding-left:36px;line-height:1.5;counter-increment:s;min-height:26px}
ol.steps li::before{content:counter(s);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--on-accent);font:700 12.5px/26px ${p.display};text-align:center}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.fact{padding:9px 11px;border-radius:calc(var(--radius) - 2px);background:var(--surface);border:1px solid var(--line)}
.fact .l{display:block;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.fact .v{font-weight:600;line-height:1.35}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.stat{padding:11px 12px;border-radius:calc(var(--radius) - 2px);background:var(--tint);border:1px solid var(--tint2)}
.stat .v{font:700 22px/1.1 ${p.display};color:var(--accent);letter-spacing:-.01em}
.stat .l{font-size:11px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
.tl{margin:0;padding:0 0 0 4px;list-style:none;position:relative}
.tl::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;background:var(--tint2);border-radius:2px}
.tl li{position:relative;padding:0 0 12px 26px}.tl li:last-child{padding-bottom:0}
.tl li::before{content:"";position:absolute;left:5px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--tint)}
.tl .w{display:block;font-weight:700;font-size:12px;color:var(--accent);letter-spacing:.02em}
.tl .t{line-height:1.45}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:calc(var(--radius) - 2px)}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:8px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{background:var(--surface);font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
tbody tr:last-child td{border-bottom:0}td:first-child{font-weight:600}
.pc{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:380px){.pc{grid-template-columns:1fr}}
.pc div{padding:10px 12px;border-radius:calc(var(--radius) - 2px);background:var(--surface);border:1px solid var(--line)}
.pc h3{margin:0 0 6px;font:700 11px/1.2 ${p.body};letter-spacing:.08em;text-transform:uppercase}
.pc .pro h3{color:#16a34a}.pc .con h3{color:#dc2626}
.pc ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}
.pc li{position:relative;padding-left:16px;font-size:12.5px;line-height:1.4}
.pc .pro li::before{content:"+";position:absolute;left:0;color:#16a34a;font-weight:800}
.pc .con li::before{content:"–";position:absolute;left:0;color:#dc2626;font-weight:800}
.hl{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.hl li{padding:10px 0;border-top:1px solid var(--line)}.hl li:first-child{padding-top:0;border-top:0}
.hl .h{font:600 14.5px/1.3 ${p.display};letter-spacing:-.005em}
.hl .h a{color:inherit}
.hl .s{margin:4px 0 0;font-size:12.5px;line-height:1.45;color:var(--muted)}
.hl .m{margin:5px 0 0;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--accent)}
.hl .m span{color:var(--muted)}
.quote{position:relative;padding:6px 14px 6px 40px;font:italic 500 16px/1.45 ${p.display}}
.quote::before{content:"\\201C";position:absolute;left:4px;top:-10px;font:700 54px/1 ${p.display};color:var(--accent);opacity:.65}
.quote .by{display:block;margin-top:6px;font:600 11.5px/1.2 ${p.body};letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-style:normal}
.note{padding:10px 12px 10px 14px;border-radius:calc(var(--radius) - 2px);border-left:3px solid var(--accent);background:var(--tint);line-height:1.5}
.note.warning{border-left-color:#f59e0b;background:rgba(245,158,11,.13)}
.note.info{border-left-color:var(--muted);background:var(--surface)}
.note b{font-weight:700;margin-right:4px}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{padding:4px 9px;border-radius:999px;background:var(--tint);color:var(--accent);font-size:11.5px;font-weight:600}
.sch{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.sch li{display:grid;grid-template-columns:minmax(58px,auto) 1fr;gap:4px 12px;padding:9px 0;border-top:1px solid var(--line)}
.sch li:first-child{border-top:0;padding-top:0}
.sch .w{font-weight:700;font-size:12px;color:var(--accent);padding-top:1px}
.sch .t{font-weight:600;line-height:1.35}.sch .d{grid-column:2;font-size:12.5px;color:var(--muted);line-height:1.45}
.badge{position:absolute;top:8px;left:8px;padding:3px 7px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:700 9.5px/1.2 ${p.body};letter-spacing:.06em;text-transform:uppercase;z-index:1}
.star{color:#f59e0b}
.pg{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.pd{position:relative;display:flex;flex-direction:column;gap:5px;padding:10px;border-radius:calc(var(--radius) - 2px);background:var(--surface);border:1px solid var(--line);color:inherit;text-decoration:none}
a.pd:hover{text-decoration:none;border-color:var(--tint2)}
.pd .im{aspect-ratio:1;border-radius:8px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}
.pd .im img{width:100%;height:100%;object-fit:contain;display:block;padding:6px}
.pd .im.none{background:var(--tint)}
.pd .t{font-size:12.5px;line-height:1.35;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pd .p{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}.pd .p b{font:700 16px/1.1 ${p.display};color:var(--accent)}.pd .p s{font-size:11.5px;color:var(--muted)}
.pd .s{font-size:11.5px;color:var(--muted);line-height:1.4}.pd .s b{font-weight:600;color:inherit}
.pd .d{font-size:11px;color:var(--muted)}
.fl{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.fo{padding:10px 12px;border-radius:calc(var(--radius) - 2px);background:var(--surface);border:1px solid var(--line)}
.fo .top{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.fo .top img{width:22px;height:22px;object-fit:contain;border-radius:4px;background:#fff;padding:1px}
.fo .al{font-size:12px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fo .bd{padding:2px 7px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:700 9.5px/1.2 ${p.body};letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.fo .pr{font:700 18px/1 ${p.display};color:var(--accent);white-space:nowrap}.fo .pr a{color:inherit}
.fo .row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}
.fo .tm{font:600 15px/1.1 ${p.display};white-space:nowrap}.fo .tm small{display:block;font:600 10.5px/1.3 ${p.body};letter-spacing:.06em;color:var(--muted);margin-top:3px}
.fo .mid{text-align:center;font-size:11px;color:var(--muted);line-height:1.35;min-width:0}
.fo .mid b{display:block;color:${p.fg};font-weight:600}
.fo .ln{height:2px;background:var(--tint2);border-radius:2px;margin:5px 8px;position:relative}
.fo .ln::before,.fo .ln::after{content:"";position:absolute;top:-3px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.fo .ln::before{left:-2px}.fo .ln::after{right:-2px}
.fo .legs{margin:8px 0 0;padding:7px 0 0;border-top:1px dashed var(--line);list-style:none;font-size:11px;color:var(--muted);display:flex;flex-direction:column;gap:3px}
.fo .nt{margin-top:6px;font-size:11px;color:var(--muted)}
.ht{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.ho{position:relative;display:grid;grid-template-columns:88px minmax(0,1fr) auto;gap:10px;padding:9px;border-radius:calc(var(--radius) - 2px);background:var(--surface);border:1px solid var(--line);align-items:start}
.ho .im{width:88px;height:72px;border-radius:8px;overflow:hidden;background:var(--tint)}
.ho .im img{width:100%;height:100%;object-fit:cover;display:block}
.ho .nm{font:600 13.5px/1.3 ${p.display}}.ho .nm a{color:inherit}
.ho .mt{margin-top:3px;font-size:11.5px;color:var(--muted);line-height:1.4}
.ho .am{margin-top:5px;display:flex;flex-wrap:wrap;gap:4px}.ho .am span{padding:2px 7px;border-radius:999px;background:var(--tint);color:var(--accent);font-size:10.5px;font-weight:600}
.ho .of{margin-top:4px;font-size:10.5px;color:var(--muted)}
.ho .pr{text-align:right;white-space:nowrap}.ho .pr b{display:block;font:700 17px/1.1 ${p.display};color:var(--accent)}.ho .pr span{font-size:10.5px;color:var(--muted)}.ho .pr small{display:block;margin-top:3px;font-size:10.5px;color:var(--muted)}
@media (max-width:380px){.ho{grid-template-columns:72px minmax(0,1fr)}.ho .im{width:72px;height:60px}.ho .pr{grid-column:2;text-align:left}}
.src{margin-top:auto;padding:12px 18px 14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.6}
.src b{letter-spacing:.08em;text-transform:uppercase;font-size:10px;margin-right:6px}
.src a{margin-right:10px;white-space:nowrap}
.skel{height:11px;border-radius:6px;background:linear-gradient(110deg,var(--surface) 30%,var(--tint) 50%,var(--surface) 70%);background-size:220% 100%;animation:shim 1.7s linear infinite}
.wait{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.wait i{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite}
@keyframes shim{from{background-position:120% 0}to{background-position:-100% 0}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;
}

export interface CardMedia {
  /** The hero picture (an engine image URL) once it's ready. */
  imageUrl?: string | null;
  /** A picture is being painted: shimmer behind the title. */
  imagePending?: boolean;
}

function hero(spec: ContentSpec, media: CardMedia, label: string): string {
  const kicker = `<span class="kicker">${esc(label)}</span>`;
  const sub = spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : "";
  const url = media.imageUrl ? href(media.imageUrl) ?? (media.imageUrl.startsWith("/api/") ? esc(media.imageUrl) : null) : null;
  if (url || media.imagePending) {
    const alt = esc(spec.image?.alt ?? "");
    return (
      `<figure class="hero" style="margin:0">` +
      (url ? `<img src="${url}" alt="${alt}" decoding="async">` : `<div class="shim"></div>`) +
      `<div class="shade"></div><div class="text">${kicker}<h1>${esc(spec.title)}</h1>${sub}</div></figure>`
    );
  }
  return `<header class="mast">${kicker}<h1>${esc(spec.title)}</h1>${sub}<div class="bar"></div></header>`;
}

function block(b: Block): string {
  const h = "title" in b && b.title ? `<h2>${esc(b.title)}</h2>` : "";
  switch (b.kind) {
    case "text":
      return `<section class="block">${h}${b.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</section>`;
    case "list": {
      const tag = b.style === "number" ? "ol" : "ul";
      return `<section class="block">${h}<${tag} class="list ${esc(b.style ?? "bullet")}">${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}></section>`;
    }
    case "steps":
      return `<section class="block">${h}<ol class="steps">${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol></section>`;
    case "facts":
      return `<section class="block">${h}<div class="facts">${b.items
        .map((f) => `<div class="fact"><span class="l">${esc(f.label)}</span><span class="v">${esc(f.value)}</span></div>`)
        .join("")}</div></section>`;
    case "stats":
      return `<section class="block"><div class="stats">${b.items
        .map((s) => `<div class="stat"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`)
        .join("")}</div></section>`;
    case "timeline":
      return `<section class="block">${h}<ol class="tl">${b.items
        .map((t) => `<li><span class="w">${esc(t.when)}</span><span class="t">${esc(t.what)}</span></li>`)
        .join("")}</ol></section>`;
    case "table":
      return (
        `<section class="block">${h}<div class="tw"><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
        b.rows.map((r) => `<tr>${b.columns.map((_c, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div></section>`
      );
    case "pros_cons":
      return (
        `<section class="block">${h}<div class="pc">` +
        (b.pros.length ? `<div class="pro"><h3>Pros</h3><ul>${b.pros.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "") +
        (b.cons.length ? `<div class="con"><h3>Cons</h3><ul>${b.cons.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : "") +
        `</div></section>`
      );
    case "headlines":
      return `<section class="block">${h}<ul class="hl">${b.items
        .map((i) => {
          const link = href(i.url);
          const title = link ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title);
          const meta = [i.source ? esc(i.source) : "", i.when ? `<span>${esc(i.when)}</span>` : ""].filter(Boolean).join(" · ");
          return `<li><div class="h">${title}</div>${i.summary ? `<p class="s">${esc(i.summary)}</p>` : ""}${meta ? `<div class="m">${meta}</div>` : ""}</li>`;
        })
        .join("")}</ul></section>`;
    case "quote":
      return `<section class="block"><blockquote class="quote" style="margin:0">${esc(b.text)}${b.by ? `<span class="by">${esc(b.by)}</span>` : ""}</blockquote></section>`;
    case "note": {
      const lead = b.tone === "tip" ? "Tip" : b.tone === "warning" ? "Note" : "";
      return `<section class="block"><div class="note ${esc(b.tone ?? "info")}">${lead ? `<b>${lead}</b>` : ""}${esc(b.text)}</div></section>`;
    }
    case "tags":
      return `<section class="block"><div class="tags">${b.items.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div></section>`;
    case "schedule":
      return `<section class="block">${h}<ol class="sch">${b.items
        .map((s) => `<li><span class="w">${esc(s.when)}</span><span class="t">${esc(s.title)}</span>${s.detail ? `<span class="d">${esc(s.detail)}</span>` : ""}</li>`)
        .join("")}</ol></section>`;
    case "products":
      return `<section class="block">${h}<div class="pg">${b.items
        .map((i) => {
          const link = href(i.url);
          const img = src(i.image);
          const open = link ? `<a class="pd" href="${link}" target="_blank" rel="noopener noreferrer">` : `<div class="pd">`;
          const close = link ? "</a>" : "</div>";
          const store = `<b>${esc(i.store)}</b>${i.rating !== undefined ? ` · ${rating(i.rating, i.reviews)}` : ""}`;
          return (
            `${open}${i.badge ? `<span class="badge">${esc(i.badge)}</span>` : ""}` +
            (img ? `<div class="im"><img src="${img}" alt="" loading="lazy" decoding="async"></div>` : `<div class="im none"></div>`) +
            `<div class="t">${esc(i.title)}</div><div class="p"><b>${esc(i.price)}</b>${i.oldPrice ? `<s>${esc(i.oldPrice)}</s>` : ""}</div>` +
            `<div class="s">${store}</div>${i.delivery ? `<div class="d">${esc(i.delivery)}</div>` : ""}${close}`
          );
        })
        .join("")}</div></section>`;
    case "flights":
      return `<section class="block">${h}<ul class="fl">${b.items
        .map((i) => {
          const link = href(i.url);
          const logo = src(i.logo);
          const price = link ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${esc(i.price)}</a>` : esc(i.price);
          return (
            `<li class="fo"><div class="top">${logo ? `<img src="${logo}" alt="" decoding="async">` : ""}<span class="al">${esc(i.airline)}</span>` +
            `${i.badge ? `<span class="bd">${esc(i.badge)}</span>` : ""}<span class="pr">${price}</span></div>` +
            `<div class="row"><div class="tm">${esc(i.depart)}<small>${esc(i.from)}</small></div>` +
            `<div class="mid"><b>${esc(i.duration)}</b><div class="ln"></div>${esc(i.stops)}</div>` +
            `<div class="tm">${esc(i.arrive)}<small>${esc(i.to)}</small></div></div>` +
            (i.legs?.length ? `<ul class="legs">${i.legs.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "") +
            (i.note ? `<div class="nt">${esc(i.note)}</div>` : "") +
            `</li>`
          );
        })
        .join("")}</ul></section>`;
    case "hotels":
      return `<section class="block">${h}<ul class="ht">${b.items
        .map((i) => {
          const link = href(i.url);
          const img = src(i.image);
          const name = link ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${esc(i.name)}</a>` : esc(i.name);
          const meta = [rating(i.rating, i.reviews), i.stars ? `${esc(String(i.stars))}-star` : "", i.location ? esc(i.location) : ""].filter(Boolean).join(" · ");
          return (
            `<li class="ho">${i.badge ? `<span class="badge">${esc(i.badge)}</span>` : ""}<div class="im">${img ? `<img src="${img}" alt="" loading="lazy" decoding="async">` : ""}</div>` +
            `<div><div class="nm">${name}</div>${meta ? `<div class="mt">${meta}</div>` : ""}` +
            (i.amenities?.length ? `<div class="am">${i.amenities.map((a) => `<span>${esc(a)}</span>`).join("")}</div>` : "") +
            (i.offers ? `<div class="of">${esc(i.offers)}</div>` : "") +
            `</div><div class="pr">${i.price ? `<b>${esc(i.price)}</b><span>per night</span>` : ""}${i.total ? `<small>${esc(i.total)} total</small>` : ""}</div></li>`
          );
        })
        .join("")}</ul></section>`;
    default:
      return "";
  }
}

function sources(spec: ContentSpec): string {
  const links = spec.sources
    .map((s) => {
      const l = href(s.url);
      return l ? `<a href="${l}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}">${esc(domain(s.url))}</a>` : "";
    })
    .filter(Boolean);
  return links.length ? `<footer class="src"><b>Sources</b>${links.join("")}</footer>` : "";
}

/** The finished card. The first line names it for the board (pageTitle convention). */
export function renderContentCard(spec: ContentSpec, media: CardMedia = {}): string {
  const p = PALETTES[spec.theme.mood] ?? PALETTES.cool;
  const label = CONTENT_TYPES[spec.type]?.label ?? "Card";
  const meta = spec.meta.length
    ? `<div class="meta">${spec.meta.map((m) => `<span class="chip"><span>${esc(m.label)}</span><b>${esc(m.value)}</b></span>`).join("")}</div>`
    : "";
  return (
    `<!-- title: ${esc(spec.title)} -->\n<style>${css(p, spec.theme.accent)}</style>` +
    `<article class="cc" data-type="${esc(spec.type)}">${hero(spec, media, label)}<div class="body">${meta}${spec.blocks.map(block).join("")}</div>${sources(spec)}</article>`
  );
}

/** The card while the designer writes: masthead (or the picture, once painted) with the topic, shimmer lines, a pulsing status. */
export function renderPendingCard(type: ContentType, topic: string, status: string, media: CardMedia = {}): string {
  const info = CONTENT_TYPES[type];
  const p = PALETTES[info.mood];
  const title = topic.charAt(0).toUpperCase() + topic.slice(1);
  const url = media.imageUrl ? href(media.imageUrl) ?? (media.imageUrl.startsWith("/api/") ? esc(media.imageUrl) : null) : null;
  const top =
    url || media.imagePending
      ? `<figure class="hero" style="margin:0">${url ? `<img src="${url}" alt="" decoding="async">` : `<div class="shim"></div>`}<div class="shade"></div><div class="text"><span class="kicker">${esc(info.label)}</span><h1>${esc(title)}</h1></div></figure>`
      : `<header class="mast"><span class="kicker">${esc(info.label)}</span><h1>${esc(title)}</h1><div class="bar"></div></header>`;
  return (
    `<!-- title: ${esc(title)} -->\n<style>${css(p, info.accent)}</style>` +
    `<article class="cc" data-type="${esc(type)}">${top}<div class="body">` +
    `<div class="wait"><i></i>${esc(status)}</div>` +
    `<div class="skel" style="width:92%"></div><div class="skel" style="width:78%"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:60%"></div>` +
    `</div></article>`
  );
}
