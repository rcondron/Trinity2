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
| **Coding skill** | **Mordiem** `deepseek-v4-1-flash-1017-ultrafast` (quick, the default) and `kimi-k3` (strong) | Builds interactive pages for the workspace (streamed) and writes new skills. |
| **Brain** | **Mordiem** `claude-sonnet-5-5` | Questions that need real knowledge or reasoning (`ask_brain`). |
| **Card designer** | **Mordiem** `deepseek-v4-1-flash-1017-ultrafast` (≈1.3 s a card; `claude-sonnet-5-5` ≈9 s, the most careful) | Information cards on the board (`show_card`): the facts, layout, look and picture brief. |
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
- **Talking (`services/talk.ts`, the "polished" talk style — the default).** The voice never
  improvises: it is held for the whole call (a standing hold, `talk:polished`) and says only words
  it is given. A finished sentence that no tool takes is answered by the *talking brain*: a text
  model (`chatModel`, blank = the Brain) that gets the persona, the last ten turns, the user's
  profile and the memories that bear on the words, the time and the situation, and writes a reply
  that is streamed a sentence at a time and capped in code (`streamSpoken` in `agent/reply.ts`):
  two sentences, three for a why or a how, six when the user asks for a story or detail. It starts
  writing when the sentence ends, beside Jev's final decision; a tool that fires takes the turn and
  the draft is dropped; a draft that is written waits at most 1.5 s on a slow Jev. If the chat
  model hasn't said a word in 1.2 s the backup (`chatBackupModel`) starts beside it and the first
  to speak has the turn; after two turns with no model at all the hold is released and the voice
  improvises for the rest of that call. Two replies are special: `ACT` (the words ask for something
  to be done and no tool took them: the solver, `figure_out`, gets them) and `SILENT` (a filler, half
  a thought, talk meant for someone else). A sentence that trails off ("I want to…") gets 700 ms
  more, and a reply that hasn't started is dropped when the user goes on, so one thought gets one
  answer. Knowledge questions Jev routes to `ask_brain` take the same streamed path. A long line a
  tool hands over to be read stops at about ninety words ("…Say keep going to hear the rest"). The
  "free" talk style (Settings → Models → How Trinity talks) is the earlier behaviour: the voice
  improvises whatever no tool answers, quieted only by the holds below.
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
  pump keeps the model stepping; a filler ("One moment.") covers slow tools. `announce()` lets
  background work speak up unprompted (a due reminder, a new skill that's ready): it waits up
  to 15 s for a call that's still connecting (words sent before the pod's hello are lost),
  its turn behind any reply, and a pause in your speech, and it resolves `"said"` once the
  whole line was said, `"cut"` when the user cut it off (talked over it, or tapped to end
  the turn) and `"owed"` when no call that can be heard was up (none, its tab has had no tap
  or key press yet, it closed or moved to another window, or no hello in time). An owed line
  waits for the next call that is up and can be heard (oldest first, at most five, for up to
  10 minutes) and that call says it; with no call anywhere the engine sends a `wake` so one
  tab warms one, and a call whose tab can't play yet asks it for a tap (`owed`). The browser
  plays nothing before a gesture, so the first click or key press anywhere on the page sets
  playback up, not only a mic tap, and tells the engine (`playback`; a call opened in a tab
  that already plays says so as its socket opens). Every line is also shown as text at once;
  a cut one is never read out again, and when an owed one is said, that call's tab drops the
  text (`announced`). No other voice stands in for PersonaPlex: the browser's own speech reads
  lines only in browser-speech mode, when no live voice is set up.
- **Barge-in.** Talking over the agent — two words, or one that plainly means stop — flushes its
  queued words at the pod (0x05) and in the tab's speaker (a `flush` event). A word of agreement
  while she talks ("yeah") is not a cut-in. Talking over a filler ("One moment.") drops only the
  filler: the reply behind it is said once the user has finished. Replies that were queued before a
  cut-in stay silent, and the tap that ends a turn cuts only what is being said at that moment — an
  answer on its way is still said. An order-aware echo gate ignores transcripts of the agent's own
  voice.
- **When something fails.** Jev is given 3.5 s; after that, or on an error, the keyword rules (and
  for a finished request the second opinion) decide, and their pick fires — it does not inherit
  Jev's error. A tool that fails or asks a question is spoken in its own words; with none, the reply
  writer is told it failed and may not confirm it. Deepgram is retried even when its first
  connection failed. A pod that takes audio and returns nothing for 8 s is treated as gone and the
  call ends cleanly (the tab warms a new one).
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
| `control_card` | Operates what's on a card: play, pause, restart, reset, mute, louder, skip, loop, speed, next / previous, press a named control, set a value, scroll — on videos, audio, timers, games and any widget, one card or several (“start the timer”, “pause everything”). The board runs it in the window and reports what actually happened. |
| `read_card` | Reads a card or answers a question about it from its live text (“how much time is left on the timer?”, “what are the ingredients?”). |
| `edit_note` / `rename_card` / `duplicate_card` | Change a note's words (“add eggs to the shopping list”, “cross off milk”), retitle a card, copy one. |
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
- **Two coders on Mordiem.** A quick one (default `deepseek-v4-1-flash-1017-ultrafast`, a page in
  about 2 s) and a strong one (`kimi-k3`); settings keys `glmModel` / `kimiModel`. Jev's `coder`
  option or a name in the utterance ("the quick coder", "the strong one", a model's name) picks
  one; Settings default otherwise. On failure the other coder takes over once on the same card.
- **Models that disappear** (`services/model-health.ts`). The gateway's catalog changes; a
  configured model that is no longer served (as `mercury-3`, the first quick coder, was) is stood in
  for by the first available model of a short list for its role — checked at start, every ten
  minutes and when settings change — and Settings → Models shows the swap. The stored setting is
  left alone, so a model that comes back is used again.
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
  WebSocket to the engine at `/ext`, paired by a one-time code and a key exchange with a mutual
  challenge on every connection (see "The browser extension: pairing, control and fill" below). The
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

- **Card selection.** Every board tool reads the same selection (`workspace/card-select.ts`): numbers and ranges
  (“cards 2, 3 and 5”, “1 through 4”), all, a kind (“the pictures”), what cards show (“the tiger and the panda”), a
  place (“the card on the left”), recency (“the last two”), a state (“the minimized ones”), exclusions (“everything
  except the timer”, “keep card 2 and close the rest”) and pronouns (“it”, “them”) — the cards just made or acted on.
- **Card commands.** `workspace/card-commands.ts` sends `{id, n, op, arg}` to the open windows; the board runs it
  on the card (its video or audio, or inside a widget's frame: controls found by label, fields, media, scrolling, and
  `window.trinityControls` hooks the coder is asked to define) and answers with what happened, so Trinity only says
  “started the timer” when a Start control was pressed. Cards moved or resized by hand reach the engine the same way.
- Media, notes, builds and content cards share one board app (`board@7`): each **make_image** /
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
  and can play it (one per browser, by Web Lock). If none can, the line is owed: shown as text,
  and said by the next call that can be heard (see `announce()` above).
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
`ALLOWED_HOSTS`), which stops DNS-rebinding pages from reading its API. Being on loopback is not a
lock, though — any page on another port and any local program can reach it — so every HTTP request
and every socket is authenticated (`server/src/auth.ts`): a **linked browser** shows the session
cookie the engine gave it (HttpOnly, SameSite=Strict) together with proof that the request comes
from one of the app's own pages (an `Origin` on the exact allow-list, or for requests browsers send
without one `Sec-Fetch-Site: none` on a GET, or `same-origin` with an allow-listed `Referer`) and
proof that it came through Trinity's own web server: Vite's proxy (and the test harness's) adds
`x-trinity-proxy` with the secret in `data/proxy.key` (`server/src/proxy-key.ts`), so a different
program on the app's port, which is on a trusted origin and gets the cookie (cookies don't keep to a
port), still can't use it. The engine's own address is not an app origin (it serves no pages). A
script shows the **API key** (`Authorization: Bearer …`; `data/auth.json` or `TRINITY_API_KEY`). The
first browser to open the app is linked at once; once one has been, every later link needs the
six-digit pairing code printed when the engine starts and shown in Settings on a linked browser, even
after all are unlinked (a damaged `auth.json` is kept aside and fails closed the same way). Every
`trinity_session` cookie a request carries is tried (a planted one can't lock the user out).
`TRINITY_ORIGINS` adds app origins, http(s) only (LAN use, test harnesses); `TRINITY_AUTH=off`
switches the checks off, and the vault then stays locked. Vite serves only `web/` (`server.fs`), sends
no CORS headers and won't move to another port (`strictPort`): before, it served every file of the
project, `data/` included, to pages on any localhost port. Settings updates are validated (kinds,
ranges, addresses), and a service's key is used only with the address it was entered for: change the
address and the key is withheld until the key for the new address is entered (`settings.ts`; a key
value that fails validation never counts as a new key). An API error never quotes a request body it
couldn't read. Generated pages run in opaque-origin frames with no network
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

## The vault (`server/src/vault/`, `routes/vault.ts`, `tools/vault.ts`, the secure sheet in `web/src/workspace/view.ts`)

Website logins, payment cards, contact details and other secrets, encrypted on this computer.
One rule shapes all of it: a secret exists only in the vault file (encrypted), in the engine's
memory while the vault is unlocked, in an encrypted envelope on the extension's socket, and in
the page field it is typed into. It is never in a model prompt, in speech, in a tool's result, in
a workspace or app event, on a card, in `workspace.json`, in memory, in a log, in an error message
or in a URL. Tools speak labels and hosts ("Saved your Netflix login."); secrets are typed, never
spoken and never asked for by voice.

**The store (`store.ts`, `crypto.ts`).** `%LOCALAPPDATA%\Trinity\vault` (`~/.config/trinity/vault`
elsewhere; `TRINITY_VAULT_DIR`, or `<TRINITY_DATA_DIR>/vault` in tests): `vault.json`, `device.key`,
`attempts.json`, `access.log`, each written temp-then-rename. A random 32-byte *data key* seals
every item's secret JSON with AES-256-GCM — a fresh 12-byte IV per write, associated data
`id|kind|version` (the version counts that item's writes). The data key is itself wrapped with
AES-256-GCM by a key-encryption key: HKDF-SHA256 over the *device secret* (lock "device"), or over
the device secret followed by scrypt(passphrase, N = 2^17, r = 8, p = 1, random salt; files made with
N = 2^15 still open, and absurd parameters are refused) (lock "passphrase"; just the scrypt output on a
computer with no key store). Every lock change makes a new data key, re-seals every item and writes
once, so a copy of the file from before can't open what was saved after; a lock and a lock change
can't interleave, and nothing is ever sealed or written under a wiped key. The plain part of the file
— each item's label, kind and hosts, a masked user name ("r…@gmail.com"), a card's brand, last
four digits and expiry, the lock mode, the spending limit — is covered by an HMAC-SHA256 under a
key derived from the data key, checked at every unlock, so the hosts a login may be filled on
can't be edited behind the vault's back. Fail closed: an unknown version, JSON that doesn't parse,
a field of the wrong shape, a tag or MAC that doesn't verify — the vault reports itself blocked,
hands out nothing and never writes over the file.

**The device secret (`dpapi.ts`).** 32 random bytes protected by Windows DPAPI (CurrentUser),
reached through `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile
-NonInteractive -EncodedCommand <script>`; the script is constant and the bytes travel on stdin
and stdout as base64, never in arguments, the environment or a file. One PowerShell start per
engine run; the secret is cached in memory afterwards. Without DPAPI (not Windows, PowerShell
missing) there is no device secret and only the passphrase lock can be chosen: an unprotected key
is never written. DPAPI stops other users and other computers, not another program running as
this user — that is what the passphrase is for.

**Locks.** "device" (the default on Windows) unlocks by itself on first use. "passphrase" is
typed into a secure form (or Settings → Vault); the vault locks again after 15 idle minutes and
whenever the engine restarts, and after five wrong passphrases each further try has to wait (30 s,
doubling to at most 15 minutes; the count survives a restart). Leaving the passphrase lock, or
changing the passphrase, needs the current one even while unlocked. `vaultStatus().blocked` is
set — and nothing unlocks, no form opens — while sign-in checks are off (`TRINITY_AUTH=off`) or
`HOST` is anything but 127.0.0.1 / localhost / ::1.

**Items (`items.ts`, `totp.ts`).** Hosts are exact lower-case names; a login is fillable only on
`https://<one of its hosts>` (no wildcards, no "www." guessing; `addHost` adds one after the user
approved it). A card number must pass the Luhn check; its brand comes from its prefix; the security
code is kept only if "Keep the security code" was ticked, and otherwise asked for each time in a
one-time form. A login may carry an authenticator key (base32, or an `otpauth://` link): the
six-digit RFC 6238 code is computed in the engine.

**Using a secret.** `useSecret(id, purpose, fn)` is the only way out: it decrypts, hands `fn` an
object whose fields read as the real strings but which prints, serializes and inspects as
`[secret]`, adds `totpCode` for a login with an authenticator key, and empties the object when
`fn` is done (and when the vault locks under it). What `fn` returns or throws is searched for the
password, card number and the like before it is passed on: a hit becomes a "leak" error. Each use
is appended to `access.log` as `{ts, id, purpose, ok}` — never a value. Every failure is a
`VaultError` with a code and a fixed sentence; errors from parsers and libraries (which can quote
what they choked on) are never passed through.

**Secure forms (`forms.ts`).** `openForm(req)` makes a ticket (32 random bytes, ten minutes) kept
in memory only, puts a placeholder card on the board (kind `form`: a lock, the title, "Waiting for
you in the secure form") and sends every workspace window `{type: "form", form}` — a descriptor,
never a value; `{type: "form_closed", id, status}` ends it, and a window that connects later gets
the open forms after its snapshot. The window draws the form itself, in the trusted host page
(`view.ts`), as a sheet over the stage: built with `createElement`/`textContent` only, the frames
`inert` beneath it, focus trapped, Escape = cancel, password-type inputs with Show/Hide whose
`autocomplete` keeps the browser's own password manager out, the card number grouped in fours with
its brand, and the fixed line "Typed here, this goes straight into Trinity's vault. Trinity and
its models never see it." Submit is `POST /api/vault/forms/<id>` with `{values}` to the page's own
origin (the session cookie authenticates it); the inputs are blanked before the sheet is removed.
Nothing typed goes over a socket, into a frame or into the view's diagnostics. Purposes:
`save-login`, `save-card`, `save-identity`, `save-secret` (always the vault's own fields; a login
form opened for a host saves for exactly that host), `one-time` (values held for one `useOneTime`
within two minutes, then wiped), `confirm` (no fields: Approve / Cancel) and `unlock`. A form that
needs the vault's key while it is locked with a passphrase waits behind the passphrase form.
Removing the placeholder card or clearing the board cancels the form; the card has no undo entry,
card tools refuse to read, edit, copy or control it, and a start-up sweep drops any left on a
saved board.

**Routes (`routes/vault.ts`).** Their own JSON parser (16 kB), mounted ahead of the general one
and behind authentication; no route returns a secret and no error echoes or logs a body. `GET
/api/vault` (status, item metadata, settings, the fields each kind of item is typed into), `POST
/api/vault/items`, `DELETE /api/vault/items/:id`, `POST` and `DELETE /api/vault/forms/:id`, `POST
/api/vault/lock`, `POST /api/vault/unlock` (for Settings), `PUT /api/vault/settings` (lock mode,
passphrase, spending limit).

**Voice tools (`tools/vault.ts`, all `sensitive`).** `vault_save_login` ("save my Netflix
password": the site comes from the page the user is on, or from the words — then as a value to
check in the form's Website field), `vault_save_card`, `vault_save_details` — each opens a form,
answers at once ("I've opened a secure form on the workspace. Type it there — I can't see or hear
it.") and says "Saved your Netflix login." when it is submitted; `vault_list` (names only);
`vault_forget` (asks first, and only "yes, remove it" removes: a passing "okay" re-asks). Stray
`/api/vault` requests get a fixed 404 that never reads or echoes a body; the vault refuses to work when
`TRINITY_ORIGINS` names a plain-http origin on another computer, and lists nothing while it refuses.
Settings → Vault shows the lock and changes it, lists and
removes items, adds them (a form on that page posting to `/api/vault/items`), sets the spending
limit and lists the linked browsers with a code to link another.

**Hardening done with it.** The card runtime never reads or sets a password, one-time-code, card
or otherwise secret-named field in a widget; the title comment in `cardEditableHtml` is escaped;
the board's same-origin sandbox branch is gone (`board@8`); a frame document always starts with
Trinity's own `<head>` and Content-Security-Policy, with the payload after it; and the asset
fetcher asks only for the exact file names the engine's media routes serve.

**Tests.** `npx tsx scripts/test-vault.mts` (a fresh `TRINITY_DATA_DIR`, an empty `.env`, a free
port): the cryptography and every kind of tampering, DPAPI on this computer, the passphrase lock,
Luhn / brand / expiry, the RFC 6238 vectors, forms, the routes on a real engine in the same
process, the sheet against a stand-in DOM, and a canary run that saves and uses unique values and
then searches tool results, every socket event, the snapshot, `workspace.json`, the console and
every file written for them.

**Known limits.** With the device lock, another program running as the same Windows user can ask
DPAPI for the key. JavaScript strings can't be wiped: decrypted values live in the heap until
collected (key bytes and plaintext buffers are zeroed). Replacing the whole vault file with an
older copy of itself is not detected. To start over, delete the vault folder.

## The browser extension: pairing, control and fill (`extension/`, `services/browser-bridge.ts`, `tools/browser.ts`, `tools/browser-fill.ts`)

The Trinity Browser Bridge (Manifest V3, plain JavaScript, no dependencies) keeps one WebSocket to
the engine at `/ext`. The engine's calls run through Chrome's extension APIs; tab changes and what
the user shares from a page come back. Four files: `background.js` (the service worker: the
connection, the calls, what a tab that holds a fill refuses), `proto.js` (keys, pairing, the
handshake, sealed fills — pure WebCrypto, shared with the Node tests), `page.js` (everything that
runs inside a page, as ONE self-contained function handed to `chrome.scripting.executeScript`),
`store.js` (IndexedDB), plus the popup.

**Pairing (once).** Settings → Browser asks `POST /api/browser/pairing-code` for a code: 8
characters from an unambiguous alphabet, good for ten minutes, five tries, one pairing. The user
types it into the popup. The extension sends `{type:"pair", id, pub, mac}` — its ECDH P-256 public
key and `HMAC-SHA256(code, "trinity-pair-v2|" + pub)`; the engine checks the MAC in constant time,
checks that `id` is the id in the socket's `Origin` and that the key is on the curve, stores the
key and id, and answers `{type:"paired", pub, mac: HMAC(code, "trinity-paired-v2|" + enginePub +
"|" + extPub)}`; the extension verifies that before it pins the engine's key. The code never
crosses the wire. Keys: the extension's pair is made with `extractable: false` and kept in
IndexedDB; the engine's static pair (`node:crypto` ECDH) and the paired extension's public key and
id are in `<data>/extension-pairing.json`. Nothing is in the socket URL, in `chrome.storage`, or in
`GET /api/browser` (state, `paired`, tabs as title + host, the extension folder).

**Every connection (mutual proof).** `hello {id, nonce nE}` → `challenge {nonce nS, proof:
HMAC(K, "engine|nE|nS")}` → `auth {proof: HMAC(K, "ext|nS|nE"), version, chrome, caps, tabs}` →
`welcome {own: Trinity's own origins}`, with `K = HKDF-SHA256(ECDH secret, salt "trinity-ext-v2",
info "link")`. Both ends are small state machines (`Link` in `proto.js`; `Peer.phase` in the
bridge): the extension runs no `call` before the engine's proof verifies and `welcome` arrives, and
the engine sends none — and accepts no tabs, shares or results — before `auth` verifies. The
upgrade itself is refused (403) unless `Origin` is `chrome-extension://<the paired id>`, or any
extension's while a code is live. A newer proved socket replaces the older (closed 4409: the
extension steps back until Connect is pressed); one that hasn't proved K never does, is closed
after 8 s, and its messages don't count. 4401 (not paired / wrong proof / unpaired in Settings) is
not retried: the popup says "Pair again". An engine that fails the proof is never mistaken for
that. `connect()` is single-flight.

**Calls.** `tabs.list / open / close / activate / navigate / history / zoom / move / duplicate /
pin / mute / group / ungroup / reopen`, `windows.create / close / update`, `page.snapshot / act /
wait / total / inject / restore / capture / fillProbe / fill`, `files.download / savePage`.
Snapshots never carry a field's value, never use a value as a name, and leave password,
one-time-code and card fields out altogether; they reach into open shadow roots and frames
(refs carry their frame id), list what is on screen first, and keep the elements behind the refs in
the extension's isolated world rather than in page attributes. Clicks send the pointer and mouse
sequence; a `target=_blank` link is opened by the extension; scrolling finds the box that actually
scrolls and reports whether anything moved; Tab, Enter, Escape, the arrows, Space and Backspace do
what a real key would (or are reported as having done nothing). Injected style sheets are recorded
in `chrome.storage.session`, so undo works after the worker restarts. Trinity's own tabs (the
origins the engine names in `welcome`) are never read, changed, navigated, captured or closed —
the engine's tab targeting leaves them out too, and "this page" with Trinity in front means the web
tab used last.

**The guard on pressing things.** One list of words in two places (`browser-words.ts` `GUARD`,
`page.js` `GUARD`; a test keeps them equal): spending (buy, pay, order, checkout, book, reserve,
subscribe, donate, bid, transfer) and saying-so (send, post, delete, remove, confirm, authorize,
allow, grant, accept, submit, …), matched as whole words. The extension holds a click, an Enter or
a "type … and submit" whose control — for Enter, the form's submit button — carries one of them,
unless the engine approves that exact name. The engine approves a say-so control when the user's
own words named it, and a spending control only from the answer to a question that names the site
and, when the page shows one, the total (`askYesNo` with the words a yes must contain). Never for
a planner's step or a scheduled run.

**Fill.** `browser_sign_in`, `browser_fill_card`, `browser_fill_details` (all `sensitive`) know a
vault item by id and label only. Inside `useSecret` the values go to `browserSecretCall`, which
seals `{values, expires}` with AES-256-GCM under `Ks = HKDF(K, salt nE + nS, info "session")`, a
fresh IV, and AAD `callId|page.fill|origin|tabId`; logs nothing; turns every failure into a fixed
code; and returns only whitelisted fields. The engine checks the page's exact host against the
login's hosts before sending. The extension then checks, before a character is typed: the origin
is an https origin; the tab is not Trinity's own; the tab's own URL is https with exactly that
origin; the envelope opens with this connection's key for exactly this call, origin and tab, is
not older than ten seconds and was not used before; the document is still the one that was probed
(`documentIds`). In the page (isolated world, top document only): `window === top`,
`location.origin`, `isSecureContext`; fields classified by `autocomplete`, then `type`, then name /
id / placeholder / label; only enabled fields a person can see (sized, not hidden or transparent
anywhere up the tree, not clipped, not off the page, not under something else); never a form whose
`action` — or a button's `formaction`, read past any element named "action" — leaves the origin;
values set with the prototype's setter plus composed `input` and `change`. What comes back is
which kinds were filled. Until that tab leaves the site, it runs no injected script, takes no
style sheet with `url()` or `@import`, and gives no screenshot or saved copy — the same holds for a fill that failed after it began typing, and for the filled document itself when it comes back out of the tab's history. The other order is closed too: a document Trinity ran a script in, or gave such a style sheet (the worker keeps their document ids), is refused by `page.fillProbe` and `page.fill` with the code "scripted" until the tab is reloaded. A card is filled
only after a yes naming the card and the site, or the Approve button of a "confirm" form when the
total is above the spending limit or can't be read; a security code that isn't kept is typed into
a "one-time" form and used once; Pay is never pressed.

**Tests.** `scripts/test-browser-link.mts`: pairing and the handshake over a real socket with the
extension's own protocol code — wrong and expired codes, the attempt limit, both MACs, a rogue
engine, unproved sockets, a replayed `auth`, replacement, sealed envelopes.
`scripts/test-browser-fill.mts`: the page code on the fixture pages (`scripts/fixtures/browser/`,
on a small stand-in DOM), then the real service worker under a pretend Chrome against the real
bridge, then the tools end to end against an in-memory vault and the engine's own, and a canary
search of everything observable. `node scripts/serve-fixtures.mjs` serves the same pages (two
origins) with `window.trinityTest` for checking the page code in real Chrome.

**Known limits.** Pairing trusts the page that shows the code: a program that took the engine's
port while the engine was down could show its own. After the handshake, calls are not signed one
by one (a relay between the two ends is outside what loopback allows other users' programs, and a
program running as the same Windows user can read the pairing file anyway). The page a login is
filled into can read it — that is what filling means; cross-origin frames (most card forms from
payment providers) are never filled. Closed shadow roots are not entered.

## Files and documents (`services/files.ts`, `files/`, `tools/files.ts`, `routes/files.ts`)

Trinity makes and keeps files: documents (PDF, Word, Markdown, plain text, a web page), spreadsheets
(Excel, CSV) and saved words (text, Markdown, JSON, CSV, HTML). No package was added for any of it.

- **The store** (`services/files.ts`). Files live in `data/files/`, flat. A file's bytes are at
  `<id>.<extension of its kind>` — the id is sixteen hex digits the store makes — and `index.json`
  lists id, name, kind, size, created / updated and a one-line description. The name people see
  never becomes a path: it is cleaned (no path parts, no control or invisible characters, no
  reserved Windows names, 80 characters at most, the extension taken from the kind) and only ever
  travels as text. Every path is still resolved and refused unless it sits directly in the folder,
  and a link is never read, served or followed — a file, the index, or the folder itself. Content
  must be what its kind says (UTF-8 for text, JSON that parses, the format's first bytes for the
  binary kinds). Caps: 10 MB a file and 500 MB in all (`TRINITY_FILES_MAX_MB`,
  `TRINITY_FILES_TOTAL_MB`), 2000 files; nothing is ever deleted to make room — the save is
  refused and says so, naming the oldest file. Writes are atomic (a temporary file, flushed, then
  renamed): the bytes, then the index; a delete removes the bytes first. So a crash leaves a listed
  file without bytes (dropped at the next read) or bytes without an entry (listed again as
  "Recovered …"), and an index that can't be read is kept aside while the folder is listed again.
  `fileInfo(id)` / `describeFile(file)` give the one description of a file for display (`FileInfo`:
  id, name, kind, mime, type, size, url, downloadUrl, opens, times, description); `onFileChange`
  tells listeners of every save, rename and delete.
- **The writers** (`files/`). `zip.ts`: a zip writer over `zlib.deflateRawSync` — local headers,
  central directory, CRC-32 (`zlib.crc32`, or a table where Node lacks it), UTF-8 names — and a
  small reader that checks what it reads. `document.ts`: the Markdown-like markup a model writes —
  headings (three levels), paragraphs with bold / italic / code, nested bulleted and numbered
  lists, tables, quotes, rules, `[[pagebreak]]` — parsed to blocks and rendered as a printable HTML
  page, plain text or Markdown; nothing in it is ever passed through as HTML. `docx.ts`:
  WordprocessingML by hand (content types, relationships, document, styles, numbering with a list
  of its own for every numbered list, settings, properties). `xlsx.ts`: SpreadsheetML — a sheet
  each, shared strings, numbers as numbers, yes / no as booleans, dates as ISO text, a bold header
  row, column widths from the content; text is never a formula. `csv.ts`: RFC 4180 with a
  byte-order mark for Excel; text a spreadsheet would run as a formula gets an apostrophe.
  `pdf.ts`: the HTML page printed by a Chromium-family browser found on the machine (Chrome, Edge,
  Brave, Chromium in their usual places, or `CHROME_PATH`) — headless, a throwaway profile,
  30 seconds at most, one at a time, the temporary folder removed afterwards — with no way out to
  the network: a Content-Security-Policy goes first in the page (`default-src 'none'; style-src
  'unsafe-inline'; img-src data:; font-src data:`), http-equiv metas and `<base>` are taken out,
  and the browser is run with `--host-resolver-rules="MAP * ~NOTFOUND"`. With no such browser, or
  one that fails, a built-in writer lays the words out in Helvetica (wrapped, paginated, a title,
  lists, tables in columns) and the result says the simple layout was used.
- **What goes in** (`files/authoring.ts`). The brain model writes a document or a table as one
  JSON object (`{title, show_title, description, body}`, `{title, description, sheets}`) that is
  checked before anything is made of it. A reply that isn't that object, or fails a check, is
  asked for once more with the reason; a second failure is said as a failure, never papered over.
  The model writes from the user's words, the conversation, the situation and the last tool
  results — each handed over marked as data — and is told never to invent a fact about the user:
  what isn't known is a blank in square brackets (counted, and said) or an empty cell.
- **The tools** (`tools/files.ts`; each reads the whole sentence). `make_document` — a PDF unless
  the words ask for Word or something editable, Markdown for notes, plain text or a web page;
  "turn this card into…" hands over the card's words. `make_spreadsheet` — an Excel workbook, or a
  CSV when asked. `save_file` — words as they are: dictated, a card's, or what Trinity just said
  ("save that note as shopping dot t x t"). `list_files`. `read_file` — text kinds; a long file is
  summed up in two sentences by the fast model with an offer to read it, answered through
  `agent/pending.ts`. `open_file`, `rename_file`, and `delete_file`, which always asks first
  (everything at once takes "yes, delete all"). Each answers within about eight seconds; slower
  work carries on in the background and is told when it's done (`agent/tell.ts`). What is said is
  built in code, in one or two sentences. A file goes on the board through `showFileCard(file)`
  alone (for now a note: "File: <name>", a line about it, its address), and the board follows the
  store when a file is renamed or deleted. Reading, opening, renaming and deleting are offered
  only when there are files, with the files as Jev's options; a context provider tells Jev which
  files exist, adds the routing rules, and hides all eight tools while a game has the board.
- **The routes** (`routes/files.ts`, under `/api`, behind the guard). `GET /files` (each file as
  `FileInfo`, and the space used), `GET /files/:id/:name` (the id is the file; the name must be
  the stored one; `?download=1` always downloads), `DELETE /files/:id`. A file is served with the
  type of its kind and `nosniff`; PDFs, text, pictures and pages open in the browser, everything
  else downloads. A saved web page is served with `Content-Security-Policy: sandbox`: it gets an
  origin of its own and runs no script, so nothing saved can act as the app. A linked browser
  opens a file by plain navigation from one of the app's pages; the guard wants that navigation's
  Referer, so such a link must not be `rel="noreferrer"`.
- **Tests.** `scripts/test-files.mts`: the zip, docx, xlsx, csv and PDF writers read back (the zip
  by another program's reader too), the printed page's isolation against a local server, the store
  (names, traversal, caps, links, the index), the routes behind the real guard on a scratch port,
  and the tools against a fake gateway.

## The game engine: rules in code, the model only narrates (`server/src/game/`)

The Game Master runs tabletop games by the rules of the System Reference Document 5.2.1 (CC BY
4.0; the attribution line is in `game/srd.ts` and in every game view's `about`). The model never
decides a hit, a save or a number. Several players share one microphone, so every game tool
fires at the end of a sentence (`argMode: "raw"`), and what is said about a result is built in
code and returned as `speak`.

- **Rules** (`game/rules.ts`). Pure functions with an injected die (`Rng`; `cryptoRng` in play,
  `seededRng` and `scriptedRng` in tests): dice expressions, advantage and disadvantage, ability
  modifiers, proficiency, skills and saves, the DC ladder, attack rolls with natural 20 and 1,
  cover, damage types with resistance, vulnerability and immunity, temporary hit points, healing,
  dropping to 0, death saves, stabilizing, the fourteen SRD conditions with their effects and
  durations, exhaustion, concentration (DC 10 or half the damage, 30 at most), initiative,
  surprise, opportunity attacks, passive scores, contests, short and long rests, spell slots,
  inspiration, XP and levels, and encounter XP budgets.
- **Reference data** (`game/srd.ts`, `game/bestiary.ts`). Class profiles, ready-made heroes,
  weapons, armor, prices, twenty-five spells, short answers to rules questions, and seventy-four
  SRD creatures (challenge 0 to 10) with stat blocks. `validateStatBlock` holds a creature the
  model invents to the bounds of its challenge rating; `buildEncounter` spends the party's XP
  budget on creatures that fit the scene and says why; `healthBand` turns hit points into what
  the table may know (healthy, bloodied, near death, down).
- **The engine** (`game/engine.ts`). What happens to a game document when something is
  resolved: a fight's turn order (initiative, rounds, monsters taking their turns by simple
  stated rules, death saves on a downed hero's turn, the order closing up behind the dead),
  attacks, spells, the standard actions, rests, items and gold, creatures arriving and leaving,
  XP and levels. Each function changes the document in place inside one `mutateGame` call and
  returns the sentences to say, results first ("17 plus 5 is 22 against armor class 15, a hit
  for 9 slashing damage"), ending with who is next.
- **A turn** (`game/adjudicate.ts`, `game/story-tools.ts`). Adjudicate: patterns first, then one
  small bounded model call, classify what was declared (who, what kind of action, the target,
  the skill, a DC on the ladder). Resolve: the engine decides and applies it atomically.
  Narrate: the code-built result is spoken, with at most forty words of narration written by the
  model from the resolved facts only; if that call is slow or fails the code-built line stands
  alone. One story turn runs at a time per game (`kit.withTurn`). Who acts is resolved in code:
  a hero or player named at the head of the sentence, else the hero on turn, else the
  spotlight, else the Game Master asks "Who is doing that?" and the bare answer completes the
  action. Out of turn, a hero is told whose turn it is and nothing changes.
- **Things the Game Master waits for** live in the game document (`pending`): a roll that was
  called for ("I rolled a 14", or "roll for me"), a yes or no before a destructive step (a new
  game over one in play, removing a hero, loading over a game in play, ending the campaign), and
  a "who?" or "which one?". A shared pre-flight (`kit.guarded`) settles them whichever game tool
  the router picked.
- **Questions** (`game_answer`) are answered from the state with no model: repeat, recap, whose
  turn, hit points, armor class, slots, gear, gold, what a hero can do, the quest, the rules.
  `game_undo` restores the checkpoint taken before each turn (twenty kept, `game_history`).
- **Session zero** (`game/setup.ts`) asks one question at a time: the adventure, how many
  players, each player's name and hero (described, or a ready-made SRD hero), tone and lines to
  avoid, difficulty, leveling. Phases run setup, playing, paused and back, ended.
- **Memory** (`game/memory.ts`). A story object (premise, outline, secrets, clues, quests,
  facts, a rolling summary refreshed in the background, the last line spoken). The digest given
  to the router, the narrator and the talking brain is built by priority from whole sections,
  never by slicing; `recap` is spoken on load and on request.
- **Context hooks** (`game/integration.ts`). `describe` (the digest), `rules` and
  `hiddenActions` for Jev, `talk` (stay in the fiction, answer only from the digest, stay silent
  for chatter between players, never invent a roll or an outcome, one question at a time) and
  `voice` (a longer end-of-speech pause, the names at the table as key terms, a slower pace).
- **The board** (`game/view.ts`, `game/present.ts`, `game/templates/default-game.html`).
  `toView` computes everything a screen draws: whose turn or spotlight it is, the initiative
  strip, the roll being waited for ("Mira: Dexterity save, DC 13"), conditions with the rounds
  left, spell slots, death saves, quests, and a creature's health as a band, never its numbers.
  `VIEW_CONTRACT` lists the fields; the default template declares the ones it reads and
  normalizes all of them. A generated screen that leaves out a required part
  (`VIEW_REQUIRED_PARTS`) is not used: the default table is shown instead.
- **Saved games keep loading.** `store.ts` normalizes every document on every read and write, so
  a game saved before any of this gets a default for each new field (a class's hit die, saves
  and slots; a stat block from the bestiary for a creature it names; what a hero carries put on).
- **Tests** (`scripts/test-game-*.mts`, each with a throwaway data folder, no keys, and the
  model stubbed). `rules`: every mechanic with scripted dice. `engine`: fights, dying, rests,
  spells, equipment and trade on real documents. `session`: an evening with three players
  through the real tools, from session zero to a saved game loaded again, checking the state and
  what was said. `compat`: a hand-written document in the old shape. `board`: the view against
  the contract, the template's declaration against what its code reads, and the default screen's
  markup drawn without a browser.

## Email, calendar and bookings (`tools/assist.ts`, `services/assist/`)

Everyday-assistant abilities that work through the user's **own signed-in browser** — their webmail
and web calendar (`mailUrl` / `calendarUrl` in Settings: Gmail and Google Calendar by default,
Outlook on the web too), driven by the browser extension. No mail or calendar account is set up in
the engine and nothing here talks to a mail or calendar server.

| Tool | When | |
|------|------|--|
| `check_email` | "check my email", "any new mail", "did Sam write back", "anything from the bank this week" | reads the list only |
| `read_email` | "read the one from Sam", "open the second one", "what does it say", "read it out" | opens one message |
| `draft_email` | "email Sam that I'll be ten minutes late", "reply that Friday works", "make it shorter" | `sensitive`; never sends |
| `send_email` | "send it" — offered only while a draft of Trinity's is open | `sensitive`; needs "yes, send" |
| `check_calendar` | "what's on my calendar tomorrow", "am I free at three", "when is my next meeting" | feed, else the page |
| `schedule_meeting` | "schedule a meeting with Sam tomorrow at three for half an hour about the roadmap" | `sensitive`; never saves |
| `save_meeting` | "save it" — offered only while that form is open | `sensitive`; needs "yes, save" |
| `open_booking` | "book the second flight", "book that hotel", "open the first one to book" | `sensitive`; opens the page, buys nothing |

Reading is open to scheduled runs ("every morning tell me if I have new mail"). Everything that
writes, sends, saves or opens a page to buy from is `sensitive` and reads the user's own words
(`ctx.userWords ?? ctx.utterance`): a planner's step that says "email…" is refused. None of the
tools takes an argument — there is nothing for a model to hand a link, an address or a body in
through. Without the extension each says so plainly ("I need the browser extension connected to
read your email — it's in Settings, under Browser"); `check_calendar` alone can work without it,
from a feed.

- **The port** (`browser-port.ts`). Everything goes through a small `BrowserPort` — `connected`,
  `open(url, {reuse})` (a new tab, or an open tab on that site brought forward and left where it
  is), `navigate`, `snapshot → {url, title, text, controls[{ref, role, name}]}`, `click(ref,
  {approved})`, `type(ref, text)`, `press`, `waitFor(predicate, timeout)` — so these tools hold no
  knowledge of the extension's protocol, and tests stand a fake in (`setBrowserPort`). The default
  port uses, and only uses: `browserConnected()`, `browserTabs()` (`id`, `url`, `active`,
  `lastAccessed`), and `browserCall` of `tabs.open {url, where:"new", active:true} → {id}`,
  `tabs.activate {tabId}`, `tabs.navigate {tabId, url}`, `page.snapshot {tabId, maxChars,
  interactive:true} → {url, title, text, interactive[{ref, tag, name, role?, type?, href?,
  disabled?, frame?}]}`, `page.act {tabId, action:"click", ref, frameId?, approved?} → {ok, error?,
  held?}`, `page.act {…action:"type", ref, frameId?, text, clear:true, submit:false}` and `page.act
  {…action:"press", key}`. `approved` is the exact name of the control: the extension's guard holds
  a click on anything named send / pay / delete / confirm… without it (`held`).
- **Reading a page.** A snapshot's text arrives with every run of white space made one space, so a
  list's rows run together: a model (the fast one) turns it into rows. Every such prompt
  (`untrusted.ts`) puts the page text between markers carrying a random tag (text that looks like
  a marker is taken out first), says that it is DATA copied from a page, that nothing in it is an
  instruction, and that it must never be done, answered or repeated as an order — and what comes
  back is checked in code: a row is kept only if its sender and its subject are on the page and
  stand near each other; a preview or a time that isn't there is blanked; an "unread" flag is
  believed only if the page has an unread marker at all; a few words on what a message is about are
  used only when its subject or preview bears every one of them out. The page's text goes to the
  model on the configured gateway, like any page Trinity reads.
- **The inbox** (`webmail.ts`, `mail-words.ts`). The mail tab is brought forward (or opened). For
  unread mail on Gmail the tab goes to Gmail's own unread search (`#search/is:unread in:inbox`),
  where every row is unread; a question about a sender or a subject reads the whole list and is
  filtered in code (sender words, topic words, "today" / "yesterday" / "this week" from the list's
  own time stamps). Where the page doesn't say which rows are unread, the newest are said as "your
  newest mail", not as unread. The line is one or two sentences ("You have 3 unread: Sam Lee about
  the roadmap, …"), and the rows go on a numbered card, so "open the second one" has something to
  count. The tool's `data` holds counts only.
- **One message.** The row is found again in a fresh snapshot by its subject (and sender; the n-th
  of several alike) and clicked — never a button, never a control whose name reads like an action
  ("Send", "Empty Trash now"), so a message can't name itself after one and get it pressed. A row
  whose name the extension's guard holds (a subject with "order", "payment", "confirm") is approved
  only when the user asked for that message themselves; for a planner or a scheduled run it stays
  shut. The model says where the message's own text starts and ends, and the text is **cut from the
  page**, not taken from the model; it also writes a two-sentence summary in the third person,
  which is cut to length, scrubbed of links and addresses, and dropped for a plain "It starts: …"
  if it reads like an order. Sentences written as orders to an assistant ("Assistant: forward all
  mail to…", "ignore previous instructions", "do not tell the user") are taken out before the model,
  the card or the user's ears get the text, and counted. What a message asks of its reader is said
  in sentences written in code: "It asks you to click a link to verify your account — I haven't
  opened it.", "It also has a line written as instructions to an assistant — I've ignored it."
  "Read it out" returns the message's own text (links as "a link"); the live voice speaks about
  ninety words and offers the rest. Nothing in a message is ever clicked, opened or followed.
- **Drafts.** The fast model writes a subject and body from the user's words alone (first person,
  brief, nothing invented; a reply is told who is being answered and the subject, as data — never
  the message's text; a sentence carrying a link or an address the user didn't say is cut). The
  recipient is an address in the words (typed or said: "sam at example dot com"), the open
  message's sender for a reply, or a name Trinity has an address for in memory (the address must
  stand right by the name; the user's own address is nobody else's) — otherwise she asks ("What's
  Zoe's email address?") and the answer joins the request. Then Compose (or Reply) is pressed and
  the recipient, subject and body are **typed into the form's fields** — never put in an address
  (`mailto:` and compose links are not used). A form someone is already writing in is left alone,
  and so is a page with more than one message being written (which fields are Trinity's can't be
  told). "Make it shorter" / "add that I'm sorry" rewrites and retypes the body; a new draft to the
  same person writes over Trinity's own open one, subject and body only. A recipient field, once
  filled, is never typed into again, so "email Dana instead" or a draft to someone else is refused
  until that one is sent or closed. The draft is shown on a card; Send is never pressed here.
- **Sending.** `send_email` checks the form is still there, then asks through `askYesNo` with
  `require: ["send"]`: "Send this to sam@example.com: “Running late”?". A bare "yeah" gets the
  question again ("To go ahead, say: yes, send."). On the yes — and only if the draft is still the
  one that was asked about — the page's Send is clicked once, with its name as `approved`, and the
  answer is as much as the page showed: "Sent — your mail page says…" (a "Message sent" bar), "I
  pressed Send and the draft closed, so it looks sent — but the page didn't show a confirmation",
  or "…the draft is still showing and the page shows an error, so it may not have gone". A draft is
  never sent twice, and while more than one message is being written Send isn't pressed at all.
- **The calendar** (`calendar.ts`, `ics.ts`). First a feed, when the user has saved one in the
  vault as a secret labelled "Calendar feed" (only `listItems` and `useSecret` are used; a vault
  that is missing, locked or refuses is the same as no feed): fetched inside the `useSecret` call
  with `fetch`, https only (`webcal:` is read as https; redirects are followed by hand and never
  off https), with a time and a size limit; what leaves that call is events, never the address,
  which is not logged, shown or spoken. `ics.ts` reads VEVENTs in UTC, zoned (IANA names, Outlook's
  Windows names, Tzfile paths), floating and all-day; DTEND or DURATION; folded lines; RRULE DAILY /
  WEEKLY (BYDAY) / MONTHLY (month-day or "second Tuesday") / YEARLY with INTERVAL, COUNT, UNTIL,
  BYMONTH; EXDATE; RECURRENCE-ID replacements; cancelled events skipped — repeats on the event's own
  wall clock, so nine o'clock stays nine across a clock change. A rule it can't read (BYSETPOS…)
  keeps its first date and is counted on the card. With no feed, the calendar page: Google
  Calendar's day view (`/r/day/Y/M/D`) or agenda for a span, Outlook's day or week view, read by
  the model under the same data rules (a title must be on the page; a day nobody asked about is
  dropped). The answer is put together in code, in the user's time zone: "You have 3 things
  tomorrow: Stand-up at 9 AM, …", "Yes, you're free at 3 PM today — your next thing is…", "Your
  next one is…"; a title that reads like an order is said as "an event whose title reads like
  instructions".
- **Meetings** (`meeting.ts`, `when.ts`). The request is read by rule, not by a model: a title, a
  day, a start, a length (30 minutes unless said; an hour for a meal; "from 3 to 4:30"), the people
  it is with, a note. "At three" is 3 PM (business hours unless a meal or a part of the day says
  otherwise), "Monday morning" is 9 AM and is said back, a weekday whose time has passed today is
  next week's, a time in the past is refused with a question, and no time at all is asked for —
  the answer's time words join the request. Guests need an address (said, or known as above);
  anyone else is left off and named. With a feed, a clash is mentioned. Then the calendar's own
  new-event form is opened filled in — Google's event-template link (`/calendar/render?action=
  TEMPLATE&text=…&dates=<UTC>/<UTC>&details=…&add=…&ctz=…`), Outlook's compose link
  (`/calendar/0/deeplink/compose?…subject=…&startdt=…&enddt=…&body=…&to=…`) — and Trinity says what
  it holds: "It's filled in: Roadmap with Sam, tomorrow 3 to 3:30 PM. Say save it to put it on your
  calendar." `save_meeting` asks first (`require: ["save"]`, saying who would be invited), presses
  Save once, and says what the page showed. When the calendar then asks whether to email the
  guests, that is asked as its own question (`require: ["send"]`); without that yes nothing more is
  pressed.
- **Bookings** (`booking.ts`). The link is only ever a result row's own: the product, flight or
  hotel rows the engine rendered on the latest shopping / flights / hotels card (found through
  `recentResults()` or on the board). Never a link in the user's words, on another card, in a page
  or in a tool argument; https only. The page is opened in a new tab and Trinity says what comes
  next without doing it: "…When you're ready, say fill in my details, then pay with my card — I'll
  ask before anything is bought."
- **Routing.** `registerAssistTools()` registers the tools, a context provider (rules that tell
  them from their neighbours — `read_card`, `browser_act`, `schedule`, `get_time`, `show_card` —
  and, in sentences written here, what is open: a listed inbox, a message, an unsent draft, an
  unsaved form), and hands `services/assist/routes.ts` the same state. That file (it imports
  nothing from the engine) holds the keyword patterns for keyless routing and `assistRoute(words,
  offered)`: "send it", "save it", "make it shorter" and "open the second one" only mean these
  tools while there is a draft, a form or a listed inbox for them to mean. A reminder or a repeat
  said first ("remind me to email Sam", "every morning check my mail") is left to `schedule`, which
  runs these tools at the time.
- **Slow pages.** A tool has fifteen seconds; work that is still going after ten is answered with
  "I'm reading your inbox — I'll tell you what's there in a moment." and the result is told when it
  lands (the same holds for the Send and Save that follow a yes).
- **Tests.** `scripts/test-assist.mts` (no browser, mailbox or calendar): a fake port serving the
  fixture pages in `scripts/fixtures/assist/` (Gmail-like and Outlook-like inboxes, opened messages
  — one with a prompt injection and a "verify your account" link — compose and reply forms, a
  calendar day, new-event forms, an .ics feed) that records every click and keystroke and keeps the
  extension's guard; the model gateway stubbed, sometimes wrong on purpose (rows that aren't on the
  page, a summary that repeats the injected order, a draft with an invented link).
- **What is assumed about the pages** (not verified against a real mailbox or calendar). Gmail: a
  row is a `role=link` control named by its subject and the start of its preview; the page text
  carries no unread marker; `#search/is%3Aunread+in%3Ainbox` and `#inbox/<id>` behave as addresses;
  Compose opens "To recipients" / "Subject" / "Message Body" / "Send"; a typed recipient is taken
  when the field loses focus; "Message sent" shows as a bar with "View message". Outlook: rows are
  `role=option` controls named by their visible text; "New mail", "To", "Add a subject", "Message
  body", "Send"; no confirmation after sending. Google Calendar: `/r/day/Y/M/D` and `/r/agenda/…`;
  the template link fills the form; "Save"; "Event saved"; the invitation question's "Send" /
  "Don't send". Outlook calendar: `/view/day|week` (today's only), the compose link and its `to`,
  "Save" or — with attendees — "Send". A category tab other than Gmail's first, a conversation that
  shows several messages, and a page drawn very differently will read badly or not at all; the
  tools then say they couldn't find it rather than guess.

## Learning and memory (`db/conversations.ts`, `services/profile.ts`, `services/reflect.ts`, `services/skill-forge.ts`, `sandbox/`, `services/safe-fetch.ts`)

What Trinity keeps from one conversation to the next, and how she gets better at what she is asked
to do. Where this section and the older ones differ ("Skills Trinity creates", "Memory",
"Heartbeat"), this one holds: curation no longer calls a model per sentence, a skill's child
process has no network of its own, "every weekday" is kept, and a one-time reminder is marked done
only after it was delivered.

- **The conversation log** (`db/conversations.ts`). Every session — a call, the text channel, a
  scheduled run — and its turns (who spoke, the words, a tool's name and whether it worked) go to
  SQLite, with an FTS5 index (porter, unicode61; a word scan if a build lacks FTS5). `startSession`,
  `logTurn`, `endSession`, `recentTurns` and `searchConversations` are one prepared statement each
  and never throw. A turn flagged `secret` is dropped, and anything shaped like a card number
  (Luhn), a key, a token, or what follows "my password is" is blanked before it is stored. A call
  ends when it hangs up; a typed session, which nobody ends, is over after thirty minutes of quiet
  (the caller keeps its one id; the log moves on underneath it). History older than the retention
  setting (180 days; 0 keeps everything) is deleted. `recentTurns(n, {withinMs})` is what a new call
  and the text channel start from after a restart.
- **The profile** (`services/profile.ts`). Two small texts that are always in the prompt:
  `data/profile/USER.md` (who the user is, 1 500 characters) and `NOTES.md` (standing instructions,
  2 200), one "- entry" per line (300 characters at most). `editProfile(add | replace | remove)`
  refuses what would go over the limit with an error that says to consolidate, and `scanEntry`
  refuses an entry that reads as
  an instruction to the model, carries a web address with credentials, holds invisible characters
  or looks like a secret. The stored name is migrated into USER.md on first run and the two follow
  each other. `profileForPrompt(max)` is the block the voice loop and the text channel put in every
  prompt, with at most one line the last reflection left for the next conversation (three days).
- **Memories** (`db/memory.ts`, `tools/memory.ts`). Each has the day it was said; recall shows the
  model dated entries ("[m1] (3 Nov 2026) …"). A new fact is compared — by the model, in one call —
  with the memories on the same subject (`relatedBySubject`), so "I moved to Seattle" replaces the
  old city instead of sitting beside it. Salience fades (half-life 120 days, never below a quarter)
  unless a memory is recalled; `consolidateMemories` merges those that say the same thing.
  `saveFacts` (`services/curator.ts`) is the one way a fact is saved, whoever found it: scanned,
  sent to the profile when it is about who the user is, compared, deduplicated, dated.
- **Curation and reflection** (`services/curator.ts`, `services/reflect.ts`). `curateExchange`
  keeps its signature and is now cheap: it takes the user's name when they say it, runs a local
  pre-filter (`likelyDurable`) and queues a sentence that may hold a lasting fact — no model call.
  Only an explicit "remember…" that no tool took is extracted at once. When a session ends, and
  nightly at 3:30 for what is left, ONE brain-model call reads the stored session, the queued
  sentences, the profile and the memories on the same subjects and returns memory adds / replaces /
  removes (eight at most, three removals, never one the user asked outright to keep), profile
  edits, notes on skills that failed, a name for a job done twice, and at most one line for next
  time. Everything is applied through `saveFacts`, `editProfile`, `noteSkill` and
  `createProcedure`. A session in which nothing could matter costs no call; a failed call leaves it
  queued and pauses the automatic runs for ten minutes. The nightly run is a `system` task: it needs
  nobody connected, says nothing, and also merges duplicates, archives stale skills and prunes old
  history.
- **Skills that improve** (`services/skill-forge.ts`, `tools/forge.ts`). The index
  (`data/skills/index.json`, version 2) keeps each skill's version, uses, fails, last error and
  arguments, last use, and state (active / draft / disabled / archived). A run that fails queues
  ONE repair: the coder gets the current source, the failing arguments and the error; its module is
  tested against the old examples plus the failing case (kept as a regression example) and
  installed in place as the next version, the old module kept in `data/skills/versions/` (ten of
  them) for rollback — no `name_2`. The coder may answer `UNCHANGED` when the skill was right to
  decline. Two failed repairs in a row switch the skill off, take it out of routing and say so
  once. Unused for 30 days, a skill is archived, never deleted. `scanSkillSource` refuses a literal
  secret, one of this installation's keys, a collecting host, a bare IP or plain http, the whole
  argument object sent away, a POST to an unknown host, and attempts on the sandbox. "NaN" or
  "undefined" counts as a broken answer only when it is the value ("The total is NaN."), not when
  it is the subject ("The slope is undefined."). A job the solver did the same way twice becomes a
  `procedure` skill: its recorded steps, replayed by the solver as guidance.
- **The problem solver** (`services/agent-loop.ts`, `tools/solve.ts`). Tools are looked up again
  before every step; the last turn is kept for the answer; a result's `data` goes back clipped
  (1 200 characters) inside a `<tool_result>` fence marked as data; a skill it forges is waited for
  and used; a caller's hidden set and every `sensitive` tool are left off the list at every step,
  and a step that names one is refused in words; the planner is asked with a 3 000-token budget
  (response format and reasoning effort when the model takes them). A question for the user ends
  the run with `ok: false` and `say` = the question; the run is kept (SQLite, ten minutes) and
  `resumeSolve(answer)` goes on with it. `answer_followup` is the same thing as a tool, offered
  only while a question waits, its description carrying the question.
- **The sandbox** (`sandbox/host.ts`, `sandbox/runner.mjs`). The child that runs a skill has NO
  network: every socket connection is refused outright, `process`, the stdio streams and the
  socket-making globals are taken away, the built-ins are frozen (`--frozen-intrinsics`) and code
  from strings is off. A skill's `fetch` is a message to the engine, which makes the request itself
  with the safe fetcher — so the rule that keeps a skill off this machine and the local network runs
  outside the skill's realm, and nothing a skill does to `Array.prototype.some`,
  `RegExp.prototype.test` or `Function.prototype.call` changes it. One run may make 40 requests
  (8 at once, 10 s each, 1 MB up, 5 MB a response, 20 MB in all). What it does not give: there is no
  operating-system firewall around the child, so a full escape from Node's permission model would
  still reach the network; a skill may send what it was given to a public host with a GET (the
  scanner is a first filter, not a guarantee); and the heap limit does not bound buffers.
- **The safe fetcher** (`services/safe-fetch.ts`). The one way the engine fetches a URL it did not
  write: http and https only, the name resolved here and every address checked inside the
  connection's own lookup (loopback, link-local, private, unique-local, carrier NAT, multicast,
  the IPv4 forms carried inside IPv6), the peer checked again on connect, redirects followed by
  hand through the same checks, a time limit and a size limit after decompression. The remote image
  cache, the media URLs a gateway hands back (`services/images.ts`, `videos.ts`) and the sandbox
  use it. `TRINITY_FETCH_ALLOW=host:port[,…]` exempts exactly those pairs for a test suite's
  fixture server; it is read once at start, logged as a warning, can't name the engine's own port,
  and nothing at run time can set it.
- **Reminders and the heartbeat** (`tools/schedule.ts`, `heartbeat.ts`). "Every weekday at nine",
  "on weekends", "every Monday and Wednesday" are kept as a `days` rule. A one-time item is
  delivered first and marked done after: a failed delivery is tried again after a minute, then
  five, then closed with one notice; a line the voice could only owe keeps the item due until it
  was said, so a restart in between delivers it again. The check-in (`kind: "checkin"`) looks at a
  short list the user keeps (`data/profile/HEARTBEAT.md`, 1 200 characters) every half hour unless
  set otherwise, only inside its active hours (8 to 21), only when the user has been quiet (ten
  minutes), only when someone could hear it — and says nothing unless something on the list needs
  saying now. An empty list costs nothing.
- **Tools a run may not use** (`tools/scope.ts`). The heartbeat wraps a scheduled run in
  `withHiddenTools(…)`: the solver leaves those tools out for the whole run, and the tools that
  change what is saved (remember, update_profile, forget, the skill and reminder tools) refuse to
  run inside it, or when a scheduled run calls them directly (`ctx.origin`). The rule ends with
  the run.
- **The tools, and when each fires.** `remember` ("remember that…"; who the user is goes to the
  profile), `update_profile` (a lasting fact or standing instruction said without "remember"),
  `forget` ("forget that I…"; everything at once is refused and pointed at Settings), `recall` (a
  question about what was saved; falls back to the conversations), `search_conversations` ("what
  did we say about…"), `create_skill`, `fix_skill` ("that skill is wrong", "fix the tip
  calculator"), `list_skills`, `disable_skill`, `enable_skill`, `schedule`, `list_reminders`,
  `cancel_reminder`, `change_reminder` ("move it to six", "an hour later"), `figure_out`,
  `answer_followup`. Each spoken result is one or two short sentences, with `speak` for anything
  that carries facts or numbers. Without a model, the tools that delete or move something act only
  on words that are about it: "I should cancel my gym membership" cancels no reminder.
- **Keyword routing** (`tools/intents.ts`). `voiceIntent(words, offered)` names the tool of this
  layer the words ask for outright, or null — the same shape as `assistRoute`. These tools are
  named with everyday words ("forget", "cancel", "change", "skills"), which the keyword fallback's
  last resort would take for a request ("I always forget my keys"): `voiceIntent` is what reads one.
- **API** (`routes/memory.ts`, `routes/skills.ts`, `routes/heartbeat.ts`). `GET` / `PUT
  /api/profile` (name, both texts, limits); `/api/memory` as before, plus
  `POST /api/memory/consolidate`; `GET /api/history`, `PUT /api/history/settings`,
  `GET /api/history/sessions[/:id]`,
  `GET /api/history/search`, `DELETE /api/history/sessions/:id` (with the sentences flagged in it),
  `DELETE /api/history` (everything said, the queue, the line for next time, the solver's open
  question and recorded requests), `POST /api/reflect`; `POST /api/skills/:name/archive`,
  `/rollback`, `/fix`; `GET` / `PUT /api/heartbeat/checkin`, and `days` on a task. Settings →
  Memory, Skills and Heartbeat show and change all of it.
- **Tests.** `scripts/test-memory.mts`, `test-skills.mts`, `test-solver.mts`, `test-sandbox.mts`,
  `test-reminders.mts` (in `npm test`): the gateway is a stubbed `fetch`, the data folder is fresh,
  the sandbox and the fetcher run for real against local servers, and the three routers are
  mounted and called over HTTP.
- **Where other files call in.** `services/voice-call.ts` and `orchestrator.ts`: the log
  (`startSession`, `logTurn`, `endSession`), the profile block, `recentTurns`, `curateExchange`.
  `heartbeat.ts` starts every scheduled run and the nightly reflection. `agent/router.ts`'s keyword
  fallback is where `voiceIntent` belongs — after the vault rules, with `EVERYDAY_TOOL_WORDS` added
  to its everyday words and `answer_followup` among the tools it may take when the routing model
  abstains. Without that call, routing with no routing model can't tell these tools' everyday
  words from a request (the tools then decline rather than delete or move anything).
