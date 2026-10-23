// POST /api/files/:id/preview-token — mint a 10-minute capability for /api/preview/[token]
// (flow.md §5.2). The media element then fetches bytes WITHOUT an auth header (a <video>
// can't attach one), while the mint itself is owner-authenticated.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { mintPreviewToken } from '@/server/files/preview-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const result = await mintPreviewToken(userId, id);
    return withCors(req, NextResponse.json(result, { status: 201 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
