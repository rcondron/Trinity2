import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

/**
 * The file store: documents, spreadsheets and notes Trinity makes or saves for the user, kept in one flat folder
 * (<data dir>/files/) and listed in index.json there.
 *
 * Confinement. A file's bytes live at <id>.<extension of its kind> — the id is sixteen hex digits this module makes,
 * so nothing a user, a model or a web page says ever becomes part of a path. The name people see is separate: it is
 * cleaned (no path parts, no control or invisible characters, no reserved Windows names, capped, its extension taken
 * from the kind) and only ever travels as text. Every path is still resolved and refused unless it sits directly in
 * the folder, and nothing that is a link is read, served or followed — not a file, and not the folder itself.
 *
 * Limits. 10 MB a file and 500 MB in all (TRINITY_FILES_MAX_MB / TRINITY_FILES_TOTAL_MB), 2000 files. Nothing is
 * ever deleted to make room: a save that doesn't fit is refused, and the refusal says so and names the oldest file.
 *
 * Writes are atomic (a temporary file in the same folder, flushed, then renamed over the target): the bytes first,
 * then the index. A delete removes the bytes first. So a crash leaves either a listed file whose bytes are gone
 * (dropped when the index is next read) or bytes with no entry (listed again as "Recovered …"), never a wrong one.
 *
 * Everything here is synchronous: the folder is small, and one step at a time means no two saves can interleave.
 */

export type FileKind = "txt" | "md" | "csv" | "json" | "html" | "pdf" | "docx" | "xlsx" | "zip" | "png" | "jpg" | "gif" | "webp";

export interface KindInfo {
  /** The extension on disk and on the name. */
  ext: string;
  /** The Content-Type it is served with. */
  mime: string;
  /** What it's called in a sentence, with its article: "a PDF", "an Excel spreadsheet". */
  noun: string;
  /** Its bytes are UTF-8 text (readText works on it). */
  text: boolean;
  /** Shown in the browser rather than downloaded. */
  inline: boolean;
}

export const FILE_KINDS: Record<FileKind, KindInfo> = {
  txt: { ext: "txt", mime: "text/plain; charset=utf-8", noun: "a text file", text: true, inline: true },
  md: { ext: "md", mime: "text/markdown; charset=utf-8", noun: "a Markdown file", text: true, inline: true },
  csv: { ext: "csv", mime: "text/csv; charset=utf-8", noun: "a CSV file", text: true, inline: false },
  json: { ext: "json", mime: "application/json; charset=utf-8", noun: "a JSON file", text: true, inline: true },
  html: { ext: "html", mime: "text/html; charset=utf-8", noun: "a web page", text: true, inline: true },
  pdf: { ext: "pdf", mime: "application/pdf", noun: "a PDF", text: false, inline: true },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", noun: "a Word document", text: false, inline: false },
  xlsx: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", noun: "an Excel spreadsheet", text: false, inline: false },
  zip: { ext: "zip", mime: "application/zip", noun: "a zip file", text: false, inline: false },
  png: { ext: "png", mime: "image/png", noun: "a picture", text: false, inline: true },
  jpg: { ext: "jpg", mime: "image/jpeg", noun: "a picture", text: false, inline: true },
  gif: { ext: "gif", mime: "image/gif", noun: "a picture", text: false, inline: true },
  webp: { ext: "webp", mime: "image/webp", noun: "a picture", text: false, inline: true },
};

export function isFileKind(v: unknown): v is FileKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FILE_KINDS, v);
}

export interface StoredFile {
  /** Sixteen hex digits. */
  id: string;
  /** The name people see, with its extension: "Shopping list.txt". */
  name: string;
  kind: FileKind;
  /** Bytes. */
  size: number;
  createdAt: number;
  updatedAt: number;
  /** One line about what it is. */
  description: string;
}

export type FileErrorCode = "bad-kind" | "bad-content" | "too-large" | "full" | "too-many" | "not-found" | "not-text" | "outside" | "link" | "io";

/** A refusal or failure of the store. The message is a plain sentence that can be said aloud. */
export class FileStoreError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileStoreError";
  }
}

export const FILES_DIR = path.join(DATA_DIR, "files");
export const FILE_ID_RE = /^[0-9a-f]{16}$/;
const INDEX = "index.json";
const ON_DISK = /^([0-9a-f]{16})\.([a-z0-9]{2,5})$/;
const MB = 1024 * 1024;
const MAX_FILES = 2000;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 200;
/** Without a byte-order mark at the start. */
const withoutBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** The caps in force: bytes for one file, bytes for all of them, and how many files. */
export function fileLimits(): { perFile: number; total: number; count: number } {
  const mb = (name: string, fallback: number) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { perFile: Math.floor(mb("TRINITY_FILES_MAX_MB", 10) * MB), total: Math.floor(mb("TRINITY_FILES_TOTAL_MB", 500) * MB), count: MAX_FILES };
}

/** "640 bytes", "48 KB", "1.2 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / MB;
  return `${mb >= 100 || Number.isInteger(Math.round(mb * 10) / 10) ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

// ─── Names ────────────────────────────────────────────────────────────────────

/** Names Windows keeps for devices, whatever extension follows. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const KNOWN_EXT = /\.(?:txt|text|md|markdown|csv|json|html?|pdf|docx?|xlsx?|zip|png|jpe?g|gif|webp)$/i;
/**
 * Characters with nothing to show: control codes, the invisible format characters a name can hide behind (zero-width,
 * direction overrides, the byte-order mark), lone surrogates and private-use code points.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu;

/**
 * The name a file is shown and downloaded under, from whatever was asked for: the words of any path it came with
 * (never the path), without characters a file system refuses, never a reserved or hidden name, at most 80 characters,
 * and ending in the extension of its kind — whatever extension it arrived with.
 */
export function sanitizeName(raw: string, kind: FileKind): string {
  let s = String(raw ?? "")
    .normalize("NFC")
    .replace(UNSEEN, " ");
  const parts = s
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^\.+$/.test(part) && !/^[A-Za-z]:$/.test(part));
  // (Of a long path the last parts say the most: the first ones go before anything is cut off the end.)
  while (parts.length > 1 && [...parts.join("-").replace(KNOWN_EXT, "")].length > MAX_NAME) parts.shift();
  s = parts.join("-");
  s = s
    .replace(/[<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (KNOWN_EXT.test(s)) s = s.replace(KNOWN_EXT, "").trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, "");
  const chars = [...s];
  if (chars.length > MAX_NAME) s = chars.slice(0, MAX_NAME).join("").replace(/[.\s]+$/g, "");
  if (!s) s = "Untitled";
  if (RESERVED.test((s.split(".")[0] ?? "").trim())) s = `_${s}`;
  return `${s}.${FILE_KINDS[kind].ext}`;
}

/** A name nothing else in the store has (case doesn't count): "Budget.xlsx", then "Budget (2).xlsx". */
function uniqueName(name: string, files: StoredFile[], exceptId?: string): string {
  const taken = new Set(files.filter((f) => f.id !== exceptId).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  for (let k = 2; ; k++) {
    const next = `${name.slice(0, dot)} (${k})${name.slice(dot)}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

const oneLine = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(UNSEEN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** The file's address in the app: /api/files/<id>/<name> (same-origin, relative). */
export function fileUrl(file: Pick<StoredFile, "id" | "name">): string {
  return `/api/files/${file.id}/${encodeURIComponent(file.name)}`;
}

/**
 * A stored file as a card, a list or the API shows it — the one description of a file for display. Everything in it
 * is safe to show; nothing in it is a path.
 */
export interface FileInfo {
  id: string;
  /** The name with its extension: "Shopping list.txt". */
  name: string;
  kind: FileKind;
  /** Its media type, without parameters: "application/pdf", "text/plain". */
  mime: string;
  /** What kind of file it is, in words: "PDF", "Word document", "text file". */
  type: string;
  /** Bytes. */
  size: number;
  /** The same-origin address that opens it: in the browser for PDFs, text, pictures and pages, as a download otherwise. */
  url: string;
  /** The same address, always as a download. */
  downloadUrl: string;
  /** Whether `url` shows the file in the browser (true) or downloads it (false). */
  opens: boolean;
  createdAt: number;
  updatedAt: number;
  /** One line about what it is. */
  description: string;
}

export function describeFile(file: StoredFile): FileInfo {
  const kind = FILE_KINDS[file.kind];
  const url = fileUrl(file);
  return {
    id: file.id,
    name: file.name,
    kind: file.kind,
    mime: kind.mime.replace(/;.*$/, ""),
    type: kind.noun.replace(/^an?\s+/, ""),
    size: file.size,
    url,
    downloadUrl: `${url}?download=1`,
    opens: kind.inline,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    description: file.description,
  };
}

/** The display description of the file with this id — or null when there is none (or the store can't be read). */
export function fileInfo(id: string): FileInfo | null {
  try {
    const file = getFile(id);
    return file ? describeFile(file) : null;
  } catch {
    return null;
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/** The path of something directly in the files folder. Anything that resolves elsewhere — or deeper — is refused. */
function inside(name: string): string {
  const root = path.resolve(FILES_DIR);
  const p = path.resolve(root, name);
  if (path.dirname(p) !== root || path.basename(p) !== name) throw new FileStoreError("outside", "That path is outside the files folder.");
  return p;
}

const diskName = (f: Pick<StoredFile, "id" | "kind">) => `${f.id}.${FILE_KINDS[f.kind].ext}`;

/** The folder exists and is a real folder (a link in its place is not followed). */
function checkedDir(create: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(FILES_DIR);
  } catch {
    if (!create) return false;
    fs.mkdirSync(FILES_DIR, { recursive: true });
    st = fs.lstatSync(FILES_DIR);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new FileStoreError("link", "The files folder is a link to somewhere else, and I don't follow links.");
  return true;
}

/** A real file, not a link to one. */
function regularFile(p: string): fs.Stats {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw new FileStoreError("not-found", "That file isn't in the store any more.");
  }
  if (st.isSymbolicLink()) throw new FileStoreError("link", "That file is a link to somewhere else, and I don't follow links.");
  if (!st.isFile()) throw new FileStoreError("not-found", "That file isn't in the store any more.");
  return st;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows can hold a file for a moment (a scanner, an indexer): a rename that is refused for that is tried again. */
function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
}

/** All of the bytes or none: written beside the target, flushed, then renamed over it. */
function writeAtomic(dest: string, bytes: Uint8Array): void {
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600); // a new file of our own: never through something already there
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameOver(tmp, dest);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never made */
    }
    throw err;
  }
}

// ─── The index ────────────────────────────────────────────────────────────────

let cache: StoredFile[] | null = null;

/** An entry as the index may hold it, or null when it isn't one (a wrong id, an unknown kind…). Its name is cleaned again. */
function validEntry(raw: unknown): StoredFile | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !FILE_ID_RE.test(e.id) || !isFileKind(e.kind)) return null;
  const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : Date.now());
  return {
    id: e.id,
    name: sanitizeName(typeof e.name === "string" ? e.name : "", e.kind),
    kind: e.kind,
    size: typeof e.size === "number" && Number.isFinite(e.size) && e.size >= 0 ? Math.floor(e.size) : 0,
    createdAt: time(e.createdAt),
    updatedAt: time(e.updatedAt),
    description: oneLine(e.description, MAX_DESCRIPTION),
  };
}

function persist(): void {
  writeAtomic(inside(INDEX), new TextEncoder().encode(`${JSON.stringify({ version: 1, files: cache ?? [] }, null, 2)}\n`));
}

/** The entries, read once and kept; brought in line with what is really in the folder the first time. */
function load(): StoredFile[] {
  if (cache) return cache;
  if (!checkedDir(false)) return (cache = []);
  let listed: StoredFile[] = [];
  let changed = false;
  const indexPath = inside(INDEX);
  let raw: string | null = null;
  let there: fs.Stats | null = null;
  try {
    there = fs.lstatSync(indexPath);
  } catch (err) {
    // No index yet is fine; an index that can't even be looked at is not a reason to rebuild over it.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new FileStoreError("io", `I couldn't read the list of files: ${(err as Error).message}`);
  }
  if (there) {
    if (there.isSymbolicLink() || !there.isFile()) throw new FileStoreError("link", "The list of files is a link to somewhere else, and I don't follow links.");
    try {
      raw = fs.readFileSync(indexPath, "utf8");
    } catch (err) {
      throw new FileStoreError("io", `I couldn't read the list of files: ${(err as Error).message}`);
    }
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { files?: unknown };
      if (!parsed || !Array.isArray(parsed.files)) throw new Error("it has no list of files");
      const seen = new Set<string>();
      for (const item of parsed.files) {
        const entry = validEntry(item);
        if (!entry || seen.has(entry.id)) {
          changed = true;
          continue;
        }
        seen.add(entry.id);
        listed.push(entry);
      }
    } catch (err) {
      // An index that can't be read is kept aside, never written over blind; the folder is listed again below.
      const aside = `index.unreadable-${Date.now()}.json`;
      try {
        fs.renameSync(indexPath, inside(aside));
      } catch {
        /* it stays where it is; the new index replaces it */
      }
      console.warn(`[files] the index couldn't be read (${(err as Error).message}); kept as ${aside} and rebuilt from the folder`);
      listed = [];
      changed = true;
    }
  }
  // What is really there: real files named <id>.<ext> — and temporary files left by a write that was cut short.
  const onDisk = new Map<string, { ext: string; size: number; at: number }>();
  for (const name of fs.readdirSync(FILES_DIR)) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(FILES_DIR, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (name.endsWith(".tmp")) {
      if (Date.now() - st.mtimeMs > 10 * 60_000) fs.rmSync(path.join(FILES_DIR, name), { force: true });
      continue;
    }
    const m = ON_DISK.exec(name);
    if (m) onDisk.set(m[1]!, { ext: m[2]!, size: st.size, at: st.mtimeMs });
  }
  const kept = listed.filter((f) => onDisk.get(f.id)?.ext === FILE_KINDS[f.kind].ext);
  if (kept.length !== listed.length) {
    console.warn(`[files] ${listed.length - kept.length} listed file(s) had no bytes in the folder and were dropped from the index`);
    changed = true;
  }
  const known = new Set(kept.map((f) => f.id));
  for (const [id, d] of onDisk) {
    if (known.has(id)) continue;
    const kind = (Object.keys(FILE_KINDS) as FileKind[]).find((k) => FILE_KINDS[k].ext === d.ext);
    if (!kind) continue;
    kept.push({
      id,
      name: uniqueName(sanitizeName(`Recovered ${id.slice(0, 6)}`, kind), kept),
      kind,
      size: d.size,
      createdAt: Math.floor(d.at),
      updatedAt: Math.floor(d.at),
      description: "Recovered: it was in the files folder without an entry.",
    });
    console.warn(`[files] ${id}.${d.ext} was in the folder without an entry; listed again as a recovered file`);
    changed = true;
  }
  cache = kept;
  if (changed) {
    try {
      persist();
    } catch (err) {
      console.warn(`[files] couldn't rewrite the index: ${(err as Error).message}`);
    }
  }
  return cache;
}

/** Forget what was read: the next call reads the folder again (after something else changed it; in tests). */
export function reloadFiles(): void {
  cache = null;
}

function entry(id: string): StoredFile {
  const f = FILE_ID_RE.test(id) ? load().find((x) => x.id === id) : undefined;
  if (!f) throw new FileStoreError("not-found", "There's no such file.");
  return f;
}

// ─── Changes others want to hear about ────────────────────────────────────────

export type FileChange = { type: "saved"; file: StoredFile } | { type: "renamed"; file: StoredFile; before: StoredFile } | { type: "removed"; file: StoredFile };

const listeners = new Set<(change: FileChange) => void>();

/** Hear about every save, rename and delete, however it was made (a tool, the API). Returns the way to stop. */
export function onFileChange(fn: (change: FileChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(change: FileChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch (err) {
      console.warn("[files] a change listener failed:", (err as Error).message);
    }
  }
}

// ─── Saving ───────────────────────────────────────────────────────────────────

/** The bytes are what the kind says they are: text is UTF-8 (JSON parses), and each binary kind starts the way its format does. */
function checkContent(kind: FileKind, bytes: Uint8Array): void {
  const info = FILE_KINDS[kind];
  if (!bytes.length) throw new FileStoreError("bad-content", "There's nothing to save.");
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const wrong = () => new FileStoreError("bad-content", `That isn't ${info.noun}.`);
  if (info.text) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new FileStoreError("bad-content", "That isn't text I can save.");
    }
    if (text.includes("\0")) throw new FileStoreError("bad-content", "That isn't text I can save.");
    if (kind === "json") {
      try {
        JSON.parse(withoutBom(text));
      } catch {
        throw new FileStoreError("bad-content", "That isn't valid JSON.");
      }
    }
    return;
  }
  const ok =
    kind === "pdf"
      ? starts(0x25, 0x50, 0x44, 0x46, 0x2d)
      : kind === "docx" || kind === "xlsx"
        ? starts(0x50, 0x4b, 0x03, 0x04)
        : kind === "zip"
          ? starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)
          : kind === "png"
            ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
            : kind === "jpg"
              ? starts(0xff, 0xd8, 0xff)
              : kind === "gif"
                ? starts(0x47, 0x49, 0x46, 0x38)
                : starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!ok) throw wrong();
}

export interface SaveInput {
  /** The name asked for (it is cleaned; the extension comes from the kind). */
  name: string;
  kind: FileKind;
  /** The content: bytes, or text (saved as UTF-8). */
  bytes?: Uint8Array;
  text?: string;
  /** One line about what it is. */
  description?: string;
}

/**
 * Save a new file. Refused (FileStoreError) when the kind is unknown, the content isn't what the kind says, it is
 * over the per-file limit, or it doesn't fit in what's left — nothing is deleted to make room. A name already taken
 * gets a number: "Budget (2).xlsx".
 */
export function saveFile(input: SaveInput): StoredFile {
  if (!isFileKind(input.kind)) throw new FileStoreError("bad-kind", "I can't save that kind of file.");
  const bytes = input.bytes ?? (typeof input.text === "string" ? new TextEncoder().encode(input.text) : null);
  if (!bytes) throw new FileStoreError("bad-content", "There's nothing to save.");
  const limits = fileLimits();
  if (bytes.length > limits.perFile) throw new FileStoreError("too-large", `That file is ${sizeWords(bytes.length)}, over the limit of ${sizeWords(limits.perFile)} for one file.`);
  checkContent(input.kind, bytes);
  checkedDir(true);
  const files = load();
  if (files.length >= limits.count) throw new FileStoreError("too-many", `There are already ${files.length} files, which is the most I keep. Delete some first.`);
  const used = files.reduce((n, f) => n + f.size, 0);
  if (used + bytes.length > limits.total) {
    const oldest = files.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
    throw new FileStoreError(
      "full",
      `There isn't room: your files take ${sizeWords(used)} of ${sizeWords(limits.total)}, and this one is ${sizeWords(bytes.length)}. I haven't deleted anything to make space` +
        (oldest ? ` — the oldest file is “${oldest.name}”.` : "."),
    );
  }
  let id = crypto.randomBytes(8).toString("hex");
  while (files.some((f) => f.id === id)) id = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const file: StoredFile = {
    id,
    name: uniqueName(sanitizeName(input.name, input.kind), files),
    kind: input.kind,
    size: bytes.length,
    createdAt: now,
    updatedAt: now,
    description: oneLine(input.description, MAX_DESCRIPTION),
  };
  const dest = inside(diskName(file));
  try {
    writeAtomic(dest, bytes);
    files.push(file);
    persist();
  } catch (err) {
    const i = files.indexOf(file);
    if (i >= 0) files.splice(i, 1);
    fs.rmSync(dest, { force: true });
    throw new FileStoreError("io", `I couldn't write the file: ${(err as Error).message}`);
  }
  announce({ type: "saved", file: { ...file } });
  return { ...file };
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/** One file's entry, or null. */
export function getFile(id: string): StoredFile | null {
  const f = FILE_ID_RE.test(String(id)) ? load().find((x) => x.id === id) : undefined;
  return f ? { ...f } : null;
}

/** Every file, newest first (of two saved in the same instant, the later one). */
export function listFiles(): StoredFile[] {
  return load()
    .map((f, order) => ({ f: { ...f }, order }))
    .sort((a, b) => b.f.createdAt - a.f.createdAt || b.order - a.order)
    .map((x) => x.f);
}

/** How much is stored, of how much may be. */
export function storeUsage(): { files: number; bytes: number; limit: number } {
  const files = load();
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), limit: fileLimits().total };
}

const SEARCH_STOP = new Set("a an the my our your this that these those of for to in on at by with and or about from is it its file files document documents doc docs called named titled saved".split(" "));

/** The words of a name, a description or a query, lower-cased, without accents, plurals trimmed. */
function searchWords(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !SEARCH_STOP.has(w))
    .map((w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(?<!s)s$/, "") : w));
}

/**
 * Files whose name or description has the query's words. Those matching more of the words come first (a word in the
 * name counts for more than one in the description); among equals, newest first. A query with no words finds nothing.
 */
export function findFiles(query: string, opts: { kinds?: FileKind[] } = {}): StoredFile[] {
  const wanted = [...new Set(searchWords(query))];
  if (!wanted.length) return [];
  const scored: { file: StoredFile; hits: number; score: number }[] = [];
  for (const file of listFiles()) {
    if (opts.kinds?.length && !opts.kinds.includes(file.kind)) continue;
    const inName = searchWords(file.name);
    const inDescription = searchWords(file.description);
    const near = (words: string[], w: string) => words.some((x) => x === w || (w.length >= 3 && x.startsWith(w)) || (x.length >= 4 && w.startsWith(x)));
    let hits = 0;
    let score = 0;
    for (const w of wanted) {
      const points = inName.includes(w) ? 4 : near(inName, w) ? 3 : inDescription.includes(w) ? 2 : near(inDescription, w) ? 1 : 0;
      if (points) hits++;
      score += points;
    }
    if (hits) scored.push({ file, hits, score });
  }
  return scored.sort((a, b) => b.hits - a.hits || b.score - a.score || b.file.createdAt - a.file.createdAt).map((s) => s.file);
}

/** Where a file's bytes are, for serving: inside the folder, a real file. Throws FileStoreError otherwise. */
export function filePath(id: string): string {
  const p = inside(diskName(entry(id)));
  checkedDir(false);
  regularFile(p);
  return p;
}

/** A text-like file's words (UTF-8, without a byte-order mark), up to `maxChars`. Throws for kinds that aren't text. */
export function readText(id: string, maxChars = 20_000): { text: string; truncated: boolean } {
  const f = entry(id);
  if (!FILE_KINDS[f.kind].text) throw new FileStoreError("not-text", `“${f.name}” is ${FILE_KINDS[f.kind].noun}, not text.`);
  const p = filePath(id);
  let raw: Buffer;
  try {
    // O_NOFOLLOW where the platform has it: the check above and this read can't be split by a link swapped in between.
    const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      raw = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new FileStoreError("io", `I couldn't read “${f.name}”: ${(err as Error).message}`);
  }
  const text = withoutBom(new TextDecoder("utf-8").decode(raw));
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

// ─── Changing ─────────────────────────────────────────────────────────────────

/** Give a file another name (cleaned, its extension kept, a number added if the name is taken). Returns it as it is now. */
export function renameFile(id: string, name: string): StoredFile {
  const files = load();
  const f = entry(id);
  const before = { ...f };
  const next = uniqueName(sanitizeName(name, f.kind), files, f.id);
  if (next === f.name) return before;
  f.name = next;
  f.updatedAt = Date.now();
  try {
    persist();
  } catch (err) {
    f.name = before.name;
    f.updatedAt = before.updatedAt;
    throw new FileStoreError("io", `I couldn't rename the file: ${(err as Error).message}`);
  }
  announce({ type: "renamed", file: { ...f }, before });
  return { ...f };
}

/** Delete a file: its bytes, then its entry. Returns the entry it had, or null when there was no such file. */
export function deleteFile(id: string): StoredFile | null {
  const files = load();
  const i = FILE_ID_RE.test(String(id)) ? files.findIndex((x) => x.id === id) : -1;
  if (i < 0) return null;
  const f = files[i]!;
  try {
    fs.rmSync(inside(diskName(f)), { force: true }); // (removing a link removes the link, never what it points at)
  } catch (err) {
    throw new FileStoreError("io", `I couldn't delete “${f.name}”: ${(err as Error).message}`);
  }
  files.splice(i, 1);
  try {
    persist();
  } catch (err) {
    console.warn(`[files] deleted ${f.id} but couldn't rewrite the index: ${(err as Error).message}`);
  }
  announce({ type: "removed", file: { ...f } });
  return { ...f };
}
