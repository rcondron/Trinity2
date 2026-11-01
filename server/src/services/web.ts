import { getEndpoints } from "../settings.js";

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
}
export interface WebSearch {
  answer?: string;
  results: WebResult[];
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Web search. Prefers Tavily when TAVILY_API_KEY is set (clean synthesized answer
 * + ranked sources); otherwise falls back to a keyless DuckDuckGo provider so
 * research works with no key at all. Both return text the brain/Jev can use.
 */
export async function search(query: string): Promise<WebSearch> {
  const q = query.trim();
  if (!q) return { results: [] };
  // Tavily if a key is configured (via .env or the Settings page).
  const key = getEndpoints().tavilyKey;
  if (key) {
    try {
      return await tavily(q, key);
    } catch (err) {
      console.warn("[web] Tavily failed, falling back to DuckDuckGo:", (err as Error).message);
    }
  }
  return duck(q);
}

// ─── Tavily (keyed) ───────────────────────────────────────────────────────────
async function tavily(query: string, key: string): Promise<WebSearch> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: "basic", max_results: 6, include_answer: true }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    answer?: string;
    results?: { title: string; url: string; content: string }[];
  };
  return {
    answer: data.answer,
    results: (data.results ?? []).map((r) => ({ title: r.title, snippet: r.content, url: r.url })),
  };
}

// ─── DuckDuckGo (keyless) ─────────────────────────────────────────────────────
async function duck(query: string): Promise<WebSearch> {
  const [ia, html] = await Promise.allSettled([duckInstant(query), duckHtml(query)]);
  const answer = ia.status === "fulfilled" ? ia.value.answer : undefined;
  const results: WebResult[] = [];
  const seen = new Set<string>();
  const push = (r: WebResult) => {
    if (!r.url || seen.has(r.url)) return;
    seen.add(r.url);
    results.push(r);
  };
  if (ia.status === "fulfilled") ia.value.results.forEach(push);
  if (html.status === "fulfilled") html.value.forEach(push);
  return { answer, results: results.slice(0, 6) };
}

/** DuckDuckGo Instant Answer API — direct facts + related topics (JSON, keyless). */
async function duckInstant(query: string): Promise<WebSearch> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=trinity`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`DDG IA ${res.status}`);
  const d = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    Answer?: string;
    RelatedTopics?: unknown[];
  };
  const results: WebResult[] = [];
  if (d.AbstractURL && d.Heading) results.push({ title: d.Heading, snippet: d.AbstractText ?? "", url: d.AbstractURL });
  for (const t of flattenTopics(d.RelatedTopics ?? [])) {
    if (t.FirstURL && t.Text) results.push({ title: t.Text.split(" - ")[0]!.slice(0, 120), snippet: t.Text, url: t.FirstURL });
  }
  const answer = (d.Answer && d.Answer.trim()) || (d.AbstractText && d.AbstractText.trim()) || undefined;
  return { answer, results };
}

interface Topic {
  Text?: string;
  FirstURL?: string;
  Topics?: unknown[];
}
function flattenTopics(topics: unknown[]): Topic[] {
  const out: Topic[] = [];
  for (const t of topics as Topic[]) {
    if (t && Array.isArray(t.Topics)) out.push(...flattenTopics(t.Topics));
    else if (t && t.FirstURL) out.push(t);
  }
  return out;
}

/** DuckDuckGo HTML results page — scraped for real web links (keyless). */
async function duckHtml(query: string): Promise<WebResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DDG HTML ${res.status}`);
  const body = await res.text();
  const results: WebResult[] = [];

  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(body))) snippets.push(clean(sm[1]!));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(body)) && results.length < 8) {
    const url = resolveDuckHref(lm[1]!);
    const title = clean(lm[2]!);
    if (url && title) results.push({ title, snippet: snippets[i] ?? "", url });
    i++;
  }
  return results;
}

/** DDG wraps result links as /l/?uddg=<encoded-real-url>; unwrap to the real URL. */
function resolveDuckHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      /* fall through */
    }
  }
  if (href.startsWith("//")) return "https:" + href;
  return href.startsWith("http") ? href : "";
}

function clean(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}
