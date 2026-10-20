// Guard tests: missing Google OAuth env must surface as SERVICE_NOT_CONFIGURED (503,
// message exposed) — never a generic 500. Caught in prod 2026-10-20; design.md §6, flow.md §9.

import { describe, it, expect, afterEach } from 'vitest';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../src/server/errors';
import { buildConsentUrl } from '../src/server/providers/google-oauth';

const VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
const saved = new Map<string, string | undefined>();
for (const v of VARS) saved.set(v, process.env[v]);
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function clearEnv(): void {
  for (const v of VARS) delete process.env[v];
}

describe('Google OAuth config guards', () => {
  it('throws SERVICE_NOT_CONFIGURED (503, exposed) when GOOGLE_CLIENT_ID is missing', () => {
    clearEnv();
    let caught: unknown;
    try {
      buildConsentUrl('state123');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe(ErrorCodes.SERVICE_NOT_CONFIGURED);
    expect(err.status).toBe(503);
    expect(err.expose).toBe(true);
    // the message must survive to the wire — that's the entire point of this code
    expect(err.toResponse().body.message).toContain('GOOGLE_CLIENT_ID');
    expect(err.toResponse().body.code).toBe(ErrorCodes.SERVICE_NOT_CONFIGURED);
  });

  it('builds a real Google consent URL once the env exists', () => {
    process.env.GOOGLE_CLIENT_ID = 'test-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test';
    process.env.GOOGLE_REDIRECT_URI = 'https://api.example.com/api/accounts/google/callback';
    const url = new URL(buildConsentUrl('state123'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-id.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/accounts/google/callback'
    );
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('prompt')).toBe('consent'); // refresh token every connect
    expect(url.searchParams.get('scope')).toContain('auth/drive');
  });
});
