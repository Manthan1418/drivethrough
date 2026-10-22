import { z } from 'zod';
import type { FileMeta, Folder, StorageSummary } from './domain.js';

// ---- Folders & files CRUD (P0.3 — flow.md §9, tech.md §4) ----
// Virtual namespace: folders are metadata-only (design.md §8), files rows point at
// provider bytes. Sizes are bigint in DB / strings in JSON (house convention).
// Trash model: `trashed` mutations set status/deletedAt; DELETE = soft (trash-first —
// design.md §5.2), permanent delete only via ?permanent=1 and only from trash.

// GET /api/folders?parentId=&q=&trashed=
export interface FolderListResponse {
  folders: Folder[];
}

// POST /api/folders
export const CreateFolderRequest = z.object({
  name: z.string().trim().min(1).max(512),
  parentId: z.string().uuid().nullish(), // omitted/null = root
});
export type CreateFolderRequest = z.infer<typeof CreateFolderRequest>;

// PATCH /api/folders/:id — every field optional; `parentId` present+null = move to root,
// `trashed:false` = restore (a restored folder whose parent is still trashed lands at root).
export const UpdateFolderRequest = z
  .object({
    name: z.string().trim().min(1).max(512).optional(),
    parentId: z.string().uuid().nullable().optional(),
    trashed: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequest>;

export interface FolderResponse {
  folder: Folder;
}

// GET /api/files?folderId=&q=&trashed=&view=recent
// `q` set ⇒ global search across active files (folderId ignored). `trashed=true` ⇒
// flat trash listing. `view=recent` ⇒ flat, most recently modified first.
// v1 returns at most `limit` rows (default 200, search 100); nextCursor stays null until
// keyset pagination lands with the larger-folder work (P0.5).
export interface FileListResponse {
  files: FileMeta[];
  nextCursor: string | null;
}

// GET /api/files/:id
export interface FileResponse {
  file: FileMeta;
}

// PATCH /api/files/:id — rename (duplicates allowed, Drive-style), move, trash/restore.
export const UpdateFileRequest = z
  .object({
    name: z.string().trim().min(1).max(512).optional(),
    folderId: z.string().uuid().nullable().optional(),
    trashed: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateFileRequest = z.infer<typeof UpdateFileRequest>;

// POST /api/files/batch — multi-select actions (move/trash/restore/permanent delete).
// Partial success is first-class: every id gets its own result row (one broken id must
// not silently roll back the other 49).
export const BatchOp = z.enum(['trash', 'restore', 'delete', 'move']);
export type BatchOp = z.infer<typeof BatchOp>;

export const BatchRequest = z
  .object({
    op: BatchOp,
    fileIds: z.array(z.string().uuid()).max(100).optional(),
    folderIds: z.array(z.string().uuid()).max(100).optional(),
    folderId: z.string().uuid().nullish(), // move destination only (null = root)
  })
  .refine((v) => (v.fileIds?.length ?? 0) + (v.folderIds?.length ?? 0) > 0, {
    message: 'at least one of fileIds/folderIds is required',
  });
export type BatchRequest = z.infer<typeof BatchRequest>;

export const BatchItemResult = z.object({
  id: z.string().uuid(),
  ok: z.boolean(),
  code: z.string().optional(), // AppError code when ok=false
  message: z.string().optional(),
});
export type BatchItemResult = z.infer<typeof BatchItemResult>;

export const BatchResponse = z.object({
  results: z.array(BatchItemResult),
});
export type BatchResponse = z.infer<typeof BatchResponse>;

// GET /api/activity — audit timeline (design.md §5.1 /audit view)
export interface ActivityEvent {
  id: string;
  action: string; // e.g. 'file.trash', 'folder.create', 'upload.complete'
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string; // ISO
}
export interface ActivityResponse {
  events: ActivityEvent[];
}

// GET /api/storage/summary — sidebar quota widget (combined pool)
export interface StorageSummaryResponse {
  summary: StorageSummary;
}
