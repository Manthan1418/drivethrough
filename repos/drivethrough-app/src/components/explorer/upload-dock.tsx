'use client';

// UploadDock — the bottom-right "Copying…" window (design.md §5.2 upload dock, kept from
// 9Drive's progress panel). Per-file progress + speed, pause/resume/cancel, and the
// resume-after-reload flow: a task from a dead tab asks for its file to be re-picked.

import { useEffect, useRef, useState } from 'react';
import { humanBytes, humanSpeed, useUploads, type UploadTask } from '@/client/uploads';
import { RetroButton, RetroProgress } from '@/components/retro/controls';
import { RetroWindow } from '@/components/retro/window';
import { IconAlert, IconCheck, IconFile, IconPause, IconPlay, IconX } from '@/components/retro/icons';

export function UploadDock() {
  const { tasks, pause, resume, retry, cancel, clearFinished, awaitingFileFor, attachFile } = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // resume-after-reload: the manager is waiting for the matching file
  useEffect(() => {
    if (awaitingFileFor) picker.current?.click();
  }, [awaitingFileFor]);

  if (tasks.length === 0) {
    return (
      <input ref={picker} type="file" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0];
        if (f && awaitingFileFor) attachFile(awaitingFileFor, f);
        e.target.value = '';
      }} />
    );
  }

  const active = tasks.filter((t) => t.status === 'uploading' || t.status === 'queued');
  const totalPct =
    tasks.reduce((acc, t) => acc + Math.min(1, t.sentBytes / Math.max(1, t.sizeBytes)), 0) / tasks.length;
  const aggregate = active.reduce((acc, t) => acc + (t.speedBps ?? 0), 0);

  return (
    <>
      <input ref={picker} type="file" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0];
        if (f && awaitingFileFor) attachFile(awaitingFileFor, f);
        e.target.value = '';
      }} />
      <div className="pointer-events-none fixed right-3 bottom-3 z-30 w-80 max-w-[calc(100vw-24px)]">
        <div className="pointer-events-auto">
          <RetroWindow
            title={collapsed ? `Copying… (${tasks.length})` : 'Copying…'}
            onClose={() => setCollapsed(true)}
            draggable
            decorations={false}
            className="w-full"
            titleSuffix={
              <button
                type="button"
                aria-label={collapsed ? 'Expand' : 'Collapse'}
                onClick={() => setCollapsed((c) => !c)}
                className="bevel-raised mr-0.5 flex h-[18px] w-[20px] items-center justify-center bg-face text-[9px] active:bevel-pressed"
              >
                {collapsed ? '▲' : '─'}
              </button>
            }
          >
            {!collapsed && (
              <>
                {!tasks.every((t) => t.status === 'done' || t.status === 'error') && (
                  <div className="mb-2 flex items-center gap-2">
                    <RetroProgress value={totalPct * 100} className="flex-1" />
                    <span className="tnum w-24 text-right text-[11px] text-ink-soft">
                      {aggregate > 0 ? humanSpeed(aggregate) : `${Math.round(totalPct * 100)}%`}
                    </span>
                  </div>
                )}
                <ul className="max-h-56 space-y-1.5 overflow-auto pr-0.5">
                  {tasks.map((t) => (
                    <TaskRow
                      key={t.key}
                      task={t}
                      onPause={() => pause(t.key)}
                      onResume={() => resume(t.key)}
                      onRetry={() => retry(t.key)}
                      onCancel={() => cancel(t.key)}
                      onPick={() => picker.current?.click()}
                    />
                  ))}
                </ul>
                {tasks.some((t) => t.status === 'done' || t.status === 'error') && (
                  <div className="mt-2 flex justify-end">
                    <RetroButton small variant="quiet" onClick={clearFinished}>Clear finished</RetroButton>
                  </div>
                )}
              </>
            )}
          </RetroWindow>
        </div>
      </div>
    </>
  );
}

function TaskRow({
  task, onPause, onResume, onRetry, onCancel, onPick,
}: {
  task: UploadTask;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onPick: () => void;
}) {
  const pct = task.sizeBytes > 0 ? Math.min(100, (task.sentBytes / task.sizeBytes) * 100) : 0;
  return (
    <li className="bevel-thin-raised bg-face p-1.5">
      <div className="flex items-center gap-1.5">
        {task.status === 'done' ? <IconCheck size={14} /> : task.status === 'error' ? <IconAlert size={14} /> : <IconFile size={14} />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-ink" title={task.fileName}>
          {task.fileName}
        </span>
        {task.status === 'uploading' && (
          <button type="button" aria-label="Pause" onClick={onPause} className="retro-focus bevel-thin-raised bg-face p-0.5 hover:bg-face-hover">
            <IconPause size={11} />
          </button>
        )}
        {(task.status === 'paused' || task.status === 'needs-file') && (
          <button type="button" aria-label="Resume" onClick={task.status === 'needs-file' ? onPick : onResume} className="retro-focus bevel-thin-raised bg-face p-0.5 hover:bg-face-hover">
            <IconPlay size={11} />
          </button>
        )}
        {task.status === 'error' && (
          <button type="button" aria-label="Retry" onClick={onRetry} className="retro-focus bevel-thin-raised bg-face px-1 text-[10px] font-bold hover:bg-face-hover">
            RETRY
          </button>
        )}
        {task.status !== 'done' && (
          <button type="button" aria-label="Cancel" onClick={onCancel} className="retro-focus bevel-thin-raised bg-face p-0.5 hover:bg-face-hover">
            <IconX size={11} />
          </button>
        )}
      </div>
      {(task.status === 'uploading' || task.status === 'paused') && (
        <>
          <RetroProgress
            className="mt-1"
            value={pct}
            indeterminate={task.status === 'uploading' && task.sentBytes === 0}
          />
          <p className="tnum mt-0.5 text-[10px] text-ink-soft">
            {humanBytes(task.sentBytes)} of {humanBytes(task.sizeBytes)} · {Math.round(pct)}%
            {task.speedBps ? ` · ${humanSpeed(task.speedBps)}` : ''}
            {task.status === 'paused' && ' · paused'}
          </p>
        </>
      )}
      {task.status === 'needs-file' && (
        <p className="mt-0.5 text-[10px] leading-snug text-warn">
          Interrupted — press ▶ and re-pick “{task.fileName}” ({humanBytes(task.sizeBytes)}) to resume exactly where it stopped.
        </p>
      )}
      {task.status === 'error' && (
        <p className="mt-0.5 text-[10px] leading-snug text-danger">{task.error} — Retry keeps the bytes already sent.</p>
      )}
      {task.status === 'done' && (
        <p className="tnum mt-0.5 text-[10px] text-ok">Done — {humanBytes(task.sizeBytes)} safely stored.</p>
      )}
    </li>
  );
}
