import { defaultPaper, type Block, type Doc, type ListBlock, type Paper, type Run, type TableBlock } from "./document.js";
import { APP_PROPS, REL, RELS_NS, corePropsXml, packageRels } from "./opc.js";
import { XML_HEAD, xmlText } from "./xml.js";
import { zipSync } from "./zip.js";

/**
 * A Word document (.docx) from a Doc: WordprocessingML in an OPC package, written by hand — [Content_Types].xml, the
 * package and document relationships, word/document.xml, styles (Title, Heading 1–3, List Paragraph, Table Grid),
 * numbering (one bullet definition; a fresh numbered list for every list, so each starts at 1), settings and the two
 * property parts. Elements are written in the order the schema lists them, which is what Word insists on.
 */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const FONT = "Calibri";
const MONO = "Consolas";
const RULE_COLOR = "C4C9D1";

/** Page size and margins in twentieths of a point. */
const PAGE: Record<Paper, { w: number; h: number }> = { letter: { w: 12240, h: 15840 }, a4: { w: 11906, h: 16838 } };
const MARGIN = 1440; // one inch

interface RunLook {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  mono?: boolean;
}

function runXml(r: Run, look: RunLook = {}): string {
  const props: string[] = [];
  if (r.code || look.mono) props.push(`<w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/>`);
  if (r.bold || look.bold) props.push("<w:b/><w:bCs/>");
  if (r.italic || look.italic) props.push("<w:i/><w:iCs/>");
  if (look.color) props.push(`<w:color w:val="${look.color}"/>`);
  let body = "";
  for (const piece of r.text.split(/(\n|\t)/)) {
    if (piece === "\n") body += "<w:br/>";
    else if (piece === "\t") body += "<w:tab/>";
    else if (piece) body += `<w:t xml:space="preserve">${xmlText(piece)}</w:t>`;
  }
  if (!body) return "";
  return `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}${body}</w:r>`;
}

const paragraph = (pPr: string, runs: string) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
const runsXml = (runs: Run[], look?: RunLook) => runs.map((r) => runXml(r, look)).join("");

/** A numbered list (or sub-list) of its own: which level it counts at, and from what. */
interface Numbered {
  id: number;
  level: number;
  start: number;
}

class Body {
  readonly parts: string[] = [];
  readonly numbered: Numbered[] = [];
  private nextNum = 2; // 1 is the bullet list

  constructor(private readonly contentWidth: number) {}

  add(b: Block): void {
    switch (b.type) {
      case "heading":
        this.parts.push(paragraph(`<w:pStyle w:val="Heading${b.level}"/>`, runsXml(b.runs)));
        break;
      case "paragraph":
        this.parts.push(paragraph("", runsXml(b.runs)));
        break;
      case "quote":
        this.parts.push(
          paragraph(`<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="${RULE_COLOR}"/></w:pBdr><w:ind w:left="360"/>`, runsXml(b.runs, { italic: true, color: "3A424D" })),
        );
        break;
      case "list":
        this.list(b);
        break;
      case "table":
        this.table(b);
        break;
      case "code":
        this.parts.push(
          paragraph('<w:shd w:val="clear" w:color="auto" w:fill="F5F6F8"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/>', runXml({ text: b.text }, { mono: true })),
        );
        break;
      case "rule":
        this.parts.push(paragraph(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${RULE_COLOR}"/></w:pBdr>`, ""));
        break;
      case "pagebreak":
        this.parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
    }
  }

  private list(list: ListBlock): void {
    // The numbered list in force at each level; a shallower item, or a bullet at the same level, ends the ones below it.
    const inForce: (number | null)[] = [null, null, null];
    list.items.forEach((it, index) => {
      const level = Math.max(0, Math.min(2, it.level));
      for (let k = level + 1; k < 3; k++) inForce[k] = null;
      let numId = 1;
      if (it.ordered) {
        if (inForce[level] == null) {
          const id = this.nextNum++;
          this.numbered.push({ id, level, start: level === 0 && index === 0 ? (list.start ?? 1) : 1 });
          inForce[level] = id;
        }
        numId = inForce[level]!;
      } else inForce[level] = null;
      this.parts.push(paragraph(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`, runsXml(it.runs)));
    });
  }

  private table(t: TableBlock): void {
    const cols = Math.max(1, t.header.length);
    const colW = Math.floor(this.contentWidth / cols);
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${RULE_COLOR}"/>`;
    const cell = (runs: Run[], c: number, header: boolean) => {
      const jc = t.align[c] === "right" ? '<w:jc w:val="right"/>' : t.align[c] === "center" ? '<w:jc w:val="center"/>' : "";
      const tcPr = `<w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F2F5"/>' : ""}</w:tcPr>`;
      return `<w:tc>${tcPr}${paragraph(`<w:spacing w:before="40" w:after="40"/>${jc}`, runsXml(runs, header ? { bold: true } : {}))}</w:tc>`;
    };
    const row = (cells: Run[][], header: boolean) =>
      `<w:tr><w:trPr><w:cantSplit/>${header ? "<w:tblHeader/>" : ""}</w:trPr>${Array.from({ length: cols }, (_x, c) => cell(cells[c] ?? [], c, header)).join("")}</w:tr>`;
    this.parts.push(
      "<w:tbl>" +
        "<w:tblPr>" +
        '<w:tblStyle w:val="TableGrid"/>' +
        `<w:tblW w:w="${colW * cols}" w:type="dxa"/>` +
        `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
        '<w:tblLayout w:type="fixed"/>' +
        '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
        '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
        "</w:tblPr>" +
        `<w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(cols)}</w:tblGrid>` +
        row(t.header, true) +
        t.rows.map((r) => row(r, false)).join("") +
        "</w:tbl>",
      // Word joins two tables that touch, and wants a paragraph after a table: a short empty one.
      paragraph('<w:spacing w:before="0" w:after="120"/>', ""),
    );
  }
}

function documentXml(doc: Doc, paper: Paper, body: Body): string {
  const page = PAGE[paper];
  const title = doc.showTitle && doc.title ? paragraph('<w:pStyle w:val="Title"/>', runXml({ text: doc.title })) : "";
  for (const b of doc.blocks) body.add(b);
  const sect =
    `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  // (A body needs at least one paragraph.)
  const content = title + body.parts.join("") || "<w:p/>";
  return `${XML_HEAD}<w:document ${W_NS}><w:body>${content}${sect}</w:body></w:document>`;
}

function stylesXml(): string {
  const heading = (n: 1 | 2 | 3, size: number, before: number, color: string) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `${XML_HEAD}<w:styles ${W_NS}>` +
    "<w:docDefaults>" +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
    '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="0" w:after="240" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>' +
    heading(1, 32, 360, "1B1F24") +
    heading(2, 26, 280, "1B1F24") +
    heading(3, 23, 240, "3A424D") +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>' +
    `<w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="${RULE_COLOR}"/>`).join("")}</w:tblBorders></w:tblPr></w:style>` +
    "</w:styles>"
  );
}

function numberingXml(numbered: Numbered[]): string {
  const level = (i: number, fmt: string, text: string) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  return (
    `${XML_HEAD}<w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "bullet", "•")}${level(1, "bullet", "–")}${level(2, "bullet", "•")}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "decimal", "%1.")}${level(1, "lowerLetter", "%2.")}${level(2, "lowerRoman", "%3.")}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    numbered.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${n.level}"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`).join("") +
    "</w:numbering>"
  );
}

const SETTINGS =
  `${XML_HEAD}<w:settings ${W_NS}><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';

const CONTENT_TYPES =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const DOCUMENT_RELS =
  `${XML_HEAD}<Relationships ${RELS_NS}>` +
  `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>` +
  `<Relationship Id="rId3" Type="${REL}/settings" Target="settings.xml"/>` +
  "</Relationships>";

/** The .docx bytes for a document. `date` stamps the properties and the archive (default: now). */
export function buildDocx(doc: Doc, opts: { paper?: Paper; date?: Date } = {}): Uint8Array {
  const paper = opts.paper ?? defaultPaper();
  const date = opts.date ?? new Date();
  const body = new Body(PAGE[paper].w - 2 * MARGIN);
  const document = documentXml(doc, paper, body);
  return zipSync(
    [
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: packageRels("word/document.xml") },
      { name: "word/document.xml", data: document },
      { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
      { name: "word/styles.xml", data: stylesXml() },
      { name: "word/numbering.xml", data: numberingXml(body.numbered) },
      { name: "word/settings.xml", data: SETTINGS },
      { name: "docProps/core.xml", data: corePropsXml(doc.title || "Document", date) },
      { name: "docProps/app.xml", data: APP_PROPS },
    ],
    { date },
  );
}
