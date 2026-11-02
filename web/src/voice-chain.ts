/**
 * Clean-up for the live voice. PersonaPlex speaks through its Mimi codec at about 1.1 kbps, which
 * sounds compressed and distant whatever the speakers; nothing on the pod raises that. What a Web
 * Audio chain can do is make it sit closer: take out the rumble and the boxy low-mids the codec
 * smears, lift presence and air (the signal reaches 12 kHz), even the level out, and hold the peaks.
 * It's a presence chain, not a restoration — the voice stays the model's.
 *
 *   speaker worklet → highpass → de-box → presence → air → compressor → makeup → limiter → out
 *
 * `clarity` is remembered per browser (localStorage "trinity.voiceClarity", on unless turned off),
 * so a listener who prefers the raw voice keeps it.
 */

/** The localStorage key (the main app watches it, so a change in Settings reaches a live call at once). */
export const CLARITY_KEY = "trinity.voiceClarity";
const STORAGE_KEY = CLARITY_KEY;

export interface VoiceChain {
  /** Where the speaker worklet connects. */
  input: AudioNode;
  /** Run the chain (true) or pass the voice straight through (false). */
  setClarity(on: boolean): void;
  readonly clarity: boolean;
}

export function clarityPreferred(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function rememberClarity(on: boolean): void {
  try {
    if (on) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, "off");
  } catch {
    /* private mode, blocked storage */
  }
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, gain = 0, q = 0.9): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.gain.value = gain;
  f.Q.value = q;
  return f;
}

function compressor(ctx: AudioContext, threshold: number, ratio: number, knee: number, attack: number, release: number): DynamicsCompressorNode {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = threshold;
  c.ratio.value = ratio;
  c.knee.value = knee;
  c.attack.value = attack;
  c.release.value = release;
  return c;
}

/** Build the chain into `destination` (the context's output). The worklet connects to `input`. */
export function buildVoiceChain(ctx: AudioContext, destination: AudioNode, clarity = clarityPreferred()): VoiceChain {
  const input = ctx.createGain();
  const makeup = ctx.createGain();
  makeup.gain.value = 1.7; // about +4.5 dB back after the compressor
  const stages: AudioNode[] = [
    filter(ctx, "highpass", 90, 0, 0.7), // rumble and hum below the voice
    filter(ctx, "peaking", 260, -2.5, 1.0), // the codec's boxy low-mids
    filter(ctx, "peaking", 3000, 3, 0.9), // presence: consonants and intelligibility
    filter(ctx, "highshelf", 6500, 3), // air, up to the 12 kHz the signal carries
    compressor(ctx, -20, 2.5, 10, 0.004, 0.15), // evens out the level
    makeup,
    compressor(ctx, -3, 20, 0, 0.001, 0.08), // holds the peaks
  ];
  for (let i = 0; i < stages.length - 1; i++) stages[i]!.connect(stages[i + 1]!);
  stages[stages.length - 1]!.connect(destination);

  let on = false;
  const chain: VoiceChain = {
    input,
    get clarity() {
      return on;
    },
    setClarity(next: boolean) {
      if (next === on) return;
      on = next;
      input.disconnect();
      if (on) input.connect(stages[0]!);
      else input.connect(destination);
    },
  };
  // Start the other way round so the first setClarity makes the connection.
  on = !clarity;
  chain.setClarity(clarity);
  return chain;
}
