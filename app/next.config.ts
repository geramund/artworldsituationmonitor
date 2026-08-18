import type { NextConfig } from "next";
import { fileURLToPath } from "url";
import { dirname } from "path";

// GitHub Pages (project site: geramund.github.io/artworldsituationmonitor/)
// serves from a subpath, so a static export needs basePath baked in. Local
// dev and any other deploy target stays at the root — set GH_PAGES=1 only
// for the export build (see scripts/build-pages.sh, run by
// .github/workflows/crawl.yml after every crawl).
const isGhPages = process.env.GH_PAGES === "1";
const basePath = isGhPages ? "/artworldsituationmonitor" : "";

const nextConfig: NextConfig = {
  // Silences the "multiple lockfiles" workspace-root warning — the repo root
  // (one level up) also has a package-lock.json for the pipeline/ scripts.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
  ...(isGhPages && {
    output: "export",
    basePath,
    assetPrefix: basePath,
    trailingSlash: true,
    env: { NEXT_PUBLIC_BASE_PATH: basePath },
    // Next's default build ID is random per build, which would make every
    // hourly crawl's docs/ rebuild look like a diff even when nothing real
    // changed. Pin it so git only sees a diff when content actually moved.
    generateBuildId: async () => "gh-pages",
  }),
};

export default nextConfig;
