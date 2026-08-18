"use client";

import { useEffect, useState } from "react";
import type { TimeRange } from "@/lib/types";

const RANGES: TimeRange[] = ["24h", "7d", "30d", "season"];

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // Synchronizing with the system clock — an SSR-safe render-time value
    // doesn't exist for "now".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function fmtUTC(d: Date): string {
  return d.toISOString().slice(11, 19) + " UTC";
}
function fmtLocal(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export interface TopBarProps {
  range: TimeRange;
  onRangeChange: (r: TimeRange) => void;
  query: string;
  onQueryChange: (q: string) => void;
  lastSync: string | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onToggleLeftRail: () => void;
}

export default function TopBar({
  range,
  onRangeChange,
  query,
  onQueryChange,
  lastSync,
  searchInputRef,
  onToggleLeftRail,
}: TopBarProps) {
  const now = useClock();

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-2 border-b px-2 sm:gap-4 sm:px-3"
      style={{ background: "var(--panel)", borderColor: "var(--hairline)" }}
    >
      <button
        onClick={onToggleLeftRail}
        aria-label="Toggle layers"
        className="label shrink-0 px-1.5 py-1 md:hidden"
        style={{ color: "var(--paper-dim)", border: "1px solid var(--hairline)" }}
      >
        L
      </button>

      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 shrink-0"
          style={{ background: "var(--orange)" }}
          aria-hidden
        />
        <span
          className="label truncate"
          style={{ color: "var(--paper)", letterSpacing: "0.12em" }}
        >
          <span className="hidden sm:inline">ART WORLD SITUATION MONITOR</span>
          <span className="sm:hidden">AWSM</span>
        </span>
      </div>

      <div className="mx-1 hidden h-5 w-px shrink-0 sm:block" style={{ background: "var(--hairline)" }} />

      <div className="hidden shrink-0 items-center gap-0.5 sm:flex">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className="label px-2 py-1"
            style={{
              color: r === range ? "var(--ground)" : "var(--paper-dim)",
              background: r === range ? "var(--orange)" : "transparent",
            }}
          >
            {r}
          </button>
        ))}
      </div>
      <select
        value={range}
        onChange={(e) => onRangeChange(e.target.value as TimeRange)}
        aria-label="Time range"
        className="mono shrink-0 px-1 py-1 text-[10px] outline-none sm:hidden"
        style={{
          background: "var(--panel-raised)",
          border: "1px solid var(--hairline)",
          color: "var(--paper)",
        }}
      >
        {RANGES.map((r) => (
          <option key={r} value={r}>
            {r.toUpperCase()}
          </option>
        ))}
      </select>

      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <input
          ref={searchInputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="/ SEARCH"
          className="mono w-full min-w-0 px-2 py-1 text-[10px] outline-none"
          style={{
            background: "var(--panel-raised)",
            border: "1px solid var(--hairline)",
            color: "var(--paper)",
          }}
        />
      </div>

      <div className="ml-auto hidden shrink-0 items-center gap-3 lg:flex">
        {now && (
          <>
            <span className="mono tabular text-[10px]" style={{ color: "var(--paper-dim)" }}>
              {fmtUTC(now)}
            </span>
            <span className="mono tabular text-[10px]" style={{ color: "var(--paper-dim)" }}>
              {fmtLocal(now)} LOCAL
            </span>
          </>
        )}
        <span className="mono tabular text-[10px]" style={{ color: "var(--dim)" }}>
          SYNC {lastSync ? lastSync.slice(0, 16).replace("T", " ") : "—"}
        </span>
      </div>
    </header>
  );
}
