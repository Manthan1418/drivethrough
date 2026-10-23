// POST /api/v1/uploads/:id/complete — finalize an external upload (byte-total verified,
// then the files row is inserted under the (accountId, providerFileId) unique index —
// G4 arbitration identical to the internal route).

import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/server/auth/principal';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { rateLimit } from '@/server/ratelimit';
import { completeUpload } from '@/server/uploads/upload-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireApiKey(req, { scope: 'uploads:write' });
    await rateLimit(`v1:${principal.keyId}`, 600);
    const { id } = await ctx.params;
    return withCors(req, NextResponse.json(await completeUpload(principal.userId, id), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
