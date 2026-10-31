import { getEndpoints, live } from "../settings.js";
import { mordiemChat } from "./llm.js";

/**
 * Mordiem builds/edits the workspace UI on the fly, using a fast codegen model
 * (MORDIEM_GEN_MODEL, e.g. qwen3-coder-480b-a35b-instruct-turbo). From-scratch
 * builds and edits both go through generation (we regenerate the fragment, which
 * is reliable for the small self-contained fragments the workspace renders).
 */
const GEN_SYSTEM =
  "You generate a single self-contained HTML fragment (no <html>/<head>/<body>, " +
  "inline styles only) that renders cleanly on a dark background (#0f0f18, light text). " +
  "Make it clear and attractive. Return ONLY the HTML, no code fences, no commentary.";

export async function build(instruction: string, currentHtml?: string): Promise<string> {
  if (live.mordiem) {
    try {
      const user = currentHtml
        ? `Here is the current UI:\n${currentHtml}\n\nUpdate it per: ${instruction}`
        : `Build UI for: ${instruction}`;
      return stripFences(
        await mordiemChat(
          getEndpoints().genModel,
          [
            { role: "system", content: GEN_SYSTEM },
            { role: "user", content: user },
          ],
          { maxTokens: 2500 },
        ),
      );
    } catch (err) {
      console.warn("[mordiem] codegen failed, using mock:", (err as Error).message);
    }
  }
  return mockBuild(instruction, currentHtml);
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
        This is a placeholder render. Add a <code>MORDIEM_API_KEY</code> and I'll generate
        and live-edit real UI here as we talk.
      </p>
      ${prior}
    </div>`.trim();
}
