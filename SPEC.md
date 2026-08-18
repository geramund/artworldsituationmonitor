# ART WORLD SITUATION MONITOR — Build Brief

## 1. What this is

A geospatial situation-monitor for contemporary art, built in the visual and interaction language of OSINT / geopolitical dashboards (`monitor-the-situation.com`, `worldmonitor.app`, `worldsituationmonitor.com`).

The joke and the thesis are the same: the art world already behaves like a theater of operations — capital flows, coordinated openings, fair-week surges, institutional flashpoints, seasonal dark periods — and rendering it in the vocabulary of threat assessment makes that legible rather than merely funny. **Build it straight-faced.** No winking copy, no "DEFCON: CHELSEA" jokes in the UI. The frame does the work; commentary on top of it kills it.

The user should be able to:

- Zoom into a locale (Tribeca, Lower East Side, Belleville, Caochangdi, Kreuzberg) and see every venue with something on view
- Click a venue and get a dossier: current exhibition, dates, artists, press release, installation views, works checklist, source link
- Watch news and criticism arrive in a ticker, **linked to the specific exhibition it concerns** wherever resolvable
- Toggle layers, scrub a time range, and share the exact view as a URL
- See biennials, triennials, and fairs as a global layer with their own date windows
- See what *changed* — openings, closings, extensions, newly posted documentation — not just what currently is

---

## 2. Non-negotiables

1. **Never rehost press releases, articles, or images wholesale.** Store: title, dates, artists, an excerpt (≤300 chars), source URL, and image URLs referenced by link with the photographer credit where given. Every dossier links out.
2. **Be a polite crawler.** Respect `robots.txt`. Descriptive User-Agent with a contact address. ≤1 request/sec per host. Conditional requests (`ETag` / `If-Modified-Since`). Cache aggressively. A publicly readable CMS API is not an invitation to hammer it.
3. **Provenance on every record.** `source_url`, `adapter`, `fetched_at`, `confidence`. Nothing renders in the UI without a traceable origin.
4. **Coverage is a first-class, visible concept.** Regions with no adapter render as no-data, not as empty. An honest coverage map is more in-genre than fake completeness.
5. **Degrade gracefully.** A dead adapter must never take down the map, and must never silently blank a venue. Last-good snapshot always renders, with a stale-since timestamp.
6. **August is real.** Galleries go dark for weeks. Render that as a genuine state, not a bug.

---

## 3. Repo layout

```
registry/
  venues/*.json        the venue registry — the project's actual asset
  nexus.json           biennials, triennials, fairs
  outlets.json         news feeds
adapters/
  fingerprint.ts       platform detection; run once per new venue
  sanity.ts artlogic.ts exhibite.ts nextdata.ts jsonld.ts
  wordpress.ts squarespace.ts sitemap.ts
  gallerypress.ts      gallery-curated press listings
  rss.ts               outlet feeds
  manual.ts            hand-curated records; authoritative, never overwritten
pipeline/
  crawl.ts             the loop
  normalize.ts         RawRecord -> Venue | Exhibition | Article
  geocode.ts           cached, one-time per space
  diff.ts              change detection + event emission
  resolve.ts           entity resolution, article <-> exhibition linking
  snapshot.ts          versioned JSON bundles, per city and global
snapshots/             committed output; the client reads only this
app/                   Next.js client; static, never scrapes at runtime
```

---

## 4. The venue registry

This is the thing you maintain. Everything else is machinery around it.

```jsonc
{
  "id": "bortolami",
  "name": "Bortolami",
  "kind": "gallery",              // gallery|museum|institution|artist_run|nonprofit|fair_site
  "city": "nyc",
  "district": "tribeca",
  "url": "https://www.bortolamigallery.com",
  "spaces": [
    { "label": "39 Walker",   "address": "39 Walker Street, New York, NY 10013",
      "lat": null, "lng": null },
    { "label": "55 Walker",   "address": "55 Walker Street, New York, NY 10013",
      "lat": null, "lng": null },
    { "label": "The Upstairs", "address": "39 Walker Street, New York, NY 10013",
      "lat": null, "lng": null }
  ],
  "adapter": "sanity",
  "config": { "projectId": "mnub8q5m", "dataset": "production" },
  "paths": { "exhibitions": "/exhibitions", "press": "/press", "news": "/news" },
  "cadence": "weekly",            // set automatically; see §6
  "hours": "Tue–Sat 10–6",
  "health": {
    "last_attempt": null, "last_success": null,
    "record_count": 0, "consecutive_failures": 0, "status": "unknown"
  },
  "notes": ""
}
```

Notes on fields:

- **`spaces`, not a single point.** Galleries with multiple rooms at different addresses are common, and "which space" is exactly the information someone walking around needs. An exhibition points at a space, not just a venue.
- **Coordinates resolve once and cache forever.** Geocode from the venue's own contact page via Nominatim; hand-correct anything that lands wrong; then never call the geocoder again for that space.
- **`adapter` and `config` are set once**, by fingerprinting (§5). After that the crawl loop is dumb.
- **Do not trust any coordinates or addresses written in this document.** Verify each from the venue's own site at registry-creation time.

---

## 5. Adapters

### 5.1 Fingerprint first

Never assume a platform. For any new venue, fetch the homepage and one exhibition page, then route:

| Signature in HTML / headers | Adapter |
|---|---|
| `cdn.sanity.io`, `apicdn.sanity.io` | `sanity` |
| `artlogic.net`, `*.artlogic.net` | `artlogic` |
| `exhibit-e`, `exhibitegallery` | `exhibite` |
| `/wp-json/` reachable, `wp-content` | `wordpress` |
| `__NEXT_DATA__` or RSC payload present | `nextdata` |
| `<script type="application/ld+json">` with Event/ExhibitionEvent | `jsonld` |
| `squarespace-cdn`, `static1.sqsp` | `squarespace` |
| none of the above | `sitemap` |

Order matters: a platform's own data API beats HTML parsing every time, so check for Sanity / WordPress / `__NEXT_DATA__` before falling back to JSON-LD or heuristics. Record the winning signature in `notes` so a future redesign is diagnosable.

### 5.2 Adapter contract

Every adapter exports the same shape. The crawl loop knows nothing about platforms.

```ts
interface RawExhibition {
  title: string | null;
  artists: string[];
  opens: string | null;          // ISO; null if unparseable, do not guess
  closes: string | null;
  space_label: string | null;    // matched against registry spaces
  body: string | null;           // full text, used for excerpt only
  press_release_url: string | null;
  image_urls: string[];
  image_credit: string | null;
  works: { title: string; year: string }[];
  source_url: string;
  confidence: number;            // 0–1, adapter's own assessment
}

interface Adapter {
  id: string;
  fetch(venue: Venue): Promise<RawExhibition[]>;
}
```

### 5.3 Worked example — Bortolami

Custom front end on **Sanity**, project `mnub8q5m`, dataset `production`. Each exhibition page server-renders artist, title, date range, space (39 Walker / 55 Walker / The Upstairs), a full set of installation views on the Sanity CDN with photographer credit, a press release PDF, and a works checklist with titles and years. Everything a dossier needs is in the HTML.

Additionally: if the dataset reads public — likely, since the CDN image URLs are unsigned — the GROQ endpoint returns the whole exhibition archive as structured JSON with no extraction heuristics at all:

```
https://{projectId}.api.sanity.io/v1/data/query/{dataset}?query={groq}
```

Test this per site. If it 401s, fall through to `nextdata`, then HTML. Apply the same logic to any headless-CMS site you fingerprint: try the CMS API, fall back to the rendered page.

### 5.4 `gallerypress`

Many galleries maintain a Press page listing coverage with author, headline, outlet, and date already attached to the gallery. That is pre-linked article data, and — more valuable — a ground-truth set for testing the resolution layer in §8. Link out to the outlet, never to the gallery's PDF scan.

---

## 6. The crawl loop

```
for venue in registry where due(venue):
    if not robots_allows(venue): skip, mark blocked
    raw     = adapters[venue.adapter].fetch(venue)   // conditional request
    records = normalize(raw, venue)
    events  = diff(records, last_good[venue])
    if plausible(records, last_good[venue]):
        write(records); emit(events); health.ok()
    else:
        keep last_good; health.suspect(reason)
```

### Cadence tiers

Exhibitions run six-to-eight-week cycles. Uniform daily polling is pointless load.

| Tier | Cadence |
|---|---|
| Venue with a show opening or closing within 7 days | daily |
| Venue with a show currently on view | weekly |
| Venue dark or between seasons | weekly |
| Venue with an announced reopening date | daily from 3 days prior |
| News outlet RSS | hourly |
| Nexus (biennials, fairs) | monthly, mostly hand-maintained |

Cadence is computed from the data, not hand-set. Two hundred galleries polled weekly, sequentially, at one request per second, is a ten-minute job. Hash the normalized extraction and write only on actual change.

### The failure mode that matters

Sites rarely go down. They get **quietly redesigned**, and the adapter starts returning zero records without erroring. So `plausible()` is the most important function in the pipeline:

- Venue returned N > 0 records last run and 0 now → **do not write.** Keep last-good, mark `suspect`, surface in the coverage layer.
- Every date in the set shifts at once → suspect.
- All titles change but all URLs stay the same → suspect.
- `consecutive_failures >= 3` → mark venue `stale` in the UI and put it in the review queue.

Suspect never silently overwrites. A wrong empty state is worse than a slightly old one.

---

## 7. Diff and the event stream

**This is what makes it a monitor rather than a directory.** Situation dashboards show events, not states. Store the changelog, not just the current snapshot.

Event types:

| Event | Trigger |
|---|---|
| `ANNOUNCED` | exhibition appears in upcoming |
| `OPENED` | `opens` reached, or moves into current |
| `CLOSING_SOON` | ≤7 days remaining |
| `CLOSED` | past `closes` |
| `EXTENDED` | `closes` pushed later |
| `DOCUMENTATION_POSTED` | installation views appear — typically 1–2 weeks after opening, a real signal |
| `PRESS_RELEASE_POSTED` | PR PDF or body text appears |
| `CHECKLIST_POSTED` | works list appears |
| `PRESS_ADDED` | article linked to this exhibition |
| `VENUE_DARK` | no current exhibition, venue previously active |
| `VENUE_STALE` | adapter suspect ≥3 runs |

The event stream is the ticker. It is also the honest answer to "what's happening" in a month when nothing is on view.

### Infrastructure

Run the crawl in **GitHub Actions**, committing snapshot JSON back to the repo. You get versioned history of every change for free, the client stays fully static, and **the diff between commits is the event log** — no separate changelog table. Vercel cron works too but throws away the history that makes this interesting.

---

## 8. Data model

```ts
Venue      { id, name, kind, city, district, url, spaces: Space[], adapter, config,
             cadence, hours, health, notes }
Space      { label, address, lat, lng }
Exhibition { id, venue_id, space_label, title, artists: string[],
             kind: 'solo'|'two_person'|'group'|'screening'|'performance'|'offsite',
             opens, closes, opening_reception?, status,
             excerpt, press_release_url, image_urls, image_credit,
             works, source_url, fetched_at, confidence }
Article    { id, outlet, headline, byline?, published, url, excerpt,
             links: { exhibition_id?, venue_ids: [], artist_names: [] },
             link_confidence }
Nexus      { id, kind: 'biennial'|'triennial'|'fair'|'festival', name, edition,
             city, country, opens, closes, venue_ids, url }
Event      { id, ts, type, venue_id, exhibition_id?, article_id?, payload }
Signal     { derived only: district_activity, openings_this_week,
             closing_within_7d, fair_week, venues_dark }
```

`status` is derived at snapshot time from dates, never stored raw: `upcoming | open | closing_soon | closed`. Offsite exhibitions (a gallery's artist showing at a museum elsewhere) are real and worth keeping, but must not place a marker on the gallery's own building.

### Entity resolution — the hard part

Article-to-exhibition linking is where this project either sings or falls apart. Layer it, cheapest first, and stop at the first confident hit:

1. **URL match** — the article links to the gallery's exhibition page. Highest confidence, free.
2. **Name + date window** — normalized artist name AND venue name both present, `published` within `opens − 14d … closes + 30d`.
3. **Fuzzy** — artist surname + city, or venue name alone, producing a candidate set.
4. **LLM adjudication** — for candidate sets of 2+, one batched call: given headline + excerpt and N candidates, return `{ exhibition_id | null, confidence }`. Cache by article ID. Never at request time.

Surface link confidence in the UI as connector line weight (solid / dashed / dotted). Keep an explicit **unlinked** bucket. Validate the whole cascade against the gallery-curated press listings from §5.4 — you have ground truth, use it.

---

## 9. Snapshots and delivery

- Crawl writes to `snapshots/{city}.json` and `snapshots/global.json`, plus `snapshots/events.json` (rolling 90 days).
- Each snapshot carries `generated_at`, `coverage` (venues live / stale / dark / blocked), and a schema version.
- Client fetches snapshots only. No runtime scraping, no server dependency, no API keys in the browser.
- Snapshots are small: 200 venues with current exhibitions is a few hundred KB before compression.

---

## 10. Layers

Left rail, toggleable, each with a live count. Mapped deliberately onto the geopolitical originals:

| Layer | Contents |
|---|---|
| `openings` | Receptions in the selected window — the closest thing to live activity |
| `on_view` | All currently open exhibitions |
| `closing` | Closing within 7 days |
| `institutions` | Museums and kunsthalles, distinct marker weight |
| `artist_run` | Artist-run and nonprofit spaces |
| `nexus` | Biennials, triennials, fairs — global, available even in uncovered cities |
| `press` | Articles and reviews, drawn at the venue they concern |
| `offsite` | Represented artists showing elsewhere; drawn at the host institution |
| `dark` | Venues with nothing on view — seasonal closure made visible |
| `coverage` | Adapter health: live / stale / blocked / no adapter |
| `market` | Auction dates, fair VIP days (Phase 4, optional) |
| `flashpoints` | Closures, deaccessioning disputes, labor actions, protests — from news, manually confirmed only |

Do not invent a fake threat level per city. **Do** compute an honest **activity index** (openings + closings + press mentions, normalized per district per week) and render it as a heat wash. During fair weeks it spikes on its own. That is the whole point.

---

## 11. Interface

- **Map:** MapLibre GL JS. Protomaps or CARTO dark-matter basemap, stripped to coastline, water, road casing, district labels. No POI clutter — the venues are the only points of interest. Marker glyph by venue kind; opacity by recency.
- **Left rail:** layer stack with counts, adapter health summary, city selector.
- **Bottom ticker:** the event stream (§7), monospace, click-to-dossier.
- **Right drawer (dossier):** venue, space, coordinates, current exhibition, dates with days-remaining, artists, press release excerpt + link, installation-view strip with credit, works checklist, linked articles with confidence, and **adjacent openings within 400m** — the walkable-cluster feature that makes this useful on a Thursday night.
- **Top bar:** time-range scrubber (`24h / 7d / 30d / season`), search across artists / venues / exhibitions, UTC + local clock, last-sync timestamp.
- **URL state:** every control serializes, as in the reference apps — `?city=nyc&zoom=13.2&layers=openings,on_view,press&range=7d&venue=bortolami`. Deep links restore the full view.
- **Keyboard:** `/` search, `L` layers, `Esc` close, arrows pan. Visible focus rings. Responsive to mobile. `prefers-reduced-motion` respected.

### Aesthetic direction

Dark, dense, hairline, monospace-dominant, zero border-radius, ALL-CAPS letterspaced labels, tabular numerals throughout. Where the reference apps default to acid green or hazard amber, **derive the accent palette from art handling rather than hacker terminal** — this is the one place to be specific instead of generic:

```
#0B0C0C  ground
#151717  panel
#2A2D2D  hairline
#E8E4DA  press-release paper — primary text, warm against the cold ground
#C8511B  crate stencil orange — openings, live activity
#B4121B  condition-report red — closing soon, flashpoints
#4C6FA5  cyanotype blue — press and criticism
#5A5F5F  dark / no-data / stale
```

Type: one grotesque for UI labels (Söhne, Untitled Sans, or Inter Tight if constrained); one mono for data and coordinates (Berkeley Mono if licensed, else JetBrains Mono). Exhibition titles get the single italic serif in the system — the art world's own typographic convention, imported into the HUD as the one soft element in an otherwise hard interface.

Motion: restrained. New events blip in once. A thin crosshair reticle with live coordinate readout follows the cursor. Nothing pulses forever.

**Signature element: the adjacency graph.** Selecting a venue draws thin connectors to nearby simultaneous openings *and* to the articles that mention them — so a night's walking route and a discourse cluster turn out to be the same object. That is what this app will be remembered for. Keep everything else quiet.

---

## 12. Phases

**Phase 1 — Skeleton with real data. Ship this before writing any pipeline.**
Hand-build `registry/venues/` for ~30 Tribeca and Lower East Side venues; hand-enter their current exhibitions via `manual.ts`. Build map, layers, dossier, URL state, and a ticker fed by outlet RSS only. No scraping. This must look finished before Phase 2 begins.

**Phase 2 — Exhibition ingestion.**
Build `fingerprint.ts` and run it across all seed venues *before* writing any parser — the observed platform distribution determines which adapters to build and in what order. Then the top two or three adapters by coverage. Add the registry-driven crawl loop, `plausible()`, dry-run diff mode, and a review queue.

**Phase 3 — Events and press.**
Diff engine and event stream. Outlet feeds: Artforum, ARTnews, The Art Newspaper, Hyperallergic, Frieze, e-flux, Contemporary Art Daily, Ocula. Then the resolution cascade, connectors, and the unlinked bucket, validated against gallery press pages.

**Phase 4 — Nexus and expansion.**
Biennials / triennials / fairs from Wikidata, Universes in Universe, and hand curation — few enough to curate well, and they give global coverage cheaply. Then cities one adapter-cluster at a time: London, Berlin, Paris, LA, Mexico City, Seoul, Shanghai / Beijing.

### Report after each phase

- Coverage: venues live / stale / blocked / no adapter
- Exhibition records with `confidence < 0.7`
- Articles linked vs. unlinked, plus false-link rate on a 20-record manual spot check
- Median staleness of currently displayed records

---

## 13. Seed venues (verify everything)

Starting set for Phase 1, Tribeca and Lower East Side. **Names only — resolve every address, space list, and coordinate from the venue's own site.** Some of these will have moved, merged, or closed; treat closures as data, not errors.

Tribeca: Bortolami · Andrew Kreps · kaufmann repetto · James Cohan · 52 Walker · Broadway · Alexander and Bonin · Bureau · Kapp Kapp · Ortuzar · PPOW · Chapter NY · Andrew Edlin · Alexander Gray · Canada · Theta · Fanta-MRLB · Hesse Flatow

Lower East Side: Bridget Donahue · Miguel Abreu · Derosia · James Fuentes · Kai Matsumiya · Foxy Production · Company · Nicelle Beauchene · Signs and Symbols · Rachel Uffner · SITUATIONS · Fierman

Institutions for the `institutions` layer: New Museum · Swiss Institute · Artists Space · The Kitchen · Whitney · MoMA PS1 · Dia Chelsea · Storefront for Art and Architecture

---

## 14. Pin these before writing code

State your choice in one line each, then proceed:

1. Datastore, or flat JSON in-repo only (flat JSON is viable at this scale and simplifies everything)
2. Review queue: a route in the app, or a CLI
3. Whether `manual.ts` records live in the registry files or separately
4. Snapshot schema versioning strategy
5. Geocoder, and where its cache lives

---

## 15. Known risks

- **Adapter rot** is continuous, not occasional. Budget maintenance time, and make `plausible()` strict from day one.
- **Gallery sites are frequently unparseable by design** — image-only pages, Flash-era holdovers, Instagram-only programs. Some venues will be manual forever. That is fine; mark them `manual` and move on.
- **Artist name normalization** is genuinely hard (diacritics, transliteration, collectives, name changes). Store the raw string alongside the normalized key, always.
- **Opening reception times are rarely on the website** — they live in mailing lists and Instagram. The `openings` layer will be incomplete unless you accept a manual input path for it.
- **Do not build a viewership metric.** The temptation to score galleries by activity, press, or "importance" will arise. It would make the project a ranking product, which is a different and worse thing.
