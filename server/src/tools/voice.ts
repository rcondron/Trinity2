import {
  describeSpeechRate,
  getSpeechRate,
  parseSpeechRateIntent,
  setSpeechRate,
  SPEECH_RATE_DEFAULT,
} from "../services/speech-rate.js";
import type { Tool } from "../types.js";
import { registerTool } from "./registry.js";

/**
 * Voice playback pace: "talk slower", "speak a bit faster", "normal speed".
 * PersonaPlex's cadence is fixed; the browser applies this rate to streamed PCM / TTS.
 */

const setSpeechRateTool: Tool = {
  name: "set_speech_rate",
  description:
    "Change how fast or slow Trinity talks — slower, faster, a bit quicker, normal speed. Not for making pictures or moving cards.",
  input: {
    rate: {
      type: "string",
      description: "how fast to talk",
      options: {
        slower: "speak more slowly",
        faster: "speak more quickly",
        normal: "back to normal speed",
      },
    },
  },
  argMode: "raw",
  source: "builtin",
  async run(args, ctx) {
    const current = getSpeechRate();
    const fromWords = parseSpeechRateIntent(ctx.utterance, current);
    let next = fromWords;
    const opt = String(args.rate ?? "").toLowerCase();
    if (next == null) {
      if (opt === "slower") next = Math.max(0.7, current - 0.15);
      else if (opt === "faster") next = Math.min(1.4, current + 0.15);
      else if (opt === "normal") next = SPEECH_RATE_DEFAULT;
    }
    if (next == null) {
      return {
        ok: false,
        say: `I'm at ${describeSpeechRate(current)} right now — say slower, faster, or normal speed.`,
      };
    }
    const applied = setSpeechRate(next);
    const say =
      Math.abs(applied - current) < 0.02
        ? `I'm already at ${describeSpeechRate(applied)}.`
        : `Okay — I'll talk ${describeSpeechRate(applied)} from here.`;
    return { ok: true, say, speak: say, data: { rate: applied, before: current } };
  },
};

export function registerVoiceTools(): void {
  registerTool(setSpeechRateTool);
}
