import { recentResults } from "../../agent/act.js";
import { getCard, listCards, type BoardCard } from "../../workspace/board.js";
import { tidy } from "./mail-words.js";
import { plain } from "./untrusted.js";

/*
 * "Book the second flight", "book that hotel", "open the first one to book": the link of a flight, hotel or product
 * that the engine's own live search put on the board (tools/content.ts → services/live-results.ts →
 * workspace/content-card.ts). That is the only place a booking link is ever taken from: the result rows the engine
 * rendered on the latest shopping, flights or hotels card — found through recentResults() or on the board. Never a
 * link in the user's words, in a page's text, in a tool argument or in anything a model wrote; and only https.
 *
 * Opening the page is all that happens here. Filling in details and paying are other tools, each with its own yes.
 */

export type ResultKind = "shopping" | "flights" | "hotels";

export interface ResultItem {
  kind: ResultKind;
  /** The product, the airline or the hotel. */
  name: string;
  /** Where it is sold, or the flight's times ("8:05 AM AUS → 9:40 AM DEN"). */
  detail: string;
  price: string;
  /** The row's own link, as the search returned it — null when the row has none. */
  url: string | null;
}

export interface ResultSet {
  card: number;
  kind: ResultKind;
  items: ResultItem[];
}

const unescape = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
const text = (html: string | undefined): string =>
  unescape((html ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const first = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1];

/** The stretches of markup that start at each match of `open`, each cut where `close` first shows. */
function pieces(html: string, open: RegExp, close: RegExp): string[] {
  const starts = [...html.matchAll(open)].map((m) => m.index);
  return starts.map((s, i) => {
    const piece = html.slice(s, starts[i + 1] ?? html.length);
    const end = close.exec(piece);
    return end ? piece.slice(0, end.index) : piece;
  });
}

/**
 * The result rows on a card the engine rendered from a live search (workspace/content-card.ts: product tiles
 * `.pd`, flight rows `.fo`, hotel rows `.ho`). Null for any other card.
 */
export function resultsOn(card: Pick<BoardCard, "n" | "html">): ResultSet | null {
  const html = card.html ?? "";
  const kind = first(html, /<article class="cc" data-type="(shopping|flights|hotels)">/) as ResultKind | undefined;
  if (!kind) return null;
  const items: ResultItem[] = [];
  if (kind === "shopping") {
    for (const p of pieces(html, /<(?:a|div) class="pd"/g, /<\/section>/)) {
      const href = first(p, /^<a class="pd" href="([^"]*)"/);
      items.push({ kind, name: text(first(p, /<div class="t">(.*?)<\/div>/s)), detail: text(first(p, /<div class="s"><b>(.*?)<\/b>/s)), price: text(first(p, /<div class="p"><b>(.*?)<\/b>/s)), url: href ? unescape(href) : null });
    }
  } else if (kind === "flights") {
    for (const p of pieces(html, /<li class="fo">/g, /<\/li>/)) {
      const href = first(p, /<span class="pr"><a href="([^"]*)"/);
      const times = [...p.matchAll(/<div class="tm">(.*?)<small>(.*?)<\/small><\/div>/gs)].map((m) => `${text(m[1])} ${text(m[2])}`);
      items.push({ kind, name: text(first(p, /<span class="al">(.*?)<\/span>/s)), detail: times.join(" → "), price: text(first(p, /<span class="pr">(.*?)<\/span>/s)), url: href ? unescape(href) : null });
    }
  } else {
    for (const p of pieces(html, /<li class="ho">/g, /<\/li>/)) {
      const href = first(p, /<div class="nm"><a href="([^"]*)"/);
      items.push({ kind, name: text(first(p, /<div class="nm">(.*?)<\/div>/s)), detail: text(first(p, /<div class="mt">(.*?)<\/div>/s)), price: text(first(p, /<div class="pr">(?:<b>(.*?)<\/b>)?/s)), url: href ? unescape(href) : null });
    }
  }
  return { card: card.n, kind, items: items.filter((i) => i.name || i.url) };
}

/** The latest shopping, flights or hotels results: the card a recent show_card result names, else the newest such card on the board. */
export function latestResults(): ResultSet | null {
  const order: number[] = [];
  for (const r of [...recentResults()].reverse()) {
    if (r.tool !== "show_card" || !r.data) continue;
    const n = /"card":\s*(\d+)/.exec(r.data)?.[1];
    if (n && /"type":\s*"(?:shopping|flights|hotels)"/.test(r.data)) order.push(Number(n));
  }
  for (const c of listCards().sort((a, b) => b.n - a.n)) order.push(c.n);
  const seen = new Set<number>();
  for (const n of order) {
    if (seen.has(n)) continue;
    seen.add(n);
    const card = getCard(n);
    const set = card && card.kind === "widget" ? resultsOn(card) : null;
    if (set?.items.length) return set;
  }
  return null;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const CARDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const FILLER = new Set(
  "book booking reserve buy order purchase get open pull up show the that this those these it them one ones flight flights hotel hotels room rooms product item option result results to for me my a an on from of at in and please now go ahead with want would like i'd i so can you could let's lets then page site link ticket tickets stay night nights".split(
    " ",
  ),
);

const amount = (price: string): number | null => {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(price);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
};

export type ItemPick = { ok: true; item: ResultItem; index: number } | { ok: false; say: string };

/** Which result the words mean: by its place ("the second flight"), "the cheapest", or what it is called ("the Delta one"). */
export function pickItem(words: string, set: ResultSet): ItemPick {
  const t = tidy(words).toLowerCase();
  const noun = set.kind === "shopping" ? "result" : set.kind === "flights" ? "flight" : "hotel";
  const at = (i: number): ItemPick => (i >= 0 && i < set.items.length ? { ok: true, item: set.items[i]!, index: i } : { ok: false, say: `There ${set.items.length === 1 ? "is only 1" : `are only ${set.items.length}`} on card ${set.card}. Which one?` });
  let m = new RegExp(String.raw`\b(${ORDINALS.join("|")})\b`).exec(t);
  if (m) return at(ORDINALS.indexOf(m[1]!));
  m = new RegExp(String.raw`\b(?:number|#|option|${noun})\s*#?\s*(\d{1,2}|${CARDINALS.join("|")})\b`).exec(t) ?? /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (m) return at((/^\d/.test(m[1]!) ? Number(m[1]) : CARDINALS.indexOf(m[1]!) + 1) - 1);
  if (/\b(?:last|bottom) (?:one|flight|hotel|option|result)\b/.test(t)) return at(set.items.length - 1);
  if (/\b(?:cheapest|least expensive|lowest[- ]priced?|lowest price)\b/.test(t)) {
    const priced = set.items.map((item, index) => ({ index, n: amount(item.price) })).filter((x): x is { index: number; n: number } => x.n !== null);
    if (priced.length) return at(priced.reduce((a, b) => (b.n < a.n ? b : a)).index);
  }
  // By what it is called: the words that aren't the request's own.
  const said = t.split(/[^a-z0-9']+/).filter((w) => w.length >= 3 && !FILLER.has(w));
  if (said.length) {
    const scores = set.items.map((item, index) => ({ index, n: said.filter((w) => `${item.name} ${item.detail}`.toLowerCase().includes(w)).length }));
    const best = Math.max(...scores.map((s) => s.n));
    const top = scores.filter((s) => s.n === best);
    if (best > 0 && top.length === 1) return at(top[0]!.index);
  }
  if (set.items.length === 1) return at(0);
  return { ok: false, say: `Which ${noun}? Say the first, the second and so on — there are ${set.items.length} on card ${set.card}.` };
}

/** A row's link, when it is one that may be opened: https, no sign-in details in it. */
export function bookingLink(item: ResultItem): { ok: true; url: string } | { ok: false; say: string } {
  if (!item.url) return { ok: false, say: "That result doesn't come with a link, so there's nothing for me to open." };
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return { ok: false, say: "That result's link isn't one I can open." };
  }
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false, say: "That result's link isn't a secure https link, so I haven't opened it." };
  return { ok: true, url: url.href };
}

/** The site a link opens on, as said: "Google Flights", "Google Hotels", "Google Shopping", else its host. */
export function siteSaid(link: string): string {
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (/(?:^|\.)google\.[a-z.]{2,6}$/.test(host)) {
      if (/\/travel\/flights|\/flights\b/.test(u.pathname)) return "Google Flights";
      if (/\/travel\/(?:hotels|search)|\/hotels\b/.test(u.pathname)) return "Google Hotels";
      if (/\/shopping\b/.test(u.pathname) || /(?:^|&)(?:tbm=shop|udm=28)(?:&|$)/.test(u.search.slice(1))) return "Google Shopping";
      return "Google";
    }
    return /^[a-z0-9.-]{3,60}$/.test(host) ? host : "the site";
  } catch {
    return "the site";
  }
}

const NEXT = "When you're ready, say fill in my details, then pay with my card — I'll ask before anything is bought.";

/** What is said once the page is open: where it opened, and what comes next — nothing is filled in or bought here. */
export function bookingLine(item: ResultItem, link: string): string {
  const site = siteSaid(link);
  const name = plain(item.name, 7, 60);
  if (item.kind === "flights") {
    const leaves = /^(\d{1,2}:\d{2}\s*[AP]M)/i.exec(item.detail)?.[1];
    // Every flight row links the same Google Flights search: the flight itself is picked there.
    if (site === "Google Flights") return `Google Flights is open on that search — pick the ${name || "flight"}${leaves ? ` ${leaves}` : ""} flight there. ${NEXT}`;
    return `It's open on ${site}. ${NEXT}`;
  }
  if (item.kind === "hotels") return `${name || "That hotel"} is open on ${site}. ${NEXT}`;
  const store = plain(item.detail, 4, 40);
  return `${name || "It"} is open${store ? ` at ${store}` : ` on ${site}`}. ${NEXT}`;
}
