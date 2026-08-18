// Hand-curated records. Authoritative, never overwritten by the crawl loop
// (SPEC.md §14.3) — records live in registry/manual/{venue_id}.json,
// separate from venue metadata in registry/venues/, so nothing else in the
// pipeline can accidentally clobber them.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Venue, RawExhibition, Adapter } from "../types/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const MANUAL_DIR = join(ROOT, "registry/manual");

async function fetchManual(venue: Venue): Promise<RawExhibition[]> {
  const path = join(MANUAL_DIR, `${venue.id}.json`);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as RawExhibition[];
}

const manualAdapter: Adapter = { id: "manual", fetch: fetchManual };
export default manualAdapter;
