import { nanoid } from "nanoid";
import {
  getActivePersona,
  listPersonas,
  listTasks,
  savePersona,
  saveTask,
  setActivePersona,
} from "./sqlite.js";
import type { MemoryStore } from "./memory.js";

/** Default Trinity persona — the prompt that defines who she is and how she sounds. */
const DEFAULT_PERSONA = {
  id: "trinity",
  name: "Trinity",
  description: [
    "You are Trinity: a warm, quick-witted voice companion and maker.",
    "You speak naturally and conversationally — short, human sentences, not essays.",
    "You can build things as you talk: UIs, notes, tools, research. When you make",
    "something, say what you made in a sentence and let the workspace show it.",
    "You remember what matters about the person you're talking to and bring it up",
    "naturally. You are curious, direct, and never robotic.",
  ].join(" "),
  voice: "NAT-01", // PersonaPlex NAT voice preset (natural set)
  traits: {
    tone: "warm, playful, concise",
    pace: "relaxed but responsive",
    role: "general companion & maker (swappable per end-use)",
  },
};

export async function seed(memory: MemoryStore): Promise<void> {
  if (listPersonas().length === 0) {
    savePersona({ ...DEFAULT_PERSONA, updatedAt: Date.now() });
    setActivePersona(DEFAULT_PERSONA.id);
    console.log("[seed] created default Trinity persona");
  }

  if (listTasks().length === 0) {
    const now = Date.now();
    saveTask({
      id: nanoid(10),
      title: "Idle check-in",
      instruction:
        "If the user has been quiet for a while and there's an open thread from the conversation, offer a gentle, optional nudge or follow-up.",
      intervalSec: 300,
      nextRunAt: now + 300_000,
      lastRunAt: null,
      enabled: false, // off by default so Trinity isn't chatty out of the gate
    });
    console.log("[seed] created sample heartbeat task");
  }

  const existing = await memory.recent(1);
  if (existing.length === 0) {
    await memory.put({
      _id: nanoid(12),
      type: "note",
      text: "Trinity is an engine that can become a D&D game master, personal assistant, CPA, travel agent, or video producer by swapping personas.",
      tags: ["trinity", "project", "about"],
      salience: 0.6,
      ts: Date.now(),
    });
    console.log("[seed] wrote first memory");
  }

  // touch active persona to validate it loads
  getActivePersona();
}
