import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { redactSecrets } from "../db/conversations.js";
import { topicWords, type MemoryStore } from "../db/memory.js";
import { cleanProfileName, getProfileName, getSetting, setProfileName, setSetting } from "../db/sqlite.js";
import type { MemoryDoc } from "../types.js";

/*
 * The user profile: two short texts that are ALWAYS in the prompt, unlike memories, which are looked up.
 *   data/profile/USER.md   (≤ 1,500 characters)  who the user is: name, people, places, preferences.
 *   data/profile/NOTES.md  (≤ 2,200 characters)  standing facts and instructions for the assistant.
 * One entry per line. The caps are the point: an add that doesn't fit is refused with an error that says to
 * consolidate, so the texts stay worth reading on every turn. Every entry is scanned before it is stored: text
 * that tries to steer the model (override its instructions, hide things from the user, send data somewhere),
 * a URL that carries credentials, invisible characters, or a secret is refused.
 *
 * The same file style holds the check-in's checklist (data/profile/HEARTBEAT.md, see heartbeat.ts).
 * The user's name lives in the settings (the voice prompt and the app read it there) and as an entry in USER.md;
 * whichever changed last is carried over to the other.
 */

export type ProfilePart = "user" | "notes";
export const PROFILE_LIMITS = { user: 1500, notes: 2200, checklist: 1200 } as const;
const MAX_ENTRY = 300;
const DIR = path.join(DATA_DIR, "profile");
const FILES = { user: "USER.md", notes: "NOTES.md", checklist: "HEARTBEAT.md" } as const;
type FileKey = keyof typeof FILES;
const LABEL: Record<FileKey, string> = { user: "the profile (USER.md)", notes: "the standing notes (NOTES.md)", checklist: "the check-in list (HEARTBEAT.md)" };

export interface ProfileResult {
  ok: boolean;
  error?: string;
  /** What was added, replaced or removed (for a confirmation). */
  changed?: string[];
}

// ─── The scan ─────────────────────────────────────────────────────────────────────────────

/** Text that tries to steer the model rather than say something about the user. */
const STEERING: [RegExp, string][] = [
  [/\b(?:ignore|disregard|forget|override|bypass|drop)\b[^.!?\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|system|safety)\b[^.!?\n]{0,30}\b(?:instructions?|prompts?|rules|guidelines|directives|restrictions|polic(?:y|ies)|guardrails)\b/i, "it tells the assistant to ignore its instructions"],
  [/\byou(?:['’]re| are) (?:now|no longer)\b[^.!?\n]{0,40}\b(?:an?|the|in|free|bound|restricted|unrestricted|jailbroken|assistant|ai|model|dan)\b|\bdo anything now\b|\bjailbr(?:eak|oken)\b|\bdeveloper mode\b|\bDAN mode\b/i, "it tries to give the assistant a new role"],
  [/\b(?:system|developer) (?:prompt|message|instructions?)\b|\bnew (?:system )?(?:instructions?|prompt)\s*:/i, "it talks about the assistant's own instructions"],
  [/^\s*(?:system|assistant|developer|tool)\s*:/im, "it is written as a system or assistant message"],
  [/<\/?(?:system|assistant|instructions?|tool|function_call|im_start|im_end)\b[^>]*>|\[\/?(?:INST|SYS)\]|<\|[a-z_]+\|>/i, "it carries prompt markup"],
  [/\b(?:do not|don['’]?t|never|must not)\s+(?:tell|inform|mention (?:this |it |that )?to|reveal (?:this |it |that )?to|let)\s+(?:the )?(?:user|caller|human|owner)\b|\bwithout (?:telling|asking|informing|notifying) (?:the )?(?:user|caller|human|owner)\b|\bhide (?:this|it|that) from (?:the )?(?:user|caller|human|owner)\b/i, "it tells the assistant to keep something from the user"],
  [/\b(?:send|post|upload|forward|exfiltrate|leak|transmit|email|submit)\b[^.!?\n]{0,60}\b(?:to|at)\s+(?:https?:\/\/|www\.)\S+/i, "it tells the assistant to send data to a web address"],
  [/\b(?:reveal|print|show|output|repeat|leak|send)\b[^.!?\n]{0,30}\b(?:system prompt|your (?:instructions|prompt|rules)|api[ -]?keys?|passwords?|credentials|the vault)\b/i, "it asks for the assistant's instructions or secrets"],
  [/\b(?:always|must|should|silently|secretly)\s+(?:call|run|invoke|execute|use)\b[^.!?\n]{0,24}\b(?:the )?(?:tool|function|skill|shell|command|script|browser_\w+|create_skill|figure_out|update_profile|remember)\b/i, "it tells the assistant to run tools"],
];
/** A URL with a user name and password in it, or a key / token in its query. */
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@|[?&](?:api[_-]?key|access[_-]?token|token|auth|password|passwd|pwd|secret|signature|sig)=[^&\s]{4,}/i;
/** Characters that don't show: zero-width and joiner characters, direction overrides, tag characters, control codes. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;

/**
 * Why a text may not be stored where the model always (or later) reads it — the profile, a memory, the check-in
 * list — or null when it is fine. In words, for the error the tool says back.
 */
export function scanEntry(text: string): string | null {
  if (INVISIBLE.test(text)) return "it contains invisible characters";
  if (CREDENTIAL_URL.test(text)) return "it contains a web address with a password or key in it";
  for (const [re, why] of STEERING) if (re.test(text)) return why;
  if (redactSecrets(text).redacted) return "it looks like a password, key or card number, and those don't belong in memory";
  return null;
}

// ─── The user's own name in a sentence (used by the memory tools and routes too) ──────────

/** A name as a word of its own in a text: "Rob" in "…is Rob, and…", never in "Robert". */
const nameWord = (name: string, flags = "u") =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, flags);

/** Whether a memory says this name as a word of its own: "The user's name is Rob." says "Rob" (not "Ro"). */
function saysName(text: string, name: string): boolean {
  return nameWord(name).test(text);
}

/**
 * "The user's name is …", "The user goes by …": the user's own name, never someone else's ("The user's son is
 * named Ryan Jr."). (Older memories say "The caller's name is …".)
 */
const OWN_NAME = /\b(?:caller|user)(?:['’]s (?:first |full |real |preferred )?name is| goes by| is called| is named(?! after)| prefers to be called)\b/i;
const OWN_NAME_IS = "The (?:caller|user)(?:['’]s (?:first |full |real |preferred )?name is| goes by| is called| is named| prefers to be called)";
/** A name as written: its first word, then any capitalized ones ("Ana María", "J. R. Smith", "Juan de la Cruz"). */
const NAME_SAID = "[\\p{L}'’.-]+(?:\\s+(?:\\p{Lu}[\\p{L}'’.-]*|de|da|del|di|du|la|le|van|von|der|bin|ibn|al|el))*";
/** A memory that states the user's name and nothing else: "The user's name is Ana María.", "The user goes by Rob." */
const BARE_NAME = new RegExp(`^${OWN_NAME_IS} (?:\\p{Lu}[\\p{L}'’.-]*(?: (?:\\p{Lu}[\\p{L}'’.-]*|de|da|del|di|du|la|le|van|von|der|bin|ibn|al|el)){0,3}|[\\p{L}'’-]+)\\.?$`, "u");

/** Whether a memory states the user's own name (when given, this one). */
export function statesOwnName(text: string, name?: string): boolean {
  return OWN_NAME.test(text) && (!name || saysName(text, name));
}

/** Whether a memory says nothing but the user's name (see BARE_NAME) — one that carries other facts too isn't. */
export function isBareName(text: string): boolean {
  return BARE_NAME.test(text.trim());
}

/** The name a memory states as the user's own: "The user's name is Ryan, and he works nights." → "Ryan". */
export function ownNameIn(text: string): string | null {
  const said = new RegExp(`\\b(?:[Cc]aller|[Uu]ser)(?:['’]s (?:first |full |real |preferred )?name is| goes by| is called| is named(?! after)| prefers to be called)\\s+(${NAME_SAID})`, "u")
    .exec(text)?.[1]
    // (A sentence that ends after the name isn't more of it: "…is Ryan. He works nights." A title's dot ends
    // nothing: "Dr. Smith".)
    ?.replace(/(?<!\p{L})(?!(?:dr|mr|mrs|ms|mx|prof|rev|fr|st)\.)(\p{L}{2,})\.\s.*$/iu, "$1");
  const name = said ? cleanProfileName(said) : null;
  // (No name at all: "…name is not shared", "…name is unknown".)
  return name && !/^(?:by|their|his|her|the|a|an|my|your|not|unknown|unclear|undisclosed|private|secret|anonymous|withheld)$/i.test(name) ? name : null;
}

/**
 * The user's name memory restated for a new name: one that says nothing else becomes `statement` ("The user
 * goes by Rob."); one that also carries other facts ("The user's name is Ryan, and he works nights as a nurse.")
 * keeps them, with the old name (`from`, else the one it states) swapped for the new one inside it.
 */
export function renamedText(text: string, from: string | null, to: string, statement: string): string {
  if (isBareName(text)) return statement;
  // Only the name it states as theirs ("…and his son is Ryan Jr." keeps the son's).
  const start = OWN_NAME.exec(text)?.index ?? 0;
  const tail = text.slice(start);
  const old = from && saysName(tail, from) ? from : ownNameIn(text);
  const at = old ? tail.search(nameWord(old)) : -1;
  // (No name to swap in it: the new one goes first, and nothing it said is lost.)
  return at < 0 ? `${statement} ${text}` : `${text.slice(0, start + at)}${to}${tail.slice(at + old!.length)}`;
}

/**
 * The user's name memory once they've cleared their name: null when it said nothing else (it goes); one that also
 * carries other facts keeps them without its own-name clause ("The user's name is Ryan, and he works nights." →
 * "The user works nights."). One that can't be taken apart stays as it is.
 */
export function unnamedText(text: string): string | null {
  if (isBareName(text)) return null;
  if (!ownNameIn(text)) return text;
  // The clause, up to what else it says: after a comma or a full stop, or an "and", "who", "from"…
  const clause = new RegExp(
    `^${OWN_NAME_IS}\\s+${NAME_SAID}(?:\\s*[,;:–-]\\s*|\\s*\\.\\s+|\\s+(?=(?:and|but|who|which|from|in|at|of|a|an|the)\\b))` +
      `(?:(?:and|but|who|which)\\s+)?(?:(?:[Hh]e|[Ss]he|[Tt]hey)(?:['’](?:s|re))?\\s+)?`,
    "u",
  ).exec(text);
  if (!clause) {
    // (A word or two after the name — "…goes by Rob these days." — say nothing else; more is kept as it is.)
    const named = new RegExp(`^${OWN_NAME_IS}\\s+${NAME_SAID}`, "u").exec(text);
    return named && text.slice(named[0].length).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length <= 2 ? null : text;
  }
  const rest = text.slice(clause[0].length).trim();
  if (!rest || /^[.!?]*$/.test(rest)) return null;
  if (/^(?:a|an|the|from|in|at|of)\b/i.test(rest)) return `The user is ${rest}`;
  if (/^(?:his|her|their)\s/i.test(rest)) return `The user's ${rest.replace(/^\S+\s+/, "")}`;
  return `The user ${rest}`;
}

/** Tags without the old name's own ("ryan" on a memory that now says Rob). */
export function withoutNameTags(tags: string[], from: string | null, to: string | null = null): string[] {
  const words = (n: string | null) => (n ? [n, ...n.split(/\s+/)].map((w) => w.toLowerCase()) : []);
  const keep = new Set([...words(to), "name"]);
  const stale = new Set(words(from).filter((w) => !keep.has(w)));
  return tags.filter((t) => !stale.has(t.toLowerCase()));
}

/**
 * The memory holding the user's own name: one tagged "name" that states it ("The user's name is
 * Rob.", "The user goes by Rob."). One about someone else ("The user's son is named Ryan Jr.")
 * or one that only mentions it ("The user, Rob, works as a nurse.") isn't it.
 */
export async function nameMemory(memory: MemoryStore): Promise<MemoryDoc | null> {
  const tagged = await memory.search("", { tags: ["name"], limit: 20 });
  return tagged.find((d) => statesOwnName(d.text)) ?? null;
}

// ─── The files ────────────────────────────────────────────────────────────────────────────

interface Cached {
  mtimeMs: number;
  text: string;
}
const cache = new Map<FileKey, Cached>();

function fileOf(key: FileKey): string {
  return path.join(DIR, FILES[key]);
}

/** A file's text ("" when it doesn't exist). Re-read only when the file changed on disk. */
function read(key: FileKey): string {
  try {
    const mtimeMs = fs.statSync(fileOf(key)).mtimeMs;
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.text;
    const text = fs.readFileSync(fileOf(key), "utf8").replace(/\r\n?/g, "\n").trim();
    cache.set(key, { mtimeMs, text });
    return text;
  } catch {
    cache.delete(key);
    return "";
  }
}

function write(key: FileKey, text: string): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileOf(key);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text ? `${text}\n` : "", "utf8");
  fs.renameSync(tmp, file);
  cache.delete(key);
}

/** One entry: a line without its bullet, spaces collapsed. */
const clean = (line: string) => line.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim();
const entriesOf = (text: string) => text.split("\n").map(clean).filter(Boolean);
const textOf = (entries: string[]) => entries.map((e) => `- ${e}`).join("\n");
const same = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function tooLong(key: FileKey, text: string): string | null {
  const cap = PROFILE_LIMITS[key];
  if (text.length <= cap) return null;
  return `${LABEL[key]} would be ${text.length.toLocaleString("en-US")} characters, and the limit is ${cap.toLocaleString("en-US")}. Consolidate it first: shorten, merge or remove entries, then add this.`;
}

function checkEntries(entries: string[]): string | null {
  for (const e of entries) {
    if (e.length > MAX_ENTRY) return `an entry is too long (${e.length} characters; the limit is ${MAX_ENTRY}): "${e.slice(0, 60)}…"`;
    const why = scanEntry(e);
    if (why) return `"${e.length > 60 ? `${e.slice(0, 59)}…` : e}" can't be saved: ${why}`;
  }
  return null;
}

/** The entries that match some words: holding them as written, else holding every topic word of them. */
function matching(entries: string[], words: string): number[] {
  const needle = words.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  if (!needle) return [];
  const direct = entries.map((e, i) => (e.toLowerCase().includes(needle) ? i : -1)).filter((i) => i >= 0);
  if (direct.length) return direct;
  const want = [...new Set(topicWords(needle))];
  if (!want.length) return [];
  const has = (e: string, w: string) => topicWords(e).some((t) => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)));
  return entries.map((e, i) => (want.every((w) => has(e, w)) ? i : -1)).filter((i) => i >= 0);
}

// ─── First run, and the name ──────────────────────────────────────────────────────────────

let migrated = false;
/** First run: the profile folder is made and the name already stored in the settings becomes its first entry. */
function migrate(): void {
  if (migrated) return;
  migrated = true;
  try {
    if (getSetting("profile_migrated") === "1") return;
    const name = getProfileName();
    if (name && !entriesOf(read("user")).some((e) => statesOwnName(e))) {
      const next = textOf([`The user's name is ${name}.`, ...entriesOf(read("user"))]);
      if (!tooLong("user", next)) write("user", next);
    }
    setSetting("profile_name_synced", name ?? "");
    setSetting("profile_migrated", "1");
  } catch (err) {
    console.warn("[profile] first-run setup failed:", (err as Error).message);
  }
}

/**
 * Keep the name in the settings and the name entry in USER.md saying the same thing: whichever changed since the
 * last look is carried over to the other (a new name from Settings or the voice goes into the file; a name edited
 * into or out of the file becomes the name).
 */
function syncName(): void {
  try {
    const stored = getProfileName() ?? "";
    const entries = entriesOf(read("user"));
    const at = entries.findIndex((e) => statesOwnName(e));
    const inFile = at >= 0 ? (ownNameIn(entries[at]!) ?? "") : "";
    if (stored === inFile) {
      if (getSetting("profile_name_synced") !== stored) setSetting("profile_name_synced", stored);
      return;
    }
    const last = getSetting("profile_name_synced") ?? "";
    if (stored !== last) {
      // The setting changed: the file follows.
      const next = [...entries];
      if (stored && at >= 0) next[at] = renamedText(entries[at]!, inFile || null, stored, `The user's name is ${stored}.`);
      else if (stored) next.unshift(`The user's name is ${stored}.`);
      else if (at >= 0) {
        const rest = unnamedText(entries[at]!);
        if (rest === null) next.splice(at, 1);
        else next[at] = rest;
      }
      const text = textOf(next);
      if (!tooLong("user", text)) write("user", text);
      setSetting("profile_name_synced", stored);
    } else {
      // The file changed: the setting follows.
      setProfileName(inFile || null);
      setSetting("profile_name_synced", getProfileName() ?? "");
    }
  } catch (err) {
    console.warn("[profile] the name could not be kept in step:", (err as Error).message);
  }
}

// ─── The API ──────────────────────────────────────────────────────────────────────────────

/** Both texts as stored (one "- entry" per line; "" when empty). Never throws. */
export function getProfile(): { user: string; notes: string } {
  try {
    migrate();
    syncName();
    return { user: read("user"), notes: read("notes") };
  } catch {
    return { user: "", notes: "" };
  }
}

/** Replace one of the texts (Settings → Memory). Lines become entries; the cap and the scan apply. */
export function setProfile(part: ProfilePart, text: string): ProfileResult {
  try {
    if (part !== "user" && part !== "notes") return { ok: false, error: "the part must be user or notes" };
    migrate();
    const entries = entriesOf(String(text ?? "").replace(/\r\n?/g, "\n"));
    const bad = checkEntries(entries);
    if (bad) return { ok: false, error: bad };
    const next = textOf(entries);
    const over = tooLong(part, next);
    if (over) return { ok: false, error: over };
    write(part, next);
    if (part === "user") syncName();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Change one entry. add: `text` is the new entry (one that's already there is left alone). replace: the entry
 * holding `match` becomes `text`. remove: the entries holding `text` (or `match`) go. An add or replace that
 * would pass the cap is refused, with an error that says to consolidate.
 */
export function editProfile(op: "add" | "replace" | "remove", part: ProfilePart, text: string, match?: string): ProfileResult {
  try {
    if (part !== "user" && part !== "notes") return { ok: false, error: "the part must be user or notes" };
    migrate();
    const entries = entriesOf(read(part));
    const entry = clean(String(text ?? ""));
    if (op === "remove") {
      const hits = matching(entries, match?.trim() || entry);
      if (!hits.length) return { ok: false, error: `nothing in ${LABEL[part]} matches "${(match?.trim() || entry).slice(0, 80)}"` };
      const removed = hits.map((i) => entries[i]!);
      write(part, textOf(entries.filter((_e, i) => !hits.includes(i))));
      if (part === "user") syncName();
      return { ok: true, changed: removed };
    }
    if (!entry) return { ok: false, error: "there is nothing to save" };
    const bad = checkEntries([entry]);
    if (bad) return { ok: false, error: bad };
    if (op === "add") {
      if (entries.some((e) => same(e, entry))) return { ok: true, changed: [] };
      const next = textOf([...entries, entry]);
      const over = tooLong(part, next);
      if (over) return { ok: false, error: over };
      write(part, next);
      if (part === "user") syncName();
      return { ok: true, changed: [entry] };
    }
    if (op === "replace") {
      if (!match?.trim()) return { ok: false, error: "say which entry to replace" };
      const hits = matching(entries, match);
      if (!hits.length) return { ok: false, error: `nothing in ${LABEL[part]} matches "${match.slice(0, 80)}"` };
      if (hits.length > 1) return { ok: false, error: `more than one entry in ${LABEL[part]} matches "${match.slice(0, 80)}": be more specific` };
      const old = entries[hits[0]!]!;
      const next = [...entries];
      next[hits[0]!] = entry;
      const nextText = textOf(next);
      const over = tooLong(part, nextText);
      if (over) return { ok: false, error: over };
      write(part, nextText);
      if (part === "user") syncName();
      return { ok: true, changed: [old, entry] };
    }
    return { ok: false, error: "the operation must be add, replace or remove" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Each entry of both texts with a short id ("u1", "n2"), for a model that may point back at one. */
export function profileEntries(): { id: string; part: ProfilePart; text: string }[] {
  const p = getProfile();
  return [
    ...entriesOf(p.user).map((text, i) => ({ id: `u${i + 1}`, part: "user" as const, text })),
    ...entriesOf(p.notes).map((text, i) => ({ id: `n${i + 1}`, part: "notes" as const, text })),
  ];
}

/** Remove what matches from both texts ("forget that I'm vegetarian"). Returns what went. */
export function forgetFromProfile(words: string): string[] {
  const gone: string[] = [];
  for (const part of ["user", "notes"] as const) {
    const r = editProfile("remove", part, words);
    if (r.ok && r.changed) gone.push(...r.changed);
  }
  return gone;
}

/** How full each text is (Settings shows it; reflection consolidates a text that is nearly full). */
export function profileUsage(): Record<ProfilePart, { used: number; limit: number }> {
  const p = getProfile();
  return { user: { used: p.user.length, limit: PROFILE_LIMITS.user }, notes: { used: p.notes.length, limit: PROFILE_LIMITS.notes } };
}

const DIGEST_FRESH_MS = 3 * 86_400_000;

/**
 * The profile as a block for a prompt: who the user is, the standing notes, and (while it's fresh) the one line
 * the last reflection left for the next conversation. "" when there is nothing. With `maxChars`, whole entries
 * are dropped from the end — the digest first, then notes, then the profile — until it fits. Cheap; never throws.
 */
export function profileForPrompt(maxChars?: number): string {
  try {
    const p = getProfile();
    let user = entriesOf(p.user);
    let notes = entriesOf(p.notes);
    let digest = "";
    try {
      const d = JSON.parse(getSetting("reflect_digest") ?? "null") as { text?: unknown; at?: unknown } | null;
      if (d && typeof d.text === "string" && typeof d.at === "number" && Date.now() - d.at < DIGEST_FRESH_MS) digest = d.text.trim();
    } catch {
      /* no digest */
    }
    const build = () =>
      [
        user.length ? `About the user:\n${textOf(user)}` : "",
        notes.length ? `Standing notes from the user:\n${textOf(notes)}` : "",
        digest ? `Since the last conversation: ${digest}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    let block = build();
    const cap = typeof maxChars === "number" && maxChars > 0 ? maxChars : Infinity;
    while (block.length > cap && (digest || notes.length || user.length)) {
      if (digest) digest = "";
      else if (notes.length) notes = notes.slice(0, -1);
      else user = user.slice(0, -1);
      block = build();
    }
    return block.length > cap ? "" : block;
  } catch {
    return "";
  }
}

// ─── The check-in's list (data/profile/HEARTBEAT.md) ──────────────────────────────────────

/** The check-in checklist, as stored ("" = none: the check-in doesn't run). */
export function getChecklist(): string {
  try {
    return read("checklist");
  } catch {
    return "";
  }
}

/** Replace the check-in checklist: capped and scanned like the profile. */
export function setChecklist(text: string): ProfileResult {
  try {
    const entries = entriesOf(String(text ?? "").replace(/\r\n?/g, "\n"));
    const bad = checkEntries(entries);
    if (bad) return { ok: false, error: bad };
    const next = textOf(entries);
    const over = tooLong("checklist", next);
    if (over) return { ok: false, error: over };
    write("checklist", next);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
