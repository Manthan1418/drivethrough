import { z } from 'zod';

// ---- Domain types shared across the wire (control plane) ----
// Sizes are bigint in DB, strings in JSON (tech.md convention).

export const ProviderKind = z.enum(['google_drive', 's3']);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const AccountStatus = z.enum(['connected', 'needs_reauth', 'disabled', 'degraded']);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const FileStatus = z.enum(['active', 'deleted', 'purged']);
export type FileStatus = z.infer<typeof FileStatus>;

export interface StorageAccount {
  id: string;
  provider: ProviderKind;
  label: string; // email for Drive, or user-chosen label for S3
  status: AccountStatus;
  lastSyncedAt: string | null; // ISO
  lastError: string | null;
}

export interface StorageUsage {
  accountId: string;
  totalBytes: string | null; // null = unlimited/unknown (Drive personal)
  usedBytes: string;
  availableBytes: string | null;
  reservedBytes: string;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  deletedAt: string | null;
}

export interface FileMeta {
  id: string;
  accountId: string;
  folderId: string | null;
  provider: ProviderKind;
  name: string;
  mimeType: string;
  sizeBytes: string;
  status: FileStatus;
  deletedAt: string | null; // ISO — set while in trash (restore cascades on it server-side)
  createdAt: string;
  updatedAt: string;
}

export interface Share {
  id: string;
  fileId: string;
  token: string | null; // raw value ONLY on create; null on idempotent replay (hashed at rest)
  enabled: boolean;
  expiresAt: string | null;
  role: 'viewer';
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  // `key` (full secret) only present on create response, shown once
  key?: string;
}

// Storage summary (combined pool view)
export interface StorageSummary {
  totalBytes: string | null; // null = any account reports unlimited/unknown
  usedBytes: string;
  availableBytes: string | null;
  reservedBytes: string; // in-flight upload claims (flow.md §4 reservations)
  accountCount: number;
}

// Auth/me
export interface MeResponse {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}
