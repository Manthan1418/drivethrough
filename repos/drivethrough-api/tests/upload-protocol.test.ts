// Unit tests — the pure upload-chunk protocol (tech.md §4/§6, flow.md §4.3).
// These encode the geometry the whole resume/idempotency machinery depends on:
// dense sequential chunks, server-authoritative offsets, provider-wins reconciliation.

import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '@drivethrough/contracts';
import {
  committedOffsetFor,
  expectedNextIndex,
  maxUploadBytes,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  parseContentRange,
  parseDriveCommittedRange,
  planReconcile,
  resolveChunkSize,
  sanitizeMime,
  totalChunksFor,
  validateChunkShape,
} from '../src/server/uploads/chunk-protocol';
import { AppError } from '../src/server/errors';

const MB = 1024 * 1024;

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected AppError ${code}, nothing was thrown`);
}

describe('resolveChunkSize — the S2 hard cap', () => {
  it('defaults to 4 MB (under the Vercel ~4.5 MB edge cap)', () => {
    expect(resolveChunkSize(undefined)).toBe(4 * MB);
    expect(resolveChunkSize(undefined)).toBe(MAX_CHUNK_SIZE);
  });
  it('clamps oversized env values down to 4 MB', () => {
    expect(resolveChunkSize(String(16 * MB))).toBe(4 * MB);
    expect(resolveChunkSize(String(5 * MB))).toBe(4 * MB);
  });
  it('clamps undersized env values up to 256 KB (Drive requirement)', () => {
    expect(resolveChunkSize(String(100 * 1024))).toBe(MIN_CHUNK_SIZE);
  });
  it('rounds env values down to a 256 KB multiple', () => {
    expect(resolveChunkSize(String(1024 * 1024))).toBe(MIN_CHUNK_SIZE * 4); // 1 MB exact
    expect(resolveChunkSize(String(3 * MB + 1234))).toBe(3 * MB); // misaligned input
  });
  it('garbage env falls back to the default', () => {
    expect(resolveChunkSize('banana')).toBe(MAX_CHUNK_SIZE);
    expect(resolveChunkSize('-1')).toBe(MAX_CHUNK_SIZE);
  });
});

describe('maxUploadBytes', () => {
  it('defaults to 50 GB', () => {
    expect(maxUploadBytes(undefined)).toBe(BigInt(50) * 1024n * 1024n * 1024n);
    expect(maxUploadBytes('nonsense')).toBe(BigInt(50) * 1024n * 1024n * 1024n);
  });
  it('honors a numeric env override', () => {
    expect(maxUploadBytes('1048576')).toBe(1048576n);
  });
});

describe('totalChunksFor', () => {
  it('ceil-divides size by chunk size', () => {
    expect(totalChunksFor(BigInt(8 * MB), 4 * MB)).toBe(2);
    expect(totalChunksFor(BigInt(9 * MB), 4 * MB)).toBe(3);
    expect(totalChunksFor(1n, 4 * MB)).toBe(1);
    expect(totalChunksFor(BigInt(4 * MB), 4 * MB)).toBe(1); // exact fit = exactly one chunk
    expect(totalChunksFor(BigInt(4 * MB) + 1n, 4 * MB)).toBe(2); // one byte over spills
  });
  it('rejects zero-byte files', () => {
    expectCode(() => totalChunksFor(0n, 4 * MB), ErrorCodes.VALIDATION_FAILED);
  });
});

describe('sanitizeMime — syntactic allowlist', () => {
  it('accepts and lowercases real types', () => {
    expect(sanitizeMime('Image/PNG')).toBe('image/png');
    expect(sanitizeMime('application/gltf-binary')).toBe('application/gltf-binary');
    expect(sanitizeMime(' model/stl ')).toBe('model/stl');
  });
  it('rejects malformed / hostile strings', () => {
    expectCode(() => sanitizeMime(''), ErrorCodes.VALIDATION_FAILED);
    expectCode(() => sanitizeMime('text/html; charset=utf-8'), ErrorCodes.VALIDATION_FAILED);
    expectCode(() => sanitizeMime('evil<script>'), ErrorCodes.VALIDATION_FAILED);
    expectCode(() => sanitizeMime('a'.repeat(300)), ErrorCodes.VALIDATION_FAILED);
  });
});

describe('parseContentRange', () => {
  it('parses a well-formed header', () => {
    expect(parseContentRange('bytes 4194304-8388607/9449529')).toEqual({
      start: 4194304,
      end: 8388607,
      total: 9449529,
    });
  });
  it('rejects missing, star-form, and garbage headers', () => {
    expectCode(() => parseContentRange(null), ErrorCodes.CHUNK_RANGE_INVALID);
    expectCode(() => parseContentRange('bytes */100'), ErrorCodes.CHUNK_RANGE_INVALID);
    expectCode(() => parseContentRange('0-100/200'), ErrorCodes.CHUNK_RANGE_INVALID);
    // reversed bounds PARSE fine here — validateChunkShape is what rejects them (see below)
    expect(parseContentRange('bytes 10-5/200')).toEqual({ start: 10, end: 5, total: 200 });
  });
});

describe('validateChunkShape — dense sequential geometry', () => {
  const TOTAL = 9 * MB + 12345;
  const base = { chunkSize: 4 * MB, totalChunks: 3, sizeBytes: BigInt(TOTAL), total: TOTAL };
  const goodFirst = { index: 0, start: 0, end: 4 * MB - 1 };
  const goodLast = { index: 2, start: 8 * MB, end: TOTAL - 1 };

  it('accepts a full middle chunk and the exact final chunk', () => {
    expect(() => validateChunkShape({ ...base, ...goodFirst })).not.toThrow();
    expect(() => validateChunkShape({ ...base, ...goodLast })).not.toThrow();
  });
  it('rejects a total that does not match the session size', () => {
    expectCode(
      () => validateChunkShape({ ...base, ...goodFirst, total: 999 }),
      ErrorCodes.CHUNK_RANGE_INVALID
    );
  });
  it('rejects a start that is not index*chunkSize', () => {
    expectCode(
      () => validateChunkShape({ ...base, ...goodFirst, start: 100, end: 100 + 4 * MB - 1 }),
      ErrorCodes.CHUNK_RANGE_INVALID
    );
  });
  it('rejects end before start', () => {
    expectCode(
      () => validateChunkShape({ ...base, index: 1, start: 4 * MB, end: 100 }),
      ErrorCodes.CHUNK_RANGE_INVALID
    );
  });
  it('rejects a short non-final chunk (would break the offset math)', () => {
    expectCode(
      () => validateChunkShape({ ...base, index: 1, start: 4 * MB, end: 4 * MB + 1000 }),
      ErrorCodes.CHUNK_RANGE_INVALID
    );
  });
  it('rejects an index outside the session', () => {
    expectCode(
      () => validateChunkShape({ ...base, ...goodLast, index: 3, start: 12 * MB, end: 13 * MB - 1 }),
      ErrorCodes.CHUNK_RANGE_INVALID
    );
  });
  it('rejects an end beyond the total', () => {
    expectCode(
      () => validateChunkShape({ ...base, index: 2, start: 8 * MB, end: 10 * MB }),
      ErrorCodes.CHUNK_RANGE_INVALID
    );
  });
});

describe('offset math', () => {
  it('committedOffsetFor is dense and clamps at the file size', () => {
    expect(committedOffsetFor(0, 4 * MB, BigInt(9 * MB))).toBe(0n);
    expect(committedOffsetFor(2, 4 * MB, BigInt(9 * MB))).toBe(BigInt(8 * MB));
    expect(committedOffsetFor(5, 4 * MB, BigInt(9 * MB))).toBe(BigInt(9 * MB)); // clamped
  });
  it('expectedNextIndex walks one at a time', () => {
    expect(expectedNextIndex(null)).toBe(0);
    expect(expectedNextIndex(0)).toBe(1);
    expect(expectedNextIndex(6)).toBe(7);
  });
  it('parseDriveCommittedRange reads the 308 Range header', () => {
    expect(parseDriveCommittedRange('bytes=0-4194303')).toBe(BigInt(4 * MB));
    expect(parseDriveCommittedRange('bytes=0-0')).toBe(1n);
    expect(parseDriveCommittedRange(null)).toBeNull();
    expect(parseDriveCommittedRange('garbage')).toBeNull();
  });
});

describe('planReconcile — provider wins on resume (G6)', () => {
  const cs = 4 * MB;
  const size = BigInt(12 * MB);
  const chunks = 3;

  it('aligned offset commits the covered chunks and resets the tail', () => {
    const plan = planReconcile(BigInt(8 * MB), cs, size, chunks);
    expect(plan.toCommit).toEqual([0, 1]);
    expect(plan.toReset).toEqual([2]);
    expect(plan.committedOffset).toBe(BigInt(8 * MB));
  });
  it('mid-chunk offset retracts that whole chunk (client re-sends it aligned)', () => {
    const plan = planReconcile(BigInt(5 * MB), cs, size, chunks);
    expect(plan.toCommit).toEqual([0]);
    expect(plan.toReset).toEqual([1, 2]);
    expect(plan.committedOffset).toBe(BigInt(5 * MB));
  });
  it('zero offset resets everything', () => {
    const plan = planReconcile(0n, cs, size, chunks);
    expect(plan.toCommit).toEqual([]);
    expect(plan.toReset).toEqual([0, 1, 2]);
  });
  it('full offset commits everything and clamps past-the-end values', () => {
    const plan = planReconcile(size, cs, size, chunks);
    expect(plan.toCommit).toEqual([0, 1, 2]);
    expect(plan.toReset).toEqual([]);
    const overshoot = planReconcile(size + 999n, cs, size, chunks);
    expect(overshoot.committedOffset).toBe(size);
  });
});
