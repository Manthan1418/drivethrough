// Build a provider context from a stored account — ownership + status checked FIRST (G8),
// access token decrypted per request, transparently refreshed + re-persisted when near expiry
// (expiry < 2 min). Refresh failure → ACCOUNT_NEEDS_REAUTH (the client shows "reconnect").
// Secrets never leave this module in logs (AGENTS: never log tokens).

import { and, eq } from 'drizzle-orm';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { accounts } from '../db/schema';
import { encryptSecret, decryptSecret } from '../crypto/vault';
import { refreshAccessToken, googleNotConfigured } from '../providers/google-oauth';
import { resolveGoogleOAuthConfig } from './provider-config-service';
import type { ProviderUserContext } from '../providers/types';

export const TOKEN_REFRESH_MARGIN_MS = 120_000;

export interface ProviderAccount {
  account: typeof accounts.$inferSelect;
  ctx: ProviderUserContext;
}

/** Load `accountId` scoped to `userId` (another user's id behaves exactly like a missing one —
 *  no existence leak), enforce usable status, decrypt the access token, refresh if needed. */
export async function loadProviderAccount(
  userId: string,
  accountId: string
): Promise<ProviderAccount> {
  const db = getDb();
  const [acct] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .limit(1);
  if (!acct) throw new AppError(ErrorCodes.NO_CONNECTED_ACCOUNT, 'Account not found');
  if (acct.provider !== 'google_drive') {
    throw new AppError(ErrorCodes.NOT_IMPLEMENTED, 'Only Google Drive accounts work yet (S3 provider comes later)');
  }
  if (acct.status === 'disabled') {
    throw new AppError(ErrorCodes.NO_CONNECTED_ACCOUNT, 'Account is disconnected');
  }
  if (acct.status === 'needs_reauth' || !acct.accessTokenEnc) {
    throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'Account needs to be reconnected in Settings');
  }

  let accessToken = decryptSecret(acct.accessTokenEnc, acct.id);
  const nearExpiry = !acct.tokenExpiresAt || acct.tokenExpiresAt.getTime() - Date.now() < TOKEN_REFRESH_MARGIN_MS;

  if (nearExpiry) {
    if (!acct.refreshTokenEnc) throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'Account has no refresh token');
    const cfg = await resolveGoogleOAuthConfig();
    if (!cfg) throw googleNotConfigured();
    const tokens = await refreshAccessToken(decryptSecret(acct.refreshTokenEnc, acct.id), cfg);
    accessToken = tokens.accessToken;
    // persist so the next invocation skips the refresh round-trip
    await db
      .update(accounts)
      .set({
        accessTokenEnc: encryptSecret(accessToken, acct.id),
        tokenExpiresAt: new Date(tokens.expiresAt),
        status: 'connected',
        lastError: null,
      })
      .where(eq(accounts.id, acct.id));
  }

  return {
    account: acct,
    ctx: {
      userId,
      accountId,
      accessToken,
      tokenExpiresAt: acct.tokenExpiresAt?.getTime() ?? null,
    },
  };
}
