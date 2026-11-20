import { vault } from "./instance.js";
import { DEFAULT_SPENDING_LIMIT } from "./store.js";

/*
 * The vault's settings that other tools read. (The facade in index.ts has a fixed set of names; this sits beside it.)
 */

export { DEFAULT_SPENDING_LIMIT };

/**
 * The spending limit (Settings → Vault; 200 until it is changed), in the currency of the page being paid on: a card
 * fill on a page whose total is above it — or can't be read — needs approval in a "confirm" secure form.
 * 0 means: always ask in the form.
 */
export function spendingLimit(): number {
  try {
    return vault().settings().spendingLimit;
  } catch {
    return 0; // if it can't be read, every fill asks
  }
}
