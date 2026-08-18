// The failure mode that matters (SPEC.md §6): sites rarely go down, they get
// quietly redesigned, and the adapter starts returning zero (or garbage)
// records without erroring. This is the gate between "adapter fetched
// something" and "we trust it enough to overwrite last-good." A wrong empty
// state is worse than a slightly old one.

import type { Exhibition } from "../types/index.ts";

export interface PlausibilityResult {
  ok: boolean;
  reason?: string;
}

export function plausible(
  newRecords: Exhibition[],
  priorRecords: Exhibition[] | null
): PlausibilityResult {
  // Nothing to compare against — first-ever crawl of this venue, or the
  // venue previously had nothing on view either. Whatever came back is the
  // new baseline.
  if (!priorRecords || priorRecords.length === 0) return { ok: true };

  if (newRecords.length === 0) {
    return {
      ok: false,
      reason: `had ${priorRecords.length} record(s) last run, 0 now — likely a redesign, not a real change`,
    };
  }

  const priorByUrl = new Map(priorRecords.map((r) => [r.source_url, r]));
  const matched = newRecords
    .map((r) => ({ next: r, prior: priorByUrl.get(r.source_url) }))
    .filter((pair): pair is { next: Exhibition; prior: Exhibition } => pair.prior !== undefined);

  // A match of 1 isn't a sample — "ALL titles changed" from n=1 is
  // indistinguishable from "this one show's title was legitimately edited."
  // Observed for real during Phase 2 wiring: a single title/URL formatting
  // difference between hand-curated and adapter-sourced data tripped this
  // exact false positive. SPEC.md's signal (§6) is about a *pattern* across
  // a redesign, not a coincidence in one record.
  const MIN_SAMPLE = 3;
  if (matched.length === 0 || matched.length < MIN_SAMPLE) return { ok: true };

  const allDatesShifted = matched.every(
    (m) => m.next.opens !== m.prior.opens || m.next.closes !== m.prior.closes
  );
  if (allDatesShifted) {
    return {
      ok: false,
      reason: `every matched record's dates shifted at once (${matched.length} matched) — likely a parsing regression, not ${matched.length} simultaneous date changes`,
    };
  }

  const allTitlesChanged = matched.every((m) => m.next.title !== m.prior.title);
  if (allTitlesChanged) {
    return {
      ok: false,
      reason: `all titles changed while URLs stayed the same (${matched.length} matched) — likely the adapter is reading the wrong field`,
    };
  }

  return { ok: true };
}
