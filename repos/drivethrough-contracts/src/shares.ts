import { z } from 'zod';
import type { Share } from './domain.js';

// ---- Sharing & preview tokens (P0.4 — flow.md §5.2/§9, design.md §3.3/§5.5) ----
// Tokens are hashed at rest (SHA-256); the raw value is returned ONLY on create.
// Shares are reader-only (`share_role` enum has no writer), revocable, optionally expiring.

// POST /api/files/:id/share — `id` is an optional client UUID for idempotent create (G6):
// a replayed request returns the existing row with `share.token = null` (the raw token is
// unknowable after creation — hashed lookup only, tech.md §8). Body may be omitted
// entirely (`{}` = new link, no expiry, server-generated id) so curl stays one line.
export const CreateShareRequest = z.object({
  id: z.string().uuid().optional(),
  // absent/null = never expires; otherwise an ISO datetime strictly in the future
  expiresAt: z.string().datetime().nullish(),
});
export type CreateShareRequest = z.infer<typeof CreateShareRequest>;

export interface ShareResponse {
  share: Share; // token: raw string on create, null on idempotent replay
}

// GET /api/files/:id/share — tokens are never listed; only liveness for the dialog.
export interface ShareStateResponse {
  shares: Array<{
    id: string;
    enabled: boolean;
    expiresAt: string | null;
    createdAt: string;
  }>;
}

export interface RevokeShareResponse {
  revoked: number; // 0 is legal (idempotent revoke) — the public side 404s regardless
}

// POST /api/files/:id/preview-token → short-lived capability for /api/preview/[token]
export interface PreviewTokenResponse {
  token: string; // raw — hashed at rest
  expiresAt: string; // ISO — 10-minute TTL (design.md §3.3)
}

// GET /api/shares/[token] — PUBLIC (no auth): what the /s/[token] page renders.
// Deliberately minimal: no file id, no owner, no path — just enough to preview + download.
export interface PublicShare {
  name: string;
  mimeType: string;
  sizeBytes: string; // bigint as string (house convention)
  expiresAt: string | null;
  role: 'viewer';
}
export interface ShareViewResponse {
  share: PublicShare;
}
