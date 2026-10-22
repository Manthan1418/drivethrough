'use client';

// MoveDialog — pick a destination folder. Lazy tree: each level loads on expand
// (the API lists one level per call), cycles are impossible by construction because
// the server rejects moving a folder into its own descendant (FOLDER_CYCLE).

import { useCallback, useEffect, useState } from 'react';
import { listFolders } from '@/client/files';
import { RetroButton } from '@/components/retro/controls';
import { RetroDialog } from '@/components/retro/dialog';
import { IconFolder } from '@/components/retro/icons';
import type { Folder } from '@drivethrough/contracts';

interface TreeNode {
  folder: Folder;
  children: Folder[] | null; // null = not loaded yet
  open: boolean;
}

export function MoveDialog({
  title,
  count,
  excludeFolderIds = [],
  onMove,
  onCancel,
}: {
  title: string;
  count: number;
  excludeFolderIds?: string[]; // a folder can't move into itself/descendants — hide them
  onMove: (folderId: string | null) => void;
  onCancel: () => void;
}) {
  const [roots, setRoots] = useState<Folder[] | null>(null);
  const [selected, setSelected] = useState<string | null | undefined>(undefined); // undefined = nothing picked

  useEffect(() => {
    let alive = true;
    void listFolders()
      .then((fs) => { if (alive) { setRoots(fs.filter((f) => !excludeFolderIds.includes(f.id))); setSelected(null); } })
      .catch(() => { if (alive) { setRoots([]); setSelected(null); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback((node: TreeNode, setNodes: (fn: (ns: TreeNode[]) => TreeNode[]) => void) => {
    if (node.open) {
      setNodes((ns) => ns.map((n) => (n.folder.id === node.folder.id ? { ...n, open: false } : n)));
      return;
    }
    if (node.children === null) {
      void listFolders({ parentId: node.folder.id }).then((kids) => {
        setNodes((ns) => ns.map((n) => (n.folder.id === node.folder.id ? { ...n, open: true, children: kids.filter((k) => !excludeFolderIds.includes(k.id)) } : n)));
      }).catch(() => setNodes((ns) => ns.map((n) => (n.folder.id === node.folder.id ? { ...n, open: true, children: [] } : n))));
    } else {
      setNodes((ns) => ns.map((n) => (n.folder.id === node.folder.id ? { ...n, open: true } : n)));
    }
  }, [excludeFolderIds]);

  return (
    <RetroDialog
      title={title}
      onClose={onCancel}
      width="w-[400px]"
      actions={
        <>
          <RetroButton onClick={onCancel}>Cancel</RetroButton>
          <RetroButton variant="primary" disabled={selected === undefined} onClick={() => onMove(selected ?? null)}>
            Move here
          </RetroButton>
        </>
      }
    >
      <p className="mb-2 text-[12px] text-ink-soft">
        Move {count} item{count === 1 ? '' : 's'} to:
      </p>
      <div className="bevel-sunken h-48 overflow-auto bg-face-field p-1">
        <TreeRow
          label="My Files (top level)"
          depth={0}
          selected={selected === null}
          onClick={() => setSelected(null)}
        />
        {roots !== null && roots.length === 0 && (
          <p className="p-2 text-[12px] text-ink-faint">No folders yet.</p>
        )}
        {roots && <TreeLevel nodes={roots.map((f) => ({ folder: f, children: null, open: false }))} onSelect={setSelected} onToggle={toggle} selected={selected} depth={1} />}
      </div>
    </RetroDialog>
  );
}

function TreeLevel({
  nodes,
  onSelect,
  onToggle,
  selected,
  depth,
}: {
  nodes: TreeNode[];
  onSelect: (id: string) => void;
  onToggle: (node: TreeNode, setNodes: (fn: (ns: TreeNode[]) => TreeNode[]) => void) => void;
  selected: string | null | undefined;
  depth: number;
}) {
  const [ns, setNs] = useState<TreeNode[]>(nodes);
  useEffect(() => setNs(nodes), [nodes]);
  return (
    <>
      {ns.map((node) => (
        <div key={node.folder.id}>
          <TreeRow
            label={node.folder.name}
            depth={depth}
            selected={selected === node.folder.id}
            expandable
            open={node.open}
            onClick={() => onSelect(node.folder.id)}
            onToggle={() => onToggle(node, setNs)}
          />
          {node.open && node.children && node.children.length > 0 && (
            <TreeLevel
              nodes={node.children.map((c) => ({ folder: c, children: null, open: false }))}
              onSelect={onSelect}
              onToggle={onToggle}
              selected={selected}
              depth={depth + 1}
            />
          )}
          {node.open && node.children !== null && node.children.length === 0 && (
            <p className="py-0.5 text-[11px] text-ink-faint" style={{ paddingLeft: 20 + depth * 14 }}>
              (empty)
            </p>
          )}
        </div>
      ))}
    </>
  );
}

function TreeRow({
  label,
  depth,
  selected,
  expandable,
  open,
  onClick,
  onToggle,
}: {
  label: string;
  depth: number;
  selected: boolean;
  expandable?: boolean;
  open?: boolean;
  onClick: () => void;
  onToggle?: () => void;
}) {
  return (
    <div
      className={`flex h-6 items-center gap-1 pr-1 text-[12px] ${selected ? 'bg-select text-select-ink' : 'text-ink hover:bg-face-hover'}`}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {expandable ? (
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          className={`retro-focus flex h-4 w-4 shrink-0 items-center justify-center text-[9px] leading-none ${selected ? 'text-select-ink' : 'text-ink'} bevel-thin-raised bg-face`}
        >
          {open ? '−' : '+'}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <button type="button" onClick={onClick} className="retro-focus flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <IconFolder size={14} />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
