const protectedPath = /(^|\/)(\.env(?:\..*)?|\.git|node_modules|credentials?|secrets?)(\/|$)|(^|\/).*?\.(pem|key|p12|pfx|crt)$/i;

export function assertSafeRepositoryPath(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  const relative = normalized.replace(/^\/+/, "");
  if (!relative || normalized.startsWith("/") || relative.startsWith("../") || relative.includes("/../") ||
      protectedPath.test(relative) || relative.includes("\0") || relative.length > 500) {
    throw new Error("Unsafe repository path rejected.");
  }
  return relative;
}

export function assertSafePush(branch: string, configuredBranch: string, force?: unknown): void {
  if (force === true || branch !== configuredBranch) throw new Error("Force push and unrelated branch updates are not permitted.");
}

export function redactGitSensitive(value: string): string {
  return value
    .replace(/(Bearer\s+|gh[pousr]_)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/-----BEGIN[\s\S]*?-----END [^-]+-----/gi, "[redacted-private-key]");
}