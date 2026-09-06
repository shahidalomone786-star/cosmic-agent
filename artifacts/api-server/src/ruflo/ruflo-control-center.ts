import type { ControlCenterSnapshot } from "@workspace/api-zod";

type GitHubSnapshotInput = {
  status: string;
  lastValidatedAt: Date | null;
};

type ToolSnapshotInput = {
  enabled: boolean;
  availability?: string;
};

type ModelSnapshotInput = {
  enabled: boolean;
};

type AuditSnapshotInput = {
  executionStatus: string;
  toolId: string;
  riskLevel: string;
  approvalStatus: string;
  timestamp: string;
};

export function buildControlCenterSnapshot({
  github,
  tools,
  auditRecords,
  models,
  now = () => new Date(),
}: {
  github: GitHubSnapshotInput;
  tools: ToolSnapshotInput[];
  auditRecords: AuditSnapshotInput[];
  models: ModelSnapshotInput[];
  now?: () => Date;
}): ControlCenterSnapshot {
  const recentActivity = auditRecords
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 8)
    .map((record) => ({
      label: `Tool ${record.executionStatus}`,
      detail: `${record.toolId} · ${record.riskLevel} · ${record.approvalStatus}`,
      timestamp: record.timestamp,
      tone: record.executionStatus === "failed" ? "danger" as const : record.executionStatus === "completed" ? "positive" as const : "neutral" as const,
    }));
  const githubActivity = github.lastValidatedAt
    ? [{ label: "GitHub credential validated", detail: "Server-side validation timestamp recorded.", timestamp: github.lastValidatedAt.toISOString(), tone: github.status === "connected" ? "positive" as const : "warning" as const }]
    : [];
  const activity = [...githubActivity, ...recentActivity].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 8);
  const toolCounts = {
    registered: tools.length,
    enabled: tools.filter((tool) => tool.enabled && tool.availability !== "disabled").length,
    disabled: tools.filter((tool) => !tool.enabled || tool.availability === "disabled").length,
  };
  const enabledModelCount = models.filter((model) => model.enabled).length;

  return {
    generatedAt: now().toISOString(),
    overallStatus: tools.length > 0 ? "operational" : "attention",
    categories: [
      {
        id: "development",
        label: "DEVELOPMENT",
        modules: [
          moduleSnapshot("skills", "Skills", "PARTIAL", "Canonical Ruflo capability registry is available; no self-granting or settings mutation is exposed.", ["workspace:read"], ["Registry is server-owned.", `${toolCounts.enabled} enabled bounded tool(s) visible.`], ["Uses the unified Ruflo registry.", "Disabled and metadata-only definitions remain non-executable."], ["Normal Agent cannot invoke Ruflo-only tools."], toolCounts),
          moduleSnapshot("files", "Files", "PARTIAL", "Workspace-bound read/write APIs exist, but this Control Center does not expose file mutations.", ["workspace:read"], [], ["Workspace operations remain project-scoped.", "Path traversal and symlink boundary checks remain server-owned."], ["Race-hardening gaps remain documented; no new file authority is added."], {}),
          moduleSnapshot("console", "Console", "DISABLED — INTENTIONALLY RESTRICTED", "No safe general sandbox with resource, network, process-tree, and filesystem isolation exists.", [], [], ["No console controls are available."], ["Bounded validation/preview subprocesses are not treated as a safe console."], {}),
          moduleSnapshot("workflows", "Workflows", "PARTIAL", "Existing bounded Ruflo jobs and DAG runtime are available; a full Settings workflow projection is not claimed.", ["workspace:read"], recentActivity.slice(0, 3).map((item) => item.detail), ["Reuses the existing jobs/DAG/session runtime."], ["No start, stop, retry, or mutation control is exposed here."], {}),
        ],
      },
      {
        id: "source-control",
        label: "SOURCE CONTROL",
        modules: [
          moduleSnapshot("git", "Git", "PARTIAL", "Repository read APIs exist; this Control Center exposes no commit, push, reset, rebase, or rewrite operation.", ["repository:read"], githubActivity.map((item) => item.detail), ["Repository access remains read-oriented here."], ["Protected Git write routes remain outside this UI and approval-bound."], {}),
          moduleSnapshot("changes", "Changes", "PARTIAL", "Proposal, validation, execution, and activity records exist without a unified read-only Settings aggregate.", ["workspace:read"], recentActivity.slice(0, 3).map((item) => item.detail), ["Change execution remains approval-gated."], ["No apply, commit, or push action is rendered."], {}),
          moduleSnapshot("history", "History", "PARTIAL", "Server-owned tool activity is available when recorded; repository history is not projected by this endpoint.", ["workspace:read"], recentActivity.slice(0, 5).map((item) => item.detail), ["Activity is limited to the current authenticated user."], ["An empty activity list means no records are available in this server process."], {}),
        ],
      },
      {
        id: "data-integrations",
        label: "DATA & INTEGRATIONS",
        modules: [
          moduleSnapshot("database", "Database", "DISABLED — INTENTIONALLY RESTRICTED", "The internal application database has no safe user-facing database-management contract.", [], [], ["No raw database credentials or query controls are exposed."], ["No database management operation is implemented."], {}),
          moduleSnapshot("storage", "Storage", "DISABLED — INTENTIONALLY RESTRICTED", "No real object/file storage integration suitable for this Control Center is configured.", [], [], ["No storage credentials or object paths are exposed."], ["Storage is not executable from this surface."], {}),
          moduleSnapshot("integrations", "Integrations", github.status === "connected" ? "NATIVE — VERIFIED" : "PARTIAL", github.status === "connected" ? "GitHub credential status is server-validated." : "GitHub integration exists but is not connected for this account.", ["repository:read"], githubActivity.map((item) => item.detail), ["Only sanitized connection status is returned.", `${enabledModelCount} approved AI model(s) are registered.`], ["Credentials never appear in this snapshot."], { enabledModels: enabledModelCount }),
        ],
      },
      {
        id: "security",
        label: "SECURITY",
        modules: [
          moduleSnapshot("secrets", "Secrets", "PARTIAL", "The GitHub credential path is encrypted and server-held; a general secret vault is not implemented.", [], githubActivity.map((item) => item.detail), ["No credential material is returned.", "No add, rotate, or delete action is exposed here."], ["Diagnostics are sanitized by construction."], {}),
          moduleSnapshot("permissions", "Permissions", "PARTIAL", "Authentication, ownership checks, approval gates, and tool permissions remain server-owned; no parallel permission editor exists.", ["workspace:read"], recentActivity.slice(0, 3).map((item) => item.detail), ["Permissions are derived from the canonical registry and request owner."], ["This panel cannot grant authority."], { registeredTools: toolCounts.registered }),
          moduleSnapshot("audit", "Audit", "PARTIAL", "Ruflo tool audit records are available for this user when recorded; the audit store is bounded in memory.", ["workspace:read"], recentActivity.slice(0, 8).map((item) => item.detail), ["Uses the existing Ruflo audit log.", `${auditRecords.length} current-user record(s) available.`], ["No fabricated score or audit result is shown."], { records: auditRecords.length }),
          moduleSnapshot("security-center", "Security Center", "DISABLED — INTENTIONALLY RESTRICTED", "No live scan/security-data API exists that would justify a score or security claim in this panel.", [], [], ["Static audit documents remain documentation, not live telemetry."], ["No score, pass, or scan result is fabricated."], {}),
        ],
      },
      {
        id: "account",
        label: "ACCOUNT",
        modules: [
          moduleSnapshot("users-auth", "Users & Auth", "PARTIAL", "Existing authenticated account and session handling is active; user administration is not implemented.", [], [], ["Current account is authenticated server-side."], ["No user-management or parallel session controls are exposed."], {}),
        ],
      },
    ],
    activity,
  };
}

function moduleSnapshot(
  id: string,
  label: string,
  classification: string,
  reason: string,
  permissions: string[],
  activity: string[],
  configuration: string[],
  diagnostics: string[],
  counts: Record<string, number>,
) {
  const status = classification.startsWith("DISABLED") ? "restricted" : classification.startsWith("NATIVE") ? "verified" : "partial";
  return { id, label, status, classification, reason, permissions, activity, configuration, diagnostics, counts };
}