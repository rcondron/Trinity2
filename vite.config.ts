import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { readOrCreateProxyKey } from "./server/src/proxy-key.js";

const ENGINE_PORT = process.env.PORT || "8799";
const HERE = fileURLToPath(new URL(".", import.meta.url));
/** The engine's data folder (server/src/config.ts DATA_DIR). */
const DATA_DIR = process.env.TRINITY_DATA_DIR ? resolve(process.env.TRINITY_DATA_DIR) : resolve(HERE, "data");

export default defineConfig(({ command }) => {
  // What the proxy adds to every request it passes to the engine: the engine takes a browser's cookie only with it
  // (auth.ts), so a different program on this port can't use the cookie. (Not needed to build the pages.)
  const toEngine = command === "serve" ? { "x-trinity-proxy": readOrCreateProxyKey(DATA_DIR) } : {};
  return {
    root: "web",
    server: {
      port: Number(process.env.WEB_PORT) || 5173,
      // Another program on this port would be on the origin the engine trusts: fail instead of moving to the next one.
      strictPort: true,
      // Same-origin pages only: no CORS answers for pages on other ports.
      cors: false,
      // Serve the app and nothing else: never data/ (keys, the API key, pairing keys), .env, or the rest of the repo.
      fs: { strict: true, allow: [resolve(HERE, "web")] },
      // The engine listens on 127.0.0.1 only; "localhost" can resolve to ::1 on Windows.
      proxy: {
        "/api": { target: `http://127.0.0.1:${ENGINE_PORT}`, changeOrigin: true, headers: toEngine },
        // Prefix match: also carries /ws/workspace (the live workspace channel).
        "/ws": { target: `ws://127.0.0.1:${ENGINE_PORT}`, ws: true, headers: toEngine },
        "/call": { target: `ws://127.0.0.1:${ENGINE_PORT}`, ws: true, headers: toEngine },
      },
    },
    build: {
      outDir: "../dist/web",
      emptyOutDir: true,
      rollupOptions: {
        // Three pages: the talk app, the standalone workspace window, and settings.
        input: {
          main: resolve(HERE, "web/index.html"),
          workspace: resolve(HERE, "web/workspace.html"),
          settings: resolve(HERE, "web/settings.html"),
        },
      },
    },
  };
});
