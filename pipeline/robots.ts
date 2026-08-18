// Shared robots.txt gate (SPEC.md §2 — "Be a polite crawler. Respect
// robots.txt."). Coarse but sufficient for our own crawl: only checks a
// blanket Disallow under a `User-agent: *` block against the site root.

const CONTACT_EMAIL = "anastasios.karnazes@gmail.com";
export const CRAWLER_USER_AGENT = `ArtWorldSituationMonitor/0.1 (contact: ${CONTACT_EMAIL})`;

const robotsCache = new Map<string, string | null>();

async function fetchRobotsTxt(origin: string): Promise<string | null> {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": CRAWLER_USER_AGENT },
    });
    const text = res.ok ? await res.text() : null;
    robotsCache.set(origin, text);
    return text;
  } catch {
    robotsCache.set(origin, null);
    return null;
  }
}

function robotsAllowsRoot(robotsTxt: string | null): boolean {
  if (!robotsTxt) return true;
  const lines = robotsTxt.split("\n").map((l) => l.trim());
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.toLowerCase().trim();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*";
    if (applies && key === "disallow" && (value === "/" || value === "")) {
      return value !== "/";
    }
  }
  return true;
}

export async function robotsAllows(url: string): Promise<boolean> {
  const origin = new URL(url).origin;
  const robotsTxt = await fetchRobotsTxt(origin);
  return robotsAllowsRoot(robotsTxt);
}
