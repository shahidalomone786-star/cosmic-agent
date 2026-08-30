export type ContextSourcePath = { path: string };

export function resolveProposalPaths(
  selectedFiles: readonly string[],
  sources: readonly ContextSourcePath[],
): string[] {
  const candidates = selectedFiles.length
    ? selectedFiles
    : sources.map((source) => source.path);

  return [
    ...new Set(
      candidates
        .map((path) => path.replace(/^@/, "").trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}