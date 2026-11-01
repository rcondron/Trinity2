import { config } from "../config.js";
import { getEndpoints, live } from "../settings.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one speech turn through PersonaPlex via fal's queue API:
 * submit → poll status until COMPLETED → fetch result.
 * @param audioUrl the user's speech — a public URL or a base64 data: URI.
 */
export async function personaplexTurn(audioUrl: string, persona: Persona): Promise<VoiceTurn> {
  if (!live.voice) throw new Error("Voice not configured (FAL_KEY missing)");

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Key ${getEndpoints().falKey}`,
  };
  const prompt =
    persona.description +
    (Object.keys(persona.traits).length ? `\nTraits: ${JSON.stringify(persona.traits)}` : "");

  // 1. Submit.
  const submit = await fetch(config.fal.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ audio_url: audioUrl, prompt, voice: resolveVoice(persona.voice) }),
  });
  if (!submit.ok) throw new Error(`PersonaPlex submit ${submit.status}: ${await submit.text()}`);
  const { status_url, response_url } = (await submit.json()) as {
    status_url: string;
    response_url: string;
  };

  // 2. Poll status (up to ~2 min).
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await fetch(status_url, { headers });
    const sj = (await s.json()) as { status: string };
    if (sj.status === "COMPLETED") break;
    if (sj.status === "FAILED" || sj.status === "ERROR")
      throw new Error(`PersonaPlex failed: ${JSON.stringify(sj)}`);
    await sleep(1500);
  }

  // 3. Fetch result.
  const r = await fetch(response_url, { headers });
  if (!r.ok) throw new Error(`PersonaPlex result ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as {
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
