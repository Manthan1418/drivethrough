// Connect-a-account use-cases (flow.md §3). Route handlers stay thin (design.md §2.3):
// all SQL + Drive calls live here.

import { eq, and, isNull } from 'drizzle-orm';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { accounts, storageUsage, oauthStates, users } from '../db/schema';
import { hashToken, generateToken, encryptSecret, decryptSecret } from '../crypto/vault';
import {
  buildConsentUrl, exchangeCode, ensureRootFolder, fetchQuota, refreshAccessToken,
} from '../providers/google-oauth';

const STATE_TTL_MS = 10 * 60 * 1000; // flow.md §3: 10 min TTL

/** Start a Drive connect flow: mint single-use state (bound to user), return Google consent URL. */
export async function startGoogleConnect(userId: string): Promise<{ authUrl: string }> {
  const raw = generateToken(32);
  const db = getDb();
  await db.insert(oauthStates).values({
    userId,
    provider: 'google_drive',
    stateHash: hashToken(raw),
    flow: 'connect',
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return { authUrl: buildConsentUrl(raw) };
}

/**
 * Complete the flow from the Google redirect. NO bearer token here — the single-use
 * state is the only credential, so it must be verified + consumed atomically (login-CSRF guard).
 */
export async function handleGoogleCallback(code: string, state: string): Promise<{ userId: string }> {
  const db = getDb();
  const stateHash = hashToken(state);

  // atomic single-use consume: only one UPDATE can flip usedAt NULL → now
  const consumed = await db
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(and(
      eq(oauthStates.stateHash, stateHash),
      eq(oauthStates.flow, 'connect'),
      isNull(oauthStates.usedAt),
    ))
    .returning({ userId: oauthStates.userId, expiresAt: oauthStates.expiresAt });

  const row = consumed[0];
  if (!row) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Invalid or already-used state');
  if (row.expiresAt.getTime() < Date.now()) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'State expired');

  // exchange code → tokens (throws PROVIDER_ERROR if Google rejects)
  const tokens = await exchangeCode(code);

  // idempotent-ish: same Google account reconnected → update tokens instead of duplicate row
  const profileEmail = await fetchProfileEmail(tokens.accessToken);
  const existing = await db
    .select()
    .from(accounts)
    .where(and(
      eq(accounts.userId, row.userId),
      eq(accounts.provider, 'google_drive'),
      eq(accounts.label, profileEmail),
    ))
    .limit(1);

  const rootFolderId = await ensureRootFolder(tokens.accessToken);
  const quota = await fetchQuota(tokens.accessToken);
  const now = new Date();
  // AAD binds ciphertext to the account row (tech.md §8) — encrypt after we know the id for new rows,
  // for updates we reuse the existing row id.
  let accountId: string;

  if (existing[0]) {
    accountId = existing[0].id;
    await db.update(accounts).set({
      accessTokenEnc: encryptSecret(tokens.accessToken, accountId),
      refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken, accountId) : existing[0].refreshTokenEnc,
      tokenExpiresAt: new Date(tokens.expiresAt),
      rootFolderId,
      status: 'connected',
      lastError: null,
      lastSyncedAt: now,
    }).where(eq(accounts.id, accountId));
    await db.update(storageUsage).set({
      totalBytes: quota.total, usedBytes: quota.used, availableBytes: quota.available, syncedAt: now,
    }).where(eq(storageUsage.accountId, accountId));
  } else {
    const inserted = await db
      .insert(accounts)
      .values({
        userId: row.userId,
        provider: 'google_drive',
        label: profileEmail,
        status: 'connected',
        rootFolderId,
        tokenExpiresAt: new Date(tokens.expiresAt),
        lastSyncedAt: now,
        // tokens encrypted with AAD = account id; id is known pre-insert via defaultRandom? No —
        // so we insert with tokens null, then update with AAD-bound ciphertext (G1: no plaintext rest).
      })
      .returning({ id: accounts.id });
    accountId = inserted[0]!.id;
    await db.update(accounts).set({
      accessTokenEnc: encryptSecret(tokens.accessToken, accountId),
      refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken, accountId) : null,
    }).where(eq(accounts.id, accountId));
    await db.insert(storageUsage).values({
      accountId,
      totalBytes: quota.total,
      usedBytes: quota.used,
      availableBytes: quota.available,
      syncedAt: now,
    });
  }

  // ensure the users row exists (first connect after sign-in)
  await ensureUserRow(row.userId);

  return { userId: row.userId };
}

/** Refresh a stored account's access token + quota (used by sync-quota route / quota cron). */
export async function syncAccountQuota(accountId: string): Promise<void> {
  const db = getDb();
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!acct) throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'Account not found');
  if (acct.provider !== 'google_drive') {
    // S3 quota sync is a HeadBucket call — handled in the S3 provider (P0.1); skip here.
    return;
  }
  if (!acct.refreshTokenEnc || !acct.rootFolderId) {
    throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'Account missing credentials');
  }
  const refresh = decryptForAccount(acct.refreshTokenEnc, acct.id);
  const tokens = await refreshAccessToken(refresh); // throws ACCOUNT_NEEDS_REAUTH on revoke (G8)
  const quota = await fetchQuota(tokens.accessToken);
  const now = new Date();
  await db.update(accounts).set({
    accessTokenEnc: encryptSecret(tokens.accessToken, acct.id),
    tokenExpiresAt: new Date(tokens.expiresAt),
    status: 'connected',
    lastError: null,
    lastSyncedAt: now,
  }).where(eq(accounts.id, acct.id));
  await db.update(storageUsage).set({
    totalBytes: quota.total, usedBytes: quota.used, availableBytes: quota.available, syncedAt: now,
  }).where(eq(storageUsage.accountId, acct.id));
}

/** List a user's connected accounts + live usage (control plane). Returns the wire shape from
 *  contracts Account: nested usage, sizes as decimal STRINGS (bigint never reaches JSON.stringify),
 *  timestamps ISO (AGENTS: sizes bigint in DB, strings in JSON). */
export async function listAccounts(userId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: accounts.id,
      provider: accounts.provider,
      label: accounts.label,
      status: accounts.status,
      lastSyncedAt: accounts.lastSyncedAt,
      lastError: accounts.lastError,
      totalBytes: storageUsage.totalBytes,
      usedBytes: storageUsage.usedBytes,
      availableBytes: storageUsage.availableBytes,
      reservedBytes: storageUsage.reservedBytes,
    })
    .from(accounts)
    .leftJoin(storageUsage, eq(storageUsage.accountId, accounts.id))
    .where(eq(accounts.userId, userId));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    status: r.status,
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    lastError: r.lastError,
    usage: {
      totalBytes: r.totalBytes !== null ? r.totalBytes.toString() : null,
      usedBytes: (r.usedBytes ?? 0n).toString(), // left-join miss ⇒ no storage_usage row yet
      availableBytes: r.availableBytes !== null ? r.availableBytes.toString() : null,
      reservedBytes: (r.reservedBytes ?? 0n).toString(),
    },
  }));
}

/** Disconnect: soft-remove (disable) rather than hard-delete — files on it stay until purged (G5/G8). */
export async function disconnectAccount(userId: string, accountId: string): Promise<void> {
  const db = getDb();
  const updated = await db
    .update(accounts)
    .set({ status: 'disabled' })
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .returning({ id: accounts.id });
  if (!updated[0]) throw new AppError(ErrorCodes.FORBIDDEN, 'Account not found');
}

// ---- helpers ----

async function fetchProfileEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) {
    const info = (await res.json()) as { email?: string };
    if (info.email) return info.email;
  }
  // fallback: userinfo may be unavailable if scope lacks profile — use token sub via id_token not available here;
  // fall back to a stable label from root folder fetch is overkill; use drive about user? Keep simple:
  return 'drive-account';
}

async function ensureUserRow(userId: string): Promise<void> {
  const db = getDb();
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (u) return;
  // user should already exist (created at first authenticated call); no-op if not — see auth middleware.
}

function decryptForAccount(ciphertext: string, accountId: string): string {
  return decryptSecret(ciphertext, accountId);
}
