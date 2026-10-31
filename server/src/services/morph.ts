import { config, live } from "../config.js";
import { morphChat, openrouterChat } from "./llm.js";

/**
 * Morph builds/edits the workspace UI.
 *
 *  - from-scratch build → a codegen model (MORPH_GEN_MODEL, e.g. morph-glm53-744b)
 *  - incremental edit of a large existing file → morph-v3-fast "fast apply"
 *    (`applyEdit`, below), which merges a lazy update snippet into the original.
 *
 * For our small workspace fragments, `build` regenerates the whole fragment
 * (reliable and fast enough); `applyEdit` is exposed for callers that already
 * have a lazy edit snippet to merge.
 */

const GEN_SYSTEM =
  "You generate a single self-contained HTML fragment (no <html>/<head>/<body>, " +
  "inline styles only) that renders cleanly on a dark background (#0f0f18, light text). " +
  "Make it clear and attractive. Return ONLY the HTML, no code fences, no commentary.";

export async function build(instruction: string, currentHtml?: string): Promise<string> {
  // 1. Prefer Morph's codegen model.
  if (live.morph) {
    try {
      const user = currentHtml
        ? `Here is the current UI:\n${currentHtml}\n\nUpdate it per: ${instruction}`
        : `Build UI for: ${instruction}`;
      return stripFences(
        await morphChat(config.morph.genModel, [
          { role: "system", content: GEN_SYSTEM },
          { role: "user", content: user },
        ]),
      );
    } catch (err) {
      console.warn("[morph] codegen failed, trying brain:", (err as Error).message);
    }
  }
  // 2. Fall back to the brain model (OpenRouter) if available.
  if (live.brain) {
    try {
      return stripFences(
        await openrouterChat(config.openrouter.brainModel, [
          { role: "system", content: GEN_SYSTEM },
          { role: "user", content: currentHtml ? `Current UI:\n${currentHtml}\n\nUpdate: ${instruction}` : instruction },
        ]),
      );
    } catch (err) {
      console.warn("[morph] brain fallback failed:", (err as Error).message);
    }
  }
  // 3. Mock.
  return mockBuild(instruction, currentHtml);
}

/**
 * Morph fast-apply: merge a lazy edit snippet (with "// ... existing code ..."
 * markers) into an existing file. `instruction` must be model-generated, per Morph.
 */
export async function applyEdit(original: string, update: string, instruction: string): Promise<string> {
  if (!live.morph) throw new Error("Morph not configured");
  const content = `<instruction>${instruction}</instruction>\n<code>${original}</code>\n<update>${update}</update>`;
  return stripFences(await morphChat(config.morph.applyModel, [{ role: "user", content }]));
}

function stripFences(s: string): string {
  return s.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
}

function mockBuild(instruction: string, currentHtml?: string): string {
  const esc = instruction.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const prior = currentHtml ? `<p style="opacity:.5;font-size:12px">(updating previous build)</p>` : "";
  return `
    <div style="font-family:system-ui;color:#e8e8ef;padding:24px;border-radius:14px;
                background:linear-gradient(135deg,#1b1b2e,#23233a);border:1px solid #33334d">
      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a8ab0">
        Trinity built this · mock mode
      </div>
      <h2 style="margin:.4em 0;font-size:22px">${esc}</h2>
      <p style="color:#b9b9d6;line-height:1.5">
        This is a placeholder render. Add a <code>MORPH_API_KEY</code> and I'll generate
        and live-edit real UI here as we talk.
      </p>
      ${prior}
    </div>`.trim();
}
