// GET  /api/keys — list keys (prefix only; hashes never leave the DB).
// POST /api/keys — create; the full `dtk_…` secret is returned exactly once (shown once).
// Flow.md §9, prd.md P0-12.

import { NextRequest, NextResponse } from 'next/server';
import { CreateApiKeyRequest } from '@drivethrough/contracts';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';
import { parseOr400 } from '@/server/validation';
import { createKey, listKeys } from '@/server/keys/key-service';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    return withCors(req, NextResponse.json(await listKeys(userId), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const input = parseOr400(CreateApiKeyRequest, await req.json().catch(() => null));
    const { key, created } = await createKey(userId, input);
    return withCors(req, NextResponse.json({ key }, { status: created ? 201 : 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
