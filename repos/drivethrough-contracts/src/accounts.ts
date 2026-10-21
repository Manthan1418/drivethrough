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

// ---- Google OAuth client config (9Drive parity: /system/google-config) ----
// The deployment owner enters the app's Google OAuth client credentials in the Settings UI;
// the server stores them encrypted. The client secret is WRITE-ONLY over the wire — only
// `hasSecret` ever leaves the server.

// GET /api/system/google-config
export const GoogleConfigStatus = z.object({
  exists: z.boolean(), // would the connect flow work right now?
  clientId: z.string(), // public half — it rides in the consent URL anyway
  redirectUri: z.string(),
  hasSecret: z.boolean(), // secret stored? (never the secret itself)
  defaultRedirectUri: z.string(), // suggested value (env/VERCEL_URL-derived)
});
export type GoogleConfigStatus = z.infer<typeof GoogleConfigStatus>;

// POST /api/system/google-config
export const SaveGoogleConfigRequest = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1).optional(), // omitted ⇒ keep the stored secret
  redirectUri: z.string().url(),
});
export type SaveGoogleConfigRequest = z.infer<typeof SaveGoogleConfigRequest>;

export const SaveGoogleConfigResponse = z.object({
  message: z.string(),
  hasSecret: z.boolean(),
  redirectUri: z.string(),
});
export type SaveGoogleConfigResponse = z.infer<typeof SaveGoogleConfigResponse>;
