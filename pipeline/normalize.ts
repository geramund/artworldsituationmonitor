// RawExhibition -> Exhibition (SPEC.md pipeline layout). Refuses to guess:
// a raw record with no title is dropped rather than normalized into a blank
// entry, same discipline the adapter contract asks of `opens`/`closes`.

import { createHash } from "crypto";
import type { Venue, RawExhibition, Exhibition, ExhibitionStatus } from "../types/index.ts";

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

function exhibitionId(venueId: string, sourceUrl: string, title: string): string {
  const basis = sourceUrl || `${venueId}:${title}`;
  const hash = createHash("sha1").update(basis).digest("hex").slice(0, 10);
  return `ex-${venueId}-${hash}`;
}

export function normalizeExhibition(
  raw: RawExhibition,
  venue: Venue,
  now: Date = new Date()
): Exhibition | null {
  if (!raw.title) return null;
  const fetched_at = raw.fetched_at ?? now.toISOString();
  return {
    id: exhibitionId(venue.id, raw.source_url, raw.title),
    venue_id: venue.id,
    space_label: raw.space_label,
    title: raw.title,
    artists: raw.artists,
    kind: raw.kind ?? "group",
    opens: raw.opens,
    closes: raw.closes,
    opening_reception: raw.opening_reception ?? null,
    status: deriveStatus(raw.opens, raw.closes, now),
    excerpt: (raw.excerpt ?? raw.body ?? "").slice(0, 300),
    press_release_url: raw.press_release_url,
    image_urls: raw.image_urls,
    image_credit: raw.image_credit,
    works: raw.works,
    source_url: raw.source_url,
    fetched_at,
    confidence: raw.confidence,
  };
}
