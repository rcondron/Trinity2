// Frees the engine/web ports before `npm run dev` / `npm start`.
// On Windows, stopping a `tsx watch` wrapper can orphan the real node process, which
// keeps holding the port AND the PouchDB LOCK file — the next engine then crashes with
// "IO error: LockFile …/data/memory/LOCK". This kills whatever still listens on the
// ports so a fresh start always works. Safe to run when nothing is listening.
import { execSync } from "node:child_process";

const ports = [Number(process.env.PORT) || 8799, ...(process.argv.includes("--web") ? [Number(process.env.WEB_PORT) || 5173] : [])];

function pidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
      return [
        ...new Set(
          out
            .split(/\r?\n/)
            .filter((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
            .map((l) => Number(l.trim().split(/\s+/).pop()))
            .filter((pid) => pid > 0),
        ),
      ];
    }
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" })
      .split(/\s+/)
      .map(Number)
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

for (const port of ports) {
  for (const pid of pidsOnPort(port)) {
    if (pid === process.pid) continue;
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
      console.log(`[free-ports] stopped stale process ${pid} on :${port}`);
    } catch {
      /* already gone */
    }
  }
}
