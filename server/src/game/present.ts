import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActivePersona } from "../db/sqlite.js";
import { workspace, type WorkspaceTemplate } from "../workspace/bus.js";
import { getActiveGameId, getCustomTemplate, getGame, setCustomTemplate, subscribeGameChanges } from "./store.js";
import type { Game } from "./types.js";
import { toView } from "./view.js";

/**
 * Puts games on the shared workspace. The first present of a game sends its template
 * (`showApp`); every later change is a hot `setState` into the running template — no reload,
 * no flicker. A game re-presents itself after every saved mutation while it's on screen.
 *
 * Templates: a game's own generated screen (`game-custom:<gameId>:<hash>`) when one exists
 * and hasn't failed, else the hand-made default (`game-default:<hash>`, read from disk so it
 * can be iterated on live), else a small built-in fallback (`game-fallback`). Template ids
 * carry the source hash, so a screen that failed gets a fresh chance once its source changes.
 */

export const DEFAULT_TEMPLATE_ID = "game-default";
export const FALLBACK_TEMPLATE_ID = "game-fallback";
const CUSTOM_PREFIX = "game-custom:";

const DEFAULT_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates", "default-game.html");

const hash8 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);

export function customTemplateId(gameId: string, source: string): string {
  return `${CUSTOM_PREFIX}${gameId}:${hash8(source)}`;
}

const defaultTemplateId = (hash: string) => `${DEFAULT_TEMPLATE_ID}:${hash}`;

/** The default screen, any version (the bare id still appears in workspace snapshots saved before ids carried the hash). */
const isDefaultTemplateId = (id: string) => id === DEFAULT_TEMPLATE_ID || id.startsWith(`${DEFAULT_TEMPLATE_ID}:`);

export function isGameTemplateId(id: string | null | undefined): boolean {
  return !!id && (isDefaultTemplateId(id) || id === FALLBACK_TEMPLATE_ID || id.startsWith(CUSTOM_PREFIX));
}

// ─── Templates ───────────────────────────────────────────────────────────────

interface Chosen {
  template: WorkspaceTemplate;
  hash: string;
}

let cachedDefault: { mtimeMs: number; size: number; source: string; hash: string } | null = null;

/** The default game screen source (module TEMPLATE's file), re-read when it changes on disk. */
export function defaultTemplateSource(): { source: string; hash: string; builtin: boolean } {
  try {
    const st = fs.statSync(DEFAULT_TEMPLATE_PATH);
    if (!cachedDefault || cachedDefault.mtimeMs !== st.mtimeMs || cachedDefault.size !== st.size) {
      const source = fs.readFileSync(DEFAULT_TEMPLATE_PATH, "utf8");
      cachedDefault = { mtimeMs: st.mtimeMs, size: st.size, source, hash: hash8(source) };
    }
    if (cachedDefault.source.includes("window.render")) return { ...cachedDefault, builtin: false };
  } catch {
    /* not written yet — use the built-in fallback */
  }
  return { source: FALLBACK_TEMPLATE, hash: FALLBACK_HASH, builtin: true };
}

/**
 * Custom screens often paint scene art as `width:100%; aspect-ratio:16/9`, which grows with
 * the column and shoves the log / party off the board — especially in a narrow workspace.
 * Rewrite known-bad rules and inject a small CSS guard so the table stays viewport-bound.
 */
export function hardenCustomTemplate(src: string): string {
  let s = src;
  s = s.replace(/(\.(?:scene-art|art))\s*\{([^}]*)\}/gi, (_full, sel: string, body: string) => {
    const cleaned = String(body)
      .replace(/aspect-ratio\s*:\s*[^;]+;?/gi, "")
      .replace(/(?:max-)?height\s*:\s*[^;]+;?/gi, "");
    return `${sel}{width:100%;height:clamp(140px,26vh,240px);max-height:240px;object-fit:cover;display:block;${cleaned}}`;
  });
  if (!/data-trinity-layout-guard/.test(s)) {
    s =
      `<style data-trinity-layout-guard>` +
      `html,body{height:100%;overflow:hidden!important}` +
      `#app{max-height:100%!important;min-height:0!important;box-sizing:border-box}` +
      `#app img.scene-art,#app .scene-art,#app img.art,#app .art,#app #r-scene>img{` +
      `width:100%!important;height:clamp(140px,26vh,240px)!important;max-height:240px!important;` +
      `aspect-ratio:auto!important;object-fit:cover!important}` +
      `#app .cols,#app .board{min-height:0!important;overflow:hidden!important}` +
      `#app .col{min-height:0!important;overflow:hidden!important}` +
      `</style>\n` +
      s;
  }
  return s;
}

function chooseTemplate(game: Game): Chosen {
  const custom = getCustomTemplate(game.id);
  if (custom) {
    const source = hardenCustomTemplate(custom);
    const id = customTemplateId(game.id, source);
    if (!workspace.isTemplateBad(id)) {
      return { template: { id, kind: "custom", name: `${game.title} — custom screen`, source }, hash: hash8(source) };
    }
  }
  const d = defaultTemplateSource();
  const defaultId = defaultTemplateId(d.hash);
  if (!workspace.isTemplateBad(defaultId)) {
    return { template: { id: defaultId, kind: "default", name: "Game table", source: d.source }, hash: d.hash };
  }
  return {
    template: { id: FALLBACK_TEMPLATE_ID, kind: "default", name: "Game table (simple)", source: FALLBACK_TEMPLATE },
    hash: FALLBACK_HASH,
  };
}

// ─── Busy labels ─────────────────────────────────────────────────────────────

const busy = new Map<string, Map<string, string>>();

/** Background-work labels for a game, e.g. ["Painting Thorin's portrait…"]. */
export function busyFor(gameId: string): string[] {
  return [...(busy.get(gameId)?.values() ?? [])];
}

/**
 * Show (text) or clear (null) a background-work label. Mirrored to the workspace activity
 * overlay (`game:<id>:<key>`) and into the view's `busy` list (re-presented if on screen).
 */
export function setBusy(gameId: string, key: string, text: string | null): void {
  let m = busy.get(gameId);
  if (text) {
    if (!m) busy.set(gameId, (m = new Map()));
    if (m.get(key) === text) return;
    m.set(key, text);
  } else {
    if (!m?.delete(key)) return;
    if (m.size === 0) busy.delete(gameId);
  }
  workspace.activity(`game:${gameId}:${key}`, text);
  scheduleRefresh(gameId);
}

const refreshQueued = new Set<string>();
/** Coalesced re-present on the next macrotask (lets an in-flight mutation save first). */
function scheduleRefresh(gameId: string): void {
  if (refreshQueued.has(gameId)) return;
  refreshQueued.add(gameId);
  setImmediate(() => {
    refreshQueued.delete(gameId);
    if (!isGameOnScreen(gameId)) return;
    const g = getGame(gameId);
    if (g) present(g, false);
  });
}

// ─── Presenting ──────────────────────────────────────────────────────────────

let presented: { gameId: string; templateId: string; hash: string } | null = null;
/** Newest log entry each game last put on screen: a new story event brings a game back, background art doesn't. */
const shownLog = new Map<string, string>();
const newestLog = (game: Game) => game.log[game.log.length - 1]?.id ?? "";

/** The id of the game the workspace is showing right now (survives engine restarts via the state). */
export function onScreenGameId(): string | null {
  if (workspace.mode !== "app" || !isGameTemplateId(workspace.templateId)) return null;
  const st = workspace.state as { kind?: unknown; id?: unknown } | null;
  return st && typeof st === "object" && st.kind === "game" && typeof st.id === "string" ? st.id : null;
}

export function isGameOnScreen(gameId: string): boolean {
  return onScreenGameId() === gameId;
}

function present(game: Game, force: boolean): void {
  const chosen = chooseTemplate(game);
  const view = toView(game, busyFor(game.id));
  const hot =
    !force &&
    presented !== null &&
    presented.gameId === game.id &&
    presented.templateId === chosen.template.id &&
    presented.hash === chosen.hash &&
    workspace.mode === "app" &&
    workspace.templateId === chosen.template.id &&
    onScreenGameId() === game.id;
  const owner = `game:${game.id}`;
  if (hot) {
    workspace.setState(view, owner);
    workspace.setTitle(game.title);
  } else {
    workspace.showApp(chosen.template, view, game.title, owner);
  }
  presented = { gameId: game.id, templateId: chosen.template.id, hash: chosen.hash };
  shownLog.set(game.id, newestLog(game));
}

/**
 * Show a game in the workspace (taking it over), using the game's latest saved state.
 * Hot-updates the running template when it's already showing this game.
 */
export function presentGame(game: Game | string, opts: { force?: boolean } = {}): void {
  const latest = getGame(typeof game === "string" ? game : game.id); // never show a stale copy or a deleted game
  if (latest) present(latest, opts.force === true);
}

/**
 * presentGame for work that finishes after an await: shows the game only while it is still its
 * persona's active game, so a slow tool never takes the screen back from the game the user
 * switched to meanwhile.
 */
export function presentIfCurrent(game: Game | string): void {
  const latest = getGame(typeof game === "string" ? game : game.id);
  if (latest && getActiveGameId(latest.personaId) === latest.id) present(latest, false);
}

/** The active persona is a Game Master and this is their active game — the one game that may take the screen back by itself. */
function isActiveGameMastersGame(game: Game): boolean {
  if (getActiveGameId(game.personaId) !== game.id) return false;
  try {
    const persona = getActivePersona();
    return persona.id === game.personaId && (persona.toolsets ?? []).includes("game");
  } catch {
    return false; // no personas yet
  }
}

/**
 * Store hook: after every saved mutation, re-present the game if it's the one on screen. The
 * active persona's game also comes back when something else took the screen (e.g. a web search
 * result) and the change is a new story event; art landing in the background never steals it.
 */
export function onGameChanged(game: Game): void {
  if (isGameOnScreen(game.id)) present(game, false);
  else if (newestLog(game) !== shownLog.get(game.id) && isActiveGameMastersGame(game)) present(game, false);
}

/** Forget in-memory state for a deleted game (busy labels, presentation). */
export function forgetGame(gameId: string): void {
  const m = busy.get(gameId);
  if (m) for (const key of [...m.keys()]) setBusy(gameId, key, null);
  if (presented?.gameId === gameId) presented = null;
  shownLog.delete(gameId);
}

subscribeGameChanges(onGameChanged);

// A template that throws while rendering: fall back so players never stare at a broken screen.
workspace.onRenderError((templateId, message) => {
  if (templateId.startsWith(CUSTOM_PREFIX)) {
    const gameId = templateId.slice(CUSTOM_PREFIX.length).split(":")[0] ?? "";
    const g = gameId ? getGame(gameId) : null;
    if (!g) return;
    setCustomTemplate(g.id, null);
    workspace.toast("The custom game screen hit a snag — switched back to the standard table.", "warn");
    if (isGameOnScreen(g.id)) present(g, true);
    return;
  }
  if (isDefaultTemplateId(templateId)) {
    const id = onScreenGameId();
    const g = id ? getGame(id) : null;
    if (g) present(g, true); // chooseTemplate now picks the built-in fallback, until default-game.html changes
    return;
  }
  if (templateId === FALLBACK_TEMPLATE_ID) {
    const id = onScreenGameId();
    const g = id ? getGame(id) : null;
    workspace.showHtml(errorCard(g?.title ?? "Game", message), g?.title ?? "Game");
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function errorCard(title: string, message: string): string {
  return `<div style="min-height:100%;display:grid;place-items:center;padding:32px;box-sizing:border-box;font-family:system-ui,'Segoe UI',Roboto,sans-serif;color:#efe7da">
  <div style="max-width:520px;padding:28px 30px;border-radius:18px;background:linear-gradient(160deg,#1f1a15,#15110d);border:1px solid #3a2f24;box-shadow:0 20px 60px rgba(0,0,0,.45)">
    <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#d9a441">Game screen</div>
    <h2 style="margin:8px 0 10px;font:600 24px/1.25 Georgia,'Palatino Linotype',serif">${escapeHtml(title)}</h2>
    <p style="margin:0 0 14px;color:#cdbfa8;line-height:1.55">The game screen couldn't be drawn just now. Your game is saved — keep playing, and it will reappear on the next update.</p>
    <div style="font:12px/1.5 ui-monospace,Consolas,monospace;color:#9c8f7c;background:#0f0c09;border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(message.slice(0, 300))}</div>
  </div>
</div>`;
}

// ─── Built-in fallback template (template contract v1) ───────────────────────

export const FALLBACK_TEMPLATE = `<style>
:root{--bg:#13100d;--panel:#1e1914;--ink:#f2e8d5;--muted:#b6a487;--accent:#d9a441;--accent2:#c0643b;--danger:#e0574c;--good:#7cbf6e;--font:Georgia,'Iowan Old Style','Palatino Linotype',serif}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font)}
#app{max-width:1440px;margin:0 auto;padding:18px;display:grid;gap:14px;grid-template-columns:minmax(230px,1fr) minmax(300px,1.5fr) minmax(220px,1fr)}
.full{grid-column:1/-1}
@media (max-width:860px){#app{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px 16px;min-width:0}
h1{margin:0;font-size:28px;line-height:1.15;overflow-wrap:anywhere}
h2{margin:0 0 10px;font:600 12px/1.2 system-ui,'Segoe UI',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h3{margin:10px 0 4px;font-size:18px}
.muted{color:var(--muted)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chip{font:12px/1 system-ui,'Segoe UI',sans-serif;padding:5px 9px;border-radius:999px;border:1px solid var(--accent);color:var(--accent)}
.chip.dim{border-color:rgba(255,255,255,.15);color:var(--muted)}
.hero{display:grid;grid-template-columns:56px 1fr;gap:10px;align-items:center;padding:10px 6px;border-top:1px solid rgba(255,255,255,.06);border-radius:10px}
.hero:first-of-type{border-top:0}
.hero.on{background:rgba(255,255,255,.04);box-shadow:inset 3px 0 0 var(--accent)}
.pic{width:56px;height:56px;border-radius:12px;object-fit:cover;background:rgba(255,255,255,.06);display:grid;place-items:center;font:700 20px/1 system-ui,sans-serif;color:var(--accent)}
.shimmer{background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.13),rgba(255,255,255,.04));background-size:200% 100%;animation:sh 1.4s linear infinite}
@keyframes sh{to{background-position:-200% 0}}
.small{font:12px/1.45 system-ui,'Segoe UI',sans-serif}
.bar{height:6px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;transition:width .4s ease}
.art{width:100%;height:clamp(140px,26vh,240px);max-height:240px;object-fit:cover;border-radius:10px;display:block}
.art.shimmer{border-radius:10px}
.read{font-style:italic;color:var(--ink)}
.log div{padding:6px 0;border-top:1px solid rgba(255,255,255,.06)}
.roll{font:700 46px/1 system-ui,sans-serif;color:var(--accent)}
.next{margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.05);border-left:3px solid var(--accent)}
.steps{display:flex;gap:16px;flex-wrap:wrap}
@media (prefers-reduced-motion:reduce){.shimmer{animation:none}.bar>i{transition:none}}
</style>
<div id="app"></div>
<script>
(function(){
var esc=(window.trinity&&window.trinity.esc)||function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});};
function A(v){return Array.isArray(v)?v:[];}
function O(v){return A(v).filter(function(x){return x&&typeof x==="object";});}
function mod(v){var m=Math.floor(((Number(v)||10)-10)/2);return(m>=0?"+":"")+m;}
function pic(ref,name,cls){ref=ref||{};if(ref.status==="ready"&&ref.url)return'<img class="'+cls+'" src="'+esc(ref.url)+'" alt="">';if(ref.status==="pending")return'<div class="'+cls+' shimmer"></div>';return cls==="pic"?'<div class="pic">'+esc((String(name||"?").trim().charAt(0)||"?").toUpperCase())+'</div>':"";}
var FONTS={serif:"Georgia,'Iowan Old Style','Palatino Linotype',serif",sans:"system-ui,'Segoe UI',Roboto,sans-serif",mono:"ui-monospace,Consolas,monospace",display:"'Trebuchet MS',Impact,sans-serif"};
var ICON={roll:"\\u{1F3B2}",combat:"\\u2694",loot:"\\u{1F4B0}",party:"\\u{1F9DD}",narration:"\\u{1F4DC}",system:"\\u2699"};
window.render=function(state){
var s=state||{},t=s.theme||{},p=t.palette||{},L=t.labels||{},r=document.documentElement.style,o=esc(t.ornament||"\\u2726");
for(var k in p){if(/^#[0-9a-f]{3,8}$/i.test(String(p[k])))r.setProperty("--"+k,p[k]);}
r.setProperty("--font",FONTS[t.font]||FONTS.serif);
var items={};O(s.items).forEach(function(it){if(it&&it.id)items[it.id]=it;});
var h='<header class="full card"><h1>'+esc(s.title||"New Adventure")+'</h1><div class="chips">'+(s.genre?'<span class="chip">'+esc(s.genre)+'</span>':'')+(s.tone?'<span class="chip dim">'+esc(s.tone)+'</span>':'')+'<span class="chip">'+(s.phase==="playing"?"Playing \\u00b7 Round "+esc(s.round||1):"Setup")+'</span>'+A(s.busy).map(function(b){return'<span class="chip dim">'+esc(b)+'</span>';}).join("")+'</div>'+(s.setting?'<p class="muted" style="margin:10px 0 0">'+esc(s.setting)+'</p>':'')+'</header>';
if(s.phase!=="playing"&&s.setup){h+='<section class="full card"><h2>'+o+' Setting up your adventure</h2><div class="steps">'+O(s.setup.steps).map(function(x){return'<span'+(x.done?'':' class="muted"')+'>'+(x.done?"\\u2713":"\\u25CB")+" "+esc(x.label)+'</span>';}).join("")+'</div>'+(s.setup.next?'<div class="next"><b>Next:</b> '+esc(s.setup.next)+'</div>':'')+'</section>';}
h+='<section class="card"><h2>'+o+' '+esc(L.party||"Party")+'</h2>'+(O(s.players).length?O(s.players).map(function(pl){
if(pl.pending)return'<div class="hero"><div class="pic shimmer"></div><div><b>'+esc(pl.name||"New hero")+'</b><div class="muted small">A new hero approaches\\u2026</div></div></div>';
var pct=pl.maxHp>0?Math.max(0,Math.min(100,Math.round(pl.hp/pl.maxHp*100))):0,col=pct>50?"var(--good)":pct>25?"var(--accent)":"var(--danger)",st=pl.stats||{};
return'<div class="hero'+(pl.id===s.activePlayerId?' on':'')+'">'+pic(pl.portrait,pl.name,"pic")+'<div style="min-width:0"><b>'+esc(pl.name)+'</b> <span class="muted small">'+esc([pl.race,pl.className].filter(Boolean).join(" "))+' \\u00b7 Lv '+esc(pl.level)+'</span><div class="muted small">HP '+esc(pl.hp)+'/'+esc(pl.maxHp)+' \\u00b7 AC '+esc(pl.ac)+' \\u00b7 '+["str","dex","con","int","wis","cha"].map(function(k){return k.toUpperCase()+" "+mod(st[k]);}).join(" ")+'</div><div class="bar"><i style="width:'+pct+'%;background:'+col+'"></i></div>'+(A(pl.conditions).length?'<div class="chips">'+A(pl.conditions).map(function(c){return'<span class="chip dim">'+esc(c)+'</span>';}).join("")+'</div>':'')+(A(pl.inventory).length?'<div class="muted small" style="margin-top:4px">'+A(pl.inventory).map(function(id){return esc((items[id]||{}).name||"");}).filter(Boolean).join(" \\u00b7 ")+'</div>':'')+'</div></div>';
}).join(""):'<p class="muted">No heroes yet.</p>')+'</section>';
var sc=s.scene;h+='<section class="card"><h2>'+o+' '+esc(L.scene||"Scene")+'</h2>'+(sc?pic(sc.image,"","art")+'<h3>'+esc(sc.title)+'</h3><p class="read">'+esc(sc.description)+'</p>':'<p class="muted">The story has not begun.</p>')+'<h2 style="margin-top:16px">'+o+' '+esc(L.log||"Adventure Log")+'</h2><div class="log">'+O(s.log).slice(-40).reverse().map(function(e){return'<div>'+(ICON[e.kind]||"\\u2022")+' '+esc(e.text)+'</div>';}).join("")+'</div></section>';
var lr=s.lastRoll;h+='<section class="card">'+(lr?'<h2>'+o+' Last roll</h2><div class="roll">'+esc(lr.total)+'</div><div class="muted small">'+esc((lr.who||"Game Master")+(lr.label?" \\u00b7 "+lr.label:"")+" \\u00b7 "+lr.notation+" ["+A(lr.rolls).join(", ")+"]")+'</div>':'')+'<h2 style="margin-top:14px">'+o+' '+esc(L.npcs||"NPCs")+'</h2>'+(O(s.npcs).map(function(n){return'<div class="hero">'+pic(n.portrait,n.name,"pic")+'<div style="min-width:0"><b>'+esc(n.name)+'</b><div class="muted small">'+esc([n.role,n.attitude].filter(Boolean).join(" \\u00b7 "))+'</div></div></div>';}).join("")||'<p class="muted">None yet.</p>')+'<h2 style="margin-top:14px">'+o+' '+esc(L.items||"Items & Loot")+'</h2>'+(O(s.items).map(function(it){return'<div class="small" style="padding:3px 0"><b>'+esc(it.name)+'</b> <span class="muted">\\u00b7 '+esc(it.rarity)+'</span></div>';}).join("")||'<p class="muted">Nothing yet.</p>')+'</section>';
document.getElementById("app").innerHTML=h;
};
})();
</script>`;

const FALLBACK_HASH = hash8(FALLBACK_TEMPLATE);
