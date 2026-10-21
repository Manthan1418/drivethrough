// GET/POST /api/system/google-config — 9Drive parity: the Google OAuth client credentials
// are entered in the Settings UI (not env vars), stored encrypted server-side. The secret
// is WRITE-ONLY — only a hasSecret flag ever leaves the server. Bearer auth required.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { getGoogleConfigStatus, saveGoogleConfig } from '@/server/accounts/provider-config-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    await requireDbUser(req);
    return withCors(req, NextResponse.json(await getGoogleConfigStatus(), { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireDbUser(req);
    // tiny JSON config payload (never a file body — the no-buffering rule covers file paths)
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = null; // empty/invalid JSON → service throws VALIDATION_FAILED
    }
    const result = await saveGoogleConfig(raw);
    return withCors(
      req,
      NextResponse.json({ message: 'Google OAuth credentials saved.', ...result }, { status: 200 })
    );
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
