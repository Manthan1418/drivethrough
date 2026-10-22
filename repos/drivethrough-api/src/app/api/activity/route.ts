// GET /api/activity — the audit timeline (design.md §5.1).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { listActivity } from '@/server/files/file-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const limitRaw = req.nextUrl.searchParams.get('limit');
    const res = await listActivity(userId, limitRaw ? Number(limitRaw) : undefined);
    return withCors(req, NextResponse.json(res, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
