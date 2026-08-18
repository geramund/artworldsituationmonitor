import type { Exhibition, ExhibitionStatus, Venue, LayerId } from "./types";

/**
 * status is derived, never stored raw (SPEC.md §8). The pipeline bakes a
 * value into the snapshot at crawl time, but the client recomputes it against
 * the viewer's actual clock so "closing in 3 days" stays true between crawls.
 */
export function deriveStatus(
  opens: string | null,
  closes: string | null,
  now: Date = new Date()
): ExhibitionStatus {
  const opensAt = opens ? new Date(opens) : null;
  const closesAt = closes ? new Date(closes) : null;

  if (opensAt && now < opensAt) return "upcoming";
  if (closesAt) {
    const msRemaining = closesAt.getTime() - now.getTime();
    if (msRemaining < 0) return "closed";
    if (msRemaining <= 7 * 24 * 60 * 60 * 1000) return "closing_soon";
  }
  return "open";
}

export function daysUntil(dateStr: string | null, now: Date = new Date()): number | null {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const ms = target.getTime() - now.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/** Great-circle distance in meters (haversine). */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** A venue's first geocoded space, used as its map anchor. */
export function venueAnchor(venue: Venue): GeoPoint | null {
  const space = venue.spaces.find((s) => s.lat != null && s.lng != null);
  if (!space || space.lat == null || space.lng == null) return null;
  return { lat: space.lat, lng: space.lng };
}

export interface DistrictActivity {
  district: string;
  openings: number;
  closings: number;
  press: number;
  score: number; // normalized 0-1 within the current result set
}

/**
 * Openings + closings + press mentions, normalized per district per week.
 * No invented threat level — this is the one heat-wash signal the spec asks
 * for (§10), and it is entirely a function of real counts.
 */
export function computeActivityIndex(
  venues: Venue[],
  exhibitions: Exhibition[],
  pressCountByVenueId: Map<string, number>,
  now: Date = new Date()
): DistrictActivity[] {
  const venueDistrict = new Map(venues.map((v) => [v.id, v.district]));
  const byDistrict = new Map<string, { openings: number; closings: number; press: number }>();

  const bump = (district: string | undefined, key: "openings" | "closings" | "press") => {
    if (!district) return;
    const entry = byDistrict.get(district) ?? { openings: 0, closings: 0, press: 0 };
    entry[key] += 1;
    byDistrict.set(district, entry);
  };

  for (const ex of exhibitions) {
    const district = venueDistrict.get(ex.venue_id);
    const opensIn = daysUntil(ex.opens, now);
    const closesIn = daysUntil(ex.closes, now);
    if (opensIn != null && opensIn >= -7 && opensIn <= 7) bump(district, "openings");
    if (closesIn != null && closesIn >= -7 && closesIn <= 7) bump(district, "closings");
  }

  for (const [venueId, count] of pressCountByVenueId) {
    const district = venueDistrict.get(venueId);
    if (!district) continue;
    const entry = byDistrict.get(district) ?? { openings: 0, closings: 0, press: 0 };
    entry.press += count;
    byDistrict.set(district, entry);
  }

  const raw = Array.from(byDistrict.entries()).map(([district, v]) => ({
    district,
    ...v,
    total: v.openings + v.closings + v.press,
  }));
  const max = Math.max(1, ...raw.map((r) => r.total));

  return raw.map((r) => ({
    district: r.district,
    openings: r.openings,
    closings: r.closings,
    press: r.press,
    score: r.total / max,
  }));
}

export function withinMeters(
  a: GeoPoint,
  b: GeoPoint,
  meters: number
): boolean {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) <= meters;
}

export interface AdjacentVenue {
  venue: Venue;
  distanceMeters: number;
}

/**
 * The signature "walkable cluster" feature (§11): venues within `meters` of
 * the selected venue that currently have something open. A night's walking
 * route.
 */
export function getAdjacentOpenVenues(
  selected: Venue,
  venues: Venue[],
  venueHasOpenShow: Set<string>,
  meters = 400
): AdjacentVenue[] {
  const origin = venueAnchor(selected);
  if (!origin) return [];

  const out: AdjacentVenue[] = [];
  for (const v of venues) {
    if (v.id === selected.id) continue;
    if (!venueHasOpenShow.has(v.id)) continue;
    const point = venueAnchor(v);
    if (!point) continue;
    const distanceMeters = haversineMeters(origin.lat, origin.lng, point.lat, point.lng);
    if (distanceMeters <= meters) out.push({ venue: v, distanceMeters });
  }
  return out.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Venue counts per togglable layer, for the left-rail badges. */
export function computeLayerCounts(
  venues: Venue[],
  exhibitionsByVenue: Map<string, Exhibition[]>,
  venuePressCount: Map<string, number>
): Record<LayerId, number> {
  const counts: Record<LayerId, number> = {
    openings: 0,
    on_view: 0,
    closing: 0,
    institutions: 0,
    artist_run: 0,
    nexus: 0,
    press: 0,
    offsite: 0,
    dark: 0,
    coverage: 0,
  };

  for (const venue of venues) {
    const exhibitions = exhibitionsByVenue.get(venue.id) ?? [];
    const isDark = exhibitions.length === 0;
    if (isDark) counts.dark += 1;
    if (exhibitions.some((e) => e.status === "upcoming")) counts.openings += 1;
    if (exhibitions.some((e) => e.status === "open" || e.status === "closing_soon"))
      counts.on_view += 1;
    if (exhibitions.some((e) => e.status === "closing_soon")) counts.closing += 1;
    if (exhibitions.some((e) => e.kind === "offsite")) counts.offsite += 1;
    if (venue.kind === "museum" || venue.kind === "institution") counts.institutions += 1;
    if (venue.kind === "artist_run" || venue.kind === "nonprofit") counts.artist_run += 1;
    if ((venuePressCount.get(venue.id) ?? 0) > 0) counts.press += 1;
  }
  return counts;
}

/** Freshness-based marker opacity: full at 0 days old, floor at ~90 days. */
export function recencyOpacity(fetchedAt: string, now: Date = new Date()): number {
  const ageDays = (now.getTime() - new Date(fetchedAt).getTime()) / (24 * 60 * 60 * 1000);
  const floor = 0.4;
  const decayDays = 90;
  const t = Math.min(1, Math.max(0, ageDays / decayDays));
  return 1 - t * (1 - floor);
}
