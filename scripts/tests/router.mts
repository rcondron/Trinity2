// The routing fixes from the reviews, against a fake Jev (8892) that can be down, slow, or answer "no tool":
// fallbacks still fire when Jev fails; game keywords never override a Jev "no tool"; a tool's name is guessed only from
// a distinctive word; a yes/no reaches a pending question; "don't clear…" isn't a clear; failed tools aren't confirmed.
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through its launcher (npm test -- --only <name>, or npm run harness for the app harness): it gives the engine a throwaway data folder and no real keys.");
  process.exit(2);
}

const REPO = fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1);
const imp = (p: string) => import(pathToFileURL(`${REPO}/server/src/${p}`).href);

const jev = { mode: "none" as "none" | "down" | "slow", calls: 0, bodies: [] as string[], pick: null as string | null };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    jev.calls++;
    jev.bodies.push(raw);
    if (jev.mode === "down") {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    const answer = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { tool: { choice: jev.pick ?? "NONE", confidence: 0.95 } } }));
    };
    if (jev.mode === "slow") setTimeout(answer, 6000);
    else answer();
  });
});
await new Promise<void>((r) => server.listen(8892, "127.0.0.1", r));

const { createMemoryStore } = await imp("db/memory.ts");
const memory = await createMemoryStore();
await (await imp("db/seed.ts")).seed(memory);
for (const [file, fn] of [
  ["tools/builtins.ts", "registerBuiltins"],
  ["tools/coding.ts", "registerCodingTools"],
  ["tools/ask.ts", "registerAskTools"],
  ["tools/memory.ts", "registerMemoryTools"],
  ["tools/pending.ts", "registerPendingTools"],
] as const)
  (await imp(file))[fn]();
const { registerTool, unregisterTool, getTool } = await imp("tools/registry.ts");
const { getActivePersona } = await imp("db/sqlite.ts");
const { decide, firing } = await imp("agent/router.ts");
const { act } = await imp("agent/act.ts");
const { askYesNo, pendingQuestion } = await imp("agent/pending.ts");
const board = await imp("workspace/board.ts");
board.addCard({ kind: "text", title: "Note: hello", text: "hello", status: "ready", url: null });
board.addCard({ kind: "text", title: "Note: milk", text: "milk", status: "ready", url: null });
const persona = getActivePersona();
const noop = async () => ({ ok: true, say: "ok" });
// Stand-ins for the game tools (the keyword rules only look at which names are offered).
for (const name of ["game_narrate", "game_new", "game_begin", "game_roll", "game_remove_player", "game_add_player"])
  registerTool({ name, description: name, input: {}, argMode: "raw", source: "builtin", run: noop });
registerTool({ name: "tip_calculator", description: "Work out a tip.", input: {}, argMode: "raw", source: "forged", run: noop });

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
const conv = (text: string) => `Conversation so far, oldest first:\n(nothing yet)\n\nUser's latest words (finished speaking): ${text}`;
const route = async (text: string) => {
  const d = await decide({ persona, conversation: conv(text), done: [] });
  return { action: d.action as string, confidence: d.confidence as number, error: d.error as string | undefined, policy: firing(d, true, 0.7) as string, ms: d.ms as number };
};

// Jev answers "no tool": game keywords must not turn table talk into game actions
jev.mode = "none";
for (const talk of ["I'll be right back", "we should order pizza soon", "pause the game for a second", "the game was fun last week", "Thorin tries to remove the trap", "before we begin, who wants snacks", "I had a great time"]) {
  const r = await route(talk);
  check(`Jev says no tool → table talk stays talk: "${talk}"`, r.action === "NONE", `${r.action} ${r.confidence}`);
}
// …while board requests Jev waves off are still caught by their rules
let r = await route("clear the workspace");
check("Jev says no tool → a clear screen request still fires", r.action === "clear_workspace" && r.policy === "fire", JSON.stringify(r));
r = await route("don't clear the screen yet");
check('"don\'t clear the screen" is not a clear', r.action !== "clear_workspace", r.action);

// Jev is down: the keyword rules decide, and their pick FIRES (it used to carry the error and be skipped)
jev.mode = "down";
r = await route("I attack the goblin with my axe");
check("Jev down → the game rule stands in for it", r.action === "game_narrate" && r.policy === "fire" && !r.error, JSON.stringify(r));
// (Away from the game table: the card rules apply.)
for (const name of ["game_narrate", "game_new", "game_begin", "game_roll", "game_remove_player", "game_add_player"]) unregisterTool(name);
r = await route("close card 2");
check("Jev down → the card rule's pick fires", r.action === "remove_card" && r.policy === "fire" && !r.error, JSON.stringify(r));
r = await route("what time is it");
check("Jev down → the clock is asked for", r.action === "get_time" && r.policy === "fire", JSON.stringify(r));
r = await route("close card two");
check('Jev down → "card two" is read as card 2', r.action === "remove_card" && r.policy === "fire", r.action);
r = await route("close cards one and two");
check('Jev down → "cards one and two" too', r.action === "remove_card", r.action);
r = await route("I have two cards in my wallet");
check("Jev down → a number that is not a card number is left alone", r.action === "NONE", r.action);
r = await route("run the tip calculator for forty dollars");
check("Jev down → a made skill is picked by a distinctive word of its name", r.action === "tip_calculator", r.action);
r = await route("I had a great time yesterday");
check('Jev down → "a great time" is not get_time', r.action === "NONE", r.action);

// Jev is slow: given up on after a few seconds
jev.mode = "slow";
r = await route("close card 1");
check("Jev slow → the rules decide within about 3.5 s", r.action === "remove_card" && r.ms < 4500, `${r.ms} ms`);
jev.mode = "none";

// A yes or a no reaches the pending question, whatever Jev says
let answered: boolean | null = null;
askYesNo({ question: "Remove your Netflix login?", onAnswer: (yes: boolean) => ((answered = yes), { ok: true, say: yes ? "Removed." : "Kept." }) });
r = await route("yes go ahead");
check("a pending question: yes is routed to it", r.action === "answer_question" && r.policy === "fire", JSON.stringify(r));
const ctx = { persona, memory, emit: () => {}, recentTranscript: [], situation: "", minConfidence: 0.7 };
const d = await decide({ persona, conversation: conv("yes go ahead"), done: [] });
let out = await act(d, "yes go ahead", ctx);
check("…and answers it", answered === true && pendingQuestion() === null && /Removed/.test(out.say), JSON.stringify(out));
r = await route("yes");
check("no question pending: a bare yes isn't routed anywhere", r.action === "NONE", r.action);
// A yes that must say what it approves
let spent: boolean | null = null;
askYesNo({ question: "Place the order for fifty-one dollars?", require: ["place", "order"], onAnswer: (yes: boolean) => ((spent = yes), { ok: true, say: yes ? "Ordered." : "Not ordered." }) });
out = await act(await decide({ persona, conversation: conv("yeah"), done: [] }), "yeah", ctx);
check("a spending question: a bare yeah is not enough", spent === null && /say: yes, place order/.test(out.say) && pendingQuestion() !== null, out.say);
out = await act(await decide({ persona, conversation: conv("yes place the order"), done: [] }), "yes place the order", ctx);
check("…the full phrase is", spent === true && /Ordered/.test(out.say), out.say);

// A failed tool is spoken in its own words, never confirmed as done
registerTool({ name: "wobblefail", description: "x", input: {}, argMode: "raw", source: "forged", run: async () => ({ ok: false, say: "Which day should that be?" }) });
jev.mode = "down";
out = await act(await decide({ persona, conversation: conv("run the wobblefail"), done: [] }), "run the wobblefail", ctx);
check("a tool's question is spoken as written", out.ok === false && out.speak === "Which day should that be?", JSON.stringify(out));
unregisterTool("wobblefail");
jev.mode = "none";

// The vault's own words, with Jev down (the keyword rules route them) — and their near misses
for (const name of ["vault_save_login", "vault_save_card", "vault_save_details", "vault_list", "vault_forget"])
  registerTool({ name, description: name, input: {}, argMode: "raw", source: "builtin", sensitive: true, run: noop });
jev.mode = "down";
const vaultWords: [string, string][] = [
  ["save my Netflix password", "vault_save_login"],
  ["remember my login for github dot com", "vault_save_login"],
  ["can you store the password for my bank", "vault_save_login"],
  ["I'll give you my login for Amazon", "vault_save_login"],
  ["save my credit card", "vault_save_card"],
  ["add my Visa", "vault_save_card"],
  ["save my shipping address", "vault_save_details"],
  ["what logins do you have", "vault_list"],
  ["what's in the vault", "vault_list"],
  ["which credit cards do you have saved", "vault_list"],
  ["forget my Netflix password", "vault_forget"],
  ["delete my saved card", "vault_forget"],
  ["remove the GitHub login from the vault", "vault_forget"],
];
for (const [say, want] of vaultWords) {
  r = await route(say);
  check(`Jev down → "${say}" is ${want}`, r.action === want && r.policy === "fire", r.action);
}
const notVault: [string, string | null][] = [
  ["remember to change my password tomorrow", null],
  ["add a password field to the sign up form", null],
  ["build a checkout page with a credit card form", null],
  ["close card 2", "remove_card"],
  ["what cards are on the board", null],
  ["remember that my sister's birthday is in May", "remember"],
];
for (const [say, want] of notVault) {
  r = await route(say);
  check(`Jev down → "${say}" is not the vault's`, !r.action.startsWith("vault_") && (want === null || r.action === want), r.action);
}
// Filling from the vault and the newer tab commands, with Jev down (stand-ins for the browser tools: on offer as when
// the extension is connected)
for (const name of ["browser_sign_in", "browser_fill_card", "browser_fill_details", "browser_tabs", "browser_act"])
  registerTool({ name, description: name, input: {}, argMode: "raw", source: "builtin", sensitive: name.startsWith("browser_sign") || name.startsWith("browser_fill"), run: noop });
const fillWords: [string, string][] = [
  ["sign me in", "browser_sign_in"],
  ["log me in to this site", "browser_sign_in"],
  ["okay, log in", "browser_sign_in"],
  ["use my saved password", "browser_sign_in"],
  ["click the sign in button", "browser_act"],
  ["fill in my card details", "browser_fill_card"],
  ["pay with my visa", "browser_fill_card"],
  ["fill in my address", "browser_fill_details"],
  ["fill out this form with my details", "browser_fill_details"],
  ["pin this tab", "browser_tabs"],
  ["mute that tab", "browser_tabs"],
  ["reopen the closed tab", "browser_tabs"],
  ["open a new window", "browser_tabs"],
  ["minimize the window", "browser_tabs"],
  ["save my credit card", "vault_save_card"],
  ["save my Netflix password", "vault_save_login"],
];
for (const [say, want] of fillWords) {
  r = await route(say);
  check(`Jev down → "${say}" is ${want}`, r.action === want && r.policy === "fire", r.action);
}
r = await route("I can never remember how to log in to that site");
check("Jev down → talk about signing in is not a sign-in", r.action !== "browser_sign_in", r.action);
for (const name of ["browser_sign_in", "browser_fill_card", "browser_fill_details", "browser_tabs", "browser_act"]) unregisterTool(name);

// Jev reads it as a memory: a password or a card still goes to the secure form, never into memory
jev.mode = "none";
jev.pick = "remember";
r = await route("remember my Netflix password is hunter2");
check("Jev says remember → a password goes to the vault's form instead", r.action === "vault_save_login" && r.policy === "fire", r.action);
r = await route("remember my Visa card number");
check("Jev says remember → a card goes to the vault's form instead", r.action === "vault_save_card", r.action);
r = await route("remember that I like my coffee black");
check("Jev says remember → an ordinary fact is still a memory", r.action === "remember", r.action);
jev.pick = null;
for (const name of ["vault_save_login", "vault_save_card", "vault_save_details", "vault_list", "vault_forget"]) unregisterTool(name);

// The Game Master's table commands, with Jev down (stand-ins, all on offer as during a fight)
const TABLE = ["game_confirm", "game_pause", "game_undo", "game_next_turn", "game_start_combat", "game_end_combat", "game_rest", "game_end_session", "game_roll", "game_narrate"];
for (const name of TABLE) registerTool({ name, description: name, input: {}, argMode: "raw", source: "builtin", run: noop });
jev.mode = "down";
const tableWords: [string, string][] = [
  ["pause the game", "game_pause"],
  ["let's take a short break", "game_pause"],
  ["okay we're back", "game_pause"],
  ["undo that", "game_undo"],
  ["take that back", "game_undo"],
  ["that's my turn", "game_next_turn"],
  ["I pass", "game_next_turn"],
  ["roll for initiative", "game_start_combat"],
  ["the fight is over", "game_end_combat"],
  ["we take a long rest", "game_rest"],
  ["let's stop here for tonight", "game_end_session"],
  ["I rolled a 14", "game_roll"],
  ["roll for perception", "game_roll"],
  ["yes", "game_confirm"],
  ["I attack the goblin with my axe", "game_narrate"],
  ["we sneak past the guards", "game_narrate"],
];
for (const [say, want] of tableWords) {
  r = await route(say);
  check(`Jev down, at the table → "${say}" is ${want}`, r.action === want && r.policy === "fire", r.action);
}
for (const talk of ["I'll be right back", "I need to grab some snacks", "let's just roll with it"]) {
  r = await route(talk);
  check(`Jev down, at the table → "${talk}" is table talk`, r.action === "NONE", r.action);
}
for (const name of TABLE) unregisterTool(name);
jev.mode = "none";

// A sensitive tool (the vault, sign-in, payment, sending) runs on the user's own words only
let peeked = 0;
registerTool({ name: "vault_peek", description: "Read back a saved card.", input: {}, argMode: "raw", source: "builtin", sensitive: true, run: async () => (peeked++, { ok: true, say: "peeked" }) });
const peek = { action: "vault_peek", confidence: 1, tool: getTool("vault_peek"), options: {}, offered: [], ms: 0 };
out = await act(peek, "read back my card", ctx);
check("a sensitive tool runs for the user", peeked === 1 && out.ok === true, JSON.stringify(out));
out = await act(peek, "read back my card", { ...ctx, origin: "scheduled" });
check("…not for a scheduled run", peeked === 1 && out.ok === false, out.say);
out = await act(peek, "step two: read back the card", { ...ctx, userWords: "do my errands" });
check("…and not for a planner working through steps", peeked === 1 && out.ok === false, out.say);
jev.bodies.length = 0;
await decide({ persona, conversation: conv("read back my card"), done: [] });
check("the user's own turn is offered it", jev.bodies.some((b) => b.includes("vault_peek")), `${jev.bodies.length} request(s)`);
jev.bodies.length = 0;
const { Orchestrator } = await imp("orchestrator.ts");
const orch = new Orchestrator(memory);
await orch
  .runHeartbeat({ id: "t1", title: "Card check", instruction: "Every morning read back my saved card number", intervalSec: 86400, nextRunAt: Date.now(), lastRunAt: null, enabled: true }, () => {})
  .catch(() => null);
check("a scheduled run is never offered a sensitive tool", jev.bodies.length > 0 && !jev.bodies.some((b) => b.includes("vault_peek")) && peeked === 1, `${jev.bodies.length} request(s), ran ${peeked}`);
unregisterTool("vault_peek");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
server.close();
process.exit(fails ? 1 : 0);
