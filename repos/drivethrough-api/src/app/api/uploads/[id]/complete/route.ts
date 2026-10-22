// POST /api/uploads/:id/complete — verify byte totals + the physical Drive file, then insert
// the files row and release the reservation in ONE transaction (flow.md §4.2, G7/G9).
// Idempotent (unique index arbitrates double-clicks). Quota sync is enqueued post-response —
// never inline in this response (flow.md §4.3 rule 5).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { completeUpload } from '@/server/uploads/upload-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    return withCors(req, NextResponse.json(await completeUpload(userId, id), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
