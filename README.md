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
| Decision / tool routing | **Jev** (TypeSafe AI) — System One decision API |
| On-the-fly UI builder + brain | **Mordiem** (Morpheus gateway: `qwen3-coder` + `claude-sonnet-5-5`) |
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

The engine + UI run end-to-end in mock mode with no keys, and all four services are wired
to live: add a key in `.env` and that service flips on (the rest stay mock). Every live
path falls back gracefully on error.

**Verified live (real round-trips):**
- **PersonaPlex voice** on fal.ai — via fal's **queue API** (submit → poll → result; the
  sync `fal.run` endpoint hangs). Returns WAV + transcript. The endpoint is marked
  deprecated but still serving; `PERSONAPLEX_URL` is configurable for self-hosting (Runpod).
- **Mic capture** — the browser records **WAV** via the Web Audio API (not MediaRecorder's
  WebM) as a `data:` URI; verified fal accepts it end-to-end.
- **Jev routing** — TypeSafe AI's System One API picks the next action (incl. selecting
  skill-library tools); verified live in the engine.
- **Mordiem** — UI codegen (`qwen3-coder-480b-a35b-instruct-turbo`) and the brain
  (`claude-sonnet-5-5`) both run through Mordiem's one OpenAI-compatible gateway; verified live.

**Wired, needs a key:**
- **Tavily web search** — request shape confirmed (clean 401 with a dummy key); add
  `TAVILY_API_KEY`.
