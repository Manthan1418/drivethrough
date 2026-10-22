// THROWAWAY SPIKE ROUTE — S2 (tech.md §7): does chunk PUT streaming hold under Vercel's
// body handling? Incoming chunk body → forwarded to a Google resumable session URL with
// ZERO buffering (req.body pass-through + duplex:'half'). DELETED once the spike memo
// (spikes/S1-S2-v1.md) records the results.
//
// Telemetry rides the RESPONSE (Vercel function logs are not accessible to the operator).
// Session URL restricted to www.googleapis.com so the route cannot be abused as a relay.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { AppError, toApiError } from '@/server/errors';
import { ErrorCodes } from '@drivethrough/contracts';

export const maxDuration = 60; // spike: chunk forwarding only

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function PUT(req: NextRequest) {
  try {
    await requireDbUser(req); // spike: any valid bearer (both existing users are the owner's)

    const session = req.nextUrl.searchParams.get('session') ?? '';
    let u: URL;
    try {
      u = new URL(session);
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'session query param must be a URL');
    }
    if (u.protocol !== 'https:' || u.hostname !== 'www.googleapis.com') {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'session must be a https://www.googleapis.com resumable URL');
    }
    if (!req.body) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'empty request body');

    const rssStart = process.memoryUsage().rss;
    const t0 = Date.now();

    const fwdHeaders: Record<string, string> = {};
    const cl = req.headers.get('content-length');
    const cr = req.headers.get('content-range');
    if (cl) fwdHeaders['Content-Length'] = cl;
    if (cr) fwdHeaders['Content-Range'] = cr;

    const fwd = await fetch(session, {
      method: 'PUT',
      headers: fwdHeaders,
      body: req.body, // web ReadableStream pass-through — never buffered (AGENTS no-buffer rule)
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const rssEnd = process.memoryUsage().rss;
    const driveBody = await fwd.text(); // resumable responses are tiny (range status / metadata)

    return withCors(
      req,
      NextResponse.json(
        {
          driveStatus: fwd.status, // 308 = more chunks needed, 200 = file complete
          driveRange: fwd.headers.get('range'),
          driveBody: driveBody.slice(0, 300),
          receivedBytes: Number(cl ?? 0),
          forwardedMs: Date.now() - t0,
          rssStartMb: Math.round(rssStart / 1048576),
          rssEndMb: Math.round(rssEnd / 1048576),
        },
        { status: 200 }
      )
    );
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
