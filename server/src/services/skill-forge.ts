import fs from "node:fs";
import path from "node:path";
import { config, live, PENDING_SKILLS_DIR, SKILLS_DIR } from "../config.js";
import { mordiemChat } from "./llm.js";

export interface ForgedSkill {
  name: string;
  description: string;
  source: string;
}

/**
 * Generated skills must be PURE COMPUTE — no imports, I/O, network, process, eval,
 * or timers. We reject anything that reaches outside its arguments. This keeps
 * approved skills safe to run in-process; a human still approves before loading.
 */
const DENY =
  /\b(require|import|process|child_process|eval|Function|globalThis|__dirname|__filename|XMLHttpRequest|WebSocket|setTimeout|setInterval|setImmediate|queueMicrotask|Deno|Bun|fetch|atob|btoa)\b|\bfs\s*\.|\bfor\s*\(\s*;\s*;\s*\)|\bwhile\s*\(\s*true\s*\)/;

const SYSTEM =
  "You author a Trinity skill as a single JavaScript ES module. It MUST `export default` " +
  "an object with exactly: name (snake_case string), description (string), input (object " +
  "mapping each arg name to {type, description, required?}), and run (an async function " +
  "taking one `args` object and returning {ok:boolean, say?:string, render?:string, data?:any}). " +
  "The run function MUST be PURE: compute only over `args`. No imports, no require, no fs, no " +
  "network/fetch, no process, no eval, no timers, no randomness other than Math.random. " +
  "Return ONLY the module source — no code fences, no commentary.";

export async function forgeSkill(
  need: string,
): Promise<{ ok: true; skill: ForgedSkill } | { ok: false; reason: string }> {
  if (!live.mordiem) return { ok: false, reason: "Mordiem is not configured" };

  let source: string;
  try {
    source = stripFences(
      await mordiemChat(
        config.mordiem.genModel,
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Create a skill for this need: ${need}` },
        ],
        { maxTokens: 900, temperature: 0 },
      ),
    );
  } catch (err) {
    return { ok: false, reason: `generation failed: ${(err as Error).message}` };
  }

  if (!/export\s+default/.test(source)) return { ok: false, reason: "no default export" };
  const nameMatch = source.match(/name\s*:\s*["'`]([a-z0-9_]+)["'`]/i);
  if (!nameMatch) return { ok: false, reason: "no valid snake_case name" };
  if (DENY.test(source)) return { ok: false, reason: "used a disallowed capability (skills must be pure compute)" };

  const name = nameMatch[1]!.toLowerCase();
  const description = source.match(/description\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? need;
  fs.mkdirSync(PENDING_SKILLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PENDING_SKILLS_DIR, `${name}.skill.mjs`), source, "utf8");
  return { ok: true, skill: { name, description, source } };
}

export function listPending(): ForgedSkill[] {
  if (!fs.existsSync(PENDING_SKILLS_DIR)) return [];
  return fs
    .readdirSync(PENDING_SKILLS_DIR)
    .filter((f) => f.endsWith(".skill.mjs"))
    .map((f) => {
      const source = fs.readFileSync(path.join(PENDING_SKILLS_DIR, f), "utf8");
      return {
        name: f.replace(/\.skill\.mjs$/, ""),
        description: source.match(/description\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "",
        source,
      };
    });
}

/** Re-validate and move a pending skill into the active library. Returns its path. */
export function approveSkill(name: string): string {
  const src = path.join(PENDING_SKILLS_DIR, `${name}.skill.mjs`);
  if (!fs.existsSync(src)) throw new Error("no such pending skill");
  if (DENY.test(fs.readFileSync(src, "utf8"))) throw new Error("skill failed the safety re-check");
  const dest = path.join(SKILLS_DIR, `${name}.skill.mjs`);
  fs.renameSync(src, dest);
  return dest;
}

export function discardSkill(name: string): void {
  const src = path.join(PENDING_SKILLS_DIR, `${name}.skill.mjs`);
  if (fs.existsSync(src)) fs.unlinkSync(src);
}

function stripFences(s: string): string {
  return s.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
}
