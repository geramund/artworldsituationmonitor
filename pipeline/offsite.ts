// Closes the gap flagged in SPEC.md §8/§10: offsite exhibitions ("a
// gallery's artist showing at a museum elsewhere") must not place a marker
// on the gallery's own building. No adapter can actually detect this on its
// own — artlogic.ts infers `kind` purely from artist count
// (solo/two_person/group), sanity/wordpress do similar structural
// guessing, and none of them have any way to know a listed show is
// physically happening somewhere else. Rather than build a heuristic
// classifier that would inevitably misfire across hundreds of unrelated
// exhibitions, this is a small hand-verified correction list — the same
// spirit as registry/manual/ — applied once, after normalization, to the
// handful of exhibitions someone has actually confirmed are offsite.
//
// Extend registry/offsite-overrides.json when the next one turns up (a
// space_label scan against known venue spaces is the fastest way to spot a
// candidate — see the 2026-08-19 audit that found these two).

import type { Exhibition, Nexus } from "../types/index.ts";

export interface OffsiteOverride {
  venue_id: string;
  title_match: string; // lowercase substring match against the exhibition title
  nexus_id: string; // registry/nexus.json entry carrying the real location
}

export function applyOffsiteOverrides(
  exhibitions: Exhibition[],
  overrides: OffsiteOverride[],
  nexus: Nexus[]
): Exhibition[] {
  if (overrides.length === 0) return exhibitions;
  const nexusById = new Map(nexus.map((n) => [n.id, n]));
  return exhibitions.map((ex) => {
    const match = overrides.find(
      (o) => o.venue_id === ex.venue_id && ex.title.toLowerCase().includes(o.title_match)
    );
    if (!match) return ex;
    const host = nexusById.get(match.nexus_id);
    return {
      ...ex,
      kind: "offsite",
      space_label: host ? host.name : ex.space_label,
    };
  });
}
