// GitHub Pages project sites are served from a subpath
// (https://{user}.github.io/{repo}/), so every hardcoded root-absolute
// reference in the app (snapshot fetches, the MapLibre worker files) needs
// this prefix. Next's own routing/asset pipeline handles basePath
// automatically; this is only for the handful of places we build a URL by
// hand. Empty in local dev — see next.config.ts for where this gets set.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function withBasePath(path: string): string {
  return `${BASE_PATH}${path}`;
}
