'use client';

// Sidebar — the Win98 "program manager" column: logo, smart views, live storage meter,
// and (per the owner's brief) the ⚙ button that opens the Connections window.

import { useEffect, useState } from 'react';
import { useAuth } from '@/client/auth-context';
import { getStorageSummary } from '@/client/files';
import { humanBytes } from '@/client/uploads';
import { RetroButton, RetroProgress } from '@/components/retro/controls';
import { IconClock, IconFolder, IconGear, IconList, IconTrash } from '@/components/retro/icons';
import type { StorageSummary } from '@drivethrough/contracts';

export type ExplorerView = 'files' | 'recent' | 'trash' | 'activity';

const NAV: { id: ExplorerView; label: string; icon: React.ReactNode }[] = [
  { id: 'files', label: 'My Files', icon: <IconFolder size={16} /> },
  { id: 'recent', label: 'Recent', icon: <IconClock size={16} /> },
  { id: 'trash', label: 'Trash', icon: <IconTrash size={16} /> },
  { id: 'activity', label: 'Activity', icon: <IconList size={16} /> },
];

export function Sidebar({
  view,
  onNavigate,
  onOpenSettings,
  refreshKey = 0,
}: {
  view: ExplorerView;
  onNavigate: (v: ExplorerView) => void;
  onOpenSettings: () => void;
  refreshKey?: number;
}) {
  const { user, signOutUser } = useAuth();
  const [summary, setSummary] = useState<StorageSummary | null>(null);

  useEffect(() => {
    let alive = true;
    void getStorageSummary()
      .then((s) => { if (alive) setSummary(s); })
      .catch(() => { /* widget degrades to "—" */ });
    return () => { alive = false; };
  }, [refreshKey]);

  const used = summary ? Number(summary.usedBytes) : 0;
  const pct =
    summary && summary.totalBytes !== null && Number(summary.totalBytes) > 0
      ? Math.min(100, (used / Number(summary.totalBytes)) * 100)
      : null;

  return (
    <div className="flex h-full w-[208px] shrink-0 flex-col gap-2 p-2">
      {/* logo */}
      <div className="bevel-raised bg-face px-3 py-2.5">
        <p className="text-[15px] font-bold tracking-tight text-titlebar">DriveThrough</p>
        <p className="text-[10px] text-ink-soft">one drive · every account</p>
      </div>

      {/* nav */}
      <nav className="bevel-raised flex flex-col bg-face p-1" aria-label="Views">
        {NAV.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`retro-focus flex h-8 items-center gap-2 px-2 text-left text-[13px] transition-colors duration-100 ${
                active ? 'bg-select font-bold text-select-ink' : 'text-ink hover:bg-face-hover'
              }`}
            >
              {item.icon}
              {item.label}
              {item.id === 'trash' && <TrashCount />}
            </button>
          );
        })}
      </nav>

      {/* storage meter */}
      <div className="bevel-raised bg-face p-2.5">
        <p className="text-[11px] font-bold text-ink-soft">STORAGE</p>
        <RetroProgress className="mt-1.5" value={pct ?? (used > 0 ? 4 : 0)} tone={pct !== null && pct > 92 ? 'warn' : 'select'} />
        <p className="tnum mt-1.5 text-[11px] leading-snug text-ink">
          {summary === null ? '…' : (
            <>
              {humanBytes(summary.usedBytes)}
              {summary.totalBytes !== null ? <> of {humanBytes(summary.totalBytes)}</> : ' used'}
              <br />
              <span className="text-ink-soft">
                {summary.accountCount} drive{summary.accountCount === 1 ? '' : 's'}
                {summary.availableBytes !== null && <> · {humanBytes(summary.availableBytes)} free</>}
                {Number(summary.reservedBytes) > 0 && <> · {humanBytes(summary.reservedBytes)} reserved</>}
              </span>
            </>
          )}
        </p>
      </div>

      <div className="flex-1" />

      {/* user + settings */}
      <div className="bevel-raised flex items-center gap-2 bg-face p-2">
        <div className="bevel-sunken flex h-8 w-8 shrink-0 items-center justify-center bg-face-field text-[13px] font-bold text-titlebar">
          {(user?.email ?? '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold text-ink">{user?.displayName ?? user?.email ?? 'Signed in'}</p>
          <button
            type="button"
            className="text-[11px] text-ink-soft underline hover:text-ink"
            onClick={() => void signOutUser()}
          >
            sign out
          </button>
        </div>
        <RetroButton small aria-label="Settings & connections" title="Settings & connections" onClick={onOpenSettings}>
          <IconGear size={14} />
        </RetroButton>
      </div>
    </div>
  );
}

/** Little trash counter — loads lazily, stays quiet on error. */
function TrashCount() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { listFolders, listFiles } = await import('@/client/files');
        const [ds, fs] = await Promise.all([listFolders({ trashed: true }), listFiles({ trashed: true })]);
        if (alive) setCount(ds.length + fs.length);
      } catch { /* silent */ }
    })();
    return () => { alive = false; };
  }, []);
  if (!count) return null;
  return <span className="ml-auto text-[10px] opacity-80">{count}</span>;
}
