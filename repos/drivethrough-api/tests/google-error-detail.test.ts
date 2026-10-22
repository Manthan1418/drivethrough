// Guard tests: the connect-failure DIAGNOSTIC path (fix 2026-10-22 — the step/status detail
// used to be swallowed with no log and no banner). Google's public error name/description must
// ride the provider messages, everything must pass safeDetail (charset allow-list + 120-char
// cap) so the ?detail= redirect can't be reshaped and never carries secret-shaped text.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError, safeDetail } from '../src/server/errors';
import { exchangeCode } from '../src/server/providers/google-oauth';

describe('safeDetail (redirect/log sanitizer)', () => {
  it('keeps step/status-style text intact', () => {
    expect(safeDetail('Token exchange failed (400): invalid_grant — Malformed auth code.')).toBe(
      'Token exchange failed (400): invalid_grant — Malformed auth code.'
    );
  });

  it('strips URL/redirect-reshaping characters: ? & = < > #', () => {
    const clean = safeDetail('Upstream said ?reason=hijack&evil=<script>#x end');
    for (const ch of ['?', '&', '=', '<', '>', '#']) expect(clean).not.toContain(ch);
    expect(clean).toContain('Upstream said');
    expect(clean).toContain('end');
  });

  it('collapses whitespace and caps at 120 chars', () => {
    expect(safeDetail('a \n\t  b')).toBe('a b');
    expect(safeDetail('x'.repeat(500)).length).toBe(120);
  });
});

describe('exchangeCode failure carries Google public error (diagnosability)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = {
    clientId: 'id.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-test',
    redirectUri: 'https://api.example.com/api/accounts/google/callback',
  };

  it('composes step + status + error + description, all sanitized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Malformed auth code.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
    let caught: unknown;
    try {
      await exchangeCode('code', 'verifier', cfg);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe(ErrorCodes.PROVIDER_ERROR);
    expect(err.status).toBe(502);
    expect(err.message).toContain('Token exchange failed (400)');
    expect(err.message).toContain('invalid_grant');
    expect(err.message).toContain('Malformed auth code');
  });

  it('survives a non-JSON error body (status only, no throw from json parsing)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    let caught: unknown;
    try {
      await exchangeCode('code', 'verifier', cfg);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).message).toBe('Token exchange failed (502)');
  });
});
