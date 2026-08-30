export function isCodingRequest(task: string): boolean {
  const normalized = task.trim();
  if (!normalized) return false;
  return /\b(create|add|build|edit|fix|change|update|remove|delete|rename|refactor|implement|modify|replace|improve|debug)\b/i.test(normalized)
    || /\b(bug|feature|component|screen|endpoint|route|api|backend|frontend|ui|file|configuration|config|patch)\b/i.test(normalized);
}