# Trinity — Architecture

Trinity is a **general agentic voice platform** with a real-time UI workspace. You talk;
PersonaPlex (a full-duplex speech model) talks back. Deepgram transcribes you live, and Jev
reads the transcription and calls **tools** to get things done — build an interactive page in
the workspace window, look something up, answer a hard question, create a brand-new skill,
remember something about you, set a reminder. Trinity has a **persona** system (who she is and
how she sounds), a **memory** system, and a **heartbeat** (reminders and scheduled tasks).
Personas can also carry extra tool sets — the Game Master is one example.

## The stack (verified 2026-10-31)

| Role | Service | Notes |
|------|---------|-------|
| **Voice** (full-duplex speech↔speech) | **NVIDIA PersonaPlex-7B**, self-hosted and patched on a GPU pod (Runpod RTX A4500) | Text persona prompt + voice prompt (a preset `.pt` or a custom `.wav` sample). Patched with say / hold / flush control frames, raw PCM, and voice-sample upload routes. |
| **Live transcription** | **Deepgram** nova-3 | Interim results drive routing while you're still talking. |
| **Tool routing** | **Jev** (TypeSafe AI System One) | A typed decision model — a `choice` over tools plus per-argument option questions, with page state and recent actions. It decides; it doesn't write text. |
| **Coding skill** | **Mordiem** `z-ai-glm-5-3-flash` (default) and `kimi-k3` | Builds interactive pages for the workspace (streamed) and writes new skills. |
| **Brain** | **Mordiem** `claude-sonnet-5-5` | Questions that need real knowledge or reasoning (`ask_brain`). |
| **Fast models** | **Mordiem** `nvidia-nemotron-3-nano-30b-a3b` | The spoken reply after a tool runs (~0.8 s), argument extraction, memory and schedule parsing (JSON). |
| **Images** | **Mordiem** `krea-2-turbo` | Art for personas that need it (e.g. the Game Master). |
| **Web** | Tavily when keyed, else keyless DuckDuckGo | Search + a synthesized answer. |

Every service has a mock, so the engine runs end-to-end with no keys. All URLs, models and
keys are editable at runtime on the Settings page.

## Processes

```
 browser ─────────────────────────────────────────────────────────────────────────────
  main app (/)                    workspace window (/workspace.html)   settings (/settings.html)
  talk · transcript · docked      the live workspace, hot-updated      personas · models & keys ·
  workspace pane                  (its own window / second screen)     voices · skills · memory ·
     │  /call (voice, binary)        │  /ws/workspace (events)          heartbeat │ /api (REST)
     │  /ws   (text turns)           │                                            │
 ────┴───────────────────────────────┴────────────────────────────────────────────┴───────
  Trinity engine (server/, 127.0.0.1:8799; Vite proxies it at :5173 in dev)
     VoiceCall ─ the real-time loop (one PersonaPlex session, owned by the engine)
     Orchestrator ─ the text channel and the heartbeat's proactive turns
        both use the agent core:  decide (Jev) → act (a tool) → reply
     tools/ ─ build_ui · ask_brain · web_search · create_skill · remember · recall · schedule ·
              get_time · skills Trinity created (sandboxed) · persona tool sets (e.g. game_*)
     WorkspaceBus ─ the one shared workspace every window subscribes to
     SQLite (personas, settings, tasks, games) · PouchDB (memories) · data/ (skills, art, voices)
 ─────────────────────────────────────────────────────────────────────────────────────
  GPU pod: patched PersonaPlex (moshi server) under a supervisor (pod/serve.sh)
```

## The real-time voice loop (`services/voice-call.ts`)

- **One session.** The GPU serves one PersonaPlex session, so the engine owns it: a new
  call evicts the previous one (`no_wait=1` + busy retries while the pod releases it). Only
  the browser tab you're looking at warms a call — except to answer a `wake` (see Heartbeat),
  whose session (`/call?standby=1&wake=1`) never takes the voice from one that's up or
  connecting: the engine turns it away first.
- **Warm standby.** The page opens `/call?standby=1` at load, so the ~5 s handshake happens
  before you tap the mic. Deepgram connects in parallel and is kept alive through the
  handshake. The persona's short voice prompt keeps the handshake short (handshake time
  grows with prompt length; an empty prompt hangs the server); the caller's name, when
  known, is added to it.
- **Routing while you talk.** Deepgram interim text is sent to Jev every ~400 ms with a
  final pass at the end of the sentence. Confident actions with no free-text arguments fire
  mid-sentence; tools that need your whole sentence fire at its end. Duplicates are
  suppressed by (utterance, tool, option arguments).
- **Speaking.** After a tool runs, the fast model writes one or two sentences that are sent
  to PersonaPlex as forced words (0x03) and spoken in the persona's voice — streamed, so a
  sentence that runs past the length cap is finished rather than cut off mid-way. Grounded tools
  (`ask_brain`, `recall`, game narration) return a `speak` line that's said verbatim. PersonaPlex
  reads words, not digits, so numbers are turned into words before they're sent: clock and race
  times, years and decades, ordinals, money in several currencies with its scale ("$12.99" →
  "twelve dollars and ninety-nine cents", "$10-20 million" → "ten to twenty million dollars"),
  percents, degrees, signs ("-3%" → "minus three percent"), ranges and scores ("30-7" → "thirty to
  seven"), fractions and ratings ("1 1/2 cups", "4.8/5"), grouped numbers and decimals; a bare long
  number (maybe a ZIP code or a PIN), a version or an IP address stays as written. A streamed chunk
  that ends in a number waits for the next one, so "$2.5" and "million" are read together, and an
  "a.m." mid-sentence doesn't end the reply. A hold
  (0x04) keeps the agent quiet while you're still talking or an action is pending; a silence
  pump keeps the model stepping; a filler ("One sec.") covers slow tools. `announce()` lets
  background work speak up unprompted (a due reminder, a new skill that's ready): it waits up
  to 15 s for a call that's still connecting (words sent before the pod's hello are lost),
  its turn behind any reply, and a pause in your speech, and it resolves `"said"` once the
  whole line was said, `"cut"` when the caller cut it off (talked over it, or tapped to end
  the turn) and `"unsaid"` when no call said it (none, it closed or moved to another window,
  or no hello in time). Every line is also shown as text; a cut one is never read out again,
  and an unsaid one is read aloud with the browser's voice, in one tab only, never while any
  tab has a live call. The browser plays nothing before a gesture, so the first click or key
  press anywhere on the page sets playback up, not only a mic tap.
- **Barge-in.** Talking over the agent flushes its queued words (0x05) and the browser's
  speaker buffer. An order-aware echo gate ignores transcripts of the agent's own voice.
- **Resilience.** Reason-tracked holds with a watchdog, Deepgram reconnects and keepalives,
  browser and pod pings, an idle release after 15 minutes without activity (not while a
  reminder, or a recurring task that runs at most hourly, is due within those 15 minutes).
  `/ws` and `/ws/workspace` peers are pinged every 30 s and one that misses a pong is dropped,
  so a phone or laptop that vanished stops counting as someone to tell within about a minute.
- **Caller's name.** The voice hears the caller's name when a session connects, so when it
  changes (Settings → Memory, or learned by voice) the main app re-warms the session — never
  during a live call, and in standby only after 20 s with no sign of work (the caller's last
  words, an action and its spoken reply finish first). `/api/status` and the `/ws` ready event
  carry `profileName`.

## The agent core (`server/src/agent/`)

- **decide** (`router.ts`) — builds the Jev request in the reference format: a `tool` choice
  whose labels are the tools' descriptions (plus NONE — "just talking"), one option question
  per argument domain (e.g. which coder), `instructions {goal, rules}`, and
  `state {page {url, title, text}, elements, recent_actions}`. Tools are filtered per persona
  (`toolsets`), by availability, and by context providers. With no TypeSafe key a keyword
  fallback routes by the intent the caller leads with: the earliest of the search, memory /
  reminder and build / skill phrases wins, so "remind me to look up flights" is a reminder and
  "build me a habit tracker for every day" is a build. An opener that only sets the scene
  ("Every day I struggle to focus…", "What's my spending this month?", "I remember…") gives way
  to a build or skill asked for after it with a verb; a search wins only when it leads every
  other match ("build a search page" builds). "Remember to / don't forget to … <time>" and
  "set / create a reminder" are reminders, and so is a snooze when snoozing is all the words say
  ("snooze it for ten minutes", "can you snooze that?"), never "I always snooze it", "don't snooze
  it" or "snooze buttons are the worst"; "make a note", "write this down" are
  memories; a page part after them ("a note taking app", "a reminder button") makes it a build
  or an edit. While a game runs, what "I" or "we" do is a move in the story and only explicit
  web words ("google", "online") search. Curly apostrophes read as straight ones.
- **act** (`act.ts`) — runs the chosen tool (free-text arguments extracted by the fast model
  when needed) with the persona, recent conversation, memory store and situation, and keeps
  the last few results so a follow-up ("chart that") can use them.
- **reply** (`reply.ts`) — the spoken line, streamed. Background work (a build streaming in,
  a skill being written) is acknowledged as started or queued, never as done.
- **context providers** (`context.ts`) — a domain (e.g. the active game) adds the situation
  summary Jev and the reply writer see, extra routing rules, hidden tools, and the reply style.

## Tools

| Tool | What it does |
|------|--------------|
| `build_ui` | **The coding skill.** Builds, changes, or shows something interactive in the workspace — an app, tool, game, chart, dashboard, form, visualization. |
| `ask_brain` | Answers questions that need real knowledge, math, or careful reasoning (spoken verbatim). |
| `web_search` | Current information and news, with a synthesized answer and a results page. |
| `create_skill` | Writes a brand-new skill on the fly, tests it in a sandbox, and makes it usable at once. |
| `remember` / `recall` | Saves a fact the caller asks Trinity to keep; answers from what they told her before. |
| `schedule` | Reminders ("in ten minutes…") and recurring tasks ("every morning at eight…"). |
| `get_time` | The date and time. |
| skills Trinity created | Each runs sandboxed; listed (and switchable) in Settings → Skills. |
| persona tool sets | Extra tools a persona enables, e.g. `game_*` for the Game Master. |

### The coding skill (`tools/coding.ts`, `services/mordiem.ts`)

- **Two coders on Mordiem.** GLM 5.3 (`z-ai-glm-5-3-flash`: first code ~1.2 s, a full canvas app
  ~16 s) is the default; Kimi K3 (`kimi-k3`: ~32 s, the most polished output) is for big or
  complex apps. Jev picks one through the tool's `coder` option ("use Kimi to build…");
  otherwise the Settings default writes it. If a coder fails (an HTTP error, a stall, no usable
  page, or a reply that didn't finish — an error inside the stream, a stop at the token limit or
  a content filter, a stream that ends with neither a finish reason nor `[DONE]`), the other
  takes over once, in the same preview. The skill forge falls back the same way.
- **Streaming.** The page streams into a live preview (`build-preview@1`): it materializes as
  it's written (markup only, no scripts) under a progress pill, then the finished page goes
  live. A thinking-only model (full `z-ai-glm-5-3`) shows "Thinking…" until its code starts.
- **Edits and order.** Builds run one at a time in request order, so "make it bigger" said
  mid-build waits and then edits the finished page. The coder names each page in a leading
  `<!-- title: … -->` comment (every finished build carries one), and keeps the name on a real
  edit; "Updating <name>" applies only when the page on screen is a build, never a tool card
  such as the search results. The coder gets the situation, the last few lines of conversation
  and recent tool results, so "chart what we just found" has the data. On failure the previous
  screen returns.
- **Untrusted text.** What tools found on the web, the agent's own lines and the situation are
  given to the coder quoted and marked as data (URLs removed from tool results) — so is a tool's
  card on screen (the search results) when "chart these" edits it; it uses their facts but never
  follows instructions in them, and its pages never navigate or send data anywhere. The caller's
  own lines are followed where they describe the page. `<meta>` and `<link>` tags are stripped
  from finished builds and from the streaming preview (a refresh would navigate; a preconnect
  hint reaches its host whatever the CSP says).

### Skills Trinity creates (`services/skill-forge.ts`, `sandbox/`)

- **Pipeline.** A coder (Kimi, with GLM as the fallback) writes one ES module
  (`export default { name, description, input, examples, run }`); it is described and
  self-tested with its examples in the sandbox, gets one repair round with the failure fed
  back, and is saved to `data/skills/<name>.skill.mjs` (+ `data/skills/index.json`).
  `create_skill` answers at once and works in the background; when the skill is ready Trinity
  says so in the live call (and runs it once if the request already contained a task for it).
  News the call didn't say in full — the call that asked is gone, or the caller cut it off — is
  Trinity's line in every open app tab instead, read aloud once if it went unsaid.
- **Approval.** `skillApproval` "auto" (default): the skill is usable on the very next turn.
  "manual": it waits in Settings → Skills for approval.
- **Sandbox.** Every describe, test and run is a short-lived child process under Node's
  permission model: it may read only the runner and the skill file — no file writes, no
  child processes or workers, no `node:sqlite`, no imports at all — with a clean environment
  (no API keys), a 128 MB heap, hard timeouts and output caps. Connections to localhost and
  private/link-local networks are refused; public HTTPS APIs work. Hand-written skills in
  `server/skills/` are trusted and run in-process.

### Memory (`tools/memory.ts`, `db/memory.ts`, `services/curator.ts`)

- **remember** turns what the caller said into one sentence, replaces a changed fact, skips
  repeats, and stores the caller's name as their profile name (it personalizes the voice
  prompt, answers and reminders). Two facts from one request never overwrite each other. With
  no model the caller's own words are kept in the third person ("The caller doesn't eat pork.",
  "The caller really likes jazz.", "The caller went to Peru."), after lead-ins like "Trinity,",
  "could you please" or "make a note of this:".
- **The caller's name** is one memory, tagged `name`, that states it ("The caller's name is
  Rob.", "The caller goes by Rob."). A new name — through remember, curation or Settings —
  replaces the name in it and keeps whatever else it says ("…is Rob, and he works nights");
  memories about other people ("The caller's son is named Ryan Jr.") are never taken for it.
  Clearing the name in Settings removes a name-only memory or takes the name out of one that
  says more; editing the name memory to another name changes the profile name.
- **recall** answers only from saved memories, spoken verbatim; it says so when nothing is saved.
- **Curation.** Durable facts are also extracted from conversations automatically (not from
  in-character game talk). An exchange that remember already handled isn't curated again; after
  schedule or recall the request itself — the reminder, the question — isn't saved, but anything
  else said in the same breath ("I'm Ryan, remind me at five…") still is. Only the caller's words
  are memories: what the agent said helps read them (an answer to its question), but a reminder it
  set or a plan it confirmed is never saved. Each exchange keeps up to three new facts, plus the
  caller's name whenever they say it, which is asked for even when a memory already holds it and
  never takes one of the three places. Settings → Memory lists,
  searches, edits and deletes them. Memory ids are letters and digits (PouchDB reserves ids
  starting with `_`).

### Heartbeat (`heartbeat.ts`, `tools/schedule.ts`)

- **schedule** parses natural language with the fast model (or a keyless pattern reader) into
  a one-time reminder or a recurring task, in the engine's local time zone. The model gets the
  full date with the year and returns calendar dates as `YYYY-MM-DD`; "November 12th", "nov 12"
  and "the 12th of November" also read, a date already past means next year's, and "next
  Friday" is the coming one (a week away when said on a Friday). Only what the caller said
  counts: a clock time, am/pm, part of the day or repeat the model adds on its own is dropped,
  and the earlier lines reach the model only when the caller is answering its question about
  when, or points back at them ("again", "do that every day", "ten more minutes" or "snooze"
  after a reminder) — so a new request never takes on an earlier one's "every Friday". A part of
  the day counts only when said as when ("tonight", "tomorrow morning", "friday night at 9"),
  never from the reminder's own words ("date night"); a bare hour reads by it, and 12 or 1–3 at
  night is the small hours ("at 1 tonight" is 1 AM, "friday night at 1" Saturday 1 AM). Without
  a clock time a part of the day means its usual hour — morning 8 AM, afternoon 2 PM, evening
  6 PM, night 9 PM — asked about instead when that's already past today ("What time tonight…?");
  a repeat said with only a day ("every Friday") runs at 9 AM, and twice a day at 8 AM and 8 PM,
  all on the wall clock so daylight saving can't shift them. Other rhythms of more than four
  hours, and a few times a week, ask when to start. "Every weekday" can't be kept yet, so it's
  asked about (every day, or one day a week?); "monthly" is every thirty days, said as "not on a
  set date". "In two days at 9am" keeps the 9 AM. A day it can't read ("next week", "this
  weekend", "the 12th") is asked about ("Which day should I …?"). "Remember to…", "don't forget
  to…" and "set a reminder…" said as the request are reminders, and so are the caller's own "I need
  you to / I've got to remember to…" and one after an acknowledgement ("thanks, and remember to…");
  never one inside a job ("brief me on the news and (also) remember to include the weather") or for
  someone else ("tell Sam to remember to…"). An answer to the when-question reads the request it
  answers the same way. With no model, "set a reminder for the meeting at 2" is "Remind me about
  the meeting.", "set a reminder for 5pm" asks what to remind of, a "for <day>" after the
  reminder's own verb stays in its words ("remind me at 5 to buy a gift for Friday" is today at 5),
  and a snooze right after a reminder came due ("snooze it for ten minutes", "ten more minutes",
  "remind me again at 5") sets that reminder again, read from the agent's last line.
- **The tick** runs every 5 s. A due reminder is said as it is ("Quick reminder: time to
  stretch."), with no model call. A recurring task runs through the agent core as a proactive
  turn — Jev decides (schedule, remember, create_skill and a persona's tool sets, such as the
  game's, are hidden from that decision), a tool may run, the reply writer phrases it with room
  for a short briefing (up to three sentences; during a Game Master's setup, without the next setup
  question or the guidance written around it) or the brain answers — and is delivered with
  `announce()` in the live call when there is one, plus the transcript and a workspace toast. A
  reply of `SKIP` means nothing worth saying.
- **Delivery.** A due item is delivered only when someone can get it: an open app tab, a
  standalone workspace window (it shows the toast) or a voice call. Otherwise a one-time
  reminder stays due and is said as soon as someone is back ("…That was due at …" once it's
  more than 10 minutes late), and a recurring task skips that slot. With no voice call up
  anywhere, a one-time reminder due within 45 s (or due and waiting), or a recurring task that
  runs at most hourly due within 45 s, sends a `wake` event and one tab warms the voice so it's
  said aloud: a tab on screen, else (after 1.5 s) a background tab that held the voice before
  and can play it (one per browser, by Web Lock). If none can, the line arrives unsaid and the
  browser's voice reads it.
- **Failures.** A scheduled run is stopped at 90 s and says nothing; a live brain that fails
  never stands in a canned line. A one-time item that fails gets one spoken notice ("Your
  scheduled … didn't run — …").

## The workspace (`workspace/bus.ts`, `web/src/workspace/`)

- **One shared workspace.** Every channel writes to the bus; every window (the standalone
  window and the main app's pane) subscribes over `/ws/workspace` and gets a snapshot, then
  events. The snapshot persists in `data/workspace.json` (never a half-built preview).
- **Two modes.** `html` — a freeform page (from `build_ui` or a tool). `app` — a template plus
  state (template contract v1: the template defines `window.render(state, prev)`); later state
  changes are posted into the running template, so updates are hot (no reload, no flicker).
  State pushes are coalesced (40 ms, at most 150 ms apart).
- **Owners.** An app has an owner (`build:<id>`, `game:<id>`); updates from a stale owner are
  dropped, so late work never lands on the wrong screen.
- **Sandbox.** Every frame is a sandboxed srcdoc iframe (opaque origin) with a CSP: no network
  (fetch/XHR/WebSocket blocked; images only from data:, blob: and the app's own origin; DNS
  prefetch off). Every html page's `<link>` tags are stripped, inside scripts too (a preconnect
  hint reaches its host whatever the CSP says): builds and tool or skill cards. An app template
  runs as written: it's the engine's own, or a generated one, refused if it has any. The in-frame
  runtime reports render errors, guards navigation and forms, disables WebRTC (it has no CSP
  directive), turns a scripted iframe, frame, object, embed or link into a `<div>`
  (`createElement`, `createElementNS`, customized built-ins), removes nested frames, and shims
  storage, `alert()`, `confirm()` and `prompt()` (modal dialogs are blocked in the sandbox). A
  page may replace its document (`document.open()`, a late `document.write()`, as a game's "Play
  again" does): the CSP, the sandbox and the guards on the window and on prototypes outlive the
  swap, the frame observer watches the document itself, and the runtime's listeners go straight
  back on. The host pages (`index.html`, `workspace.html`, `settings.html`)
  carry the CSP `frame-src 'none'`, so a frame can never navigate — a page could otherwise carry
  data out in a URL. A link a page opens (a click, or `window.open`) waits in the workspace
  notice, which shows the URL with ↗ Open / ✕ Don't open; Open needs a deliberate move onto it
  with a mouse, a tap more than a second after the notice and the previous press (a burst of
  taps never counts), or the keyboard. Settings → Skills previews a skill's output under the
  same CSP.
- **Images.** Chromium blocks an opaque-origin frame from loading `http://localhost` images,
  so the host page fetches each engine image (cached, immutable) and posts the bytes into the
  frame (`{type:"asset", url, blob}`); the runtime swaps in its own `blob:` URLs and shows a
  shimmer until each image arrives.
- **Placement.** The workspace opens in its own window on the first tap to talk; Dock brings it
  back into the main page. The choice is remembered.

## Settings (`/settings.html`)

A full page (not a modal) with deep links: **Personas** (create and edit: voice, voice prompt
with a length meter, description, tool sets), **Models & API keys** (every key — Mordiem,
TypeSafe/Jev, Deepgram, Tavily, fal, PersonaPlex admin token; the models — the coding skill's
GLM and Kimi coders and default, brain, reply writer, fast JSON, images, Jev; endpoints; live-loop
timing; per-field reset to the `.env` default), **Voices** (record or drop a sample; trimmed to
the best ≤8 s of speech, normalized, uploaded to the pod), **Skills** (built-in tools, skills
Trinity created — switch, read the code, test, delete — the approval mode and a "create a skill"
box), **Memory** (your name, search, edit, add, delete), **Heartbeat** (reminders and recurring
tasks), and Saved games (for the Game Master). Changes broadcast to open pages.

## Voices (`services/voices.ts`)

Built-in presets plus custom voices made from a short sample (1–12 s WAV, converted to 16-bit
mono). Custom samples are uploaded to the pod (`POST /api/voices`, bearer admin token) and
verified by SHA-256 before a call uses them; if one can't be confirmed, the call falls back to
the default voice rather than failing.

## Security

The engine binds 127.0.0.1 and refuses requests whose `Host` isn't localhost (or a name in
`ALLOWED_HOSTS`), which stops DNS-rebinding pages from reading its API. WebSocket upgrades and
state-changing HTTP requests must also come from a localhost origin (sandboxed frames send
`Origin: null` and are refused). Generated pages run in opaque-origin frames with no network
access and can't navigate (the host pages' `frame-src 'none'`); links they open need the viewer's
OK. Two residuals remain: a page's own script that tries to navigate makes Chrome open a
connection to the host it names before the CSP refuses the navigation (the host name gets out,
never the URL's path or query), and a `<link>` a script writes in as markup (`innerHTML`) still
sends its hint. Text from the web reaches the coder marked as untrusted data, without its URLs,
so getting a page to try either takes an injected instruction the coder was told to ignore. Skills
Trinity creates run in the sandbox described above. Test hooks exist only with
`TRINITY_TEST_HOOKS=1`. Secrets live in `.env` / `data/endpoints.json` and are never sent to the
browser.

## Example persona with a tool set: the Game Master (`server/src/game/`)

A persona whose `toolsets` include `game` gets tools for running tabletop adventures: guided
setup (the kind of adventure, then each hero), heroes with full sheets and portraits, NPCs,
items and scenes with generated art, dice, grounded narration that applies its consequences
(damage, loot, new places on the map), and a themed game screen — a hand-made default table
plus a custom screen generated for each scenario — that updates live as the game is played.
Games live in SQLite and every change goes through a serialized `mutateGame(id, fn)`. While a
game runs, the general tools (build_ui, create_skill, memory, schedule) are hidden from Jev.

## The pod (`pod/`)

`setup.sh` (idempotent): clone PersonaPlex, apply `server.patch` (say/hold, raw PCM, int8), the
`sphn` fix, `patch_voices.py` (voice upload/list routes) and `patch_flush.py` (0x05 flush) to both
the repo and the installed copy, create the admin token, download weights. `serve.sh` supervises
the server (restarts on crash/OOM, exports the token) and is single-instance (a lock file next to
the token). `restart.sh` stops any supervisor however it was started and restarts it detached.
