import type { AiProvider } from "./ai-provider";
import { executeAgentTool, getAgentSessionForProposal } from "./agent-runtime";
import { verifyValidationResult, type ValidationCheck, type ValidationResult } from "./validation-runtime";

export async function validateAppliedProposal(provider: AiProvider, proposalId: string): Promise<ValidationResult> {
  const session = getAgentSessionForProposal(proposalId);
  if (!session || session.appliedProposalId !== proposalId) {
    return { taskId: session?.id ?? "", status: "not-verified", checks: [], toolCallIds: [], summary: "The approved applied proposal is not available to the validator." };
  }

  const checks: ValidationCheck[] = [];
  for (const [tool, label] of [["run_typecheck", "typecheck"], ["run_build", "build"]] as const) {
    try {
      await executeAgentTool(provider, session, tool, { proposalId, scope: "workspace" }, "validator");
    } catch (error) {
      // The trace is authoritative. A command failure is a failed check; an
      // infrastructure denial/timeout is not-verified and never a pass.
      const trace = session.toolTraces.at(-1);
      const status = trace?.status === "failed" ? "fail" : "not-verified";
      checks.push({ name: label, status, sourceToolCallId: trace?.toolCallId, details: error instanceof Error ? error.message : `${label} did not complete.` });
      continue;
    }
    const trace = session.toolTraces.at(-1);
    checks.push({ name: label, status: "pass", sourceToolCallId: trace?.toolCallId, details: `${label} completed successfully.` });
  }

  const claimed: ValidationResult = {
    taskId: session.id,
    status: checks.some((check) => check.status === "not-verified") ? "not-verified" : checks.some((check) => check.status === "fail") ? "fail" : "pass",
    checks,
    toolCallIds: checks.flatMap((check) => check.sourceToolCallId ? [check.sourceToolCallId] : []),
    summary: "Validator checks completed.",
  };
  const verified = verifyValidationResult(claimed, session.toolTraces);
  session.validation = verified;
  try {
    await executeAgentTool(provider, session, "inspect_validation_result", { proposalId }, "validator");
  } catch {
    return {
      ...verified,
      status: "not-verified",
      summary: "Validator execution could not complete its final result inspection.",
    };
  }
  session.memory.validationResults = [...session.memory.validationResults, `${verified.status}: ${verified.summary}`].slice(-10);
  return verified;
}