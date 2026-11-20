// The real app in a real browser with nothing real behind it:   npm run harness   →   http://127.0.0.1:8898/
//
// For looking at the pages, the board, Settings and the voice path without the GPU pod, the keys or your own data. It
// starts stand-ins for the routing model, the model gateway, the transcriber and the voice model (it "speaks" a steady
// tone and echoes the words it is given), runs the engine in this process's child on port 8897 with a throwaway data
// folder, and serves the built web app on 8898. Typed turns work end to end; the microphone is heard by nobody.
// See scripts/tests/app-harness.mts. It uses ports 8892–8898: don't run it beside `npm test`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(ROOT, "dist", "web", "index.html"))) {
  console.error("Build the web app first:  npm run build:web");
  process.exit(1);
}
// (A harness that was killed leaves its folder behind; only one can run at a time, so any found now is stale.)
for (const name of fs.readdirSync(os.tmpdir())) if (name.startsWith("trinity-harness-")) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trinity-harness-"));
fs.writeFileSync(path.join(dir, "empty.env"), "");
const env = {
  ...process.env,
  TRINITY_TEST: "1",
  TRINITY_DATA_DIR: dir,
  DOTENV_CONFIG_PATH: path.join(dir, "empty.env"),
  TRINITY_ORIGINS: "http://127.0.0.1:8898",
  TYPESAFE_URL: "http://127.0.0.1:8892",
  TYPESAFE_API_KEY: "test",
  MORDIEM_URL: "http://127.0.0.1:8893",
  MORDIEM_API_KEY: "test",
  BRAIN_MODEL: "brain-x",
  FAST_MODEL: "fast-x",
  REPLY_MODEL: "reply-x",
  PLANNER_MODEL: "plan-x",
  CHAT_MODEL: "",
  CHAT_BACKUP_MODEL: "backup-x",
  DEEPGRAM_URL: "ws://127.0.0.1:8894/v1/listen",
  DEEPGRAM_API_KEY: "test",
  PERSONAPLEX_WS_URL: "ws://127.0.0.1:8895",
  // Nothing inherited from the shell may reach a real service or change who is let in.
  ...Object.fromEntries(["SERPAPI_KEY", "SERPAPI_API_KEY", "FAL_KEY", "TAVILY_API_KEY", "MORPH_API_KEY", "TRINITY_API_KEY", "TRINITY_AUTH", "TRINITY_FETCH_ALLOW"].map((k) => [k, ""])),
};
console.log(`data folder: ${dir} (thrown away when you stop the harness)`);
const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "scripts", "tests", "app-harness.mts")], { cwd: ROOT, env, stdio: "inherit" });
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("close", (code) => {
  fs.rm(dir, { recursive: true, force: true }, () => process.exit(code ?? 0));
});
