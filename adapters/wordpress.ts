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
}
type WordPressConfig = WPCustomPostTypeConfig | WPTaxonomyFilteredConfig | WPCurrentPageConfig;

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
