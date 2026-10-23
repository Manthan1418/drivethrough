// client/keys.ts — API key management (P0.4, prd.md P0-12). The full `dtk_…` secret is
// returned by create ONCE and never again — the list only ever carries prefixes.

import { api } from './api';
import type { ApiKey } from '@drivethrough/contracts';

export async function listKeys(): Promise<ApiKey[]> {
  const res = await api<{ keys: ApiKey[] }>('/api/keys');
  return res.keys;
}

export async function createKey(name: string): Promise<ApiKey> {
  const res = await api<{ key: ApiKey }>('/api/keys', { method: 'POST', json: { name } });
  return res.key; // .key present (full secret) exactly on fresh create
}

export async function revokeKey(id: string): Promise<void> {
  await api(`/api/keys/${id}`, { method: 'DELETE' });
}
