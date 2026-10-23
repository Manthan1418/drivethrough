// POST /api/v1/uploads/:id/abort — abandon an external upload; releases the reservation
// (claim goes back, G9) and best-effort kills the provider session.

import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/server/auth/principal';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { rateLimit } from '@/server/ratelimit';
import { abortUpload } from '@/server/uploads/upload-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireApiKey(req, { scope: 'uploads:write' });
    await rateLimit(`v1:${principal.keyId}`, 600);
    const { id } = await ctx.params;
    return withCors(req, NextResponse.json(await abortUpload(principal.userId, id), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
