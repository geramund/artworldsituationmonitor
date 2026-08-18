"use client";

import { useCallback, useRef, useState } from "react";
import type { MonitorEvent } from "@/lib/types";

const MIN_HEIGHT = 40;
const DEFAULT_HEIGHT = 132;
const MAX_HEIGHT_RATIO = 0.7;

const EVENT_LABEL: Record<string, string> = {
  ANNOUNCED: "ANNOUNCED",
  OPENED: "OPENED",
  CLOSING_SOON: "CLOSING SOON",
  CLOSED: "CLOSED",
  EXTENDED: "EXTENDED",
  DOCUMENTATION_POSTED: "DOCS POSTED",
  PRESS_RELEASE_POSTED: "PRESS RELEASE",
  CHECKLIST_POSTED: "CHECKLIST",
  PRESS_ADDED: "PRESS",
  VENUE_DARK: "DARK",
  VENUE_STALE: "STALE",
};

function eventColor(type: string): string {
  if (type === "CLOSING_SOON" || type === "VENUE_STALE") return "var(--red)";
  if (type === "OPENED" || type === "ANNOUNCED" || type === "EXTENDED") return "var(--orange)";
  if (type === "PRESS_ADDED" || type === "PRESS_RELEASE_POSTED") return "var(--blue)";
  return "var(--dim)";
}

export interface TickerProps {
  events: (MonitorEvent & { label: string })[];
  onSelectVenue: (id: string) => void;
}

export default function Ticker({ events, onSelectVenue }: TickerProps) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const clamp = useCallback((h: number) => {
    const max = typeof window !== "undefined" ? window.innerHeight * MAX_HEIGHT_RATIO : 500;
    return Math.min(Math.max(h, MIN_HEIGHT), max);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startY: e.clientY, startHeight: height };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [height],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - e.clientY;
      setHeight(clamp(dragRef.current.startHeight + delta));
    },
    [clamp],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowUp") {
        setHeight((h) => clamp(h + 20));
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        setHeight((h) => clamp(h - 20));
        e.preventDefault();
      }
    },
    [clamp],
  );

  return (
    <div
      className="flex shrink-0 flex-col border-t"
      style={{ height, background: "var(--panel)", borderColor: "var(--hairline)" }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize event stream"
        aria-valuenow={Math.round(height)}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className="drag-handle flex shrink-0 cursor-row-resize items-center justify-center"
        style={{ height: 7, touchAction: "none" }}
      >
        <div className="h-[2px] w-8 rounded-full" style={{ background: "var(--hairline)" }} />
      </div>
      <div
        className="label flex items-center justify-between border-b px-3 py-1"
        style={{ borderColor: "var(--hairline)" }}
      >
        <span>Event stream</span>
        <span style={{ color: "var(--paper-dim)" }}>{events.length}</span>
      </div>
      <div className="mono flex-1 overflow-y-auto px-3 py-1 text-[11px]">
        {events.length === 0 ? (
          <p className="py-2" style={{ color: "var(--dim)" }}>
            No events in the selected window. Quiet is a real state — see §6.
          </p>
        ) : (
          events.map((e) => (
            <button
              key={e.id}
              onClick={() => e.venue_id && onSelectVenue(e.venue_id)}
              disabled={!e.venue_id}
              className="event-blip flex w-full items-baseline gap-2 py-0.5 text-left disabled:cursor-default"
            >
              <span className="tabular shrink-0" style={{ color: "var(--dim)" }}>
                {e.ts.slice(5, 16).replace("T", " ")}
              </span>
              <span
                className="label shrink-0"
                style={{ color: eventColor(e.type), letterSpacing: "0.06em" }}
              >
                {EVENT_LABEL[e.type] ?? e.type}
              </span>
              <span className="truncate" style={{ color: "var(--paper)" }}>
                {e.label}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
