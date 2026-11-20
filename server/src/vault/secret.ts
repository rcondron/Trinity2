import { inspect } from "node:util";
import { VaultError } from "./errors.js";

/**
 * Keeping secrets from printing by accident.
 *
 *  - `Secret` wraps one value (a passphrase on its way to the key derivation, a one-time security code): String(x),
 *    `${x}`, x + "", JSON.stringify(x), util.inspect(x) and console.log(x) all give "[secret]". Only expose() gives
 *    the value, and it is called in exactly the places that seal it or use it.
 *  - `guard(values)` does the same for the object a caller is handed inside useSecret / useOneTime: its fields read as
 *    the real strings (that is what the fill needs), but the object as a whole prints, serializes and inspects as
 *    "[secret]", and once the call is over revoke() empties it — a reference kept by mistake reads nothing.
 *
 * What this cannot do: a string a caller copies out of a field is an ordinary string. The vault therefore also checks
 * what the caller returns and throws (holds(), below) before it lets the result out.
 */
export const MASK = "[secret]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The value itself: only where it is sealed into the store or used. */
  expose(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [Symbol.toPrimitive](): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}

const viewProto: object = Object.freeze({
  toString(): string {
    return MASK;
  },
  toJSON(): string {
    return MASK;
  },
  [Symbol.toPrimitive](): string {
    return MASK;
  },
  [inspect.custom](): string {
    return MASK;
  },
});

export interface Guarded<T> {
  /** What the caller gets: fields read as their values until revoke(). */
  view: Readonly<T>;
  /** Empty it: every field then throws. */
  revoke(): void;
}

const GONE = "That secret is no longer available: it can only be used inside the vault call that handed it out.";

/** A read-only view of `values` that prints as "[secret]" and can be emptied (see the module comment). */
export function guard<T extends object>(values: T): Guarded<T> {
  let live: Record<string, unknown> | null = { ...(values as Record<string, unknown>) };
  const view = Object.create(viewProto) as Record<string, unknown>;
  for (const key of Object.keys(live)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: false,
      get(): unknown {
        if (!live) throw new VaultError("gone", GONE);
        return live[key];
      },
    });
  }
  Object.freeze(view);
  return {
    view: view as Readonly<T>,
    revoke(): void {
      if (!live) return;
      for (const key of Object.keys(live)) live[key] = undefined;
      live = null;
    },
  };
}

/** Long enough to look for without false alarms: eight characters, or six when it isn't only digits. */
const searchable = (s: string): boolean => s.length >= 8 || (s.length >= 6 && !/^\d+$/.test(s));

/** The strings to look for when checking that `secrets` didn't get out (a card number also in its grouped spellings). */
export function needlesOf(secrets: Iterable<unknown>): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== "string" || !searchable(s)) continue;
    out.add(s);
    if (/^\d{12,19}$/.test(s)) {
      const groups = s.match(/.{1,4}/g) ?? [];
      out.add(groups.join(" "));
      out.add(groups.join("-"));
    }
  }
  return [...out];
}

/**
 * Does `value` hold any of `needles` — anywhere inside it: a string, an object's fields, an array, a Map or a Set, an
 * error's message, stack and cause, bytes? Bounded, and safe on cycles and on getters that throw.
 */
export function holds(value: unknown, needles: readonly string[]): boolean {
  if (!needles.length) return false;
  const seen = new WeakSet<object>();
  let budget = 20_000;
  const hit = (s: string): boolean => needles.some((n) => s.includes(n));
  const walk = (v: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 12) return false;
    if (typeof v === "string") return hit(v);
    if (typeof v === "number" || typeof v === "bigint") return hit(String(v));
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return false;
    const obj = v as object;
    if (seen.has(obj)) return false;
    seen.add(obj);
    try {
      if (obj instanceof Secret) return false;
      if (ArrayBuffer.isView(obj)) {
        const bytes = Buffer.from(obj.buffer, obj.byteOffset, obj.byteLength);
        return needles.some((n) => bytes.includes(n, 0, "utf8") || bytes.includes(n, 0, "utf16le"));
      }
      if (obj instanceof Error) {
        if (hit(String(obj.message)) || hit(String(obj.stack ?? "")) || walk((obj as { cause?: unknown }).cause, depth + 1)) return true;
      }
      if (obj instanceof Map) {
        for (const [k, x] of obj) if (walk(k, depth + 1) || walk(x, depth + 1)) return true;
        return false;
      }
      if (obj instanceof Set) {
        for (const x of obj) if (walk(x, depth + 1)) return true;
        return false;
      }
      for (const key of Reflect.ownKeys(obj)) {
        if (typeof key === "string" && hit(key)) return true;
        let x: unknown;
        try {
          x = (obj as Record<string | symbol, unknown>)[key];
        } catch {
          continue; // a getter that throws (a revoked view) holds nothing
        }
        if (walk(x, depth + 1)) return true;
      }
    } catch {
      return false;
    }
    return false;
  };
  return walk(value, 0);
}
