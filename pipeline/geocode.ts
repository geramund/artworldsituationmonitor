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

// left,top,right,bottom (min-lon,max-lat,max-lon,min-lat) around NYC metro.
// Passed as an unbounded `viewbox` (bias, not a hard filter) so a genuinely
// odd address can still resolve outside it rather than coming back empty —
// see the plausibility check below for what catches a bad match instead.
const NYC_VIEWBOX = "-74.30,40.92,-73.65,40.48";
const NYC_CENTER = { lat: 40.7128, lng: -74.006 };

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Bug this guards against (found 2026-08-19): a plain free-text Nominatim
// query for "475 Tenth Avenue, New York, NY 10018" matched a same-named
// street in Colonie, Albany County — ~200km upstate — instead of Manhattan's
// West Side avenue, silently, with no signal anything had gone wrong. Four
// Chelsea venues (aca-galleries, michael-rosenfeld, nicola-vassell,
// sean-kelly) carried that wrong point for a day before a user spotted a
// marker sitting in Watervliet on the map. `viewbox` biases NYC-area lookups
// toward the right result; the distance check below is the backstop for
// when biasing still isn't enough — it warns loudly rather than silently
// accepting a result 200km from where it was asked to look.
async function geocodeOnce(
  address: string,
  viewbox?: string
): Promise<GeocodeCacheEntry | null> {
  const params = new URLSearchParams({ format: "json", limit: "1", q: address });
  if (viewbox) params.set("viewbox", viewbox);
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
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
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (viewbox === NYC_VIEWBOX) {
    const distanceKm = haversineKm(NYC_CENTER.lat, NYC_CENTER.lng, lat, lng);
    if (distanceKm > 75) {
      console.warn(
        `  SUSPECT geocode for "${address}": resolved ${Math.round(distanceKm)}km from NYC ` +
          `(${r.display_name}) — check by hand before trusting this point`
      );
    }
  }
  return {
    lat,
    lng,
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

async function resolve(
  address: string,
  cache: GeocodeCache,
  viewbox?: string
): Promise<GeocodeCacheEntry | null> {
  const key = normalizeAddress(address);
  if (key in cache && cache[key] !== null) return cache[key];
  console.log(`geocoding: ${address}`);
  let entry = await geocodeOnce(address, viewbox);
  cache[key] = entry;
  saveCache(cache);
  await sleep(1100); // stay under Nominatim's 1 req/sec ceiling with margin

  if (!entry) {
    const simplified = simplifyAddress(address);
    if (simplified) {
      const simplifiedKey = normalizeAddress(simplified);
      entry = simplifiedKey in cache ? cache[simplifiedKey] : await geocodeOnce(simplified, viewbox);
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
    const viewbox = venue.city === "nyc" ? NYC_VIEWBOX : undefined;
    for (const space of venue.spaces) {
      if (space.lat != null && space.lng != null) continue;
      if (!space.address) continue;
      const entry = await resolve(space.address, cache, viewbox);
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
