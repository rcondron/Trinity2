import type { Block, FlightItem, HotelItem, ProductItem } from "./content-spec.js";
import { daysBetween, fmtDay, fmtMinutes, fmtTime, money, type FlightSearch, type HotelSearch, type ShoppingSearch } from "./serpapi.js";

/*
 * Live search results → what goes on a card. The engine lays the results out itself (typed blocks the
 * renderer knows: product tiles, flight rows, hotel rows, a price-insight strip) so every price, time
 * and link is exactly what the provider returned; the card designer only writes around them — the
 * title, the spoken summary, the pick and the advice — from the same results as numbered text.
 */

export type LiveKind = "products" | "flights" | "hotels";

export interface LiveBundle {
  kind: LiveKind;
  /** The results laid out; inserted above the designer's blocks. */
  blocks: Block[];
  /** The results as numbered data for the designer. */
  text: string;
  /** The "see all" link for the card's footer. */
  sources: { title: string; url: string }[];
  /** Every link in the blocks (the normalizer's allow-list). */
  urls: string[];
  count: number;
}

const fmtCount = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const dayDiff = (a: string, b: string): number => daysBetween(a.slice(0, 10), b.slice(0, 10));
const assumedText = (assumed: string[]) => (assumed.length ? `\nAssumed (say so in the summary): ${assumed.join("; ")}.` : "");

/** The remote pictures a result set carries, to cache before the blocks are built. */
export function liveImages(s: ShoppingSearch | FlightSearch | HotelSearch): string[] {
  const out: string[] = [];
  if ("products" in s) for (const p of s.products.slice(0, 8)) if (p.image) out.push(p.image);
  if ("options" in s) for (const o of s.options.slice(0, 8)) if (o.logo) out.push(o.logo);
  if ("hotels" in s) for (const h of s.hotels.slice(0, 7)) if (h.image) out.push(h.image);
  return out;
}

// ─── Shopping ─────────────────────────────────────────────────────────────────

export function productsBundle(s: ShoppingSearch, images: Map<string, string>, assumed: string[] = []): LiveBundle {
  const shown = s.products.slice(0, 8);
  const priced = shown.filter((p) => p.priceValue !== null);
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => (b.priceValue! < a.priceValue! ? b : a)) : null;
  const topRated = shown
    .filter((p) => (p.rating ?? 0) >= 4.5 && (p.reviews ?? 0) >= 50)
    .sort((a, b) => b.rating! - a.rating! || (b.reviews ?? 0) - (a.reviews ?? 0))[0];
  const items: ProductItem[] = shown.map((p) => {
    const it: ProductItem = { title: p.title, price: p.price, store: p.store };
    if (p.oldPrice) it.oldPrice = p.oldPrice;
    if (p.rating !== undefined) it.rating = p.rating;
    if (p.reviews !== undefined) it.reviews = p.reviews;
    const img = p.image ? images.get(p.image) : undefined;
    if (img) it.image = img;
    if (p.url) it.url = p.url;
    if (p.delivery) it.delivery = p.delivery;
    if (p === cheapest) it.badge = "Lowest price";
    else if (p === topRated) it.badge = "Top rated";
    else if (p.tag) it.badge = p.tag;
    return it;
  });
  const lo = priced.length ? Math.min(...priced.map((p) => p.priceValue!)) : null;
  const hi = priced.length ? Math.max(...priced.map((p) => p.priceValue!)) : null;
  const range = lo !== null && hi !== null && lo !== hi ? `${money(lo)}–${money(hi)}` : lo !== null ? money(lo) : "";
  const text = [
    `Search: "${s.query.query}"${s.query.maxPrice !== undefined ? `, under ${money(s.query.maxPrice)}` : ""}${s.query.minPrice !== undefined ? `, over ${money(s.query.minPrice)}` : ""}. ${s.products.length} results; the first ${shown.length} are on the card${range ? ` (${range})` : ""}.`,
    ...shown.map(
      (p, i) =>
        `${i + 1}. ${p.title} — ${p.price}${p.oldPrice ? ` (was ${p.oldPrice})` : ""} at ${p.store}${p.rating !== undefined ? `, rated ${p.rating}${p.reviews ? ` by ${p.reviews.toLocaleString("en-US")}` : ""}` : ""}${p.delivery ? `, ${p.delivery}` : ""}`,
    ),
    cheapest ? `Lowest price: ${cheapest.price} at ${cheapest.store}.` : "",
    topRated ? `Best rated: ${topRated.title} (${topRated.rating} from ${fmtCount(topRated.reviews ?? 0)} reviews) at ${topRated.price}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const block: Block = { kind: "products", title: shown.length < s.products.length ? `Top ${shown.length} of ${s.products.length} results` : `${shown.length} results`, items };
  return {
    kind: "products",
    blocks: [block],
    text: text + assumedText(assumed),
    sources: [{ title: "Google Shopping", url: s.url }],
    urls: [s.url, ...items.map((i) => i.url).filter((u): u is string => Boolean(u))],
    count: s.products.length,
  };
}

// ─── Flights ──────────────────────────────────────────────────────────────────

const LEVEL: Record<string, string> = { low: "Low", typical: "Typical", high: "High" };

export function flightsBundle(s: FlightSearch, images: Map<string, string>, assumed: string[] = []): LiveBundle {
  const shown = s.options.slice(0, 8);
  const priced = shown.filter((o) => o.price !== null);
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => (b.price! < a.price! ? b : a)) : null;
  const fastest = shown.length > 1 ? shown.reduce((a, b) => (b.totalMinutes && b.totalMinutes < a.totalMinutes ? b : a)) : null;
  const best = shown.find((o) => o.best) ?? null;
  const q = s.query;
  const roundTrip = Boolean(q.returnDate);
  const items: FlightItem[] = shown.map((o) => {
    const first = o.legs[0]!;
    const last = o.legs[o.legs.length - 1]!;
    const plus = dayDiff(first.from.time, last.to.time);
    const it: FlightItem = {
      price: money(o.price, s.currency) || "—",
      airline: o.airlines.join(" · "),
      depart: fmtTime(first.from.time),
      arrive: `${fmtTime(last.to.time)}${plus > 0 ? ` +${plus}` : ""}`,
      from: first.from.code,
      to: last.to.code,
      duration: fmtMinutes(o.totalMinutes) || "—",
      stops:
        o.stops === 0
          ? "Nonstop"
          : `${o.stops} stop${o.stops > 1 ? "s" : ""}${o.layovers.length ? ` · ${o.layovers.map((l) => `${fmtMinutes(l.minutes)} in ${l.code}${l.overnight ? " overnight" : ""}`).join(", ")}` : ""}`,
      url: s.url,
    };
    const logo = o.logo ? images.get(o.logo) : undefined;
    if (logo) it.logo = logo;
    if (o.stops > 0)
      it.legs = o.legs.map((l) => `${l.flightNumber ? `${l.flightNumber} · ` : ""}${l.from.code} ${fmtTime(l.from.time)} → ${l.to.code} ${fmtTime(l.to.time)} · ${fmtMinutes(l.minutes)}`);
    if (o === best) it.badge = "Best";
    else if (o === cheapest) it.badge = "Cheapest";
    else if (o === fastest && o.stops === 0) it.badge = "Fastest";
    const note = o.notes.find((n) => /bag|legroom|wi-?fi|power|seat|delay/i.test(n));
    if (note) it.note = note;
    return it;
  });
  const blocks: Block[] = [];
  if (s.insights && (s.insights.lowest !== null || s.insights.typicalRange || s.insights.level)) {
    const stats: { value: string; label: string }[] = [];
    if (s.insights.lowest !== null) stats.push({ value: money(s.insights.lowest, s.currency), label: "Lowest fare" });
    if (s.insights.typicalRange) stats.push({ value: `${money(s.insights.typicalRange[0], s.currency)}–${money(s.insights.typicalRange[1], s.currency)}`, label: "Typical range" });
    if (s.insights.level && LEVEL[s.insights.level]) stats.push({ value: LEVEL[s.insights.level]!, label: "Prices now" });
    if (stats.length) blocks.push({ kind: "stats", items: stats });
  }
  const when = `${fmtDay(q.departDate)}${q.returnDate ? ` – ${fmtDay(q.returnDate)}` : ""}`;
  blocks.push({
    kind: "flights",
    title: `${roundTrip ? "Outbound · round-trip fares" : "One way"} · ${when}${shown.length < s.options.length ? ` · ${shown.length} of ${s.options.length}` : ""}`,
    items,
  });
  const text = [
    `Search: ${q.originName ?? q.origin.join("/")} (${q.origin.join("/")}) → ${q.destinationName ?? q.destination.join("/")} (${q.destination.join("/")}), ${when}, ${roundTrip ? "round trip (fares below are round-trip totals for this outbound; the return leg is picked on Google Flights)" : "one way"}, ${q.adults ?? 1} adult${(q.adults ?? 1) > 1 ? "s" : ""}, ${q.cabin ?? "economy"}${q.nonstop ? ", nonstop only" : ""}. ${s.options.length} options; the first ${shown.length} are on the card.`,
    ...shown.map(
      (o, i) =>
        `${i + 1}. ${money(o.price, s.currency) || "price n/a"} ${o.airlines.join("/")} — ${o.legs[0]!.from.code} ${fmtTime(o.legs[0]!.from.time)} → ${o.legs[o.legs.length - 1]!.to.code} ${fmtTime(o.legs[o.legs.length - 1]!.to.time)}, ${fmtMinutes(o.totalMinutes)}, ${o.stops === 0 ? "nonstop" : `${o.stops} stop${o.stops > 1 ? "s" : ""} (${o.layovers.map((l) => `${fmtMinutes(l.minutes)} ${l.code}`).join(", ")})`}${o.best ? " [Google: best]" : ""}${o.notes.length ? ` — ${o.notes.slice(0, 2).join("; ")}` : ""}`,
    ),
    s.insights?.lowest !== null && s.insights?.lowest !== undefined ? `Google's price insight: lowest ${money(s.insights.lowest, s.currency)}${s.insights.typicalRange ? `, typical ${money(s.insights.typicalRange[0], s.currency)}–${money(s.insights.typicalRange[1], s.currency)}` : ""}${s.insights.level ? `, prices are ${s.insights.level} right now` : ""}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    kind: "flights",
    blocks,
    text: text + assumedText(assumed),
    sources: [{ title: "Google Flights", url: s.url }],
    urls: [s.url],
    count: s.options.length,
  };
}

// ─── Hotels ───────────────────────────────────────────────────────────────────

export function hotelsBundle(s: HotelSearch, images: Map<string, string>, assumed: string[] = []): LiveBundle {
  const shown = s.hotels.slice(0, 7);
  const priced = shown.filter((h) => h.pricePerNightValue !== null);
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => (b.pricePerNightValue! < a.pricePerNightValue! ? b : a)) : null;
  const topRated = shown
    .filter((h) => (h.rating ?? 0) >= 4.3 && (h.reviews ?? 0) >= 50)
    .sort((a, b) => b.rating! - a.rating! || (b.reviews ?? 0) - (a.reviews ?? 0))[0];
  const q = s.query;
  const items: HotelItem[] = shown.map((h) => {
    const it: HotelItem = { name: h.name, url: h.url ?? s.url };
    if (h.pricePerNight) it.price = h.pricePerNight;
    if (h.total) it.total = h.total;
    if (h.rating !== undefined) it.rating = h.rating;
    if (h.reviews !== undefined) it.reviews = h.reviews;
    if (h.stars !== undefined) it.stars = h.stars;
    const img = h.image ? images.get(h.image) : undefined;
    if (img) it.image = img;
    if (h.amenities.length) it.amenities = h.amenities.slice(0, 4);
    if (h.nearby) it.location = h.nearby;
    if (h === topRated) it.badge = "Top rated";
    else if (h === cheapest) it.badge = "Best value";
    else if (h.type === "vacation rental") it.badge = "Rental";
    if (h.offers.length > 1) it.offers = h.offers.slice(0, 3).map((o) => `${o.source} ${o.price}`).join(" · ");
    return it;
  });
  const nights = `${s.nights} night${s.nights > 1 ? "s" : ""}`;
  const when = `${fmtDay(q.checkIn)} – ${fmtDay(q.checkOut)}`;
  const block: Block = { kind: "hotels", title: `${nights} · ${when} · ${q.adults ?? 2} guest${(q.adults ?? 2) > 1 ? "s" : ""}`, items };
  const text = [
    `Search: hotels in ${q.destination}, ${when} (${nights}), ${q.adults ?? 2} guests${q.maxPrice !== undefined ? `, up to ${money(q.maxPrice)} a night` : ""}. ${s.hotels.length} properties; the first ${shown.length} are on the card.`,
    ...shown.map(
      (h, i) =>
        `${i + 1}. ${h.name}${h.stars ? ` (${h.stars}-star)` : ""}${h.type === "vacation rental" ? " (vacation rental)" : ""} — ${h.pricePerNight ?? "rate n/a"} a night${h.total ? `, ${h.total} total` : ""}${h.rating !== undefined ? `, rated ${h.rating}${h.reviews ? ` by ${h.reviews.toLocaleString("en-US")}` : ""}` : ""}${h.amenities.length ? `; ${h.amenities.slice(0, 4).join(", ")}` : ""}${h.nearby ? `; ${h.nearby}` : ""}${h.description ? `. ${h.description}` : ""}`,
    ),
    cheapest ? `Lowest rate: ${cheapest.name} at ${cheapest.pricePerNight}.` : "",
    topRated ? `Best rated: ${topRated.name} (${topRated.rating} from ${fmtCount(topRated.reviews ?? 0)} reviews) at ${topRated.pricePerNight ?? "n/a"}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    kind: "hotels",
    blocks: [block],
    text: text + assumedText(assumed),
    sources: [{ title: "Google Hotels", url: s.url }],
    urls: [s.url, ...items.map((i) => i.url).filter((u): u is string => Boolean(u))],
    count: s.hotels.length,
  };
}
