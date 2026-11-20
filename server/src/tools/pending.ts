import { answerPending, pendingQuestion } from "../agent/pending.js";
import type { Tool } from "../types.js";
import { registerTool } from "./registry.js";

/**
 * answer_question: the user's yes or no to the question Trinity just asked (agent/pending.ts). Offered only while a
 * question is waiting, and only to the user's own words.
 */
const answerQuestion: Tool = {
  name: "answer_question",
  description:
    "The user answers the yes-or-no question Trinity just asked: yes, no, go ahead, confirm, cancel, never mind (only while a question is waiting).",
  input: {},
  argMode: "raw",
  source: "builtin",
  sensitive: true,
  available: () => pendingQuestion() !== null,
  async run(_args, ctx) {
    return answerPending(ctx.userWords ?? ctx.utterance);
  },
};

export function registerPendingTools(): void {
  registerTool(answerQuestion);
}
