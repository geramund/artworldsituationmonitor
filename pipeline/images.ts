// Image backfill for crawled records that came back with no image. Most
// adapters only see a listing page, but a show with its own page usually
// declares a picture for link previews (og:image) — first-party, chosen by
// the venue, and the same thing a shared link would show. Verified
// 2026-10-07 on davidzwirner.com, drawingcenter.org, guggenheim.org and
// noguchi.org, which together had ~19 imageless shows.
//
// Guards against putting a site logo on a show:
//   - only records whose source_url is a page of its own (no "#anchor" into a
//     shared listing page, and not the venue homepage);
//   - an og:image identical to the homepage's, or shared by two different
//     shows, is the site-wide default (galeriebuchholz.de, fierman.nyc) and
//     is dropped;
//   - anything that looks like a logo/favicon/icon is dropped.
//
// `config.page_image` (a CSS selector) covers sites with real photos on each
// show page but no og:image (kaje.world, entrance.nyc): the first match's
// image is used when og:image is missing.

import * as cheerio from "cheerio";
import type { Venue, RawExhibition } from "../types/index.ts";
import { fetchHtmlPage } from "../adapters/html.ts";
import { robotsAllows } from "./robots.ts";

const LOGOISH = /logo|favicon|icon|placeholder|sprite/i;

function decode(u: string): string {
  return u.replace(/&amp;/g, "&");
}

function sameImage(a: string, b: string): boolean {
  const strip = (u: string) => {
    try {
      const url = new URL(u);
      return url.host + url.pathname;
    } catch {
      return u;
    }
  };
  return strip(a) === strip(b);
}

function ogImage($: cheerio.CheerioAPI, pageUrl: string): string | null {
  const raw =
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content");
  if (!raw) return null;
  try {
    return new URL(decode(raw), pageUrl).toString();
  } catch {
    return null;
  }
}

function selectorImage($: cheerio.CheerioAPI, selector: string, pageUrl: string): string | null {
  for (const el of $(selector).toArray()) {
    const $el = $(el);
    const img = $el.is("img") ? $el : $el.find("img").first();
    const src = img.attr("data-src") || img.attr("data-image") || img.attr("src");
    if (src && !src.startsWith("data:") && !LOGOISH.test(src)) {
      try {
        return new URL(decode(src), pageUrl).toString();
      } catch {
        /* try the next match */
      }
    }
  }
  return null;
}

export async function backfillImages(venue: Venue, records: RawExhibition[]): Promise<number> {
  const home = venue.url.replace(/\/$/, "");
  const candidates = records.filter(
    (r) => r.image_urls.length === 0 && !r.source_url.includes("#") && r.source_url.replace(/\/$/, "") !== home
  );
  if (candidates.length === 0) return 0;

  const pageSelector = (venue.config as { page_image?: string } | undefined)?.page_image;
  const homeHtml = await fetchHtmlPage(venue.url);
  const homeOg = homeHtml ? ogImage(cheerio.load(homeHtml), venue.url) : null;

  const found = new Map<RawExhibition, { url: string; fromOg: boolean }>();
  for (const r of candidates) {
    if (!(await robotsAllows(r.source_url))) continue;
    const html = await fetchHtmlPage(r.source_url);
    if (!html) continue;
    const $ = cheerio.load(html);
    let og = ogImage($, r.source_url);
    if (og && (LOGOISH.test(og) || (homeOg && sameImage(og, homeOg)))) og = null;
    const url = og ?? (pageSelector ? selectorImage($, pageSelector, r.source_url) : null);
    if (url) found.set(r, { url, fromOg: og !== null });
    await new Promise((res) => setTimeout(res, 250));
  }

  // An og:image used by two different shows is the site default, not a show.
  const ogUses = new Map<string, number>();
  for (const { url, fromOg } of found.values()) if (fromOg) ogUses.set(url, (ogUses.get(url) ?? 0) + 1);

  let filled = 0;
  for (const [r, { url, fromOg }] of found) {
    if (fromOg && (ogUses.get(url) ?? 0) > 1) continue;
    r.image_urls = [url];
    filled++;
  }
  return filled;
}
