"use client";

import type { Venue, Exhibition, Article } from "@/lib/types";
import { daysUntil, type AdjacentVenue } from "@/lib/derive";

const STATUS_LABEL: Record<string, string> = {
  upcoming: "OPENING",
  open: "ON VIEW",
  closing_soon: "CLOSING SOON",
  closed: "CLOSED",
};

function statusColor(status: string): string {
  if (status === "closing_soon") return "var(--red)";
  if (status === "open" || status === "upcoming") return "var(--orange)";
  return "var(--dim)";
}

function linkBorderStyle(confidence: number): string {
  if (confidence >= 0.8) return "solid";
  if (confidence >= 0.4) return "dashed";
  return "dotted";
}

export interface DossierProps {
  venue: Venue;
  exhibitions: Exhibition[];
  articles: Article[];
  adjacent: AdjacentVenue[];
  onClose: () => void;
  onSelectVenue: (id: string) => void;
}

export default function Dossier({
  venue,
  exhibitions,
  articles,
  adjacent,
  onClose,
  onSelectVenue,
}: DossierProps) {
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex h-full w-full flex-col overflow-y-auto border-l sm:relative sm:z-auto sm:w-[380px] sm:shrink-0"
      style={{ background: "var(--panel)", borderColor: "var(--hairline)" }}
      aria-label={`Dossier: ${venue.name}`}
    >
      <header
        className="flex items-start justify-between gap-2 border-b p-3"
        style={{ borderColor: "var(--hairline)" }}
      >
        <div>
          <div className="label">{venue.kind.replace("_", "-")}</div>
          <h2 className="text-[15px] font-medium">{venue.name}</h2>
          <a
            href={venue.url}
            target="_blank"
            rel="noreferrer"
            className="mono text-[10px] underline decoration-dotted"
            style={{ color: "var(--paper-dim)" }}
          >
            {venue.url.replace(/^https?:\/\//, "")}
          </a>
        </div>
        <button
          onClick={onClose}
          aria-label="Close dossier"
          className="mono px-1 text-[13px]"
          style={{ color: "var(--paper-dim)" }}
        >
          ESC ✕
        </button>
      </header>

      <section className="border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <div className="label mb-1">Spaces</div>
        {venue.spaces.map((s) => (
          <div key={s.label} className="mono mb-1.5 text-[11px]" style={{ color: "var(--paper)" }}>
            <div>{s.label}</div>
            <div className="tabular" style={{ color: "var(--paper-dim)" }}>
              {s.address}
              {s.lat != null && s.lng != null ? ` · ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}` : ""}
            </div>
          </div>
        ))}
        {venue.hours && (
          <div className="mono text-[11px]" style={{ color: "var(--paper-dim)" }}>
            {venue.hours}
          </div>
        )}
      </section>

      {exhibitions.length === 0 && (
        <section className="p-3">
          <div className="label mb-1" style={{ color: "var(--dim)" }}>
            Dark
          </div>
          <p className="text-[12px]" style={{ color: "var(--paper-dim)" }}>
            Nothing currently on view.
          </p>
        </section>
      )}

      {exhibitions.map((ex) => {
        const daysRemaining = ex.closes ? daysUntil(ex.closes) : null;
        const daysToOpen = ex.opens ? daysUntil(ex.opens) : null;
        return (
          <section key={ex.id} className="border-b p-3" style={{ borderColor: "var(--hairline)" }}>
            <div className="mb-1 flex items-center gap-2">
              <span
                className="label px-1 py-0.5"
                style={{ color: statusColor(ex.status), border: `1px solid ${statusColor(ex.status)}` }}
              >
                {STATUS_LABEL[ex.status]}
              </span>
              {ex.space_label && (
                <span className="mono text-[10px]" style={{ color: "var(--paper-dim)" }}>
                  {ex.space_label}
                </span>
              )}
            </div>
            <h3 className="serif-italic mb-1 text-[17px]">{ex.title}</h3>
            {ex.artists.length > 0 && (
              <p className="mb-1.5 text-[12px]" style={{ color: "var(--paper)" }}>
                {ex.artists.join(", ")}
              </p>
            )}
            <p className="mono tabular mb-2 text-[10px]" style={{ color: "var(--paper-dim)" }}>
              {ex.opens ?? "?"} — {ex.closes ?? "?"}
              {ex.status === "closing_soon" && daysRemaining != null && (
                <span style={{ color: "var(--red)" }}> · {daysRemaining}D LEFT</span>
              )}
              {ex.status === "upcoming" && daysToOpen != null && (
                <span style={{ color: "var(--orange)" }}> · OPENS IN {daysToOpen}D</span>
              )}
            </p>
            {ex.excerpt && (
              <p className="mb-2 text-[12px] leading-relaxed" style={{ color: "var(--paper-dim)" }}>
                {ex.excerpt}
              </p>
            )}
            <div className="mono flex flex-wrap gap-2 text-[10px]" style={{ color: "var(--blue)" }}>
              {ex.press_release_url && (
                <a href={ex.press_release_url} target="_blank" rel="noreferrer" className="underline">
                  PRESS RELEASE
                </a>
              )}
              <a href={ex.source_url} target="_blank" rel="noreferrer" className="underline">
                SOURCE
              </a>
            </div>

            {ex.image_urls.length > 0 && (
              <div className="mt-2 flex gap-1.5 overflow-x-auto">
                {ex.image_urls.slice(0, 6).map((url) => (
                  // installation views are hotlinked, never rehosted — see SPEC.md §2
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={url}
                    alt={ex.image_credit ?? ex.title}
                    className="h-20 w-20 shrink-0 object-cover"
                    style={{ border: "1px solid var(--hairline)" }}
                    loading="lazy"
                    onError={(e) => {
                      // a broken hotlink shouldn't leave an ugly icon in an
                      // otherwise-clean HUD — just drop it
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ))}
              </div>
            )}
            {ex.image_urls.length > 0 && ex.image_credit && (
              <p className="mono mt-1 text-[9px]" style={{ color: "var(--dim)" }}>
                {ex.image_credit}
              </p>
            )}

            {ex.works.length > 0 && (
              <details className="mt-2">
                <summary className="label cursor-pointer">Checklist ({ex.works.length})</summary>
                <ul className="mt-1 space-y-0.5 text-[11px]" style={{ color: "var(--paper-dim)" }}>
                  {ex.works.map((w, i) => (
                    <li key={i}>
                      <span className="serif-italic">{w.title}</span>
                      {w.year && <span className="mono"> {w.year}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <p className="mono mt-2 text-[9px]" style={{ color: "var(--dim)" }}>
              CONFIDENCE {(ex.confidence * 100).toFixed(0)}% · FETCHED {ex.fetched_at.slice(0, 10)}
            </p>
          </section>
        );
      })}

      <section className="border-b p-3" style={{ borderColor: "var(--hairline)" }}>
        <div className="label mb-1.5">
          Linked press {articles.length > 0 && `(${articles.length})`}
        </div>
        {articles.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--dim)" }}>
            No linked coverage yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {articles.map((a) => (
              <li
                key={a.id}
                className="pl-2 text-[11px]"
                style={{ borderLeft: `2px ${linkBorderStyle(a.link_confidence)} var(--blue)` }}
              >
                <a href={a.url} target="_blank" rel="noreferrer" className="underline">
                  {a.headline}
                </a>
                <div className="mono mt-0.5 text-[9px]" style={{ color: "var(--paper-dim)" }}>
                  {a.outlet} · {a.published.slice(0, 10)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="p-3">
        <div className="label mb-1.5">Adjacent openings (≤400m)</div>
        {adjacent.length === 0 ? (
          <p className="text-[11px]" style={{ color: "var(--dim)" }}>
            Nothing else on view within walking distance right now.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {adjacent.map((a) => (
              <li key={a.venue.id}>
                <button
                  onClick={() => onSelectVenue(a.venue.id)}
                  className="text-left text-[11px] underline decoration-dotted"
                >
                  {a.venue.name}
                </button>
                <span className="mono tabular ml-1.5 text-[9px]" style={{ color: "var(--paper-dim)" }}>
                  {Math.round(a.distanceMeters)}M
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {venue.notes && (
        <section className="p-3 text-[10px]" style={{ color: "var(--dim)" }}>
          {venue.notes}
        </section>
      )}
    </aside>
  );
}
