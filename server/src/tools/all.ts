/*
 * Every tool family the engine starts with, registered in one place: the engine (index.ts) and the scripts that
 * exercise routing against the same set (scripts/eval-assistant.mts) both call this, so a family added here is
 * routed, evaluated and tested without a second list to keep in step.
 */
import { registerGameContext } from "../game/integration.js";
import { registerStoryTools } from "../game/story-tools.js";
import { registerGameTools } from "../game/tools.js";
import { registerAskTools } from "./ask.js";
import { registerAssistTools } from "./assist.js";
import { registerBrowserFillTools } from "./browser-fill.js";
import { registerBrowserTools } from "./browser.js";
import { registerBuiltins } from "./builtins.js";
import { registerCodingTools } from "./coding.js";
import { registerDisplayTools } from "./display.js";
import { registerFileTools } from "./files.js";
import { registerForgeTools } from "./forge.js";
import { registerMemoryTools } from "./memory.js";
import { registerPendingTools } from "./pending.js";
import { registerScheduleTools } from "./schedule.js";
import { registerVaultTools } from "./vault.js";

/**
 * The tools Jev routes to: built-ins, the board and its builders, memory, scheduling, skills, the Game Master's
 * toolset (only for personas that enable it), the user's browser, the vault, and the yes/no answer.
 */
export function registerAllTools(): void {
  registerBuiltins();
  registerCodingTools();
  registerAskTools();
  registerMemoryTools();
  registerScheduleTools();
  registerForgeTools();
  registerGameTools();
  registerStoryTools();
  registerGameContext();
  registerBrowserTools();
  registerBrowserFillTools();
  registerVaultTools();
  registerPendingTools();
  registerFileTools();
  registerAssistTools();
  registerDisplayTools();
}
