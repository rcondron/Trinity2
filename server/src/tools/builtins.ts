import { nanoid } from "nanoid";
import { saveTask } from "../db/sqlite.js";
import { search } from "../services/web.js";
import type { Tool } from "../types.js";
import { registerTool } from "./registry.js";

const webSearch: Tool = {
  name: "web_search",
  description: "Search the web for current information and report what you find.",
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
    const top = results[0];
    const say =
      answer ||
      (top ? `${top.title}. ${top.snippet}` : `I couldn't find anything for "${query}".`);
    return {
      ok: true,
      say,
      render: results.length
        ? `<div style="font-family:system-ui;color:#e8e8ef;padding:20px">
             <h3 style="margin:0 0 10px">Search: ${query.replace(/</g, "&lt;")}</h3>
             ${answer ? `<p style="color:#b9b9d6">${answer.replace(/</g, "&lt;")}</p>` : ""}
             <ul style="line-height:1.6">${results
               .map((r) => `<li><a href="${r.url}" style="color:#22d3ee">${r.title.replace(/</g, "&lt;")}</a></li>`)
               .join("")}</ul>
           </div>`
        : undefined,
      data: { answer, results },
    };
  },
};

const heartbeatAdd: Tool = {
  name: "heartbeat_add",
  description: "Add a recurring task to the heartbeat so Trinity acts on it on a schedule.",
  input: {
    instruction: { type: "string", description: "What to do when due", required: true },
    intervalSec: { type: "number", description: "How often, in seconds (default 1800)" },
    title: { type: "string", description: "Short title" },
  },
  source: "builtin",
  async run(args) {
    const intervalSec = Number(args.intervalSec) > 0 ? Number(args.intervalSec) : 1800;
    const title = String(args.title ?? "Recurring task");
    const instruction = String(args.instruction ?? "");
    saveTask({
      id: nanoid(10),
      title,
      instruction,
      intervalSec,
      nextRunAt: Date.now() + intervalSec * 1000,
      lastRunAt: null,
      enabled: true,
    });
    return { ok: true, say: `Okay — I'll handle "${title}" every ${intervalSec} seconds.` };
  },
};

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
  [webSearch, heartbeatAdd, getTime].forEach(registerTool);
}
