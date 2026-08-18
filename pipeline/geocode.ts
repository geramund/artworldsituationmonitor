// Resolves every registry space's address to lat/lng via Nominatim, once,
// and caches forever (SPEC.md §4, §14.5). Safe to re-run: already-cached
// addresses are never re-requested, and only genuinely new addresses cost a
// network round trip, sequential at <=1 req/sec per Nominatim's usage policy.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Venue, Nexus } from "../types/index.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const VENUES_DIR = join(ROOT, "registry/venues");
const NEXUS_PATH = join(ROOT, "registry/nexus.json");
const CACHE_PATH = join(ROOT, "registry/geocode-cache.json");
const CONTACT_EMAIL = "anastasios.karnazes@gmail.com";
const USER_AGENT = `ArtWorldSituationMonitor/0.1 (contact: ${CONTACT_EMAIL})`;

interface GeocodeCacheEntry {
  lat: number;
  lng: number;
  display_name: string;
  fetched_at: string;
}
type GeocodeCache = Record<string, GeocodeCacheEntry | null>;

function loadCache(): GeocodeCache {
  if (!existsSync(CACHE_PATH)) return {};
  return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
}

function saveCache(cache: GeocodeCache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeOnce(address: string): Promise<GeocodeCacheEntry | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    console.warn(`  geocode HTTP ${res.status} for "${address}"`);
    return null;
  }
  const results = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!results.length) {
    console.warn(`  no geocode result for "${address}"`);
    return null;
  }
  const r = results[0];
  return {
    lat: Number(r.lat),
    lng: Number(r.lon),
    display_name: r.display_name,
    fetched_at: new Date().toISOString(),
  };
}

// Nominatim frequently can't match a floor/suite/room qualifier appended to
// an otherwise-good street address. Strip it and retry once before giving up
// — the building-level point is still correct for a map marker.
function simplifyAddress(address: string): string | null {
  const simplified = address
    .replace(
      /,?\s*(?:\d+(?:st|nd|rd|th)?\s*floor|floor\s*\d+|\d+(?:st|nd|rd|th)?\s*fl\.?|suite\s*\S+|ste\.?\s*\S+|unit\s*\S+|room\s*\S+|apt\.?\s*\S+|#\S+|\b[0-9]{1,3}[A-Z]\b|lower level)/gi,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();
  return simplified !== address ? simplified : null;
}

async function resolve(address: string, cache: GeocodeCache): Promise<GeocodeCacheEntry | null> {
  const key = normalizeAddress(address);
  if (key in cache && cache[key] !== null) return cache[key];
  console.log(`geocoding: ${address}`);
  let entry = await geocodeOnce(address);
  cache[key] = entry;
  saveCache(cache);
  await sleep(1100); // stay under Nominatim's 1 req/sec ceiling with margin

  if (!entry) {
    const simplified = simplifyAddress(address);
    if (simplified) {
      const simplifiedKey = normalizeAddress(simplified);
      entry = simplifiedKey in cache ? cache[simplifiedKey] : await geocodeOnce(simplified);
      if (!(simplifiedKey in cache)) {
        cache[simplifiedKey] = entry;
        await sleep(1100);
      }
      if (entry) {
        console.log(`  resolved via simplified address: "${simplified}"`);
        cache[key] = entry; // cache the fallback under the original key too
      }
      saveCache(cache);
    }
  }
  return entry;
}

async function main() {
  const cache = loadCache();
  let resolvedCount = 0;
  let missCount = 0;

  const venueFiles = readdirSync(VENUES_DIR).filter((f) => f.endsWith(".json"));
  for (const file of venueFiles) {
    const path = join(VENUES_DIR, file);
    const venue = JSON.parse(readFileSync(path, "utf8")) as Venue;
    let changed = false;
    for (const space of venue.spaces) {
      if (space.lat != null && space.lng != null) continue;
      if (!space.address) continue;
      const entry = await resolve(space.address, cache);
      if (entry) {
        space.lat = entry.lat;
        space.lng = entry.lng;
        changed = true;
        resolvedCount++;
      } else {
        missCount++;
      }
    }
    if (changed) writeFileSync(path, JSON.stringify(venue, null, 2) + "\n");
  }

  if (existsSync(NEXUS_PATH)) {
    const nexusList = JSON.parse(readFileSync(NEXUS_PATH, "utf8")) as Nexus[];
    let nexusChanged = false;
    for (const n of nexusList) {
      if (n.lat != null && n.lng != null) continue;
      const address = (n as unknown as { fairground_address?: string }).fairground_address;
      if (!address) continue;
      const entry = await resolve(address, cache);
      if (entry) {
        n.lat = entry.lat;
        n.lng = entry.lng;
        nexusChanged = true;
        resolvedCount++;
      } else {
        missCount++;
      }
    }
    if (nexusChanged) writeFileSync(NEXUS_PATH, JSON.stringify(nexusList, null, 2) + "\n");
  }

  console.log(`\nGeocoding done. Resolved ${resolvedCount} space(s), ${missCount} miss(es).`);
  console.log(`Cache: ${CACHE_PATH} (${Object.keys(cache).length} addresses)`);
}

main();
