import type { RepositoryRef } from "./github-provider";

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

export type BranchComparison = {
  unchanged: boolean;
  expectedHeadSha: string;
  actualHeadSha: string;
};

export class GitHubWriteProviderError extends Error {
  constructor(
    readonly code: "provider_not_configured" | "conflict" | "protected_file" | "invalid_state",
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubWriteProvider {
  getRepositoryState(repository: RepositoryRef, branch: string): Promise<WriteRepositoryState>;
  compareBranch(repository: RepositoryRef, branch: string, expectedHeadSha: string): Promise<BranchComparison>;
  createCommit(input: CreateCommitInput): Promise<CommitResult>;
  pushBranch(repository: RepositoryRef, branch: string, expectedHeadSha: string, commitSha: string): Promise<PushResult>;
  lookupCommit(repository: RepositoryRef, commitSha: string): Promise<CommitResult>;
}

class NotConfiguredGitHubWriteProvider implements GitHubWriteProvider {
  private unavailable(): never {
    throw new GitHubWriteProviderError(
      "provider_not_configured",
      "GITHUB_PROVIDER_NOT_CONFIGURED",
    );
  }

  getRepositoryState(_repository: RepositoryRef, _branch: string): Promise<WriteRepositoryState> {
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

export const githubWriteProvider: GitHubWriteProvider = new NotConfiguredGitHubWriteProvider();