import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { serviceStatus } from "./config.js";
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
import { getTools } from "./tools/registry.js";
import type { HeartbeatTask, Persona } from "./types.js";

export function createApi(memory: MemoryStore): Router {
  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));

  api.get("/status", (_req, res) => {
    res.json({ services: serviceStatus(), persona: getActivePersona() });
  });

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

  return api;
}
