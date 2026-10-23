// client/shares.ts — sharing + preview-token service (P0.4). All calls funnel through
// api.ts; public (unauthenticated) fetches pass auth:false — the share/preview token in
// the URL is the capability.

import { api, apiUrl } from './api';
import type {
  CreateShareRequest,
  PreviewTokenResponse,
  PublicShare,
  Share,
} from '@drivethrough/contracts';

/** Live links of a file (tokens are never listed — they're unknowable after create). */
export async function getShareState(fileId: string): Promise<
  Array<{ id: string; enabled: boolean; expiresAt: string | null; createdAt: string }>
> {
  const res = await api<{ shares: Array<{ id: string; enabled: boolean; expiresAt: string | null; createdAt: string }> }>(
    `/api/files/${fileId}/share`
  );
  return res.shares;
}

/** Create a reader-only link. `share.token` is non-null ONLY on fresh create. */
export async function createShare(fileId: string, input: CreateShareRequest = {}): Promise<Share> {
  const res = await api<{ share: Share }>(`/api/files/${fileId}/share`, { method: 'POST', json: input });
  return res.share;
}

/** Revoke ALL live links of a file (or one via shareId). Returns how many died. */
export async function revokeShare(fileId: string, shareId?: string): Promise<number> {
  const res = await api<{ revoked: number }>(
    `/api/files/${fileId}/share${shareId ? `?shareId=${shareId}` : ''}`,
    { method: 'DELETE' }
  );
  return res.revoked;
}

/** Mint a 10-minute preview capability (owner-authenticated). */
export async function mintPreviewToken(fileId: string): Promise<PreviewTokenResponse> {
  return api<PreviewTokenResponse>(`/api/files/${fileId}/preview-token`, { method: 'POST' });
}

/** Direct URL for a preview/share capability — what media elements put in `src`. */
export function capabilityUrl(token: string, opts: { download?: boolean } = {}): string {
  return apiUrl(`/api/preview/${encodeURIComponent(token)}${opts.download ? '?download=1' : ''}`);
}

/** PUBLIC share metadata fetch (the /s/[token] page — no auth, per-IP rate limited). */
export async function fetchPublicShare(token: string): Promise<PublicShare> {
  const res = await api<{ share: PublicShare }>(`/api/shares/${encodeURIComponent(token)}`, { auth: false });
  return res.share;
}

/** The shareable link lives on the FRONTEND origin (the public page route). */
export function sharePageUrl(token: string): string {
  if (typeof window === 'undefined') return `/s/${token}`; // SSR-safe fallback
  return `${window.location.origin}/s/${token}`;
}
