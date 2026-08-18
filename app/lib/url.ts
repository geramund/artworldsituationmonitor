import type { LayerId, TimeRange } from "./types";

export const DEFAULT_LAYERS: LayerId[] = ["openings", "on_view", "closing", "institutions"];

export interface MonitorState {
  city: string;
  lat: number;
  lng: number;
  zoom: number;
  layers: LayerId[];
  range: TimeRange;
  venue: string | null;
  q: string;
}

export const DEFAULT_STATE: MonitorState = {
  city: "nyc",
  lat: 40.7168,
  lng: -73.9999,
  zoom: 14.2,
  layers: DEFAULT_LAYERS,
  range: "7d",
  venue: null,
  q: "",
};

const ALL_LAYERS: LayerId[] = [
  "openings",
  "on_view",
  "closing",
  "institutions",
  "artist_run",
  "nexus",
  "press",
  "offsite",
  "dark",
  "coverage",
];
const ALL_RANGES: TimeRange[] = ["24h", "7d", "30d", "season"];

export function parseState(params: URLSearchParams): MonitorState {
  const layersParam = params.get("layers");
  const layers = layersParam
    ? (layersParam.split(",").filter((l) => ALL_LAYERS.includes(l as LayerId)) as LayerId[])
    : DEFAULT_STATE.layers;

  const rangeParam = params.get("range");
  const range = ALL_RANGES.includes(rangeParam as TimeRange)
    ? (rangeParam as TimeRange)
    : DEFAULT_STATE.range;

  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const zoom = Number(params.get("zoom"));

  return {
    city: params.get("city") ?? DEFAULT_STATE.city,
    lat: Number.isFinite(lat) && params.has("lat") ? lat : DEFAULT_STATE.lat,
    lng: Number.isFinite(lng) && params.has("lng") ? lng : DEFAULT_STATE.lng,
    zoom: Number.isFinite(zoom) && params.has("zoom") ? zoom : DEFAULT_STATE.zoom,
    layers: layers.length ? layers : DEFAULT_STATE.layers,
    range,
    venue: params.get("venue"),
    q: params.get("q") ?? "",
  };
}

export function serializeState(state: MonitorState): string {
  const params = new URLSearchParams();
  params.set("city", state.city);
  params.set("lat", state.lat.toFixed(4));
  params.set("lng", state.lng.toFixed(4));
  params.set("zoom", state.zoom.toFixed(2));
  params.set("layers", state.layers.join(","));
  params.set("range", state.range);
  if (state.venue) params.set("venue", state.venue);
  if (state.q) params.set("q", state.q);
  return params.toString();
}
