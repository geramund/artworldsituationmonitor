// Platform detection (SPEC.md §5.1). Run once per new venue — never assume a
// platform. Order matters: a platform's own data API beats HTML parsing, so
// CMS-API signatures (Sanity, WordPress, __NEXT_DATA__) are checked before
// falling back to JSON-LD or the sitemap heuristic.

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import type { AdapterId, Venue } from "../types/index.ts";
import { robotsAllows, CRAWLER_USER_AGENT } from "../pipeline/robots.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const VENUES_DIR = join(ROOT, "registry/venues");

export interface FingerprintResult {
  adapter: AdapterId;
  signature: string;
}

export async function fingerprintVenue(url: string): Promise<FingerprintResult | { blocked: true }> {
  if (!(await robotsAllows(url))) return { blocked: true };

  let html = "";
  let headers: Headers | null = null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": CRAWLER_USER_AGENT }, redirect: "follow" });
    headers = res.headers;
    html = await res.text();
  } catch (err) {
    return { adapter: "sitemap", signature: `fetch failed: ${(err as Error).message}` };
  }

  const server = headers?.get("server") ?? "";
  const poweredBy = headers?.get("x-powered-by") ?? "";

  if (/cdn\.sanity\.io|apicdn\.sanity\.io/i.test(html)) {
    return { adapter: "sanity", signature: "cdn.sanity.io reference in HTML" };
  }
  if (/artlogic\.net/i.test(html)) {
    return { adapter: "artlogic", signature: "artlogic.net reference in HTML" };
  }
  if (/exhibit-e|exhibitegallery/i.test(html)) {
    return { adapter: "exhibite", signature: "exhibit-e/exhibitegallery reference in HTML" };
  }
  if (/wp-content|wp-json|wp-includes/i.test(html) || /wordpress/i.test(poweredBy)) {
    // confirm the REST API is actually reachable before committing to wordpress
    try {
      const wpRes = await fetch(new URL("/wp-json/", url).toString(), {
        headers: { "User-Agent": CRAWLER_USER_AGENT },
      });
      if (wpRes.ok) return { adapter: "wordpress", signature: "/wp-json/ reachable" };
    } catch {
      /* fall through */
    }
    if (/wp-content/i.test(html)) return { adapter: "wordpress", signature: "wp-content path in HTML, /wp-json/ unreachable" };
  }
  if (/__NEXT_DATA__/.test(html) || /"buildId"\s*:/.test(html)) {
    return { adapter: "nextdata", signature: "__NEXT_DATA__ present" };
  }
  if (/<script[^>]+type=["']application\/ld\+json["']/i.test(html) && /"@type"\s*:\s*"(Event|ExhibitionEvent)"/i.test(html)) {
    return { adapter: "jsonld", signature: "JSON-LD Event/ExhibitionEvent block present" };
  }
  if (/squarespace-cdn|static1\.sqsp/i.test(html) || /squarespace/i.test(server)) {
    return { adapter: "squarespace", signature: "squarespace-cdn reference in HTML" };
  }
  return { adapter: "sitemap", signature: "no known platform signature matched" };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const files = readdirSync(VENUES_DIR).filter((f) => f.endsWith(".json"));
  const distribution: Record<string, number> = {};
  const blocked: string[] = [];
  const noUrl: string[] = [];

  for (const file of files) {
    const path = join(VENUES_DIR, file);
    const venue = JSON.parse(readFileSync(path, "utf8")) as Venue;
    if (!venue.url) {
      noUrl.push(venue.id);
      continue;
    }

    const result = await fingerprintVenue(venue.url);
    if ("blocked" in result) {
      blocked.push(venue.id);
      console.log(`${venue.id.padEnd(38)} BLOCKED by robots.txt`);
      await sleep(300);
      continue;
    }

    console.log(`${venue.id.padEnd(38)} ${result.adapter.padEnd(11)} ${result.signature}`);
    distribution[result.adapter] = (distribution[result.adapter] ?? 0) + 1;

    // Record the fingerprint but don't switch a venue over to a real
    // adapter here — that's a deliberate decision made after seeing the
    // distribution, applied by hand once the corresponding adapter exists.
    venue.notes = venue.notes
      ? `${venue.notes}\n\nFingerprint (${new Date().toISOString().slice(0, 10)}): ${result.adapter} — ${result.signature}.`
      : `Fingerprint (${new Date().toISOString().slice(0, 10)}): ${result.adapter} — ${result.signature}.`;
    writeFileSync(path, JSON.stringify(venue, null, 2) + "\n");

    await sleep(300);
  }

  console.log("\n--- DISTRIBUTION ---");
  for (const [adapter, count] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`${adapter.padEnd(11)} ${count}`);
  }
  if (blocked.length) console.log(`\nblocked by robots.txt: ${blocked.join(", ")}`);
  if (noUrl.length) console.log(`no url on file: ${noUrl.join(", ")}`);
}

main();
