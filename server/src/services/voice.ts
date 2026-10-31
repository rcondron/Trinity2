import { live } from "../config.js";

/**
 * Voice (NVIDIA PersonaPlex, full-duplex speech-to-speech).
 *
 * Two modes:
 *  - LIVE  (FAL_KEY set): the browser streams mic PCM → engine → PersonaPlex on
 *    fal.ai, and PersonaPlex streams back Trinity's speech audio + a transcript.
 *    The bidirectional streaming client is wired here once we have a key to test
 *    against the real endpoint (and later a persistent Runpod pod).
 *  - MOCK  (no FAL_KEY): the BROWSER does speech itself via the Web Speech API
 *    (SpeechRecognition → text in, speechSynthesis → voice out). The engine then
 *    works purely on text turns. This gives a fully usable talking Trinity today
 *    with zero API keys.
 *
 * The engine's orchestrator is identical in both modes — it reasons over text
 * turns — so turning the real voice on later changes only the transport.
 */
export function voiceMode(): "live" | "mock" {
  return live.voice ? "live" : "mock";
}

/** Placeholder for the fal.ai PersonaPlex streaming session (filled when FAL_KEY exists). */
export async function startVoiceSession(): Promise<never> {
  throw new Error(
    "Live PersonaPlex streaming not implemented yet — add FAL_KEY and we'll wire the fal.ai stream.",
  );
}
