// The loop (SPEC.md §6). Four adapters are wired in now: manual (always
// authoritative, never plausibility-gated), sanity, wordpress, artlogic
// (gated by plausible() against last-good — a wrong empty state is worse
// than a slightly old one). Venues on a platform without a working adapter
// yet (squarespace, sitemap-fallback, jsonld, exhibite, nextdata) are simply
// skipped here — they keep whatever health/data they already have.
//
// Run with --dry-run to see what the crawl WOULD do (fetch, normalize,
// plausibility-check, diff) without writing anything to disk.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import manualAdapter from "../adapters/manual.ts";
import sanityAdapter from "../adapters/sanity.ts";
import wordpressAdapter from "../adapters/wordpress.ts";
import artlogicAdapter from "../adapters/artlogic.ts";
import { fetchOutletArticles, type OutletConfig } from "../adapters/rss.ts";
import { normalizeExhibition } from "./normalize.ts";
import { plausible } from "./plausible.ts";
import { resolveArticles, type ResolveStats } from "./resolve.ts";
import { robotsAllows } from "./robots.ts";
import { diffEvents, bootstrapEvents, type PriorState } from "./diff.ts";
import { writeCitySnapshot, writeGlobalSnapshot, appendEvents } from "./snapshot.ts";
import type { Adapter, Venue, Exhibition, Article, Nexus, MonitorEvent, CitySnapshot } from "../types/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const VENUES_DIR = join(ROOT, "registry/venues");
const OUTLETS_PATH = join(ROOT, "registry/outlets.json");
const NEXUS_PATH = join(ROOT, "registry/nexus.json");
const NYC_SNAPSHOT_PATH = join(ROOT, "snapshots/nyc.json");

const DRY_RUN = process.argv.includes("--dry-run");

const ADAPTERS: Record<string, Adapter> = {
  manual: manualAdapter,
  sanity: sanityAdapter,
  wordpress: wordpressAdapter,
  artlogic: artlogicAdapter,
};

function loadVenues(): Venue[] {
  return readdirSync(VENUES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(VENUES_DIR, f), "utf8")) as Venue);
}

function saveVenue(venue: Venue) {
  if (DRY_RUN) return;
  writeFileSync(join(VENUES_DIR, `${venue.id}.json`), JSON.stringify(venue, null, 2) + "\n");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface SuspectReport {
  id: string;
  reason: string;
  had: number;
  got: number;
}

async function main() {
  const now = new Date();
  const venues = loadVenues();
  const allExhibitions: Exhibition[] = [];
  const suspects: SuspectReport[] = [];
  const blocked: string[] = [];

  const priorSnapshot = existsSync(NYC_SNAPSHOT_PATH)
    ? (JSON.parse(readFileSync(NYC_SNAPSHOT_PATH, "utf8")) as CitySnapshot)
    : null;
  const priorExhibitionsByVenue = new Map<string, Exhibition[]>();
  for (const ex of priorSnapshot?.exhibitions ?? []) {
    priorExhibitionsByVenue.set(ex.venue_id, [...(priorExhibitionsByVenue.get(ex.venue_id) ?? []), ex]);
  }

  for (const venue of venues) {
    const adapter = ADAPTERS[venue.adapter];
    if (!adapter) continue; // no adapter built for this platform yet — leave health/data as-is

    if (venue.adapter !== "manual") {
      const allowed = await robotsAllows(venue.url);
      if (!allowed) {
        blocked.push(venue.id);
        venue.health = { ...venue.health, last_attempt: now.toISOString(), status: "blocked" };
        saveVenue(venue);
        continue;
      }
    }

    let raw: Awaited<ReturnType<Adapter["fetch"]>> = [];
    try {
      raw = await adapter.fetch(venue);
    } catch (err) {
      console.warn(`[crawl] ${venue.id}: adapter threw — ${(err as Error).message}`);
    }
    const exhibitions = raw
      .map((r) => normalizeExhibition(r, venue, now))
      .filter((e): e is Exhibition => e !== null);

    if (venue.adapter === "manual") {
      // Authoritative by definition (SPEC.md §14.3) — never plausibility-gated.
      allExhibitions.push(...exhibitions);
      venue.health = {
        last_attempt: now.toISOString(),
        last_success: now.toISOString(),
        record_count: exhibitions.length,
        consecutive_failures: 0,
        status: "ok",
      };
    } else {
      const prior = priorExhibitionsByVenue.get(venue.id) ?? null;
      const result = plausible(exhibitions, prior);
      if (result.ok) {
        allExhibitions.push(...exhibitions);
        venue.health = {
          last_attempt: now.toISOString(),
          last_success: now.toISOString(),
          record_count: exhibitions.length,
          consecutive_failures: 0,
          status: "ok",
        };
      } else {
        // Suspect never silently overwrites — keep last-good.
        allExhibitions.push(...(prior ?? []));
        const failures = venue.health.consecutive_failures + 1;
        venue.health = {
          last_attempt: now.toISOString(),
          last_success: venue.health.last_success,
          record_count: venue.health.record_count,
          consecutive_failures: failures,
          status: failures >= 3 ? "stale" : "suspect",
        };
        suspects.push({ id: venue.id, reason: result.reason ?? "unknown", had: prior?.length ?? 0, got: exhibitions.length });
      }
    }
    saveVenue(venue);
  }

  const outlets = JSON.parse(readFileSync(OUTLETS_PATH, "utf8")) as OutletConfig[];
  const rawArticles: Article[] = [];
  for (const outlet of outlets) {
    const articles = await fetchOutletArticles(outlet);
    rawArticles.push(...articles);
    console.log(`[rss] ${outlet.id}: ${articles.length} article(s)`);
    await sleep(300);
  }

  // Resolution cascade (SPEC.md §8) — links each article to the exhibition
  // it's actually about, or explicitly marks it ambiguous/unlinked. Runs
  // even in --dry-run so the preview report reflects real link rates.
  const { articles: allArticles, stats: resolveStats } = await resolveArticles(rawArticles, allExhibitions, venues);

  const nexus = JSON.parse(readFileSync(NEXUS_PATH, "utf8")) as Nexus[];

  let newEvents: MonitorEvent[];
  if (DRY_RUN) {
    // Preview what the diff WOULD produce, without touching snapshots/.
    newEvents = priorSnapshot
      ? diffEvents(
          {
            exhibitionsById: new Map(priorSnapshot.exhibitions.map((e) => [e.id, e])),
            venuesWithShowsIds: new Set(
              priorSnapshot.venues
                .filter((v) => priorSnapshot.exhibitions.some((e) => e.venue_id === v.id))
                .map((v) => v.id)
            ),
          } satisfies PriorState,
          venues,
          allExhibitions,
          now
        )
      : bootstrapEvents(allExhibitions, now);
    console.log("\n[dry-run] no files written — venues/, snapshots/ left untouched.");
  } else {
    const { snapshot, newEvents: written } = writeCitySnapshot("nyc", venues, allExhibitions, allArticles, now);
    appendEvents(written, now);
    writeGlobalSnapshot(["nyc"], nexus, snapshot.coverage, now);
    newEvents = written;
  }

  report(venues, allExhibitions, allArticles, newEvents, suspects, blocked, resolveStats);
}

function report(
  venues: Venue[],
  exhibitions: Exhibition[],
  articles: Article[],
  events: MonitorEvent[],
  suspects: SuspectReport[],
  blocked: string[],
  resolveStats: ResolveStats
) {
  const lowConfidence = exhibitions.filter((e) => e.confidence < 0.7);
  const linked = articles.filter((a) => a.links.exhibition_id !== null);
  const ambiguous = articles.filter((a) => a.links.exhibition_id === null && a.links.venue_ids.length > 0);
  const staleDaysList = exhibitions
    .map((e) => (Date.now() - new Date(e.fetched_at).getTime()) / (24 * 60 * 60 * 1000))
    .sort((a, b) => a - b);
  const median = staleDaysList.length ? staleDaysList[Math.floor(staleDaysList.length / 2)] : 0;
  const adapterCounts = new Map<string, number>();
  for (const v of venues) {
    if (ADAPTERS[v.adapter]) adapterCounts.set(v.adapter, (adapterCounts.get(v.adapter) ?? 0) + 1);
  }

  console.log(`\n--- ${DRY_RUN ? "DRY-RUN " : ""}PHASE REPORT ---`);
  console.log(`Venues: ${venues.length} (` + [...adapterCounts.entries()].map(([a, c]) => `${a}=${c}`).join(", ") + ")");
  console.log(`Exhibitions: ${exhibitions.length} (${lowConfidence.length} below 0.7 confidence)`);
  console.log(
    `Articles: ${articles.length} (${linked.length} linked, ${ambiguous.length} ambiguous, ` +
      `${articles.length - linked.length - ambiguous.length} unlinked)`
  );
  console.log(
    `  resolution: tier1=${resolveStats.tier1} tier2=${resolveStats.tier2} tier3=${resolveStats.tier3} ` +
      `llm=${resolveStats.llm} ambiguous=${resolveStats.ambiguous} unlinked=${resolveStats.unlinked}`
  );
  console.log(`New events this run: ${events.length}`);
  console.log(`Median record staleness: ${median.toFixed(1)} day(s)`);
  console.log(`Suspect this run: ${suspects.length}${blocked.length ? `, blocked by robots.txt: ${blocked.length}` : ""}`);
  if (suspects.length) {
    console.log("\nSuspect venues (kept last-good, did not overwrite):");
    for (const s of suspects) console.log(`  ${s.id}: had ${s.had}, got ${s.got} — ${s.reason}`);
  }
  if (lowConfidence.length) {
    console.log("\nLow-confidence exhibitions:");
    for (const e of lowConfidence) console.log(`  ${e.confidence.toFixed(2)}  ${e.venue_id} — ${e.title}`);
  }
}

main();
