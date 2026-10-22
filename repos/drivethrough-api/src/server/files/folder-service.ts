// Folder use-cases — the virtual namespace (flow.md §6, design.md §8 "Namespace" row):
// folders are METADATA ONLY, never mirrored into Drive folders. That buys O(1) moves,
// cross-account moves, and zero provider rename-quota burn.
//
// Trash model (design.md §5.2 "trash-first deletion"):
//  - trash cascades to descendants in ONE transaction and stamps every hit with the SAME
//    `deletedAt` marker; that shared timestamp is the cascade's identity, which is what
//    makes restore-to-exactly-this-cascade possible without a shadow table.
//  - restore walks back down from the marker. Known v1 tradeoff (documented): a child
//    trashed EARLIER (different marker) and then re-trashed by a parent cascade is
//    over-restored with the parent — accepted, reconciliation (P0.5) is the backstop.
//  - permanent delete is only legal FROM trash, and deletes provider bytes via the
//    file-service purge path (provider first, then rows — never lose the pointer).

import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { ErrorCodes, type CreateFolderRequest, type Folder, type FolderListResponse, type UpdateFolderRequest } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { files, folders, uploads } from '../db/schema';
import { logAudit } from '../audit';
// Static import is safe: file-service never imports this module (folder validation there
// is inline SQL) — the dependency runs one way only.
import { purgeFilePermanently } from './file-service';
import { ilikeSafe } from './search-like';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Hard cap on folder nesting — also the walk bound for cycle checks (nobody needs deeper). */
const MAX_DEPTH = 64;

function toWire(row: typeof folders.$inferSelect): Folder {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    color: row.color,
    icon: row.icon,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

async function loadFolder(db: Db, userId: string, id: string, trashed: boolean) {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.userId, userId), trashed ? isNotNull(folders.deletedAt) : isNull(folders.deletedAt)))
    .limit(1);
  if (!row) throw new AppError(ErrorCodes.FOLDER_NOT_FOUND, 'Folder not found');
  return row;
}

/** Same-name sibling conflict (folders only — files keep Drive's duplicate-name freedom). */
async function assertNameFree(db: Db, userId: string, parentId: string | null, name: string, exceptId?: string): Promise<void> {
  const conds: (SQL | undefined)[] = [
    eq(folders.userId, userId),
    parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
    sql`lower(${folders.name}) = lower(${name})`,
  ];
  if (exceptId) conds.push(sql`${folders.id} <> ${exceptId}`);
  const [dupe] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(...conds))
    .limit(1);
  if (dupe) throw new AppError(ErrorCodes.NAME_ALREADY_EXISTS, `A folder named "${name}" already exists here`);
}

/** Walk target ancestors up to root; FOLDER_CYCLE if the moved folder is among them. */
async function assertNoCycle(db: Db, userId: string, folderId: string, newParentId: string): Promise<void> {
  let cursor: string | null = newParentId;
  for (let depth = 0; cursor && depth <= MAX_DEPTH; depth++) {
    if (cursor === folderId) throw new AppError(ErrorCodes.FOLDER_CYCLE, 'Cannot move a folder into itself');
    const [p] = await db.select({ parentId: folders.parentId }).from(folders).where(eq(folders.id, cursor)).limit(1);
    if (!p) break; // parent row vanished (raced delete) — the parent check upstream reports it
    cursor = p.parentId;
  }
  if (cursor) throw new AppError(ErrorCodes.FOLDER_CYCLE, `Folder nesting exceeds ${MAX_DEPTH} levels`);
}

/** BFS over live descendants — returns [rootId, ...all descendants]. */
async function collectDescendants(db: Db, rootId: string): Promise<string[]> {
  const all = [rootId];
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const kids = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(inArray(folders.parentId, frontier), isNull(folders.deletedAt)));
    frontier = kids.map((k) => k.id);
    all.push(...frontier);
  }
  return all;
}

// ---------------------------------------------------------------- list

export async function listFolders(
  userId: string,
  opts: { parentId?: string | null; q?: string; trashed?: boolean }
): Promise<FolderListResponse> {
  const db = getDb();
  const conds: (SQL | undefined)[] = [eq(folders.userId, userId)];
  if (opts.trashed) {
    conds.push(isNotNull(folders.deletedAt)); // flat trash listing — every trashed folder
  } else {
    conds.push(isNull(folders.deletedAt));
    conds.push(opts.parentId ? eq(folders.parentId, opts.parentId) : isNull(folders.parentId));
    if (opts.q?.trim()) conds.push(ilikeSafe(folders.name, opts.q.trim()));
  }
  const rows = await db
    .select()
    .from(folders)
    .where(and(...conds))
    .orderBy(folders.name)
    .limit(opts.trashed || opts.q?.trim() ? 200 : 500);
  return { folders: rows.map(toWire) };
}

// ---------------------------------------------------------------- create

export async function createFolder(userId: string, input: CreateFolderRequest): Promise<Folder> {
  const db = getDb();
  const name = input.name.trim();
  if (!name) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'name must not be empty');
  const parentId: string | null = input.parentId ?? null;
  if (parentId) await loadFolder(db, userId, parentId, false); // target must be an active folder
  await assertNameFree(db, userId, parentId, name);
  const [row] = await db
    .insert(folders)
    .values({ userId, parentId, name })
    .returning();
  if (!row) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'folder insert produced no row');
  await logAudit(userId, 'folder.create', 'folder', row.id, { name });
  return toWire(row);
}

// ---------------------------------------------------------------- update (rename / move / trash / restore)

export async function updateFolder(userId: string, id: string, input: UpdateFolderRequest): Promise<Folder> {
  const db = getDb();
  // rename/move act on live folders; restore acts on trashed ones — the `trashed` flag
  // decides which (PATCH { trashed:false } is the restore path). loadFolder's third arg
  // means "require trashed state", so restoring ⇔ look among the trashed.
  const restoring = input.trashed === false;
  const folder = await loadFolder(db, userId, id, restoring);

  const sets: Partial<typeof folders.$inferInsert> = {};
  if (input.name !== undefined && input.name.trim() !== folder.name) {
    const name = input.name.trim();
    await assertNameFree(db, userId, folder.parentId, name, id);
    sets.name = name;
  }
  if (input.parentId !== undefined && (input.parentId ?? null) !== folder.parentId) {
    const newParent = input.parentId ?? null;
    if (newParent) {
      await loadFolder(db, userId, newParent, false);
      await assertNoCycle(db, userId, id, newParent);
    }
    sets.parentId = newParent;
  }
  // trash/restore route through their cascade-aware use-cases, never a bare column set
  if (restoring) return restoreFolder(userId, id);
  if (input.trashed === true) return trashFolder(userId, id);

  if (Object.keys(sets).length === 0) return toWire(folder); // no-op PATCH → current state
  const [row] = await db
    .update(folders)
    .set({ ...sets, updatedAt: new Date() })
    .where(and(eq(folders.id, id), eq(folders.userId, userId)))
    .returning();
  if (!row) throw new AppError(ErrorCodes.FOLDER_NOT_FOUND, 'Folder not found');
  if (sets.name) await logAudit(userId, 'folder.rename', 'folder', id, { name: sets.name });
  if ('parentId' in sets) await logAudit(userId, 'folder.move', 'folder', id, { parentId: sets.parentId ?? null });
  return toWire(row);
}

/** Trash one folder and everything under it, stamped with ONE marker (see file header). */
export async function trashFolder(userId: string, id: string): Promise<Folder> {
  const db = getDb();
  const folder = await loadFolder(db, userId, id, false);
  const marker = new Date();
  let trashedFolders = 0;
  let trashedFiles = 0;
  await db.transaction(async (tx) => {
    // widen the frontier manually (collectDescendants is read-only + live-only by design)
    const all = [id];
    let frontier = [id];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const kids = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(inArray(folders.parentId, frontier), isNull(folders.deletedAt)));
      frontier = kids.map((k) => k.id);
      all.push(...frontier);
    }
    const updFolders = await tx
      .update(folders)
      .set({ deletedAt: marker, updatedAt: marker })
      .where(and(inArray(folders.id, all), isNull(folders.deletedAt)))
      .returning({ id: folders.id });
    const updFiles = await tx
      .update(files)
      .set({ deletedAt: marker, status: 'deleted', updatedAt: marker })
      .where(and(inArray(files.folderId, all), eq(files.status, 'active')))
      .returning({ id: files.id });
    trashedFolders = updFolders.length;
    trashedFiles = updFiles.length;
  });
  await logAudit(userId, 'folder.trash', 'folder', id, { name: folder.name, trashedFolders, trashedFiles });
  return { ...toWire(folder), deletedAt: marker.toISOString() };
}

/** Restore the cascade identified by this folder's marker — descendants and files that
 *  share the marker come back; independently-trashed children stay in trash. */
export async function restoreFolder(userId: string, id: string): Promise<Folder> {
  const db = getDb();
  const folder = await loadFolder(db, userId, id, true);
  const marker = folder.deletedAt!;
  let restoredFolders = 0;
  let restoredFiles = 0;
  await db.transaction(async (tx) => {
    const all = [id];
    let frontier = [id];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const kids = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(inArray(folders.parentId, frontier), eq(folders.deletedAt, marker)));
      frontier = kids.map((k) => k.id);
      all.push(...frontier);
    }
    const updFolders = await tx
      .update(folders)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(inArray(folders.id, all), eq(folders.deletedAt, marker)))
      .returning({ id: folders.id });
    const updFiles = await tx
      .update(files)
      .set({ deletedAt: null, status: 'active', updatedAt: new Date() })
      .where(and(inArray(files.folderId, all), eq(files.deletedAt, marker)))
      .returning({ id: files.id });
    restoredFolders = updFolders.length;
    restoredFiles = updFiles.length;
  });
  await logAudit(userId, 'folder.restore', 'folder', id, { name: folder.name, restoredFolders, restoredFiles });
  return { ...toWire(folder), deletedAt: null };
}

// ---------------------------------------------------------------- permanent delete

/** Purge a TRASHED folder subtree: provider bytes first (via file-service purge), then rows.
 *  `purgeFilePermanently` lives in file-service to keep provider/account logic in one place;
 *  file-service intentionally does not import this module (no cycle). */
export async function purgeFolder(userId: string, id: string): Promise<{ files: number; folders: number }> {
  const db = getDb();
  const folder = await loadFolder(db, userId, id, true); // must already be in trash
  // tripwire: loadFolder(trashed=true) must have filtered for deletedAt — cheap guard
  // against the inverted-boolean class of bug this file had on 2026-10-22
  if (!folder.deletedAt) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Folder is not in the trash');
  // every descendant (any deleted state — children may have been trashed separately)
  const all = [id];
  let frontier = [id];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const kids = await db.select({ id: folders.id }).from(folders).where(inArray(folders.parentId, frontier));
    frontier = kids.map((k) => k.id);
    all.push(...frontier);
  }
  const contained = await db
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.folderId, all), sql`${files.status} <> 'purged'`));
  let purgedFiles = 0;
  for (const f of contained) {
    await purgeFilePermanently(userId, f.id); // provider-first; throws → aborts, rows intact
    purgedFiles++;
  }
  // detach upload sessions from the doomed folders (history stays, FK stays satisfied —
  // uploads.folderId is NO ACTION and would otherwise 500 the whole purge)
  await db.update(uploads).set({ folderId: null }).where(inArray(uploads.folderId, all));
  await db.delete(folders).where(and(inArray(folders.id, all), eq(folders.userId, userId)));
  await logAudit(userId, 'folder.delete', 'folder', id, { name: folder.name, files: purgedFiles, folders: all.length });
  return { files: purgedFiles, folders: all.length };
}

export { collectDescendants };
