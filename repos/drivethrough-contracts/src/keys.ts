import { z } from 'zod';
import type { ApiKey } from './domain.js';

// ---- API keys + external upload API (P0.4 — prd.md P0-12, flow.md §9, tech.md §4) ----
// Keys are hashed at rest (SHA-256 of the FULL key); the raw secret is returned exactly
// once, on create. `keyPrefix` (`dtk_<8 hex>`) is the public identification segment.

export const DEFAULT_KEY_SCOPES = ['uploads:write'] as const;

// POST /api/keys — `id` is an optional client UUID for idempotent create (G6); a replayed
// request returns the existing row WITHOUT `key` (the secret is unrecoverable by design).
export const CreateApiKeyRequest = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(255),
  scopes: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export interface ApiKeyListResponse {
  keys: ApiKey[];
}

export interface ApiKeyResponse {
  key: ApiKey; // `key` (full secret) present only when freshly created
}

// ---- /api/v1/uploads (API-key auth, same chunk protocol — tech.md §4, flow.md §9) ----
// v1 init folds placement into creation: POST once → immediately ready for chunks.
// Bodies mirror the internal protocol (UploadInitRequest etc. in uploads.ts).

// POST /api/v1/uploads → init + reserve in one call (retry-safe via clientUploadId)
export interface V1UploadCreateResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[]; // resume support — already-committed indexes
  status: string; // UploadStatus
  accountId: string; // placement result (drive_proxy always, P0)
}
