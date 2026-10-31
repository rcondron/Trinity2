import { live } from "../config.js";

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
}

/**
 * Web search / browse tool. Provider-agnostic: wire your preferred search API in
 * the live branch. In mock mode it returns a clear, honest placeholder so the
 * routing + tool loop is still exercisable end-to-end.
 */
export async function search(query: string): Promise<WebResult[]> {
  if (!live.web) {
    return [
      {
        title: "Web search not configured",
        snippet: `I would search for "${query}" here. Set WEB_SEARCH_API_KEY in .env to enable real results.`,
        url: "about:blank",
      },
    ];
  }
  // TODO: plug in a concrete provider (Brave, Tavily, SerpAPI, etc.) using config.web.key.
  throw new Error("Web search provider not implemented yet");
}
