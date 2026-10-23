'use client';

// / — the explorer shell (the product's home). Win98 desktop: sidebar program-manager
// column, one big window for the active view, the upload dock floating bottom-right,
// and the ⚙ → Connections window (owner brief 2026-10-22). View + folder ride in the
// URL for shareable state; a deep-linked folder shows root-level crumbs only until the
// user re-navigates (no ancestor endpoint yet — P0.5 with keyset paging).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/client/auth-context';
import { UploadsProvider, useUploads } from '@/client/uploads';
import { Sidebar, type ExplorerView } from '@/components/explorer/sidebar';
import { FileBrowser, type Crumb } from '@/components/explorer/file-browser';
import { TrashView } from '@/components/explorer/trash-view';
import { ActivityView } from '@/components/explorer/activity-view';
import { UploadDock } from '@/components/explorer/upload-dock';
import { KeysView } from '@/components/explorer/keys-view';
import { RetroWindow } from '@/components/retro/window';
import { ConnectionsPanel } from '@/components/settings/connections';
import { RetroButton } from '@/components/retro/controls';
import { IconFolder, IconGear, IconKey, IconList, IconTrash, IconX } from '@/components/retro/icons';

const TITLES: Record<ExplorerView, string> = {
  files: 'My Files',
  recent: 'Recent',
  trash: 'Recycle Bin',
  activity: 'Activity Log',
  keys: 'API Keys',
};
const VIEW_ICONS: Record<ExplorerView, React.ReactNode> = {
  files: <IconFolder size={14} />,
  recent: <IconFolder size={14} />,
  trash: <IconTrash size={14} />,
  activity: <IconList size={14} />,
  keys: <IconKey size={14} />,
};

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/sign-in');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <div className="bevel-raised bg-face px-6 py-4 text-[13px] text-ink">Loading DriveThrough…</div>
      </main>
    );
  }
  return (
    <UploadsProvider>
      <Explorer />
    </UploadsProvider>
  );
}

function Explorer() {
  const [view, setView] = useState<ExplorerView>('files');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const { onUploadDone, addFiles } = useUploads();

  // refresh hooks (upload completion + mutations)
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  onUploadDone.current = bump;

  // URL state (write) — replaceState keeps back-button sane
  useEffect(() => {
    const p = new URLSearchParams();
    if (view !== 'files') p.set('view', view);
    if (view === 'files' && folderId) p.set('folder', folderId);
    const qs = p.toString();
    window.history.replaceState({}, '', `/${qs ? `?${qs}` : ''}`);
  }, [view, folderId]);

  // URL state (read once — deep link)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get('view');
    if (v === 'recent' || v === 'trash' || v === 'activity' || v === 'keys') setView(v);
    const f = p.get('folder');
    if (f) setFolderId(f);
  }, []);

  const navigate = useCallback((v: ExplorerView) => {
    setView(v);
    // clicking "My Files" while inside a folder returns to the root — without this
    // the button looks dead (the view is already 'files' and the folder never resets)
    if (v === 'files') {
      setFolderId(null);
      setPath([]);
    }
    setSidebarOpen(false);
  }, []);

  const openFolder = useCallback((crumb: Crumb) => {
    setPath((p) => [...p, crumb]);
    setFolderId(crumb.id);
  }, []);

  const crumbTo = useCallback((index: number) => {
    setPath((p) => (index < 0 ? [] : p.slice(0, index + 1)));
    setFolderId(index < 0 ? null : path[index]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* mobile top strip */}
      <div className="flex items-center gap-2 p-2 md:hidden">
        <RetroButton small onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</RetroButton>
        <p className="text-[13px] font-bold text-white drop-shadow">DriveThrough</p>
      </div>

      {/* sidebar: fixed column on desktop, slide-over drawer on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)] md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0 shadow-[4px_0_16px_rgba(0,0,0,0.25)]' : '-translate-x-full'
        }`}
      >
        <div className="h-full bg-transparent md:bg-transparent">
          <Sidebar view={view} onNavigate={navigate} onOpenSettings={() => { setSettingsOpen(true); setSidebarOpen(false); }} refreshKey={refreshKey} />
        </div>
      </aside>
      {sidebarOpen && (
        <div className="anim-fade fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* main window */}
      <main className="min-w-0 flex-1 p-2 md:p-3">
        <RetroWindow
          title={`DriveThrough — ${TITLES[view]}`}
          icon={VIEW_ICONS[view]}
          draggable={false}
          className="flex h-[calc(100dvh-88px)] flex-col md:h-[calc(100dvh-24px)]"
        >
          <div className="min-h-0 flex-1">
            {view === 'files' && (
              <FileBrowser
                mode="files"
                folderId={folderId}
                path={path}
                onOpenFolder={openFolder}
                onCrumb={crumbTo}
                refreshKey={refreshKey}
                onUploadFiles={(files) => addFiles(files, folderId)}
                onMutated={bump}
              />
            )}
            {view === 'recent' && (
              <FileBrowser
                mode="recent"
                folderId={null}
                path={[]}
                onOpenFolder={() => undefined}
                onCrumb={() => undefined}
                refreshKey={refreshKey}
                onUploadFiles={() => undefined}
                onMutated={bump}
              />
            )}
            {view === 'trash' && <TrashView refreshKey={refreshKey} onMutated={bump} />}
            {view === 'activity' && <ActivityView refreshKey={refreshKey} />}
            {view === 'keys' && <KeysView refreshKey={refreshKey} />}
          </div>
        </RetroWindow>
      </main>

      {/* floating pieces */}
      <UploadDock />
      {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** Indirection removed — addFiles comes from the provider at the Explorer level. */

function SettingsWindow({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="anim-fade fixed inset-0 z-40 flex items-center justify-center bg-black/25 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <RetroWindow
        title="Settings — Connections"
        icon={<IconGear size={14} />}
        onClose={onClose}
        draggable
        className="max-h-[86dvh] w-auto max-w-full overflow-auto"
        decorations={false}
      >
        <ConnectionsPanel />
        <div className="flex justify-end px-1 pb-1">
          <RetroButton small onClick={onClose} aria-label="Close settings"><IconX size={11} /> Close</RetroButton>
        </div>
      </RetroWindow>
    </div>
  );
}
