import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SKILLS_DIR } from "../config.js";
import type { Tool } from "../types.js";

const tools = new Map<string, Tool>();

export function registerTool(t: Tool): void {
  tools.set(t.name, t);
}
export function getTools(): Tool[] {
  return [...tools.values()];
}
export function getTool(name: string): Tool | undefined {
  return tools.get(name);
}

/**
 * Load the Trinity skills library. Each skill is a module in server/skills/
 * named *.skill.ts (or .js) whose default export is a Tool. This is where
 * Morph-authored connectors/skills get saved for future Jev routing.
 */
export async function loadSkills(): Promise<string[]> {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const loaded: string[] = [];
  for (const file of fs.readdirSync(SKILLS_DIR)) {
    if (!/\.skill\.(ts|js|mjs)$/.test(file)) continue;
    try {
      const mod = await import(pathToFileURL(path.join(SKILLS_DIR, file)).href);
      const tool = mod.default as Tool | undefined;
      if (tool?.name && typeof tool.run === "function") {
        registerTool({ ...tool, source: "skill" });
        loaded.push(tool.name);
      }
    } catch (err) {
      console.warn(`[skills] failed to load ${file}:`, (err as Error).message);
    }
  }
  return loaded;
}
