# Trinity

A real-time **voice agent engine**. You talk to Trinity; she responds naturally and
**creates things as you speak** — UIs, tools, research — in a live workspace beside the
conversation. The same engine becomes a D&D game master, personal assistant, CPA, travel
agent, or video producer by swapping her **persona**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## The stack

| Role | Service |
|------|---------|
| Voice (full-duplex speech↔speech) | NVIDIA **PersonaPlex-7B** via **fal.ai** |
| Decision / tool routing | **Jev** (TypeSafe AI) via OpenRouter |
| On-the-fly UI builder + brain | **Morph** (`morph-v3-fast`) / OpenRouter |
| Memory | SQLite (structured) + **PouchDB** (documents) |

**Everything runs in mock mode with no API keys** — including a fully usable *talking*
Trinity (your browser does speech via the Web Speech API). Add keys in `.env` to switch
each service to live.

## Run it

```bash
npm install
cp .env.example .env   # optional — fill in keys to go live; works empty
npm run dev
```

Then open **http://localhost:5173**. The engine runs on `localhost:8799`.

- `npm run dev` runs the engine (watch) + the web UI together.
- `npm run start` runs just the engine.
- `npm run typecheck` type-checks everything.

## What's in the box

- **Three-pane UI** — Talk (mic + push-to-talk + text), collapsible Transcript (speech +
  routing + tool + memory + heartbeat events), and a live Workspace where built UI renders.
- **Orchestrator loop** — `listen → route (Jev) → act (tools/build/recall) → speak → remember`.
- **Memory** — PouchDB document store with relevance recall; SQLite for persona, tasks, skills.
- **Heartbeat** — recurring tasks processed every 30s (managed in Settings).
- **Skills library** — drop a `*.skill.ts` in `server/skills/` and Trinity can route to it.
  See `server/skills/dice.skill.ts` for the pattern.
- **Persona editor** — edit who Trinity is and how she sounds in Settings.

## Status

This is the **foundation**: the full engine + UI, runnable end-to-end in mock mode. Live
service wiring (real PersonaPlex audio streaming on fal.ai, live Jev routing, live Morph
builds, a web-search provider) plugs in behind the existing interfaces as keys are added —
see the `services/` modules and `.env.example`.

Not yet wired: real fal.ai audio transport, a concrete web-search provider, and Runpod
self-hosting (planned for after the fal.ai loop is proven).
