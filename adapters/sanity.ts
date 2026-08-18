// Sanity CMS gallery sites (SPEC.md §5.3). Per the worked example (Bortolami,
// project mnub8q5m, dataset production): if the dataset reads public — likely,
// since the CDN image URLs are unsigned — the GROQ endpoint returns
// structured JSON with no HTML-parsing heuristics at all.
//
// Different galleries' Sanity studios use genuinely different schemas (field
// names, nesting) even though they're all Sanity — verified directly against
// two real venues, Bortolami and Canada, which do NOT share a schema. So
// this adapter is config-driven per venue (`venue.config.sanity`) rather
// than assuming one universal shape. A venue with no `config.sanity` set —
// because its schema hasn't been mapped yet, or the project/dataset couldn't
// be found on its own site — returns an empty array rather than guessing.

import { CRAWLER_USER_AGENT } from "../pipeline/robots.ts";
import type { Venue, RawExhibition, Adapter, Work } from "../types/index.ts";

interface SanityConfigNested {
  projectId: string;
  dataset: string;
  schema: "nested"; // Bortolami-style: exhibitionInfo.{startDate,endDate,location}, installation[], masterInstallCaption
}
interface SanityConfigFlat {
  projectId: string;
  dataset: string;
  schema: "flat"; // Canada-style: top-level startDate/endDate, installationImages[] (each with its own caption), pressRelease
}
type SanityConfig = SanityConfigNested | SanityConfigFlat;

function hasSanityConfig(config: unknown): config is { sanity: SanityConfig } {
  return (
    typeof config === "object" &&
    config !== null &&
    "sanity" in config &&
    typeof (config as { sanity?: unknown }).sanity === "object"
  );
}

async function groq<T>(projectId: string, dataset: string, query: string): Promise<T | null> {
  const url = `https://${projectId}.api.sanity.io/v1/data/query/${dataset}?query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": CRAWLER_USER_AGENT } });
    if (!res.ok) return null; // 401 on a private dataset, etc. — fall through to empty, not a guess
    const json = (await res.json()) as { result: T };
    return json.result;
  } catch {
    return null;
  }
}

// Portable Text -> plain text. Only what we need: flatten span children,
// join blocks with a space. No marks/formatting preserved — this is for a
// ≤300-char excerpt, not a rehost of the rich text.
function portableTextToPlain(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const children = (block as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      const text = (child as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchNested(venue: Venue, cfg: SanityConfigNested): Promise<RawExhibition[]> {
  const query = `*[_type == "exhibition"] | order(exhibitionInfo.startDate desc) [0...6] {
    title,
    "artists": artists[]->title,
    "opens": exhibitionInfo.startDate,
    "closes": exhibitionInfo.endDate,
    "location": exhibitionInfo.location->title,
    "descriptionBlocks": exhibitionInfo.description,
    "slug": url.current,
    "images": installation[].asset->url,
    "captionBlocks": masterInstallCaption
  }`;
  const results = await groq<Record<string, unknown>[]>(cfg.projectId, cfg.dataset, query);
  if (!results) return [];

  const fetchedAt = new Date().toISOString();
  return results
    .filter((r) => typeof r.title === "string")
    .map((r): RawExhibition => {
      const images = Array.isArray(r.images) ? (r.images.filter((u) => typeof u === "string") as string[]) : [];
      const excerptSource =
        portableTextToPlain(r.descriptionBlocks) || portableTextToPlain(r.captionBlocks);
      return {
        title: r.title as string,
        artists: Array.isArray(r.artists) ? (r.artists.filter((a) => typeof a === "string") as string[]) : [],
        kind: "group",
        opens: typeof r.opens === "string" ? r.opens : null,
        closes: typeof r.closes === "string" ? r.closes : null,
        space_label: typeof r.location === "string" ? r.location : null,
        excerpt: excerptSource.slice(0, 300),
        press_release_url: null,
        image_urls: images,
        image_credit: portableTextToPlain(r.captionBlocks).slice(0, 200) || null,
        works: [] as Work[],
        source_url: typeof r.slug === "string" ? `${venue.url}/exhibitions/${r.slug}` : venue.url,
        confidence: 0.9, // clean structured GROQ hit, first-party
        fetched_at: fetchedAt,
      };
    });
}

async function fetchFlat(venue: Venue, cfg: SanityConfigFlat): Promise<RawExhibition[]> {
  const query = `*[_type == "exhibition"] | order(startDate desc) [0...6] {
    title,
    "artists": artists[]->title,
    startDate,
    endDate,
    "locationNames": locations[]->title,
    pressRelease,
    "slug": url.current,
    "images": installationImages[].asset->url,
    "captions": installationImages[].caption
  }`;
  const results = await groq<Record<string, unknown>[]>(cfg.projectId, cfg.dataset, query);
  if (!results) return [];

  const fetchedAt = new Date().toISOString();
  return results
    .filter((r) => typeof r.title === "string")
    .map((r): RawExhibition => {
      const images = Array.isArray(r.images) ? (r.images.filter((u) => typeof u === "string") as string[]) : [];
      const locationNames = Array.isArray(r.locationNames)
        ? (r.locationNames.filter((l) => typeof l === "string") as string[])
        : [];
      const firstCaption = Array.isArray(r.captions) && r.captions.length > 0 ? r.captions[0] : null;
      return {
        title: r.title as string,
        artists: Array.isArray(r.artists) ? (r.artists.filter((a) => typeof a === "string") as string[]) : [],
        kind: "group",
        opens: typeof r.startDate === "string" ? r.startDate : null,
        closes: typeof r.endDate === "string" ? r.endDate : null,
        space_label: locationNames[0] ?? null,
        excerpt: portableTextToPlain(r.pressRelease).slice(0, 300),
        press_release_url: null,
        image_urls: images,
        image_credit: portableTextToPlain(firstCaption).slice(0, 200) || null,
        works: [] as Work[],
        source_url: typeof r.slug === "string" ? `${venue.url}/exhibitions/${r.slug}` : venue.url,
        confidence: 0.9,
        fetched_at: fetchedAt,
      };
    });
}

async function fetchSanity(venue: Venue): Promise<RawExhibition[]> {
  if (!hasSanityConfig(venue.config)) return []; // unmapped schema — honest empty, not a guess
  const cfg = venue.config.sanity;
  const all = cfg.schema === "nested" ? await fetchNested(venue, cfg) : await fetchFlat(venue, cfg);

  // Keep it to what's plausibly current: closes today-or-later, or no
  // closes date at all (open-ended), or opens in the future (upcoming).
  const today = todayISO();
  return all.filter((ex) => (ex.closes && ex.closes >= today) || !ex.closes || (ex.opens && ex.opens >= today));
}

const sanityAdapter: Adapter = { id: "sanity", fetch: fetchSanity };
export default sanityAdapter;
