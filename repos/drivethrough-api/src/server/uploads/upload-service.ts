// Upload use-cases — the critical path (flow.md §4, tech.md §4/§6).
// Route handlers stay thin: all SQL + provider calls live here. No `any` (AGENTS.md).
//
// Guarantees implemented (prd.md §5.4):
//  G1 atomicity      — placement txn (lock usage rows → pick → claim) before any byte flows;
//                      Drive session handshake happens OUTSIDE the txn with compensating
//                      release on failure (never hold bytes for a session that doesn't exist).
//  G2/G3 no overfill — storage_usage row locked FOR UPDATE + reserved_bytes claimed in one txn.
//  G4 idempotency    — init keyed on (user, clientUploadId); reserve double-click returns the
//                      same placement; committed chunks are acknowledged without re-forwarding;
//                      complete is arbitrated by the (accountId, providerFileId) unique index.
//  G5/G9 limbo-free  — every failure path releases the reservation (fail/abort/reserve-failure);
//                      provider cleanup is best-effort, GC (P0.5) sweeps whatever stays.
//  G6 resume         — committedOffset is cross-checked against Drive's 308 Range whenever the
//                      answer could disagree (provider wins — it owns the bytes).
//  byte accounting   — streamed bytes are counted in-flight and compared to Content-Range
//                      (UPLOAD_SIZE_MISMATCH), and Drive's final size is re-verified at complete.

import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { after } from 'next/server';
import { ErrorCodes } from '@drivethrough/contracts';
import type {
  ChunkCommitResponse,
  UploadAbortResponse,
  UploadCompleteResponse,
  UploadInitRequest,
  UploadInitResponse,
  UploadReserveResponse,
  UploadStateResponse,
} from '@drivethrough/contracts';
import { AppError } from '../errors';
import { getDb } from '../db/client';
import {
  accounts,
  folders,
  reservations,
  storageUsage,
  uploadChunks,
  uploads,
  files,
} from '../db/schema';
import { googleDriveProvider } from '../providers/google-drive';
import { loadProviderAccount } from '../accounts/account-context';
import { syncAccountQuota } from '../accounts/connect-service';
import { pickAccount, type AccountCapacity } from '../storage/placement';
import {
  committedOffsetFor,
  expectedNextIndex,
  maxUploadBytes,
  parseContentRange,
  planReconcile,
  resolveChunkSize,
  sanitizeMime,
  totalChunksFor,
  validateChunkShape,
  type ReconcilePlan,
} from './chunk-protocol';

/** Stale-claim window — GC hardening (cron) is P0.5; this is the reservation TTL. */
const RESERVATION_TTL_MS = 48 * 3600 * 1000;

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function loadOwnedUpload(userId: string, uploadId: string) {
  const db = getDb();
  const [u] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId)))
    .limit(1);
  if (!u) throw new AppError(ErrorCodes.UPLOAD_NOT_FOUND, 'Upload session not found');
  return u;
}

async function committedIndexes(db: Db, uploadId: string): Promise<number[]> {
  const rows = await db
    .select({ index: uploadChunks.index })
    .from(uploadChunks)
    .where(and(eq(uploadChunks.uploadId, uploadId), eq(uploadChunks.status, 'committed')))
    .orderBy(asc(uploadChunks.index));
  return rows.map((r) => r.index);
}

/** Release a placement claim and give the bytes back (atomic in SQL — used both inside
 *  transactions and as compensation). Deleting first makes it idempotent. */
async function releaseReservation(conn: Db | Tx, uploadId: string): Promise<void> {
  const deleted = await conn
    .delete(reservations)
    .where(eq(reservations.uploadId, uploadId))
    .returning({ bytes: reservations.bytes, accountId: reservations.accountId });
  const claim = deleted[0];
  if (!claim) return;
  await conn
    .update(storageUsage)
    .set({ reservedBytes: sql`GREATEST(${storageUsage.reservedBytes} - ${claim.bytes}, 0)` })
    .where(eq(storageUsage.accountId, claim.accountId));
}

/** Post-response quota refresh (flow.md §4.3 rule 5: NEVER inline in the upload response).
 *  In a real request scope Next's `after(CALLBACK)` runs it once the response is flushed (and
 *  Vercel keeps the invocation alive for it); outside one (unit/E2E calling handlers directly)
 *  `after` throws, and we fall back to a fire-and-forget promise. */
function enqueueQuotaSync(accountId: string): void {
  const run = () =>
    syncAccountQuota(accountId).catch((err: unknown) =>
      console.warn('[quota-sync] background sync failed:', err instanceof Error ? err.message : err)
    );
  try {
    after(run); // pass the callback — after() invokes it post-flush
  } catch {
    void run();
  }
}

// ---------------------------------------------------------------- init

export async function initUpload(userId: string, input: UploadInitRequest): Promise<UploadInitResponse> {
  const db = getDb();
  const size = BigInt(input.sizeBytes);
  const maxBytes = maxUploadBytes(process.env.MAX_UPLOAD_BYTES);
  if (size <= 0n) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'file must be at least 1 byte');
  if (size > maxBytes) {
    throw new AppError(ErrorCodes.FILE_TOO_LARGE_FOR_PLAN, `file exceeds this server's MAX_UPLOAD_BYTES (${maxBytes} bytes)`);
  }
  const mimeType = sanitizeMime(input.mimeType);
  if (input.folderId) {
    const [folder] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, input.folderId), eq(folders.userId, userId), isNull(folders.deletedAt)))
      .limit(1);
    if (!folder) throw new AppError(ErrorCodes.FOLDER_NOT_FOUND, 'Target folder not found');
  }

  const chunkSize = resolveChunkSize(process.env.CHUNK_SIZE);
  const totalChunks = totalChunksFor(size, chunkSize);

  // idempotency key: a double-click/retry must never fork a second session (G4)
  const [existing] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.userId, userId), eq(uploads.clientUploadId, input.clientUploadId)))
    .limit(1);
  if (existing) {
    if (existing.sizeBytes !== size || existing.fileName !== input.fileName) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'clientUploadId was already used for a different file');
    }
    return {
      uploadId: existing.id,
      chunkSize: existing.chunkSize,
      totalChunks: existing.totalChunks,
      receivedChunks: existing.status === 'aborted' || existing.status === 'failed' ? [] : await committedIndexes(db, existing.id),
      status: existing.status,
    };
  }

  const [row] = await db
    .insert(uploads)
    .values({
      userId,
      clientUploadId: input.clientUploadId,
      fileName: input.fileName,
      mimeType,
      sizeBytes: size,
      folderId: input.folderId ?? null,
      chunkSize,
      totalChunks,
      status: 'initiated',
    })
    .returning({ id: uploads.id, status: uploads.status, chunkSize: uploads.chunkSize, totalChunks: uploads.totalChunks });
  if (!row) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'insert produced no upload row');
  return { uploadId: row.id, chunkSize: row.chunkSize, totalChunks: row.totalChunks, receivedChunks: [], status: row.status };
}

// ---------------------------------------------------------------- reserve

/** Placement inside ONE transaction: load eligible accounts, lock their quota rows
 *  (FOR UPDATE — never on the nullable side of a join), pick, claim, commit (G1/G2/G3). */
async function placeReservation(userId: string, uploadId: string, sizeBytes: bigint): Promise<string> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const accts = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.provider, 'google_drive'),
          eq(accounts.status, 'connected')
        )
      );
    const ids = accts.map((a) => a.id);
    const usageRows = ids.length
      ? await tx.select().from(storageUsage).where(inArray(storageUsage.accountId, ids)).for('update')
      : [];
    const usageById = new Map(usageRows.map((r) => [r.accountId, r]));

    const caps: AccountCapacity[] = accts.map((a) => {
      const u = usageById.get(a.id);
      // connect always inserts the usage row; a miss is treated as "unknown free space"
      return {
        accountId: a.id,
        provider: a.provider,
        status: a.status,
        totalBytes: u?.totalBytes ?? null,
        usedBytes: u?.usedBytes ?? 0n,
        reservedBytes: u?.reservedBytes ?? 0n,
        availableBytes: u?.availableBytes ?? null,
      };
    });

    const picked = pickAccount({ policy: 'most_available', accounts: caps, requiredBytes: sizeBytes });
    await tx
      .insert(reservations)
      .values({ uploadId, userId, accountId: picked.accountId, bytes: sizeBytes, expiresAt: new Date(Date.now() + RESERVATION_TTL_MS) });
    await tx
      .update(storageUsage)
      .set({ reservedBytes: sql`${storageUsage.reservedBytes} + ${sizeBytes}` })
      .where(eq(storageUsage.accountId, picked.accountId));
    return picked.accountId;
  });
}

export async function reserveUpload(userId: string, uploadId: string): Promise<UploadReserveResponse> {
  const db = getDb();
  const u = await loadOwnedUpload(userId, uploadId);
  if (u.status === 'completed') {
    throw new AppError(ErrorCodes.UPLOAD_ALREADY_COMPLETED, 'Upload already completed');
  }
  if (u.status === 'aborted') {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Upload was aborted — start a new one');
  }
  // idempotent double-click: same open session → same answer, no second claim
  if (u.status === 'uploading' && u.accountId && u.providerSessionUri) {
    return { uploadId: u.id, mode: 'drive_proxy', accountId: u.accountId };
  }
  if (u.status === 'failed') {
    // flow.md §4.1: failed ─client retry→ initiated — drop the dead session, re-place fresh
    await db
      .update(uploads)
      .set({ status: 'initiated', error: null, accountId: null, providerSessionUri: null, providerFileId: null })
      .where(eq(uploads.id, u.id));
  }

  // (1) claim bytes first (a crash here leaves only a stale claim — reused or GC'd)
  let accountId = '';
  const [claim] = await db.select().from(reservations).where(eq(reservations.uploadId, u.id)).limit(1);
  if (claim) {
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, claim.accountId)).limit(1);
    if (acct && acct.status === 'connected' && acct.provider === 'google_drive') {
      accountId = acct.id; // reuse the interrupted attempt's claim
    } else {
      await releaseReservation(db, u.id); // claim on a dead account → drop it and re-place
    }
  }
  if (!accountId) accountId = await placeReservation(userId, u.id, u.sizeBytes);

  // (2) Drive resumable handshake — network happens OUTSIDE the txn; failure releases the
  // claim so bytes are never held for a session that doesn't exist (G1/G9)
  try {
    const { account, ctx } = await loadProviderAccount(userId, accountId);
    let rootId = account.rootFolderId;
    if (!rootId) {
      rootId = await googleDriveProvider.ensureRoot(ctx);
      await db.update(accounts).set({ rootFolderId: rootId }).where(eq(accounts.id, accountId));
    }
    const begin = await googleDriveProvider.beginUpload({
      ...ctx,
      uploadId: u.id,
      fileName: u.fileName,
      mimeType: u.mimeType,
      sizeBytes: u.sizeBytes,
      targetRootFolderId: rootId,
    });
    await db
      .update(uploads)
      .set({
        accountId,
        providerSessionUri: begin.sessionUri,
        targetRootFolderId: rootId,
        status: 'uploading',
        error: null,
      })
      .where(eq(uploads.id, u.id));
    return { uploadId: u.id, mode: 'drive_proxy', accountId };
  } catch (err) {
    await releaseReservation(db, u.id);
    throw err;
  }
}

// ---------------------------------------------------------------- chunk

/** Mark the session failed AND release its claim (flow.md §4.3 rule 4) — one txn.
 *  Best-effort provider cleanup first: an orphaned partial session/file must not linger
 *  unbilled-but-unreclaimable (P0.5 GC sweeps whatever cleanup can't reach). */
async function failUpload(
  userId: string,
  u: { id: string; accountId: string | null; providerSessionUri: string | null; providerFileId: string | null; sizeBytes: bigint; mimeType: string; fileName: string },
  message: string
): Promise<void> {
  if (u.accountId) {
    try {
      const { ctx } = await loadProviderAccount(userId, u.accountId);
      await googleDriveProvider.abortUpload({
        ...ctx,
        uploadId: u.id,
        fileName: u.fileName,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        sessionUri: u.providerSessionUri ?? undefined,
        providerFileId: u.providerFileId ?? undefined,
      });
    } catch (cleanupErr) {
      console.warn('[upload] provider cleanup on failure:', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }
  }
  await getDb().transaction(async (tx) => {
    await tx
      .update(uploads)
      .set({ status: 'failed', error: message.slice(0, 500) })
      .where(and(eq(uploads.id, u.id), inArray(uploads.status, ['initiated', 'uploading'])));
    await releaseReservation(tx, u.id);
  });
}

export async function putUploadChunk(
  userId: string,
  uploadId: string,
  indexRaw: string,
  rangeHeader: string | null,
  body: ReadableStream<Uint8Array>
): Promise<ChunkCommitResponse> {
  const db = getDb();
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'index must be a non-negative integer');
  }
  const u = await loadOwnedUpload(userId, uploadId);
  if (u.status === 'completed') {
    throw new AppError(ErrorCodes.UPLOAD_ALREADY_COMPLETED, 'Upload already completed');
  }
  if (u.status === 'aborted' || u.status === 'failed') {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, `Upload is ${u.status}`);
  }
  if (!u.providerSessionUri || !u.accountId) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Upload not reserved yet — call POST /api/uploads/reserve first');
  }

  const parsed = parseContentRange(rangeHeader); // CHUNK_RANGE_INVALID on garbage
  validateChunkShape({ index, chunkSize: u.chunkSize, totalChunks: u.totalChunks, sizeBytes: u.sizeBytes, ...parsed });

  // server-authoritative ordering: one Drive session advances one offset (sequential only)
  const [agg] = await db
    .select({ m: max(uploadChunks.index) })
    .from(uploadChunks)
    .where(and(eq(uploadChunks.uploadId, u.id), eq(uploadChunks.status, 'committed')));
  const expected = expectedNextIndex(agg?.m ?? null);

  if (index < expected) {
    // idempotent retry of a chunk we only marked committed AFTER Drive confirmed it
    // (flow.md §4.3 rule 2) → acknowledge without re-forwarding. Validation errors never
    // fail the session: the client just fixes the value and retries.
    return {
      committedOffset: committedOffsetFor(index + 1, u.chunkSize, u.sizeBytes).toString(),
      index,
    };
  }
  if (index > expected) {
    throw new AppError(ErrorCodes.CHUNK_OUT_OF_ORDER, `expected chunk ${expected}, got ${index}`);
  }

  const { ctx } = await loadProviderAccount(userId, u.accountId);
  let result: { committedOffset: bigint; providerFileId?: string };
  try {
    result = await googleDriveProvider.putChunk(
      {
        ...ctx,
        uploadId: u.id,
        fileName: u.fileName,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        sessionUri: u.providerSessionUri,
        targetRootFolderId: u.targetRootFolderId ?? undefined,
        providerFileId: u.providerFileId ?? undefined,
      },
      index,
      parsed,
      body // stream pass-through — this is the whole trick (never buffered, S2-validated)
    );
  } catch (err) {
    const unrecoverable =
      err instanceof AppError &&
      (err.code === ErrorCodes.PROVIDER_ERROR || err.code === ErrorCodes.UPLOAD_SIZE_MISMATCH);
    if (unrecoverable) await failUpload(userId, u, err.message); // unrecoverable → failed + release
    throw err;
  }

  // ledger write + captured file id in ONE txn: a crash between them would leave a fully
  // committed upload whose complete() can't verify the physical file (no recovery path).
  await db.transaction(async (tx) => {
    await tx
      .insert(uploadChunks)
      .values({
        uploadId: u.id,
        index,
        status: 'committed',
        sizeBytes: BigInt(parsed.end - parsed.start + 1),
        providerOffset: result.committedOffset,
      })
      .onConflictDoUpdate({
        target: [uploadChunks.uploadId, uploadChunks.index],
        set: {
          status: 'committed',
          sizeBytes: BigInt(parsed.end - parsed.start + 1),
          providerOffset: result.committedOffset,
          updatedAt: new Date(),
        },
      });
    if (result.providerFileId) {
      // final chunk: Drive created the file — remember its id for complete/abort (server-only)
      await tx.update(uploads).set({ providerFileId: result.providerFileId }).where(eq(uploads.id, u.id));
    }
  });
  return { committedOffset: result.committedOffset.toString(), index };
}

// ---------------------------------------------------------------- state (resume)

async function applyReconcile(uploadId: string, plan: ReconcilePlan, chunkSize: number, sizeBytes: bigint): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const i of plan.toCommit) {
      const start = i * chunkSize;
      const len = Math.min(chunkSize, Number(sizeBytes) - start);
      await tx
        .insert(uploadChunks)
        .values({ uploadId, index: i, status: 'committed', sizeBytes: BigInt(len) })
        .onConflictDoUpdate({
          target: [uploadChunks.uploadId, uploadChunks.index],
          set: { status: 'committed', sizeBytes: BigInt(len), updatedAt: new Date() },
        });
    }
    if (plan.toReset.length) {
      await tx
        .update(uploadChunks)
        .set({ status: 'pending', providerOffset: null, updatedAt: new Date() })
        .where(and(eq(uploadChunks.uploadId, uploadId), inArray(uploadChunks.index, plan.toReset)));
    }
  });
}

export async function getUploadState(userId: string, uploadId: string): Promise<UploadStateResponse> {
  const db = getDb();
  const u = await loadOwnedUpload(userId, uploadId);
  let idxs = await committedIndexes(db, u.id);
  let offset = committedOffsetFor(idxs.length, u.chunkSize, u.sizeBytes);

  // Provider cross-check whenever the answer could disagree (flow.md §4.2 resume note) —
  // Drive's 308 Range owns the truth; the ledger is corrected to match it (G6).
  if (u.status === 'uploading' && u.providerSessionUri && u.accountId && offset < u.sizeBytes) {
    try {
      const { ctx } = await loadProviderAccount(userId, u.accountId);
      const q = await googleDriveProvider.queryOffset({
        ...ctx,
        uploadId: u.id,
        fileName: u.fileName,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        sessionUri: u.providerSessionUri,
        targetRootFolderId: u.targetRootFolderId ?? undefined,
        providerFileId: u.providerFileId ?? undefined,
      });
      if (q === 'complete') {
        const plan = planReconcile(u.sizeBytes, u.chunkSize, u.sizeBytes, u.totalChunks);
        await applyReconcile(u.id, plan, u.chunkSize, u.sizeBytes);
        idxs = plan.toCommit;
        offset = u.sizeBytes;
      } else if (q !== 'unknown' && q !== offset) {
        const plan = planReconcile(q, u.chunkSize, u.sizeBytes, u.totalChunks);
        await applyReconcile(u.id, plan, u.chunkSize, u.sizeBytes);
        idxs = plan.toCommit;
        offset = plan.committedOffset;
      }
    } catch (err) {
      // reauth/config errors must surface (client action needed); a mere provider hiccup on a
      // resume check falls back to the honest DB view instead of failing the GET
      if (err instanceof AppError && (err.code === ErrorCodes.ACCOUNT_NEEDS_REAUTH || err.code === ErrorCodes.SERVICE_NOT_CONFIGURED)) {
        throw err;
      }
      console.warn('[upload-state] provider offset check failed, answering from DB:', err instanceof Error ? err.message : err);
    }
  }

  return {
    uploadId: u.id,
    status: u.status,
    committedOffset: offset.toString(),
    receivedChunks: idxs,
    error: u.error,
  };
}

// ---------------------------------------------------------------- complete

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505';
}

async function existingFileFor(accountId: string, providerFileId: string) {
  const db = getDb();
  const [f] = await db
    .select({ id: files.id, sizeBytes: files.sizeBytes })
    .from(files)
    .where(and(eq(files.accountId, accountId), eq(files.providerFileId, providerFileId)))
    .limit(1);
  return f ?? null;
}

export async function completeUpload(userId: string, uploadId: string): Promise<UploadCompleteResponse> {
  const db = getDb();
  const u = await loadOwnedUpload(userId, uploadId);

  if (u.status === 'completed') {
    if (!u.providerFileId || !u.accountId) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'completed upload without a provider file id');
    }
    const f = await existingFileFor(u.accountId, u.providerFileId);
    if (f) {
      return { uploadId: u.id, fileId: f.id, providerFileId: u.providerFileId, sizeBytes: u.sizeBytes.toString() };
    }
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'completed upload without a files row');
  }
  if (u.status !== 'uploading') {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, `Upload is ${u.status} — nothing to complete`);
  }
  if (!u.accountId || !u.providerFileId) {
    // status uploading implies both (set atomically at reserve/final-chunk) — defensive guard
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'reserved upload missing its account or Drive file id');
  }

  // byte totals: every dense chunk committed AND equal to the declared size (G7)
  const idxs = await committedIndexes(db, u.id);
  const offset = committedOffsetFor(idxs.length, u.chunkSize, u.sizeBytes);
  if (offset !== u.sizeBytes) {
    throw new AppError(
      ErrorCodes.UPLOAD_SIZE_MISMATCH,
      `upload incomplete: ${offset} of ${u.sizeBytes} bytes committed`
    );
  }

  const { ctx } = await loadProviderAccount(userId, u.accountId);
  const meta = await googleDriveProvider.completeUpload({
    ...ctx,
    uploadId: u.id,
    fileName: u.fileName,
    mimeType: u.mimeType,
    sizeBytes: u.sizeBytes,
    sessionUri: u.providerSessionUri ?? undefined,
    targetRootFolderId: u.targetRootFolderId ?? undefined,
    providerFileId: u.providerFileId ?? undefined,
  });

  const respond = (fileId: string): UploadCompleteResponse => ({
    uploadId: u.id,
    fileId,
    providerFileId: meta.providerFileId,
    sizeBytes: u.sizeBytes.toString(),
  });

  // capture narrowed values: property narrowing is dropped inside the txn closure below
  const accountId: string = u.accountId;

  const run = async (): Promise<string | null> =>
    db.transaction(async (tx) => {
      // insert FIRST: the (accountId, providerFileId) unique index arbitrates double-clicks
      const [row] = await tx
        .insert(files)
        .values({
          userId,
          accountId,
          folderId: u.folderId,
          provider: 'google_drive',
          providerFileId: meta.providerFileId,
          name: u.fileName,
          mimeType: u.mimeType,
          sizeBytes: u.sizeBytes,
        })
        .returning({ id: files.id });
      if (!row) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'files insert produced no row');
      await tx
        .update(uploads)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(uploads.id, u.id));
      await releaseReservation(tx, u.id); // bytes freed exactly when the file becomes real
      return row.id;
    });

  let fileId: string | null = null;
  try {
    fileId = await run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // another tab completed the same upload first → answer with the winner's row (G4)
    const winner = await existingFileFor(accountId, meta.providerFileId);
    if (winner) fileId = winner.id;
    else throw err;
  }
  if (!fileId) throw new AppError(ErrorCodes.INTERNAL_ERROR, 'complete produced no file row');

  enqueueQuotaSync(accountId); // rule 5: never inline — runs after the response flushes
  return respond(fileId);
}

// ---------------------------------------------------------------- abort

export async function abortUpload(userId: string, uploadId: string): Promise<UploadAbortResponse> {
  const db = getDb();
  const u = await loadOwnedUpload(userId, uploadId);
  if (u.status === 'completed') {
    throw new AppError(ErrorCodes.UPLOAD_ALREADY_COMPLETED, 'Upload already completed — delete the file instead');
  }
  if (u.status !== 'aborted') {
    await db.transaction(async (tx) => {
      await tx
        .update(uploads)
        .set({ status: 'aborted' })
        .where(and(eq(uploads.id, u.id), inArray(uploads.status, ['initiated', 'uploading', 'failed'])));
      await releaseReservation(tx, u.id); // claim always goes back (G9)
    });
    // provider cleanup is best-effort AFTER the DB is consistent — the client gets its
    // answer even if Google is unreachable; P0.5 GC sweeps stragglers.
    if (u.accountId && (u.providerSessionUri || u.providerFileId)) {
      try {
        const { ctx } = await loadProviderAccount(userId, u.accountId);
        await googleDriveProvider.abortUpload({
          ...ctx,
          uploadId: u.id,
          fileName: u.fileName,
          mimeType: u.mimeType,
          sizeBytes: u.sizeBytes,
          sessionUri: u.providerSessionUri ?? undefined,
          providerFileId: u.providerFileId ?? undefined,
        });
      } catch (cleanupErr) {
        console.warn('[abort] provider cleanup failed (GC will retry):', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      }
    }
  }
  return { uploadId: u.id, status: 'aborted' };
}
