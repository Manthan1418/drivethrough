'use client';

// ActivityView — the audit timeline (design.md §5.1 /activity). Every sensitive action
// the backend records (audit_logs) renders here in plain retro speech.

import { useCallback, useEffect, useState } from 'react';
import { listActivity } from '@/client/files';
import { RetroButton } from '@/components/retro/controls';
import {
  IconAlert, IconFile, IconFolder, IconRestore, IconTrash, IconUpload,
} from '@/components/retro/icons';
import type { ActivityEvent } from '@drivethrough/contracts';

const VERB: Record<string, { text: (e: ActivityEvent) => string; icon: React.ReactNode }> = {
  'upload.complete': { text: (e) => `Uploaded “${nameOf(e)}”${sizeOf(e)}`, icon: <IconUpload size={14} /> },
  'file.rename': { text: (e) => `Renamed a file to “${nameOf(e)}”`, icon: <IconFile size={14} /> },
  'file.move': { text: () => 'Moved a file', icon: <IconFile size={14} /> },
  'file.trash': { text: (e) => `Moved “${nameOf(e)}” to the Recycle Bin`, icon: <IconTrash size={14} /> },
  'file.restore': { text: (e) => `Restored “${nameOf(e)}”`, icon: <IconRestore size={14} /> },
  'file.delete': { text: (e) => `Permanently deleted “${nameOf(e)}”`, icon: <IconTrash size={14} /> },
  'folder.create': { text: (e) => `Created folder “${nameOf(e)}”`, icon: <IconFolder size={14} /> },
  'folder.rename': { text: (e) => `Renamed a folder to “${nameOf(e)}”`, icon: <IconFolder size={14} /> },
  'folder.move': { text: () => 'Moved a folder', icon: <IconFolder size={14} /> },
  'folder.trash': { text: (e) => `Moved folder “${nameOf(e)}” to the Recycle Bin`, icon: <IconTrash size={14} /> },
  'folder.restore': { text: (e) => `Restored folder “${nameOf(e)}”`, icon: <IconRestore size={14} /> },
  'folder.delete': { text: (e) => `Permanently deleted folder “${nameOf(e)}”`, icon: <IconTrash size={14} /> },
  'folder.batch.delete': { text: (e) => `Bulk action: ${metaOf(e, 'op')}`, icon: <IconTrash size={14} /> },
};

function nameOf(e: ActivityEvent): string {
  const m = e.metadata as { name?: string } | null;
  return m?.name ?? 'item';
}
function sizeOf(e: ActivityEvent): string {
  const b = Number((e.metadata as { sizeBytes?: string } | null)?.sizeBytes ?? 0);
  if (!b) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return ` (${(v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1))} ${units[i]})`;
}
function metaOf(e: ActivityEvent, key: string): string {
  const m = e.metadata as Record<string, unknown> | null;
  return String(m?.[key] ?? '…');
}

export function ActivityView({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEvents(await listActivity());
      setError(null);
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not load activity');
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      <div className="flex items-center justify-between pb-2">
        <p className="text-[12px] text-ink-soft">What happened, most recent first</p>
        <RetroButton small onClick={() => void load()}>Refresh</RetroButton>
      </div>
      {error && (
        <p role="alert" className="bevel-thin-raised mb-2 flex items-center gap-2 bg-[#f8e6e6] p-2 text-[12px] text-danger">
          <IconAlert size={14} /> {error}
        </p>
      )}
      <div className="bevel-sunken min-h-0 flex-1 overflow-auto bg-face-field">
        {events?.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <IconFolder size={36} />
            <p className="text-[13px] font-bold text-ink">Nothing has happened yet</p>
            <p className="text-[11px] text-ink-soft">Uploads, renames and deletes will show up here.</p>
          </div>
        )}
        <ul>
          {events?.map((e) => {
            const v = VERB[e.action];
            return (
              <li key={e.id} className="flex h-8 items-center gap-2.5 px-2.5 text-[12px] text-ink odd:bg-black/[0.025]">
                <span className="shrink-0">{v ? v.icon : <IconAlert size={14} />}</span>
                <span className="min-w-0 flex-1 truncate">{v ? v.text(e) : e.action}</span>
                <span className="tnum shrink-0 text-[11px] text-ink-soft">{timeLabel(e.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}
