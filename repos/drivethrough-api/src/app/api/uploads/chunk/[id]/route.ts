// PUT /api/uploads/chunk/:id?index=i — THE no-buffer path (tech.md §6/§9, AGENTS rule).
// The raw Content-Range body is passed to the service as a stream and forwarded to Drive
// with duplex:'half' — NEVER await req.text()/arrayBuffer()/formData() anywhere in here
// (guard test tests/no-buffer-guard.test.ts scans this file). Chunk bodies are ≤ 4 MB
// (S2-proven Vercel edge cap ~4.5 MB); telemetry-free by design.

import { NextRequest, NextResponse } from 'next/server';
import { ErrorCodes } from '@drivethrough/contracts';
import { requireDbUser } from '@/server/auth/db-user';
import { handlePreflight, withCors } from '@/server/cors';
import { AppError, toApiError } from '@/server/errors';
import { putUploadChunk } from '@/server/uploads/upload-service';

export const maxDuration = 60; // spike S2: 4 MB chunk ≈ 1–3 s round trip

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    if (!req.body) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'empty chunk body');
    }
    const index = req.nextUrl.searchParams.get('index') ?? '';
    const result = await putUploadChunk(
      userId,
      id,
      index,
      req.headers.get('content-range'),
      req.body // stream pass-through — the entire point of this route
    );
    return withCors(req, NextResponse.json(result, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
