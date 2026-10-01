import { schema, type Executor } from '@smart-school/database';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  schoolId?: string | null;
  requestId?: string | null;
  /** Identifiers and outcomes only — never passwords, tokens or free-text personal data. */
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Appends an audit row using the caller's executor, so the audit entry commits or rolls
 * back together with the change it describes. `audit_logs` rejects UPDATE and DELETE at the
 * database level.
 */
export async function writeAudit(executor: Executor, entry: AuditEntry): Promise<void> {
  await executor.insert(schema.auditLogs).values({
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    actorUserId: entry.actorUserId ?? null,
    schoolId: entry.schoolId ?? null,
    requestId: entry.requestId ?? null,
    metadata: entry.metadata ?? {},
  });
}
