// Serves the browser fixture pages (scripts/fixtures/browser/*.html) for checking the extension's page-side code in
// a real browser. Two ports on 127.0.0.1 serve the same files: the second is "another origin" — the frame in
// iframe-card.html and the form targets in action-elsewhere.html point at it ({{OTHER}} in the pages).
//
//   node scripts/serve-fixtures.mjs [port] [otherPort]      (defaults 8931 and 8932)
//
// Also served: /ext/page.js (the extension's page code, as it is) and /harness.js (window.trinityTest: probe, fill,
// snapshot, act, total). A POST to any path answers with the field NAMES that arrived — never what was typed.
//
// scripts/e2e-extension.mjs uses `fixtureServer` below to serve the same pages over https (fills need https and an
// exact origin) and over plain http (where fills must be refused).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "browser");
const PAGE_JS = path.join(here, "..", "extension", "page.js");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const pages = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort();
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * One fixture server. `self` is its own origin ("https://127.0.0.1:8862"), `other` the origin the pages' {{OTHER}}
 * points at. With `tls` ({key, cert}) it is https. `onPost` hears of every form that arrives: its path and the field
 * names, and how many of them held something — never a value. Resolves once it listens.
 */
export function fixtureServer({ port, self, other, tls = null, onPost = null, quiet = false }) {
  const handler = (req, res) => {
    const url = new URL(req.url ?? "/", self);
    const send = (status, type, body) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(body);
    };
    if (req.method === "POST") {
      // What a form sent, as names only.
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size <= 64 * 1024) chunks.push(c);
      });
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const names = [...form.keys()];
        if (onPost) onPost({ origin: self, path: url.pathname, names, nonEmpty: [...form.values()].filter((v) => v !== "").length });
        send(200, TYPES[".html"], `<!doctype html><title>Received</title><h1>${escapeHtml(url.pathname)} on ${escapeHtml(self)} received a form</h1><p>Fields: ${escapeHtml(names.join(", ") || "(none)")}</p><p><a href="/">Back to the fixtures</a></p>`);
      });
      return;
    }
    if (req.method !== "GET") return send(405, "text/plain", "GET or POST only");
    if (url.pathname === "/") {
      const list = pages()
        .map((f) => `<li><a href="/${f}">${f}</a></li>`)
        .join("");
      return send(200, TYPES[".html"], `<!doctype html><title>Trinity browser fixtures</title><h1>Trinity browser fixtures</h1><p>This origin: ${self} — the other origin: ${other}</p><ul>${list}</ul>`);
    }
    if (url.pathname === "/ext/page.js") return send(200, TYPES[".js"], fs.readFileSync(PAGE_JS));
    const name = path.basename(url.pathname);
    const file = path.join(FIXTURES, name);
    if (!/^[\w.-]+\.(html|js)$/.test(name) || !fs.existsSync(file)) return send(404, "text/plain", "not found");
    let body = fs.readFileSync(file, "utf8");
    if (name.endsWith(".html")) body = body.replaceAll("{{OTHER}}", other).replaceAll("{{SELF}}", self);
    send(200, TYPES[path.extname(name)] ?? "application/octet-stream", body);
  };
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      if (!quiet) console.log(`fixtures on ${self}/  (its other origin: ${other})`);
      resolve(server);
    });
  });
}

// As a program: two plain-http servers that are each other's "other origin".
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.argv[2]) || 8931;
  const OTHER_PORT = Number(process.argv[3]) || 8932;
  const at = (p) => `http://127.0.0.1:${p}`;
  await fixtureServer({ port: PORT, self: at(PORT), other: at(OTHER_PORT) });
  await fixtureServer({ port: OTHER_PORT, self: at(OTHER_PORT), other: at(PORT) });
}
