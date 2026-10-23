// GET /api/v1/uploads/:id — resume state for an external client (same response shape as
// the internal GET /api/uploads/:id — flow.md §4.2). Key auth; ownership = the key's user.

import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/server/auth/principal';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { rateLimit } from '@/server/ratelimit';
import { getUploadState } from '@/server/uploads/upload-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireApiKey(req, { scope: 'uploads:write' });
    await rateLimit(`v1:${principal.keyId}`, 600);
    const { id } = await ctx.params;
    return withCors(req, NextResponse.json(await getUploadState(principal.userId, id), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
