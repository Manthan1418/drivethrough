'use client';

// PreviewWindow — double-clicking a file opens it in a small retro window (blob via the
// Range-capable content proxy). Sizes are honest about v1: the blob lives in browser
// memory for the preview's lifetime; big-file streaming polish comes with striping (P1).

import { useEffect, useRef, useState } from 'react';
import { apiRaw } from '@/client/api';
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
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiRaw(`/api/files/${file.id}/content`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!alive) { URL.revokeObjectURL(URL.createObjectURL(blob)); return; }
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => {
      alive = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [file.id]);

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
        {state === 'error' && <p className="text-[12px] text-danger">Could not load this file.</p>}
        {state === 'ready' && url && kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={file.name} className="max-h-[56vh] object-contain" />
        )}
        {state === 'ready' && url && kind === 'video' && <video src={url} controls className="max-h-[56vh] w-full" />}
        {state === 'ready' && url && kind === 'audio' && <audio src={url} controls className="w-full" />}
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
      .then((r) => r.text())
      .then((t) => setText(t.slice(0, 200_000)))
      .catch(() => setText('(could not read text)'));
  }, [url]);
  return (
    <pre className="w-full whitespace-pre-wrap break-all font-mono text-[12px] leading-snug text-ink">{text}</pre>
  );
}

function fileKindOf(mime: string): 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other' {
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
