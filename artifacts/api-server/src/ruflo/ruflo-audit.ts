import { randomUUID } from "node:crypto";
import type { RufloRiskLevel, RufloToolSource } from "./ruflo-tool-registry";

export type RufloToolAuditRecord = {
  id: string;
  sessionId: string;
  taskId?: string;
  userId: string;
  toolId: string;
  source: RufloToolSource;
  mcpServer?: string;
  timestamp: string;
  riskLevel: RufloRiskLevel;
  approvalStatus: "not_required" | "required" | "approved" | "rejected";
  executionStatus: "authorized" | "started" | "completed" | "failed";
  durationMs?: number;
  errorCategory?: string;
};

const MAX_RECORDS = 2_000;

export class RufloToolAuditLog {
  private readonly records: RufloToolAuditRecord[] = [];

  record(record: Omit<RufloToolAuditRecord, "id" | "timestamp"> & { timestamp?: string }): RufloToolAuditRecord {
    const safe: RufloToolAuditRecord = {
      ...record,
      id: randomUUID(),
      timestamp: record.timestamp ?? new Date().toISOString(),
      sessionId: record.sessionId.slice(0, 120),
      taskId: record.taskId?.slice(0, 120),
      userId: record.userId.slice(0, 200),
      toolId: record.toolId.slice(0, 160),
      mcpServer: record.mcpServer?.slice(0, 120),
      errorCategory: record.errorCategory?.slice(0, 80),
    };
    this.records.push(safe);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    return { ...safe };
  }

  list(filter: { sessionId?: string; userId?: string } = {}): RufloToolAuditRecord[] {
    return this.records
      .filter((record) => (!filter.sessionId || record.sessionId === filter.sessionId) && (!filter.userId || record.userId === filter.userId))
      .map((record) => ({ ...record }));
  }
}

export const rufloToolAuditLog = new RufloToolAuditLog();