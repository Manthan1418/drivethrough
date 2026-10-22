// GET /api/folders — list folders (root of the virtual namespace, a subtree, search, or trash).
// POST /api/folders — create a folder (metadata-only, design.md §8).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { createFolder, listFolders } from '@/server/files/folder-service';
import { parseOr400 } from '@/server/validation';
import { CreateFolderRequest } from '@drivethrough/contracts';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const p = req.nextUrl.searchParams;
    const parentIdRaw = p.get('parentId');
    const res = await listFolders(userId, {
      // 'root'/absent ⇒ root level; explicit uuid ⇒ that subtree; trashed=true ⇒ flat trash
      parentId: !parentIdRaw || parentIdRaw === 'root' ? null : parentIdRaw,
      q: p.get('q') ?? undefined,
      trashed: p.get('trashed') === 'true',
    });
    return withCors(req, NextResponse.json(res, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const input = parseOr400(CreateFolderRequest, await req.json());
    const folder = await createFolder(userId, input);
    return withCors(req, NextResponse.json({ folder }, { status: 201 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
