import zlib from "node:zlib";

/**
 * A small zip writer over node:zlib — what a .docx and an .xlsx are made of — and a tiny reader that checks what it
 * reads (the tests read back what the writers made). No packages.
 *
 * Written: one local header + data per entry (deflate when it's smaller, stored otherwise), the central directory and
 * the end record; names in UTF-8 (general-purpose bit 11, set where a name isn't plain ASCII); CRC-32 of the
 * uncompressed bytes; MS-DOS dates. No zip64 (an archive here is a few megabytes), no encryption, no data descriptors.
 */

export interface ZipEntry {
  /** The path inside the archive, with forward slashes ("word/document.xml"). A trailing slash makes a folder. */
  name: string;
  data: Uint8Array | string;
  /** Modification time (default: the archive's `date`). */
  date?: Date;
}

export interface ZipOptions {
  /** Modification time for entries that don't carry one (default: now). */
  date?: Date;
  /** Deflate level 0–9 (default 9; these are small text parts). */
  level?: number;
}

export interface ZipFileEntry {
  name: string;
  data: Uint8Array;
  /** 0 = stored, 8 = deflate. */
  method: number;
  crc: number;
  date: Date;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_NAMES = 0x0800;
const MAX_32 = 0xffffffff;

/** A view of any buffer as plain bytes (a Buffer from zlib or fs included), without copying. */
export function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ─── CRC-32 ───────────────────────────────────────────────────────────────────

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  table = t;
  return t;
}

/** CRC-32 (IEEE 802.3, the zip one) by table — the fallback where zlib.crc32 doesn't exist (Node before 22.2). */
export function crc32Table(data: Uint8Array, seed = 0): number {
  const t = crcTable();
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = (t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

export function crc32(data: Uint8Array): number {
  return typeof nativeCrc32 === "function" ? nativeCrc32(data) >>> 0 : crc32Table(data);
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/** MS-DOS time and date words (two-second resolution, years 1980–2107). */
function dosDateTime(d: Date): { time: number; date: number } {
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  if (t.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  const year = Math.min(2107, t.getFullYear());
  return {
    time: (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
  };
}

function fromDos(time: number, date: number): Date {
  return new Date(((date >> 9) & 0x7f) + 1980, Math.max(0, ((date >> 5) & 0x0f) - 1), date & 0x1f || 1, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** An entry name that stays inside whatever folder the archive is unpacked into: relative, forward slashes, no "..". */
function checkedName(name: string): string {
  const bad = (why: string) => new Error(`bad zip entry name ${JSON.stringify(name.slice(0, 80))}: ${why}`);
  if (!name) throw bad("empty");
  if (name.includes("\0") || name.includes("\\")) throw bad("backslashes and NULs aren't allowed");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw bad("it must be a relative path");
  const parts = name.split("/");
  if (parts.some((p, i) => p === "." || p === ".." || (p === "" && i !== parts.length - 1))) throw bad("it must not have empty, '.' or '..' parts");
  return name;
}

/** Build a zip archive in memory. Entry order is kept; a repeated or unsafe name is an error. */
export function zipSync(entries: ZipEntry[], opts: ZipOptions = {}): Uint8Array {
  if (entries.length > 0xffff) throw new Error("too many entries for a zip without zip64");
  const enc = new TextEncoder();
  const stamp = opts.date ?? new Date();
  const seen = new Set<string>();
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = checkedName(e.name);
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);
    const nameBytes = enc.encode(name);
    if (nameBytes.length > 0xffff) throw new Error(`zip entry name too long: ${name.slice(0, 60)}…`);
    const isDir = name.endsWith("/");
    // The UTF-8 flag only where a name needs it: a plain ASCII name (every part of an Office package) reads the same
    // either way, and the oldest readers know nothing of the flag.
    const flags = nameBytes.length === name.length ? 0 : UTF8_NAMES;
    const raw = isDir ? new Uint8Array(0) : typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const crc = crc32(raw);
    let method = 0;
    let packed = raw;
    if (raw.length > 0) {
      const deflated = bytesOf(zlib.deflateRawSync(raw, { level: opts.level ?? 9 }));
      if (deflated.length < raw.length) {
        method = 8;
        packed = deflated;
      }
    }
    if (raw.length > MAX_32 || packed.length > MAX_32 || offset > MAX_32) throw new Error("too large for a zip without zip64");
    const { time, date } = dosDateTime(e.date ?? stamp);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed to extract: 2.0 (deflate)
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // no extra field
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true); // made by: 2.0, MS-DOS attributes
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, isDir ? 0x10 : 0, true); // external attributes: the MS-DOS directory bit
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    body.push(local, packed);
    central.push(cd);
    offset += local.length + packed.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  if (offset > MAX_32 || centralSize > MAX_32) throw new Error("too large for a zip without zip64");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_SIG, true);
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with the central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // no comment
  return concatBytes([...body, ...central, end]);
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface UnzipOptions {
  /** Refuse an entry that unpacks to more than this (default 64 MB). */
  maxEntryBytes?: number;
  /** Refuse an archive that unpacks to more than this in all (default 256 MB). */
  maxTotalBytes?: number;
}

/**
 * Read a zip archive made without zip64 or encryption: every entry of the central directory, its local header
 * checked against it, its data inflated and its size and CRC-32 verified. Throws on anything that doesn't add up.
 */
export function unzipSync(zip: Uint8Array, opts: UnzipOptions = {}): ZipFileEntry[] {
  const maxEntry = opts.maxEntryBytes ?? 64 * 1024 * 1024;
  const maxTotal = opts.maxTotalBytes ?? 256 * 1024 * 1024;
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is the last 22 bytes, or sits before a comment of up to 65535 bytes.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === END_SIG && i + 22 + dv.getUint16(i + 20, true) === zip.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = dv.getUint16(end + 10, true);
  const centralSize = dv.getUint32(end + 12, true);
  let p = dv.getUint32(end + 16, true);
  if (dv.getUint16(end + 8, true) !== count) throw new Error("multi-disk zip archives aren't supported");
  if (p + centralSize !== end) throw new Error("the zip's central directory isn't where its end record says");
  const dec = new TextDecoder("utf-8", { fatal: true });
  const out: ZipFileEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || dv.getUint32(p, true) !== CENTRAL_SIG) throw new Error("bad zip central directory entry");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    const packedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x0001) throw new Error(`zip entry ${name} is encrypted`);
    if (localAt + 30 > zip.length || dv.getUint32(localAt, true) !== LOCAL_SIG) throw new Error(`zip entry ${name}: no local header where the directory points`);
    const localNameLen = dv.getUint16(localAt + 26, true);
    const localName = dec.decode(zip.subarray(localAt + 30, localAt + 30 + localNameLen));
    if (localName !== name) throw new Error(`zip entry ${name}: the local header names ${localName}`);
    if (!(flags & 0x0008) && (dv.getUint32(localAt + 14, true) !== crc || dv.getUint32(localAt + 18, true) !== packedSize || dv.getUint32(localAt + 22, true) !== size))
      throw new Error(`zip entry ${name}: the local header and the directory disagree`);
    if (dv.getUint16(localAt + 8, true) !== method) throw new Error(`zip entry ${name}: the local header and the directory disagree on the method`);
    const start = localAt + 30 + localNameLen + dv.getUint16(localAt + 28, true);
    if (start + packedSize > zip.length) throw new Error(`zip entry ${name} runs past the end of the archive`);
    total += size;
    if (size > maxEntry || total > maxTotal) throw new Error(`zip entry ${name} is too large to unpack`);
    const packed = zip.subarray(start, start + packedSize);
    let data: Uint8Array;
    if (method === 0) data = packed.slice();
    else if (method === 8) data = bytesOf(zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, size) }));
    else throw new Error(`zip entry ${name}: compression method ${method} isn't supported`);
    if (data.length !== size) throw new Error(`zip entry ${name}: ${data.length} bytes unpacked, ${size} expected`);
    if (crc32(data) !== crc) throw new Error(`zip entry ${name}: CRC-32 mismatch`);
    out.push({ name, data, method, crc, date: fromDos(time, date) });
  }
  return out;
}

/** One entry's text (UTF-8), or null when the archive has no such entry. */
export function zipText(entries: ZipFileEntry[], name: string): string | null {
  const e = entries.find((x) => x.name === name);
  return e ? new TextDecoder("utf-8").decode(e.data) : null;
}
