import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { serviceStatus, publicEndpoints, setEndpoints, type Endpoints } from "./settings.js";
import {
  deleteTask,
  getActivePersona,
  getPersona,
  listPersonas,
  listTasks,
  savePersona,
  saveTask,
  setActivePersona,
} from "./db/sqlite.js";
import type { MemoryStore } from "./db/memory.js";
import { getTools, loadSkillFile } from "./tools/registry.js";
import { approveSkill, discardSkill, listPending } from "./services/skill-forge.js";
import type { HeartbeatTask, Persona } from "./types.js";

export function createApi(memory: MemoryStore): Router {
  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));

  api.get("/status", (_req, res) => {
    res.json({ services: serviceStatus(), persona: getActivePersona() });
  });

  // ── Endpoints & models (Settings page) ──
  api.get("/settings/endpoints", (_req, res) => res.json(publicEndpoints()));
  api.put("/settings/endpoints", (req, res) => {
    setEndpoints((req.body ?? {}) as Partial<Endpoints>);
    res.json(publicEndpoints());
  });
  // Available PersonaPlex voice presets (for the voice picker).
  api.get("/voices", (_req, res) =>
    res.json([
      "NATF0", "NATF1", "NATF2", "NATF3", "NATM0", "NATM1", "NATM2", "NATM3",
      "VARF0", "VARF1", "VARF2", "VARF3", "VARF4", "VARM0", "VARM1", "VARM2", "VARM3", "VARM4",
    ]),
  );

  // ── Personas ──
  api.get("/personas", (_req, res) => res.json(listPersonas()));
  api.get("/personas/:id", (req, res) => {
    const p = getPersona(req.params.id);
    return p ? res.json(p) : res.status(404).json({ error: "not found" });
  });
  api.post("/personas", (req, res) => {
    const b = req.body as Partial<Persona>;
    const persona: Persona = {
      id: b.id || nanoid(8),
      name: b.name || "Unnamed",
      description: b.description || "",
      voice: b.voice || "NAT-01",
      traits: b.traits || {},
      updatedAt: Date.now(),
    };
    savePersona(persona);
    res.json(persona);
  });
  api.post("/personas/:id/activate", (req, res) => {
    if (!getPersona(req.params.id)) return res.status(404).json({ error: "not found" });
    setActivePersona(req.params.id);
    res.json({ ok: true, persona: getActivePersona() });
  });

  // ── Heartbeat tasks ──
  api.get("/heartbeat", (_req, res) => res.json(listTasks()));
  api.post("/heartbeat", (req, res) => {
    const b = req.body as Partial<HeartbeatTask>;
    const intervalSec = Number(b.intervalSec) > 0 ? Number(b.intervalSec) : 1800;
    const task: HeartbeatTask = {
      id: nanoid(10),
      title: b.title || "Recurring task",
      instruction: b.instruction || "",
      intervalSec,
      nextRunAt: Date.now() + intervalSec * 1000,
      lastRunAt: null,
      enabled: b.enabled ?? true,
    };
    saveTask(task);
    res.json(task);
  });
  api.put("/heartbeat/:id", (req, res) => {
    const existing = listTasks().find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const merged: HeartbeatTask = { ...existing, ...(req.body as Partial<HeartbeatTask>), id: existing.id };
    saveTask(merged);
    res.json(merged);
  });
  api.delete("/heartbeat/:id", (req, res) => {
    deleteTask(req.params.id);
    res.json({ ok: true });
  });

  // ── Memory ──
  api.get("/memory", async (_req, res) => res.json(await memory.recent(50)));

  // ── Tools / skills ──
  api.get("/skills", (_req, res) =>
    res.json(getTools().map((t) => ({ name: t.name, description: t.description, source: t.source ?? "builtin" }))),
  );
  api.get("/skills/pending", (_req, res) =>
    res.json(listPending().map((s) => ({ name: s.name, description: s.description, source: s.source }))),
  );
  api.post("/skills/:name/approve", async (req, res) => {
    try {
      const dest = approveSkill(req.params.name);
      const name = await loadSkillFile(dest);
      if (!name) return res.status(400).json({ error: "approved file did not load as a valid skill" });
      res.json({ ok: true, name });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
  api.post("/skills/:name/discard", (req, res) => {
    discardSkill(req.params.name);
    res.json({ ok: true });
  });

  return api;
}
