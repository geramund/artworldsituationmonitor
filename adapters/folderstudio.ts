// folder.studio sites (deitch.com, verified 2026-10-07). The page shell is
// empty and the client loads content from `/lazystate/<path>`, a public
// JSON endpoint keyed by page URL: the exhibitions listing comes back
// together with every child page, each a `template: "exhibition"` object
// with ISO `openingdate`/`closingdate`, `title` and a street `location`.
// Structured and first-party — no HTML parsing at all.
//
// Config: `config.folderstudio.path` — the lazystate path for the venue's
// exhibitions section, e.g. "/lazystate/new-york/exhibitions".

import type { Venue, RawExhibition, Adapter } from "../types/index.ts";
import { CRAWLER_USER_AGENT } from "../pipeline/robots.ts";

interface FolderStudioConfig {
  path: string;
}

interface FsPage {
  url?: string;
  template?: string;
  title?: string;
  artists?: string;
  openingdate?: string;
  closingdate?: string;
  location?: string;
  files?: Record<string, { type?: string; url?: string }> | unknown[];
}

function isoDate(s: string | undefined): string | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function fetchFolderStudio(venue: Venue): Promise<RawExhibition[]> {
  const config = (venue.config as { folderstudio?: FolderStudioConfig } | undefined)?.folderstudio;
  if (!config) return [];

  let pages: Record<string, FsPage>;
  try {
    const res = await fetch(new URL(config.path, venue.url).toString(), { headers: { "User-Agent": CRAWLER_USER_AGENT } });
    if (!res.ok) return [];
    pages = (await res.json()) as Record<string, FsPage>;
  } catch {
    return [];
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const out: RawExhibition[] = [];
  for (const page of Object.values(pages)) {
    if (page.template !== "exhibition" || !page.title || !page.url) continue;
    const opens = isoDate(page.openingdate);
    const closes = isoDate(page.closingdate);
    if (closes ? closes < today : !opens) continue;

    const image = (Array.isArray(page.files) ? [] : Object.values(page.files ?? {})).find((f) => f.type === "image")?.url;
    const artists = (page.artists ?? "")
      .split(/\s*,\s*/)
      .map((a) => a.trim())
      .filter(Boolean);
    out.push({
      title: page.title.trim(),
      artists,
      opens,
      closes,
      space_label: page.location?.trim() || null,
      excerpt: "",
      press_release_url: null,
      image_urls: image ? [new URL(image, venue.url).toString()] : [],
      image_credit: null,
      works: [],
      source_url: new URL(page.url, venue.url).toString(),
      confidence: 0.85,
      fetched_at: now.toISOString(),
    });
  }
  return out;
}

const folderStudioAdapter: Adapter = { id: "folderstudio", fetch: fetchFolderStudio };
export default folderStudioAdapter;
