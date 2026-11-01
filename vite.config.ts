import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const ENGINE_PORT = process.env.PORT || "8799";
const HERE = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "web",
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    // The engine listens on 127.0.0.1 only; "localhost" can resolve to ::1 on Windows.
    proxy: {
      "/api": { target: `http://127.0.0.1:${ENGINE_PORT}`, changeOrigin: true },
      // Prefix match: also carries /ws/workspace (the live workspace channel).
      "/ws": { target: `ws://127.0.0.1:${ENGINE_PORT}`, ws: true },
      "/call": { target: `ws://127.0.0.1:${ENGINE_PORT}`, ws: true },
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
});
