import { tell } from "../agent/tell.js";
import {
  CONTENT_TYPE_IDS,
  CONTENT_TYPE_OPTIONS,
  CONTENT_TYPES,
  LIVE_BLOCK_KINDS,
  composeContent,
  earlyImagePrompt,
  guessType,
  pickCardModel,
  provisionalTitle,
  topicFrom,
  wantsWeb,
  type Block,
  type ContentSpec,
  type ContentType,
} from "../services/content-spec.js";
import { getImageJob, requestImage } from "../services/images.js";
import { flightsBundle, hotelsBundle, liveImages, productsBundle, type LiveBundle } from "../services/live-results.js";
import { pickMordiemModel, QUALITY_OPTIONS } from "../services/mordiem-router.js";
import { fetchHeadlines } from "../services/news.js";
import { cacheRemoteImages } from "../services/remote-images.js";
import {
  flightsUrl,
  hotelsUrl,
  searchFlights,
  searchHotels,
  searchProducts,
  shoppingUrl,
  travelLive,
  type FlightQuery,
  type HotelQuery,
  type ShoppingQuery,
} from "../services/serpapi.js";
import { extractFlightAsk, extractHotelAsk, parseShoppingAsk, resolveFlightAsk, resolveHotelAsk, shoppingQuery } from "../services/travel-query.js";
import { search, type WebResult } from "../services/web.js";
import { live } from "../settings.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { addCard, boardBlocked, getCard, removeCard, tagsFromText, updateCard } from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import { renderContentCard, renderPendingCard } from "../workspace/content-card.js";
import { registerTool } from "./registry.js";

/**
 * show_card: "give me a blueberry muffin recipe", "what's in the news", "who was Marie Curie", "find me
 * flights to Denver next Friday" — the information laid out as a designed card on the board, with a
 * picture when one fits, and a spoken summary. The card goes up at once (a masthead and shimmer), the
 * web is searched when the topic is fresh, the card designer (services/content-spec.ts) writes the
 * content and look, the engine renders it (workspace/content-card.ts), and the hero picture lands when
 * Mordiem has painted it. Shopping, flights and hotels first run a live search (services/serpapi.ts):
 * the engine lays those results out itself — real prices, times and links — and the designer writes
 * around them. The spoken line waits a few seconds for the real summary; if the work is slower,
 * Trinity says it's coming and tells the summary when it's up.
 */

const SPEAK_WAIT_MS = 9_000; // under act.ts's tool timeout; the reply then speaks the actual summary
const SEARCH_MS = 7_000;
const LIVE_MS = 22_000; // Google Flights can take a while
const IMAGES_MS = 6_000;
const COMPOSE_MS = 45_000;
const CARD_W = 42;
const CARD_H = 74;

const LIVE_TYPES = new Set<ContentType>(["shopping", "flights", "hotels"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("timed out")), ms)));
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** A live search the words resolved to, with what had to be assumed to run it. */
type LiveAsk =
  | { kind: "products"; query: ShoppingQuery; assumed: string[] }
  | { kind: "flights"; query: FlightQuery; assumed: string[] }
  | { kind: "hotels"; query: HotelQuery; assumed: string[] };

interface CardJob {
  n: number;
  type: ContentType;
  topic: string;
  utterance: string;
  spec: ContentSpec | null;
  imageStarted: boolean;
  imagePending: boolean;
  imageUrl: string | null;
  imageModel: string;
  designer: string;
  /** Live results that made it onto the card (shopping / flights / hotels). */
  liveCount: number | null;
  /** The card was removed (or the board cleared) while work was in flight: nothing more to show. */
  dead: boolean;
}

const busy = (n: number, text: string | null) => workspace.activity(`card:${n}`, text);
const article = (label: string) => (/^[aeiou]/i.test(label) ? `an ${label.toLowerCase()}` : `a ${label.toLowerCase()}`);

function typeArg(v: unknown): ContentType | null {
  return typeof v === "string" && (CONTENT_TYPE_IDS as string[]).includes(v) ? (v as ContentType) : null;
}

/** What to search for: "the news" → today's top stories; weather and scores say so; otherwise the topic. */
function searchQuery(job: CardJob, ask: LiveAsk | null): string {
  const t = job.topic;
  if (ask?.kind === "products") return `${ask.query.query} price`;
  if (ask?.kind === "flights") return `flights from ${ask.query.originName ?? ask.query.origin.join(" ")} to ${ask.query.destinationName ?? ask.query.destination.join(" ")}`;
  if (ask?.kind === "hotels") return `hotels in ${ask.query.destination}`;
  if (job.type === "news") return /^(the |today'?s |latest )?(news|headlines)( today| right now| this morning)?$/i.test(t) ? "top news headlines today" : `${t} news today`;
  if (job.type === "weather") return /\b(weather|forecast)\b/i.test(t) ? t : `weather ${t} today`;
  if (job.type === "sports") return /\b(score|result|standings)\b/i.test(t) ? t : `${t} score`;
  return t;
}

/** Still on the board? (Removed or cleared: the job quietly stops.) */
function alive(job: CardJob): boolean {
  if (job.dead) return false;
  if (!getCard(job.n)) {
    job.dead = true;
    busy(job.n, null);
  }
  return !job.dead;
}

function cardTitle(spec: ContentSpec): string {
  const label = CONTENT_TYPES[spec.type].label;
  return label === "Card" ? spec.title : `${label} · ${spec.title}`;
}

/** The spoken line once the card is written: the summary, then where it is. */
function spokenLine(spec: ContentSpec, n: number): string {
  const summary = spec.summary.replace(/\s+/g, " ").trim();
  const where = `It's on the board as card ${n}.`;
  return summary ? `${summary} ${where}` : `${cardTitle(spec)} is on the board as card ${n}.`;
}

/** Write (or rewrite) the card from the spec and whatever the picture is doing. */
function paint(job: CardJob): void {
  if (!job.spec || !alive(job)) return;
  const spec = job.spec;
  const html = renderContentCard(spec, { imageUrl: job.imageUrl, imagePending: job.imagePending });
  const ok = updateCard(job.n, {
    status: "ready",
    title: cardTitle(spec).slice(0, 80),
    text: spec.summary || job.utterance,
    tags: tagsFromText(spec.title, job.topic, CONTENT_TYPES[spec.type].label),
    html,
    model: undefined,
    error: undefined,
  });
  if (!ok) job.dead = true;
}

/** The placeholder, refreshed (the picture may land before the words; the topic may sharpen after parsing). */
function repaintPending(job: CardJob, status: string): void {
  if (job.spec || !alive(job)) return;
  updateCard(job.n, {
    title: provisionalTitle(job.type, job.topic).slice(0, 80),
    tags: tagsFromText(job.topic, CONTENT_TYPES[job.type].label),
    html: renderPendingCard(job.type, job.topic, status, { imageUrl: job.imageUrl, imagePending: job.imagePending }),
  });
}

function startImage(job: CardJob, prompt: string): void {
  if (job.imageStarted) return;
  job.imageStarted = true;
  const { id, done } = requestImage(prompt, "picture", { model: job.imageModel });
  const first = getImageJob(id);
  if (first?.status === "ready" && first.url) {
    job.imageUrl = first.url;
    return;
  }
  if (first?.status === "error") return;
  job.imagePending = true;
  void done.then((j) => {
    job.imagePending = false;
    if (j.status === "ready" && j.url) job.imageUrl = j.url;
    if (!alive(job)) return;
    if (job.spec) {
      paint(job);
      busy(job.n, null);
    } else repaintPending(job, `${job.designer} is writing the card…`);
  });
}

/** "the news" / "today's headlines" → top stories; "news about X" → stories about X. */
function headlineTopic(job: CardJob): string {
  const t = job.topic
    .replace(/\b(the|today'?s|latest|current|top|this morning'?s)\b/gi, " ")
    .replace(/\b(news|headlines?|stories|what('s| is) (happening|going on))\b/gi, " ")
    .replace(/\b(about|on|in the world|today|right now)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 2 ? t : "";
}

// ─── Live results (shopping / flights / hotels) ───────────────────────────────

const LIVE_LABEL: Record<LiveAsk["kind"], string> = { products: "Google Shopping", flights: "Google Flights", hotels: "Google Hotels" };

/**
 * From the words to a search. Shopping is parsed from the words alone; flights and hotels ask the card
 * model to read the route, dates and travellers (with a word-level parser as the fallback) and resolve
 * what's missing into an assumption — or, when the origin or destination isn't there, into a question.
 */
async function prepareLive(job: CardJob): Promise<LiveAsk | { clarify: string } | null> {
  if (job.type === "shopping") {
    const ask = parseShoppingAsk(job.utterance, job.topic);
    job.topic = ask.query;
    return { kind: "products", query: shoppingQuery(ask), assumed: [] };
  }
  if (job.type === "flights") {
    busy(job.n, "Working out the route and dates…");
    const resolved = resolveFlightAsk(await extractFlightAsk(job.utterance), job.utterance);
    if (!resolved.ok) return { clarify: resolved.clarify };
    const q = resolved.query;
    job.topic = `${q.originName ?? q.origin.join("/")} to ${q.destinationName ?? q.destination.join("/")}`;
    return { kind: "flights", query: q, assumed: resolved.assumed };
  }
  if (job.type === "hotels") {
    busy(job.n, "Working out the place and dates…");
    const resolved = resolveHotelAsk(await extractHotelAsk(job.utterance), job.utterance);
    if (!resolved.ok) return { clarify: resolved.clarify };
    job.topic = `hotels in ${resolved.query.destination}`;
    return { kind: "hotels", query: resolved.query, assumed: resolved.assumed };
  }
  return null;
}

/** The "see all" link for a live search — also the way in when there's no key. */
function seeAll(ask: LiveAsk): { title: string; url: string } {
  if (ask.kind === "products") return { title: "Google Shopping", url: shoppingUrl(ask.query.query) };
  if (ask.kind === "flights") return { title: "Google Flights", url: flightsUrl(ask.query) };
  return { title: "Google Hotels", url: hotelsUrl(ask.query) };
}

interface LiveOutcome {
  bundle: LiveBundle | null;
  /** Why there are no live results on the card, when there aren't. */
  note: Block | null;
}

/** Run the live search and cache its pictures; a note instead when it can't run or finds nothing. */
async function fetchLive(job: CardJob, ask: LiveAsk): Promise<LiveOutcome> {
  const label = LIVE_LABEL[ask.kind];
  if (!travelLive())
    return {
      bundle: null,
      note: {
        kind: "note",
        tone: "info",
        text: `Live prices need a SerpApi key — add one in Settings → API keys (the free tier is 250 searches a month). The ${label} link below opens this search.`,
      },
    };
  busy(job.n, `Searching ${label} for ${job.topic}…`);
  try {
    if (ask.kind === "products") {
      const res = await withTimeout(searchProducts(ask.query, LIVE_MS), LIVE_MS + 500);
      if (!res.products.length) return { bundle: null, note: empty(label, job.topic) };
      busy(job.n, `Fetching pictures for card ${job.n}…`);
      const images = await cacheRemoteImages(liveImages(res), { timeoutMs: IMAGES_MS, max: 8 });
      return { bundle: productsBundle(res, images, ask.assumed), note: null };
    }
    if (ask.kind === "flights") {
      const res = await withTimeout(searchFlights(ask.query, LIVE_MS), LIVE_MS + 500);
      if (!res.options.length) return { bundle: null, note: empty(label, job.topic) };
      const images = await cacheRemoteImages(liveImages(res), { timeoutMs: IMAGES_MS, max: 8 });
      return { bundle: flightsBundle(res, images, ask.assumed), note: null };
    }
    const res = await withTimeout(searchHotels(ask.query, LIVE_MS), LIVE_MS + 500);
    if (!res.hotels.length) return { bundle: null, note: empty(label, job.topic) };
    busy(job.n, `Fetching pictures for card ${job.n}…`);
    const images = await cacheRemoteImages(liveImages(res), { timeoutMs: IMAGES_MS, max: 7 });
    return { bundle: hotelsBundle(res, images, ask.assumed), note: null };
  } catch (err) {
    const reason = (err as Error).message.replace(/\s+/g, " ").slice(0, 140);
    console.warn(`[show_card] live ${ask.kind} search failed: ${reason}`);
    return {
      bundle: null,
      note: { kind: "note", tone: "warning", text: `Live results didn't come back from ${label} (${reason}) — this card is from the web and general knowledge instead.` },
    };
  }
}

const empty = (label: string, topic: string): Block => ({ kind: "note", tone: "warning", text: `${label} returned no results for ${topic} — try other words, dates or places.` });

/** The live results, then any assumptions, then what the designer wrote (minus anything it tried to lay out itself). */
function mergeLive(spec: ContentSpec, bundle: LiveBundle | null, note: Block | null, assumed: string[]): ContentSpec {
  const lead: Block[] = [];
  if (note) lead.push(note);
  if (bundle) lead.push(...bundle.blocks);
  if (assumed.length) lead.push({ kind: "note", tone: "info", text: `Assumed: ${assumed.join("; ")}. Say the details and I'll search again.` });
  const blocks = [...lead, ...spec.blocks.filter((b) => !LIVE_BLOCK_KINDS.has(b.kind))].slice(0, 12);
  const seen = new Set(spec.sources.map((s) => s.url));
  const sources = [...spec.sources];
  for (const s of bundle?.sources ?? []) if (!seen.has(s.url)) sources.push(s);
  return { ...spec, blocks, sources: sources.slice(0, 6) };
}

// ─── Writing the card ─────────────────────────────────────────────────────────

async function compose(job: CardJob, ctx: ToolContext, quality: unknown, ask: LiveAsk | null): Promise<ContentSpec | null> {
  let sources: WebResult[] = [];
  let answer: string | undefined;
  let outcome: LiveOutcome = { bundle: null, note: null };
  if (ask) {
    outcome = await fetchLive(job, ask);
    if (!alive(job)) return null;
    job.liveCount = outcome.bundle?.count ?? 0;
  }
  if (!outcome.bundle && wantsWeb(job.type, job.utterance)) {
    busy(job.n, `Searching the web for ${job.topic}…`);
    // News (and a fresh sports / event ask): real headlines from the news feed first — a web search for
    // "the news" only finds the front pages of news sites. Anything else, or a feed that gives nothing: web search.
    if (job.type === "news" || job.type === "sports" || job.type === "event") {
      try {
        sources = await withTimeout(fetchHeadlines(job.type === "news" ? headlineTopic(job) : job.topic, { limit: 10 }), SEARCH_MS);
      } catch (err) {
        console.warn(`[show_card] headlines failed: ${(err as Error).message}`);
      }
    }
    if (sources.length < 3) {
      try {
        const res = await withTimeout(search(searchQuery(job, ask)), SEARCH_MS);
        sources = [...sources, ...res.results].slice(0, 10);
        answer = res.answer;
      } catch (err) {
        console.warn(`[show_card] search failed: ${(err as Error).message}`);
      }
    }
    if (!alive(job)) return null;
  }
  busy(job.n, `${job.designer} is writing card ${job.n}…`);
  const bundle = outcome.bundle;
  const composed = await composeContent({
    persona: ctx.persona,
    utterance: job.utterance,
    topic: job.topic,
    type: job.type,
    sources,
    answer,
    live: bundle ? { kind: bundle.kind, text: bundle.text, sources: bundle.sources, urls: bundle.urls } : null,
    quality,
    timeoutMs: COMPOSE_MS,
  });
  if (!alive(job)) return null;
  if (!composed) {
    busy(job.n, null);
    updateCard(job.n, { status: "error", error: "the card designer didn't answer in time", model: undefined });
    workspace.toast(`Card ${job.n}: couldn't write that card`, "error");
    return null;
  }
  let spec = composed.spec;
  if (ask) {
    spec = mergeLive(spec, bundle, outcome.note, ask.assumed);
    // Without live results the way in is the same search on Google; keep that link whatever the designer cited.
    if (!bundle) {
      const link = seeAll(ask);
      if (!spec.sources.some((s) => s.url === link.url)) spec = { ...spec, sources: [link, ...spec.sources].slice(0, 6) };
    }
  }
  job.spec = spec;
  // The picture: the early one if it's already painting; else the designer's brief, unless this kind never has one.
  if (!job.imageStarted && spec.image && CONTENT_TYPES[spec.type].image !== "none") startImage(job, spec.image.prompt);
  paint(job);
  busy(job.n, job.imagePending ? `Painting the picture for card ${job.n}…` : null);
  console.log(
    `[show_card] card ${job.n} (${spec.type}) written by ${composed.label} in ${composed.ms} ms${bundle ? `, ${bundle.count} live ${bundle.kind}` : ""}${job.imagePending ? ", picture pending" : ""}`,
  );
  return spec;
}

/** What Trinity says when the card will take longer than the user should wait. */
function laterLine(job: CardJob, ask: LiveAsk | null, info: { label: string }): string {
  if (ask) return `Card ${job.n} is on the board — I'm searching ${LIVE_LABEL[ask.kind]} for ${job.topic} now and I'll tell you what I find.`;
  return `Card ${job.n} is on the board — ${job.designer} is writing ${article(info.label)} on ${job.topic} now.`;
}

const showCard: Tool = {
  name: "show_card",
  description:
    "Look something up and lay it out as a designed card on the workspace — a recipe, today's news, who someone is, a place, a product to buy or compare prices on, flights, hotels, a trip itinerary, how to do something, what something is, an event, the weather, scores, a film or book, a plan or a list — with a fitting picture and live prices where there are any, plus a spoken summary.",
  input: {
    type: { type: "string", description: "what kind of information card this is", options: CONTENT_TYPE_OPTIONS },
    quality: { type: "string", description: "which Mordiem text model should write the card", options: QUALITY_OPTIONS },
  },
  // The request is the user's whole sentence: fires when it ends; Jev's options arrive as args.
  argMode: "raw",
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const utterance = ctx.utterance.replace(/\s+/g, " ").trim();
    if (!utterance) return { ok: false, say: "What should the card be about?" };
    if (boardBlocked()) return { ok: false, say: "A game is on the workspace right now — finish or clear it before I add cards." };
    if (!live.mordiem) return { ok: false, say: "I can't write cards without a Mordiem key — there's a place for it in Settings, under Models." };

    const type = typeArg(args.type) ?? guessType(utterance);
    const topic = topicFrom(utterance) || utterance;
    const info = CONTENT_TYPES[type];
    const designer = pickCardModel(args.quality, utterance);
    const imagePick = pickMordiemModel({ modality: "image", quality: args.quality, utterance });
    const job: CardJob = {
      n: 0,
      type,
      topic,
      utterance,
      spec: null,
      imageStarted: false,
      imagePending: false,
      imageUrl: null,
      imageModel: imagePick.model,
      designer: designer.label,
      liveCount: null,
      dead: false,
    };
    const early = earlyImagePrompt(type, topic);
    const isLive = LIVE_TYPES.has(type);
    const card = addCard({
      kind: "widget",
      title: provisionalTitle(type, topic).slice(0, 80),
      text: utterance,
      tags: tagsFromText(topic, info.label),
      status: "pending",
      html: renderPendingCard(type, topic, isLive ? "Reading the request…" : `${designer.label} is writing the card…`, { imagePending: Boolean(early) }),
      model: designer.label,
      w: CARD_W,
      h: CARD_H,
    });
    job.n = card.n;
    if (early) startImage(job, early);

    // Shopping / flights / hotels: resolve the search first — a missing origin or destination is a question, not a card.
    let ask: LiveAsk | null = null;
    if (isLive) {
      const prepared = await prepareLive(job);
      if (!alive(job)) return { ok: true, say: "That card was taken down before I got to it.", data: { card: job.n, type } };
      if (prepared && "clarify" in prepared) {
        removeCard(job.n);
        busy(job.n, null);
        return { ok: true, say: prepared.clarify, data: { type, clarify: true } };
      }
      ask = prepared;
      repaintPending(job, travelLive() ? `Searching ${LIVE_LABEL[ask!.kind]}…` : `${designer.label} is writing the card…`);
    }

    const writing = compose(job, ctx, args.quality, ask);
    const first = await Promise.race([writing, sleep(SPEAK_WAIT_MS).then(() => "later" as const)]);
    if (first !== "later") {
      if (!first) return { ok: false, say: `I couldn't put together ${article(info.label)} on ${job.topic} just now.`, data: { card: job.n, type } };
      const line = spokenLine(first, job.n);
      return {
        ok: true,
        say: line,
        speak: line,
        data: {
          card: job.n,
          type: first.type,
          title: first.title,
          model: designer.model,
          picture: job.imageUrl ?? (job.imagePending ? "pending" : null),
          ...(ask ? { live: job.liveCount } : {}),
        },
      };
    }
    // Slower than the user should wait: acknowledge now; the summary is told when the card is written.
    void writing.then((spec) => {
      if (spec && alive(job)) tell(ctx, spokenLine(spec, job.n), "show_card");
    });
    return {
      ok: true,
      say: laterLine(job, ask, info),
      inProgress: "started",
      data: { card: job.n, type, model: designer.model },
    };
  },
};

export function registerContentTools(): void {
  registerTool(showCard);
}
