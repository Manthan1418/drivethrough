// Audit trail writer (design.md §7 — every sensitive action lands in audit_logs).
// Best-effort BY DESIGN: an audit failure must never fail the user's action — it warns
// and moves on (the action itself is already ACID; the trail is forensics, not state).

import { getDb } from './db/client';
import { auditLogs } from './db/schema';

export type AuditEntityType = 'folder' | 'file' | 'account' | 'upload' | 'key' | 'share';

export async function logAudit(
  userId: string,
  action: string,
  entityType: AuditEntityType,
  entityId: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await getDb()
      .insert(auditLogs)
      .values({ userId, action, entityType, entityId, metadata: metadata ?? null });
  } catch (err) {
    console.warn('[audit] write failed:', err instanceof Error ? err.message : err);
  }
}
