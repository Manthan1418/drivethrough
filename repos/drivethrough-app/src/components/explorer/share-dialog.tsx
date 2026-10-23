'use client';

// ShareDialog — create / copy / revoke a reader-only link for ONE file (prd.md P0-11).
// Design notes:
//  • the raw token exists only in the create response (hashed server-side), so a reopen
//    shows the live-link count but never the URL again — that's the security model, not a bug;
//  • default expiry is 7 days ("default expiring" — tech.md §8) with a Never option;
//  • revoke kills ALL live links of the file (the API's file-level DELETE) — the honest
//    answer to "someone has my link".

import { useCallback, useEffect, useState } from 'react';
import { createShare, getShareState, revokeShare, sharePageUrl } from '@/client/shares';
import { humanBytes } from '@/client/uploads';
import { RetroButton, RetroSelect } from '@/components/retro/controls';
import { RetroDialog } from '@/components/retro/dialog';
import type { FileMeta } from '@drivethrough/contracts';

const EXPIRY_CHOICES: { label: string; ms: number | null }[] = [
  { label: 'Expires in 24 hours', ms: 24 * 3600 * 1000 },
  { label: 'Expires in 7 days (default)', ms: 7 * 24 * 3600 * 1000 },
  { label: 'Expires in 30 days', ms: 30 * 24 * 3600 * 1000 },
  { label: 'Never expires', ms: null },
];
const DEFAULT_CHOICE = 1;

export function ShareDialog({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const [live, setLive] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null); // in-memory only — cleared on close/revoke
  const [choice, setChoice] = useState(DEFAULT_CHOICE);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getShareState(file.id)
      .then((s) => { if (alive) setLive(s.length); })
      .catch(() => { if (alive) setLive(0); });
    return () => { alive = false; };
  }, [file.id]);

  const doCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const preset = EXPIRY_CHOICES[choice] ?? EXPIRY_CHOICES[DEFAULT_CHOICE]!;
      const expiresAt = preset.ms ? new Date(Date.now() + preset.ms).toISOString() : null;
      const share = await createShare(file.id, { expiresAt });
      setLive((n) => (n ?? 0) + 1);
      if (share.token) {
        setUrl(sharePageUrl(share.token));
        setCopied(false);
      } else {
        setError('A link was already created for this request — revoke to rotate it.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [choice, file.id]);

  const doRevoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const revoked = await revokeShare(file.id);
      setLive((n) => Math.max(0, (n ?? 0) - revoked));
      if (revoked > 0) {
        setUrl(null);
        setCopied(false);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [file.id]);

  const doCopy = useCallback(() => {
    if (!url) return;
    void navigator.clipboard
      .writeText(url)
      .then(() => setCopied(true))
      .catch(() => setError('Clipboard blocked — select the link and copy manually.'));
  }, [url]);

  return (
    <RetroDialog
      title="Share file"
      onClose={onClose}
      width="w-[460px]"
      actions={
        <>
          <RetroButton onClick={onClose}>Close</RetroButton>
          {(live ?? 0) > 0 && (
            <RetroButton variant="danger" disabled={busy} onClick={() => void doRevoke()}>
              {busy ? 'Working…' : 'Revoke link(s)'}
            </RetroButton>
          )}
          <RetroButton variant="primary" disabled={busy} onClick={() => void doCreate()}>
            {busy ? 'Working…' : url ? 'Create another' : 'Create link'}
          </RetroButton>
        </>
      }
    >
      <p className="truncate text-[12px] font-bold text-ink" title={file.name}>
        {file.name} · {humanBytes(file.sizeBytes)}
      </p>
      <p className="mt-1 text-[11px] leading-snug text-ink-soft">
        Anyone with the link can <b>view</b> this file — read-only, no sign-in needed.
        Links can be revoked at any time.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <span className="shrink-0 text-[12px] font-bold text-ink">Link lifetime:</span>
        <RetroSelect value={choice} onChange={(e) => setChoice(Number(e.target.value))} aria-label="Link lifetime">
          {EXPIRY_CHOICES.map((c, i) => (
            <option key={c.label} value={i}>{c.label}</option>
          ))}
        </RetroSelect>
      </div>

      {live === null && <p className="mt-3 text-[11px] text-ink-soft">Checking existing links…</p>}
      {live !== null && live > 0 && !url && (
        <p className="mt-3 text-[11px] text-ink">
          <b>{live}</b> live link{live === 1 ? '' : 's'} for this file. The address can&apos;t be shown
          again after it was created (it&apos;s stored hashed) — create a new link if you lost it,
          or revoke.
        </p>
      )}
      {live === 0 && !url && (
        <p className="mt-3 text-[11px] text-ink-soft">No active links yet.</p>
      )}

      {url && (
        <div className="bevel-sunken mt-3 bg-face-field p-2">
          <p className="mb-1 text-[11px] font-bold text-ink">Share link (shown once):</p>
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="h-7 w-full bg-transparent font-mono text-[11px] text-ink outline-none"
            aria-label="Share link"
          />
        </div>
      )}

      {url && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-soft">
            {copied ? 'Copied to clipboard ✓' : 'Copy it now — it won&apos;t be shown again.'}
          </span>
          <RetroButton small variant={copied ? 'default' : 'primary'} onClick={doCopy}>
            {copied ? 'Copied' : 'Copy link'}
          </RetroButton>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
    </RetroDialog>
  );
}
