export type GitHubRateState = "healthy" | "low" | "exhausted" | "unknown";

export type GitHubResourceStatus = {
  api: GitHubRateState;
  message: string;
  remaining: number | null;
  limit: number | null;
  resetAt: number | null;
  cache: {
    status: "warm" | "cold";
    hits: number;
    misses: number;
  };
};

const LOW_REMAINING = 25;
let rateState: GitHubResourceStatus["api"] = "unknown";
let remaining: number | null = null;
let limit: number | null = null;
let resetAt: number | null = null;
let cacheHits = 0;
let cacheMisses = 0;

export function recordGitHubResponse(headers: Headers, status: number, message = ""): void {
  const headerRemaining = Number(headers.get("x-ratelimit-remaining"));
  const headerLimit = Number(headers.get("x-ratelimit-limit"));
  const headerReset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(headerRemaining)) remaining = headerRemaining;
  if (Number.isFinite(headerLimit)) limit = headerLimit;
  if (Number.isFinite(headerReset)) resetAt = headerReset * 1000;
  const rateLimited = status === 429 || status === 403 && (remaining === 0 || /rate limit|secondary rate limit|abuse detection/i.test(message));
  if (rateLimited || remaining === 0) rateState = "exhausted";
  else if (remaining !== null && remaining <= LOW_REMAINING) rateState = "low";
  else if (status >= 200 && status < 400) rateState = "healthy";
}

export function recordCacheHit(): void {
  cacheHits += 1;
}

export function recordCacheMiss(): void {
  cacheMisses += 1;
}

export function getGitHubResourceStatus(): GitHubResourceStatus {
  const message =
    rateState === "healthy"
      ? "GitHub API: Healthy"
      : rateState === "low"
        ? "GitHub API: Rate limit low — using cache where possible"
        : rateState === "exhausted"
          ? "GitHub API: Rate limited — cached repository data available"
          : "GitHub API status is not known yet.";
  return {
    api: rateState,
    message,
    remaining,
    limit,
    resetAt,
    cache: {
      status: cacheHits > 0 ? "warm" : "cold",
      hits: cacheHits,
      misses: cacheMisses,
    },
  };
}