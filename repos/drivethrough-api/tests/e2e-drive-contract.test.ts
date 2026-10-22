// REAL Drive E2E contract test — the P0.2 exit gate (tech.md §12).
// Skipped unless E2E_DRIVE=1 (npm run test:e2e). Talks to REAL Google Drive + REAL Neon
// by calling the actual route handlers in-process (no HTTP server, no mocks anywhere).
//
// Auth: the smoke Firebase user signs in for real (identitytoolkit) → Bearer token.
// Drive account: the smoke user owns no Drive account, and every service is ownership-
// scoped, so the suite MIRRORS the production connected account under the smoke user
// (tokens re-encrypted under the new row id — vault AAD is the row id). The production
// user's row is never touched; provider_configs is global so token refresh works.
// Everything the suite creates is removed in afterAll (best-effort, Drive file first).
//
// Payload: ~9.4 MB of random bytes → 3 chunks (4 MB + 4 MB + remainder), non-aligned
// last chunk on purpose. The owner's Drive has ~138 MB free — stays true after cleanup.
//
// Covered contract (flow.md §4.2/§5.2, tech.md §4/§6):
//   init idempotency · reserve claim + double-click · CHUNK_OUT_OF_ORDER ·
//   CHUNK_RANGE_INVALID · chunk streaming + offsets · resume state with provider
//   308 cross-check · committed-chunk replay without re-forward · complete idempotency
//   via the unique index · reservation release · sha256-exact download · Range 206 ·
//   provider.listChildren reconciliation · soft(trash)/hard delete · post-write quota sync.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, and, isNotNull } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { GET as listAccounts } from '../src/app/api/accounts/route';
import { POST as postInit } from '../src/app/api/uploads/init/route';
import { POST as postReserve } from '../src/app/api/uploads/reserve/route';
import { PUT as putChunkRoute } from '../src/app/api/uploads/chunk/[id]/route';
import { GET as getState } from '../src/app/api/uploads/[id]/route';
import { POST as postComplete } from '../src/app/api/uploads/[id]/complete/route';
import { GET as getContent } from '../src/app/api/files/[id]/content/route';

import { getDb } from '../src/server/db/client';
import { accounts, storageUsage, users, files, uploads, uploadChunks, reservations } from '../src/server/db/schema';
import { decryptSecret, encryptSecret } from '../src/server/crypto/vault';
import { googleDriveProvider } from '../src/server/providers/google-drive';
import { loadProviderAccount } from '../src/server/accounts/account-context';

const RUN = !!process.env.E2E_DRIVE;
const API_BASE = 'http://localhost/api';

// ---- fixtures (overridable so the suite survives the smoke user's deletion) ----
const SMOKE_EMAIL = process.env.E2E_EMAIL ?? 'dt-smoke-20261020@example.com';
const SMOKE_PASSWORD = process.env.E2E_PASSWORD ?? 'SmokeTest!2026xyz';

const SIZE = 9 * 1024 * 1024 + 12345; // 3 chunks: 4 MB, 4 MB, 1060921-byte tail
const CHUNK = 4 * 1024 * 1024;
const payload = randomBytes(SIZE);
const payloadSha = createHash('sha256').update(payload).digest('hex');

type Db = ReturnType<typeof getDb>;
let db: Db; // bound in beforeAll — module scope must not touch env (gate runs without DATABASE_URL)

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`${API_BASE}${url}`, init);
}
function authed(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return req(url, { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${bearer}` } });
}
function bearerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${bearer}` };
}
const uploadCtx = () => ({ params: Promise.resolve({ id: uploadId }) });
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function firebaseApiKey(): string {
  if (process.env.E2E_FIREBASE_API_KEY) return process.env.E2E_FIREBASE_API_KEY; // explicit override wins
  const appEnv = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../drivethrough-app/.env'
  );
  const m = /^NEXT_PUBLIC_FIREBASE_API_KEY=(.+)$/m.exec(readFileSync(appEnv, 'utf8'));
  if (!m?.[1]) throw new Error(`NEXT_PUBLIC_FIREBASE_API_KEY not found in ${appEnv}`);
  return m[1].trim();
}

let bearer = '';
let firebaseUid = '';
let userId = '';
let shadowAccountId = '';
let uploadId = '';
let fileId = '';
let providerFileId = '';
let syncedAtBeforeComplete = 0; // quota-test baseline captured BEFORE the sync gets enqueued

describe.runIf(RUN)('Drive E2E contract (real Drive + real Neon)', () => {
  beforeAll(async () => {
    db = getDb();

    // 1) real Firebase sign-in → ID token (verified later by the real JWKS path)
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
      throw new Error(
        `smoke sign-in failed: ${data.error?.message ?? 'no idToken'} (check E2E_EMAIL/E2E_PASSWORD/E2E_FIREBASE_API_KEY)`
      );
    }
    bearer = data.idToken;
    firebaseUid = data.localId;

    // 2) first API call upserts the users row (requireDbUser)
    const accRes = await listAccounts(authed('/accounts'));
    expect(accRes.status).toBe(200);

    const [userRow] = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid)).limit(1);
    expect(userRow).toBeDefined();
    userId = userRow!.id;

    // 3) mirror the production Drive account under the smoke user (test fixture — production
    //    row untouched; tokens re-encrypted because the vault AAD is the row id)
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

    shadowAccountId = randomUUID();
    await db.insert(accounts).values({
      id: shadowAccountId,
      userId,
      provider: 'google_drive',
      label: real!.label, // unique per (user, provider, label) — different user ⇒ no clash
      providerAccountId: real!.providerAccountId, // Google permissionId (identity key)
      rootFolderId: real!.rootFolderId,
      accessTokenEnc: encryptSecret(decryptSecret(real!.accessTokenEnc!, real!.id), shadowAccountId),
      refreshTokenEnc: encryptSecret(decryptSecret(real!.refreshTokenEnc!, real!.id), shadowAccountId),
      tokenExpiresAt: real!.tokenExpiresAt,
      status: 'connected',
    });
    const [realUsage] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, real!.id)).limit(1);
    await db.insert(storageUsage).values({
      accountId: shadowAccountId,
      totalBytes: realUsage?.totalBytes ?? null,
      usedBytes: realUsage?.usedBytes ?? 0n,
      availableBytes: realUsage?.availableBytes ?? null,
      reservedBytes: 0n,
      syncedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    // Drive side FIRST (needs the shadow account), then DB — all best-effort.
    try {
      if (providerFileId && shadowAccountId) {
        const { ctx } = await loadProviderAccount(userId, shadowAccountId);
        await googleDriveProvider.delete(ctx, providerFileId, false);
      }
    } catch (e) {
      console.warn('[e2e-cleanup] Drive delete:', e instanceof Error ? e.message : e);
    }
    try {
      if (fileId) await db.delete(files).where(eq(files.id, fileId));
      if (uploadId) {
        await db.delete(uploadChunks).where(eq(uploadChunks.uploadId, uploadId));
        await db.delete(reservations).where(eq(reservations.uploadId, uploadId));
        await db.delete(uploads).where(eq(uploads.id, uploadId));
      }
      if (shadowAccountId) {
        await db.delete(storageUsage).where(eq(storageUsage.accountId, shadowAccountId));
        await db.delete(accounts).where(eq(accounts.id, shadowAccountId));
      }
    } catch (e) {
      console.warn('[e2e-cleanup] DB delete:', e instanceof Error ? e.message : e);
    }
  }, 60_000);

  it(
    'init: creates a session and is idempotent by clientUploadId',
    async () => {
      const body = {
        clientUploadId: randomUUID(),
        fileName: 'e2e-contract.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: String(SIZE),
      };
      const first = await json(await postInit(authed('/uploads/init', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })));
      expect(first.uploadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.chunkSize).toBe(CHUNK);
      expect(first.totalChunks).toBe(3);
      expect(first.receivedChunks).toEqual([]);
      expect(first.status).toBe('initiated');

      const second = await json(await postInit(authed('/uploads/init', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })));
      expect(second.uploadId).toBe(first.uploadId); // no forked session (G4)

      uploadId = first.uploadId as string; // bound BEFORE the clash probe — a failing probe must not abort the flow

      // a different file under the same key is rejected (VALIDATION_FAILED → 400)
      const clash = await postInit(
        authed('/uploads/init', {
          method: 'POST',
          body: JSON.stringify({ ...body, fileName: 'other.bin' }),
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(clash.status).toBe(400);
    },
    60_000
  );

  it(
    'reserve: claims bytes exactly once and is double-click safe',
    async () => {
      const [usage0] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, shadowAccountId)).limit(1);
      const before = usage0!.reservedBytes;

      const first = await json(await postReserve(authed('/uploads/reserve', { method: 'POST', body: JSON.stringify({ uploadId }), headers: { 'Content-Type': 'application/json' } })));
      expect(first.mode).toBe('drive_proxy');
      expect(first.accountId).toBe(shadowAccountId); // only account in the pool ⇒ placement picks it

      const [usage1] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, shadowAccountId)).limit(1);
      expect(usage1!.reservedBytes).toBe(before + BigInt(SIZE)); // G2/G3 claim

      const second = await json(await postReserve(authed('/uploads/reserve', { method: 'POST', body: JSON.stringify({ uploadId }), headers: { 'Content-Type': 'application/json' } })));
      expect(second.accountId).toBe(first.accountId);
      const [usage2] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, shadowAccountId)).limit(1);
      expect(usage2!.reservedBytes).toBe(usage1!.reservedBytes); // no double claim (G4)
    },
    120_000
  );

  it(
    'chunk validation: out-of-order and malformed ranges are rejected without failing the session',
    async () => {
      const cr = (s: number, e: number) => ({ 'Content-Range': `bytes ${s}-${e}/${SIZE}` });

      // valid shape, wrong order (expected 0) — last-chunk range so the SHAPE passes and
      // ordering is what rejects (end beyond total would trip CHUNK_RANGE_INVALID first)
      const ooo = await putChunkRoute(
        new NextRequest(`${API_BASE}/uploads/chunk/${uploadId}?index=2`, {
          method: 'PUT',
          headers: { ...bearerHeaders(), ...cr(2 * CHUNK, SIZE - 1) },
          body: payload.subarray(2 * CHUNK, SIZE),
        }),
        { params: Promise.resolve({ id: uploadId }) }
      );
      expect(ooo.status).toBe(409);
      expect((await json(ooo)).code).toBe('CHUNK_OUT_OF_ORDER');

      // malformed: start is not index*chunkSize (checked BEFORE ordering)
      const bad = await putChunkRoute(
        new NextRequest(`${API_BASE}/uploads/chunk/${uploadId}?index=1`, {
          method: 'PUT',
          headers: { ...bearerHeaders(), ...cr(0, 100) },
          body: payload.subarray(0, 101),
        }),
        { params: Promise.resolve({ id: uploadId }) }
      );
      expect(bad.status).toBe(422);
      expect((await json(bad)).code).toBe('CHUNK_RANGE_INVALID');

      // session survived both
      const state = await json(await getState(authed(`/uploads/${uploadId}`), uploadCtx()));
      expect(state.status).toBe('uploading');
      expect(state.committedOffset).toBe('0');
    },
    60_000
  );

  it(
    'uploads 3 chunks sequentially with server-authoritative offsets + provider cross-check',
    async () => {
      const put = async (i: number, start: number, end: number) =>
        putChunkRoute(
          new NextRequest(`${API_BASE}/uploads/chunk/${uploadId}?index=${i}`, {
            method: 'PUT',
            headers: { ...bearerHeaders(), 'Content-Range': `bytes ${start}-${end}/${SIZE}` },
            body: payload.subarray(start, end + 1),
          }),
          { params: Promise.resolve({ id: uploadId }) }
        );

      const c0 = await put(0, 0, CHUNK - 1);
      expect(c0.status).toBe(200);
      expect(await json(c0)).toEqual({ committedOffset: String(CHUNK), index: 0 });

      // mid-state: the resume cross-check queries Drive's 308 and agrees with the ledger
      const mid = await json(await getState(authed(`/uploads/${uploadId}`), uploadCtx()));
      expect(mid.status).toBe('uploading');
      expect(mid.committedOffset).toBe(String(CHUNK));
      expect(mid.receivedChunks).toEqual([0]);

      // idempotent replay of a committed chunk — acknowledged without re-forwarding (G4)
      const replay = await put(0, 0, CHUNK - 1);
      expect(replay.status).toBe(200);
      expect((await json(replay)).committedOffset).toBe(String(CHUNK));

      const c1 = await put(1, CHUNK, 2 * CHUNK - 1);
      expect(c1.status).toBe(200);
      expect(await json(c1)).toEqual({ committedOffset: String(2 * CHUNK), index: 1 });

      const c2 = await put(2, 2 * CHUNK, SIZE - 1); // non-aligned tail
      expect(c2.status).toBe(200);
      expect(await json(c2)).toEqual({ committedOffset: String(SIZE), index: 2 });

      // Drive captured the created file id on the final chunk's 200 (server-only column)
      const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
      providerFileId = row!.providerFileId ?? '';
      expect(providerFileId).not.toBe('');
    },
    300_000
  );

  it(
    'complete: verifies physical bytes, frees the reservation, and is idempotent',
    async () => {
      const [usage0] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, shadowAccountId)).limit(1);
      const before = usage0!.reservedBytes;
      syncedAtBeforeComplete = usage0!.syncedAt?.getTime() ?? 0; // baseline BEFORE enqueue

      const done = await json(await postComplete(authed(`/uploads/${uploadId}/complete`, { method: 'POST' }), uploadCtx()));
      expect(done.fileId).toMatch(/^[0-9a-f-]{36}$/);
      expect(done.providerFileId).toBe(providerFileId);
      expect(done.sizeBytes).toBe(String(SIZE));
      fileId = done.fileId as string;

      // reservation released exactly when the file became real (G9)
      const [usage1] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, shadowAccountId)).limit(1);
      expect(usage1!.reservedBytes).toBe(before - BigInt(SIZE));

      // double-click complete → same file (unique index arbitrates, G4)
      const again = await json(await postComplete(authed(`/uploads/${uploadId}/complete`, { method: 'POST' }), uploadCtx()));
      expect(again.fileId).toBe(done.fileId);

      const state = await json(await getState(authed(`/uploads/${uploadId}`), uploadCtx()));
      expect(state.status).toBe('completed');

      // the file row exists and belongs to the caller
      const [f] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
      expect(f!.userId).toBe(userId);
      expect(f!.sizeBytes).toBe(BigInt(SIZE));
    },
    120_000
  );

  it(
    'download: sha256-exact full read and byte-exact 206 Range window',
    async () => {
      const full = await getContent(authed(`/files/${fileId}/content`), { params: Promise.resolve({ id: fileId }) });
      expect(full.status).toBe(200);
      const bytes = new Uint8Array(await full.arrayBuffer());
      expect(bytes.byteLength).toBe(SIZE);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(payloadSha); // byte-for-byte
      expect(full.headers.get('cache-control')).toBe('private, no-store');

      const win = await getContent(
        new NextRequest(`${API_BASE}/files/${fileId}/content`, { headers: { ...bearerHeaders(), Range: 'bytes=0-99' } }),
        { params: Promise.resolve({ id: fileId }) }
      );
      expect(win.status).toBe(206);
      const head = new Uint8Array(await win.arrayBuffer());
      expect(head.byteLength).toBe(100);
      expect(Buffer.from(head)).toEqual(payload.subarray(0, 100)); // Buffer vs Buffer (prototype-safe)
      expect(win.headers.get('content-range')).toBe(`bytes 0-99/${SIZE}`);

      // nonexistent file id → honest 404, no leak
      const missingId = randomUUID();
      const missing = await getContent(
        authed(`/files/${missingId}/content`),
        { params: Promise.resolve({ id: missingId }) }
      );
      expect(missing.status).toBe(404);
    },
    300_000
  );

  it(
    'provider primitives: listChildren sees the file, soft-delete trashes it, hard-delete removes it',
    async () => {
      const { account, ctx } = await loadProviderAccount(userId, shadowAccountId);
      const ids: string[] = [];
      for await (const obj of googleDriveProvider.listChildren(ctx, account.rootFolderId!)) {
        ids.push(obj.id);
      }
      expect(ids).toContain(providerFileId); // reconciliation primitive sees our upload

      await googleDriveProvider.delete(ctx, providerFileId, true); // soft → Google-side trash
      const afterTrash: string[] = [];
      for await (const obj of googleDriveProvider.listChildren(ctx, account.rootFolderId!)) {
        afterTrash.push(obj.id);
      }
      expect(afterTrash).not.toContain(providerFileId); // trashed files leave the listing

      await googleDriveProvider.delete(ctx, providerFileId, false); // hard → gone
      const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${providerFileId}?fields=id`, {
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
      });
      expect(meta.status).toBe(404); // physically gone from Drive
    },
    120_000
  );

  it(
    'quota sync ran after the write (never inline — enqueued post-response)',
    async () => {
      // baseline was captured in the complete test BEFORE the enqueue; poll for the
      // background sync (after() in prod, fire-and-forget fallback here) to advance it
      let advanced = false;
      for (let i = 0; i < 20 && !advanced; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const [now] = await db.select().from(storageUsage).where(eq(storageUsage.accountId, shadowAccountId)).limit(1);
        advanced = (now!.syncedAt?.getTime() ?? 0) > syncedAtBeforeComplete;
      }
      expect(advanced, 'background quota sync never updated storage_usage').toBe(true);
    },
    60_000
  );
});
