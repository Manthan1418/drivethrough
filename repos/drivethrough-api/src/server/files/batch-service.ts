// Batch use-case — the multi-select action bar (move/trash/restore/permanent delete).
// Per-item results are first-class: 49 successes + 1 failure must report exactly that,
// never a silent all-or-nothing (a single foreign/stale id would otherwise veto the
// user's whole selection). Each item runs its single-item use-case, so every ACID
// guarantee there holds here unchanged.

import { ErrorCodes, type BatchRequest, type BatchResponse, type BatchItemResult } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { files, folders } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { purgeFilePermanently, restoreFile, trashFile, updateFile } from './file-service';
import { purgeFolder, restoreFolder, trashFolder, updateFolder } from './folder-service';
import { logAudit } from '../audit';

async function ownedIds<T extends string>(
  table: typeof files | typeof folders,
  userId: string,
  ids: T[]
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const db = getDb();
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(inArray(table.id, ids), eq(table.userId, userId)));
  return new Set(rows.map((r) => r.id));
}

export async function runBatch(userId: string, input: BatchRequest): Promise<BatchResponse> {
  const fileIds = input.fileIds ?? [];
  const folderIds = input.folderIds ?? [];
  // ownership pre-check once — a foreign id must fail as FORBIDDEN-ish NOT_FOUND per item,
  // but we also must never let batch route cross-user ids into mutations at all
  const ownedFiles = await ownedIds(files, userId, fileIds);
  const ownedFolders = await ownedIds(folders, userId, folderIds);
  const results: BatchItemResult[] = [];

  const track = async (id: string, owned: boolean, run: () => Promise<unknown>): Promise<void> => {
    if (!owned) {
      results.push({ id, ok: false, code: ErrorCodes.VALIDATION_FAILED, message: 'not found' });
      return;
    }
    try {
      await run();
      results.push({ id, ok: true });
    } catch (err) {
      if (err instanceof AppError) results.push({ id, ok: false, code: err.code, message: err.message });
      else {
        console.error('[batch] item failed:', err);
        results.push({ id, ok: false, code: ErrorCodes.INTERNAL_ERROR, message: 'Internal error' });
      }
    }
  };

  for (const id of fileIds) {
    await track(id, ownedFiles.has(id), () => {
      switch (input.op) {
        case 'trash':
          return trashFile(userId, id);
        case 'restore':
          return restoreFile(userId, id);
        case 'delete':
          return purgeFilePermanently(userId, id);
        case 'move':
          return updateFile(userId, id, { folderId: input.folderId ?? null });
        default:
          throw new AppError(ErrorCodes.VALIDATION_FAILED, 'unknown batch op');
      }
    });
  }
  for (const id of folderIds) {
    await track(id, ownedFolders.has(id), () => {
      switch (input.op) {
        case 'trash':
          return trashFolder(userId, id);
        case 'restore':
          return restoreFolder(userId, id);
        case 'delete':
          return purgeFolder(userId, id);
        case 'move':
          return updateFolder(userId, id, { parentId: input.folderId ?? null });
        default:
          throw new AppError(ErrorCodes.VALIDATION_FAILED, 'unknown batch op');
      }
    });
  }

  const okCount = results.filter((r) => r.ok).length;
  await logAudit(userId, `folder.batch.${input.op}`, 'file', null, {
    op: input.op,
    requested: results.length,
    ok: okCount,
  });
  return { results };
}
