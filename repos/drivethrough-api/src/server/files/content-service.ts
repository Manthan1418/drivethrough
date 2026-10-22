// Read-path use-case (flow.md §5.2): ownership first, then a provider stream handle.
// Route handlers never touch SQL or the provider directly (AGENTS route rule).

import { and, eq } from 'drizzle-orm';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { files } from '../db/schema';
import { googleDriveProvider } from '../providers/google-drive';
import { loadProviderAccount } from '../accounts/account-context';
import type { ReadHandle } from '../providers/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Open a file's bytes for streaming. The file must be `userId`'s own (another user's id
 *  behaves exactly like a missing one — no existence leak) and active (trashed files 404
 *  until the trash UI restores them, P0.3). `rangeHeader` is the client's raw Range. */
export async function openFileContent(
  userId: string,
  fileId: string,
  rangeHeader?: string
): Promise<ReadHandle> {
  if (!UUID_RE.test(fileId)) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'invalid file id');
  }
  const db = getDb();
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId)))
    .limit(1);
  if (!file || file.status !== 'active') {
    throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File not found');
  }
  const { ctx } = await loadProviderAccount(userId, file.accountId);
  return googleDriveProvider.openRead(ctx, file.providerFileId, rangeHeader);
}
