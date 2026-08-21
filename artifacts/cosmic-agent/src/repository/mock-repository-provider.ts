import type {
  RepositoryConnectionRequest,
  RepositoryInfo,
  RepositoryProvider,
  RepositoryResult,
} from './repository-provider';

const NOT_IMPLEMENTED = {
  ok: false as const,
  error: {
    code: 'not_implemented' as const,
    message:
      'Repository operations are not available in Phase 1. No repository action was performed.',
  },
};

export class MockRepositoryProvider implements RepositoryProvider {
  readonly host = 'github' as const;

  async connect(
    _request: RepositoryConnectionRequest,
  ): Promise<RepositoryResult<RepositoryInfo>> {
    return NOT_IMPLEMENTED;
  }

  async getRepository(): Promise<RepositoryResult<RepositoryInfo>> {
    return NOT_IMPLEMENTED;
  }

  async listFiles(_path?: string): Promise<RepositoryResult<string[]>> {
    return NOT_IMPLEMENTED;
  }

  async readFile(_path: string): Promise<RepositoryResult<string>> {
    return NOT_IMPLEMENTED;
  }

  async writeFile(
    _path: string,
    _content: string,
  ): Promise<RepositoryResult<void>> {
    return NOT_IMPLEMENTED;
  }

  async getDiff(): Promise<RepositoryResult<string>> {
    return NOT_IMPLEMENTED;
  }

  async commit(_message: string): Promise<RepositoryResult<void>> {
    return NOT_IMPLEMENTED;
  }

  async push(): Promise<RepositoryResult<void>> {
    return NOT_IMPLEMENTED;
  }
}