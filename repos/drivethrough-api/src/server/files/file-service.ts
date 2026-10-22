// File use-cases — the browser's data layer (flow.md §6, tech.md §4).
// A `files` row is this gateway's TRUTH about a blob; the provider copy is referred to by
// (accountId, providerFileId). Ordering of side effects differs by op, on purpose:
//   trash   → DB first (the user's view flips instantly), provider trash best-effort after
//             (a Drive hiccup leaves the blob untrashed physically — P0.5 reconcile repairs;
//              virtual trash is DB-level, so the UI is never lying about ITS state).
//   purge   → provider first, then the row. The row is the only pointer to the bytes:
//             lose it and the blob is orphaned forever. A provider failure keeps the row.
// Restore trashes back into the live tree; if its folder is itself in trash it lands at
// root (visible beats correct-but-invisible), recorded in the audit metadata.

import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  ErrorCodes,
  type ActivityEvent,
  type ActivityResponse,
  type FileListResponse,
  type FileMeta,
  type StorageSummary,
  type UpdateFileRequest,
} from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { accounts, auditLogs, files, folders, storageUsage } from '../db/schema';
import { googleDriveProvider } from '../providers/google-drive';
import { loadProviderAccount } from '../accounts/account-context';
import { logAudit } from '../audit';
import { ilikeSafe } from './search-like';

type Db = ReturnType<typeof getDb>;

function toWire(row: typeof files.$inferSelect): FileMeta {
  return {
    id: row.id,
    accountId: row.accountId,
    folderId: row.folderId,
    provider: row.provider,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes.toString(),
    status: row.status,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadFile(db: Db, userId: string, id: string, status?: 'active' | 'deleted') {
  const conds: (SQL | undefined)[] = [eq(files.id, id), eq(files.userId, userId)];
  if (status === 'active') conds.push(eq(files.status, 'active'));
  if (status === 'deleted') conds.push(inArray(files.status, ['deleted']));
  const [row] = await db.select().from(files).where(and(...conds)).limit(1);
  if (!row) throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File not found');
  return row;
}

/** Folder targets for create/move are validated here (active + owned) — inline SQL on
 *  purpose: file-service must not import folder-service (batch-service composes both). */
async function assertLiveFolder(db: Db, userId: string, folderId: string): Promise<void> {
  const [row] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId), isNull(folders.deletedAt)))
    .limit(1);
  if (!row) throw new AppError(ErrorCodes.FOLDER_NOT_FOUND, 'Target folder not found');
}

// ---------------------------------------------------------------- list / search

export async function listFiles(
  userId: string,
  opts: { folderId?: string | null; q?: string; trashed?: boolean; recent?: boolean; limit?: number }
): Promise<FileListResponse> {
  const db = getDb();
  const q = opts.q?.trim();
  let rows: (typeof files.$inferSelect)[];

  if (opts.recent) {
    rows = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.status, 'active')))
      .orderBy(desc(files.updatedAt))
      .limit(Math.min(opts.limit ?? 50, 100));
  } else if (q) {
    // global search across the whole (active) tree — the search box is not folder-scoped
    rows = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.status, 'active'), ilikeSafe(files.name, q)))
      .orderBy(files.name)
      .limit(Math.min(opts.limit ?? 100, 200));
  } else if (opts.trashed) {
    rows = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), inArray(files.status, ['deleted'])))
      .orderBy(desc(files.deletedAt))
      .limit(500);
  } else {
    const inFolder = opts.folderId ? eq(files.folderId, opts.folderId) : isNull(files.folderId);
    rows = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.status, 'active'), inFolder))
      .orderBy(files.name)
      .limit(Math.min(opts.limit ?? 200, 500));
  }
  // keyset paging for very large folders is P0.5 (design.md §5.2 keeps v1 honest with a cap)
  return { files: rows.map(toWire), nextCursor: null };
}

export async function getFile(userId: string, id: string): Promise<FileMeta> {
  const row = await loadFile(getDb(), userId, id); // any status — trash view needs deleted rows too
  return toWire(row);
}

// ---------------------------------------------------------------- rename / move

export async function updateFile(userId: string, id: string, input: UpdateFileRequest): Promise<FileMeta> {
  const db = getDb();
  const row = await loadFile(db, userId, id, 'active');
  const sets: Partial<typeof files.$inferInsert> = {};

  if (input.name !== undefined && input.name.trim() !== row.name) {
    sets.name = input.name.trim(); // duplicates allowed — Drive's own semantics (no quota burn on rename)
  }
  if (input.folderId !== undefined && (input.folderId ?? null) !== row.folderId) {
    const target = input.folderId ?? null;
    if (target) await assertLiveFolder(db, userId, target);
    sets.folderId = target;
  }
  if (input.trashed === true) return trashFile(userId, id);
  if (input.trashed === false) return restoreFile(userId, id);

  if (Object.keys(sets).length === 0) return toWire(row);
  const [updated] = await db
    .update(files)
    .set({ ...sets, updatedAt: new Date() })
    .where(and(eq(files.id, id), eq(files.userId, userId)))
    .returning();
  if (!updated) throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File not found');
  if (sets.name) await logAudit(userId, 'file.rename', 'file', id, { name: sets.name });
  if ('folderId' in sets) await logAudit(userId, 'file.move', 'file', id, { folderId: sets.folderId ?? null });
  return toWire(updated);
}

// ---------------------------------------------------------------- trash / restore

export async function trashFile(userId: string, id: string): Promise<FileMeta> {
  const db = getDb();
  const row = await loadFile(db, userId, id, 'active');
  const marker = new Date();
  const [updated] = await db
    .update(files)
    .set({ status: 'deleted', deletedAt: marker, updatedAt: marker })
    .where(and(eq(files.id, id), eq(files.status, 'active')))
    .returning();
  if (!updated) throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File not found');

  // provider trash is best-effort AFTER the DB is consistent (file header explains why)
  let providerTrashed = false;
  try {
    const { ctx } = await loadProviderAccount(userId, row.accountId);
    await googleDriveProvider.delete(ctx, row.providerFileId, true); // soft = Drive trash
    providerTrashed = true;
  } catch (err) {
    console.warn('[file-trash] provider trash failed (reconcile will retry):', err instanceof Error ? err.message : err);
  }
  await logAudit(userId, 'file.trash', 'file', id, { name: row.name, providerTrashed });
  return toWire(updated);
}

export async function restoreFile(userId: string, id: string): Promise<FileMeta> {
  const db = getDb();
  const row = await loadFile(db, userId, id, 'deleted');
  // if the old parent is still in trash, restore to root — visible beats invisible
  let folderId = row.folderId;
  let movedToRoot = false;
  if (folderId) {
    const [parent] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)))
      .limit(1);
    if (!parent) {
      folderId = null;
      movedToRoot = true;
    }
  }
  const [updated] = await db
    .update(files)
    .set({ status: 'active', deletedAt: null, folderId, updatedAt: new Date() })
    .where(and(eq(files.id, id), inArray(files.status, ['deleted'])))
    .returning();
  if (!updated) throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File not found');
  await logAudit(userId, 'file.restore', 'file', id, { name: row.name, movedToRoot });
  return toWire(updated);
}

// ---------------------------------------------------------------- permanent delete

/** Provider-first purge of a TRASHED file (folder-purge reuses this). Throws → row kept. */
export async function purgeFilePermanently(userId: string, id: string): Promise<void> {
  const db = getDb();
  const anyRow = await loadFile(db, userId, id); // any status — distinguish "active" from "missing"
  if (anyRow.status !== 'deleted') {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'File is not in the trash — move it there before deleting forever');
  }
  const { ctx } = await loadProviderAccount(userId, anyRow.accountId);
  await googleDriveProvider.delete(ctx, anyRow.providerFileId, false); // hard delete at Drive
  await db.delete(files).where(and(eq(files.id, id), eq(files.userId, userId)));
  await logAudit(userId, 'file.delete', 'file', id, { name: anyRow.name });
}

// ---------------------------------------------------------------- storage summary (sidebar widget)

export async function getStorageSummary(userId: string): Promise<StorageSummary> {
  const db = getDb();
  const rows = await db
    .select({
      totalBytes: storageUsage.totalBytes,
      usedBytes: storageUsage.usedBytes,
      availableBytes: storageUsage.availableBytes,
      reservedBytes: storageUsage.reservedBytes,
    })
    .from(accounts)
    .leftJoin(storageUsage, eq(storageUsage.accountId, accounts.id))
    .where(and(eq(accounts.userId, userId), eq(accounts.status, 'connected')));

  const anyUnlimited = rows.some((r) => r.totalBytes === null || r.availableBytes === null);
  const sum = (pick: (r: (typeof rows)[number]) => bigint | null) =>
    rows.reduce((acc, r) => acc + (pick(r) ?? 0n), 0n).toString();
  return {
    totalBytes: anyUnlimited ? null : sum((r) => r.totalBytes),
    usedBytes: sum((r) => r.usedBytes),
    availableBytes: anyUnlimited ? null : sum((r) => r.availableBytes),
    reservedBytes: sum((r) => r.reservedBytes),
    accountCount: rows.length,
  };
}

// ---------------------------------------------------------------- activity (audit timeline)

export async function listActivity(userId: string, limit = 100): Promise<ActivityResponse> {
  const db = getDb();
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(limit, 200));
  const events: ActivityEvent[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
  return { events };
}
