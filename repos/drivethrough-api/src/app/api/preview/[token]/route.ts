// GET /api/preview/[token] — PUBLIC content stream (unauthenticated for the token's life —
// flow.md §5.2). Accepts BOTH issuers through one permission resolver (design.md §3.3):
//   dtp_… preview token (owner-minted, 10 min) — what <img>/<video>/<iframe> fetch directly
//   dsh_… share token   (link liveness re-checked on every request — revoke lands instantly)
// Upstream Range status/headers pass through (200/206/416) exactly like the authed content
// route; `?download=1` flips it to a native browser download (attachment disposition).
// Per-IP rate limited (video seeking issues many small Range requests → generous bucket).

import { NextRequest, NextResponse } from 'next/server';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { contentDisposition } from '@/server/files/disposition';
import { openPublicContent } from '@/server/files/public-read';
import { clientIp, rateLimit } from '@/server/ratelimit';

export const maxDuration = 300; // same budget as the authed content route (tech.md §6.2)

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    await rateLimit(`pv:${clientIp(req)}`, 300);
    const { token } = await ctx.params;
    const { grant, handle } = await openPublicContent(token, req.headers.get('range') ?? undefined);
    handle.headers.set('Cache-Control', 'private, no-store'); // capability URLs never cache
    handle.headers.set('X-Content-Type-Options', 'nosniff');
    if (req.nextUrl.searchParams.get('download') === '1') {
      handle.headers.set('Content-Disposition', contentDisposition(grant.file.name));
    }
    return withCors(req, new Response(handle.stream, { status: handle.status, headers: handle.headers }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
