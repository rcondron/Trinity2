/*
 * The card kinds the board draws itself — table, chart, document, code, file — on the engine side.
 *
 * Each kind has a normalizer: whatever arrives (a model's JSON, a CSV file, a note's lines, a page's source) is cut
 * down to plain values a card can hold — strings clipped to one line where they should be one, numbers as numbers,
 * sizes clamped — and nothing in it is markup: the board escapes every value when it draws the card
 * (kinds/render.ts). And each kind can say what a card holds — a summary for the board's description and a short
 * text for read_card — never the whole thing.
 */

export type Cell = string | number | null;

// ─── Text ────────────────────────────────────────────────────────────────────

const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/** One printable line, at most `max` characters. */
export function oneLine(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : typeof v === "object" ? safeJson(v) : String(v);
  return s
    .replace(LINE_BREAKS, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Text with its lines kept (tabs and line breaks), other control characters out, at most `max` characters. */
export function plainText(v: unknown, max: number): string {
  return String(typeof v === "string" ? v : (v ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(LINE_BREAKS, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .slice(0, max);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "1,234.5", "$12", "45%", "-3", "€ 9.99" → the number; anything else → null. */
export function numberOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 40) return null;
  if (!/^[-+]?(?:[$€£¥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?\s*%?$/i.test(s) || !/\d/.test(s)) return null;
  const n = Number(s.replace(/[$€£¥,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const n0 = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const listOf = (xs: string[], max = 4) => {
  const shown = xs.slice(0, max);
  const more = xs.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${plural(more, "more")}`;
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
};

// ─── Table ───────────────────────────────────────────────────────────────────

export interface TableData {
  columns: string[];
  rows: Cell[][];
  /** Per column: it holds numbers (drawn right-aligned, sorted as numbers). */
  numeric: boolean[];
  /** How many rows there were, when more than the card keeps. */
  total: number;
}

export const TABLE_LIMITS = { columns: 40, rows: 1000, cell: 200, header: 60, chars: 400_000 };

function cellOf(v: unknown): Cell {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return oneLine(v, TABLE_LIMITS.cell) || null;
}

/**
 * A table from columns and rows of anything: names cleaned and made unique, every row as long as the header, cells
 * clipped, at most TABLE_LIMITS of each. Null when there is nothing to show.
 */
export function normalizeTable(raw: unknown): TableData | null {
  if (!isObj(raw)) return null;
  const rowsIn = Array.isArray(raw.rows) ? raw.rows : [];
  let width = Array.isArray(raw.columns) ? raw.columns.length : 0;
  for (const r of rowsIn.slice(0, 50)) if (Array.isArray(r)) width = Math.max(width, r.length);
  width = Math.min(width, TABLE_LIMITS.columns);
  if (!width) return null;
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    let name = oneLine(Array.isArray(raw.columns) ? raw.columns[i] : "", TABLE_LIMITS.header) || `Column ${i + 1}`;
    const key = name.toLowerCase();
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    if (k > 1) name = `${name} (${k})`;
    names.push(name);
  }
  const rows: Cell[][] = [];
  let chars = 0;
  for (const r of rowsIn) {
    if (rows.length >= TABLE_LIMITS.rows || chars > TABLE_LIMITS.chars) break;
    const src: unknown[] = Array.isArray(r) ? r : isObj(r) ? names.map((n) => r[n]) : [r];
    const row: Cell[] = [];
    for (let i = 0; i < width; i++) row.push(cellOf(src[i]));
    if (row.every((c) => c === null)) continue;
    for (const c of row) chars += c === null ? 1 : String(c).length + 3;
    rows.push(row);
  }
  if (!rows.length) return null;
  const numeric = names.map((_, i) => {
    let filled = 0;
    let numbers = 0;
    for (const r of rows) {
      const c = r[i];
      if (c === null || c === undefined) continue;
      filled++;
      if (numberOf(c) !== null) numbers++;
    }
    return filled > 0 && numbers / filled >= 0.8;
  });
  const total = Math.max(rows.length, Number.isInteger(raw.total) ? Number(raw.total) : 0, rowsIn.length);
  return { columns: names, rows, numeric, total };
}

/** The separator a delimited text most likely uses: comma, tab, semicolon or pipe. */
function delimiterOf(text: string): string {
  const head = text.split("\n").slice(0, 5).join("\n");
  let best = ",";
  let most = 0;
  for (const d of [",", "\t", ";", "|"]) {
    let n = 0;
    let quoted = false;
    for (const ch of head) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    if (n > most) {
      most = n;
      best = d;
    }
  }
  return best;
}

/** Records and fields of delimited text (quotes as CSV has them). */
function splitDelimited(text: string, d: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (c === d) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
    if (out.length > TABLE_LIMITS.rows + 1) break;
  }
  if (field !== "" || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/**
 * A table from delimited text — CSV, tab-separated, semicolons, or a Markdown pipe table. The first line is the
 * header unless it is all numbers. Null when the text isn't a table (one column, or one line).
 */
export function tableFromText(text: string): TableData | null {
  const t = plainText(text, 2_000_000).replace(/^﻿/, "").trim();
  if (!t) return null;
  const d = delimiterOf(t);
  let rows = splitDelimited(t, d).map((r) => r.map((c) => c.trim()));
  if (d === "|") {
    rows = rows
      .map((r) => {
        const x = r.slice();
        if (x.length && x[0] === "") x.shift();
        if (x.length && x[x.length - 1] === "") x.pop();
        return x;
      })
      .filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
  }
  rows = rows.filter((r) => r.some((c) => c !== ""));
  if (rows.length < 2 || Math.max(...rows.map((r) => r.length)) < 2) return null;
  const first = rows[0]!;
  const header = !first.every((c) => numberOf(c) !== null);
  return normalizeTable({ columns: header ? first : [], rows: header ? rows.slice(1) : rows });
}

/** A table from JSON: rows of objects, rows of arrays, {columns, rows}, an object holding such a list, columns of values, or one object (key / value). */
export function tableFromJson(v: unknown, depth = 0): TableData | null {
  if (depth > 3) return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (v.every(isObj)) {
      const keys: string[] = [];
      for (const r of v.slice(0, 200)) for (const k of Object.keys(r as Record<string, unknown>)) if (!keys.includes(k) && keys.length < TABLE_LIMITS.columns) keys.push(k);
      return normalizeTable({ columns: keys, rows: v.map((r) => keys.map((k) => (r as Record<string, unknown>)[k])) });
    }
    if (v.every(Array.isArray)) {
      const first = v[0] as unknown[];
      const header = v.length > 1 && first.every((c) => typeof c === "string" && numberOf(c) === null);
      return normalizeTable({ columns: header ? first : [], rows: header ? v.slice(1) : v });
    }
    return normalizeTable({ columns: ["Value"], rows: v.map((x) => [x]) });
  }
  if (!isObj(v)) return null;
  if (Array.isArray(v.rows)) return normalizeTable(v);
  for (const key of ["data", "items", "results", "records", "table", "values", "list"]) {
    const inner = v[key];
    if (inner && typeof inner === "object") {
      const t = tableFromJson(inner, depth + 1);
      if (t) return t;
    }
  }
  const entries = Object.entries(v);
  if (entries.length && entries.every(([, x]) => Array.isArray(x))) {
    const cols = entries.slice(0, TABLE_LIMITS.columns);
    const len = Math.max(...cols.map(([, x]) => (x as unknown[]).length));
    const rows = Array.from({ length: Math.min(len, TABLE_LIMITS.rows) }, (_, i) => cols.map(([, x]) => (x as unknown[])[i]));
    return normalizeTable({ columns: cols.map(([k]) => k), rows });
  }
  if (entries.length) return normalizeTable({ columns: ["Key", "Value"], rows: entries.map(([k, x]) => [k, x]) });
  return null;
}

export function tableSummary(t: TableData): string {
  const rows = t.total > t.rows.length ? `${plural(t.total, "row")} (the first ${t.rows.length.toLocaleString("en-US")} shown)` : plural(t.rows.length, "row");
  return `a table of ${rows} and ${plural(t.columns.length, "column")}: ${listOf(t.columns, 5)}`;
}

/** What read_card works from: the summary, figures for the number columns, then the first rows (cut short). */
export function tableText(t: TableData, maxChars = 3500): string {
  const lines = [`${tableSummary(t)}.`];
  t.columns.forEach((name, i) => {
    if (!t.numeric[i]) return;
    const xs = t.rows.map((r) => numberOf(r[i])).filter((x): x is number => x !== null);
    if (!xs.length) return;
    const sum = xs.reduce((a, b) => a + b, 0);
    lines.push(`${name}: lowest ${n0(Math.min(...xs))}, highest ${n0(Math.max(...xs))}, total ${n0(sum)}, average ${n0(sum / xs.length)}.`);
  });
  lines.push(t.columns.join(" | "));
  let used = lines.join("\n").length;
  let shown = 0;
  for (const r of t.rows) {
    const line = r.map((c) => (c === null ? "" : String(c))).join(" | ");
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < t.rows.length) lines.push(`…and ${plural(t.rows.length - shown, "more row")}.`);
  return lines.join("\n");
}

// ─── Chart ───────────────────────────────────────────────────────────────────

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter";
export const CHART_TYPES: readonly ChartType[] = ["bar", "line", "area", "pie", "donut", "scatter"];

export interface ChartSeries {
  name: string;
  /** One value per label (bar, line, area, pie, donut). */
  values: (number | null)[];
  /** Scatter: the points. */
  points?: [number, number][];
}

export interface ChartData {
  type: ChartType;
  labels: string[];
  series: ChartSeries[];
  /** What the values are in ("°C", "USD", "visits"). */
  units?: string;
  /** The axes' names. */
  x?: string;
  y?: string;
  /** Series left out (a chart shows at most eight; a scatter, three). */
  dropped?: number;
}

export const CHART_LIMITS = { series: 8, scatterSeries: 3, slices: 8, points: 400, bars: 120, label: 40 };

/** "pie chart", "doughnut", "columns", "trend" … → the chart type. */
export function chartTypeOf(v: unknown): ChartType | null {
  const s = String(v ?? "").toLowerCase();
  if (/donut|doughnut|ring/.test(s)) return "donut";
  if (/pie/.test(s)) return "pie";
  if (/scatter|dots?\b|points?\b|bubble/.test(s)) return "scatter";
  if (/area|filled/.test(s)) return "area";
  if (/line|trend|over time|time ?series/.test(s)) return "line";
  if (/bar|column|histogram/.test(s)) return "bar";
  return null;
}

const looksLikeTime = (labels: string[]) => labels.length >= 3 && labels.filter((l) => /^(?:\d{4}(?:[-/]\d{1,2}){0,2}|\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s+\d{2,4})?|q[1-4](?:\s+\d{2,4})?|(?:mon|tue|wed|thu|fri|sat|sun)\w*|week \d+|day \d+|\d{1,2}(?::\d{2})?\s*(?:am|pm))$/i.test(l.trim())).length >= labels.length * 0.7;

/**
 * A chart from a spec: a type, labels and one or more series (or {label, value} pairs, or Chart.js-style datasets).
 * Values become numbers or gaps; at most eight series (three for a scatter) and a readable number of points; a pie
 * keeps its seven biggest slices and folds the rest into "Other". Null when there is nothing to draw.
 */
export function normalizeChart(raw: unknown, wanted?: ChartType | null): ChartData | null {
  if (!isObj(raw)) return null;
  let labels = (Array.isArray(raw.labels) ? raw.labels : Array.isArray(raw.categories) ? raw.categories : Array.isArray(raw.x) ? raw.x : []).map((l) => oneLine(l, CHART_LIMITS.label));
  let seriesIn: unknown[] = Array.isArray(raw.series) ? raw.series : Array.isArray(raw.datasets) ? raw.datasets : [];
  // [{label, value}, …] → labels and one series.
  const pairs = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.points) ? raw.points : null;
  if (!seriesIn.length && pairs && pairs.every(isObj)) {
    const p = pairs as Record<string, unknown>[];
    const labelKey = ["label", "name", "category", "x", "key"].find((k) => p.some((o) => o[k] !== undefined)) ?? "label";
    const valueKey = ["value", "y", "count", "amount", "total"].find((k) => p.some((o) => o[k] !== undefined)) ?? "value";
    labels = p.map((o) => oneLine(o[labelKey], CHART_LIMITS.label));
    seriesIn = [{ name: oneLine(raw.name ?? raw.title ?? "", 60), values: p.map((o) => o[valueKey]) }];
  } else if (!seriesIn.length && (Array.isArray(raw.values) || Array.isArray(raw.data))) {
    seriesIn = [{ name: oneLine(raw.name ?? "", 60), values: (raw.values ?? raw.data) as unknown[] }];
  }
  let type = wanted ?? chartTypeOf(raw.type ?? raw.kind ?? raw.chart) ?? null;
  const series: ChartSeries[] = [];
  let dropped = 0;
  for (const s of seriesIn) {
    if (!isObj(s)) continue;
    const name = oneLine(s.name ?? s.label ?? s.title ?? "", 60);
    const vals = Array.isArray(s.points) && s.points.length ? s.points : Array.isArray(s.values) ? s.values : Array.isArray(s.data) ? s.data : [];
    // Points: [[x, y], …] or [{x, y}, …].
    const pts: [number, number][] = [];
    for (const p of vals) {
      if (Array.isArray(p) && p.length >= 2) {
        const x = numberOf(p[0]);
        const y = numberOf(p[1]);
        if (x !== null && y !== null) pts.push([x, y]);
      } else if (isObj(p) && (p.x !== undefined || p.y !== undefined)) {
        const x = numberOf(p.x);
        const y = numberOf(p.y);
        if (x !== null && y !== null) pts.push([x, y]);
      }
    }
    if (pts.length && pts.length >= vals.length * 0.6) {
      type ??= "scatter";
      series.push({ name, values: [], points: pts.slice(0, CHART_LIMITS.points) });
      continue;
    }
    series.push({ name, values: vals.map((v) => numberOf(isObj(v) ? (v.value ?? v.y) : v)) });
  }
  if (!series.length) return null;
  if (type === "scatter" && !series.some((s) => s.points?.length)) type = null;
  if (type !== "scatter") {
    for (const s of series) delete s.points;
    const len = Math.max(labels.length, ...series.map((s) => s.values.length));
    if (!labels.length) labels = Array.from({ length: len }, (_, i) => String(i + 1));
    labels = labels.map((l, i) => l || String(i + 1));
    const max = type === "bar" || (!type && !looksLikeTime(labels)) ? CHART_LIMITS.bars : CHART_LIMITS.points;
    labels = labels.slice(0, max);
    for (const s of series) {
      s.values = s.values.slice(0, labels.length);
      while (s.values.length < labels.length) s.values.push(null);
    }
  }
  const usable = series.filter((s) => (s.points?.length ?? 0) > 0 || s.values.some((v) => v !== null));
  if (!usable.length) return null;
  type ??= looksLikeTime(labels) && labels.length > 2 ? "line" : "bar";
  const cap = type === "scatter" ? CHART_LIMITS.scatterSeries : type === "pie" || type === "donut" ? 1 : CHART_LIMITS.series;
  dropped = usable.length - Math.min(usable.length, cap);
  let kept = usable.slice(0, cap);
  usable.forEach((s, i) => {
    if (!s.name) s.name = kept.length === 1 && i === 0 ? oneLine(raw.y ?? raw.units ?? "", 60) : `Series ${i + 1}`;
  });
  if (type === "pie" || type === "donut") {
    const s = kept[0]!;
    // A pie can't show a negative share: then it is a bar chart.
    if (s.values.some((v) => v !== null && v < 0)) type = "bar";
    else {
      let slices = labels.map((l, i) => ({ l, v: s.values[i] ?? 0 })).filter((x) => x.v > 0);
      if (slices.length > CHART_LIMITS.slices) {
        slices.sort((a, b) => b.v - a.v);
        const rest = slices.slice(CHART_LIMITS.slices - 1).reduce((a, x) => a + x.v, 0);
        slices = [...slices.slice(0, CHART_LIMITS.slices - 1), { l: "Other", v: rest }];
      }
      if (!slices.length) return null;
      labels = slices.map((x) => x.l);
      kept = [{ name: s.name, values: slices.map((x) => x.v) }];
    }
  }
  const out: ChartData = { type, labels: type === "scatter" ? [] : labels, series: kept };
  const units = oneLine(raw.units ?? raw.unit ?? "", 20);
  const x = oneLine(raw.xLabel ?? raw.x_label ?? raw.xAxis ?? (typeof raw.x === "string" ? raw.x : ""), 40);
  const y = oneLine(raw.yLabel ?? raw.y_label ?? raw.yAxis ?? (typeof raw.y === "string" ? raw.y : ""), 40);
  if (units) out.units = units;
  if (x) out.x = x;
  if (y) out.y = y;
  // (Series an earlier step left out — a table's column on another scale — stay counted.)
  const carried = typeof raw.dropped === "number" && Number.isInteger(raw.dropped) && raw.dropped > 0 ? Math.min(raw.dropped, 100) : 0;
  if (dropped + carried > 0) out.dropped = dropped + carried;
  return out;
}

/** A chart of a table's number columns against its first text column (or its row order). Null without a number column. */
export function chartFromTable(t: TableData, type?: ChartType | null, only?: string[]): ChartData | null {
  const want = (only ?? []).map((w) => w.toLowerCase());
  let valueCols = t.columns.map((_, i) => i).filter((i) => t.numeric[i]);
  const picked = want.length ? valueCols.filter((i) => want.some((w) => t.columns[i]!.toLowerCase().includes(w))) : [];
  if (picked.length) valueCols = picked;
  const labelCol = t.columns.findIndex((_, i) => !t.numeric[i]);
  // A first column of years is the labels, not a series.
  const yearCol = labelCol < 0 && t.numeric[0] && t.rows.every((r) => /^(?:1[89]|2\d)\d\d$/.test(String(r[0] ?? ""))) ? 0 : -1;
  const lc = labelCol >= 0 ? labelCol : yearCol;
  valueCols = valueCols.filter((i) => i !== lc);
  if (!valueCols.length) return null;
  const rows = t.rows.slice(0, CHART_LIMITS.points);
  // One axis, one scale: columns more than ten times bigger or smaller than the first are left out (and counted).
  let unlike = 0;
  if (!picked.length && valueCols.length > 1) {
    const peak = (i: number) => rows.reduce((m, r) => Math.max(m, Math.abs(numberOf(r[i]) ?? 0)), 0);
    const base = peak(valueCols[0]!) || 1;
    const same = valueCols.filter((i) => {
      const p = peak(i);
      return p === 0 || (p <= base * 10 && p >= base / 10);
    });
    unlike = valueCols.length - same.length;
    valueCols = same;
  }
  const chart = normalizeChart(
    {
      labels: rows.map((r, k) => (lc >= 0 ? String(r[lc] ?? "") : String(k + 1))),
      series: valueCols.map((i) => ({ name: t.columns[i], values: rows.map((r) => numberOf(r[i])) })),
      x: lc >= 0 ? t.columns[lc] : "",
    },
    type ?? null,
  );
  if (chart && unlike) chart.dropped = (chart.dropped ?? 0) + unlike;
  return chart;
}

const TYPE_WORD: Record<ChartType, string> = { bar: "bar chart", line: "line chart", area: "area chart", pie: "pie chart", donut: "donut chart", scatter: "scatter plot" };

export function chartSummary(c: ChartData): string {
  const names = c.series.map((s) => s.name).filter(Boolean);
  if (c.type === "scatter") return `a scatter plot of ${plural(c.series.reduce((a, s) => a + (s.points?.length ?? 0), 0), "point")}${names.length ? ` (${listOf(names)})` : ""}`;
  const what = c.type === "pie" || c.type === "donut" ? plural(c.labels.length, "slice") : c.type === "bar" ? plural(c.labels.length, c.series.length > 1 ? "group" : "bar") : plural(c.labels.length, "point");
  return `a ${TYPE_WORD[c.type]} of ${names.length ? listOf(names) : "values"}${c.x ? ` by ${c.x}` : ""}, ${what}`;
}

export function chartText(c: ChartData, maxChars = 3500): string {
  const lines = [`${chartSummary(c)}.`];
  const u = c.units ? ` ${c.units}` : "";
  if (c.type === "scatter") {
    for (const s of c.series) lines.push(`${s.name || "Points"}: ${(s.points ?? []).slice(0, 60).map(([x, y]) => `(${n0(x)}, ${n0(y)})`).join(", ")}`);
    return lines.join("\n").slice(0, maxChars);
  }
  for (const s of c.series) {
    const xs = s.values.map((v, i) => ({ v, l: c.labels[i] ?? "" })).filter((p): p is { v: number; l: string } => p.v !== null);
    if (!xs.length) continue;
    const hi = xs.reduce((a, b) => (b.v > a.v ? b : a));
    const lo = xs.reduce((a, b) => (b.v < a.v ? b : a));
    const total = xs.reduce((a, b) => a + b.v, 0);
    lines.push(`${s.name || "Values"}: highest ${hi.l} at ${n0(hi.v)}${u}, lowest ${lo.l} at ${n0(lo.v)}${u}, total ${n0(total)}${u}.`);
  }
  let used = lines.join("\n").length;
  for (let i = 0; i < c.labels.length; i++) {
    const line = `${c.labels[i]}: ${c.series.map((s) => (s.values[i] === null || s.values[i] === undefined ? "–" : n0(s.values[i]!))).join(", ")}`;
    if (used + line.length + 1 > maxChars) {
      lines.push(`…and ${plural(c.labels.length - i, "more point")}.`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

// ─── Document ────────────────────────────────────────────────────────────────

export interface DocumentData {
  /** Markdown (drawn as a safe subset: no raw HTML). */
  markdown: string;
  words: number;
}

export const DOCUMENT_LIMIT = 60_000;

/** Markdown from what arrived: HTML tags become line breaks or nothing (the board would show them as text anyway). */
export function normalizeDocument(raw: unknown): DocumentData | null {
  const src = isObj(raw) ? (raw.markdown ?? raw.text ?? raw.content ?? raw.body) : raw;
  let md = plainText(src, DOCUMENT_LIMIT * 2);
  if (/<\/?[a-z][\s\S]*?>/i.test(md)) {
    md = md
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, "");
  }
  md = md.replace(/\n{4,}/g, "\n\n\n").trim().slice(0, DOCUMENT_LIMIT);
  if (!md) return null;
  return { markdown: md, words: md.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length };
}

/** The document's words without its Markdown signs. */
export function documentPlain(d: DocumentData): string {
  return d.markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, "$1")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");
}

export function documentSummary(d: DocumentData): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(d.markdown)?.[1];
  return `a document of ${plural(d.words, "word")}${heading ? `, “${oneLine(heading, 60)}”` : ""}`;
}

// ─── Code ────────────────────────────────────────────────────────────────────

export interface CodeData {
  code: string;
  /** What it is written in, as people say it ("JavaScript", "Python", "HTML"). */
  language: string;
  lines: number;
  /** Lines there were, when more than the card keeps. */
  total: number;
}

export const CODE_LIMITS = { chars: 120_000, lines: 3000 };

const LANGUAGES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript",
  py: "Python", python: "Python", html: "HTML", htm: "HTML", css: "CSS", json: "JSON", sql: "SQL", sh: "Shell", bash: "Shell", shell: "Shell",
  ps1: "PowerShell", powershell: "PowerShell", md: "Markdown", markdown: "Markdown", csv: "CSV", yaml: "YAML", yml: "YAML", xml: "XML",
  java: "Java", c: "C", cpp: "C++", "c++": "C++", cs: "C#", "c#": "C#", go: "Go", rust: "Rust", rs: "Rust", rb: "Ruby", ruby: "Ruby", php: "PHP",
  swift: "Swift", kotlin: "Kotlin", kt: "Kotlin", txt: "Text", text: "Text",
};

/** The language a piece of code is most likely in. */
export function guessLanguage(code: string, hint?: unknown): string {
  const h = String(hint ?? "").trim().toLowerCase();
  if (LANGUAGES[h]) return LANGUAGES[h]!;
  if (h && /^[a-z0-9+#. -]{1,20}$/.test(h)) return h.charAt(0).toUpperCase() + h.slice(1);
  const s = code.slice(0, 4000);
  const t = s.trim();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(code);
      return "JSON";
    } catch {
      /* not JSON */
    }
  }
  if (/^<!doctype html|<(?:html|head|body|div|span|p|style|script|button|svg)\b/i.test(t)) return "HTML";
  if (/^\s*(?:def |class \w+:|import \w+|from \w+ import)/m.test(s) && /:\s*$/m.test(s)) return "Python";
  if (/\b(?:interface|type) \w+\s*[={<]|:\s*(?:string|number|boolean)\b/.test(s)) return "TypeScript";
  if (/\b(?:function|const|let|var|=>|console\.log|document\.)\b/.test(s)) return "JavaScript";
  if (/^\s*(?:select|insert|update|delete|create table)\b/im.test(s)) return "SQL";
  if (/^#!\/(?:usr\/)?bin\/(?:env )?(?:ba)?sh|^\s*(?:echo|export|cd|sudo) /m.test(s)) return "Shell";
  if (/^[^{}]*\{[^{}]*:[^{}]*;[^{}]*\}/m.test(s) && !/[()=]/.test(s.slice(0, 200))) return "CSS";
  return "Text";
}

export function normalizeCode(raw: unknown, hint?: unknown): CodeData | null {
  const src = isObj(raw) ? (raw.code ?? raw.text ?? raw.source ?? raw.content) : raw;
  let code = plainText(src, CODE_LIMITS.chars * 2).replace(/\s+$/, "");
  // A model's fence around it goes.
  const fenced = /^\s*`{3,}[\w+#.-]*[^\n]*\n([\s\S]*?)\n?`{3,}\s*$/.exec(code);
  if (fenced) code = fenced[1]!;
  if (!code.trim()) return null;
  const all = code.split("\n");
  const total = all.length;
  let kept = all.slice(0, CODE_LIMITS.lines).join("\n");
  if (kept.length > CODE_LIMITS.chars) kept = kept.slice(0, CODE_LIMITS.chars).replace(/\n[^\n]*$/, "");
  const lines = kept.split("\n").length;
  const language = guessLanguage(kept, isObj(raw) ? (raw.language ?? raw.lang ?? hint) : hint);
  const said = isObj(raw) && typeof raw.total === "number" && Number.isInteger(raw.total) ? raw.total : 0;
  return { code: kept, language, lines, total: Math.max(total, lines, said) };
}

export function codeSummary(c: CodeData): string {
  const lines = c.total > c.lines ? `${plural(c.total, "line")} (the first ${c.lines.toLocaleString("en-US")} shown)` : plural(c.lines, "line");
  return `${c.language === "Text" ? "text" : `${c.language} code`}, ${lines}`;
}

// ─── File ────────────────────────────────────────────────────────────────────

/** A file Trinity made or was given (services/files.ts FileInfo), as its card shows it. */
export interface FileCardData {
  /** The file store's id: sixteen hex digits. The window builds the file's address from it and the name. */
  id: string;
  /** The name, with its extension. */
  name: string;
  /** The extension, lower case ("pdf", "xlsx"). */
  ext: string;
  /** "application/pdf". */
  mime: string;
  /** What kind of file it is, in words ("PDF", "Excel spreadsheet"). */
  type: string;
  size: number;
  /** The browser shows it (a PDF, text, a picture) — else Open downloads it. */
  opens: boolean;
  description?: string;
  /** The first lines, for a text file. */
  preview?: string;
}

export const FILE_ID = /^[0-9a-f]{16}$/;

export function normalizeFile(raw: unknown): FileCardData | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === "string" && FILE_ID.test(raw.id) ? raw.id : "";
  const name = oneLine(raw.name, 120);
  if (!id || !name || /[\\/]/.test(name) || name.startsWith(".")) return null;
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").toLowerCase();
  const mime = typeof raw.mime === "string" && /^[a-z0-9.+/-]{3,80}$/i.test(raw.mime) ? raw.mime.toLowerCase() : "application/octet-stream";
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? Math.floor(raw.size) : 0;
  const out: FileCardData = { id, name, ext, mime, type: oneLine(raw.type, 40) || (ext ? ext.toUpperCase() : "file"), size, opens: raw.opens === true };
  const description = oneLine(raw.description, 200);
  const preview = plainText(raw.preview ?? "", 1200).trim();
  if (description) out.description = description;
  if (preview) out.preview = preview;
  return out;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte");
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

export function fileSummary(f: FileCardData): string {
  return `the file “${f.name}” (${f.type}, ${sizeText(f.size)})`;
}
