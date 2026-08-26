export type ContextSource = { path: string; startLine?: number; endLine?: number };

export const MAX_CONTEXT_CHARS = 64_000;
export const RETRY_CONTEXT_CHARS = 32_000;
export const MAX_FILE_CHARS = 12_000;
let lastContextStatus = { filesIncluded: 0, approximateChars: 0, chunked: false, lastWarnings: [] as string[] };

export function chunkContext(path: string, content: string, budget: number): { text: string; startLine: number; endLine: number; chunked: boolean } {
  const take = Math.min(MAX_FILE_CHARS, Math.max(0, budget));
  const text = content.slice(0, take);
  const lines = text.split("\n");
  return {
    text: `### ${path} (lines 1-${lines.length})\n${text}`,
    startLine: 1,
    endLine: lines.length,
    chunked: content.length > text.length,
  };
}

export function recordContextStatus(status: typeof lastContextStatus): void {
  lastContextStatus = status;
}

export function getContextResourceStatus(): typeof lastContextStatus {
  return { ...lastContextStatus, lastWarnings: [...lastContextStatus.lastWarnings] };
}