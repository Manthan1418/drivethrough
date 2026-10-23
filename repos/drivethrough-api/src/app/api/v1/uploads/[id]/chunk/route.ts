// PUT /api/v1/uploads/:id/chunk?index=i — external chunk upload: THE no-buffer path,
// same rules as the internal chunk route (tech.md §6/§9, AGENTS rule). The raw
// Content-Range body streams straight through to Drive with duplex:'half' — NEVER
// await req.text()/arrayBuffer()/formData() in here (the no-buffer guard scans this
// tree too). Chunks are ≤ 4 MB (Vercel edge cap ~4.5 MB).

import { NextRequest, NextResponse } from 'next/server';
import { ErrorCodes } from '@drivethrough/contracts';
import { requireApiKey } from '@/server/auth/principal';
import { handlePreflight, withCors } from '@/server/cors';
import { AppError, toApiError } from '@/server/errors';
import { rateLimit } from '@/server/ratelimit';
import { putUploadChunk } from '@/server/uploads/upload-service';

export const maxDuration = 60; // spike S2: 4 MB chunk ≈ 1–3 s round trip

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireApiKey(req, { scope: 'uploads:write' });
    await rateLimit(`v1:${principal.keyId}`, 600);
    const { id } = await ctx.params;
    if (!req.body) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'empty chunk body');
    }
    const index = req.nextUrl.searchParams.get('index') ?? '';
    const result = await putUploadChunk(
      principal.userId,
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
