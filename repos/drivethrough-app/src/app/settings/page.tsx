'use client';

// /settings — storage accounts screen (design.md §5.6 "Accounts" subset).
// Also the OAuth callback landing: backend 302s here with ?connected=1 / ?connect=error&reason=…

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/client/auth-context';
import {
  listAccounts, connectGoogleAccount, syncAccountQuota, disconnectAccount, readConnectResult,
} from '@/client/accounts';
import { getGoogleConfigStatus, saveGoogleConfig } from '@/client/system';
import type { Account, GoogleConfigStatus } from '@drivethrough/contracts';

function human(bytes: string | null): string {
  if (bytes === null) return '—';
  const n = Number(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// useSearchParams needs a Suspense boundary — this is the real page body.
function SettingsContent() {
  const { user, loading: authLoading } = useAuth();
  const search = useSearchParams();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Google OAuth client config (9Drive parity — configured in-app, secret write-only)
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

  // OAuth result banner (?connected=1 / ?connect=error) — clear it from the URL after reading
  useEffect(() => {
    const result = readConnectResult(window.location.search);
    if (result) {
      setBanner(
        result.ok
          ? { kind: 'ok', text: 'Drive connected — quota synced.' }
          : { kind: 'err', text: `Connect failed (${result.reason ?? 'unknown'}). Try again.` }
      );
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) void refresh();
  }, [authLoading, user, refresh]);

  if (authLoading || !user) {
    return <main className="flex min-h-dvh items-center justify-center text-sm text-zinc-500">Loading…</main>;
  }

  async function guard(fn: (id?: string) => Promise<void>, id?: string) {
    setBusyId(id ?? 'global');
    try { await fn(id); await refresh(); }
    catch (err) { setError((err as { message?: string }).message ?? 'Action failed'); }
    finally { setBusyId(null); }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <a href="/" className="text-sm text-zinc-500 hover:underline">← Back</a>
      </header>

      <h2 className="mt-6 text-sm font-medium text-zinc-500">Storage accounts</h2>

      {banner && (
        <div
          role="status"
          className={`mt-3 rounded-[var(--radius-control)] border px-3 py-2 text-sm ${
            banner.kind === 'ok'
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
          }`}
        >
          {banner.text}
          <button type="button" className="ml-2 underline" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[var(--color-error)]" role="alert">{error}</p>}

      <div className="mt-3 space-y-3">
        {accounts === null && <p className="text-sm text-zinc-500">Loading accounts…</p>}
        {accounts?.length === 0 && (
          <p className="rounded-[var(--radius-surface)] border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
            No drives connected yet.
          </p>
        )}
        {accounts?.map((a) => {
          const pct =
            a.usage.totalBytes !== null && Number(a.usage.totalBytes) > 0
              ? Math.min(100, (Number(a.usage.usedBytes) / Number(a.usage.totalBytes)) * 100)
              : null;
          return (
            <article
              key={a.id}
              className="rounded-[var(--radius-surface)] border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.label}</p>
                  <p className="text-xs text-zinc-500">
                    {a.provider === 'google_drive' ? 'Google Drive' : 'S3'} ·{' '}
                    <StatusBadge status={a.status} />
                    {a.lastSyncedAt && <> · synced {new Date(a.lastSyncedAt).toLocaleDateString()}</>}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <button
                    type="button"
                    disabled={busyId === a.id}
                    onClick={() => void guard(async (id) => { await syncAccountQuota(id!); }, a.id)}
                    className="h-9 rounded-[var(--radius-control)] border border-zinc-300 px-3 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {busyId === a.id ? '…' : 'Sync'}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === a.id}
                    onClick={() => {
                      if (confirm(`Disconnect ${a.label}? Files stored there stay until deleted.`)) {
                        void guard(async (id) => { await disconnectAccount(id!); }, a.id);
                      }
                    }}
                    className="h-9 rounded-[var(--radius-control)] border border-zinc-300 px-3 text-[var(--color-error)] hover:bg-red-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-red-950"
                  >
                    Disconnect
                  </button>
                </div>
              </div>

              {/* quota bar — design.md §5.3 semantic colors: green=used portion of total */}
              <div className="mt-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
                    style={{ width: `${pct ?? Math.min(100, Number(a.usage.usedBytes) > 0 ? 4 : 0)}%` }}
                  />
                </div>
                <p className="tnum mt-1 text-xs text-zinc-500">
                  {human(a.usage.usedBytes)} used
                  {a.usage.totalBytes !== null && <> of {human(a.usage.totalBytes)}</>}
                  {Number(a.usage.reservedBytes) > 0 && <> · {human(a.usage.reservedBytes)} reserved</>}
                </p>
              </div>
            </article>
          );
        })}
      </div>

      {/* Google OAuth client credentials — 9Drive parity (their Settings form): entered once,
          stored AES-encrypted server-side; the secret is write-only (hasSecret flag only). */}
      <section className="mt-6 rounded-[var(--radius-surface)] border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Google Drive API credentials</h2>
          <span className={`text-xs ${cfg?.exists ? 'text-[var(--color-free)]' : 'text-zinc-400'}`}>
            {cfg === null ? '…' : cfg.exists ? 'Configured' : 'Not configured'}
          </span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          One-time setup: create an OAuth client in Google Cloud Console (enable Drive API → consent
          screen → Web client with the redirect URI below), then paste its ID and secret here.
          Saved encrypted; the secret can never be read back.
        </p>
        <div className="mt-3 space-y-2">
          <input
            value={formClientId}
            onChange={(e) => setFormClientId(e.target.value)}
            placeholder="Client ID — ….apps.googleusercontent.com"
            autoComplete="off"
            className="h-10 w-full rounded-[var(--radius-control)] border border-zinc-300 bg-transparent px-3 text-sm dark:border-zinc-700"
          />
          <input
            type="password"
            value={formClientSecret}
            onChange={(e) => setFormClientSecret(e.target.value)}
            placeholder={cfg?.hasSecret ? '•••••• (saved — leave blank to keep)' : 'Client secret — GOCSPX-…'}
            autoComplete="new-password"
            className="h-10 w-full rounded-[var(--radius-control)] border border-zinc-300 bg-transparent px-3 text-sm dark:border-zinc-700"
          />
          <div className="flex gap-2">
            <input
              value={formRedirectUri}
              onChange={(e) => setFormRedirectUri(e.target.value)}
              placeholder="Redirect URI"
              autoComplete="off"
              className="h-10 w-full rounded-[var(--radius-control)] border border-zinc-300 bg-transparent px-3 text-sm dark:border-zinc-700"
            />
            <button
              type="button"
              disabled={!formRedirectUri}
              onClick={() => { if (formRedirectUri) void navigator.clipboard.writeText(formRedirectUri); }}
              className="h-10 shrink-0 rounded-[var(--radius-control)] border border-zinc-300 px-3 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Copy
            </button>
          </div>
        </div>
        <button
          type="button"
          disabled={busyId === 'cfg' || !formClientId.trim() || !formRedirectUri.trim()}
          onClick={() =>
            void guard(async () => {
              await saveGoogleConfig({
                clientId: formClientId.trim(),
                ...(formClientSecret.trim() ? { clientSecret: formClientSecret.trim() } : {}),
                redirectUri: formRedirectUri.trim(),
              });
              setFormClientSecret(''); // never keep the secret in component state after save
              setBanner({ kind: 'ok', text: 'Google credentials saved (encrypted).' });
            }, 'cfg')
          }
          className="mt-3 h-10 rounded-[var(--radius-control)] border border-zinc-300 px-4 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {busyId === 'cfg' ? 'Saving…' : 'Save credentials'}
        </button>
      </section>

      <button
        type="button"
        disabled={busyId === 'global' || cfg?.exists === false}
        onClick={() => void guard(() => connectGoogleAccount())}
        className="mt-4 h-11 w-full rounded-[var(--radius-control)] bg-[var(--color-accent)] text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
      >
        {busyId === 'global' ? 'Redirecting to Google…' : 'Connect Google Drive'}
      </button>
      {cfg?.exists === false && (
        <p className="mt-1 text-xs text-zinc-400">
          Save your Google API credentials above first — then this button opens Google&apos;s consent page.
        </p>
      )}

      <p className="mt-2 text-xs text-zinc-400">
        S3-compatible accounts (R2 / B2 / MinIO) get their connect form in P0.1.
      </p>
    </main>
  );
}

function StatusBadge({ status }: { status: Account['status'] }) {
  const map = {
    connected: 'text-[var(--color-free)]',
    needs_reauth: 'text-[var(--color-reserved)]',
    degraded: 'text-[var(--color-reserved)]',
    disabled: 'text-zinc-400',
  } as const;
  return <span className={map[status]}>{status.replace('_', ' ')}</span>;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<main className="flex min-h-dvh items-center justify-center text-sm text-zinc-500">Loading…</main>}>
      <SettingsContent />
    </Suspense>
  );
}
