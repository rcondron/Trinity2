import type { WebResult } from "./web.js";

/**
 * Headlines for a news card: Google News's public RSS (top stories, or a topic search), keyless and
 * fast — real stories with a source and a time, where a web search for "the news" only returns the
 * front pages of news sites. Each item is returned in the web-search result shape so the card
 * designer gets them as numbered sources ("[1] title / url / Source · 2h ago"). Everything here is
 * data from the web: titles are escaped by the renderer and never followed as instructions.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TOP = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
const SEARCH = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const tag = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decode(m[1]!) : "";
};

/** "2h ago" / "yesterday" / a date, from an RSS pubDate. */
export function ago(pubDate: string, now = Date.now()): string {
  const t = Date.parse(pubDate);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Parse Google News RSS items into web results (title, "Source · when" as the snippet, the story link). */
export function parseHeadlines(xml: string, limit = 10, now = Date.now()): WebResult[] {
  const out: WebResult[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1]!;
    const source = tag(item, "source");
    let title = tag(item, "title");
    // Google puts the outlet after the headline ("… - Reuters"); keep the headline.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const url = tag(item, "link");
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const when = ago(tag(item, "pubDate"), now);
    out.push({ title: title.slice(0, 160), url, snippet: [source, when].filter(Boolean).join(" · ") });
    if (out.length >= limit) break;
  }
  return out;
}

/** Top stories (no topic) or stories about a topic; [] when the feed can't be reached. */
export async function fetchHeadlines(topic = "", opts: { limit?: number; timeoutMs?: number } = {}): Promise<WebResult[]> {
  const q = topic.replace(/\s+/g, " ").trim();
  const url = q ? SEARCH + encodeURIComponent(q) : TOP;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000) });
    if (!res.ok) return [];
    return parseHeadlines(await res.text(), opts.limit ?? 10);
  } catch (err) {
    console.warn(`[news] headlines failed: ${(err as Error).message}`);
    return [];
  }
}
