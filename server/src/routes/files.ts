import express, { type Router } from "express";
import { FILE_ID_RE, FILE_KINDS, FileStoreError, deleteFile, describeFile, filePath, getFile, listFiles, storeUsage, type StoredFile } from "../services/files.js";

/**
 * The file store over HTTP (mounted under /api, behind the engine's authentication):
 *
 *   GET    /files             what is saved: each file as FileInfo (id, name, kind, mime, type, size, url, …) and the space used
 *   GET    /files/:id/:name   the file itself (add ?download=1 to always get it as a download)
 *   DELETE /files/:id         delete it
 *
 * The id is the file (sixteen hex digits, nothing else is looked up); the name in the address is there for people and
 * for the browser's download name, and must be the stored one. A file is served with the type of its kind and
 * "nosniff", so it is never taken for something else. PDFs, text, pictures and web pages open in the browser;
 * everything else downloads. A saved web page is served with "Content-Security-Policy: sandbox": it gets an origin of
 * its own and no script, so nothing saved can ever act as the app.
 *
 * A plain GET with nothing but the session cookie is all it takes, so one of the app's pages can open a file in a new
 * tab or link to it (the guard in auth.ts wants that navigation to come from the app: same-origin, with its Referer).
 */

/** inline / attachment with the file's name: an ASCII stand-in, and the real name as RFC 5987 UTF-8. */
function disposition(file: StoredFile, download: boolean): string {
  const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  const utf8 = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${FILE_KINDS[file.kind].inline && !download ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export function filesRouter(): Router {
  const r = express.Router();

  r.get("/files", (_req, res) => {
    try {
      const usage = storeUsage();
      res.json({ files: listFiles().map(describeFile), usedBytes: usage.bytes, limitBytes: usage.limit });
    } catch (err) {
      res.status(500).json({ error: err instanceof FileStoreError ? err.message : "couldn't list the files" });
    }
  });

  r.get("/files/:id/:name", (req, res) => {
    const id = String(req.params.id ?? "");
    if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: "bad file id" });
    let file: StoredFile | null;
    let onDisk: string;
    try {
      file = getFile(id);
      if (!file || file.name !== String(req.params.name ?? "")) return res.status(404).json({ error: "not found" });
      onDisk = filePath(id); // inside the folder, a real file — or it throws
    } catch {
      return res.status(404).json({ error: "not found" });
    }
    const download = req.query.download !== undefined && req.query.download !== "0";
    res.setHeader("Content-Type", FILE_KINDS[file.kind].mime);
    res.setHeader("Content-Disposition", disposition(file, download));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-cache");
    if (file.kind === "html") res.setHeader("Content-Security-Policy", "sandbox");
    res.sendFile(onDisk, { dotfiles: "deny" }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "not found" });
    });
  });

  r.delete("/files/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: "bad file id" });
    try {
      const removed = deleteFile(id);
      if (!removed) return res.status(404).json({ error: "not found" });
      res.json({ ok: true, deleted: describeFile(removed) });
    } catch (err) {
      res.status(500).json({ error: err instanceof FileStoreError ? err.message : "couldn't delete the file" });
    }
  });

  return r;
}
