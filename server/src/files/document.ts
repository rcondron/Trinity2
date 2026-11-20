import { withoutBom, xmlText } from "./xml.js";

/**
 * A document as simple structured content — a title, headings (three levels), paragraphs with bold / italic runs,
 * bulleted and numbered lists, simple tables, quotes, rules and page breaks — parsed from the Markdown-like text a
 * model (or the user) writes, and rendered as a printable HTML page, plain text or Markdown. The Word and PDF
 * writers (docx.ts, pdf.ts) take the same structure.
 *
 * The markup, deliberately small:
 *   # Heading   ## Subheading   ### Minor heading          (deeper levels count as the third)
 *   paragraphs separated by a blank line; a line break inside one is kept (addresses, sign-offs)
 *   **bold**  *italic*  `code`                              (also __bold__, _italic_)
 *   - item  * item  + item  • item      1. item  1) item    (indent to nest, up to three levels; - [ ] / - [x] boxes)
 *   | A | B |  rows with a |---|---| line under the header  (:--, :-:, --: align a column)
 *   > quoted lines        ``` fenced code ```        ---  a rule
 *   [[pagebreak]]  alone on a line starts a new page        (also \pagebreak, \newpage, <!-- pagebreak -->)
 * Everything else is text: nothing in it is ever passed through as HTML or XML.
 */

export interface Run {
  /** The words; a "\n" inside is a line break. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type Align = "left" | "center" | "right";

export interface ListItem {
  runs: Run[];
  /** 0 = top level, up to 2. */
  level: number;
  ordered: boolean;
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "quote"; runs: Run[] }
  | { type: "list"; items: ListItem[]; /** The number a numbered list starts at (when not 1). */ start?: number }
  | { type: "table"; header: Run[][]; rows: Run[][][]; align: Align[] }
  | { type: "code"; text: string }
  | { type: "rule" }
  | { type: "pagebreak" };

export type ListBlock = Extract<Block, { type: "list" }>;
export type TableBlock = Extract<Block, { type: "table" }>;

export interface Doc {
  /** The document's name (the file is named after it). */
  title: string;
  /** Whether the title is printed at the top (a report, a resume) or not (a letter). */
  showTitle: boolean;
  blocks: Block[];
  /** The markup the blocks were parsed from. */
  source: string;
}

export type Paper = "letter" | "a4";

/** What a printed document may load: nothing from anywhere — its own inline styles, and images and fonts carried inside it. */
export const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

// ─── Inline: bold, italic, code ───────────────────────────────────────────────

type Style = Pick<Run, "bold" | "italic" | "code">;

/** A backslash-escaped mark ("\*") is hidden in the private-use range while the marks are read, then put back. */
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|~<>])/g;
const hide = (s: string) => s.replace(ESCAPED, (_m, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const unhide = (s: string) =>
  s.replace(/\p{Co}/gu, (c) => {
    const code = c.charCodeAt(0);
    return code >= 0xe021 && code <= 0xe07e ? String.fromCharCode(code - 0xe000) : c;
  });

/** The few inline tags a model reaches for become marks or go; no tag is ever kept. */
function withoutInlineTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:b|strong)\s*>/gi, "**")
    .replace(/<\/?(?:i|em)\s*>/gi, "*")
    .replace(/<\/?(?:u|span|sup|sub|small|mark|font|center|ins|del|s)\b[^>]*>/gi, "")
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, "$1");
}

interface Mark {
  re: RegExp;
  /** The capture group holding what's inside the marks. */
  inner: number;
  kind: "code" | "link" | "style";
  style?: Style;
}

const MARKS: Mark[] = [
  { re: /`([^`\n]+)`/, inner: 1, kind: "code" },
  { re: /\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)/, inner: 1, kind: "link" },
  { re: /\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/, inner: 1, kind: "style", style: { bold: true, italic: true } },
  { re: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/, inner: 1, kind: "style", style: { bold: true } },
  { re: /(?<![\p{L}\p{N}_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\p{L}\p{N}_])/u, inner: 1, kind: "style", style: { bold: true } },
  { re: /(?<![*\p{L}\p{N}])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\p{L}\p{N}])/u, inner: 1, kind: "style", style: { italic: true } },
  { re: /(?<![_\p{L}\p{N}])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![_\p{L}\p{N}])/u, inner: 1, kind: "style", style: { italic: true } },
  { re: /~~(?=\S)([\s\S]+?)(?<=\S)~~/, inner: 1, kind: "style", style: {} },
];

function pushRun(out: Run[], text: string, style: Style): void {
  const t = unhide(text);
  if (!t) return;
  const last = out[out.length - 1];
  if (last && Boolean(last.bold) === Boolean(style.bold) && Boolean(last.italic) === Boolean(style.italic) && Boolean(last.code) === Boolean(style.code)) {
    last.text += t;
    return;
  }
  out.push({ text: t, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.code ? { code: true } : {}) });
}

function readMarks(text: string, style: Style, out: Run[]): void {
  let rest = text;
  while (rest) {
    let first: { m: RegExpExecArray; mark: Mark } | null = null;
    for (const mark of MARKS) {
      const m = mark.re.exec(rest);
      if (m && (!first || m.index < first.m.index)) first = { m, mark };
    }
    if (!first) {
      pushRun(out, rest, style);
      return;
    }
    const { m, mark } = first;
    if (m.index > 0) pushRun(out, rest.slice(0, m.index), style);
    const inner = m[mark.inner] ?? "";
    if (mark.kind === "code") pushRun(out, inner, { ...style, code: true });
    else if (mark.kind === "link") {
      // A link is its words, and its address in brackets when that says more than the words do.
      readMarks(inner, style, out);
      const url = m[2] ?? "";
      if (/^(?:https?:\/\/|mailto:)/i.test(url) && url.replace(/^mailto:/i, "") !== unhide(inner).trim()) pushRun(out, ` (${url.replace(/^mailto:/i, "")})`, style);
    } else readMarks(inner, { ...style, ...mark.style }, out);
    rest = rest.slice(m.index + m[0].length);
  }
}

/** A line or paragraph of the markup as styled runs. */
export function parseInline(text: string): Run[] {
  const out: Run[] = [];
  readMarks(hide(withoutInlineTags(text)), {}, out);
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((r) => r.text);
}

export function plainText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

const PAGEBREAK = /^\s*(?:\[\[\s*page[ -]?break\s*\]\]|\\(?:pagebreak|newpage)|<!--\s*page[ -]?break\s*-->|<div\s+style="page-break-(?:after|before):\s*always;?\s*">\s*<\/div>)\s*$/i;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ITEM = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const SETEXT = /^\s*={3,}\s*$/;
const NUMERIC_CELL = /^[-+]?\(?[$€£¥]?\s?\d[\d.,' ]*\)?\s?(?:%|[A-Za-z€£$]{1,3})?$/;

function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The markup as blocks. Never throws: what isn't markup is a paragraph. */
export function parseBlocks(source: string): Block[] {
  const lines = withoutBom(source)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // (A tab that indents counts as four spaces; one between words stays a tab.)
    .map((l) => l.replace(/^[ \t]+/, (indent) => indent.replace(/\t/g, "    ")).replace(/\s+$/, ""));
  const blocks: Block[] = [];
  const at = (k: number) => lines[k] ?? "";
  const tableStarts = (k: number) => at(k).includes("|") && k + 1 < lines.length && at(k + 1).includes("|") && TABLE_RULE.test(at(k + 1));
  /** Whether line k begins something that ends the paragraph before it. */
  const interrupts = (k: number): boolean => {
    const l = at(k);
    if (FENCE.test(l) || PAGEBREAK.test(l) || RULE.test(l) || HEADING.test(l) || QUOTE.test(l) || SETEXT.test(l) || tableStarts(k)) return true;
    const item = ITEM.exec(l);
    return Boolean(item) && (item![3] === undefined || item![3] === "1");
  };

  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const closing = fence[1]!.startsWith("`") ? /^\s{0,3}`{3,}\s*$/ : /^\s{0,3}~{3,}\s*$/;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closing.test(at(i))) body.push(at(i++));
      i++; // the closing fence, or the end of the text
      if (body.some((l) => l.trim())) blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (PAGEBREAK.test(line)) {
      blocks.push({ type: "pagebreak" });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const runs = parseInline(heading[2]!);
      if (runs.length) blocks.push({ type: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, runs });
      i++;
      continue;
    }
    if (tableStarts(i)) {
      const header = tableCells(line);
      const marks = tableCells(at(i + 1));
      const explicit: (Align | null)[] = header.map((_h, c) => {
        const m = marks[c] ?? "";
        return m.startsWith(":") && m.endsWith(":") ? "center" : m.endsWith(":") ? "right" : m.startsWith(":") ? "left" : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && at(i).trim() && at(i).includes("|")) {
        const cells = tableCells(at(i++));
        rows.push(header.map((_h, c) => cells[c] ?? ""));
      }
      // A column of figures lines up on the right unless the header row said otherwise.
      const align: Align[] = header.map((_h, c) => {
        if (explicit[c]) return explicit[c]!;
        const filled = rows.map((r) => r[c] ?? "").filter(Boolean);
        return filled.length > 0 && filled.every((v) => NUMERIC_CELL.test(v)) ? "right" : "left";
      });
      blocks.push({ type: "table", header: header.map(parseInline), rows: rows.map((r) => r.map(parseInline)), align });
      continue;
    }
    if (ITEM.test(line)) {
      const raw: { text: string; level: number; ordered: boolean }[] = [];
      const indents: number[] = [];
      let start: number | undefined;
      while (i < lines.length) {
        const l = at(i);
        const m = ITEM.exec(l);
        if (m) {
          const indent = m[1]!.length;
          while (indents.length > 1 && indent < indents[indents.length - 1]!) indents.pop();
          if (!indents.length || indent > indents[indents.length - 1]!) indents.push(indent);
          const ordered = m[3] !== undefined;
          if (!raw.length && ordered && Number(m[3]) !== 1) start = Number(m[3]);
          raw.push({ text: m[4]!.replace(/^\[ \]\s+/, "☐ ").replace(/^\[[xX]\]\s+/, "☑ "), level: Math.min(2, indents.length - 1), ordered });
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line ends the list unless another item follows it.
          let k = i;
          while (k < lines.length && !at(k).trim()) k++;
          if (k < lines.length && ITEM.test(at(k))) {
            i = k;
            continue;
          }
          break;
        }
        // An indented line carries on the item above it; anything else starts something new.
        if (/^\s{2,}\S/.test(l) && !interrupts(i) && raw.length) {
          raw[raw.length - 1]!.text += `\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      const items = raw.map((r) => ({ runs: parseInline(r.text), level: r.level, ordered: r.ordered })).filter((it) => it.runs.length);
      if (items.length) blocks.push({ type: "list", items, ...(start !== undefined ? { start } : {}) });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) quoted.push(QUOTE.exec(at(i++))![1]!.trim());
      const runs = parseInline(quoted.join("\n"));
      if (runs.length) blocks.push({ type: "quote", runs });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && at(i).trim() && !interrupts(i)) para.push(at(i++).trim());
    if (i < lines.length && SETEXT.test(at(i))) {
      i++; // a line of === under one line of text makes it a heading; under more, it's dropped
      if (para.length === 1) {
        const runs = parseInline(para[0]!);
        if (runs.length) blocks.push({ type: "heading", level: 1, runs });
        continue;
      }
    }
    const runs = parseInline(para.join("\n"));
    if (runs.length) blocks.push({ type: "paragraph", runs });
  }
  return blocks;
}

const sameWords = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A document from its title and markup. A first heading that only repeats a printed title is dropped. */
export function buildDoc(input: { title: string; showTitle?: boolean; body: string }): Doc {
  const title = input.title.replace(/\s+/g, " ").trim();
  const showTitle = input.showTitle ?? true;
  const source = withoutBom(input.body).replace(/\r\n?/g, "\n").trim();
  const blocks = parseBlocks(source);
  const first = blocks[0];
  if (showTitle && title && first?.type === "heading" && sameWords(plainText(first.runs), title)) blocks.shift();
  return { title, showTitle, blocks, source };
}

/** Whether a document has any words in it at all. */
export function hasWords(blocks: Block[]): boolean {
  return blocks.some((b) => {
    if (b.type === "heading" || b.type === "paragraph" || b.type === "quote") return plainText(b.runs).trim().length > 0;
    if (b.type === "list") return b.items.length > 0;
    if (b.type === "table") return b.header.length > 0;
    if (b.type === "code") return b.text.trim().length > 0;
    return false;
  });
}

/**
 * Blanks left for the user to fill in: "[Your full name]"-style brackets (not a link, a check box or a footnote
 * number) and runs of underscores.
 */
export function findBlanks(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\[([^[\]\n]{2,80})\](?!\()/g)) {
    const inner = m[1]!.trim();
    if (!inner || /^\d+$/.test(inner) || /^[xX ]$/.test(inner) || /^page[ -]?break$/i.test(inner)) continue;
    out.push(inner);
  }
  for (const m of source.matchAll(/_{4,}/g)) out.push(m[0]);
  return out;
}

// ─── Lists ────────────────────────────────────────────────────────────────────

const roman = (n: number): string => {
  const table: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  let left = Math.max(1, Math.min(3999, n));
  for (const [v, s] of table)
    while (left >= v) {
      out += s;
      left -= v;
    }
  return out;
};

const letters = (n: number): string => {
  let out = "";
  for (let k = Math.max(1, n); k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
  return out;
};

/**
 * The marker each item of a list is written with — "•" and "–" for bullets, "1." / "a." / "i." for numbered items by
 * level, counting again under each new parent — the same way the Word numbering does.
 */
export function listMarkers(list: ListBlock): string[] {
  const counts: number[] = [];
  return list.items.map((it, index) => {
    counts.length = Math.min(counts.length, it.level + 1);
    if (!it.ordered) {
      counts[it.level] = 0;
      return it.level === 1 ? "–" : "•";
    }
    const from = it.level === 0 && index === 0 ? (list.start ?? 1) - 1 : 0;
    const n = (counts[it.level] || from) + 1;
    counts[it.level] = n;
    return it.level === 0 ? `${n}.` : it.level === 1 ? `${letters(n)}.` : `${roman(n)}.`;
  });
}

// ─── HTML (the page that is printed to PDF, and the "web page" file) ─────────

/** North America prints on Letter; everywhere else on A4. From the machine's locale. */
export function defaultPaper(): Paper {
  try {
    const region = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).maximize().region;
    return region && !["US", "CA", "MX", "PH", "CL", "CO", "VE", "GT", "PA", "DO", "PR"].includes(region) ? "a4" : "letter";
  } catch {
    return "letter";
  }
}

/** The print stylesheet: margins, readable type, headings that stay with their text, tables that repeat their header. */
export function printCss(paper: Paper): string {
  return `
@page { size: ${paper === "a4" ? "A4" : "Letter"}; margin: 22mm 20mm 24mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #1b1f24; background: #fff; font: 11pt/1.5 "Segoe UI", "Helvetica Neue", Helvetica, Arial, "Noto Sans", "Liberation Sans", sans-serif; }
main { max-width: 170mm; margin: 0 auto; padding: 16mm 8mm; }
h1.title { font-size: 22pt; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 14pt; }
h2 { font-size: 15pt; line-height: 1.25; margin: 20pt 0 6pt; }
h3 { font-size: 12.5pt; line-height: 1.3; margin: 16pt 0 4pt; }
h4 { font-size: 11pt; line-height: 1.3; margin: 12pt 0 3pt; color: #3a424d; }
h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
main > :first-child { margin-top: 0; }
p { margin: 0 0 9pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 9pt; padding-left: 20pt; }
li { margin: 0 0 3pt; break-inside: avoid; }
li > ul, li > ol { margin: 3pt 0 0; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 10pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 0.5pt solid #c4c9d1; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f0f2f5; font-weight: 600; }
.r { text-align: right; }
.c { text-align: center; }
blockquote { margin: 0 0 9pt; padding: 2pt 0 2pt 10pt; border-left: 2.5pt solid #c4c9d1; color: #3a424d; font-style: italic; }
pre { margin: 0 0 9pt; padding: 6pt 8pt; background: #f5f6f8; border-radius: 3pt; font: 9.5pt/1.4 Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
code { font: 0.92em Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace; background: #f5f6f8; padding: 0 2pt; border-radius: 2pt; }
hr { border: 0; border-top: 0.75pt solid #c4c9d1; margin: 12pt 0; }
.pagebreak { break-after: page; page-break-after: always; height: 0; margin: 0; }
@media print { main { max-width: none; margin: 0; padding: 0; } }
`.trim();
}

function inlineHtml(runs: Run[]): string {
  return runs
    .map((r) => {
      let h = xmlText(r.text).replace(/\n/g, "<br>");
      if (r.code) h = `<code>${h}</code>`;
      if (r.italic) h = `<em>${h}</em>`;
      if (r.bold) h = `<strong>${h}</strong>`;
      return h;
    })
    .join("");
}

function listHtml(list: ListBlock): string {
  const open: boolean[] = []; // one entry per open list: whether it is numbered
  const tag = (ordered: boolean) => (ordered ? "ol" : "ul");
  let html = "";
  list.items.forEach((it, index) => {
    const level = Math.min(it.level, open.length);
    while (open.length > level + 1) html += `</li></${tag(open.pop()!)}>`;
    if (open.length === level + 1) {
      html += "</li>";
      if (open[level] !== it.ordered) {
        html += `</${tag(open.pop()!)}><${tag(it.ordered)}>`;
        open.push(it.ordered);
      }
    } else {
      const start = it.ordered && index === 0 && list.start !== undefined ? ` start="${list.start}"` : "";
      html += `<${tag(it.ordered)}${start}>`;
      open.push(it.ordered);
    }
    html += `<li>${inlineHtml(it.runs)}`;
  });
  while (open.length) html += `</li></${tag(open.pop()!)}>`;
  return html;
}

function tableHtml(t: TableBlock): string {
  const cls = (c: number) => (t.align[c] === "right" ? ' class="r"' : t.align[c] === "center" ? ' class="c"' : "");
  const head = `<thead><tr>${t.header.map((h, c) => `<th${cls(c)}>${inlineHtml(h)}</th>`).join("")}</tr></thead>`;
  const body = t.rows.map((r) => `<tr>${r.map((cell, c) => `<td${cls(c)}>${inlineHtml(cell)}</td>`).join("")}</tr>`).join("\n");
  return `<table>\n${head}\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function blockHtml(b: Block): string {
  switch (b.type) {
    case "heading":
      return `<h${b.level + 1}>${inlineHtml(b.runs)}</h${b.level + 1}>`;
    case "paragraph":
      return `<p>${inlineHtml(b.runs)}</p>`;
    case "quote":
      return `<blockquote>${inlineHtml(b.runs)}</blockquote>`;
    case "list":
      return listHtml(b);
    case "table":
      return tableHtml(b);
    case "code":
      return `<pre>${xmlText(b.text)}</pre>`;
    case "rule":
      return "<hr>";
    case "pagebreak":
      return '<div class="pagebreak"></div>';
  }
}

/**
 * The document as one self-contained HTML page: the print stylesheet inline, every word escaped, no script, and a
 * Content-Security-Policy that lets it load nothing — so it prints the same offline and stays inert wherever it is opened.
 */
export function renderHtml(doc: Doc, opts: { paper?: Paper } = {}): string {
  const body = doc.blocks.map(blockHtml);
  if (doc.showTitle && doc.title) body.unshift(`<h1 class="title">${xmlText(doc.title)}</h1>`);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${xmlText(doc.title || "Document")}</title>`,
    `<style>\n${printCss(opts.paper ?? defaultPaper())}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    ...body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ─── Plain text and Markdown ──────────────────────────────────────────────────

function tableText(t: TableBlock): string {
  const flat = (cell: Run[]) => plainText(cell).replace(/\s*\n\s*/g, " / ");
  const rows = [t.header.map(flat), ...t.rows.map((r) => r.map(flat))];
  const widths = t.header.map((_h, c) => Math.min(48, Math.max(3, ...rows.map((r) => (r[c] ?? "").length))));
  const pad = (s: string, c: number) => (t.align[c] === "right" ? s.padStart(widths[c]!) : s.padEnd(widths[c]!));
  const line = (r: string[]) => r.map((s, c) => pad(s, c)).join(" | ").replace(/\s+$/, "");
  return [line(rows[0]!), widths.map((w) => "-".repeat(w)).join("-+-"), ...rows.slice(1).map(line)].join("\n");
}

/** The document as plain text: headings underlined, lists marked, tables in padded columns, no markup left. */
export function renderText(doc: Doc): string {
  const out: string[] = [];
  if (doc.showTitle && doc.title) out.push(`${doc.title}\n${"=".repeat(Math.min(72, doc.title.length))}`);
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      const t = plainText(b.runs);
      out.push(b.level === 1 ? `${t}\n${"-".repeat(Math.min(72, t.length))}` : t);
    } else if (b.type === "paragraph") out.push(plainText(b.runs));
    else if (b.type === "quote")
      out.push(
        plainText(b.runs)
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
      );
    else if (b.type === "list") {
      const markers = listMarkers(b);
      out.push(
        b.items
          .map((it, k) => {
            const marker = it.ordered ? markers[k]! : "-";
            const indent = "  ".repeat(it.level);
            return `${indent}${marker} ${plainText(it.runs).replace(/\n/g, `\n${indent}${" ".repeat(marker.length + 1)}`)}`;
          })
          .join("\n"),
      );
    } else if (b.type === "table") out.push(tableText(b));
    else if (b.type === "code")
      out.push(
        b.text
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    else if (b.type === "rule") out.push("-".repeat(40));
  }
  return `${out.join("\n\n").replace(/[ \t]+$/gm, "")}\n`;
}

/** The document as Markdown: its own markup as written, under the title when that is printed; a page break becomes a rule. */
export function renderMarkdown(doc: Doc): string {
  const body = doc.source
    .split("\n")
    .map((l) => (PAGEBREAK.test(l) ? "---" : l.replace(/\s+$/, "")))
    .join("\n")
    .trim();
  // (A first heading that already says the title isn't said twice.)
  const first = HEADING.exec(body.split("\n")[0] ?? "");
  const titled = doc.showTitle && doc.title && !(first && sameWords(first[2] ?? "", doc.title));
  return `${titled ? `# ${doc.title}\n\n` : ""}${body}\n`;
}

/** Words only, from HTML: tags, scripts and styles gone, blocks on their own lines. For reading a page aloud. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|table|ul|ol|blockquote|pre)\s*>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => (Number(n) > 31 && Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : " "))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
