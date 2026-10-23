// Fixed-window rate limiter, in Postgres (tech.md §4): must work serverless — no memory
// counters, no extra service (no-cost rule, prd.md §11). One row per bucket, rolled over
// in place: the upsert advances `window_start` and resets `count` when the window changes,
// so the table is bounded by active buckets. Idle buckets are deleted opportunistically
// (2% of calls) and wholesale by the P0.5 daily cleanup job.

import { sql } from 'drizzle-orm';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from './errors';
import { getDb } from './db/client';

export const RATE_WINDOW_SEC = 60;

/** Start of the fixed window containing `nowMs` (pure — unit-tested). */
export function windowStartMs(nowMs: number, windowSec: number = RATE_WINDOW_SEC): number {
  return Math.floor(nowMs / (windowSec * 1000)) * windowSec * 1000;
}

/**
 * Client IP for per-IP buckets. On Vercel `x-forwarded-for` is OVERWRITTEN with the true
 * client address (spoof-proof — verified against Vercel docs 2026-10-23) and `x-real-ip`
 * mirrors it; locally neither exists, so all dev traffic shares the `unknown` bucket.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get('x-real-ip');
  if (real) {
    const trimmed = real.trim();
    if (trimmed) return trimmed.slice(0, 64);
  }
  return 'unknown';
}

/** Consume one unit from `bucketKey`. Throws AppError(RATE_LIMITED) past `limit`. */
export async function rateLimit(bucketKey: string, limit: number): Promise<void> {
  const bucket = bucketKey.slice(0, 255); // varchar(255) — never truncate mid-uuid silently wrong
  // ISO string, NOT a JS Date: db.execute() params go through postgres.js's prepared/Bind
  // path, which serializes Date as a string and crashes (ERR_INVALID_ARG_TYPE → every
  // rate-limited route 500s). Postgres parses the text back to timestamptz from column
  // context. Caught by the live e2e suite 2026-10-23.
  const ws = new Date(windowStartMs(Date.now())).toISOString();
  const db = getDb();
  const rows = await db.execute(sql`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (${bucket}, ${ws}, 1)
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start = ${ws} THEN rate_limits.count + 1 ELSE 1 END,
      window_start = ${ws}
    RETURNING count
  `);
  const count = Number((rows[0] as { count?: unknown } | undefined)?.count ?? 1);
  if (count > limit) {
    throw new AppError(
      ErrorCodes.RATE_LIMITED,
      `Too many requests — try again in ${RATE_WINDOW_SEC}s`
    );
  }
  // opportunistic sweep: idle buckets (no hit for >1 h) are useless state — drop them
  if (Math.random() < 0.02) {
    try {
      await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 hour'`);
    } catch (err) {
      console.warn('[ratelimit] sweep failed:', err instanceof Error ? err.message : err);
    }
  }
}
