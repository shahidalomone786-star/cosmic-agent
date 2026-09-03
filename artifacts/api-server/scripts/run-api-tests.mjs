import { execFileSync, execSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("test-dist", { recursive: true, force: true });

const builds = [
  ["src/ai/agent-continuation.ts", "agent-continuation.mjs", "esm"],
  ["src/ai/coding-intent.ts", "coding-intent.mjs", "esm"],
  ["src/workspace/local-workspace.ts", "local-workspace.mjs", "esm"],
  ["src/ai/evidence-verifier.ts", "evidence-verifier.mjs", "esm"],
  ["src/ai/validation-runtime.ts", "validation-runtime.mjs", "esm"],
  ["src/ai/approval-gate.ts", "approval-gate.mjs", "esm"],
  ["src/repository/github-response.ts", "github-response.mjs", "esm"],
  ["src/lib/github-crypto.ts", "github-crypto.mjs", "esm"],
  ["src/repository/git-security.ts", "git-security.mjs", "esm"],
  ["src/repository/github-write-policy.ts", "github-write-policy.mjs", "esm"],
  ["src/ai/gemini-provider.ts", "gemini-provider.mjs", "esm"],
  ["src/ai/gemini-key-manager.ts", "gemini-key-manager.mjs", "esm"],
  ["src/repository/context-manager.ts", "context-manager.mjs", "esm"],
  ["src/ai/context-budget.ts", "context-budget.mjs", "esm"],
  ["src/ruflo/memory-policy.ts", "ruflo-memory-policy.mjs", "esm"],
  ["src/ruflo/memory-retrieval.ts", "ruflo-memory-retrieval.mjs", "esm"],
  ["src/ruflo/memory-learning.ts", "ruflo-memory-learning.mjs", "esm"],
  ["src/ruflo/embedding-provider.ts", "ruflo-embedding-provider.mjs", "esm"],
  ["src/ruflo/ruflo-runtime.ts", "ruflo-runtime.cjs", "cjs"],
  ["src/ruflo/ruflo-workflow.ts", "ruflo-workflow.cjs", "cjs"],
  ["src/ruflo/ruflo-jobs.ts", "ruflo-jobs.mjs", "esm"],
  ["src/ruflo/ruflo-dag.ts", "ruflo-dag.mjs", "esm"],
  ["src/ruflo/ruflo-cost-tracker.ts", "ruflo-cost-tracker.mjs", "esm"],
  ["src/ruflo/ruflo-provider-router.ts", "ruflo-provider-router.mjs", "esm"],
  ["src/ruflo/ruflo-live-events.ts", "ruflo-live-events.mjs", "esm"],
  ["src/ruflo/ruflo-specialized-agents.ts", "ruflo-specialized-agents.mjs", "esm"],
  ["test/ruflo-swarm-entry.mjs", "ruflo-swarm.mjs", "esm"],
  ["test/ruflo-proposal-apply-entry.mjs", "ruflo-proposal-apply.cjs", "cjs"],
  ["test/ruflo-memory.test.mjs", "ruflo-memory.cjs", "cjs"],
];

for (const [entry, output, format] of builds) {
  const args = ["exec", "esbuild", entry, "--bundle", "--platform=node", `--format=${format}`, `--outfile=test-dist/${output}`];
  if ((format === "cjs" && (entry.includes("ruflo-runtime") || entry.includes("ruflo-workflow") || entry.includes("proposal-apply"))) || entry.includes("gemini-provider")) {
    args.push("--external:pino", "--external:pino-pretty");
  }
  execFileSync("pnpm", args, { stdio: "inherit" });
}

execSync("node --test test/*.test.mjs", { stdio: "inherit", shell: true });