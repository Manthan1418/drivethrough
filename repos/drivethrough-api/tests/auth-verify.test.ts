// Guard tests for the keyless Firebase ID-token verifier (tech.md §9, spike S5).
// Pure claim + header validation only — NO network: the JWKS fetch/signature path is jose's
// job and gets its live exercise in spike S5 (cross-origin auth test against a real deploy).

import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '@drivethrough/contracts';
import type { JWTPayload } from 'jose';
import { AppError } from '../src/server/errors';
import { validateIdTokenClaims, requireAuth } from '../src/server/auth/verify';

const NOW = 1_700_000_000; // fixed clock — tests never depend on real time

function validPayload(): JWTPayload {
  return { sub: 'fb-uid-1', iat: NOW - 5, exp: NOW + 600, auth_time: NOW - 60 };
}

describe('validateIdTokenClaims (Google manual-verification checklist)', () => {
  it('accepts a well-formed payload', () => {
    expect(() => validateIdTokenClaims(validPayload(), NOW)).not.toThrow();
  });

  it('accepts a payload without optional auth_time', () => {
    const p = validPayload();
    delete p.auth_time;
    expect(() => validateIdTokenClaims(p, NOW)).not.toThrow();
  });

  it('accepts timestamps within clock tolerance', () => {
    expect(() => validateIdTokenClaims({ ...validPayload(), iat: NOW + 10 }, NOW)).not.toThrow();
    expect(() => validateIdTokenClaims({ ...validPayload(), auth_time: NOW + 10 }, NOW)).not.toThrow();
  });

  it('rejects empty, missing, and oversized sub with UNAUTHENTICATED', () => {
    for (const sub of ['', 'x'.repeat(257)] as const) {
      let caught: unknown;
      try {
        validateIdTokenClaims({ ...validPayload(), sub }, NOW);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe(ErrorCodes.UNAUTHENTICATED);
      expect((caught as AppError).status).toBe(401);
    }
    const noSub = validPayload();
    delete noSub.sub;
    expect(() => validateIdTokenClaims(noSub, NOW)).toThrow(AppError);
  });

  it('rejects iat or auth_time in the future (beyond tolerance)', () => {
    expect(() => validateIdTokenClaims({ ...validPayload(), iat: NOW + 31 }, NOW)).toThrow(AppError);
    expect(() => validateIdTokenClaims({ ...validPayload(), auth_time: NOW + 31 }, NOW)).toThrow(AppError);
  });
});

describe('requireAuth bearer-header parsing', () => {
  it('rejects a missing Authorization header', async () => {
    const req = new Request('http://api.test/api/files', { headers: {} });
    await expect(requireAuth(req)).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHENTICATED,
      message: 'Missing bearer token',
    });
  });

  it('rejects a non-Bearer scheme', async () => {
    const req = new Request('http://api.test/api/files', { headers: { authorization: 'Basic dXNlcjpwdw==' } });
    await expect(requireAuth(req)).rejects.toMatchObject({ code: ErrorCodes.UNAUTHENTICATED });
  });

  it('rejects "Bearer" with no token after it', async () => {
    const req = new Request('http://api.test/api/files', { headers: { authorization: 'Bearer' } });
    await expect(requireAuth(req)).rejects.toMatchObject({ code: ErrorCodes.UNAUTHENTICATED });
  });

  // A well-formed Bearer token would trigger a real JWKS fetch → spike S5 live test, not here.
});
