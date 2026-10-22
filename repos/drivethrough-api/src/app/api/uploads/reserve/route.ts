// POST /api/uploads/reserve — placement + Drive resumable session (flow.md §4.2).
// Idempotent: a double-click on the same upload returns the same placement, never a
// second reservation (G4). Thin handler: auth + validate + delegate.

import { NextRequest, NextResponse } from 'next/server';
import { UploadReserveRequest } from '@drivethrough/contracts';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { parseOr400 } from '@/server/validation';
import { reserveUpload } from '@/server/uploads/upload-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const input = parseOr400(UploadReserveRequest, await req.json().catch(() => null));
    return withCors(req, NextResponse.json(await reserveUpload(userId, input.uploadId), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
