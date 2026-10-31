import { config } from "../config.js";
import { live } from "../settings.js";

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
}
export interface WebSearch {
  answer?: string;
  results: WebResult[];
}

/**
 * Web search via Tavily (https://api.tavily.com/search). Returns a synthesized
 * answer plus ranked results. In mock mode it returns a clear placeholder so the
 * routing + tool loop stays exercisable end-to-end.
 */
export async function search(query: string): Promise<WebSearch> {
  if (!live.web) {
    return {
      answer: `(Web search is in mock mode — set TAVILY_API_KEY to search for "${query}".)`,
      results: [
        { title: "Web search not configured", snippet: `Would search for "${query}".`, url: "about:blank" },
      ],
    };
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.web.key}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: true,
    }),
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
