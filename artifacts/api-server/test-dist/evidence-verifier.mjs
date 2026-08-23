// src/ai/evidence-verifier.ts
function verifyEvidenceForTrace(trace, taskId, finding, expectedRole) {
  if (!trace || trace.taskId !== taskId || expectedRole && trace.role !== expectedRole || !trace.completedAt || trace.status !== "completed" || !trace.evidence) {
    return { ...finding, result: "insufficient" };
  }
  const actual = normalize(trace.evidence.content);
  const claimed = normalize(finding.evidence);
  if (!claimed || !actual.includes(claimed)) return { ...finding, result: "mismatch" };
  return { ...finding, result: "match" };
}
function findWorkerConflicts(reports) {
  const claims = /* @__PURE__ */ new Map();
  for (const report of reports) {
    for (const dependency of report.dependencies) {
      const key = normalize(dependency);
      const roles = claims.get(key) ?? /* @__PURE__ */ new Set();
      roles.add(report.role);
      claims.set(key, roles);
    }
  }
  return [...claims.entries()].filter(([, roles]) => roles.size > 1).map(([claim]) => claim);
}
function normalize(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 4e3);
}
export {
  findWorkerConflicts,
  verifyEvidenceForTrace
};
