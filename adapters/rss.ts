// Outlet feeds -> unlinked Article records (SPEC.md §5.4 rss, §8 Article).
// Linking to exhibitions is the resolution cascade's job (§8, Phase 3) — this
// adapter only ever produces the explicit "unlinked" bucket.

import { createHash } from "crypto";
import { XMLParser } from "fast-xml-parser";
import type { Article } from "../types/index.ts";

const CONTACT_EMAIL = "anastasios.karnazes@gmail.com";
const USER_AGENT = `ArtWorldSituationMonitor/0.1 (contact: ${CONTACT_EMAIL})`;

export interface OutletConfig {
  id: string;
  name: string;
  rss_url: string | null;
  site_url: string;
  status: "ok" | "blocked" | "no_feed";
}

function stripHtml(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
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

function articleId(outletId: string, url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  return `article-${outletId}-${hash}`;
}

function textOf(field: unknown): string {
  if (typeof field === "string") return field;
  if (field && typeof field === "object" && "#text" in (field as Record<string, unknown>)) {
    return String((field as Record<string, unknown>)["#text"]);
  }
  return "";
}

function toArticle(item: Record<string, unknown>, outlet: OutletConfig): Article | null {
  const headline = stripHtml(textOf(item.title));
  const url = textOf(item.link) || (item.guid ? textOf(item.guid) : "");
  if (!headline || !url) return null;

  const pubDateRaw = textOf(item.pubDate) || textOf((item as Record<string, unknown>)["dc:date"]);
  const publishedDate = pubDateRaw ? new Date(pubDateRaw) : new Date();
  const published = Number.isNaN(publishedDate.getTime())
    ? new Date().toISOString()
    : publishedDate.toISOString();

  const descriptionRaw =
    textOf(item.description) || textOf((item as Record<string, unknown>)["content:encoded"]);
  const excerpt = stripHtml(descriptionRaw).slice(0, 300);
  const bylineRaw = textOf((item as Record<string, unknown>)["dc:creator"]);

  return {
    id: articleId(outlet.id, url),
    outlet: outlet.name,
    headline,
    byline: bylineRaw || null,
    published,
    url,
    excerpt,
    links: { exhibition_id: null, venue_ids: [], artist_names: [] },
    link_confidence: 0,
  };
}

export async function fetchOutletArticles(outlet: OutletConfig): Promise<Article[]> {
  if (!outlet.rss_url || outlet.status !== "ok") return [];

  let res: Response;
  try {
    res = await fetch(outlet.rss_url, { headers: { "User-Agent": USER_AGENT } });
  } catch (err) {
    console.warn(`[rss] ${outlet.id}: fetch failed — ${(err as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`[rss] ${outlet.id}: HTTP ${res.status}`);
    return [];
  }

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "#text" });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    console.warn(`[rss] ${outlet.id}: XML parse failed — ${(err as Error).message}`);
    return [];
  }

  const channel = (doc?.rss as Record<string, unknown>)?.channel as
    | Record<string, unknown>
    | undefined;
  const rawItems = channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items
    .map((item) => toArticle(item as Record<string, unknown>, outlet))
    .filter((a): a is Article => a !== null);
}
