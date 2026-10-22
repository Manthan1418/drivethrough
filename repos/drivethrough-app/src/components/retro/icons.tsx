// Pixel-crisp icon set — the retro world's iconography. Hand-drawn rects on a 16×16
// grid with shape-rendering="crispEdges" (no anti-aliasing = authentic chunk), colored
// from the Win98 palette. Stroke weight stays visually consistent across the set.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconFolder({ open = false, ...rest }: IconProps & { open?: boolean }) {
  return (
    <Svg {...rest}>
      <rect x="1" y="4" width="6" height="2" fill="#8a5f00" />
      <rect x="1" y="6" width="14" height="7" fill="#e8a900" />
      <rect x="1" y="6" width="14" height="1" fill="#ffd76e" />
      <rect x="1" y="12" width="14" height="1" fill="#8a5f00" />
      {open && <rect x="3" y="4" width="11" height="2" fill="#ffd76e" />}
    </Svg>
  );
}

export function IconFile({ mimeType, ...rest }: IconProps & { mimeType?: string }) {
  const kind = fileKind(mimeType);
  const accent = kind === 'image' ? '#0f8a4a' : kind === 'video' ? '#7b2fbe' : kind === 'audio' ? '#a34700' : kind === 'archive' ? '#8a5f00' : kind === 'pdf' ? '#a40000' : '#3a5fa4';
  return (
    <Svg {...rest}>
      <path d="M3 1h7l3 3v11H3z" fill="#fdfdfd" stroke="#3d3d3d" strokeWidth="1" />
      <path d="M10 1v3h3" fill="none" stroke="#3d3d3d" strokeWidth="1" />
      <rect x="5" y="8" width="6" height="5" fill={accent} opacity="0.85" />
      {kind === 'image' && (<><rect x="6" y="9" width="1" height="1" fill="#ffd76e" /><rect x="5" y="11" width="6" height="2" fill="#0f6d3c" /></>)}
      {kind === 'video' && <path d="M6.5 9l3.5 2.5L6.5 12z" fill="#fff" />}
      {kind === 'doc' && <>{[9, 10.5, 12].map((y) => <rect key={y} x="5" y={y} width="6" height="0.8" fill="#c8c8c8" />)}</>}
    </Svg>
  );
}

export function fileKind(mimeType?: string): 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'doc' {
  const m = mimeType ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/zip|compressed|x-tar|x-7z|rar/.test(m)) return 'archive';
  return 'doc';
}

export function IconGear(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="6" y="2" width="4" height="2" fill="#4a4a4a" />
      <rect x="6" y="12" width="4" height="2" fill="#4a4a4a" />
      <rect x="2" y="6" width="2" height="4" fill="#4a4a4a" />
      <rect x="12" y="6" width="2" height="4" fill="#4a4a4a" />
      <rect x="4" y="4" width="8" height="8" fill="#8a8a8a" />
      <rect x="6" y="6" width="4" height="4" fill="#c8c8c8" />
      <rect x="7" y="7" width="2" height="2" fill="#3d3d3d" />
    </Svg>
  );
}

export function IconTrash(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="3" y="4" width="10" height="2" fill="#4a4a4a" />
      <rect x="6" y="2" width="4" height="2" fill="#4a4a4a" />
      <rect x="4" y="6" width="8" height="8" fill="#a0a0a0" />
      <rect x="5" y="7" width="1" height="6" fill="#6f6f6f" />
      <rect x="7.5" y="7" width="1" height="6" fill="#6f6f6f" />
      <rect x="10" y="7" width="1" height="6" fill="#6f6f6f" />
    </Svg>
  );
}

export function IconUpload(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="7" y="2" width="2" height="7" fill="#000080" />
      <path d="M4 6l4-4 4 4z" fill="#000080" />
      <rect x="2" y="10" width="12" height="4" fill="#c8c8c8" stroke="#3d3d3d" strokeWidth="1" />
    </Svg>
  );
}

export function IconSearch(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="3" y="3" width="7" height="7" fill="#fdfdfd" stroke="#3d3d3d" strokeWidth="1" />
      <rect x="4" y="4" width="5" height="5" fill="#cfe6ff" />
      <path d="M9 9l4 4" stroke="#3d3d3d" strokeWidth="2" />
    </Svg>
  );
}

export function IconDriveG(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="2" y="2" width="12" height="12" fill="#fdfdfd" stroke="#3d3d3d" strokeWidth="1" />
      <path d="M8 5a3 3 0 1 0 2.6 4.5H8V7.5h4.5A4.5 4.5 0 1 1 8 5z" fill="#e8a900" />
    </Svg>
  );
}

export function IconHome(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M8 2l6 5h-2v6H4V7H2z" fill="#c8c8c8" stroke="#3d3d3d" strokeWidth="1" />
      <rect x="7" y="9" width="2" height="4" fill="#000080" />
    </Svg>
  );
}

export function IconClock(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="3" y="3" width="10" height="10" fill="#fdfdfd" stroke="#3d3d3d" strokeWidth="1" />
      <rect x="7" y="5" width="1" height="3" fill="#000080" />
      <rect x="8" y="7" width="2" height="1" fill="#000080" />
    </Svg>
  );
}

export function IconList(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="2" y="3" width="2" height="2" fill="#000080" />
      <rect x="6" y="3" width="8" height="2" fill="#8a8a8a" />
      <rect x="2" y="7" width="2" height="2" fill="#000080" />
      <rect x="6" y="7" width="8" height="2" fill="#8a8a8a" />
      <rect x="2" y="11" width="2" height="2" fill="#000080" />
      <rect x="6" y="11" width="8" height="2" fill="#8a8a8a" />
    </Svg>
  );
}

export function IconCheck(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M3 8l3 3 7-7" fill="none" stroke="#0f6d0f" strokeWidth="2" />
    </Svg>
  );
}

export function IconAlert(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M8 2l6 11H2z" fill="#ffd76e" stroke="#8a5f00" strokeWidth="1" />
      <rect x="7" y="6" width="2" height="4" fill="#8a5f00" />
      <rect x="7" y="11" width="2" height="1" fill="#8a5f00" />
    </Svg>
  );
}

export function IconPause(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="4" y="3" width="3" height="10" fill="#3d3d3d" />
      <rect x="9" y="3" width="3" height="10" fill="#3d3d3d" />
    </Svg>
  );
}

export function IconPlay(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M4 3l9 5-9 5z" fill="#3d3d3d" />
    </Svg>
  );
}

export function IconX(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M3 3l10 10M13 3L3 13" stroke="#3d3d3d" strokeWidth="2" />
    </Svg>
  );
}

export function IconNewFolder(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="1" y="4" width="6" height="2" fill="#8a5f00" />
      <rect x="1" y="6" width="14" height="7" fill="#e8a900" />
      <rect x="1" y="6" width="14" height="1" fill="#ffd76e" />
      <rect x="1" y="12" width="14" height="1" fill="#8a5f00" />
      <rect x="10" y="1" width="2" height="6" fill="#0f6d0f" />
      <rect x="8" y="3" width="6" height="2" fill="#0f6d0f" />
    </Svg>
  );
}

export function IconRename(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M2 14l1-3 8-8 2 2-8 8z" fill="#e8c400" stroke="#3d3d3d" strokeWidth="1" />
      <path d="M11 3l2 2" stroke="#3d3d3d" strokeWidth="1" />
    </Svg>
  );
}

export function IconMove(rest: IconProps) {
  return (
    <Svg {...rest}>
      <rect x="1" y="4" width="6" height="2" fill="#8a5f00" />
      <rect x="1" y="6" width="11" height="7" fill="#e8a900" />
      <path d="M9 8l5 3-5 3z" fill="#000080" />
    </Svg>
  );
}

export function IconRestore(rest: IconProps) {
  return (
    <Svg {...rest}>
      <path d="M13 8a5 5 0 1 1-2-4" fill="none" stroke="#0f6d0f" strokeWidth="2" />
      <path d="M11 1l3 3-3 3" fill="none" stroke="#0f6d0f" strokeWidth="2" />
    </Svg>
  );
}
