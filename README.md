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
- *"Save my Netflix password"* → a secure form opens on the workspace; the vault keeps it encrypted and
  fills it in later only on that site, without Trinity or any model ever seeing it.
- *"Sign me in"*, *"fill in my card"* → done in your own browser by the extension, after you say yes.
- *"Write a one-page summary of the plan as a PDF"*, *"a spreadsheet of my expenses"* → kept as files,
  opened and downloaded from the board.
- *"Check my email"*, *"schedule a meeting with Dana on Friday at two"* → through the mail and calendar
  pages in your browser; nothing is sent or saved without a yes.
- *"Put those numbers in a table"*, *"show that as a pie chart"* → drawn on the board at once.
- *"Let's start a short fantasy adventure for two players"* → the Game Master runs it, with turns, real
  rules and dice, on a live game screen.

Trinity has **personas** (who she is and how she sounds), a **memory** system, a **heartbeat**
(reminders and scheduled tasks), and **creates skills on the fly**. Personas can carry extra
tool sets — the Game Master, which runs tabletop adventures on a live game screen, is one example.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, and
[`docs/REVIEW-2026-11.md`](docs/REVIEW-2026-11.md) for the November 2026 review: what was found, what changed,
what was measured, and what is still open.

## Getting started

**Requirements:** [Node.js 22+](https://nodejs.org/) (LTS is fine), npm, and a modern desktop browser
(Chrome / Edge recommended for voice and the optional browser extension).

```bash
git clone https://github.com/rcondron/Trinity2.git
cd Trinity2
npm install
cp .env.example .env   # leave keys blank to start in mock mode
npm run dev
```

Open **http://localhost:5173**. The engine listens on `127.0.0.1:8799`.

That’s enough to explore the UI, type to Trinity, and use mock voice (your browser’s Web Speech API).
Add keys when you want live routing, models, search, or real-time PersonaPlex voice.

### Optional: go live

| You want… | Set in `.env` or **Settings → Models & API keys** |
|-----------|--------------------------------------------------|
| Tool routing (Jev) | `TYPESAFE_API_KEY` |
| Coding / brain / images / video | `MORDIEM_API_KEY` |
| Live transcription | `DEEPGRAM_API_KEY` |
| Better web search | `TAVILY_API_KEY` (else keyless DuckDuckGo) |
| Shopping / flights / hotels cards | `SERPAPI_KEY` |
| Real-time full-duplex voice | `PERSONAPLEX_WS_URL` + Deepgram (see [Real-time voice](#real-time-voice)) |

Keys and runtime data stay on your machine:

- `.env` is gitignored — never commit it
- `data/` holds the DB, auth tokens, vault, workspace, and media — also gitignored
- Prefer the Settings page for day-to-day key edits; it writes into `data/`, not into the repo

### First minutes in the app

1. Open **http://localhost:5173** and allow mic access if you try voice.
2. Open **⚙ Settings** to create a persona, paste API keys, or pick models.
3. Type or speak a request (e.g. *"build me a tip calculator"* or *"remember my favorite color is green"*).
4. Optional: load the **Trinity Browser Bridge** from [`extension/`](extension/) (Chrome → Extensions → Load unpacked) and link it under Settings → Browser extension.
5. Optional: for full-duplex PersonaPlex voice, follow [Hosting PersonaPlex on a GPU pod](#hosting-personaplex-on-a-gpu-pod).

**Linking a browser.** Every request to the engine is authenticated. The first browser to open the
app is linked by itself. Any other browser is asked for a six-digit code: the engine prints one when
it starts, and Settings → Vault → "Link another browser" shows a fresh one on a browser that is
already linked. Scripts use the API key in `data/auth.json` (`Authorization: Bearer …`) — that file
is local-only and never committed.

### Scripts

| Command | What it does |
|---------|----------------|
| `npm run dev` | Engine (watch) + Vite web UI |
| `npm run start` | Engine only |
| `npm run build:web` | Production web build into `dist/` |
| `npm run typecheck` | Type-check the whole project |
| `npm test` | Offline suites on throwaway data (`-- --list`, `-- --only voice,vault`) |
| `npm run harness` | App + stand-in services at http://127.0.0.1:8898 (after `build:web`) |
| `npm run eval:assistant` | Router eval (~115 prompts); no side effects on your data |
| `npm run eval:cards` | Card-skill library against a throwaway board |
| `node scripts/e2e-voice.mjs "…"` | Real voice-loop drive with typed turns |

For use from another device on a **trusted** network, set `HOST=0.0.0.0` and
`ALLOWED_HOSTS=<that machine's IP or name>` (see `.env.example`). Do not expose the engine to the
public internet without additional protection.

## How it works

1. **PersonaPlex** (NVIDIA's full-duplex speech model, self-hosted) is the voice. It says only
   words it is given: it never makes up a reply of its own.
2. **Deepgram** transcribes you live, beside it.
3. **Jev** (TypeSafe AI) reads the transcription as you speak and picks a tool when you ask for
   something.
4. A tool that fires runs, a fast model writes one spoken line about what it did, and the
   **workspace** window updates live. When no tool fires, a text model (the "talking brain")
   answers in a sentence or two, with your profile, the time and the board in view, started the
   moment you stop speaking. A request no tool covers is handed to a multi-step solver instead
   of being declined.

## The stack

| Role | Service |
|------|---------|
| Voice — real-time, full-duplex | NVIDIA **PersonaPlex-7B**, self-hosted (patched) on a **Runpod** GPU pod |
| Live transcription | **Deepgram** (nova-3, interim results) |
| Tool routing | **Jev** (TypeSafe AI) — System One decision API |
| Coding skill (UIs, new skills) | **Mordiem** `deepseek-v4-1-flash-1017-ultrafast` (quick, default: a page in ~2 s) or `kimi-k3` (strong) |
| Brain | **Mordiem** `claude-sonnet-5-5` |
| Card designer (recipes, news, profiles… on the board) | **Mordiem** `deepseek-v4-1-flash-1017-ultrafast` (≈1.3 s a card; `claude-sonnet-5-5` for the quality tier) |
| Fast reply writer + JSON | **Mordiem** `nvidia-nemotron-3-nano` |
| Images | **Mordiem** `krea-2-turbo` |
| Web search | Tavily (keyed) or keyless DuckDuckGo |
| Shopping & travel cards (live prices, flights, hotels) | SerpApi (`SERPAPI_KEY`; free tier 250 searches/month) — without it the cards fall back to web search |
| Browser control (tabs, reading, clicking, restyling, saving, sharing) | The **Trinity Browser Bridge** Chrome extension in `extension/` — see Settings → Browser extension |
| Memory | SQLite (structured) + **PouchDB** (documents) |
| Voice — turn-based fallback | PersonaPlex via **fal.ai** (queue API) |

**Everything runs in mock mode with no API keys** — including a usable *talking* Trinity (your
browser does speech via the Web Speech API). Add keys in `.env`, or on the **Settings** page
(Models & API keys), to switch each service to live.

## Settings

Open **⚙ Settings** (a full page at `/settings.html`):

- **Personas** — create and edit who Trinity is: name, personality, voice, voice prompt, tool sets.
- **Models & API keys** — every key (Mordiem, TypeSafe/Jev, Deepgram, Tavily, SerpApi, fal, PersonaPlex
  admin token) and every model (the coding skill's quick and strong coders and which is the
  default, brain, reply writer, fast JSON, images, Jev), plus endpoints and live-loop timing.
- **Voices** — make a new voice from a short recorded or uploaded sample.
- **Skills** — the built-in tools and the skills Trinity created (switch on/off, read the code,
  test, delete), whether new skills need your approval, and a box to ask for a new one.
- **Memory** — what Trinity remembers about you (search, edit, add, delete) and your name.
- **Heartbeat** — reminders and recurring tasks.
- **Vault** — encrypted logins and cards; link another browser with a one-time code.

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
**Never commit `pod/admin_token`.**

`serve.sh` supervises the server and **restarts it on crash or OOM** (the model runs in bf16,
~19 GB on a 20 GB card); it's single-instance, and `restart.sh` restarts it safely. Set
`PP_INT8=1` for int8 weights if your `torchao` build matches the image's torch. Expose the server
on an HTTP port and point `PERSONAPLEX_WS_URL` at `wss://<pod-proxy-host>`.

**Durability.** A pod's container disk is **ephemeral** — it survives disconnects and an in-place
restart, but a **Stop** wipes everything. Use a **network volume** for the repo + Hugging Face
cache (`PP_ROOT=/workspace … bash pod/setup.sh`, `HF_HOME` on the volume), or re-run
`pod/setup.sh` on a fresh pod (a few minutes).

## Security notes for a public clone

- Copy `.env.example` → `.env`; leave secrets out of git.
- Runtime auth (`data/auth.json`), the vault, SQLite, and generated media live under `data/` and are
  ignored by git.
- Do not paste live API keys, JWT cookies, or vault passphrases into issues or PRs.
- The engine defaults to localhost-only binding; treat `HOST=0.0.0.0` as a trusted-LAN setting only.

## Status

Everything runs end-to-end in mock mode with no keys; each service flips to live when its key is
set, and every live path falls back gracefully on error.

**Verified live (real round-trips):** the real-time loop against the self-hosted pod (PersonaPlex
speaking tool replies, Deepgram transcription, Jev routing in ~100–150 ms); streamed workspace
builds with both coders (first content on screen in ~1 s); skills created on the fly, sandboxed
and used on the next turn; remember/recall; spoken reminders; custom voice upload/list on the
patched pod; keyless web search with a synthesized answer.
