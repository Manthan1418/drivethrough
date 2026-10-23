// Preview tokens (flow.md §5.2, design.md §3.3): 10-minute TTL, hashed, capability-style —
// minted by an authenticated owner, then served UNAUTHENTICATED through /api/preview/[token]
// so <img>/<video>/PDF can just use a URL (no auth header on media elements).
// One code path with the share issuer: both land in public-read.ts's permission resolver.

import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { ErrorCodes, type PreviewTokenResponse } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { previewTokens } from '../db/schema';
import { newSecretToken, sha256Hex, PREVIEW_PREFIX } from '../crypto/tokens';
import { loadActiveFileRow } from './content-service';

/** design.md §3.3 — "10-min TTL". Exported so the sweeper test and docs agree with the code. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** Mint a fresh preview capability for a file the user owns. */
export async function mintPreviewToken(userId: string, fileId: string): Promise<PreviewTokenResponse> {
  const file = await loadActiveFileRow(userId, fileId); // ownership + active, same as read
  const token = newSecretToken(PREVIEW_PREFIX);
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  await getDb().insert(previewTokens).values({
    id: randomUUID(),
    fileId: file.id,
    tokenHash: sha256Hex(token),
    expiresAt,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** PUBLIC resolver: raw token → fileId, or PREVIEW_TOKEN_INVALID (unknown OR expired —
 *  the client always re-mints, so the distinction never changes behavior). */
export async function resolvePreviewToken(rawToken: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ fileId: previewTokens.fileId })
    .from(previewTokens)
    .where(and(eq(previewTokens.tokenHash, sha256Hex(rawToken)), gt(previewTokens.expiresAt, new Date())))
    .limit(1);
  if (!row) {
    throw new AppError(ErrorCodes.PREVIEW_TOKEN_INVALID, 'Preview token is invalid or has expired');
  }
  return row.fileId;
}
