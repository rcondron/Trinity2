# Trinity

A **general agentic voice platform** with a real-time UI workspace. You talk to Trinity and
she talks back, naturally and in real time. While you talk, your words are transcribed live
and a decision model calls **tools** that get things done and update the **workspace** — a web
page in its own window — as the conversation happens:

- *"Build me a pomodoro timer"* → the coding skill writes it, and you watch it appear.
- *"Use Kimi to make a 3D solar system"* → the stronger coder builds it.
- *"Make a skill that converts currencies"* → she writes a new tool, tests it in a sandbox, and can use it right away.
- *"Remember that my favorite color is green"* / *"What's my favorite color?"*
- *"Remind me in ten minutes to stretch"* → she says it, in the call, when it's due.
- *"What's the tallest building in the world?"* → a web search, answered out loud.

Trinity has **personas** (who she is and how she sounds), a **memory** system, a **heartbeat**
(reminders and scheduled tasks), and **creates skills on the fly**. Personas can carry extra
tool sets — the Game Master, which runs tabletop adventures on a live game screen, is one example.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## How it works

1. **PersonaPlex** (NVIDIA's full-duplex speech model, self-hosted) does the talking.
2. **Deepgram** transcribes you live, beside it.
3. **Jev** (TypeSafe AI) reads the transcription every ~400 ms and picks a tool when you ask
   for something.
4. The tool runs; a fast model writes one spoken line that PersonaPlex is **made to say in its
   own voice**; the **workspace** window updates live.

## The stack

| Role | Service |
|------|---------|
| Voice — real-time, full-duplex | NVIDIA **PersonaPlex-7B**, self-hosted (patched) on a **Runpod** GPU pod |
| Live transcription | **Deepgram** (nova-3, interim results) |
| Tool routing | **Jev** (TypeSafe AI) — System One decision API |
| Coding skill (UIs, new skills) | **Mordiem** `mercury-3` (quick, default: a page in ~3 s) or `kimi-k3` (strong) |
| Brain | **Mordiem** `claude-sonnet-5-5` |
| Fast reply writer + JSON | **Mordiem** `nvidia-nemotron-3-nano` |
| Images | **Mordiem** `krea-2-turbo` |
| Web search | Tavily (keyed) or keyless DuckDuckGo |
| Memory | SQLite (structured) + **PouchDB** (documents) |
| Voice — turn-based fallback | PersonaPlex via **fal.ai** (queue API) |

**Everything runs in mock mode with no API keys** — including a usable *talking* Trinity (your
browser does speech via the Web Speech API). Add keys in `.env`, or on the **Settings** page
(Models & API keys), to switch each service to live.

## Settings

Open **⚙ Settings** (a full page at `/settings.html`):

- **Personas** — create and edit who Trinity is: name, personality, voice, voice prompt, tool sets.
- **Models & API keys** — every key (Mordiem, TypeSafe/Jev, Deepgram, Tavily, fal, PersonaPlex
  admin token) and every model (the coding skill's quick and strong coders and which is the
  default, brain, reply writer, fast JSON, images, Jev), plus endpoints and live-loop timing.
- **Voices** — make a new voice from a short recorded or uploaded sample.
- **Skills** — the built-in tools and the skills Trinity created (switch on/off, read the code,
  test, delete), whether new skills need your approval, and a box to ask for a new one.
- **Memory** — what Trinity remembers about you (search, edit, add, delete) and your name.
- **Heartbeat** — reminders and recurring tasks.

## Real-time voice

The headline path is a **continuous, full-duplex call**. The call warms up in the background
when the page opens, so tapping the mic starts talking right away. It needs a **patched,
self-hosted PersonaPlex** (fal's hosted endpoint can't accept the say/hold protocol):

```
PERSONAPLEX_WS_URL=wss://<your-pod-or-deployment>   # the patched streaming server
DEEPGRAM_API_KEY=<your deepgram key>
```

With Jev + Mordiem keys set, the real-time loop goes live.

### Hosting PersonaPlex on a GPU pod

[`pod/`](pod/) provisions the patched server on a CUDA PyTorch pod (tested on Runpod,
`runpod/pytorch:…torch280`, one RTX A4500 20 GB). On the pod:

```bash
HF_TOKEN=hf_xxx bash pod/setup.sh    # clone + patch + deps + weights + admin token (idempotent)
bash pod/restart.sh                  # (re)start the supervised server, detached
```

`setup.sh` applies `pod/server.patch` (the say/hold + raw-PCM + int8 protocol), a fix for
`sphn` 0.2, `patch_voices.py` (custom voice upload/list routes, bearer-token protected) and
`patch_flush.py` (a 0x05 "flush" frame for barge-in) — to both the repo and the installed
`moshi` copy — and creates the voice-upload admin token in `pod/admin_token`. Paste that token
into **Settings → Models & API keys → PersonaPlex admin token** so custom voices sync to the pod.

`serve.sh` supervises the server and **restarts it on crash or OOM** (the model runs in bf16,
~19 GB on a 20 GB card); it's single-instance, and `restart.sh` restarts it safely. Set
`PP_INT8=1` for int8 weights if your `torchao` build matches the image's torch. Expose the server
on an HTTP port and point `PERSONAPLEX_WS_URL` at `wss://<pod-proxy-host>`.

**Durability.** A pod's container disk is **ephemeral** — it survives disconnects and an in-place
restart, but a **Stop** wipes everything. Use a **network volume** for the repo + Hugging Face
cache (`PP_ROOT=/workspace … bash pod/setup.sh`, `HF_HOME` on the volume), or re-run
`pod/setup.sh` on a fresh pod (a few minutes).

## Run it

```bash
npm install
cp .env.example .env   # optional — fill in keys to go live; works empty
npm run dev
```

Then open **http://localhost:5173**. The engine runs on `127.0.0.1:8799` and only answers
requests addressed to localhost; for use from another device on a trusted network, set
`HOST=0.0.0.0` and `ALLOWED_HOSTS=<that machine's IP or name>` (see `.env.example`).

- `npm run dev` runs the engine (watch) + the web UI together.
- `npm run start` runs just the engine.
- `npm run typecheck` type-checks everything.
- `node scripts/e2e-voice.mjs "build me a tip calculator" "what's my favorite color" …` drives
  the real voice loop with typed turns and reports Jev's decisions, the tools, what PersonaPlex
  actually said, and the workspace (`--persona <id>` to pick a persona, `--settle 60` to wait for
  background work).

## Status

Everything runs end-to-end in mock mode with no keys; each service flips to live when its key is
set, and every live path falls back gracefully on error.

**Verified live (real round-trips):** the real-time loop against the self-hosted pod (PersonaPlex
speaking tool replies, Deepgram transcription, Jev routing in ~100–150 ms); streamed workspace
builds with both coders (first content on screen in ~1 s); skills created on the fly, sandboxed
and used on the next turn; remember/recall; spoken reminders; custom voice upload/list on the
patched pod; keyless web search with a synthesized answer.
