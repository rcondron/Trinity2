# Trinity

A real-time **voice agent engine**. You talk to Trinity; she responds naturally and
**creates things as you speak** — UIs, tools, research — in a live workspace beside the
conversation. The same engine becomes a D&D game master, personal assistant, CPA, travel
agent, or video producer by swapping her **persona**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## The stack

| Role | Service |
|------|---------|
| Voice — real-time, full-duplex | NVIDIA **PersonaPlex-7B**, self-hosted (patched) on **Modal** |
| Voice — turn-based fallback | PersonaPlex via **fal.ai** (queue API) |
| Live transcription | **Deepgram** (nova-3, interim results) |
| Decision / tool routing | **Jev** (TypeSafe AI) — System One decision API |
| On-the-fly UI builder + brain | **Mordiem** (Morpheus gateway: `qwen3-coder` + `claude-sonnet-5-5`) |
| Fast reply writer (for voice) | **Mordiem** (`nvidia-nemotron-3-nano`) |
| Memory | SQLite (structured) + **PouchDB** (documents) |

**Everything runs in mock mode with no API keys** — including a fully usable *talking*
Trinity (your browser does speech via the Web Speech API). Add keys in `.env`, or edit
endpoints live in **Settings → Endpoints & models**, to switch each service to live.

## Real-time voice (the streaming loop)

The headline path is a **continuous, full-duplex call**: a persistent PersonaPlex WebSocket
does the talking while **Deepgram** transcribes you live beside it, **Jev** is polled every
~400 ms on your in-progress sentence to fire tools, and after a tool runs a fast model writes
one sentence that PersonaPlex is **made to say in its own voice** (held quiet while you're
still talking). Tap the mic to open a call; it appears as `stream: live` once configured.

This needs a **patched, self-hosted PersonaPlex** (fal's hosted endpoint can't accept the
say/hold protocol). Host it on **[Modal](https://modal.com)** (one L40S GPU; needs a Hugging
Face token with access to `nvidia/personaplex-7b-v1`) — see the `personaplex-toolcall` repo's
`personaplex/` for the server patch + `modal_app.py`. Then set:

```
PERSONAPLEX_WS_URL=wss://<your-modal-deployment>   # the patched streaming server
DEEPGRAM_API_KEY=<your deepgram key>
```

With Jev + Mordiem keys already set, the real-time loop goes live. Everything is also
adjustable at runtime in **Settings → Endpoints & models** (URLs, model names, keys, and the
route interval / confidence / filler timing) — no restart needed.

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
