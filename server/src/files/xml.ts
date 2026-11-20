/** Escaping, and the byte-order mark, shared by the writers (docx, xlsx, csv, the printed page). */

/**
 * Characters XML 1.0 can't carry at all: control codes other than tab / LF / CR, the two noncharacters at the end of
 * the basic plane (FFFE, FFFF) and lone surrogates.
 */
const NOT_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F\u{FFFE}\u{FFFF}\p{Cs}]/gu;

export function xmlSafe(s: string): string {
  return s.replace(NOT_XML, "");
}

/** Text content: &, < and > escaped, and nothing an XML parser would refuse. */
export function xmlText(s: string): string {
  return xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** An attribute value (double-quoted): quotes too, and line breaks and tabs as character references so they survive. */
export function xmlAttr(s: string): string {
  return xmlText(s)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The byte-order mark (code point FEFF): Excel reads a CSV as UTF-8 only when it starts with one. */
export const BOM = String.fromCharCode(0xfeff);

/** Without a byte-order mark at the start. */
export function withoutBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
