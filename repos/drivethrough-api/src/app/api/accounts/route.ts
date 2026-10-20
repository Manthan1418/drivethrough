// GET /api/accounts — list connected accounts + live usage (control plane, flow.md §9).

import { NextRequest, NextResponse } from 'next/server';
import { requireDbUser } from '@/server/auth/db-user';
import { listAccounts } from '@/server/accounts/connect-service';
import { handlePreflight, withCors } from '@/server/cors';
import { toApiError } from '@/server/errors';

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req) ?? NextResponse.json({}, { status: 405 });
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireDbUser(req);
    const rows = await listAccounts(userId);
    // sizes → strings (BigInt JSON safety, tech.md convention)
    const accounts = rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: r.label,
      status: r.status,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      lastError: r.lastError,
      usage: {
        totalBytes: r.totalBytes?.toString() ?? null,
        usedBytes: (r.usedBytes ?? 0n).toString(),
        availableBytes: r.availableBytes?.toString() ?? null,
        reservedBytes: (r.reservedBytes ?? 0n).toString(),
      },
    }));
    return withCors(req, NextResponse.json({ accounts }, { status: 200 }));
  } catch (err) {
    const { status, body } = toApiError(err);
    return withCors(req, NextResponse.json(body, { status }));
  }
}
