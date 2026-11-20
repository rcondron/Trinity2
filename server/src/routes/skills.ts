import express, { type NextFunction, type Request, type Response, type Router } from "express";
import {
  approveSkill,
  archiveSkill,
  deleteForged,
  discardSkill,
  forgedSource,
  forgeSkill,
  listForged,
  listPending,
  repairSkill,
  rollbackSkill,
  setForgedEnabled,
  SkillError,
  skillVersions,
  testForged,
  type ForgedSkill,
} from "../services/skill-forge.js";
import { getTools, toolSource } from "../tools/registry.js";
import { ah } from "../util/bg.js";

/**
 * Skills API (mounted under /api): the tools Jev can route to — built-in, hand-written skills,
 * toolset tools (e.g. Game Master), and skills Trinity created on the fly ("forged": these can
 * be switched off, tested, read, fixed, rolled back to an earlier version, archived, deleted, and
 * — with approval "manual" — approved). Each forged skill is listed with its version, its counters
 * (uses, failures, the last error) and its state.
 */
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A forged skill as the Skills API lists it (`problem` says why it can't be used right now). */
function forgedInfo(s: ForgedSkill) {
  let versions: number[] = [];
  try {
    versions = skillVersions(s.name).filter((v) => !v.current).map((v) => v.version);
  } catch {
    /* a pending skill has none */
  }
  return {
    name: s.name,
    description: s.description,
    source: "forged" as const,
    toolset: null,
    // A skill that can't load isn't really on, whatever its switch says (`problem` says why).
    enabled: s.state === "active" && !s.problem,
    /** active | disabled | archived (| draft while it waits for approval) */
    state: s.state,
    kind: s.kind ?? "module",
    version: s.version,
    /** Earlier versions that can be installed again, newest first. */
    versions,
    uses: s.uses,
    fails: s.fails,
    failedRepairs: s.failedRepairs,
    ...(s.lastError ? { lastError: s.lastError } : {}),
    ...(s.lastUsedAt ? { lastUsedAt: s.lastUsedAt } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
    ...(s.disabledWhy ? { disabledWhy: s.disabledWhy } : {}),
    ...(s.notes?.length ? { notes: s.notes } : {}),
    createdAt: s.createdAt,
    need: s.need,
    model: s.model,
    input: s.input,
    examples: s.examples,
    ...(s.problem ? { problem: s.problem } : {}),
  };
}

/** Registered tools (forged ones as their records) plus forged skills that are switched off or archived. */
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
  // Out of routing, kept with everything it knows; enabling it brings it back.
  r.post(
    "/skills/:name/archive",
    ah((req, res) => res.json({ ok: true, skill: forgedInfo(archiveSkill(nameParam(req))) })),
  );
  // An earlier module again (body { version } names one; without it, the one before the current), installed as the next version.
  r.post(
    "/skills/:name/rollback",
    ah(async (req, res) => {
      const to = req.body?.version;
      if (to !== undefined && !(Number.isInteger(to) && to >= 1)) return res.status(400).json({ error: "version must be a whole number" });
      res.json({ ok: true, skill: forgedInfo(await rollbackSkill(nameParam(req), to as number | undefined)) });
    }),
  );
  // Repair it: body { description } says what is wrong, in the user's words (like fix_skill by voice). Slow: the coder writes, the sandbox tests.
  r.post(
    "/skills/:name/fix",
    ah(async (req, res) => {
      const name = nameParam(req);
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      if (!description) return res.status(400).json({ error: "say what is wrong with the skill (description)" });
      if (description.length > 1000) return res.status(400).json({ error: "description is too long (1000 characters at most)" });
      const skill = listForged().find((s) => s.name === name);
      if (!skill) throw new SkillError(`no skill Trinity created is named ${name}`, 404);
      const out = await repairSkill(name, { userWords: description, args: skill.lastArgs, error: skill.lastError });
      res.json(out.ok ? { ok: true, skill: forgedInfo(out.skill), version: out.version } : { ok: false, reason: out.reason, kind: out.kind, ...(out.disabled ? { disabled: true } : {}) });
    }),
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
