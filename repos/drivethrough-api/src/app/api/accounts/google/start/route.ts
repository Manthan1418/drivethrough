// GET /api/accounts/google/start — begin Drive connect (flow.md §3).
// Frontend calls this (bearer auth), gets the consent URL back, then navigates the browser to it.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { startGoogleConnect } from '@/server/accounts/connect-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const { authUrl } = await startGoogleConnect(userId);
    return withCors(req, NextResponse.json({ authUrl }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
