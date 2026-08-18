"use client";

import type { MonitorEvent } from "@/lib/types";

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
  return (
    <div
      className="flex h-[132px] shrink-0 flex-col border-t"
      style={{ background: "var(--panel)", borderColor: "var(--hairline)" }}
    >
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
