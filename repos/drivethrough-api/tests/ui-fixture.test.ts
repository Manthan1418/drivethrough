// P0.4 browser-sweep fixture — NOT part of the e2e gate (tech.md §9). The Playwright
// sweep runs in a SEPARATE process and needs a live Drive account + file under the smoke
// user to right-click → Share → preview → revoke, but the e2e suite mirrors and removes
// both every run. This file stands that fixture up, then tears it down on request:
//
//   setup  (leaves everything behind): UI_FIXTURE=1 npx vitest run tests/ui-fixture.test.ts
//   cleanup (removes account + bytes + rows): UI_FIXTURE=1 UI_FIXTURE_CLEANUP=1 npx vitest run …
//
// ALWAYS run cleanup after a sweep — the file lives in the owner's real Drive.
// The sweep script discovers the file purely by name in the DOM (no id hand-off).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNotNull } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { GET as listAccounts } from '../src/app/api/accounts/route';
import { POST as postInit } from '../src/app/api/uploads/init/route';
import { POST as postReserve } from '../src/app/api/uploads/reserve/route';
import { PUT as putChunkRoute } from '../src/app/api/uploads/chunk/[id]/route';
import { POST as postComplete } from '../src/app/api/uploads/[id]/complete/route';

import { getDb } from '../src/server/db/client';
import { accounts, storageUsage, users, files, folders, uploads, uploadChunks, reservations, auditLogs, shares, apiKeys, rateLimits } from '../src/server/db/schema';
import { decryptSecret, encryptSecret } from '../src/server/crypto/vault';
import { googleDriveProvider } from '../src/server/providers/google-drive';
import { loadProviderAccount } from '../src/server/accounts/account-context';

const RUN = !!process.env.UI_FIXTURE;
const CLEAN = !!process.env.UI_FIXTURE_CLEANUP;
const API_BASE = 'http://localhost/api';

const SMOKE_EMAIL = process.env.E2E_EMAIL ?? 'dt-smoke-20261020@example.com';
const SMOKE_PASSWORD = process.env.E2E_PASSWORD ?? 'SmokeTest!2026xyz';
const FIXTURE_NAME = `p04-sweep-${new Date().toISOString().slice(0, 10)}.txt`;
const FIXTURE_BODY = 'P0.4 browser-sweep fixture — preview/share target.\n';

let bearer = '';
let firebaseUid = '';
let userId = '';
let mirrorAccountId = '';
let fixtureFileId = '';

function firebaseApiKey(): string {
  if (process.env.E2E_FIREBASE_API_KEY) return process.env.E2E_FIREBASE_API_KEY;
  const appEnv = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../drivethrough-app/.env');
  const m = /^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$/m.exec(readFileSync(appEnv, 'utf8'));
  if (!m?.[1]) throw new Error(`NEXT_PUBLIC_FIREBASE_API_KEY not found in ${appEnv}`);
  return m[1].trim();
}

const authed = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest =>
  new NextRequest(`${API_BASE}${url}`, {
    ...init,
    headers: { ...((init?.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${bearer}` },
  });

describe.runIf(RUN || CLEAN)('P0.4 UI sweep fixture (mirrors prod Drive, keeps it until cleanup)', () => {
  beforeAll(async () => {
    // 1) real Firebase sign-in → bearer
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: SMOKE_EMAIL, password: SMOKE_PASSWORD, returnSecureToken: true }),
      }
    );
    const data = (await res.json()) as { idToken?: string; localId?: string; error?: { message?: string } };
    if (!res.ok || !data.idToken || !data.localId) {
      throw new Error(`smoke sign-in failed: ${data.error?.message ?? 'no idToken'}`);
    }
    bearer = data.idToken;
    firebaseUid = data.localId;

    // 2) any authed call upserts the users row (requireDbUser)
    const db = getDb();
    const accRes = await listAccounts(authed('/accounts'));
    expect(accRes.status).toBe(200);
    const [userRow] = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid)).limit(1);
    expect(userRow).toBeDefined();
    userId = userRow!.id;

    if (CLEAN) return; // cleanup mode: afterAll sweeps everything

    // 3) mirror the production Drive account under the smoke user (reused if a previous
    //    sweep already left one — tokens re-encrypted because the vault AAD is the row id)
    const [existing] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google_drive'), eq(accounts.status, 'connected')))
      .limit(1);
    if (existing) {
      mirrorAccountId = existing.id;
    } else {
      const [real] = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, 'google_drive'),
            eq(accounts.status, 'connected'),
            isNotNull(accounts.accessTokenEnc),
            isNotNull(accounts.refreshTokenEnc)
          )
        )
        .limit(1);
      expect(real, 'no connected Drive account in the DB — run the prod connect first').toBeDefined();

      mirrorAccountId = randomUUID();
      await db.insert(accounts).values({
        id: mirrorAccountId,
        userId,
        provider: 'google_drive',
        label: real!.label,
        providerAccountId: real!.providerAccountId,
        rootFolderId: real!.rootFolderId,
        accessTokenEnc: encryptSecret(decryptSecret(real!.accessTokenEnc!, real!.id), mirrorAccountId),
        refreshTokenEnc: encryptSecret(decryptSecret(real!.refreshTokenEnc!, real!.id), mirrorAccountId),
        tokenExpiresAt: real!.tokenExpiresAt,
        status: 'connected',
      });
      const [realUsage] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, real!.id)).limit(1);
      await db.insert(storageUsage).values({
        accountId: mirrorAccountId,
        totalBytes: realUsage?.totalBytes ?? null,
        usedBytes: realUsage?.usedBytes ?? 0n,
        availableBytes: realUsage?.availableBytes ?? null,
        reservedBytes: 0n,
        syncedAt: new Date(),
      });
    }

    // 4) upload the sweep target in-process (internal path — one tiny chunk)
    const body = Buffer.from(FIXTURE_BODY, 'utf8');
    const init = (await (await postInit(
      authed('/uploads/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientUploadId: randomUUID(),
          fileName: FIXTURE_NAME,
          mimeType: 'text/plain',
          sizeBytes: String(body.byteLength),
        }),
      })
    )).json()) as { uploadId?: string };
    expect(init.uploadId).toBeTruthy();
    const sid = init.uploadId!;
    expect((await postReserve(authed('/uploads/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: sid }),
    }))).status).toBe(200);
    const chunk = await putChunkRoute(
      new NextRequest(`${API_BASE}/uploads/chunk/${sid}?index=0`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Range': `bytes 0-${body.byteLength - 1}/${body.byteLength}` },
        body,
      }),
      { params: Promise.resolve({ id: sid }) }
    );
    expect(chunk.status).toBe(200);
    const done = (await (await postComplete(authed(`/uploads/${sid}/complete`, { method: 'POST' }), {
      params: Promise.resolve({ id: sid }),
    })).json()) as { fileId?: string };
    expect(done.fileId).toMatch(/^[0-9a-f-]{36}$/);
    fixtureFileId = done.fileId!;
  }, 180_000);

  it('sweep fixture', () => {
    if (CLEAN) {
      expect(userId).toMatch(/^[0-9a-f-]{36}$/);
      console.log(`[fixture] cleanup mode — sweeping smoke user ${userId}`);
      return;
    }
    expect(fixtureFileId).toMatch(/^[0-9a-f-]{36}$/);
    console.log(`[fixture] READY — file "${FIXTURE_NAME}" id=${fixtureFileId} account=${mirrorAccountId}`);
  }, 30_000);

  afterAll(async () => {
    if (!userId) return;
    if (!CLEAN) {
      console.log(`[fixture] KEPT (file "${FIXTURE_NAME}") — run with UI_FIXTURE_CLEANUP=1 after the sweep`);
      return;
    }
    const db = getDb();

    // Drive side FIRST (needs the mirrored account's token), then DB — all best-effort.
    try {
      const [mirror] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google_drive')))
        .limit(1);
      if (mirror?.rootFolderId) {
        const { account, ctx } = await loadProviderAccount(userId, mirror.id);
        const leftovers: string[] = [];
        for await (const obj of googleDriveProvider.listChildren(ctx, account.rootFolderId!)) leftovers.push(obj.id);
        for (const id of leftovers) await googleDriveProvider.delete(ctx, id, false);
      }
    } catch (err) {
      console.warn('[fixture] Drive sweep failed:', err instanceof Error ? err.message : err);
    }

    // DB rows: uploads first (FK), then capability rows; shares/preview_tokens cascade
    // with the files rows; api_keys hang off the persisted user row — sweep explicitly.
    await db.delete(uploads).where(eq(uploads.userId, userId));
    await db.delete(files).where(eq(files.userId, userId));
    await db.delete(folders).where(eq(folders.userId, userId));
    await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    const [mirrorRow] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google_drive')))
      .limit(1);
    if (mirrorRow) {
      await db.delete(storageUsage).where(eq(storageUsage.accountId, mirrorRow.id));
      await db.delete(accounts).where(eq(accounts.id, mirrorRow.id));
    }
    for (const b of [`ck:${userId}`, 'unknown', 'pv:unknown', 'shm:unknown', 'auth:unknown']) {
      await db.delete(rateLimits).where(eq(rateLimits.bucket, b));
    }
    console.log('[fixture] cleaned — account, Drive bytes, and per-user rows removed');
  }, 180_000);
});
