'use client';

// PreviewWindow — double-clicking a file opens it in a small retro window.
//
// P0.4 change: bytes now arrive through a short-lived PREVIEW TOKEN URL (flow.md §5.2 —
// "img/video/PDF/text uses same endpoint with short-lived preview token") instead of an
// authed whole-file blob. That means:
//  • <video>/<img> fetch directly with Range support — a multi-GB file previews in a
//    bounded window instead of being buffered entirely into JS memory;
//  • no Authorization header can ride a media element — the token in the URL IS the
//    credential (10-minute TTL, hashed server-side);
//  • if the token expires mid-playback the media element errors → we re-mint a fresh
//    token and resume from the same position (the URL changes, playback continues).
// "Save to disk" keeps the authenticated full-fetch path (it must produce a file, not a tab).

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRaw } from '@/client/api';
import { capabilityUrl, mintPreviewToken } from '@/client/shares';
import { humanBytes, type UploadTask } from '@/client/uploads';
import { RetroButton } from '@/components/retro/controls';
import { RetroWindow } from '@/components/retro/window';
import { IconFile } from '@/components/retro/icons';
import type { FileMeta } from '@drivethrough/contracts';

export async function downloadFileMeta(file: FileMeta): Promise<void> {
  const res = await apiRaw(`/api/files/${file.id}/content`);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type PreviewState = 'loading' | 'ready' | 'error';

export function PreviewWindow({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const [state, setState] = useState<PreviewState>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const resumeAt = useRef<number | null>(null); // playback position to restore after re-mint

  const load = useCallback(async () => {
    setState('loading');
    try {
      const minted = await mintPreviewToken(file.id);
      setUrl(capabilityUrl(minted.token));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [file.id]);

  useEffect(() => {
    void load();
    resumeAt.current = null;
  }, [load]);

  // Token TTL (10 min) can outlive a long playback — the media element's error means the
  // URL went stale: mint a fresh one and continue where we were.
  const recover = useCallback(() => {
    const el = mediaRef.current;
    if (el && Number.isFinite(el.currentTime) && el.currentTime > 0.5) {
      resumeAt.current = el.currentTime;
    }
    void load();
  }, [load]);

  const kind = fileKindOf(file.mimeType);

  return (
    <RetroWindow
      title={file.name}
      icon={<IconFile size={14} mimeType={file.mimeType} />}
      onClose={onClose}
      draggable
      className="w-[520px] max-w-[94vw]"
      footer={
        <RetroButton
          variant="primary"
          disabled={downloading || state !== 'ready'}
          onClick={() => {
            setDownloading(true);
            void downloadFileMeta(file).finally(() => setDownloading(false));
          }}
        >
          {downloading ? 'Saving…' : `Save to disk · ${humanBytes(file.sizeBytes)}`}
        </RetroButton>
      }
    >
      <div className="bevel-sunken flex max-h-[60vh] min-h-[180px] items-center justify-center overflow-auto bg-face-field p-2">
        {state === 'loading' && <p className="text-[12px] text-ink-soft">Fetching from your drive…</p>}
        {state === 'error' && (
          <div className="text-center">
            <p className="text-[12px] text-danger">Could not load this file.</p>
            <p className="mt-1 text-[11px] text-ink-soft">The preview link may have expired.</p>
            <RetroButton small className="mt-2" onClick={() => void load()}>Try again</RetroButton>
          </div>
        )}
        {state === 'ready' && url && kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={file.name} className="max-h-[56vh] object-contain" />
        )}
        {state === 'ready' && url && kind === 'video' && (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={url}
            controls
            className="max-h-[56vh] w-full"
            onError={recover}
            onLoadedMetadata={() => {
              const el = mediaRef.current;
              if (el && resumeAt.current !== null) {
                el.currentTime = resumeAt.current;
                resumeAt.current = null;
              }
            }}
          />
        )}
        {state === 'ready' && url && kind === 'audio' && (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={url}
            controls
            className="w-full"
            onError={recover}
          />
        )}
        {state === 'ready' && url && kind === 'pdf' && <iframe src={url} title={file.name} className="h-[56vh] w-full border-0" />}
        {state === 'ready' && url && kind === 'text' && <TextPreview url={url} />}
        {state === 'ready' && url && kind === 'other' && (
          <div className="text-center">
            <IconFile size={48} mimeType={file.mimeType} />
            <p className="mt-2 text-[12px] text-ink-soft">
              No preview for {file.mimeType || 'this type'} — save it to disk.
            </p>
          </div>
        )}
      </div>
      <p className="tnum mt-1.5 text-[11px] text-ink-soft">
        {file.mimeType} · {humanBytes(file.sizeBytes)} · modified {new Date(file.updatedAt).toLocaleString()}
      </p>
    </RetroWindow>
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string>('…');
  useEffect(() => {
    void fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => setText(t.slice(0, 200_000)))
      .catch(() => setText('(could not read text)'));
  }, [url]);
  return (
    <pre className="w-full whitespace-pre-wrap break-all font-mono text-[12px] leading-snug text-ink">{text}</pre>
  );
}

/** Shared with the public /s/[token] page — one definition of "what can preview". */
export function fileKindOf(mime: string): 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other' {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/') || /json|xml|csv|javascript|yaml/.test(m)) return 'text';
  return 'other';
}

export type PreviewFile = FileMeta;
export type DockTask = UploadTask;
