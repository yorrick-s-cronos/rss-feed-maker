/**
 * HTML fetcher with timeout and retry.
 */

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 2;

// Browser-like headers to avoid Cloudflare/bot detection
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const API_HEADERS: Record<string, string> = {
  "User-Agent": "ai-rss-feeds/1.0",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const TLS_CERT_ERROR_PATTERNS = [
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "unable to verify the first certificate",
  "unable to get local issuer certificate",
  "self-signed certificate",
  "self signed certificate",
  "CERT_HAS_EXPIRED",
];

function isTlsCertError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err);
  return TLS_CERT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * fetch() that retries once with TLS verification disabled when the first
 * attempt fails with a certificate-chain error. Some sites (e.g. Medium-hosted
 * blogs like booking.ai) serve incomplete chains that browsers recover from via
 * AIA but Node/Bun reject. Read-only scraping makes this trade-off acceptable.
 */
export async function tolerantFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isTlsCertError(err)) throw err;
    console.warn(
      `⚠️  TLS chain verification failed for ${url} — retrying with verification disabled (read-only scrape).`
    );
    return await fetch(url, {
      ...(init ?? {}),
      tls: { rejectUnauthorized: false },
    } as RequestInit & { tls: { rejectUnauthorized: boolean } });
  }
}

/**
 * Fetch JSON from GitHub API (for github-releases mode).
 */
export async function fetchGitHubAPI(
  owner: string,
  repo: string,
  limit = 50,
  timeoutMs = DEFAULT_TIMEOUT
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${Math.min(limit, 100)}`;
  const headers: Record<string, string> = { ...API_HEADERS };

  // Use GITHUB_TOKEN if available for higher rate limits
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(url, {
    headers,
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
  }

  return await res.text();
}

export async function fetchHTML(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT,
  retries = DEFAULT_RETRIES
): Promise<string> {
  let lastError: Error | null = null;

  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await tolerantFetch(url, {
        headers: HEADERS,
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);

      if (!res.ok) {
        const cfMitigated = res.headers.get("cf-mitigated");
        if (res.status === 403 && cfMitigated) {
          throw new Error(
            `HTTP 403 — site is protected by Cloudflare bot detection (cf-mitigated: ${cfMitigated}). This site cannot be scraped with static HTTP requests.`
          );
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return await res.text();
    } catch (err) {
      lastError = err as Error;
      if (i < retries) {
        const wait = Math.min(2 ** i * 1000, 5000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw new Error(`Failed to fetch ${url}: ${lastError?.message}`);
}

/**
 * Check if a URL is reachable (HEAD request, follows redirects).
 */
export async function isReachable(
  url: string,
  timeoutMs = 10_000
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await tolerantFetch(url, {
      method: "HEAD",
      headers: HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
