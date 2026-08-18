// Gallery-curated press listings (SPEC.md §5.4). Many galleries maintain a
// page listing coverage with outlet/headline/date already attached to the
// gallery — that's both real press data for the "press" layer AND a
// ground-truth set for validating the resolution cascade in §8 (see
// pipeline/resolve.ts's validateAgainstGroundTruth).
//
// Real gallery sites are wildly inconsistent about this even within one
// platform (verified by hand against kaufmann repetto's WordPress "press"
// category and P·P·O·W's Artlogic-template news grid — two different CMSs,
// two different shapes, and *other* venues on the very same platforms had
// no equivalent category at all). Rather than guess at an unverified
// venue's markup, this adapter is config-driven per venue
// (`venue.config.gallerypress`) and only ever produces data for venues
// where that config has been hand-verified against the live site — same
// philosophy as manual.ts: no data beats guessed data.
//
// "Link out to the outlet, never to the gallery's PDF scan" (SPEC.md §5.4)
// is enforced structurally: an item with no qualifying external,
// non-PDF link is dropped rather than falling back to the gallery's own
// page for it.

import { createHash } from "crypto";
import * as cheerio from "cheerio";
import type { Article, Venue } from "../types/index.ts";
import { robotsAllows, CRAWLER_USER_AGENT } from "../pipeline/robots.ts";

export type GalleryPressConfig =
  | { type: "wordpress-category"; categoryId: number; perPage?: number }
  | { type: "artlogic-news-grid"; path: string; maxEntries?: number };

export interface RawPressItem {
  outlet: string;
  headline: string;
  byline: string | null;
  published: string; // ISO
  url: string; // the outlet's article, never the gallery's own page/PDF
}

const DEFAULT_WORDPRESS_PER_PAGE = 15;
const DEFAULT_ARTLOGIC_MAX_ENTRIES = 25;

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isQualifyingOutboundLink(href: string, base: string, ownHostname: string | null): boolean {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (ownHostname && u.hostname.replace(/^www\./, "").toLowerCase() === ownHostname) return false; // gallery's own page
  if (/\.pdf($|\?)/i.test(u.pathname)) return false; // "never the gallery's PDF scan"
  return true;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// No structured "outlet" field on a WordPress post — best-effort guess from
// the linked domain (artforum.com -> "Artforum"). Never fabricated beyond
// what the URL itself says.
function outletFromHostname(url: string): string {
  const host = hostnameOf(url);
  if (!host) return "";
  const base = host.split(".").slice(0, -1).join(".") || host;
  return base
    .split(/[-.]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

async function fetchWordpressCategory(
  venue: Venue,
  config: Extract<GalleryPressConfig, { type: "wordpress-category" }>
): Promise<RawPressItem[]> {
  const perPage = config.perPage ?? DEFAULT_WORDPRESS_PER_PAGE;
  const apiUrl = `${venue.url.replace(/\/$/, "")}/wp-json/wp/v2/posts?categories=${config.categoryId}&per_page=${perPage}&orderby=date&order=desc`;
  const res = await fetch(apiUrl, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
  if (!res.ok) throw new Error(`wp-json press fetch failed: HTTP ${res.status}`);
  const posts = (await res.json()) as Array<{
    title: { rendered: string };
    content: { rendered: string };
    date_gmt: string;
    link: string;
  }>;

  const ownHostname = hostnameOf(venue.url);
  const items: RawPressItem[] = [];
  for (const post of posts) {
    const $ = cheerio.load(post.content.rendered);
    const href = $("a[href]")
      .toArray()
      .map((el) => $(el).attr("href") ?? "")
      .find((h) => h && isQualifyingOutboundLink(h, post.link, ownHostname));
    if (!href) continue; // no external, non-PDF link — not usable press coverage

    items.push({
      outlet: outletFromHostname(href),
      headline: stripTags(post.title.rendered),
      byline: null,
      published: post.date_gmt.endsWith("Z") ? post.date_gmt : `${post.date_gmt}Z`,
      url: href,
    });
  }
  return items;
}

async function fetchArtlogicNewsGrid(
  venue: Venue,
  config: Extract<GalleryPressConfig, { type: "artlogic-news-grid" }>
): Promise<RawPressItem[]> {
  const maxEntries = config.maxEntries ?? DEFAULT_ARTLOGIC_MAX_ENTRIES;
  const pageUrl = `${venue.url.replace(/\/$/, "")}${config.path}`;
  const res = await fetch(pageUrl, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
  if (!res.ok) throw new Error(`news grid fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const ownHostname = hostnameOf(venue.url);

  const items: RawPressItem[] = [];
  $(".entry").each((_, el) => {
    if (items.length >= maxEntries) return false;
    const $el = $(el);
    const headline = $el.find(".titles .title").first().text().trim();
    const outlet = $el.find(".titles .subtitle").first().text().trim();
    const dateText = $el.find(".titles .date").first().text().trim();
    if (!headline || !dateText) return;

    const href = $el
      .find("a[href]")
      .toArray()
      .map((a) => $(a).attr("href") ?? "")
      .find((h) => h && isQualifyingOutboundLink(h, pageUrl, ownHostname));
    if (!href) return; // internal-only or PDF — not usable per SPEC.md §5.4

    const published = new Date(dateText);
    if (Number.isNaN(published.getTime())) return;

    items.push({
      outlet: outlet || outletFromHostname(href),
      headline,
      byline: null,
      published: published.toISOString(),
      url: new URL(href, pageUrl).toString(),
    });
  });
  return items;
}

export async function fetchGalleryPress(venue: Venue): Promise<RawPressItem[]> {
  const config = (venue.config as { gallerypress?: GalleryPressConfig }).gallerypress;
  if (!config) return [];

  const allowed = await robotsAllows(venue.url);
  if (!allowed) return [];

  if (config.type === "wordpress-category") return fetchWordpressCategory(venue, config);
  if (config.type === "artlogic-news-grid") return fetchArtlogicNewsGrid(venue, config);
  return [];
}

function pressArticleId(venueId: string, url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  return `article-gallerypress-${venueId}-${hash}`;
}

// The gallery itself vouches for the venue association (it's on their own
// site), so this skips resolve.ts's venue-guessing tiers entirely — venue
// confidence starts high. Whether the piece can be pinned to one specific
// current exhibition is still an open question the caller resolves (see
// pipeline/resolve.ts's linkWithinVenue), so exhibition_id starts null.
const VENUE_CONFIRMED_CONFIDENCE = 0.9;

export async function fetchGalleryPressArticles(venue: Venue): Promise<Article[]> {
  const items = await fetchGalleryPress(venue);
  return items.map((item) => ({
    id: pressArticleId(venue.id, item.url),
    outlet: item.outlet,
    headline: item.headline,
    byline: item.byline,
    published: item.published,
    url: item.url,
    excerpt: "",
    links: { exhibition_id: null, venue_ids: [venue.id], artist_names: [] },
    link_confidence: VENUE_CONFIRMED_CONFIDENCE,
  }));
}
