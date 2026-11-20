import { isoDate, type Cell } from "./csv.js";
import { APP_PROPS, REL, RELS_NS, corePropsXml, packageRels } from "./opc.js";
import { XML_HEAD, xmlAttr, xmlSafe, xmlText } from "./xml.js";
import { zipSync } from "./zip.js";

/**
 * An Excel workbook (.xlsx) from rows: SpreadsheetML in an OPC package, written by hand. One worksheet per sheet, a
 * bold shaded header row, column widths from what the cells hold, text in the shared-strings table (what Excel itself
 * writes, and what every reader takes), numbers as numbers, yes/no as booleans, dates as ISO text. Text is always a
 * string cell — never a formula — so a value that starts with "=" is shown, not run.
 */

export interface Sheet {
  name: string;
  /** The header row. */
  columns: string[];
  rows: Cell[][];
}

const MAIN_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
/** Excel's own limits. */
const MAX_CELL_CHARS = 32_767;
const MAX_COLS = 16_384;
const MAX_ROWS = 1_048_576;
/** Cell styles (indexes into cellXfs below). */
const STYLE_HEADER = 1;
const STYLE_WRAP = 2;

/** "A", "B", … "Z", "AA", … for a zero-based column. */
export function columnName(index: number): string {
  let out = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** Sheet names Excel accepts: at most 31 characters, none of \ / ? * [ ] :, no apostrophe at either end, not "History", all different. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let name = xmlSafe(String(raw ?? ""))
      .replace(/[\\/?*[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^'+|'+$/g, "")
      .slice(0, 31)
      .trim();
    if (!name || name.toLowerCase() === "history") name = `Sheet${i + 1}`;
    let unique = name;
    for (let k = 2; used.has(unique.toLowerCase()); k++) {
      const suffix = ` (${k})`;
      unique = `${name.slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    used.add(unique.toLowerCase());
    return unique;
  });
}

/** The shared-strings table: each distinct text once, cells point at it by index. */
class Strings {
  private readonly index = new Map<string, number>();
  private uses = 0;

  id(text: string): number {
    this.uses++;
    let i = this.index.get(text);
    if (i === undefined) {
      i = this.index.size;
      this.index.set(text, i);
    }
    return i;
  }

  xml(): string {
    const items = [...this.index.keys()].map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join("");
    return `${XML_HEAD}<sst ${MAIN_NS} count="${this.uses}" uniqueCount="${this.index.size}">${items}</sst>`;
  }
}

type Written = { kind: "empty" } | { kind: "number"; value: number } | { kind: "bool"; value: boolean } | { kind: "text"; value: string };

function written(v: Cell): Written {
  if (v === null || v === undefined) return { kind: "empty" };
  if (typeof v === "number") return Number.isFinite(v) ? { kind: "number", value: v } : { kind: "empty" };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  const text = xmlSafe(v instanceof Date ? isoDate(v) : String(v)).slice(0, MAX_CELL_CHARS);
  return text ? { kind: "text", value: text } : { kind: "empty" };
}

function sheetXml(sheet: Sheet, strings: Strings, first: boolean): string {
  const header = sheet.columns.slice(0, MAX_COLS).map((c) => String(c ?? ""));
  const grid: Cell[][] = [header, ...sheet.rows.slice(0, MAX_ROWS - 1).map((r) => r.slice(0, MAX_COLS))];
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  const rowsXml: string[] = [];
  grid.forEach((row, r) => {
    let cells = "";
    row.forEach((v, c) => {
      const w = written(v);
      if (w.kind === "empty") return;
      const ref = `${columnName(c)}${r + 1}`;
      const style = r === 0 ? STYLE_HEADER : w.kind === "text" && w.value.includes("\n") ? STYLE_WRAP : 0;
      const s = style ? ` s="${style}"` : "";
      if (w.kind === "number") cells += `<c r="${ref}"${s}><v>${w.value}</v></c>`;
      else if (w.kind === "bool") cells += `<c r="${ref}"${s} t="b"><v>${w.value ? 1 : 0}</v></c>`;
      else cells += `<c r="${ref}"${s} t="s"><v>${strings.id(w.value)}</v></c>`;
      const shown = w.kind === "text" ? Math.max(...w.value.split("\n").map((l) => l.length)) : w.kind === "bool" ? 5 : String(w.value).length;
      widths[c] = Math.max(widths[c] ?? 0, shown + (r === 0 ? 1 : 0)); // bold runs a little wider
    });
    if (cells) rowsXml.push(`<row r="${r + 1}">${cells}</row>`);
  });
  const colsXml = widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>`).join("");
  const lastRow = Math.max(1, grid.length);
  return (
    `${XML_HEAD}<worksheet ${MAIN_NS}>` +
    `<dimension ref="A1:${columnName(cols - 1)}${lastRow}"/>` +
    `<sheetViews><sheetView${first ? ' tabSelected="1"' : ""} workbookViewId="0"/></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${colsXml}</cols>` +
    `<sheetData>${rowsXml.join("")}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    "</worksheet>"
  );
}

/** Two fonts (plain, bold), three fills (the two Excel requires, the header's), two borders, and the three cell styles. */
const STYLES =
  `${XML_HEAD}<styleSheet ${MAIN_NS}>` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEFF3"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA1AC"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** The .xlsx bytes for one or more sheets. `date` stamps the properties and the archive (default: now). */
export function buildXlsx(sheets: Sheet[], opts: { title?: string; date?: Date } = {}): Uint8Array {
  const list = sheets.length ? sheets : [{ name: "Sheet1", columns: [], rows: [] }];
  const date = opts.date ?? new Date();
  const names = sheetNames(list.map((s) => s.name));
  const strings = new Strings();
  const sheetParts = list.map((s, i) => sheetXml(s, strings, i === 0));
  const n = list.length;
  const workbook =
    `${XML_HEAD}<workbook ${MAIN_NS} xmlns:r="${REL}"><bookViews><workbookView/></bookViews>` +
    `<sheets>${names.map((name, i) => `<sheet name="${xmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const workbookRels =
    `${XML_HEAD}<Relationships ${RELS_NS}>` +
    list.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>";
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    list.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>";
  return zipSync(
    [
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: packageRels("xl/workbook.xml") },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
      ...sheetParts.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
      { name: "xl/styles.xml", data: STYLES },
      { name: "xl/sharedStrings.xml", data: strings.xml() },
      { name: "docProps/core.xml", data: corePropsXml(opts.title || names[0] || "Workbook", date) },
      { name: "docProps/app.xml", data: APP_PROPS },
    ],
    { date },
  );
}
