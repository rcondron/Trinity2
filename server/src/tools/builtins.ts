import { jsonChat } from "../services/json-chat.js";
import { search } from "../services/web.js";
import type { Tool } from "../types.js";
import { registerContentTools } from "./content.js";
import { registerHtmlTools } from "./html.js";
import { registerMediaTools } from "./media.js";
import { registerTool } from "./registry.js";
import { registerScreenTools } from "./screen.js";
import { registerVoiceTools } from "./voice.js";

/** Web text as HTML text or an attribute value: a result's title or URL can't add tags or attributes to the card. */
const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Only a web link is a link: any other scheme ("javascript:", "data:") is dropped. */
const webHref = (url: string) => (/^https?:\/\//i.test(url.trim()) ? html(url.trim()) : "#");

/** When the search provider has no direct answer, have the fast model write one from the top results. */
async function synthesizeAnswer(query: string, results: { title: string; snippet: string }[]): Promise<string | null> {
  if (!results.length) return null;
  const sources = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet}`)
    .join("\n");
  const out = await jsonChat<{ answer?: string }>(
    'Answer the question in 1-2 plain sentences using ONLY the search results given. If they don\'t contain the answer, say what they do show. Return ONLY {"answer": "..."}.',
    `Question: ${query}\n\nSearch results:\n${sources}`,
    { maxTokens: 160, timeoutMs: 6000 },
  );
  return out?.answer?.trim() || null;
}

const webSearch: Tool = {
  name: "web_search",
  description: "Search the web for a quick fact, link or answer and say what you find (news or anything to lay out on the board is show_card).",
  input: { query: { type: "string", description: "What to search for", required: true } },
  source: "builtin",
  async run(args) {
    const query = String(args.query ?? "");
    let answer: string | undefined;
    let results: Awaited<ReturnType<typeof search>>["results"] = [];
    try {
      ({ answer, results } = await search(query));
    } catch (err) {
      return { ok: false, say: `My search tool hit an error: ${(err as Error).message}`, error: (err as Error).message };
    }
    if (!answer) answer = (await synthesizeAnswer(query, results)) ?? undefined;
    const top = results[0];
    const say =
      answer ||
      (top ? `${top.title}. ${top.snippet}` : `I couldn't find anything for "${query}".`);
    return {
      ok: true,
      say,
      render: results.length
        ? `<div style="font-family:system-ui;color:#e8e8ef;padding:20px">
             <h3 style="margin:0 0 10px">Search: ${html(query)}</h3>
             ${answer ? `<p style="color:#b9b9d6">${html(answer)}</p>` : ""}
             <ul style="line-height:1.6">${results
               .map((r) => `<li><a href="${webHref(r.url)}" style="color:#22d3ee">${html(r.title)}</a></li>`)
               .join("")}</ul>
           </div>`
        : undefined,
      data: { answer, results },
    };
  },
};

// (Reminders and recurring tasks: the `schedule` tool, tools/schedule.ts.)

const getTime: Tool = {
  name: "get_time",
  description: "Get the current date and time.",
  input: {},
  source: "builtin",
  async run() {
    const now = new Date();
    return { ok: true, say: `It's ${now.toLocaleString()}.`, data: { iso: now.toISOString() } };
  },
};

export function registerBuiltins(): void {
  [webSearch, getTime].forEach(registerTool);
  registerScreenTools();
  registerMediaTools();
  registerContentTools();
  registerHtmlTools();
  registerVoiceTools();
}
