// Lists every venue on the manual adapter that has real hand-entered
// exhibition data in registry/manual/{id}.json — i.e. the ones that will
// silently go stale, since adapters/manual.ts is a static read the crawl
// never re-fetches (SPEC.md §14.3). Run this periodically and re-check
// whatever it prints; a manual venue with an EMPTY registry/manual file (or
// none at all) isn't listed here since there's nothing in it to go stale —
// it's just dark until either a real adapter or an initial manual pass.
//
// Usage: npm run manual-status

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Venue, RawExhibition } from "../types/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const VENUES_DIR = join(ROOT, "registry/venues");
const MANUAL_DIR = join(ROOT, "registry/manual");

function loadVenues(): Venue[] {
  return readdirSync(VENUES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(VENUES_DIR, f), "utf8")) as Venue);
}

function main() {
  const venues = loadVenues().filter((v) => v.adapter === "manual");
  const populated: { venue: Venue; count: number }[] = [];

  for (const venue of venues) {
    const path = join(MANUAL_DIR, `${venue.id}.json`);
    if (!existsSync(path)) continue;
    const records = JSON.parse(readFileSync(path, "utf8")) as RawExhibition[];
    if (records.length > 0) populated.push({ venue, count: records.length });
  }

  populated.sort((a, b) => b.count - a.count);

  console.log(`${populated.length} manual-adapter venue(s) with hand-entered data (will go stale):\n`);
  for (const { venue, count } of populated) {
    console.log(`  ${venue.name.padEnd(40)} ${String(count).padStart(2)} record(s)  registry/manual/${venue.id}.json`);
  }

  const emptyOrMissing = venues.length - populated.length;
  console.log(`\n${emptyOrMissing} other manual-adapter venue(s) have no data yet (empty or missing manual file) — nothing to go stale there.`);
}

main();
