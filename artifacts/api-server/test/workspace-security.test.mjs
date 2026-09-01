import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertWorkspacePath,
  createWorkspaceDirectory,
  ensureWorkspace,
  readWorkspaceFile,
  removeWorkspacePath,
  renameWorkspacePath,
  safeWorkspaceRelative,
  writeWorkspaceFile,
} from "../test-dist/local-workspace.mjs";

test("rejects lexical, encoded, absolute, and Windows traversal", () => {
  for (const candidate of ["../secret", "nested/../../secret", "..%2Fsecret", "nested/%2e%2e/secret", "/tmp/secret", "\\\\server\\secret", "C:\\secret"]) {
    assert.throws(() => safeWorkspaceRelative(candidate), /Unsafe workspace path rejected/);
  }
  assert.equal(safeWorkspaceRelative("src/./feature.ts"), "src/feature.ts");
});

test("rejects external symlinks and permits safe internal symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ruflo-path-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ruflo-outside-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "internal-target"), { recursive: true });
    await symlink(outside, path.join(root, "escape"));
    await symlink(path.join(root, "internal-target"), path.join(root, "internal"));

    await assert.rejects(() => assertWorkspacePath(root, "escape", true), /escaped/i);
    await assert.rejects(() => assertWorkspacePath(root, "escape/file.ts", true), /escaped/i);
    await assert.doesNotReject(() => assertWorkspacePath(root, "internal", true));
    await assert.doesNotReject(() => assertWorkspacePath(root, "internal/new.ts", false));

    // The same confinement check is used immediately before destructive
    // rename/delete operations, so an external symlink cannot be targeted.
    await assert.rejects(() => assertWorkspacePath(root, "escape", true), /escaped/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("guards real read/write/create/delete/rename operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ruflo-ops-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ruflo-ops-outside-"));
  const previousRoot = process.env.COSMIC_WORKSPACE_ROOT;
  process.env.COSMIC_WORKSPACE_ROOT = root;
  try {
    const workspace = await ensureWorkspace("user", "project");
    await writeWorkspaceFile("user", "project", "src/safe.ts", "export const safe = true;\n");
    assert.equal((await readWorkspaceFile("user", "project", "src/safe.ts")).content, "export const safe = true;\n");
    await createWorkspaceDirectory("user", "project", "src/nested");
    await renameWorkspacePath("user", "project", "src/safe.ts", "src/nested/safe.ts");
    await removeWorkspacePath("user", "project", "src/nested/safe.ts");

    await symlink(outside, path.join(workspace, "escape"));
    await assert.rejects(() => readWorkspaceFile("user", "project", "escape/secret.ts"), /escaped/i);
    await assert.rejects(() => writeWorkspaceFile("user", "project", "escape/secret.ts", "nope"), /escaped/i);
    await assert.rejects(() => createWorkspaceDirectory("user", "project", "escape/new"), /escaped/i);
    await assert.rejects(() => removeWorkspacePath("user", "project", "escape"), /escaped/i);
    await assert.rejects(() => renameWorkspacePath("user", "project", "escape", "moved"), /escaped/i);
  } finally {
    if (previousRoot === undefined) delete process.env.COSMIC_WORKSPACE_ROOT;
    else process.env.COSMIC_WORKSPACE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
