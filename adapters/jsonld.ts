// JSON-LD adapter (SPEC.md §5.1 — "jsonld"). Some sites embed schema.org
// ExhibitionEvent/Event objects in a <script type="application/ld+json">
// block: real ISO start/end dates and a canonical URL per show, no HTML
// heuristics. Verified on davidzwirner.com/exhibitions (2026-10-07): one
// `@graph` with every current/upcoming show worldwide, each carrying a
// `location[].name` like "New York: 19th Street" / "London" — hence the
// per-venue `locations` filter so a multi-city gallery maps to just the
// spaces this venue entry covers.
//
// Config-driven like the other adapters: no `config.jsonld`, no attempt.

import type { Venue, RawExhibition, Adapter } from "../types/index.ts";
import { fetchHtmlPage } from "./html.ts";

interface JsonLdConfig {
  path: string;
  // Keep only events whose location name contains one of these (case-
  // insensitive). Unset: every event on the page.
  locations?: string[];
}

interface LdEvent {
  "@type"?: string | string[];
  name?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  image?: string | string[] | { url?: string };
  location?: LdPlace | LdPlace[];
  performer?: { name?: string } | { name?: string }[];
}
interface LdPlace {
  name?: string;
}

const EVENT_TYPES = new Set(["ExhibitionEvent", "Event", "VisualArtsEvent"]);

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function isEvent(node: LdEvent): boolean {
  return asArray(node["@type"]).some((t) => EVENT_TYPES.has(t));
}

// Every object reachable from the JSON-LD blocks — events can sit at the
// top level, in an array, or under `@graph`.
function collectEvents(html: string): LdEvent[] {
  const out: LdEvent[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      if (isEvent(node as LdEvent)) out.push(node as LdEvent);
      for (const v of Object.values(node)) if (typeof v === "object") walk(v);
    }
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]));
    } catch {
      /* one malformed block shouldn't sink the others */
    }
  }
  return out;
}

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

async function fetchJsonLd(venue: Venue): Promise<RawExhibition[]> {
  const config = (venue.config as { jsonld?: JsonLdConfig } | undefined)?.jsonld;
  if (!config) return [];
  const pageUrl = new URL(config.path, venue.url).toString();
  const html = await fetchHtmlPage(pageUrl);
  if (!html) return [];

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const wanted = config.locations?.map((l) => l.toLowerCase());
  const out: RawExhibition[] = [];
  const seen = new Set<string>();
  for (const ev of collectEvents(html)) {
    if (!ev.name) continue;
    const places = asArray(ev.location).map((p) => (p.name ?? "").toLowerCase());
    if (wanted && !places.some((p) => wanted.some((w) => p.includes(w)))) continue;

    const opens = isoDate(ev.startDate);
    const closes = isoDate(ev.endDate);
    if (closes ? closes < today : !opens) continue;

    const source_url = ev.url ? new URL(ev.url, pageUrl).toString() : pageUrl;
    if (seen.has(source_url)) continue;
    seen.add(source_url);

    const img = asArray(ev.image as string | string[] | { url?: string })
      .map((i) => (typeof i === "string" ? i : i.url))
      .filter((u): u is string => Boolean(u));
    out.push({
      title: ev.name.trim(),
      artists: asArray(ev.performer)
        .map((p) => p.name?.trim())
        .filter((n): n is string => Boolean(n)),
      opens,
      closes,
      space_label: null,
      excerpt: "",
      press_release_url: null,
      image_urls: img.slice(0, 1),
      image_credit: null,
      works: [],
      source_url,
      confidence: 0.85, // structured, first-party, ISO dates
      fetched_at: now.toISOString(),
    });
  }
  return out;
}

const jsonldAdapter: Adapter = { id: "jsonld", fetch: fetchJsonLd };
export default jsonldAdapter;
