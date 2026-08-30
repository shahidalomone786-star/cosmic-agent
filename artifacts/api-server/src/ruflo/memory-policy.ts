export const MAX_RUFLO_MEMORY_FACT_CHARS = 1_000;
export const MAX_RUFLO_MEMORY_FACTS = 12;
export const MAX_RUFLO_MEMORY_CONTEXT_CHARS = 6_000;
export const MAX_RUFLO_PERSISTED_MEMORY_FACTS = 48;

const secretPattern =
  /((?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|secret|token)\s*[:=]\s*)\S+|(?:ghp_|github_pat_|AIza|sk-|xox[baprs]-)[A-Za-z0-9_./+=-]+/gi;

export function sanitizeMemoryFact(value: string): string {
  return value
    .replace(secretPattern, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RUFLO_MEMORY_FACT_CHARS);
}

export function formatMemoryContext(memory: ReadonlyArray<{ kind: string; fact: string }>): string {
  const heading = "HISTORICAL RUFLO MEMORY (bounded hints only; current repository evidence is authoritative)";
  let remaining = MAX_RUFLO_MEMORY_CONTEXT_CHARS - heading.length - 1;
  const lines: string[] = [];
  for (const item of memory.slice(0, MAX_RUFLO_MEMORY_FACTS)) {
    const line = `- [${item.kind}] ${sanitizeMemoryFact(item.fact)}`;
    if (!line || line.length + 1 > remaining) break;
    lines.push(line);
    remaining -= line.length + 1;
  }
  return lines.length ? `${heading}\n${lines.join("\n")}` : "";
}