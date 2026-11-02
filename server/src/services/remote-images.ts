import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IMAGES_DIR } from "./images.js";

/*
 * Pictures from elsewhere (a product thumbnail, a hotel photo, an airline logo from a live search)
 * for the cards on the board. A widget card's frame is offline — it can only show engine images, as
 * data: URLs the host inlines — so each remote picture is fetched once here, checked (an image type by
 * header and by its first bytes, under a size cap, from a public host) and kept in the image store
 * beside the generated ones. Same URL → same file; a failure → no picture (the card shows a tile).
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 7_000;
const EXT: Record<string, "png" | "jpg" | "webp" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const EXTS = ["png", "jpg", "webp", "gif"] as const;

const inflight = new Map<string, Promise<string | null>>();

/** Public web hosts only: no loopback, link-local or private ranges, no bare IPs. */
function publicHost(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.startsWith("[") || h.includes(":")) return false; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // any IPv4 literal
  return true;
}

function magicOk(buf: Buffer, ext: string): boolean {
  if (buf.length < 12) return false;
  switch (ext) {
    case "png":
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    case "jpg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "gif":
      return buf.subarray(0, 4).toString("latin1") === "GIF8";
    case "webp":
      return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}

function idFor(href: string): string {
  return `r${crypto.createHash("sha1").update(href).digest("hex").slice(0, 24)}`;
}

/** The engine URL a cached remote picture is served at (images.ts serves these extensions). */
export function remoteImageUrl(id: string, ext: string): string {
  return `/api/images/${id}.${ext}`;
}

/** Fetch one remote picture into the image store; its engine URL, or null when it can't be used. */
export async function cacheRemoteImage(url: string, opts: { timeoutMs?: number } = {}): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!publicHost(u)) return null;
  const id = idFor(u.href);
  for (const ext of EXTS) if (fs.existsSync(path.join(IMAGES_DIR, `${id}.${ext}`))) return remoteImageUrl(id, ext);
  const pending = inflight.get(id);
  if (pending) return pending;
  const job = (async (): Promise<string | null> => {
    try {
      const res = await fetch(u.href, {
        headers: { "User-Agent": UA, Accept: "image/*" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) return null;
      let final: URL;
      try {
        final = new URL(res.url || u.href);
      } catch {
        return null;
      }
      if (!publicHost(final)) return null;
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const ext = EXT[type];
      if (!ext) return null;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES || !magicOk(buf, ext)) return null;
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      const dest = path.join(IMAGES_DIR, `${id}.${ext}`);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      fs.renameSync(tmp, dest);
      return remoteImageUrl(id, ext);
    } catch (err) {
      console.warn(`[remote-images] ${u.hostname}: ${(err as Error).message}`);
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, job);
  return job;
}

/** A picture the browser sent as a data: URL (a screenshot) into the image store; its engine URL, or null. */
export function saveImageDataUrl(dataUrl: string): string | null {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.slice(0, 64) + dataUrl.slice(64).replace(/\s+/g, ""));
  if (!m) return null;
  const ext = EXT[m[1]!];
  if (!ext) return null;
  const buf = Buffer.from(m[2]!, "base64");
  if (!buf.length || buf.length > MAX_BYTES || !magicOk(buf, ext)) return null;
  const id = `s${crypto.createHash("sha1").update(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)).digest("hex").slice(0, 24)}`;
  const dest = path.join(IMAGES_DIR, `${id}.${ext}`);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    fs.renameSync(tmp, dest);
  }
  return remoteImageUrl(id, ext);
}

/**
 * Cache several pictures at once (a card's worth), a few at a time. The map holds an engine URL for
 * each remote URL that worked; the rest are simply absent.
 */
export async function cacheRemoteImages(
  urls: Iterable<string>,
  opts: { timeoutMs?: number; concurrency?: number; max?: number } = {},
): Promise<Map<string, string>> {
  const unique = [...new Set([...urls].filter(Boolean))].slice(0, opts.max ?? 24);
  const out = new Map<string, string>();
  const width = Math.max(1, Math.min(opts.concurrency ?? 6, unique.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < unique.length) {
        const url = unique[next++]!;
        const local = await cacheRemoteImage(url, { timeoutMs: opts.timeoutMs });
        if (local) out.set(url, local);
      }
    }),
  );
  return out;
}
