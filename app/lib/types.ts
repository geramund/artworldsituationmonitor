// Client-facing mirror of /types/index.ts (the pipeline's canonical model).
// Kept separate because app/ and the root pipeline are different deployable
// units; the wire contract is the snapshot JSON, not shared TS modules.

export type VenueKind =
  | "gallery"
  | "museum"
  | "institution"
  | "artist_run"
  | "nonprofit"
  | "fair_site";

export type HealthStatus = "unknown" | "ok" | "suspect" | "stale" | "blocked";

export interface Space {
  label: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface VenueHealth {
  last_attempt: string | null;
  last_success: string | null;
  record_count: number;
  consecutive_failures: number;
  status: HealthStatus;
}

export interface Venue {
  id: string;
  name: string;
  kind: VenueKind;
  city: string;
  district: string;
  url: string;
  spaces: Space[];
  adapter: string;
  config: Record<string, unknown>;
  paths: { exhibitions?: string; press?: string; news?: string };
  cadence: "daily" | "weekly" | "monthly";
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
  opens: string | null;
  closes: string | null;
  opening_reception: string | null;
  status: ExhibitionStatus;
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
  published: string;
  url: string;
  excerpt: string;
  links: ArticleLinks;
  link_confidence: number;
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
  // Not in the SPEC.md §8 model verbatim — added so the nexus layer has
  // somewhere to render a marker (fairground/venue centroid), resolved once
  // like any other space.
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
  ts: string;
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
  generated_at: string;
  city: string;
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

export type LayerId =
  | "openings"
  | "on_view"
  | "closing"
  | "institutions"
  | "artist_run"
  | "nexus"
  | "press"
  | "offsite"
  | "dark"
  | "coverage";

export type TimeRange = "24h" | "7d" | "30d" | "season";
