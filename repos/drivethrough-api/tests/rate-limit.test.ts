// Rate-limiter plumbing (P0.4 — tech.md §4): fixed-window math + client-IP extraction are
// pure, so they get unit tests; the live 429 behavior is proven in the e2e suite.

import { describe, it, expect } from 'vitest';
import { RATE_WINDOW_SEC, clientIp, windowStartMs } from '../src/server/ratelimit';

describe('windowStartMs (fixed windows)', () => {
  it('aligns every timestamp to the 60 s grid', () => {
    expect(windowStartMs(0)).toBe(0);
    expect(windowStartMs(59_999)).toBe(0);
    expect(windowStartMs(60_000)).toBe(60_000);
    expect(windowStartMs(60_001)).toBe(60_000);
    expect(windowStartMs(600_000)).toBe(600_000);
  });

  it('consecutive requests inside a minute share one window; the next minute rolls over', () => {
    const a = windowStartMs(Date.UTC(2026, 9, 23, 12, 0, 0));
    const b = windowStartMs(Date.UTC(2026, 9, 23, 12, 0, 59));
    const c = windowStartMs(Date.UTC(2026, 9, 23, 12, 1, 0));
    expect(a).toBe(b);
    expect(c).toBe(a + RATE_WINDOW_SEC * 1000);
  });

  it('honors a custom window', () => {
    expect(windowStartMs(150_000, 300)).toBe(0); // first 300 s window spans [0, 300000)
    expect(windowStartMs(160_000, 300)).toBe(0);
    expect(windowStartMs(460_000, 300)).toBe(300_000); // rolls at the 5-minute mark
  });
});

describe('clientIp', () => {
  const withHeaders = (h: Record<string, string>) =>
    new Request('http://localhost/api/x', { headers: h });

  it('uses x-forwarded-for (Vercel overwrites it — spoof-proof, docs verified 2026-10-23)', () => {
    expect(clientIp(withHeaders({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('takes the first hop if a chain somehow appears, capped at 64 chars', () => {
    expect(clientIp(withHeaders({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(withHeaders({ 'x-forwarded-for': 'a'.repeat(200) }))).toHaveLength(64);
  });

  it('falls back to x-real-ip (identical value on Vercel), then a shared local bucket', () => {
    expect(clientIp(withHeaders({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(withHeaders({}))).toBe('unknown');
    expect(clientIp(withHeaders({ 'x-forwarded-for': '   ' }))).toBe('unknown');
  });
});
