// Name normalization (SPEC.md §15: "Artist name normalization is genuinely
// hard — diacritics, transliteration, collectives, name changes. Store the
// raw string alongside the normalized key, always.") Every function here
// returns a derived key; callers keep the raw string on the record itself.

const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(COMBINING_MARKS, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function surname(fullName: string): string {
  const parts = normalizeName(fullName).split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// Whole-word containment — "eve" must not match inside "steven".
export function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystack);
}
