import type { ToolRisk } from '@/tools/tool-definition';

export type ApprovalReason =
  | 'delete_files'
  | 'bulk_edit'
  | 'install_package'
  | 'destructive_command'
  | 'commit'
  | 'push'
  | 'secrets_or_configuration';

export interface ApprovalRequest {
  id: string;
  reason: ApprovalReason;
  risk: ToolRisk;
  summary: string;
  details?: string;
  createdAt: string;
}

export interface ApprovalDecision {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}

export const approvalRequiredFor: ReadonlySet<ApprovalReason> = new Set([
  'delete_files',
  'bulk_edit',
  'install_package',
  'destructive_command',
  'commit',
  'push',
  'secrets_or_configuration',
]);