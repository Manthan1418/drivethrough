// Provider abstraction — the core interface (tech.md §5).
// Adding Dropbox/OneDrive later = one new provider file + a migration enum value.
// No `any` allowed in this path (AGENTS.md).

import type { ProviderKind } from '@drivethrough/contracts';

export interface ProviderUserContext {
  userId: string;
  accountId: string;
  // decrypted per-request by the caller (crypto/vault) — never persisted on ctx
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number | null;
  // S3 fields
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix?: string;
  };
}

export interface UploadContext extends ProviderUserContext {
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  targetRootFolderId?: string;
  /** Drive resumable session URI (server-held). S3 ignores. */
  sessionUri?: string;
  /** Drive: id captured from the final chunk's 200 response (uploads.provider_file_id).
   *  Set for completeUpload/abortUpload — never sent to the client. */
  providerFileId?: string;
}

export interface BeginResult {
  /** Drive: resumable sessionUri. S3: undefined (presigned parts or proxy mode). */
  sessionUri?: string;
  mode: 'drive_proxy' | 's3_direct' | 's3_proxy';
  /** S3 direct mode: presigned part URLs the client PUTs to. */
  presignedParts?: { index: number; url: string }[];
  /** Recommended app-chunk size (S3: max(4MB, partSize); Drive: 4MB or larger via relay). */
  chunkSize: number;
}

export interface ReadHandle {
  stream: ReadableStream;
  status: number;
  headers: Headers;
}

export interface ProviderObject {
  id: string;
  name: string;
  sizeBytes: bigint;
  mimeType: string;
  isFolder: boolean;
  modifiedAt: string;
}

export interface StorageProvider {
  kind: ProviderKind;

  // lifecycle
  ensureRoot(ctx: ProviderUserContext): Promise<string>;
  getQuota(ctx: ProviderUserContext, rootId: string): Promise<{
    total: bigint | null;
    used: bigint;
    available: bigint | null;
  }>;

  // write
  beginUpload(ctx: UploadContext): Promise<BeginResult>;
  putChunk(
    ctx: UploadContext,
    index: number,
    range: { start: number; end: number; total: number },
    body: ReadableStream
  ): Promise<{
    committedOffset: bigint;
    /** Drive final chunk (200): id of the file Google created. S3: undefined. */
    providerFileId?: string;
  }>;
  /** Drive 308 range check; S3 uses DB chunk ledger + ListParts. */
  queryOffset(ctx: UploadContext): Promise<bigint | 'complete' | 'unknown'>;
  completeUpload(ctx: UploadContext): Promise<{ providerFileId: string; name: string; size: bigint }>;
  abortUpload(ctx: UploadContext): Promise<void>;

  // read
  /** S3: presigned URL. Drive: null → caller uses openRead proxy. */
  signDownloadUrl(ctx: ProviderUserContext, fileId: string, ttlSeconds: number): Promise<string | null>;
  /** Drive alt=media Range proxy (passthrough 206/416). `rangeHeader` is the RAW client
   *  `Range` header (e.g. `bytes=1000-` from a <video> element) passed through verbatim —
   *  parsing/re-serializing would lose suffix and open-ended forms. S3 may also implement. */
  openRead(ctx: ProviderUserContext, fileId: string, rangeHeader?: string): Promise<ReadHandle>;

  // manage
  delete(ctx: ProviderUserContext, fileId: string, soft?: boolean): Promise<void>;
  /** reconciliation — enumerate provider children under a root */
  listChildren(ctx: ProviderUserContext, rootId: string): AsyncIterable<ProviderObject>;
}
