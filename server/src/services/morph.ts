import { live } from "../config.js";
import { morphChat } from "./llm.js";

/**
 * Morph builds/edits the workspace UI on the fly. For a from-scratch build we ask
 * for a self-contained HTML fragment; for an edit we hand Morph the current HTML
 * plus an update instruction (its fast-apply sweet spot).
 */
export async function build(instruction: string, currentHtml?: string): Promise<string> {
  if (!live.morph) return mockBuild(instruction, currentHtml);

  const sys =
    "You generate a single self-contained HTML fragment (no <html>/<head>/<body>, inline styles only) " +
    "that renders cleanly on a dark background. Return ONLY the HTML.";
  const user = currentHtml
    ? `Current UI:\n<code>${currentHtml}</code>\n\nUpdate it: ${instruction}`
    : `Build UI for: ${instruction}`;
  try {
    const html = await morphChat([
      { role: "system", content: sys },
      { role: "user", content: user },
    ]);
    return stripFences(html);
  } catch (err) {
    console.warn("[morph] build failed, using mock:", (err as Error).message);
    return mockBuild(instruction, currentHtml);
  }
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
