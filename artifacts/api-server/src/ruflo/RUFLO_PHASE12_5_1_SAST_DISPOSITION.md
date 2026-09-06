# Phase 12.5.1 SAST disposition

Date: 2026-09-06

The current SAST scan reports 12 instances of the same high-severity
`javascript.express.file.fs-express.fs-express` path-construction rule. The
scanner does not model the asynchronous boundary checks used by this project,
so it reports the path sink even when the path has already passed the
workspace/preview boundary. None of these findings is suppressed. Each is
listed below with its current evidenced disposition.

## Findings

| # | Location | Disposition | Evidence |
| --- | --- | --- | --- |
| 1 | `preview-runtime.ts:39` (`fs.readFile(canonicalCandidate)`) | already covered by an existing guard | `readPreviewFile` canonicalizes the root with `fs.realpath`, resolves the requested path, checks lexical containment, canonicalizes the candidate with `fs.realpath`, checks canonical containment again, and only then reads it. This is the symlink/traversal gap fixed during stabilization. |
| 2 | `local-workspace.ts:60` (`fs.readdir(directory)`) | already covered by an existing guard | The input is first normalized by `safeWorkspaceRelative`; `directory` is then returned only by `assertWorkspacePath(base, safe, true)`, which checks the canonical root and final target. |
| 3 | `local-workspace.ts:79` (`fs.readFile(absolute)`) | already covered by an existing guard | `relative` must pass `safeWorkspaceRelative`, and `absolute` must pass `assertWorkspacePath(base, safe, true)` before the file type, size, and read checks. |
| 4 | `local-workspace.ts:91` (`fs.mkdir(path.dirname(absolute))`) | already covered by an existing guard | The safe path is checked before directory creation (`assertWorkspacePath` on the target and its parent); the parent is checked again after creation. |
| 5 | `local-workspace.ts:94` (`fs.writeFile(temporary, ...)`) | already covered by an existing guard | `temporary` is derived from the already-contained `absolute` path, and the containing directory is checked before and after the temporary write. |
| 6 | `local-workspace.ts:96` (`fs.rename(temporary, absolute)`, source) | already covered by an existing guard | The temporary file and destination are both under the validated workspace path; the parent boundary is rechecked before the rename. |
| 7 | `local-workspace.ts:96` (`fs.rename(temporary, absolute)`, destination) | already covered by an existing guard | The destination is derived from `safeWorkspaceRelative`; the final target is canonicalized after the operation and the parent is checked before the operation. |
| 8 | `local-workspace.ts:109` (`fs.rm(absolute, ...)`) | already covered by an existing guard | Removal requires a safe relative path, writable-path policy, a non-following ancestor check, and a final-target check when the path exists. |
| 9 | `local-workspace.ts:119` (`fs.mkdir(absolute, ...)`) | already covered by an existing guard | Creation requires the safe relative path, target existence check, canonical parent check, and post-creation canonical target check. |
| 10 | `local-workspace.ts:133` (`fs.mkdir(path.dirname(absoluteTarget), ...)`) | already covered by an existing guard | Both source/target paths are normalized and checked before the parent directory is created; the target parent is checked again immediately afterward. |
| 11 | `local-workspace.ts:137` (`fs.rename(absoluteSource, absoluteTarget)`, source) | already covered by an existing guard | Source and target each pass `assertWorkspacePath` immediately before the rename, including existing-ancestor and symlink checks. |
| 12 | `local-workspace.ts:137` (`fs.rename(absoluteSource, absoluteTarget)`, destination) | already covered by an existing guard | The destination is derived only from `safeWorkspaceRelative` and is checked immediately before the rename; no request path reaches the filesystem sink directly. |

## Conclusion

The scan findings remain visible because the static rule flags the sink
expression itself. The current runtime behavior is bounded by canonical root
checks, path normalization, blocked-file policy, and operation-specific
symlink handling. The preview read path has both lexical and canonical
containment checks, including the final symlink target, so the prior real
preview escape is fixed rather than ignored.