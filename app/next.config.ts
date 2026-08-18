import type { NextConfig } from "next";
import { fileURLToPath } from "url";
import { dirname } from "path";

const nextConfig: NextConfig = {
  // Silences the "multiple lockfiles" workspace-root warning — the repo root
  // (one level up) also has a package-lock.json for the pipeline/ scripts.
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
