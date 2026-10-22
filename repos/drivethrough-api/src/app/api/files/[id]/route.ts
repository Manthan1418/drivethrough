// GET /api/files/:id — one file's metadata (any status — the trash view needs deleted rows).
// PATCH /api/files/:id — rename, move, trash (trashed:true), restore (trashed:false).
// DELETE /api/files/:id — soft trash; ?permanent=1 purges provider bytes first, then the row.

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { getFile, purgeFilePermanently, trashFile, updateFile } from '@/server/files/file-service';
import { parseOr400 } from '@/server/validation';
import { UpdateFileRequest } from '@drivethrough/contracts';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const file = await getFile(userId, id);
    return withCors(req, NextResponse.json({ file }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const input = parseOr400(UpdateFileRequest, await req.json());
    const file = await updateFile(userId, id, input);
    return withCors(req, NextResponse.json({ file }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    if (req.nextUrl.searchParams.get('permanent') === '1') {
      await purgeFilePermanently(userId, id);
      return withCors(req, NextResponse.json({ ok: true }, { status: 200 }));
    }
    const file = await trashFile(userId, id);
    return withCors(req, NextResponse.json({ file }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
