# Trinity — Architecture

Trinity is a voice agent **engine**: you talk, she responds in real time, and she can
build things (UI, tools, documents) as the conversation happens. The engine is
end-use agnostic — the same core powers a D&D game master, a personal assistant, a
CPA, a travel agent, or a video producer, swapped by **persona**.

## The stack (verified 2026-10-31)

| Role | Service | Notes |
|------|---------|-------|
| **Voice** (full-duplex speech↔speech) | **NVIDIA PersonaPlex-7B-v1** | Text persona prompt + audio voice prompt. Hosted on **fal.ai** for v1; self-host on Runpod later. |
| **Decision / routing** | **Jev** (TypeSafe AI — System One API) | Typed decision model (`/v1/systemone`, not OpenAI-compatible). Routing is framed as a `choice` question over actions; Jev picks one. Does *not* generate text or tool args itself. |
| **UI builder** (on the fly) | **Mordiem** `qwen3-coder-480b` | OpenAI-compatible gateway (Morpheus network). Generates/edits workspace UI live. |
| **Brain** (general knowledge) | **Mordiem** `claude-sonnet-5-5` | Same Mordiem gateway. PersonaPlex knowledge lookups & reasoning. |
| **Web** | Built-in search/browse tool | Research & lookups. |

> **Why fal.ai before Runpod:** PersonaPlex is real-time full-duplex and needs a warm,
> low-latency stream. Runpod *serverless* scale-to-zero would cold-start a 7B model on
> every conversation. We start on fal.ai (zero infra), then move to a persistent Runpod
> pod when we want the true full-duplex feel. See `docs/RUNPOD.md` (todo).

## Processes

```
┌─────────────────────────── browser (web/) ───────────────────────────┐
│  TALK pane            │  TRANSCRIPT pane        │  WORKSPACE pane      │
│  mic capture + VAD    │  (collapsible) live     │  live-built UI       │
│  audio playback       │  speech + tool events   │  (Morph renders)     │
└───────────────▲───────┴────────────▲────────────┴──────────▲──────────┘
                │  WebSocket (bidirectional events + audio)   │
┌───────────────┴─────────────────────────────────────────────┴─────────┐
│                      Trinity engine (server/)                           │
│                                                                         │
│   Orchestrator ── the loop: audio ⇄ voice, transcript → Jev → tools,    │
│                   memory recall/write, workspace builds                 │
│      │                                                                  │
│      ├── services/voice   (PersonaPlex via fal.ai)   [mockable]         │
│      ├── services/jev     (routing decisions)        [mockable]         │
│      ├── services/brain   (general knowledge)        [mockable]         │
│      ├── services/mordiem (UI codegen + brain)       [mockable]         │
│      ├── services/web     (search/browse)            [mockable]         │
│      │                                                                  │
│      ├── tools/registry   (built-in tools + Trinity skills library)     │
│      └── heartbeat        (recurring tasks, every 30s)                  │
│                                                                         │
│   Data:  SQLite (persona traits, heartbeat tasks, settings, skills)     │
│          PouchDB (memory documents — the "page database")               │
└─────────────────────────────────────────────────────────────────────────┘
```

## The core loop (orchestrator)

1. **Listen** — browser streams mic audio → engine → PersonaPlex. PersonaPlex streams
   back Trinity's speech audio *and* a running transcript of both sides.
2. **Route** — each transcript turn is fed to **Jev**, which decides: is a tool/skill
   needed? which one? what memory/context is relevant? Jev returns a typed decision.
3. **Act** — the orchestrator executes the chosen tool (web search, build UI via Morph,
   brain lookup, heartbeat edit, …). Results flow back into the conversation and/or the
   workspace pane.
4. **Remember** — salient turns are written to the memory store; Jev also selects which
   existing memories to surface into the live context window.
5. **Heartbeat** — every 30s a separate loop processes due recurring tasks (reminders,
   check-ins, background research) and can speak or build without being prompted.

## Graceful degradation

Every external service sits behind an interface with a **mock** implementation. With no
API keys set, Trinity runs fully in mock mode — you can exercise the whole UI, memory,
heartbeat, and routing wiring locally before spending a cent. Each real service turns on
when its key appears in `.env` (see `.env.example`).

## Memory model

- **Structured** (SQLite): persona definition & traits, heartbeat tasks, settings,
  tool/skill registry metadata. Small, relational, transactional.
- **Memories** (PouchDB): free-form documents — facts, events, preferences, summaries —
  each tagged and timestamped. Jev + brain select the relevant few into context. PouchDB
  is chosen as a lightweight, CouchDB-compatible document store so we can add multi-device
  sync later for free.

## Skills library

`server/skills/` holds reusable tools Trinity has (or Morph has) created. When Jev wants a
capability that no registered tool provides, the orchestrator asks a Mordiem model to author
a connector/skill, saves it here, and registers it for future routing. Each skill is a
self-describing module (name, description, input schema, handler).
