// DELETE /api/keys/:id — revoke an API key (soft: revoked_at). The next /api/v1 call with
// it returns 401 immediately (flow.md §10.6). Idempotent: revoking twice is fine.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { revokeKey } from '@/server/keys/key-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    await revokeKey(userId, id);
    return withCors(req, NextResponse.json({ ok: true }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
