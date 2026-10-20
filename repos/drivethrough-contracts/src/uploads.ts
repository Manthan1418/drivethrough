import { z } from 'zod';

// ---- Upload protocol (tech.md §4, flow.md §4) ----
// Server-authoritative offset; chunks are raw PUT bodies with Content-Range (NOT multipart).

export const UploadStatus = z.enum([
  'initiated',
  'uploading',
  'completed',
  'failed',
  'aborted',
]);
export type UploadStatus = z.infer<typeof UploadStatus>;

export const UploadChunkStatus = z.enum(['pending', 'committed']);
export type UploadChunkStatus = z.infer<typeof UploadChunkStatus>;

// POST /api/uploads/init  (idempotent via client-generated clientUploadId)
export const UploadInitRequest = z.object({
  clientUploadId: z.string().uuid(),
  fileName: z.string().min(1).max(512),
  mimeType: z.string().min(1),
  sizeBytes: z.string().regex(/^\d+$/), // bigint as string (tech.md convention)
  folderId: z.string().uuid().nullish(),
});
export type UploadInitRequest = z.infer<typeof UploadInitRequest>;

export const UploadInitResponse = z.object({
  uploadId: z.string().uuid(),
  chunkSize: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  receivedChunks: z.array(z.number().int().nonnegative()), // indexes already committed (resume)
  status: UploadStatus,
});
export type UploadInitResponse = z.infer<typeof UploadInitResponse>;

// POST /api/uploads/reserve → placement result
export const UploadReserveResponse = z.object({
  uploadId: z.string().uuid(),
  mode: z.enum(['drive_proxy', 's3_direct', 's3_proxy']),
  accountId: z.string().uuid(),
  // drive_proxy: server holds the resumable session URI (never sent to client)
  // s3_direct: array of presigned part URLs the browser PUTs to directly
  presignedParts: z
    .array(z.object({ index: z.number().int(), url: z.string().url() }))
    .optional(),
});
export type UploadReserveResponse = z.infer<typeof UploadReserveResponse>;

// GET /api/uploads/:id → resume state
export const UploadStateResponse = z.object({
  uploadId: z.string().uuid(),
  status: UploadStatus,
  committedOffset: z.string().regex(/^\d+$/),
  receivedChunks: z.array(z.number().int().nonnegative()),
  error: z.string().nullish(),
});
export type UploadStateResponse = z.infer<typeof UploadStateResponse>;

// PUT /api/uploads/chunk/:id?index=i  (headers: Content-Range: bytes a-b/total)
// response:
export const ChunkCommitResponse = z.object({
  committedOffset: z.string().regex(/^\d+$/),
  index: z.number().int().nonnegative(),
});
export type ChunkCommitResponse = z.infer<typeof ChunkCommitResponse>;

// POST /api/uploads/:id/complete
export const UploadCompleteResponse = z.object({
  uploadId: z.string().uuid(),
  fileId: z.string().uuid(),
  providerFileId: z.string(),
  sizeBytes: z.string().regex(/^\d+$/),
});
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponse>;
