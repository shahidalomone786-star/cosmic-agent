export type RepositoryHost = 'github' | 'gitlab' | 'other';

export interface RepositoryInfo {
  id: string;
  host: RepositoryHost;
  owner: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
  connectedAt?: string;
}

export interface RepositoryConnectionRequest {
  host: RepositoryHost;
  repositoryUrl?: string;
}

export interface RepositoryResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: 'not_implemented' | 'not_connected' | 'permission_denied' | 'unknown';
    message: string;
  };
}

export interface RepositoryProvider {
  readonly host: RepositoryHost;
  connect(
    request: RepositoryConnectionRequest,
  ): Promise<RepositoryResult<RepositoryInfo>>;
  getRepository(): Promise<RepositoryResult<RepositoryInfo>>;
  listFiles(path?: string): Promise<RepositoryResult<string[]>>;
  readFile(path: string): Promise<RepositoryResult<string>>;
  writeFile(path: string, content: string): Promise<RepositoryResult<void>>;
  getDiff(): Promise<RepositoryResult<string>>;
  commit(message: string): Promise<RepositoryResult<void>>;
  push(): Promise<RepositoryResult<void>>;
}