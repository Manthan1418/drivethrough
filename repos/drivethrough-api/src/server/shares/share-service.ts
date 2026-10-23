// Share use-cases (flow.md §5.2, prd.md P0-11, design.md §5.5): reader-only, hashed,
// revocable, optionally expiring. Fixes 9Drive's L6 — the share_role enum physically has
// no `writer`, so a world-writable link cannot be expressed.
//
// Token lifecycle: raw value exists only in the create response; every lookup is by
// SHA-256 hash (tech.md §8). Revocation flips `enabled` — the public resolver checks it
// on EVERY request, so revoke lands within seconds (prd.md §216: ≤ 60 s).

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { ErrorCodes, type CreateShareRequest, type RevokeShareResponse, type Share, type ShareStateResponse, type ShareViewResponse, type PublicShare } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { files, shares } from '../db/schema';
import { logAudit } from '../audit';
import { newSecretToken, sha256Hex, SHARE_PREFIX } from '../crypto/tokens';
import { loadActiveFileRow, type ReadableFileRow } from '../files/content-service';

type ShareRow = typeof shares.$inferSelect;

function toShare(row: ShareRow, token: string | null): Share {
  return {
    id: row.id,
    fileId: row.fileId,
    token,
    enabled: row.enabled,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Create (or idempotently re-return) a share link for a file the user owns (G6).
 *  The raw token is returned ONLY when this call actually inserted the row — after that it
 *  is unrecoverable by design (hashed at rest). `created` distinguishes 201 from 200. */
export async function createShare(
  userId: string,
  fileId: string,
  input: CreateShareRequest
): Promise<{ share: Share; created: boolean }> {
  const file = await loadActiveFileRow(userId, fileId);

  let expiresAt: Date | null = null;
  if (input.expiresAt != null) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'expiresAt: invalid datetime');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'expiresAt must be in the future');
    }
  }

  const id = input.id ?? randomUUID();
  const token = newSecretToken(SHARE_PREFIX);
  const db = getDb();
  const [created] = await db
    .insert(shares)
    .values({
      id,
      fileId: file.id,
      userId,
      tokenHash: sha256Hex(token),
      enabled: true,
      expiresAt,
    })
    .onConflictDoNothing({ target: shares.id })
    .returning();

  if (!created) {
    // replay of a client-supplied id — answer with the existing row (no raw token)
    const [existing] = await db
      .select()
      .from(shares)
      .where(and(eq(shares.id, id), eq(shares.userId, userId)))
      .limit(1);
    if (!existing || existing.fileId !== fileId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'id was already used for a different share');
    }
    return { share: toShare(existing, null), created: false };
  }

  await logAudit(userId, 'share.create', 'share', created.id, {
    fileId,
    name: file.name,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
  return { share: toShare(created, token), created: true };
}

/** Revoke share link(s) for a file the user owns — all live links of the file by default,
 *  or exactly one via `shareId`. Idempotent: revoking twice returns `{ revoked: 0 }`
 *  (the public side 404s either way). */
export async function revokeShares(
  userId: string,
  fileId: string,
  shareId?: string
): Promise<RevokeShareResponse> {
  const db = getDb();
  const [file] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .limit(1);
  if (!file) throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File not found');

  const conditions = [eq(shares.fileId, fileId), eq(shares.userId, userId), eq(shares.enabled, true)];
  if (shareId) conditions.push(eq(shares.id, shareId));
  const revokedRows = await db
    .update(shares)
    .set({ enabled: false })
    .where(and(...conditions))
    .returning({ id: shares.id });

  if (revokedRows.length) {
    await logAudit(userId, 'share.revoke', 'share', shareId ?? null, {
      fileId,
      revoked: revokedRows.length,
    });
  }
  return { revoked: revokedRows.length };
}

/** Live links of a file (never includes tokens — they are unknowable after create). */
export async function getShareState(userId: string, fileId: string): Promise<ShareStateResponse> {
  const db = getDb();
  const rows = await db
    .select({
      id: shares.id,
      enabled: shares.enabled,
      expiresAt: shares.expiresAt,
      createdAt: shares.createdAt,
    })
    .from(shares)
    .where(
      and(
        eq(shares.fileId, fileId),
        eq(shares.userId, userId),
        eq(shares.enabled, true),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date()))
      )
    )
    .orderBy(desc(shares.createdAt))
    .limit(20);
  return {
    shares: rows.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export interface ResolvedShare {
  share: ShareRow;
  file: ReadableFileRow;
}

/** PUBLIC resolver — token → (share, file), enforcing liveness on every request:
 *  unknown/disabled → SHARE_NOT_FOUND (404, the "revoked" answer), past expiry →
 *  SHARE_EXPIRED (410), trashed/purged file → SHARE_NOT_FOUND (a trashed file's link
 *  must look dead too — no existence leak). */
export async function resolveShareForRead(rawToken: string): Promise<ResolvedShare> {
  const db = getDb();
  const [share] = await db
    .select()
    .from(shares)
    .where(eq(shares.tokenHash, sha256Hex(rawToken)))
    .limit(1);
  if (!share || !share.enabled) {
    throw new AppError(ErrorCodes.SHARE_NOT_FOUND, 'This link has been revoked or does not exist');
  }
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
    throw new AppError(ErrorCodes.SHARE_EXPIRED, 'This link has expired');
  }
  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, share.fileId), eq(files.status, 'active')))
    .limit(1);
  if (!file[0]) {
    throw new AppError(ErrorCodes.SHARE_NOT_FOUND, 'This link has been revoked or does not exist');
  }
  return { share, file: file[0] };
}

/** What the public /s/[token] page renders — deliberately minimal (design.md §5.5). */
export function publicShareView(file: ReadableFileRow, expiresAt: Date | null): PublicShare {
  return {
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes.toString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    role: 'viewer',
  };
}
