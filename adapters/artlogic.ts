// Artlogic-platform gallery sites (SPEC.md §5.1/§5.2). Highest-coverage
// platform in the seed registry (8 of 37 venues, per adapters/fingerprint.ts).
//
// No public data API was found (unlike Sanity's GROQ endpoint) — Artlogic
// server-renders plain HTML with a very consistent template across every
// site on the platform, so this is a structural HTML scrape via cheerio
// rather than a JSON fetch. Verified against andrew-kreps.com and
// ppowgallery.com.
//
// Listing page (/exhibitions) layout:
//   - Multiple `.grid-container` divs (ids vary: "large", "medium", "small",
//     "exhibitions-grid", ...). CURRENT exhibitions live in a container with
//     no section heading. A container whose OWN <h4> section-header (nested
//     INSIDE it, not a preceding sibling — confirmed on both ppowgallery.com
//     and yancey-richardson.com, which also mixes in every historical art-fair
//     booth back to the 2000s) reads "Past" must be skipped entirely; "Upcoming"
//     is kept. Do not track section state across sibling iteration — the
//     heading is nested per-container, so a doc-order running-state approach
//     silently misattributes the Past archive to whatever section preceded it.
//   - Each `.entry` is `<a href="/exhibitions/{slug}">` wrapping an <h1>
//     title, optional `<h2 class="subtitle2">` space label, and `<h3>` date
//     range text like "June 26 – September 12, 2026". Entries with no <a>
//     (announced-but-not-yet-linked) are skipped — no page to link to means
//     no adapter-sourced record, that's what manual.ts is for.
//   - Newer "records_list" template (leilahellergallery.com, 2026-10-07):
//     /exhibitions redirects to /exhibitions/current/, sections are
//     `div[id^=exhibitions-grid-]` (-current, -upcoming, -past) each with a
//     `.subheading`, entries are `li > a[href=/exhibitions/{id}-{slug}/]`
//     holding `.content h2` title, `span.date` ("10 Sep - 22 Oct 2026") and
//     `span.location` ("New York" / "Dubai"). None of the old subpage
//     selectors exist there, so the listing's own lazy-loaded image is used.
//     `config.artlogic.locations` keeps a multi-city gallery to the spaces
//     this venue entry maps.
//   - Per-exhibition subpages: `/exhibitions/{slug}` (image slider with a
//     <figcaption> crediting the photographer), `/{slug}/artists` (artist
//     grid), `/{slug}/press-release` (full text + a PDF download link).

import * as cheerio from "cheerio";
import type { Venue, RawExhibition, Adapter, ExhibitionKind } from "../types/index.ts";
import { CRAWLER_USER_AGENT } from "../pipeline/robots.ts";
import { parseDateRange as parseLooseDateRange } from "./html.ts";

interface ArtlogicConfig {
  // Keep only entries whose listed location contains one of these (case-
  // insensitive). Only the records_list template shows a location.
  locations?: string[];
  // Regex (case-insensitive) on "title | subtitle" — drops matches, e.g. a
  // gallery's show hosted at another gallery's space.
  exclude?: string;
  // How to read "10.9 - 24.10.2026"-style dates (nararoesler.art is dmy).
  numeric?: "mdy" | "dmy";
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// "June 26 – September 12, 2026" / "June 27 – November 1, 2026" / a single
// "September 12, 2026" with no range. En-dash or hyphen, year borrowed from
// the closing side if the opening side omits it. Returns [null, null] if it
// can't confidently parse — never guesses.
function parseDateRange(text: string): [string | null, string | null] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const parts = cleaned.split(/[–—-]/).map((s) => s.trim());
  if (parts.length === 1) {
    const d = new Date(parts[0]);
    return Number.isNaN(d.getTime()) ? [null, null] : [toISODate(d), toISODate(d)];
  }
  if (parts.length !== 2) return [null, null];

  let [openPart, closePart] = parts;
  const closeYearMatch = closePart.match(/\b(\d{4})\b/);
  if (!openPart.match(/\b\d{4}\b/) && closeYearMatch) {
    openPart = `${openPart}, ${closeYearMatch[1]}`;
  }
  const opens = new Date(openPart);
  const closes = new Date(closePart);
  if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) return [null, null];
  return [toISODate(opens), toISODate(closes)];
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function kindFromArtistCount(n: number): ExhibitionKind {
  if (n === 1) return "solo";
  if (n === 2) return "two_person";
  return "group";
}

interface ListingEntry {
  slug: string;
  title: string;
  spaceLabel: string | null;
  dateText: string;
  location: string | null;
  subtitle: string;
  image: string | null;
}

function parseListing(html: string, origin: string): ListingEntry[] {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // Each grid-container carries its own section heading NESTED inside it
  // (not as a preceding sibling) — read it locally per-container rather
  // than tracking running state across document order. A container with no
  // heading (or one that isn't "Past") is current/upcoming; "Past" is a
  // full historical archive (including old art-fair booths) and must be
  // skipped entirely.
  $(".grid-container").each((_, container) => {
    const $el = $(container);
    const heading = $el.find("h4").first().text().trim().toLowerCase();
    if (heading === "past") return;

    $el.find(".entry > a[href^='/exhibitions/']").each((_, a) => {
      const $a = $(a);
      const href = $a.attr("href") ?? "";
      const slugMatch = href.match(/^\/exhibitions\/([a-z0-9-]+)\/?$/i);
      if (!slugMatch) return;
      const title = $a.find("h1").first().text().trim();
      const spaceLabel = $a.find("h2.subtitle2").first().text().trim() || null;
      const dateText = $a.find("h3").first().text().trim();
      if (!title) return;
      entries.push({ slug: slugMatch[1], title, spaceLabel, dateText, location: null, subtitle: spaceLabel ?? "", image: null });
    });
  });

  // records_list template — see header.
  $("div[id^='exhibitions-grid-']:not([id$='-container'])").each((_, section) => {
    const $sec = $(section);
    const heading = $sec.find(".subheading").first().text().trim().toLowerCase();
    if (heading === "past" || /-past$/.test($sec.attr("id") ?? "")) return;

    $sec.find("li > a[href^='/exhibitions/']").each((_, a) => {
      const $a = $(a);
      const slugMatch = ($a.attr("href") ?? "").match(/^\/exhibitions\/([a-z0-9-]+)\/?$/i);
      if (!slugMatch) return;
      const title = $a.find(".content h2").first().text().trim();
      if (!title) return;
      entries.push({
        slug: slugMatch[1],
        title,
        spaceLabel: null,
        dateText: $a.find(".date").first().text().trim(),
        location: $a.find(".location").first().text().trim() || null,
        subtitle: $a.find(".content h3, .content .subtitle").first().text().trim(),
        image: $a.find("img[data-src]").first().attr("data-src") ?? null,
      });
    });
  });

  // de-dupe (same slug can't legitimately appear twice, but be defensive)
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.slug) ? false : (seen.add(e.slug), true)));
}

async function fetchArtists(baseUrl: string, slug: string): Promise<string[]> {
  const html = await fetchHtml(`${baseUrl}/exhibitions/${slug}/artists`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const names: string[] = [];
  $("#artists-grid .entry .title").each((_, el) => {
    const name = $(el).text().trim();
    if (name) names.push(titleCase(name));
  });
  return names;
}

// Artlogic renders artist names in the artist grid as all-caps; store them
// in a readable form rather than shouting.
function titleCase(s: string): string {
  // Capitalize after word boundaries AND hyphens/apostrophes so
  // "KELLIHER-COMBS" -> "Kelliher-Combs", not "Kelliher-combs".
  return s
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

interface ImageInfo {
  urls: string[];
  credit: string | null;
}

async function fetchImages(baseUrl: string, slug: string): Promise<ImageInfo> {
  const html = await fetchHtml(`${baseUrl}/exhibitions/${slug}`);
  if (!html) return { urls: [], credit: null };
  const $ = cheerio.load(html);
  const urls: string[] = [];
  let credit: string | null = null;

  $("img[data-enlarge]").each((_, el) => {
    const src = $(el).attr("data-enlarge") || $(el).attr("data-src");
    if (src && !urls.includes(src)) urls.push(src);
  });

  // Exhibit-E-derived Artlogic sites (ppowgallery.com, paulacoopergallery.com,
  // nahmadcontemporary.com — 2026-10-07) have no data-enlarge slider: show
  // images are plain `<img itemprop=image src=".../exhibit-e/...">`. The
  // w_200,h_50 ones on the same CDN path are partner/footer logos. Some lazy-
  // load (data-src); some only have a header background (nahmad).
  if (urls.length === 0) {
    $("img").each((_, el) => {
      const src = $(el).attr("data-src") || $(el).attr("src");
      if (src && src.includes("/exhibit-e/") && !/h_50\b/.test(src) && !urls.includes(src)) urls.push(src);
    });
  }
  if (urls.length === 0) {
    const bg = ($(".item-header-background").attr("style") ?? "").match(/url\(['"]?([^'")]+exhibit-e\/[^'")]+)/);
    if (bg) urls.push(bg[1]);
  }

  $("figcaption p").each((_, el) => {
    if (credit) return;
    const text = $(el).text();
    const match = text.match(/Photo(?:s|graph)?(?:\s+by)?:?\s*([^\n]+)$/im);
    if (match) credit = match[1].trim().replace(/\.$/, "");
  });

  return { urls: urls.slice(0, 6), credit };
}

interface PressInfo {
  excerpt: string;
  pressReleaseUrl: string | null;
}

async function fetchPressRelease(baseUrl: string, slug: string): Promise<PressInfo> {
  const html = await fetchHtml(`${baseUrl}/exhibitions/${slug}/press-release`);
  if (!html) return { excerpt: "", pressReleaseUrl: null };
  const $ = cheerio.load(html);

  const firstParagraph = $(".text-one-column .content p").first().text().trim();
  const excerpt = firstParagraph.length > 300 ? firstParagraph.slice(0, 297) + "…" : firstParagraph;

  let pressReleaseUrl: string | null = null;
  const fileHref = $("a.file[href]").first().attr("href");
  if (fileHref) pressReleaseUrl = new URL(fileHref, baseUrl).toString();

  return { excerpt, pressReleaseUrl };
}

async function fetchArtlogic(venue: Venue): Promise<RawExhibition[]> {
  const baseUrl = venue.url.replace(/\/$/, "");
  const listingUrl = `${baseUrl}/exhibitions`;
  const listingHtml = await fetchHtml(listingUrl);
  if (!listingHtml) return [];

  const config = (venue.config as { artlogic?: ArtlogicConfig } | undefined)?.artlogic;
  const wanted = config?.locations?.map((l) => l.toLowerCase());
  const exclude = config?.exclude ? new RegExp(config.exclude, "i") : null;
  const entries = parseListing(listingHtml, baseUrl).filter(
    (e) =>
      (!wanted || (e.location !== null && wanted.some((w) => e.location!.toLowerCase().includes(w)))) &&
      !exclude?.test(`${e.title} | ${e.subtitle}`)
  );
  const now = new Date().toISOString();
  const results: RawExhibition[] = [];

  for (const entry of entries) {
    // A configured numeric order means "10.9 - 10.11.2026"-style text, which
    // the Date-based parser would happily misread as month-first.
    let [opens, closes] = config?.numeric ? [null, null] : parseDateRange(entry.dateText);
    if (!opens || !closes) {
      const loose = parseLooseDateRange(entry.dateText, config?.numeric);
      if (loose) [opens, closes] = [loose.opens, loose.closes];
    }
    const sourceUrl = `${baseUrl}/exhibitions/${entry.slug}`;

    const artists = await fetchArtists(baseUrl, entry.slug);
    await sleep(250);
    const images = await fetchImages(baseUrl, entry.slug);
    const imageUrls = images.urls.length ? images.urls : entry.image ? [new URL(entry.image, baseUrl).toString()] : [];
    const credit = images.credit;
    await sleep(250);
    const { excerpt, pressReleaseUrl } = await fetchPressRelease(baseUrl, entry.slug);
    await sleep(250);

    // Confidence reflects extraction certainty, not curatorial completeness:
    // the listing tile + dedicated subpages are all first-party structured
    // HTML from the gallery's own site, so a clean parse here is solid —
    // docked slightly if we couldn't resolve real dates.
    const confidence = opens && closes ? 0.85 : 0.6;

    results.push({
      title: entry.title,
      artists,
      kind: kindFromArtistCount(artists.length || 1),
      opens,
      closes,
      opening_reception: null,
      space_label: entry.spaceLabel,
      excerpt,
      press_release_url: pressReleaseUrl,
      image_urls: imageUrls,
      image_credit: credit,
      works: [],
      source_url: sourceUrl,
      confidence,
      fetched_at: now,
    });
  }

  return results;
}

const artlogicAdapter: Adapter = { id: "artlogic", fetch: fetchArtlogic };
export default artlogicAdapter;
