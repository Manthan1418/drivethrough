import { z } from 'zod';
import { AccountStatus, ProviderKind } from './domain.js';

// ---- Accounts (connect + list) — flow.md §3, §9 ----

// GET /api/accounts/google/start
export const StartConnectResponse = z.object({
  authUrl: z.string().url(), // frontend navigates the browser here
});
export type StartConnectResponse = z.infer<typeof StartConnectResponse>;

// GET /api/accounts
export const AccountUsage = z.object({
  totalBytes: z.string().regex(/^\d+$/).nullable(),
  usedBytes: z.string().regex(/^\d+$/),
  availableBytes: z.string().regex(/^\d+$/).nullable(),
  reservedBytes: z.string().regex(/^\d+$/),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

export const Account = z.object({
  id: z.string().uuid(),
  provider: ProviderKind,
  label: z.string(), // Drive email or S3 label
  status: AccountStatus,
  lastSyncedAt: z.string().nullable(), // ISO
  lastError: z.string().nullable(),
  usage: AccountUsage,
});
export type Account = z.infer<typeof Account>;

export const AccountListResponse = z.object({
  accounts: z.array(Account),
});
export type AccountListResponse = z.infer<typeof AccountListResponse>;

// POST /api/accounts/:id/sync-quota
export const SyncQuotaResponse = z.object({
  ok: z.literal(true),
  usage: AccountUsage.nullable(),
});
export type SyncQuotaResponse = z.infer<typeof SyncQuotaResponse>;
