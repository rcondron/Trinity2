import type { FileKind } from "../services/files.js";
import type { DocFormat, SheetFormat } from "./authoring.js";

/**
 * What a spoken request about files says, read from the words alone: which format a document should be, what a file
 * to save is called and what goes in it, which saved file is meant, what a file is renamed to.
 *
 * The words are a transcript, not typing: they come with fillers ("um, okay, so…"), sentence punctuation, and file
 * names as they were heard ("shopping dot t x t", "Shopping.TXT."). Everything here reads them after tidy().
 */

/** Extensions as they may be written or heard, and the kind each means. */
const EXT_KIND: Record<string, FileKind> = { txt: "txt", text: "txt", md: "md", markdown: "md", json: "json", csv: "csv", html: "html", htm: "html", pdf: "pdf", doc: "docx", docx: "docx", xlsx: "xlsx", xls: "xlsx" };
const EXT_RE = /\.(txt|text|md|markdown|json|csv|html?|pdf|docx?|xlsx?)$/i;

/** One spelling for what was heard: straight quotes, single spaces, and "dot t x t" / "dot text" as ".txt". */
export function tidy(utterance: string): string {
  return utterance
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+dot\s+((?:[a-z]\s?){2,5}|markdown)(?=$|[\s.,!?])/gi, (whole, e: string) => {
      const ext = e.replace(/\s+/g, "").toLowerCase();
      return EXT_KIND[ext] ? `.${ext}` : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER = /^(?:(?:um+|uh+|er+|erm|hmm+|ah+|oh|hey|hi|hello|ok(?:ay)?|so|well|right|alright|all right|now|yeah|yes|yep|please|trinity|listen|and|also|then|actually)\b[\s,.!…-]*)+/i;
const ASKING = /^(?:(?:can|could|would|will) you(?: please| kindly| just| go ahead and)*|i(?:'d| would) (?:like|love)(?: for)?(?: you)? to|i (?:want|need)(?: you)? to|go ahead and|please|just|let's|kindly)\b[\s,]*/i;

/** Without what comes before the request itself: fillers, a greeting, "could you please". */
export function withoutLead(words: string): string {
  let t = words.trim();
  for (let i = 0; i < 6; i++) {
    const next = t.replace(FILLER, "").replace(ASKING, "");
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Without what trails after it: "please", "for me", "thanks", the full stop. */
export function withoutTail(words: string): string {
  return words
    .replace(/(?:[\s,]+(?:please|for me|thanks|thank you|if you (?:can|could|would)|right now|right away|real quick|asap|as soon as (?:possible|you can|you could)|when you (?:can|get a chance|have a (?:moment|minute|second))))*[\s.!?…]*$/i, "")
    .trim();
}

const requestWords = (utterance: string) => withoutTail(withoutLead(tidy(utterance)));

// ─── Which format ─────────────────────────────────────────────────────────────

const FORMAT_WORDS: [DocFormat, RegExp][] = [
  ["pdf", /\bpdfs?\b|\bp\.\s?d\.\s?f\b/gi],
  ["docx", /\bdocx\b|\bword\s+(?:docs?|documents?|files?|format|version)\b|\b(?:microsoft|ms)\s+word\b|\b(?:in|as|into|to)\s+word\b(?!\s+(?:count|it|this|that|for|form))|\beditable\b|\b(?:i|we)\s+can\s+edit\b|\bcan\s+be\s+edited\b/gi],
  ["md", /\bmarkdown\b|\.md\b/gi],
  ["txt", /\bplain[- ]?text\b|\btext\s+(?:files?|documents?)\b|\btxt\b/gi],
  ["html", /\bhtml\b|\bweb ?pages?\b/gi],
];
/** "…, not a PDF", "instead of Word": the format after it is the one not wanted. */
const NOT_THIS = /\b(?:not|instead of|rather than|don't want|no)\s+(?:an?\s+|the\s+)?$/i;
/** "…into a PDF", "as an editable …": the format asked for, over one that is only mentioned. */
const AS_THIS = /\b(?:as|into|in|to|want|need|make it)\s+(?:an?\s+|the\s+)?(?:editable\s+|printable\s+)?$/i;
/** Notes, minutes, an outline, a checklist: kept as Markdown unless a format is named. */
const NOTES = /\bnotes\b|\b(?:meeting|study|lecture|class|quick)\s+notes?\b|\bminutes\s+(?:of|from|for)\b|\ban?\s+outline\b|\ba\s+checklist\b|\ba\s+to-?do\s+list\b|\ba\s+cheat\s?sheet\b|\ba\s+study\s+guide\b/i;

/**
 * The format a document should be made in: the one the words name (Word or "editable" → docx; PDF; Markdown; plain
 * text; a web page), else Markdown for notes, else a PDF — the thing to send or print.
 */
export function docFormat(utterance: string): DocFormat {
  const t = tidy(utterance);
  let best: { format: DocFormat; at: number; asked: boolean } | null = null;
  for (const [format, re] of FORMAT_WORDS) {
    for (const m of t.matchAll(re)) {
      const before = t.slice(0, m.index);
      if (NOT_THIS.test(before)) continue;
      const asked = AS_THIS.test(before) || /^(?:in|as|into|to)\s/i.test(m[0]) || /editable|edit/i.test(m[0]);
      if (!best || (asked && !best.asked) || (asked === best.asked && m.index < best.at)) best = { format, at: m.index, asked };
    }
  }
  return best ? best.format : NOTES.test(t) ? "md" : "pdf";
}

/** A CSV when the words ask for one, else an Excel workbook. */
export function sheetFormat(utterance: string): SheetFormat {
  return /\bcsv\b|\bcomma[- ]separated\b/i.test(tidy(utterance)) ? "csv" : "xlsx";
}

// ─── What is meant on the board ───────────────────────────────────────────────

/** The words point at a card on the board: its number, or "this card", "that note", "the recipe card". */
export const CARD_REF = /\bcards?\s*(?:number\s*)?\d+\b|\b(?:this|that|the|my)\s+(?:[\w'-]+\s+){0,3}(?:card|note|sticky|list|recipe|widget|table|chart)\b/i;
/** The words point at something without naming it. */
export const PRONOUN_REF = /\b(?:this|that|it|these|those|them)\b/i;

// ─── Saving ───────────────────────────────────────────────────────────────────

export interface SaveAsk {
  /** The name asked for, as said ("shopping.txt", "my ideas") — or null. */
  name: string | null;
  /** The kind the name's extension or the words give ("as a text file") — or null. */
  kind: FileKind | null;
  /** Words dictated for the file ("…that says buy milk") — or null. */
  content: string | null;
  /** What is left of the request: the words that point at the thing to save ("save that note"). */
  source: string;
}

/** A kind said in words ("as a text file", "as markdown") — never the extension on a name ("recipe.markdown": that's the name). */
const KIND_PHRASES: [RegExp, FileKind][] = [
  [/\b(?:as|to|in|into)\s+(?:an?\s+)?(?:plain[- ]?)?(?:text|txt)(?:\s+(?:file|document|doc))?\b|(?<!\.)\b(?:plain[- ]?)?(?:text|txt)\s+(?:file|document|doc)\b/i, "txt"],
  [/(?<!\.)\b(?:(?:as|to|in|into)\s+(?:an?\s+)?)?(?<!\.)markdown(?:\s+(?:file|document|doc))?\b|(?<!\.)\bmd\s+file\b/i, "md"],
  [/(?<!\.)\b(?:(?:as|to|in|into)\s+(?:an?\s+)?)?(?<!\.)json(?:\s+file)?\b/i, "json"],
  [/(?<!\.)\b(?:(?:as|to|in|into)\s+(?:an?\s+)?)?(?<!\.)csv(?:\s+file)?\b/i, "csv"],
  [/(?<!\.)\b(?:(?:as|to|in|into)\s+(?:an?\s+)?)?(?<!\.)(?:html(?:\s+(?:file|page))?|web ?page)\b/i, "html"],
  [/(?<!\.)\b(?:(?:as|to|in|into)\s+(?:an?\s+)?)?(?<!\.)pdf(?:\s+(?:file|document))?\b/i, "pdf"],
  [/(?<!\.)\b(?:(?:as|to|in|into)\s+(?:an?\s+)?)?(?<!\.)(?:docx|word\s+(?:doc(?:ument)?|file))\b|\b(?:as|in|into)\s+word\b/i, "docx"],
];

/** Dictated words after a marker: "…that says X", "…saying X", "…with the text X", "…and put X in it". */
const SAID = /\s+(?:that|which)\s+(?:says|reads)\s*[:,]?\s+(.+)$|\s+saying\s*[:,]?\s+(.+)$|\s+with\s+the\s+(?:text|words|contents?)\s*[:,]?\s+(.+)$|\s+and\s+(?:put|write)\s+(.+?)\s+in\s+it$/i;
/** The start of something that points at a thing rather than being the words to save. */
const POINTS = /^(?:(?:that|this|it|them|these|those|what|your|everything|all)\b|(?:the|my|our)\s|cards?\s*\d|notes?\s*\d|an?\s+(?:new\s+)?(?:file|note|text|document)\b)/i;
const NOT_A_NAME = /^(?:an?|the|my)\s+(?:new\s+)?(?:file|document|doc|note|text|copy)$/i;

function cleanName(raw: string | undefined): string | null {
  const said = (raw ?? "").replace(/^["'\s]+|["'\s.,!?;:]+$/g, "").trim();
  if (!said || NOT_A_NAME.test(said) || said.split(/\s+/).length > 8) return null;
  // "the shopping file" is called "shopping".
  const name = said
    .replace(/\s+file$/i, "")
    .replace(/^(?:the|an?)\s+/i, "")
    .trim();
  return name || null;
}

/** A request to save something as a file, taken apart. */
export function parseSave(utterance: string): SaveAsk {
  let t = requestWords(utterance);
  let content: string | null = null;
  let name: string | null = null;
  let kind: FileKind | null = null;

  const said = SAID.exec(t);
  if (said) {
    content = (said[1] ?? said[2] ?? said[3] ?? said[4] ?? "").trim() || null;
    t = t.slice(0, said.index).trim();
  } else {
    // "save this as notes.txt: remember to call the plumber" — a colon and a space (never the one in "5:30").
    const colon = /^(.{4,90}?):\s+(\S.*)$/.exec(t);
    if (colon && /\b(?:save|file|write|store|note|down|as|called|named)\b/i.test(colon[1]!)) {
      content = colon[2]!.trim();
      t = colon[1]!.trim();
    }
  }

  for (const [re, k] of KIND_PHRASES) {
    const m = re.exec(t);
    if (!m) continue;
    kind = k;
    t = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
    break;
  }

  // The name: after "called / named", "call it", "as", or a word that ends in a file extension.
  const NAMED: RegExp[] = [
    /\b(?:called|named|titled|entitled)\s+(.+)$/i,
    /\b(?:call|name|title)\s+it\s+(.+)$/i,
    /\bas\s+(?!soon\b|well\b|is\b|it\b|usual\b|always\b|before\b)(.+)$/i,
    /\b(?:to|in|into)\s+([\w'-]+\.(?:txt|text|md|markdown|json|csv|html?|pdf|docx?))$/i,
  ];
  const making = /^(?:create|make|start|begin|write)\b/i.test(t);
  for (const re of NAMED) {
    const m = re.exec(t);
    if (!m) continue;
    let said = m[1]!;
    // "make a file called groceries with milk, eggs and bread": the rest is what goes in it (a name saved under may hold a "with").
    const withWords = content === null && making ? /^(.+?)\s+(?:with|containing|that has)\s+(.+)$/i.exec(said) : null;
    if (withWords) {
      said = withWords[1]!;
      content = withWords[2]!.trim();
    }
    const cleaned = cleanName(said);
    if (!cleaned) continue;
    name = cleaned;
    t = t.slice(0, m.index).trim();
    break;
  }
  const ext = name ? EXT_RE.exec(name) : null;
  if (ext) kind = EXT_KIND[ext[1]!.toLowerCase()] ?? kind;

  // "save buy milk and eggs (as …)", "put call the plumber in a file": the words themselves, unless they point at something.
  if (content === null) {
    const m =
      /^(?:write|put|store|save|stick|drop|jot|note)\s+(?:down\s+)?(.+?)\s+(?:in|into|to|on)\s+(?:an?|the|my)\s+(?:new\s+)?(?:(?:text|txt)\s+)?file\b/i.exec(t) ??
      /^(?:save|write|store|jot|note)\s+(?:down\s+)?(.+)$/i.exec(t);
    const words = m?.[1]?.trim();
    if (words && !POINTS.test(words) && words.split(/\s+/).length >= 2) content = words;
  }
  return { name, kind, content, source: t };
}

// ─── Renaming ─────────────────────────────────────────────────────────────────

/**
 * The ways a rename request may split into the file meant and its new name, likeliest first ("rename the letter to
 * the landlord to rent letter" splits at either "to"; the one whose first half names a file is the one meant).
 */
export function renameSplits(utterance: string): { target: string; name: string }[] {
  const t = requestWords(utterance);
  const out: { target: string; name: string }[] = [];
  const add = (target: string | undefined, name: string | undefined) => {
    const n = (name ?? "").replace(/^["'\s]+|["'\s.,!?;:]+$/g, "").replace(/\s+instead$/i, "").trim();
    const tg = (target ?? "").trim();
    if (n && tg) out.push({ target: tg, name: n });
  };
  const body = /\brename\s+(.+)$/i.exec(t)?.[1] ?? /\bchange\s+(?:the\s+)?(?:name|title)\s+of\s+(.+)$/i.exec(t)?.[1];
  if (body) {
    // Every " to " / " as " is a place the request may split; the last one first (names rarely hold a "to", files often do).
    const cuts = [...body.matchAll(/\s+(?:to|as)\s+/gi)].reverse();
    for (const c of cuts) add(body.slice(0, c.index), body.slice(c.index + c[0].length));
    return out;
  }
  const call = /\b(?:call|name|title)\s+(.+?\b(?:file|document|doc|pdf|spreadsheet|sheet|csv|it|that|this|one))\s+(.+)$/i.exec(t);
  if (call) add(call[1], call[2]);
  const give = /\bgive\s+(.+?)\s+(?:the|a new|a different|another)\s+name\s+(?:of\s+)?(.+)$/i.exec(t);
  if (give) add(give[1], give[2]);
  return out;
}

// ─── Which saved file ─────────────────────────────────────────────────────────

export interface FileRef {
  /** The words that could name the file (its name or what it's about), without the request around them. */
  words: string[];
  /** The kinds the words allow ("the PDF", "the spreadsheet") — empty: any. */
  kinds: FileKind[];
  /** "the latest file", "the oldest one". */
  recency: "newest" | "oldest" | null;
  /** "all my files", "every PDF". */
  all: boolean;
}

const KIND_REFS: [RegExp, FileKind[]][] = [
  [/\bpdfs?\b/g, ["pdf"]],
  [/\bword\s+(?:docs?|documents?|files?)\b|\bdocx\b/g, ["docx"]],
  [/\bexcel(?:\s+(?:files?|sheets?|workbooks?|spreadsheets?))?\b|\bxlsx\b|\bworkbooks?\b/g, ["xlsx"]],
  [/\bspread\s?sheets?\b/g, ["xlsx", "csv"]],
  [/\bcsvs?(?:\s+files?)?\b/g, ["csv"]],
  [/\b(?:text|txt)\s+files?\b|\btxt\b/g, ["txt"]],
  [/\bmarkdown(?:\s+files?)?\b/g, ["md"]],
  [/\bjson(?:\s+files?)?\b/g, ["json"]],
  [/\bhtml(?:\s+files?)?\b|\bweb ?pages?\b/g, ["html"]],
  [/\bzips?(?:\s+files?)?\b/g, ["zip"]],
  [/\b(?:pictures?|images?|photos?)\b/g, ["png", "jpg", "gif", "webp"]],
];
const WRITTEN: FileKind[] = ["pdf", "docx", "md", "txt", "html"];

const REF_STOP = new Set(
  (
    "read reading open show display view pull bring up find get fetch see look where is are was were delete remove erase trash discard rename call name change rid " +
    "me my mine the a an please out loud aloud again back to of for in on at into it its it's what what's whats does do did say says said tell about contents content inside " +
    "that this these those them i you we can could would will want need like have has had file files document documents doc docs saved save called named titled one ones and or " +
    "with from all every everything last latest newest recent recently most oldest first earliest just made make wrote written write created new old any there which got " +
    "yesterday today tonight earlier before ago now then asked gave sent told thing stuff"
  ).split(/\s+/),
);

/** Which saved file a request is about, as far as its words go. */
export function fileRef(utterance: string): FileRef {
  let t = requestWords(utterance).toLowerCase();
  const kinds: FileKind[] = [];
  for (const [re, ks] of KIND_REFS) {
    if (!re.test(t)) continue;
    re.lastIndex = 0;
    for (const k of ks) if (!kinds.includes(k)) kinds.push(k);
    t = t.replace(re, " ");
  }
  if (!kinds.length && /\b(?:documents?|docs?)\b/.test(t)) kinds.push(...WRITTEN);
  const recency = /\b(?:last|latest|newest|most recent|just (?:made|saved|wrote|created))\b/.test(t) ? "newest" : /\b(?:oldest|earliest|first)\b/.test(t) ? "oldest" : null;
  const all = /\b(?:all|every|everything)\b/.test(t);
  const words = t
    .replace(EXT_RE, "")
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 2 && !REF_STOP.has(w));
  return { words: [...new Set(words)], kinds, recency, all };
}
