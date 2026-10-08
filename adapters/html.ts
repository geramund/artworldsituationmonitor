// Hand-configured HTML scraper (SPEC.md §5.2) for venues with no data API —
// Squarespace/Wix/Cargo/Kirby/custom builds, or a CMS whose API isn't
// public. One adapter, but nothing in it is generic guesswork: every venue
// that uses it carries a `config.html` block naming the exact page and CSS
// selectors, chosen by hand against that venue's real markup. No
// `config.html` means no attempt, same rule as sanity.ts/wordpress.ts.
//
// Per-venue config (all selectors are cheerio/CSS, scoped to `item`):
//   path      page to fetch, relative to venue.url — or several (e.g.
//             ["/current", "/upcoming"]), each read with the same selectors
//   item      one element per show
//   title     the show title (default: the item's first heading, else link
//             text); a list is tried in order, for listings where some
//             shows have a separate title and others are titled by artist
//   artists   artist name(s) — every match is one entry, or one comma/"and"
//             separated string (default: none — titles often ARE the artist,
//             and splitting that heuristically is worse than leaving it empty)
//   dates     element holding the date range (default: whole item text)
//   link      <a> for the show page (default: item itself if <a>, else first
//             a[href]; "none" when the item's links all point off-site)
//   image     <img> for a thumbnail (searched inside the item, or inside
//             `imageScope` when set)
//   imageScope  ancestor of the item to look for `image` in — page builders
//             (Squarespace fluid-engine, plain two-column layouts) put the
//             text block and its photo in sibling blocks of one container
//   limit     only the first N items (listings sorted newest-first, where
//             older entries are past shows with no "closed" marker)
//   numeric   "mdy" | "dmy" — how to read 10.08.26-style dates (default mdy)
//   keepUndated  keep items with no parseable date (only for pages that are
//             by construction "current only", e.g. a /current page)
//   openEndedDays  how long a show with an opening date but no closing
//             date counts as on view (default 60)
//   titleLine for free-text blocks with no title element: take the item's
//             Nth line (0-based; lines split at <br> and block elements)
//   artistsLine  same, for the artist line
//   exclude   regex (case-insensitive) on the title — drops matches, e.g.
//             Kings Leap's "Claire's Camera at N/A, Seoul" off-site shows
//   detail    for listings that carry no dates: open each item's link and
//             read `detail.dates` (a selector on that page) instead. Capped
//             at `limit` (default 8) pages per run, 300ms apart.
//
// Shows already closed are dropped here, not left to the snapshot layer, so
// an archive-style listing can't flood the map with past shows.

import * as cheerio from "cheerio";
import type { Venue, RawExhibition, Adapter, ExhibitionKind } from "../types/index.ts";
import { CRAWLER_USER_AGENT } from "../pipeline/robots.ts";

export interface HtmlConfig {
  path: string | string[];
  item: string;
  title?: string | string[];
  artists?: string;
  dates?: string;
  link?: string;
  image?: string;
  imageScope?: string;
  limit?: number;
  numeric?: "mdy" | "dmy";
  keepUndated?: boolean;
  openEndedDays?: number;
  titleLine?: number;
  artistsLine?: number;
  exclude?: string;
  detail?: { dates: string };
}

function getHtmlConfig(venue: Venue): HtmlConfig | null {
  return (venue.config as { html?: HtmlConfig } | undefined)?.html ?? null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DAY_RE = "(\\d{1,2})(?:st|nd|rd|th)?";
const DASH_RE = "\\s*(?:[-–—~]|to|through|thru)\\s*";

interface Part {
  y: number | null;
  m: number;
  d: number;
}

function iso(p: Part): string {
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function valid(p: Part): boolean {
  return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31;
}

function fullYear(y: string): number {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

// Fill in missing years: a range's start borrows the end's year (rolling
// back one if the months wrap, "Dec 5 – Jan 10, 2027"); a range with no
// year at all takes the year that puts it nearest to `now`.
function resolveYears(start: Part, end: Part | null, now: Date): void {
  if (end && end.y === null && start.y !== null) end.y = start.m > end.m ? start.y + 1 : start.y;
  if (end && start.y === null && end.y !== null) start.y = start.m > end.m ? end.y - 1 : end.y;
  if (start.y === null) {
    const y = now.getUTCFullYear();
    const candidates = [y - 1, y, y + 1];
    const anchor = end ?? start;
    const best = candidates.reduce((a, b) =>
      Math.abs(Date.UTC(a, anchor.m - 1, anchor.d) - now.getTime()) <= Math.abs(Date.UTC(b, anchor.m - 1, anchor.d) - now.getTime()) ? a : b
    );
    if (end) {
      end.y = best;
      start.y = start.m > end.m ? best - 1 : best;
    } else start.y = best;
  }
}

export interface ParsedDates {
  opens: string | null;
  closes: string | null;
}

export function parseDateRange(text: string, numeric: "mdy" | "dmy" = "mdy", now: Date = new Date()): ParsedDates | null {
  const t = text.replace(/\s+/g, " ").replace(/,(?=\S)/g, ", ");
  const Y = "(?:,?\\s*(\\d{4}))?";

  // "September 17 – November 1, 2026", "Oct 1–Nov 7, 2026", "Sep 10, 2026 – Jan 3, 2027", "October 16th — 31st, 2025"
  let m = t.match(new RegExp(`${MONTH_RE}\\s+${DAY_RE}${Y}${DASH_RE}(?:${MONTH_RE}\\s+)?${DAY_RE}${Y}`, "i"));
  if (m) {
    const start: Part = { m: MONTHS[m[1].slice(0, 3).toLowerCase()], d: Number(m[2]), y: m[3] ? Number(m[3]) : null };
    const end: Part = { m: m[4] ? MONTHS[m[4].slice(0, 3).toLowerCase()] : start.m, d: Number(m[5]), y: m[6] ? Number(m[6]) : null };
    if (valid(start) && valid(end)) {
      resolveYears(start, end, now);
      return { opens: iso(start), closes: iso(end) };
    }
  }

  // "17 September – 1 November 2026", "5–28 June 2026"
  m = t.match(new RegExp(`${DAY_RE}(?:\\s+${MONTH_RE})?${Y}${DASH_RE}${DAY_RE}\\s+${MONTH_RE}${Y}`, "i"));
  if (m) {
    const end: Part = { d: Number(m[4]), m: MONTHS[m[5].slice(0, 3).toLowerCase()], y: m[6] ? Number(m[6]) : null };
    const start: Part = { d: Number(m[1]), m: m[2] ? MONTHS[m[2].slice(0, 3).toLowerCase()] : end.m, y: m[3] ? Number(m[3]) : null };
    if (valid(start) && valid(end)) {
      resolveYears(start, end, now);
      return { opens: iso(start), closes: iso(end) };
    }
  }

  // "10.08.26 - 12.12.26", "10/8/2026 – 12/12/2026", "10.9 - 24.10.2026"
  // (start year omitted: borrowed from the end)
  m = t.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s*[-–—]\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    const [a, b, c, d] = numeric === "mdy" ? [m[1], m[2], m[4], m[5]] : [m[2], m[1], m[5], m[4]];
    const start: Part = { m: Number(a), d: Number(b), y: fullYear(m[3] ?? m[6]) };
    const end: Part = { m: Number(c), d: Number(d), y: fullYear(m[6]) };
    if (valid(start) && valid(end)) return { opens: iso(start), closes: iso(end) };
  }

  // "Through November 1, 2026" / "Until Nov 1" / "On view until 1 November"
  m = t.match(new RegExp(`(?:through|thru|until|till|closes|closing)\\s+(?:${MONTH_RE}\\s+${DAY_RE}|${DAY_RE}\\s+${MONTH_RE})${Y}`, "i"));
  if (m) {
    const end: Part = m[1]
      ? { m: MONTHS[m[1].slice(0, 3).toLowerCase()], d: Number(m[2]), y: m[5] ? Number(m[5]) : null }
      : { m: MONTHS[m[4].slice(0, 3).toLowerCase()], d: Number(m[3]), y: m[5] ? Number(m[5]) : null };
    if (valid(end)) {
      if (end.y === null) resolveYears(end, null, now);
      return { opens: null, closes: iso(end) };
    }
  }

  // A single date — an opening ("Opening September 16, 2026") or one-night event.
  m = t.match(new RegExp(`${MONTH_RE}\\s+${DAY_RE}${Y}`, "i"));
  if (m) {
    const p: Part = { m: MONTHS[m[1].slice(0, 3).toLowerCase()], d: Number(m[2]), y: m[3] ? Number(m[3]) : null };
    if (valid(p)) {
      if (p.y === null) resolveYears(p, null, now);
      return { opens: iso(p), closes: null };
    }
  }
  return null;
}

function clean(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function splitArtists(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\band\b|\n)\s*/)
    .map((a) => a.trim().replace(/^(?:with|featuring|by)\s+/i, ""))
    .filter((a) => a.length > 1 && a.length < 80);
}

// A show with an opening date but no closing date is kept for 60 days after
// opening — long enough for a typical run, short enough that an undated
// archive entry can't linger as "open" forever.
const OPEN_ENDED_DAYS = 60;

function isCurrentOrUpcoming(d: ParsedDates, now: Date, openEndedDays = OPEN_ENDED_DAYS): boolean {
  const today = now.toISOString().slice(0, 10);
  if (d.closes) return d.closes >= today;
  if (d.opens) return new Date(d.opens).getTime() > now.getTime() - openEndedDays * 86_400_000;
  return false;
}

export async function fetchHtmlPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": CRAWLER_USER_AGENT }, redirect: "follow" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// <br> and block boundaries become newlines so `titleLine`/`artistsLine`
// can split an item into lines; clean() collapses them for everything else.
function load(html: string) {
  const $ = cheerio.load(html);
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6").append("\n");
  return $;
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map(clean)
    .filter(Boolean);
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// `link: "none"` for pages whose only <a>s point elsewhere (artist sites).
function itemHref($: cheerio.CheerioAPI, $item: cheerio.Cheerio<any>, config: HtmlConfig): string | undefined {
  if (config.link === "none") return undefined;
  const $link = config.link ? $item.find(config.link).first() : $item.is("a[href]") ? $item : $item.find("a[href]").first();
  return $link.attr("href");
}

// Artist text that also contains the title ("Samantha Jones: Residual
// Worlds" in one heading) — keep just the part that isn't the title.
// A heading that is ONLY the artist's name doubles as the title (Matthew
// Marks' "GARY HUME") — then the artist is that same text, not nothing.
function withoutTitle(text: string, title: string): string {
  const rest = text.replace(title, "").replace(/^[\s:,|–—-]+|[\s:,|–—-]+$/g, "");
  return rest || text;
}

export type DetailDates = Map<string, string>; // item link -> date text from its own page

export function extractHtml(
  html: string,
  config: HtmlConfig,
  pageUrl: string,
  now: Date = new Date(),
  detailDates?: DetailDates
): RawExhibition[] {
  const $ = load(html);
  let items = $(config.item).toArray();
  if (config.limit) items = items.slice(0, config.limit);

  const out: RawExhibition[] = [];
  const seen = new Set<string>();
  for (const el of items) {
    const $item = $(el);

    const itemLines = lines($item.text());
    const title =
      config.titleLine !== undefined
        ? itemLines[config.titleLine] ?? ""
        : clean(
            config.title
              ? (Array.isArray(config.title) ? config.title : [config.title])
                  .map((sel) => clean($item.find(sel).first().text()))
                  .find(Boolean) ?? ""
              : $item.find("h1,h2,h3,h4").first().text() || $item.find("a").first().text()
          );
    if (!title) continue;
    if (config.exclude && new RegExp(config.exclude, "i").test(title)) continue;

    const artists = config.artistsLine !== undefined
      ? splitArtists(withoutTitle(itemLines[config.artistsLine] ?? "", title))
      : config.artists
      ? (() => {
          const hits = $item
            .find(config.artists)
            .toArray()
            .map((a) => withoutTitle(clean($(a).text()), title))
            .filter(Boolean);
          return hits.length === 1 ? splitArtists(hits[0]) : hits;
        })()
      : [];

    // No link of its own: the page URL plus a title anchor, so two linkless
    // shows on one page still get distinct exhibition ids (normalize.ts
    // hashes source_url).
    const href = itemHref($, $item, config);
    const source_url = href ? new URL(href, pageUrl).toString() : `${pageUrl}#${slug(title)}`;

    const dateText = detailDates
      ? detailDates.get(source_url) ?? ""
      : config.dates
        ? $item.find(config.dates).text()
        : $item.text();
    const dates = parseDateRange(clean(dateText), config.numeric, now);
    if (dates ? !isCurrentOrUpcoming(dates, now, config.openEndedDays) : !config.keepUndated) continue;

    const key = `${source_url}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const $scope = config.imageScope ? $item.closest(config.imageScope) : $item;
    const $img = config.image ? $scope.find(config.image).first() : $();
    let src = $img.attr("data-src") || $img.attr("data-original") || $img.attr("data-image") || $img.attr("src");
    // Wix serves a transform path (".../v1/fill/w_108,...,blur_2/...") that is
    // often a blurred lazy-load placeholder; the media URL before /v1/ is the
    // original upload.
    if (src && /static\.wixstatic\.com\/media\//.test(src)) src = src.replace(/\/v1\/.*$/, "");
    const kind: ExhibitionKind | undefined = artists.length === 1 ? "solo" : artists.length === 2 ? "two_person" : undefined;

    out.push({
      title,
      artists,
      kind,
      opens: dates?.opens ?? null,
      closes: dates?.closes ?? null,
      space_label: null,
      excerpt: "",
      press_release_url: null,
      image_urls: src ? [new URL(src, pageUrl).toString()] : [],
      image_credit: null,
      works: [],
      source_url,
      // Hand-mapped selectors on a first-party page: better than the
      // squarespace text heuristic, below a structured API.
      confidence: dates?.closes ? 0.7 : 0.55,
      fetched_at: now.toISOString(),
    });
  }
  return out;
}

// The links a detail-mode listing would follow, in page order.
export function detailLinks(html: string, config: HtmlConfig, pageUrl: string): string[] {
  const $ = load(html);
  const links = $(config.item)
    .toArray()
    .map((el) => {
      const href = itemHref($, $(el), config);
      return href ? new URL(href, pageUrl).toString() : null;
    })
    .filter((u): u is string => u !== null);
  return [...new Set(links)].slice(0, config.limit ?? 8);
}

export async function fetchDetailDates(links: string[], selector: string): Promise<DetailDates> {
  const out: DetailDates = new Map();
  for (const url of links) {
    const page = await fetchHtmlPage(url);
    if (page) out.set(url, clean(load(page)(selector).first().text()));
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

async function fetchHtml(venue: Venue): Promise<RawExhibition[]> {
  const config = getHtmlConfig(venue);
  if (!config) return [];
  const out: RawExhibition[] = [];
  for (const path of Array.isArray(config.path) ? config.path : [config.path]) {
    const pageUrl = new URL(path, venue.url).toString();
    const html = await fetchHtmlPage(pageUrl);
    if (!html) continue;
    const detailDates = config.detail
      ? await fetchDetailDates(detailLinks(html, config, pageUrl), config.detail.dates)
      : undefined;
    for (const r of extractHtml(html, config, pageUrl, new Date(), detailDates)) {
      if (!out.some((o) => o.source_url === r.source_url)) out.push(r);
    }
  }
  return out;
}

const htmlAdapter: Adapter = { id: "html", fetch: fetchHtml };
export default htmlAdapter;
