import type { ToolCallTrace } from "./manager-brain";
import type { WorkerReport } from "./worker-runtime";

export type EvidenceCheckInput = {
  claim: string;
  evidence: string;
  sourceToolCallId: string;
  critical: boolean;
  result?: "match" | "mismatch" | "insufficient";
};

export function verifyEvidenceForTrace(
  trace: ToolCallTrace | undefined,
  taskId: string,
  finding: EvidenceCheckInput,
  expectedRole?: ToolCallTrace["role"],
): EvidenceCheckInput {
  if (!trace || trace.taskId !== taskId || (expectedRole && trace.role !== expectedRole) || !trace.completedAt || trace.status !== "completed" || !trace.evidence) {
    return { ...finding, result: "insufficient" };
  }
  const actual = normalize(trace.evidence.content);
  const claimed = normalize(finding.evidence);
  if (!claimed || !actual.includes(claimed)) return { ...finding, result: "mismatch" };
  return { ...finding, result: "match" };
}

export function findWorkerConflicts(reports: Pick<WorkerReport, "role" | "dependencies">[]): string[] {
  const claims = new Map<string, Set<string>>();
  for (const report of reports) {
    for (const dependency of report.dependencies) {
      const key = normalize(dependency);
      const roles = claims.get(key) ?? new Set<string>();
      roles.add(report.role);
      claims.set(key, roles);
    }
  }
  return [...claims.entries()].filter(([, roles]) => roles.size > 1).map(([claim]) => claim);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 4_000);
}