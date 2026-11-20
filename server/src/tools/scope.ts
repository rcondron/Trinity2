import { AsyncLocalStorage } from "node:async_hooks";
import type { Tool, ToolResult } from "../types.js";

/*
 * Tools a run may not use.
 *
 * Work that starts by itself — a scheduled task, a plan being replayed — is wrapped in withHiddenTools(names, fn).
 * Everything that work starts, however deep (a tool, the problem solver, a procedure skill), sees the same names:
 * the solver leaves those tools off its list and refuses a step that names one (tools/solve.ts takes the set when a
 * run starts and keeps it for the whole run), and a tool that changes what is saved — memories, the profile,
 * skills, reminders — refuses to run while it is in the set (hiddenHere).
 *
 * The set holds only while `fn` is running. A timer or a connection made inside it can outlive it; whatever runs
 * from one of those afterwards (a user's next request, say) is not held to a rule that was meant for the run.
 */

interface Scope {
  names: ReadonlySet<string>;
  active: boolean;
  parent: Scope | undefined;
}

const scope = new AsyncLocalStorage<Scope>();
const NONE: ReadonlySet<string> = new Set();

/** The innermost scope still running (its names include every scope around it that was running when it began). */
function current(): ReadonlySet<string> {
  for (let s = scope.getStore(); s; s = s.parent) if (s.active) return s.names;
  return NONE;
}

/** Run `fn` with these tools kept away from everything it starts — until it settles. */
export async function withHiddenTools<T>(hidden: Iterable<string>, fn: () => Promise<T>): Promise<T> {
  const mine: Scope = { names: new Set([...current(), ...hidden]), active: true, parent: scope.getStore() };
  try {
    return await scope.run(mine, fn);
  } finally {
    mine.active = false;
  }
}

/** The tools hidden for the code that is running now (empty outside any scope). */
export function hiddenTools(): ReadonlySet<string> {
  return current();
}

/** Whether this tool is hidden for the run that is calling it. */
export function hiddenHere(name: string): boolean {
  return current().has(name);
}

/** What a tool answers when the run that called it may not use it. */
export function notHere(): ToolResult {
  return { ok: false, say: "That one needs the user to ask for it themselves, so I left it." };
}

/**
 * The tool, refusing to run while it is hidden for the run that calls it — or when a scheduled run calls it
 * directly (agent/act.ts says so in `ctx.origin`). For the tools that change what is saved: the router and the
 * solver already leave them out of such a run; this holds if one is reached all the same.
 */
export function guarded(tool: Tool): Tool {
  const run = tool.run;
  return { ...tool, run: (args, ctx) => (hiddenHere(tool.name) || ctx.origin === "scheduled" ? Promise.resolve(notHere()) : run(args, ctx)) };
}
