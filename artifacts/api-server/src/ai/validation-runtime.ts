import type { ToolCallTrace } from "./manager-brain";

export const VALIDATION_STATES = ["pass", "fail", "not-verified"] as const;
export type ValidationStatus = (typeof VALIDATION_STATES)[number];

export interface ValidationCheck {
  name: string;
  status: ValidationStatus;
  sourceToolCallId?: string;
  details: string;
}

export interface ValidationResult {
  taskId: string;
  status: ValidationStatus;
  checks: ValidationCheck[];
  toolCallIds: string[];
  summary: string;
}

export function validationStatusForTrace(trace: ToolCallTrace | undefined): ValidationStatus {
  if (!trace || !trace.completedAt) return "not-verified";
  if (trace.status === "completed") return "pass";
  if (trace.status === "failed") return "fail";
  return "not-verified";
}

export function verifyValidationResult(
  claimed: ValidationResult,
  traces: readonly ToolCallTrace[],
): ValidationResult {
  const checks = claimed.checks.map((check) => {
    if (!check.sourceToolCallId) {
      return { ...check, status: "not-verified" as const, details: "This check has no server tool-call evidence." };
    }
    const trace = traces.find((candidate) =>
      candidate.toolCallId === check.sourceToolCallId &&
      candidate.taskId === claimed.taskId &&
      candidate.role === "validator" &&
      (candidate.tool === "run_typecheck" || candidate.tool === "run_build") &&
      Boolean(candidate.completedAt),
    );
    const actual = validationStatusForTrace(trace);
    if (actual !== check.status) {
      return { ...check, status: "not-verified" as const, details: "The claimed status does not match the server execution trace." };
    }
    return { ...check, status: actual };
  });
  const toolCallIds = checks.filter((check) => check.status !== "not-verified" && check.sourceToolCallId).map((check) => check.sourceToolCallId as string);
  const status: ValidationStatus =
    checks.some((check) => check.status === "not-verified") ? "not-verified" :
    checks.some((check) => check.status === "fail") ? "fail" : "pass";
  return {
    ...claimed,
    status,
    checks,
    toolCallIds,
    summary: status === "pass"
      ? "All validator checks passed with server execution evidence."
      : status === "fail"
        ? "One or more validator checks failed with server execution evidence."
        : "Validation could not be verified from complete server execution evidence.",
  };
}