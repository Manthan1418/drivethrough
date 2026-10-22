// PATCH /api/folders/:id — rename, move, trash (trashed:true), restore (trashed:false).
// DELETE /api/folders/:id — soft trash (design.md §5.2: deletion is always trash-first).
//   ?permanent=1 — purge from trash: provider bytes first, then rows (never orphan bytes).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { purgeFolder, trashFolder, updateFolder } from '@/server/files/folder-service';
import { parseOr400 } from '@/server/validation';
import { UpdateFolderRequest } from '@drivethrough/contracts';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireDbUser(req);
    const { id } = await ctx.params;
    const input = parseOr400(UpdateFolderRequest, await req.json());
    const folder = await updateFolder(userId, id, input);
    return withCors(req, NextResponse.json({ folder }, { status: 200 }));
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
      const purged = await purgeFolder(userId, id);
      return withCors(req, NextResponse.json({ ok: true, ...purged }, { status: 200 }));
    }
    const folder = await trashFolder(userId, id);
    return withCors(req, NextResponse.json({ folder }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
