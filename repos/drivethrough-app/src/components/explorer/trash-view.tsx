'use client';

// TrashView — smart view over trashed files + folders (design.md §5.2: permanent delete
// lives ONLY here). Restore undoes the cascade marker; "delete forever" is irreversible
// and always double-confirmed.

import { useCallback, useEffect, useState } from 'react';
import { batchOp, listFiles, listFolders } from '@/client/files';
import { humanBytes } from '@/client/uploads';
import { RetroButton } from '@/components/retro/controls';
import { ConfirmDialog } from '@/components/retro/dialog';
import { IconAlert, IconFile, IconFolder, IconRestore, IconTrash } from '@/components/retro/icons';
import type { FileMeta, Folder } from '@drivethrough/contracts';

type TrashedRow = { kind: 'file'; item: FileMeta } | { kind: 'folder'; item: Folder };

export function TrashView({ refreshKey, onMutated }: { refreshKey: number; onMutated?: () => void }) {
  const [rows, setRows] = useState<TrashedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState<TrashedRow[] | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ds, fs] = await Promise.all([listFolders({ trashed: true }), listFiles({ trashed: true })]);
      const merged: TrashedRow[] = [
        ...fs.map((f) => ({ kind: 'file' as const, item: f })),
        ...ds.map((d) => ({ kind: 'folder' as const, item: d })),
      ];
      merged.sort((a, b) => new Date(b.item.deletedAt ?? 0).getTime() - new Date(a.item.deletedAt ?? 0).getTime());
      setRows(merged);
      setError(null);
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not load trash');
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = useCallback(
    async (op: 'restore' | 'delete', selection: TrashedRow[]) => {
      setBusy(true);
      try {
        await batchOp(op, {
          fileIds: selection.filter((r) => r.kind === 'file').map((r) => r.item.id),
          folderIds: selection.filter((r) => r.kind === 'folder').map((r) => r.item.id),
        });
        await load();
        onMutated?.();
      } catch (err) {
        setError((err as { message?: string }).message ?? 'Action failed');
      } finally {
        setBusy(false);
        setConfirmPurge(null);
        setConfirmEmpty(false);
      }
    },
    [load, onMutated]
  );

  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      <div className="flex items-center justify-between gap-2 pb-2">
        <p className="text-[12px] text-ink-soft">
          {rows === null ? 'Loading…' : `${rows.length} item${rows.length === 1 ? '' : 's'} in the Recycle Bin`}
        </p>
        {rows && rows.length > 0 && (
          <RetroButton small variant="danger" onClick={() => setConfirmEmpty(true)}>
            <IconTrash size={13} /> Empty Recycle Bin
          </RetroButton>
        )}
      </div>

      {error && (
        <p role="alert" className="bevel-thin-raised mb-2 flex items-center gap-2 bg-[#f8e6e6] p-2 text-[12px] text-danger">
          <IconAlert size={14} /> {error}
        </p>
      )}

      <div className="bevel-sunken min-h-0 flex-1 overflow-auto bg-face-field">
        {rows?.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <IconTrash size={36} />
            <p className="text-[13px] font-bold text-ink">The Recycle Bin is empty</p>
            <p className="text-[11px] text-ink-soft">Deleted files land here first — nothing is lost until you purge it.</p>
          </div>
        )}
        <ul>
          {rows?.map((r) => (
            <li
              key={`${r.kind}:${r.item.id}`}
              className="flex h-9 items-center gap-2 px-2.5 text-[13px] text-ink transition-colors duration-75 hover:bg-face-hover"
            >
              {r.kind === 'file' ? <IconFile size={16} mimeType={r.item.mimeType} /> : <IconFolder size={16} />}
              <span className="min-w-0 flex-1 truncate">{r.item.name}</span>
              <span className="tnum w-20 text-right text-[11px] text-ink-soft">
                {r.kind === 'file' ? humanBytes(r.item.sizeBytes) : 'folder'}
              </span>
              <span className="w-36 text-[11px] text-ink-soft">
                trashed {r.item.deletedAt ? new Date(r.item.deletedAt).toLocaleDateString() : '—'}
              </span>
              <RetroButton small onClick={() => void run('restore', [r])} disabled={busy}>
                <IconRestore size={12} /> Restore
              </RetroButton>
              <RetroButton small variant="danger" onClick={() => setConfirmPurge([r])} disabled={busy}>
                Delete forever
              </RetroButton>
            </li>
          ))}
        </ul>
      </div>

      {confirmPurge && (
        <ConfirmDialog
          title="Delete forever"
          message={
            <>
              Permanently delete <b>{confirmPurge[0]?.item.name}</b>?
              <br />
              <span className="text-[11px] text-danger">This removes the actual bytes from the drive. No undo.</span>
            </>
          }
          confirmLabel="Delete forever"
          danger
          busy={busy}
          onConfirm={() => void run('delete', confirmPurge)}
          onCancel={() => setConfirmPurge(null)}
        />
      )}
      {confirmEmpty && (
        <ConfirmDialog
          title="Empty Recycle Bin"
          message={
            <>
              Permanently delete all {rows?.length ?? 0} items?
              <br />
              <span className="text-[11px] text-danger">This removes the actual bytes from every drive. No undo.</span>
            </>
          }
          confirmLabel="Delete everything"
          danger
          busy={busy}
          onConfirm={() => void run('delete', rows ?? [])}
          onCancel={() => setConfirmEmpty(false)}
        />
      )}
    </div>
  );
}
