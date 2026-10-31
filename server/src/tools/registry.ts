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
    // *.skill.(ts|js|mjs) only — the "pending" subdir is a directory and is skipped.
    if (!/\.skill\.(ts|js|mjs)$/.test(file)) continue;
    const name = await loadSkillFile(path.join(SKILLS_DIR, file));
    if (name) loaded.push(name);
  }
  return loaded;
}
