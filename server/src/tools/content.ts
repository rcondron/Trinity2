import { tell } from "../agent/tell.js";
import {
  CONTENT_TYPE_IDS,
  CONTENT_TYPE_OPTIONS,
  CONTENT_TYPES,
  composeContent,
  earlyImagePrompt,
  guessType,
  pickCardModel,
  provisionalTitle,
  topicFrom,
  wantsWeb,
  type ContentSpec,
  type ContentType,
} from "../services/content-spec.js";
import { getImageJob, requestImage } from "../services/images.js";
import { pickMordiemModel, QUALITY_OPTIONS } from "../services/mordiem-router.js";
import { fetchHeadlines } from "../services/news.js";
import { search, type WebResult } from "../services/web.js";
import { live } from "../settings.js";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import { addCard, boardBlocked, getCard, tagsFromText, updateCard } from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import { renderContentCard, renderPendingCard } from "../workspace/content-card.js";
import { registerTool } from "./registry.js";

/**
 * show_card: "give me a blueberry muffin recipe", "what's in the news", "who was Marie Curie" — the
 * information laid out as a designed card on the board, with a picture when one fits, and a spoken
 * summary. The card goes up at once (a masthead and shimmer), the web is searched when the topic is
 * fresh, the card designer (services/content-spec.ts) writes the content and look, the engine renders
 * it (workspace/content-card.ts), and the hero picture lands when Mordiem has painted it. The spoken
 * line waits a few seconds for the real summary; if the designer is slower, Trinity says it's coming
 * and tells the summary when it's up.
 */

const SPEAK_WAIT_MS = 9_000; // under act.ts's tool timeout; the reply then speaks the actual summary
const SEARCH_MS = 7_000;
const COMPOSE_MS = 45_000;
const CARD_W = 42;
const CARD_H = 74;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("timed out")), ms)));
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

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
  /** The card was removed (or the board cleared) while work was in flight: nothing more to show. */
  dead: boolean;
}

const busy = (n: number, text: string | null) => workspace.activity(`card:${n}`, text);
const article = (label: string) => (/^[aeiou]/i.test(label) ? `an ${label.toLowerCase()}` : `a ${label.toLowerCase()}`);

function typeArg(v: unknown): ContentType | null {
  return typeof v === "string" && (CONTENT_TYPE_IDS as string[]).includes(v) ? (v as ContentType) : null;
}

/** What to search for: "the news" → today's top stories; weather and scores say so; otherwise the topic. */
function searchQuery(job: CardJob): string {
  const t = job.topic;
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

/** The placeholder, refreshed (the picture may land before the words). */
function repaintPending(job: CardJob, status: string): void {
  if (job.spec || !alive(job)) return;
  updateCard(job.n, { html: renderPendingCard(job.type, job.topic, status, { imageUrl: job.imageUrl, imagePending: job.imagePending }) });
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

async function compose(job: CardJob, ctx: ToolContext, quality: unknown): Promise<ContentSpec | null> {
  let sources: WebResult[] = [];
  let answer: string | undefined;
  if (wantsWeb(job.type, job.utterance)) {
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
        const res = await withTimeout(search(searchQuery(job)), SEARCH_MS);
        sources = [...sources, ...res.results].slice(0, 10);
        answer = res.answer;
      } catch (err) {
        console.warn(`[show_card] search failed: ${(err as Error).message}`);
      }
    }
    if (!alive(job)) return null;
  }
  busy(job.n, `${job.designer} is writing card ${job.n}…`);
  const composed = await composeContent({
    persona: ctx.persona,
    utterance: job.utterance,
    topic: job.topic,
    type: job.type,
    sources,
    answer,
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
  job.spec = composed.spec;
  // The picture: the early one if it's already painting; else the designer's brief, unless this kind never has one.
  if (!job.imageStarted && composed.spec.image && CONTENT_TYPES[composed.spec.type].image !== "none") startImage(job, composed.spec.image.prompt);
  paint(job);
  busy(job.n, job.imagePending ? `Painting the picture for card ${job.n}…` : null);
  console.log(`[show_card] card ${job.n} (${composed.spec.type}) written by ${composed.label} in ${composed.ms} ms${job.imagePending ? ", picture pending" : ""}`);
  return composed.spec;
}

const showCard: Tool = {
  name: "show_card",
  description:
    "Look something up and lay it out as a designed card on the workspace — a recipe, today's news, who someone is, a place, a product or comparison, how to do something, what something is, an event, the weather, scores, a film or book, a plan or a list — with a fitting picture, plus a spoken summary.",
  input: {
    type: { type: "string", description: "what kind of information card this is", options: CONTENT_TYPE_OPTIONS },
    quality: { type: "string", description: "which Mordiem text model should write the card", options: QUALITY_OPTIONS },
  },
  // The request is the caller's whole sentence: fires when it ends; Jev's options arrive as args.
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
      dead: false,
    };
    const early = earlyImagePrompt(type, topic);
    const card = addCard({
      kind: "widget",
      title: provisionalTitle(type, topic).slice(0, 80),
      text: utterance,
      tags: tagsFromText(topic, info.label),
      status: "pending",
      html: renderPendingCard(type, topic, `${designer.label} is writing the card…`, { imagePending: Boolean(early) }),
      model: designer.label,
      w: CARD_W,
      h: CARD_H,
    });
    job.n = card.n;
    if (early) startImage(job, early);

    const writing = compose(job, ctx, args.quality);
    const first = await Promise.race([writing, sleep(SPEAK_WAIT_MS).then(() => "later" as const)]);
    if (first !== "later") {
      if (!first) return { ok: false, say: `I couldn't put together ${article(info.label)} on ${topic} just now.`, data: { card: job.n, type } };
      const line = spokenLine(first, job.n);
      return {
        ok: true,
        say: line,
        speak: line,
        data: { card: job.n, type: first.type, title: first.title, model: designer.model, picture: job.imageUrl ?? (job.imagePending ? "pending" : null) },
      };
    }
    // Slower than the caller should wait: acknowledge now; the summary is told when the card is written.
    void writing.then((spec) => {
      if (spec && alive(job)) tell(ctx, spokenLine(spec, job.n), "show_card");
    });
    return {
      ok: true,
      say: `Card ${job.n} is on the board — ${designer.label} is writing ${article(info.label)} on ${topic} now.`,
      inProgress: "started",
      data: { card: job.n, type, model: designer.model },
    };
  },
};

export function registerContentTools(): void {
  registerTool(showCard);
}
