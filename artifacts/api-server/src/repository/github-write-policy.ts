import type { RepositoryRef } from "./github-provider";
import { redactGitSensitive } from "./git-security";

export type GitHubWriteErrorCode = "provider_not_configured" | "invalid_credential" | "permission_denied" | "conflict" | "protected_file" | "invalid_state" | "verification_failed";

export class GitHubWriteProviderError extends Error {
  constructor(readonly code: GitHubWriteErrorCode, message: string) {
    super(message);
  }
}

export type RepositoryWritePermission = {
  repository: RepositoryRef;
  branch: string;
  headSha: string;
  canPush: boolean;
  permission: "admin" | "push" | "pull" | "none";
};

export function classifyGitHubWriteFailure(
  status: number,
  message: string,
  rateLimitRemaining?: string | null,
): GitHubWriteProviderError {
  const safeMessage = redactGitSensitive(message).slice(0, 500) || "GitHub rejected the protected request.";
  if (status === 401) {
    return new GitHubWriteProviderError(
      "invalid_credential",
      "GitHub authorization is invalid or expired. Reconnect GitHub authorization before continuing.",
    );
  }
  if (status === 403 && (rateLimitRemaining === "0" || /rate limit/i.test(safeMessage))) {
    return new GitHubWriteProviderError("provider_not_configured", `GitHub rejected the request: ${safeMessage}`);
  }
  if (status === 403) {
    return new GitHubWriteProviderError("permission_denied", `GitHub rejected the request: ${safeMessage}`);
  }
  if (status === 409 || status === 422) {
    return new GitHubWriteProviderError("conflict", `GitHub rejected the request: ${safeMessage}`);
  }
  return new GitHubWriteProviderError("provider_not_configured", `GitHub rejected the request: ${safeMessage}`);
}

export function resolveRepositoryWritePermission(
  repository: RepositoryRef,
  branch: string,
  headSha: string,
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean },
): RepositoryWritePermission {
  const permission = permissions?.admin ? "admin" : permissions?.push ? "push" : permissions?.pull ? "pull" : "none";
  const canPush = permission === "admin" || permission === "push";
  if (!canPush) {
    throw new GitHubWriteProviderError(
      "permission_denied",
      `GitHub authorization is connected, but this account cannot push to ${repository.owner}/${repository.name} on ${branch}.`,
    );
  }
  return { repository, branch, headSha, canPush, permission };
}

export function assertRemoteHeadMatches(expectedHeadSha: string, actualHeadSha: string): void {
  if (expectedHeadSha !== actualHeadSha) {
    throw new GitHubWriteProviderError(
      "verification_failed",
      "The push result could not be verified against the remote branch. No push success was reported.",
    );
  }
}