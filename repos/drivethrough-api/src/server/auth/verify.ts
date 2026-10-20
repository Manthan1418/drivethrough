// Firebase ID-token verification guard (bearer-only, cross-origin) — tech.md §8, spike S5.
// Verifies Authorization: Bearer <idToken> on every protected route; maps firebase_uid → users row.
//
// KEYLESS since 2026-10-20 (replaces firebase-admin + service-account JSON): the organisation
// enforces iam.disableServiceAccountKeyCreation ("secure by default"), so service-account keys
// cannot exist here — and JWT verification never needed one: we check Google's SIGNATURE against
// its public JWKS plus the iss/aud/exp/sub claims Google documents for manual verification.
// Tradeoff (design.md §8): no checkRevoked (admin-SDK-only, needs a credential) → a revoked or
// deleted user's token stays valid for its normal ≤1 h lifetime. Accepted for v1; sensitive ops
// rely on that TTL bound. Guard tests: tests/auth-verify.test.ts (tech.md §9).

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';

/** Google's public signing keys for Firebase ID tokens (securetoken@system.gserviceaccount.com). */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_TOLERANCE_S = 30; // serverless clock drift
const MAX_SUB_LEN = 256; // Google's documented bound

const jwks = createRemoteJWKSet(new URL(JWKS_URL), {
  cooldownDuration: 30_000, // after a fetch miss/failure, don't refetch sooner than 30 s
  cacheMaxAge: 60 * 60 * 1000, // Google rotates rarely; cache keys an hour
});

function projectId(): string {
  const pid = process.env.FIREBASE_PROJECT_ID;
  if (!pid) throw new Error('FIREBASE_PROJECT_ID not set');
  return pid;
}

export interface AuthedUser {
  firebaseUid: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

function unauthenticated(): AppError {
  return new AppError(ErrorCodes.UNAUTHENTICATED, 'Invalid or expired token');
}

/**
 * Claim checks jose does not do for us (Google's manual-verification checklist).
 * Signature, issuer, audience, expiry are enforced by jwtVerify itself.
 * Exported for guard tests; `nowSec` injectable so tests don't depend on the clock.
 */
export function validateIdTokenClaims(payload: JWTPayload, nowSec: number): void {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUB_LEN) throw unauthenticated();
  if (typeof payload.iat === 'number' && payload.iat > nowSec + CLOCK_TOLERANCE_S) throw unauthenticated();
  const authTime = payload.auth_time;
  if (typeof authTime === 'number' && authTime > nowSec + CLOCK_TOLERANCE_S) throw unauthenticated();
}

async function verifyIdToken(token: string): Promise<JWTPayload> {
  const pid = projectId();
  const verified = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${pid}`,
    audience: pid,
    algorithms: ['RS256'],
    requiredClaims: ['iat', 'exp', 'sub'],
    clockTolerance: CLOCK_TOLERANCE_S,
  }).catch(() => null);
  if (!verified) throw unauthenticated();
  validateIdTokenClaims(verified.payload, Math.floor(Date.now() / 1000));
  return verified.payload;
}

/** Extract + verify the bearer ID token. Throws AppError(UNAUTHENTICATED) on any failure. */
export async function requireAuth(req: Request): Promise<AuthedUser> {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Missing bearer token');
  }
  const payload = await verifyIdToken(token);
  return {
    firebaseUid: payload.sub!, // string — validated non-empty by validateIdTokenClaims
    email: typeof payload.email === 'string' ? payload.email : '',
    name: typeof payload.name === 'string' ? payload.name : undefined,
    avatarUrl: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
