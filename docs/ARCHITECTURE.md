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
| **Coding skill** | **Mordiem** `mercury-3` (quick, the default) and `kimi-k3` (strong) | Builds interactive pages for the workspace (streamed) and writes new skills. |
| **Brain** | **Mordiem** `claude-sonnet-5-5` | Questions that need real knowledge or reasoning (`ask_brain`). |
| **Card designer** | **Mordiem** `mercury-3` (≈1.8 s a card; `claude-sonnet-5-5` ≈9 s, the most careful) | Information cards on the board (`show_card`): the facts, layout, look and picture brief. |
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
     tools/ ─ build_ui · show_card · make_image · make_audio · clear_workspace · ask_brain ·
              web_search · browser_* (the Chrome extension) · create_skill · remember · recall ·
              schedule · get_time · skills Trinity created (sandboxed) · persona tool sets (e.g. game_*)
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
  connecting: the engine turns it away first. The session can also be lent out for a few
  seconds to render a voice sample (see Voices): from no one, or from a standby tab, which is
  told so and warms up again when the voice is free; never from a live call, and a call that
  starts meanwhile takes it back at once.
- **Warm standby.** The page opens `/call?standby=1` at load, so the ~5 s handshake happens
  before you tap the mic. Deepgram connects in parallel and is kept alive through the
  handshake. The persona's short voice prompt keeps the handshake short (handshake time
  grows with prompt length; an empty prompt hangs the server); the user's name, when
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
  number (maybe a ZIP code or a PIN), a version or an IP address stays as written. Some numbers are
  read by the words around them: a slash pair after a date word stays a date ("on 3/4", "due
  1/10"), a hyphenated pair that names one thing stays an identifier ("room 3-104", "the 1-800
  number"), "30s" after a range or a timing word is seconds ("rest 60-90s"), "19.45" after "at" is
  a clock time, and 1000–1899 after "in" or "since" is a year. A streamed chunk that ends in a
  number, a currency sign, "a.m." or a word the next number is read by ("at", "on", "between")
  waits for the next one, so "$2.5" and "million" are read together, and each chunk is read after
  the words already said, so a rule that looks back ("cut the recipe by 2/3") sees them; an "a.m."
  followed by a weekday, a month or a time zone doesn't end the reply. In the browser the voice
  passes through a clean-up chain (`web/src/voice-chain.ts`: high-pass, de-box, presence, air,
  compressor, limiter) with a 240 ms jitter cushion that grows on underruns; Settings → Voices
  turns the chain off per browser. A hold
  (0x04) keeps the agent quiet while you're still talking or an action is pending; a silence
  pump keeps the model stepping; a filler ("One sec.") covers slow tools. `announce()` lets
  background work speak up unprompted (a due reminder, a new skill that's ready): it waits up
  to 15 s for a call that's still connecting (words sent before the pod's hello are lost),
  its turn behind any reply, and a pause in your speech, and it resolves `"said"` once the
  whole line was said, `"cut"` when the user cut it off (talked over it, or tapped to end
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
- **User's name.** Stored as Settings → Memory “Your name” / a `name` memory for the brain
  and reply writer. It is **not** put in PersonaPlex's `text_prompt` (that model treats the
  prompt as identity and used to greet as “Hello, this is [user]”). `/api/status` and the
  `/ws` ready event still carry `profileName`; a name change may re-warm standby for other
  session state, never mid-call.

## The agent core (`server/src/agent/`)

- **decide** (`router.ts`) — builds the Jev request in the reference format: a `tool` choice
  whose labels are the tools' descriptions (plus NONE — "just talking"), one option question
  per argument domain (e.g. which coder), `instructions {goal, rules}`, and
  `state {page {url, title, text}, elements, recent_actions}`. Tools are filtered per persona
  (`toolsets`), by availability, and by context providers. A finished sentence Jev is unsure
  about (a real tool under the confidence gate) or waves off although it plainly asks for
  something gets a **second opinion** from the fast model over the same tools
  (`agent/arbiter.ts`), which can also hand it to `figure_out`. With no TypeSafe key a keyword
  fallback routes by the intent the user leads with: the earliest of the search, memory /
  reminder and build / skill phrases wins, so "remind me to look up flights" is a reminder and
  "build me a habit tracker for every day" is a build. An opener that only sets the scene
  ("Every day I struggle to focus…", "What's my spending this month?", "I remember…") gives way
  to a build or skill asked for after it with a verb; a search wins only when it leads every
  other match ("build a search page" builds). "Remember to / don't forget to … <time>" and
  "set / create a reminder" are reminders, and so is a snooze when snoozing is all the words say
  ("snooze it for ten minutes", "can you snooze that?"), never "I always snooze it", "don't snooze
  it" or "snooze buttons are the worst"; "make a note", "write this down" are
  memories; a page part after them ("a note taking app", "a reminder button") makes it a build
  or an edit. A picture asked for by name ("draw me a picture of…", "paint a sunset", "I'd like a
  portrait of…") is make_image, a clip "make a video of…" make_video, a reading or a voice note
  make_audio, "clear / close / reset the screen" clear_workspace and "what's on the screen?"
  describe_workspace; a chart "drawn" is still a build, and a picture mentioned ("I took a picture
  yesterday") asks for nothing. While a game runs, what "I" or "we" do is a move in the story and only explicit
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
| `build_ui` | **The coding skill.** Adds or edits ONE numbered floating widget card (timer, chart, app, …). Other cards on the board stay put. |
| `edit_html` | **The HTML skill.** Tweaks something already on the board: resize a picture/video (img width/height %), edit SVG/canvas/widget markup and styles. |
| `show_card` | **Content cards.** A recipe, the news, who someone is, a place, a product or comparison, a how-to, an explainer, an event, the weather, scores, a film or book, a plan or a list — laid out as a designed widget card with a fitting picture, plus a spoken summary. |
| `ask_brain` | Answers a quick question that needs real knowledge, math, or careful reasoning (spoken verbatim, nothing on screen). |
| `web_search` | A quick fact or link from the web, spoken; its results go up as a card on the board. |
| `create_skill` | Writes a brand-new skill on the fly, tests it in a sandbox, and makes it usable at once. |
| `remember` / `recall` | Saves a fact the user asks Trinity to keep; answers from what they told her before. |
| `schedule` | Reminders ("in ten minutes…") and recurring tasks ("every morning at eight…"). |
| `get_time` | The date and time. |
| `make_image` / `make_audio` / `make_video` / `make_text` | Adds numbered floating card(s) (loader first). Several subjects (“a panda and a tiger”) → one card each, tagged by content. |
| `remove_card` / `move_card` | Remove or reposition by number or content (“remove the tiger”, “move the tiger under the panda”), including layering (“put the tiger behind the panda”, “bring card 2 forward”). |
| `arrange_cards` | Lays every card out in numerical order: an aligned grid of equal cards (“organize the cards”, “tidy up the board”), a stack, a row or a column; undo restores the old layout. |
| `resize_card` | A card's own size: maximize / full screen, minimize to a tile on the bottom row, restore, bigger, smaller, wider, narrower, taller, shorter — by number or content (“maximize card 2”, “make the tiger bigger”). |
| `figure_out` | **The problem solver.** For a request no tool covers: the Settings → Problem solver model plans, runs the tools in turn, tries another way when a step fails, forges a skill when none fits, and says what happened (in the background past eight seconds). |
| `set_speech_rate` | Talk slower / faster / normal speed (browser playback rate). |
| `clear_workspace` / `describe_workspace` | Clears the whole board / window; lists what's showing (including card numbers). |
| skills Trinity created | Each runs sandboxed; listed (and switchable) in Settings → Skills. |
| persona tool sets | Extra tools a persona enables, e.g. `game_*` for the Game Master. |

### The coding skill (`tools/coding.ts`, `services/mordiem.ts`)

- **One floating card per build.** `build_ui` adds (or edits) a numbered **widget** card on the
  board — it does not replace the whole workspace. A picture in card 1 stays when you ask for a
  timer as card 2. The coder is told to build only that one widget (no multi-card panel).
- **Two coders on Mordiem.** Quick Mercury 3 vs strong Kimi K3 (settings keys `glmModel` /
  `kimiModel`). Jev's `coder` option or a name in the utterance picks one; Settings default
  otherwise. On failure the other coder takes over once on the same card.
- **Streaming.** HTML streams into the pending widget card, then marks ready. Edits target
  "card N" or the latest matching widget. Builds run one at a time in request order.
- **Untrusted text.** What tools found on the web, the agent's own lines and the situation are
  given to the coder quoted and marked as data (URLs removed from tool results) — so is a tool's
  card on screen (the search results) when "chart these" edits it; it uses their facts but never
  follows instructions in them, and its pages never navigate or send data anywhere. The user's
  own lines are followed where they describe the page. `<meta>` and `<link>` tags are stripped
  from finished builds and from the streaming preview (a refresh would navigate; a preconnect
  hint reaches its host whatever the CSP says).

### Content cards (`tools/content.ts`, `services/content-spec.ts`, `workspace/content-card.ts`)

- **The ask.** "Give me a blueberry muffin recipe", "what's in the news", "who was Marie Curie",
  "compare the iPhone and the Pixel", "how do I fix a leaking tap", "what's the weather in Austin",
  "top ten sci-fi novels"… Jev picks `show_card` with a `type` option (sixteen kinds: recipe, news,
  person, place, explainer, how-to, comparison, product, event, weather, sports, media, plan, health,
  list, other); keyless routing guesses the kind from the words. A quick fact stays `ask_brain`
  (spoken only); "search for X" stays `web_search`; a picture alone is `make_image`; a note in the
  user's own words is `make_text`.
- **What happens.** The card goes up at once (a masthead and shimmer lines; a tall widget card). The
  web is searched first when the kind or the words are fresh — news, sports and events take real
  headlines from Google News's RSS (`services/news.ts`; a web search for "the news" only finds front
  pages), everything else the usual search. Then the **card designer** (`CARD_MODEL`, Mercury 3 by
  default; the Brain when Jev's `quality` option or the words ask for care) returns a **ContentSpec**:
  title, subtitle, a spoken summary, a look (mood + accent), a picture brief, meta chips, up to ten
  typed **blocks** (text, list, steps, facts, stats, timeline, table, pros/cons, headlines, quote,
  note, tags, schedule — plus products, flights and hotels, which only the engine writes) and sources. Each kind has a design brief (a recipe: chips for prep / bake /
  serves, a check-list of ingredients, numbered steps, a tip; a profile: born / died chips, a
  biography, a timeline; news: headlines with source and time from the sources only…). The engine
  **renders** the spec with its own design system — six moods (warm, editorial, cool, playful,
  elegant, calm) × the accent, a hero with the picture (or a shimmer while it paints, or a
  typographic masthead), one styled layout per block kind — so every card is laid out for its
  content yet always valid, consistent and fast; `edit_html` can still restyle it afterwards.
- **The picture.** Concrete subjects (a dish, a place, a product, a how-to) start their hero picture
  at once from the topic, in parallel with the writing; otherwise the designer writes the brief (a
  scene evoking the subject — never a real person's face, a poster or a logo); news, weather,
  scores, comparisons and health get none. The picture lands into the card when Mordiem has painted
  it. Inside a widget card's frame an engine image can only load as a `data:` URL (the nested
  sandboxed frame is another opaque origin — it can load neither the board frame's `blob:` URLs nor
  localhost), so the host fetches it once and the board frame inlines it.
- **Shopping & travel** (`services/serpapi.ts`, `services/travel-query.ts`, `services/live-results.ts`,
  `services/remote-images.ts`). "Find me the cheapest noise-cancelling headphones under $200",
  "flights from Austin to Denver next Friday, back Sunday", "a hotel in Lisbon for three nights" are
  the `shopping`, `flights` and `hotels` kinds: a **live search** runs first — Google Shopping,
  Flights or Hotels through SerpApi (one key, `SERPAPI_KEY` / Settings → API keys) — and the engine
  lays those results out itself as product tiles, flight rows (times, stops, layovers, fares,
  Google's price insight) or hotel rows (rates, stars, ratings, amenities), so every price, time and
  link is exactly what came back; the designer only writes around them (title, the spoken summary
  naming the pick and the cheapest, advice). Shopping is parsed from the words (the product, a price
  cap, "cheapest" → sorted by price); flights and hotels ask the card model to read the route, dates
  and travellers (a word-level parser is the fallback and the cross-check), what's missing is
  **assumed and said** ("no date was given, so this is for Fri, Nov 20"; one way; one adult) or, when
  the origin or destination isn't there, becomes a **question** instead of a card. Product photos,
  hotel pictures and airline logos are remote: `remote-images.ts` fetches each once (public host,
  image type by header and first bytes, size cap) into the image store, so they reach the offline
  card frame like any engine image. Without a key, or when the search fails or finds nothing, the
  card says so in a note, falls back to web search and knowledge, and links the same search on
  Google. `itinerary` is a fourth kind, written by the designer: one schedule block per day, facts,
  a packing list, a destination hero picture.
- **Grounding.** Sources are numbered data to the designer, never instructions; it may only cite
  URLs it was given (an invented link is dropped), and every string is escaped by the renderer.
- **The spoken line.** The tool waits up to ~9 s for the designer so the reply is the real summary
  ("Here's a recipe that makes twelve… It's on the board as card 3"). When the designer is slower,
  Trinity says the card is coming and tells the summary when it's written (into the live call, or as
  a line in every open app — `agent/tell.ts`, shared with finished skills).

### Browser extension (`extension/`, `services/browser-bridge.ts`, `services/browser-words.ts`, `tools/browser.ts`)

- **What it is.** A Chrome extension (Manifest V3, loaded unpacked from `extension/`) that keeps one
  WebSocket to the engine at `/ext`, paired with a token the engine makes (Settings → Browser
  extension shows it; `POST /api/browser/token` rotates it; a wrong token is closed with 4401). The
  engine never listens for pages: the extension's service worker runs the engine's **calls** through
  Chrome's APIs — `tabs.list / open / close / activate / navigate / history / zoom`, `page.snapshot`
  (text, headings, every clickable thing given a `data-trinity-ref`, pictures, the page's ids and
  classes, the selection), `page.act` (click / type / select / scroll / press), `page.inject` (CSS
  through `insertCSS`, static HTML, JavaScript in the page's main world and, on sites whose CSP
  refuses eval, through `chrome.userScripts` when the user turned on *Allow User Scripts*),
  `page.restore`, `page.capture` (a screenshot), `files.download`, `files.savePage` (an MHTML
  archive) — and reports its tabs whenever they change. Right-clicking a page, a selection, a link
  or an image (or the popup's button) **shares** it: the engine puts it on the board as a note or a
  picture card and Trinity says so.
- **The tools.** Seven, offered to Jev only while the extension is connected (`available`), hidden
  at the game table: `browser_open` (a site, a search on a site, an address, a new tab),
  `browser_tabs` (close / close others / next / previous / switch / back / forward / reload / zoom /
  list), `browser_read` (a spoken summary or an answer from the page, the selection, the headings,
  the links), `browser_act` (click / type / select / scroll / press), `browser_modify` (dark mode,
  reader mode, hide the ads / sidebar / popups…, bigger text — presets as CSS; anything else written
  by the quick coder as CSS / HTML / JS from the page's own structure; undo), `browser_save` (the page
  as an archive, its text as markdown, a screenshot, a picture, a link — to the downloads folder),
  `browser_share` (the page, the selection, a screenshot or a picture onto the board).
- **Fast by words.** Jev picks the tool in a few hundred milliseconds; `browser-words.ts` fills the
  arguments from the words at once — sixty spoken site names and site searches ("search for X on
  Amazon", "youtube cute cats", "directions to…"), tab phrases, click / type / select / scroll /
  press phrases, hide-and-restyle presets — so most commands run with no model call. A model is asked
  only when the words don't settle it: the fast model picks an element the names didn't match, the
  quick coder writes a tweak with no preset, the fast model (or the brain) reads a page. Keyless
  routing has matching cues; Jev gets the same as rules from the browser context provider, which
  also tells it and the reply writer which tabs are open.
- **Kept safe whatever a page says.** Page text is data to every model prompt, never instructions.
  Password fields are never listed in a snapshot nor typed into. A control whose name spends, sends
  or destroys (buy, order, pay, checkout, confirm, submit, send, delete, sign out…) is clicked only
  when the user's own words contain that word; otherwise Trinity names it and asks. Chrome's own
  pages are left alone; only web and `data:` URLs are opened or downloaded; injected HTML is stripped
  of scripts and handlers. The extension's host permissions are broad (it must read and change any
  site), so the pairing token is the gate: it lives in Chrome's storage and the engine's SQLite.

### Floating card board (`workspace/board.ts`, `tools/media.ts`, `tools/screen.ts`, `tools/html.ts`)

- Media, notes, builds and content cards share one board app (`board@5`): each **make_image** /
  **make_audio** / **make_video** / **make_text** / **build_ui** / **show_card** call adds a
  **numbered floating card** at an absolute position (a tool's rendered page — search results — too).
  Cards show a loader while Mordiem works, then fill in when ready (`data/images|audio|videos/`).
  Numbers stay stable so the user can say **remove_card** / **move_card** (“remove card 2”,
  “move card 1 to the top-left”). **clear_workspace** wipes the whole board.
- **edit_html** adjusts existing cards without regenerating them: size-only asks (“make the
  picture smaller”) set the img/video width % immediately; deeper asks stream a surgical HTML
  edit (SVG, canvas, widget CSS/DOM). Media cards can be opened into editable HTML when needed.
- Quality routing is unchanged: Jev’s `quality` option or prompt cues pick fast vs pro Mordiem
  models via `mordiem-router.ts`. Every Jev decision / tool / reply is also relayed as an `agent`
  event. Sandboxed frames still receive media bytes from the host (same as game art).
- **Widget frames.** Each widget card (a build, a content card, an HTML edit) is its own isolated
  `srcdoc` frame inside the board's frame (`sandbox="allow-scripts"`: no same-origin, no top
  navigation, no `src`). The workspace frame runtime removes every other nested frame; the board
  template alone runs in `nested` mode (`FramePayload.nested`, set by the host for `board@*`), and
  it hardens each widget document itself: WebRTC constructors neutralized, frames of its own removed,
  and a link clicked inside a card handed to the host through the board (the card never navigates).
  Images for those documents go in as `data:` URLs (see Content cards).
- **The screen as context** (`tools/screen.ts`). The situation Jev and the reply writer see says
  what the workspace shows ("The workspace window shows a picture: “Picture: a red fox…”", "…is
  empty"), so "clear that" and "what's on screen?" mean something, and **clear_workspace** blanks
  it. While a game owns the screen neither applies: the game describes itself and its tools run
  the screen.

### Skills Trinity creates (`services/skill-forge.ts`, `sandbox/`)

- **Pipeline.** A coder (the strong one, with the quick one as the fallback) writes one ES module
  (`export default { name, description, input, examples, run }`); it is described and
  self-tested with its examples in the sandbox, gets one repair round with the failure fed
  back, and is saved to `data/skills/<name>.skill.mjs` (+ `data/skills/index.json`).
  `create_skill` answers at once and works in the background; when the skill is ready Trinity
  says so in the live call (and runs it once if the request already contained a task for it).
  News the call didn't say in full — the call that asked is gone, or the user cut it off — is
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

- **remember** turns what the user said into one sentence, replaces a changed fact, skips
  repeats, and stores the user's name as their profile name (it personalizes the voice
  prompt, answers and reminders). Two facts from one request never overwrite each other. With
  no model the user's own words are kept in the third person ("The user doesn't eat pork.",
  "The user really likes jazz.", "The user went to Peru."), after lead-ins like "Trinity,",
  "could you please" or "make a note of this:".
- **The user's name** is one memory, tagged `name`, that states it ("The user's name is
  Rob.", "The user goes by Rob."). A new name — through remember, curation or Settings —
  replaces the name in it and keeps whatever else it says ("…is Rob, and he works nights");
  memories about other people ("The user's son is named Ryan Jr.") are never taken for it.
  Clearing the name in Settings removes a name-only memory or takes the name out of one that
  says more; editing the name memory to another name changes the profile name.
- **recall** answers only from saved memories, spoken verbatim; it says so when nothing is saved.
- **Curation.** Durable facts are also extracted from conversations automatically (not from
  in-character game talk). An exchange that remember already handled isn't curated again; after
  schedule or recall the request itself — the reminder, the question — isn't saved, but anything
  else said in the same breath ("I'm Ryan, remind me at five…") still is. Only the user's words
  are memories: what the agent said helps read them (an answer to its question), but a reminder it
  set or a plan it confirmed is never saved. Each exchange keeps up to three new facts, plus the
  user's name whenever they say it, which is asked for even when a memory already holds it and
  never takes one of the three places. Settings → Memory lists,
  searches, edits and deletes them. Memory ids are letters and digits (PouchDB reserves ids
  starting with `_`).

### Heartbeat (`heartbeat.ts`, `tools/schedule.ts`)

- **schedule** parses natural language with the fast model (or a keyless pattern reader) into
  a one-time reminder or a recurring task, in the engine's local time zone. The model gets the
  full date with the year and returns calendar dates as `YYYY-MM-DD`; "November 12th", "nov 12"
  and "the 12th of November" also read, a date already past means next year's, and "next
  Friday" is the coming one (a week away when said on a Friday). Only what the user said
  counts: a clock time, am/pm, part of the day or repeat the model adds on its own is dropped,
  and the earlier lines reach the model only when the user is answering its question about
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
  to…" and "set a reminder…" said as the request are reminders, and so are the user's own "I need
  you to / I've got to remember to…" and one after an acknowledgement ("thanks, and remember to…");
  never one inside a job ("brief me on the news and (also) remember to include the weather") or for
  someone else ("tell Sam to remember to…"). An answer to the when-question reads the request it
  answers the same way. With no model, "set a reminder for the meeting at 2" is "Remind me about
  the meeting.", "set a reminder for 5pm" asks what to remind of, a "for <day>" after the
  reminder's own verb stays in its words ("remind me at 5 to buy a gift for Friday" is today at 5),
  and a snooze right after a reminder came due ("snooze it for ten minutes", "ten more minutes",
  "remind me again at 5") sets that reminder again, read from the agent's last line. Dotted times
  ("at 3.30pm") and decimal delays ("in 1.5 hours", "every 1.5 hours") read too, while "for 1.5
  hours" stays in the reminder's words, and an ordinal the request goes on with ("on the 2nd
  floor") isn't a day. A delay under three days that isn't whole days is said in hours, with its
  day ("in thirty-six hours, at ten PM tomorrow").
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
quick and strong coders and default, brain, reply writer, fast JSON, images, speech and its voice,
Jev; endpoints; live-loop timing; per-field reset to the `.env` default), **Voices** (hear a sample of
every voice; the live voice clean-up switch; record or drop a sample of your own, trimmed to the best
≤8 s of speech, normalized, uploaded to the pod), **Skills** (built-in tools, skills
Trinity created — switch, read the code, test, delete — the approval mode and a "create a skill"
box), **Memory** (your name, search, edit, add, delete), **Heartbeat** (reminders and recurring
tasks), and Saved games (for the Game Master). Changes broadcast to open pages.

## Voices (`services/voices.ts`)

Built-in presets plus custom voices made from a short sample (1–12 s WAV, converted to 16-bit
mono). Custom samples are uploaded to the pod (`POST /api/voices`, bearer admin token) and
verified by SHA-256 before a call uses them; if one can't be confirmed, the call falls back to
the default voice rather than failing.

**Samples.** The built-in presets exist on the pod only as embeddings, so to hear one the pod
speaks a fixed line in it (`services/voice-samples.ts`): the engine borrows the voice session,
holds the model quiet except for the forced words, collects the audio until the echo of the line
is complete, trims the silence and caches a 24 kHz WAV in `data/voices/samples/`. Settings →
Voices plays a cached sample from a ▶ on each voice, makes one on first play (about ten
seconds), or makes them all in one go. A sample is never made while a call is live.

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
