'use client';

// RetroMenu — the right-click context menu: beveled popup, navy selection bar on hover,
// pops in from its corner. Closes on outside click / Escape / scroll; viewport-clamped.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function RetroMenu({
  x,
  y,
  items,
  onClose,
  ariaLabel = 'Context menu',
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className="bevel-raised anim-menu fixed z-50 min-w-44 bg-face py-1"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separatorBefore && <div className="bevel-thin-raised my-1 h-px" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
            className={`retro-focus flex h-7 w-full items-center gap-2 px-3 text-left text-[13px] transition-colors duration-75 ${
              item.disabled
                ? 'cursor-default text-ink-faint'
                : item.danger
                  ? 'text-danger hover:bg-select hover:text-select-ink'
                  : 'text-ink hover:bg-select hover:text-select-ink'
            }`}
          >
            {item.icon && <span className="w-4 shrink-0">{item.icon}</span>}
            <span className="truncate">{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
