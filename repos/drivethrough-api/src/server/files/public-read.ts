// Public read plane (design.md §3.3: "one code path (read service + permission resolver),
// two issuers"). A raw capability token arrives at /api/preview/[token]; the resolver
// decides WHO it belongs to (preview token → owner-minted file; share token → the share's
// file with liveness enforced), and the SAME streaming path takes it from there.
//
// There is deliberately no "user" check at stream time: the token IS the permission, and
// every issuer validated ownership (preview) or link liveness (share) before minting.

import { and, eq } from 'drizzle-orm';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { SHARE_PREFIX, PREVIEW_PREFIX } from '../crypto/tokens';
import type { ReadHandle } from '../providers/types';
import { getDb } from '../db/client';
import { files } from '../db/schema';
import { openFileRow, type ReadableFileRow } from './content-service';
import { resolvePreviewToken } from './preview-service';
import { resolveShareForRead } from '../shares/share-service';

export interface PublicReadGrant {
  file: ReadableFileRow;
  issuer: 'preview' | 'share';
}

/** Permission resolver in front of the read service (tech.md §6.2). */
export async function resolvePublicRead(rawToken: string): Promise<PublicReadGrant> {
  if (rawToken.startsWith(PREVIEW_PREFIX)) {
    const fileId = await resolvePreviewToken(rawToken);
    // resolvePreviewToken proved the token; the file row still must be active+existing
    const { file } = await resolveSharelessFile(fileId);
    return { file, issuer: 'preview' };
  }
  if (rawToken.startsWith(SHARE_PREFIX)) {
    const { file } = await resolveShareForRead(rawToken);
    return { file, issuer: 'share' };
  }
  // unknown shape → same class of answer as an expired preview token (no oracle on which
  // table a token *almost* belongs to)
  throw new AppError(ErrorCodes.PREVIEW_TOKEN_INVALID, 'Preview token is invalid or has expired');
}

/** Load the active file row for a preview-token grant (trashed/purged → same 404 as the
 *  authed path — a preview capability never resurrects a trashed file). */
async function resolveSharelessFile(fileId: string): Promise<{ file: ReadableFileRow }> {
  const [file] = await getDb()
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.status, 'active')))
    .limit(1);
  if (!file) {
    throw new AppError(ErrorCodes.PREVIEW_TOKEN_INVALID, 'Preview token is invalid or has expired');
  }
  return { file };
}

/** Stream bytes for a resolved public grant (Range passthrough — 206 for <video> seeks). */
export async function openPublicContent(
  rawToken: string,
  rangeHeader?: string
): Promise<{ grant: PublicReadGrant; handle: ReadHandle }> {
  const grant = await resolvePublicRead(rawToken);
  const handle = await openFileRow(grant.file, rangeHeader);
  return { grant, handle };
}
