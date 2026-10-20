// GET /api/accounts/google/callback?code&state — Google's redirect target (flow.md §3).
// This is a top-level browser NAVIGATION, not a fetch: no bearer token, no CORS.
// Auth = the single-use state (hash-verified, bound to initiating user). Success → 302 to frontend.

import { NextRequest, NextResponse } from 'next/server';
import { handleGoogleCallback } from '@/server/accounts/connect-service';
import { AppError, toApiError } from '@/server/errors';

function frontendBase(): string {
  return (process.env.FRONTEND_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const providerError = req.nextUrl.searchParams.get('error');

  if (providerError || !code || !state) {
    // user declined / Google error — no state to consume, just bounce back with the reason
    return NextResponse.redirect(
      `${frontendBase()}/settings?connect=error&reason=${encodeURIComponent(providerError ?? 'missing_params')}`,
      { status: 303 }
    );
  }

  try {
    await handleGoogleCallback(code, state);
    return NextResponse.redirect(`${frontendBase()}/settings?connected=1`, { status: 303 });
  } catch (err) {
    const { body } = toApiError(err);
    const reason = err instanceof AppError ? body.code : 'internal';
    return NextResponse.redirect(
      `${frontendBase()}/settings?connect=error&reason=${encodeURIComponent(reason)}`,
      { status: 303 }
    );
  }
}
