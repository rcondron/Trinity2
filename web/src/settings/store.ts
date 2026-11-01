// Shared, cached data for the settings sections. Each Resource loads once,
// hands out the cached value afterwards, and notifies subscribers whenever it
// is refreshed or replaced — so e.g. a voice created in Voices shows up in the
// persona editor's voice picker without a reload.

import {
  api,
  type GameList,
  type HeartbeatTask,
  type ModelCatalog,
  type PendingSkill,
  type Persona,
  type Profile,
  type PublicEndpoints,
  type Skill,
  type StatusResponse,
  type Toolset,
  type VoiceLibrary,
} from "./api.js";

type Listener<T> = (value: T) => void;

export class Resource<T> {
  private value: T | undefined;
  private inflight: Promise<T> | null = null;
  private seq = 0;
  private readonly listeners = new Set<Listener<T>>();

  constructor(private readonly loader: () => Promise<T>) {}

  /** The cached value, if loaded. */
  peek(): T | undefined {
    return this.value;
  }

  /** Cached value, or load it (shared in-flight request). */
  get(): Promise<T> {
    if (this.value !== undefined) return Promise.resolve(this.value);
    return this.load(false);
  }

  /** Always reload; the newest request wins if several overlap. */
  refresh(): Promise<T> {
    return this.load(true);
  }

  /** Replace the cached value locally (e.g. after a successful write) and notify. */
  set(value: T): void {
    this.value = value;
    for (const fn of [...this.listeners]) {
      try {
        fn(value);
      } catch (err) {
        console.error("[settings] listener failed", err);
      }
    }
  }

  /** Transform the cached value (no-op until loaded). */
  update(fn: (value: T) => T): void {
    if (this.value !== undefined) this.set(fn(this.value));
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private load(force: boolean): Promise<T> {
    if (this.inflight && !force) return this.inflight;
    const mine = ++this.seq;
    const p = this.loader()
      .then((v) => {
        if (mine === this.seq) this.set(v);
        return v;
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    return p;
  }
}

export interface SkillsData {
  /** Every tool the engine lists — built-in, hand-written, toolset, and created by Trinity (enabled or not). */
  all: Skill[];
  /** Skills Trinity created that wait for approval. */
  pending: PendingSkill[];
}

export const statusRes = new Resource<StatusResponse>(() => api.status());
export const personasRes = new Resource<Persona[]>(() => api.personas.list());
export const voicesRes = new Resource<VoiceLibrary>(() => api.voices.list());
export const toolsetsRes = new Resource<Toolset[]>(() => api.toolsets.list());
export const endpointsRes = new Resource<PublicEndpoints>(() => api.endpoints.get());
export const modelCatalogRes = new Resource<ModelCatalog | null>(() => api.models.catalog());
export const gamesRes = new Resource<GameList>(() => api.games.list());
export const heartbeatRes = new Resource<HeartbeatTask[]>(() => api.heartbeat.list());
export const profileRes = new Resource<Profile>(() => api.profile.get());
export const skillsRes = new Resource<SkillsData>(async () => {
  const [all, pending] = await Promise.all([api.skills.list(), api.skills.pending()]);
  return { all, pending };
});

/** Id of the persona that answers new calls (from /status), if known. */
export function activePersonaId(): string | null {
  return statusRes.peek()?.persona.id ?? null;
}

/** Human label for a persona's voice value. */
export function voiceLabel(value: string, lib: VoiceLibrary | undefined = voicesRes.peek()): string {
  if (value.startsWith("custom:")) {
    const slug = value.slice("custom:".length);
    const v = lib?.custom.find((c) => c.slug === slug || c.id === value);
    return v ? v.name : `Custom · ${slug}`;
  }
  return lib?.builtin.find((b) => b.id === value)?.label ?? value;
}

/** Personas that use a given voice value. */
export function personasUsingVoice(value: string): Persona[] {
  return (personasRes.peek() ?? []).filter((p) => p.voice === value);
}
