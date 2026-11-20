// Runs Trinity's offline test suites, one after another, and prints one line each.
//
//   npm test                      every suite
//   npm test -- --only voice      suites whose name contains "voice" (comma-separated list allowed)
//   npm test -- --list            the suites and what each covers
//   npm test -- --verbose         each suite's own output as it runs
//
// Every suite runs in its own process against a throwaway data folder, with no real keys and no real services: the
// voice model, the transcriber, the routing model and the model gateway are fakes on loopback ports. Nothing here
// touches data/, .env, the GPU pod or the engine you may have running (the suites use ports 8890–8898 and 9330–9339).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const VOICE = { PERSONAPLEX_WS_URL: "ws://127.0.0.1:8895", DEEPGRAM_URL: "ws://127.0.0.1:8894/v1/listen", DEEPGRAM_API_KEY: "test" };
const GATEWAY = { MORDIEM_URL: "http://127.0.0.1:8893", MORDIEM_API_KEY: "test", BRAIN_MODEL: "brain-x", FAST_MODEL: "fast-x", REPLY_MODEL: "reply-x", PLANNER_MODEL: "plan-x", CHAT_MODEL: "", CHAT_BACKUP_MODEL: "backup-x" };

const BLANK = ["SERPAPI_KEY", "SERPAPI_API_KEY", "FAL_KEY", "TYPESAFE_API_KEY", "DEEPGRAM_API_KEY", "PERSONAPLEX_WS_URL", "MORPH_API_KEY", "TRINITY_API_KEY", "TRINITY_AUTH", "TRINITY_ORIGINS", "TRINITY_FETCH_ALLOW"];

/** name, file (under scripts/), what it covers, extra environment, time limit in seconds. */
const SUITES = [
  ["auth", "tests/auth.mts", "who may talk to the engine: linked browsers, the API key, the pairing code, every way in that must fail", {}, 120],
  ["settings", "tests/settings.mts", "settings validation, keys bound to their address, stand-ins for models the gateway dropped", { MORDIEM_URL: "http://127.0.0.1:8890", MORDIEM_API_KEY: "env-key", QUICK_CODER: "mercury-3", CARD_MODEL: "mercury-3" }, 120],
  ["router", "tests/router.mts", "routing fallbacks, table talk, tool-name guesses, yes/no questions, failed tools", { TYPESAFE_API_KEY: "test", TYPESAFE_URL: "http://127.0.0.1:8892", MORDIEM_API_KEY: "" }, 150],
  ["voice-talk", "tests/voice-talk.mts", "the polished talk style on a simulated call: brevity, timing, cut-ins, fillers, fallbacks", { ...VOICE, ...GATEWAY, TYPESAFE_API_KEY: "", ROUTE_EVERY_MS: "400", FILLER_AFTER_MS: "500" }, 300],
  ["voice-holds", "tests/voice-holds.mts", "the free talk style: the voice is held from the first words of a request", { ...VOICE, TYPESAFE_API_KEY: "", MORDIEM_API_KEY: "", ROUTE_EVERY_MS: "1000" }, 240],
  ["voice-owed", "tests/voice-owed.mts", "unprompted lines wait for a call that can be heard", { ...VOICE, TYPESAFE_API_KEY: "test" }, 240],
  ["voice-asks", "tests/voice-asks.mts", "which words sound like a request", {}, 60],
  ["text-channel", "tests/text-channel.mts", "typed turns with no live call: the talking brain, the solver hand-off, always a reply", { ...GATEWAY, TYPESAFE_API_KEY: "" }, 120],
  ["pace", "test-time-stretch.mts", "speech pace without a change of pitch; the speaker's queue and catch-up", {}, 300],
  ["cards", "tests/cards.mts", "card skills: operate, read, edit, many at once", {}, 300],
  ["board-arrange", "tests/board-arrange.mts", "laying the board out", {}, 200],
  ["board-resize", "tests/board-resize.mts", "sizing and layering cards", {}, 200],
  ["workspace", "test-workspace.mts", "the board: card identity, one queue per card, nothing loads forever, undo by card, limits, card kinds, two-way cards", {}, 300],
  ["solver", "tests/solver.mts", "the multi-step solver (earlier suite)", {}, 300],
  ["travel", "tests/travel.mts", "shopping and travel cards against fake results", {}, 300],
  ["browser", "tests/browser.mts", "browser tools against a stand-in extension", {}, 300],
  // Suites written with their features in this pass (present once those features are in).
  ["vault", "test-vault.mts", "the vault: encryption, forms, routes, and that no secret ever leaves", {}, 300],
  ["browser-link", "test-browser-link.mts", "extension pairing and the mutual handshake", {}, 300],
  ["browser-fill", "test-browser-fill.mts", "signing in and filling cards from the vault", {}, 300],
  ["game-rules", "test-game-rules.mts", "the Game Master's rules engine", {}, 300],
  ["game-session", "test-game-session.mts", "a scripted multi-player game session", {}, 400],
  ["game-engine", "test-game-engine.mts", "the Game Master's turns, spotlight, combat and undo", {}, 400],
  ["game-compat", "test-game-compat.mts", "games saved before this rebuild still load", {}, 300],
  ["game-board", "test-game-board.mts", "what the game screen is given to draw", {}, 300],
  ["memory", "test-memory.mts", "conversation history, the profile, reflection", {}, 300],
  ["skills", "test-skills.mts", "skills that are counted, repaired and retired", {}, 300],
  ["solver-fixes", "test-solver.mts", "the solver's reviewed defects", {}, 300],
  ["sandbox", "test-sandbox.mts", "the skill sandbox's network guard and the safe fetcher", {}, 300],
  ["reminders", "test-reminders.mts", "reminders by voice", {}, 300],
  ["files", "test-files.mts", "files, documents, spreadsheets, PDFs", {}, 400],
  ["assist", "test-assist.mts", "email, calendar, meetings, booking against fixtures", {}, 400],
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? "").split(",").filter(Boolean) : [];
const picked = SUITES.filter(([name, file]) => fs.existsSync(path.join(ROOT, "scripts", file)) && (!only.length || only.some((o) => name.includes(o))));

if (flag("--list")) {
  for (const [name, file, covers] of SUITES) console.log(`${fs.existsSync(path.join(ROOT, "scripts", file)) ? " " : "-"} ${name.padEnd(14)} ${covers}`);
  console.log("\n(- : the suite's file isn't in this checkout)");
  process.exit(0);
}
if (!picked.length) {
  console.error("no suite matches");
  process.exit(2);
}

function run([name, file, , extra, limitSec]) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trinity-test-${name}-`));
    fs.writeFileSync(path.join(dir, "empty.env"), "");
    const env = {
      ...process.env,
      TRINITY_TEST: "1", // the suites refuse to run without it (they must never see the real data folder)
      TRINITY_DATA_DIR: dir,
      DOTENV_CONFIG_PATH: path.join(dir, "empty.env"),
      MORDIEM_API_KEY: "test",
      TAVILY_API_KEY: "test",
      // Nothing inherited from the shell may reach a real service or change who is let in.
      ...Object.fromEntries(BLANK.map((k) => [k, ""])),
      ...extra,
    };
    const started = Date.now();
    const child = spawn(process.execPath, [TSX, path.join(ROOT, "scripts", file)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (chunk) => {
      out += chunk;
      if (flag("--verbose")) process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill(), limitSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!flag("--keep")) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          /* still held by the suite's process: the sweep at the next run takes it */
        }
      }
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      const checks = lines.filter((l) => /^(ok|PASS)\b/.test(l)).length;
      const failed = lines.filter((l) => /^(FAIL|BAD)\b/.test(l));
      resolve({ name, ok: code === 0, code, checks, failed, last: lines[lines.length - 1] ?? "", ms: Date.now() - started });
    });
  });
}

// (A run that was killed leaves its folders behind: clear those more than two hours old.)
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!name.startsWith("trinity-test-")) continue;
  const full = path.join(os.tmpdir(), name);
  try {
    if (Date.now() - fs.statSync(full).mtimeMs > 2 * 3600_000) fs.rmSync(full, { recursive: true, force: true });
  } catch {
    /* in use or already gone */
  }
}

let bad = 0;
for (const suite of picked) {
  const r = await run(suite);
  if (!r.ok) bad++;
  const time = `${(r.ms / 1000).toFixed(0)}s`.padStart(5);
  console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(14)} ${time}  ${r.checks ? `${r.checks} checks` : ""}${r.ok ? "" : `  — ${r.code === null ? "timed out" : `exit ${r.code}`}: ${r.last.slice(0, 120)}`}`);
  if (!r.ok && !flag("--verbose")) for (const line of r.failed.slice(0, 8)) console.log(`        ${line.slice(0, 160)}`);
}
console.log(bad ? `\n${bad} of ${picked.length} suites FAILED` : `\nall ${picked.length} suites passed`);
process.exit(bad ? 1 : 0);
