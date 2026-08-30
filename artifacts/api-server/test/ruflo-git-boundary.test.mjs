import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveProposal,
  commitProposal,
  executeProposal,
  getCommitReview,
  getPushReview,
  markProposalValidated,
  pushProposal,
  registerProposal,
  stageProposal,
} from "../test-dist/ruflo-proposal-apply.cjs";

const repository = { id: "1", owner: "owner", name: "repo", branch: "main", defaultBranch: "main", webUrl: "https://github.com/owner/repo" };
const proposal = (proposalId) => ({
  proposalId,
  status: "proposal",
  summary: "Update value",
  explanation: "Focused Ruflo Git boundary test",
  risk: "LOW",
  affectedFiles: ["src/example.ts"],
  addedLines: 1,
  removedLines: 1,
  plan: ["Inspect", "Apply", "Validate"],
  validationPlan: ["Run checks"],
  files: [{
    path: "src/example.ts",
    operation: "edit",
    language: "typescript",
    originalCode: "export const value = 1;\n",
    proposedCode: "export const value = 2;\n",
    diff: "-export const value = 1;\n+export const value = 2;\n",
    explanation: "Update value",
    addedLines: 1,
    removedLines: 1,
  }],
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ruflo-git-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "example.ts"), "export const value = 1;\n");
  return root;
}

function mockProvider(calls) {
  return {
    async getRepositoryState() { return { repository, branch: "main", headSha: "head-1" }; },
    async compareBranch(_repository, _branch, expectedHeadSha) {
      calls.comparisons.push(expectedHeadSha);
      return { unchanged: true, expectedHeadSha, actualHeadSha: expectedHeadSha };
    },
    async createCommit(input) {
      calls.createCommit.push(input);
      return { repository, branch: "main", commitSha: "commit-1", shortSha: "commit-1" };
    },
    async pushBranch(_repository, _branch, expectedHeadSha, commitSha) {
      calls.pushBranch.push({ expectedHeadSha, commitSha });
      return { repository, branch: "main", commitSha, shortSha: commitSha };
    },
  };
}

test("Ruflo requires validated code, distinct commit approval, then distinct push approval", async () => {
  const root = await setup();
  try {
    const current = proposal("ruflo-git-boundary");
    registerProposal(current, repository, "gemini", root, "user-a", "default");
    const applyApproval = approveProposal(current, repository, "user-a", undefined, "apply");
    await executeProposal(current.proposalId, applyApproval.approvalId);
    await assert.rejects(() => getCommitReview(current.proposalId), /validated/i);
    markProposalValidated(current.proposalId, true);
    assert.equal((await getCommitReview(current.proposalId)).validation, "passed");

    const calls = { comparisons: [], createCommit: [], pushBranch: [] };
    const provider = mockProvider(calls);
    await stageProposal(current.proposalId, applyApproval.approvalId);
    await assert.rejects(() => commitProposal(current.proposalId, "", "Update value", provider), /commit approval/i);

    const commitApproval = approveProposal(current, repository, "user-a", undefined, "commit");
    const commit = await commitProposal(current.proposalId, commitApproval.approvalId, "Update value", provider);
    assert.equal(commit.commitSha, "commit-1");
    assert.equal(calls.createCommit.length, 1);
    assert.equal(getPushReview(current.proposalId).commitSha, "commit-1");

    await assert.rejects(() => pushProposal(current.proposalId, "", provider), /push approval/i);
    const pushApproval = approveProposal(current, repository, "user-a", undefined, "push");
    const pushed = await pushProposal(current.proposalId, pushApproval.approvalId, provider);
    assert.equal(pushed.status, "pushed");
    assert.deepEqual(calls.pushBranch[0], { expectedHeadSha: "head-1", commitSha: "commit-1" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});