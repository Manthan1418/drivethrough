// POST /api/uploads/init — create (or idempotently re-open) an upload session (flow.md §4.2).
// Idempotency key comes from the client (clientUploadId) so a double-click never forks a
// second session (G4). Thin handler: auth + validate + delegate (AGENTS route rule).

import { NextRequest, NextResponse } from 'next/server';
import { UploadInitRequest } from '@drivethrough/contracts';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { parseOr400 } from '@/server/validation';
import { initUpload } from '@/server/uploads/upload-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const input = parseOr400(UploadInitRequest, await req.json().catch(() => null));
    return withCors(req, NextResponse.json(await initUpload(userId, input), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
