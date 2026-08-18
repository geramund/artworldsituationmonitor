#!/usr/bin/env bash
# Builds the static export for GitHub Pages (Settings -> Pages -> Deploy from
# a branch -> main /docs) and drops it at repo-root docs/. Pages serves
# whatever's committed there directly — no Actions deploy step needed, just
# this script's output committed on main. .github/workflows/crawl.yml runs
# this after every crawl so the published site never drifts from the data.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd app && GH_PAGES=1 npm run build)

rm -rf docs
cp -r app/out docs
touch docs/.nojekyll # Jekyll ignores _next/ (leading underscore) by default — must disable it

echo "docs/ rebuilt from app/out/"
