// Guard tests: missing Google OAuth env must surface as SERVICE_NOT_CONFIGURED (503,
// message exposed) — never a generic 500 (design.md §6, flow.md §9). Plus PKCE (S256)
// correctness: the challenge Google sees must be base64url(sha256(verifier)), and the
// token request must carry the verifier back verbatim.

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../src/server/errors';
import {
  buildConsentUrl, exchangeCode, generatePkce, tokenRequestBody,
} from '../src/server/providers/google-oauth';

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

function setEnv(): void {
  process.env.GOOGLE_CLIENT_ID = 'test-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test';
  process.env.GOOGLE_REDIRECT_URI = 'https://api.example.com/api/accounts/google/callback';
}

describe('Google OAuth config guards', () => {
  it('throws SERVICE_NOT_CONFIGURED (503, exposed) when GOOGLE_CLIENT_ID is missing', () => {
    clearEnv();
    let caught: unknown;
    try {
      buildConsentUrl('state123', 'challenge123');
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

  it('builds a real Google consent URL (with PKCE) once the env exists', () => {
    setEnv();
    const url = new URL(buildConsentUrl('state123', 'CHALLENGE-abc'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-id.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/accounts/google/callback'
    );
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('prompt')).toBe('consent'); // refresh token every connect
    expect(url.searchParams.get('scope')).toContain('auth/drive');
    // PKCE (flow.md §3): challenge in the URL, method pinned to S256
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('PKCE (RFC 7636, S256)', () => {
  it('challenge = base64url(sha256(verifier)), verifier ≥ 43 chars, url-safe', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43); // 32 random bytes → base64url
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // no +, / or = (must survive URL round-trips)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(challenge).not.toContain('=');
  });

  it('two pairs are never identical', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });

  it('token request carries the verifier back verbatim (and omits it when absent)', () => {
    setEnv();
    const withV = tokenRequestBody('auth-code', 'verifier-xyz');
    expect(withV.get('code_verifier')).toBe('verifier-xyz');
    expect(withV.get('grant_type')).toBe('authorization_code');
    expect(withV.get('code')).toBe('auth-code');
    const withoutV = tokenRequestBody('auth-code');
    expect(withoutV.get('code_verifier')).toBeNull();
  });

  it('exchangeCode signature requires a verifier (compile-time contract, runtime guard)', () => {
    setEnv();
    // exchangeCode(code) without verifier must NOT be callable — typed as (code, codeVerifier).
    // Runtime check: the exported function arity is 2.
    expect(exchangeCode.length).toBe(2);
  });
});
