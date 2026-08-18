// Versioned JSON bundles, per city and global (SPEC.md §9). The diff between
// commits of these files *is* the event log — no separate changelog table.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { diffEvents, bootstrapEvents, type PriorState } from "./diff.ts";
import type {
  Venue,
  Exhibition,
  Article,
  Nexus,
  CitySnapshot,
  GlobalSnapshot,
  EventsSnapshot,
  MonitorEvent,
} from "../types/index.ts";
import { SCHEMA_VERSION } from "../types/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SNAPSHOTS_DIR = join(ROOT, "snapshots");
const EVENTS_WINDOW_DAYS = 90;

function readJSONIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function computeCoverage(venues: Venue[], exhibitionsByVenue: Map<string, Exhibition[]>) {
  const coverage = { live: 0, stale: 0, dark: 0, blocked: 0, no_adapter: 0 };
  for (const v of venues) {
    if (v.health.status === "ok") coverage.live += 1;
    else if (v.health.status === "stale") coverage.stale += 1;
    else if (v.health.status === "blocked") coverage.blocked += 1;
    else if (v.health.status === "unknown") coverage.no_adapter += 1;
    if ((exhibitionsByVenue.get(v.id) ?? []).length === 0) coverage.dark += 1;
  }
  return coverage;
}

export function writeCitySnapshot(
  city: string,
  venues: Venue[],
  exhibitions: Exhibition[],
  articles: Article[],
  now: Date = new Date()
): { snapshot: CitySnapshot; newEvents: MonitorEvent[] } {
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  const exhibitionsByVenue = new Map<string, Exhibition[]>();
  for (const ex of exhibitions) {
    exhibitionsByVenue.set(ex.venue_id, [...(exhibitionsByVenue.get(ex.venue_id) ?? []), ex]);
  }

  const path = join(SNAPSHOTS_DIR, `${city}.json`);
  const prior = readJSONIfExists<CitySnapshot>(path);

  let newEvents: MonitorEvent[];
  if (!prior) {
    newEvents = bootstrapEvents(exhibitions, now);
  } else {
    const priorState: PriorState = {
      exhibitionsById: new Map(prior.exhibitions.map((e) => [e.id, e])),
      venuesWithShowsIds: new Set(
        prior.venues
          .filter((v) => prior.exhibitions.some((e) => e.venue_id === v.id))
          .map((v) => v.id)
      ),
    };
    newEvents = diffEvents(priorState, venues, exhibitions, now);
  }

  const snapshot: CitySnapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    city,
    coverage: computeCoverage(venues, exhibitionsByVenue),
    venues,
    exhibitions,
    articles,
  };
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
  return { snapshot, newEvents };
}

export function writeGlobalSnapshot(cities: string[], nexus: Nexus[], coverage: GlobalSnapshot["coverage"], now: Date = new Date()) {
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshot: GlobalSnapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    coverage,
    cities,
    nexus,
  };
  writeFileSync(join(SNAPSHOTS_DIR, "global.json"), JSON.stringify(snapshot, null, 2) + "\n");
}

export function appendEvents(newEvents: MonitorEvent[], now: Date = new Date()) {
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const path = join(SNAPSHOTS_DIR, "events.json");
  const prior = readJSONIfExists<EventsSnapshot>(path);
  const cutoff = now.getTime() - EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const priorEvents = (prior?.events ?? []).filter((e) => new Date(e.ts).getTime() >= cutoff);
  const seen = new Set(priorEvents.map((e) => `${e.type}:${e.venue_id}:${e.exhibition_id}:${e.ts}`));
  const merged = [...priorEvents];
  for (const e of newEvents) {
    const key = `${e.type}:${e.venue_id}:${e.exhibition_id}:${e.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  const snapshot: EventsSnapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    window_days: EVENTS_WINDOW_DAYS,
    events: merged,
  };
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}
