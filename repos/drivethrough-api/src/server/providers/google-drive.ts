// Google Drive StorageProvider (tech.md §5) — raw fetch, no `googleapis` bundle.
// Upload: resumable handshake + 4 MB Content-Range chunk PUTs, streaming body pass-through
// (duplex:'half', ZERO buffering — spike S2 validated this holds on Vercel 2026-10-22).
// Read: alt=media Range proxy (spike S1 validated throughput + 206 passthrough).
// No `any` in this path (AGENTS.md).

import { ErrorCodes } from '@drivethrough/contracts';
import { AppError, safeDetail } from '../errors';
import { ensureRootFolder, fetchAbout } from './google-oauth';
import { parseDriveCommittedRange, DEFAULT_CHUNK_SIZE } from '../uploads/chunk-protocol';
import type {
  BeginResult,
  ProviderObject,
  ProviderUserContext,
  ReadHandle,
  StorageProvider,
  UploadContext,
} from './types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function tokenOf(ctx: ProviderUserContext): string {
  if (!ctx.accessToken) {
    throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, 'Drive access token missing');
  }
  return ctx.accessToken;
}

/** Map a non-OK Drive response to the stable error taxonomy, embedding Google's PUBLIC
 *  error message (charset-filtered by safeDetail — the diagnosability pattern from 2026-10-22). */
async function providerError(res: Response, step: string): Promise<never> {
  const txt = await res.text().catch(() => '');
  let ext = '';
  try {
    const parsed = JSON.parse(txt) as { error?: { message?: string; status?: string } };
    ext = parsed.error?.message ?? '';
  } catch {
    /* non-JSON body — status alone carries the info */
  }
  const detail = safeDetail(`${step} failed (${res.status})${ext ? `: ${ext}` : ''}`);
  if (res.status === 401) {
    throw new AppError(ErrorCodes.ACCOUNT_NEEDS_REAUTH, `${step}: Drive token rejected`);
  }
  if (res.status === 429 || (res.status === 403 && /rate|quota|userRate/i.test(ext))) {
    throw new AppError(ErrorCodes.PROVIDER_RATE_LIMITED, detail);
  }
  throw new AppError(ErrorCodes.PROVIDER_ERROR, detail);
}

/** Wrap a request body stream with a byte counter — forwards without ever holding bytes
 *  (the no-buffer guarantee: we count, we don't collect). */
function countingBody(input: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  count: () => number;
} {
  const reader = input.getReader();
  let total = 0;
  return {
    count: () => total,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

function assertStreamedExactly(streamed: number, declared: number, index: number): void {
  if (streamed !== declared) {
    throw new AppError(
      ErrorCodes.UPLOAD_SIZE_MISMATCH,
      `chunk ${index}: streamed ${streamed} bytes, Content-Range declared ${declared}`
    );
  }
}

export const googleDriveProvider: StorageProvider = {
  kind: 'google_drive',

  async ensureRoot(ctx: ProviderUserContext): Promise<string> {
    return ensureRootFolder(tokenOf(ctx)); // idempotent primitive from the connect flow
  },

  async getQuota(ctx: ProviderUserContext): Promise<{
    total: bigint | null;
    used: bigint;
    available: bigint | null;
  }> {
    const about = await fetchAbout(tokenOf(ctx));
    return { total: about.total, used: about.used, available: about.available };
  },

  async beginUpload(ctx: UploadContext): Promise<BeginResult> {
    if (!ctx.targetRootFolderId) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'beginUpload without a target root folder');
    }
    const res = await fetch(`${UPLOAD_API}/files?uploadType=resumable`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenOf(ctx)}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': ctx.mimeType,
        'X-Upload-Content-Length': String(ctx.sizeBytes),
      },
      // Physical location: under the account's `drivethrough/` root only — the virtual
      // folder tree lives in OUR DB (move/re-folder = metadata-only, design.md §3).
      body: JSON.stringify({
        name: ctx.fileName,
        mimeType: ctx.mimeType,
        parents: [ctx.targetRootFolderId],
      }),
    });
    if (!res.ok) throw await providerError(res, 'Resumable session init');
    const sessionUri = res.headers.get('location');
    if (!sessionUri) {
      throw new AppError(
        ErrorCodes.PROVIDER_ERROR,
        safeDetail('Resumable session init returned no Location header')
      );
    }
    return { sessionUri, mode: 'drive_proxy', chunkSize: DEFAULT_CHUNK_SIZE };
  },

  async putChunk(ctx, _index, range, body) {
    if (!ctx.sessionUri) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'putChunk without a session URI');
    }
    const { stream, count } = countingBody(body);
    let res: Response;
    try {
      res = await fetch(ctx.sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`,
          // explicit length: Google's resumable protocol requires it (a streamed body would
          // otherwise go Transfer-Encoding: chunked, which it rejects)
          'Content-Length': String(range.end - range.start + 1),
        },
        body: stream, // pass-through — never buffered anywhere in this handler
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    } catch (err) {
      throw new AppError(
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        safeDetail(`Drive chunk upload unreachable: ${err instanceof Error ? err.message : 'network error'}`)
      );
    }

    if (res.status === 308) {
      await res.body?.cancel().catch(() => {});
      assertStreamedExactly(count(), range.end - range.start + 1, _index);
      // Drive's Range is the source of truth; fall back to the declared end if absent.
      return {
        committedOffset: parseDriveCommittedRange(res.headers.get('range')) ?? BigInt(range.end + 1),
      };
    }
    if (res.status === 200) {
      // final chunk: Drive created the file and returns its metadata
      const meta = (await res.json().catch(() => null)) as { id?: string } | null;
      assertStreamedExactly(count(), range.end - range.start + 1, _index);
      if (!meta?.id) {
        throw new AppError(ErrorCodes.PROVIDER_ERROR, safeDetail('Final chunk accepted but Drive returned no file id'));
      }
      return { committedOffset: BigInt(range.total), providerFileId: meta.id };
    }
    throw await providerError(res, `Chunk ${_index} upload`);
  },

  async queryOffset(ctx: UploadContext): Promise<bigint | 'complete' | 'unknown'> {
    if (!ctx.sessionUri) return 'unknown';
    let res: Response;
    try {
      // Protocol status probe: empty PUT, `Content-Range: bytes */<total>` (Google's documented
      // "find out how many bytes are committed" request).
      res = await fetch(ctx.sessionUri, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes */${ctx.sizeBytes}` },
        body: '',
      });
    } catch {
      return 'unknown'; // unreachable now ≠ dead session — caller keeps the DB view
    }
    if (res.status === 308) {
      await res.body?.cancel().catch(() => {});
      return parseDriveCommittedRange(res.headers.get('range')) ?? 0n; // no Range header = 0 bytes
    }
    if (res.status === 200) {
      await res.body?.cancel().catch(() => {});
      return 'complete';
    }
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return 'unknown'; // session gone/invalid — DB remains the view; next PUT fails honestly
    }
    throw await providerError(res, 'Session offset query');
  },

  async completeUpload(ctx: UploadContext): Promise<{ providerFileId: string; name: string; size: bigint }> {
    if (!ctx.providerFileId) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'completeUpload without the captured Drive file id');
    }
    const res = await fetch(`${DRIVE_API}/files/${ctx.providerFileId}?fields=id,name,size`, {
      headers: { Authorization: `Bearer ${tokenOf(ctx)}` },
    });
    if (!res.ok) throw await providerError(res, 'Final file verify');
    const meta = (await res.json()) as { id: string; name: string; size?: string };
    const size = BigInt(meta.size ?? '0');
    if (size !== ctx.sizeBytes) {
      // physical bytes disagree with the declared size — the 9Drive UPLOAD_SIZE_MISMATCH guard
      throw new AppError(
        ErrorCodes.UPLOAD_SIZE_MISMATCH,
        `Drive holds ${size} bytes, upload declared ${ctx.sizeBytes}`
      );
    }
    return { providerFileId: meta.id, name: meta.name ?? ctx.fileName, size };
  },

  async abortUpload(ctx: UploadContext): Promise<void> {
    const auth = { Authorization: `Bearer ${tokenOf(ctx)}` };
    if (ctx.providerFileId) {
      // final chunk already created the file — remove it so an abort never leaves orphan bytes
      const res = await fetch(`${DRIVE_API}/files/${ctx.providerFileId}`, {
        method: 'DELETE',
        headers: auth,
      });
      if (res.ok || res.status === 404) return;
      throw await providerError(res, 'Abort cleanup delete');
      return;
    }
    if (!ctx.sessionUri) return;
    // Drive session abort: empty PUT with `Content-Range: bytes */<total>` → 400 = released.
    const res = await fetch(ctx.sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${ctx.sizeBytes}` },
      body: '',
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok || res.status === 400 || res.status === 404 || res.status === 410) return;
    throw await providerError(res, 'Session abort');
  },

  async signDownloadUrl(): Promise<string | null> {
    return null; // Drive has no presigned GET → caller streams through openRead (tech.md §6.2)
  },

  async openRead(
    ctx: ProviderUserContext,
    fileId: string,
    rangeHeader?: string
  ): Promise<ReadHandle> {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokenOf(ctx)}` };
    // Single-range only (`bytes=a-b`, `bytes=a-`, `bytes=-n`); anything else (multi-range,
    // malformed) is ignored per RFC 7233 → full 200 response instead of a broken proxy call.
    if (rangeHeader && /^bytes=(\d*-\d+|\d+-\d*)$/.test(rangeHeader.trim())) {
      headers.Range = rangeHeader.trim();
    }
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, { headers });
    if (res.ok || res.status === 206 || res.status === 416) {
      // 200 / 206 / 416 (unsatisfiable range) pass through with headers — status/headers
      // passthrough is what makes <video> seeking work (flow.md §5.2).
      const out = new Headers();
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = res.headers.get(h);
        if (v) out.set(h, v);
      }
      return {
        stream: res.body ?? new ReadableStream<Uint8Array>(),
        status: res.status,
        headers: out,
      };
    }
    if (res.status === 404) {
      throw new AppError(ErrorCodes.FILE_NOT_FOUND, 'File no longer exists on the provider');
    }
    throw await providerError(res, 'Media read');
  },

  async delete(ctx: ProviderUserContext, fileId: string, soft?: boolean): Promise<void> {
    const auth = { Authorization: `Bearer ${tokenOf(ctx)}`, 'Content-Type': 'application/json' };
    if (soft) {
      // trash (recoverable on Google's side too) — probe-verified in the P0.2 E2E contract test
      const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ trashed: true }),
      });
      if (res.ok || res.status === 404) return;
      throw await providerError(res, 'Trash file');
      return;
    }
    const res = await fetch(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE', headers: auth });
    if (res.ok || res.status === 404) return; // idempotent: already gone is success
    throw await providerError(res, 'Delete file');
  },

  async *listChildren(
    ctx: ProviderUserContext,
    rootId: string
  ): AsyncIterable<ProviderObject> {
    const auth = { Authorization: `Bearer ${tokenOf(ctx)}` };
    let pageToken: string | undefined;
    do {
      const q = encodeURIComponent(`'${rootId}' in parents and trashed = false`);
      const fields = encodeURIComponent('nextPageToken,files(id,name,size,mimeType,modifiedTime)');
      const url =
        `${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=100&spaces=drive` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await fetch(url, { headers: auth });
      if (!res.ok) throw await providerError(res, 'List children');
      const data = (await res.json()) as {
        files?: {
          id: string;
          name: string;
          size?: string;
          mimeType?: string;
          modifiedTime?: string;
        }[];
        nextPageToken?: string;
      };
      for (const f of data.files ?? []) {
        const isFolder = f.mimeType === FOLDER_MIME;
        yield {
          id: f.id,
          name: f.name,
          // folders and native Google Docs carry no size; uploaded binaries always do
          sizeBytes: isFolder ? 0n : BigInt(f.size ?? '0'),
          mimeType: f.mimeType ?? 'application/octet-stream',
          isFolder,
          modifiedAt: f.modifiedTime ?? new Date().toISOString(),
        };
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  },
};
