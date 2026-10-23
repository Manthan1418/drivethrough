// GET /api/shares/[token] — PUBLIC metadata for the /s/[token] page (no auth by design —
// the share token IS the capability). Per-IP rate limited (design.md §5.5).

import { NextRequest, NextResponse } from 'next/server';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { clientIp, rateLimit } from '@/server/ratelimit';
import { publicShareView, resolveShareForRead } from '@/server/shares/share-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    await rateLimit(`shm:${clientIp(req)}`, 60);
    const { token } = await ctx.params;
    const { share, file } = await resolveShareForRead(token);
    return withCors(
      req,
      NextResponse.json(
        { share: publicShareView(file, share.expiresAt) },
        { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
      )
    );
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
