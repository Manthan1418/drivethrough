// client/files.ts — frontend service for the P0.3 control plane (folders/files CRUD,
// trash, search, activity, storage summary). All calls via api.ts (single choke-point).

import { api } from './api';
import type {
  ActivityEvent,
  BatchOp,
  BatchResponse,
  CreateFolderRequest,
  FileListResponse,
  FileMeta,
  Folder,
  FolderListResponse,
  StorageSummary,
  UpdateFileRequest,
  UpdateFolderRequest,
} from '@drivethrough/contracts';

// ---- folders ----

export async function listFolders(opts: { parentId?: string | null; q?: string; trashed?: boolean } = {}): Promise<Folder[]> {
  const p = new URLSearchParams();
  if (opts.parentId) p.set('parentId', opts.parentId);
  if (opts.q) p.set('q', opts.q);
  if (opts.trashed) p.set('trashed', 'true');
  const qs = p.toString();
  const res = await api<FolderListResponse>(`/api/folders${qs ? `?${qs}` : ''}`);
  return res.folders;
}

export async function createFolder(name: string, parentId: string | null): Promise<Folder> {
  const res = await api<{ folder: Folder }>('/api/folders', {
    method: 'POST',
    json: { name, parentId } satisfies CreateFolderRequest,
  });
  return res.folder;
}

export async function updateFolder(id: string, patch: UpdateFolderRequest): Promise<Folder> {
  const res = await api<{ folder: Folder }>(`/api/folders/${id}`, { method: 'PATCH', json: patch });
  return res.folder;
}

export async function trashFolder(id: string): Promise<void> {
  await api(`/api/folders/${id}`, { method: 'DELETE' });
}

export async function purgeFolder(id: string): Promise<void> {
  await api(`/api/folders/${id}?permanent=1`, { method: 'DELETE' });
}

// ---- files ----

export async function listFiles(
  opts: { folderId?: string | null; q?: string; trashed?: boolean; recent?: boolean; limit?: number } = {}
): Promise<FileMeta[]> {
  const p = new URLSearchParams();
  if (opts.folderId) p.set('folderId', opts.folderId);
  if (opts.q) p.set('q', opts.q);
  if (opts.trashed) p.set('trashed', 'true');
  if (opts.recent) p.set('view', 'recent');
  if (opts.limit) p.set('limit', String(opts.limit));
  const qs = p.toString();
  const res = await api<FileListResponse>(`/api/files${qs ? `?${qs}` : ''}`);
  return res.files;
}

export async function getFile(id: string): Promise<FileMeta> {
  const res = await api<{ file: FileMeta }>(`/api/files/${id}`);
  return res.file;
}

export async function updateFile(id: string, patch: UpdateFileRequest): Promise<FileMeta> {
  const res = await api<{ file: FileMeta }>(`/api/files/${id}`, { method: 'PATCH', json: patch });
  return res.file;
}

export async function trashFile(id: string): Promise<void> {
  await api(`/api/files/${id}`, { method: 'DELETE' });
}

export async function purgeFile(id: string): Promise<void> {
  await api(`/api/files/${id}?permanent=1`, { method: 'DELETE' });
}

export async function batchOp(
  op: BatchOp,
  opts: { fileIds?: string[]; folderIds?: string[]; folderId?: string | null } = {}
): Promise<BatchResponse> {
  return api<BatchResponse>('/api/files/batch', {
    method: 'POST',
    json: {
      op,
      ...(opts.fileIds?.length ? { fileIds: opts.fileIds } : {}),
      ...(opts.folderIds?.length ? { folderIds: opts.folderIds } : {}),
      ...(op === 'move' ? { folderId: opts.folderId ?? null } : {}),
    },
  });
}

// ---- activity ----

export async function listActivity(): Promise<ActivityEvent[]> {
  const res = await api<{ events: ActivityEvent[] }>('/api/activity');
  return res.events;
}

// ---- storage summary (sidebar widget) ----

export async function getStorageSummary(): Promise<StorageSummary> {
  const res = await api<{ summary: StorageSummary }>('/api/storage/summary');
  return res.summary;
}
