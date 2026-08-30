import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveProposal,
  executeProposal,
  filterTextProposalPaths,
  registerProposal,
  reviewRufloProposal,
} from "../test-dist/ruflo-proposal-apply.cjs";

const makeProposal = (proposalId, originalCode = "export const value = 1;\n") => ({
  proposalId,
  status: "proposal",
  summary: "Update value",
  explanation: "Focused test proposal",
  risk: "LOW",
  affectedFiles: ["src/example.ts"],
  addedLines: 1,
  removedLines: 1,
  plan: ["Inspect the file", "Apply the approved edit"],
  validationPlan: ["Run focused validation"],
  files: [{
    path: "src/example.ts",
    operation: "edit",
    language: "typescript",
    originalCode,
    proposedCode: "export const value = 2;\n",
    diff: "-export const value = 1;\n+export const value = 2;\n",
    explanation: "Update the value",
    addedLines: 1,
    removedLines: 1,
  }],
});

async function setupWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ruflo-2a-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "example.ts"), "export const value = 1;\n", { encoding: "utf8" });
  return root;
}

test("a proposal cannot apply without approval", async () => {
  const root = await setupWorkspace();
  try {
    const proposal = makeProposal("ruflo-no-approval");
    registerProposal(proposal, undefined, undefined, root, "user-a", "default");
    await assert.rejects(() => executeProposal(proposal.proposalId), /approval/i);
    assert.equal(await readFile(path.join(root, "src/example.ts"), "utf8"), proposal.files[0].originalCode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected or unrelated approval does not apply the proposal", async () => {
  const root = await setupWorkspace();
  try {
    const proposal = makeProposal("ruflo-rejected");
    registerProposal(proposal, undefined, undefined, root, "user-a", "default");
    await assert.rejects(() => executeProposal(proposal.proposalId, "rejected-by-user"), /approval/i);
    assert.equal(await readFile(path.join(root, "src/example.ts"), "utf8"), proposal.files[0].originalCode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved valid proposal applies successfully", async () => {
  const root = await setupWorkspace();
  try {
    const proposal = makeProposal("ruflo-approved");
    registerProposal(proposal, undefined, undefined, root, "user-a", "default");
    const approval = approveProposal(proposal, undefined, "user-a");
    const result = await executeProposal(proposal.proposalId, approval.approvalId);
    assert.equal(result.status, "applied");
    assert.equal(await readFile(path.join(root, "src/example.ts"), "utf8"), proposal.files[0].proposedCode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary files are excluded from Ruflo text proposal targets", () => {
  assert.deepEqual(
    filterTextProposalPaths(["src/App.tsx", "assets/logo.png", "manual.pdf", "font.woff2", "src/App.tsx"]),
    ["src/App.tsx"],
  );
  const binaryProposal = makeProposal("ruflo-binary");
  binaryProposal.files[0].path = "assets/logo.png";
  assert.throws(() => reviewRufloProposal(binaryProposal, ["assets/logo.png"]), /binary|text proposal/i);
});

test("Ruflo proposal paths remain protected", () => {
  const unsafeProposal = makeProposal("ruflo-unsafe");
  unsafeProposal.files[0].path = "../outside.ts";
  assert.throws(() => reviewRufloProposal(unsafeProposal, ["../outside.ts"]), /unsafe|path/i);
  assert.throws(() => registerProposal(unsafeProposal), /unsafe|path/i);
});