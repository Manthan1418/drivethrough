'use client';

// RetroWindow — the chrome every surface in the app lives in: silver beveled frame,
// navy gradient title bar with bold white title + close button. Modal windows are
// draggable by the title bar (pointer events, viewport-clamped) — the Win98 tell.

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { IconX } from './icons';

interface RetroWindowProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose?: () => void;
  draggable?: boolean;
  className?: string;
  /** Rendered under the body — e.g. dialog buttons. */
  footer?: ReactNode;
  /** Decorative min/max buttons (top-right, left of close) — pure retro flavor. */
  decorations?: boolean;
  titleSuffix?: ReactNode;
}

const DRAG_CLAMP = 8;

export function RetroWindow({
  title,
  icon,
  children,
  onClose,
  draggable = false,
  className = '',
  footer,
  decorations = true,
  titleSuffix,
}: RetroWindowProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggable || e.button !== 0) return;
      // Never hijack presses on interactive title-bar controls (close X, collapse,
      // suffix buttons): pointer capture retargets their click event to the title
      // bar and the button silently stops working.
      if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return;
      const origin = pos ?? { x: 0, y: 0 };
      dragRef.current = { startX: e.clientX, startY: e.clientY, originX: origin.x, originY: origin.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [draggable, pos]
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const maxX = window.innerWidth - DRAG_CLAMP * 8;
    const maxY = window.innerHeight - 60;
    setPos({
      x: Math.min(Math.max(d.originX + dx, -maxX + 200), maxX),
      y: Math.min(Math.max(d.originY + dy, 0), maxY),
    });
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    <div
      // The entrance animation (`.anim-window`, fill-mode both) keeps its final
      // keyframe's transform applied and would override the inline drag translate —
      // so once the window has been dragged, drop the class and let pos win.
      className={`bevel-raised bg-face ${pos ? '' : 'anim-window'} ${className}`}
      style={pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined}
      role="dialog"
      aria-label={title}
    >
      {/* title bar */}
      <div
        className={`title-shine flex h-[26px] items-center gap-2 bg-gradient-to-r from-titlebar to-titlebar-end px-1.5 select-none ${
          draggable ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white">{title}</span>
        {titleSuffix}
        {decorations && (
          <span className="flex shrink-0 items-center gap-[2px]">
            <TitleGlyph>─</TitleGlyph>
            <TitleGlyph>▢</TitleGlyph>
          </span>
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="bevel-raised retro-focus ml-0.5 flex h-[18px] w-[20px] shrink-0 items-center justify-center bg-face active:bevel-pressed"
          >
            <IconX size={9} />
          </button>
        )}
      </div>
      {/* body — flex-1 + min-h-0 so full-height children (the file browser) can
          actually fill the window; block layout left a gray void below the list and
          floated the selection action bar on top of the rows. */}
      <div className="flex min-h-0 flex-1 flex-col p-2">{children}</div>
      {footer && <div className="flex justify-end gap-2 px-2 pb-2">{footer}</div>}
    </div>
  );
}

function TitleGlyph({ children }: { children: ReactNode }) {
  return (
    <span className="bevel-raised flex h-[18px] w-[18px] items-center justify-center bg-face text-[9px] leading-none text-ink">
      {children}
    </span>
  );
}
