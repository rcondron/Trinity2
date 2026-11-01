import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SKILLS_DIR } from "../config.js";
import type { Tool } from "../types.js";

const tools = new Map<string, Tool>();

/**
 * Where a tool came from: shipped with the engine, a hand-written skill (server/skills/,
 * trusted, in-process), or created by Trinity at runtime ("forged": data/skills/, each run
 * sandboxed in a child process — see services/skill-forge.ts).
 */
export type ToolSource = NonNullable<Tool["source"]>;

/** `Tool.source` for forged skills. */
export const FORGED_SOURCE: ToolSource = "forged";

/** Add a tool, or replace the one registered under the same name. Jev sees it on its next decision. */
export function registerTool(t: Tool): void {
  tools.set(t.name, t);
}
/** Remove a tool (e.g. a forged skill switched off or deleted). Returns whether it was registered. */
export function unregisterTool(name: string): boolean {
  return tools.delete(name);
}
export function getTools(): Tool[] {
  return [...tools.values()];
}
export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}
export function toolSource(t: Tool): ToolSource {
  return t.source ?? "builtin";
}

/**
 * Load the hand-written skills library: each module in server/skills/ named *.skill.ts (or
 * .js/.mjs) default-exports a Tool and runs in-process. Skills Trinity creates on the fly
 * are NOT loaded here — they live in data/skills/ and run sandboxed (tools/forge.ts).
 */
/** Load one skill module and register it. Returns its tool name, or null. */
export async function loadSkillFile(filePath: string): Promise<string | null> {
  try {
    const mod = await import(pathToFileURL(filePath).href);
    const tool = mod.default as Tool | undefined;
    if (tool?.name && typeof tool.run === "function") {
      registerTool({ ...tool, source: "skill" });
      return tool.name;
    }
  } catch (err) {
    console.warn(`[skills] failed to load ${filePath}:`, (err as Error).message);
  }
  return null;
}

export async function loadSkills(): Promise<string[]> {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const loaded: string[] = [];
  for (const file of fs.readdirSync(SKILLS_DIR)) {
    if (!/\.skill\.(ts|js|mjs)$/.test(file)) continue;
    const name = await loadSkillFile(path.join(SKILLS_DIR, file));
    if (name) loaded.push(name);
  }
  return loaded;
}
