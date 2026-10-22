'use client';

// ConnectionsPanel — storage accounts + Google OAuth credentials (design.md §5.6).
// Lives in one place and renders in two: the sidebar's ⚙ settings window (P0.3 brief)
// and the standalone /settings page (the OAuth callback lands there, so it must exist).

import { useCallback, useEffect, useState } from 'react';
import {
  listAccounts, connectGoogleAccount, syncAccountQuota, disconnectAccount, readConnectResult,
} from '@/client/accounts';
import { getGoogleConfigStatus, saveGoogleConfig } from '@/client/system';
import { RetroButton, RetroField, RetroInput, RetroProgress } from '@/components/retro/controls';
import { IconAlert, IconCheck, IconDriveG } from '@/components/retro/icons';
import type { Account, GoogleConfigStatus } from '@drivethrough/contracts';

export function human(bytes: string | null): string {
  if (bytes === null) return '—';
  const n = Number(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function ConnectionsPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<GoogleConfigStatus | null>(null);
  const [formClientId, setFormClientId] = useState('');
  const [formClientSecret, setFormClientSecret] = useState('');
  const [formRedirectUri, setFormRedirectUri] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [acctList, cfgStatus] = await Promise.all([listAccounts(), getGoogleConfigStatus()]);
      setAccounts(acctList);
      setCfg(cfgStatus);
      // functional updates: never clobber what the user is typing on a background refresh
      setFormClientId((v) => v || cfgStatus.clientId);
      setFormRedirectUri((v) => v || cfgStatus.redirectUri || cfgStatus.defaultRedirectUri);
      setError(null);
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Failed to load accounts');
    }
  }, []);

  // OAuth result (?connected=1 / ?connect=error) — clear it from the URL after reading
  useEffect(() => {
    const result = readConnectResult(window.location.search);
    if (result) {
      setBanner(
        result.ok
          ? { kind: 'ok', text: 'Drive connected — quota synced.' }
          : { kind: 'err', text: `Connect failed (${result.reason ?? 'unknown'})${result.detail ? ` — ${result.detail}` : ''}. Try again.` }
      );
      window.history.replaceState({}, '', window.location.pathname);
    }
    void refresh();
  }, [refresh]);

  async function guard(fn: (id: string) => Promise<void>, id: string) {
    setBusyId(id);
    try { await fn(id); await refresh(); }
    catch (err) { setError((err as { message?: string }).message ?? 'Action failed'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="w-[380px] max-w-full p-3">
      {/* banner */}
      {banner && (
        <div
          role="status"
          className={`bevel-thin-raised mb-3 flex items-start gap-2 p-2 text-[12px] leading-snug ${
            banner.kind === 'ok' ? 'bg-[#e6f4e6] text-ok' : 'bg-[#f8e6e6] text-danger'
          }`}
        >
          {banner.kind === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
          <span className="flex-1">{banner.text}</span>
          <button type="button" className="underline" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}
      {error && (
        <p role="alert" className="bevel-thin-raised mb-3 flex items-start gap-2 bg-[#f8e6e6] p-2 text-[12px] text-danger">
          <IconAlert size={14} /> {error}
        </p>
      )}

      <h3 className="mb-2 text-[12px] font-bold text-ink-soft">Storage drives</h3>

      <div className="space-y-2">
        {accounts === null && <p className="text-[12px] text-ink-soft">Looking for drives…</p>}
        {accounts?.length === 0 && (
          <p className="bevel-sunken bg-face-field p-3 text-[12px] text-ink-soft">
            No drives connected yet — connect Google Drive below.
          </p>
        )}
        {accounts?.map((a) => {
          const pct =
            a.usage.totalBytes !== null && Number(a.usage.totalBytes) > 0
              ? Math.min(100, (Number(a.usage.usedBytes) / Number(a.usage.totalBytes)) * 100)
              : null;
          return (
            <article key={a.id} className="bevel-thin-raised bg-face p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <IconDriveG size={20} />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-bold text-ink">{a.label}</p>
                    <p className="text-[11px] text-ink-soft">
                      {a.provider === 'google_drive' ? 'Google Drive' : 'S3'} · <StatusBadge status={a.status} />
                      {a.lastSyncedAt && <> · synced {new Date(a.lastSyncedAt).toLocaleDateString()}</>}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <RetroButton small disabled={busyId === a.id} onClick={() => void guard(async (id) => { await syncAccountQuota(id); }, a.id)}>
                    {busyId === a.id ? '…' : 'Sync'}
                  </RetroButton>
                  <RetroButton
                    small
                    variant="danger"
                    disabled={busyId === a.id}
                    onClick={() => {
                      if (window.confirm(`Disconnect ${a.label}? Files stored there stay until deleted.`)) {
                        void guard(async (id) => { await disconnectAccount(id); }, a.id);
                      }
                    }}
                  >
                    Off
                  </RetroButton>
                </div>
              </div>
              <RetroProgress
                className="mt-2"
                value={pct ?? (Number(a.usage.usedBytes) > 0 ? 4 : 0)}
                tone={pct !== null && pct > 92 ? 'warn' : 'select'}
              />
              <p className="tnum mt-1 text-[11px] text-ink-soft">
                {human(a.usage.usedBytes)} used{a.usage.totalBytes !== null && <> of {human(a.usage.totalBytes)}</>}
                {Number(a.usage.reservedBytes) > 0 && <> · {human(a.usage.reservedBytes)} reserved</>}
                {a.usage.totalBytes === null && <> · free Drive quota</>}
              </p>
            </article>
          );
        })}
      </div>

      {/* Google OAuth client credentials — write-only secret (9Drive parity) */}
      <section className="bevel-thin-raised mt-4 bg-face p-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[12px] font-bold text-ink">Google API credentials</h3>
          <span className={`text-[11px] ${cfg?.exists ? 'text-ok' : 'text-ink-faint'}`}>
            {cfg === null ? '…' : cfg.exists ? 'Configured' : 'Not set'}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink-soft">
          One-time setup: Google Cloud Console → enable Drive API → OAuth consent → Web client,
          then paste its ID and secret here. Saved encrypted; the secret can never be read back.
        </p>
        <div className="mt-2 space-y-2">
          <RetroField label="Client ID">
            <RetroInput
              value={formClientId}
              onChange={(e) => setFormClientId(e.target.value)}
              placeholder="….apps.googleusercontent.com"
              autoComplete="off"
            />
          </RetroField>
          <RetroField label="Client secret">
            <RetroInput
              type="password"
              value={formClientSecret}
              onChange={(e) => setFormClientSecret(e.target.value)}
              placeholder={cfg?.hasSecret ? '•••••• (saved — leave blank to keep)' : 'GOCSPX-…'}
              autoComplete="new-password"
            />
          </RetroField>
          <RetroField label="Redirect URI">
            <div className="flex gap-1">
              <RetroInput
                value={formRedirectUri}
                onChange={(e) => setFormRedirectUri(e.target.value)}
                placeholder="https://…/settings"
                autoComplete="off"
              />
              <RetroButton small onClick={() => void navigator.clipboard.writeText(formRedirectUri)}>Copy</RetroButton>
            </div>
          </RetroField>
        </div>
        <RetroButton
          className="mt-2 w-full"
          disabled={busyId === 'cfg' || !formClientId.trim() || !formRedirectUri.trim()}
          onClick={() =>
            void (async () => {
              setBusyId('cfg');
              try {
                await saveGoogleConfig({
                  clientId: formClientId.trim(),
                  ...(formClientSecret.trim() ? { clientSecret: formClientSecret.trim() } : {}),
                  redirectUri: formRedirectUri.trim(),
                });
                setFormClientSecret(''); // never keep the secret in state after save
                setBanner({ kind: 'ok', text: 'Google credentials saved (encrypted).' });
                await refresh();
              } catch (err) {
                setError((err as { message?: string }).message ?? 'Save failed');
              } finally { setBusyId(null); }
            })()
          }
        >
          {busyId === 'cfg' ? 'Saving…' : 'Save credentials'}
        </RetroButton>
      </section>

      <RetroButton
        variant="primary"
        className="mt-3 w-full"
        disabled={busyId === 'connect' || cfg?.exists === false}
        onClick={() =>
          void (async () => {
            setBusyId('connect');
            try { await connectGoogleAccount(); } // full-page navigation to Google
            catch (err) { setError((err as { message?: string }).message ?? 'Connect failed'); setBusyId(null); }
          })()
        }
      >
        {busyId === 'connect' ? 'Redirecting to Google…' : '⊕ Connect Google Drive'}
      </RetroButton>
      {cfg?.exists === false && (
        <p className="mt-1 text-[11px] leading-snug text-ink-soft">
          Save your Google API credentials above first — then this button opens Google&apos;s consent page.
        </p>
      )}
      <p className="mt-2 text-[11px] text-ink-faint">S3-compatible drives (R2 / B2 / MinIO) arrive in a later phase.</p>
    </div>
  );
}

function StatusBadge({ status }: { status: Account['status'] }) {
  const map = {
    connected: 'text-ok',
    needs_reauth: 'text-warn',
    degraded: 'text-warn',
    disabled: 'text-ink-faint',
  } as const;
  return <span className={map[status]}>{status.replace('_', ' ')}</span>;
}
