'use client';

// /s/[token] — the PUBLIC share page (design.md §5.5): minimal chrome, no sign-in, works
// in incognito. One beveled card on the teal desktop: file facts, an inline preview through
// the same Range proxy (the share token in the URL IS the credential), a native download
// button, a live expiry countdown, and honest dead-link states —
//   revoked → "This link has been revoked" · expired → "This link has expired" ·
//   RATE_LIMITED → try again shortly.
// Rate-limited per IP server-side; this page just renders whatever the API answers.

import { use, useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '@/client/api';
import { capabilityUrl, fetchPublicShare } from '@/client/shares';
import { humanBytes } from '@/client/uploads';
import { RetroButton } from '@/components/retro/controls';
import { IconFile, IconShare } from '@/components/retro/icons';
import { fileKindOf } from '@/components/explorer/preview';
import type { PublicShare } from '@drivethrough/contracts';

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; share: PublicShare }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'limited' }
  | { kind: 'error'; message: string };

export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [, tick] = useState(0); // re-render for the countdown

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const share = await fetchPublicShare(token);
      setState({ kind: 'ready', share });
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'INTERNAL_ERROR';
      if (code === 'SHARE_NOT_FOUND') setState({ kind: 'revoked' });
      else if (code === 'SHARE_EXPIRED') setState({ kind: 'expired' });
      else if (code === 'RATE_LIMITED') setState({ kind: 'limited' });
      else setState({ kind: 'error', message: (err as Error).message });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // countdown refresh — one tick per second only while the page is ready
  useEffect(() => {
    if (state.kind !== 'ready' || !state.share.expiresAt) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-4">
      <div className="bevel-raised w-full max-w-[560px] bg-face">
        {/* title bar */}
        <div className="flex items-center gap-1.5 bg-titlebar px-2 py-1">
          <IconShare size={13} />
          <p className="truncate text-[12px] font-bold text-white">Shared file</p>
        </div>

        <div className="p-3">
          {state.kind === 'loading' && (
            <p className="py-8 text-center text-[13px] text-ink-soft">Loading shared file…</p>
          )}

          {state.kind === 'revoked' && (
            <DeadLink
              title="This link has been revoked"
              detail="The owner turned sharing off for this file, or the file was deleted."
            />
          )}
          {state.kind === 'expired' && (
            <DeadLink title="This link has expired" detail="Ask the owner for a fresh link." />
          )}
          {state.kind === 'limited' && (
            <DeadLink title="Too many requests" detail="Please wait a minute and reload this page." />
          )}
          {state.kind === 'error' && (
            <DeadLink title="Could not open this link" detail={state.message} />
          )}

          {state.kind === 'ready' && (
            <ReadyBody token={token} share={state.share} />
          )}
        </div>
      </div>

      <p className="text-[11px] text-white/85 drop-shadow">
        shared with <span className="font-bold">DriveThrough</span> — one drive, every account
      </p>
    </main>
  );
}

function DeadLink({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-8 text-center">
      <IconFile size={40} mimeType="application/octet-stream" />
      <p className="text-[14px] font-bold text-ink">{title}</p>
      <p className="max-w-[380px] text-[12px] leading-snug text-ink-soft">{detail}</p>
    </div>
  );
}

function ReadyBody({ token, share }: { token: string; share: PublicShare }) {
  const kind = fileKindOf(share.mimeType);
  const url = capabilityUrl(token);

  const expiresAt = share.expiresAt ? new Date(share.expiresAt).getTime() : null;
  const left = expiresAt !== null ? expiresAt - Date.now() : null;

  return (
    <>
      {/* file facts */}
      <div className="flex items-center gap-2.5">
        <div className="bevel-sunken flex h-10 w-10 shrink-0 items-center justify-center bg-face-field">
          <IconFile size={26} mimeType={share.mimeType} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-bold text-ink" title={share.name}>
            {share.name}
          </p>
          <p className="tnum text-[11px] text-ink-soft">
            {humanBytes(share.sizeBytes)} · {share.mimeType || 'file'} · view only
          </p>
        </div>
        <RetroButton
          variant="primary"
          onClick={() => {
            // native download via attachment disposition — streams, never buffers in JS
            const a = document.createElement('a');
            a.href = capabilityUrl(token, { download: true });
            document.body.appendChild(a);
            a.click();
            a.remove();
          }}
        >
          Download
        </RetroButton>
      </div>

      {left !== null && (
        <p className="mt-1.5 text-[11px] text-ink-soft">
          {left > 0 ? `Expires in ${countdown(left)}` : 'This link has expired.'}
        </p>
      )}

      {/* inline preview — same Range proxy as the app, share token as the capability */}
      <div className="bevel-sunken mt-2.5 flex min-h-[140px] max-h-[52vh] items-center justify-center overflow-auto bg-face-field p-2">
        {kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={share.name} className="max-h-[50vh] object-contain" />
        )}
        {kind === 'video' && <video src={url} controls className="max-h-[50vh] w-full" />}
        {kind === 'audio' && <audio src={url} controls className="w-full" />}
        {kind === 'pdf' && <iframe src={url} title={share.name} className="h-[48vh] w-full border-0" />}
        {kind === 'text' && <TextSnippet url={url} />}
        {kind === 'other' && (
          <div className="py-6 text-center">
            <IconFile size={36} mimeType={share.mimeType} />
            <p className="mt-2 text-[12px] text-ink-soft">No inline preview — use Download.</p>
          </div>
        )}
      </div>
    </>
  );
}

function TextSnippet({ url }: { url: string }) {
  const [text, setText] = useState('…');
  useEffect(() => {
    void fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => setText(t.slice(0, 100_000)))
      .catch(() => setText('(could not read this file)'));
  }, [url]);
  return (
    <pre className="max-h-[48vh] w-full overflow-auto whitespace-pre-wrap break-all p-1 font-mono text-[12px] leading-snug text-ink">
      {text}
    </pre>
  );
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
