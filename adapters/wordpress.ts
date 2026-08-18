// WordPress REST API adapter (SPEC.md §5). Real-world finding from testing
// against the 5 WordPress-fingerprinted seed venues: the REST API's
// `content`/`excerpt` fields come back EMPTY on every page-builder-driven
// site tested (Elementor/Bricks-style builders don't populate the classic
// WP content field) — so the API is only reliable for discovering *which*
// URLs are current exhibitions (title, link, publish date), not their
// actual exhibition content. Real dates/images have to come from a
// best-effort scrape of the rendered HTML page the API points at.
//
// WordPress structure varies too much across galleries to handle
// generically (custom post types with different rest_base slugs, taxonomy
// filters, or no exposed post type at all — just a single "current show"
// page). Each venue that works with this adapter has a `config.wordpress`
// block describing HOW to query it; venues without one return an empty
// array rather than guess.

import * as cheerio from "cheerio";
import type { Venue, RawExhibition, Adapter } from "../types/index.ts";
import { CRAWLER_USER_AGENT } from "../pipeline/robots.ts";

interface WPCustomPostTypeConfig {
  mode: "custom-post-type";
  restBase: string; // e.g. "exhibitions-api" — NOT always the same as the type slug
}
interface WPTaxonomyFilteredConfig {
  mode: "taxonomy-filtered";
  restBase: string; // e.g. "program"
  taxonomyQueryParam: string; // e.g. "program-type"
  termId: number;
}
interface WPCurrentPageConfig {
  mode: "current-page";
  path: string; // e.g. "/exhibitions-current/" — a single page IS the current show
  // Some multi-location galleries render a location-tabbed slider on this
  // page instead of a single show (verified on kaufmann repetto's
  // /exhibitions-current/: `.custom-navi .nav-item[data-swipe]` tabs paired
  // with `.content[data-swipe]` panes, each holding `.author` / `.opera` /
  // a "through {date}" paragraph). When set, scope to the pane whose nav
  // label contains this text (case-insensitive); when unset, or no
  // matching pane is found, fall back to the generic <title>-tag heuristic.
  locationLabel?: string;
}
interface WPExhibitionArchiveConfig {
  mode: "exhibition-archive";
  // e.g. "/exhibitions/" — a real "exhibition" custom post type (confirmed
  // via `post-type-archive-exhibition` on the body class) rendered as an
  // archive page with an explicit `<h3>Current</h3>` section, each show a
  // `.exhibition-item` with `.exhibition-title` / `.exhibition-subtitle`
  // (comma-separated artist list) / `.exhibition-location` /
  // `.exhibition-dates`. Not exposed via /wp-json/ (show_in_rest is false
  // for this CPT on the one venue this was verified against), so this
  // scrapes the rendered archive HTML instead of querying the REST API.
  path: string;
}
interface WPNextEmbeddedConfig {
  mode: "nextjs-embedded";
  // e.g. "/exhibitions/" — a headless-WordPress site where the public
  // frontend is a separate Next.js app (verified on New Museum: /wp-json/
  // on the public domain 500s — the real WP/WPGraphQL backend lives on a
  // different subdomain entirely). The page still embeds real, fully
  // structured data — GraphQL-typed objects with ISO startDate/endDate —
  // pre-fetched into a `<script id="__NEXT_DATA__">` JSON blob for SSR.
  // No extra request needed; just walk that JSON for objects matching
  // `typeName` (New Museum: "Exhibition").
  path: string;
  typeName: string;
}
type WordPressConfig =
  | WPCustomPostTypeConfig
  | WPTaxonomyFilteredConfig
  | WPCurrentPageConfig
  | WPExhibitionArchiveConfig
  | WPNextEmbeddedConfig;

function getWordPressConfig(venue: Venue): WordPressConfig | null {
  const wp = (venue.config as { wordpress?: WordPressConfig } | undefined)?.wordpress;
  return wp ?? null;
}

const DATE_RANGE_RE =
  /([A-Z][a-z]+\.?\s*\d{1,2})\s*[-–—]\s*([A-Z]?[a-z]*\.?\s*\d{1,2}),?\s*(\d{4})/;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&bull;/g, "•")
    .replace(/&hellip;/g, "…")
    .replace(/&copy;/g, "©")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateRange(text: string, year: number): { opens: string | null; closes: string | null } {
  const m = text.match(DATE_RANGE_RE);
  if (!m) return { opens: null, closes: null };
  const [, startRaw, endRaw, yearStr] = m;
  const y = yearStr ? Number(yearStr) : year;
  const closesMonthDay = /^[A-Z]/.test(endRaw.trim())
    ? endRaw.trim()
    : `${startRaw.trim().match(/^[A-Z][a-z]+/)?.[0] ?? ""} ${endRaw.trim()}`;
  const opens = safeDate(`${startRaw.trim()}, ${y}`);
  const closes = safeDate(`${closesMonthDay}, ${y}`);
  return { opens, closes };
}

function safeDate(input: string): string | null {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isRecentOrFuture(dateStr: string | null, maxAgeDays: number): boolean {
  if (!dateStr) return true;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return true;
  return t >= Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
}

interface LocationSlide {
  title: string;
  artists: string[];
  closesText: string | null;
}

// See WPCurrentPageConfig.locationLabel — scopes a multi-location slider
// page down to the pane for one location.
function extractLocationSlide(html: string, locationLabel: string): LocationSlide | null {
  const $ = cheerio.load(html);
  const label = locationLabel.toLowerCase();
  let swipeId: string | undefined;
  $(".custom-navi .nav-item").each((_, el) => {
    const $el = $(el);
    if ($el.text().trim().toLowerCase().includes(label)) {
      swipeId = $el.attr("data-swipe");
      return false; // stop at first match
    }
  });
  if (!swipeId) return null;

  const $pane = $(`.content[data-swipe="${swipeId}"]`);
  if ($pane.length === 0) return null;

  const artist = $pane.find(".author").first().text().trim();
  const title = $pane.find(".opera").first().text().trim();
  if (!artist && !title) return null;

  const paraText = $pane.find("p").first().text().replace(/\s+/g, " ").trim();
  return { title: title || artist, artists: artist ? [artist] : [], closesText: paraText || null };
}

// "through august 8th" — no year, ordinal day suffix. Assumes the
// reference year unless that lands >60 days in the past, in which case it
// rolls to next year (handles a December page read in early January).
function parseThroughDate(text: string, referenceYear: number): string | null {
  const m = text.match(/through\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
  if (!m) return null;
  const [, month, day] = m;
  let d = new Date(`${month} ${day}, ${referenceYear}`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() < Date.now() - 60 * 24 * 60 * 60 * 1000) {
    d = new Date(`${month} ${day}, ${referenceYear + 1}`);
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Miguel Abreu Gallery's own markup has a real bug: `class"exhibition-
// subtitle italic"` is missing its `=`, so the parser can't recognize it as
// a class attribute — it merges into one mangled attribute name instead
// (verified: `{"class\"exhibition-subtitle": "", "italic\"": ""}`). Try the
// normal selector first; fall back to matching that mangled attribute name
// directly so a real site typo doesn't just silently drop the artist list.
function findByClassOrMangledAttr(
  $scope: ReturnType<cheerio.CheerioAPI>,
  className: string
): ReturnType<cheerio.CheerioAPI> {
  const normal = $scope.find(`.${className}`);
  if (normal.length > 0) return normal;
  return $scope.find("*").filter((_, el) => Object.keys(el.attribs ?? {}).some((k) => k.includes(className)));
}

// See WPExhibitionArchiveConfig — scopes to the <h3>Current</h3> section's
// .exhibition-item entries only, never Past (or Upcoming, if a theme has
// one — treated the same as Current since both are worth surfacing).
function extractExhibitionArchive(html: string, pageUrl: string): RawExhibition[] {
  const $ = cheerio.load(html);
  const fetchedAt = new Date().toISOString();
  const results: RawExhibition[] = [];

  const sectionHeaders = $("h3").filter((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    return label === "current" || label === "upcoming";
  });

  sectionHeaders.each((_, header) => {
    const $header = $(header);
    // Verified structure nests both the heading and its items inside the
    // same wrapper div, with Past living in a separate sibling wrapper —
    // scoping to the parent keeps this section's items from bleeding into
    // the next.
    const container = $header.parent();
    container.find(".exhibition-item").each((__, el) => {
      const $el = $(el);
      const title = $el.find(".exhibition-title").first().text().trim();
      if (!title) return;

      const artistsText = findByClassOrMangledAttr($el, "exhibition-subtitle").first().text().trim();
      const artists = artistsText
        ? artistsText
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        : [];
      const spaceLabel = $el.find(".exhibition-location").first().text().trim() || null;
      const datesText = $el.find(".exhibition-dates").first().text().trim();
      const { opens, closes } = parseDateRange(datesText, new Date().getFullYear());

      const href = $el.find("a[href]").first().attr("href");
      const sourceUrl = href ? new URL(href, pageUrl).toString() : pageUrl;
      const imgSrc = $el.find("img").first().attr("src");

      results.push({
        title,
        artists,
        opens,
        closes,
        space_label: spaceLabel,
        excerpt: "",
        press_release_url: null,
        image_urls: imgSrc ? [new URL(imgSrc, pageUrl).toString()] : [],
        image_credit: null,
        works: [],
        source_url: sourceUrl,
        // Real per-field structure (not free-text parsing) — same
        // confidence tier as a clean sanity/artlogic hit.
        confidence: opens || closes ? 0.85 : 0.7,
        fetched_at: fetchedAt,
      });
    });
  });

  return results;
}

// See WPNextEmbeddedConfig. Only trusted as "current" the same way
// sanity.ts treats a missing closing date — an old opens date with nothing
// recorded after it (New Museum's page embeds its full exhibition history,
// e.g. a 2022 "First Look" with no endDate) is far more likely stale than a
// genuinely still-running installation.
const NEXT_EMBEDDED_OPEN_ENDED_MAX_AGE_DAYS = 180;

function extractNextData(html: string): unknown {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function collectByTypename(node: unknown, typeName: string, seenIds: Set<string>, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectByTypename(item, typeName, seenIds, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.__typename === typeName) {
    const id = typeof rec.databaseId === "number" || typeof rec.databaseId === "string" ? String(rec.databaseId) : JSON.stringify(rec);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      out.push(rec);
    }
  }
  for (const v of Object.values(rec)) collectByTypename(v, typeName, seenIds, out);
}

function isoDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extractNextEmbedded(html: string, typeName: string): RawExhibition[] {
  const data = extractNextData(html);
  if (!data) return [];

  const found: Record<string, unknown>[] = [];
  collectByTypename(data, typeName, new Set(), found);

  const fetchedAt = new Date().toISOString();
  const today = todayISO();
  const results: RawExhibition[] = [];

  for (const rec of found) {
    const title = typeof rec.title === "string" ? stripTags(rec.title) : null;
    if (!title) continue;
    const opens = isoDateOnly(rec.startDate);
    const closes = isoDateOnly(rec.endDate);
    const isCurrent = closes ? closes >= today : isRecentOrFuture(opens, NEXT_EMBEDDED_OPEN_ENDED_MAX_AGE_DAYS);
    if (!isCurrent) continue;

    const link = typeof rec.link === "string" ? rec.link : null;
    const featuredImage = rec.featuredImage as { node?: { sourceUrl?: unknown } } | undefined;
    const imageUrl = typeof featuredImage?.node?.sourceUrl === "string" ? featuredImage.node.sourceUrl : null;

    results.push({
      title,
      artists: [], // no artist field on this GraphQL type — not fabricated
      opens,
      closes,
      space_label: null,
      excerpt: "",
      press_release_url: null,
      image_urls: imageUrl ? [imageUrl] : [],
      image_credit: null,
      works: [],
      source_url: link ?? "",
      confidence: 0.85, // real GraphQL-typed structured data, not free-text
      fetched_at: fetchedAt,
    });
  }
  return results;
}

// Generic "content area" image guess: pull <img src> values and drop
// anything that's obviously chrome (logo/icon/avatar/tracking pixel) rather
// than an installation view. Imprecise by nature — reflected in confidence.
function extractImages(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const src = match[1];
    if (/logo|icon|avatar|gravatar|sprite|pixel|favicon|placeholder/i.test(src)) continue;
    if (src.startsWith("data:")) continue;
    try {
      urls.add(new URL(src, pageUrl).toString());
    } catch {
      /* skip unparseable */
    }
    if (urls.size >= 6) break;
  }
  return Array.from(urls);
}

function extractExcerpt(text: string, dateMatchIndex: number): string {
  const after = text.slice(dateMatchIndex).replace(DATE_RANGE_RE, "").trim();
  return after.slice(0, 300);
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface WPPost {
  link: string;
  date: string;
  title: { rendered: string };
}

async function buildFromPage(sourceUrl: string, title: string, publishedYear: number): Promise<RawExhibition> {
  const html = await fetchHtml(sourceUrl);
  if (!html) {
    return {
      title,
      artists: [],
      opens: null,
      closes: null,
      space_label: null,
      excerpt: "",
      press_release_url: null,
      image_urls: [],
      image_credit: null,
      works: [],
      source_url: sourceUrl,
      confidence: 0.3,
      fetched_at: new Date().toISOString(),
    };
  }
  const text = stripTags(html);
  const dateMatch = text.match(DATE_RANGE_RE);
  const { opens, closes } = parseDateRange(text, publishedYear);
  const excerpt = dateMatch ? extractExcerpt(text, (dateMatch.index ?? 0) + dateMatch[0].length) : "";
  const image_urls = extractImages(html, sourceUrl);

  return {
    title,
    artists: [], // not reliably extractable across page-builder markup — see file header
    opens,
    closes,
    space_label: null,
    excerpt,
    press_release_url: null,
    image_urls,
    image_credit: null,
    works: [],
    source_url: sourceUrl,
    // dates found + a real page fetched: moderate confidence, honest about
    // what this adapter can and can't reliably pull generically.
    confidence: opens || closes ? 0.6 : 0.45,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchWordPress(venue: Venue): Promise<RawExhibition[]> {
  const config = getWordPressConfig(venue);
  if (!config) return []; // no verified query strategy for this venue yet

  if (config.mode === "current-page") {
    const url = new URL(config.path, venue.url).toString();
    const html = await fetchHtml(url);
    if (!html) return [];

    if (config.locationLabel) {
      const slide = extractLocationSlide(html, config.locationLabel);
      if (slide) {
        const closes = slide.closesText ? parseThroughDate(slide.closesText, new Date().getFullYear()) : null;
        return [
          {
            title: slide.title,
            artists: slide.artists,
            opens: null,
            closes,
            space_label: null,
            excerpt: slide.closesText ?? "",
            press_release_url: null,
            image_urls: extractImages(html, url),
            image_credit: null,
            works: [],
            source_url: url,
            confidence: closes ? 0.65 : 0.5,
            fetched_at: new Date().toISOString(),
          },
        ];
      }
      // No matching pane (page layout changed, or location label stopped
      // matching) — fall through to the generic <title>-tag heuristic below
      // rather than returning nothing.
    }

    const text = stripTags(html);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]).split("|")[0].trim() : null;
    if (!title) return [];
    const { opens, closes } = parseDateRange(text, new Date().getFullYear());
    const dateMatch = text.match(DATE_RANGE_RE);
    const excerpt = dateMatch ? extractExcerpt(text, (dateMatch.index ?? 0) + dateMatch[0].length) : "";
    return [
      {
        title,
        artists: [],
        opens,
        closes,
        space_label: null,
        excerpt,
        press_release_url: null,
        image_urls: extractImages(html, url),
        image_credit: null,
        works: [],
        source_url: url,
        confidence: opens || closes ? 0.6 : 0.4,
        fetched_at: new Date().toISOString(),
      },
    ];
  }

  if (config.mode === "exhibition-archive") {
    const url = new URL(config.path, venue.url).toString();
    const html = await fetchHtml(url);
    if (!html) return [];
    return extractExhibitionArchive(html, url);
  }

  if (config.mode === "nextjs-embedded") {
    const url = new URL(config.path, venue.url).toString();
    const html = await fetchHtml(url);
    if (!html) return [];
    return extractNextEmbedded(html, config.typeName);
  }

  const base = new URL(`/wp-json/wp/v2/${config.restBase}`, venue.url);
  base.searchParams.set("orderby", "date");
  base.searchParams.set("order", "desc");
  base.searchParams.set("per_page", "10");
  if (config.mode === "taxonomy-filtered") {
    base.searchParams.set(config.taxonomyQueryParam, String(config.termId));
  }

  const posts = await fetchJSON<WPPost[]>(base.toString());
  if (!posts || posts.length === 0) return [];

  const results: RawExhibition[] = [];
  for (const post of posts.slice(0, 6)) {
    const title = stripTags(post.title.rendered);
    const publishedYear = new Date(post.date).getFullYear() || new Date().getFullYear();
    results.push(await buildFromPage(post.link, title, publishedYear));
    await new Promise((r) => setTimeout(r, 300)); // one host, stay polite
  }
  return results;
}

const wordpressAdapter: Adapter = { id: "wordpress", fetch: fetchWordPress };
export default wordpressAdapter;
