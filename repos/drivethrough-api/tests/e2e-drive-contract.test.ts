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
// P0.4: preview-token mint → unauthenticated Range stream · share create/revoke
//   (public reader dies 404 within seconds — the "revoke test" exit gate) ·
//   API key shown once → /api/v1 upload → revoke 401 · auth-endpoint rate limit.

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
// P0.3 — folders/files CRUD, batch, trash, search, activity, storage summary
import { GET as listFoldersRoute, POST as postFolder } from '../src/app/api/folders/route';
import { PATCH as patchFolder, DELETE as deleteFolderRoute } from '../src/app/api/folders/[id]/route';
import { GET as listFilesRoute } from '../src/app/api/files/route';
import { GET as getFileRoute, PATCH as patchFile, DELETE as deleteFileRoute } from '../src/app/api/files/[id]/route';
import { POST as postBatch } from '../src/app/api/files/batch/route';
import { GET as getActivity } from '../src/app/api/activity/route';
import { GET as getSummaryRoute } from '../src/app/api/storage/summary/route';
// P0.4 — shares, preview tokens, API keys, external /api/v1 uploads, rate limits
import { GET as getShareStateRoute, POST as postShare, DELETE as deleteShareRoute } from '../src/app/api/files/[id]/share/route';
import { POST as postPreviewToken } from '../src/app/api/files/[id]/preview-token/route';
import { GET as getPublicShareRoute } from '../src/app/api/shares/[token]/route';
import { GET as getPublicPreviewRoute } from '../src/app/api/preview/[token]/route';
import { GET as listKeysRoute, POST as postKeyRoute } from '../src/app/api/keys/route';
import { DELETE as deleteKeyRoute } from '../src/app/api/keys/[id]/route';
import { POST as v1PostUploads } from '../src/app/api/v1/uploads/route';
import { GET as v1GetUpload } from '../src/app/api/v1/uploads/[id]/route';
import { PUT as v1PutChunk } from '../src/app/api/v1/uploads/[id]/chunk/route';
import { POST as v1PostComplete } from '../src/app/api/v1/uploads/[id]/complete/route';
import { GET as googleStartRoute } from '../src/app/api/accounts/google/start/route';

import { getDb } from '../src/server/db/client';
import { accounts, storageUsage, users, files, folders, uploads, uploadChunks, reservations, auditLogs, shares, previewTokens, apiKeys, rateLimits } from '../src/server/db/schema';
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
    // Drive side FIRST (needs the shadow account's token), then DB — all best-effort.
    // Sweep is generalized: the P0.3 tests upload extra files under the shadow root,
    // and a mid-suite failure must not leave bytes in the owner's Drive.
    try {
      if (shadowAccountId && userId) {
        const { account, ctx } = await loadProviderAccount(userId, shadowAccountId);
        const leftovers: string[] = [];
        for await (const obj of googleDriveProvider.listChildren(ctx, account.rootFolderId!)) leftovers.push(obj.id);
        for (const id of leftovers) await googleDriveProvider.delete(ctx, id, false);
      }
    } catch (e) {
      console.warn('[e2e-cleanup] Drive sweep:', e instanceof Error ? e.message : e);
    }
    try {
      if (userId) {
        const ups = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.userId, userId));
        for (const u of ups) {
          await db.delete(uploadChunks).where(eq(uploadChunks.uploadId, u.id));
          await db.delete(reservations).where(eq(reservations.uploadId, u.id));
        }
        await db.delete(uploads).where(eq(uploads.userId, userId));
        await db.delete(files).where(eq(files.userId, userId));
        await db.delete(folders).where(eq(folders.userId, userId));
        await db.delete(auditLogs).where(eq(auditLogs.userId, userId)); // keep Neon tidy
        // api_keys hang off the (persisted) user row — no cascade path, sweep explicitly.
        // shares/preview_tokens cascade away with the files rows above (FK onDelete cascade).
        await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
      }
      if (shadowAccountId) {
        await db.delete(storageUsage).where(eq(storageUsage.accountId, shadowAccountId));
        await db.delete(accounts).where(eq(accounts.id, shadowAccountId));
      }
      // rate-limit buckets this suite created in-process (clientIp = 'unknown' locally)
      for (const b of ['unknown', 'pv:unknown', 'shm:unknown', 'auth:unknown']) {
        await db.delete(rateLimits).where(eq(rateLimits.bucket, b));
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

  // ─────────────────────────────────────────────────────────────────────────
  // P0.3 — Core UX contract (tech.md §12). Folders/files CRUD over the REAL
  // Drive account, the "flaky mobile upload" resume gate, trash cascade +
  // restore, permanent purge, search, activity, storage summary.
  // Folders are virtual (metadata-only) — only file bytes touch Drive.
  // ─────────────────────────────────────────────────────────────────────────

  const fctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const jsonBody = (obj: unknown) => ({ method: 'POST', headers: { ...bearerHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  const patchBody = (obj: unknown) => ({ method: 'PATCH', headers: { ...bearerHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  let p3Root = '';
  let p3Child = '';
  let p3FileId = '';
  let p3ProviderFileId = '';
  const P3_SIZE = CHUNK + 777; // 2 chunks: 4 MB + non-aligned tail
  const p3Name = `flaky-mobile-${Date.now()}.bin`;
  const p3Payload = randomBytes(P3_SIZE);

  it(
    'p0.3 folders: create, list subtree, rename, sibling-name conflict, cycle guard',
    async () => {
      const rootName = `e2e-root-${Date.now()}`;
      const rootRes = await postFolder(authed('/folders', jsonBody({ name: rootName })));
      expect(rootRes.status).toBe(201);
      p3Root = ((await json(rootRes)).folder as { id: string }).id;

      const childRes = await postFolder(authed('/folders', jsonBody({ name: 'child', parentId: p3Root })));
      expect(childRes.status).toBe(201);
      p3Child = ((await json(childRes)).folder as { id: string }).id;

      // same name twice in one parent → 409 (folders are unique per sibling set)
      const dupe = await postFolder(authed('/folders', jsonBody({ name: rootName })));
      expect(dupe.status).toBe(409);
      expect((await json(dupe)).code).toBe('NAME_ALREADY_EXISTS');

      // rename
      const renamed = await patchFolder(authed(`/folders/${p3Child}`, patchBody({ name: 'child-renamed' })), fctx(p3Child));
      expect(renamed.status).toBe(200);
      expect(((await json(renamed)).folder as { name: string }).name).toBe('child-renamed');

      // moving a folder into itself / a descendant is a cycle → 422
      const intoSelf = await patchFolder(authed(`/folders/${p3Root}`, patchBody({ parentId: p3Root })), fctx(p3Root));
      expect(intoSelf.status).toBe(422);
      expect((await json(intoSelf)).code).toBe('FOLDER_CYCLE');
      const intoChild = await patchFolder(authed(`/folders/${p3Root}`, patchBody({ parentId: p3Child })), fctx(p3Root));
      expect(intoChild.status).toBe(422);

      // subtree listing
      const listed = await json(await listFoldersRoute(authed(`/folders?parentId=${p3Root}`))) as { folders: { id: string }[] };
      expect(listed.folders.map((f) => f.id)).toContain(p3Child);
    },
    60_000
  );

  it(
    'p0.3 flaky mobile upload: interrupted mid-file, resumes from the server offset, completes (THE P0.3 GATE)',
    async () => {
      const clientUploadId = randomUUID();
      const initBody = {
        clientUploadId,
        fileName: p3Name,
        mimeType: 'application/octet-stream',
        sizeBytes: String(P3_SIZE),
        folderId: p3Child,
      };
      const putChunk = (sid: string, i: number, start: number, end: number) =>
        putChunkRoute(
          new NextRequest(`${API_BASE}/uploads/chunk/${sid}?index=${i}`, {
            method: 'PUT',
            headers: { ...bearerHeaders(), 'Content-Range': `bytes ${start}-${end}/${P3_SIZE}` },
            body: p3Payload.subarray(start, end + 1),
          }),
          { params: Promise.resolve({ id: sid }) }
        );

      // session A: init → reserve → chunk 0 lands → the phone drops off the network
      const init1 = await json(await postInit(authed('/uploads/init', jsonBody(initBody))));
      const upA = init1.uploadId as string;
      expect((await postReserve(authed('/uploads/reserve', jsonBody({ uploadId: upA })))).status).toBe(200);
      expect((await putChunk(upA, 0, 0, CHUNK - 1)).status).toBe(200);
      // …tab dies here. Nothing is sent further. Session A is abandoned.

      // session B (fresh page load): same idempotency key → SAME server session + committed chunk 0
      const init2 = await json(await postInit(authed('/uploads/init', jsonBody(initBody))));
      expect(init2.uploadId).toBe(upA); // G4: never fork a second session
      expect(init2.receivedChunks).toEqual([0]); // the client learns exactly where to resume
      const upB = init2.uploadId as string;

      // re-reserve: idempotent, same placement
      const r2 = await json(await postReserve(authed('/uploads/reserve', jsonBody({ uploadId: upB }))));
      expect(r2.uploadId).toBe(upB);

      // a raced retry of chunk 0 is acknowledged WITHOUT re-forwarding to Drive (G4)
      const replay = await putChunk(upB, 0, 0, CHUNK - 1);
      expect(replay.status).toBe(200);
      expect((await json(replay)).committedOffset).toBe(String(CHUNK));

      // the remaining tail flows and the upload completes
      const c1 = await putChunk(upB, 1, CHUNK, P3_SIZE - 1);
      expect(c1.status).toBe(200);
      const done = await postComplete(authed(`/uploads/${upB}/complete`, { method: 'POST' }), fctx(upB));
      expect(done.status).toBe(200);
      const doneBody = await json(done);
      p3FileId = doneBody.fileId as string;
      expect(p3FileId).toMatch(/^[0-9a-f-]{36}$/);

      // remember the Drive-side id for the physical-gone check in the purge test
      const [upRow] = await db.select().from(uploads).where(eq(uploads.id, upB)).limit(1);
      p3ProviderFileId = upRow!.providerFileId ?? '';
      expect(p3ProviderFileId).not.toBe('');
    },
    300_000
  );

  it(
    'p0.3 browser: folder listing, global search, rename, batch move',
    async () => {
      // the resumed upload landed inside the (virtual) child folder
      const inChild = await json(await listFilesRoute(authed(`/files?folderId=${p3Child}`))) as { files: { id: string; folderId: string | null }[] };
      const mine = inChild.files.find((f) => f.id === p3FileId);
      expect(mine).toBeDefined();
      expect(mine!.folderId).toBe(p3Child);

      // global search ignores folders and finds by name fragment
      const search = await json(await listFilesRoute(authed(`/files?q=${encodeURIComponent('flaky-mobile')}`))) as { files: { id: string }[] };
      expect(search.files.map((f) => f.id)).toContain(p3FileId);

      // rename (duplicates allowed — Drive semantics)
      const newName = `renamed-${Date.now()}.bin`;
      const patched = await patchFile(authed(`/files/${p3FileId}`, patchBody({ name: newName })), fctx(p3FileId));
      expect(patched.status).toBe(200);
      expect(((await json(patched)).file as { name: string }).name).toBe(newName);
      const search2 = await json(await listFilesRoute(authed(`/files?q=${encodeURIComponent('renamed-')}`))) as { files: { id: string }[] };
      expect(search2.files.map((f) => f.id)).toContain(p3FileId);

      // batch move → the destination folder lists it
      const moved = await json(await postBatch(authed('/files/batch', jsonBody({ op: 'move', fileIds: [p3FileId], folderId: p3Root }))));
      expect((moved as { results: { ok: boolean }[] }).results.every((r) => r.ok)).toBe(true);
      const inRoot = await json(await listFilesRoute(authed(`/files?folderId=${p3Root}`))) as { files: { id: string }[] };
      expect(inRoot.files.map((f) => f.id)).toContain(p3FileId);
    },
    60_000
  );

  it(
    'p0.3 trash: folder cascade hides descendants; restore brings back exactly that cascade',
    async () => {
      // put the file back under the child so the cascade reaches it
      expect((await patchFile(authed(`/files/${p3FileId}`, patchBody({ folderId: p3Child })), fctx(p3FileId))).status).toBe(200);

      // trash the ROOT → child folder + file go with it (one marker, one txn)
      expect((await patchFolder(authed(`/folders/${p3Root}`, patchBody({ trashed: true })), fctx(p3Root))).status).toBe(200);

      const activeInChild = await json(await listFilesRoute(authed(`/files?folderId=${p3Child}`))) as { files: unknown[] };
      expect(activeInChild.files).toHaveLength(0); // nothing active remains in the subtree
      const trashedFiles = await json(await listFilesRoute(authed('/files?trashed=true'))) as { files: { id: string; status: string }[] };
      const tf = trashedFiles.files.find((f) => f.id === p3FileId);
      expect(tf?.status).toBe('deleted');
      const trashedFolders = await json(await listFoldersRoute(authed('/folders?trashed=true'))) as { folders: { id: string }[] };
      const tIds = trashedFolders.folders.map((f) => f.id);
      expect(tIds).toContain(p3Root);
      expect(tIds).toContain(p3Child);

      // restore the root → the whole cascade (child + file) returns to life
      expect((await patchFolder(authed(`/folders/${p3Root}`, patchBody({ trashed: false })), fctx(p3Root))).status).toBe(200);
      const back = await json(await listFilesRoute(authed(`/files?folderId=${p3Child}`))) as { files: { id: string; status: string }[] };
      const bf = back.files.find((f) => f.id === p3FileId);
      expect(bf).toBeDefined();
      expect(bf!.status).toBe('active');
    },
    60_000
  );

  it(
    'p0.3 purge: permanent delete removes Drive bytes first; folder purge removes the subtree rows',
    async () => {
      // the real UI flow purges FROM the trash — mirror it (soft → forever)
      const soft = await deleteFileRoute(authed(`/files/${p3FileId}`, { method: 'DELETE', headers: bearerHeaders() }), fctx(p3FileId));
      expect(soft.status).toBe(200);
      const pRes = await deleteFileRoute(authed(`/files/${p3FileId}?permanent=1`, { method: 'DELETE', headers: bearerHeaders() }), fctx(p3FileId));
      expect(pRes.status).toBe(200);
      expect((await getFileRoute(authed(`/files/${p3FileId}`), fctx(p3FileId))).status).toBe(404); // row gone

      // physically gone from Drive (bytes before rows — the only pointer just got consumed)
      const { ctx } = await loadProviderAccount(userId, shadowAccountId);
      const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${p3ProviderFileId}?fields=id`, {
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
      });
      expect(meta.status).toBe(404);

      // purge the folder subtree: trash it first (the only legal path), then purge —
      // child + root rows both disappear
      const softF = await deleteFolderRoute(authed(`/folders/${p3Root}`, { method: 'DELETE', headers: bearerHeaders() }), fctx(p3Root));
      expect(softF.status).toBe(200);
      const fp = await json(await deleteFolderRoute(authed(`/folders/${p3Root}?permanent=1`, { method: 'DELETE', headers: bearerHeaders() }), fctx(p3Root)));
      expect((fp as { ok: boolean }).ok).toBe(true);
      expect((fp as { folders: number }).folders).toBe(2);
      const after = await json(await listFoldersRoute(authed(`/folders?parentId=root`))) as { folders: { id: string }[] };
      expect(after.folders.map((f) => f.id)).not.toContain(p3Root);
      p3Root = '';
      p3Child = '';
    },
    120_000
  );

  it(
    'p0.3 activity + storage summary: the audit trail recorded every action; the pool adds up',
    async () => {
      const act = await json(await getActivity(authed('/activity'))) as { events: { action: string }[] };
      const actions = act.events.map((e) => e.action);
      for (const expected of [
        'upload.complete',
        'folder.create',
        'folder.trash',
        'folder.restore',
        'folder.delete',
        'file.rename',
        'file.move',
        'file.delete',
      ]) {
        expect(actions, `audit trail should contain ${expected}`).toContain(expected);
      }

      const sum = await json(await getSummaryRoute(authed('/storage/summary'))) as { summary: { accountCount: number; usedBytes: string; reservedBytes: string } };
      expect(sum.summary.accountCount).toBeGreaterThanOrEqual(1);
      expect(sum.summary.usedBytes).toMatch(/^\d+$/);
      expect(sum.summary.reservedBytes).toMatch(/^\d+$/);
    },
    30_000
  );

  // ─────────────────────────────────────────────────────────────────────────
  // P0.4 — Sharing & API keys (tech.md §12). THE EXIT GATES ("revoke test"):
  //  1. a share link serves an UNAUTHENTICATED reader, then dies within seconds
  //     of revoke (404 — flow.md §10.5/§10.6, prd.md §216 ≤ 60 s);
  //  2. an API key uploads through /api/v1 and 401s the moment it's revoked;
  //  3. auth endpoints rate-limit per IP (10/min).
  // Fixture: a small fresh file — the P0.2 file's Drive bytes were hard-deleted
  // by the provider-primitives test above, so sharing it would 404 at stream time.
  // ─────────────────────────────────────────────────────────────────────────

  const tctx = (token: string) => ({ params: Promise.resolve({ token }) });
  const keyHeaders = (k: string) => ({ Authorization: `Bearer ${k}` });
  const P4_SIZE = 100_000;
  const p4Name = `share-fixture-${Date.now()}.bin`;
  const p4Payload = randomBytes(P4_SIZE);
  const p4Sha = createHash('sha256').update(p4Payload).digest('hex');
  let p4FileId = '';

  it(
    'p0.4 fixture: uploads a small file through the internal path',
    async () => {
      const init = await json(
        await postInit(
          authed('/uploads/init', jsonBody({
            clientUploadId: randomUUID(),
            fileName: p4Name,
            mimeType: 'application/octet-stream',
            sizeBytes: String(P4_SIZE),
          }))
        )
      );
      const sid = init.uploadId as string;
      expect((await postReserve(authed('/uploads/reserve', jsonBody({ uploadId: sid })))).status).toBe(200);
      const c0 = await putChunkRoute(
        new NextRequest(`${API_BASE}/uploads/chunk/${sid}?index=0`, {
          method: 'PUT',
          headers: { ...bearerHeaders(), 'Content-Range': `bytes 0-${P4_SIZE - 1}/${P4_SIZE}` },
          body: p4Payload,
        }),
        { params: Promise.resolve({ id: sid }) }
      );
      expect(c0.status).toBe(200);
      const done = await json(await postComplete(authed(`/uploads/${sid}/complete`, { method: 'POST' }), { params: Promise.resolve({ id: sid }) }));
      p4FileId = done.fileId as string;
      expect(p4FileId).toMatch(/^[0-9a-f-]{36}$/);
    },
    120_000
  );

  it(
    'p0.4 preview token: mint → unauthenticated Range stream with exact bytes → dead tokens 404',
    async () => {
      const mintRes = await postPreviewToken(authed(`/files/${p4FileId}/preview-token`, { method: 'POST' }), fctx(p4FileId));
      expect(mintRes.status).toBe(201);
      const minted = (await json(mintRes)) as { token: string; expiresAt: string };
      expect(minted.token.startsWith('dtp_')).toBe(true);
      const ttl = new Date(minted.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000); // design §3.3: 10-min TTL
      expect(ttl).toBeLessThan(11 * 60_000);

      // hashed at rest: the row holds a 64-hex digest, never the raw token
      const [row] = await db.select().from(previewTokens).where(eq(previewTokens.fileId, p4FileId)).limit(1);
      expect(row).toBeDefined();
      expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.tokenHash).not.toContain(minted.token);

      // NO Authorization below this line — the token in the URL is the capability
      const full = await getPublicPreviewRoute(new NextRequest(`${API_BASE}/preview/${minted.token}`), tctx(minted.token));
      expect(full.status).toBe(200);
      const bytes = new Uint8Array(await full.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(p4Sha);
      expect(full.headers.get('cache-control')).toBe('private, no-store');

      const win = await getPublicPreviewRoute(
        new NextRequest(`${API_BASE}/preview/${minted.token}`, { headers: { Range: 'bytes=0-99' } }),
        tctx(minted.token)
      );
      expect(win.status).toBe(206);
      expect(win.headers.get('content-range')).toBe(`bytes 0-99/${P4_SIZE}`);

      // ?download=1 → native download semantics (RFC 6266 attachment)
      const dl = await getPublicPreviewRoute(new NextRequest(`${API_BASE}/preview/${minted.token}?download=1`), tctx(minted.token));
      expect(dl.headers.get('content-disposition')).toContain('attachment;');
      expect(dl.headers.get('content-disposition')).toContain(p4Name);

      // unknown token → honest 404, no oracle on which table it almost belongs to
      const bogus = await getPublicPreviewRoute(new NextRequest(`${API_BASE}/preview/dtp_deadbeef`), tctx('dtp_deadbeef'));
      expect(bogus.status).toBe(404);
      expect((await json(bogus)).code).toBe('PREVIEW_TOKEN_INVALID');
    },
    120_000
  );

  it(
    'p0.4 share + revoke: public reader works unauthenticated, dies 404 within seconds (THE EXIT GATE)',
    async () => {
      // past expiry is refused up front (400 VALIDATION_FAILED, never a dead-on-arrival link)
      const past = await postShare(
        authed(`/files/${p4FileId}/share`, jsonBody({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
        fctx(p4FileId)
      );
      expect(past.status).toBe(400);
      expect((await json(past)).code).toBe('VALIDATION_FAILED');

      // idempotent create keyed on a client UUID (G6): first insert 201 + raw token,
      // replay 200 + token null (the raw value is unrecoverable — hashed at rest)
      const clientId = randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const firstRes = await postShare(authed(`/files/${p4FileId}/share`, jsonBody({ id: clientId, expiresAt })), fctx(p4FileId));
      expect(firstRes.status).toBe(201);
      const first = (await json(firstRes)) as { share: { id: string; token: string | null; role: string; expiresAt: string | null } };
      expect(first.share.token).toMatch(/^dsh_/);
      expect(first.share.role).toBe('viewer'); // L6 fix: the enum physically has no writer
      expect(first.share.expiresAt).toBe(expiresAt);
      const shareToken = first.share.token!;

      const replayRes = await postShare(authed(`/files/${p4FileId}/share`, jsonBody({ id: clientId, expiresAt })), fctx(p4FileId));
      expect(replayRes.status).toBe(200);
      const replay = (await json(replayRes)) as { share: { id: string; token: string | null } };
      expect(replay.share.id).toBe(first.share.id); // same row — no forked link
      expect(replay.share.token).toBeNull();

      // live-link state for the dialog: one link, no token material
      const state = (await json(await getShareStateRoute(authed(`/files/${p4FileId}/share`), fctx(p4FileId)))) as {
        shares: { id: string; expiresAt: string | null }[];
      };
      expect(state.shares).toHaveLength(1);
      expect(state.shares[0]!.id).toBe(first.share.id);
      expect(state.shares[0]!.expiresAt).toBe(expiresAt);

      // PUBLIC reader (no auth anywhere): metadata is minimal + uncacheable
      const meta = await getPublicShareRoute(new NextRequest(`${API_BASE}/shares/${shareToken}`), tctx(shareToken));
      expect(meta.status).toBe(200);
      const view = (await json(meta)) as { share: { name: string; sizeBytes: string; mimeType: string; role: string } };
      expect(view.share.name).toBe(p4Name);
      expect(view.share.sizeBytes).toBe(String(P4_SIZE));
      expect(view.share.role).toBe('viewer');
      expect(meta.headers.get('cache-control') ?? '').toContain('no-store');

      // …and the same token streams the real bytes through the shared read path
      const pub = await getPublicPreviewRoute(new NextRequest(`${API_BASE}/preview/${shareToken}`), tctx(shareToken));
      expect(pub.status).toBe(200);
      expect(createHash('sha256').update(new Uint8Array(await pub.arrayBuffer())).digest('hex')).toBe(p4Sha);

      // REVOKE — the public side 404s on the very next request (≤ 60 s, prd §216)
      const rev = (await json(
        await deleteShareRoute(authed(`/files/${p4FileId}/share`, { method: 'DELETE', headers: bearerHeaders() }), fctx(p4FileId))
      )) as { revoked: number };
      expect(rev.revoked).toBe(1);
      const afterMeta = await getPublicShareRoute(new NextRequest(`${API_BASE}/shares/${shareToken}`), tctx(shareToken));
      expect(afterMeta.status).toBe(404);
      expect((await json(afterMeta)).code).toBe('SHARE_NOT_FOUND');
      const afterPub = await getPublicPreviewRoute(new NextRequest(`${API_BASE}/preview/${shareToken}`), tctx(shareToken));
      expect(afterPub.status).toBe(404); // content dies with metadata — no zombie stream

      // second revoke is idempotent: honest 0, no error
      const rev2 = (await json(
        await deleteShareRoute(authed(`/files/${p4FileId}/share`, { method: 'DELETE', headers: bearerHeaders() }), fctx(p4FileId))
      )) as { revoked: number };
      expect(rev2.revoked).toBe(0);

      // a TRASHED file's link looks dead too — and no existence leak either way
      const second = (await json(await postShare(authed(`/files/${p4FileId}/share`, jsonBody({})), fctx(p4FileId)))) as {
        share: { token: string | null };
      };
      expect(second.share.token).toMatch(/^dsh_/);
      expect((await patchFile(authed(`/files/${p4FileId}`, patchBody({ trashed: true })), fctx(p4FileId))).status).toBe(200);
      const hidden = await getPublicShareRoute(new NextRequest(`${API_BASE}/shares/${second.share.token}`), tctx(second.share.token!));
      expect(hidden.status).toBe(404);
      expect((await patchFile(authed(`/files/${p4FileId}`, patchBody({ trashed: false })), fctx(p4FileId))).status).toBe(200);
    },
    120_000
  );

  it(
    'p0.4 api keys + /api/v1: secret shown once → key upload lands in Drive → revoke 401s (THE EXIT GATE)',
    async () => {
      // create — the full secret appears in THIS response only
      const createRes = await postKeyRoute(authed('/keys', jsonBody({ name: `e2e-key-${Date.now()}` })));
      expect(createRes.status).toBe(201);
      const created = (await json(createRes)) as {
        key: { id: string; keyPrefix: string; key: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null };
      };
      const rawKey = created.key.key;
      expect(rawKey.startsWith('dtk_')).toBe(true);
      expect(created.key.keyPrefix).toHaveLength(12);
      expect(created.key.scopes).toContain('uploads:write');
      expect(created.key.revokedAt).toBeNull();

      // list: prefix only — the secret is never served again
      const list = (await json(await listKeysRoute(authed('/keys')))) as {
        keys: { id: string; key?: string; keyPrefix: string }[];
      };
      const mine = list.keys.find((k) => k.id === created.key.id);
      expect(mine).toBeDefined();
      expect(mine!.key).toBeUndefined();
      expect(mine!.keyPrefix).toBe(created.key.keyPrefix);

      // v1 refuses a SESSION bearer — the public contract is key-authenticated
      const sessionReject = await v1PostUploads(
        authed('/v1/uploads', jsonBody({ clientUploadId: randomUUID(), fileName: 'x.bin', mimeType: 'application/octet-stream', sizeBytes: '1' }))
      );
      expect(sessionReject.status).toBe(401);
      expect((await json(sessionReject)).code).toBe('UNAUTHENTICATED');

      // v1 create: init + placement in ONE key-authenticated call
      const V1_SIZE = 50_000;
      const v1Payload = randomBytes(V1_SIZE);
      const initRes = await v1PostUploads(
        new NextRequest(`${API_BASE}/v1/uploads`, {
          method: 'POST',
          headers: { ...keyHeaders(rawKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientUploadId: randomUUID(),
            fileName: `v1-${Date.now()}.bin`,
            mimeType: 'application/octet-stream',
            sizeBytes: String(V1_SIZE),
          }),
        })
      );
      expect(initRes.status).toBe(201);
      const v1init = (await json(initRes)) as { uploadId: string; chunkSize: number; totalChunks: number; status: string; accountId: string };
      expect(v1init.chunkSize).toBe(CHUNK);
      expect(v1init.totalChunks).toBe(1);
      expect(v1init.status).toBe('uploading'); // reserve folded into create
      expect(v1init.accountId).toBe(shadowAccountId); // only account in the pool

      // chunk: SAME no-buffer protocol (raw body + Content-Range), key auth
      const chunkRes = await v1PutChunk(
        new NextRequest(`${API_BASE}/v1/uploads/${v1init.uploadId}/chunk?index=0`, {
          method: 'PUT',
          headers: { ...keyHeaders(rawKey), 'Content-Range': `bytes 0-${V1_SIZE - 1}/${V1_SIZE}` },
          body: v1Payload,
        }),
        { params: Promise.resolve({ id: v1init.uploadId }) }
      );
      expect(chunkRes.status).toBe(200);
      expect((await json(chunkRes)).committedOffset).toBe(String(V1_SIZE));

      // resume state through the key
      const state = (await json(
        await v1GetUpload(new NextRequest(`${API_BASE}/v1/uploads/${v1init.uploadId}`, { headers: keyHeaders(rawKey) }), {
          params: Promise.resolve({ id: v1init.uploadId }),
        })
      )) as { committedOffset: string };
      expect(state.committedOffset).toBe(String(V1_SIZE));

      // complete → a real file, byte-exact through the app's own read path
      const done = (await json(
        await v1PostComplete(new NextRequest(`${API_BASE}/v1/uploads/${v1init.uploadId}/complete`, { method: 'POST', headers: keyHeaders(rawKey) }), {
          params: Promise.resolve({ id: v1init.uploadId }),
        })
      )) as { fileId: string; sizeBytes: string };
      expect(done.fileId).toMatch(/^[0-9a-f-]{36}$/);
      expect(done.sizeBytes).toBe(String(V1_SIZE));
      const dl = await getContent(authed(`/files/${done.fileId}/content`), { params: Promise.resolve({ id: done.fileId }) });
      expect(dl.status).toBe(200);
      expect(createHash('sha256').update(new Uint8Array(await dl.arrayBuffer())).digest('hex')).toBe(
        createHash('sha256').update(v1Payload).digest('hex')
      );

      // last-used recorded (flow §10.6: the key shows activity)
      const after = (await json(await listKeysRoute(authed('/keys')))) as { keys: { id: string; lastUsedAt: string | null }[] };
      expect(after.keys.find((k) => k.id === created.key.id)!.lastUsedAt).not.toBeNull();

      // REVOKE → the next v1 call with that key 401s immediately (TOKEN_REVOKED)
      const keyCtx = { params: Promise.resolve({ id: created.key.id }) };
      expect((await deleteKeyRoute(authed(`/keys/${created.key.id}`, { method: 'DELETE', headers: bearerHeaders() }), keyCtx)).status).toBe(200);
      const dead = await v1GetUpload(new NextRequest(`${API_BASE}/v1/uploads/${v1init.uploadId}`, { headers: keyHeaders(rawKey) }), {
        params: Promise.resolve({ id: v1init.uploadId }),
      });
      expect(dead.status).toBe(401);
      expect((await json(dead)).code).toBe('TOKEN_REVOKED');

      // double revoke stays idempotent
      expect((await deleteKeyRoute(authed(`/keys/${created.key.id}`, { method: 'DELETE', headers: bearerHeaders() }), keyCtx)).status).toBe(200);

      // audit: every P0.4 sensitive action landed in the trail (design §7)
      const act = (await json(await getActivity(authed('/activity')))) as { events: { action: string }[] };
      const actions = act.events.map((e) => e.action);
      for (const expected of ['key.create', 'key.revoke', 'share.create', 'share.revoke']) {
        expect(actions, `audit trail should contain ${expected}`).toContain(expected);
      }
    },
    300_000
  );

  it(
    'p0.4 rate limit: auth endpoints answer 429 after 10 hits/min per IP, before auth',
    async () => {
      // unauthenticated on purpose: the limiter sits BEFORE token verification (tech.md §4),
      // so abuse never burns JWKS lookups either — local runs share the `unknown` IP bucket,
      // which only makes an exhausted bucket MORE likely, never less (assertions tolerate both)
      let saw429 = false;
      let passes = 0;
      for (let i = 0; i < 11; i++) {
        const res = await googleStartRoute(new NextRequest(`${API_BASE}/accounts/google/start`));
        if (res.status === 429) {
          saw429 = true;
          expect((await json(res)).code).toBe('RATE_LIMITED');
        } else {
          passes += 1;
          expect(res.status).toBe(401); // auth still enforced inside the window
        }
      }
      expect(passes).toBeLessThanOrEqual(10);
      expect(saw429, '11th request in the same minute should be rate limited').toBe(true);
    },
    30_000
  );
});
