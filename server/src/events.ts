import type { Persona } from "./types.js";

/**
 * Tiny in-process hooks so features can react to engine-wide events without the
 * transports importing them (e.g. the game module re-presents a persona's active game
 * when that persona is activated).
 */
type PersonaListener = (persona: Persona) => void;
const personaListeners = new Set<PersonaListener>();

export function onPersonaActivated(cb: PersonaListener): () => void {
  personaListeners.add(cb);
  return () => personaListeners.delete(cb);
}

export function emitPersonaActivated(persona: Persona): void {
  for (const cb of personaListeners) {
    try {
      cb(persona);
    } catch (err) {
      console.warn("[events] persona listener failed:", (err as Error).message);
    }
  }
}
