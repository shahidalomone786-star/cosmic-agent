import test from "node:test";
import assert from "node:assert/strict";
import { safeWorkspaceRelative } from "../test-dist/local-workspace.mjs";

test("binary assets cannot become text-edit targets", () => {
  for (const path of ["logo.png", "manual.pdf", "archive.zip", "font.woff2", "video.mp4"]) {
    assert.throws(() => safeWorkspaceRelative(path), /Unsafe workspace path rejected/);
  }
});