import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { PRINT_CSP, defaultPaper, listMarkers, plainText, renderHtml, type Align, type Doc, type Paper, type Run, type TableBlock } from "./document.js";
import { withoutBom } from "./xml.js";
import { bytesOf } from "./zip.js";

/**
 * PDFs, two ways.
 *
 * The real one: the document's HTML page printed by a Chromium-family browser that is already on the machine
 * (Chrome, Edge, Brave or Chromium, from their usual install places, or CHROME_PATH), headless, with a throwaway
 * profile, a 30-second limit, and no way out to the network: the page carries a Content-Security-Policy that lets it
 * load nothing, and the browser is told that no host name resolves.
 *
 * The fallback, when there is no such browser or it fails: a minimal PDF written here — the words laid out in the
 * standard Helvetica (no fonts embedded), wrapped, paginated, with a title — and the result says so.
 */

// ─── Finding a browser ────────────────────────────────────────────────────────

export interface Browser {
  name: "Chrome" | "Edge" | "Brave" | "Chromium";
  path: string;
}

function candidates(): Browser[] {
  const out: Browser[] = [];
  const env = process.env;
  if (process.platform === "win32") {
    const roots = [...new Set([env.PROGRAMFILES ?? "C:\\Program Files", env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", env.PROGRAMW6432, env.LOCALAPPDATA].filter((r): r is string => Boolean(r)))];
    const places: [Browser["name"], string][] = [
      ["Chrome", "Google\\Chrome\\Application\\chrome.exe"],
      ["Edge", "Microsoft\\Edge\\Application\\msedge.exe"],
      ["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
      ["Chromium", "Chromium\\Application\\chrome.exe"],
    ];
    for (const [name, rel] of places) for (const root of roots) out.push({ name, path: path.join(root, rel) });
  } else if (process.platform === "darwin") {
    const places: [Browser["name"], string][] = [
      ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ];
    for (const [name, rel] of places) for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) out.push({ name, path: path.join(root, rel) });
  } else {
    const places: [Browser["name"], string[]][] = [
      ["Chrome", ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/usr/local/bin/google-chrome"]],
      ["Edge", ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"]],
      ["Brave", ["/usr/bin/brave-browser", "/usr/bin/brave-browser-stable", "/usr/bin/brave", "/opt/brave.com/brave/brave", "/snap/bin/brave"]],
      ["Chromium", ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/lib/chromium/chromium", "/usr/local/bin/chromium", "/snap/bin/chromium"]],
    ];
    for (const [name, paths] of places) for (const p of paths) out.push({ name, path: p });
  }
  return out;
}

function nameFromPath(p: string): Browser["name"] {
  const base = path.basename(p).toLowerCase();
  return /edge/.test(base) ? "Edge" : /brave/.test(base) ? "Brave" : /chromium/.test(base) ? "Chromium" : "Chrome";
}

/** The browser PDFs are printed with: CHROME_PATH when it names a file, else the first of Chrome, Edge, Brave, Chromium that is installed. */
export function findBrowser(): Browser | null {
  const named = process.env.CHROME_PATH?.trim();
  const list = [...(named ? [{ name: nameFromPath(named), path: named }] : []), ...candidates()];
  for (const b of list) {
    try {
      if (fs.statSync(b.path).isFile()) return b;
    } catch {
      /* not there */
    }
  }
  return null;
}

// ─── Printing with it ─────────────────────────────────────────────────────────

const PRINT_TIMEOUT_MS = 30_000;

/** The browser's arguments: headless, a profile of its own, nothing in the background, no host resolves, print and exit. */
export function browserArgs(profileDir: string, outPdf: string, pageUrl: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-pdf-header-footer",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${outPdf}`,
    pageUrl,
  ];
}

/** The command as one would type it (for logs and reports). */
export function commandLine(browser: Browser, args: string[]): string {
  const q = (s: string) => (/[\s*~]/.test(s) ? `"${s}"` : s);
  return [q(browser.path), ...args.map((a) => (a.startsWith("--") && a.includes("=") ? `${a.slice(0, a.indexOf("=") + 1)}${q(a.slice(a.indexOf("=") + 1))}` : q(a)))].join(" ");
}

/**
 * The page as it is handed to the browser: the Content-Security-Policy first, before anything the page could ask for,
 * and nothing in the page that could move it elsewhere or relax the policy (http-equiv metas — a refresh, another
 * policy — and <base>).
 */
export function preparePrintHtml(html: string): string {
  const page = withoutBom(html)
    .replace(/^\s*<!doctype[^>]*>/i, "")
    .replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => (/\bhttp-equiv\b/i.test(tag) ? "" : tag))
    .replace(/<base\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, "");
  return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">\n${page.replace(/^\s+/, "")}`;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Run the browser to the end. Rejects when it can't start, exits badly, or takes too long (it is killed). */
function run(exe: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let stderr = "";
    const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      child.kill("SIGKILL");
      finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => finish(new Error(`couldn't start (${err.message})`)));
    child.on("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`exited with ${signal ?? `code ${code}`}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-2).join(" / ").slice(0, 300)}` : ""}`));
    });
  });
}

/** Remove the work folder (page, PDF, profile). The browser's helpers can hold profile files for a moment: try again in the background. */
async function removeDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    void fs.promises
      .rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
      .catch((err: unknown) => console.warn(`[pdf] couldn't remove ${dir}: ${(err as Error).message}`));
  }
}

let printing: Promise<unknown> = Promise.resolve();

/**
 * Print an HTML page to PDF with the browser. One at a time. Throws when there is no browser, it fails, or it takes
 * more than 30 seconds — `makePdf` then falls back to the built-in writer. The page, the PDF and the profile live in
 * one temporary folder that is removed afterwards.
 */
export function htmlToPdf(html: string, opts: { browser?: Browser | null; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const job = printing.then(async () => {
    const browser = opts.browser === undefined ? findBrowser() : opts.browser;
    if (!browser) throw new Error("no Chrome, Edge, Brave or Chromium was found");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "trinity-pdf-"));
    try {
      const page = path.join(dir, "document.html");
      const out = path.join(dir, "document.pdf");
      const profile = path.join(dir, "profile");
      await fs.promises.mkdir(profile);
      await fs.promises.writeFile(page, preparePrintHtml(html), "utf8");
      await run(browser.path, browserArgs(profile, out, pathToFileURL(page).href), opts.timeoutMs ?? PRINT_TIMEOUT_MS);
      let pdf: Uint8Array;
      try {
        pdf = bytesOf(await fs.promises.readFile(out));
      } catch {
        throw new Error("it wrote no PDF");
      }
      if (!isPdf(pdf)) throw new Error("what it wrote isn't a PDF");
      return pdf;
    } finally {
      await removeDir(dir);
    }
  });
  printing = job.catch(() => {});
  return job;
}

// ─── Reading a PDF's shape ────────────────────────────────────────────────────

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

/** Starts with "%PDF-" and ends with "%%EOF". */
export function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  return latin1(bytes.subarray(0, 5)) === "%PDF-" && /%%EOF\s*$/.test(latin1(bytes.subarray(Math.max(0, bytes.length - 32))));
}

/** How many pages a PDF has: its page objects counted — inside compressed object streams too, when it keeps them there. */
export function pdfPageCount(bytes: Uint8Array): number {
  const PAGE_OBJ = /\/Type\s*\/Page(?![A-Za-z])/g;
  const text = latin1(bytes);
  const direct = (text.match(PAGE_OBJ) ?? []).length;
  if (direct) return direct;
  let inStreams = 0;
  const STREAM = /stream\r?\n/g;
  for (let m = STREAM.exec(text); m; m = STREAM.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    try {
      const inflated = zlib.inflateSync(bytes.subarray(start, end), { maxOutputLength: 32 * 1024 * 1024 });
      inStreams += (inflated.toString("latin1").match(PAGE_OBJ) ?? []).length;
    } catch {
      /* not a Flate stream */
    }
    STREAM.lastIndex = end + "endstream".length;
  }
  if (inStreams) return inStreams;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((c) => Number(c[1]));
  return counts.length ? Math.max(...counts) : 0;
}

// ─── The built-in writer ──────────────────────────────────────────────────────

type Font = "F1" | "F2" | "F3"; // Helvetica, Helvetica-Bold, Courier

/** Advance widths (thousandths of the font size) of the printable ASCII characters, from the fonts' metrics files. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
  722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** The accented letters of Latin-1 (0xC0–0xFF) by the plain letter each is as wide as. */
const LATIN1_BASE = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo-ouuuuypy";
/** Widths of the Windows-1252 characters that differ much from a letter's (regular / bold alike, near enough). */
const SPECIAL_WIDTH: Record<number, number> = {
  0x85: 1000, 0x89: 1000, 0x8c: 1000, 0x97: 1000, 0x99: 1000, 0x9c: 944, 0xc6: 1000, 0xe6: 889, 0x95: 350, 0x91: 222, 0x92: 222, 0x82: 222, 0x93: 400, 0x94: 400, 0x84: 400, 0x8b: 333, 0x9b: 333,
  0xa1: 333, 0xa6: 260, 0xa8: 333, 0xa9: 737, 0xae: 737, 0xaa: 370, 0xba: 365, 0xad: 333, 0xaf: 333, 0xb0: 400, 0xb2: 333, 0xb3: 333, 0xb4: 333, 0xb7: 278, 0xb8: 333, 0xb9: 333, 0xbc: 834, 0xbd: 834,
  0xbe: 834, 0xbf: 611,
};

function charWidth(code: number, font: Font): number {
  if (font === "F3") return 600;
  const table = font === "F2" ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32]!;
  const special = SPECIAL_WIDTH[code];
  if (special !== undefined) return special;
  if (code >= 0xc0 && code <= 0xff) return table[LATIN1_BASE.charCodeAt(code - 0xc0) - 32] ?? 556;
  return 556;
}

const textWidth = (s: string, font: Font, size: number) => {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i), font);
  return (w * size) / 1000;
};

/** The characters Windows-1252 keeps in 0x80–0x9F. */
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
/** Near enough, for what the standard fonts can't draw. */
const STAND_IN: Record<string, string> = {
  "☐": "[ ]", "☑": "[x]", "☒": "[x]", "✓": "x", "✔": "x", "✗": "x", "→": "->", "←": "<-", "⇒": "=>", "↔": "<->", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "−": "-", "‐": "-", "‑": "-", "‒": "-",
  "―": "—", "◦": "•", "▪": "•", "‣": "•", "●": "•", "■": "•", "○": "o", "′": "'", "″": '"', "‹": "<", "›": ">", "ﬁ": "fi", "ﬂ": "fl",
};

/**
 * Text as the standard fonts can show it: one character per byte of Windows-1252. Accents the encoding lacks fall
 * back to the plain letter, a few symbols to stand-ins, anything else to "?".
 */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || code === 0x0a) out += ch; // (line breaks stay: the layout wraps at them)
    else if (code === 0x09 || code === 0xa0 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000) out += " ";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff || (code >= 0xfe00 && code <= 0xfe0f))
      continue;
    else if (CP1252[ch] !== undefined) out += String.fromCharCode(CP1252[ch]!);
    else if (STAND_IN[ch] !== undefined) out += toWinAnsi(STAND_IN[ch]!);
    else {
      const plain = ch.normalize("NFKD").replace(/\p{M}/gu, "");
      out += plain && plain !== ch && /^[\x20-\x7e\xa1-\xff]+$/.test(plain) ? plain : "?";
    }
  }
  return out;
}

/** A PDF literal string: ASCII only, with (, ) and \ escaped and every other byte in octal. */
function pdfString(winAnsi: string): string {
  let out = "";
  for (let i = 0; i < winAnsi.length; i++) {
    const c = winAnsi.charCodeAt(i);
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += `\\${winAnsi[i]}`;
    else if (c >= 0x20 && c <= 0x7e) out += winAnsi[i];
    else out += `\\${(c & 0xff).toString(8).padStart(3, "0")}`;
  }
  return `(${out})`;
}

/** A text string for the document's properties: ASCII as it is, anything else as UTF-16 in hex. */
function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return pdfString(s);
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${hex}>`;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** Break text into lines no wider than `max` points: at spaces, at its own line breaks, and inside a word only when the word alone is too wide. */
function wrap(text: string, font: Font, size: number, max: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let word of para.split(/ +/)) {
      if (!word) continue;
      while (textWidth(word, font, size) > max && word.length > 1) {
        if (line) {
          lines.push(line);
          line = "";
        }
        let k = word.length - 1;
        while (k > 1 && textWidth(word.slice(0, k), font, size) > max) k--;
        lines.push(word.slice(0, k));
        word = word.slice(k);
      }
      const next = line ? `${line} ${word}` : word;
      if (!line || textWidth(next, font, size) <= max) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const SIZES: Record<Paper, { w: number; h: number }> = { letter: { w: 612, h: 792 }, a4: { w: 595.28, h: 841.89 } };
const MARGIN_X = 64;
const MARGIN_TOP = 68;
const MARGIN_BOTTOM = 64;
const BODY = 11;
const LEADING = 15.5;

interface Piece {
  x: number;
  text: string;
  font: Font;
  size: number;
}

/** Lines going down a page, a new page when the next one won't fit. */
class Layout {
  readonly pages: string[][] = [[]];
  private y: number;
  readonly width: number;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.y = h - MARGIN_TOP;
    this.width = w - 2 * MARGIN_X;
  }

  private get ops(): string[] {
    return this.pages[this.pages.length - 1]!;
  }
  get atTop(): boolean {
    return this.y === this.h - MARGIN_TOP;
  }
  newPage(): void {
    this.pages.push([]);
    this.y = this.h - MARGIN_TOP;
  }
  /** A gap, unless at the top of a page. */
  space(pt: number): void {
    if (!this.atTop) this.y -= pt;
  }
  /** Start a new page unless this much still fits. */
  need(pt: number): void {
    if (!this.atTop && this.y - pt < MARGIN_BOTTOM) this.newPage();
  }
  line(pieces: Piece[], leading: number): void {
    this.need(leading);
    this.y -= leading;
    for (const p of pieces) if (p.text) this.ops.push(`BT /${p.font} ${num(p.size)} Tf ${num(p.x)} ${num(this.y)} Td ${pdfString(p.text)} Tj ET`);
  }
  /** A hairline under the last line. */
  rule(drop: number): void {
    this.ops.push(`q 0.75 G 0.6 w ${num(MARGIN_X)} ${num(this.y - drop)} m ${num(this.w - MARGIN_X)} ${num(this.y - drop)} l S Q`);
  }
  text(text: string, font: Font, size: number, leading: number, indent = 0): void {
    for (const l of wrap(text, font, size, this.width - indent)) this.line([{ x: MARGIN_X + indent, text: l, font, size }], leading);
  }
}

function layTable(L: Layout, t: TableBlock): void {
  const cols = Math.max(1, t.header.length);
  const gap = 12;
  const size = 10;
  const leading = 13.5;
  const cellText = (runs: Run[]) => toWinAnsi(plainText(runs)).trim();
  const head = t.header.map(cellText);
  const body = t.rows.map((r) => Array.from({ length: cols }, (_x, c) => cellText(r[c] ?? [])));
  // Columns as wide as their longest cell, shrunk in proportion when the page is narrower (never under 36 points).
  const natural = head.map((h, c) => Math.max(textWidth(h, "F2", size), ...body.map((r) => Math.max(...(r[c] ?? "").split("\n").map((l) => textWidth(l, "F1", size))))));
  const room = L.width - gap * (cols - 1);
  const total = natural.reduce((a, b) => a + b, 0) || 1;
  const widths = natural.map((w) => (total <= room ? w + (room - total) / cols : Math.max(36, (w * room) / total)));
  const lefts = widths.map((_w, c) => MARGIN_X + widths.slice(0, c).reduce((a, b) => a + b, 0) + gap * c);
  const row = (cells: string[], font: Font) => {
    const wrapped = cells.map((s, c) => wrap(s, font, size, widths[c]!));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    L.need(height * leading + 4);
    for (let k = 0; k < height; k++) {
      L.line(
        wrapped.map((w, c): Piece => {
          const text = w[k] ?? "";
          const align: Align = t.align[c] ?? "left";
          const x = align === "right" ? lefts[c]! + widths[c]! - textWidth(text, font, size) : align === "center" ? lefts[c]! + (widths[c]! - textWidth(text, font, size)) / 2 : lefts[c]!;
          return { x, text, font, size };
        }),
        leading,
      );
    }
  };
  row(head, "F2");
  L.rule(4);
  L.space(5);
  for (const r of body) {
    row(r, "F1");
    L.space(2.5);
  }
}

/**
 * The fallback PDF: plain words in Helvetica on Letter or A4, wrapped and paginated, the title on top, headings in
 * bold, lists with their markers, tables in columns, page breaks kept, "Page n of m" at the foot. No styling inside a
 * line, and only the characters Windows-1252 has.
 */
export function simplePdf(doc: Doc, opts: { paper?: Paper; date?: Date } = {}): Uint8Array {
  const { w, h } = SIZES[opts.paper ?? defaultPaper()];
  const L = new Layout(w, h);
  const plain = (runs: Run[]) => toWinAnsi(plainText(runs));
  if (doc.showTitle && doc.title) {
    L.text(toWinAnsi(doc.title), "F2", 20, 26);
    L.space(10);
  }
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      const size = b.level === 1 ? 15 : b.level === 2 ? 13 : 11.5;
      const leading = size * 1.35;
      const lines = wrap(plain(b.runs), "F2", size, L.width);
      L.space(b.level === 1 ? 12 : 9);
      L.need(lines.length * leading + LEADING); // a heading stays with the line after it
      for (const l of lines) L.line([{ x: MARGIN_X, text: l, font: "F2", size }], leading);
      L.space(3);
    } else if (b.type === "paragraph") {
      L.text(plain(b.runs), "F1", BODY, LEADING);
      L.space(7);
    } else if (b.type === "quote") {
      L.text(plain(b.runs), "F1", BODY, LEADING, 16);
      L.space(7);
    } else if (b.type === "list") {
      const markers = listMarkers(b);
      b.items.forEach((it, k) => {
        const marker = toWinAnsi(markers[k]!);
        const markerX = MARGIN_X + 8 + 18 * it.level;
        const textX = markerX + Math.max(14, textWidth(marker, "F1", BODY) + 6);
        const lines = wrap(plain(it.runs), "F1", BODY, L.w - MARGIN_X - textX);
        lines.forEach((l, n) => L.line([...(n === 0 ? [{ x: markerX, text: marker, font: "F1" as Font, size: BODY }] : []), { x: textX, text: l, font: "F1", size: BODY }], LEADING));
        L.space(2);
      });
      L.space(5);
    } else if (b.type === "table") {
      layTable(L, b);
      L.space(8);
    } else if (b.type === "code") {
      L.text(toWinAnsi(b.text), "F3", 9.5, 12.5, 8);
      L.space(7);
    } else if (b.type === "rule") {
      L.need(14);
      L.space(4);
      L.rule(4);
      L.space(12);
    } else if (b.type === "pagebreak") {
      if (!L.atTop) L.newPage();
    }
  }

  const pages = L.pages;
  const date = opts.date ?? new Date();
  const stamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  // Objects: 1 catalog, 2 page tree, 3–5 fonts, 6 properties, then a page and its content for each page.
  const objects: string[] = [];
  const pageIds = pages.map((_p, i) => 7 + i * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  for (const base of ["Helvetica", "Helvetica-Bold", "Courier"]) objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
  objects.push(`<< /Title ${pdfTextString(doc.title || "Document")} /Producer (Trinity) /CreationDate (D:${stamp}Z) >>`);
  pages.forEach((ops, i) => {
    const foot = pages.length > 1 ? toWinAnsi(`Page ${i + 1} of ${pages.length}`) : "";
    const all = foot ? [...ops, `BT /F1 9 Tf ${num((w - textWidth(foot, "F1", 9)) / 2)} 36 Td ${pdfString(foot)} Tj ET`] : ops;
    const stream = all.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  // Everything is ASCII except the marker comment, so a character is a byte and offsets can be counted on the string.
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return bytesOf(Buffer.from(out, "latin1"));
}

// ─── A document to PDF ────────────────────────────────────────────────────────

export interface PdfResult {
  bytes: Uint8Array;
  /** What made it: the browser's name, or "built-in" for the simple layout. */
  engine: Browser["name"] | "built-in";
  pages: number;
  /** The simple layout was used. */
  simple: boolean;
  /** Why the simple layout was used. */
  note?: string;
}

/** The document as a PDF: printed by the browser when there is one and it works, else in the simple layout — and the result says which. */
export async function makePdf(doc: Doc, opts: { browser?: Browser | null; paper?: Paper; timeoutMs?: number } = {}): Promise<PdfResult> {
  const paper = opts.paper ?? defaultPaper();
  const browser = opts.browser === undefined ? findBrowser() : opts.browser;
  let note = "no Chrome, Edge, Brave or Chromium was found on this machine";
  if (browser) {
    try {
      const bytes = await htmlToPdf(renderHtml(doc, { paper }), { browser, timeoutMs: opts.timeoutMs });
      return { bytes, engine: browser.name, pages: Math.max(1, pdfPageCount(bytes)), simple: false };
    } catch (err) {
      note = `${browser.name} couldn't print it: ${(err as Error).message}`;
      console.warn(`[pdf] ${note}; using the simple layout`);
    }
  }
  const bytes = simplePdf(doc, { paper });
  return { bytes, engine: "built-in", pages: pdfPageCount(bytes), simple: true, note };
}
