import { config, live } from "../config.js";
import type { Persona } from "../types.js";

/**
 * Voice — NVIDIA PersonaPlex (full-duplex speech-to-speech model).
 *
 * Transport reality (verified 2026-10-31): the fal.ai endpoint is TURN-BASED and
 * marked DEPRECATED. You submit one audio clip (the user's speech) + a persona
 * prompt, and get back one WAV (Trinity's reply) + its transcript. True streaming
 * full-duplex is not exposed through fal. The durable path is self-hosting
 * PersonaPlex (Runpod) and pointing PERSONAPLEX_URL at it — this client's request
 * shape is reusable there (adjust the auth header).
 *
 * Modes:
 *  - LIVE  (FAL_KEY set): `personaplexTurn` runs a turn through the endpoint.
 *  - MOCK  (no FAL_KEY): the browser does speech via the Web Speech API; the
 *    engine never calls this. See web/src/speech.ts.
 */
export function voiceMode(): "live" | "mock" {
  return live.voice ? "live" : "mock";
}

const VOICE_ENUM = /^(NAT|VAR)[FM]\d$/;
function resolveVoice(personaVoice: string): string {
  return VOICE_ENUM.test(personaVoice) ? personaVoice : config.fal.defaultVoice;
}

export interface VoiceTurn {
  audioUrl: string; // WAV (24kHz) hosted URL of Trinity's reply
  text: string; // transcript of Trinity's reply
  duration?: number;
}

/**
 * Run one speech turn through PersonaPlex.
 * @param audioUrl the user's speech — a public URL or a base64 data: URI.
 */
export async function personaplexTurn(audioUrl: string, persona: Persona): Promise<VoiceTurn> {
  if (!live.voice) throw new Error("Voice not configured (FAL_KEY missing)");

  const prompt =
    persona.description +
    (Object.keys(persona.traits).length ? `\nTraits: ${JSON.stringify(persona.traits)}` : "");

  const res = await fetch(config.fal.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${config.fal.key}`,
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      prompt,
      voice: resolveVoice(persona.voice),
    }),
  });
  if (!res.ok) throw new Error(`PersonaPlex ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as {
    audio: string | { url: string };
    text: string;
    duration?: number;
  };
  return {
    audioUrl: typeof data.audio === "string" ? data.audio : data.audio?.url,
    text: data.text ?? "",
    duration: data.duration,
  };
}
