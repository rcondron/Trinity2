import { noteResult, recentResults } from "../agent/act.js";
import { registerContextProvider } from "../agent/context.js";
import { askYesNo, pendingQuestion } from "../agent/pending.js";
import { tell } from "../agent/tell.js";
import { FORMAT_NOUN, summarizeText, writeDocument, writeSheets, type DocFormat, type SheetFormat } from "../files/authoring.js";
import { parseCsv, toCsv } from "../files/csv.js";
import { buildDoc, findBlanks, htmlToText, renderHtml, renderMarkdown, renderText, type Doc } from "../files/document.js";
import { buildDocx } from "../files/docx.js";
import { makePdf } from "../files/pdf.js";
import { CARD_REF, PRONOUN_REF, docFormat, fileRef, parseSave, renameSplits, sheetFormat, tidy, withoutLead, withoutTail, type SaveAsk } from "../files/request-words.js";
import { BOM } from "../files/xml.js";
import { buildXlsx } from "../files/xlsx.js";
import {
  FILE_KINDS,
  FileStoreError,
  deleteFile,
  describeFile,
  fileUrl,
  findFiles,
  getFile,
  listFiles,
  onFileChange,
  readText,
  renameFile,
  sanitizeName,
  saveFile,
  sizeWords,
  type FileChange,
  type FileKind,
  type StoredFile,
} from "../services/files.js";
import { live } from "../settings.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { bg } from "../util/bg.js";
import { addCard, boardBlocked, listCards, moveCard, removeCards, tagsFromText, touchCards, updateCard, type BoardCard } from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import { selectCards } from "../workspace/card-select.js";
import { fileCardData } from "../workspace/kinds/file-card.js";
import { registerTool } from "./registry.js";

/**
 * Files by voice: make_document ("write a letter to…", "a PDF report about…", "turn this card into a Word document"),
 * make_spreadsheet ("put that in a spreadsheet", "a CSV of…"), save_file ("save that note as shopping.txt"),
 * list_files, read_file, open_file, rename_file and delete_file (which asks first).
 *
 * What goes into a document or a spreadsheet is written by the brain model as checked, structured output
 * (files/authoring.ts) from the user's words, the conversation, the situation and what the tools just found — never
 * invented facts about the user: what isn't known is a blank to fill in. The engine turns it into the file
 * (files/*.ts), keeps it in the store (services/files.ts) and puts a card for it on the board.
 *
 * Every tool answers promptly. Work that takes more than about eight seconds goes on in the background and is told
 * when it's done (agent/tell.ts). What is said is built here, in one or two short sentences.
 */

/** How long the user waits for the finished file before being told it's in hand. */
const SPEAK_WAIT_MS = 8_000;
/** A file up to this many words is read out as it is; a longer one is summed up, with an offer to read it. */
const READ_WHOLE_WORDS = 120;
/** The most of a file that is read aloud in one go (the live voice says it a part at a time, on "keep going"). */
const READ_CHARS = 8_000;

const FILE_TOOLS = ["make_document", "make_spreadsheet", "save_file", "list_files", "read_file", "open_file", "delete_file", "rename_file"];

// ─── Saying it ────────────────────────────────────────────────────────────────

const baseName = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "");
/** A file's name as it is said and shown in a line: “Shopping list” (the voice drops the quotes). */
const quote = (f: Pick<StoredFile, "name">) => `“${baseName(f.name)}”`;
const noun = (kind: FileKind) => FILE_KINDS[kind].noun; // "a PDF"
const bareNoun = (kind: FileKind) => noun(kind).replace(/^an?\s+/, ""); // "PDF"
const count = (n: number, one: string, many = `${one}s`) => `${n === 1 ? "one" : n} ${n === 1 ? one : many}`;
const andList = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const quoted = (s: string, max: number) => JSON.stringify(s.replace(/\s+/g, " ").trim().slice(0, max));
const requestWords = (utterance: string) => withoutTail(withoutLead(tidy(utterance)));

/** A store refusal in its own words; anything else as a plain failure to do `what`. */
function storeLine(err: unknown, what: string): string {
  if (err instanceof FileStoreError) return err.message;
  console.warn(`[files] couldn't ${what}: ${(err as Error).message}`);
  return `I couldn't ${what}: something went wrong on my side.`;
}

function filesOrNone(): StoredFile[] {
  try {
    return listFiles();
  } catch {
    return [];
  }
}

/** "Your files are “A”, “B” and “C”." — the newest few (two with one name are told apart by kind: the “A” PDF). */
function haveLine(files: StoredFile[]): string {
  if (!files.length) return "You don't have any saved files yet.";
  const shown = files.slice(0, 4);
  const names = shown.map((f) => (shown.some((o) => o !== f && baseName(o.name).toLowerCase() === baseName(f.name).toLowerCase()) ? `the ${quote(f)} ${bareNoun(f.kind)}` : quote(f)));
  return files.length > 4 ? `Your newest files are ${andList(names)}.` : files.length === 1 ? `Your only file is ${names[0]}.` : `Your files are ${andList(names)}.`;
}

/** A tool result's data: the file as it is described for display (services/files.ts FileInfo), and what else the tool has to say. */
function fileData(file: StoredFile, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { file: describeFile(file), ...more };
}

// ─── On the board ─────────────────────────────────────────────────────────────

const aboutLine = (file: StoredFile) => `${capital(bareNoun(file.kind))}, ${sizeWords(file.size)}${file.description ? ` — ${file.description}` : ""}`;
const fileTags = (file: StoredFile) => tagsFromText(baseName(file.name), file.description, bareNoun(file.kind));
/** The cards that show a file: its "file" card (by the file's id) — or the note an older build put up, which carries the address. */
const cardsOf = (file: Pick<StoredFile, "id">): BoardCard[] =>
  listCards().filter((c) => (c.kind === "file" && (c.data as { id?: unknown } | undefined)?.id === file.id) || (c.kind === "text" && c.text.includes(`/api/files/${file.id}/`)));
const isFileCard = (c: BoardCard) => c.kind === "file" || (c.kind === "text" && /\/api\/files\/[0-9a-f]{16}\//.test(c.text));

/**
 * Put a file on the board — the one place that does: a "file" card, which the board draws with the file's name, kind,
 * size and first lines, and Open / Download (the window opens it: workspace/kinds/render.ts, web/src/workspace/view.ts).
 * Its words keep the line about the file and its address. A file already showing comes to the front instead of going
 * up twice. Returns the card's number, or null while a game has the board (or the board is full: the file is saved).
 */
export function showFileCard(file: StoredFile): number | null {
  if (boardBlocked()) return null;
  const up = cardsOf(file)[0];
  if (up) {
    moveCard(up.n, "front");
    touchCards([up.n]);
    return up.n;
  }
  try {
    return addCard({ kind: "file", title: `File: ${file.name}`, text: `${aboutLine(file)}\n${fileUrl(file)}`, tags: fileTags(file), status: "ready", url: null, data: fileCardData(file) }).n;
  } catch (err) {
    if ((err as Error)?.name === "BoardLimitError") return null;
    throw err;
  }
}

/** The board follows the store: a deleted file's card goes, a renamed file's card is retitled — however the change was made. */
function followStore(change: FileChange): void {
  if (change.type === "removed") {
    const ns = cardsOf(change.file).map((c) => c.n);
    if (ns.length) removeCards(ns);
  } else if (change.type === "renamed") {
    for (const c of cardsOf(change.file))
      updateCard(c.n, {
        title: `File: ${change.file.name}`.slice(0, 80),
        text: `${aboutLine(change.file)}\n${fileUrl(change.file)}`,
        tags: fileTags(change.file),
        ...(c.kind === "file" ? { data: fileCardData(change.file) } : {}),
      });
  }
}

/** Where the file is now — and, for a PDF made without a browser, that it's in the simple layout (said, never passed off as the printed one). */
const where = (card: number | null, simple = false) => {
  const place = card ? `It's on the board as card ${card}` : "It's saved with your files";
  return simple ? `${place}, in a simple layout: I found no browser here that could print it properly.` : `${place}.`;
};

// ─── Which file ───────────────────────────────────────────────────────────────

/** The file last made, opened, read or renamed: what "it" means for a quarter of an hour. */
let lastUsed: { id: string; at: number } | null = null;
const used = (file: StoredFile) => {
  lastUsed = { id: file.id, at: Date.now() };
};
const lastFile = (): StoredFile | null => (lastUsed && Date.now() - lastUsed.at < 15 * 60_000 ? getFile(lastUsed.id) : null);

/**
 * The saved file the words mean. Its name or what it's about wins (the best match, newest among equals; a kind word —
 * "the PDF" — narrows it); then "the latest"; then the file just used ("it", "that file"); then Jev's pick; then the
 * only one there is. Otherwise a line saying what there is to choose from.
 */
function pickFile(words: string, hint?: unknown): { file: StoredFile } | { say: string } {
  let files: StoredFile[];
  try {
    files = listFiles();
  } catch (err) {
    return { say: storeLine(err, "look at your files") };
  }
  if (!files.length) return { say: "You don't have any saved files yet." };
  const ref = fileRef(words);
  const pool = ref.kinds.length ? files.filter((f) => ref.kinds.includes(f.kind)) : files;
  const hinted = typeof hint === "string" ? files.find((f) => f.id === hint) : undefined;
  if (ref.words.length) {
    const found = findFiles(ref.words.join(" "), ref.kinds.length ? { kinds: ref.kinds } : {})[0] ?? findFiles(ref.words.join(" "))[0];
    if (found) return { file: found };
    if (hinted) return { file: hinted };
    // "the PDF I made this morning", and there is one PDF: that one.
    if (ref.kinds.length && pool.length === 1) return { file: pool[0]! };
    return { say: `I couldn't find a file like that. ${haveLine(files)}` };
  }
  if (!pool.length) return { say: `You don't have a file of that kind. ${haveLine(files)}` };
  if (ref.recency === "newest") return { file: pool[0]! };
  if (ref.recency === "oldest") return { file: pool[pool.length - 1]! };
  const last = lastFile();
  if (last && pool.some((f) => f.id === last.id)) return { file: last };
  if (hinted && pool.some((f) => f.id === hinted.id)) return { file: hinted };
  if (pool.length === 1) return { file: pool[0]! };
  return { say: `Which file? ${haveLine(pool)}` };
}

/** The newest files as Jev's choices for "which saved file". */
function fileOptions(): Record<string, string> | undefined {
  const files = filesOrNone().slice(0, 15);
  if (!files.length) return undefined;
  return Object.fromEntries(files.map((f) => [f.id, `“${f.name}” — ${bareNoun(f.kind)}${f.description ? `: ${f.description.slice(0, 80)}` : ""}`]));
}

const FILE_ARG = { file: { type: "string", description: "saved file" } };
const haveFiles = () => filesOrNone().length > 0;

// ─── What a request is about ──────────────────────────────────────────────────

interface Source {
  /** How it is introduced to the model. */
  label: string;
  /** How it is said to the user: "the note", "card 3". */
  what: string;
  /** Where it came from, for the file's description. */
  origin: string;
  title: string;
  text: string;
}

/** A card's words, when it has any to give (a note, a written card — not a picture, a clip or a file's own card). */
function cardWords(c: BoardCard): string | null {
  if (c.status !== "ready" || isFileCard(c)) return null;
  if (c.kind === "text") return c.text.trim() || null;
  if (c.html) return htmlToText(c.html).slice(0, 12_000) || null;
  return null;
}

const cardTitle = (c: BoardCard) => c.title.replace(/^(?:Note|File|Card|Picture|Audio|Video):\s*/i, "").replace(/^[\w ]{2,16}·\s*/, "").replace(/…$/, "").trim();

function sourceOf(c: BoardCard, named: boolean): Source | null {
  const text = cardWords(c);
  if (!text) return null;
  const title = cardTitle(c);
  return {
    label: named ? `Card ${c.n} on the board ("${c.title}"), which the request points at` : `Card ${c.n} on the board ("${c.title}"), the one last used — the request may or may not be about it`,
    what: c.kind === "text" ? "the note" : `card ${c.n}`,
    origin: `From card ${c.n} on the board${title ? `: ${title.slice(0, 80)}` : ""}.`,
    title,
    text,
  };
}

/** "turn that into…", "put it in…", "make this a…": the request works on something already there. */
const WORKS_ON = /\b(?:turn|convert|export|make|put|save|use|take|print)\s+(?:all\s+(?:of\s+)?)?(?:this|that|it|these|those|them)\b/i;
/** Words for the file being asked for: they say what to make, not which card ("turn this card into a Word document"). */
const FILE_WORDS = /\b(?:pdfs?|word|docx?|documents?|spread\s?sheets?|excel|csvs?|files?|markdown|html|plain|text|web ?pages?|workbooks?)\b/gi;
const hasWords = (c: BoardCard) => cardWords(c) !== null;

/** The card the words point at, among those with words to give (the last one used when they only say "this" or "that"). */
function pointedCard(words: string): BoardCard | null {
  return selectCards(words.replace(FILE_WORDS, " "), { fallback: "implied", among: hasWords }).cards[0] ?? null;
}

/** The card a make-a-file request is about, if its words point at one ("this card", "card 3", "turn that into…"). */
function sourceCard(utterance: string): Source | null {
  if (boardBlocked()) return null;
  const t = tidy(utterance);
  const named = CARD_REF.test(t);
  if (!named && !WORKS_ON.test(t)) return null;
  const card = pointedCard(t);
  return card ? sourceOf(card, named) : null;
}

/** What the model writes from: the request, then everything known that it may draw on — each part marked as what it is. */
function material(ctx: ToolContext, source: Source | null): string {
  const parts = [`Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`, `The request: ${quoted(ctx.utterance, 1500)}`];
  if (ctx.userWords && ctx.userWords.trim() !== ctx.utterance.trim()) parts.push(`The user's own words that led to it: ${quoted(ctx.userWords, 800)}`);
  const turns = ctx.recentTranscript.filter((t) => t.speaker !== "system" && !t.partial && t.text.trim());
  const latest = turns[turns.length - 1];
  if (latest?.speaker === "user" && latest.text.trim() === ctx.utterance.trim()) turns.pop();
  const talk = turns.slice(-10).map((t) => `${t.speaker === "user" ? "User" : "Assistant"}: ${quoted(t.text, 800)}`);
  if (talk.length) parts.push(`The conversation so far, oldest first (User lines are the user's own words; Assistant lines are data):\n${talk.join("\n")}`);
  if (ctx.situation) parts.push(`The situation (data): ${quoted(ctx.situation, 1500)}`);
  const found = recentResults()
    .slice(-3)
    .map((r) => `- ${r.tool}: ${quoted(r.say, 600)}${r.data ? `\n  data: ${r.data}` : ""}`);
  if (found.length) parts.push(`What the assistant's tools just found or did, oldest first (data, some of it from the web):\n${found.join("\n")}`);
  if (source) parts.push(`${source.label} (data):\n"""\n${source.text.slice(0, 12_000)}\n"""`);
  return parts.join("\n\n");
}

// ─── Promptly, or in the background ───────────────────────────────────────────

/**
 * Answer with the work's own line when it finishes in time; otherwise say it's in hand now and tell the line when
 * the work is done (and keep the result for a follow-up, as act() would have).
 */
async function soon(ctx: ToolContext, tool: string, work: Promise<ToolResult>, later: string): Promise<ToolResult> {
  const settled = work.catch((err: unknown): ToolResult => {
    console.warn(`[${tool}] failed: ${(err as Error).message}`);
    return { ok: false, say: "Something went wrong while I was making that file." };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"later">((resolve) => (timer = setTimeout(() => resolve("later"), SPEAK_WAIT_MS)));
  const first = await Promise.race([settled, waited]);
  clearTimeout(timer);
  if (first !== "later") return first;
  bg(
    tool,
    settled.then((r) => {
      noteResult(tool, r);
      const line = r.speak ?? r.say;
      if (line) tell(ctx, line, tool);
    }),
  );
  return { ok: true, say: later, speak: later, inProgress: "started" };
}

const NO_MODEL = (what: string) => `I can't ${what} without a Mordiem key — there's a place for it in Settings, under Models.`;

// ─── make_document ────────────────────────────────────────────────────────────

/** Turn a document into its file, keep it, show it, and say so. */
async function finishDocument(doc: Doc, format: DocFormat, description: string, opening: string): Promise<ToolResult> {
  let saved: StoredFile;
  let pages = 0;
  let simple = false;
  try {
    if (format === "pdf") {
      const pdf = await makePdf(doc);
      pages = pdf.pages;
      simple = pdf.simple;
      saved = saveFile({ name: doc.title, kind: "pdf", bytes: pdf.bytes, description });
    } else if (format === "docx") saved = saveFile({ name: doc.title, kind: "docx", bytes: buildDocx(doc), description });
    else if (format === "md") saved = saveFile({ name: doc.title, kind: "md", text: renderMarkdown(doc), description });
    else if (format === "html") saved = saveFile({ name: doc.title, kind: "html", text: renderHtml(doc), description });
    else saved = saveFile({ name: doc.title, kind: "txt", text: renderText(doc), description });
  } catch (err) {
    return { ok: false, say: storeLine(err, "save that document") };
  }
  used(saved);
  const card = showFileCard(saved);
  const blanks = findBlanks(doc.source).length;
  const line = `${opening} ${quote(saved)} as ${noun(saved.kind)}${pages > 1 ? `, ${pages} pages` : ""}${blanks ? `, with ${count(blanks, "blank")} for you to fill in` : ""}. ${where(card, simple)}`;
  return { ok: true, say: line, speak: line, data: fileData(saved, { card, blanks, ...(pages ? { pages } : {}), ...(format === "pdf" ? { layout: simple ? "simple" : "printed" } : {}) }) };
}

async function composeDocument(ctx: ToolContext, format: DocFormat, source: Source | null): Promise<ToolResult> {
  const written = await writeDocument({ material: material(ctx, source), format });
  if (!written.ok) {
    console.warn(`[make_document] no usable document from the model: ${written.why}`);
    return { ok: false, say: "I couldn't write that document just now: the writing model didn't give me one I could use. Ask me again in a moment." };
  }
  return finishDocument(written.doc, format, written.description, "I've written");
}

const makeDocument: Tool = {
  name: "make_document",
  description:
    "Write a document and save it as a file — a letter, a report, a resume, an invoice, meeting notes, or a card or what was just found turned into a document — as a PDF unless Word, something editable, Markdown or plain text is asked for (“write a letter to my landlord about the heating”, “make a PDF report about…”, “draft a resume”, “turn this card into a Word document”).",
  input: {},
  // The request is the user's whole sentence: fires when it ends.
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    if (!requestWords(ctx.utterance)) return { ok: false, say: "What should the document be?" };
    if (!live.mordiem) return { ok: false, say: NO_MODEL("write documents") };
    const format = docFormat(ctx.utterance);
    const activity = `file:${Date.now().toString(36)}`;
    workspace.activity(activity, `Writing the document (${FORMAT_NOUN[format]})…`);
    const work = composeDocument(ctx, format, sourceCard(ctx.utterance)).finally(() => workspace.activity(activity, null));
    return soon(ctx, "make_document", work, `I'm writing that now, as ${FORMAT_NOUN[format]}. I'll tell you when it's ready.`);
  },
};

// ─── make_spreadsheet ─────────────────────────────────────────────────────────

async function composeSheets(ctx: ToolContext, format: SheetFormat, source: Source | null): Promise<ToolResult> {
  const written = await writeSheets({ material: material(ctx, source), format });
  if (!written.ok) {
    console.warn(`[make_spreadsheet] no usable table from the model: ${written.why}`);
    return { ok: false, say: "I couldn't put that spreadsheet together just now: the model didn't give me a table I could use. Ask me again in a moment." };
  }
  const first = written.sheets[0]!;
  let saved: StoredFile;
  try {
    saved =
      format === "csv"
        ? saveFile({ name: written.title, kind: "csv", text: toCsv([first.columns, ...first.rows]), description: written.description })
        : saveFile({ name: written.title, kind: "xlsx", bytes: buildXlsx(written.sheets, { title: written.title }), description: written.description });
  } catch (err) {
    return { ok: false, say: storeLine(err, "save that spreadsheet") };
  }
  used(saved);
  const card = showFileCard(saved);
  const sheets = format === "csv" ? [first] : written.sheets;
  const rows = sheets.reduce((n, s) => n + s.rows.length, 0);
  const empty = sheets.reduce((n, s) => n + s.rows.reduce((k, r) => k + r.filter((v) => v === null || v === undefined || v === "").length, 0), 0);
  const shape = sheets.length > 1 ? `${count(sheets.length, "sheet")} and ${count(rows, "row")} in all` : `${count(first.columns.length, "column")} and ${count(rows, "row")}`;
  const line = `I've put that in ${noun(saved.kind)} called ${quote(saved)}: ${shape}${empty ? ", with the cells I had nothing for left empty" : ""}. ${where(card)}`;
  return { ok: true, say: line, speak: line, data: fileData(saved, { card, sheets: sheets.length, rows, columns: first.columns, emptyCells: empty }) };
}

const makeSpreadsheet: Tool = {
  name: "make_spreadsheet",
  description:
    "Put data into a spreadsheet file — rows from what the user says, the conversation or what was just found — as an Excel workbook, or a CSV when asked (“put that in a spreadsheet”, “make a budget table in Excel”, “a CSV of those results”).",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    if (!requestWords(ctx.utterance)) return { ok: false, say: "What should go in the spreadsheet?" };
    if (!live.mordiem) return { ok: false, say: NO_MODEL("fill in spreadsheets") };
    const format = sheetFormat(ctx.utterance);
    const activity = `file:${Date.now().toString(36)}`;
    workspace.activity(activity, `Filling in the ${format === "csv" ? "CSV" : "spreadsheet"}…`);
    const work = composeSheets(ctx, format, sourceCard(ctx.utterance)).finally(() => workspace.activity(activity, null));
    return soon(ctx, "make_spreadsheet", work, `I'm putting that into ${FORMAT_NOUN[format]} now. I'll tell you when it's ready.`);
  },
};

// ─── save_file ────────────────────────────────────────────────────────────────

/** The kinds save_file writes: words as they are, or as they are on a page. */
const SAVE_KINDS: FileKind[] = ["txt", "md", "json", "csv", "html", "pdf", "docx"];
const firstWords = (text: string, n = 6) => text.replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ").replace(/[.,;:!?]+$/, "");

/** What Trinity last said, when it's something worth keeping (not a question, not a word or two). */
function lastSaid(ctx: ToolContext): { text: string; card: number | null } | null {
  for (let i = ctx.recentTranscript.length - 1; i >= 0; i--) {
    const turn = ctx.recentTranscript[i]!;
    if (turn.speaker !== "trinity" || turn.partial || !turn.text.trim()) continue;
    const card = /\bcard\s+(\d+)\b/i.exec(turn.text);
    return { text: turn.text.trim(), card: card ? Number(card[1]) : null };
  }
  return null;
}

/** The words a save request means: dictated, on a card, or what was just said. */
function wordsToSave(ask: SaveAsk, ctx: ToolContext): Source | { say: string } {
  if (ask.content) return { label: "", what: "that", origin: "Words you dictated.", title: firstWords(ask.content), text: ask.content };
  const src = ask.source;
  const cards = boardBlocked() ? [] : listCards().filter(hasWords);
  if (cards.length && CARD_REF.test(src)) {
    const card = pointedCard(src);
    const from = card ? sourceOf(card, true) : null;
    if (from) return from;
  }
  const said = lastSaid(ctx);
  const worthKeeping = Boolean(said && said.text.split(/\s+/).length >= 4 && !said.text.endsWith("?"));
  // "the answer", "what you just said" mean Trinity's last line. A bare "that" means the card she just spoke of, else
  // her last line when she said something, else the card last used.
  const meansSaid = /\b(?:answer|reply|response|what you (?:just )?said|what you told me|last thing you said)\b/i.test(src);
  if (!meansSaid && cards.length) {
    const spokenOf = said?.card ? cards.find((c) => c.n === said.card) : undefined;
    const byWords = selectCards(src.replace(FILE_WORDS, " "), { fallback: "none", among: hasWords });
    const card = spokenOf ?? (byWords.how === "pronoun" && worthKeeping ? undefined : byWords.cards[0]);
    const from = card ? sourceOf(card, true) : null;
    if (from) return from;
  }
  if (said && worthKeeping && (meansSaid || PRONOUN_REF.test(src))) return { label: "", what: "what I said", origin: "What Trinity said.", title: firstWords(said.text), text: said.text };
  return { say: "What should I save? Say the words, or name a card on the board." };
}

const saveFileTool: Tool = {
  name: "save_file",
  description:
    "Save words as a file just as they are — text the user dictates, or the text of a note or card on the board — under a name (“save that note as shopping.txt”, “save this as a text file called ideas”, “make a file called todo that says…”).",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    const ask = parseSave(ctx.utterance);
    if (ask.kind && !SAVE_KINDS.includes(ask.kind))
      return { ok: false, say: `I can't save words as ${noun(ask.kind)}. For a spreadsheet, ask me to put it in a spreadsheet; otherwise I can save it as text, Markdown, a PDF or a Word document.` };
    const from = wordsToSave(ask, ctx);
    if ("say" in from) return { ok: false, say: from.say };
    const name = ask.name || from.title || "Note";
    let kind: FileKind = ask.kind ?? "txt";
    let text = from.text.replace(/\r\n?/g, "\n").trim();
    const reasons: string[] = []; // why the file isn't quite what was asked for
    if (kind === "json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        kind = "txt";
        reasons.push("it isn't valid JSON");
      }
    }
    const description = from.origin;
    const saving = (async (): Promise<ToolResult> => {
      let saved: StoredFile;
      let simple = false;
      try {
        if (kind === "pdf" || kind === "docx") {
          // The words on a page, as they are: no title added, nothing rewritten.
          const doc = buildDoc({ title: baseName(sanitizeName(name, kind)), showTitle: false, body: text });
          if (kind === "pdf") {
            const pdf = await makePdf(doc);
            simple = pdf.simple;
            saved = saveFile({ name, kind, bytes: pdf.bytes, description });
          } else saved = saveFile({ name, kind, bytes: buildDocx(doc), description });
        } else saved = saveFile({ name, kind, text: `${kind === "csv" && !text.startsWith(BOM) ? BOM : ""}${text}\n`, description });
      } catch (err) {
        return { ok: false, say: storeLine(err, "save that") };
      }
      used(saved);
      const card = showFileCard(saved);
      if (saved.name !== sanitizeName(name, kind)) reasons.unshift(`${quote({ name: sanitizeName(name, kind) })} was taken`);
      const line = `Saved ${from.what} as ${quote(saved)}, ${noun(saved.kind)}${reasons.length ? `, since ${reasons.join(" and ")}` : ""}. ${where(card, simple)}`;
      return { ok: true, say: line, speak: line, data: fileData(saved, { card }) };
    })();
    return soon(ctx, "save_file", saving, `I'm saving ${from.what} as ${noun(kind)} now. I'll tell you when it's ready.`);
  },
};

// ─── list_files ───────────────────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The whole list as a small page for the board, when there are more files than the voice should name. */
function filesTable(files: StoredFile[]): string {
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const rows = files
    .slice(0, 200)
    .map((f) => `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(capital(bareNoun(f.kind)))}</td><td class="n">${escapeHtml(sizeWords(f.size))}</td><td class="n">${escapeHtml(day(f.createdAt))}</td></tr>`)
    .join("");
  return (
    "<style>body{margin:0;padding:14px;font:13px/1.45 system-ui,sans-serif;color:#e8e8ef;background:#14141f}h1{font-size:15px;margin:0 0 10px}table{width:100%;border-collapse:collapse}" +
    "th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #2a2a3d;vertical-align:top}th{color:#9a9ab8;font-weight:600}.n{text-align:right;white-space:nowrap}</style>" +
    `<h1>Your files (${files.length})</h1><table><thead><tr><th>Name</th><th>Kind</th><th class="n">Size</th><th class="n">Saved</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

const listFilesTool: Tool = {
  name: "list_files",
  description: "Say which files are saved (“what files do I have?”, “list my documents”, “do I have any spreadsheets?”, “is there a file about the trip?”).",
  input: {},
  argMode: "raw",
  source: "builtin",
  async run(_args, ctx): Promise<ToolResult> {
    let all: StoredFile[];
    try {
      all = listFiles();
    } catch (err) {
      return { ok: false, say: storeLine(err, "look at your files") };
    }
    if (!all.length) return { ok: true, say: "You don't have any saved files yet.", speak: "You don't have any saved files yet.", data: { files: [] } };
    const ref = fileRef(ctx.utterance);
    const about = ref.words.length ? findFiles(ref.words.join(" "), ref.kinds.length ? { kinds: ref.kinds } : {}) : null;
    const files = about ?? (ref.kinds.length ? all.filter((f) => ref.kinds.includes(f.kind)) : all);
    const data = { files: files.map(describeFile) };
    if (!files.length) {
      const line = about ? `I don't see a file about that. ${haveLine(all)}` : `You don't have any files of that kind. ${haveLine(all)}`;
      return { ok: true, say: line, speak: line, data };
    }
    const named = files.slice(0, 3).map((f) => `${quote(f)}, ${noun(f.kind)}`);
    const what = about ? "that match" : ref.kinds.length ? "of that kind" : "";
    const line =
      files.length === 1
        ? `You have one file${what ? ` ${what}` : ""}: ${named[0]}.`
        : files.length <= 3
          ? `You have ${files.length} files${what ? ` ${what}` : ""}: ${andList(named)}.`
          : `You have ${files.length} files${what ? ` ${what}` : ""}. The newest are ${andList(named)}; the whole list is on the board.`;
    return { ok: true, say: line, speak: line, data, ...(files.length > 3 && !boardBlocked() ? { render: filesTable(files) } : {}) };
  },
};

// ─── read_file ────────────────────────────────────────────────────────────────

/** A file's text as it is read out: a page without its tags, a table row by row, marks and list bullets gone, lines as phrases. */
function aloud(kind: FileKind, text: string): string {
  let t = text;
  if (kind === "html") t = htmlToText(t);
  else if (kind === "csv")
    t = parseCsv(t)
      .map((r) => r.filter(Boolean).join(", "))
      .filter(Boolean)
      .join(".\n");
  else if (kind === "md")
    t = t
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
      .replace(/\s*\|\s*/g, ", ")
      .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, "$1");
  const lines = t
    .split(/\n+/)
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, "")
        .replace(/^[,\s]+|[,\s]+$/g, "")
        .replace(/\s+/g, " "),
    )
    .filter(Boolean);
  let out = "";
  let before = 0;
  for (const l of lines) {
    const size = l.split(" ").length;
    out += !out ? l : /[.!?:;,]$/.test(out) ? ` ${l}` : before <= 6 && size <= 6 ? `, ${l}` : `. ${l}`;
    before = size;
  }
  return out;
}

const readFileTool: Tool = {
  name: "read_file",
  description: "Read a saved text file aloud, or sum up a long one and offer to read it (“read me the shopping list file”, “what's in my notes file?”, “what does the plan document say?”).",
  input: FILE_ARG,
  options: (arg) => (arg === "file" ? fileOptions() : undefined),
  argMode: "raw",
  available: haveFiles,
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const picked = pickFile(ctx.utterance, args.file);
    if ("say" in picked) return { ok: false, say: picked.say };
    const file = picked.file;
    used(file);
    if (!FILE_KINDS[file.kind].text) return { ok: false, say: `${quote(file)} is ${noun(file.kind)}, so I can't read it aloud. Say open it and I'll put it on the board.`, data: fileData(file) };
    let text: string;
    let truncated: boolean;
    try {
      const got = readText(file.id, READ_CHARS * 3);
      text = aloud(file.kind, got.text);
      truncated = got.truncated;
    } catch (err) {
      return { ok: false, say: storeLine(err, "read that file") };
    }
    if (!text) {
      const line = `${quote(file)} is empty.`;
      return { ok: true, say: line, speak: line, data: fileData(file) };
    }
    const words = text.split(/\s+/).length;
    if (words <= READ_WHOLE_WORDS && !truncated) {
      const line = `${quote(file)} says: ${text}${/[.!?]$/.test(text) ? "" : "."}`;
      return { ok: true, say: line, speak: line, data: fileData(file, { words }) };
    }
    // Long: two sentences on what's in it, and the offer to read it.
    const summary = (await summarizeText(file.name, noun(file.kind), text)) ?? `It begins: ${text.split(" ").slice(0, 30).join(" ")}…`;
    const reading = `${text.slice(0, READ_CHARS)}${text.length > READ_CHARS || truncated ? " That's as far as I'll read aloud: the rest is in the file." : ""}`;
    askYesNo({
      question: `Want me to read ${quote(file)} from the start?`,
      onAnswer: (yes) => {
        const line = yes ? `Here's ${quote(file)}. ${reading}` : "Okay, I'll leave it there.";
        return { ok: true, say: line, speak: line, data: fileData(file) };
      },
    });
    const line = `${summary} It's about ${Math.max(10, Math.round(words / 10) * 10)} words: want me to read it from the start?`;
    return { ok: true, say: line, speak: line, data: fileData(file, { words, summarized: true }) };
  },
};

// ─── open_file ────────────────────────────────────────────────────────────────

const openFileTool: Tool = {
  name: "open_file",
  description: "Show a saved file on the board again and give its link (“open the budget spreadsheet”, “show me the cover letter”, “bring up that PDF”, “where's the file I saved?”).",
  input: FILE_ARG,
  options: (arg) => (arg === "file" ? fileOptions() : undefined),
  argMode: "raw",
  available: haveFiles,
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const picked = pickFile(ctx.utterance, args.file);
    if ("say" in picked) return { ok: false, say: picked.say };
    const file = picked.file;
    used(file);
    const card = showFileCard(file);
    const line = card
      ? `${quote(file)}, ${noun(file.kind)}, is on the board as card ${card}, with its link.`
      : `${quote(file)}, ${noun(file.kind)}, is saved with your files, but a game has the board right now, so I can't show it there.`;
    return { ok: Boolean(card), say: line, speak: line, data: fileData(file, { card }) };
  },
};

// ─── delete_file ──────────────────────────────────────────────────────────────

/** The delete that is waiting for its yes, so that asking again repeats the question instead of starting over. */
let deleting: { question: string; ids: string; questionId: string } | null = null;

const deleteFileTool: Tool = {
  name: "delete_file",
  description: "Delete a saved file, after asking to be sure (“delete the shopping file”, “get rid of that PDF”, “delete all my files”).",
  input: FILE_ARG,
  options: (arg) => (arg === "file" ? fileOptions() : undefined),
  argMode: "raw",
  available: haveFiles,
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const ref = fileRef(ctx.utterance);
    let files: StoredFile[];
    if (ref.all && !ref.words.length) {
      const all = filesOrNone();
      files = ref.kinds.length ? all.filter((f) => ref.kinds.includes(f.kind)) : all;
      if (!files.length) return { ok: false, say: all.length ? `You don't have any files of that kind. ${haveLine(all)}` : "You don't have any saved files yet." };
    } else {
      const picked = pickFile(ctx.utterance, args.file);
      if ("say" in picked) return { ok: false, say: picked.say };
      files = [picked.file];
    }
    const one = files.length === 1 ? files[0]! : null;
    const question = one
      ? `Delete ${quote(one)}, the ${bareNoun(one.kind)}, for good? To go ahead, say: yes, delete it.`
      : `Delete all ${files.length} of ${ref.kinds.length ? "those" : "your"} files? It can't be undone.`;
    const ids = files.map((f) => f.id).join(",");
    // Asked again while the same question waits (Jev took "yes, delete it" for a new request): the question stands, and is repeated.
    if (deleting && deleting.ids === ids && pendingQuestion()?.id === deleting.questionId) {
      // (The single file's question already says what to answer; for everything, say it here.)
      const again = one ? deleting.question : `${deleting.question} To go ahead, say: yes, delete all. Or say no to keep them.`;
      return { ok: true, say: again, speak: again, data: { asking: true, files: files.map((f) => f.id) } };
    }
    const questionId = askYesNo({
      question,
      // A stray "yeah" (or her own "okay" heard back) deletes nothing: the yes has to say delete.
      require: one ? ["delete"] : ["delete", "all"],
      onAnswer: (yes) => {
        deleting = null;
        if (!yes) {
          const kept = one ? `Okay, I've kept ${quote(one)}.` : "Okay, I've kept them all.";
          return { ok: true, say: kept, speak: kept };
        }
        const gone: StoredFile[] = [];
        let failed = "";
        for (const f of files) {
          try {
            const removed = deleteFile(f.id);
            if (removed) gone.push(removed);
          } catch (err) {
            failed = storeLine(err, `delete ${quote(f)}`);
          }
        }
        if (lastUsed && gone.some((f) => f.id === lastUsed?.id)) lastUsed = null;
        const line = failed
          ? `${gone.length ? `Deleted ${count(gone.length, "file")}, but not all of them. ` : ""}${failed}`
          : one
            ? gone.length
              ? `Deleted ${quote(one)}.`
              : `${quote(one)} was already gone.`
            : `Deleted ${count(gone.length, "file")}.`;
        return { ok: !failed, say: line, speak: line, data: { deleted: gone.map((f) => f.id) } };
      },
    });
    deleting = { question, ids, questionId };
    return { ok: true, say: question, speak: question, data: { asking: true, files: files.map((f) => f.id) } };
  },
};

// ─── rename_file ──────────────────────────────────────────────────────────────

const renameFileTool: Tool = {
  name: "rename_file",
  description: "Give a saved file another name (“rename the budget file to household budget”, “call that file groceries”, “change the name of the letter to landlord letter”).",
  input: FILE_ARG,
  options: (arg) => (arg === "file" ? fileOptions() : undefined),
  argMode: "raw",
  available: haveFiles,
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const splits = renameSplits(ctx.utterance);
    if (!splits.length) return { ok: false, say: "Which file, and what should it be called? Say something like: rename the budget file to household budget." };
    // Where the request splits into the file and its new name: the split whose file words all fit a file, else the first that finds one.
    let chosen: { file: StoredFile; name: string } | null = null;
    let fallback: { file: StoredFile; name: string } | null = null;
    let problem = "";
    for (const s of splits) {
      const picked = pickFile(s.target, args.file);
      if ("say" in picked) {
        problem ||= picked.say;
        continue;
      }
      const words = fileRef(s.target).words;
      if (words.every((w) => findFiles(w).some((f) => f.id === picked.file.id))) {
        chosen = { file: picked.file, name: s.name };
        break;
      }
      fallback ??= { file: picked.file, name: s.name };
    }
    chosen ??= fallback;
    if (!chosen) return { ok: false, say: problem || "I couldn't tell which file you mean." };
    const before = chosen.file;
    const wanted = sanitizeName(chosen.name, before.kind);
    let after: StoredFile;
    try {
      after = renameFile(before.id, chosen.name);
    } catch (err) {
      return { ok: false, say: storeLine(err, "rename that file") };
    }
    used(after);
    const line =
      after.name === before.name
        ? `${quote(before)} already has that name.`
        : after.name === wanted
          ? `Renamed ${quote(before)} to ${quote(after)}.`
          : `Renamed ${quote(before)} to ${quote(after)}, since ${quote({ name: wanted })} was taken.`;
    return { ok: true, say: line, speak: line, data: fileData(after, { was: before.name }) };
  },
};

// ─── Registration ─────────────────────────────────────────────────────────────

let wired = false;

export function registerFileTools(): void {
  [makeDocument, makeSpreadsheet, saveFileTool, listFilesTool, readFileTool, openFileTool, deleteFileTool, renameFileTool].forEach(registerTool);
  if (wired) return;
  wired = true;
  onFileChange(followStore);
  registerContextProvider({
    // Jev and the reply writer know which files there are, so "read the shopping file" means something.
    describe: () => {
      if (boardBlocked()) return null;
      const files = filesOrNone();
      if (!files.length) return null;
      return `Saved files (${files.length}): ${files
        .slice(0, 6)
        .map((f) => `“${f.name}”`)
        .join(", ")}${files.length > 6 ? ", and older ones" : ""}.`;
    },
    rules: () =>
      boardBlocked()
        ? []
        : [
            "A document to keep, send or print — a letter, a report, a resume, an invoice, 'a PDF of…', 'a Word document' — is make_document; information laid out on the board is show_card, and a quick note on the board is make_text.",
            "Data put into a file — 'a spreadsheet', 'an Excel file', 'a CSV' — is make_spreadsheet; a table or chart shown on the board is show_card or build_ui.",
            "'Save that as a file', 'save the note as shopping.txt' is save_file (the words as they are); 'remember that…' is remember.",
            "read_file, open_file, rename_file and delete_file act on saved files (the user says file, document, PDF, spreadsheet, or a saved file's name); read_card, rename_card and remove_card act on cards on the board.",
          ],
    // At the game table "I write a letter to the king" is a move in the story, not a document.
    hiddenActions: () => (boardBlocked() ? FILE_TOOLS : []),
  });
}
