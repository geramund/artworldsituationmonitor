"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, Marker, LngLatBounds } from "maplibre-gl";
import type { Venue, Exhibition, Nexus, LayerId } from "@/lib/types";
import {
  venueAnchor,
  recencyOpacity,
  getAdjacentOpenVenues,
  type DistrictActivity,
} from "@/lib/derive";

const BASEMAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Turbopack doesn't bundle maplibre-gl's `new Worker(new URL(...))` pattern
// correctly (the worker's import of its maplibre-gl-shared.mjs sibling fails
// silently, so tiles never get requested and the map stays blank). Serving
// both files from public/ and pointing setWorkerUrl at them sidesteps
// Turbopack's worker bundling entirely. See scripts/copy-maplibre-worker.mjs.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const PALETTE = {
  orange: "#c8511b",
  red: "#b4121b",
  blue: "#4c6fa5",
  dim: "#5a5f5f",
  paper: "#e8e4da",
};

function markerColor(status: string | null): string {
  if (status === "closing_soon") return PALETTE.red;
  if (status === "open" || status === "upcoming") return PALETTE.orange;
  return PALETTE.dim;
}

// `rotate` is degrees for maplibregl.Marker's own setRotation() — NOT a CSS
// transform. MapLibre positions markers by writing its own `translate(...)`
// into el.style.transform on every map render; setting that property
// ourselves (even to layer in a rotation) clobbers the position the instant
// our code runs after MapLibre's, and nothing then fixes it on a static,
// non-interacted page. setRotation() is the API built for this — MapLibre
// composes it with its own translate internally instead of us touching the
// same style property.
function shapeFor(kind: Venue["kind"]): { clip?: string; rotate?: number; radius?: string } {
  switch (kind) {
    case "museum":
      return { rotate: 45 }; // diamond, bigger via size
    case "institution":
      return { rotate: 45 };
    case "artist_run":
    case "nonprofit":
      return { radius: "50%" };
    case "fair_site":
      return { clip: "polygon(50% 0%, 0% 100%, 100% 100%)" }; // triangle
    default:
      return {}; // gallery: square
  }
}

function buildPreviewContent(venue: Venue, ex: Exhibition): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.style.width = "160px";

  const image = ex.image_urls[0];
  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = ex.image_credit || ex.title;
    img.style.display = "block";
    img.style.width = "160px";
    img.style.height = "110px";
    img.style.objectFit = "cover";
    img.onerror = () => {
      img.style.display = "none";
    };
    wrap.appendChild(img);
  }

  const body = document.createElement("div");
  body.style.padding = "6px 8px";

  const venueLabel = document.createElement("div");
  venueLabel.textContent = venue.name.toUpperCase();
  venueLabel.style.font = "10px var(--font-mono)";
  venueLabel.style.letterSpacing = "0.06em";
  venueLabel.style.color = "var(--paper-dim)";
  body.appendChild(venueLabel);

  const title = document.createElement("div");
  title.textContent = ex.title;
  title.style.font = "italic 400 13px var(--font-serif)";
  title.style.color = "var(--paper)";
  title.style.marginTop = "2px";
  title.style.lineHeight = "1.25";
  body.appendChild(title);

  if (ex.image_credit) {
    const credit = document.createElement("div");
    credit.textContent = ex.image_credit;
    credit.style.font = "9px var(--font-mono)";
    credit.style.color = "var(--dim)";
    credit.style.marginTop = "3px";
    body.appendChild(credit);
  }

  wrap.appendChild(body);
  return wrap;
}

// Sets the marker's visual state on an EXISTING element. Kept separate from
// element creation so re-styling (e.g. on selection change) never replaces
// the DOM node — swapping the node out from under the cursor fires a
// spurious mouseleave that was silently killing the hover preview the
// instant a click also tried to show it.
function applyMarkerVisualState(
  el: HTMLDivElement,
  venue: Venue,
  status: string | null,
  opacity: number,
  hasPress: boolean,
  selected: boolean
) {
  const size = venue.kind === "museum" ? 14 : 10;
  const shape = shapeFor(venue.kind);
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.background = markerColor(status);
  el.style.opacity = String(opacity);
  el.style.boxSizing = "border-box";
  // NOTE: transform is deliberately untouched here — see the comment above.
  el.style.borderRadius = shape.radius ?? "";
  el.style.clipPath = shape.clip ?? "";
  el.style.border = selected
    ? `2px solid ${PALETTE.paper}`
    : hasPress
      ? `1px solid ${PALETTE.blue}`
      : "1px solid rgba(0,0,0,0.4)";
  el.style.boxShadow = selected ? `0 0 0 4px rgba(232,228,218,0.15)` : "";
}

function buildMarkerEl(venue: Venue): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cursor = "pointer";
  el.setAttribute("aria-label", venue.name);
  el.setAttribute("tabindex", "0");
  el.setAttribute("role", "button");
  return el;
}

function buildNexusEl(nexus: Nexus): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = "0";
  el.style.height = "0";
  el.style.borderLeft = "6px solid transparent";
  el.style.borderRight = "6px solid transparent";
  el.style.borderBottom = `10px solid ${PALETTE.blue}`;
  el.style.cursor = "pointer";
  el.setAttribute("aria-label", nexus.name);
  return el;
}

export interface MapViewProps {
  venues: Venue[];
  exhibitionsByVenue: Map<string, Exhibition[]>;
  nexus: Nexus[];
  activeLayers: Set<LayerId>;
  selectedVenueId: string | null;
  onSelectVenue: (id: string | null) => void;
  venueHasOpenShow: Set<string>;
  venuePressCount: Map<string, number>;
  activity: DistrictActivity[];
  districtCentroids: Map<string, { lat: number; lng: number }>;
  center: { lat: number; lng: number };
  zoom: number;
  onViewChange: (center: { lat: number; lng: number }, zoom: number) => void;
}

export default function MapView({
  venues,
  exhibitionsByVenue,
  nexus,
  activeLayers,
  selectedVenueId,
  onSelectVenue,
  venueHasOpenShow,
  venuePressCount,
  activity,
  districtCentroids,
  center,
  zoom,
  onViewChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  // Mutable per-venue data the marker's event listeners read live, so
  // listeners can be attached once at element-creation time and never go
  // stale even as venue/exhibition props change on later renders.
  const markerDataRef = useRef<Map<string, { venue: Venue; primary: Exhibition | undefined; point: { lat: number; lng: number } }>>(
    new Map()
  );
  const nexusMarkersRef = useRef<Map<string, Marker>>(new Map());
  const previewPopupRef = useRef<maplibregl.Popup | null>(null);
  // Which venue's preview the shared popup is currently showing. A resize
  // (e.g. the dossier opening shifts every marker sideways) can land the
  // stationary cursor on a *different* marker mid-transition; that marker's
  // own mouseleave must not be allowed to close a popup it never opened.
  const previewOwnerRef = useRef<string | null>(null);
  // Kept in sync two ways: synchronously inside this component's own click
  // handler (below) so there's zero delay before a same-tick resize can
  // race it, and via effect for selection changes that originate elsewhere
  // (the ticker, the dossier's adjacent-openings list).
  const selectedVenueIdRef = useRef(selectedVenueId);
  useEffect(() => {
    selectedVenueIdRef.current = selectedVenueId;
  }, [selectedVenueId]);
  const reticleRef = useRef<HTMLDivElement>(null);
  const initialCenter = useRef(center);
  const initialZoom = useRef(zoom);
  const onViewChangeRef = useRef(onViewChange);
  useEffect(() => {
    onViewChangeRef.current = onViewChange;
  }, [onViewChange]);
  // Map init is async (style fetch happens first) — effects that touch
  // mapRef.current need to re-run once it actually exists, not just once on
  // mount when it's still null.
  const [mapReady, setMapReady] = useState(false);

  // --- init map once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    async function init() {
      let style: string | maplibregl.StyleSpecification = BASEMAP_STYLE_URL;
      try {
        const res = await fetch(BASEMAP_STYLE_URL);
        const json = await res.json();
        // Strip POI clutter per SPEC.md §11 — venues are the only points of interest.
        if (json?.layers) {
          json.layers = json.layers.filter((l: { id?: string }) => {
            const id = (l.id ?? "").toLowerCase();
            return !id.includes("poi") && !id.includes("transit");
          });
        }
        style = json;
      } catch {
        // fall back to the raw style URL if fetch/strip fails
      }
      if (cancelled || !containerRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: [initialCenter.current.lng, initialCenter.current.lat],
        zoom: initialZoom.current,
        attributionControl: { compact: true },
        // MapLibre reads prefers-reduced-motion itself for camera animations
        // (AnimationOptions.essential) — no map-level option needed.
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

      map.on("moveend", () => {
        const c = map.getCenter();
        onViewChangeRef.current({ lat: c.lat, lng: c.lng }, map.getZoom());
      });

      map.on("mousemove", (e) => {
        const el = reticleRef.current;
        if (!el) return;
        el.textContent = `${e.lngLat.lat.toFixed(5)} ${e.lngLat.lng.toFixed(5)}`;
      });

      map.on("click", (e) => {
        // click on empty map clears selection unless a marker's own handler stops it
        const target = e.originalEvent.target as HTMLElement;
        if (!target.closest("[data-venue-marker]")) {
          selectedVenueIdRef.current = null;
          onSelectVenue(null);
          previewPopupRef.current?.remove();
          previewOwnerRef.current = null;
        }
      });

      previewPopupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "venue-preview-popup",
      });

      mapRef.current = map;
      setMapReady(true);
    }
    init();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      previewPopupRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // arrow-key panning (§11 keyboard: "arrows pan")
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      const map = mapRef.current;
      if (!map) return;
      const step = 80;
      if (e.key === "ArrowLeft") map.panBy([-step, 0]);
      else if (e.key === "ArrowRight") map.panBy([step, 0]);
      else if (e.key === "ArrowUp") map.panBy([0, -step]);
      else if (e.key === "ArrowDown") map.panBy([0, step]);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- district activity heat wash (soft radial halos, no fabricated polygons) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const showHeat = true; // always-on ambient signal, not a togglable layer
      const features = showHeat
        ? activity
            .map((a) => {
              const c = districtCentroids.get(a.district);
              if (!c) return null;
              return {
                type: "Feature" as const,
                properties: { score: a.score },
                geometry: { type: "Point" as const, coordinates: [c.lng, c.lat] },
              };
            })
            .filter((f): f is NonNullable<typeof f> => f !== null)
        : [];
      const data = { type: "FeatureCollection" as const, features };
      const src = map.getSource("activity") as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else if (map.isStyleLoaded()) {
        map.addSource("activity", { type: "geojson", data });
        map.addLayer({
          id: "activity-heat",
          type: "circle",
          source: "activity",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["get", "score"], 0, 0, 1, 90],
            "circle-color": PALETTE.orange,
            "circle-opacity": ["interpolate", ["linear"], ["get", "score"], 0, 0, 1, 0.18],
            "circle-blur": 1,
          },
        });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [activity, districtCentroids, mapReady]);

  // --- adjacency connectors for the selected venue ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const selected = venues.find((v) => v.id === selectedVenueId) ?? null;
      const origin = selected ? venueAnchor(selected) : null;
      let features: GeoJSON.Feature[] = [];
      if (selected && origin) {
        const adjacent = getAdjacentOpenVenues(selected, venues, venueHasOpenShow, 400);
        features = adjacent
          .map((a) => {
            const p = venueAnchor(a.venue);
            if (!p) return null;
            return {
              type: "Feature" as const,
              properties: { distance: Math.round(a.distanceMeters) },
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [origin.lng, origin.lat],
                  [p.lng, p.lat],
                ],
              },
            };
          })
          .filter((f): f is NonNullable<typeof f> => f !== null);
      }
      const data = { type: "FeatureCollection" as const, features };
      const src = map.getSource("connectors") as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else if (map.isStyleLoaded()) {
        map.addSource("connectors", { type: "geojson", data });
        map.addLayer({
          id: "connectors-line",
          type: "line",
          source: "connectors",
          paint: {
            "line-color": PALETTE.paper,
            "line-width": 1,
            "line-opacity": 0.55,
            "line-dasharray": [2, 2],
          },
        });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [selectedVenueId, venues, venueHasOpenShow, mapReady]);

  // --- markers ---
  const layerVisible = useCallback(
    (venue: Venue, exhibitions: Exhibition[]): boolean => {
      const isDark = exhibitions.length === 0;
      const isInstitution = venue.kind === "museum" || venue.kind === "institution";
      const isArtistRun = venue.kind === "artist_run" || venue.kind === "nonprofit";
      const closingSoon = exhibitions.some((e) => e.status === "closing_soon");
      const onView = exhibitions.some((e) => e.status === "open" || e.status === "closing_soon");
      const openingSoon = exhibitions.some((e) => e.status === "upcoming");

      if (isDark && activeLayers.has("dark")) return true;
      if (closingSoon && activeLayers.has("closing")) return true;
      if (onView && activeLayers.has("on_view")) return true;
      if (openingSoon && activeLayers.has("openings")) return true;
      if (isInstitution && activeLayers.has("institutions")) return true;
      if (isArtistRun && activeLayers.has("artist_run")) return true;
      return false;
    },
    [activeLayers]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();
    for (const venue of venues) {
      const point = venueAnchor(venue);
      if (!point) continue;
      const exhibitions = exhibitionsByVenue.get(venue.id) ?? [];
      const visible = layerVisible(venue, exhibitions);
      seen.add(venue.id);

      let marker = markersRef.current.get(venue.id);
      if (!visible) {
        marker?.remove();
        markersRef.current.delete(venue.id);
        markerDataRef.current.delete(venue.id);
        if (previewOwnerRef.current === venue.id) {
          previewPopupRef.current?.remove(); // its marker just vanished mid-hover
          previewOwnerRef.current = null;
        }
        continue;
      }

      const primary = exhibitions[0];
      const status = primary?.status ?? null;
      const opacity = primary ? recencyOpacity(primary.fetched_at) : 0.5;
      const hasPress = (venuePressCount.get(venue.id) ?? 0) > 0;
      const selected = venue.id === selectedVenueId;

      // Data listeners read live, updated every render regardless of
      // whether the element itself is newly created this pass.
      markerDataRef.current.set(venue.id, { venue, primary, point });

      if (!marker) {
        const el = buildMarkerEl(venue);
        el.setAttribute("data-venue-marker", venue.id);

        const showPreview = () => {
          const data = markerDataRef.current.get(venue.id);
          if (!data?.primary) return; // nothing on view — no poster to show
          previewPopupRef.current
            ?.setLngLat([data.point.lng, data.point.lat])
            .setDOMContent(buildPreviewContent(data.venue, data.primary))
            .addTo(map);
          previewOwnerRef.current = venue.id;
        };
        const hidePreview = () => {
          // Two reasons this can be a no-op rather than an actual close:
          // (1) an unrelated marker's mouseleave should never clobber a
          //     popup it doesn't own;
          // (2) selecting a venue opens the dossier, which resizes the map
          //     (MapLibre's own ResizeObserver) and can shift *this very*
          //     marker out from under a stationary cursor moments after the
          //     click that opened its popup — a real mouseleave, but not
          //     one that should close the popup for the venue the user
          //     just committed to. It closes for real once selection moves
          //     on to something else.
          if (previewOwnerRef.current !== venue.id) return;
          if (selectedVenueIdRef.current === venue.id) return;
          previewPopupRef.current?.remove();
          previewOwnerRef.current = null;
        };

        el.addEventListener("click", (evt) => {
          evt.stopPropagation();
          selectedVenueIdRef.current = venue.id; // synchronous — see hidePreview
          onSelectVenue(venue.id);
          showPreview();
        });
        el.addEventListener("mouseenter", showPreview);
        el.addEventListener("mouseleave", hidePreview);
        el.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" || evt.key === " ") {
            evt.preventDefault();
            selectedVenueIdRef.current = venue.id;
            onSelectVenue(venue.id);
            showPreview();
          }
        });

        marker = new maplibregl.Marker({ element: el })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        markersRef.current.set(venue.id, marker);
      }

      // Re-assert position every render, not just at creation — a marker
      // added before the map's transform is fully settled can otherwise get
      // stuck pinned at the container's (0,0) corner with nothing left to
      // trigger a reposition.
      marker.setLngLat([point.lng, point.lat]);
      marker.setRotation(shapeFor(venue.kind).rotate ?? 0);
      applyMarkerVisualState(marker.getElement() as HTMLDivElement, venue, status, opacity, hasPress, selected);
    }

    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
        markerDataRef.current.delete(id);
      }
    }
  }, [
    venues,
    exhibitionsByVenue,
    layerVisible,
    selectedVenueId,
    venuePressCount,
    onSelectVenue,
    mapReady,
  ]);

  // --- nexus markers (fairs, biennials, triennials) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const showNexus = activeLayers.has("nexus");
    const seen = new Set<string>();

    for (const n of nexus) {
      if (n.lat == null || n.lng == null || !showNexus) continue;
      seen.add(n.id);
      if (nexusMarkersRef.current.has(n.id)) continue;
      const el = buildNexusEl(n);
      const popup = new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(
        `<strong>${n.name}</strong> ${n.edition}<br/>${n.opens ?? "?"} — ${n.closes ?? "?"}`
      );
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([n.lng, n.lat])
        .setPopup(popup)
        .addTo(map);
      el.addEventListener("click", () => marker.togglePopup());
      nexusMarkersRef.current.set(n.id, marker);
    }
    for (const [id, marker] of nexusMarkersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        nexusMarkersRef.current.delete(id);
      }
    }
  }, [nexus, activeLayers, mapReady]);

  // --- fly to selected venue ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedVenueId) return;
    const venue = venues.find((v) => v.id === selectedVenueId);
    const point = venue ? venueAnchor(venue) : null;
    if (!point) return;
    const bounds = map.getBounds() as LngLatBounds;
    if (!bounds.contains([point.lng, point.lat])) {
      map.easeTo({ center: [point.lng, point.lat], duration: 400 });
    }
  }, [selectedVenueId, venues, mapReady]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" style={{ background: "var(--ground)" }} />
      <div
        ref={reticleRef}
        className="mono tabular pointer-events-none absolute bottom-2 left-2 select-none px-1.5 py-1 text-[10px]"
        style={{ background: "rgba(11,12,12,0.7)", color: "var(--paper-dim)", border: "1px solid var(--hairline)" }}
      >
        —
      </div>
    </div>
  );
}
