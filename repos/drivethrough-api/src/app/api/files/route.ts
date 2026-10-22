// GET /api/files — browser listing: a folder's files, global search (q), trash (trashed=true),
// recent (view=recent). Folder listing only (folders come from /api/folders in parallel).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { listFiles } from '@/server/files/file-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const p = req.nextUrl.searchParams;
    const res = await listFiles(userId, {
      folderId: p.get('folderId') === 'root' ? null : p.get('folderId'),
      q: p.get('q') ?? undefined,
      trashed: p.get('trashed') === 'true',
      recent: p.get('view') === 'recent',
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    });
    return withCors(req, NextResponse.json(res, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
