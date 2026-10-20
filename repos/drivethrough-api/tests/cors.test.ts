// Guard tests for the CORS allowlist (tech.md §9, cross-origin boundary §8).
// Regression class caught in prod 2026-10-20: a trailing slash in CORS_ALLOW_ORIGIN
// made every real browser origin fail the exact match and broke the whole frontend.

import { describe, it, expect, afterEach } from 'vitest';
import { corsHeaders, handlePreflight } from '../src/server/cors';

afterEach(() => {
  delete process.env.CORS_ALLOW_ORIGIN;
});

describe('CORS allowlist normalization', () => {
  it('matches an origin when the env value has a trailing slash', () => {
    process.env.CORS_ALLOW_ORIGIN = 'https://app.example.com/';
    expect(corsHeaders('https://app.example.com')?.['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com'
    );
  });

  it('trims whitespace and supports a comma-separated list', () => {
    process.env.CORS_ALLOW_ORIGIN = ' https://a.example.com/ , https://b.example.com ';
    expect(corsHeaders('https://b.example.com')).not.toBeNull();
    expect(corsHeaders('https://a.example.com')).not.toBeNull();
  });

  it('rejects an unlisted origin (no wildcard, ever)', () => {
    process.env.CORS_ALLOW_ORIGIN = 'https://a.example.com';
    expect(corsHeaders('https://evil.example.com')).toBeNull();
  });

  it('rejects an unlisted preflight with 403 and no ACAO header', () => {
    process.env.CORS_ALLOW_ORIGIN = 'https://a.example.com';
    const res = handlePreflight(
      new Request('http://x.test/api', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } })
    );
    expect(res?.status).toBe(403);
    expect(res?.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('204s an allowed preflight (slash-tolerant) with full headers', () => {
    process.env.CORS_ALLOW_ORIGIN = 'https://a.example.com/';
    const res = handlePreflight(
      new Request('http://x.test/api', { method: 'OPTIONS', headers: { origin: 'https://a.example.com' } })
    );
    expect(res?.status).toBe(204);
    expect(res?.headers.get('Access-Control-Allow-Origin')).toBe('https://a.example.com');
    expect(res?.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});
