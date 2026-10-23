'use client';

// KeysView — API key management + the in-app /api/v1 quick-start (design.md §5.1 /keys:
// "secret shown once, copy affordance"; line 192: "key-auth docs page in-app, 9Drive parity").
// The full dtk_… secret exists in this component's state ONLY until the tab closes —
// the server keeps just a SHA-256 hash and can never show it again.

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '@/client/api';
import { createKey, listKeys, revokeKey } from '@/client/keys';
import { RetroButton, RetroInput } from '@/components/retro/controls';
import { ConfirmDialog } from '@/components/retro/dialog';
import { IconAlert, IconKey } from '@/components/retro/icons';
import type { ApiKey } from '@drivethrough/contracts';

export function KeysView({ refreshKey }: { refreshKey?: number }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<ApiKey | null>(null); // fresh key, shown once
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await listKeys());
      setError(null);
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not load API keys');
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const doCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const key = await createKey(trimmed);
      setName('');
      setCopied(false);
      if (key.key) setRevealed(key);
      await load();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not create key');
    } finally {
      setBusy(false);
    }
  }, [name, load]);

  const doRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      await revokeKey(revokeTarget.id);
      await load();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not revoke key');
    } finally {
      setBusy(false);
      setRevokeTarget(null);
    }
  }, [revokeTarget, load]);

  const copyRevealed = useCallback(() => {
    if (!revealed?.key) return;
    void navigator.clipboard
      .writeText(revealed.key)
      .then(() => setCopied(true))
      .catch(() => setError('Clipboard blocked — select the key and copy manually.'));
  }, [revealed]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* create row */}
      <div className="bevel-raised flex flex-wrap items-end gap-2 bg-face p-2.5">
        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-ink-soft">NEW KEY NAME</span>
          <RetroInput
            value={name}
            placeholder="e.g. laptop-uploader"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doCreate(); }}
            maxLength={255}
          />
        </label>
        <RetroButton variant="primary" disabled={busy || !name.trim()} onClick={() => void doCreate()}>
          {busy ? 'Working…' : 'Create key'}
        </RetroButton>
      </div>

      {error && (
        <p role="alert" className="bevel-thin-raised flex items-center gap-2 bg-[#f8e6e6] p-2 text-[12px] text-danger">
          <IconAlert size={14} /> {error}
        </p>
      )}

      {/* revealed-once secret */}
      {revealed?.key && (
        <div className="bevel-raised anim-window bg-[#f8f4d8] p-2.5" role="status">
          <p className="text-[12px] font-bold text-ink">
            Key “{revealed.name}” created — copy it now, it will never be shown again:
          </p>
          <div className="bevel-sunken mt-1.5 bg-face-field p-2">
            <input
              readOnly
              value={revealed.key}
              onFocus={(e) => e.currentTarget.select()}
              className="h-6 w-full bg-transparent font-mono text-[12px] text-ink outline-none"
              aria-label="New API key"
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-soft">{copied ? 'Copied to clipboard ✓' : 'Kept only in this tab.'}</span>
            <div className="flex gap-1.5">
              <RetroButton small variant={copied ? 'default' : 'primary'} onClick={copyRevealed}>
                {copied ? 'Copied' : 'Copy key'}
              </RetroButton>
              <RetroButton small onClick={() => setRevealed(null)}>Done</RetroButton>
            </div>
          </div>
        </div>
      )}

      {/* key list */}
      <div className="bevel-sunken min-h-0 flex-1 overflow-auto bg-face-field">
        {keys === null && <p className="p-3 text-[12px] text-ink-soft">Loading keys…</p>}
        {keys?.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <IconKey size={36} />
            <p className="text-[13px] font-bold text-ink">No API keys yet</p>
            <p className="max-w-72 text-[11px] leading-snug text-ink-soft">
              Keys let scripts upload into your DriveThrough without signing in. Create one above,
              then use the quick-start below.
            </p>
          </div>
        )}
        {keys && keys.length > 0 && (
          <table className="w-full border-collapse text-[12px] text-ink">
            <thead>
              <tr className="sticky top-0 bevel-thin-pressed bg-face text-left text-[11px] font-bold text-ink-soft">
                <th className="px-2.5 py-1.5">Name</th>
                <th className="px-2.5 py-1.5">Key</th>
                <th className="px-2.5 py-1.5">Last used</th>
                <th className="px-2.5 py-1.5">Status</th>
                <th className="px-2.5 py-1.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k, i) => (
                <tr key={k.id} className={i % 2 ? 'bg-black/[0.025]' : ''}>
                  <td className="max-w-[160px] truncate px-2.5 py-1.5 font-bold">{k.name}</td>
                  <td className="px-2.5 py-1.5 font-mono text-[11px]">{k.keyPrefix}…</td>
                  <td className="tnum px-2.5 py-1.5 text-[11px] text-ink-soft">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}
                  </td>
                  <td className="px-2.5 py-1.5 text-[11px]">
                    {k.revokedAt ? (
                      <span className="text-danger font-bold">revoked</span>
                    ) : (
                      <span className="font-bold" style={{ color: 'var(--color-ok)' }}>live</span>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5 text-right">
                    {!k.revokedAt && (
                      <RetroButton small variant="danger" onClick={() => setRevokeTarget(k)}>
                        Revoke
                      </RetroButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* /api/v1 quick-start — the key-auth docs page, in-app (9Drive parity) */}
      <details className="bevel-raised bg-face p-2.5">
        <summary className="cursor-pointer select-none text-[12px] font-bold text-ink">
          Using a key — POST /api/v1/uploads quick-start
        </summary>
        <pre className="bevel-sunken mt-2 overflow-auto bg-face-field p-2 font-mono text-[11px] leading-relaxed text-ink">{v1Snippet()}</pre>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-soft">
          Same chunk protocol as the app: create the session (keep its <code>uploadId</code> and your
          file&apos;s SHA-256 id as <code>clientUploadId</code>), PUT each ≤ 4 MB body with its
          <code> Content-Range</code> in order, then complete. Responses are JSON
          <code> {'{ code, message }'} </code> on error. Rate limit: 600 requests/minute/key.
        </p>
      </details>

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke API key"
          message={
            <>
              Revoke “<b>{revokeTarget.name}</b>” ({revokeTarget.keyPrefix}…)?
              <br />
              <span className="text-[11px] text-ink-soft">
                Anything using it gets a 401 on the next call. This cannot be undone.
              </span>
            </>
          }
          confirmLabel="Revoke key"
          danger
          busy={busy}
          onConfirm={() => void doRevoke()}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

function v1Snippet(): string {
  const api = apiUrl('');
  return `# 1. create a session (clientUploadId = a UUID you keep for retries)
curl -sS -X POST ${api}/api/v1/uploads \\
  -H "Authorization: Bearer dtk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"clientUploadId":"$(uuidgen)","fileName":"report.pdf","mimeType":"application/pdf","sizeBytes":"1048576"}'
# → { "uploadId": "…", "chunkSize": 4194304, "totalChunks": 1, "accountId": "…" }

# 2. PUT each chunk (raw body, NOT multipart) — sequential, ≤ 4 MB each
curl -sS -X PUT "${api}/api/v1/uploads/UPLOAD_ID/chunk?index=0" \\
  -H "Authorization: Bearer dtk_YOUR_KEY" \\
  -H "Content-Range: bytes 0-1048575/1048576" \\
  --data-binary @report.pdf

# 3. complete → the file appears in your DriveThrough
curl -sS -X POST ${api}/api/v1/uploads/UPLOAD_ID/complete \\
  -H "Authorization: Bearer dtk_YOUR_KEY"

# resume after a crash: GET /api/v1/uploads/UPLOAD_ID → committedOffset + receivedChunks`;
}
