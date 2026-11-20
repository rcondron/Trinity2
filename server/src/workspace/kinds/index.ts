/*
 * The kinds the board draws from data, by kind: what a card of each kind holds (normalizeKindData), what it is in a
 * few words (kindSummary: the board's description) and what read_card works from (kindText). See kinds/data.ts for
 * the kinds themselves and kinds/render.ts for how the board draws them.
 */
import {
  chartSummary,
  chartText,
  codeSummary,
  documentPlain,
  documentSummary,
  fileSummary,
  normalizeChart,
  normalizeCode,
  normalizeDocument,
  normalizeFile,
  normalizeTable,
  sizeText,
  tableSummary,
  tableText,
  type ChartData,
  type CodeData,
  type DocumentData,
  type FileCardData,
  type TableData,
} from "./data.js";

export type DataKind = "table" | "chart" | "document" | "code" | "file";
export const DATA_KIND_NAMES: readonly DataKind[] = ["table", "chart", "document", "code", "file"];
export const isDataKindName = (k: unknown): k is DataKind => typeof k === "string" && (DATA_KIND_NAMES as readonly string[]).includes(k);

/** The data a card of this kind holds, cut down to what it may hold — or null when there is nothing to show. */
export function normalizeKindData(kind: DataKind, raw: unknown): unknown {
  switch (kind) {
    case "table":
      return normalizeTable(raw);
    case "chart":
      return normalizeChart(raw);
    case "document":
      return normalizeDocument(raw);
    case "code":
      return normalizeCode(raw);
    case "file":
      return normalizeFile(raw);
  }
}

interface WithData {
  kind: string;
  data?: unknown;
}

/** A card's data as its kind has it (a card saved by hand or by an older build is checked again), or null. */
function dataOf(c: WithData): unknown {
  return isDataKindName(c.kind) && c.data !== undefined && c.data !== null ? normalizeKindData(c.kind, c.data) : null;
}

/** What a data card holds, in a few words ("a table of 120 rows and 5 columns: …"); null for other cards. */
export function kindSummary(c: WithData): string | null {
  const d = dataOf(c);
  if (!d) return null;
  switch (c.kind) {
    case "table":
      return tableSummary(d as TableData);
    case "chart":
      return chartSummary(d as ChartData);
    case "document":
      return documentSummary(d as DocumentData);
    case "code":
      return codeSummary(d as CodeData);
    case "file":
      return fileSummary(d as FileCardData);
  }
  return null;
}

/** What read_card works from for a data card: the summary first, then as much of the content as fits. */
export function kindText(c: WithData, maxChars = 3500): string | null {
  const d = dataOf(c);
  if (!d) return null;
  switch (c.kind) {
    case "table":
      return tableText(d as TableData, maxChars);
    case "chart":
      return chartText(d as ChartData, maxChars);
    case "document": {
      const doc = d as DocumentData;
      return `${documentSummary(doc)}.\n${documentPlain(doc)}`.slice(0, maxChars);
    }
    case "code": {
      const code = d as CodeData;
      return `${codeSummary(code)}.\n${code.code}`.slice(0, maxChars);
    }
    case "file": {
      const f = d as FileCardData;
      return [`${fileSummary(f)}.`, f.description ?? "", f.preview ? `It begins:\n${f.preview}` : "", f.opens ? "It opens in the browser." : "It downloads when opened.", `Size: ${sizeText(f.size)}.`]
        .filter(Boolean)
        .join("\n")
        .slice(0, maxChars);
    }
  }
  return null;
}
