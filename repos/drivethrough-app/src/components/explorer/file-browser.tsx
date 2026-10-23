'use client';

// FileBrowser — the product's center of gravity (design.md §5.2), wearing Win98:
// details-view rows with navy selection, right-click context menus, breadcrumb address
// bar, drag-drop upload target, skeleton/empty/error triad, inline rename, move dialog.

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { listFiles, listFolders, batchOp, createFolder, updateFile, updateFolder } from '@/client/files';
import { humanBytes } from '@/client/uploads';
import { RetroButton, RetroInput } from '@/components/retro/controls';
import { RetroMenu, type MenuItem } from '@/components/retro/menu';
import { ConfirmDialog, RetroDialog } from '@/components/retro/dialog';
import {
  IconAlert, IconFile, IconFolder, IconMove, IconNewFolder, IconRename, IconSearch, IconShare, IconTrash, IconUpload,
} from '@/components/retro/icons';
import { PreviewWindow, downloadFileMeta, type PreviewFile } from './preview';
import { MoveDialog } from './move-dialog';
import { ShareDialog } from './share-dialog';
import type { FileMeta, Folder } from '@drivethrough/contracts';

type SelectionKey = string; // `f:<id>` | `d:<id>`
type SortKey = 'name' | 'size' | 'modified';

export interface Crumb {
  id: string;
  name: string;
}

export function FileBrowser({
  mode,
  folderId,
  path,
  onOpenFolder,
  onCrumb,
  refreshKey,
  onUploadFiles,
  onMutated,
}: {
  mode: 'files' | 'recent';
  folderId: string | null;
  path: Crumb[];
  onOpenFolder: (folder: Crumb) => void;
  onCrumb: (index: number) => void; // -1 = root
  refreshKey: number;
  onUploadFiles: (files: File[]) => void;
  onMutated?: () => void; // sidebar counters + quota refresh hook
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selection, setSelection] = useState<Set<SelectionKey>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'new-folder' }
    | { kind: 'rename'; target: SelectionKey }
    | { kind: 'move'; keys: SelectionKey[] }
    | { kind: 'trash'; keys: SelectionKey[] }
    | { kind: 'share'; target: SelectionKey }
    | null
  >(null);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const fileInput = useRef<HTMLInputElement>(null);
  const lastClicked = useRef<string | null>(null);

  // debounce search typing
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === 'recent') {
        setFiles(await listFiles({ recent: true }));
        setFolders([]);
      } else if (debouncedQ) {
        setFiles(await listFiles({ q: debouncedQ })); // global search — not folder-scoped
        setFolders([]);
      } else {
        const [ds, fs] = await Promise.all([listFolders({ parentId: folderId }), listFiles({ folderId })]);
        setFolders(ds);
        setFiles(fs);
      }
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not load this folder');
    } finally {
      setLoading(false);
    }
  }, [mode, folderId, debouncedQ]);

  useEffect(() => {
    void load();
    setSelection(new Set());
  }, [load, refreshKey]);

  // ---- selection ----
  const sortedFiles = useMemo(() => {
    const arr = [...files];
    const dir = sort.dir;
    arr.sort((a, b) => {
      if (sort.key === 'size') return (Number(a.sizeBytes) - Number(b.sizeBytes)) * dir;
      if (sort.key === 'modified') return (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()) * dir;
      return a.name.localeCompare(b.name) * dir;
    });
    return arr;
  }, [files, sort]);

  // row order must match the DOM order or shift-range selection lands on the wrong rows
  const rowKeys = useMemo(() => {
    const fKeys = folders.map((d) => `d:${d.id}` as SelectionKey);
    const lKeys = sortedFiles.map((f) => `f:${f.id}` as SelectionKey);
    return [...fKeys, ...lKeys];
  }, [folders, sortedFiles]);

  const toggleSelect = useCallback((key: SelectionKey, additive: boolean, range: boolean) => {
    setSelection((prev) => {
      const next = new Set(additive ? prev : []);
      if (range && lastClicked.current) {
        const a = rowKeys.indexOf(lastClicked.current);
        const b = rowKeys.indexOf(key);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) {
            const rk = rowKeys[i];
            if (rk !== undefined) next.add(rk);
          }
          return next;
        }
      }
      if (next.has(key) && additive) next.delete(key);
      else next.add(key);
      lastClicked.current = key;
      return next;
    });
    if (!range) lastClicked.current = key;
  }, [rowKeys]);

  // ---- actions ----
  const refresh = useCallback(() => {
    void load();
    onMutated?.();
  }, [load, onMutated]);

  const doRename = useCallback(
    async (key: SelectionKey, name: string) => {
      setBusy(true);
      try {
        if (key.startsWith('d:')) await updateFolder(key.slice(2), { name });
        else await updateFile(key.slice(2), { name });
        refresh();
      } catch (err) {
        setError((err as { message?: string }).message ?? 'Rename failed');
      } finally {
        setBusy(false);
        setDialog(null);
      }
    },
    [refresh]
  );

  const doMove = useCallback(
    async (keys: SelectionKey[], dest: string | null) => {
      setBusy(true);
      try {
        const fileIds = keys.filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
        const folderIds = keys.filter((k) => k.startsWith('d:')).map((k) => k.slice(2));
        await batchOp('move', { fileIds, folderIds, folderId: dest });
        setSelection(new Set());
        refresh();
      } catch (err) {
        setError((err as { message?: string }).message ?? 'Move failed');
      } finally {
        setBusy(false);
        setDialog(null);
      }
    },
    [refresh]
  );

  const doTrash = useCallback(
    async (keys: SelectionKey[]) => {
      setBusy(true);
      try {
        const fileIds = keys.filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
        const folderIds = keys.filter((k) => k.startsWith('d:')).map((k) => k.slice(2));
        await batchOp('trash', { fileIds, folderIds });
        setSelection(new Set());
        refresh();
      } catch (err) {
        setError((err as { message?: string }).message ?? 'Could not move to trash');
      } finally {
        setBusy(false);
        setDialog(null);
      }
    },
    [refresh]
  );

  const doDownload = useCallback(async (f: FileMeta) => {
    try { await downloadFileMeta(f); } catch (err) { setError((err as Error).message); }
  }, []);

  const openItem = useCallback(
    (key: SelectionKey) => {
      if (key.startsWith('d:')) {
        const f = folders.find((d) => d.id === key.slice(2));
        if (f) onOpenFolder({ id: f.id, name: f.name });
      } else {
        const f = files.find((x) => x.id === key.slice(2));
        if (f) setPreview(f);
      }
    },
    [folders, files, onOpenFolder]
  );

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || menu || preview) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') setSelection(new Set());
      if (e.key === 'Delete' && selection.size > 0) {
        e.preventDefault();
        setDialog({ kind: 'trash', keys: [...selection] });
      }
      if (e.key === 'F2' && selection.size === 1) {
        e.preventDefault();
        const only = [...selection][0];
        if (only) setDialog({ kind: 'rename', target: only });
      }
      if (e.key === 'Enter' && selection.size === 1) {
        e.preventDefault();
        const only = [...selection][0];
        if (only) openItem(only);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, dialog, menu, preview, openItem]);

  // ---- context menus ----
  const menuFor = useCallback(
    (key: SelectionKey): MenuItem[] => {
      if (!selection.has(key)) toggleSelect(key, false, false);
      const isFolder = key.startsWith('d:');
      const one: MenuItem[] = [
        { label: 'Open', onClick: () => openItem(key) },
        ...(isFolder ? [] : [{ label: 'Save to disk', onClick: () => { const f = files.find((x) => `f:${x.id}` === key); if (f) void doDownload(f); } }]),
        ...(isFolder ? [] : [{ label: 'Share link…', icon: <IconShare size={14} />, onClick: () => setDialog({ kind: 'share', target: key }) }]),
        { label: 'Rename…', icon: <IconRename size={14} />, separatorBefore: true, onClick: () => setDialog({ kind: 'rename', target: key }) },
        { label: 'Move to…', icon: <IconMove size={14} />, onClick: () => setDialog({ kind: 'move', keys: [...(selection.size > 1 ? selection : new Set([key]))] }) },
        { label: 'Move to Trash', icon: <IconTrash size={14} />, danger: true, separatorBefore: true, onClick: () => setDialog({ kind: 'trash', keys: [...(selection.size > 1 ? selection : new Set([key]))] }) },
      ];
      return one;
    },
    [selection, toggleSelect, openItem, files, doDownload]
  );

  const bgMenu = useCallback(
    (x: number, y: number): MenuItem[] => [
      { label: 'New folder…', icon: <IconNewFolder size={14} />, disabled: mode !== 'files' || !!debouncedQ, onClick: () => setDialog({ kind: 'new-folder' }) },
      { label: 'Upload files…', icon: <IconUpload size={14} />, onClick: () => fileInput.current?.click() },
      { label: 'Refresh', separatorBefore: true, onClick: refresh },
    ],
    [mode, debouncedQ, refresh]
  );

  // ---- rendering ----
  const selectedFiles = files.filter((f) => selection.has(`f:${f.id}`));
  const searching = mode === 'files' && !!debouncedQ;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 p-2 pb-1.5">
        {mode === 'files' && (
          <div className="bevel-sunken flex h-8 min-w-0 flex-1 items-center gap-1 overflow-x-auto bg-face-field px-1.5">
            <button
              type="button"
              onClick={() => onCrumb(-1)}
              className={`retro-focus shrink-0 px-1 text-[12px] ${searching ? 'text-ink-faint' : 'text-titlebar hover:underline'}`}
              disabled={searching}
            >
              My Files
            </button>
            {path.map((c, i) => (
              <span key={c.id} className="flex shrink-0 items-center">
                <span className="px-0.5 text-ink-faint">▸</span>
                <button
                  type="button"
                  onClick={() => onCrumb(i)}
                  disabled={searching}
                  className="retro-focus px-1 text-[12px] text-titlebar hover:underline"
                >
                  {c.name}
                </button>
              </span>
            ))}
            {searching && (
              <span className="flex min-w-0 items-center gap-1 px-1 text-[12px] text-ink">
                <IconSearch size={12} /> results for “{debouncedQ}”
              </span>
            )}
          </div>
        )}
        <div className="bevel-sunken flex h-8 w-44 items-center gap-1.5 bg-face-field px-2">
          <IconSearch size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files…  ( / )"
            aria-label="Search files"
            className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        {mode === 'files' && (
          <>
            <RetroButton small onClick={() => setDialog({ kind: 'new-folder' })} disabled={!!debouncedQ}>
              <IconNewFolder size={14} /> New folder
            </RetroButton>
            <RetroButton small variant="primary" onClick={() => fileInput.current?.click()}>
              <IconUpload size={14} /> Upload
            </RetroButton>
          </>
        )}
      </div>

      {/* column headers (details view) */}
      <div className="mx-2 flex h-6 items-center gap-2 bevel-thin-pressed bg-face px-2 text-[11px] font-bold text-ink-soft select-none">
        <SortHead label="Name" k="name" sort={sort} setSort={setSort} className="min-w-0 flex-1" />
        <SortHead label="Size" k="size" sort={sort} setSort={setSort} className="w-20 text-right" />
        <span className="w-24">Type</span>
        <SortHead label="Modified" k="modified" sort={sort} setSort={setSort} className="w-32" />
        <span className="w-10 text-center">Drv</span>
      </div>

      {/* list */}
      <div
        className={`relative mx-2 mt-1 mb-2 min-h-0 flex-1 bevel-sunken bg-face-field ${dragging ? 'outline outline-2 outline-titlebar' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) onUploadFiles(Array.from(e.dataTransfer.files));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, items: bgMenu(e.clientX, e.clientY) });
        }}
      >
        {loading && <Skeletons />}
        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <IconAlert size={28} />
            <p className="text-[13px] text-danger">{error}</p>
            <RetroButton small onClick={refresh}>Try again</RetroButton>
          </div>
        )}
        {!loading && !error && rowKeys.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <IconFolder size={40} open />
            <p className="text-[13px] font-bold text-ink">
              {searching ? `Nothing matches “${debouncedQ}”` : mode === 'recent' ? 'No files yet' : 'This folder is empty'}
            </p>
            <p className="max-w-64 text-[11px] leading-snug text-ink-soft">
              {searching ? 'Try a different word — search looks across every folder.' : 'Drag files anywhere in this panel, or press Upload.'}
            </p>
          </div>
        )}
        {!loading && !error && (
          <div className="h-full overflow-auto" onClick={(e) => { if (e.target === e.currentTarget) setSelection(new Set()); }}>
            {mode !== 'files' && (
              <p className="px-3 pt-2 text-[11px] font-bold text-ink-soft">
                {searching ? `${sortedFiles.length} match${sortedFiles.length === 1 ? '' : 'es'} across all folders` : 'Most recently modified first'}
              </p>
            )}
            <ul className="pb-2">
              {mode === 'files' && !searching && folders.map((d) => (
                <Row
                  key={`d:${d.id}`}
                  icon={<IconFolder size={16} />}
                  name={d.name}
                  size="—"
                  type="Folder"
                  updated={null}
                  drv=""
                  selected={selection.has(`d:${d.id}`)}
                  onClick={(e) => toggleSelect(`d:${d.id}`, e.metaKey || e.ctrlKey, e.shiftKey)}
                  onDoubleClick={() => openItem(`d:${d.id}`)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(`d:${d.id}`) }); }}
                />
              ))}
              {sortedFiles.map((f) => (
                <Row
                  key={`f:${f.id}`}
                  icon={<IconFile size={16} mimeType={f.mimeType} />}
                  name={f.name}
                  size={humanBytes(f.sizeBytes)}
                  type={typeLabel(f.mimeType)}
                  updated={f.updatedAt}
                  drv={f.provider === 'google_drive' ? 'G' : '?'}
                  selected={selection.has(`f:${f.id}`)}
                  onClick={(e) => toggleSelect(`f:${f.id}`, e.metaKey || e.ctrlKey, e.shiftKey)}
                  onDoubleClick={() => openItem(`f:${f.id}`)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: menuFor(`f:${f.id}`) }); }}
                />
              ))}
            </ul>
          </div>
        )}

        {/* selection action bar */}
        {selection.size > 0 && (
          <div className="anim-window absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 bevel-raised bg-face px-2 py-1.5">
            <span className="text-[12px] font-bold text-ink">{selection.size} selected</span>
            <RetroButton small onClick={() => setDialog({ kind: 'move', keys: [...selection] })}>
              <IconMove size={13} /> Move
            </RetroButton>
            {selectedFiles.length > 0 && (
              <RetroButton small onClick={() => void selectedFiles.forEach((f) => void doDownload(f))}>
                Save
              </RetroButton>
            )}
            <RetroButton small variant="danger" onClick={() => setDialog({ kind: 'trash', keys: [...selection] })}>
              <IconTrash size={13} /> Trash
            </RetroButton>
            <RetroButton small variant="quiet" onClick={() => setSelection(new Set())}>✕</RetroButton>
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-select/10">
            <p className="bevel-raised bg-face px-4 py-2 text-[13px] font-bold text-ink">Drop to upload here</p>
          </div>
        )}
      </div>

      {/* hidden file input for uploads */}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onUploadFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />

      {/* menus + dialogs + preview */}
      {menu && <RetroMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'new-folder' && (
        <NamePrompt
          title="New folder"
          label="Folder name"
          initial=""
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(name) =>
            void (async () => {
              setBusy(true);
              try {
                await createFolder(name, folderId);
                refresh();
              } catch (err) {
                setError((err as { message?: string }).message ?? 'Could not create folder');
              } finally {
                setBusy(false);
                setDialog(null);
              }
            })()
          }
        />
      )}

      {dialog?.kind === 'rename' && (
        <NamePrompt
          title="Rename"
          label="New name"
          initial={
            dialog.target.startsWith('d:')
              ? folders.find((d) => d.id === dialog.target.slice(2))?.name ?? ''
              : files.find((f) => f.id === dialog.target.slice(2))?.name ?? ''
          }
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(name) => void doRename(dialog.target, name)}
        />
      )}

      {dialog?.kind === 'move' && (
        <MoveDialog
          title="Move"
          count={dialog.keys.length}
          excludeFolderIds={dialog.keys.filter((k) => k.startsWith('d:')).map((k) => k.slice(2))}
          onMove={(dest) => void doMove(dialog.keys, dest)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'trash' && (
        <ConfirmDialog
          title="Recycle"
          message={
            <>
              Move <b>{dialog.keys.length}</b> item{dialog.keys.length === 1 ? '' : 's'} to the Recycle Bin?
              <br />
              <span className="text-[11px] text-ink-soft">You can restore from Trash, or delete forever there.</span>
            </>
          }
          confirmLabel="Move to Trash"
          danger
          busy={busy}
          onConfirm={() => void doTrash(dialog.keys)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.kind === 'share' &&
        (() => {
          const f = files.find((x) => x.id === dialog.target.slice(2));
          return f ? <ShareDialog file={f} onClose={() => setDialog(null)} /> : null;
        })()}

      {preview && <PreviewWindow file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- row + bits

function Row({
  icon, name, size, type, updated, drv, selected, onClick, onDoubleClick, onContextMenu,
}: {
  icon: React.ReactNode;
  name: string;
  size: string;
  type: string;
  updated: string | null;
  drv: string;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <li
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        // the list container also opens the background menu — don't let the
        // bubbled event overwrite this row's menu
        e.stopPropagation();
        onContextMenu(e);
      }}
      className={`flex h-7 cursor-default items-center gap-2 px-2 text-[13px] transition-colors duration-75 ${
        selected ? 'bg-select text-select-ink' : 'text-ink hover:bg-face-hover'
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon}
        <span className="truncate">{name}</span>
      </span>
      <span className="tnum w-20 text-right">{size}</span>
      <span className={`w-24 truncate text-[11px] ${selected ? 'text-select-ink/80' : 'text-ink-soft'}`}>{type}</span>
      <span className={`w-32 text-[11px] ${selected ? 'text-select-ink/80' : 'text-ink-soft'}`}>
        {updated ? new Date(updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
      </span>
      <span className={`w-10 text-center text-[11px] font-bold ${selected ? 'text-select-ink' : 'text-ink-soft'}`}>{drv}</span>
    </li>
  );
}

function SortHead({
  label, k, sort, setSort, className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  setSort: (s: { key: SortKey; dir: 1 | -1 }) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => setSort({ key: k, dir: active && sort.dir === 1 ? -1 : 1 })}
      className={`retro-focus text-left font-bold ${active ? 'text-ink' : ''} ${className ?? ''}`}
    >
      {label}
      {active && <span> {sort.dir === 1 ? '▲' : '▼'}</span>}
    </button>
  );
}

function Skeletons() {
  return (
    <div className="space-y-1.5 p-2">
      {Array.from({ length: 7 }).map((_, i) => (
        <div
          key={i}
          className="h-6 animate-pulse bevel-thin-raised bg-face"
          style={{ animationDelay: `${i * 70}ms`, width: `${92 - i * 6}%` }}
        />
      ))}
    </div>
  );
}

function NamePrompt({
  title, label, initial, onSubmit, onCancel, busy,
}: {
  title: string;
  label: string;
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RetroDialog
      title={title}
      onClose={onCancel}
      width="w-[320px]"
      actions={
        <>
          <RetroButton onClick={onCancel}>Cancel</RetroButton>
          <RetroButton variant="primary" disabled={!value.trim() || busy} onClick={() => onSubmit(value.trim())}>
            {busy ? '…' : 'OK'}
          </RetroButton>
        </>
      }
    >
      <form
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}
        className="space-y-2"
      >
        <span className="text-[12px] font-bold">{label}</span>
        <RetroInput
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
      </form>
    </RetroDialog>
  );
}

function typeLabel(mime: string): string {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'Image';
  if (m.startsWith('video/')) return 'Video';
  if (m.startsWith('audio/')) return 'Audio';
  if (m === 'application/pdf') return 'PDF document';
  if (/zip|compressed|x-tar|7z|rar/.test(m)) return 'Archive';
  if (m.startsWith('text/') || /json|xml|csv|javascript/.test(m)) return 'Text document';
  return m.split('/').pop() ?? 'File';
}
