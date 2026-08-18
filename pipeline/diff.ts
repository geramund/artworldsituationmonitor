// Change detection + event emission (SPEC.md §7). This is what makes it a
// monitor rather than a directory: the event stream is a record of what
// *changed*, not a re-statement of the current snapshot.
//
// On a genuine first run (no previous snapshot to compare against) there is
// nothing to diff yet — but throwing the whole crawl's worth of known dates
// away would make the ticker permanently empty for anyone bootstrapping the
// project. The compromise that stays honest: seed the log with events dated
// at the *exhibition's own real opens/closes dates*, which are sourced facts,
// not invented ones. That's different from fabricating an event; it's a
// truthful backfill of "this happened" using data we already have
// provenance for. Every run after that is a real diff against the prior
// commit.

import type { Exhibition, MonitorEvent, Venue } from "../types/index.ts";

let counter = 0;
function eventId(): string {
  counter += 1;
  return `evt-${Date.now().toString(36)}-${counter}`;
}

function push(events: MonitorEvent[], partial: Omit<MonitorEvent, "id">) {
  events.push({ id: eventId(), ...partial });
}

export function bootstrapEvents(exhibitions: Exhibition[], now: Date = new Date()): MonitorEvent[] {
  const events: MonitorEvent[] = [];
  for (const ex of exhibitions) {
    if (ex.opens) {
      const opensAt = new Date(ex.opens);
      if (opensAt <= now) {
        push(events, {
          ts: opensAt.toISOString(),
          type: "OPENED",
          venue_id: ex.venue_id,
          exhibition_id: ex.id,
          article_id: null,
          payload: { title: ex.title },
        });
      } else {
        push(events, {
          ts: ex.fetched_at,
          type: "ANNOUNCED",
          venue_id: ex.venue_id,
          exhibition_id: ex.id,
          article_id: null,
          payload: { title: ex.title, opens: ex.opens },
        });
      }
    }
    if (ex.closes) {
      const closesAt = new Date(ex.closes);
      if (closesAt <= now) {
        push(events, {
          ts: closesAt.toISOString(),
          type: "CLOSED",
          venue_id: ex.venue_id,
          exhibition_id: ex.id,
          article_id: null,
          payload: { title: ex.title },
        });
      } else {
        const msRemaining = closesAt.getTime() - now.getTime();
        if (msRemaining <= 7 * 24 * 60 * 60 * 1000) {
          push(events, {
            ts: now.toISOString(),
            type: "CLOSING_SOON",
            venue_id: ex.venue_id,
            exhibition_id: ex.id,
            article_id: null,
            payload: { title: ex.title, closes: ex.closes },
          });
        }
      }
    }
  }
  return events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

export interface PriorState {
  exhibitionsById: Map<string, Exhibition>;
  venuesWithShowsIds: Set<string>;
}

export function diffEvents(
  prior: PriorState,
  venues: Venue[],
  exhibitions: Exhibition[],
  now: Date = new Date()
): MonitorEvent[] {
  const events: MonitorEvent[] = [];
  const currentByVenue = new Map<string, Exhibition[]>();
  for (const ex of exhibitions) {
    currentByVenue.set(ex.venue_id, [...(currentByVenue.get(ex.venue_id) ?? []), ex]);

    const prev = prior.exhibitionsById.get(ex.id);
    if (!prev) {
      push(events, {
        ts: now.toISOString(),
        type: "ANNOUNCED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title },
      });
      continue;
    }
    if (prev.status !== "open" && ex.status === "open") {
      push(events, {
        ts: now.toISOString(),
        type: "OPENED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title },
      });
    }
    if (prev.status !== "closing_soon" && ex.status === "closing_soon") {
      push(events, {
        ts: now.toISOString(),
        type: "CLOSING_SOON",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title, closes: ex.closes },
      });
    }
    if (prev.status !== "closed" && ex.status === "closed") {
      push(events, {
        ts: now.toISOString(),
        type: "CLOSED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title },
      });
    }
    if (prev.closes && ex.closes && new Date(ex.closes) > new Date(prev.closes)) {
      push(events, {
        ts: now.toISOString(),
        type: "EXTENDED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title, was: prev.closes, now: ex.closes },
      });
    }
    if (prev.image_urls.length === 0 && ex.image_urls.length > 0) {
      push(events, {
        ts: now.toISOString(),
        type: "DOCUMENTATION_POSTED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title, count: ex.image_urls.length },
      });
    }
    if (!prev.press_release_url && ex.press_release_url) {
      push(events, {
        ts: now.toISOString(),
        type: "PRESS_RELEASE_POSTED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title },
      });
    }
    if (prev.works.length === 0 && ex.works.length > 0) {
      push(events, {
        ts: now.toISOString(),
        type: "CHECKLIST_POSTED",
        venue_id: ex.venue_id,
        exhibition_id: ex.id,
        article_id: null,
        payload: { title: ex.title, count: ex.works.length },
      });
    }
  }

  for (const venue of venues) {
    const hasShowsNow = (currentByVenue.get(venue.id) ?? []).length > 0;
    if (!hasShowsNow && prior.venuesWithShowsIds.has(venue.id)) {
      push(events, {
        ts: now.toISOString(),
        type: "VENUE_DARK",
        venue_id: venue.id,
        exhibition_id: null,
        article_id: null,
        payload: { name: venue.name },
      });
    }
  }

  return events;
}
