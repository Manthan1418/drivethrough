// GET /api/files/:id/content — streamed Drive Range proxy (tech.md §6.2, flow.md §5.2).
// Upstream status/headers pass through (200 / 206 / 416) so <video> seeking and the browser
// range downloader both work; the body streams straight through — zero buffering.
// Whole-file fetches fit Hobby's 300 s window (S1 measured 32 MB ≈ 18 s); the multi-GB path
// is client-side ranged windows ≤ 16 MB (P0.3), not this route alone.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { openFileContent } from '@/server/files/content-service';

export const maxDuration = 300; // Hobby ceiling — S1 validated headroom for ≤ 16 MB windows

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const handle = await openFileContent(userId, id, req.headers.get('range') ?? undefined);
    handle.headers.set('Cache-Control', 'private, no-store'); // previews never cache (tech §6.2)
    handle.headers.set('X-Content-Type-Options', 'nosniff');
    return withCors(req, new Response(handle.stream, { status: handle.status, headers: handle.headers }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
