// GET    /api/files/:id/share — live links of a file (never includes tokens — unknowable
//                                  after create; the dialog only needs count/expiry).
// POST   /api/files/:id/share — create a reader-only link; raw token returned ONCE.
// DELETE /api/files/:id/share — revoke (all live links of the file, or one via ?shareId=).
// Flow.md §9, prd.md P0-11. Auth = session bearer on all three.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { CreateShareRequest } from '@drivethrough/contracts';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { parseOr400 } from '@/server/validation';
import { createShare, getShareState, revokeShares } from '@/server/shares/share-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    return withCors(req, NextResponse.json(await getShareState(userId, id), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const input = parseOr400(CreateShareRequest, await req.json().catch(() => ({})));
    const { share, created } = await createShare(userId, id, input);
    return withCors(req, NextResponse.json({ share }, { status: created ? 201 : 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const shareId = req.nextUrl.searchParams.get('shareId') ?? undefined;
    const result = await revokeShares(userId, id, shareId);
    return withCors(req, NextResponse.json(result, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
