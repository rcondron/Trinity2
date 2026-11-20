import { getImageJob, requestImage } from "../services/images.js";
import { pickMordiemModel, QUALITY_OPTIONS } from "../services/mordiem-router.js";
import { getSpeechJob, requestSpeech } from "../services/speech.js";
import { getVideoJob, requestVideo } from "../services/videos.js";
import { live } from "../settings.js";
import type { Tool, ToolResult } from "../types.js";
import { boardBlocked, patchCard, tagsFromText, tryAddCard, type BoardCard, type CardPatch, type CardRetry } from "../workspace/board.js";
import { workspace } from "../workspace/bus.js";
import { holdCard } from "../workspace/card-jobs.js";
import { registerTool } from "./registry.js";

/**
 * Pictures, audio, video and text notes the user asks for — each becomes a numbered floating
 * card on the workspace board (loader first, content when ready). Jev / the Mordiem router pick
 * the fast vs quality model for media. Cards stay side by side so "remove card 2" / "move card 1"
 * (or "the tiger") can refer to them by number or content tags.
 */

function caption(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59).replace(/\s+\S*$/, "")}…` : t;
}

/**
 * Split "a panda and a tiger" / "panda, tiger, and lion" / "a picture of X and a picture of Y"
 * into one subject per card. Only splits on commas or "and a/an/the" so "black and white" stays one.
 */
export function splitSubjects(raw: string): string[] {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return [];
  const repeated = [
    ...s.matchAll(
      /\b(?:a\s+|an\s+|the\s+)?(?:picture|image|photo(?:graph)?|illustration|painting|drawing|artwork|video|clip)\s+of\s+(.+?)(?=\s+and\s+(?:a\s+|an\s+|the\s+)?(?:picture|image|photo|illustration|painting|drawing|artwork|video|clip)\b|$)/gi,
    ),
  ]
    .map((m) => m[1]!.replace(/[,\s]+$/g, "").trim())
    .filter(Boolean);
  if (repeated.length >= 2) return repeated.slice(0, 6);

  const body = s
    .replace(
      /^(?:(?:a|an|some|the)\s+)?(?:pictures?|images?|photos?|illustrations?|paintings?|drawings?|artworks?|videos?|clips?)\s+(?:of|showing|with)\s+/i,
      "",
    )
    .trim();
  const parts = body
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=a\s+|an\s+|the\s+)/i)
    .map((p) => p.replace(/^(?:a|an|the)\s+/i, "").replace(/[.\s]+$/g, "").trim())
    .filter((p) => p.length > 1);
  if (parts.length >= 2) return parts.slice(0, 6);
  return [s];
}

const IMAGE_LEAD =
  /^(?:(?:hey|hi|ok(?:ay)?|so|please|trinity|can you|could you|would you|will you|i want you to|i['’]d like you to|i need you to)[\s,]*)*(?:make|create|generate|draw|paint|sketch|render|give|show|design|add)\s+(?:me\s+|us\s+)?(?:(?:a|an|some|the)\s+)?(?:(?:nice|cool|quick|cute|realistic|beautiful|detailed)\s+)?(?:picture|image|photo(?:graph)?|illustration|painting|drawing|artwork|art|poster|logo|icon|wallpaper)?s?\s*(?:of|showing|with|depicting|that shows)?\s*/i;
const AUDIO_LEAD =
  /^(?:(?:hey|hi|ok(?:ay)?|so|please|trinity|can you|could you|would you|will you)[\s,]*)*(?:(?:make|create|generate|record|produce|add)\s+(?:me\s+)?(?:(?:a|an|some)\s+)?(?:audio|recording|clip|voice ?(?:note|memo|over))\s*(?:of|saying|that says|reading|with)?|read\s+(?:this|that|it|the following)?\s*(?:aloud|out loud|back(?: to me)?)?|say\s+(?:this|that|the following)?|narrate)[\s:,]*/i;
const VIDEO_LEAD =
  /^(?:(?:hey|hi|ok(?:ay)?|so|please|trinity|can you|could you|would you|will you)[\s,]*)*(?:make|create|generate|film|shoot|animate|render|add)\s+(?:me\s+|us\s+)?(?:(?:a|an|some|the)\s+)?(?:(?:quick|short|cool|cinematic|detailed)\s+)?(?:video|clip|animation|movie|gif)s?\s*(?:of|showing|with|depicting|that shows)?\s*/i;
const TEXT_LEAD =
  /^(?:(?:hey|hi|ok(?:ay)?|so|please|trinity|can you|could you|would you|will you)[\s,]*)*(?:(?:add|put|pin|show|write|stick|place)\s+(?:(?:a|an|the|this|that)\s+)?(?:(?:text|note|card|memo|message|reminder)\s+)?(?:(?:to|on|in)\s+(?:the\s+)?(?:workspace|board|screen|window)\s*)?(?:that says|saying|with|:)?|note that|write down)\s*/i;
const NOT_SPEECH = /\b(song|music|melody|jingle|beat|tune|soundtrack|sound ?effects?|sfx|sound of|noise of|ambien(?:t|ce)|white noise)\b/i;

const qualityInput = {
  quality: {
    type: "string" as const,
    description: "which Mordiem model tier should handle this",
    options: QUALITY_OPTIONS,
  },
};

/** The chip for work on a card, keyed by the card itself (its id), so a later card with the same number never clears it. */
function busy(card: Pick<BoardCard, "id">, text: string | null): void {
  workspace.activity(`card:${card.id}`, text);
}

const qualityArg = (v: unknown): Record<string, string> => (typeof v === "string" && v ? { quality: v.slice(0, 40) } : {});

/** What "try again" needs to make this card again: the tool, the words, and the one subject this card shows. */
function retryFor(tool: string, request: string, arg: string, value: string, quality: unknown): CardRetry {
  return { tool, request: request.slice(0, 600), args: { [arg]: value.slice(0, 600), ...qualityArg(quality) } };
}

/**
 * The job behind a loading card: it holds the card (by id) until the media is ready or has failed, then writes the
 * result into that same card — or into nothing, if the card has gone meanwhile. A later card that happens to get the
 * same number is never touched.
 */
function finishInto(card: BoardCard, done: Promise<{ status: string; url?: string | null; error?: string }>, failed: string): void {
  const release = holdCard(card.id);
  void done
    .then((j) => {
      busy(card, null);
      const patch: CardPatch =
        j.status === "ready" && j.url ? { status: "ready", url: j.url, model: undefined } : { status: "error", error: j.error ?? "unknown error", model: undefined };
      const updated = patchCard(card.id, patch);
      if (updated && updated.status === "error") workspace.toast(`Card ${updated.n}: ${failed}`, "error");
    })
    .catch((err: unknown) => {
      busy(card, null);
      console.warn(`[media] card ${card.id}: ${(err as Error).message}`);
      try {
        patchCard(card.id, { status: "error", error: (err as Error).message.slice(0, 160), model: undefined });
      } catch {
        /* the board can't take it: the card stays as it is and is settled later */
      }
    })
    .finally(release);
}

const makeImage: Tool = {
  name: "make_image",
  description:
    "Add one or more pictures to the workspace as numbered floating cards. When the user asks for several subjects (a panda and a tiger), make a separate card for each.",
  input: {
    prompt: {
      type: "string",
      required: true,
      description:
        "What the picture(s) show, in the user's own words — one subject or several joined by 'and' / commas — without the request words ('draw me a picture of')",
    },
    ...qualityInput,
  },
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const prompt = String(args.prompt ?? "").trim() || ctx.utterance.replace(IMAGE_LEAD, "").trim();
    if (!prompt) return { ok: false, say: "What should the picture show?" };
    if (boardBlocked()) return { ok: false, say: "A game is on the workspace right now — finish or clear it before I add picture cards." };
    if (!live.mordiem) return { ok: false, say: "I can't make pictures without a Mordiem key — there's a place for it in Settings, under Models." };
    const subjects = splitSubjects(prompt);
    const pick = pickMordiemModel({ modality: "image", quality: args.quality, utterance: ctx.utterance });
    const cards: number[] = [];
    let anyPending = false;
    for (const subject of subjects) {
      const { id, done } = requestImage(subject, "picture", { model: pick.model });
      const job = getImageJob(id);
      if (job?.status === "error") {
        if (!cards.length) return { ok: false, say: `I couldn't make that picture: ${job.error ?? "unknown error"}.` };
        continue;
      }
      const card = tryAddCard({
        kind: "image",
        title: `Picture: ${caption(subject)}`,
        text: subject,
        tags: tagsFromText(subject),
        status: job?.status === "ready" && job.url ? "ready" : "pending",
        url: job?.status === "ready" ? job.url : null,
        model: pick.label,
        retry: retryFor("make_image", ctx.utterance, "prompt", subject, args.quality),
      });
      if (typeof card === "string") {
        if (!cards.length) return { ok: false, say: card };
        break; // the board is full: the pictures that did fit stay
      }
      cards.push(card.n);
      if (card.status === "ready") continue;
      anyPending = true;
      busy(card, `${pick.label} is painting card ${card.n}…`);
      finishInto(card, done, "couldn't make the picture");
    }
    if (!cards.length) return { ok: false, say: "I couldn't start those pictures." };
    if (cards.length === 1) {
      const n = cards[0]!;
      return {
        ok: true,
        say: anyPending
          ? `Card ${n} is on the board — ${pick.label} is painting ${caption(subjects[0]!)} into it now.`
          : `Added card ${n} with the picture of ${caption(subjects[0]!)}.`,
        inProgress: anyPending ? "started" : undefined,
        data: { cards, model: pick.model, quality: pick.quality },
      };
    }
    return {
      ok: true,
      say: `Started ${cards.length} picture cards (${cards.map((n, i) => `${n}: ${caption(subjects[i]!)}`).join("; ")}).`,
      inProgress: anyPending ? "started" : undefined,
      data: { cards, model: pick.model, quality: pick.quality },
    };
  },
};

const makeAudio: Tool = {
  name: "make_audio",
  description: "Add spoken audio — a reading, narration, or voice note — to the workspace as a numbered floating card.",
  input: {
    text: {
      type: "string",
      required: true,
      description:
        "The exact words to speak, verbatim — without the user's request around them ('read this aloud', 'make an audio that says')",
    },
    ...qualityInput,
  },
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    if (NOT_SPEECH.test(ctx.utterance)) return { ok: false, say: "I can make spoken audio, but not music or sound effects yet." };
    const text = String(args.text ?? "").trim() || ctx.utterance.replace(AUDIO_LEAD, "").trim();
    if (!text) return { ok: false, say: "What should the audio say?" };
    if (boardBlocked()) return { ok: false, say: "A game is on the workspace right now — finish or clear it before I add audio cards." };
    if (!live.mordiem) return { ok: false, say: "I can't make audio without a Mordiem key — there's a place for it in Settings, under Models." };
    const pick = pickMordiemModel({ modality: "audio", quality: args.quality, utterance: ctx.utterance });
    const { id, done } = requestSpeech(text, { model: pick.model });
    const job = getSpeechJob(id);
    if (job?.status === "error") return { ok: false, say: `I couldn't make that audio: ${job.error ?? "unknown error"}.` };
    const card = tryAddCard({
      kind: "audio",
      title: `Audio: ${caption(text)}`,
      text,
      tags: tagsFromText(text),
      status: job?.status === "ready" && job.url ? "ready" : "pending",
      url: job?.status === "ready" ? job.url : null,
      model: pick.label,
      retry: retryFor("make_audio", ctx.utterance, "text", text, args.quality),
    });
    if (typeof card === "string") return { ok: false, say: card };
    if (card.status === "ready") {
      return { ok: true, say: `Added card ${card.n} with that audio.`, data: { card: card.n } };
    }
    busy(card, `${pick.label} is recording card ${card.n}…`);
    finishInto(card, done, "couldn't make the audio");
    return {
      ok: true,
      say: `Card ${card.n} is on the board — ${pick.label} is recording into it now.`,
      inProgress: "started",
      data: { card: card.n, model: pick.model, quality: pick.quality },
    };
  },
};

const makeVideo: Tool = {
  name: "make_video",
  description: "Add a video clip or animation to the workspace as a numbered floating card.",
  input: {
    prompt: {
      type: "string",
      required: true,
      description: "What the video shows, as a description for a video model — subject, motion, setting, without the request words",
    },
    ...qualityInput,
  },
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const prompt = String(args.prompt ?? "").trim() || ctx.utterance.replace(VIDEO_LEAD, "").trim();
    if (!prompt) return { ok: false, say: "What should the video show?" };
    if (boardBlocked()) return { ok: false, say: "A game is on the workspace right now — finish or clear it before I add video cards." };
    if (!live.mordiem) return { ok: false, say: "I can't make videos without a Mordiem key — there's a place for it in Settings, under Models." };
    const pick = pickMordiemModel({ modality: "video", quality: args.quality, utterance: ctx.utterance });
    if (!pick.model) return { ok: false, say: "No video model is set — pick one in Settings → Models." };
    const subjects = splitSubjects(prompt);
    const cards: number[] = [];
    let anyPending = false;
    for (const subject of subjects) {
      const { id, done } = requestVideo(subject, { model: pick.model });
      const job = getVideoJob(id);
      if (job?.status === "error") {
        if (!cards.length) return { ok: false, say: `I couldn't make that video: ${job.error ?? "unknown error"}.` };
        continue;
      }
      const card = tryAddCard({
        kind: "video",
        title: `Video: ${caption(subject)}`,
        text: subject,
        tags: tagsFromText(subject),
        status: job?.status === "ready" && job.url ? "ready" : "pending",
        url: job?.status === "ready" ? job.url : null,
        model: pick.label,
        retry: retryFor("make_video", ctx.utterance, "prompt", subject, args.quality),
      });
      if (typeof card === "string") {
        if (!cards.length) return { ok: false, say: card };
        break;
      }
      cards.push(card.n);
      if (card.status === "ready") continue;
      anyPending = true;
      busy(card, `${pick.label} is filming card ${card.n}…`);
      finishInto(card, done, "couldn't make the video");
    }
    if (!cards.length) return { ok: false, say: "I couldn't start those videos." };
    if (cards.length === 1) {
      return {
        ok: true,
        say: anyPending
          ? `Card ${cards[0]} is on the board — ${pick.label} is filming ${caption(subjects[0]!)} into it now.`
          : `Added card ${cards[0]} with the video of ${caption(subjects[0]!)}.`,
        inProgress: anyPending ? "started" : undefined,
        data: { cards, model: pick.model, quality: pick.quality },
      };
    }
    return {
      ok: true,
      say: `Started ${cards.length} video cards (${cards.map((n, i) => `${n}: ${caption(subjects[i]!)}`).join("; ")}).`,
      inProgress: anyPending ? "started" : undefined,
      data: { cards, model: pick.model, quality: pick.quality },
    };
  },
};

const makeText: Tool = {
  name: "make_text",
  description: "Add a text note or written card to the workspace board (a sticky note, quote, or short message).",
  input: {
    text: {
      type: "string",
      required: true,
      description: "The exact words to put on the card, without the request words ('add a note that says')",
    },
  },
  source: "builtin",
  async run(args, ctx): Promise<ToolResult> {
    const text = String(args.text ?? "").trim() || ctx.utterance.replace(TEXT_LEAD, "").trim();
    if (!text) return { ok: false, say: "What should the text card say?" };
    if (boardBlocked()) return { ok: false, say: "A game is on the workspace right now — finish or clear it before I add text cards." };
    const card = tryAddCard({
      kind: "text",
      title: `Note: ${caption(text)}`,
      text,
      tags: tagsFromText(text),
      status: "ready",
      url: null,
    });
    if (typeof card === "string") return { ok: false, say: card };
    return { ok: true, say: `Added card ${card.n} with that note.`, data: { card: card.n } };
  },
};

export function registerMediaTools(): void {
  [makeImage, makeAudio, makeVideo, makeText].forEach(registerTool);
}
