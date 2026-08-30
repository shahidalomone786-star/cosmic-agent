import type { RepositoryRef } from "./github-provider";
import { getCurrentAuthUser } from "../middlewares/auth-middleware";
import { getGitHubCredential, updateGitHubCredentialStatus } from "../lib/github-credentials";
import { assertSafePush, assertSafeRepositoryPath, redactGitSensitive } from "./git-security";
import {
  assertRemoteHeadMatches,
  classifyGitHubWriteFailure,
  GitHubWriteProviderError,
  resolveRepositoryWritePermission,
  type RepositoryWritePermission,
} from "./github-write-policy";
export { GitHubWriteProviderError } from "./github-write-policy";
export { assertRemoteHeadMatches } from "./github-write-policy";
export type { RepositoryWritePermission } from "./github-write-policy";

export type WriteRepositoryState = {
  repository: RepositoryRef;
  branch: string;
  headSha: string;
};

export type CreateCommitInput = {
  repository: RepositoryRef;
  branch: string;
  expectedHeadSha: string;
  message: string;
  files: Array<{ path: string; content: string }>;
};

export type CommitResult = {
  repository: RepositoryRef;
  branch: string;
  commitSha: string;
  shortSha: string;
};

export type PushResult = {
  repository: RepositoryRef;
  branch: string;
  commitSha: string;
  shortSha: string;
};

export type GitStatus = {
  repository: RepositoryRef;
  branch: string;
  headSha: string;
  clean: boolean;
  stagedFiles: string[];
};

export type GitDiff = {
  repository: RepositoryRef;
  branch: string;
  baseSha: string;
  headSha: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  summary: string;
};

export type BranchComparison = {
  unchanged: boolean;
  expectedHeadSha: string;
  actualHeadSha: string;
};

export interface GitHubWriteProvider {
  getStatus(repository: RepositoryRef, branch: string, stagedFiles?: string[]): Promise<GitStatus>;
  getDiff(repository: RepositoryRef, branch: string, baseSha?: string): Promise<GitDiff>;
  getRepositoryState(repository: RepositoryRef, branch: string): Promise<WriteRepositoryState>;
  checkRepositoryPermission(repository: RepositoryRef, branch: string): Promise<RepositoryWritePermission>;
  compareBranch(repository: RepositoryRef, branch: string, expectedHeadSha: string): Promise<BranchComparison>;
  createCommit(input: CreateCommitInput): Promise<CommitResult>;
  pushBranch(repository: RepositoryRef, branch: string, expectedHeadSha: string, commitSha: string): Promise<PushResult>;
  lookupCommit(repository: RepositoryRef, commitSha: string): Promise<CommitResult>;
}

class NotConfiguredGitHubWriteProvider implements GitHubWriteProvider {
  getStatus(_repository: RepositoryRef, _branch: string, _stagedFiles?: string[]): Promise<GitStatus> { return Promise.reject(this.unavailable()); }
  getDiff(_repository: RepositoryRef, _branch: string, _baseSha?: string): Promise<GitDiff> { return Promise.reject(this.unavailable()); }
  private unavailable(): never {
    throw new GitHubWriteProviderError(
      "provider_not_configured",
      "GITHUB_PROVIDER_NOT_CONFIGURED",
    );
  }

  getRepositoryState(_repository: RepositoryRef, _branch: string): Promise<WriteRepositoryState> {
    return Promise.reject(this.unavailable());
  }

  checkRepositoryPermission(_repository: RepositoryRef, _branch: string): Promise<RepositoryWritePermission> {
    return Promise.reject(this.unavailable());
  }

  compareBranch(_repository: RepositoryRef, _branch: string, _expectedHeadSha: string): Promise<BranchComparison> {
    return Promise.reject(this.unavailable());
  }

  createCommit(_input: CreateCommitInput): Promise<CommitResult> {
    return Promise.reject(this.unavailable());
  }

  pushBranch(_repository: RepositoryRef, _branch: string, _expectedHeadSha: string, _commitSha: string): Promise<PushResult> {
    return Promise.reject(this.unavailable());
  }

  lookupCommit(_repository: RepositoryRef, _commitSha: string): Promise<CommitResult> {
    return Promise.reject(this.unavailable());
  }
}

class GitHubApiWriteProvider implements GitHubWriteProvider {
  private async request<T>(repository: RepositoryRef, method: string, route: string, body?: unknown): Promise<T> {
    const user = getCurrentAuthUser();
    if (!user) throw new GitHubWriteProviderError("provider_not_configured", "GitHub authorization/configuration is required for protected Git operations.");
    const credential = await getGitHubCredential(user.id);
    if (!credential?.token || credential.status !== "connected") {
      throw new GitHubWriteProviderError("provider_not_configured", "GitHub authorization/configuration is required for protected Git operations.");
    }
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Cosmic-Agent-Write-Provider",
        Authorization: `Bearer ${credential.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = redactGitSensitive(await response.text(), [credential.token]);
    let parsed: unknown = undefined;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { /* handled below */ }
    if (!response.ok) {
      const message = typeof parsed === "object" && parsed && "message" in parsed && typeof parsed.message === "string"
        ? redactGitSensitive(parsed.message)
        : "GitHub rejected the protected request.";
      const failure = classifyGitHubWriteFailure(response.status, message, response.headers.get("x-ratelimit-remaining"));
      if (failure.code === "invalid_credential") {
        await updateGitHubCredentialStatus(user.id, "invalid", false).catch(() => undefined);
      }
      throw failure;
    }
    return parsed as T;
  }

  async getRepositoryState(repository: RepositoryRef, branch: string): Promise<WriteRepositoryState> {
    validateBranch(branch);
    const ref = await this.request<{ object: { sha: string } }>(repository, "GET", `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return { repository, branch, headSha: ref.object.sha };
  }

  async checkRepositoryPermission(repository: RepositoryRef, branch: string): Promise<RepositoryWritePermission> {
    validateBranch(branch);
    const metadata = await this.request<{
      permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
    }>(repository, "GET", `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`);
    const state = await this.getRepositoryState(repository, branch);
    return resolveRepositoryWritePermission(repository, branch, state.headSha, metadata.permissions);
  }

  async compareBranch(repository: RepositoryRef, branch: string, expectedHeadSha: string): Promise<BranchComparison> {
    const state = await this.getRepositoryState(repository, branch);
    return { unchanged: state.headSha === expectedHeadSha, expectedHeadSha, actualHeadSha: state.headSha };
  }

  async getStatus(repository: RepositoryRef, branch: string, stagedFiles: string[] = []): Promise<GitStatus> {
    const state = await this.getRepositoryState(repository, branch);
    return { ...state, clean: stagedFiles.length === 0, stagedFiles: [...stagedFiles] };
  }

  async getDiff(repository: RepositoryRef, branch: string, baseSha?: string): Promise<GitDiff> {
    const state = await this.getRepositoryState(repository, branch);
    const base = baseSha ?? state.headSha;
    const comparison = await this.request<{ files?: Array<{ filename: string; status: string; additions: number; deletions: number }> }>(
      repository, "GET", `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(state.headSha)}`,
    );
    const files = (comparison.files ?? []).map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions }));
    return { repository, branch, baseSha: base, headSha: state.headSha, files, summary: `${files.length} files changed between the selected commits.` };
  }

  async createCommit(input: CreateCommitInput): Promise<CommitResult> {
    const state = await this.getRepositoryState(input.repository, input.branch);
    if (state.headSha !== input.expectedHeadSha) throw new GitHubWriteProviderError("conflict", "Remote branch changed. Commit was cancelled.");
    const baseCommit = await this.request<{ tree: { sha: string } }>(input.repository, "GET", `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/git/commits/${input.expectedHeadSha}`);
    const tree = await Promise.all(input.files.map(async (file) => {
      const safePath = assertSafeRepositoryPath(file.path);
      const blob = await this.request<{ sha: string }>(input.repository, "POST", `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/git/blobs`, { content: file.content, encoding: "utf-8" });
      return { path: safePath, mode: "100644", type: "blob", sha: blob.sha };
    }));
    const createdTree = await this.request<{ sha: string }>(input.repository, "POST", `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/git/trees`, { base_tree: baseCommit.tree.sha, tree });
    const commit = await this.request<{ sha: string }>(input.repository, "POST", `/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/git/commits`, { message: input.message, tree: createdTree.sha, parents: [input.expectedHeadSha] });
    return { repository: input.repository, branch: input.branch, commitSha: commit.sha, shortSha: commit.sha.slice(0, 7) };
  }

  async pushBranch(repository: RepositoryRef, branch: string, expectedHeadSha: string, commitSha: string): Promise<PushResult> {
    assertSafePush(branch, repository.branch);
    const comparison = await this.compareBranch(repository, branch, expectedHeadSha);
    if (!comparison.unchanged) throw new GitHubWriteProviderError("conflict", "Remote branch changed. Push was cancelled.");
    await this.request(repository, "PATCH", `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commitSha, force: false });
    return { repository, branch, commitSha, shortSha: commitSha.slice(0, 7) };
  }

  async lookupCommit(repository: RepositoryRef, commitSha: string): Promise<CommitResult> {
    const commit = await this.request<{ sha: string }>(repository, "GET", `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits/${encodeURIComponent(commitSha)}`);
    return { repository, branch: repository.branch, commitSha: commit.sha, shortSha: commit.sha.slice(0, 7) };
  }
}

function validateBranch(branch: string): void {
  if (!branch || branch.includes("..") || /[\u0000-\u001f\u007f ~^:?*\[\\]/.test(branch) || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    throw new GitHubWriteProviderError("invalid_state", "Invalid branch.");
  }
}

export const githubWriteProvider: GitHubWriteProvider = new GitHubApiWriteProvider();