/*
 * The vault, tested: its cryptography, the device key (Windows DPAPI), the passphrase lock, what makes a valid login
 * or card, authenticator codes, secure forms, the HTTP routes on a real engine started in this process, the voice
 * tools — and the canary: a login, a card and more whose values are unique strings are saved and used, and then
 * everything that can be observed (tool results, every event on every socket, the workspace snapshot and
 * workspace.json, the console, every file the engine wrote) is searched for them.
 *
 *   npx tsx scripts/test-vault.mts
 *
 * It never touches the real vault, the real data/ or the real .env: it runs in TRINITY_DATA_DIR (which must be a
 * fresh folder; without one it makes its own under the system temp folder), with an empty .env and the API key
 * "test-key", on a free port. Every secret in it is made up here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// The secure sheet is browser code: it is checked in a process of its own (`--sheet`), against a stand-in DOM, so
// that nothing of that stand-in is around while the engine runs. See sheetSuite() at the end of this file.
if (process.argv.includes("--sheet")) await sheetSuite();

// ─── A throwaway home, set up before any engine module loads ──────────────────

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.resolve(process.env.TRINITY_DATA_DIR?.trim() || fs.mkdtempSync(path.join(os.tmpdir(), "trinity-vault-test-")));
if (DATA === path.join(REPO, "data") || fs.existsSync(path.join(DATA, "vault"))) {
  console.error(`test-vault: ${DATA} is not a fresh folder. Point TRINITY_DATA_DIR at a new, empty one.`);
  process.exit(2);
}
fs.mkdirSync(DATA, { recursive: true });
process.env.TRINITY_DATA_DIR = DATA;
if (!process.env.DOTENV_CONFIG_PATH) {
  process.env.DOTENV_CONFIG_PATH = path.join(DATA, "empty.env");
  fs.writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
}
const KEY = "test-key";
process.env.TRINITY_API_KEY = KEY;
process.env.HOST = "127.0.0.1";
delete process.env.TRINITY_VAULT_DIR;
delete process.env.TRINITY_AUTH;
// No model, search or voice keys: every service is its mock, and nothing here reaches the network.
for (const k of ["MORDIEM_API_KEY", "MORPH_API_KEY", "TYPESAFE_API_KEY", "DEEPGRAM_API_KEY", "TAVILY_API_KEY", "WEB_SEARCH_API_KEY", "SERPAPI_KEY", "SERPAPI_API_KEY", "FAL_KEY", "PERSONAPLEX_WS_URL"]) delete process.env[k];
const PORT: number = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = (probe.address() as net.AddressInfo).port;
    probe.close(() => resolve(port));
  });
});
process.env.PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

// Everything written to the console from here on is kept, to be searched at the end.
const consoleOut: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const real = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    consoleOut.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return real(chunk, ...rest);
  }) as typeof stream.write;
}

const imp = (p: string) => import(new URL(`../server/src/${p}`, import.meta.url).href);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 4000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (what()) return true;
    await sleep(25);
  }
  return what();
}

// ─── Checks ───────────────────────────────────────────────────────────────────

const sections: { name: string; pass: number; fail: number }[] = [];
function section(name: string): void {
  sections.push({ name, pass: 0, fail: 0 });
  console.log(`\n== ${name}`);
}
function check(name: string, ok: boolean, detail = ""): void {
  const s = sections[sections.length - 1]!;
  if (ok) s.pass++;
  else s.fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
}
/** The error a promise (or a call) ends with — its code when it is the vault's own — or null when it didn't fail. */
async function failure(run: () => unknown): Promise<{ code: string; message: string; err: unknown } | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    return { code: typeof e.code === "string" ? e.code : "", message: String(e.message ?? ""), err };
  }
}

const { vaultDir } = await imp("vault/policy.ts");
if (!path.resolve(vaultDir()).startsWith(DATA + path.sep)) {
  console.error("test-vault: the vault folder is not inside the test folder. Stopping before anything is touched.");
  process.exit(2);
}
const UNIT = path.join(DATA, "unit");
const C = await imp("vault/crypto.ts");
const { VaultError } = await imp("vault/errors.ts");
const { VaultStore, retryDelayMs, FREE_TRIES } = await imp("vault/store.ts");
const items = await imp("vault/items.ts");
const { Secret, guard, holds, needlesOf, MASK } = await imp("vault/secret.ts");
const totpMod = await imp("vault/totp.ts");
const dpapi = await imp("vault/dpapi.ts");

/** A device key that needs no PowerShell: for everything that isn't about DPAPI itself. */
function standInDevice() {
  const secret = new Uint8Array(crypto.randomBytes(32));
  return { available: () => true, secret: async () => secret };
}
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const text = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
const flip = (b64: string, at = 0): string => {
  const b = Buffer.from(b64, "base64");
  b[at % b.length] = b[at % b.length]! ^ 0x01;
  return b.toString("base64");
};

// ══ 1. Where the vault lives ══════════════════════════════════════════════════
section("where the vault lives");
check("with TRINITY_DATA_DIR set: <data>/vault", vaultDir() === path.join(DATA, "vault"));
process.env.TRINITY_VAULT_DIR = path.join(DATA, "elsewhere");
check("TRINITY_VAULT_DIR wins", vaultDir() === path.join(DATA, "elsewhere"));
delete process.env.TRINITY_VAULT_DIR;
{
  const keep = process.env.TRINITY_DATA_DIR;
  delete process.env.TRINITY_DATA_DIR;
  const real = vaultDir();
  process.env.TRINITY_DATA_DIR = keep;
  const want = process.platform === "win32" ? /[\\/]Trinity[\\/]vault$/ : /[\\/]\.config[\\/]trinity[\\/]vault$/;
  check("without either: the user's own app-data folder, outside the repository", want.test(real) && !real.startsWith(REPO), real.replace(os.homedir(), "~"));
}

// ══ 2. Cryptography ═══════════════════════════════════════════════════════════
section("cryptography");
{
  const key = C.randomBytes(32);
  const aad = "item-1|login|1";
  const sealed = C.seal(key, bytes("the plaintext"), aad);
  check("AES-256-GCM round trip", text(C.open(key, sealed, aad)) === "the plaintext");
  check("12-byte IV, 16-byte tag", Buffer.from(sealed.iv, "base64").length === 12 && Buffer.from(sealed.tag, "base64").length === 16);
  const again = C.seal(key, bytes("the plaintext"), aad);
  check("a fresh IV for every write (same plaintext, different IV and ciphertext)", again.iv !== sealed.iv && again.ct !== sealed.ct);
  const ivs = new Set(Array.from({ length: 200 }, () => C.seal(key, bytes("x"), aad).iv));
  check("200 seals, 200 different IVs", ivs.size === 200);
  const bad = async (name: string, s: unknown, a: string, k = key) => {
    const f = await failure(() => C.open(k, s, a));
    check(`tampering detected: ${name}`, f?.code === "tampered", f ? f.code : "it decrypted");
  };
  await bad("a flipped ciphertext bit", { ...sealed, ct: flip(sealed.ct, 3) }, aad);
  await bad("a flipped IV bit", { ...sealed, iv: flip(sealed.iv, 5) }, aad);
  await bad("a flipped tag bit", { ...sealed, tag: flip(sealed.tag, 1) }, aad);
  await bad("another item's id in the associated data", sealed, "item-2|login|1");
  await bad("another kind in the associated data", sealed, "item-1|card|1");
  await bad("another version in the associated data", sealed, "item-1|login|2");
  await bad("the wrong key", sealed, aad, C.randomBytes(32));
  await bad("a truncated ciphertext", { ...sealed, ct: Buffer.from(sealed.ct, "base64").subarray(0, 5).toString("base64") }, aad);
  const shortTag = await failure(() => C.open(key, { ...sealed, tag: Buffer.from(sealed.tag, "base64").subarray(0, 12).toString("base64") }, aad));
  check("a shortened tag is refused outright", shortTag !== null && (shortTag.code === "damaged" || shortTag.code === "tampered"), shortTag?.code);
  const errText = (await failure(() => C.open(key, { ...sealed, ct: flip(sealed.ct) }, aad)))?.message ?? "";
  check("the error names no key, plaintext or ciphertext", !errText.includes(sealed.ct) && !errText.includes("plaintext") && errText.length < 200);

  const salt = C.randomBytes(32);
  const k1 = C.hkdf(bytes("input key material, thirty-two b"), salt, "trinity-vault/kek/v1/device/device");
  const k2 = C.hkdf(bytes("input key material, thirty-two b"), salt, "trinity-vault/kek/v1/device/device");
  const k3 = C.hkdf(bytes("input key material, thirty-two b"), salt, "trinity-vault/kek/v1/passphrase/device");
  check("HKDF-SHA256: 32 bytes, repeatable, and different for a different purpose", k1.length === 32 && Buffer.from(k1).equals(Buffer.from(k2)) && !Buffer.from(k1).equals(Buffer.from(k3)));
  // RFC 5869 test case 1 (L = 32 of its 42 bytes).
  const rfc = Buffer.from(crypto.hkdfSync("sha256", Buffer.from("0b".repeat(22), "hex"), Buffer.from("000102030405060708090a0b0c", "hex"), Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex"), 32)).toString("hex");
  check("HKDF matches RFC 5869 test case 1", rfc === "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf");
  const t0 = Date.now();
  const s1 = await C.scryptKey("correct horse", bytes("0123456789abcdef"));
  const ms = Date.now() - t0;
  const s2 = await C.scryptKey("correct horse", bytes("0123456789abcdef"));
  const s3 = await C.scryptKey("correct horsf", bytes("0123456789abcdef"));
  const ref = crypto.scryptSync("correct horse", Buffer.from("0123456789abcdef"), 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  check("scrypt for a passphrase set now: N=2^17 r=8 p=1 → 32 bytes, as node:crypto computes it", C.SCRYPT.N === 2 ** 17 && C.SCRYPT.r === 8 && C.SCRYPT.p === 1 && s1.length === 32 && Buffer.from(s1).equals(ref) && Buffer.from(s1).equals(Buffer.from(s2)) && !Buffer.from(s1).equals(Buffer.from(s3)), `${ms} ms`);
  const old15 = await C.scryptKey("correct horse", bytes("0123456789abcdef"), { N: 2 ** 15, r: 8, p: 1 });
  check("…and the cost a file was made with (N=2^15) is still computed", Buffer.from(old15).equals(crypto.scryptSync("correct horse", Buffer.from("0123456789abcdef"), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })));
  check("absurd scrypt parameters are refused: N over 2^20, more than 512 MB, r or p out of range", !C.scryptParamsOk({ N: 2 ** 21, r: 8, p: 1 }) && !C.scryptParamsOk({ N: 2 ** 20, r: 8, p: 1 }) && C.scryptParamsOk({ N: 2 ** 19, r: 8, p: 1 }) && !C.scryptParamsOk({ N: 2 ** 19, r: 16, p: 1 }) && !C.scryptParamsOk({ N: 2 ** 17, r: 64, p: 1 }) && !C.scryptParamsOk({ N: 2 ** 17, r: 8, p: 64 }) && (await failure(() => C.scryptKey("x", bytes("0123456789abcdef"), { N: 2 ** 24, r: 8, p: 1 })))?.code === "damaged");
  const dead = new Uint8Array(32);
  const sealDead = await failure(() => C.seal(dead, bytes("x"), "a|b|1"));
  const openDead = await failure(() => C.open(dead, sealed, aad));
  check("a wiped (all-zero) key seals nothing and opens nothing", sealDead?.code === "failed" && openDead?.code === "failed" && C.isZeroKey(dead) && !C.isZeroKey(key) && (await failure(() => C.liveKey(dead)))?.code === "failed");
  check("scrypt parameters from a file are bounded", C.scryptParamsOk({ N: 2 ** 15, r: 8, p: 1 }) && !C.scryptParamsOk({ N: 2 ** 10, r: 8, p: 1 }) && !C.scryptParamsOk({ N: 2 ** 26, r: 8, p: 1 }) && !C.scryptParamsOk({ N: 40000, r: 8, p: 1 }));
  check("canonical JSON ignores key order", C.canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }) === C.canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  const mk = C.randomBytes(32);
  check("MAC verifies, and fails for other text or another key", C.macOk(mk, "abc", C.mac(mk, "abc")) && !C.macOk(mk, "abd", C.mac(mk, "abc")) && !C.macOk(C.randomBytes(32), "abc", C.mac(mk, "abc")) && !C.macOk(mk, "abc", "nonsense"));
  const w = C.randomBytes(32);
  C.wipe(w);
  check("wipe zeroes a key", w.every((b: number) => b === 0));
}

// ══ 3. Secrets don't print ════════════════════════════════════════════════════
section("secrets that don't print");
{
  const s = new Secret("hunter2-not-real");
  const shown = [String(s), `${s}`, s + "", JSON.stringify(s), JSON.stringify({ s }), util.inspect(s), util.inspect({ nested: { s } }), util.format("%s %o %j", s, s, s)];
  check("a Secret: String, template, +, JSON.stringify, util.inspect, util.format all give [secret]", shown.every((x) => !x.includes("hunter2")) && shown.every((x) => x.includes(MASK)), shown[4]);
  check("a Secret gives its value only through expose()", s.expose() === "hunter2-not-real" && !Object.keys(s).length && !Object.getOwnPropertyNames(s).length);
  const g = guard({ username: "ryan@example.com", password: "hunter2-not-real" });
  const prints = [String(g.view), `${g.view}`, JSON.stringify(g.view), JSON.stringify({ a: [g.view] }), util.inspect(g.view), util.inspect({ deep: [g.view] }, { depth: 9 })];
  check("the object handed out by useSecret prints as [secret] every way", prints.every((x) => !x.includes("hunter2") && !x.includes("ryan@")), prints[3]);
  check("…while its fields read as the values the fill needs", g.view.password === "hunter2-not-real" && g.view.username === "ryan@example.com");
  check("…and cannot be changed", (await failure(() => ((g.view as { password: string }).password = "x"))) !== null && g.view.password === "hunter2-not-real");
  g.revoke();
  const after = await failure(() => g.view.password);
  check("once taken back, a field read throws and still prints as [secret]", after?.code === "gone" && JSON.stringify(g.view) === `"${MASK}"` && util.inspect(g.view) === MASK);
  const needles = needlesOf(["hunter2-not-real", "4242424242424242", "123", "654321", undefined]);
  check("what is searched for: long values, a card number in every spelling; never a 3-digit code", needles.includes("4242 4242 4242 4242") && needles.includes("4242-4242-4242-4242") && !needles.includes("123") && !needles.includes("654321"));
  check("holds() finds a secret in a nested result, an error, a Map, bytes", holds({ a: [{ b: "x hunter2-not-real y" }] }, needles) && holds(new Error("failed for hunter2-not-real"), needles) && holds(new Map([["k", "4242 4242 4242 4242"]]), needles) && holds(Buffer.from("zz hunter2-not-real"), needles) && !holds({ a: "nothing here", n: 4242 }, needles));
}

// ══ 4. Items: hosts, hints, cards ═════════════════════════════════════════════
section("hosts, hints and cards");
{
  const host = (s: string) => items.normalizeHost(s);
  check("a host from an address, lower-cased, without scheme, port or path", host("https://WWW.Netflix.com:443/login?x=1") === "www.netflix.com" && host("  Example.COM. ") === "example.com");
  check("an international name becomes its ASCII form", host("bücher.example") === "xn--bcher-kva.example");
  for (const bad of ["netflix", "", "http://", "exa mple.com", "*.example.com", "[::1]", "example..com", "-a.example.com", "a".repeat(300) + ".com"]) {
    const f = await failure(() => host(bad));
    if (f?.code !== "invalid") check(`refused as a host: ${JSON.stringify(bad.slice(0, 20))}`, false, f?.code ?? "accepted");
  }
  check("a bare word, a wildcard, an IPv6 literal, a space: refused as hosts", true);
  check("several hosts, each exact", JSON.stringify(items.parseHosts("netflix.com, www.netflix.com netflix.com")) === JSON.stringify(["netflix.com", "www.netflix.com"]));
  check("the user name is masked: first character, an ellipsis, the @domain of an email", items.usernameHint("ryan@gmail.com") === "r…@gmail.com" && items.usernameHint("ryan") === "r…" && items.usernameHint("") === undefined);
  check("a name for a login from its host", items.labelFromHost("www.netflix.com") === "Netflix" && items.labelFromHost("accounts.google.com") === "Google" && items.labelFromHost("www.bbc.co.uk") === "Bbc");
  check(
    "the name a site is registered under: netflix for www.netflix.com, bbc for www.bbc.co.uk — evil for netflix.com.evil.io; none for an address",
    items.siteNameOf("www.netflix.com") === "netflix" && items.siteNameOf("www.bbc.co.uk") === "bbc" && items.siteNameOf("netflix.com.evil.io") === "evil" && items.siteNameOf("evilnetflix.com") === "evilnetflix" && items.siteNameOf("netflix.co.io") === "co" && items.siteNameOf("192.168.1.20") === null && items.siteNameOf("localhost") === null,
  );

  check("Luhn: the test numbers pass", ["4242424242424242", "5555555555554444", "378282246310005", "6011111111111117", "3530111333300000", "30569309025904"].every(items.luhnOk));
  check("Luhn: one wrong digit, letters, too short, too long all fail", !items.luhnOk("4242424242424241") && !items.luhnOk("4242-4242") && !items.luhnOk("42424242424") && !items.luhnOk("4".repeat(20)) && !items.luhnOk(""));
  const brands: [string, string][] = [
    ["4242424242424242", "Visa"],
    ["5555555555554444", "Mastercard"],
    ["2223003122003222", "Mastercard"],
    ["378282246310005", "American Express"],
    ["6011111111111117", "Discover"],
    ["3530111333300000", "JCB"],
    ["30569309025904", "Diners Club"],
    ["6200000000000005", "UnionPay"],
    ["9999999999999995", "Card"],
  ];
  const wrongBrand = brands.filter(([n, b]) => items.cardBrand(n) !== b).map(([n, b]) => `${n.slice(0, 4)}→${items.cardBrand(n)}≠${b}`);
  check("the brand from the number's prefix (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay)", wrongBrand.length === 0, wrongBrand.join(" "));
  const now = new Date(2026, 10, 10);
  const exp = (s: string) => items.parseExpiry(s, now);
  check("expiry: MM/YY, M/YYYY, MMYY", JSON.stringify([exp("08/27"), exp("8/2027"), exp("0827"), exp("11/26")]) === JSON.stringify([{ month: 8, year: 2027 }, { month: 8, year: 2027 }, { month: 8, year: 2027 }, { month: 11, year: 2026 }]));
  const expBad = await Promise.all(["13/27", "00/27", "10/26", "08/2025", "soon", "", "08/99"].map((s) => failure(() => exp(s))));
  check("expiry: month 13, month 0, last month, last year, words, nothing, 2099+ are refused", expBad.every((f) => f?.code === "invalid"), expBad.map((f) => f?.code ?? "accepted").join(","));

  const card = items.buildItem("card", { number: "4242 4242 4242 4242", expiry: "08/30", holder: "A Person", cvc: "123", keepCvc: false });
  check("a card: brand, last four, expiry and a name made from them", card.kind === "card" && card.brand === "Visa" && card.last4 === "4242" && card.expMonth === 8 && card.expYear === 2030 && card.label === "Visa ending 4242");
  check("the security code is NOT kept unless the box was ticked", card.kind === "card" && card.hasCvc === false && card.secret.cvc === undefined);
  const kept = items.buildItem("card", { number: "4242424242424242", expiry: "08/30", cvc: "123", keepCvc: true });
  check("…and is kept when it was", kept.kind === "card" && kept.hasCvc === true && kept.secret.cvc === "123");
  const badNumber = await failure(() => items.buildItem("card", { number: "4242424242424243", expiry: "08/30" }));
  check("a card number with a wrong digit is refused — and the message doesn't quote it", badNumber?.code === "invalid" && !/4242/.test(badNumber.message), badNumber?.message);
  const login = items.buildItem("login", { label: "", hosts: "https://www.netflix.com/login", username: "ryan@example.com", password: " pass with spaces " });
  check("a login: exact host, masked hint, name from the host, the password kept exactly as typed", login.kind === "login" && login.hosts[0] === "www.netflix.com" && login.usernameHint === "r…@example.com" && login.label === "Netflix" && login.secret.password === " pass with spaces ");
  const fixed = items.buildItem("login", { hosts: "evil.example", password: "x" }, "www.netflix.com");
  check("a form opened for a site saves for exactly that site, whatever is posted", fixed.kind === "login" && JSON.stringify(fixed.hosts) === JSON.stringify(["www.netflix.com"]));
  const noPass = await failure(() => items.buildItem("login", { hosts: "example.com", password: "" }));
  check("a login without a password is refused", noPass?.code === "invalid");
  const slips = await Promise.all([
    failure(() => items.buildItem("login", { label: "pasted-pw-5512", hosts: "example.com", password: "pasted-pw-5512" })),
    failure(() => items.buildItem("card", { label: "my card 4242 4242 4242 4242", number: "4242424242424242", expiry: "08/30" })),
    failure(() => items.buildItem("secret", { label: "Wi-Fi: hunter2-wifi", value: "hunter2-wifi" })),
  ]);
  check("a name that holds the secret itself (the password pasted into the wrong box) is refused, without quoting it", slips.every((f) => f?.code === "invalid" && (f.err as { field?: string }).field === "label" && !/5512|4242|hunter2/.test(f.message)));
  check("…but the plain name of the site is fine even when the password is that weak", items.buildItem("login", { label: "Netflix", hosts: "www.netflix.com", password: "netflix" }).label === "Netflix");
  const who = items.buildItem("identity", { fullName: "A Person", email: "a@example.com", city: " Lisbon " });
  check("details: only what was filled in is kept", who.kind === "identity" && JSON.stringify(who.secret) === JSON.stringify({ fullName: "A Person", email: "a@example.com", city: "Lisbon" }) && who.label === "My details");
}

// ══ 5. Authenticator codes ════════════════════════════════════════════════════
section("authenticator codes (RFC 4226, RFC 6238)");
{
  const seed = bytes("12345678901234567890");
  const hotpWant = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  check("HOTP: the ten RFC 4226 values", hotpWant.every((v, i) => totpMod.hotp(seed, i) === v));
  // RFC 6238 appendix B, SHA-1: the seed above in base32, eight digits.
  const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  check("base32 decodes to the RFC seed", text(totpMod.base32Decode(b32)) === "12345678901234567890");
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  const wrong = vectors.filter(([t, v]) => totpMod.totp(b32, t * 1000, { digits: 8 }) !== v);
  check("TOTP: the six RFC 6238 SHA-1 vectors (8 digits)", wrong.length === 0, wrong.map(([t]) => t).join(","));
  check("TOTP: six digits are the last six of those", vectors.every(([t, v]) => totpMod.totp(b32, t * 1000) === v.slice(2)));
  check("TOTP: the same code through a 30-second step, a new one after it", totpMod.totp(b32, 60_000) === totpMod.totp(b32, 89_999) && totpMod.totp(b32, 60_000) !== totpMod.totp(b32, 90_000));
  check("a typed key is cleaned (spaces, dashes, case, padding)", totpMod.normalizeTotpSecret(" gezd gnbv-gy3t qojq gezd gnbv gy3t qojq== ") === b32);
  check("an otpauth:// link gives its key", totpMod.normalizeTotpSecret(`otpauth://totp/Example:ryan?secret=${b32}&issuer=Example`) === b32);
  const odd = await Promise.all([`otpauth://totp/x?secret=${b32}&digits=8`, `otpauth://hotp/x?secret=${b32}`, "not base32 !!", "ABC"].map((s) => failure(() => totpMod.normalizeTotpSecret(s))));
  check("8-digit, counter-based, malformed and too-short keys are refused", odd.every((f) => f?.code === "invalid"));
}

// ══ 6. The store ══════════════════════════════════════════════════════════════
section("the store: sealing, using, tampering");
{
  const dir = path.join(UNIT, "store");
  const device = standInDevice();
  let store = new VaultStore({ dir, device });
  check("nothing saved yet: empty, device lock, no file", JSON.stringify(store.status()) === JSON.stringify({ state: "empty", lock: "device", items: 0 }) && !fs.existsSync(path.join(dir, "vault.json")));
  const PASS = "unit-test-password-7c1f";
  const meta = await store.add(items.buildItem("login", { label: "Netflix", hosts: "www.netflix.com", username: "ryan@example.com", password: PASS, totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }));
  const file = () => fs.readFileSync(path.join(dir, "vault.json"), "utf8");
  check("saved: metadata in the clear, the secret nowhere in the file", file().includes('"label": "Netflix"') && !file().includes(PASS) && !file().includes("ryan@example.com") && !file().includes("GEZDGNBV") && !file().includes(Buffer.from(PASS).toString("base64")));
  check("status: unlocked, one item", store.status().state === "unlocked" && store.status().items === 1);
  check("logins are found for exactly their host", store.findLogins("www.netflix.com").length === 1 && store.findLogins("netflix.com").length === 0 && store.findLogins("evil-netflix.com").length === 0 && store.findLogins("WWW.NETFLIX.COM").length === 1);
  check("metadata handed out is a copy", (() => { const m = store.list()[0]; m.hosts.push("evil.example"); return store.findLogins("evil.example").length === 0; })());

  let seen: Record<string, unknown> = {};
  let kept: { password: string } | null = null;
  const out = await store.use(meta.id, "fill on www.netflix.com", async (secret: { username: string; password: string; totpSecret?: string; totpCode?: string }, m: { label: string }) => {
    seen = { user: secret.username, pass: secret.password, code: secret.totpCode, label: m.label, printed: `${secret} ${JSON.stringify(secret)} ${util.inspect(secret)}` };
    kept = secret;
    return { filled: ["username", "password", "otp"] };
  });
  check("useSecret hands the secret to fn and returns what fn returns", seen.user === "ryan@example.com" && seen.pass === PASS && seen.label === "Netflix" && JSON.stringify(out) === JSON.stringify({ filled: ["username", "password", "otp"] }));
  check("…with the current six-digit authenticator code", /^\d{6}$/.test(String(seen.code)) && seen.code === totpMod.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
  check("…as an object that prints as [secret]", !String(seen.printed).includes(PASS) && String(seen.printed).includes(MASK));
  check("…which is emptied when fn is done (a kept reference reads nothing)", (await failure(() => kept!.password))?.code === "gone");
  check("lastUsedAt is set", typeof store.meta(meta.id)?.lastUsedAt === "number");
  const log = () => fs.readFileSync(path.join(dir, "access.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ts: number; id: string; purpose: string; ok: boolean });
  check("the access log has the time, the id and the purpose — and no value", log().length === 1 && log()[0]!.id === meta.id && log()[0]!.purpose === "fill on www.netflix.com" && !fs.readFileSync(path.join(dir, "access.log"), "utf8").includes(PASS));
  const leak = await failure(() => store.use(meta.id, "test", async (s: { password: string }) => ({ note: `typed ${s.password}` })));
  check("a result that holds the password is stopped", leak?.code === "leak" && !leak.message.includes(PASS));
  const leakErr = await failure(() => store.use(meta.id, "test", async (s: { password: string }) => { throw new Error(`could not type ${s.password}`); }));
  check("an error that holds the password is stopped too", leakErr?.code === "leak" && !leakErr.message.includes(PASS) && !String((leakErr.err as Error).stack).includes(PASS));
  const own = await failure(() => store.use(meta.id, "test", async () => { throw new Error("the tab went away"); }));
  check("fn's own harmless error is passed on as it is", own?.message === "the tab went away");
  const weak = await store.add(items.buildItem("login", { hosts: "www.hulu-example.com", username: "u", password: "hulu-example" }));
  const worse = await store.add(items.buildItem("login", { hosts: "plain.example", username: "u", password: "password" }));
  const honest = { ok: true, origin: "https://www.hulu-example.com", filled: ["username", "password"], step: "done" };
  check("a weak password that is part of the site's own name, or the word 'password', doesn't make an honest result look like a leak", JSON.stringify(await store.use(weak.id, "x", async () => honest)) === JSON.stringify(honest) && JSON.stringify(await store.use(worse.id, "x", async () => honest)) === JSON.stringify(honest));
  await store.remove(weak.id);
  await store.remove(worse.id);
  await store.use(meta.id, `fill ${PASS} somewhere`, async () => 1);
  check("a purpose that holds the secret is not written to the log", !fs.readFileSync(path.join(dir, "access.log"), "utf8").includes(PASS) && log().some((l) => l.purpose.includes("withheld")));
  check("a missing item: not-found", (await failure(() => store.use("nope-nope-nope", "x", async () => 1)))?.code === "not-found");

  await store.addHost(meta.id, "https://Netflix.com/");
  check("addHost: the login is then found on the new host too", store.findLogins("netflix.com").length === 1 && store.meta(meta.id)!.hosts.length === 2);
  const card = await store.add(items.buildItem("card", { number: "4242424242424242", expiry: "08/30", holder: "A Person" }));
  check("only a login takes hosts", (await failure(() => store.addHost(card.id, "example.com")))?.code === "invalid");
  check("no temp files are left behind", fs.readdirSync(dir).every((f) => !f.endsWith(".tmp")), fs.readdirSync(dir).join(" "));

  // A new engine run: the same files, a fresh store.
  store = new VaultStore({ dir, device });
  check("after a restart: locked until first use, metadata still listed", store.status().state === "locked" && store.list().length === 2);
  check("…and the device key alone unlocks it on first use", (await store.use(meta.id, "after restart", async (s: { password: string }) => s.password === PASS)) === true && store.status().state === "unlocked");
  await store.lock();
  check("lock() forgets the key; the next use unlocks again", store.status().state === "locked" && (await store.use(card.id, "again", async (s: { number: string }) => s.number.length)) === 16);
  let during: { number: string } | null = null;
  const blockedUse = store.use(card.id, "lock while in use", async (s: { number: string }) => {
    during = s;
    await store.lock();
    return (await failure(() => during!.number))?.code;
  });
  check("locking empties a secret that is in use at that moment", (await blockedUse) === "gone");
  const otherDevice = await failure(() => new VaultStore({ dir, device: standInDevice() }).use(meta.id, "x", async () => 1));
  check("another computer's device key opens nothing", otherDevice?.code === "tampered", otherDevice?.code);

  // Tampering with the file, one field at a time: each copy is opened by a fresh store.
  const pristine = file();
  const tamper = async (name: string, edit: (f: any) => void, want: string[] = ["blocked", "tampered"]) => {
    const d = path.join(UNIT, `tamper-${name.replace(/[^a-z0-9]+/gi, "-")}`);
    fs.mkdirSync(d, { recursive: true });
    const f = JSON.parse(pristine);
    edit(f);
    fs.writeFileSync(path.join(d, "vault.json"), JSON.stringify(f));
    const s = new VaultStore({ dir: d, device });
    const use = await failure(() => s.use(meta.id, "x", async (sec: { password: string }) => sec.password));
    const add = await failure(() => s.add(items.buildItem("secret", { label: "x", value: "y" })));
    const refused = use !== null && want.includes(use.code) && add !== null && want.includes(add.code);
    const untouched = fs.readFileSync(path.join(d, "vault.json"), "utf8") === JSON.stringify(f);
    check(`tampered file refused: ${name}`, refused && untouched && !use!.message.includes(PASS), `${use?.code ?? "USED"}/${add?.code ?? "ADDED"}${untouched ? "" : " file rewritten"}`);
  };
  await tamper("an item's ciphertext", (f) => (f.items[0].ct = flip(f.items[0].ct, 7)));
  await tamper("an item's IV", (f) => (f.items[0].iv = flip(f.items[0].iv, 2)));
  await tamper("an item's tag", (f) => (f.items[0].tag = flip(f.items[0].tag, 2)));
  await tamper("an item's id (its associated data)", (f) => (f.items[0].meta.id = "AAAAAAAAAAAAAAAA"), ["blocked", "tampered", "not-found"]);
  await tamper("an item's kind (its associated data)", (f) => (f.items[0].meta.kind = "secret"));
  await tamper("an item's version (its associated data)", (f) => (f.items[0].v = 2));
  await tamper("a host added to a login", (f) => f.items[0].meta.hosts.push("evil.example"));
  await tamper("a label changed", (f) => (f.items[0].meta.label = "Renamed"));
  await tamper("two items' ciphertexts swapped", (f) => { const a = f.items[0], b = f.items[1]; [a.iv, a.ct, a.tag, b.iv, b.ct, b.tag] = [b.iv, b.ct, b.tag, a.iv, a.ct, a.tag]; });
  await tamper("an item deleted", (f) => f.items.pop());
  await tamper("the spending limit raised", (f) => (f.settings.spendingLimit = 999999));
  await tamper("the wrapped key", (f) => (f.key.ct = flip(f.key.ct, 4)));
  await tamper("the key-derivation salt", (f) => (f.kdf.salt = flip(f.kdf.salt, 4)));
  await tamper("the lock mode", (f) => { f.lock = "passphrase"; f.kdf.scrypt = { salt: Buffer.alloc(16).toString("base64"), N: 32768, r: 8, p: 1 }; }, ["blocked", "tampered", "locked"]);
  await tamper("the MAC itself", (f) => (f.mac = flip(f.mac, 9)));
  await tamper("an unknown version", (f) => (f.version = 2), ["blocked"]);
  await tamper("an unknown format", (f) => (f.format = "something-else"), ["blocked"]);
  await tamper("an extra field", (f) => (f.note = "hello"), ["blocked"]);
  {
    const d = path.join(UNIT, "tamper-truncated");
    fs.mkdirSync(d, { recursive: true });
    const cut = pristine.slice(0, pristine.length - 40);
    fs.writeFileSync(path.join(d, "vault.json"), cut);
    const s = new VaultStore({ dir: d, device });
    const st = s.status();
    const add = await failure(() => s.add(items.buildItem("secret", { label: "x", value: "y" })));
    check("a truncated file: blocked, nothing listed, and never written over", typeof st.blocked === "string" && s.list().length === 0 && add?.code === "blocked" && fs.readFileSync(path.join(d, "vault.json"), "utf8") === cut && !add.message.includes(cut.slice(20, 60)));
  }
  check("the untouched file still opens", (await new VaultStore({ dir, device }).use(meta.id, "x", async (s: { password: string }) => s.password === PASS)) === true);
  check("remove: gone from the list and from the file", (await store.remove(card.id)) === true && (await store.remove(card.id)) === false && store.list().length === 1 && !file().includes(card.id));
  check("settings: the spending limit is 200 until it is changed", store.settings().spendingLimit === 200 && (await store.setSettings({ spendingLimit: 75.5 })).spendingLimit === 75.5 && new VaultStore({ dir, device }).settings().spendingLimit === 75.5);
  check("a nonsense spending limit is refused", (await failure(() => store.setSettings({ spendingLimit: -1 })))?.code === "invalid" && (await failure(() => store.setSettings({ spendingLimit: Number.NaN })))?.code === "invalid");
}

// ══ 7. The passphrase lock ════════════════════════════════════════════════════
section("the passphrase lock");
{
  const dir = path.join(UNIT, "passphrase");
  const device = standInDevice();
  let clock = Date.now();
  const make = (extra: Record<string, unknown> = {}) => new VaultStore({ dir, device, now: () => clock, ...extra });
  let store = make();
  const PASS = "unit-test-password-9d2e";
  const PHRASE = "correct horse battery staple";
  const meta = await store.add(items.buildItem("login", { hosts: "example.com", username: "u", password: PASS }));
  check("a passphrase shorter than eight characters is refused", (await failure(() => store.setLock("passphrase", { passphrase: new Secret("short") })))?.code === "invalid");
  await store.setLock("passphrase", { passphrase: new Secret(PHRASE) });
  const raw = fs.readFileSync(path.join(dir, "vault.json"), "utf8");
  check("lock mode passphrase: scrypt parameters (N=2^17) and salts in the file, the passphrase nowhere", /"lock": "passphrase"/.test(raw) && /"N": 131072/.test(raw) && /"r": 8/.test(raw) && /"p": 1/.test(raw) && !raw.includes(PHRASE));
  check("it stays unlocked for the one who just set it", store.status().state === "unlocked");

  store = make();
  check("after a restart it is locked, and the items are still listed by name", JSON.stringify(store.status()) === JSON.stringify({ state: "locked", lock: "passphrase", items: 1 }) && store.list()[0]?.label === "Example");
  check("locked: a secret can't be used, added, removed or re-hosted", (await Promise.all([failure(() => store.use(meta.id, "x", async () => 1)), failure(() => store.add(items.buildItem("secret", { label: "x", value: "y" }))), failure(() => store.remove(meta.id)), failure(() => store.addHost(meta.id, "b.example"))])).every((f) => f?.code === "locked"));
  for (let i = 1; i <= FREE_TRIES; i++) {
    const f = await failure(() => store.unlock(new Secret(`wrong guess ${i}`)));
    if (f?.code !== "wrong-passphrase") check(`wrong passphrase #${i}`, false, f?.code ?? "unlocked");
  }
  check("five wrong passphrases: each refused, none echoed", store.status().state === "locked");
  const sixth = await failure(() => store.unlock(new Secret(PHRASE)));
  check("…then even the right one has to wait (30 s)", sixth?.code === "wait" && Math.abs(((sixth.err as { retryAfterMs: number }).retryAfterMs ?? 0) - 30_000) < 50 && store.status().state === "locked", String((sixth?.err as { retryAfterMs?: number })?.retryAfterMs));
  check("the wait survives a restart", (await failure(() => make().unlock(new Secret(PHRASE))))?.code === "wait");
  clock += 30_001;
  check("after the wait a wrong one is refused again…", (await failure(() => store.unlock(new Secret("still wrong"))))?.code === "wrong-passphrase");
  const longer = await failure(() => store.unlock(new Secret(PHRASE)));
  check("…and the next wait is longer (60 s): the delay grows", longer?.code === "wait" && Math.abs(((longer.err as { retryAfterMs: number }).retryAfterMs ?? 0) - 60_000) < 50);
  check("the delays: 0 for the first five, then 30 s doubling to at most 15 min", retryDelayMs(4) === 0 && retryDelayMs(5) === 30_000 && retryDelayMs(6) === 60_000 && retryDelayMs(7) === 120_000 && retryDelayMs(40) === 15 * 60_000);
  clock += 60_001;
  await store.unlock(new Secret(PHRASE));
  check("the right passphrase unlocks, and the count starts over", store.status().state === "unlocked" && store.retryAfterMs() === 0 && (await store.use(meta.id, "x", async (s: { password: string }) => s.password === PASS)) === true);
  check("a wrong passphrase is refused even while it is unlocked", (await failure(() => store.unlock(new Secret("nope nope nope"))))?.code === "wrong-passphrase");
  await store.unlock(new Secret(PHRASE));

  const quick = make({ idleMs: 600 });
  await quick.unlock(new Secret(PHRASE));
  await sleep(300);
  await quick.use(meta.id, "keeps it awake", async () => 1);
  await sleep(400); // 700 ms since it was unlocked, 400 since it was last used
  const stillOpen = quick.status().state;
  await sleep(500);
  check("it re-locks after the idle time (15 minutes; 600 ms here), counted from the last use", stillOpen === "unlocked" && quick.status().state === "locked" && (await failure(() => quick.use(meta.id, "x", async () => 1)))?.code === "locked");

  check("to change the lock, being unlocked is not enough: the current passphrase is asked for", (await failure(() => store.setLock("device")))?.code === "invalid" && (await failure(() => store.setLock("device", { current: new Secret("not it at all") })))?.code === "wrong-passphrase");
  await store.setLock("passphrase", { passphrase: new Secret("a new passphrase entirely"), current: new Secret(PHRASE) });
  store = make();
  check("a changed passphrase: the old one no longer opens it, the new one does", (await failure(() => store.unlock(new Secret(PHRASE))))?.code === "wrong-passphrase" && (await store.unlock(new Secret("a new passphrase entirely")), store.status().state === "unlocked"));
  await store.setLock("device", { current: new Secret("a new passphrase entirely") });
  store = make();
  check("back to the device lock: it opens by itself again", store.status().lock === "device" && (await store.use(meta.id, "x", async (s: { password: string }) => s.password === PASS)) === true);

  // A computer with no key store at all.
  const bare = path.join(UNIT, "no-key-store");
  let none = new VaultStore({ dir: bare, device: null });
  check("no key store: passphrase is the only lock, and the vault says what to do", none.status().lock === "passphrase" && /passphrase/i.test(none.status().blocked ?? ""));
  check("…nothing can be saved before a passphrase is set", (await failure(() => none.add(items.buildItem("secret", { label: "x", value: "y" }))))?.code === "no-key-store" && !fs.existsSync(path.join(bare, "vault.json")));
  check("…and the device lock can't be chosen", (await failure(() => none.setLock("device")))?.code === "no-key-store");
  await none.setLock("passphrase", { passphrase: new Secret(PHRASE) });
  const m2 = await none.add(items.buildItem("secret", { label: "Wi-Fi", value: "unit-test-wifi-secret" }));
  none = new VaultStore({ dir: bare, device: null });
  await none.unlock(new Secret(PHRASE));
  check("…with one set it works, from the passphrase alone", (await none.use(m2.id, "x", async (s: { value: string }) => s.value === "unit-test-wifi-secret")) === true && none.status().blocked === undefined);
  const files = fs.readdirSync(bare).sort();
  check("never an unprotected key file: only the vault, its attempt count and its log are written", JSON.stringify(files) === JSON.stringify(["access.log", "vault.json"]) || JSON.stringify(files) === JSON.stringify(["access.log", "attempts.json", "vault.json"]), files.join(" "));
  check("a vault that needs a device key doesn't open where there is none", (await failure(() => new VaultStore({ dir, device: null }).use(meta.id, "x", async () => 1)))?.code === "no-key-store");

  // A key store that is there but won't protect a key (PowerShell locked down by policy).
  let dead = false;
  const failing = {
    available: () => !dead,
    secret: async (): Promise<Uint8Array> => {
      dead = true;
      throw new VaultError("no-key-store", "The Windows key store (DPAPI) didn't answer, so the vault's key can't be read.");
    },
  };
  const fdir = path.join(UNIT, "failing-key-store");
  const fl = new VaultStore({ dir: fdir, device: failing });
  const firstSave = await failure(() => fl.add(items.buildItem("secret", { label: "x", value: "y" })));
  check("a key store that fails: the first save says so, nothing is written, and from then on the vault asks for a passphrase", firstSave?.code === "no-key-store" && !fs.existsSync(path.join(fdir, "vault.json")) && fl.status().lock === "passphrase" && /passphrase/i.test(fl.status().blocked ?? ""));
  await fl.setLock("passphrase", { passphrase: new Secret(PHRASE) });
  const savedThen = await fl.add(items.buildItem("secret", { label: "x", value: "unit-test-fallback" }));
  check("…and with one set, it saves — locked by the passphrase alone", savedThen.label === "x" && JSON.parse(fs.readFileSync(path.join(fdir, "vault.json"), "utf8")).device === false && fs.readdirSync(fdir).every((f) => f !== "device.key"));
}

// ══ 7b. Changing the lock: one change at a time, and a new data key ═══════════
section("changing the lock: one change at a time, a new data key");
{
  const PHRASE = "correct horse battery staple";
  /** A device key whose secret this test knows — and that can run something at the moment the vault asks for it. */
  const knownDevice = () => {
    const secret32 = new Uint8Array(crypto.randomBytes(32));
    const dev = {
      bytes: secret32,
      onAsk: null as null | (() => Promise<void>),
      available: () => true,
      secret: async (): Promise<Uint8Array> => {
        const hook = dev.onAsk;
        dev.onAsk = null;
        if (hook) await hook();
        return secret32;
      },
    };
    return dev;
  };
  const vaultFile = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "vault.json"), "utf8"));
  /** The data key a vault file wraps — unwrapped here with node:crypto alone, by the scheme store.ts documents. */
  const dataKeyOf = (f: any, deviceSecret: Uint8Array, passphrase?: string): Buffer => {
    const pass = f.lock === "passphrase" ? crypto.scryptSync(passphrase!.normalize("NFKC"), Buffer.from(f.kdf.scrypt.salt, "base64"), 32, { N: f.kdf.scrypt.N, r: f.kdf.scrypt.r, p: f.kdf.scrypt.p, maxmem: 256 * 1024 * 1024 }) : Buffer.alloc(0);
    const which = `${f.lock}/${f.device ? "device" : "no-device"}`;
    const ikm = Buffer.concat([f.device ? Buffer.from(deviceSecret) : Buffer.alloc(0), pass]);
    const kek = Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.from(f.kdf.salt, "base64"), Buffer.from(`trinity-vault/kek/v1/${which}`), 32));
    const d = crypto.createDecipheriv("aes-256-gcm", kek, Buffer.from(f.key.iv, "base64"));
    d.setAAD(Buffer.from(`trinity-vault|1|data-key|${which.replace("/", "|")}`));
    d.setAuthTag(Buffer.from(f.key.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(f.key.ct, "base64")), d.final()]);
  };
  /** Whether a stored item opens under `key` (bound to id|kind|version). */
  const opensUnder = (key: Uint8Array, item: any): boolean => {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(item.iv, "base64"));
      d.setAAD(Buffer.from(`${item.meta.id}|${item.meta.kind}|${item.v}`));
      d.setAuthTag(Buffer.from(item.tag, "base64"));
      d.update(Buffer.from(item.ct, "base64"));
      d.final();
      return true;
    } catch {
      return false;
    }
  };
  const ZERO = new Uint8Array(32);
  const reads = async (s: any, id: string, value: string): Promise<boolean> => (await s.use(id, "test", async (v: { value: string }) => v.value === value)) === true;
  /** Run `change` and ask for a lock while its write is under way: the new file written, not yet put in place of the old. */
  const lockDuringWrite = async (store: any, dir: string, change: () => Promise<unknown>) => {
    const order: string[] = [];
    let landed: { running: number; tmp: boolean } | null = null;
    let lockDone: Promise<unknown> = Promise.resolve();
    const realRename = fs.promises.rename;
    fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
      if (!landed && String(to) === path.join(dir, "vault.json")) {
        landed = { running: store.running, tmp: fs.existsSync(String(from)) };
        lockDone = store.lock().then(() => order.push("lock"));
        await sleep(30); // every chance for a lock that doesn't wait its turn to land first
      }
      return realRename.call(fs.promises, from, to);
    }) as typeof fs.promises.rename;
    try {
      const failed = await failure(() => change().then(() => order.push("change")));
      await lockDone;
      return { failed, order: order.join(","), landed: landed as { running: number; tmp: boolean } | null };
    } finally {
      fs.promises.rename = realRename;
    }
  };

  // (i) device → passphrase; the lock is asked for while the new lock is being made (scrypt is about to run).
  {
    const dir = path.join(UNIT, "race-to-passphrase");
    const dev = knownDevice();
    const store = new VaultStore({ dir, device: dev });
    const before = await store.add(items.buildItem("secret", { label: "Before", value: "unit-race-before-4f1a" }));
    const order: string[] = [];
    let landed: { running: number; lock: string } | null = null;
    let lockDone: Promise<unknown> = Promise.resolve();
    dev.onAsk = async () => {
      landed = { running: (store as any).running, lock: vaultFile(dir).lock };
      lockDone = store.lock().then(() => order.push("lock")); // as POST /api/vault/lock or the idle timer would
      await sleep(30);
    };
    const failed = await failure(() => store.setLock("passphrase", { passphrase: new Secret(PHRASE) }).then(() => order.push("change")));
    await lockDone;
    const at = landed as { running: number; lock: string } | null;
    check("a lock asked for in the middle of a change to a passphrase waits for the change, then locks", failed === null && at?.running === 1 && at.lock === "device" && order.join(",") === "change,lock" && store.status().state === "locked", `${failed?.code ?? ""} ${order.join(",")}`);
    const f = vaultFile(dir);
    const key = dataKeyOf(f, dev.bytes, PHRASE);
    check("…the file it wrote wraps a real key: every item opens under it, none under an all-zero key", f.lock === "passphrase" && !C.isZeroKey(key) && f.items.length === 1 && f.items.every((it: any) => opensUnder(key, it) && !opensUnder(ZERO, it)));
    const again = new VaultStore({ dir, device: dev });
    await again.unlock(new Secret(PHRASE));
    const after = await again.add(items.buildItem("secret", { label: "After", value: "unit-race-after-6b2e" }));
    check("…and after a restart the passphrase opens it: the item from before reads back, a new one saves and reads", (await reads(again, before.id, "unit-race-before-4f1a")) && (await reads(again, after.id, "unit-race-after-6b2e")));
  }

  // (ii) passphrase → device; the lock is asked for while the new file is being written.
  {
    const dir = path.join(UNIT, "race-to-device");
    const dev = knownDevice();
    const store = new VaultStore({ dir, device: dev });
    await store.setLock("passphrase", { passphrase: new Secret(PHRASE) });
    const before = await store.add(items.buildItem("secret", { label: "Before", value: "unit-race-before-8c2d" }));
    const race = await lockDuringWrite(store, dir, () => store.setLock("device", { current: new Secret(PHRASE) }));
    check("a lock asked for while a change back to the device lock is being written waits for the write, then locks", race.failed === null && race.landed?.running === 1 && race.landed.tmp === true && race.order === "change,lock" && store.status().state === "locked", `${race.failed?.code ?? ""} ${race.order}`);
    const f = vaultFile(dir);
    const key = dataKeyOf(f, dev.bytes);
    check("…the file wraps a real key: every item opens under it, none under an all-zero key", f.lock === "device" && !C.isZeroKey(key) && f.items.every((it: any) => opensUnder(key, it) && !opensUnder(ZERO, it)));
    check("…and a new run opens it by the device key alone, the item intact", await reads(new VaultStore({ dir, device: dev }), before.id, "unit-race-before-8c2d"));
    // The same for any other change that holds a key across a wait: an item being saved.
    const saving = await lockDuringWrite(store, dir, () => store.add(items.buildItem("secret", { label: "Mid", value: "unit-race-mid-1d4f" })));
    const mid = new VaultStore({ dir, device: dev }).list().find((m: { label: string }) => m.label === "Mid");
    check("a lock asked for while an item is being written: the item is saved whole, then the vault locks", saving.failed === null && saving.order === "change,lock" && saving.landed?.running === 1 && mid !== undefined && (await reads(new VaultStore({ dir, device: dev }), mid.id, "unit-race-mid-1d4f")) && vaultFile(dir).items.every((it: any) => !opensUnder(ZERO, it)));
    const onDisk = fs.readFileSync(path.join(dir, "vault.json"), "utf8");
    const zeroWrite = await failure(() => (store as any).write(JSON.parse(onDisk), new Uint8Array(32)));
    check("nothing is ever authenticated or written under a wiped (all-zero) key", zeroWrite?.code === "failed" && fs.readFileSync(path.join(dir, "vault.json"), "utf8") === onDisk);
  }

  // A new data key whenever the lock changes.
  {
    const dir = path.join(UNIT, "rotation");
    const dev = knownDevice();
    let store = new VaultStore({ dir, device: dev });
    const a = await store.add(items.buildItem("secret", { label: "A", value: "unit-rotate-a-3e9b" }));
    const f0 = vaultFile(dir);
    const k0 = dataKeyOf(f0, dev.bytes);
    const oldCopy = JSON.parse(fs.readFileSync(path.join(dir, "vault.json"), "utf8")); // taken while the device key alone locked it
    await store.setLock("passphrase", { passphrase: new Secret(PHRASE) });
    const f1 = vaultFile(dir);
    const k1 = dataKeyOf(f1, dev.bytes, PHRASE);
    const [i0, i1] = [f0.items[0], f1.items[0]];
    check("changing the lock makes a new random data key and seals every item again under it (its version moves on)", !k1.equals(k0) && !C.isZeroKey(k1) && i1.meta.id === a.id && i1.v === i0.v + 1 && i1.ct !== i0.ct && opensUnder(k1, i1) && !opensUnder(k0, i1));
    check("…in one write that replaces the file whole (no temp file left, the MAC is new)", fs.readdirSync(dir).every((n) => !n.endsWith(".tmp")) && f1.mac !== f0.mac && f1.items.length === 1);
    const b = await store.add(items.buildItem("secret", { label: "B", value: "unit-rotate-b-7d2c" }));
    const f2 = vaultFile(dir);
    check("so an old copy of the file and the device key give a key that opens nothing in the vault as it is now", dataKeyOf(oldCopy, dev.bytes).equals(k0) && f2.items.length === 2 && f2.items.every((it: any) => opensUnder(k1, it) && !opensUnder(k0, it)));
    store = new VaultStore({ dir, device: dev });
    await store.unlock(new Secret(PHRASE));
    check("…while the new lock opens everything, saved before the change or after it", (await reads(store, a.id, "unit-rotate-a-3e9b")) && (await reads(store, b.id, "unit-rotate-b-7d2c")));
    const asWas = fs.readFileSync(path.join(dir, "vault.json"), "utf8"); // (the reads above set lastUsedAt)
    const refused = await failure(() => store.setLock("device", { current: new Secret("not the passphrase at all") }));
    check("a change that is refused leaves the file and its key as they were", refused?.code === "wrong-passphrase" && fs.readFileSync(path.join(dir, "vault.json"), "utf8") === asWas && f2.items.every((it: any) => opensUnder(dataKeyOf(JSON.parse(asWas), dev.bytes, PHRASE), it)));
    await store.setLock("device", { current: new Secret(PHRASE) });
    const f3 = vaultFile(dir);
    const k3 = dataKeyOf(f3, dev.bytes);
    check("changing it back makes yet another key: the passphrase-era key opens nothing now", !k3.equals(k1) && !k3.equals(k0) && f3.items.every((it: any) => opensUnder(k3, it) && !opensUnder(k1, it) && !opensUnder(k0, it)) && (await reads(new VaultStore({ dir, device: dev }), b.id, "unit-rotate-b-7d2c")));
  }

  // The scrypt cost: 2^17 for a passphrase set now; a file made with 2^15 still opens; a doctored one is refused.
  {
    const dir = path.join(UNIT, "older-cost");
    const dev = knownDevice();
    let store = new VaultStore({ dir, device: dev });
    const m = await store.add(items.buildItem("secret", { label: "Old", value: "unit-old-cost-5a6b" }));
    const cost = C.SCRYPT.N;
    C.SCRYPT.N = 2 ** 15; // as an earlier Trinity made it
    try {
      await store.setLock("passphrase", { passphrase: new Secret(PHRASE) });
    } finally {
      C.SCRYPT.N = cost;
    }
    const made = vaultFile(dir);
    store = new VaultStore({ dir, device: dev });
    await store.unlock(new Secret(PHRASE));
    check("a file made with the earlier scrypt cost (N=2^15) still opens with its passphrase", made.kdf.scrypt.N === 2 ** 15 && (await reads(store, m.id, "unit-old-cost-5a6b")));
    await store.setLock("passphrase", { passphrase: new Secret("a longer passphrase now"), current: new Secret(PHRASE) });
    check("…and a passphrase set on it now gets the new cost (N=2^17)", vaultFile(dir).kdf.scrypt.N === 2 ** 17 && cost === 2 ** 17);
    const d = path.join(UNIT, "absurd-cost");
    fs.mkdirSync(d, { recursive: true });
    const doctored = vaultFile(dir);
    doctored.kdf.scrypt.N = 2 ** 24;
    fs.writeFileSync(path.join(d, "vault.json"), JSON.stringify(doctored));
    const s2 = new VaultStore({ dir: d, device: dev });
    const t0 = Date.now();
    const tried = await failure(() => s2.unlock(new Secret("a longer passphrase now")));
    check("a file whose scrypt cost was raised past the bounds (2^24) is refused as damaged, before any work is done", typeof s2.status().blocked === "string" && tried?.code === "blocked" && Date.now() - t0 < 1000, `${tried?.code} ${Date.now() - t0} ms`);
  }
}

// ══ 8. Auth off, or not bound to this computer ════════════════════════════════
section("refuses when auth is off or HOST isn't loopback");
{
  const dir = path.join(UNIT, "blocked");
  const store = new VaultStore({ dir, device: standInDevice() });
  const meta = await store.add(items.buildItem("secret", { label: "x", value: "unit-test-blocked-value" }));
  const refusedAll = async () => {
    const st = store.status();
    const tries = await Promise.all([
      failure(() => store.use(meta.id, "x", async (s: { value: string }) => s.value)),
      failure(() => store.add(items.buildItem("secret", { label: "y", value: "z" }))),
      failure(() => store.remove(meta.id)),
      failure(() => store.unlock()),
      failure(() => store.setLock("passphrase", { passphrase: new Secret("long enough phrase") })),
      failure(() => store.setSettings({ spendingLimit: 5 })),
    ]);
    return typeof st.blocked === "string" && st.state === "locked" && tries.every((f) => f?.code === "blocked");
  };
  process.env.TRINITY_AUTH = "off";
  check("TRINITY_AUTH=off: blocked is set, the key is dropped, nothing unlocks", await refusedAll(), store.status().blocked);
  delete process.env.TRINITY_AUTH;
  check("auth back on: it works again", store.status().blocked === undefined && (await store.use(meta.id, "x", async () => true)) === true);
  for (const host of ["0.0.0.0", "192.168.1.20", "::", "example.com"]) {
    process.env.HOST = host;
    if (!(await refusedAll())) check(`HOST=${host} blocks`, false);
  }
  check("HOST set to 0.0.0.0, a LAN address, :: or a name: blocked each time", true);
  const fine: string[] = [];
  for (const host of ["127.0.0.1", "localhost", "::1", "LOCALHOST", ""]) {
    process.env.HOST = host;
    if (store.status().blocked === undefined) fine.push(host);
  }
  process.env.HOST = "127.0.0.1";
  check("HOST 127.0.0.1, localhost, ::1 or unset: not blocked", fine.length === 5, fine.join(" "));

  // The app opened from another computer through the web server (HOST stays loopback): TRINITY_ORIGINS says so.
  const shut: string[] = [];
  for (const origins of ["http://192.168.1.20:5173", "https://trinity.example.com, http://box.lan:5173", "http://0.0.0.0:5173", "http://127.0.0.1.nip.io:5173", "http://localhost.example.com", "box.lan:5173", "file:///C:/trinity/index.html", "foo://localhost:1234"]) {
    process.env.TRINITY_ORIGINS = origins;
    if (!(await refusedAll()) || !/TRINITY_ORIGINS/.test(store.status().blocked ?? "")) shut.push(origins);
  }
  check("TRINITY_ORIGINS naming a page on another computer over plain http — or an entry with no origin of its own — blocks it", shut.length === 0, shut.join(" | "));
  const usable: string[] = [];
  const ORIGINS_OK = ["http://127.0.0.1:8898", "http://localhost:5173, http://[::1]:5173", "http://app.localhost:5173", "http://127.0.0.2:5173", "https://trinity.example.com", "https://192.168.1.20:5173", "not an origin", ""];
  for (const origins of ORIGINS_OK) {
    process.env.TRINITY_ORIGINS = origins;
    const blocked = store.status().blocked;
    if (blocked === undefined && (await failure(() => store.use(meta.id, "x", async () => true))) === null) usable.push(origins);
  }
  delete process.env.TRINITY_ORIGINS;
  check("…while origins on this computer (http://127.0.0.1:8898, localhost, [::1], *.localhost) and https ones keep it usable", usable.length === ORIGINS_OK.length, ORIGINS_OK.filter((o) => !usable.includes(o)).join(" | "));
}

// ══ 9. The device key (Windows DPAPI) ═════════════════════════════════════════
section("the device key (Windows DPAPI, through PowerShell)");
if (dpapi.dpapiAvailable()) {
  const dir = path.join(UNIT, "dpapi");
  const k1 = new dpapi.DpapiDeviceKey(dir);
  const t0 = Date.now();
  const s1: Uint8Array = await k1.secret(true);
  const made = Date.now() - t0;
  const keyFile = path.join(dir, "device.key");
  const stored = JSON.parse(fs.readFileSync(keyFile, "utf8")) as { format: string; version: number; protection: string; blob: string };
  const blob = Buffer.from(stored.blob, "base64");
  check("a 32-byte device secret is made and protected", s1.length === 32 && stored.format === "trinity-device-key" && stored.protection === "dpapi-user" && blob.length > 64, `${made} ms, blob ${blob.length} bytes`);
  check("the file holds the protected blob, not the secret", !blob.includes(Buffer.from(s1)) && !fs.readFileSync(keyFile).includes(Buffer.from(s1)) && !fs.readFileSync(keyFile, "utf8").includes(Buffer.from(s1).toString("base64")));
  const t1 = Date.now();
  const same = await k1.secret(false);
  check("cached for the run: asked again, no second PowerShell start", same === s1 && k1.starts === 1 && Date.now() - t1 < 250);
  const k2 = new dpapi.DpapiDeviceKey(dir);
  const [a, b] = await Promise.all([k2.secret(false), k2.secret(false)]);
  check("a new run unprotects the same secret, with one PowerShell start for two callers", Buffer.from(a).equals(Buffer.from(s1)) && a === b && k2.starts === 1);
  const bad = path.join(UNIT, "dpapi-bad");
  fs.mkdirSync(bad, { recursive: true });
  const broken = Buffer.from(blob);
  broken[broken.length - 6] = broken[broken.length - 6]! ^ 0xff;
  fs.writeFileSync(path.join(bad, "device.key"), JSON.stringify({ ...stored, blob: broken.toString("base64") }));
  const f = await failure(() => new dpapi.DpapiDeviceKey(bad).secret(true));
  check("a tampered blob fails closed — and is not replaced by a new key", f?.code === "no-key-store" && !f.message.includes(stored.blob.slice(0, 12)) && JSON.parse(fs.readFileSync(path.join(bad, "device.key"), "utf8")).blob === broken.toString("base64"), f?.code);
  fs.writeFileSync(path.join(bad, "device.key"), "{ not json");
  const g = await failure(() => new dpapi.DpapiDeviceKey(bad).secret(true));
  check("an unreadable key file fails closed too, untouched", g?.code === "damaged" && fs.readFileSync(path.join(bad, "device.key"), "utf8") === "{ not json");
  check("without `create`, a missing key is an error, not a new key", (await failure(() => new dpapi.DpapiDeviceKey(path.join(UNIT, "dpapi-none")).secret(false)))?.code === "no-key-store" && !fs.existsSync(path.join(UNIT, "dpapi-none", "device.key")));

  const vdir = path.join(UNIT, "dpapi-vault");
  const first = new VaultStore({ dir: vdir, device: new dpapi.DpapiDeviceKey(vdir) });
  const meta = await first.add(items.buildItem("login", { hosts: "example.com", username: "u", password: "unit-test-dpapi-pass" }));
  const secondKey = new dpapi.DpapiDeviceKey(vdir);
  const second = new VaultStore({ dir: vdir, device: secondKey });
  check("a vault locked by the real device key: saved in one run, opened by itself in the next", (await second.use(meta.id, "x", async (s: { password: string }) => s.password === "unit-test-dpapi-pass")) === true && secondKey.starts === 1);
  check("its folder holds vault.json, device.key and the log — no plain key", JSON.stringify(fs.readdirSync(vdir).sort()) === JSON.stringify(["access.log", "device.key", "vault.json"]), fs.readdirSync(vdir).join(" "));
} else {
  console.log("skip  DPAPI wrap and unwrap: this is not Windows (or Windows PowerShell is missing). The passphrase-only path is covered above.");
}

// ══ 10. The board's card runtime, the frame document, the title comment ════════
section("board and frame fixes");
{
  const board = await imp("workspace/board.ts");
  const scripts = [...String(board.BOARD_TEMPLATE.source).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  let syntax = "";
  for (const code of scripts) {
    try {
      new vm.Script(code);
    } catch (err) {
      syntax = (err as Error).message;
    }
  }
  check("the board template's scripts parse", scripts.length >= 2 && !syntax, syntax);
  const templateNo = Number(/^board@(\d+)$/.exec(board.BOARD_TEMPLATE.id)?.[1] ?? 0);
  check("the template id moved on from board@7", templateNo >= 8, board.BOARD_TEMPLATE.id);
  check("the allow-same-origin branch is gone", !/allow-same-origin/.test(board.BOARD_TEMPLATE.source) && !/BROWSE_SANDBOX/.test(board.BOARD_TEMPLATE.source));

  // The card runtime against stand-in elements: what read and set can reach.
  const win: Record<string, any> = { getComputedStyle: (el: any) => el.css };
  const runtime = scripts.find((code) => code.includes("window.__trinityCard =")) ?? "";
  vm.runInNewContext(runtime, { window: win, setTimeout, Promise, Event: class {}, KeyboardEvent: class {} });
  const RT = win.__trinityCard;
  const el = (attrs: Record<string, string>, value: string, extra: Record<string, unknown> = {}) => ({
    tagName: "INPUT",
    id: attrs.id ?? "",
    value,
    disabled: false,
    labels: [] as { innerText: string }[],
    isContentEditable: false,
    css: { visibility: "visible", display: "block", webkitTextSecurity: "none" },
    getAttribute: (k: string) => attrs[k] ?? null,
    getBoundingClientRect: () => ({ width: 80, height: 20 }),
    dispatchEvent: () => true,
    ...extra,
  });
  const SECRETS = {
    password: el({ type: "password", name: "pw" }, "S3CRET-password-value"),
    otp: el({ type: "text", autocomplete: "one-time-code" }, "S3CRET-otp-481516"),
    otpName: el({ type: "text", name: "otp" }, "S3CRET-otp-by-name"),
    card: el({ type: "text", autocomplete: "cc-number" }, "S3CRET-4242424242424242"),
    cardLabel: el({ type: "text" }, "S3CRET-card-by-label", { labels: [{ innerText: "Card number" }] }),
    cvv: el({ type: "tel", id: "cvv" }, "S3CRET-737"),
    cvc: el({ type: "text", placeholder: "CVC" }, "S3CRET-cvc"),
    token: el({ type: "text", "aria-label": "API token" }, "S3CRET-token"),
    ssn: el({ type: "text", name: "ssn" }, "S3CRET-ssn"),
    passphrase: el({ type: "text", placeholder: "Passphrase" }, "S3CRET-passphrase"),
    masked: el({ type: "text", name: "note" }, "S3CRET-masked", { css: { visibility: "visible", display: "block", webkitTextSecurity: "disc" } }),
  };
  const plain = el({ type: "text", name: "city" }, "Lisbon");
  const editable = { ...el({ "aria-label": "secret answer" }, ""), tagName: "DIV", isContentEditable: true, innerText: "S3CRET-editable-text" };
  const all = [plain, ...Object.values(SECRETS)];
  const root = {
    innerText: "Visible words on the card. S3CRET-editable-text",
    ownerDocument: {},
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel.startsWith("input") ? [...all, editable] : sel.startsWith("[contenteditable") ? [editable] : []),
  };
  const read = String(RT.readText(root));
  check("reading a card gives its text and its ordinary fields", read.includes("Visible words") && read.includes("city: Lisbon"), read.replace(/\s+/g, " ").slice(0, 80));
  const leaked = Object.entries(SECRETS).filter(([, e]) => read.includes(e.value)).map(([k]) => k);
  check("…and never a password, one-time-code, card, CVV/CVC, token, SSN, passphrase or masked field", leaked.length === 0 && !read.includes("S3CRET"), leaked.join(" "));
  const onlySecret = { ...root, querySelectorAll: (sel: string) => (sel.startsWith("input") ? Object.values(SECRETS) : []) };
  const set = await RT.run(onlySecret, "set", { value: "typed-by-trinity", field: "password" });
  check("setting a value never lands in such a field", set.ok === false && set.reason === "no-field" && Object.values(SECRETS).every((e) => e.value.startsWith("S3CRET")));
  const setPlain = await RT.run(root, "set", { value: "Porto", field: "city" });
  check("…while an ordinary field is still set", setPlain.ok === true && plain.value === "Porto");

  const html = String(board.cardEditableHtml({ n: 1, kind: "text", status: "ready", x: 0, y: 0, w: 30, z: 1, title: "Notes --><script>alert(1)</script><!--", text: "hello", url: null }));
  const end = html.indexOf("-->");
  check("a card title can't end the title comment", !/<script/i.test(html) && end > html.indexOf("alert(1)") && html.slice(end + 3).trim().startsWith("<p "), html.slice(0, 70));
  check("a form placeholder has no HTML to edit", board.cardEditableHtml({ n: 2, kind: "form", status: "ready", x: 0, y: 0, w: 30, z: 1, title: "Secure form: x", text: "", url: null, html: "<b>x</b>" }) === null);

  const frame = await import(new URL("../web/src/workspace/frame.ts", import.meta.url).href);
  const firstScript = (doc: string) => doc.indexOf("<script");
  const csp = (doc: string) => doc.indexOf("Content-Security-Policy");
  const attack = "<!doctype html><html><script>window.PWNED=1</script><textarea><head></textarea><body>hi</body></html>";
  const docs: [string, string][] = [
    ["a fragment", frame.buildFrameDoc("html", "<p>PAYLOAD-MARK</p><script>1</script>")],
    ["a whole document", frame.buildFrameDoc("html", "<!doctype html><html><head><title>t</title><script>PAYLOAD-MARK</script></head><body>x</body></html>")],
    ["a document that hides <head> in a textarea", frame.buildFrameDoc("html", attack)],
    ["an app template that is a whole document", frame.buildFrameDoc("app", { source: "<html><head><script>window.render=function(){}</script></head><body></body></html>", state: {} })],
  ];
  for (const [name, doc] of docs) {
    const mark = Math.max(doc.indexOf("PAYLOAD-MARK"), doc.indexOf("window.PWNED"), doc.indexOf("window.render=function"));
    const ok = doc.startsWith('<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy"') && csp(doc) < firstScript(doc) && csp(doc) < mark && doc.indexOf("</head>") < mark && csp(doc) === doc.lastIndexOf("Content-Security-Policy");
    check(`frame document, ${name}: Trinity's head and policy come first, once, before any of the payload`, ok);
  }
}

// ══ 10b. The secure sheet ═════════════════════════════════════════════════════
section("the secure sheet (the window's own page, against a stand-in DOM)");
{
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--sheet"], { encoding: "utf8", timeout: 120_000 });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  for (const line of out.split(/\r?\n/)) {
    const m = /^(ok  |FAIL) (.*)$/.exec(line);
    if (m) check(m[2]!, m[1] === "ok  ");
    else if (line.trim() && !/^SHEET DONE/.test(line)) console.log(`      ${line}`);
  }
  check("the sheet checks ran to the end", /^SHEET DONE/m.test(out) && run.status === 0, `exit ${run.status}`);
}

// ══ The engine, started in this process on a free port ════════════════════════
section("the engine (in this process)");
await import(new URL("../server/src/index.ts", import.meta.url).href);
{
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      up = false;
    }
    if (!up) await sleep(250);
  }
  check(`engine up on 127.0.0.1:${PORT}`, up);
  if (!up) {
    console.log("\nThe engine didn't start: nothing after this can run.");
    process.exit(1);
  }
}
const facade = await imp("vault/index.ts");
const forms = await imp("vault/forms.ts");
const { vault } = await imp("vault/instance.ts");
const { workspace } = await imp("workspace/bus.ts");
const board = await imp("workspace/board.ts");
const { getTool, getTools } = await imp("tools/registry.ts");
const { act, recentResults } = await imp("agent/act.ts");
const { getActivePersona } = await imp("db/sqlite.ts");
const { pendingQuestion } = await imp("agent/pending.ts");

// Everything observable, collected from here on.
const busEvents: unknown[] = [];
workspace.subscribe((e: unknown) => busEvents.push(e));
const toolEvents: unknown[] = [];
const toolOutcomes: unknown[] = [];
const responses: { what: string; status: number; body: string; headers: string }[] = [];
const errorsSeen: string[] = [];
function listen(pathname: string): Promise<{ events: any[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}`, { headers: { authorization: `Bearer ${KEY}` } });
    sock.on("message", (d: unknown) => {
      try {
        events.push(JSON.parse(String(d)));
      } catch {
        events.push(String(d));
      }
    });
    sock.on("open", () => resolve({ events, close: () => sock.close() }));
    sock.on("error", reject);
  });
}
const appSocket = await listen("/ws");
const windowSocket = await listen("/ws/workspace");

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; body: string }> {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const raw = await res.text();
  responses.push({ what: `${method} ${p.replace(/forms\/.+/, "forms/<id>").replace(/items\/.+/, "items/<id>")}`, status: res.status, body: raw, headers: JSON.stringify([...res.headers]) });
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: res.status, json, body: raw };
}
const persona = getActivePersona();
/** Run a tool the way the engine does (agent/act.ts): its events and its outcome are kept. */
async function say(toolName: string, utterance: string): Promise<{ ok: boolean; say: string; speak?: string }> {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`no tool ${toolName}`);
  const outcome = await act({ action: toolName, confidence: 1, tool, options: {}, offered: [], ms: 0 }, utterance, {
    persona,
    memory: {} as never,
    emit: (e: unknown) => toolEvents.push(e),
    recentTranscript: [],
    situation: "",
    minConfidence: 0.7,
  });
  toolOutcomes.push(outcome);
  return outcome;
}
const formCards = () => board.listCards().filter((c: { kind: string }) => c.kind === "form");
const openOf = (purpose: string) => facade.openForms().find((f: { purpose: string }) => f.purpose === purpose);
check("the five vault tools are registered, all sensitive, none with arguments", ["vault_save_login", "vault_save_card", "vault_save_details", "vault_list", "vault_forget"].every((n) => getTool(n)?.sensitive === true && Object.keys(getTool(n).input).length === 0));
check("the engine starts with an empty vault of its own", facade.vaultStatus().state === "empty" && facade.vaultStatus().blocked === undefined && path.resolve(vaultDir()) === path.join(DATA, "vault"));
{
  const { hostFitsLabel } = await imp("tools/vault.ts");
  const fits: [string, string, boolean][] = [
    ["www.netflix.com", "Netflix", true],
    ["www.amazon.co.uk", "Amazon Prime", true],
    ["github.com", "git hub", true],
    ["netflix.com.evil.io", "Netflix", false],
    ["evilnetflix.com", "Netflix", false],
    ["netflix.co.io", "Netflix", false],
    ["my-netflix-login.example", "Netflix", false],
    ["192.168.1.20", "Netflix", false],
  ];
  const wrongFit = fits.filter(([host, label, want]) => hostFitsLabel(host, label) !== want).map(([host, label]) => `${host}/${label}`);
  check("the open tab is taken for a spoken site only when the site's registered name is that name (not netflix.com.evil.io for Netflix)", wrongFit.length === 0, wrongFit.join(" "));
}

// ══ 11. Secure forms ══════════════════════════════════════════════════════════
section("secure forms");
{
  const before = busEvents.length;
  const a = facade.openForm({ purpose: "save-login", title: "Example login", detail: "A test.", host: "WWW.Example.com", fields: [{ name: "label", label: "Name", type: "text", value: "Example" }, { name: "password", label: "Password", type: "password", value: "should-be-dropped" }], submitLabel: "Save" });
  const id: string = a.form.id;
  check("a ticket: 32 random bytes (base64url), ten minutes to live", /^[A-Za-z0-9_-]{43}$/.test(id) && Math.abs(a.form.expiresAt - Date.now() - 600_000) < 3000);
  check("the form shows the vault's own fields; only a plain field may arrive filled in", JSON.stringify(a.form.fields.map((f: { name: string }) => f.name)) === JSON.stringify(["label", "username", "password", "totpSecret"]) && a.form.fields[0].value === "Example" && a.form.fields.every((f: { name: string; value?: string }) => f.name === "label" || f.value === undefined) && a.form.host === "www.example.com");
  const card = formCards()[0];
  check("a placeholder card on the board: kind form, the title, 'Waiting for you in the secure form.'", formCards().length === 1 && card.title === "Secure form: Example login" && card.text === "Waiting for you in the secure form." && a.form.card === card.n);
  const opened = busEvents.slice(before).find((e: any) => e.type === "form") as any;
  check("every window is told: {type: 'form', form} — a descriptor with no value in it", opened?.form?.id === id && !JSON.stringify(opened).includes("should-be-dropped") && !("values" in opened.form));
  check("the window's own socket got it too", await until(() => windowSocket.events.some((e) => e.type === "form" && e.form.id === id)));
  const late = await listen("/ws/workspace");
  check("a window that connects later gets the snapshot, then the open form", (await until(() => late.events.length >= 2)) && late.events[0].type === "snapshot" && late.events[1].type === "form" && late.events[1].form.id === id);
  late.close();
  check("the form is in no snapshot (only its placeholder card is)", !JSON.stringify(workspace.snapshot()).includes(id) && !JSON.stringify(late.events[0]).includes(id) && facade.openForms().some((f: { id: string }) => f.id === id));

  const typed = "typed-password-form-1a2b";
  const wrongField = await failure(() => forms.submitForm(id, { password: typed, sneaky: "x" }));
  const missing = await failure(() => forms.submitForm(id, { username: "u@example.com" }));
  const notText = await failure(() => forms.submitForm(id, { password: { $gt: "" } }));
  check("a submission with a field the form doesn't have, without a required one, or with a non-string: refused, form still open", wrongField?.code === "invalid" && missing?.code === "invalid" && notText?.code === "invalid" && facade.openForms().length === 1 && !wrongField.message.includes(typed));
  check("the card can't be edited or copied from the engine side", board.updateCard(card.n, { html: "<b>x</b>", title: "Changed" }) === null && board.duplicateCard(card.n) === null && board.renameCard(card.n, "x") === null && board.getCard(card.n).title === "Secure form: Example login");

  const status = await forms.submitForm(id, { label: "Example", username: "u@example.com", password: typed });
  const outcome = await a.done;
  const saved = facade.getMeta(outcome.itemId);
  check("submitted: the item is saved for the form's host, and `done` gives its id", status === "submitted" && outcome.status === "submitted" && saved?.label === "Example" && JSON.stringify(saved?.hosts) === JSON.stringify(["www.example.com"]) && saved?.usernameHint === "u…@example.com");
  check("the placeholder card is gone, with no undo entry", formCards().length === 0 && workspace.canUndo() === false);
  check("{type: 'form_closed', id, status} goes out", busEvents.some((e: any) => e.type === "form_closed" && e.id === id && e.status === "submitted"));
  check("a ticket works once", (await failure(() => forms.submitForm(id, { password: "again" })))?.code === "gone" && facade.openForms().length === 0);
  check("what was typed is in no event, snapshot or tool result", !JSON.stringify(busEvents).includes(typed) && !JSON.stringify(windowSocket.events).includes(typed) && !JSON.stringify(workspace.snapshot()).includes(typed));

  const b = facade.openForm({ purpose: "save-card", title: "Payment card", detail: "", fields: [], submitLabel: "" });
  check("cancel: `done` says cancelled, the card and the form are gone", forms.cancelForm(b.form.id) === true && (await b.done).status === "cancelled" && formCards().length === 0 && busEvents.some((e: any) => e.type === "form_closed" && e.id === b.form.id && e.status === "cancelled") && forms.cancelForm(b.form.id) === false);
  check("a card form has the box 'Keep the security code', unticked", b.form.fields.some((f: { name: string; type: string; label: string; value?: string }) => f.name === "keepCvc" && f.type === "checkbox" && f.label === "Keep the security code" && f.value === undefined));

  const c = facade.openForm({ purpose: "save-identity", title: "Details", detail: "", fields: [], submitLabel: "" }, { ttlMs: 150 });
  const lapsed = await c.done;
  check("expiry: `done` says expired, the card and the form are gone, late typing is refused", lapsed.status === "expired" && formCards().length === 0 && (await failure(() => forms.submitForm(c.form.id, { fullName: "x" })))?.code === "gone");

  const once = facade.openForm({ purpose: "one-time", title: "Security code", detail: "For this payment only.", fields: [{ name: "cvc", label: "Security code", type: "cvc", required: true }], submitLabel: "Use once" });
  await forms.submitForm(once.form.id, { cvc: "9137" });
  check("one-time: submitted, and nothing is saved in the vault", (await once.done).status === "submitted" && (await once.done).itemId === undefined && facade.listItems().length === 1 && forms.heldOneTimeCount() === 1);
  const got = await facade.useOneTime(once.form.id, async (v: { cvc: string }) => ({ digits: v.cvc.length, printed: `${v}|${JSON.stringify(v)}` }));
  check("useOneTime hands the value to fn once, as an object that prints as [secret]", got.digits === 4 && !got.printed.includes("9137") && got.printed.includes(MASK));
  check("…and then it is wiped: there is no second use", (await failure(() => facade.useOneTime(once.form.id, async () => 1)))?.code === "gone" && forms.heldOneTimeCount() === 0);
  forms.formTiming.oneTimeMs = 120;
  const once2 = facade.openForm({ purpose: "one-time", title: "Security code", detail: "", fields: [{ name: "code", label: "Code", type: "password", required: true }], submitLabel: "" });
  await forms.submitForm(once2.form.id, { code: "one-time-value-88aa" });
  await sleep(260);
  check("a one-time value not used in time (two minutes; 120 ms here) is wiped", forms.heldOneTimeCount() === 0 && (await failure(() => facade.useOneTime(once2.form.id, async () => 1)))?.code === "gone");
  forms.formTiming.oneTimeMs = 2 * 60_000;
  const once3 = facade.openForm({ purpose: "one-time", title: "Code", detail: "", fields: [{ name: "code", label: "Code", type: "password", required: true }], submitLabel: "" });
  await forms.submitForm(once3.form.id, { code: "one-time-value-99bb" });
  check("a one-time value in fn's result is stopped", (await failure(() => facade.useOneTime(once3.form.id, async (v: { code: string }) => `used ${v.code}`)))?.code === "leak");

  const q = facade.openForm({ purpose: "confirm", title: "Use this login on another site?", detail: "Example on shop.example.", fields: [{ name: "x", label: "X", type: "text" }], submitLabel: "Approve" });
  check("confirm: no fields, whatever was asked for", q.form.fields.length === 0);
  check("confirm: approving it settles `done` as approved", (await forms.submitForm(q.form.id, undefined)) === "approved" && (await q.done).status === "approved");
  check("an unknown ticket: gone", (await failure(() => forms.submitForm(crypto.randomBytes(32).toString("base64url"), {})))?.code === "gone");

  // The card tools and a form's placeholder.
  const f1 = facade.openForm({ purpose: "save-login", title: "Tool test", detail: "", fields: [], submitLabel: "" });
  const n = f1.form.card as number;
  const readIt = await say("read_card", `read card ${n}`);
  const pressIt = await say("control_card", `press save on card ${n}`);
  const renameIt = await say("rename_card", `rename card ${n} to Groceries`);
  const copyIt = await say("duplicate_card", `duplicate card ${n}`);
  check("read_card, control_card, rename_card and duplicate_card refuse a secure form's card", [readIt, pressIt, renameIt, copyIt].every((o) => o.ok === false && /secure form/i.test(o.say)) && formCards().length === 1 && formCards()[0].title === "Secure form: Tool test", [readIt, pressIt, renameIt, copyIt].map((o) => o.ok).join(","));
  const removeIt = await say("remove_card", `remove card ${n}`);
  check("remove_card on it cancels the form (and adds no undo entry)", removeIt.ok === true && (await f1.done).status === "cancelled" && formCards().length === 0 && workspace.canUndo() === false, removeIt.say);
  const f2 = facade.openForm({ purpose: "save-login", title: "Clear test", detail: "", fields: [], submitLabel: "" });
  const cleared = await say("clear_workspace", "clear the workspace");
  check("clear_workspace cancels it too", cleared.ok === true && (await f2.done).status === "cancelled" && facade.openForms().length === 0, cleared.say);
  if (workspace.canUndo()) await say("undo_workspace", "undo");
  check("an undo never brings a form's card back", formCards().length === 0);
  board.addFormCard("Secure form: left over from the last run");
  forms.reconcileFormCards();
  check("a form card left on a saved board is swept away when the engine starts", formCards().length === 0);
  // A board saved by the previous template: its cards carry over to this one.
  workspace.showApp({ id: "board@7", kind: "default", name: "Card board", source: "<div id='board'></div>" }, { cards: [{ n: 4, kind: "text", status: "ready", x: 4, y: 6, w: 28, z: 1, title: "Note: milk", text: "milk", url: null }] }, "Workspace", "board");
  const carried = board.listCards();
  check("a board saved under board@7 is upgraded in place, cards kept", workspace.snapshot().template?.id === board.BOARD_TEMPLATE.id && board.BOARD_TEMPLATE.id !== "board@7" && carried.length === 1 && carried[0].n === 4 && carried[0].text === "milk");
  board.removeCards([4]);
  const policyOff = (() => {
    process.env.TRINITY_AUTH = "off";
    try {
      facade.openForm({ purpose: "confirm", title: "x", detail: "", fields: [], submitLabel: "" });
      return "opened";
    } catch (err) {
      return (err as { code?: string }).code ?? "threw";
    } finally {
      delete process.env.TRINITY_AUTH;
    }
  })();
  check("no form opens while the vault may not be used", policyOff === "blocked" && facade.openForms().length === 0);
  await sleep(700);
  const disk = fs.readFileSync(path.join(DATA, "workspace.json"), "utf8");
  check("no ticket and nothing typed ever reached workspace.json", ![id, b.form.id, c.form.id, once.form.id, q.form.id, f1.form.id, f2.form.id].some((t) => disk.includes(t)) && !disk.includes(typed) && !disk.includes("9137"));
}

// ══ 12. The routes ════════════════════════════════════════════════════════════
section("the HTTP routes");
{
  const open = async (method: string, p: string) => (await fetch(`${BASE}/api${p}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" })).status;
  const closed = await Promise.all([open("GET", "/vault"), open("POST", "/vault/items"), open("DELETE", "/vault/items/abcdefgh"), open("POST", "/vault/forms/abcdefghijklmnopqrstuvwxyz"), open("DELETE", "/vault/forms/abcdefghijklmnopqrstuvwxyz"), open("POST", "/vault/lock"), open("POST", "/vault/unlock"), open("PUT", "/vault/settings")]);
  check("every vault route answers 401 without a linked browser or the API key", closed.every((s) => s === 401), closed.join(","));
  const wrongKey = await fetch(`${BASE}/api/vault`, { headers: { authorization: "Bearer not-the-key" } });
  check("…and with the wrong key", wrongKey.status === 401);

  const first = await api("GET", "/vault");
  check("GET /api/vault: status, items (metadata), settings, and the fields each kind is typed into", first.status === 200 && first.json.status.items === 1 && first.json.items[0].label === "Example" && first.json.settings.spendingLimit === 200 && typeof first.json.keyStore === "boolean" && Array.isArray(first.json.fields.login) && first.json.fields.card.some((f: { name: string }) => f.name === "keepCvc"));
  check("…and no ciphertext, key or secret field among them", !/"(?:ct|iv|tag|key|mac|kdf|password|username|number|cvc|totpSecret|value)"\s*:/.test(JSON.stringify([first.json.status, first.json.items, first.json.settings])) && Object.keys(first.json).sort().join() === "fields,items,keyStore,retryAfterMs,settings,status");

  const ROUTE_PASS = "route-password-55ef";
  const added = await api("POST", "/vault/items", { kind: "login", values: { label: "GitHub", hosts: "github.com", username: "octo@example.com", password: ROUTE_PASS } });
  check("POST /api/vault/items: saved; the answer is the metadata and never the secret", added.status === 200 && added.json.ok === true && added.json.item.label === "GitHub" && added.json.item.usernameHint === "o…@example.com" && !added.body.includes(ROUTE_PASS) && !added.body.includes("octo@"));
  const badCard = await api("POST", "/vault/items", { kind: "card", values: { number: "4000123412341239", expiry: "08/30" } });
  check("a card number with a wrong digit: 422, the field named, the number not echoed", badCard.status === 422 && badCard.json.code === "invalid" && badCard.json.field === "number" && !badCard.body.includes("4000123412341239") && !badCard.body.includes("1239"), badCard.body.slice(0, 90));
  const notJson = await api("POST", "/vault/items", '{"kind":"login","values":{"password":"broken-json-secret-77"', {});
  check("a body that isn't JSON: 400, nothing of it echoed", notJson.status === 400 && notJson.json?.code === "bad-request" && !notJson.body.includes("broken-json-secret-77") && !notJson.body.includes("password"), notJson.body.slice(0, 90));
  const big = await api("POST", "/vault/items", { kind: "secret", values: { label: "big", value: `too-big-secret-66${"x".repeat(20_000)}` } });
  check("a body over 16 kB: 413, nothing of it echoed", big.status === 413 && !big.body.includes("too-big-secret-66"), `${big.status}`);
  const formPost = await fetch(`${BASE}/api/vault/items`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "text/plain" }, body: JSON.stringify({ kind: "secret", values: { label: "x", value: "wrong-type-secret-44" } }) });
  const formPostBody = await formPost.text();
  responses.push({ what: "POST /vault/items as text/plain", status: formPost.status, body: formPostBody, headers: "" });
  check("anything but application/json: 400, and nothing is saved", formPost.status === 400 && !formPostBody.includes("wrong-type-secret-44") && facade.listItems().length === 2);
  const extraKey = await api("POST", "/vault/items", { kind: "secret", values: { label: "x", value: "y" }, also: "this" });
  const badKind = await api("POST", "/vault/items", { kind: "weapon", values: {} });
  const badField = await api("POST", "/vault/items", { kind: "secret", values: { label: "x", value: "unknown-field-secret-33", extra: "z" } });
  check("an unknown key, kind or field: refused without an echo", extraKey.status === 400 && badKind.status === 400 && badField.status === 422 && !badField.body.includes("unknown-field-secret-33") && facade.listItems().length === 2);

  const f = facade.openForm({ purpose: "save-secret", title: "Wi-Fi", detail: "", fields: [], submitLabel: "" });
  const viaHttp = await api("POST", `/vault/forms/${f.form.id}`, { values: { label: "Wi-Fi", value: "route-form-secret-22" } });
  check("POST /api/vault/forms/<id>: {ok, status: submitted} and the form is over", viaHttp.status === 200 && viaHttp.json.status === "submitted" && !viaHttp.body.includes("route-form-secret-22") && (await f.done).status === "submitted" && facade.listItems().length === 3);
  const twice = await api("POST", `/vault/forms/${f.form.id}`, { values: { label: "Wi-Fi", value: "route-form-secret-22" } });
  check("…a second time: 404 gone, no echo", twice.status === 404 && twice.json.code === "gone" && !twice.body.includes("route-form-secret-22"));
  const g = facade.openForm({ purpose: "confirm", title: "Fill your card on shop.example?", detail: "", fields: [], submitLabel: "Approve" });
  const noType = await fetch(`${BASE}/api/vault/forms/${g.form.id}`, { method: "POST", headers: { authorization: `Bearer ${KEY}` } });
  check("a confirmation can't be approved by a request that isn't JSON", noType.status === 400 && facade.openForms().length === 1);
  const gone = await api("DELETE", `/vault/forms/${g.form.id}`);
  const goneAgain = await api("DELETE", `/vault/forms/${g.form.id}`);
  check("DELETE /api/vault/forms/<id>: cancels; then 404", gone.status === 200 && (await g.done).status === "cancelled" && goneAgain.status === 404);

  const limit = await api("PUT", "/vault/settings", { spendingLimit: 120 });
  check("PUT /api/vault/settings: the spending limit", limit.status === 200 && limit.json.settings.spendingLimit === 120 && vault().settings().spendingLimit === 120);
  const badLimit = await api("PUT", "/vault/settings", { spendingLimit: "lots" });
  check("…a limit that isn't a number: 400", badLimit.status === 400 && vault().settings().spendingLimit === 120);
  const PHRASE = "route passphrase 31ab horse";
  const toPhrase = await api("PUT", "/vault/settings", { lock: "passphrase", passphrase: PHRASE });
  check("PUT /api/vault/settings: lock with a passphrase; it is not echoed", toPhrase.status === 200 && toPhrase.json.status.lock === "passphrase" && !toPhrase.body.includes(PHRASE));
  const locked = await api("POST", "/vault/lock");
  check("POST /api/vault/lock: locked", locked.status === 200 && locked.json.status.state === "locked");
  const whileLocked = await api("POST", "/vault/items", { kind: "secret", values: { label: "x", value: "locked-secret-11" } });
  const delLocked = await api("DELETE", `/vault/items/${added.json.item.id}`);
  check("locked: adding and deleting answer 423, the list still loads", whileLocked.status === 423 && whileLocked.json.code === "locked" && delLocked.status === 423 && (await api("GET", "/vault")).json.items.length === 3);
  const wrong = await api("POST", "/vault/unlock", { passphrase: "route wrong guess 99zz" });
  check("POST /api/vault/unlock with the wrong passphrase: 403, not echoed", wrong.status === 403 && wrong.json.code === "wrong-passphrase" && !wrong.body.includes("route wrong guess 99zz"));
  const right = await api("POST", "/vault/unlock", { passphrase: PHRASE });
  check("…with the right one: unlocked", right.status === 200 && right.json.status.state === "unlocked" && !right.body.includes(PHRASE));
  const noCurrent = await api("PUT", "/vault/settings", { lock: "device" });
  const wrongCurrent = await api("PUT", "/vault/settings", { lock: "device", currentPassphrase: "route wrong guess 98yy" });
  check("leaving the passphrase lock needs the current passphrase", noCurrent.status === 422 && wrongCurrent.status === 403 && !wrongCurrent.body.includes("98yy") && facade.vaultStatus().lock === "passphrase");
  const backToDevice = await api("PUT", "/vault/settings", vault().deviceAvailable() ? { lock: "device", currentPassphrase: PHRASE } : { spendingLimit: 200 });
  check("…and with it, the lock changes back", backToDevice.status === 200 && (!vault().deviceAvailable() || backToDevice.json.status.lock === "device"));
  await api("PUT", "/vault/settings", { spendingLimit: 200 });
  const removed = await api("DELETE", `/vault/items/${added.json.item.id}`);
  const removedAgain = await api("DELETE", `/vault/items/${added.json.item.id}`);
  check("DELETE /api/vault/items/<id>: removed; then 404", removed.status === 200 && removedAgain.status === 404 && facade.listItems().length === 2);
  check("vault answers are never cached", (await fetch(`${BASE}/api/vault`, { headers: { authorization: `Bearer ${KEY}` } })).headers.get("cache-control") === "no-store");

  // Anything else addressed to the vault: a fixed 404, the body never read, so never quoted.
  const ODD = "catch-all-secret-6a7b";
  const NO_SUCH = JSON.stringify({ error: "The vault has no such address.", code: "not-found" });
  const odd = [
    await api("PATCH", "/vault/items", { kind: "secret", values: { label: "x", value: ODD } }),
    await api("POST", "/vault/nope", `{"values":{"value":"${ODD}"`),
    await api("PUT", "/vault/items/abcdefgh", `{"values":{"value":"${ODD}"}}`),
    await api("GET", "/vault/items"),
    await api("POST", "/vault/forms", { values: { value: ODD } }),
    await api("POST", "/vaultx", `"${ODD}${"x".repeat(20_000)}`),
  ];
  check("anything else under /api/vault: one fixed 404 — broken or oversized JSON makes no difference, its body is never read or echoed", odd.every((r) => r.status === 404 && r.body === NO_SUCH) && facade.listItems().length === 2, odd.map((r) => r.status).join(","));
  check("…and the rest of the API is unaffected", (await api("GET", "/workspace")).status === 200);

  // Auth off / not loopback / a plain-http page on the network, through the running engine: blocked, and listing nothing.
  const hidden = (r: { json: any }) => typeof r.json?.status?.blocked === "string" && r.json.status.items === 0 && Array.isArray(r.json.items) && r.json.items.length === 0;
  process.env.TRINITY_AUTH = "off";
  const offGet = await api("GET", "/vault");
  const offAdd = await api("POST", "/vault/items", { kind: "secret", values: { label: "x", value: "auth-off-secret-00" } });
  const offUse = await failure(() => facade.useSecret(facade.listItems()[0].id, "x", async () => 1));
  delete process.env.TRINITY_AUTH;
  check("with TRINITY_AUTH=off the engine's vault is blocked: status says so, nothing is saved or used", typeof offGet.json.status.blocked === "string" && offGet.json.status.state === "locked" && offAdd.status === 403 && offAdd.json.code === "blocked" && offUse?.code === "blocked");
  check("…and GET /api/vault lists no item and no count while it is", hidden(offGet), JSON.stringify(offGet.json?.items ?? null).slice(0, 60));
  process.env.HOST = "0.0.0.0";
  const lanGet = await api("GET", "/vault");
  const lanUse = await failure(() => facade.useSecret(facade.listItems()[0].id, "x", async () => 1));
  process.env.HOST = "127.0.0.1";
  check("with HOST=0.0.0.0 too (and nothing listed)", hidden(lanGet) && lanUse?.code === "blocked");
  process.env.TRINITY_ORIGINS = "http://192.168.1.20:5173";
  const plainGet = await api("GET", "/vault");
  const plainAdd = await api("POST", "/vault/items", { kind: "secret", values: { label: "x", value: "lan-origin-secret-12" } });
  process.env.TRINITY_ORIGINS = "http://127.0.0.1:8898";
  const loopGet = await api("GET", "/vault");
  delete process.env.TRINITY_ORIGINS;
  check("with TRINITY_ORIGINS naming a plain-http page on the network too — but not for a loopback one (http://127.0.0.1:8898)", hidden(plainGet) && /TRINITY_ORIGINS/.test(plainGet.json.status.blocked) && plainAdd.status === 403 && plainAdd.json.code === "blocked" && loopGet.json.status.blocked === undefined && loopGet.json.items.length === 2);
  check("and it works again once all are right", (await api("GET", "/vault")).json.status.blocked === undefined && (await facade.useSecret(facade.listItems()[0].id, "check", async () => true)) === true);
}

// ══ 13. The canary ════════════════════════════════════════════════════════════
section("the canary");
const tag = crypto.randomBytes(5).toString("hex");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function luhnNumber(prefix: string): string {
  let body = prefix;
  while (body.length < 15) body += String(crypto.randomInt(0, 10));
  for (let d = 0; d < 10; d++) if (items.luhnOk(body + d)) return body + d;
  throw new Error("no check digit");
}
const CANARY: Record<string, string> = {
  password: `cnry-P4ss-${tag}-!x`,
  username: `cnry.user.${tag}@example.com`,
  totpSeed: Array.from(crypto.randomBytes(32), (b) => B32[b % 32]).join(""),
  cardNumber: luhnNumber("4"),
  cardHolder: `Cnry Holder ${tag}`,
  cardPostal: `CN${tag.slice(0, 6).toUpperCase()}`,
  fullName: `Cnry Person ${tag}`,
  address: `${tag} Cnry Lane`,
  email: `cnry.id.${tag}@example.org`,
  phone: `+1555${String(crypto.randomInt(1_000_000, 9_999_999))}`,
  genericSecret: `cnry-s3cret-${tag}`,
  oneTime: `cnry-once-${tag}`,
  passphrase: `cnry phrase ${tag} horse`,
  wrongPassphrase: `cnry wrong ${tag} guess`,
  refusedCard: luhnNumber("5105").replace(/.$/, (d) => String((Number(d) + 1) % 10)),
  brokenJson: `cnry-broken-json-${tag}`,
};
const CVC = String(crypto.randomInt(1000, 9999)); // too short to search everything for: checked where it could sit
/** Every spelling a value could leave in: as it is, grouped (a card), base64, base64url, hex, URL-encoded, JSON-escaped. */
function spellings(v: string): string[] {
  const out = new Set([v, Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url"), Buffer.from(v).toString("hex"), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]);
  if (/^\d{12,19}$/.test(v)) for (const sep of [" ", "-"]) out.add((v.match(/.{1,4}/g) ?? []).join(sep));
  return [...out];
}
const NEEDLES = Object.entries(CANARY).flatMap(([name, v]) => spellings(v).map((s) => ({ name, s })));
let searched = 0;
const found: string[] = [];
const kinds = new Map<string, number>();
/** Search one observable thing for every canary; only the canary's NAME is ever reported. */
function search(kind: string, where: string, hay: string | Buffer): void {
  searched++;
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const buf = typeof hay === "string" ? Buffer.from(hay, "utf8") : hay;
  for (const { name, s } of NEEDLES) {
    const hit = `${name} in ${where}`;
    if ((buf.includes(s, 0, "utf8") || buf.includes(s, 0, "utf16le")) && !found.includes(hit)) found.push(hit);
  }
}
{
  const planted = `{"say":"Filled ${CANARY.password} on the page"}`;
  const before = found.length;
  search("self-test", "a planted string", planted);
  search("self-test", "a planted base64 string", Buffer.from(CANARY.cardNumber).toString("base64"));
  check("the search itself works: a planted canary is found, plain and encoded", found.length - before === 2);
  found.length = before;
  searched = 0;
  kinds.clear();
}
const typeInto = async (purpose: string, values: Record<string, unknown>) => {
  const form = openOf(purpose);
  if (!form) return { status: 0, json: null as any, body: "" };
  return api("POST", `/vault/forms/${form.id}`, { values });
};
const heard = (line: string | RegExp) => until(() => appSocket.events.some((e) => e.type === "transcript" && (typeof line === "string" ? e.turn?.text === line : line.test(String(e.turn?.text)))), 5000);

// — saving a login, by voice and through the secure form —
const savingLogin = await say("vault_save_login", "Save my Netflix password.");
check("vault_save_login answers at once: a secure form is open, and it can't see or hear it", savingLogin.ok && savingLogin.speak === "I've opened a secure form on the workspace. Type it there — I can't see or hear it.", savingLogin.say);
const loginForm = openOf("save-login");
check("…the form is for Netflix, asks for the website, and its card is on the board", loginForm?.title === "Netflix login" && loginForm.fields.some((f: { name: string }) => f.name === "hosts") && loginForm.fields.find((f: { name: string }) => f.name === "label")?.value === "Netflix" && formCards().some((c: { title: string }) => c.title === "Secure form: Netflix login"));
const loginPost = await typeInto("save-login", { label: "Netflix", hosts: "www.netflix.com", username: CANARY.username, password: CANARY.password, totpSecret: CANARY.totpSeed });
check("the window posts what was typed; the answer is {ok, status}", loginPost.status === 200 && loginPost.json.status === "submitted");
check("…and Trinity says so afterwards: 'Saved your Netflix login.'", await heard("Saved your Netflix login."));
const loginId: string = facade.findLogins("www.netflix.com")[0]?.id;

// — a card (keeping the security code), contact details, a plain secret from Settings —
const savingCard = await say("vault_save_card", "save my credit card");
const cardPost = await typeInto("save-card", { number: CANARY.cardNumber.replace(/(.{4})/g, "$1 ").trim(), expiry: "08/31", holder: CANARY.cardHolder, postalCode: CANARY.cardPostal, keepCvc: true, cvc: CVC, label: "" });
const cardMeta = facade.listItems("card")[0];
check("vault_save_card: form, post, saved — brand and last four from the number", savingCard.ok && cardPost.status === 200 && cardMeta?.brand === "Visa" && cardMeta.last4 === CANARY.cardNumber.slice(-4) && cardMeta.hasCvc === true && (await heard(`Saved your Visa ending ${CANARY.cardNumber.slice(-4)}.`)));
const savingDetails = await say("vault_save_details", "save my address");
const detailsPost = await typeInto("save-identity", { label: "", fullName: CANARY.fullName, email: CANARY.email, phone: CANARY.phone, address1: CANARY.address, city: "Lisbon", country: "Portugal" });
check("vault_save_details: form, post, saved", savingDetails.ok && detailsPost.status === 200 && facade.listItems("identity").length === 1 && (await heard("Saved your details.")));
const settingsAdd = await api("POST", "/vault/items", { kind: "secret", values: { label: "Router admin", value: CANARY.genericSecret } });
check("a secret added from Settings", settingsAdd.status === 200);

// — what is kept, by name —
const listing = await say("vault_list", "what's in the vault?");
check("vault_list names what is kept: labels only", listing.ok && /Netflix/.test(listing.say) && new RegExp(`Visa ending ${CANARY.cardNumber.slice(-4)}`).test(listing.say) && /Router admin/.test(listing.say), listing.say);
const logins = await say("vault_list", "which logins do you have?");
check("…or one kind of thing", logins.ok && /^You have \d+ logins?, /.test(logins.say) && /Netflix/.test(logins.say) && !/Visa/.test(logins.say), logins.say);

// — using them, as a fill would —
const fill = await facade.useSecret(loginId, "fill on www.netflix.com", async (s: { username: string; password: string; totpSecret?: string; totpCode?: string }, meta: { hosts: string[] }) => ({
  right: s.username === CANARY.username && s.password === CANARY.password && s.totpSecret === CANARY.totpSeed && /^\d{6}$/.test(s.totpCode ?? ""),
  filled: ["username", "password", "otp"],
  host: meta.hosts[0],
}));
check("useSecret gives the fill the real values (they are in the vault, encrypted)", fill.right === true && fill.host === "www.netflix.com");
const cardFill = await facade.useSecret(cardMeta.id, "fill on checkout.example.com", async (s: { number: string; holder: string; cvc?: string; expMonth: number; postalCode?: string }) => s.number === CANARY.cardNumber && s.holder === CANARY.cardHolder && s.cvc === CVC && s.expMonth === 8 && s.postalCode === CANARY.cardPostal);
const who = await facade.useSecret(facade.listItems("identity")[0].id, "fill on shop.example.com", async (s: { fullName?: string; address1?: string; email?: string; phone?: string }) => s.fullName === CANARY.fullName && s.address1 === CANARY.address && s.email === CANARY.email && s.phone === CANARY.phone);
const plainSecret = await facade.useSecret(settingsAdd.json.item.id, "read for a test", async (s: { value: string }) => s.value === CANARY.genericSecret);
check("…the card, the details and the plain secret too", cardFill === true && who === true && plainSecret === true);
const leakTry = await failure(() => facade.useSecret(loginId, "a careless caller", async (s: { password: string }) => ({ say: `Filled ${s.password}` })));
errorsSeen.push(String(leakTry?.message), util.inspect(leakTry?.err));
check("a careless caller that returns the password gets an error instead", leakTry?.code === "leak");
const oneTime = facade.openForm({ purpose: "one-time", title: "Security code", detail: "For this payment only.", fields: [{ name: "code", label: "Security code", type: "password", required: true }], submitLabel: "Use once" });
const oncePost = await typeInto("one-time", { code: CANARY.oneTime });
const onceUsed = await facade.useOneTime(oneTime.form.id, async (v: { code: string }) => v.code === CANARY.oneTime);
check("a one-time value: typed, used once", oncePost.status === 200 && onceUsed === true);
const confirm = facade.openForm({ purpose: "confirm", title: `Fill your Visa ending ${CANARY.cardNumber.slice(-4)} on checkout.example.com?`, detail: "The total is above your limit.", fields: [], submitLabel: "Approve" });
const approved = await typeInto("confirm", {});
check("a confirmation: approved in the form", approved.status === 200 && (await confirm.done).status === "approved");

// — the passphrase lock, through the secure form —
const canDevice: boolean = vault().deviceAvailable();
const setPhrase = await api("PUT", "/vault/settings", { lock: "passphrase", passphrase: CANARY.passphrase });
await api("POST", "/vault/lock");
const lockedUse = await failure(() => facade.useSecret(loginId, "fill on www.netflix.com", async () => 1));
errorsSeen.push(String(lockedUse?.message), util.inspect(lockedUse?.err));
check("locked with a passphrase: useSecret fails with 'locked' and the passphrase form goes up by itself", setPhrase.status === 200 && lockedUse?.code === "locked" && openOf("unlock")?.fields.length === 1 && openOf("unlock").fields[0].type === "password");
const wrongTyped = await typeInto("unlock", { passphrase: CANARY.wrongPassphrase });
check("a wrong passphrase in the form: 403, the form stays, nothing echoed", wrongTyped.status === 403 && wrongTyped.json.code === "wrong-passphrase" && openOf("unlock") !== undefined);
const whileLocked = await say("vault_save_login", "save my password for github dot com");
check("vault_save_login while locked: says to type the passphrase first; its own form waits", whileLocked.ok && /locked/i.test(whileLocked.say) && openOf("save-login") === undefined && facade.openForms().length === 1, whileLocked.say);
const rightTyped = await typeInto("unlock", { passphrase: CANARY.passphrase });
check("the right passphrase: unlocked — and Trinity says so", rightTyped.status === 200 && facade.vaultStatus().state === "unlocked" && (await heard(/The vault is unlocked/)));
const waiting = openOf("save-login");
check("…and the login form that was waiting now shows, with the spoken address filled in to be checked", (await until(() => openOf("save-login") !== undefined)) && openOf("save-login").fields.find((f: { name: string }) => f.name === "hosts")?.value === "github.com" && waiting?.host === undefined);
const cancelled = await api("DELETE", `/vault/forms/${openOf("save-login")?.id}`);
check("cancelling it leaves the vault as it was", cancelled.status === 200 && facade.listItems().length === 6);
const restore = await api("PUT", "/vault/settings", canDevice ? { lock: "device", currentPassphrase: CANARY.passphrase } : { spendingLimit: 200 });
check("back to the device lock", restore.status === 200);

// — requests that must fail without repeating what they carried —
const refusedCard = await api("POST", "/vault/items", { kind: "card", values: { number: CANARY.refusedCard, expiry: "08/31" } });
const brokenJson = await api("POST", "/vault/items", `{"kind":"secret","values":{"label":"x","value":"${CANARY.brokenJson}`);
const wrongUnlock = await api("POST", "/vault/unlock", { passphrase: CANARY.wrongPassphrase });
check("a refused card, broken JSON and a pointless unlock: answered without an echo", refusedCard.status === 422 && brokenJson.status === 400 && wrongUnlock.status === 200);

// — forgetting —
const asking = await say("vault_forget", "forget my Netflix password");
check(
  "vault_forget asks first, and says what to answer",
  asking.ok && asking.speak === "Remove your Netflix login from the vault for good? To confirm, say: yes, remove it." && pendingQuestion() !== null && facade.findLogins("www.netflix.com").length === 1,
  asking.say,
);
const no = await say("answer_question", "no, wait");
check("…a no keeps it", /kept/i.test(no.say) && facade.findLogins("www.netflix.com").length === 1, no.say);
await say("vault_forget", "delete the Netflix login from the vault");
const bare = await say("answer_question", "yes");
check("…a bare yes is not enough: it asks again, with the words to say", /yes, remove/.test(bare.say) && pendingQuestion() !== null && facade.findLogins("www.netflix.com").length === 1, bare.say);
const okay = await say("answer_question", "okay sure");
check("…nor is a passing okay", pendingQuestion() !== null && facade.findLogins("www.netflix.com").length === 1, okay.say);
const yes = await say("answer_question", "yes, remove it");
check("…a yes that says remove removes it", yes.ok && yes.say === "Removed your Netflix login from the vault." && facade.findLogins("www.netflix.com").length === 0, yes.say);
const unclear = await say("vault_forget", "forget that thing");
check("…and words that name nothing ask which", unclear.ok === false && /Which one/.test(unclear.say), unclear.say);

// — now look everywhere —
await sleep(900); // the workspace's debounced save, and anything still being said
for (const [i, o] of toolOutcomes.entries()) search("tool result", `tool result #${i + 1}`, `${JSON.stringify(o)}\n${util.inspect(o, { depth: 9 })}`);
search("tool events", "the events tools emitted (tool, tool_result, transcript)", JSON.stringify(toolEvents));
search("recent tool results", "what the engine keeps of recent tool results for later turns", JSON.stringify(recentResults()));
search("workspace bus", "every workspace bus event (in process)", JSON.stringify(busEvents));
search("socket /ws/workspace", "every event a workspace window received", JSON.stringify(windowSocket.events));
search("socket /ws", "every event the app's socket received", JSON.stringify(appSocket.events));
search("workspace snapshot", "workspace.snapshot()", JSON.stringify(workspace.snapshot()));
search("workspace snapshot", "GET /api/workspace", (await api("GET", "/workspace")).body);
search("vault metadata", "vaultStatus, listItems, openForms", util.inspect([facade.vaultStatus(), facade.listItems(), facade.openForms()], { depth: 9 }));
for (const [i, r] of responses.entries()) search("HTTP response", `response #${i + 1} (${r.what} → ${r.status})`, `${r.body}\n${r.headers}`);
for (const [i, e] of errorsSeen.entries()) search("error", `error #${i + 1}`, e);
search("console", "everything written to the console", consoleOut.join(""));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const dataFiles = walk(DATA);
const unreadable: string[] = [];
for (const f of dataFiles) {
  let content: Buffer;
  try {
    content = fs.readFileSync(f);
  } catch {
    unreadable.push(path.relative(DATA, f)); // a file the engine holds open exclusively
    continue;
  }
  const rel = path.relative(DATA, f);
  search(rel.startsWith(`vault${path.sep}`) ? "vault folder file" : rel === "workspace.json" ? "workspace.json" : "other data file", `file ${rel}`, content);
}
const vaultJson = fs.readFileSync(path.join(DATA, "vault", "vault.json"), "utf8");
const parsedVault = JSON.parse(vaultJson) as { items: { ct: string; meta: Record<string, unknown> }[] };
check("the vault file holds the items as ciphertext only: no secret field names, no security code", parsedVault.items.length === 5 && parsedVault.items.every((i) => i.ct.length > 20) && !/"(?:password|number|cvc|totpSecret|value|username|holder|fullName|address1)"/.test(vaultJson) && !new RegExp(`"${CVC}"`).test(vaultJson));
check("…and what it does show is what may be shown: label, kind, hosts, brand, last four, expiry", parsedVault.items.some((i) => i.meta.brand === "Visa" && i.meta.last4 === CANARY.cardNumber.slice(-4) && i.meta.expMonth === 8));
const log = fs.readFileSync(path.join(DATA, "vault", "access.log"), "utf8");
check("the access log lists uses by id and purpose", /"purpose":"fill on www\.netflix\.com"/.test(log) && log.split("\n").filter(Boolean).every((l) => Object.keys(JSON.parse(l)).sort().join() === "id,ok,purpose,ts"));
check("workspace.json exists and was searched", dataFiles.some((f) => path.relative(DATA, f) === "workspace.json"));
// (The memory database's LOCK file is held exclusively while the engine runs; it is an empty marker.)
const notRead = unreadable.filter((f) => path.basename(f) !== "LOCK");
check(`every file the run wrote was read and searched (${dataFiles.length - unreadable.length} of ${dataFiles.length}; the rest: the memory database's empty LOCK file)`, notRead.length === 0 && unreadable.length <= 1, notRead.join(" "));
check(`no canary anywhere: ${searched} places searched for ${Object.keys(CANARY).length} values in ${NEEDLES.length} spellings`, found.length === 0, found.slice(0, 6).join("; "));
check("the engine wrote nothing about a failed request beyond a fixed line", !consoleOut.join("").includes("cnry"));

// ─── Summary ──────────────────────────────────────────────────────────────────
appSocket.close();
windowSocket.close();
let pass = 0;
let fails = 0;
console.log("\n── summary ──");
for (const s of sections) {
  pass += s.pass;
  fails += s.fail;
  console.log(`${s.fail ? "FAIL" : "ok  "} ${s.name}: ${s.pass}/${s.pass + s.fail}`);
}
console.log(`canary: ${searched} places searched (${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")}); ${found.length} canaries found`);
console.log(`${dpapi.dpapiAvailable() ? "DPAPI: tested on this computer" : "DPAPI: skipped (not Windows)"}`);
console.log(fails ? `\n${fails} FAILED, ${pass} passed` : `\nALL ${pass} CHECKS PASSED`);
process.exit(fails ? 1 : 0);

// ═══ The secure sheet, against a stand-in DOM (run as `--sheet`, in a process of its own) ═══════════════════════════
// web/src/workspace/view.ts is loaded as it is and mounted on a small imitation of the DOM: elements, attributes,
// events that bubble, focus, a WebSocket and a fetch that record what passes through them. It proves the logic — what
// is drawn from a descriptor, where typed values go and don't go, that inputs are blanked before a sheet is removed,
// that Tab stays inside and Escape cancels. It cannot prove how a real browser lays it out, focuses it or treats its
// password fields: that still needs eyes on a real page.
async function sheetSuite(): Promise<never> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `   [${detail}]` : ""}`);
  };
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const { registerHooks } = await import("node:module");
  // A stylesheet import means nothing here.
  registerHooks({
    load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
      return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context);
    },
  } as never);

  type Listener = (e: any) => void;
  class Target {
    listeners = new Map<string, Listener[]>();
    addEventListener(type: string, fn: Listener): void {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type)!.push(fn);
    }
    removeEventListener(type: string, fn: Listener): void {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== fn));
    }
    run(evt: any): void {
      for (const fn of [...(this.listeners.get(evt.type) ?? [])]) fn(evt);
    }
  }
  const posted: unknown[] = []; // everything posted into any frame
  /** An element's inline style: the property calls a page makes. */
  const makeStyle = () => {
    const props = new Map<string, string>();
    return {
      setProperty: (k: string, v: string): void => void props.set(k, String(v)),
      getPropertyValue: (k: string): string => props.get(k) ?? "",
      removeProperty: (k: string): string => {
        const v = props.get(k) ?? "";
        props.delete(k);
        return v;
      },
    };
  };
  class El extends Target {
    parentNode: El | null = null;
    children: El[] = [];
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    style = makeStyle();
    text = "";
    value = "";
    checked = false;
    disabled = false;
    inert = false;
    tabIndex = 0;
    title = "";
    placeholder = "";
    maxLength = -1;
    inputMode = "";
    srcdoc = "";
    selectionStart: number | null = null;
    markupWrites = 0;
    readonly win = { postMessage: (m: unknown) => void posted.push(m) };
    constructor(public tagName: string) {
      super();
    }
    get contentWindow(): unknown {
      return this.tagName === "IFRAME" ? this.win : undefined;
    }
    get id(): string {
      return this.attrs.get("id") ?? "";
    }
    set id(v: string) {
      this.attrs.set("id", v);
    }
    get className(): string {
      return this.attrs.get("class") ?? "";
    }
    set className(v: string) {
      this.attrs.set("class", v);
    }
    get type(): string {
      return this.attrs.get("type") ?? (this.tagName === "INPUT" ? "text" : "");
    }
    set type(v: string) {
      this.attrs.set("type", v);
    }
    get hidden(): boolean {
      return this.attrs.has("hidden");
    }
    set hidden(v: boolean) {
      if (v) this.attrs.set("hidden", "");
      else this.attrs.delete("hidden");
    }
    get innerHTML(): string {
      return "";
    }
    set innerHTML(_v: string) {
      this.markupWrites++;
    }
    get textContent(): string {
      return this.tagName === "#text" ? this.text : this.children.map((c) => c.textContent).join("");
    }
    set textContent(v: string) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
      if (v) this.append(String(v));
    }
    get classList() {
      const get = (): string[] => this.className.split(/\s+/).filter(Boolean);
      const set = (xs: string[]): void => void (this.className = [...new Set(xs)].join(" "));
      return {
        add: (...c: string[]) => set([...get(), ...c]),
        remove: (...c: string[]) => set(get().filter((x) => !c.includes(x))),
        contains: (c: string) => get().includes(c),
        toggle: (c: string, force?: boolean) => {
          const on = force ?? !get().includes(c);
          set(on ? [...get(), c] : get().filter((x) => x !== c));
          return on;
        },
      };
    }
    setAttribute(k: string, v: unknown): void {
      this.attrs.set(k, String(v));
    }
    getAttribute(k: string): string | null {
      return this.attrs.get(k) ?? null;
    }
    removeAttribute(k: string): void {
      this.attrs.delete(k);
    }
    hasAttribute(k: string): boolean {
      return this.attrs.has(k);
    }
    append(...nodes: (El | string)[]): void {
      for (const n of nodes) {
        if (typeof n === "string") {
          const t = new El("#text");
          t.text = n;
          this.insertBefore(t, null);
        } else this.insertBefore(n, null);
      }
    }
    appendChild(n: El): El {
      return this.insertBefore(n, null);
    }
    insertBefore(n: El, ref: El | null): El {
      n.remove();
      n.parentNode = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at < 0) this.children.push(n);
      else this.children.splice(at, 0, n);
      return n;
    }
    remove(): void {
      const p = this.parentNode;
      if (!p) return;
      p.children = p.children.filter((c) => c !== this);
      this.parentNode = null;
      if (this.contains(doc.activeElement)) doc.activeElement = doc.body; // as a browser does when the focused element goes
    }
    replaceChildren(): void {
      for (const c of [...this.children]) c.remove();
    }
    contains(n: El | null): boolean {
      for (let x = n; x; x = x.parentNode) if (x === this) return true;
      return false;
    }
    get isConnected(): boolean {
      return doc.body.contains(this);
    }
    get offsetWidth(): number {
      return 100;
    }
    matches(selector: string): boolean {
      return selector.split(",").some((part) => {
        const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(part.trim());
        if (!m) return false;
        if (m[1] && m[1].toUpperCase() !== this.tagName) return false;
        for (const cls of (m[2] ?? "").split(".").filter(Boolean)) if (!this.classList.contains(cls)) return false;
        for (const a of (m[3] ?? "").match(/\[[^\]]+\]/g) ?? []) {
          const kv = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(a);
          if (!kv || !this.attrs.has(kv[1]!) || (kv[2] !== undefined && this.attrs.get(kv[1]!) !== kv[2])) return false;
        }
        return true;
      });
    }
    closest(selector: string): El | null {
      for (let x: El | null = this; x; x = x.parentNode) if (x.tagName !== "#text" && x.matches(selector)) return x;
      return null;
    }
    querySelectorAll(selector: string): El[] {
      const out: El[] = [];
      const walk = (e: El): void => {
        for (const c of e.children) {
          if (c.tagName !== "#text" && c.matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector: string): El | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    focus(): void {
      if (!this.disabled && this.isConnected && !this.closest("[hidden]")) doc.activeElement = this;
    }
    blur(): void {
      if (doc.activeElement === this) doc.activeElement = doc.body;
    }
    setSelectionRange(): void {}
    select(): void {}
  }
  class Doc extends Target {
    body = new El("BODY");
    activeElement: El = this.body;
    visibilityState = "visible";
    fullscreenElement = null;
    fullscreenEnabled = false;
    createElement(tag: string): El {
      return new El(tag.toUpperCase());
    }
    createTextNode(text: string): El {
      const t = new El("#text");
      t.text = text;
      return t;
    }
    createElementNS(_ns: string, tag: string): El {
      return new El(tag.toUpperCase());
    }
    exitFullscreen(): Promise<void> {
      return Promise.resolve();
    }
  }
  class Win extends Target {
    setTimeout = setTimeout;
    clearTimeout = clearTimeout;
    open(): null {
      return null;
    }
  }
  class Socket {
    static all: Socket[] = [];
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      Socket.all.push(this);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
    up(): void {
      this.readyState = 1;
      this.onopen?.();
    }
    push(evt: unknown): void {
      this.onmessage?.({ data: JSON.stringify(evt) });
    }
    drop(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const doc = new Doc();
  const win = new Win();
  const calls: { url: string; init: Record<string, any> }[] = [];
  let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, status: "submitted" } });
  const fakeFetch = async (url: unknown, init: Record<string, any> = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), blob: async () => ({ size: 1 }) });
    if (u === "/api/auth/status") return reply(200, { auth: "on", linked: true, needsCode: false });
    if (u.startsWith("/api/vault/forms/") && init.method === "POST") {
      const a = answer();
      return reply(a.status, a.body);
    }
    return reply(200, { ok: true });
  };
  const ORIGIN = "http://localhost:5173";
  // A browser that can draw a plain text field masked (as Chrome, Edge and Safari can): `-webkit-text-security`.
  const TEXT_MASK = "-webkit-text-security";
  const cssWith = (canMask: boolean) => ({ supports: (p: string, v?: string) => canMask && p === TEXT_MASK && v === "disc", escape: (s: string) => s });
  Object.assign(globalThis, { document: doc, window: win, HTMLElement: El, Node: El, CSS: cssWith(true), WebSocket: Socket, fetch: fakeFetch, location: { protocol: "http:", host: "localhost:5173", origin: ORIGIN, href: `${ORIGIN}/workspace.html` } });
  /** Typed into as dots: a password field — or a text field masked by `-webkit-text-security`. */
  const masked = (i: El): boolean => i.type === "password" || (i.type === "text" && i.style.getPropertyValue(TEXT_MASK) === "disc");

  /** Dispatch an event the way a browser does: at the target, then up through its ancestors, the document and the window. */
  const fire = (target: El, type: string, init: Record<string, unknown> = {}): any => {
    const evt: any = { type, target, defaultPrevented: false, stopped: false, isComposing: false, detail: 0, key: "", shiftKey: false, ...init };
    evt.preventDefault = () => void (evt.defaultPrevented = true);
    evt.stopPropagation = () => void (evt.stopped = true);
    for (let x: El | null = target; x && !evt.stopped; x = x.parentNode) x.run(evt);
    if (!evt.stopped) doc.run(evt);
    if (!evt.stopped) win.run(evt);
    return evt;
  };
  const type = (input: El, value: string): void => {
    input.value = value;
    input.selectionStart = value.length;
    fire(input, "input");
  };
  const press = (button: El, detail = 1): void => {
    if (!button.disabled) fire(button, "click", { detail });
  };
  const key = (k: string, init: Record<string, unknown> = {}): any => fire(doc.activeElement, "keydown", { key: k, ...init });

  const view = await import(new URL("../web/src/workspace/view.ts", import.meta.url).href);
  const SNAP = { epoch: "e1", version: 1, mode: "empty", title: "Workspace", html: null, template: null, state: null, owner: null, activities: [], overlays: "all", updatedAt: 0 };
  const mount = async (opts: Record<string, unknown> = { chrome: true }) => {
    const container = new El("DIV");
    doc.body.append(container);
    const handle = view.mountWorkspace(container, opts);
    await wait(20); // the session check, then the socket
    const socket = Socket.all[Socket.all.length - 1]!;
    socket.up();
    socket.push({ type: "snapshot", snapshot: SNAP });
    return { container, handle, socket };
  };
  const sheetsIn = (container: El): El[] => container.querySelectorAll(".tw-sheet").filter((s) => !s.hidden);
  const TYPED = "typed-in-the-sheet-9f3c";
  const loginForm = (id: string) => ({
    id,
    purpose: "save-login",
    title: "Netflix <img src=x onerror=alert(1)> login",
    detail: "Your sign-in for Netflix.",
    host: "www.netflix.com",
    fields: [
      { name: "label", label: "Name", type: "text", value: "Netflix" },
      { name: "username", label: "User name or email", type: "text", autocomplete: "username" },
      { name: "password", label: "Password", type: "password", required: true, value: "MUST-NOT-ARRIVE-FILLED-IN" },
      { name: "totpSecret", label: "Authenticator key (optional)", type: "otp-secret" },
    ],
    submitLabel: "Save login",
    expiresAt: Date.now() + 600_000,
    card: 3,
  });
  const ID1 = "A".repeat(43);

  // — drawn from a descriptor —
  const a = await mount();
  const outside = new El("BUTTON");
  doc.body.append(outside);
  outside.focus();
  const frame = a.container.querySelector("iframe")!;
  check("before any form: no sheet, the frame is live", sheetsIn(a.container).length === 0 && frame.inert === false && a.container.querySelector(".tw-sheet-layer")!.hidden);
  a.socket.push({ type: "form", form: loginForm(ID1) });
  const sheet = sheetsIn(a.container)[0]!;
  const layer = a.container.querySelector(".tw-sheet-layer")!;
  check("a form event draws the sheet in the host overlay, over the stage", Boolean(sheet) && !layer.hidden && layer.parentNode!.classList.contains("tw-overlay") && sheet.getAttribute("role") === "dialog" && sheet.getAttribute("aria-modal") === "true");
  check("the board frame is inert while it is up", frame.inert === true);
  check("the title bar says a secure form is open", a.container.querySelector(".tw-sheet-flag")!.hidden === false);
  check("title, detail and host are shown as text, never as markup", sheet.querySelector(".tw-sheet-title")!.textContent === "Netflix <img src=x onerror=alert(1)> login" && sheet.querySelector(".tw-sheet-detail")!.textContent === "Your sign-in for Netflix." && sheet.querySelector(".tw-sheet-host")!.textContent === "For www.netflix.com" && sheet.querySelectorAll("img").length === 0);
  const everyNode = (e: El): El[] => [e, ...e.children.flatMap(everyNode)];
  check("nothing in the sheet was built from markup (no innerHTML at all)", everyNode(layer).every((n) => n.markupWrites === 0));
  check("the fixed line is there, word for word", sheet.querySelector(".tw-sheet-note")!.textContent === "Typed here, this goes straight into Trinity's vault. Trinity and its models never see it.");
  const inputs = sheet.querySelectorAll("input");
  const [label, user, pass, seed] = inputs as [El, El, El, El];
  check("the fields: plain text for the name and user name, masked for the password and the authenticator key", inputs.length === 4 && label.type === "text" && user.type === "text" && !masked(label) && !masked(user) && masked(pass) && masked(seed));
  check("only a plain field arrives filled in", label.value === "Netflix" && user.value === "" && pass.value === "" && seed.value === "");
  check("the browser's password manager is kept out: new-password on a password field, off on every other", inputs.every((i) => i.getAttribute("autocomplete") === (i.type === "password" ? "new-password" : "off")) && inputs.every((i) => i.getAttribute("data-lpignore") === "true" && i.getAttribute("spellcheck") === "false" && !i.hasAttribute("name")));
  const viewMasksText = fs.readFileSync(new URL("../web/src/workspace/view.ts", import.meta.url), "utf8").includes(TEXT_MASK);
  if (viewMasksText) check("where text can be masked, a secret is typed into a text field drawn as dots: no password field for the browser to offer to save", [pass, seed].every((i) => i.type === "text" && i.style.getPropertyValue(TEXT_MASK) === "disc" && i.getAttribute("autocomplete") === "off"));
  else console.log("skip  masked text fields in the sheet: web/src/workspace/view.ts doesn't have that change yet");
  check("there is no <form> element to submit or capture", a.container.querySelectorAll("form").length === 0);
  check("the focus moves into the sheet, to its first field", doc.activeElement === label);

  // — show / hide —
  const toggles = sheet.querySelectorAll(".tw-sheet-toggle");
  check("masked fields have a Show / Hide button; plain ones don't", toggles.length === 2 && toggles[0]!.textContent === "Show" && toggles[0]!.getAttribute("aria-pressed") === "false");
  type(pass, TYPED);
  press(toggles[0]!);
  const shown = !masked(pass) && toggles[0]!.textContent === "Hide" && toggles[0]!.getAttribute("aria-pressed") === "true";
  press(toggles[0]!);
  check("Show reveals the field, Hide masks it again", shown && masked(pass) && toggles[0]!.textContent === "Show");

  // — the focus stays inside —
  const order = sheet.querySelectorAll("input, button").filter((e) => !e.disabled);
  const last = order[order.length - 1]!;
  last.focus();
  const tab = key("Tab");
  const wrapped = doc.activeElement === order[0];
  const back = key("Tab", { shiftKey: true });
  check("Tab from the last control goes to the first, Shift+Tab back to the last: the focus is trapped", wrapped && doc.activeElement === last && tab.defaultPrevented && back.defaultPrevented && order.length === 8);
  let all = true;
  for (let i = 0; i < 20; i++) {
    key("Tab");
    if (!sheet.contains(doc.activeElement)) all = false;
  }
  check("twenty Tabs never leave the sheet", all);
  const f = fire(pass, "keydown", { key: "f" });
  check("keys typed in the sheet don't reach the page's shortcuts", f.stopped === true);
  fire(layer, "mousedown");
  check("a click beside the sheet doesn't close it", sheetsIn(a.container).length === 1 && sheet.contains(doc.activeElement));

  // — a value that is refused stays, with the engine's message at its field —
  answer = () => ({ status: 422, body: { error: "Type the password.", code: "invalid", field: "password" } });
  type(pass, "");
  type(pass, TYPED);
  type(user, "ryan@example.com");
  pass.focus();
  key("Enter");
  await wait(20);
  const firstPost = calls.filter((c) => c.init.method === "POST" && c.url.startsWith("/api/vault/forms/"));
  const fieldError = pass.closest(".tw-sheet-field")!.querySelector(".tw-sheet-field-error")!;
  check("Enter in a field submits; a refusal shows the engine's sentence at that field and keeps what was typed", firstPost.length === 1 && fieldError.hidden === false && fieldError.textContent === "Type the password." && pass.value === TYPED && sheetsIn(a.container).length === 1 && pass.getAttribute("aria-invalid") === "true");

  // — the one way out —
  answer = () => ({ status: 200, body: { ok: true, status: "submitted" } });
  const submit = sheet.querySelector(".tw-sheet-primary")!;
  check("the submit button carries the form's own label", submit.textContent === "Save login");
  press(submit);
  const during = { busy: submit.disabled, cancel: sheet.querySelectorAll(".tw-sheet-btn")[0]!.disabled };
  await wait(20);
  const post = calls.filter((c) => c.init.method === "POST" && c.url.startsWith("/api/vault/forms/"))[1]!;
  check("it is one POST to this page's own origin: /api/vault/forms/<id>, JSON, {values}", post.url === `/api/vault/forms/${ID1}` && post.init.headers["Content-Type"] === "application/json" && JSON.stringify(JSON.parse(post.init.body)) === JSON.stringify({ values: { label: "Netflix", username: "ryan@example.com", password: TYPED, totpSecret: "" } }));
  check("…same-origin credentials, never following a redirect, never cached", post.init.credentials === "same-origin" && post.init.redirect === "error" && post.init.cache === "no-store");
  check("the buttons are disabled while it is sent", during.busy === true && during.cancel === true);
  check("on success the inputs are blanked and the sheet is removed", inputs.every((i) => i.value === "") && sheetsIn(a.container).length === 0 && layer.hidden && sheet.parentNode === null);
  check("the frame is live again and the focus goes back where it was", frame.inert === false && doc.activeElement === outside && a.container.querySelector(".tw-sheet-flag")!.hidden === true);
  const overSocket = Socket.all.flatMap((s) => s.sent).join("\n");
  check("nothing typed went over the WebSocket", !overSocket.includes(TYPED) && !overSocket.includes("ryan@example.com"), overSocket.slice(0, 60));
  check("…or into a frame", !JSON.stringify(posted).includes(TYPED));
  check("…or into the view's diagnostics", !JSON.stringify(a.handle.stats()).includes(TYPED) && a.handle.stats().uiEvents.length === 0 && a.handle.stats().secureForms === 0);
  check("…or into a URL", calls.every((c) => !c.url.includes(TYPED)));

  // — Escape cancels —
  const ID2 = "B".repeat(43);
  a.socket.push({ type: "form", form: loginForm(ID2) });
  const s2 = sheetsIn(a.container)[0]!;
  const p2 = s2.querySelectorAll("input")[2]!;
  type(p2, TYPED);
  key("Escape");
  await wait(10);
  check("Escape cancels: DELETE /api/vault/forms/<id>, inputs blanked, sheet gone", calls.some((c) => c.url === `/api/vault/forms/${ID2}` && c.init.method === "DELETE") && p2.value === "" && sheetsIn(a.container).length === 0);
  const ID3 = "C".repeat(43);
  a.socket.push({ type: "form", form: loginForm(ID3) });
  const s3 = sheetsIn(a.container)[0]!;
  const p3 = s3.querySelectorAll("input")[2]!;
  type(p3, TYPED);
  doc.activeElement = doc.body; // the focus is nowhere in particular
  fire(doc.body, "keydown", { key: "Escape" });
  check("Escape also cancels when nothing has the focus", p3.value === "" && sheetsIn(a.container).length === 0 && calls.some((c) => c.url === `/api/vault/forms/${ID3}` && c.init.method === "DELETE"));
  const ID4 = "D".repeat(43);
  a.socket.push({ type: "form", form: loginForm(ID4) });
  const p4 = sheetsIn(a.container)[0]!.querySelectorAll("input")[2]!;
  type(p4, TYPED);
  press(sheetsIn(a.container)[0]!.querySelectorAll(".tw-sheet-btn")[0]!);
  check("so does the Cancel button", p4.value === "" && sheetsIn(a.container).length === 0 && calls.filter((c) => c.init.method === "DELETE").length === 3);

  // — the engine ends a form —
  const ID5 = "E".repeat(43);
  a.socket.push({ type: "form", form: loginForm(ID5) });
  const p5 = sheetsIn(a.container)[0]!.querySelectorAll("input")[2]!;
  type(p5, TYPED);
  const deletesBefore = calls.filter((c) => c.init.method === "DELETE").length;
  a.socket.push({ type: "form_closed", id: ID5, status: "cancelled" });
  check("form_closed from the engine takes the sheet down, blanked, without another request", p5.value === "" && sheetsIn(a.container).length === 0 && calls.filter((c) => c.init.method === "DELETE").length === deletesBefore);

  // — a card form —
  const ID6 = "F".repeat(43);
  a.socket.push({
    type: "form",
    form: {
      id: ID6,
      purpose: "save-card",
      title: "Payment card",
      detail: "",
      fields: [
        { name: "number", label: "Card number", type: "card-number", required: true },
        { name: "expiry", label: "Expires", type: "expiry", required: true, placeholder: "MM/YY" },
        { name: "keepCvc", label: "Keep the security code", type: "checkbox" },
        { name: "cvc", label: "Security code", type: "cvc" },
      ],
      submitLabel: "Save card",
      expiresAt: Date.now() + 600_000,
    },
  });
  const cardSheet = sheetsIn(a.container)[0]!;
  const [number, expiry, keep, cvc] = cardSheet.querySelectorAll("input") as [El, El, El, El];
  type(number, "4242424242424242");
  const brand = cardSheet.querySelector(".tw-sheet-brand")!;
  check("the card number is grouped in fours and its brand is shown", number.value === "4242 4242 4242 4242" && brand.textContent === "Visa" && number.inputMode === "numeric" && number.getAttribute("autocomplete") === "off");
  type(number, "5555-5555-5555-4444xx");
  const master = number.value === "5555 5555 5555 4444" && brand.textContent === "Mastercard";
  type(number, "3782 822463 10005");
  check("…for other brands and however it is typed or pasted", master && number.value === "3782 8224 6310 005" && brand.textContent === "American Express");
  type(expiry, "0827");
  const mmyy = expiry.value;
  type(expiry, "8/27");
  check("expiry takes MM/YY (and adds the slash)", mmyy === "08/27" && expiry.value === "8/27");
  const cvcRow = cvc.closest(".tw-sheet-field")!;
  check("'Keep the security code' is unticked, and the security code isn't asked for until it is ticked", keep.type === "checkbox" && keep.checked === false && cvcRow.hidden === true && masked(cvc));
  type(number, "4242424242424241");
  press(cardSheet.querySelector(".tw-sheet-primary")!);
  await wait(10);
  const postsSoFar = calls.filter((c) => c.init.method === "POST").length;
  check("a card number with a wrong digit is caught before anything is sent", cardSheet.querySelector(".tw-sheet-field-error")!.hidden === false && sheetsIn(a.container).length === 1);
  type(number, "4242424242424242");
  type(expiry, "08/27");
  press(cardSheet.querySelector(".tw-sheet-primary")!);
  await wait(20);
  const cardPost = calls.filter((c) => c.init.method === "POST")[postsSoFar];
  check("unticked: the card is sent as digits, without a security code", cardPost !== undefined && JSON.stringify(JSON.parse(cardPost.init.body)) === JSON.stringify({ values: { number: "4242424242424242", expiry: "08/27", keepCvc: false } }) && number.value === "");
  const ID7 = "G".repeat(43);
  a.socket.push({ type: "form", form: { id: ID7, purpose: "save-card", title: "Payment card", detail: "", fields: [{ name: "number", label: "Card number", type: "card-number", required: true }, { name: "keepCvc", label: "Keep the security code", type: "checkbox" }, { name: "cvc", label: "Security code", type: "cvc" }], submitLabel: "Save card", expiresAt: Date.now() + 600_000 } });
  const c2 = sheetsIn(a.container)[0]!;
  const [n2, k2, v2] = c2.querySelectorAll("input") as [El, El, El];
  k2.checked = true;
  fire(k2, "change");
  const asked = v2.closest(".tw-sheet-field")!.hidden === false;
  type(v2, "12a34");
  type(n2, "4242424242424242");
  press(c2.querySelector(".tw-sheet-primary")!);
  await wait(20);
  const keptPost = calls.filter((c) => c.init.method === "POST").pop()!;
  check("ticked: the security code is asked for (digits only) and sent", asked && JSON.parse(keptPost.init.body).values.cvc === "1234" && JSON.parse(keptPost.init.body).values.keepCvc === true);

  // — a question to approve —
  const ID8 = "H".repeat(43);
  a.socket.push({ type: "form", form: { id: ID8, purpose: "confirm", title: "Fill your Visa ending 4242 on checkout.example.com?", detail: "The total is above your limit.", fields: [{ name: "x", label: "X", type: "text" }], submitLabel: "Approve", expiresAt: Date.now() + 600_000 } });
  const q = sheetsIn(a.container)[0]!;
  const [qCancel, qApprove] = q.querySelectorAll(".tw-sheet-btn") as [El, El];
  check("a confirmation has no fields; the focus starts on Cancel", q.querySelectorAll("input").length === 0 && doc.activeElement === qCancel && qApprove.textContent === "Approve");
  const beforeApprove = calls.length;
  press(qApprove, 1);
  await wait(10);
  check("a click on Approve that lands as the sheet appears does nothing", calls.length === beforeApprove && sheetsIn(a.container).length === 1);
  key("Enter");
  check("Enter with the focus on Cancel approves nothing", calls.filter((c) => c.url === `/api/vault/forms/${ID8}` && c.init.method === "POST").length === 0);
  await wait(850);
  press(qApprove, 1);
  await wait(20);
  const approve = calls.filter((c) => c.url === `/api/vault/forms/${ID8}` && c.init.method === "POST");
  check("a deliberate click on Approve posts {values: {}}", approve.length === 1 && approve[0]!.init.body === JSON.stringify({ values: {} }) && sheetsIn(a.container).length === 0);

  // — two forms at once: the newest on top, the other kept with what was typed —
  const ID9 = "I".repeat(43);
  const ID10 = "J".repeat(43);
  a.socket.push({ type: "form", form: loginForm(ID9) });
  const under = a.container.querySelectorAll(".tw-sheet")[0]!;
  type(under.querySelectorAll("input")[2]!, TYPED);
  a.socket.push({ type: "form", form: { id: ID10, purpose: "unlock", title: "Unlock the vault", detail: "Type the vault's passphrase.", fields: [{ name: "passphrase", label: "Vault passphrase", type: "password", required: true }], submitLabel: "Unlock", expiresAt: Date.now() + 600_000 } });
  const top = sheetsIn(a.container);
  check("a second form shows on top; the first waits behind it with what was typed", top.length === 1 && top[0]!.querySelector(".tw-sheet-title")!.textContent === "Unlock the vault" && under.hidden === true && under.querySelectorAll("input")[2]!.value === TYPED && frame.inert === true);
  answer = () => ({ status: 403, body: { error: "That isn't the vault's passphrase.", code: "wrong-passphrase" } });
  const phrase = top[0]!.querySelector("input")!;
  type(phrase, "a wrong passphrase");
  key("Enter");
  await wait(20);
  check("a wrong passphrase: the engine's sentence is shown, the field is emptied, the sheet stays", top[0]!.querySelector(".tw-sheet-field-error")!.textContent === "That isn't the vault's passphrase." && phrase.value === "" && sheetsIn(a.container)[0] === top[0]);
  answer = () => ({ status: 429, body: { error: "Too many wrong passphrases. Wait a little, then try again.", code: "wait", retryAfterMs: 30_000 } });
  type(phrase, "another wrong one");
  key("Enter");
  await wait(20);
  check("too many tries: the wait is shown and Unlock is disabled for it", top[0]!.querySelector(".tw-sheet-primary")!.disabled === true && /Wait a little/.test(top[0]!.textContent));
  a.socket.push({ type: "form_closed", id: ID10, status: "submitted" });
  check("when it ends, the first form is back, as it was", sheetsIn(a.container)[0] === under && under.querySelectorAll("input")[2]!.value === TYPED);

  // — a reconnect —
  a.socket.drop();
  await wait(900);
  const again = Socket.all[Socket.all.length - 1]!;
  again.up();
  again.push({ type: "snapshot", snapshot: { ...SNAP, epoch: "e1", version: 2 } });
  again.push({ type: "form", form: loginForm(ID9) });
  await wait(1700);
  check("after a reconnect, a form the engine announces again stays, with what was typed", again !== a.socket && sheetsIn(a.container)[0] === under && under.querySelectorAll("input")[2]!.value === TYPED);
  again.drop();
  await wait(900);
  const third = Socket.all[Socket.all.length - 1]!;
  third.up();
  third.push({ type: "snapshot", snapshot: { ...SNAP, epoch: "e2", version: 0 } });
  await wait(1700);
  check("…and one it doesn't (the engine restarted) is taken down, blanked", third !== again && sheetsIn(a.container).length === 0 && under.querySelectorAll("input").every((i) => i.value === "") && frame.inert === false);

  // — the view goes away —
  third.push({ type: "form", form: loginForm("K".repeat(43)) });
  const lastSheet = sheetsIn(a.container)[0]!;
  const lastPass = lastSheet.querySelectorAll("input")[2]!;
  type(lastPass, TYPED);
  const deletes = calls.filter((c) => c.init.method === "DELETE").length;
  a.handle.destroy();
  check("destroying the view blanks and removes its sheets, and leaves the form open in the engine", lastPass.value === "" && lastSheet.parentNode === null && calls.filter((c) => c.init.method === "DELETE").length === deletes);

  // — the embedded pane (no title bar), and an engine that isn't this page's own —
  const b = await mount({});
  b.socket.push({ type: "form", form: loginForm("L".repeat(43)) });
  check("the app's embedded pane draws the same sheet", sheetsIn(b.container).length === 1 && b.container.querySelector(".tw-sheet-flag") === null && b.container.querySelector("iframe")!.inert === true);
  b.handle.destroy();
  const c = await mount({ url: "ws://localhost:9999/ws/workspace" });
  c.socket.push({ type: "form", form: loginForm("M".repeat(43)) });
  check("a view on another engine's socket draws no form: what is typed only ever goes to this page's own origin", sheetsIn(c.container).length === 0);
  c.handle.destroy();
  const d = await mount({});
  d.socket.push({ type: "form", form: { id: "short", purpose: "save-login", title: "x", fields: [] } });
  d.socket.push({ type: "form", form: { ...loginForm("N".repeat(43)), purpose: "something-else" } });
  check("a descriptor with a malformed ticket or an unknown purpose is ignored", sheetsIn(d.container).length === 0);

  // — the asset fetcher —
  const fetchedBefore = calls.length;
  d.socket.push({
    type: "template",
    version: 5,
    title: "Board",
    template: { id: "custom@1", kind: "custom", name: "t", source: "<script>window.render=function(){}</script>" },
    state: {
      cards: [
        { url: "/api/images/abcdef123.png", status: "ready" },
        { url: "/api/images/../browser", status: "ready" },
        { url: "/api/images/../../api/vault", status: "ready" },
        { url: "/api/audio/clip01.mp3/../../memory", status: "ready" },
        { url: "/api/videos/vid001.mp4?x=/../", status: "ready" },
        { html: `<img src="/api/images/hero12345.jpg"> <img src="/api/images/hero12345.jpg/../../browser"> <img src="/api/images/..%2Fbrowser">` },
      ],
    },
  });
  const appFrame = d.container.querySelectorAll("iframe").pop()!;
  fire(doc.body, "message"); // (not from a frame: ignored)
  win.run({ type: "message", source: appFrame.contentWindow, data: { type: "ready" } });
  await wait(30);
  const fetched = calls.slice(fetchedBefore).map((c) => c.url);
  check("the asset fetcher asks only for the engine's own file names", JSON.stringify(fetched.sort()) === JSON.stringify([`${ORIGIN}/api/images/abcdef123.png`, `${ORIGIN}/api/images/hero12345.jpg`]), fetched.join(" "));
  d.handle.destroy();

  // — a browser that can't mask a text field: password fields, kept from its password manager as well as they can be —
  if (viewMasksText) {
    Object.assign(globalThis, { CSS: cssWith(false) });
    const e = await mount({});
    e.socket.push({ type: "form", form: loginForm("O".repeat(43)) });
    const [, , p, s] = sheetsIn(e.container)[0]!.querySelectorAll("input");
    const t = sheetsIn(e.container)[0]!.querySelector(".tw-sheet-toggle")!;
    const before = p!.type === "password" && s!.type === "password" && p!.getAttribute("autocomplete") === "new-password";
    press(t);
    const open = p!.type === "text";
    press(t);
    check("where text can't be masked: password fields (new-password), and Show / Hide switches the type", before && open && p!.type === "password");
    e.handle.destroy();
    Object.assign(globalThis, { CSS: cssWith(true) });
  }

  // — Settings → Vault: what is typed there is masked the same way —
  const settingsPage = await import(new URL("../web/src/settings/vault.ts", import.meta.url).href);
  const settingsField = (canMask: boolean) => {
    Object.assign(globalThis, { CSS: cssWith(canMask) });
    const { el, input } = settingsPage.secretInput({ label: "Password" }) as { el: El; input: El };
    const toggle = el.querySelector("button")!;
    const state = () => ({ type: input.type, mask: input.style.getPropertyValue(TEXT_MASK), label: toggle.textContent, pressed: toggle.getAttribute("aria-pressed") });
    const start = { ...state(), autocomplete: input.getAttribute("autocomplete") };
    press(toggle);
    const shownNow = state();
    press(toggle);
    return { start, shown: shownNow, hidden: state() };
  };
  const canMask = settingsField(true);
  check(
    "Settings → Vault, where text can be masked: a text field drawn as dots (no password field for the browser to save); Show / Hide lifts and restores the mask",
    canMask.start.type === "text" && canMask.start.mask === "disc" && canMask.start.autocomplete === "off" && canMask.shown.type === "text" && canMask.shown.mask === "none" && canMask.shown.label === "Hide" && canMask.shown.pressed === "true" && canMask.hidden.mask === "disc" && canMask.hidden.label === "Show",
    JSON.stringify(canMask),
  );
  const cannot = settingsField(false);
  check("…and where it can't: a password field (new-password), Show / Hide switches its type", cannot.start.type === "password" && cannot.start.mask === "" && cannot.start.autocomplete === "new-password" && cannot.shown.type === "text" && cannot.hidden.type === "password", JSON.stringify(cannot));
  Object.assign(globalThis, { CSS: cssWith(true) });

  console.log(`SHEET DONE pass=${passed} fail=${failed}`);
  process.exit(failed ? 1 : 0);
}
