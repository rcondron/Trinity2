import type { Tool } from "../src/types.js";

/**
 * Example skill — a dice roller (handy when Trinity is a D&D game master).
 * This demonstrates the skills-library convention: a *.skill.ts module whose
 * default export is a Tool. Morph-authored skills land here for future routing.
 */
const dice: Tool = {
  name: "roll_dice",
  description: "Roll dice in standard notation, e.g. 2d6+3 or d20.",
  input: {
    notation: { type: "string", description: "Dice notation like 2d6+3 or d20", required: true },
  },
  async run(args) {
    const notation = String(args.notation ?? "d20").toLowerCase().replace(/\s/g, "");
    const m = notation.match(/^(\d*)d(\d+)([+-]\d+)?$/);
    if (!m) return { ok: false, error: `I couldn't read "${notation}" as dice.` };
    const count = Number(m[1] || "1");
    const sides = Number(m[2]);
    const mod = Number(m[3] || "0");
    if (count > 100 || sides > 1000) return { ok: false, error: "That's a lot of dice — keep it reasonable." };
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    return {
      ok: true,
      say: `${notation} → ${total}${count > 1 || mod ? ` (${rolls.join(", ")}${mod ? ` ${m[3]}` : ""})` : ""}`,
      data: { rolls, mod, total },
    };
  },
};

export default dice;
