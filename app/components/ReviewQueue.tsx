"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CitySnapshot, Venue, Exhibition } from "@/lib/types";

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const HEALTH_COLOR: Record<string, string> = {
  ok: "var(--paper-dim)",
  unknown: "var(--dim)",
  suspect: "var(--orange)",
  stale: "var(--red)",
  blocked: "var(--red)",
};

export default function ReviewQueue() {
  const [snapshot, setSnapshot] = useState<CitySnapshot | null>(null);

  useEffect(() => {
    fetchJSON<CitySnapshot>("/snapshots/nyc.json").then(setSnapshot);
  }, []);

  if (!snapshot) {
    return (
      <div className="mono p-6 text-[11px]" style={{ color: "var(--paper-dim)" }}>
        LOADING…
      </div>
    );
  }

  const flaggedVenues = snapshot.venues.filter(
    (v) => v.health.status === "suspect" || v.health.status === "stale" || v.health.status === "blocked" || v.health.consecutive_failures > 0
  );
  const noDataVenues = snapshot.venues.filter((v) => v.spaces.length === 0 || v.spaces.every((s) => s.lat == null));
  const lowConfidence = snapshot.exhibitions
    .filter((e) => e.confidence < 0.7)
    .sort((a, b) => a.confidence - b.confidence);
  const venueById = new Map(snapshot.venues.map((v) => [v.id, v]));

  return (
    <div className="min-h-screen p-4 sm:p-6" style={{ background: "var(--ground)", color: "var(--paper)" }}>
      <header className="mb-6 flex items-center justify-between border-b pb-3" style={{ borderColor: "var(--hairline)" }}>
        <div>
          <div className="label mb-1">Art World Situation Monitor</div>
          <h1 className="text-[16px] font-medium">Review queue</h1>
        </div>
        <Link href="/" className="mono text-[11px] underline decoration-dotted" style={{ color: "var(--blue)" }}>
          ← BACK TO MAP
        </Link>
      </header>

      <p className="mb-6 max-w-2xl text-[12px]" style={{ color: "var(--paper-dim)" }}>
        Everything the pipeline itself flagged as needing a human look — venues whose adapter came back
        suspect or stale, venues with no resolvable coordinates, and exhibition records below the 0.7
        confidence threshold. Nothing here is hidden from the map; this is just the honest worklist.
      </p>

      <Section title={`Adapter health (${flaggedVenues.length})`}>
        {flaggedVenues.length === 0 ? (
          <Empty>No venues currently suspect, stale, or blocked.</Empty>
        ) : (
          <Table headers={["Venue", "Adapter", "Status", "Failures", "Last success", "Notes"]}>
            {flaggedVenues.map((v) => (
              <tr key={v.id} className="border-t" style={{ borderColor: "var(--hairline)" }}>
                <Td>{v.name}</Td>
                <Td className="mono">{v.adapter}</Td>
                <Td>
                  <span className="label" style={{ color: HEALTH_COLOR[v.health.status] }}>
                    {v.health.status}
                  </span>
                </Td>
                <Td className="mono tabular">{v.health.consecutive_failures}</Td>
                <Td className="mono tabular">{v.health.last_success?.slice(0, 10) ?? "—"}</Td>
                <Td className="max-w-xs truncate" style={{ color: "var(--dim)" }}>
                  {v.notes || "—"}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={`No coordinates (${noDataVenues.length})`}>
        {noDataVenues.length === 0 ? (
          <Empty>Every venue has at least one geocoded space.</Empty>
        ) : (
          <Table headers={["Venue", "Spaces", "Notes"]}>
            {noDataVenues.map((v) => (
              <tr key={v.id} className="border-t" style={{ borderColor: "var(--hairline)" }}>
                <Td>{v.name}</Td>
                <Td className="mono tabular">{v.spaces.length}</Td>
                <Td className="max-w-md" style={{ color: "var(--dim)" }}>
                  {v.notes || "—"}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={`Low-confidence exhibitions (${lowConfidence.length})`}>
        {lowConfidence.length === 0 ? (
          <Empty>Every exhibition record is at or above 0.7 confidence.</Empty>
        ) : (
          <Table headers={["Confidence", "Venue", "Title", "Source"]}>
            {lowConfidence.map((e) => (
              <ExhibitionRow key={e.id} exhibition={e} venue={venueById.get(e.venue_id)} />
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

function ExhibitionRow({ exhibition, venue }: { exhibition: Exhibition; venue: Venue | undefined }) {
  return (
    <tr className="border-t" style={{ borderColor: "var(--hairline)" }}>
      <Td className="mono tabular" style={{ color: exhibition.confidence < 0.5 ? "var(--red)" : "var(--orange)" }}>
        {(exhibition.confidence * 100).toFixed(0)}%
      </Td>
      <Td>{venue?.name ?? exhibition.venue_id}</Td>
      <Td className="serif-italic">{exhibition.title}</Td>
      <Td>
        <a href={exhibition.source_url} target="_blank" rel="noreferrer" className="mono text-[10px] underline" style={{ color: "var(--blue)" }}>
          SOURCE
        </a>
      </Td>
    </tr>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="label mb-2">{title}</div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[12px]" style={{ color: "var(--dim)" }}>
      {children}
    </p>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto border" style={{ borderColor: "var(--hairline)" }}>
      <table className="w-full min-w-max border-collapse text-[12px]">
        <thead>
          <tr style={{ background: "var(--panel)" }}>
            {headers.map((h) => (
              <th key={h} className="label px-2 py-1.5 text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td className={`px-2 py-1.5 align-top ${className}`} style={style}>
      {children}
    </td>
  );
}
