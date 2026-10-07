// Squarespace gallery sites (SPEC.md §5.1/§5.2). `?format=json` on any
// Squarespace URL returns the page wrapped in JSON — but that only helps
// when the page is a structured Collection (blog/gallery, with a real
// `items[]` array). Every venue checked by hand here is a plain Squarespace
// "Page" (`collection.type === 10`), which comes back as one opaque
// `mainContent` HTML blob with no per-item structure at all — same
// difficulty as the generic HTML case, just wrapped in JSON instead of
// wrapped in a rendered document.
//
// Squarespace is also not one platform in practice: newer "Fluid Engine"
// pages (theta.nyc, confirmed via a `layout-engine-section` class on the
// full render) don't serialize into `mainContent` at all — it comes back
// empty — so this adapter can only ever cover classic block-based pages.
// Verified real, current, parseable text on two of five squarespace-
// fingerprinted venues (fierman.nyc, situations.us); the other two checked
// (theta.nyc: empty Fluid Engine page; signs-and-symbols.art: real text but
// over a year stale) yielded nothing usable, so they stay `manual` rather
// than being fed a scraper that would either return nothing or resurface
// old shows as current. Config-driven per venue like sanity.ts/wordpress.ts
// — no `config.squarespace` means no attempt, not a guess.
//
// Both real venues put exactly one show at the top of their page, in one
// of two text shapes with no separator between the title and the date:
//   "MASAMITSU SHIGETA September 10 - October 17, 2026"        (range)
//   "TEN YEARS OF FIERMAN OPENING SEPTEMBER 16, 2026"           (single)
// This adapter takes the first such match on the page as *the* current or
// next show — same one-show-per-page model as wordpress.ts's current-page
// mode — rather than trying to enumerate every entry on the page, which
// risks pulling in unrelated content (situations.us's page, for example,
// also lists a fair-booth appearance below the gallery show).

//
// Collection mode (added 2026-10-07): some venues run their exhibitions as
// a real Squarespace blog collection (`collection.type === 1`), where
// `?format=json` DOES carry one `items[]` entry per show — verified on
// airgallery.org/exhibitions (items tagged with categories "current" /
// "upcoming" / "past", title text inside the excerpt's <em>) and
// underdonk.com/exhibitions (real item titles, date range leading the
// excerpt). Dates still come from text, but per item rather than per page,
// via the shared html.ts parser, and closed shows are dropped.

import type { Venue, RawExhibition, Adapter } from "../types/index.ts";
import { CRAWLER_USER_AGENT } from "../pipeline/robots.ts";
import { parseDateRange } from "./html.ts";

interface SquarespacePageConfig {
  mode?: "page";
  path: string; // e.g. "/upcoming" — the page whose top entry is the current/next show
}
interface SquarespaceCollectionConfig {
  mode: "collection";
  path: string; // a blog collection, e.g. "/exhibitions"
  // Only items carrying one of these categories (A.I.R.: ["current", "upcoming"]).
  // Unset: every item, filtered by its parsed dates alone.
  categories?: string[];
}
type SquarespaceConfig = SquarespacePageConfig | SquarespaceCollectionConfig;

function getSquarespaceConfig(venue: Venue): SquarespaceConfig | null {
  const cfg = (venue.config as { squarespace?: SquarespaceConfig } | undefined)?.squarespace;
  return cfg ?? null;
}

// Case-insensitive: fierman.nyc's date text is all-caps ("OPENING SEPTEMBER
// 16, 2026"), situations.us's is mixed case ("September 10 - October 17").
const ENTRY_RE =
  /(OPENING\s+)?(?<startMonth>[A-Za-z]+\.?)\s+(?<startDay>\d{1,2})(?:\s*[-–—]\s*(?:(?<endMonth>[A-Za-z]+\.?)\s+)?(?<endDay>\d{1,2}))?,?\s*(?<year>\d{4})/i;

// Leading section-header words that precede the real title on some pages
// ("FUTURE Masamitsu Shigeta" on situations.us) — stripped, not treated as
// part of the show's title.
const SECTION_HEADER_RE = /^(FUTURE|CURRENT|UPCOMING|PAST|NOW SHOWING)\s+/i;

function safeDate(input: string): string | null {
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedEntry {
  title: string;
  opens: string | null;
  closes: string | null;
  confidence: number;
}

function parseFirstEntry(text: string): ParsedEntry | null {
  const m = text.match(ENTRY_RE);
  if (!m || !m.groups) return null;

  const title = text.slice(0, m.index).trim().replace(SECTION_HEADER_RE, "");
  if (!title || title.length > 150) return null; // empty, or we grabbed unrelated preceding text

  const { startMonth, startDay, endMonth, endDay, year } = m.groups;
  const opens = safeDate(`${startMonth} ${startDay}, ${year}`);
  const isRange = Boolean(endDay);
  const closes = isRange ? safeDate(`${endMonth ?? startMonth} ${endDay}, ${year}`) : null;

  if (!opens) return null;
  return { title, opens, closes, confidence: isRange ? 0.5 : 0.4 };
}

interface CollectionItem {
  title?: string;
  fullUrl?: string;
  excerpt?: string;
  body?: string;
  categories?: string[];
  assetUrl?: string;
}

async function fetchCollection(venue: Venue, config: SquarespaceCollectionConfig): Promise<RawExhibition[]> {
  const pageUrl = new URL(config.path, venue.url).toString();
  let items: CollectionItem[];
  try {
    const res = await fetch(`${pageUrl}?format=json`, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
    if (!res.ok) return [];
    items = ((await res.json()) as { items?: CollectionItem[] }).items ?? [];
  } catch {
    return [];
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const out: RawExhibition[] = [];
  for (const item of items) {
    const cats = (item.categories ?? []).map((c) => c.toLowerCase());
    if (config.categories && !config.categories.some((c) => cats.includes(c.toLowerCase()))) continue;

    // Squarespace's own title field is empty on airgallery.org — the real
    // title is the excerpt's italicized lead.
    const title = (item.title?.trim() || stripHtml(item.excerpt?.match(/<em>([\s\S]*?)<\/em>/)?.[1] ?? "")).trim();
    if (!title) continue;

    const dates = parseDateRange(`${stripHtml(item.excerpt ?? "")} ${stripHtml(item.body ?? "")}`, "mdy", now);
    if (!dates) continue;
    if (dates.closes ? dates.closes < today : !config.categories) continue;

    out.push({
      title,
      artists: [],
      opens: dates.opens,
      closes: dates.closes,
      space_label: null,
      excerpt: "",
      press_release_url: null,
      image_urls: item.assetUrl ? [item.assetUrl] : [],
      image_credit: null,
      works: [],
      source_url: item.fullUrl ? new URL(item.fullUrl, venue.url).toString() : pageUrl,
      confidence: dates.closes ? 0.7 : 0.55,
      fetched_at: now.toISOString(),
    });
  }
  return out;
}

async function fetchSquarespace(venue: Venue): Promise<RawExhibition[]> {
  const config = getSquarespaceConfig(venue);
  if (!config) return [];
  if (config.mode === "collection") return fetchCollection(venue, config);

  const pageUrl = new URL(config.path, venue.url).toString();
  let html: string;
  try {
    const res = await fetch(`${pageUrl}?format=json`, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
    if (!res.ok) return [];
    const data = (await res.json()) as { mainContent?: unknown };
    if (typeof data.mainContent !== "string" || data.mainContent.length === 0) return []; // Fluid Engine page — nothing to parse
    html = data.mainContent;
  } catch {
    return [];
  }

  const text = stripHtml(html);
  const entry = parseFirstEntry(text);
  if (!entry) return [];

  return [
    {
      title: entry.title,
      artists: [], // not reliably separable from the title text — see file header
      opens: entry.opens,
      closes: entry.closes,
      space_label: null,
      excerpt: "",
      press_release_url: null,
      image_urls: [],
      image_credit: null,
      works: [],
      source_url: pageUrl,
      confidence: entry.confidence,
      fetched_at: new Date().toISOString(),
    },
  ];
}

const squarespaceAdapter: Adapter = { id: "squarespace", fetch: fetchSquarespace };
export default squarespaceAdapter;
