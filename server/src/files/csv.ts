/**
 * CSV as RFC 4180 has it: fields joined by commas, records by CRLF; a field holding a quote, a comma or a line break
 * (or edged with a space) goes in double quotes with its quotes doubled. A UTF-8 byte-order mark goes first so Excel
 * reads the accents. The reader takes back what the writer made — and LF-only files, and files with no mark.
 */

import { BOM, withoutBom } from "./xml.js";

export type Cell = string | number | boolean | Date | null | undefined;

/** A date as ISO text: the day alone when it has no time of day, else the full instant. */
export function isoDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return d.toISOString();
}

/** What a spreadsheet would run as a formula when the cell starts with it. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** …unless it's simply a number ("-12.5", "+3"). */
const SIGNED_NUMBER = /^[+-]?\d[\d,]*(?:\.\d+)?%?$/;

export interface CsvOptions {
  /** Lead with a byte-order mark (default true: Excel needs it to read UTF-8). */
  bom?: boolean;
  /**
   * Put an apostrophe before text a spreadsheet would run as a formula ("=HYPERLINK(…)", "@SUM", "+cmd|…"), so a
   * value copied from the web can't act when the file is opened (default true; plain signed numbers are left alone).
   */
  guardFormulas?: boolean;
}

export function toCsv(rows: Cell[][], opts: CsvOptions = {}): string {
  const guard = opts.guardFormulas ?? true;
  const field = (v: Cell): string => {
    let s: string;
    if (v === null || v === undefined) s = "";
    else if (typeof v === "number") s = Number.isFinite(v) ? String(v) : "";
    else if (typeof v === "boolean") s = v ? "TRUE" : "FALSE";
    else if (v instanceof Date) s = isoDate(v);
    else {
      s = String(v);
      if (guard && FORMULA_START.test(s) && !SIGNED_NUMBER.test(s)) s = `'${s}`;
    }
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => r.map(field).join(",")).join("\r\n");
  return `${(opts.bom ?? true) ? BOM : ""}${body}${rows.length ? "\r\n" : ""}`;
}

/** Records and fields of a CSV text (every field a string). A final line break doesn't make an empty record. */
export function parseCsv(text: string): string[][] {
  const s = withoutBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false; // inside a quoted field
  let started = false; // the current record has something in it (a field, or a comma)
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
