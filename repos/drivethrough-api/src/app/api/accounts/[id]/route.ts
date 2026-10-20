// DELETE /api/accounts/:id — disconnect an account (soft: status → disabled; G5/G8 — files stay).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { disconnectAccount } from '@/server/accounts/connect-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req); // keyless verify: revocation bounded by the token's ≤1 h TTL (design.md §8)
    const { id } = await ctx.params;
    await disconnectAccount(userId, id);
    return withCors(req, NextResponse.json({ ok: true }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
