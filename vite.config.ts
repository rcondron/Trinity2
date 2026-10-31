import { defineConfig } from "vite";

const ENGINE_PORT = process.env.PORT || "8799";

export default defineConfig({
  root: "web",
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    proxy: {
      "/api": { target: `http://localhost:${ENGINE_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${ENGINE_PORT}`, ws: true },
    },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
