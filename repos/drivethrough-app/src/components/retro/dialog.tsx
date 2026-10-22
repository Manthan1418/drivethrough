'use client';

// RetroDialog — modal confirm/prompt in a small draggable window over a dim overlay.
// Replaces native confirm()/prompt() everywhere (they can't be styled — and can't be
// beautiful). ESC = cancel, ENTER = primary action.

import { useEffect, type ReactNode } from 'react';
import { RetroWindow } from './window';
import { RetroButton } from './controls';

export function RetroDialog({
  title,
  children,
  onClose,
  actions,
  width = 'w-[340px]',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="anim-fade fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <RetroWindow title={title} onClose={onClose} draggable className={`${width} max-w-full`} decorations={false} footer={actions}>
        <div className="text-[13px] leading-relaxed text-ink">{children}</div>
      </RetroWindow>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  danger = false,
  onConfirm,
  onCancel,
  busy = false,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <RetroDialog
      title={title}
      onClose={onCancel}
      actions={
        <>
          <RetroButton onClick={onCancel}>Cancel</RetroButton>
          <RetroButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </RetroButton>
        </>
      }
    >
      {message}
    </RetroDialog>
  );
}
