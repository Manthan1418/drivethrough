'use client';

// client/uploads.tsx — the chunked-upload manager behind the dock (design.md §5.2).
// One provider owns every in-flight upload; the dock renders its state.
//
// Resume story (flow.md §4.2, the P0.3 e2e gate):
//  · in-session pause / network drop → the File object is still alive (kept in a ref),
//    resume re-enters the SAME server session; init is idempotent per key and returns
//    the committed chunks, so we continue from the server's offset.
//  · reload / close the tab → the browser forgets File objects, so task metadata
//    (keyed on clientUploadId + name + size) persists to localStorage; next visit the
//    dock shows "reselect to resume", and picking the matching file re-attaches it.
// Chunks are sequential raw PUTs with Content-Range through apiRaw — never buffered.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type MutableRefObject, type ReactNode,
} from 'react';
import { apiRaw, ApiRequestError } from './api';

const STORE_KEY = 'dt-uploads-v1';
const STORE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface UploadTask {
  key: string; // clientUploadId — the idempotency key
  uploadId?: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  folderId: string | null;
  status: 'queued' | 'uploading' | 'paused' | 'needs-file' | 'error' | 'done';
  sentBytes: number;
  chunkSize?: number;
  totalChunks?: number;
  error?: string;
  speedBps?: number;
}

interface StoredEntry {
  key: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  folderId: string | null;
  savedAt: number;
}

interface UploadsContextValue {
  tasks: UploadTask[];
  addFiles: (files: File[] | FileList, folderId: string | null) => void;
  pause: (key: string) => void;
  resume: (key: string) => void;
  retry: (key: string) => void;
  cancel: (key: string) => void;
  clearFinished: () => void;
  /** resume-after-reload: the UI should open a file picker for this key */
  awaitingFileFor: string | null;
  attachFile: (key: string, file: File) => void;
  /** explorer sets this → called after each completed upload (refresh listing) */
  onUploadDone: MutableRefObject<(() => void) | null>;
}

const UploadsContext = createContext<UploadsContextValue | null>(null);

interface RunState {
  cancelled: boolean;
  paused: boolean;
  controller: AbortController | null;
}

function loadStored(): StoredEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as StoredEntry[];
    const cutoff = Date.now() - STORE_MAX_AGE_MS;
    return arr.filter((e) => e && typeof e.key === 'string' && e.savedAt > cutoff);
  } catch {
    return [];
  }
}

function saveStored(entries: StoredEntry[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(-20)));
  } catch { /* private mode / quota — resume-after-reload just degrades */ }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function toApiError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { message?: string; code?: string };
    return new ApiRequestError(body.code ?? 'INTERNAL_ERROR', body.message ?? res.statusText, res.status);
  } catch {
    return new ApiRequestError('INTERNAL_ERROR', res.statusText, res.status);
  }
}

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [awaitingFileFor, setAwaitingFileFor] = useState<string | null>(null);
  const runs = useRef(new Map<string, RunState>());
  const liveFiles = useRef(new Map<string, File>());
  const tasksRef = useRef<UploadTask[]>([]);
  const onUploadDone = useRef<(() => void) | null>(null);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // hydrate resume candidates from a previous session (Files die with the tab)
  useEffect(() => {
    const stored = loadStored();
    if (!stored.length) return;
    setTasks(
      stored.map((e) => ({
        key: e.key,
        fileName: e.fileName,
        sizeBytes: e.sizeBytes,
        mimeType: e.mimeType,
        folderId: e.folderId,
        status: 'needs-file' as const,
        sentBytes: 0,
      }))
    );
  }, []);

  const patch = useCallback((key: string, p: Partial<UploadTask>) => {
    setTasks((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));
  }, []);

  const persist = useCallback((current: UploadTask[]) => {
    saveStored(
      current
        .filter((t) => t.status !== 'done')
        .map((t) => ({
          key: t.key,
          fileName: t.fileName,
          sizeBytes: t.sizeBytes,
          mimeType: t.mimeType,
          folderId: t.folderId,
          savedAt: Date.now(),
        }))
    );
  }, []);

  /** Drive the whole flow for one task. Re-entrant: entering with a fresh run after a
   *  pause/reload re-syncs from the server ledger via init's idempotent receivedChunks. */
  const runUpload = useCallback(
    async (key: string, file: File, run: RunState) => {
      try {
        patch(key, { status: 'uploading', error: undefined });
        // 1) init — idempotent per clientUploadId; returns chunks a previous attempt committed
        const initRes = await apiRaw('/api/uploads/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientUploadId: key,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: String(file.size),
            folderId: tasksRef.current.find((t) => t.key === key)?.folderId ?? undefined,
          }),
        });
        if (!initRes.ok) throw await toApiError(initRes);
        const init = (await initRes.json()) as {
          uploadId: string; chunkSize: number; totalChunks: number; receivedChunks: number[]; status: string;
        };
        if (init.status === 'completed') {
          patch(key, { status: 'done', sentBytes: file.size, uploadId: init.uploadId });
          persist(tasksRef.current.filter((t) => t.key !== key));
          onUploadDone.current?.();
          return;
        }
        // 2) reserve — placement + Drive session (idempotent double-click safe)
        const resv = await apiRaw('/api/uploads/reserve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: init.uploadId }),
        });
        if (!resv.ok) throw await toApiError(resv);

        let nextIdx = init.receivedChunks.length; // dense-sequential commits ⇒ count == next index
        let sent = Math.min(nextIdx * init.chunkSize, file.size);
        const speed = { t: Date.now(), bytes: sent, bps: 0 };
        patch(key, { uploadId: init.uploadId, chunkSize: init.chunkSize, totalChunks: init.totalChunks, sentBytes: sent });

        // 3) sequential chunk loop — one Drive session advances one offset
        while (nextIdx < init.totalChunks) {
          if (run.cancelled) return;
          if (run.paused) {
            patch(key, { status: 'paused' });
            return;
          }
          const start = nextIdx * init.chunkSize;
          const end = Math.min(start + init.chunkSize, file.size);
          run.controller = new AbortController();
          let res: Response;
          try {
            res = await apiRaw(`/api/uploads/chunk/${init.uploadId}?index=${nextIdx}`, {
              method: 'PUT',
              headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` },
              body: file.slice(start, end),
              signal: run.controller.signal,
            });
          } catch (err) {
            if (run.cancelled) return;
            if (run.paused || isAbort(err)) {
              patch(key, { status: 'paused' });
              return;
            }
            throw err; // network drop → error state with Retry; the offset survives server-side
          }
          if (res.status === 409) {
            // CHUNK_OUT_OF_ORDER (a raced retry) — the server's ledger wins; re-sync and go on
            const st = await apiRaw(`/api/uploads/${init.uploadId}`);
            if (st.ok) {
              const state = (await st.json()) as { committedOffset: string };
              nextIdx = Math.floor(Number(state.committedOffset) / init.chunkSize);
              continue;
            }
          }
          if (!res.ok) throw await toApiError(res);
          nextIdx += 1;
          sent = end;
          const now = Date.now();
          const dt = (now - speed.t) / 1000;
          if (dt > 0.4) {
            speed.bps = speed.bps ? speed.bps * 0.6 + ((sent - speed.bytes) / dt) * 0.4 : (sent - speed.bytes) / dt;
            speed.t = now;
            speed.bytes = sent;
          }
          patch(key, { sentBytes: sent, speedBps: speed.bps });
        }

        // 4) complete — server re-verifies the physical file + byte total before the row exists
        const done = await apiRaw(`/api/uploads/${init.uploadId}/complete`, { method: 'POST' });
        if (!done.ok) throw await toApiError(done);
        patch(key, { status: 'done', sentBytes: file.size, speedBps: undefined });
        persist(tasksRef.current.filter((t) => t.key !== key));
        onUploadDone.current?.();
      } catch (err) {
        if (run.cancelled) return;
        const msg = err instanceof ApiRequestError || err instanceof Error ? err.message : 'Upload failed';
        patch(key, { status: 'error', error: msg });
      } finally {
        run.controller = null;
      }
    },
    [patch, persist]
  );

  const start = useCallback(
    (key: string, file: File, folderId: string | null) => {
      const run: RunState = { cancelled: false, paused: false, controller: null };
      runs.current.set(key, run);
      liveFiles.current.set(key, file);
      setTasks((ts) => {
        const next = ts.some((t) => t.key === key)
          ? ts.map((t) => (t.key === key ? { ...t, status: 'uploading' as const, error: undefined } : t))
          : [
              ...ts,
              {
                key,
                fileName: file.name,
                sizeBytes: file.size,
                mimeType: file.type || 'application/octet-stream',
                folderId,
                status: 'uploading' as const,
                sentBytes: 0,
              },
            ];
        persist(next);
        return next;
      });
      void runUpload(key, file, run);
    },
    [runUpload, persist]
  );

  const addFiles = useCallback(
    (files: File[] | FileList, folderId: string | null) => {
      for (const file of Array.from(files)) {
        // same name+size in a previous session ⇒ reuse its key → server-side resume
        const prior = loadStored().find((e) => e.fileName === file.name && e.sizeBytes === file.size);
        start(prior?.key ?? crypto.randomUUID(), file, folderId);
      }
    },
    [start]
  );

  const attachFile = useCallback(
    (key: string, file: File) => {
      setAwaitingFileFor(null);
      const t = tasksRef.current.find((x) => x.key === key);
      if (!t) return;
      if (file.name !== t.fileName || file.size !== t.sizeBytes) {
        patch(key, { status: 'error', error: 'That file does not match — pick the same file to resume.' });
        return;
      }
      start(key, file, t.folderId);
    },
    [start, patch]
  );

  const pause = useCallback(
    (key: string) => {
      const run = runs.current.get(key);
      if (run) {
        run.paused = true;
        run.controller?.abort();
      } else {
        patch(key, { status: 'paused' });
      }
    },
    [patch]
  );

  const resume = useCallback((key: string) => {
    const run = runs.current.get(key);
    if (run) {
      // in-session: the File object is still alive — re-enter the flow
      run.paused = false;
      const file = liveFiles.current.get(key);
      const t = tasksRef.current.find((x) => x.key === key);
      if (file && t) {
        patch(key, { status: 'uploading' });
        void runUpload(key, file, run);
      }
      return;
    }
    setAwaitingFileFor(key); // no live File (reload) → the dock opens a picker
  }, [patch, runUpload]);

  const retry = useCallback(
    (key: string) => {
      const run: RunState = { cancelled: false, paused: false, controller: null };
      runs.current.set(key, run);
      const file = liveFiles.current.get(key);
      if (file) {
        void runUpload(key, file, run);
      } else {
        setAwaitingFileFor(key);
        patch(key, { status: 'needs-file' });
      }
    },
    [runUpload, patch]
  );

  const cancel = useCallback(
    (key: string) => {
      const run = runs.current.get(key);
      const uploadId = tasksRef.current.find((t) => t.key === key)?.uploadId;
      if (run) {
        run.cancelled = true;
        run.controller?.abort();
      }
      runs.current.delete(key);
      liveFiles.current.delete(key);
      setAwaitingFileFor((a) => (a === key ? null : a));
      setTasks((ts) => {
        const next = ts.filter((t) => t.key !== key);
        persist(next);
        return next;
      });
      // server-side abort releases the reservation — best-effort; P0.5 GC is the backstop
      if (uploadId) void apiRaw(`/api/uploads/${uploadId}/abort`, { method: 'POST' }).catch(() => undefined);
    },
    [persist]
  );

  const clearFinished = useCallback(() => {
    setTasks((ts) => {
      const next = ts.filter((t) => t.status !== 'done' && t.status !== 'error');
      persist(next);
      return next;
    });
  }, [persist]);

  const value = useMemo<UploadsContextValue>(
    () => ({
      tasks,
      addFiles,
      pause,
      resume,
      retry,
      cancel,
      clearFinished,
      awaitingFileFor,
      attachFile,
      onUploadDone,
    }),
    [tasks, addFiles, pause, resume, retry, cancel, clearFinished, awaitingFileFor, attachFile]
  );

  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

export function useUploads(): UploadsContextValue {
  const ctx = useContext(UploadsContext);
  if (!ctx) throw new Error('useUploads must be used within <UploadsProvider>');
  return ctx;
}

// ---- shared formatting (dock + browser) ----

export function humanBytes(bytes: number | string): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function humanSpeed(bps: number | undefined): string {
  if (!bps || !Number.isFinite(bps)) return '';
  return `${humanBytes(Math.round(bps))}/s`;
}
