import type { RufloSession } from "./ruflo-runtime";
import type { ChangeProposal } from "../ai/change-proposal";
import type { RufloMemoryKind } from "./types";

export type RufloLearningCandidate = {
  kind: Extract<RufloMemoryKind, "project_fact" | "coding_pattern" | "successful_solution" | "failed_solution" | "architecture_decision" | "warning" | "tool_pattern">;
  fact: string;
  confidence: number;
  importance: number;
  outcome: "success" | "failure" | "neutral";
};

export type RufloLearningInput = {
  session?: RufloSession;
  proposal?: Pick<ChangeProposal, "summary" | "explanation" | "plan">;
  workflowStatus: "completed" | "waiting_approval" | "failed";
  validation?: { status: "pass" | "fail" | "not-verified"; summary: string };
};

/**
 * Extracts small, reusable outcome signals. It intentionally does not persist
 * prompts, full source files, tool payloads, or validation logs.
 */
export function extractRufloLearning(input: RufloLearningInput): RufloLearningCandidate[] {
  const candidates: RufloLearningCandidate[] = [];
  const session = input.session;

  if (session && session.status === "failed" || session?.status === "limit_reached") {
    candidates.push({
      kind: "warning",
      fact: `Ruflo inspection stopped before completion: ${session.error?.code ?? "bounded_failure"}.`,
      confidence: 0.45,
      importance: 65,
      outcome: "failure",
    });
  }

  if (input.workflowStatus === "waiting_approval") return candidates;

  if (input.workflowStatus === "completed" && input.validation?.status === "pass" && input.proposal?.summary) {
    candidates.push({
      kind: "successful_solution",
      fact: `Validated successful approach: ${input.proposal.summary}`,
      confidence: 0.7,
      importance: 70,
      outcome: "success",
    });
    if (input.proposal.plan?.length) {
      candidates.push({
        kind: "coding_pattern",
        fact: `Validated coding pattern: ${input.proposal.plan.slice(0, 2).join(" → ")}`,
        confidence: 0.65,
        importance: 60,
        outcome: "success",
      });
    }
  }

  if (input.workflowStatus === "failed") {
    const reason = input.validation?.summary || "The Ruflo workflow failed before validation completed.";
    candidates.push({
      kind: "failed_solution",
      fact: `Approach to avoid until reviewed: ${reason}`,
      confidence: 0.45,
      importance: 65,
      outcome: "failure",
    });
    if (input.validation && input.validation.status !== "pass") {
      candidates.push({
        kind: "warning",
        fact: `Validation warning: ${input.validation.summary}`,
        confidence: 0.5,
        importance: 70,
        outcome: "failure",
      });
    }
  }

  if (session && session.observations.filter((observation) => observation.status === "completed").length > 0) {
    candidates.push({
      kind: "tool_pattern",
      fact: "Bounded repository inspection completed before proposal preparation.",
      confidence: 0.6,
      importance: 45,
      outcome: input.workflowStatus === "completed" ? "success" : input.workflowStatus === "failed" ? "failure" : "neutral",
    });
  }

  return deduplicateCandidates(candidates);
}

function deduplicateCandidates(candidates: readonly RufloLearningCandidate[]): RufloLearningCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.fact.toLocaleLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}