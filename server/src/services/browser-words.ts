/*
 * The user's words → a browser action, with no model in the loop: Jev picks the tool in a few
 * hundred milliseconds and these parsers fill in the rest at once — which site or search to open,
 * which tab, which button, how far to scroll, what to hide. A model is only asked when the words
 * don't settle it (an element that no name matches, a styling change with no preset).
 */

const enc = encodeURIComponent;

// ─── Sites ────────────────────────────────────────────────────────────────────

/** Spoken names → home pages. */
const SITES: Record<string, string> = {
  youtube: "https://www.youtube.com/",
  "youtube music": "https://music.youtube.com/",
  gmail: "https://mail.google.com/",
  google: "https://www.google.com/",
  "google maps": "https://maps.google.com/",
  maps: "https://maps.google.com/",
  "google calendar": "https://calendar.google.com/",
  calendar: "https://calendar.google.com/",
  "google drive": "https://drive.google.com/",
  drive: "https://drive.google.com/",
  "google docs": "https://docs.google.com/",
  docs: "https://docs.google.com/",
  "google photos": "https://photos.google.com/",
  "google news": "https://news.google.com/",
  "the news": "https://news.google.com/",
  news: "https://news.google.com/",
  amazon: "https://www.amazon.com/",
  netflix: "https://www.netflix.com/",
  reddit: "https://www.reddit.com/",
  twitter: "https://x.com/",
  x: "https://x.com/",
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
  tiktok: "https://www.tiktok.com/",
  pinterest: "https://www.pinterest.com/",
  github: "https://github.com/",
  wikipedia: "https://en.wikipedia.org/",
  outlook: "https://outlook.live.com/",
  spotify: "https://open.spotify.com/",
  twitch: "https://www.twitch.tv/",
  linkedin: "https://www.linkedin.com/",
  ebay: "https://www.ebay.com/",
  walmart: "https://www.walmart.com/",
  target: "https://www.target.com/",
  "best buy": "https://www.bestbuy.com/",
  costco: "https://www.costco.com/",
  etsy: "https://www.etsy.com/",
  bbc: "https://www.bbc.com/news",
  cnn: "https://www.cnn.com/",
  "new york times": "https://www.nytimes.com/",
  nytimes: "https://www.nytimes.com/",
  "the times": "https://www.nytimes.com/",
  "washington post": "https://www.washingtonpost.com/",
  "the guardian": "https://www.theguardian.com/",
  espn: "https://www.espn.com/",
  weather: "https://weather.com/",
  "the weather": "https://weather.com/",
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  "hacker news": "https://news.ycombinator.com/",
  apple: "https://www.apple.com/",
  "stack overflow": "https://stackoverflow.com/",
  whatsapp: "https://web.whatsapp.com/",
  yahoo: "https://www.yahoo.com/",
  bing: "https://www.bing.com/",
  duckduckgo: "https://duckduckgo.com/",
  craigslist: "https://www.craigslist.org/",
  zillow: "https://www.zillow.com/",
  airbnb: "https://www.airbnb.com/",
  expedia: "https://www.expedia.com/",
  booking: "https://www.booking.com/",
  "uber eats": "https://www.ubereats.com/",
  doordash: "https://www.doordash.com/",
  imdb: "https://www.imdb.com/",
  "rotten tomatoes": "https://www.rottentomatoes.com/",
  discord: "https://discord.com/app",
  slack: "https://app.slack.com/",
  notion: "https://www.notion.so/",
  figma: "https://www.figma.com/",
  canva: "https://www.canva.com/",
  paypal: "https://www.paypal.com/",
  "google flights": "https://www.google.com/travel/flights",
  "google translate": "https://translate.google.com/",
  translate: "https://translate.google.com/",
  "my bank": "",
};

/** Spoken names → a search page for a query. */
const SEARCH: Record<string, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${enc(q)}`,
  "google images": (q) => `https://www.google.com/search?tbm=isch&q=${enc(q)}`,
  images: (q) => `https://www.google.com/search?tbm=isch&q=${enc(q)}`,
  "google news": (q) => `https://news.google.com/search?q=${enc(q)}`,
  news: (q) => `https://news.google.com/search?q=${enc(q)}`,
  "google maps": (q) => `https://www.google.com/maps/search/${enc(q)}`,
  maps: (q) => `https://www.google.com/maps/search/${enc(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${enc(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${enc(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${enc(q)}`,
  reddit: (q) => `https://www.reddit.com/search/?q=${enc(q)}`,
  github: (q) => `https://github.com/search?q=${enc(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${enc(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${enc(q)}`,
  ebay: (q) => `https://www.ebay.com/sch/i.html?_nkw=${enc(q)}`,
  twitter: (q) => `https://x.com/search?q=${enc(q)}`,
  x: (q) => `https://x.com/search?q=${enc(q)}`,
  netflix: (q) => `https://www.netflix.com/search?q=${enc(q)}`,
  spotify: (q) => `https://open.spotify.com/search/${enc(q)}`,
  imdb: (q) => `https://www.imdb.com/find/?q=${enc(q)}`,
  "stack overflow": (q) => `https://stackoverflow.com/search?q=${enc(q)}`,
  walmart: (q) => `https://www.walmart.com/search?q=${enc(q)}`,
  target: (q) => `https://www.target.com/s?searchTerm=${enc(q)}`,
  "best buy": (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${enc(q)}`,
  etsy: (q) => `https://www.etsy.com/search?q=${enc(q)}`,
  linkedin: (q) => `https://www.linkedin.com/search/results/all/?keywords=${enc(q)}`,
  "hacker news": (q) => `https://hn.algolia.com/?q=${enc(q)}`,
  tiktok: (q) => `https://www.tiktok.com/search?q=${enc(q)}`,
  pinterest: (q) => `https://www.pinterest.com/search/pins/?q=${enc(q)}`,
  zillow: (q) => `https://www.zillow.com/homes/${enc(q)}_rb/`,
  airbnb: (q) => `https://www.airbnb.com/s/${enc(q)}/homes`,
  "google flights": (q) => `https://www.google.com/travel/flights?q=${enc(q)}`,
  translate: (q) => `https://translate.google.com/?sl=auto&tl=en&text=${enc(q)}&op=translate`,
};

const SITE_NAMES = [...new Set([...Object.keys(SITES), ...Object.keys(SEARCH)])].sort((a, b) => b.length - a.length);
const SITE_ALT = SITE_NAMES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/**
 * Chatter speech puts before the ask — "Alright.", "I think so,", "Trinity,", "go ahead and" — along with
 * the punctuation Deepgram's smart formatting attaches to it. Stripped at the front only, and never a word
 * a parser needs ("no dark mode", "next tab").
 */
const FILLER_LEAD =
  /^(?:(?:alright|all right|okay so|ok so|okay|ok|yeah|yes|yep|yup|sure|cool|right|well|um|uh|hmm|so|and then|and|now|then|anyway|actually|gotcha|got it|i see|i think so|sounds good|great|perfect|good|fine|nice|awesome|hey|hi|hello|trinity|please|thanks|thank you|let's see|let me see|go ahead and|go ahead|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|why don't you|how about you|how about|what about)(?:[\s,.!?;:]+|$))+/;
/** Politeness after the ask: "…, please.", "… for me", "… instead". */
const FILLER_TAIL = /(?:[\s,.!?;:]+(?:please|thanks|thank you|thank you very much|for me|for us|instead|if you can|if you could|if you would|if you don't mind|real quick|quickly))*[\s,.!?;:]*$/;

/** "Alright. Open amazon dot com, please." → "open amazon.com"; "the youtube website" → "youtube". */
function normalize(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(FILLER_LEAD, "")
    .replace(FILLER_TAIL, "")
    .replace(/\b(?:dot|period)\s+(?=com|org|net|io|co|edu|gov|uk|de|fr|ai|app|dev|tv|me|us|ca|info|xyz)\b/g, ".")
    .replace(/\bslash\b/g, "/")
    .replace(/\bw w w\b/g, "www")
    .replace(/\blocalhost\s+(?:port\s+)?(\d{2,5})\b/g, "localhost:$1")
    .replace(/\b(?:the|a)\s+(?=(?:[a-z ]+?)\s+(?:website|site|web page|page|homepage|home page)\b)/g, "")
    .replace(/\s+(?:website|site|web page|homepage|home page|dot com)\b/g, "")
    .replace(/\b(?:please|for me|would you|could you|can you|will you|trinity)\b/g, " ")
    .replace(/[\s?!.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface OpenTarget {
  url: string;
  /** What to say: "YouTube", "Amazon for running shoes", "a new tab". */
  label: string;
  kind: "site" | "search" | "url" | "newtab";
}

const TITLE = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bYoutube\b/g, "YouTube").replace(/\bGithub\b/g, "GitHub").replace(/\bEbay\b/g, "eBay").replace(/\bImdb\b/g, "IMDb").replace(/\bTiktok\b/g, "TikTok").replace(/\bChatgpt\b/g, "ChatGPT").replace(/\bLinkedin\b/g, "LinkedIn").replace(/\bPaypal\b/g, "PayPal").replace(/\bEspn\b/g, "ESPN").replace(/\bBbc\b/g, "BBC").replace(/\bCnn\b/g, "CNN");
const DOMAIN = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?::\d{2,5})?(?:\/\S*)?$/i;
const LOCAL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?::\d{2,5})?(?:\/\S*)?$/i;
/** Endings a spoken address can have — any two-letter country code, or one of these. "openebay" is not one. */
const TLDS = new Set(
  "com org net edu gov mil int info biz xyz app dev pro name mobi travel online site store shop blog news cloud live tech wiki design page link club social games game music video photo pics health coffee email team zone world today life space art studio media digital agency network systems solutions services codes run house homes land city town bank money finance capital legal law energy green farm food fun cool academy school college museum gallery center expert coach inc ltd local test internal lan home".split(
    " ",
  ),
);
/** One token that reads as an address — "github.com/trending", "localhost:5173" — so "alright. open ebay" can't become a host. */
function looksLikeAddress(c: string): boolean {
  if (!c || /\s/.test(c)) return false;
  if (LOCAL.test(c)) return true;
  const m = DOMAIN.exec(c);
  return m !== null && (m[1]!.length === 2 || TLDS.has(m[1]!.toLowerCase()));
}
const addressUrl = (c: string) => (/^https?:\/\//i.test(c) ? c : `${LOCAL.test(c) ? "http" : "https"}://${c}`);
const OPEN_VERBS = String.raw`open|go to|goto|navigate to|take me to|pull up|bring up|visit|load|launch|head to|jump to|browse to|surf to|show me|get me|i want|i'd like|let's see|let me see`;
const OPEN_LEAD = new RegExp(String.raw`^(?:(?:hey |ok |okay |so |and |now |then |just )*)?(?:(?:${OPEN_VERBS})\s+)?(?:up\s+)?(?:(?:the|a|an|my)\s+)?`);
/** Where the ask can start inside chatter the filler list missed ("that's right, open ebay"): each verb, in order. */
const ASK_START = new RegExp(String.raw`\b(?:${OPEN_VERBS}|search|look up|look for|find|google|youtube|bing|duckduckgo|wikipedia|directions|new tab)\b`, "g");

/** Sentence punctuation → spaces, so "alright. open ebay" can't run together into a host; a dot inside an address stays. */
function loosen(t: string): string {
  return t
    .replace(/[,;:!?]+(?=\s|$)|\.(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The whole text first, then from each verb in turn. */
function* askStarts(t: string): Generator<number> {
  yield 0;
  for (const m of t.matchAll(ASK_START)) {
    const at = m.index ?? 0;
    if (at > 0) yield at;
  }
}

/** The site, search or address the words ask for — null when they don't name one. */
export function parseOpen(utterance: string): OpenTarget | null {
  const t = loosen(normalize(utterance));
  for (const at of askStarts(t)) {
    const target = openTarget(t.slice(at));
    if (target) return target;
  }
  return null;
}

function openTarget(words: string): OpenTarget | null {
  let t = words;
  const inNew = /\bin a new tab\b|\bnew tab\b/.test(t);
  t = t.replace(/\s*\b(?:in|on)\s+(?:a\s+)?(?:new|this|the current|the same)\s+(?:tab|window)\b/g, "").trim();
  if (/^(?:open|make|create|give me|start)?\s*(?:a\s+)?(?:new|blank|empty)\s+(?:tab|page|window)$/.test(t) || (!t && inNew)) return { url: "chrome://newtab", label: "a new tab", kind: "newtab" };
  // "open ebay and search for golf clubs".
  let m = new RegExp(String.raw`^(?:(?:${OPEN_VERBS})\s+)?(?:up\s+)?(?:(?:the|a|an|my)\s+)?(${SITE_ALT})\s+and\s+(?:then\s+)?(?:search|look|shop)(?:\s+(?:for|up))?\s+(.+)$`).exec(t);
  if (m) {
    const search = SEARCH[m[1]!] ?? SEARCH[m[1]!.replace(/^google /, "")];
    if (search) return { url: search(m[2]!), label: `${TITLE(m[1]!)} for ${m[2]}`, kind: "search" };
  }
  // "search for X on youtube", "look up X on amazon", "find X on ebay", "youtube cute cats", "google the weather".
  m = new RegExp(String.raw`^(?:(?:please\s+)?(?:search|look|find|browse|check|shop|show me|show)(?:\s+(?:up|for|me))*\s+)(.+?)\s+(?:on|in|at|using|with|via|through)\s+(?:the\s+)?(${SITE_ALT})$`).exec(t);
  if (!m) m = new RegExp(String.raw`^(?:(?:please\s+)?(?:search|look|browse|check)(?:\s+(?:up|on|in))?\s+)(${SITE_ALT})\s+for\s+(.+)$`).exec(t);
  if (m && m.length === 3 && SEARCH[m[2]!] === undefined && SEARCH[m[1]!] !== undefined) m = [m[0], m[2]!, m[1]!] as unknown as RegExpExecArray;
  if (!m) m = new RegExp(String.raw`^(?:(?:please\s+)?(?:open|pull up|bring up|show me|find|get)\s+)(.+?)\s+on\s+(?:the\s+)?(${SITE_ALT})$`).exec(t);
  if (m) {
    const [, q, site] = m as unknown as [string, string, string];
    const search = SEARCH[site] ?? SEARCH[site.replace(/^google /, "")];
    if (search && q) return { url: search(q), label: `${TITLE(site)} for ${q}`, kind: "search" };
  }
  m = new RegExp(String.raw`^(?:google|bing|duckduckgo|youtube|wikipedia)\s+(?:for\s+|search\s+(?:for\s+)?)?(.+)$`).exec(t);
  if (m) {
    const engine = t.split(" ")[0]!;
    return { url: SEARCH[engine]!(m[1]!), label: `${TITLE(engine)} for ${m[1]}`, kind: "search" };
  }
  m = /^(?:(?:get|show me|find|open|pull up)\s+)?(?:driving\s+|walking\s+)?directions\s+(?:to\s+)?(.+)$/.exec(t);
  if (m) return { url: SEARCH.maps!(m[1]!), label: `directions to ${m[1]}`, kind: "search" };
  m = /^(?:search(?:\s+for)?|look up|look for|find)\s+(.+?)(?:\s+(?:online|on the web|in the browser|on google))?$/.exec(t);
  if (m && /\b(?:online|on the web|in the browser|on google)\b/.test(t)) return { url: SEARCH.google!(m[1]!), label: `Google for ${m[1]}`, kind: "search" };
  // A site or an address.
  const rest = t.replace(OPEN_LEAD, "").replace(/^(?:website|site|page)\s+(?:for|of)\s+/, "").trim();
  if (!rest) return null;
  if (SITES[rest] !== undefined) return SITES[rest] ? { url: SITES[rest]!, label: TITLE(rest), kind: "site" } : null;
  if (SEARCH[rest]) return { url: SEARCH[rest]!("").replace(/[?&][^=]+=$/, "").replace(/\/search\/$/, "/"), label: TITLE(rest), kind: "site" };
  // Spaces only around the dots and slashes of a spoken address ("github dot com slash trending").
  const compact = rest.replace(/\s*([./:])\s*/g, "$1");
  if (looksLikeAddress(compact)) return { url: addressUrl(compact), label: compact.replace(/^https?:\/\//i, "").replace(/\/$/, ""), kind: "url" };
  return null;
}

/** When the words name no site: a Google search for them ("open the article about the eclipse"). */
export function openFallback(utterance: string): OpenTarget | null {
  const t = loosen(normalize(utterance));
  const from = Math.max(0, t.search(ASK_START));
  const rest = t
    .slice(from)
    .replace(OPEN_LEAD, "")
    .replace(/^(?:search|look up|look for|find|google)\s+(?:for\s+|up\s+)?/, "")
    .replace(/^(?:website|site|page|article|story|video|thing)\s+(?:for|of|about|on)\s+/, "")
    .replace(/^(?:the\s+)?(?:article|story|video|page|post)\s+(?:about|on)\s+/, "")
    .replace(/\s+(?:online|on the web|in the browser|on google)$/, "")
    .trim();
  if (rest.length < 2 || /^(?:it|that|this|something|anything|up|there|here|this one|that one)$/.test(rest)) return null;
  return { url: SEARCH.google!(rest), label: `Google for ${rest}`, kind: "search" };
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

export type TabsAction = "close" | "close_others" | "next" | "previous" | "switch" | "back" | "forward" | "reload" | "zoom_in" | "zoom_out" | "zoom_reset" | "list" | "new";

export interface TabsAsk {
  action: TabsAction;
  /** Words naming a tab, for close / switch. */
  target?: string;
}

const TAB_TARGET = /\b(?:close|switch to|go to|bring up|show|open|select|jump to|focus)\s+(?:the\s+|my\s+)?(.+?)\s+tab\b/;

export function parseTabs(utterance: string): TabsAsk | null {
  const t = normalize(utterance);
  if (/\b(?:close|shut)\s+(?:all\s+)?(?:the\s+)?other\s+tabs?\b|\bclose\s+(?:all\s+)?(?:the\s+)?tabs?\s+(?:except|but|other than)\b|\bclose\s+everything\s+else\b/.test(t)) return { action: "close_others" };
  if (/\b(?:close|shut|kill|dismiss|get rid of)\s+(?:this|the current|that|the)\s+tab\b|\bclose\s+tab\b|\bclose\s+(?:this|it)$/.test(t)) return { action: "close" };
  let m = /\b(?:close|shut|kill|get rid of)\s+(?:the\s+|my\s+)?(.+?)\s+tab\b/.exec(t);
  if (m && !/^(?:this|current|that|the)$/.test(m[1]!)) return { action: "close", target: m[1]! };
  if (/\b(?:next|following)\s+tab\b|\bswitch\s+tabs?\b|\bother\s+tab\b|\btab\s+(?:over|forward)\b/.test(t)) return { action: "next" };
  if (/\b(?:previous|prior|last)\s+tab\b|\btab\s+back\b|\bback\s+a\s+tab\b/.test(t)) return { action: "previous" };
  m = TAB_TARGET.exec(t);
  if (m && !/^(?:this|current|that|the|next|previous|new|a new|another)$/.test(m[1]!)) return { action: "switch", target: m[1]! };
  m = /\b(?:switch|go|jump|flip)\s+(?:over\s+)?to\s+(?:the\s+|my\s+)?(.+?)$/.exec(t);
  if (m && !/\b(?:tab|page|site|website)\b/.test(m[1]!) && !SITES[m[1]!] && !SEARCH[m[1]!] && /\btab/.test(utterance.toLowerCase()) === false && /^(?:switch|flip)/.test(t)) return { action: "switch", target: m[1]! };
  if (/^(?:go\s+)?back(?:\s+a\s+page)?$|\bgo\s+back\b|\bprevious\s+page\b|\bback\s+a\s+page\b/.test(t)) return { action: "back" };
  if (/^(?:go\s+)?forward(?:\s+a\s+page)?$|\bgo\s+forward\b|\bforward\s+a\s+page\b/.test(t)) return { action: "forward" };
  if (/\b(?:reload|refresh)\b/.test(t)) return { action: "reload" };
  if (/\bzoom\s+(?:in|up)\b|\bzoom\s+closer\b|\bmake\s+(?:it|everything|the page)\s+bigger\b/.test(t)) return { action: "zoom_in" };
  if (/\bzoom\s+(?:out|down|away)\b|\bmake\s+(?:it|everything|the page)\s+smaller\b/.test(t)) return { action: "zoom_out" };
  if (/\b(?:reset|normal|default)\s+(?:the\s+)?zoom\b|\bzoom\s+(?:to\s+)?(?:100|normal|default|reset)\b/.test(t)) return { action: "zoom_reset" };
  if (/\b(?:what|which)\s+tabs?\b|\blist\s+(?:the\s+|my\s+)?tabs\b|\btabs?\s+(?:are|do i have)\s+open\b|\bhow many tabs\b/.test(t)) return { action: "list" };
  if (/^(?:open\s+)?(?:a\s+)?(?:new|blank|empty)\s+tab$/.test(t)) return { action: "new" };
  return null;
}

/** The open tab the words mean ("the youtube tab", "amazon", "the one about muffins"). */
export function matchTab<T extends { title: string; url: string }>(tabs: T[], words: string): T | null {
  const w = words.toLowerCase().replace(/\b(?:the|my|that|one|about|with|on)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!w) return null;
  const tokens = w.split(" ").filter((x) => x.length > 1);
  let best: { tab: T; score: number } | null = null;
  for (const tab of tabs) {
    const hay = `${tab.title} ${tab.url}`.toLowerCase();
    const host = (() => {
      try {
        return new URL(tab.url).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();
    let score = 0;
    if (host && (host.startsWith(w.replace(/\s+/g, "")) || host.split(".")[0] === w.replace(/\s+/g, ""))) score += 5;
    if (hay.includes(w)) score += 4;
    score += tokens.filter((tok) => hay.includes(tok)).length;
    if (score > (best?.score ?? 0)) best = { tab, score };
  }
  return best && best.score >= 2 ? best.tab : null;
}

// ─── Acting on the page ───────────────────────────────────────────────────────

export interface Interactive {
  ref: number;
  tag: string;
  name: string;
  role?: string;
  type?: string;
  href?: string;
  value?: string;
  disabled?: boolean;
}

export interface ActAsk {
  action: "click" | "type" | "select" | "scroll" | "press";
  /** Words naming the element (a button, a link, a field). */
  target?: string;
  /** What to type or pick. */
  text?: string;
  direction?: "up" | "down" | "top" | "bottom";
  key?: string;
  /** Press Enter after typing (a search box). */
  submit?: boolean;
}

const KEYS: Record<string, string> = { enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", space: " ", backspace: "Backspace", delete: "Delete", "page down": "PageDown", "page up": "PageUp", home: "Home", end: "End", "arrow down": "ArrowDown", "arrow up": "ArrowUp", "arrow left": "ArrowLeft", "arrow right": "ArrowRight", down: "ArrowDown", up: "ArrowUp", left: "ArrowLeft", right: "ArrowRight" };
const unquote = (s: string) => s.replace(/^["'“‘]+|["'”’]+$/g, "").trim();

export function parseAct(utterance: string): ActAsk | null {
  const t = normalize(utterance);
  let m = /\bscroll\s+(?:(?:all the way\s+|back\s+)?(?:to\s+)?(?:the\s+)?(top|bottom|end|start)|(down|up))\b|\b(?:page|go)\s+(down|up)\b|\b(top|bottom)\s+of\s+the\s+page\b/.exec(t);
  if (m) {
    const word = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "down").toLowerCase();
    const direction = word === "end" ? "bottom" : word === "start" ? "top" : (word as ActAsk["direction"]);
    return { action: "scroll", direction };
  }
  m = /\b(?:press|hit|push)\s+(?:the\s+)?(enter|return|escape|esc|tab|space|backspace|delete|page down|page up|home|end|arrow down|arrow up|arrow left|arrow right)(?:\s+key)?\b/.exec(t);
  if (m) return { action: "press", key: KEYS[m[1]!] ?? m[1]! };
  m = /\b(?:type|enter|write|put|fill in|input|paste)\s+(.+?)\s+(?:in|into|in to|on)\s+(?:the\s+)?(.+?)(?:\s+(?:box|field|input|bar|form|area))?(?:\s+and\s+(?:press\s+enter|search|submit|go))?$/.exec(t);
  if (m) return { action: "type", text: unquote(m[1]!), target: m[2]!, submit: /\band\s+(?:press\s+enter|search|submit|go)$/.test(t) || /\bsearch\b/.test(m[2]!) };
  m = /\b(?:search|look)\s+(?:for\s+|up\s+)?(.+?)\s+(?:on|in)\s+(?:this|the)\s+(?:page|site|website)$|\bsearch\s+(?:this|the)\s+(?:page|site|website)\s+for\s+(.+)$/.exec(t);
  if (m) return { action: "type", text: unquote(m[1] ?? m[2]!), target: "search", submit: true };
  m = /\b(?:type|enter|write|input)\s+(.+)$/.exec(t);
  if (m) return { action: "type", text: unquote(m[1]!), submit: /\band\s+(?:press\s+enter|search|submit|go)$/.test(t) };
  m = /\b(?:select|choose|pick|set)\s+(.+?)\s+(?:in|from|for|as|on)\s+(?:the\s+)?(.+?)(?:\s+(?:dropdown|menu|list|select|box|field))?$/.exec(t);
  if (m) return { action: "select", text: unquote(m[1]!), target: m[2]! };
  m = /\b(?:click|tap|press|hit|push|choose|select|open|follow|activate)\s+(?:on\s+)?(?:the\s+|that\s+|this\s+)?(.+?)(?:\s+(?:button|link|tab|menu|option|icon|checkbox|toggle|item))?$/.exec(t);
  if (m && m[1] && !/^(?:it|that|this|there|here)$/.test(m[1])) return { action: "click", target: unquote(m[1]) };
  return null;
}

const STOP = new Set(["the", "a", "an", "on", "to", "for", "of", "in", "and", "button", "link", "box", "field", "input", "icon", "menu", "option", "tab", "that", "this", "it", "please"]);

/** The listed element the words mean: exact name first, then starts-with, then contains, then shared words. */
export function pickElement(items: Interactive[], words: string, prefer: "any" | "input" | "select" = "any"): Interactive | null {
  const w = words.toLowerCase().replace(/\s+/g, " ").trim();
  if (!w) return null;
  const tokens = w.split(" ").filter((x) => x && !STOP.has(x));
  const isInput = (i: Interactive) => i.tag === "input" || i.tag === "textarea" || i.role === "textbox" || i.tag === "contenteditable";
  const isSelect = (i: Interactive) => i.tag === "select" || i.role === "combobox" || i.role === "listbox";
  let best: { item: Interactive; score: number } | null = null;
  for (const item of items) {
    if (item.disabled) continue;
    if (prefer === "input" && !isInput(item) && !isSelect(item)) continue;
    if (prefer === "select" && !isSelect(item)) continue;
    const name = item.name.toLowerCase();
    const extra = `${item.type ?? ""} ${item.role ?? ""} ${item.href ?? ""}`.toLowerCase();
    let score = 0;
    if (name === w) score = 100;
    else if (name.startsWith(w)) score = 80;
    else if (name.includes(w)) score = 60;
    else if (w.includes(name) && name.length >= 4) score = 50;
    else {
      const hit = tokens.filter((tok) => name.includes(tok) || extra.includes(tok)).length;
      if (hit) score = 20 + hit * 8 - Math.max(0, name.split(" ").length - tokens.length);
    }
    if (prefer === "input" && isInput(item) && (item.type === "search" || /search/.test(name) || /search/.test(extra))) score += /search/.test(w) ? 30 : 0;
    if (score && (item.tag === "button" || item.role === "button" || item.tag === "a")) score += 2;
    if (score > (best?.score ?? 0)) best = { item, score };
  }
  return best && best.score >= 20 ? best.item : null;
}

/** A search box, when the page has one. */
export function searchBox(items: Interactive[]): Interactive | null {
  return (
    items.find((i) => (i.tag === "input" && i.type === "search") || ((i.tag === "input" || i.tag === "textarea") && /search/i.test(`${i.name} ${i.role ?? ""}`))) ??
    items.find((i) => i.tag === "input" && (i.type === "text" || !i.type) && /\b(?:search|find|query|q)\b/i.test(i.name)) ??
    null
  );
}

/**
 * Buttons that spend money, send things or destroy things: clicked only when the user's own words
 * name the action ("yes, place the order" — not "click the big yellow button").
 */
const DANGEROUS =
  /\b(?:buy|purchase|order|place (?:your|my|the)?\s*order|pay|checkout|check out|confirm|submit|send|post|publish|delete|remove|unsubscribe|sign out|log out|logout|transfer|book|reserve|apply|accept|agree|subscribe|donate|bid|proceed|continue to payment|complete)\b/i;

export function clickNeedsSayingSo(elementName: string): boolean {
  return DANGEROUS.test(elementName);
}

/** The user said the dangerous word (or its stem) themselves. */
export function clickSaidSo(elementName: string, utterance: string): boolean {
  const u = utterance.toLowerCase();
  const words = elementName.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((w) => w.length >= 3 && DANGEROUS.test(w) && u.includes(w.replace(/(?:ing|ed|s)$/, "")));
}

// ─── Changing the page ────────────────────────────────────────────────────────

export interface ModifyAsk {
  kind: "undo" | "dark" | "light" | "hide" | "reader" | "font" | "coder";
  css?: string;
  /** Words for what to hide / what to change, for the note and the coder. */
  what?: string;
  /** Font size as a percentage for "font". */
  percent?: number;
}

const DARK_CSS = `html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}img,video,picture,canvas,iframe,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`;
const HIDE_SELECTORS: Record<string, string> = {
  ads: '[id*="ad-"],[id^="ad"],[class*="ad-"],[class*="-ad"],[class*="advert"],[id*="advert"],ins.adsbygoogle,iframe[src*="ads"],iframe[src*="doubleclick"],[class*="sponsored"],[id*="sponsor"],[data-ad],[aria-label*="advert" i]',
  sidebar: 'aside,[class*="sidebar"],[id*="sidebar"],[class*="side-bar"],[class*="rail"],[role="complementary"]',
  comments: '#comments,[id*="comment"],[class*="comment"],[class*="disqus"],[id*="disqus"]',
  popups: '[class*="cookie"],[id*="cookie"],[class*="consent"],[id*="consent"],[class*="popup"],[class*="pop-up"],[class*="modal"],[id*="modal"],[class*="overlay"],[id*="overlay"],[role="dialog"],[aria-modal="true"],[class*="newsletter"],[class*="paywall"],[id*="paywall"],[class*="gdpr"]',
  header: 'header,[role="banner"],[class*="header"]:not(article *),[id*="header"],[class*="navbar"],[class*="topbar"]',
  footer: 'footer,[role="contentinfo"],[class*="footer"],[id*="footer"]',
  navigation: 'nav,[role="navigation"],[class*="navbar"],[class*="menu-bar"]',
  images: "img,picture,svg:not(:root),figure",
  videos: 'video,iframe[src*="youtube"],iframe[src*="vimeo"],[class*="video"]',
  chat: '[class*="chat"],[id*="chat"],[class*="intercom"],[id*="intercom"],[class*="drift"],[class*="livechat"],[id*="hubspot"]',
  banners: '[class*="banner"],[id*="banner"],[class*="promo"],[class*="announcement"],[class*="notice"]',
};
const HIDE_WORDS: Record<string, RegExp> = {
  ads: /\b(?:ads?|adverts?|advertisements?|advertising|sponsored\b.*)\b/,
  sidebar: /\b(?:side ?bars?|side panels?|right rail|right column|left column)\b/,
  comments: /\bcomments?(?: section)?\b/,
  popups: /\b(?:pop-?ups?|cookie (?:banner|notice|popup|thing|warning|consent)|cookies? (?:banner|notice)|consent (?:banner|dialog)|modal|overlay|paywall|newsletter (?:popup|prompt|box)|sign-?up (?:popup|box|prompt)|subscribe (?:popup|box)|the dialog)\b/,
  header: /\b(?:header|top bar|top menu|navigation bar|nav bar|menu bar)\b/,
  footer: /\bfooter\b/,
  navigation: /\b(?:navigation|the nav|menus?)\b/,
  images: /\b(?:images?|pictures?|photos?)\b/,
  videos: /\b(?:videos?|autoplay)\b/,
  chat: /\b(?:chat (?:widget|bubble|box|window|thing)|live chat|chat bot|chatbot)\b/,
  banners: /\b(?:banners?|promo(?:tion)?s?|announcements?|notices?)\b/,
};

export function parseModify(utterance: string): ModifyAsk {
  const t = normalize(utterance);
  if (/\b(?:undo|revert|put (?:it|that|everything|the page) back|restore|go back to normal|back to normal|reset (?:the\s+)?(?:page|changes|styles?))\b|\bnormal (?:mode|again)\b/.test(t)) return { kind: "undo" };
  if (/\b(?:light mode|day mode|turn off dark mode|no dark mode|un-?invert|lighter theme)\b/.test(t)) return { kind: "light" };
  if (/\b(?:dark(?:er)? mode|night mode|dark theme|make (?:it|this|the page|everything) dark(?:er)?|invert(?: the)? colou?rs|go dark)\b/.test(t)) return { kind: "dark", css: DARK_CSS };
  if (/\b(?:reader (?:mode|view)|reading (?:mode|view)|declutter|simplify (?:the\s+)?(?:page|this)|just the (?:article|text)|clean (?:up )?(?:the\s+)?page|focus mode)\b/.test(t))
    return {
      kind: "reader",
      css: `${HIDE_SELECTORS.ads},${HIDE_SELECTORS.sidebar},${HIDE_SELECTORS.popups},${HIDE_SELECTORS.chat},${HIDE_SELECTORS.banners},nav,aside,footer{display:none!important}main,article,[role="main"]{max-width:760px!important;margin:0 auto!important;padding:24px!important;font-size:19px!important;line-height:1.65!important}body{background:#fbf8f3!important;color:#222!important}p{max-width:70ch!important}`,
    };
  const font = /\b(?:make (?:the\s+)?(?:text|font|words|letters|type)\s+(?:bigger|larger|huge|smaller|tiny)|(?:bigger|larger|smaller)\s+(?:text|font|fonts|letters)|(?:increase|decrease|enlarge|reduce)\s+(?:the\s+)?(?:text|font)(?: size)?|text size)\b/.exec(t);
  if (font) {
    const bigger = /\b(?:bigger|larger|huge|increase|enlarge)\b/.test(t);
    const percent = /\bhuge\b/.test(t) ? 160 : /\btiny\b/.test(t) ? 75 : bigger ? 125 : 85;
    return { kind: "font", percent, css: `html{font-size:${percent}%!important}` };
  }
  if (/\b(?:hide|remove|get rid of|block|kill|close|dismiss|take away|take out|strip|clear away|no more|without|turn off|disable|zap|nuke|delete)\b/.test(t)) {
    const parts: string[] = [];
    const names: string[] = [];
    for (const [key, re] of Object.entries(HIDE_WORDS))
      if (re.test(t)) {
        parts.push(HIDE_SELECTORS[key]!);
        names.push(key);
      }
    if (parts.length) return { kind: "hide", css: `${parts.join(",")}{display:none!important;visibility:hidden!important}${names.includes("popups") ? "html,body{overflow:auto!important;position:static!important}" : ""}`, what: names.join(", ") };
  }
  return { kind: "coder", what: utterance.trim() };
}

// ─── Saving and sharing ───────────────────────────────────────────────────────

export type SaveWhat = "page" | "text" | "screenshot" | "image" | "link";

export function parseSave(utterance: string): SaveWhat {
  const t = normalize(utterance);
  if (/\b(?:screenshot|screen shot|screen grab|capture (?:the\s+)?(?:screen|page))\b/.test(t)) return "screenshot";
  if (/\b(?:image|picture|photo|graphic|logo)s?\b/.test(t)) return "image";
  if (/\b(?:as (?:a )?(?:text|markdown|md|txt|notes?)(?: file)?|the (?:text|article|words|content)(?: of (?:this|the) page)?|(?:text|article) (?:of|from) (?:this|the) page)\b/.test(t)) return "text";
  if (/\b(?:link|file|download|pdf|attachment|that|it)\b/.test(t) && !/\b(?:this|the) page\b/.test(t)) return "link";
  return "page";
}

export type ShareWhat = "page" | "selection" | "screenshot" | "image";

export function parseShare(utterance: string): ShareWhat {
  const t = normalize(utterance);
  if (/\b(?:screenshot|screen shot|screen grab|snapshot|capture)\b/.test(t)) return "screenshot";
  if (/\b(?:image|picture|photo|graphic)s?\b/.test(t)) return "image";
  if (/\b(?:selected|selection|highlighted|what i (?:selected|highlighted)|this (?:text|paragraph|quote|bit))\b/.test(t)) return "selection";
  return "page";
}

/** A file name Chrome will accept, from a page title. */
export function safeFilename(name: string, ext: string, fallback = "page"): string {
  const base =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/g, "") || fallback;
  return `${base}.${ext}`;
}
