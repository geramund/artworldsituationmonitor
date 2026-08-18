// Article <-> exhibition resolution cascade (SPEC.md §8, "Entity resolution
// — the hard part"). Four tiers, cheapest first, stop at the first
// confident hit:
//   1. URL match          — article is hosted on the venue's own domain
//   2. Name + date window — normalized artist AND venue name both present,
//                           published within opens-14d..closes+30d
//   3. Fuzzy               — artist surname alone, or venue name alone
//   4. LLM adjudication    — one batched call for every article still stuck
//                           on 2+ candidates after tiers 1-3, cached by
//                           article id so a given article is never sent to
//                           the model twice
//
// Tiers 1-3 are fully deterministic and always run. Tier 4 needs
// ANTHROPIC_API_KEY; without it, 2+-candidate articles land in an explicit
// "ambiguous" state (multiple venue_ids, exhibition_id null, low
// confidence) rather than blocking the crawl or guessing.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { Article, Exhibition, Venue } from "../types/index.ts";
import { normalizeName, surname, containsWord } from "./names.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CACHE_PATH = join(ROOT, "registry/resolution-cache.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_BEFORE_OPENS_DAYS = 14;
const WINDOW_AFTER_CLOSES_DAYS = 30;

interface Candidate {
  exhibition: Exhibition;
  venue: Venue;
}

interface CachedResolution {
  exhibition_id: string | null;
  confidence: number;
}

type ResolutionCache = Record<string, CachedResolution>;

function loadCache(): ResolutionCache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as ResolutionCache;
  } catch {
    return {};
  }
}

function saveCache(cache: ResolutionCache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function inWindow(published: string, ex: Exhibition): boolean {
  if (!ex.opens && !ex.closes) return true; // nothing to check the window against
  const pub = new Date(published).getTime();
  const start = ex.opens ? new Date(ex.opens).getTime() - WINDOW_BEFORE_OPENS_DAYS * DAY_MS : -Infinity;
  const end = ex.closes ? new Date(ex.closes).getTime() + WINDOW_AFTER_CLOSES_DAYS * DAY_MS : Infinity;
  return pub >= start && pub <= end;
}

function tier1UrlMatch(article: Article, venues: Venue[]): Venue | null {
  const articleHost = hostnameOf(article.url);
  if (!articleHost) return null;
  return venues.find((v) => hostnameOf(v.url) === articleHost) ?? null;
}

function findCandidates(
  article: Article,
  exhibitions: Exhibition[],
  venueById: Map<string, Venue>
): { tier2: Candidate[]; tier3: Candidate[] } {
  const haystack = normalizeName(`${article.headline} ${article.excerpt}`);
  const tier2: Candidate[] = [];
  const tier3: Candidate[] = [];

  for (const ex of exhibitions) {
    const venue = venueById.get(ex.venue_id);
    if (!venue) continue;
    const venueNameHit = containsWord(haystack, normalizeName(venue.name));
    const artistHit = ex.artists.some((a) => {
      const s = surname(a);
      return s.length > 2 && containsWord(haystack, s);
    });

    if (venueNameHit && artistHit && inWindow(article.published, ex)) {
      tier2.push({ exhibition: ex, venue });
    } else if (venueNameHit || artistHit) {
      tier3.push({ exhibition: ex, venue });
    }
  }
  return { tier2, tier3 };
}

function link(article: Article, exhibition: Exhibition, venue: Venue, confidence: number): Article {
  return {
    ...article,
    links: { exhibition_id: exhibition.id, venue_ids: [venue.id], artist_names: exhibition.artists },
    link_confidence: confidence,
  };
}

function linkVenuesOnly(article: Article, venueIds: string[], confidence: number): Article {
  return {
    ...article,
    links: { exhibition_id: null, venue_ids: venueIds, artist_names: [] },
    link_confidence: confidence,
  };
}

function dedupeVenueIds(candidates: Candidate[]): string[] {
  return [...new Set(candidates.map((c) => c.venue.id))];
}

export interface ResolveOptions {
  // Defaults to true whenever ANTHROPIC_API_KEY is set. Exposed mainly for
  // tests / dry runs that want to force tier 4 off deterministically.
  llmAdjudicate?: boolean;
}

export interface ResolveStats {
  tier1: number;
  tier2: number;
  tier3: number;
  llm: number;
  ambiguous: number;
  unlinked: number;
}

export async function resolveArticles(
  articles: Article[],
  exhibitions: Exhibition[],
  venues: Venue[],
  options: ResolveOptions = {}
): Promise<{ articles: Article[]; stats: ResolveStats }> {
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const exhibitionsByVenue = new Map<string, Exhibition[]>();
  for (const ex of exhibitions) {
    exhibitionsByVenue.set(ex.venue_id, [...(exhibitionsByVenue.get(ex.venue_id) ?? []), ex]);
  }

  const stats: ResolveStats = { tier1: 0, tier2: 0, tier3: 0, llm: 0, ambiguous: 0, unlinked: 0 };
  const cache = loadCache();
  // originTier: 3 when the candidate set came only from surname/venue-name-
  // alone matching; 2 when it's a venue+artist match that just had 2+
  // exhibitions tie (a stronger signal, still ambiguous). Used only to
  // attribute the final resolution to the right stats bucket below.
  const llmQueue: { article: Article; candidates: Candidate[]; originTier: 2 | 3 }[] = [];
  const resolved: Article[] = [];

  // settle() links a single-candidate match immediately and returns the
  // literal string "queue" when the caller should push to llmQueue instead
  // (2+ candidates that tiers 1-3 can't distinguish between).
  // Only tier 2 (venue name AND artist AND date window, all at once) is
  // trustworthy enough to auto-link on a single hit. Tier 2 is "name +
  // date window", not "name only" — a single common surname (e.g. a press
  // story mentioning a "Clark" who has nothing to do with an unrelated
  // artist "Ed Clark" at a group show) is exactly the false-positive shape
  // real RSS testing produced, so tier 3 always goes through adjudication
  // (LLM if configured, otherwise the explicit ambiguous bucket) even when
  // it only turned up one candidate — a single fuzzy hit is not proof.
  function settle(article: Article, candidates: Candidate[], tier2Confidence: number, isTier2: boolean): Article | "queue" {
    if (isTier2 && candidates.length === 1) {
      const [c] = candidates;
      stats.tier2++;
      return link(article, c.exhibition, c.venue, tier2Confidence);
    }
    return "queue";
  }

  for (const article of articles) {
    const urlVenue = tier1UrlMatch(article, venues);
    if (urlVenue) {
      const atVenue = exhibitionsByVenue.get(urlVenue.id) ?? [];
      if (atVenue.length === 1) {
        stats.tier1++;
        resolved.push(link(article, atVenue[0], urlVenue, 0.95));
        continue;
      }
      if (atVenue.length === 0) {
        stats.tier1++;
        resolved.push(linkVenuesOnly(article, [urlVenue.id], 0.6));
        continue;
      }
      // Confirmed venue but multiple current shows — narrow the fuzzy
      // search to just this venue instead of the whole city.
      const { tier2, tier3 } = findCandidates(article, atVenue, venueById);
      const candidates = tier2.length ? tier2 : tier3;
      if (candidates.length === 0) {
        stats.tier1++;
        resolved.push(linkVenuesOnly(article, [urlVenue.id], 0.6));
        continue;
      }
      const outcome = settle(article, candidates, 0.9, tier2.length > 0);
      if (outcome === "queue") llmQueue.push({ article, candidates, originTier: tier2.length > 0 ? 2 : 3 });
      else resolved.push(outcome);
      continue;
    }

    const { tier2, tier3 } = findCandidates(article, exhibitions, venueById);
    const usingTier2 = tier2.length > 0;
    const candidates = usingTier2 ? tier2 : tier3;

    if (candidates.length === 0) {
      stats.unlinked++;
      resolved.push(article);
      continue;
    }

    const outcome = settle(article, candidates, 0.85, usingTier2);
    if (outcome === "queue") llmQueue.push({ article, candidates, originTier: usingTier2 ? 2 : 3 });
    else resolved.push(outcome);
  }

  const wantLLM = options.llmAdjudicate ?? Boolean(process.env.ANTHROPIC_API_KEY);
  const uncached = llmQueue.filter(({ article }) => !cache[article.id]);
  if (wantLLM && uncached.length > 0) {
    try {
      const results = await adjudicateBatch(uncached);
      for (const r of results) cache[r.article_id] = { exhibition_id: r.exhibition_id, confidence: r.confidence };
      saveCache(cache);
    } catch (err) {
      console.warn(
        `[resolve] LLM adjudication failed — leaving ${uncached.length} article(s) ambiguous: ${(err as Error).message}`
      );
    }
  }

  for (const { article, candidates, originTier } of llmQueue) {
    const cached = cache[article.id];
    if (cached?.exhibition_id) {
      const match = candidates.find((c) => c.exhibition.id === cached.exhibition_id);
      if (match) {
        if (originTier === 3) stats.tier3++;
        else stats.llm++;
        resolved.push(link(article, match.exhibition, match.venue, cached.confidence));
        continue;
      }
    }
    if (cached) {
      // LLM looked at every candidate and confidently said none fit.
      stats.unlinked++;
      resolved.push(article);
      continue;
    }
    // No API key configured, or the call failed this run.
    stats.ambiguous++;
    resolved.push(linkVenuesOnly(article, dedupeVenueIds(candidates), 0.3));
  }

  return { articles: resolved, stats };
}

// --- Tier 4: LLM adjudication -------------------------------------------

interface LLMResolution {
  article_id: string;
  exhibition_id: string | null;
  confidence: number;
}

async function adjudicateBatch(
  queue: { article: Article; candidates: Candidate[] }[]
): Promise<LLMResolution[]> {
  const client = new Anthropic();

  const items = queue.map(({ article, candidates }) => ({
    article_id: article.id,
    headline: article.headline,
    excerpt: article.excerpt,
    published: article.published,
    candidates: candidates.map((c) => ({
      exhibition_id: c.exhibition.id,
      venue_name: c.venue.name,
      title: c.exhibition.title,
      artists: c.exhibition.artists,
      opens: c.exhibition.opens,
      closes: c.exhibition.closes,
    })),
  }));

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 8192,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            resolutions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  article_id: { type: "string" },
                  exhibition_id: { anyOf: [{ type: "string" }, { type: "null" }] },
                  confidence: { type: "number" },
                },
                required: ["article_id", "exhibition_id", "confidence"],
                additionalProperties: false,
              },
            },
          },
          required: ["resolutions"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content:
          "You are matching art-press articles to the specific gallery exhibition each one covers. " +
          "For every article below, choose which candidate exhibition_id it is actually about, or null " +
          "if none of the listed candidates fit (e.g. the article is generic art-world coverage, or is " +
          "about a show at a venue not in the candidate list). confidence is 0-1. Base every decision only " +
          "on the text given — do not invent facts about shows you don't have information on.\n\n" +
          JSON.stringify(items, null, 2),
      },
    ],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block in LLM response");
  const parsed = JSON.parse(block.text) as { resolutions: LLMResolution[] };
  return parsed.resolutions;
}
