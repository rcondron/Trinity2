/*
 * The assistant's routing library — things a person says to Trinity in a day, and the tool each should reach.
 *
 * Each phrase goes through the real router (Jev with a TypeSafe key, then the second opinion; the keyword rules
 * without a key) with every tool family on offer, as on a call with the browser extension connected, a few cards on
 * the board, files saved and a reminder set. Nothing is run: this measures who is picked and how long the decision
 * takes. Pairs that are easy to confuse are in on purpose (forget a memory / forget a login, read a card / a file /
 * a page / an email, a reminder / a meeting). It never touches the engine's data: everything lives in a temporary
 * folder, and nothing is sent anywhere but the routing model and, for the second opinion, the model gateway.
 *
 *   npm run eval:assistant                          everything
 *   npm run eval:assistant -- --only vault,files    some families (talk know memory reminders vault browser fill mail
 *                                                   calendar travel files board cards display media skills voice
 *                                                   confusable)
 *   npm run eval:assistant -- --verbose             every decision, not just the misses
 *   npm run eval:assistant -- --tools               list the tools on offer and stop
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATA = mkdtempSync(path.join(tmpdir(), "trinity-eval-assistant-"));
process.env.TRINITY_DATA_DIR = DATA;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = (p: string) => import(pathToFileURL(path.join(ROOT, "server/src", p)).href);

/** The temporary folder goes when the run ends (the memory store may still hold it open: the OS clears temp folders). */
function tidy(): void {
  try {
    rmSync(DATA, { recursive: true, force: true });
  } catch {
    /* still held open */
  }
}

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 ? new Set(String(argv[i + 1] ?? "").split(",").filter(Boolean)) : null;
})();
const verbose = argv.includes("--verbose");

const board = await load("workspace/board.ts");
const { decide, firing, visibleTools } = await load("agent/router.ts");
const { getEndpoints, live } = await load("settings.ts");
const { getTools, registerTool } = await load("tools/registry.ts");
const { createMemoryStore } = await load("db/memory.ts");
(await load("tools/all.ts")).registerAllTools();
await createMemoryStore();

// Everything is on offer, as on a day when the extension is connected, something is saved in the vault, files exist
// and a reminder is set — except the yes/no answer (only offered while a question is pending) and the Game Master's
// tools (their persona's). A tool's own `available` would hide most of them in this empty folder.
type Tool = { name: string; toolset?: string; available?: unknown; description: string };
for (const t of getTools() as Tool[]) if (!t.toolset && t.name !== "answer_question" && t.available) registerTool({ ...t, available: undefined });

const persona = { id: "trinity", name: "Trinity", description: "You are Trinity.", voicePrompt: "", voice: "NATF2", traits: { role: "general companion & agent" }, toolsets: [], updatedAt: 0 };
board.addCard({ kind: "text", title: "Note: shopping", text: "milk, bread", status: "ready", url: null });
board.addCard({ kind: "widget", title: "Pomodoro timer", text: "", status: "ready", url: null, html: "<!-- title: Pomodoro timer --><button>Start</button><div>25:00</div>" });
board.addCard({ kind: "image", title: "A red fox", text: "", status: "ready", url: "/api/images/fox.png" });

const offered = (visibleTools(persona) as Tool[]).map((t) => t.name);
if (argv.includes("--tools")) {
  console.log(`${offered.length} tools on offer:\n${offered.join(" ")}`);
  tidy();
  process.exit(0);
}

/** [family, what is said, the tool it should reach — or several that would each be right]. NONE = just talk. */
const CASES: [string, string, string | string[]][] = [
  // Talk: nothing should fire
  ["talk", "How are you doing today?", "NONE"],
  ["talk", "That's really interesting.", "NONE"],
  ["talk", "I had a long day at work.", "NONE"],
  ["talk", "Thanks, that's all for now.", "NONE"],
  ["talk", "Honestly I'm not sure what I want for dinner.", "NONE"],
  ["talk", "Tell me a joke.", ["NONE", "ask_brain"]],
  // Knowing things
  ["know", "What's the capital of Australia?", ["ask_brain", "NONE"]],
  ["know", "How many ounces are in a pound?", ["ask_brain", "NONE"]],
  ["know", "What time is it?", "get_time"],
  ["know", "What's today's date?", "get_time"],
  ["know", "Search the web for the latest news on the Mars mission.", ["web_search", "show_card"]],
  ["know", "Look up the best pizza places in Chicago.", ["web_search", "show_card"]],
  // Memory and history
  ["memory", "Remember that my sister's birthday is March third.", "remember"],
  ["memory", "Please remember I parked on level four.", "remember"],
  ["memory", "I'm vegetarian, by the way.", ["update_profile", "remember"]],
  ["memory", "From now on, always use Celsius.", ["update_profile", "remember"]],
  ["memory", "When is my sister's birthday?", "recall"],
  ["memory", "Do you remember where I parked?", "recall"],
  ["memory", "Forget what I told you about my diet.", "forget"],
  ["memory", "What did we talk about yesterday?", "search_conversations"],
  ["memory", "Find the conversation where I mentioned the dentist.", "search_conversations"],
  // Reminders
  ["reminders", "Remind me to call the dentist tomorrow at nine.", "schedule"],
  ["reminders", "Every morning at eight, tell me the weather.", "schedule"],
  ["reminders", "What reminders do I have?", "list_reminders"],
  ["reminders", "Cancel the dentist reminder.", "cancel_reminder"],
  ["reminders", "Move the dentist reminder to ten o'clock.", "change_reminder"],
  // The vault
  ["vault", "Save my Netflix password.", "vault_save_login"],
  ["vault", "I need to give you my bank login.", "vault_save_login"],
  ["vault", "Save my credit card.", "vault_save_card"],
  ["vault", "Save my shipping address for filling in forms.", "vault_save_details"],
  ["vault", "What logins do you have saved?", "vault_list"],
  ["vault", "Forget my Netflix login.", "vault_forget"],
  ["vault", "Delete my saved credit card.", "vault_forget"],
  // The browser
  ["browser", "Open YouTube.", "browser_open"],
  ["browser", "Go to amazon dot com.", "browser_open"],
  ["browser", "Close this tab.", "browser_tabs"],
  ["browser", "Switch to the Gmail tab.", "browser_tabs"],
  ["browser", "What does this page say?", "browser_read"],
  ["browser", "Summarize this article for me.", "browser_read"],
  ["browser", "Click the sign in button.", "browser_act"],
  ["browser", "Scroll down a bit.", "browser_act"],
  ["browser", "Type hello world into the search box.", "browser_act"],
  ["browser", "Make this page dark mode.", "browser_modify"],
  ["browser", "Hide the ads on this page.", "browser_modify"],
  ["browser", "Save this page as a PDF.", "browser_save"],
  ["browser", "Put this page on the board.", "browser_share"],
  // Filling from the vault
  ["fill", "Sign me in to this site.", "browser_sign_in"],
  ["fill", "Log in to Netflix for me.", ["browser_sign_in", "browser_open"]],
  ["fill", "Fill in my card details.", "browser_fill_card"],
  ["fill", "Pay with my Visa.", "browser_fill_card"],
  ["fill", "Fill in my address.", "browser_fill_details"],
  ["fill", "Fill out this form with my details.", "browser_fill_details"],
  // Email
  ["mail", "Check my email.", "check_email"],
  ["mail", "Do I have any new emails?", "check_email"],
  ["mail", "Read me the email from Sarah.", ["read_email", "check_email"]],
  ["mail", "Write an email to John saying I'll be ten minutes late.", "draft_email"],
  ["mail", "Reply to that one and say thanks.", "draft_email"],
  // Calendar and meetings
  ["calendar", "What's on my calendar today?", "check_calendar"],
  ["calendar", "Am I free tomorrow afternoon?", "check_calendar"],
  ["calendar", "Schedule a meeting with Dana on Friday at two.", "schedule_meeting"],
  ["calendar", "Set up a call with the team next Tuesday at ten.", "schedule_meeting"],
  // Travel and shopping
  ["travel", "Find me flights to Denver next Friday.", "show_card"],
  ["travel", "Show me hotels in Austin for next weekend.", "show_card"],
  ["travel", "Book the second flight.", "open_booking"],
  ["travel", "Find me a good pair of running shoes under a hundred dollars.", "show_card"],
  // Files
  ["files", "Write a one page summary of our plan as a PDF.", "make_document"],
  ["files", "Make a document about the history of jazz.", "make_document"],
  ["files", "Create a spreadsheet of my monthly expenses.", "make_spreadsheet"],
  ["files", "Save that note as a text file called shopping.", "save_file"],
  ["files", "What files do I have?", "list_files"],
  ["files", "Open the expenses spreadsheet.", "open_file"],
  ["files", "Read me the notes file.", "read_file"],
  ["files", "Delete the old report file.", "delete_file"],
  ["files", "Rename the report to final report.", "rename_file"],
  // The board
  ["board", "Clear the board.", "clear_workspace"],
  ["board", "Undo that.", "undo_workspace"],
  ["board", "What's on the board right now?", "describe_workspace"],
  ["board", "Close card two.", "remove_card"],
  ["board", "Move the timer to the top right.", "move_card"],
  ["board", "Arrange the cards in a grid.", "arrange_cards"],
  ["board", "Make card one bigger.", "resize_card"],
  // Working with cards
  ["cards", "Start the timer.", "control_card"],
  ["cards", "Read me the shopping note.", "read_card"],
  ["cards", "Add eggs to the shopping note.", "edit_note"],
  ["cards", "Rename card three to fox.", "rename_card"],
  ["cards", "Duplicate the timer.", "duplicate_card"],
  ["cards", "Make the timer's background blue.", "edit_html"],
  // Engine-drawn cards
  ["display", "Put those numbers in a table.", "show_table"],
  ["display", "Make a bar chart of sales: January 10, February 15, March 12.", "show_chart"],
  ["display", "Show that as a pie chart.", "show_chart"],
  ["display", "Show me the code for card two.", "show_code"],
  ["display", "Show the meeting notes as a document.", "show_document"],
  ["display", "That build failed, try it again.", "retry_card"],
  // Making things
  ["media", "Draw me a picture of a lighthouse at dusk.", "make_image"],
  ["media", "Make a short video of waves on a beach.", "make_video"],
  ["media", "Write a note that says call the plumber.", "make_text"],
  ["media", "Build me a habit tracker.", "build_ui"],
  ["media", "Show me a recipe for banana bread.", "show_card"],
  ["media", "What's in the news today?", ["show_card", "web_search"]],
  // Skills and working things out
  ["skills", "Create a skill that converts currencies.", "create_skill"],
  ["skills", "What skills do you have?", "list_skills"],
  ["skills", "The currency skill is giving wrong answers, fix it.", "fix_skill"],
  ["skills", "Figure out how to track my package from the post office.", "figure_out"],
  // Her own voice
  ["voice", "Speak a little slower.", "set_speech_rate"],
  ["voice", "Talk faster please.", "set_speech_rate"],
  // Easy to confuse
  ["confusable", "Forget my password for Netflix.", "vault_forget"],
  ["confusable", "Forget that I like jazz.", "forget"],
  ["confusable", "Remember my Netflix password.", "vault_save_login"],
  ["confusable", "Read the file called notes.", "read_file"],
  ["confusable", "Read card one.", "read_card"],
  ["confusable", "Read this page to me.", "browser_read"],
  ["confusable", "Read my latest email.", ["read_email", "check_email"]],
  ["confusable", "Open the report file.", "open_file"],
  ["confusable", "Open Reddit.", "browser_open"],
  ["confusable", "Write a quick note about the meeting.", "make_text"],
  ["confusable", "Write up the meeting as a Word document.", "make_document"],
  ["confusable", "Save this page.", "browser_save"],
  ["confusable", "Remind me about lunch with Sam tomorrow at noon.", "schedule"],
  ["confusable", "Put lunch with Sam on my calendar for tomorrow at noon.", "schedule_meeting"],
  ["confusable", "What's on my screen?", ["describe_workspace", "browser_read"]],
  ["confusable", "Close everything.", ["clear_workspace", "remove_card", "browser_tabs"]],
];

const conv = (u: string) => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (finished speaking): ${u}`;
const min = getEndpoints().minConfidence;
console.log(
  `assistant routing library — ${live.jev ? "Jev" : "keyword rules (no TypeSafe key)"}${live.mordiem ? " + second opinion" : ""}, ${offered.length} tools on offer, fires at ${Math.round(min * 100)}%\n`,
);

const tally = new Map<string, { n: number; ok: number }>();
const times: number[] = [];
const misses: string[] = [];
const unknown = new Set<string>();
for (const [cat, say, wanted] of CASES) {
  if (only && !only.has(cat)) continue;
  const want = Array.isArray(wanted) ? wanted : [wanted];
  for (const w of want) if (w !== "NONE" && !offered.includes(w)) unknown.add(w);
  const t0 = Date.now();
  const d = await decide({ persona, conversation: conv(say), done: [] });
  const ms = Date.now() - t0;
  times.push(ms);
  const fires = firing(d, true, min) === "fire";
  const got = fires ? (d.action as string) : "NONE";
  const ok = want.includes(got);
  const row = tally.get(cat) ?? { n: 0, ok: 0 };
  row.n++;
  if (ok) row.ok++;
  tally.set(cat, row);
  const line = `${ok ? "ok  " : "MISS"} ${cat.padEnd(10)} ${JSON.stringify(say).padEnd(64)} → ${got.padEnd(20)} ${String(Math.round((d.confidence as number) * 100)).padStart(3)}% ${String(ms).padStart(5)} ms${ok ? "" : `   wanted ${want.join(" or ")}${fires ? "" : ` (picked ${d.action as string}, under the gate)`}`}`;
  if (!ok) misses.push(line);
  if (verbose || !ok) console.log(line);
}

const sorted = [...times].sort((a, b) => a - b);
const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
let n = 0;
let ok = 0;
console.log("");
for (const [cat, row] of tally) {
  n += row.n;
  ok += row.ok;
  console.log(`${cat.padEnd(11)} ${String(row.ok).padStart(3)} / ${row.n}`);
}
console.log(`\n${ok} of ${n} right (${n ? Math.round((100 * ok) / n) : 0}%) · decision time: median ${at(0.5)} ms, 9 in 10 under ${at(0.9)} ms, slowest ${sorted[sorted.length - 1] ?? 0} ms`);
if (unknown.size) console.log(`\nnot registered here (their cases can only miss): ${[...unknown].join(", ")}`);
tidy();
process.exit(misses.length ? 1 : 0);
