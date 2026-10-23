// POST /api/v1/uploads — EXTERNAL upload API, API-key auth (prd.md P0-12, flow.md §9).
// One call does init + placement ("same chunk protocol" from here on): return value carries
// chunkSize/totalChunks, then PUT /api/v1/uploads/:id/chunk?index=i streams each ≤4 MB
// body exactly like the internal route (no buffering — guard test covers this tree too).
// Idempotent via client-supplied clientUploadId (G6): a replayed POST re-opens the session
// and re-runs the idempotent reserve.

import { NextRequest, NextResponse } from 'next/server';
import { UploadInitRequest } from '@drivethrough/contracts';
import type { V1UploadCreateResponse } from '@drivethrough/contracts';
import { requireApiKey } from '@/server/auth/principal';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { parseOr400 } from '@/server/validation';
import { rateLimit } from '@/server/ratelimit';
import { initUpload, reserveUpload } from '@/server/uploads/upload-service';
import { getDb } from '@/server/db/client';
import { uploads } from '@/server/db/schema';
import { and, eq } from 'drizzle-orm';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const principal = await requireApiKey(req, { scope: 'uploads:write' });
    await rateLimit(`v1:${principal.keyId}`, 600); // keyed by user+key (tech.md §4)
    const input = parseOr400(UploadInitRequest, await req.json().catch(() => null));

    const init = await initUpload(principal.userId, input);
    if (init.status === 'completed') {
      const [row] = await getDb()
        .select({ accountId: uploads.accountId })
        .from(uploads)
        .where(and(eq(uploads.id, init.uploadId), eq(uploads.userId, principal.userId)))
        .limit(1);
      return withCors(
        req,
        NextResponse.json(
          { ...init, accountId: row?.accountId ?? '' } satisfies V1UploadCreateResponse,
          { status: 200 }
        )
      );
    }
    const reserve = await reserveUpload(principal.userId, init.uploadId);
    return withCors(
      req,
      NextResponse.json(
        {
          uploadId: init.uploadId,
          chunkSize: init.chunkSize,
          totalChunks: init.totalChunks,
          receivedChunks: init.receivedChunks,
          status: 'uploading',
          accountId: reserve.accountId,
        } satisfies V1UploadCreateResponse,
        { status: 201 }
      )
    );
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
