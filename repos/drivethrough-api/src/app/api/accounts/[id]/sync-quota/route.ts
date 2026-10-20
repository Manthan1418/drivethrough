// POST /api/accounts/:id/sync-quota — refresh one account's token + quota now (flow.md §9).
// Ownership is checked BEFORE any work (never touch another user's account — G8/authz).
// On revoked refresh token → ACCOUNT_NEEDS_REAUTH.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { syncAccountQuota, listAccounts } from '@/server/accounts/connect-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;

    // 1) ownership first
    const mine = (await listAccounts(userId)).some((a) => a.id === id);
    if (!mine) {
      return withCors(req, NextResponse.json({ code: 'FORBIDDEN', message: 'Not your account' }, { status: 403 }));
    }

    // 2) then the actual sync
    await syncAccountQuota(id);

    const after = (await listAccounts(userId)).find((a) => a.id === id);
    return withCors(req, NextResponse.json({ ok: true, usage: after?.usage ?? null }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
