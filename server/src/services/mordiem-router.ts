import { getEndpoints, modelName } from "../settings.js";

/**
 * Pick the best Mordiem model for a modality given what the caller needs.
 * Jev can pass an explicit quality tier (tool option); otherwise the utterance
 * is read for cues ("quick sketch", "photorealistic", "carefully explain").
 * Slot defaults come from Settings / .env; "quality" slots fall back to the
 * fast default when a separate pro model isn't configured.
 */

export type Modality = "text" | "image" | "audio" | "video";
export type Quality = "auto" | "fast" | "quality";
export type TextNeed = "brain" | "reply" | "fast" | "code_quick" | "code_strong";

export interface ModelPick {
  model: string;
  /** Human label for activity chips / spoken acknowledgements. */
  label: string;
  quality: "fast" | "quality";
  modality: Modality;
}

const FAST_IMAGE = /\b(quick|fast|draft|sketch|rough|thumbnail|simple|cheap)\b/i;
const QUALITY_IMAGE =
  /\b(detailed|detail|photoreal(?:istic)?|high[\s-]?res(?:olution)?|hi[\s-]?res|4k|ultra|cinematic|pro(?:fessional)?|best|highest|premium|masterpiece|intricate)\b/i;
const FAST_AUDIO = /\b(quick|fast|short|simple|draft)\b/i;
const QUALITY_AUDIO = /\b(natural|expressive|rich|premium|high[\s-]?quality|eleven|studio|warm|emotional)\b/i;
const FAST_VIDEO = /\b(quick|fast|short|draft|simple|gif|loop)\b/i;
const QUALITY_VIDEO =
  /\b(cinematic|detailed|high[\s-]?quality|photoreal(?:istic)?|4k|ultra|pro(?:fessional)?|best|premium|polished)\b/i;
const FAST_TEXT = /\b(quick(?:ly)?|brief(?:ly)?|short|simple|rough|in a word|tl;?dr)\b/i;
const QUALITY_TEXT =
  /\b(careful(?:ly)?|detail(?:ed|s)?|thorough(?:ly)?|in depth|step by step|explain|reason|prove|calculate|math|precise|exact)\b/i;

/** Normalize a Jev option / free string into a quality tier. */
export function parseQuality(raw: unknown): Quality {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s || s === "auto" || s === "none" || s === "default") return "auto";
  if (/^(fast|quick|turbo|draft|cheap|flash)$/.test(s)) return "fast";
  if (/^(quality|best|pro|strong|rich|premium|careful|detailed|cinematic)$/.test(s)) return "quality";
  return "auto";
}

function resolveQuality(explicit: Quality, utterance: string | undefined, fastRe: RegExp, qualityRe: RegExp): "fast" | "quality" {
  if (explicit === "fast") return "fast";
  if (explicit === "quality") return "quality";
  const t = utterance ?? "";
  const fastAt = fastRe.test(t) ? t.search(fastRe) : Infinity;
  const qualityAt = qualityRe.test(t) ? t.search(qualityRe) : Infinity;
  if (qualityAt < Infinity && qualityAt <= fastAt) return "quality";
  if (fastAt < Infinity) return "fast";
  return "fast"; // default: snappy on a live call
}

/** Best Mordiem model id for this modality and need. */
export function pickMordiemModel(opts: {
  modality: Modality;
  /** Jev option or "auto". */
  quality?: unknown;
  utterance?: string;
  /** Text-only role when modality is text. */
  need?: TextNeed;
}): ModelPick {
  const e = getEndpoints();
  const qualityIn = parseQuality(opts.quality);
  const utterance = opts.utterance ?? "";

  if (opts.modality === "image") {
    const quality = resolveQuality(qualityIn, utterance, FAST_IMAGE, QUALITY_IMAGE);
    // Prefer a dedicated pro slot when quality is asked; else the default (usually turbo).
    const model = quality === "quality" ? e.imageProModel || e.imageModel : e.imageModel;
    return { model, label: modelName(model), quality, modality: "image" };
  }

  if (opts.modality === "audio") {
    const quality = resolveQuality(qualityIn, utterance, FAST_AUDIO, QUALITY_AUDIO);
    const model = quality === "quality" ? e.ttsProModel || e.ttsModel : e.ttsModel;
    return { model, label: modelName(model), quality, modality: "audio" };
  }

  if (opts.modality === "video") {
    const quality = resolveQuality(qualityIn, utterance, FAST_VIDEO, QUALITY_VIDEO);
    const model = quality === "quality" ? e.videoProModel || e.videoModel : e.videoModel;
    return { model, label: modelName(model), quality, modality: "video" };
  }

  // Text: map need + quality cues onto the configured role slots.
  const need = opts.need ?? "brain";
  if (need === "reply") {
    return { model: e.replyModel, label: modelName(e.replyModel), quality: "fast", modality: "text" };
  }
  if (need === "fast") {
    return { model: e.fastModel, label: modelName(e.fastModel), quality: "fast", modality: "text" };
  }
  if (need === "code_quick") {
    return { model: e.glmModel, label: modelName(e.glmModel), quality: "fast", modality: "text" };
  }
  if (need === "code_strong") {
    return { model: e.kimiModel, label: modelName(e.kimiModel), quality: "quality", modality: "text" };
  }
  // brain (default text): careful reasoning vs a snappy answer.
  const quality = resolveQuality(qualityIn, utterance, FAST_TEXT, QUALITY_TEXT);
  const model = quality === "fast" ? e.fastModel : e.brainModel;
  return { model, label: modelName(model), quality, modality: "text" };
}

/** Labels Jev sees for a shared quality option across media / brain tools. */
export const QUALITY_OPTIONS: Record<string, string> = {
  auto: "pick the best model for what they asked (default)",
  fast: "the quick model — right for drafts, short clips, and snappy answers",
  quality: "the stronger model — slower but better for detail, photorealism, cinema, or careful reasoning",
};
