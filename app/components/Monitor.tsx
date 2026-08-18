"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type {
  CitySnapshot,
  GlobalSnapshot,
  EventsSnapshot,
  Exhibition,
  LayerId,
} from "@/lib/types";
import { parseState, serializeState, type MonitorState } from "@/lib/url";
import {
  deriveStatus,
  computeLayerCounts,
  computeActivityIndex,
  getAdjacentOpenVenues,
  venueAnchor,
} from "@/lib/derive";
import { useIsMobile } from "@/lib/useIsMobile";
import { withBasePath } from "@/lib/basePath";
import TopBar from "./TopBar";
import LeftRail from "./LeftRail";
import MapView from "./MapView";
import Ticker from "./Ticker";
import Dossier from "./Dossier";

const RANGE_DAYS: Record<MonitorState["range"], number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  season: 90,
};

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default function Monitor() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const [state, setState] = useState<MonitorState>(() => parseState(searchParams));
  const [citySnapshot, setCitySnapshot] = useState<CitySnapshot | null>(null);
  const [globalSnapshot, setGlobalSnapshot] = useState<GlobalSnapshot | null>(null);
  const [eventsSnapshot, setEventsSnapshot] = useState<EventsSnapshot | null>(null);
  const [showCoverage, setShowCoverage] = useState(true);
  // Starts open (matches SSR, which has no viewport to check — an initializer
  // keyed off `window` would disagree with the server-rendered HTML and trip
  // a hydration-mismatch error). Corrected to closed post-mount, once
  // `isMobile` resolves to true, via the effect below.
  const [leftRailOpen, setLeftRailOpen] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Correcting for a real viewport we only learn about post-mount (see the
    // leftRailOpen comment above) — not derivable at render time on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isMobile) setLeftRailOpen(false);
  }, [isMobile]);

  // Re-derive time-sensitive fields (status, days-remaining) every minute so
  // a long-open tab doesn't drift stale between crawls.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // URL is the source of truth on load; after that `state` drives the URL.
  useEffect(() => {
    const qs = serializeState(state);
    router.replace(`${pathname}?${qs}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    // Clear stale data immediately on city switch so the map doesn't show
    // the previous city's venues while the new snapshot is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCitySnapshot(null);
    fetchJSON<CitySnapshot>(withBasePath(`/snapshots/${state.city}.json`)).then(setCitySnapshot);
  }, [state.city]);

  useEffect(() => {
    fetchJSON<GlobalSnapshot>(withBasePath("/snapshots/global.json")).then(setGlobalSnapshot);
    fetchJSON<EventsSnapshot>(withBasePath("/snapshots/events.json")).then(setEventsSnapshot);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTyping = target && ["INPUT", "TEXTAREA"].includes(target.tagName);
      if (e.key === "/" && !isTyping) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
        }
        setState((s) => (s.venue ? { ...s, venue: null } : s));
      } else if ((e.key === "l" || e.key === "L") && !isTyping) {
        setLeftRailOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const exhibitionsByVenue = useMemo(() => {
    const map = new Map<string, Exhibition[]>();
    if (!citySnapshot) return map;
    for (const ex of citySnapshot.exhibitions) {
      const withStatus = { ...ex, status: deriveStatus(ex.opens, ex.closes, now) };
      const list = map.get(ex.venue_id) ?? [];
      list.push(withStatus);
      map.set(ex.venue_id, list);
    }
    return map;
  }, [citySnapshot, now]);

  const venuePressCount = useMemo(() => {
    const map = new Map<string, number>();
    if (!citySnapshot) return map;
    for (const a of citySnapshot.articles) {
      for (const vid of a.links.venue_ids) map.set(vid, (map.get(vid) ?? 0) + 1);
    }
    return map;
  }, [citySnapshot]);

  const venueHasOpenShow = useMemo(() => {
    const set = new Set<string>();
    for (const [vid, exs] of exhibitionsByVenue) {
      if (exs.some((e) => e.status === "open" || e.status === "closing_soon")) set.add(vid);
    }
    return set;
  }, [exhibitionsByVenue]);

  const matchingVenueIds = useMemo(() => {
    if (!state.q.trim() || !citySnapshot) return null;
    const q = state.q.toLowerCase();
    const ids = new Set<string>();
    for (const v of citySnapshot.venues) {
      if (v.name.toLowerCase().includes(q)) ids.add(v.id);
    }
    for (const ex of citySnapshot.exhibitions) {
      if (
        ex.title.toLowerCase().includes(q) ||
        ex.artists.some((a) => a.toLowerCase().includes(q))
      ) {
        ids.add(ex.venue_id);
      }
    }
    return ids;
  }, [state.q, citySnapshot]);

  const visibleVenues = useMemo(() => {
    if (!citySnapshot) return [];
    if (!matchingVenueIds) return citySnapshot.venues;
    return citySnapshot.venues.filter((v) => matchingVenueIds.has(v.id));
  }, [citySnapshot, matchingVenueIds]);

  const activeLayers = useMemo(() => new Set<LayerId>(state.layers), [state.layers]);

  const layerCounts = useMemo(() => {
    const counts = computeLayerCounts(visibleVenues, exhibitionsByVenue, venuePressCount);
    counts.nexus = globalSnapshot?.nexus?.length ?? 0;
    return counts;
  }, [visibleVenues, exhibitionsByVenue, venuePressCount, globalSnapshot]);

  const districtCentroids = useMemo(() => {
    const sums = new Map<string, { lat: number; lng: number; n: number }>();
    for (const v of citySnapshot?.venues ?? []) {
      const p = venueAnchor(v);
      if (!p) continue;
      const entry = sums.get(v.district) ?? { lat: 0, lng: 0, n: 0 };
      entry.lat += p.lat;
      entry.lng += p.lng;
      entry.n += 1;
      sums.set(v.district, entry);
    }
    const out = new Map<string, { lat: number; lng: number }>();
    for (const [district, s] of sums) out.set(district, { lat: s.lat / s.n, lng: s.lng / s.n });
    return out;
  }, [citySnapshot]);

  const activity = useMemo(
    () =>
      citySnapshot
        ? computeActivityIndex(citySnapshot.venues, citySnapshot.exhibitions, venuePressCount, now)
        : [],
    [citySnapshot, venuePressCount, now]
  );

  const venueById = useMemo(
    () => new Map((citySnapshot?.venues ?? []).map((v) => [v.id, v])),
    [citySnapshot]
  );
  const exhibitionById = useMemo(() => {
    const map = new Map<string, Exhibition>();
    for (const list of exhibitionsByVenue.values()) for (const e of list) map.set(e.id, e);
    return map;
  }, [exhibitionsByVenue]);

  const selectedVenue = state.venue ? (venueById.get(state.venue) ?? null) : null;
  const selectedExhibitions = selectedVenue ? (exhibitionsByVenue.get(selectedVenue.id) ?? []) : [];
  const selectedArticles = useMemo(() => {
    if (!selectedVenue || !citySnapshot) return [];
    const exIds = new Set(selectedExhibitions.map((e) => e.id));
    return citySnapshot.articles.filter(
      (a) =>
        a.links.venue_ids.includes(selectedVenue.id) ||
        (a.links.exhibition_id && exIds.has(a.links.exhibition_id))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVenue, citySnapshot]);
  const adjacent = useMemo(
    () =>
      selectedVenue && citySnapshot
        ? getAdjacentOpenVenues(selectedVenue, citySnapshot.venues, venueHasOpenShow, 400)
        : [],
    [selectedVenue, citySnapshot, venueHasOpenShow]
  );

  const tickerEvents = useMemo(() => {
    if (!eventsSnapshot) return [];
    const days = RANGE_DAYS[state.range];
    const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
    return eventsSnapshot.events
      .filter((e) => new Date(e.ts).getTime() >= cutoff)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .map((e) => {
        const venue = e.venue_id ? venueById.get(e.venue_id) : null;
        const ex = e.exhibition_id ? exhibitionById.get(e.exhibition_id) : null;
        const headline =
          typeof e.payload?.headline === "string" ? (e.payload.headline as string) : null;
        const label = [venue?.name, ex?.title].filter(Boolean).join(" — ") || headline || "—";
        return { ...e, label };
      });
  }, [eventsSnapshot, state.range, now, venueById, exhibitionById]);

  const cities = globalSnapshot?.cities?.length
    ? globalSnapshot.cities.map((c) => ({ id: c, label: c.toUpperCase() }))
    : [{ id: "nyc", label: "NYC" }];

  return (
    <div className="flex h-screen w-screen flex-col" style={{ background: "var(--ground)" }}>
      <TopBar
        range={state.range}
        onRangeChange={(range) => setState((s) => ({ ...s, range }))}
        query={state.q}
        onQueryChange={(q) => setState((s) => ({ ...s, q }))}
        lastSync={citySnapshot?.generated_at ?? null}
        searchInputRef={searchInputRef}
        onToggleLeftRail={() => setLeftRailOpen((v) => !v)}
      />
      <div className="relative flex min-h-0 flex-1">
        {leftRailOpen && isMobile && (
          <button
            aria-label="Close layers"
            onClick={() => setLeftRailOpen(false)}
            className="absolute inset-0 z-10"
            style={{ background: "rgba(0,0,0,0.5)" }}
          />
        )}
        {leftRailOpen && (
          <div className={isMobile ? "absolute inset-y-0 left-0 z-20" : "relative"}>
            <LeftRail
              activeLayers={activeLayers}
              onToggleLayer={(id) =>
                setState((s) => ({
                  ...s,
                  layers: s.layers.includes(id)
                    ? s.layers.filter((l) => l !== id)
                    : [...s.layers, id],
                }))
              }
              counts={layerCounts}
              coverage={citySnapshot?.coverage ?? { live: 0, stale: 0, dark: 0, blocked: 0, no_adapter: 0 }}
              city={state.city}
              cities={cities}
              onCityChange={(city) => setState((s) => ({ ...s, city, venue: null }))}
              showCoverage={showCoverage}
              onToggleCoverage={() => setShowCoverage((v) => !v)}
            />
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          {citySnapshot ? (
            <MapView
              venues={visibleVenues}
              exhibitionsByVenue={exhibitionsByVenue}
              nexus={globalSnapshot?.nexus ?? []}
              activeLayers={activeLayers}
              selectedVenueId={state.venue}
              onSelectVenue={(id) => setState((s) => ({ ...s, venue: id }))}
              venueHasOpenShow={venueHasOpenShow}
              venuePressCount={venuePressCount}
              activity={activity}
              districtCentroids={districtCentroids}
              center={{ lat: state.lat, lng: state.lng }}
              zoom={state.zoom}
              onViewChange={(center, zoom) =>
                setState((s) => ({ ...s, lat: center.lat, lng: center.lng, zoom }))
              }
            />
          ) : (
            <div
              className="mono flex h-full w-full items-center justify-center text-[11px]"
              style={{ color: "var(--paper-dim)" }}
            >
              SYNCHRONIZING {state.city.toUpperCase()}…
            </div>
          )}
        </div>
        {selectedVenue && (
          <Dossier
            venue={selectedVenue}
            exhibitions={selectedExhibitions}
            articles={selectedArticles}
            adjacent={adjacent}
            onClose={() => setState((s) => ({ ...s, venue: null }))}
            onSelectVenue={(id) => setState((s) => ({ ...s, venue: id }))}
          />
        )}
      </div>
      <Ticker events={tickerEvents} onSelectVenue={(id) => setState((s) => ({ ...s, venue: id }))} />
    </div>
  );
}
