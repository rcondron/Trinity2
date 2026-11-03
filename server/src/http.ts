import path from "node:path";
import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { ROOT } from "./config.js";
import { serviceStatus, getEndpoints, publicEndpoints, setEndpoints, type Endpoints } from "./settings.js";
import { deletePersona, getActivePersona, getPersona, getProfileName, listPersonas, savePersona, setActivePersona } from "./db/sqlite.js";
import type { MemoryStore } from "./db/memory.js";
import { browserState, browserToken, rotateBrowserToken } from "./services/browser-bridge.js";
import { imagesRouter } from "./services/images.js";
import { audioRouter } from "./services/speech.js";
import { videosRouter } from "./services/videos.js";
import { voicesRouter } from "./services/voices-routes.js";
import { gamesRouter } from "./game/routes.js";
import { heartbeatRouter } from "./routes/heartbeat.js";
import { memoryRouter } from "./routes/memory.js";
import { skillsRouter } from "./routes/skills.js";
import { emitPersonaActivated } from "./events.js";
import { mordiemModels } from "./services/llm.js";
import { ah, isAllowedOrigin } from "./util/bg.js";
import { workspace, type ToastTone, type WorkspaceTemplate } from "./workspace/bus.js";
import type { Persona } from "./types.js";

const VOICE_RE = /^((NAT|VAR)[FM]\d|custom:[a-z0-9][a-z0-9_-]{0,63})$/;
/** Persona field limits (characters / entries). The Settings editor enforces the same ones. */
const PERSONA_LIMITS = { name: 80, description: 6000, voicePrompt: 200, toolsets: 10, traits: 30, traitName: 40, traitValue: 200 };

/** The first field of `p` over PERSONA_LIMITS, as an error naming it — or null. */
function personaLimitError(p: Persona): string | null {
  const L = PERSONA_LIMITS;
  const long = (field: string, text: string, max: number) =>
    text.length > max ? `${field} is too long (${text.length} characters; the limit is ${max})` : null;
  const traits = Object.entries(p.traits);
  return (
    long("name", p.name, L.name) ??
    long("description", p.description, L.description) ??
    long("voicePrompt", p.voicePrompt, L.voicePrompt) ??
    (p.toolsets.length > L.toolsets ? `toolsets has ${p.toolsets.length} entries; the limit is ${L.toolsets}` : null) ??
    (traits.length > L.traits ? `traits has ${traits.length} entries; the limit is ${L.traits}` : null) ??
    traits
      .map(([k, v]) => long(`trait name "${k.slice(0, L.traitName)}…"`, k, L.traitName) ?? long(`trait "${k}"`, v, L.traitValue))
      .find((e) => e !== null) ??
    null
  );
}

export interface ApiHooks {
  /** Called after a persona is activated (e.g. reset the text channel's context). */
  onPersonaActivated?: () => void;
}

export function createApi(memory: MemoryStore, hooks: ApiHooks = {}): Router {
  const api = express.Router();
  // Cross-site browser requests may not change anything: only the local app (or a
  // non-browser client, which sends no Origin) can write.
  api.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!isAllowedOrigin(req.get("origin"))) return res.status(403).json({ error: "forbidden origin" });
    next();
  });
  api.use(express.json({ limit: "12mb" }));
  api.use(imagesRouter());
  api.use(audioRouter());
  api.use(videosRouter());

  // ── Workspace ──
  api.get("/workspace", (_req, res) => res.json(workspace.snapshot()));
  // Test hook (TRINITY_TEST_HOOKS=1, localhost only, explicit header): drive the
  // workspace directly so the renderer and templates can be verified without voice.
  api.post("/workspace/_test", (req, res) => {
    if (process.env.TRINITY_TEST_HOOKS !== "1") return res.status(404).json({ error: "not found" });
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (!local || req.get("x-trinity-test") !== "1") return res.status(403).json({ error: "forbidden" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title : "Workspace";
    switch (b.action) {
      case "html":
        workspace.showHtml(String(b.html ?? ""), title);
        break;
      case "app": {
        const template: WorkspaceTemplate = {
          id: typeof b.templateId === "string" ? b.templateId : `test:${Date.now()}`,
          kind: b.kind === "custom" ? "custom" : "default",
          name: typeof b.templateName === "string" ? b.templateName : "test",
          source: String(b.templateSource ?? ""),
        };
        workspace.showApp(template, b.state ?? null, title);
        break;
      }
      case "state":
        workspace.setState(b.state ?? null);
        break;
      case "toast":
        workspace.toast(String(b.text ?? ""), (b.tone as ToastTone) ?? "info");
        break;
      case "activity":
        workspace.activity(String(b.id ?? "test"), typeof b.text === "string" ? b.text : null);
        break;
      case "clear":
        workspace.clear();
        break;
      default:
        return res.status(400).json({ error: "action must be html|app|state|toast|activity|clear" });
    }
    res.json({ ok: true, version: workspace.snapshot().version });
  });

  // The user's name too: the voice hears it when a call connects, so the app re-warms when it changes.
  api.get("/status", (_req, res) => {
    res.json({ services: serviceStatus(), persona: getActivePersona(), profileName: getProfileName() });
  });

  // ── Endpoints & models (Settings page) ──
  api.get("/settings/endpoints", (_req, res) => res.json(publicEndpoints()));
  api.put("/settings/endpoints", (req, res) => {
    setEndpoints((req.body ?? {}) as Partial<Endpoints>);
    workspace.setOverlays(getEndpoints().workspaceOverlays); // every open workspace window follows at once
    res.json(publicEndpoints());
  });
  // Model ids the gateway offers, for the Settings model pickers ({text: [...], image: [...]}).
  api.get("/settings/models", ah(async (_req, res) => res.json(await mordiemModels())));
  // The Chrome extension: connection state, its tabs, and the pairing token (Settings → Browser extension).
  api.get("/browser", (_req, res) => res.json({ ...browserState(), token: browserToken(), extensionDir: path.join(ROOT, "extension") }));
  api.post("/browser/token", (_req, res) => res.json({ token: rotateBrowserToken() }));
  // Voice library (built-in presets + custom samples synced to the pod) and saved games.
  api.use(voicesRouter());
  api.use(gamesRouter());
  // Tool groups a persona can be given (Settings → Personas).
  api.get("/toolsets", (_req, res) =>
    res.json([
      {
        id: "game",
        label: "Game Master tools",
        description: "Run tabletop adventures: guided setup, the party, items, NPCs, scenes, dice, narration, saved games",
      },
    ]),
  );

  // ── Personas ──
  api.get("/personas", (_req, res) => res.json(listPersonas()));
  api.get("/personas/:id", (req, res) => {
    const p = getPersona(req.params.id);
    return p ? res.json(p) : res.status(404).json({ error: "not found" });
  });
  // Create or update (merge): fields that aren't sent keep their current values. A field over
  // PERSONA_LIMITS is refused by name, never cut short (the editor would keep showing the lost text).
  const upsertPersona = (id: string | undefined, b: Partial<Persona>): Persona | { error: string } => {
    const existing = id ? getPersona(id) : null;
    const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
    const voice = str(b.voice, existing?.voice ?? "NATF2").trim();
    if (b.voice !== undefined && !VOICE_RE.test(voice)) return { error: `unknown voice "${voice}"` };
    const persona: Persona = {
      id: existing?.id ?? (id || nanoid(8)),
      name: str(b.name, existing?.name ?? "Unnamed").trim() || "Unnamed",
      description: str(b.description, existing?.description ?? ""),
      voicePrompt: str(b.voicePrompt, existing?.voicePrompt ?? "").trim(),
      voice: VOICE_RE.test(voice) ? voice : "NATF2",
      toolsets: Array.isArray(b.toolsets) ? b.toolsets.map(String) : (existing?.toolsets ?? []),
      traits:
        b.traits && typeof b.traits === "object"
          ? Object.fromEntries(Object.entries(b.traits).map(([k, v]) => [String(k), String(v)]))
          : (existing?.traits ?? {}),
      updatedAt: Date.now(),
    };
    const overLimit = personaLimitError(persona);
    if (overLimit) return { error: overLimit };
    // PersonaPlex hangs on an empty prompt — a persona needs at least one of the two.
    if (!persona.voicePrompt && !persona.description.trim()) return { error: "give the persona a voice prompt or a description" };
    savePersona(persona);
    return persona;
  };
  api.post("/personas", (req, res) => {
    const b = (req.body ?? {}) as Partial<Persona>;
    const out = upsertPersona(b.id, b);
    if ("error" in out) return res.status(400).json(out);
    res.json(out);
  });
  api.put("/personas/:id", (req, res) => {
    if (!getPersona(req.params.id)) return res.status(404).json({ error: "not found" });
    const out = upsertPersona(req.params.id, (req.body ?? {}) as Partial<Persona>);
    if ("error" in out) return res.status(400).json(out);
    res.json(out);
  });
  api.delete("/personas/:id", (req, res) => {
    const all = listPersonas();
    if (!all.some((p) => p.id === req.params.id)) return res.status(404).json({ error: "not found" });
    if (all.length <= 1) return res.status(400).json({ error: "can't delete the last persona" });
    const wasActive = getActivePersona().id === req.params.id;
    deletePersona(req.params.id);
    if (wasActive) setActivePersona(listPersonas()[0]!.id);
    res.json({ ok: true, active: getActivePersona().id });
  });
  api.post("/personas/:id/activate", (req, res) => {
    if (!getPersona(req.params.id)) return res.status(404).json({ error: "not found" });
    setActivePersona(req.params.id);
    const persona = getActivePersona();
    hooks.onPersonaActivated?.();
    emitPersonaActivated(persona);
    res.json({ ok: true, persona });
  });

  // ── Heartbeat, memory, skills ──
  api.use(heartbeatRouter());
  api.use(memoryRouter(memory));
  api.use(skillsRouter());

  // JSON errors instead of Express's HTML stack page (and never an unhandled rejection).
  api.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status ?? (err.type === "entity.too.large" ? 413 : 500);
    if (status >= 500) console.warn("[api]", err.message);
    res.status(status).json({ error: status === 413 ? "upload too large" : err.message });
  });

  return api;
}
