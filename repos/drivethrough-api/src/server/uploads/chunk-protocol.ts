// Upload chunk protocol — pure helpers, zero I/O (tech.md §4/§6, flow.md §4.2/§4.3).
//
// Invariants encoded here (the ACID-for-files guarantees, prd.md §5.4):
// - Chunks are DENSE and SEQUENTIAL per stripe: chunk i covers [i*chunkSize, min((i+1)*chunkSize, size)).
//   Drive's resumable session advances a single offset, so out-of-order writes can never apply
//   (CHUNK_OUT_OF_ORDER) — one stripe = one sequential stream (P1 striping parallelizes across files).
// - Raw PUT bodies with `Content-Range` — NOT multipart (tech.md §6); chunkSize is hard-capped at
//   4 MB because S2 proved Vercel rejects request bodies > ~4.5 MB at the edge (413 FUNCTION_PAYLOAD_TOO_LARGE),
//   and Drive requires 256 KB multiples for non-final chunks.

import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';

export const MIN_CHUNK_SIZE = 256 * 1024; // Drive requirement
export const MAX_CHUNK_SIZE = 4 * 1024 * 1024; // Vercel edge cap (spike S2, 2026-10-22)
export const DEFAULT_CHUNK_SIZE = MAX_CHUNK_SIZE;

const DEFAULT_MAX_UPLOAD_BYTES = BigInt(50) * 1024n * 1024n * 1024n; // tech.md §6: MAX_UPLOAD_BYTES default 50 GB

/** Resolve the chunk size: env override clamped into [256 KB, 4 MB] and rounded DOWN to a
 *  256 KB multiple (Drive rejects misaligned non-final chunks). */
export function resolveChunkSize(envValue?: string): number {
  const parsed = envValue ? Number.parseInt(envValue, 10) : NaN;
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHUNK_SIZE;
  const clamped = Math.min(Math.max(wanted, MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
  return Math.floor(clamped / MIN_CHUNK_SIZE) * MIN_CHUNK_SIZE;
}

/** MAX_UPLOAD_BYTES env (bytes), default 50 GB. */
export function maxUploadBytes(envValue?: string): bigint {
  const parsed = envValue ? Number.parseInt(envValue, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return BigInt(parsed);
}

export function totalChunksFor(sizeBytes: bigint, chunkSize: number): number {
  if (sizeBytes <= 0n) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'file must be at least 1 byte');
  }
  const cs = BigInt(chunkSize);
  return Number((sizeBytes + cs - 1n) / cs); // ceil
}

const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** Syntactic MIME allowlist (flow.md §4.2 "mime allowlist"): every real type passes
 *  (model/gltf-binary, application/x-…), malformed/hostile strings are rejected before
 *  they can ever reach a Content-Type header or the DB (varchar 255). */
export function sanitizeMime(input: string): string {
  const mime = input.trim().toLowerCase();
  if (!mime || mime.length > 255 || !MIME_RE.test(mime)) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'invalid mimeType');
  }
  return mime;
}

export interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

/** `bytes a-b/total` → numbers. Malformed → CHUNK_RANGE_INVALID (422). */
export function parseContentRange(header: string | null): ParsedContentRange {
  const m = header ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim()) : null;
  if (!m) {
    throw new AppError(
      ErrorCodes.CHUNK_RANGE_INVALID,
      'Content-Range must look like "bytes a-b/total"'
    );
  }
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    throw new AppError(ErrorCodes.CHUNK_RANGE_INVALID, 'Content-Range out of safe integer range');
  }
  return { start, end, total };
}

export interface ChunkShapeInput {
  index: number;
  chunkSize: number;
  totalChunks: number;
  sizeBytes: bigint;
  start: number;
  end: number;
  total: number;
}

/** Shape of one chunk vs the session's declared geometry (ordering is checked separately).
 *  Dense: every non-final chunk must be FULL (start === index*chunkSize, length === chunkSize);
 *  the final chunk must run to exactly sizeBytes — this is what makes the offset math exact. */
export function validateChunkShape(i: ChunkShapeInput): void {
  const bad = (msg: string): never => {
    throw new AppError(ErrorCodes.CHUNK_RANGE_INVALID, msg);
  };
  if (BigInt(i.total) !== i.sizeBytes) {
    bad(`Content-Range total ${i.total} does not match upload size ${i.sizeBytes}`);
  }
  if (i.index < 0 || i.index >= i.totalChunks) {
    bad(`chunk index ${i.index} outside 0..${i.totalChunks - 1}`);
  }
  if (i.start !== i.index * i.chunkSize) {
    bad(`chunk ${i.index} must start at byte ${i.index * i.chunkSize}, got ${i.start}`);
  }
  if (i.end < i.start) {
    bad(`Content-Range end before start`);
  }
  if (i.end >= i.total) {
    bad(`Content-Range end ${i.end} beyond total ${i.total}`);
  }
  const len = i.end - i.start + 1;
  const expectedLen =
    i.index === i.totalChunks - 1 ? i.total - i.start : i.chunkSize;
  if (len !== expectedLen) {
    bad(`chunk ${i.index} must be ${expectedLen} bytes, got ${len}`);
  }
}

/** Next expected chunk index from the highest committed one (sequential ⇒ gaps impossible). */
export function expectedNextIndex(maxCommittedIndex: number | null): number {
  return maxCommittedIndex === null ? 0 : maxCommittedIndex + 1;
}

/** Bytes covered once `expectedIndex` chunks are committed (dense math). */
export function committedOffsetFor(
  expectedIndex: number,
  chunkSize: number,
  sizeBytes: bigint
): bigint {
  const off = BigInt(expectedIndex) * BigInt(chunkSize);
  return off > sizeBytes ? sizeBytes : off;
}

/** Drive's 308 `Range: bytes=0-N` header → committed offset (N+1). Absent/malformed → null. */
export function parseDriveCommittedRange(header: string | null): bigint | null {
  if (!header) return null;
  const m = /^bytes=0-(\d+)$/.exec(header.trim());
  const end = m?.[1];
  if (end === undefined) return null;
  return BigInt(end) + 1n;
}

export interface ReconcilePlan {
  /** Committed chunk indexes the ledger must record (they're covered by provider bytes). */
  toCommit: number[];
  /** Committed chunk indexes the ledger must retract (provider lost/never fully got them). */
  toReset: number[];
  /** Authoritative offset = what the provider reports. */
  committedOffset: bigint;
}

/** Plan the resume reconciliation between the DB chunk ledger and the provider's 308 offset
 *  (flow.md §4.2 resume note: provider wins when they disagree — it owns the bytes).
 *  A provider offset that cuts mid-chunk retracts that whole chunk: the client re-sends it
 *  from its aligned start (Drive re-receives the overlap — verified in the P0.3 flaky-upload e2e). */
export function planReconcile(
  providerOffset: bigint,
  chunkSize: number,
  sizeBytes: bigint,
  totalChunks: number
): ReconcilePlan {
  const toCommit: number[] = [];
  const toReset: number[] = [];
  const cs = BigInt(chunkSize);
  for (let i = 0; i < totalChunks; i++) {
    const start = BigInt(i) * cs;
    const end = i === totalChunks - 1 ? sizeBytes : start + cs; // exclusive
    if (end <= providerOffset) toCommit.push(i);
    else toReset.push(i); // fully or partially beyond what the provider holds
  }
  return { toCommit, toReset, committedOffset: providerOffset > sizeBytes ? sizeBytes : providerOffset };
}
