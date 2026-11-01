import express, { type NextFunction, type Request, type Response, type Router } from "express";
import {
  approveSkill,
  deleteForged,
  discardSkill,
  forgedSource,
  forgeSkill,
  listForged,
  listPending,
  setForgedEnabled,
  SkillError,
  testForged,
  type ForgedSkill,
} from "../services/skill-forge.js";
import { getTools, toolSource } from "../tools/registry.js";
import { ah } from "../util/bg.js";

/**
 * Skills API (mounted under /api): the tools Jev can route to — built-in, hand-written skills,
 * toolset tools (e.g. Game Master), and skills Trinity created on the fly ("forged": these can
 * be switched off, tested, read, deleted, and — with approval "manual" — approved).
 */
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A forged skill as the Skills API lists it (`problem` says why it can't be used right now). */
function forgedInfo(s: ForgedSkill) {
  return {
    name: s.name,
    description: s.description,
    source: "forged" as const,
    toolset: null,
    // A skill that can't load isn't really on, whatever its switch says (`problem` says why).
    enabled: s.enabled && !s.problem,
    createdAt: s.createdAt,
    need: s.need,
    model: s.model,
    input: s.input,
    examples: s.examples,
    ...(s.problem ? { problem: s.problem } : {}),
  };
}

/** Registered tools (forged ones as their records) plus forged skills that are switched off. */
function listSkills() {
  const out: Record<string, unknown>[] = getTools()
    .filter((t) => toolSource(t) !== "forged")
    .map((t) => ({ name: t.name, description: t.description, source: toolSource(t), toolset: t.toolset ?? null, enabled: true, input: t.input }));
  return [...out, ...listForged().map(forgedInfo)];
}

function nameParam(req: Request): string {
  const name = String(req.params.name ?? "");
  if (!NAME_RE.test(name)) throw new SkillError(`no skill Trinity created is named ${name.slice(0, 64)}`, 404);
  return name;
}

export function skillsRouter(): Router {
  const r = express.Router();

  r.get("/skills", (_req, res) => res.json(listSkills()));

  // ── Waiting for approval (skill approval "manual"); `source` is the module's code, for review ──
  r.get("/skills/pending", (_req, res) =>
    res.json(
      listPending().map((s) => ({
        name: s.name,
        description: s.description,
        source: forgedSource(s.name) ?? "",
        createdAt: s.createdAt,
        need: s.need,
        model: s.model,
        input: s.input,
        examples: s.examples,
        ...(s.problem ? { problem: s.problem } : {}),
      })),
    ),
  );

  // Create one from Settings: the same pipeline as create_skill (≈15–60 s; skills are made one at a time).
  r.post(
    "/skills/forge",
    ah(async (req, res) => {
      const need = typeof req.body?.need === "string" ? req.body.need.trim() : "";
      if (!need) return res.status(400).json({ error: "say what the skill should do (need)" });
      if (need.length > 2000) return res.status(400).json({ error: "need is too long (2000 characters at most)" });
      const out = await forgeSkill(need);
      res.json(out.ok ? { ok: true, skill: forgedInfo(out.skill), pending: out.skill.pending } : { ok: false, reason: out.reason });
    }),
  );

  r.get(
    "/skills/:name/source",
    ah((req, res) => {
      const name = nameParam(req);
      const source = forgedSource(name);
      if (source === null) throw new SkillError(`no skill Trinity created is named ${name}`, 404);
      res.json({ name, source });
    }),
  );
  r.post(
    "/skills/:name/enable",
    ah(async (req, res) => res.json({ ok: true, skill: forgedInfo(await setForgedEnabled(nameParam(req), true)) })),
  );
  r.post(
    "/skills/:name/disable",
    ah(async (req, res) => res.json({ ok: true, skill: forgedInfo(await setForgedEnabled(nameParam(req), false)) })),
  );
  r.delete(
    "/skills/:name",
    ah((req, res) => {
      deleteForged(nameParam(req));
      res.json({ ok: true });
    }),
  );
  r.post(
    "/skills/:name/test",
    ah(async (req, res) => {
      const name = nameParam(req);
      const args = req.body?.args;
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))
        return res.status(400).json({ error: "args must be an object" });
      const { result, ms } = await testForged(name, (args ?? {}) as Record<string, unknown>);
      res.json({ ok: result.ok, result, ms });
    }),
  );
  r.post(
    "/skills/:name/approve",
    ah(async (req, res) => {
      const skill = await approveSkill(nameParam(req));
      res.json({ ok: true, skill: forgedInfo(skill), name: skill.name });
    }),
  );
  r.post(
    "/skills/:name/discard",
    ah((req, res) => {
      discardSkill(nameParam(req));
      res.json({ ok: true });
    }),
  );

  // Lifecycle refusals carry their own status (404 unknown, 409 can't be enabled/approved).
  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SkillError) return res.status(err.status).json({ error: err.message });
    next(err);
  });

  return r;
}
