export function parseGitHubUrl(value: string): { owner: string; name: string } {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Invalid repository URL. Use https://github.com/owner/repository.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("Invalid repository URL. Use https://github.com/owner/repository.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parsed.search || parsed.hash) {
    throw new Error("Invalid repository URL. Use https://github.com/owner/repository.");
  }
  return { owner: parts[0], name: parts[1].replace(/\.git$/, "") };
}

export function classifyGitHubResponse(
  status: number,
  contentType: string,
  rawBody: string,
  responseBody: { message?: string } | null,
): "ok" | "repository_not_found" | "branch_not_found" | "file_not_found" | "permission_denied" | "rate_limited" | "internal_route" | "service_unavailable" | "network" {
  const looksLikeHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(rawBody);
  if (looksLikeHtml) return "internal_route";
  if (status === 404) return "file_not_found";
  if (status === 401 || status === 403) {
    return status === 403 && (/rate limit/i.test(responseBody?.message ?? "") || responseBody?.message === undefined)
      ? "rate_limited"
      : "permission_denied";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  return status >= 200 && status < 300 ? "ok" : "network";
}

export type GitHubCredentialStatus = "connected" | "invalid" | "rate_limited" | "unavailable";

export function classifyGitHubCredentialStatus(
  status: number,
  contentType: string,
  rawBody: string,
  responseBody: { message?: string } | null,
): GitHubCredentialStatus {
  switch (classifyGitHubResponse(status, contentType, rawBody, responseBody)) {
    case "ok":
      return "connected";
    case "permission_denied":
      return "invalid";
    case "rate_limited":
      return "rate_limited";
    default:
      return "unavailable";
  }
}