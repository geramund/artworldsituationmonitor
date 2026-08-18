// Copies maplibre-gl's worker + its shared.mjs sibling into public/, where
// they're served as plain static files. Needed because Turbopack doesn't
// correctly bundle maplibre-gl's `new Worker(new URL(...))` pattern — the
// worker's relative import of maplibre-gl-shared.mjs fails silently in the
// bundled output, so no vector tiles ever get requested and the map stays
// blank. setWorkerUrl() in MapView.tsx points at these copies instead.
// Re-run (via `npm install`'s postinstall) any time maplibre-gl is upgraded.

import { copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "node_modules", "maplibre-gl", "dist");
const DEST = join(__dirname, "..", "public");

for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(SRC, file), join(DEST, file));
  console.log(`copied ${file} -> public/`);
}
