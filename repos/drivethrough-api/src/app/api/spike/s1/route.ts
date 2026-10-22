// THROWAWAY SPIKE ROUTE — S1 (tech.md §7): Drive proxy throughput on the Hobby plan.
// Streams a Drive file (full or Range) through this function with ZERO buffering; telemetry
// rides the RESPONSE HEADERS, wall-clock throughput is measured by the client.
// DELETED once the spike memo (spikes/S1-S2-v1.md) records the results.
//
// Spike-only shortcuts (documented in the memo): account looked up by accountId WITHOUT
// ownership scoping (only the owner's two users exist during the spike window); access
// token refreshed in-memory if near expiry (DB left untouched).

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { ErrorCodes } from '@drivethrough/contracts';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { AppError, toApiError } from '@/server/errors';
import { getDb } from '@/server/db/client';
import { accounts } from '@/server/db/schema';
import { decryptSecret } from '@/server/crypto/vault';
import { refreshAccessToken, googleNotConfigured } from '@/server/providers/google-oauth';
import { resolveGoogleOAuthConfig } from '@/server/accounts/provider-config-service';

export const maxDuration = 300; // Hobby ceiling — S1 measures how far a stream gets within it

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    await requireDbUser(req);
    const accountId = req.nextUrl.searchParams.get('accountId') ?? '';
    const fileId = req.nextUrl.searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'id must be a Drive file id');
    }
    const db = getDb();
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!acct?.accessTokenEnc) throw new AppError(ErrorCodes.NO_CONNECTED_ACCOUNT, 'Account not found');

    let token = decryptSecret(acct.accessTokenEnc, acct.id);
    if (acct.tokenExpiresAt && acct.tokenExpiresAt.getTime() - Date.now() < 120_000) {
      if (!acct.refreshTokenEnc) throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'No refresh token');
      const cfg = await resolveGoogleOAuthConfig();
      if (!cfg) throw googleNotConfigured();
      token = (await refreshAccessToken(decryptSecret(acct.refreshTokenEnc, acct.id), cfg)).accessToken;
    }

    const range = req.headers.get('range');
    const t0 = Date.now();
    const up = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
    });
    const ttfb = Date.now() - t0;
    if (!up.ok && up.status !== 206) {
      const txt = await up.text();
      throw new AppError(ErrorCodes.PROVIDER_ERROR, `Drive media fetch failed (${up.status})`);
    }

    // stream through untouched — no buffering anywhere in this handler
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('x-spike-upstream-status', String(up.status));
    headers.set('x-spike-upstream-ttfb-ms', String(ttfb));
    headers.set('x-spike-rss-mb', String(Math.round(process.memoryUsage().rss / 1048576)));
    if (!range) headers.set('x-spike-total-bytes', up.headers.get('content-length') ?? 'unknown');
    return withCors(req, new Response(up.body, { status: up.status, headers }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
