'use client';

// Win98 controls: beveled buttons (press swaps the bevel — authentic), sunken fields,
// and the segmented progress bar. All motion stays inside the 120–180 ms envelope.

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'quiet';

interface RetroButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  small?: boolean;
}

export const RetroButton = forwardRef<HTMLButtonElement, RetroButtonProps>(function RetroButton(
  { variant = 'default', small = false, className = '', children, disabled, ...rest },
  ref
) {
  const base =
    'bevel-raised retro-focus inline-flex items-center justify-center gap-1.5 bg-face font-ui text-ink transition-colors duration-100 active:bevel-pressed disabled:cursor-default disabled:text-ink-faint';
  const size = small ? 'h-6 px-2 text-[12px]' : 'h-8 px-3.5 text-[13px]';
  const variantCls =
    variant === 'primary'
      ? 'shadow-[0_0_0_1px_var(--color-ink)] font-bold'
      : variant === 'danger'
        ? 'text-danger font-bold'
        : variant === 'quiet'
          ? 'bevel-thin-raised hover:bg-face-hover'
          : 'hover:bg-face-hover';
  return (
    <button ref={ref} type="button" disabled={disabled} className={`${base} ${size} ${variantCls} ${className}`} {...rest}>
      {children}
    </button>
  );
});

interface RetroInputProps extends InputHTMLAttributes<HTMLInputElement> {
  wrapperClassName?: string;
}

export const RetroInput = forwardRef<HTMLInputElement, RetroInputProps>(function RetroInput(
  { className = '', wrapperClassName = '', ...rest },
  ref
) {
  return (
    <div className={`bevel-sunken bg-face-field ${wrapperClassName}`}>
      <input
        ref={ref}
        className={`h-7 w-full bg-transparent px-2 text-[13px] text-ink outline-none placeholder:text-ink-faint ${className}`}
        {...rest}
      />
    </div>
  );
});

/** Segmented Win95 progress: navy blocks on a sunken track; marquee when indeterminate. */
export function RetroProgress({
  value,
  max = 100,
  indeterminate = false,
  className = '',
  tone = 'select',
}: {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  className?: string;
  tone?: 'select' | 'ok' | 'warn';
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, ((value ?? 0) / max) * 100)) : 0;
  const color = tone === 'ok' ? 'var(--color-ok)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-select)';
  return (
    <div className={`bevel-sunken relative h-4 overflow-hidden bg-face-field ${className}`}>
      {indeterminate ? (
        <div className="progress-marquee absolute inset-0 opacity-80" />
      ) : (
        <div
          className="h-full transition-[width] duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)]"
          style={{
            width: `${pct}%`,
            backgroundColor: color,
            backgroundImage:
              'repeating-linear-gradient(90deg, transparent 0 7px, rgb(255 255 255 / 35%) 7px 8px)',
          }}
        />
      )}
    </div>
  );
}

/** Field + label, Win98 settings-dialog style. */
export function RetroField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-bold text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-ink-soft">{hint}</span>}
    </label>
  );
}
