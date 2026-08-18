// Canonical data model — SPEC.md §8. Shared shape between pipeline/ scripts
// and the app/ client (the client keeps its own mirror in app/lib/types.ts
// since it's a separate deployable unit; keep the two in sync by hand).

export type City = "nyc" | string;

export type VenueKind =
  | "gallery"
  | "museum"
  | "institution"
  | "artist_run"
  | "nonprofit"
  | "fair_site";

export type Cadence = "daily" | "weekly" | "monthly";

export type AdapterId =
  | "manual"
  | "sanity"
  | "artlogic"
  | "exhibite"
  | "nextdata"
  | "jsonld"
  | "wordpress"
  | "squarespace"
  | "sitemap"
  | "gallerypress"
  | "rss";

export type HealthStatus = "unknown" | "ok" | "suspect" | "stale" | "blocked";

export interface Space {
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface VenueHealth {
  last_attempt: string | null; // ISO timestamp
  last_success: string | null; // ISO timestamp
  record_count: number;
  consecutive_failures: number;
  status: HealthStatus;
}

export interface Venue {
  id: string;
  name: string;
  kind: VenueKind;
  city: City;
  district: string;
  url: string;
  spaces: Space[];
  adapter: AdapterId;
  config: Record<string, unknown>;
  paths: { exhibitions?: string; press?: string; news?: string };
  cadence: Cadence;
  hours: string;
  health: VenueHealth;
  notes: string;
}

export type ExhibitionKind =
  | "solo"
  | "two_person"
  | "group"
  | "screening"
  | "performance"
  | "offsite";

export type ExhibitionStatus = "upcoming" | "open" | "closing_soon" | "closed";

export interface Work {
  title: string;
  year: string;
}

export interface Exhibition {
  id: string;
  venue_id: string;
  space_label: string | null;
  title: string;
  artists: string[];
  kind: ExhibitionKind;
  opens: string | null; // ISO date
  closes: string | null; // ISO date
  opening_reception: string | null; // ISO datetime
  status: ExhibitionStatus; // derived at snapshot time, never stored raw upstream
  excerpt: string;
  press_release_url: string | null;
  image_urls: string[];
  image_credit: string | null;
  works: Work[];
  source_url: string;
  fetched_at: string;
  confidence: number;
}

export interface ArticleLinks {
  exhibition_id: string | null;
  venue_ids: string[];
  artist_names: string[];
}

export interface Article {
  id: string;
  outlet: string;
  headline: string;
  byline: string | null;
  published: string; // ISO
  url: string;
  excerpt: string;
  links: ArticleLinks;
  link_confidence: number; // 0 if unlinked
}

export type NexusKind = "biennial" | "triennial" | "fair" | "festival";

export interface Nexus {
  id: string;
  kind: NexusKind;
  name: string;
  edition: string;
  city: string;
  country: string;
  opens: string | null;
  closes: string | null;
  venue_ids: string[];
  url: string;
  // Not in SPEC.md §8 verbatim — added so the nexus layer has somewhere to
  // render a marker (fairground centroid), resolved once like any space.
  lat: number | null;
  lng: number | null;
}

export type EventType =
  | "ANNOUNCED"
  | "OPENED"
  | "CLOSING_SOON"
  | "CLOSED"
  | "EXTENDED"
  | "DOCUMENTATION_POSTED"
  | "PRESS_RELEASE_POSTED"
  | "CHECKLIST_POSTED"
  | "PRESS_ADDED"
  | "VENUE_DARK"
  | "VENUE_STALE";

export interface MonitorEvent {
  id: string;
  ts: string; // ISO
  type: EventType;
  venue_id: string | null;
  exhibition_id: string | null;
  article_id: string | null;
  payload: Record<string, unknown>;
}

export interface CoverageSummary {
  live: number;
  stale: number;
  dark: number;
  blocked: number;
  no_adapter: number;
}

export interface CitySnapshot {
  schema_version: string;
  generated_at: string; // ISO
  city: City;
  coverage: CoverageSummary;
  venues: Venue[];
  exhibitions: Exhibition[];
  articles: Article[];
}

export interface GlobalSnapshot {
  schema_version: string;
  generated_at: string;
  coverage: CoverageSummary;
  cities: string[];
  nexus: Nexus[];
}

export interface EventsSnapshot {
  schema_version: string;
  generated_at: string;
  window_days: number;
  events: MonitorEvent[];
}

// Adapter contract output (SPEC.md §5.2). `kind` and `opening_reception`
// aren't in the spec's literal interface but are cheap for a hand-curated
// source to know and useful for every other adapter too, so they live here
// as optional rather than being bolted onto just one adapter.
export interface RawExhibition {
  title: string | null;
  artists: string[];
  kind?: ExhibitionKind;
  opens: string | null;
  closes: string | null;
  opening_reception?: string | null;
  space_label: string | null;
  body?: string | null;
  excerpt?: string;
  press_release_url: string | null;
  image_urls: string[];
  image_credit: string | null;
  works: Work[];
  source_url: string;
  confidence: number;
  fetched_at?: string;
}

export interface Adapter {
  id: string;
  fetch(venue: Venue): Promise<RawExhibition[]>;
}

export const SCHEMA_VERSION = "1.0.0";
