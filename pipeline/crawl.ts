// The loop (SPEC.md §6). Phase 1 has exactly one working adapter — manual —
// plus outlet RSS for the ticker; no scraping adapters exist yet, so
// plausible()/suspect-handling has nothing real to guard against this run.
// It's still structured the way the pseudocode describes so Phase 2 adapters
// slot in without restructuring this file.

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import manualAdapter from "../adapters/manual.ts";
import { fetchOutletArticles, type OutletConfig } from "../adapters/rss.ts";
import { normalizeExhibition } from "./normalize.ts";
import { writeCitySnapshot, writeGlobalSnapshot, appendEvents } from "./snapshot.ts";
import type { Venue, Exhibition, Article, Nexus, MonitorEvent } from "../types/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const VENUES_DIR = join(ROOT, "registry/venues");
const OUTLETS_PATH = join(ROOT, "registry/outlets.json");
const NEXUS_PATH = join(ROOT, "registry/nexus.json");

function loadVenues(): Venue[] {
  return readdirSync(VENUES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(VENUES_DIR, f), "utf8")) as Venue);
}

function saveVenue(venue: Venue) {
  writeFileSync(join(VENUES_DIR, `${venue.id}.json`), JSON.stringify(venue, null, 2) + "\n");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const now = new Date();
  const venues = loadVenues();
  const allExhibitions: Exhibition[] = [];

  for (const venue of venues) {
    if (venue.adapter !== "manual") continue; // only adapter implemented so far
    const raw = await manualAdapter.fetch(venue);
    const exhibitions = raw
      .map((r) => normalizeExhibition(r, venue, now))
      .filter((e): e is Exhibition => e !== null);
    allExhibitions.push(...exhibitions);

    venue.health = {
      last_attempt: now.toISOString(),
      last_success: now.toISOString(),
      record_count: exhibitions.length,
      consecutive_failures: 0,
      status: "ok",
    };
    saveVenue(venue);
  }

  const outlets = JSON.parse(readFileSync(OUTLETS_PATH, "utf8")) as OutletConfig[];
  const allArticles: Article[] = [];
  for (const outlet of outlets) {
    const articles = await fetchOutletArticles(outlet);
    allArticles.push(...articles);
    console.log(`[rss] ${outlet.id}: ${articles.length} article(s)`);
    await sleep(300);
  }

  const nexus = JSON.parse(readFileSync(NEXUS_PATH, "utf8")) as Nexus[];

  const { snapshot, newEvents } = writeCitySnapshot("nyc", venues, allExhibitions, allArticles, now);
  appendEvents(newEvents, now);
  writeGlobalSnapshot(["nyc"], nexus, snapshot.coverage, now);

  report(venues, allExhibitions, allArticles, newEvents);
}

function report(venues: Venue[], exhibitions: Exhibition[], articles: Article[], events: MonitorEvent[]) {
  const lowConfidence = exhibitions.filter((e) => e.confidence < 0.7);
  const linked = articles.filter((a) => a.links.exhibition_id || a.links.venue_ids.length > 0);
  const staleDaysList = exhibitions
    .map((e) => (Date.now() - new Date(e.fetched_at).getTime()) / (24 * 60 * 60 * 1000))
    .sort((a, b) => a - b);
  const median = staleDaysList.length
    ? staleDaysList[Math.floor(staleDaysList.length / 2)]
    : 0;

  console.log("\n--- PHASE REPORT ---");
  console.log(`Venues: ${venues.length}`);
  console.log(`Exhibitions: ${exhibitions.length} (${lowConfidence.length} below 0.7 confidence)`);
  console.log(`Articles: ${articles.length} (${linked.length} linked, ${articles.length - linked.length} unlinked)`);
  console.log(`New events this run: ${events.length}`);
  console.log(`Median record staleness: ${median.toFixed(1)} day(s)`);
  if (lowConfidence.length) {
    console.log("\nLow-confidence exhibitions:");
    for (const e of lowConfidence) console.log(`  ${e.confidence.toFixed(2)}  ${e.venue_id} — ${e.title}`);
  }
}

main();
