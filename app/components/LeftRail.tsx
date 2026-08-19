"use client";

import type { LayerId, CoverageSummary } from "@/lib/types";

const LAYER_DEFS: { id: LayerId; label: string; color: string }[] = [
  { id: "openings", label: "Openings", color: "var(--orange)" },
  { id: "on_view", label: "On view", color: "var(--paper)" },
  { id: "closing", label: "Closing", color: "var(--red)" },
  { id: "institutions", label: "Institutions", color: "var(--paper)" },
  { id: "artist_run", label: "Artist-run / nonprofit", color: "var(--paper)" },
  { id: "nexus", label: "Nexus (fairs, biennials)", color: "var(--blue)" },
  // "press" layer toggle deliberately hidden for now (2026-08-19) — press
  // linkage quality isn't there yet to surface as a filter; see the phase
  // report's low linked-article rate. Underlying plumbing (venuePressCount,
  // layerVisible's press branch) is untouched, just not exposed in the UI.
  { id: "offsite", label: "Offsite", color: "var(--paper-dim)" },
  { id: "dark", label: "Dark", color: "var(--dim)" },
];

export interface LeftRailProps {
  activeLayers: Set<LayerId>;
  onToggleLayer: (id: LayerId) => void;
  counts: Record<LayerId, number>;
  coverage: CoverageSummary;
  city: string;
  cities: { id: string; label: string }[];
  onCityChange: (id: string) => void;
  showCoverage: boolean;
  onToggleCoverage: () => void;
}

export default function LeftRail({
  activeLayers,
  onToggleLayer,
  counts,
  coverage,
  city,
  cities,
  onCityChange,
  showCoverage,
  onToggleCoverage,
}: LeftRailProps) {
  return (
    <nav
      className="flex w-[220px] shrink-0 flex-col overflow-y-auto border-r"
      style={{ background: "var(--panel)", borderColor: "var(--hairline)" }}
      aria-label="Layers"
    >
      <div className="border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <div className="label mb-1.5">City</div>
        <select
          value={city}
          onChange={(e) => onCityChange(e.target.value)}
          className="mono w-full px-1.5 py-1 text-[11px] outline-none"
          style={{ background: "var(--panel-raised)", border: "1px solid var(--hairline)", color: "var(--paper)" }}
        >
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <div className="label mb-2">Layers</div>
        <ul className="space-y-0.5">
          {LAYER_DEFS.map((l) => {
            const active = activeLayers.has(l.id);
            const count = counts[l.id] ?? 0;
            return (
              <li key={l.id}>
                <button
                  onClick={() => onToggleLayer(l.id)}
                  aria-pressed={active}
                  className="flex w-full items-center justify-between px-1.5 py-1 text-left text-[11px]"
                  style={{
                    background: active ? "var(--panel-raised)" : "transparent",
                    color: active ? "var(--paper)" : "var(--paper-dim)",
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-1.5 w-1.5"
                      style={{ background: active ? l.color : "var(--hairline)" }}
                      aria-hidden
                    />
                    {l.label}
                  </span>
                  <span className="mono tabular" style={{ color: "var(--paper-dim)" }}>
                    {count}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="p-3">
        <button
          onClick={onToggleCoverage}
          aria-pressed={showCoverage}
          className="label mb-2 flex w-full items-center justify-between"
        >
          <span>Coverage</span>
          <span style={{ color: "var(--paper-dim)" }}>{showCoverage ? "−" : "+"}</span>
        </button>
        {showCoverage && (
          <ul className="mono tabular space-y-1 text-[11px]">
            <li className="flex justify-between">
              <span style={{ color: "var(--orange)" }}>LIVE</span>
              <span>{coverage.live}</span>
            </li>
            <li className="flex justify-between">
              <span style={{ color: "var(--paper-dim)" }}>DARK</span>
              <span>{coverage.dark}</span>
            </li>
            <li className="flex justify-between">
              <span style={{ color: "var(--red)" }}>STALE</span>
              <span>{coverage.stale}</span>
            </li>
            <li className="flex justify-between">
              <span style={{ color: "var(--dim)" }}>BLOCKED</span>
              <span>{coverage.blocked}</span>
            </li>
            <li className="flex justify-between">
              <span style={{ color: "var(--dim)" }}>NO ADAPTER</span>
              <span>{coverage.no_adapter}</span>
            </li>
          </ul>
        )}
      </div>
    </nav>
  );
}
