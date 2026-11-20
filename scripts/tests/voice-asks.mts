// soundsLikeAsk over the card-skill library (all should wait, except the plain talk among them) and over everyday
// conversation (none should wait, except real questions a tool may answer).
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.env.TRINITY_TEST) {
  console.error("Run this through the runner (npm test -- --only <name>): it gives each suite a throwaway data folder and no real keys.");
  process.exit(2);
}

const { soundsLikeAsk } = await import(pathToFileURL(fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1) + "/server/src/agent/arbiter.ts").href);
const src = fs.readFileSync(fileURLToPath(new URL("../../", import.meta.url)).slice(0, -1) + "/scripts/eval-card-skills.mts", "utf8");
const library = [...src.matchAll(/say: "([^"]+)", tool: ([^,]+?),/g)].map((m) => ({ say: m[1]!, tool: m[2]! }));
let fails = 0;
const missed: string[] = [];
for (const c of library) {
  const talk = /"NONE"/.test(c.tool) && !/ask_brain/.test(c.tool);
  const got = soundsLikeAsk(c.say);
  if (got === talk) {
    fails++;
    missed.push(`${talk ? "held talk" : "missed ask"}: ${c.say}`);
  }
}
console.log(`library: ${library.length - fails}/${library.length} classified right`);
for (const m of missed) console.log("   ", m);

const chat = [
  "that's funny",
  "that's really cool",
  "I went to the store today",
  "I think so",
  "yeah that makes sense",
  "no worries",
  "thanks so much",
  "okay sounds good",
  "how are you doing today",
  "how's it going",
  "what's up",
  "can you hear me",
  "are you there",
  "I love that idea",
  "my sister lives in Denver",
  "wow",
  "hmm let me think",
  "that was a long day",
  "I'm back",
  "who are you",
];
const asks = [
  "what's the weather in Austin",
  "what time is it",
  "who won the game last night",
  "how do I make pancakes",
  "remind me to call mom at five",
  "open youtube",
  "search for running shoes on amazon",
  "make me a picture of a fox",
  "build me a pomodoro timer",
  "what did I tell you about my sister",
  "stop",
  "pause",
  "undo",
  "next",
];
let chatHeld = 0;
for (const t of chat) if (soundsLikeAsk(t)) {
  chatHeld++;
  console.log("   held talk:", t);
}
let asksMissed = 0;
for (const t of asks) if (!soundsLikeAsk(t)) {
  asksMissed++;
  console.log("   missed ask:", t);
}
console.log(`everyday talk answered at once: ${chat.length - chatHeld}/${chat.length}`);
console.log(`everyday asks waiting for a decision: ${asks.length - asksMissed}/${asks.length}`);
process.exit(0);
