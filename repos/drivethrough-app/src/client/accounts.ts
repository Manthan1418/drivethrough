// client/accounts.ts — frontend service for the connect-a-account flow (flow.md §3).
// Uses api.ts (single choke-point). The OAuth dance: fetch consent URL → navigate browser →
// Google hits backend callback → backend 302s back to /settings?connected=1.

import { api } from './api';
import type { Account, AccountListResponse, StartConnectResponse, SyncQuotaResponse } from '@drivethrough/contracts';

export async function listAccounts(): Promise<Account[]> {
  const res = await api<AccountListResponse>('/api/accounts');
  return res.accounts;
}

/**
 * Kick off a Drive connect. Navigates the full page to Google (required — the consent
 * screen is a top-level redirect, cannot be an iframe/popup reliably across devices).
 */
export async function connectGoogleAccount(): Promise<void> {
  const { authUrl } = await api<StartConnectResponse>('/api/accounts/google/start', { method: 'GET' });
  window.location.assign(authUrl);
}

export async function syncAccountQuota(accountId: string): Promise<SyncQuotaResponse> {
  return api<SyncQuotaResponse>(`/api/accounts/${accountId}/sync-quota`, { method: 'POST' });
}

export async function disconnectAccount(accountId: string): Promise<void> {
  // revocation check for this sensitive op is enforced server-side (backend calls checkRevoked)
  await api<{ ok: true }>(`/api/accounts/${accountId}`, { method: 'DELETE' });
}

/**
 * Parse the OAuth callback result from the URL (?connected=1 or ?connect=error&reason=…)
 * after the backend redirects back to /settings. Returns a result object for the toast/banner.
 */
export function readConnectResult(search: string): { ok: boolean; reason?: string } | null {
  const p = new URLSearchParams(search);
  if (p.get('connected') === '1') return { ok: true };
  if (p.get('connect') === 'error') return { ok: false, reason: p.get('reason') ?? undefined };
  return null;
}
