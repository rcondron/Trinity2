import { getEndpoints } from "../settings.js";

/*
 * SerpApi: live Google Shopping, Google Flights and Google Hotels results for the shopping and travel
 * cards (tools/content.ts via services/live-results.ts). One key covers all three — SERPAPI_KEY in .env
 * or Settings → API keys; the free tier is 250 searches a month. Every reply is coerced into the
 * engine's own shapes here, so nothing downstream ever reads the provider's JSON, and nothing is cached
 * across requests (prices move). Without a key the users fall back to web search and say so.
 */

const BASE = "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 20_000;

export function serpapiKey(): string {
  return (getEndpoints().serpapiKey ?? "").trim();
}

/** Live shopping / flight / hotel results are available (a key is set). */
export function travelLive(): boolean {
  return Boolean(serpapiKey());
}

type Params = Record<string, string | number | boolean | undefined | null>;

export class SerpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SerpApiError";
  }
}

/** One search. Throws SerpApiError on HTTP failure; a 200 that carries `error` (no results) is returned as is. */
async function serpapi<T extends Record<string, unknown>>(engine: string, params: Params, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const key = serpapiKey();
  if (!key) throw new SerpApiError("no SerpApi key", 0);
  const qs = new URLSearchParams({ engine, api_key: key });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  // (The URL carries the key: never log it.)
  const res = await fetch(`${BASE}?${qs.toString()}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) throw new SerpApiError(typeof body.error === "string" ? body.error : `SerpApi answered ${res.status}`, res.status);
  if (typeof body.error === "string") console.warn(`[serpapi] ${engine}: ${body.error}`);
  return body as T;
}

// ─── Coercion helpers ─────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const httpUrl = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https?:\/\/[^\s"'<>]{4,2000}$/i.test(s) ? s : undefined;
};

// ─── Formatting (shared with the card builder) ────────────────────────────────

/** 325 → "5h 25m". */
export function fmtMinutes(min: number | null | undefined): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** "2026-03-03 10:10" → "10:10 am". */
export function fmtTime(s: string): string {
  const m = /(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return s;
  const h = Number(m[1]);
  const ampm = h >= 12 ? "pm" : "am";
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${ampm}`;
}

/** The date part of "2026-03-03 10:10" (or an ISO date) → "Tue, Mar 3". */
export function fmtDay(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Days between two ISO dates (0 when either is malformed). */
export function daysBetween(a: string, b: string): number {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(a);
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  if (!pa || !pb) return 0;
  const da = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const db = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((db - da) / 86_400_000);
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "CA$", AUD: "A$", MXN: "MX$", INR: "₹" };

/** 520 → "$520"; 1234.5 → "$1,235". */
export function money(n: number | null | undefined, currency = "USD"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const sym = SYMBOL[currency] ?? `${currency} `;
  return `${sym}${Math.round(n).toLocaleString("en-US")}`;
}

// ─── Google Shopping ──────────────────────────────────────────────────────────

export interface Product {
  title: string;
  /** As Google shows it: "$829.00". */
  price: string;
  priceValue: number | null;
  oldPrice?: string;
  store: string;
  rating?: number;
  reviews?: number;
  /** The remote thumbnail (the user caches it into the engine before it reaches a card). */
  image?: string;
  /** The merchant page when Google gives one, else the Google product page. */
  url?: string;
  delivery?: string;
  snippet?: string;
  tag?: string;
}

export interface ShoppingQuery {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: "price" | "relevance";
  limit?: number;
}

export interface ShoppingSearch {
  query: ShoppingQuery;
  products: Product[];
  /** The same search on Google Shopping, for the card's footer. */
  url: string;
}

export function shoppingUrl(query: string): string {
  return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`;
}

function product(raw: unknown): Product | null {
  const r = obj(raw);
  const title = str(r.title, 160);
  const price = str(r.price, 24);
  if (!title || !price) return null;
  const p: Product = {
    title,
    price,
    priceValue: num(r.extracted_price),
    store: str(r.source, 60) || "Store",
    url: httpUrl(r.link) ?? httpUrl(r.product_link),
  };
  const old = str(r.old_price, 24);
  if (old) p.oldPrice = old;
  const rating = num(r.rating);
  if (rating !== null) p.rating = rating;
  const reviews = num(r.reviews);
  if (reviews !== null) p.reviews = reviews;
  const image = httpUrl(r.thumbnail) ?? httpUrl(r.serpapi_thumbnail);
  if (image) p.image = image;
  const delivery = str(r.delivery, 60);
  if (delivery) p.delivery = delivery;
  const snippet = str(r.snippet, 160);
  if (snippet) p.snippet = snippet;
  const tag = str(r.tag, 24);
  if (tag) p.tag = tag;
  return p;
}

export async function searchProducts(q: ShoppingQuery, timeoutMs?: number): Promise<ShoppingSearch> {
  const body = await serpapi<{ shopping_results?: unknown[]; inline_shopping_results?: unknown[] }>(
    "google_shopping",
    {
      q: q.query,
      hl: "en",
      gl: "us",
      min_price: q.minPrice,
      max_price: q.maxPrice,
      sort_by: q.sort === "price" ? 1 : undefined,
    },
    timeoutMs,
  );
  const seen = new Set<string>();
  const products: Product[] = [];
  for (const raw of [...list(body.shopping_results), ...list(body.inline_shopping_results)]) {
    const p = product(raw);
    if (!p) continue;
    const key = `${p.title.toLowerCase()}|${p.store.toLowerCase()}|${p.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Google's own filter is loose; the user's bounds are firm.
    if (q.maxPrice !== undefined && p.priceValue !== null && p.priceValue > q.maxPrice) continue;
    if (q.minPrice !== undefined && p.priceValue !== null && p.priceValue < q.minPrice) continue;
    products.push(p);
  }
  if (q.sort === "price") products.sort((a, b) => (a.priceValue ?? Infinity) - (b.priceValue ?? Infinity));
  return { query: q, products: products.slice(0, q.limit ?? 12), url: shoppingUrl(q.query) };
}

// ─── Google Flights ───────────────────────────────────────────────────────────

export interface FlightStop {
  code: string;
  name?: string;
  /** "2026-03-03 10:10" as Google gives it (local time). */
  time: string;
}

export interface FlightLeg {
  airline: string;
  logo?: string;
  flightNumber?: string;
  from: FlightStop;
  to: FlightStop;
  minutes: number;
  aircraft?: string;
  cabin?: string;
  overnight?: boolean;
}

export interface Layover {
  minutes: number;
  code: string;
  name?: string;
  overnight?: boolean;
}

export interface FlightOption {
  price: number | null;
  currency: string;
  legs: FlightLeg[];
  layovers: Layover[];
  totalMinutes: number;
  stops: number;
  /** Distinct airlines, in order of flying. */
  airlines: string[];
  logo?: string;
  /** Emissions vs typical for the route, percent (negative = less). */
  emissionsPct: number | null;
  notes: string[];
  /** Google put it in "best flights". */
  best: boolean;
}

export type Cabin = "economy" | "premium" | "business" | "first";

export interface FlightQuery {
  /** IATA codes (a city may have several). */
  origin: string[];
  destination: string[];
  originName?: string;
  destinationName?: string;
  /** YYYY-MM-DD. */
  departDate: string;
  /** YYYY-MM-DD for a round trip; null / absent for one way. */
  returnDate?: string | null;
  adults?: number;
  cabin?: Cabin;
  nonstop?: boolean;
  currency?: string;
}

export interface PriceInsights {
  lowest: number | null;
  /** "low" | "typical" | "high" as Google says it. */
  level: string;
  typicalRange: [number, number] | null;
}

export interface FlightSearch {
  query: FlightQuery;
  options: FlightOption[];
  insights: PriceInsights | null;
  currency: string;
  /** The same search on Google Flights. */
  url: string;
}

const CABIN_CODE: Record<Cabin, number> = { economy: 1, premium: 2, business: 3, first: 4 };

/** A Google Flights search for the same trip (its search box takes plain words). */
export function flightsUrl(q: FlightQuery): string {
  const from = q.originName || q.origin.join(" or ");
  const to = q.destinationName || q.destination.join(" or ");
  const words = `flights from ${from} to ${to} on ${q.departDate}${q.returnDate ? ` through ${q.returnDate}` : " one way"}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(words)}`;
}

function stop(raw: unknown): FlightStop | null {
  const r = obj(raw);
  const code = str(r.id, 8).toUpperCase();
  if (!code) return null;
  const s: FlightStop = { code, time: str(r.time, 32) };
  const name = str(r.name, 80);
  if (name) s.name = name;
  return s;
}

function leg(raw: unknown): FlightLeg | null {
  const r = obj(raw);
  const from = stop(r.departure_airport);
  const to = stop(r.arrival_airport);
  if (!from || !to) return null;
  const l: FlightLeg = { airline: str(r.airline, 60) || "Airline", from, to, minutes: num(r.duration) ?? 0 };
  const logo = httpUrl(r.airline_logo);
  if (logo) l.logo = logo;
  const fn = str(r.flight_number, 16);
  if (fn) l.flightNumber = fn;
  const aircraft = str(r.airplane, 40);
  if (aircraft) l.aircraft = aircraft;
  const cabin = str(r.travel_class, 24);
  if (cabin) l.cabin = cabin;
  if (r.overnight === true) l.overnight = true;
  return l;
}

function layover(raw: unknown): Layover | null {
  const r = obj(raw);
  const code = str(r.id, 8).toUpperCase();
  const minutes = num(r.duration) ?? 0;
  if (!code && !minutes) return null;
  const l: Layover = { minutes, code: code || "—" };
  const name = str(r.name, 80);
  if (name) l.name = name;
  if (r.overnight === true) l.overnight = true;
  return l;
}

function flight(raw: unknown, best: boolean, currency: string): FlightOption | null {
  const r = obj(raw);
  const legs = list(r.flights).map(leg).filter((l): l is FlightLeg => l !== null);
  if (!legs.length) return null;
  const layovers = list(r.layovers).map(layover).filter((l): l is Layover => l !== null);
  const airlines: string[] = [];
  for (const l of legs) if (!airlines.includes(l.airline)) airlines.push(l.airline);
  const emissions = obj(r.carbon_emissions);
  const o: FlightOption = {
    price: num(r.price),
    currency,
    legs,
    layovers,
    totalMinutes: num(r.total_duration) ?? legs.reduce((s, l) => s + l.minutes, 0) + layovers.reduce((s, l) => s + l.minutes, 0),
    stops: Math.max(0, legs.length - 1),
    airlines,
    emissionsPct: num(emissions.difference_percent),
    notes: list(r.extensions)
      .map((x) => str(x, 80))
      .filter(Boolean)
      .slice(0, 4),
    best,
  };
  const logo = httpUrl(r.airline_logo) ?? legs[0]?.logo;
  if (logo) o.logo = logo;
  return o;
}

export async function searchFlights(q: FlightQuery, timeoutMs?: number): Promise<FlightSearch> {
  const currency = q.currency || "USD";
  const roundTrip = Boolean(q.returnDate);
  const body = await serpapi<{ best_flights?: unknown[]; other_flights?: unknown[]; price_insights?: unknown }>(
    "google_flights",
    {
      departure_id: q.origin.join(","),
      arrival_id: q.destination.join(","),
      outbound_date: q.departDate,
      return_date: roundTrip ? q.returnDate : undefined,
      type: roundTrip ? 1 : 2,
      adults: q.adults && q.adults > 0 ? q.adults : 1,
      travel_class: CABIN_CODE[q.cabin ?? "economy"] ?? 1,
      stops: q.nonstop ? 1 : undefined,
      currency,
      hl: "en",
      gl: "us",
    },
    timeoutMs,
  );
  const best = list(body.best_flights)
    .map((r) => flight(r, true, currency))
    .filter((f): f is FlightOption => f !== null);
  const other = list(body.other_flights)
    .map((r) => flight(r, false, currency))
    .filter((f): f is FlightOption => f !== null)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const seen = new Set<string>();
  const options: FlightOption[] = [];
  for (const f of [...best, ...other]) {
    const key = f.legs.map((l) => `${l.flightNumber ?? l.airline}@${l.from.time}`).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(f);
  }
  const pi = obj(body.price_insights);
  const range = list(pi.typical_price_range).map(num);
  const lo = range[0];
  const hi = range[1];
  const insights: PriceInsights | null = Object.keys(pi).length
    ? {
        lowest: num(pi.lowest_price),
        level: str(pi.price_level, 16),
        typicalRange: range.length === 2 && typeof lo === "number" && typeof hi === "number" ? [lo, hi] : null,
      }
    : null;
  return { query: q, options, insights, currency, url: flightsUrl(q) };
}

// ─── Google Hotels ────────────────────────────────────────────────────────────

export interface HotelOffer {
  source: string;
  /** Per night, as shown: "$68". */
  price: string;
}

export interface Hotel {
  name: string;
  /** "hotel" | "vacation rental". */
  type: string;
  description?: string;
  url?: string;
  /** The remote thumbnail (cached by the user). */
  image?: string;
  /** Per night, as shown: "$154". */
  pricePerNight?: string;
  pricePerNightValue: number | null;
  total?: string;
  rating?: number;
  reviews?: number;
  /** Hotel class, 1–5. */
  stars?: number;
  locationRating?: number;
  amenities: string[];
  /** "10 min taxi to Jimbaran Beach" — the first nearby place. */
  nearby?: string;
  offers: HotelOffer[];
  freeCancellation?: boolean;
}

export interface HotelQuery {
  destination: string;
  /** YYYY-MM-DD. */
  checkIn: string;
  checkOut: string;
  adults?: number;
  maxPrice?: number;
  sort?: "price" | "rating" | "relevance";
  currency?: string;
}

export interface HotelSearch {
  query: HotelQuery;
  hotels: Hotel[];
  nights: number;
  /** The same search on Google Hotels. */
  url: string;
}

export function hotelsUrl(q: HotelQuery): string {
  const words = `hotels in ${q.destination} ${q.checkIn} to ${q.checkOut}`;
  return `https://www.google.com/travel/search?q=${encodeURIComponent(words)}`;
}

function hotel(raw: unknown): Hotel | null {
  const r = obj(raw);
  const name = str(r.name, 120);
  if (!name) return null;
  const rate = obj(r.rate_per_night);
  const total = obj(r.total_rate);
  const h: Hotel = {
    name,
    type: str(r.type, 24) || "hotel",
    pricePerNightValue: num(rate.extracted_lowest) ?? num(rate.extracted_before_taxes_fees) ?? num(r.extracted_price),
    amenities: list(r.amenities)
      .map((x) => str(x, 40))
      .filter(Boolean)
      .slice(0, 12),
    offers: list(r.prices)
      .map((x) => {
        const o = obj(x);
        const source = str(o.source, 40);
        const price = str(obj(o.rate_per_night).lowest, 24);
        return source && price ? { source, price } : null;
      })
      .filter((o): o is HotelOffer => o !== null)
      .slice(0, 6),
  };
  const description = str(r.description, 240);
  if (description) h.description = description;
  const url = httpUrl(r.link);
  if (url) h.url = url;
  const image = httpUrl(obj(list(r.images)[0]).thumbnail) ?? httpUrl(r.thumbnail);
  if (image) h.image = image;
  const perNight = str(rate.lowest, 24) || str(r.price, 24);
  if (perNight) h.pricePerNight = perNight;
  const tot = str(total.lowest, 24);
  if (tot) h.total = tot;
  const rating = num(r.overall_rating);
  if (rating !== null) h.rating = Math.round(rating * 10) / 10;
  const reviews = num(r.reviews);
  if (reviews !== null) h.reviews = reviews;
  const stars = num(r.extracted_hotel_class) ?? (typeof r.hotel_class === "number" ? r.hotel_class : num(/^(\d)-star/.exec(str(r.hotel_class, 24))?.[1]));
  if (stars !== null && stars >= 1 && stars <= 5) h.stars = stars;
  const loc = num(r.location_rating);
  if (loc !== null) h.locationRating = Math.round(loc * 10) / 10;
  const near = obj(list(r.nearby_places)[0]);
  const nearName = str(near.name, 60);
  const trans = obj(list(near.transportations)[0]);
  if (nearName) h.nearby = trans.duration ? `${str(trans.duration, 16)} ${str(trans.type, 16).toLowerCase()} to ${nearName}`.replace(/\s+/g, " ") : nearName;
  if (r.free_cancellation === true || h.offers.length === 0 ? false : list(r.prices).some((x) => obj(x).free_cancellation === true)) h.freeCancellation = true;
  return h;
}

const HOTEL_SORT: Record<string, number | undefined> = { price: 3, rating: 8, relevance: undefined };

export async function searchHotels(q: HotelQuery, timeoutMs?: number): Promise<HotelSearch> {
  const body = await serpapi<{ properties?: unknown[] }>(
    "google_hotels",
    {
      q: /\b(hotels?|stays?|resorts?|rentals?)\b/i.test(q.destination) ? q.destination : `hotels in ${q.destination}`,
      check_in_date: q.checkIn,
      check_out_date: q.checkOut,
      adults: q.adults && q.adults > 0 ? q.adults : 2,
      max_price: q.maxPrice,
      sort_by: HOTEL_SORT[q.sort ?? "relevance"],
      currency: q.currency || "USD",
      hl: "en",
      gl: "us",
    },
    timeoutMs,
  );
  const hotels = list(body.properties)
    .map(hotel)
    .filter((h): h is Hotel => h !== null);
  return { query: q, hotels, nights: Math.max(1, daysBetween(q.checkIn, q.checkOut)), url: hotelsUrl(q) };
}
