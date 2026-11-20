import { XML_HEAD, xmlText } from "./xml.js";

/** The package parts a .docx and an .xlsx share (Open Packaging Conventions): the root relationships and the two property parts. */

export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const RELS_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

/** _rels/.rels: the main part (word/document.xml, xl/workbook.xml) and the property parts. */
export function packageRels(mainPart: string): string {
  return (
    `${XML_HEAD}<Relationships ${RELS_NS}>` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="${mainPart}"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
    "</Relationships>"
  );
}

/** docProps/core.xml: the title, who made it, and when. */
export function corePropsXml(title: string, date: Date): string {
  const when = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(title)}</dc:title><dc:creator>Trinity</dc:creator><cp:lastModifiedBy>Trinity</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

/** docProps/app.xml. */
export const APP_PROPS =
  `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Trinity</Application></Properties>';
