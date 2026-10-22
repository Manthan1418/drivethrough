// POST /api/files/batch — multi-select actions (move/trash/restore/permanent delete).
// Partial success is first-class: per-id results (see batch-service).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { runBatch } from '@/server/files/batch-service';
import { parseOr400 } from '@/server/validation';
import { BatchRequest } from '@drivethrough/contracts';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const input = parseOr400(BatchRequest, await req.json());
    const res = await runBatch(userId, input);
    return withCors(req, NextResponse.json(res, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
