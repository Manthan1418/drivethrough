// API keys (prd.md P0-12, flow.md §9): hashed at rest, secret shown ONCE, revocable,
// last-used tracked, scope-gated. The external /api/v1 surface authenticates with these —
// never with a Firebase session (a leaked key must be revocable without touching sign-in).
//
// Key format: `dtk_<8 hex>_<32 base64url>` — 12-char `keyPrefix` shown in lists for
// identification; the FULL string is what gets SHA-256'd, so the prefix alone is useless.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or, lt, sql } from 'drizzle-orm';
import { ErrorCodes, type ApiKey, type ApiKeyListResponse, type CreateApiKeyRequest, DEFAULT_KEY_SCOPES } from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import { apiKeys } from '../db/schema';
import { logAudit } from '../audit';
import { newApiKey, sha256Hex, API_KEY_PREFIX } from '../crypto/tokens';

type ApiKeyRow = typeof apiKeys.$inferSelect;

/** Never serialize the hash — the wire shape is the contract's ApiKey. */
function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes ?? [],
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

export async function listKeys(userId: string): Promise<ApiKeyListResponse> {
  const rows = await getDb()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt))
    .limit(100);
  return { keys: rows.map(toApiKey) };
}

/** Create a key; the raw secret appears ONLY in this response (shown once, copy affordance).
 *  Optional client-supplied `id` makes creation idempotent (G6) — a replay returns the
 *  existing row WITHOUT `key` (the secret is unrecoverable by design). */
export async function createKey(userId: string, input: CreateApiKeyRequest): Promise<{ key: ApiKey; created: boolean }> {
  const id = input.id ?? randomUUID();
  const { raw, prefix } = newApiKey();
  const scopes = input.scopes ?? [...DEFAULT_KEY_SCOPES];
  const db = getDb();
  const [row] = await db
    .insert(apiKeys)
    .values({
      id,
      userId,
      name: input.name,
      keyPrefix: prefix,
      keyHash: sha256Hex(raw),
      scopes,
    })
    .onConflictDoNothing({ target: apiKeys.id })
    .returning();

  if (row) {
    await logAudit(userId, 'key.create', 'key', row.id, { name: row.name, keyPrefix: prefix, scopes });
    return { key: { ...toApiKey(row), key: raw }, created: true };
  }

  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .limit(1);
  if (!existing) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'id was already used for a different key');
  }
  return { key: toApiKey(existing), created: false };
}

/** Revoke (soft — `revoked_at`): the next v1 call with it 401s immediately (flow §10.6). */
export async function revokeKey(userId: string, keyId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (!row) {
    // exists-but-already-revoked is indistinguishable from missing (no state oracle)
    const [anyRow] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .limit(1);
    if (anyRow) return; // idempotent second revoke — already dead, nothing to do
    throw new AppError(ErrorCodes.KEY_NOT_FOUND, 'API key not found');
  }
  await logAudit(userId, 'key.revoke', 'key', keyId, {});
}

export interface AuthenticatedKey {
  userId: string;
  keyId: string;
  scopes: string[];
}

/** Full-key authentication for /api/v1: hash → row → liveness. Unknown → UNAUTHENTICATED;
 *  revoked → TOKEN_REVOKED (both 401 — flow §10.6's "next call 401"). last-used is touched
 *  at most once a minute so chunked uploads don't write per request. */
export async function authenticateApiKey(raw: string): Promise<AuthenticatedKey> {
  if (!raw.startsWith(API_KEY_PREFIX)) {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Invalid API key');
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, sha256Hex(raw)))
    .limit(1);
  if (!row) throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Invalid API key');
  if (row.revokedAt) throw new AppError(ErrorCodes.TOKEN_REVOKED, 'API key has been revoked');

  try {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, row.id),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '60 seconds'`))
        )
      );
  } catch (err) {
    console.warn('[api-key] last-used touch failed:', err instanceof Error ? err.message : err);
  }
  return { userId: row.userId, keyId: row.id, scopes: row.scopes ?? [] };
}
